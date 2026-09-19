import { useState, useEffect } from 'react'
import { useWriteContract, useReadContract } from 'wagmi'
import { createPublicClient, http, stringToHex, recoverTypedDataAddress } from 'viem'
import {
  parsePgpKey, verifyAttestation, identifyProof, fingerprintToBytes, bytesToFingerprint,
  attestTypedData, reattestTypedData, updateKeyTypedData, revokeTypedData,
} from '@thurinlabs/identity-kit'
import { REGISTRY_ADDRESS, REGISTRY_ABI, RPC_URL, CHAIN, EXPLORER_URL, NETWORK } from '../wagmiConfig'

// Publish someone else's authorized write. The owner signed the typed data in the CLI
// (`thurin attest --authorize`); this panel rebuilds that typed data from the hand-off,
// recovers the signer, checks the nonce and deadline against the chain, verifies the PGP
// side the way a lookup would, and then lets *any* connected wallet pay for the `…For` call.

// A relayer (`thurin relay`) that pays on the viewer's behalf. Unset = no button; the
// viewer's own wallet is always the other path.
const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || ''

const VERBS = { attest: 'Publish a claim', reattest: 'Replace a claim', 'update-key': 'Update a key', revoke: 'Revoke a claim' }
const FNS = { attest: 'attestFor', reattest: 'reattestFor', 'update-key': 'updateKeyFor', revoke: 'revokeFor' }

