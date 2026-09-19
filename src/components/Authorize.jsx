import { useState, useEffect } from 'react'
import { useBalance, useSignTypedData, useReadContract } from 'wagmi'
import { recoverTypedDataAddress } from 'viem'
import { attestTypedData, reattestTypedData, updateKeyTypedData } from '@thurinlabs/identity-kit'
import { REGISTRY_ADDRESS, REGISTRY_ABI, CHAIN, NETWORK } from '../wagmiConfig'
import { encodeHandoff } from '../handoff'

// The empty-wallet exit from a publish step. Instead of a transaction the wallet signs the
// write as EIP-712 typed data (free), and the result is the same hand-off the CLI makes with
// `--authorize`: a link anyone can publish, a file for `thurin submit`, or one click to
// Thurin's relayer. The owner can't recall it before the deadline, so that is said out loud.

const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || ''
const DEADLINES = [{ label: '1 hour', s: 3600 }, { label: '1 day', s: 86400 }, { label: '7 days', s: 7 * 86400 }]

function fmtDate(unix) { return new Date(unix * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
function shortAddr(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '' }

/** True when the connected address can't pay for a transaction on this chain. */
export function useIsEmpty(address) {
  const { data, isFetched } = useBalance({ address, chainId: CHAIN.id, query: { enabled: !!address } })
  return { empty: isFetched && data ? data.value === 0n : false, checked: isFetched }
}

/**
 * op: 'attest' | 'reattest' | 'update-key'
 * fields: { fingerprint, key, signature?, index?, includeEmail }
 * onPublished(hash): the relayer path succeeded
 */
export default function Authorize({ address, op, fields, onPublished }) {
  const [deadlineS, setDeadlineS] = useState(DEADLINES[2].s)
  const [handoff, setHandoff] = useState(null)   // once signed
  const [status, setStatus] = useState(null)
  const [copied, setCopied] = useState(false)
  const { signTypedDataAsync } = useSignTypedData()
  const { data: nonce, isFetched: nonceFetched, refetch: refetchNonce } = useReadContract({
    address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'nonces', args: [address], query: { enabled: !!address },
  })

  useEffect(() => { setHandoff(null); setStatus(null) }, [address, op, fields?.key, fields?.signature, fields?.index])

  const sign = async () => {
    try {
      setStatus({ type: 'info', msg: 'Your wallet will ask you to sign a message. No fee.' })
      const fresh = await refetchNonce()
      const n = BigInt(fresh.data ?? nonce ?? 0n)
      const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineS)
      const owner = address.toLowerCase()
      const common = { owner: address, nonce: n, deadline }
      const typed = op === 'attest'
        ? attestTypedData(CHAIN.id, REGISTRY_ADDRESS, { ...common, fingerprint: fields.fingerprint, pgpSignature: fields.signature, pgpPublicKey: fields.key })
        : op === 'reattest'
          ? reattestTypedData(CHAIN.id, REGISTRY_ADDRESS, { ...common, revokeIndex: BigInt(fields.index), fingerprint: fields.fingerprint, pgpSignature: fields.signature, pgpPublicKey: fields.key })
          : updateKeyTypedData(CHAIN.id, REGISTRY_ADDRESS, { ...common, index: BigInt(fields.index), pgpPublicKey: fields.key })
      const signature = await signTypedDataAsync(typed)
      // Prove it back before showing it: a wallet that signs something else must not produce a link.
      const signer = await recoverTypedDataAddress({ ...typed, signature })
      if (signer.toLowerCase() !== owner) { setStatus({ type: 'err', msg: 'The wallet signed with a different address than the one connected. Nothing was published.' }); return }
      const h = {
        v: 1, op, network: NETWORK, owner, fingerprint: fields.fingerprint.toUpperCase(), includeEmail: !!fields.includeEmail,
        key: fields.key, ...(fields.signature ? { signature: fields.signature } : {}), ...(fields.index !== undefined && fields.index !== null ? { index: Number(fields.index) } : {}),
        authorization: { nonce: Number(n), deadline: Number(deadline), signature },
      }
      setHandoff(h)
      setStatus(null)
    } catch (err) {
      setStatus({ type: 'err', msg: err.shortMessage || err.message })
    }
  }

  const link = handoff ? `${window.location.origin}/attest#handoff=${encodeHandoff(handoff)}` : ''

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* the textarea below is selectable */ }
  }

  const relay = async () => {
    try {
      setStatus({ type: 'info', msg: 'Asking Thurin’s relayer to publish…' })
      const resp = await fetch(RELAYER_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(handoff) })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) { setStatus({ type: 'err', msg: `The relayer declined: ${data.error || resp.statusText}. The link below still works.` }); return }
      setStatus({ type: 'ok', msg: '✓ Published by Thurin’s relayer.' })
      onPublished && onPublished(data.hash)
    } catch (err) {
      setStatus({ type: 'err', msg: `Could not reach the relayer: ${err.message}. The link below still works.` })
    }
  }

  if (!handoff) return (
    <div className="authorize-box fade-in">
      <div className="label">This address holds no ETH</div>
      <p className="helper">
        That is fine: sign a permission slip instead of a transaction. It costs nothing, and someone else can publish it for you.
        The claim still lands under {shortAddr(address)}.
      </p>
      <div className="row" style={{ marginTop: 8, alignItems: 'center', gap: 8 }}>
        <span className="helper" style={{ margin: 0 }}>Good for</span>
        <select value={deadlineS} onChange={e => setDeadlineS(Number(e.target.value))}>
          {DEADLINES.map(d => <option key={d.s} value={d.s}>{d.label}</option>)}
        </select>
      </div>
      <p className="helper" style={{ marginTop: 8 }}>You can’t take it back before then. After then it does nothing.</p>
      <button className="btn btn-primary" onClick={sign} disabled={!nonceFetched || status?.type === 'info'} style={{ marginTop: 8 }}>
        {status?.type === 'info' ? 'Waiting for your wallet…' : 'Sign an authorization instead'}
      </button>
      {status && <div className={`status ${status.type}`}>{status.msg}</div>}
    </div>
  )

  return (
    <div className="authorize-box signed fade-in">
      <div className="label">Signed. Anyone can publish this until {fmtDate(handoff.authorization.deadline)}</div>
      <p className="helper">
        Three ways to get it on-chain. Whoever does it pays the fee; the claim is yours either way.
      </p>
      <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        {RELAYER_URL && (
          <button className="btn btn-primary" onClick={relay} disabled={status?.type === 'info' || status?.type === 'ok'} title="Thurin’s relayer pays, within its daily budget">
            {status?.type === 'info' ? 'Publishing…' : 'Have Thurin publish it'}
          </button>
        )}
        <button className="btn" onClick={copyLink}>{copied ? '✓ copied' : 'Copy link for someone with a wallet'}</button>
        <button className="btn btn-sm" onClick={() => copyToFile(handoff)}>Download for thurin submit</button>
      </div>
      <textarea className="pgp-input" readOnly value={link} onFocus={e => e.target.select()} />
      {status && <div className={`status ${status.type}`}>{status.msg}</div>}
    </div>
  )
}

function copyToFile(h) {
  const blob = new Blob([JSON.stringify(h, null, 2) + '\n'], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = `thurin-${h.op}-${h.owner.slice(0, 8)}.json`
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