function shortAddr(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '' }
function fmtDate(unix) { return new Date(unix * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
function timeLeft(unix) {
  const s = unix - Math.floor(Date.now() / 1000)
  if (s <= 0) return null
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  return `${Math.floor(s / 86400)} day${s >= 172800 ? 's' : ''}`
}

function typedDataFor(h) {
  const common = { owner: h.owner, nonce: BigInt(h.authorization.nonce), deadline: BigInt(h.authorization.deadline) }
  switch (h.op) {
    case 'attest': return attestTypedData(CHAIN.id, REGISTRY_ADDRESS, { ...common, fingerprint: h.fingerprint, pgpSignature: h.signature, pgpPublicKey: h.key })
    case 'reattest': return reattestTypedData(CHAIN.id, REGISTRY_ADDRESS, { ...common, revokeIndex: BigInt(h.index), fingerprint: h.fingerprint, pgpSignature: h.signature, pgpPublicKey: h.key })
    case 'update-key': return updateKeyTypedData(CHAIN.id, REGISTRY_ADDRESS, { ...common, index: BigInt(h.index), pgpPublicKey: h.key })
    case 'revoke': return revokeTypedData(CHAIN.id, REGISTRY_ADDRESS, { ...common, index: BigInt(h.index) })
    default: throw new Error(`Unknown operation ${h.op}`)
  }
}

function argsFor(h) {
  const { deadline, signature } = h.authorization
  const d = BigInt(deadline)
  switch (h.op) {
    case 'attest': return [h.owner, fingerprintToBytes(h.fingerprint), stringToHex(h.signature), stringToHex(h.key), d, signature]
    case 'reattest': return [h.owner, BigInt(h.index), fingerprintToBytes(h.fingerprint), stringToHex(h.signature), stringToHex(h.key), d, signature]
    case 'update-key': return [h.owner, BigInt(h.index), stringToHex(h.key), d, signature]
    case 'revoke': return [h.owner, BigInt(h.index), d, signature]
    default: throw new Error(`Unknown operation ${h.op}`)
  }
}

export default function SubmitAuthorization({ handoff: h, isConnected }) {
  const [check, setCheck] = useState(null)     // { ok, problems: [], names, proofs, bytes, signer }
  const [status, setStatus] = useState(null)
  const [txHash, setTxHash] = useState(null)
  const [done, setDone] = useState(false)
  const { writeContractAsync } = useWriteContract()

  const { data: chainNonce, isFetched: nonceFetched, refetch: refetchNonce } = useReadContract({
    address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'nonces', args: [h.owner],
  })
  const { data: rows } = useReadContract({
    address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'attestationsOf', args: [h.owner],
  })
  const target = h.index !== null && rows ? rows[h.index] : null   // the claim being replaced / updated / revoked

  // Every check the registry and a lookup will make, before anyone pays.
  useEffect(() => {
    if (!nonceFetched) return
    let cancelled = false
    ;(async () => {
      const problems = []
      let names = [], proofs = 0, bytes = 0, signer = null
      try {
        signer = await recoverTypedDataAddress({ ...typedDataFor(h), signature: h.authorization.signature })
        if (signer.toLowerCase() !== h.owner) problems.push(`The authorization was not signed by ${shortAddr(h.owner)} (it recovers to ${shortAddr(signer)}), so something in this link was changed.`)
      } catch (e) {
        problems.push(`The authorization signature could not be checked: ${e.message}`)
      }
      if (chainNonce !== undefined && Number(chainNonce) !== h.authorization.nonce) {
        problems.push(Number(chainNonce) > h.authorization.nonce
          ? 'This authorization was already used, or the owner has published something since signing it. Ask them for a new one.'
          : 'The nonce in this authorization is ahead of the chain; it cannot be submitted yet.')
      }
      if (!timeLeft(h.authorization.deadline)) problems.push(`This authorization expired on ${fmtDate(h.authorization.deadline)}. Ask ${shortAddr(h.owner)} for a new one.`)
      if (h.key) {
        const info = await parsePgpKey(h.key)
        if (!info) problems.push('The key in this link does not parse.')
        else {
          if (info.fingerprint.toUpperCase() !== h.fingerprint) problems.push('The key in this link is not the key it names.')
          names = info.userIDs; proofs = info.notations.filter(n => identifyProof(n)).length
          bytes = new TextEncoder().encode(h.key).length
        }
        if (h.signature) {
          const v = await verifyAttestation({ pgpPublicKey: h.key, pgpSignature: h.signature, fingerprint: h.fingerprint, ethAddress: h.owner })
          if (!v.verified) problems.push(`The PGP signature does not verify: ${v.reason}`)
        }
      }
      if (h.index !== null && rows && !rows[h.index]) problems.push(`${shortAddr(h.owner)} has no claim #${h.index}.`)
      if (target?.revokedAt && Number(target.revokedAt) > 0) problems.push(`Claim #${h.index} is already revoked.`)
      if (!cancelled) setCheck({ ok: problems.length === 0, problems, names, proofs, bytes, signer })
    })()
    return () => { cancelled = true }
  }, [h, chainNonce, nonceFetched, rows, target])

  const handleRelay = async () => {
    try {
      setStatus({ type: 'info', msg: 'Asking the relayer to publish…' })
      const body = { v: 1, op: h.op, network: NETWORK, owner: h.owner, fingerprint: h.fingerprint, includeEmail: h.includeEmail,
        ...(h.key ? { key: h.key } : {}), ...(h.signature ? { signature: h.signature } : {}), ...(h.index !== null ? { index: h.index } : {}),
        authorization: h.authorization }
      const resp = await fetch(RELAYER_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) { setStatus({ type: 'err', msg: `The relayer declined: ${data.error || resp.statusText}. You can still publish from your own wallet.` }); return }
      setTxHash(data.hash)
      setStatus({ type: 'ok', msg: '✓ Published by the relayer.' }); setDone(true); refetchNonce()
    } catch (err) {
      setStatus({ type: 'err', msg: `Could not reach the relayer: ${err.message}. You can still publish from your own wallet.` })
    }
  }

  const handlePublish = async () => {
    try {
      setStatus({ type: 'info', msg: 'Sending transaction…' })
      const hash = await writeContractAsync({ address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: FNS[h.op], args: argsFor(h), chainId: CHAIN.id })
      setTxHash(hash)
      setStatus({ type: 'info', msg: `Waiting for confirmation… tx: ${hash.slice(0, 10)}…` })
      const client = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) })
      const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 4_000 })
      if (receipt.status === 'success') { setStatus({ type: 'ok', msg: '✓ Published.' }); setDone(true); refetchNonce() }
      else setStatus({ type: 'err', msg: `Transaction reverted. Tx: ${hash}` })
    } catch (err) {
      setStatus({ type: 'err', msg: err.shortMessage || err.message })
    }
  }

  const left = timeLeft(h.authorization.deadline)
  const targetFpr = target ? bytesToFingerprint(target.fingerprint).toUpperCase() : null

  return (
    <div className={`step ${isConnected ? 'active' : ''} ${done ? 'done' : ''}`}>
      <div className="step-header">
        <span className={`step-num ${isConnected && !done ? 'active-num' : ''}`}>02 //</span>
        <span className="step-title">{VERBS[h.op]} for {shortAddr(h.owner)}</span>
        {done && <span className="step-badge">✓ published</span>}
      </div>

      {done ? (
        <div className="fade-in">
          <div className="status ok">Published. The claim is under {shortAddr(h.owner)}, and anyone can check it.</div>
          <div style={{ marginTop: 16 }} className="row">
            <a href={`/eth/${h.owner}`} className="btn btn-primary" target="_blank" rel="noopener noreferrer">View identity</a>
            {txHash && EXPLORER_URL && <a href={`${EXPLORER_URL}/tx/${txHash}`} className="btn" target="_blank" rel="noopener noreferrer">View transaction</a>}
          </div>
        </div>
      ) : (
        <div className="fade-in">
          <div className="mono-box" style={{ marginBottom: 12 }}>
            <div className="label">What will be published</div>
            <div className="value">Owner: {h.owner}</div>
            {h.fingerprint && h.op !== 'revoke' && <div className="value">Key: {h.fingerprint}</div>}
            {h.index !== null && <div className="value">{h.op === 'reattest' ? 'Replaces' : h.op === 'revoke' ? 'Revokes' : 'Updates'} claim #{h.index}{targetFpr ? ` (${targetFpr.slice(0, 8)}…${targetFpr.slice(-8)})` : ''}</div>}
            {check && h.key && (
              <>
                <div className="value">Name: {check.names.join(', ') || '—'}</div>
                <div className="value">Proofs: {check.proofs}</div>
                <div className="value" style={{ color: 'var(--color-text-muted)' }}>{(check.bytes / 1024).toFixed(1)} KB</div>
              </>
            )}
            <div className="value" style={{ color: 'var(--color-text-muted)' }}>
              Signed by the owner · nonce {h.authorization.nonce} · {left ? `expires in ${left} (${fmtDate(h.authorization.deadline)})` : `expired ${fmtDate(h.authorization.deadline)}`}
            </div>
          </div>

          {!check && <div className="status info">Checking the authorization against the chain…</div>}
          {check && check.problems.map((p, i) => <div key={i} className="status err">{p}</div>)}
          {check?.ok && (
            <div className="status ok">
              ✓ Authorization signed by {shortAddr(h.owner)}{h.signature ? ' · PGP signature verified' : ''} · nonce matches the chain
            </div>
          )}

          <p className="helper" style={{ marginTop: 12 }}>
            Your wallet pays the fee; the claim lands under {shortAddr(h.owner)}, not you. The owner can't recall this
            link before it expires, and it can be used once.
          </p>

          <div className="row">
            <button className="btn btn-primary" onClick={handlePublish} disabled={!isConnected || !check?.ok || status?.type === 'info'}>
              {status?.type === 'info' ? 'Publishing…' : `Publish for ${shortAddr(h.owner)}`}
            </button>
            {RELAYER_URL && (
              <button className="btn" onClick={handleRelay} disabled={!check?.ok || status?.type === 'info'} title="Thurin's relayer pays the fee, within its daily budget">
                Have Thurin publish it
              </button>
            )}
          </div>
          {RELAYER_URL && !isConnected && check?.ok && (
            <p className="helper" style={{ marginTop: 8 }}>No wallet? "Have Thurin publish it" pays the fee from Thurin's relayer, within its daily budget.</p>
          )}

          {status && <div className={`status ${status.type}`}>{status.msg}</div>}
        </div>
      )}
    </div>
  )
}
