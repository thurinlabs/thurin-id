import { Fragment, useState, useCallback, useMemo, useEffect } from 'react'
import { useAccount, useWriteContract, useReadContract, useReadContracts } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import * as openpgp from 'openpgp'
import { createPublicClient, http, stringToHex, hexToString } from 'viem'
import { stripEmailUserIDs, hasEmailUserID, parsePgpKey, identifyProof, fingerprintToBytes, bytesToFingerprint, verifyClearsigned, verifyAttestation } from '@thurinlabs/identity-kit'
import { REGISTRY_ADDRESS, REGISTRY_ABI, RPC_URL, CHAIN, EXPLORER_URL, NETWORK } from '../wagmiConfig'
import { readHandoff } from '../handoff'
import SubmitAuthorization from './SubmitAuthorization'
import Authorize, { useIsEmpty } from './Authorize'
import SetRecordPanel from './SetRecordPanel'

// ─── helpers ────────────────────────────────────────────────────────────────

function shortAddr(addr) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : ''
}

function copyToClipboard(text, e) {
  navigator.clipboard.writeText(text)
  if (e?.target) {
    const btn = e.target
    const original = btn.textContent
    btn.textContent = 'copied!'
    btn.classList.add('copied')
    setTimeout(() => {
      btn.textContent = original
      btn.classList.remove('copied')
    }, 1200)
  }
}

/** The signed block and the public key block out of one terminal paste (prompts and noise around them are ignored). */
function splitPaste(text) {
  const sig = text.match(/-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?-----END PGP SIGNATURE-----/)?.[0] ?? null
  const key = text.match(/-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]*?-----END PGP PUBLIC KEY BLOCK-----/)?.[0] ?? null
  return { sig, key }
}

/** "Use a different key": a fingerprint (spaces and 0x allowed), an email, or a name. It goes into a shell command, so only plain characters. */
function normalizeKeyChoice(text) {
  const t = text.trim()
  if (!t) return { value: '' }
  const hex = t.replace(/\s/g, '').replace(/^0x/i, '')
  if (/^[0-9a-f]{40}$/i.test(hex)) return { value: hex.toUpperCase(), fingerprint: hex.toUpperCase() }
  if (/^[\w.+@ -]+$/.test(t)) return { value: t }
  return { value: '', error: 'Use the key\'s fingerprint, an email on it, or a name on it.' }
}

// The message GPG signs — must match exactly
function gpgPayload(address) {
  return `I control the Ethereum address: ${address.toLowerCase()}`
}

// Must match PGPRegistry.MAX_KEY_BYTES (8 KB). The on-chain key only needs to
// verify the attestation signature and carry the proof notations, so a minimal
// export stays well under this — and every byte costs gas.
const MAX_PUBKEY_BYTES = 8192

// One command: sign the line, then print the same key's public half. Without a chosen key it
// takes the first secret key that can sign (gpg's own default unless gpg.conf sets default-key);
// the page shows which key it got, and "Use a different key" names one instead.
const PICK_SIGNING_KEY = `F=$(gpg -K --with-colons | awk -F: '$1=="sec"&&$12~/S/{s=1}s&&$1=="fpr"{print $10;exit}')`
const EXPORT_OPTIONS = 'export-minimal,no-export-attributes'

function signCommand(address, key) {
  const sign = `echo "${gpgPayload(address)}" | gpg --clearsign`
  return key
    ? `${sign} -u "${key}"; gpg --export-options ${EXPORT_OPTIONS} --armor --export "${key}"`
    : `${PICK_SIGNING_KEY}; ${sign} -u $F; gpg --export-options ${EXPORT_OPTIONS} --armor --export $F`
}

function spacedFingerprint(fpr) {
  return fpr.match(/.{4}/g).join(' ')
}

// ─── Step 1: Connect Wallet ──────────────────────────────────────────────────

function StepConnect({ active, done }) {
  const { isConnected } = useAccount()

  return (
    <div className={`step ${active ? 'active' : ''} ${done ? 'done' : ''}`}>
      <div className="step-header">
        <span className={`step-num ${active ? 'active-num' : ''}`}>01 //</span>
        <span className="step-title">Connect Wallet</span>
        {done && <span className="step-badge">✓ complete</span>}
      </div>

      {!isConnected && (
        <p className="helper">Connect your wallet to get started. The claim is published from this address, so it has to be yours. Already have a claim? <a href="/" rel="noopener noreferrer">Look it up</a>.</p>
      )}

      <ConnectButton showBalance={false} />
    </div>
  )
}

// ─── Step 2: Sign — one command, one paste ───────────────────────────────────
//
// The paste carries the clearsigned line and the exported key. The page finds the key that
// made the signature, checks it exactly as a lookup will, and shows what goes on-chain: every
// email user ID removed unless "Include my email" is ticked. The keyserver is never consulted:
// keys.openpgp.org drops non-email user IDs, so it can't supply the name the proofs sit on.

function StepSign({ active, done, locked, address, expectedFingerprint, includeEmail, setIncludeEmail, onVerified, paste, setPaste, fromLink = false }) {
  const [keyChoiceText, setKeyChoiceText] = useState('')
  const [otherKey, setOtherKey] = useState(false)
  // A CLI hand-off brings the signature and key in the link: nothing to run or paste unless it fails.
  const [manual, setManual] = useState(!fromLink)
  const [status, setStatus] = useState(null)
  const [verified, setVerified] = useState(null) // { armoredFull, sig, signedText, keyId, fingerprint, publicKey, expiresAt, emails }
  const [preview, setPreview] = useState(null)   // { kept, removed, proofsPublished, proofsTotal, bytes }
  const [needsName, setNeedsName] = useState(false)

  const keyChoice = normalizeKeyChoice(otherKey ? keyChoiceText : '')
  const command = address ? signCommand(address, keyChoice.value) : ''
  const wantedFingerprint = expectedFingerprint?.toUpperCase() || keyChoice.fingerprint || null

  // Check the paste as soon as it has both blocks.
  useEffect(() => {
    let cancelled = false
    setVerified(null)
    setPreview(null)
    setNeedsName(false)
    onVerified(null)
    if (!paste.trim() || !address) { setStatus(null); return }
    const { sig, key } = splitPaste(paste)
    if (!sig || !key) {
      setStatus({ type: 'err', msg: `That's only part of it: the output has a signed message and a public key block${sig ? '; the key block is missing' : key ? '; the signed message is missing' : ''}. Paste all of it.` })
      return
    }
    setStatus({ type: 'info', msg: 'Checking the signature…' })
    ;(async () => {
      try {
        const message = await openpgp.readCleartextMessage({ cleartextMessage: sig })
        const signedText = message.getText().trim()
        if (!signedText.toLowerCase().includes(address.toLowerCase())) {
          throw new Error(`the signed line doesn't name your connected address. Copy the command again: it has to sign "${gpgPayload(address)}".`)
        }
        // `--export "<email>"` can print several keys: use the one that made the signature. The
        // check is the kit's, the same one every lookup runs (curve policy, key valid now).
        const keys = await openpgp.readKeys({ armoredKeys: key })
        const issuer = message.signature.packets[0]?.issuerKeyID
        let publicKey = null
        let ownKeyReason = null // the signer's key is in the paste, but the signature didn't verify
        for (const k of keys) {
          const v = await verifyClearsigned({ armoredKey: k.armor(), clearsigned: sig })
          if (v.verified) { publicKey = k; break }
          if (issuer && k.getKeys(issuer).length) ownKeyReason = v.reason || 'verification failed'
        }
        if (!publicKey) throw new Error(ownKeyReason
          ? `the key that signed is in the paste, but its signature doesn't verify (${ownKeyReason}). If \`echo test | gpg --clearsign | gpg --verify\` says BAD too, it's your gpg setup, not this page.`
          : `the signature doesn't match the key in the paste. Run the whole command again and paste all of its output.`)
        const fingerprint = publicKey.getFingerprint().toUpperCase()
        if (wantedFingerprint && fingerprint !== wantedFingerprint) {
          throw new Error(`this was signed by ${spacedFingerprint(fingerprint)}, not ${spacedFingerprint(wantedFingerprint)}.`)
        }
        const expirationTime = await publicKey.getExpirationTime()
        const expiresAt = expirationTime && expirationTime !== Infinity ? new Date(expirationTime).toISOString() : null
        const keyId = message.signature.packets[0]?.issuerKeyID?.toHex()?.toUpperCase() ?? null
        const armoredFull = publicKey.armor()
        const info = await parsePgpKey(armoredFull)
        const emails = (info?.userIDs ?? []).map(u => u.match(/<([^>]+@[^>]+)>/)?.[1] || (u.includes('@') ? u : null)).filter(Boolean)
        if (cancelled) return
        setVerified({ armoredFull, sig, signedText, keyId, fingerprint, publicKey, expiresAt, emails })
      } catch (err) {
        if (!cancelled) setStatus({ type: 'err', msg: `Couldn't use that: ${err.message}` })
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paste, address, wantedFingerprint])

  // What gets published follows the email switch.
  useEffect(() => {
    if (!verified) return
    let cancelled = false
    ;(async () => {
      const full = verified.armoredFull
      const fullInfo = await parsePgpKey(full)
      const proofsTotal = fullInfo ? fullInfo.notations.filter(n => identifyProof(n)).length : 0

      let armored, kept, removed
      if (includeEmail) {
        armored = full; kept = fullInfo?.userIDs ?? []; removed = []
      } else {
        const stripped = await stripEmailUserIDs(full)
        if (cancelled) return
        if (!stripped) {
          setPreview(null); setNeedsName({ proofs: proofsTotal }); setStatus(null); onVerified(null)
          return
        }
        armored = stripped.armored; kept = stripped.kept; removed = stripped.removed
      }
      setNeedsName(false)

      const bytes = new TextEncoder().encode(armored).length
      if (bytes > MAX_PUBKEY_BYTES) {
        if (cancelled) return
        setPreview(null); onVerified(null)
        setStatus({ type: 'err', msg: `The key to publish is ${(bytes / 1024).toFixed(1)} KB, over the ${MAX_PUBKEY_BYTES / 1024} KB on-chain limit. It likely has large photos or many signatures on it; the command already leaves most of those out.` })
        return
      }

      // What a lookup will run on the published claim, run now on exactly those bytes.
      const check = await verifyAttestation({ pgpPublicKey: armored, pgpSignature: verified.sig, fingerprint: verified.fingerprint, ethAddress: address })
      if (cancelled) return
      if (!check.verified) {
        setPreview(null); onVerified(null)
        setStatus({ type: 'err', msg: `The key as it would be published doesn't verify (${check.reason}). Nothing was sent.` })
        return
      }

      const pubInfo = await parsePgpKey(armored)
      const proofsPublished = pubInfo ? pubInfo.notations.filter(n => identifyProof(n)).length : 0
      if (cancelled) return
      setPreview({ kept, removed, proofsPublished, proofsTotal, bytes })
      setStatus(null)
      onVerified({
        pgpSig: verified.sig,
        signedText: verified.signedText,
        keyId: verified.keyId,
        fingerprint: verified.fingerprint,
        armoredPublicKey: armored,
        pgpMeta: {
          userIDs: kept,
          algorithm: verified.publicKey.keyPacket.algorithm,
          bits: verified.publicKey.keyPacket.getBitSize?.() ?? null,
          createdAt: verified.publicKey.keyPacket.created?.toISOString() ?? null,
          expiresAt: verified.expiresAt,
          subkeys: verified.publicKey.subkeys?.length ?? 0,
        },
      })
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verified, includeEmail])

  // Suggest the name already on the key, without the email or "(comment)"; kept to shell-safe characters.
  const suggestedName = (verified?.publicKey?.users ?? []).map(u => u.userID?.name?.replace(/["$`\\]/g, '').trim()).find(Boolean) || 'Your Name'
  const addNameCommand = verified ? `gpg --quick-add-uid ${verified.fingerprint} "${suggestedName}"` : ''
  const shownName = preview?.kept?.[0] ?? verified?.publicKey?.users?.[0]?.userID?.name ?? ''

  if (locked) return (
    <div className="step done">
      <div className="step-header">
        <span className="step-num">02 //</span>
        <span className="step-title">Sign with your PGP key</span>
        <span className="step-badge">✓ signed</span>
      </div>
      {verified && <div className="mono-box"><div className="label">signed by</div><div className="value">{spacedFingerprint(verified.fingerprint)}</div></div>}
    </div>
  )

  return (
    <div className={`step ${active ? 'active' : ''} ${done ? 'done' : ''}`}>
      <div className="step-header">
        <span className={`step-num ${active ? 'active-num' : ''}`}>02 //</span>
        <span className="step-title">Sign with your PGP key</span>
        {done && <span className="step-badge">✓ signed</span>}
      </div>

      {(active || done) && !manual && (
        <div className="fade-in">
          <p className="helper">
            The signed line and your key came with the link, so there is nothing to run or paste.
            Checking the signature against the key, exactly as a lookup would.
          </p>
          {status && <div className={`status ${status.type}`}>{status.msg}</div>}
          {status?.type === 'err' && (
            <button className="btn btn-sm" onClick={() => { setManual(true); setPaste('') }} style={{ marginTop: 12 }}>Run the command myself instead</button>
          )}
        </div>
      )}

      {(active || done) && manual && (
        <div className="fade-in">
          <p className="helper">
            Run this in a terminal. It signs a line naming your address and prints your public key.
            Don't have a PGP key? <a href="https://docs.thurin.id/#/guides/getting-started" target="_blank" rel="noopener noreferrer">Make one first</a>.
          </p>
          <div className="command-block wrap"><span className="prompt">$ </span>{command}</div>
          <div className="row" style={{ alignItems: 'center' }}>
            <button className="btn btn-sm" onClick={(e) => copyToClipboard(command, e)}>copy command</button>
            {!expectedFingerprint && (
              <button type="button" className="link-btn" onClick={() => { setOtherKey(o => !o); setKeyChoiceText('') }}>
                {otherKey ? 'Use my default key' : 'Use a different key'}
              </button>
            )}
          </div>
          {otherKey && (
            <div className="fade-in" style={{ marginTop: 12 }}>
              <input
                className="key-choice"
                placeholder="Fingerprint, or an email or name on the key"
                value={keyChoiceText}
                onChange={e => setKeyChoiceText(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
              {keyChoice.error
                ? <div className="status err" style={{ marginTop: 8 }}>{keyChoice.error}</div>
                : <p className="helper" style={{ marginTop: 6 }}>The command above updates as you type. <code>gpg -K</code> lists your keys.</p>}
            </div>
          )}

          <textarea
            className="pgp-input"
            style={{ minHeight: 120, marginTop: 16 }}
            placeholder={`Paste the whole output here:\n\n-----BEGIN PGP SIGNED MESSAGE-----\n…\n-----END PGP SIGNATURE-----\n-----BEGIN PGP PUBLIC KEY BLOCK-----\n…\n-----END PGP PUBLIC KEY BLOCK-----`}
            value={paste}
            onChange={e => setPaste(e.target.value)}
            spellCheck={false}
          />
          {status && <div className={`status ${status.type}`}>{status.msg}</div>}
        </div>
      )}

      {(active || done) && verified && (
        <div className="fade-in" style={{ marginTop: 16 }}>
          <div className="status ok">
            ✓ Signed by {spacedFingerprint(verified.fingerprint)}{shownName ? ` · ${shownName}` : ''}
            {!expectedFingerprint && manual && !otherKey && (
              <> · <button type="button" className="link-btn" onClick={() => { setOtherKey(true); setKeyChoiceText('') }}>not this key?</button></>
            )}
          </div>

          {needsName && (
            <div className="status info needs-name" style={{ marginTop: 12 }}>
              <p>This key's only name includes your email{verified.emails.length ? ` (${verified.emails.join(', ')})` : ''}. Pick one:</p>
              <p><strong>Keep your email private:</strong> add a name without it (change the name if you like), then run the command above again and paste the new output.</p>
              <div className="command-block" style={{ marginTop: 8 }}><span className="prompt">$ </span>{addNameCommand}</div>
              <button className="btn btn-sm" onClick={(e) => copyToClipboard(addNameCommand, e)}>copy command</button>
              {needsName.proofs > 0 && (
                <p>
                  Your {needsName.proofs === 1 ? 'proof is' : `${needsName.proofs} proofs are`} on the email name, so add {needsName.proofs === 1 ? 'it' : 'them'} to
                  the new name too (<a href="https://docs.thurin.id/#/guides/gnupg" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>how</a>).
                </p>
              )}
              <p><strong>Or publish your email:</strong></p>
              <label className="email-toggle" style={{ marginTop: 4 }}>
                <input type="checkbox" checked={includeEmail} onChange={e => setIncludeEmail(e.target.checked)} />
                <span>Include my email. Only if it's already public; it can't be removed later.</span>
              </label>
            </div>
          )}

          {preview && (
            <div className="mono-box" style={{ marginTop: 12 }}>
              <div className="label">Going on-chain</div>
              <div className="value">Name: {preview.kept.join(', ')}</div>
              {preview.removed.length > 0 && (
                <div className="value" style={{ color: 'var(--color-text-muted)' }}>Left out (has an email): {preview.removed.join(', ')}</div>
              )}
              <div className="value">Proofs: {preview.proofsPublished}</div>
              {preview.proofsPublished === 0 && preview.proofsTotal > 0 && (
                <div className="status err" style={{ marginTop: 8 }}>
                  Your {preview.proofsTotal === 1 ? 'proof is' : `${preview.proofsTotal} proofs are`} on a name being left out, so {preview.proofsTotal === 1 ? "it won't" : 'none will'} show.
                  Add {preview.proofsTotal === 1 ? 'it' : 'them'} to the published name (<a href="https://docs.thurin.id/#/guides/gnupg" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>how</a>),
                  then run the command again, or publish now and update the key later.
                </div>
              )}
              <div className="value" style={{ color: 'var(--color-text-muted)' }}>{(preview.bytes / 1024).toFixed(1)} KB</div>
            </div>
          )}

          {verified.emails.length > 0 && !needsName && (
            <label className="email-toggle">
              <input type="checkbox" checked={includeEmail} onChange={e => setIncludeEmail(e.target.checked)} />
              <span>
                Include my email ({verified.emails.join(', ')}). Only if it's already public; it can't be removed later.
              </span>
            </label>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Step 4: Generate Identity Claim ─────────────────────────────────────────

function StepAttest({ active, done, attestation, onPublish, activeClaims = [], replaceIndex, setReplaceIndex }) {
  const [publishStatus, setPublishStatus] = useState(null)
  const [txHash, setTxHash] = useState(null)

  const { writeContractAsync } = useWriteContract()
  const { empty } = useIsEmpty(attestation?.ethAddress)
  const replacing = replaceIndex !== null && replaceIndex !== undefined

  if (!active && !done) return (
    <div className={`step`}>
      <div className="step-header">
        <span className="step-num">03 //</span>
        <span className="step-title">Publish</span>
      </div>
    </div>
  )

  const handlePublish = async () => {
    try {
      setPublishStatus({ type: 'info', msg: 'Sending transaction…' })

      const payload = [
        fingerprintToBytes(attestation.gpgFingerprint),
        stringToHex(attestation.gpgSignature),
        stringToHex(attestation.gpgPublicKey),
      ]
      // `reattest` revokes the chosen claim and publishes the new one in a single transaction.
      const hash = replaceIndex !== null && replaceIndex !== undefined
        ? await writeContractAsync({
            address: REGISTRY_ADDRESS,
            abi: REGISTRY_ABI,
            functionName: 'reattest',
            args: [BigInt(replaceIndex), ...payload],
            chainId: CHAIN.id,
          })
        : await writeContractAsync({
            address: REGISTRY_ADDRESS,
            abi: REGISTRY_ABI,
            functionName: 'attest',
            args: payload,
            chainId: CHAIN.id,
          })

      setTxHash(hash)
      setPublishStatus({ type: 'info', msg: `Waiting for confirmation… tx: ${hash.slice(0, 10)}…` })

      // RPC_URL follows VITE_CHAIN; the raw env var is always the mainnet URL.
      const client = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) })
      const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 4_000 })

      if (receipt.status === 'success') {
        setPublishStatus({ type: 'ok', msg: `✓ Attested on-chain.` })
        onPublish && onPublish()
      } else {
        setPublishStatus({ type: 'err', msg: `Transaction reverted. Tx: ${hash}` })
      }
    } catch (err) {
      setPublishStatus({ type: 'err', msg: err.shortMessage || err.message })
    }
  }

  const explorerUrl = attestation?.ethAddress
    ? `/eth/${attestation.ethAddress}`
    : null

  return (
    <div className={`step ${active && !done ? 'active' : ''} ${done ? 'done' : ''}`}>
      <div className="step-header">
        <span className={`step-num ${active && !done ? 'active-num' : ''}`}>03 //</span>
        <span className="step-title">Publish</span>
        {done && <span className="step-badge">✓ published</span>}
      </div>

      {done && attestation && (
        <div className="fade-in">
          <div className="status ok">
            Your claim is on-chain. Your address and your PGP key now point at each other, and anyone can check it.
          </div>

          <div style={{ marginTop: 16 }} className="row">
            <a href={explorerUrl} className="btn btn-primary" target="_blank" rel="noopener noreferrer">
              View identity
            </a>
            {txHash && (
              <>
                {EXPLORER_URL && (
                  <a className="btn btn-sm" href={`${EXPLORER_URL}/tx/${txHash}`} target="_blank" rel="noopener noreferrer">
                    View Transaction
                  </a>
                )}
                <button className="btn btn-sm" onClick={(e) => { copyToClipboard(txHash, e); }}>
                  Copy Tx Hash
                </button>
              </>
            )}
          </div>

        </div>
      )}

      {active && !done && attestation && (
        <div className="fade-in">
          <p className="helper">
            Publishing from your connected wallet proves the address is yours. What's stored: your address,
            this key with the name above, and the signed line. Readable by anyone, from any Ethereum node,
            for good. You can revoke it later but not erase it.
          </p>

          {activeClaims.length > 0 && (
            <div className="mono-box" style={{ marginBottom: 12 }}>
              <div className="label">Replace an existing claim?</div>
              <select
                value={replaceIndex === null || replaceIndex === undefined ? '' : String(replaceIndex)}
                onChange={e => setReplaceIndex(e.target.value === '' ? null : Number(e.target.value))}
                style={{ marginTop: 6 }}
              >
                <option value="">No — add alongside my active claims</option>
                {activeClaims.map(c => (
                  <option key={c.index} value={String(c.index)}>
                    Yes — revoke #{c.index} ({c.fingerprint.toUpperCase().slice(0, 8)}…{c.fingerprint.toUpperCase().slice(-8)}) in the same transaction
                  </option>
                ))}
              </select>
              {activeClaims.some(c => c.fingerprint === attestation.gpgFingerprint.toLowerCase()) && (replaceIndex === null || replaceIndex === undefined) && (
                <div className="status err" style={{ marginTop: 8 }}>
                  This key already has an active claim. Pick it above to replace it — the registry allows one active claim per key.
                </div>
              )}
            </div>
          )}

          <button className="btn btn-primary" onClick={handlePublish} disabled={publishStatus?.type === 'info' || empty} title={empty ? 'This address has no ETH for the fee' : undefined}>
            {publishStatus?.type === 'info' ? 'Publishing…' : (replacing ? 'Replace & Publish' : 'Publish to Registry')}
          </button>

          {publishStatus && <div className={`status ${publishStatus.type}`}>{publishStatus.msg}</div>}

          {empty && (
            <Authorize
              address={attestation.ethAddress}
              op={replacing ? 'reattest' : 'attest'}
              fields={{ fingerprint: attestation.gpgFingerprint, key: attestation.gpgPublicKey, signature: attestation.gpgSignature, index: replacing ? replaceIndex : undefined, includeEmail: (attestation.gpgMeta?.userIDs || []).some(u => u.includes('@')) }}
              onPublished={hash => { setTxHash(hash); setPublishStatus({ type: 'ok', msg: '✓ Attested on-chain.' }); onPublish && onPublish() }}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ─── Your Identity Claims (with Revoke) ──────────────────────────────────────

function formatDate(ts) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

/** The connected wallet's claims from the v2 registry, newest first, with the stored key. */
function useMyAttestations(address) {
  const { data: rows, refetch: refetchRows, isFetched } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: 'attestationsOf',
    args: address ? [address] : undefined,
    chainId: CHAIN.id,
    query: { enabled: !!address },
  })
  const count = rows ? rows.length : 0

  const contracts = useMemo(() => {
    if (!address || !count) return []
    return Array.from({ length: count }, (_, i) => ({
      address: REGISTRY_ADDRESS,
      abi: REGISTRY_ABI,
      functionName: 'getPayload',
      args: [address, BigInt(i)],
      chainId: CHAIN.id,
    }))
  }, [address, count])

  const { data: payloads, refetch: refetchPayloads } = useReadContracts({
    contracts,
    query: { enabled: contracts.length > 0 },
  })

  const attestations = useMemo(() => {
    if (!rows) return []
    return rows
      .map((row, index) => {
        const p = payloads?.[index]
        const revokedAt = Number(row.revokedAt)
        return {
          index,
          fingerprint: bytesToFingerprint(row.fingerprint),
          createdAt: Number(row.createdAt),
          revoked: revokedAt !== 0,
          pgpPublicKey: p?.status === 'success' ? hexToString(p.result[1]) : null,
        }
      })
      .reverse()
  }, [rows, payloads])

  const refetch = useCallback(() => { refetchRows(); refetchPayloads() }, [refetchRows, refetchPayloads])
  const loaded = isFetched && (count === 0 || payloads !== undefined)
  return { attestations, count, refetch, loaded }
}

/** Paste a fresh export → (strip emails unless included) → `updateKey`. Same key, new notations, no new signature. */
function UpdateKeyPanel({ claim, address, hasEmail = false, onDone, onCancel, initialKey = null }) {
  const [keyText, setKeyText] = useState(initialKey || '')
  const { empty } = useIsEmpty(address)
  const [withEmail, setWithEmail] = useState(hasEmail) // defaults to what the claim holds today
  const [preview, setPreview] = useState(null)
  const [status, setStatus] = useState(null)
  const [result, setResult] = useState(null) // { hash, proofs, kept } once the update is confirmed
  const { writeContractAsync } = useWriteContract()

  useEffect(() => {
    let cancelled = false
    setPreview(null)
    setStatus(null)
    const raw = keyText.trim()
    if (!raw) return
    const text = splitPaste(raw).key || raw
    ;(async () => {
      const info = await parsePgpKey(text)
      if (cancelled) return
      if (!info) { setStatus({ type: 'err', msg: 'That is not a PGP public key.' }); return }
      if (info.fingerprint.toLowerCase() !== claim.fingerprint) {
        setStatus({ type: 'err', msg: `That key's fingerprint (${info.fingerprint}) is not this claim's key.` })
        return
      }
      let armored, kept, removed
      if (withEmail) {
        armored = text; kept = info.userIDs; removed = []
      } else {
        const stripped = await stripEmailUserIDs(text)
        if (cancelled) return
        if (!stripped) {
          const name = (info.userIDs || []).map(u => u.replace(/\s*<[^>]*>/, '').replace(/\s*\([^)]*\)/, '').replace(/["$`\\]/g, '').trim()).find(Boolean) || 'Your Name'
          setStatus({ type: 'err', msg: `This key's only name includes your email. Add a name without it (gpg --quick-add-uid ${claim.fingerprint.toUpperCase()} "${name}"), run the command again and paste, or tick "Include my email".` })
          return
        }
        armored = stripped.armored; kept = stripped.kept; removed = stripped.removed
      }
      const published = await parsePgpKey(armored)
      const proofs = (published?.notations || []).filter(n => identifyProof(n)).length
      setPreview({ armored, kept, removed, proofs, bytes: new TextEncoder().encode(armored).length })
    })()
    return () => { cancelled = true }
  }, [keyText, claim.fingerprint, withEmail])

  const handleUpdate = async () => {
    if (!preview) return
    if (preview.bytes > MAX_PUBKEY_BYTES) { setStatus({ type: 'err', msg: `Key is ${(preview.bytes / 1024).toFixed(1)} KB; the registry accepts up to ${MAX_PUBKEY_BYTES / 1024} KB. Export a minimal key (gpg --export-options export-minimal).` }); return }
    try {
      setStatus({ type: 'info', msg: 'Sending transaction…' })
      const hash = await writeContractAsync({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: 'updateKey',
        args: [BigInt(claim.index), stringToHex(preview.armored)],
        chainId: CHAIN.id,
      })
      setStatus({ type: 'info', msg: 'Waiting for confirmation…' })
      const client = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) })
      const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 4_000 })
      if (receipt.status === 'success') {
        setStatus(null)
        setResult({ hash, proofs: preview.proofs, kept: preview.kept })
        onDone && onDone()
      } else {
        setStatus({ type: 'err', msg: `Transaction reverted. Tx: ${hash}` })
      }
    } catch (err) {
      setStatus({ type: 'err', msg: err.shortMessage || err.message })
    }
  }

  const exportCommand = `gpg --export-options export-minimal,no-export-attributes --armor --export ${claim.fingerprint.toUpperCase()}`

  if (result) return (
    <div className="update-panel fade-in">
      <div className="status ok">
        ✓ Key updated on claim #{claim.index}. Published name: {result.kept.join(', ')} · proofs: {result.proofs}.
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <a href={`/eth/${address}`} className="btn btn-primary" target="_blank" rel="noopener noreferrer">View identity</a>
        {EXPLORER_URL && (
          <a className="btn btn-sm" href={`${EXPLORER_URL}/tx/${result.hash}`} target="_blank" rel="noopener noreferrer">View Transaction</a>
        )}
        <button className="btn btn-sm" onClick={(e) => copyToClipboard(result.hash, e)}>Copy Tx Hash</button>
        <button className="btn btn-sm" onClick={onCancel}>close</button>
      </div>
    </div>
  )

  return (
    <div className="update-panel fade-in">
      <p className="helper">
        Update the key on claim #{claim.index}: add or change proofs on your published name, then run this
        and paste the output. No new signature is needed.
      </p>
      <div className="command-block wrap"><span className="prompt">$ </span>{exportCommand}</div>
      <button className="btn btn-sm" onClick={(e) => copyToClipboard(exportCommand, e)}>copy command</button>

      <textarea
        className="pgp-input"
        style={{ minHeight: 120, marginTop: 16 }}
        placeholder={`Paste the whole output here:\n\n-----BEGIN PGP PUBLIC KEY BLOCK-----\n…\n-----END PGP PUBLIC KEY BLOCK-----`}
        value={keyText}
        onChange={e => setKeyText(e.target.value)}
        spellCheck={false}
      />

      {preview && (
        <div className="mono-box fade-in" style={{ marginTop: 12 }}>
          <div className="label">Going on-chain</div>
          <div className="value">Name: {preview.kept.join(', ')}</div>
          {preview.removed.length > 0 && (
            <div className="value" style={{ color: 'var(--color-text-muted)' }}>Left out (has an email): {preview.removed.join(', ')}</div>
          )}
          <div className="value">Proofs: {preview.proofs}</div>
          <div className="value" style={{ color: 'var(--color-text-muted)' }}>{(preview.bytes / 1024).toFixed(1)} KB</div>
        </div>
      )}

      {keyText.trim() && (
        <label className="email-toggle">
          <input type="checkbox" checked={withEmail} onChange={e => { setWithEmail(e.target.checked); setStatus(null) }} />
          <span>
            Include my email. Only if it's already public: it can't be removed later.
            {hasEmail && !withEmail && ' This claim has it now; unticked, the updated key leaves it out (older copies stay in chain history).'}
          </span>
        </label>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" onClick={handleUpdate} disabled={!preview || status?.type === 'info' || empty} title={empty ? 'This address has no ETH for the fee' : undefined}>
          {status?.type === 'info' ? 'Updating…' : 'Update key'}
        </button>
        <button className="btn btn-sm" onClick={onCancel}>cancel</button>
      </div>
      {status && <div className={`status ${status.type}`}>{status.msg}</div>}
      {empty && preview && preview.bytes <= MAX_PUBKEY_BYTES && (
        <Authorize
          address={address}
          op="update-key"
          fields={{ fingerprint: claim.fingerprint, key: preview.armored, index: claim.index, includeEmail: withEmail }}
          onPublished={hash => { setStatus(null); setResult({ hash, proofs: preview.proofs, kept: preview.kept }); onDone && onDone() }}
        />
      )}
    </div>
  )
}

function YourAttestations({ address, attestations, count, refetch, onCreate, handoff = null }) {
  const [revokeStatus, setRevokeStatus] = useState({})
  const [emailByIndex, setEmailByIndex] = useState({}) // index → true when the on-chain key has an email user ID
  const [updating, setUpdating] = useState(handoff ? handoff.index : null) // index of the claim whose key is being updated
  useEffect(() => { if (handoff) setUpdating(handoff.index) }, [handoff])   // the hand-off arrives once the right wallet is connected
  const { writeContractAsync } = useWriteContract()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const next = {}
      for (const a of attestations) {
        if (!a.revoked && a.pgpPublicKey) next[a.index] = await hasEmailUserID(a.pgpPublicKey)
      }
      if (!cancelled) setEmailByIndex(next)
    })()
    return () => { cancelled = true }
  }, [attestations])

  if (count === 0) return (
    <div className="step active">
      <div className="step-header">
        <span className="step-title">Your claims</span>
        <span className="step-badge">none yet</span>
      </div>
      <p className="helper">This wallet has no claim yet.</p>
      <button className="btn btn-primary" onClick={onCreate}>Create your first claim</button>
    </div>
  )

  const handleRevoke = async (index) => {
    try {
      setRevokeStatus(s => ({ ...s, [index]: { type: 'info', msg: 'Sending revoke…' } }))

      const hash = await writeContractAsync({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: 'revoke',
        args: [BigInt(index)],
        chainId: CHAIN.id,
      })

      setRevokeStatus(s => ({ ...s, [index]: { type: 'info', msg: `Waiting for confirmation…` } }))

      const client = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) })
      await client.waitForTransactionReceipt({ hash, pollingInterval: 4_000 })

      setRevokeStatus(s => ({ ...s, [index]: { type: 'ok', msg: 'Revoked.' } }))
      refetch()
    } catch (err) {
      setRevokeStatus(s => ({ ...s, [index]: { type: 'err', msg: err.shortMessage || err.message } }))
    }
  }

  const activeCount = attestations.filter(a => !a.revoked).length

  return (
    <div className="step active">
      <div className="step-header">
        <span className="step-title">Your claims</span>
        <span className="step-badge">{activeCount} active</span>
      </div>

      <div className="attestation-table-wrap">
        <table className="attestation-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Fingerprint</th>
              <th>Date</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {/* Active first, then revoked; newest first within each — same order as the identity page. */}
            {[...attestations].sort((a, b) => (a.revoked === b.revoked ? b.index - a.index : a.revoked ? 1 : -1)).map(a => (
              <Fragment key={a.index}>
              <tr>
                <td className="att-index">{a.index}</td>
                <td>
                  <a href={`/pgp/${a.fingerprint.toUpperCase()}`} rel="noopener noreferrer" style={{ color: 'inherit' }}>
                    {a.fingerprint.toUpperCase().slice(0, 8)}...{a.fingerprint.toUpperCase().slice(-8)}
                  </a>
                </td>
                <td className="att-date">{formatDate(a.createdAt)}</td>
                <td>
                  <span className={`status-badge ${a.revoked ? 'revoked' : 'active'}`}>
                    {a.revoked ? 'revoked' : 'active'}
                  </span>
                </td>
                <td className="att-actions-cell">
                  {!a.revoked && (
                    <div className="att-actions">
                      <button className="btn btn-sm" onClick={() => setUpdating(updating === a.index ? null : a.index)}>
                        {updating === a.index ? 'Close' : 'Update'}
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={() => handleRevoke(a.index)}
                        disabled={revokeStatus[a.index]?.type === 'info'}
                      >
                        {revokeStatus[a.index]?.type === 'info' ? 'Revoking…' : 'Revoke'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
              {(revokeStatus[a.index]?.type === 'ok' || revokeStatus[a.index]?.type === 'err' || (!a.revoked && emailByIndex[a.index])) && (
                <tr className="att-note-row">
                  <td colSpan={5} style={{ padding: '0 16px 10px' }}>
                    {!a.revoked && emailByIndex[a.index] && (
                      <div className="lookup-detected" style={{ fontSize: '12px', margin: 0 }}
                        title="The key stored on this claim carries an email user ID. Update the key with 'Keep my email off-chain' to publish a copy without it; the old copy stays in chain history.">
                        Email included on this claim
                      </div>
                    )}
                    {revokeStatus[a.index] && revokeStatus[a.index].type !== 'info' && (
                      <span className={`status ${revokeStatus[a.index].type}`} style={{ fontSize: '12px' }}>
                        {revokeStatus[a.index].msg}
                      </span>
                    )}
                  </td>
                </tr>
              )}
              {updating === a.index && !a.revoked && (
                <tr key={`${a.index}-update`} className="att-update-row">
                  <td colSpan={5} style={{ padding: '4px 8px 12px' }}>
                    <UpdateKeyPanel
                      claim={a}
                      address={address}
                      hasEmail={handoff && handoff.index === a.index ? handoff.includeEmail : !!emailByIndex[a.index]}
                      initialKey={handoff && handoff.index === a.index ? handoff.key : null}
                      onDone={refetch}
                      onCancel={() => setUpdating(null)}
                    />
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Root Attest component ─────────────────────────────────────────────────

export default function Attest() {
  const { address, isConnected } = useAccount()

  // A link from `thurin attest --no-key` carries the PGP half in the fragment: the
  // steps it covers start out done, and only connecting + publishing are left.
  const [handoff, handoffError] = useMemo(() => {
    try { return [readHandoff(), null] } catch (e) { return [null, e.message] }
  }, [])
  const handoffNetworkOk = !handoff || handoff.network === NETWORK
  // An authorized hand-off is published by *any* wallet through the `…For` calls; the
  // plain kind needs the owner's wallet and flows through the wizard below.
  const authorized = handoff && handoffNetworkOk && handoff.authorization ? handoff : null
  const recordHandoff = handoff && handoffNetworkOk && !authorized && handoff.op === 'set-record' ? handoff : null
  const claimHandoff = handoff && handoffNetworkOk && !authorized && !recordHandoff && handoff.op !== 'update-key' ? handoff : null   // attest | reattest
  const updateHandoff = handoff && handoffNetworkOk && !authorized && handoff.op === 'update-key' ? handoff : null
  const wrongWallet = !!(handoff && !authorized && isConnected && address && address.toLowerCase() !== handoff.owner)
  // The fragment is read once; a new link pasted over this page should start over.
  useEffect(() => {
    const onHash = () => window.location.reload()
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // State flowing through the steps
  const [pgpData, setPgpData]   = useState(null)   // { pgpSig, signedText, keyId, fingerprint, armoredPublicKey, pgpMeta }
  const [published, setPublished] = useState(false)
  const [linkUsed, setLinkUsed] = useState(false) // a CLI link fills one claim; after that, New claim is a normal one
  const linkClaim = claimHandoff && !linkUsed ? claimHandoff : null
  // The paste lives here so switching tabs mid-way doesn't lose it; a CLI link fills it in.
  const [paste, setPaste] = useState(claimHandoff?.key && claimHandoff?.signature ? `${claimHandoff.signature}\n${claimHandoff.key}` : '')
  const [includeEmail, setIncludeEmail] = useState(!!claimHandoff?.includeEmail) // off unless ticked
  const [replaceIndex, setReplaceIndex] = useState(null) // claim to revoke in the same tx, if any
  const { attestations: myClaims, count: myCount, refetch: refetchMine, loaded: myLoaded } = useMyAttestations(address)
  const activeClaims = useMemo(() => myClaims.filter(c => !c.revoked), [myClaims])

  // Tabs: returning users land on their claims, first-timers on the wizard.
  const [tab, setTab] = useState(null) // 'claims' | 'new'
  useEffect(() => {
    if (tab !== null || !myLoaded) return
    setTab(updateHandoff ? 'claims' : claimHandoff ? 'new' : activeClaims.length > 0 ? 'claims' : 'new')
  }, [myLoaded, activeClaims.length, tab, claimHandoff, updateHandoff])
  useEffect(() => { if (!isConnected) setTab(null) }, [isConnected])

  // Default to replacing the active claim for the same key (the registry allows one per key).
  useEffect(() => {
    if (!pgpData?.fingerprint) return
    const same = activeClaims.find(c => c.fingerprint === pgpData.fingerprint.toLowerCase())
    setReplaceIndex(linkClaim?.op === 'reattest' ? linkClaim.index : same ? same.index : null)
  }, [pgpData?.fingerprint, activeClaims, linkClaim])

  // Derive active step
  const step = !isConnected ? 1
    : !pgpData ? 2
    : 3

  // Build final attestation object. The ETH side of the claim is the publish tx
  // itself (msg.sender + fingerprint), so no separate ETH signature is stored.
  const attestation = pgpData ? {
    version: '3',
    timestamp: new Date().toISOString(),
    ethAddress: address,
    gpgFingerprint: pgpData.fingerprint,
    gpgSignedMessage: pgpData.signedText,
    gpgSignature: pgpData.pgpSig,
    gpgPublicKey: pgpData.armoredPublicKey,
    gpgKeyId: pgpData.keyId,
    gpgMeta: pgpData.pgpMeta,
  } : null

  return (
    <>
      <div className="attest-intro" style={{ maxWidth: 640, margin: '0 auto', padding: '0 16px' }}>
        {handoffError ? (
          <div className="status err" style={{ marginBottom: 24 }}>{handoffError}</div>
        ) : handoff && !handoffNetworkOk ? (
          <div className="status err" style={{ marginBottom: 24 }}>
            This link was made for <strong>{handoff.network}</strong>, but this page publishes to <strong>{NETWORK}</strong>.
            Run the command again with <code>--network {NETWORK}</code>, or open the link on a {handoff.network} build.
          </div>
        ) : authorized ? (
          <p className="helper" style={{ marginBottom: 24 }}>
            This link came from the Thurin CLI. <strong>{shortAddr(authorized.owner)}</strong> has already signed
            {authorized.op === 'attest' ? ' a claim' : authorized.op === 'reattest' ? ' a replacement claim' : authorized.op === 'update-key' ? ' a key update' : ' a revocation'},
            so any wallet can publish it and pay the fee. Connect yours, check what it says, and publish.
            Nothing was sent anywhere; the part of the link after <code>#</code> stays in this browser.
          </p>
        ) : handoff ? (
          <>
            <p className="helper">
              This link came from the Thurin CLI. It carries {handoff.op === 'update-key' ? 'an updated key for claim' : 'a signed claim for'}{' '}
              {handoff.op === 'update-key' ? `#${handoff.index} of ` : ''}<strong>{shortAddr(handoff.owner)}</strong>: the wallet that has to publish it.
              Nothing was sent anywhere; the part of the link after <code>#</code> stays in this browser.
            </p>
            <p className="helper" style={{ marginBottom: 24 }}>
              Connect that wallet, check the summary, and publish. Nothing to paste. Anyone can make a link like this,
              so publish only if the key it names is yours: <code>{handoff.fingerprint}</code>.
            </p>
            {wrongWallet && (
              <div className="status err" style={{ marginBottom: 24 }}>
                Connected as <strong>{shortAddr(address)}</strong>, but this claim was signed for <strong>{shortAddr(handoff.owner)}</strong>.
                Switch to that account in your wallet.
              </div>
            )}
          </>
        ) : isConnected && myLoaded && activeClaims.length > 0 ? (
          <p className="helper">
            Attest links your Ethereum address to your PGP key. This wallet already has a claim:
            update or replace it under <strong>Your claims</strong>, or make a new one.
          </p>
        ) : (
          <>
            <p className="helper">
              Attest links your Ethereum address to your PGP key, so anyone can check that both belong to
              the same person. One command, one paste, one transaction.
            </p>
            <p className="helper">
              What goes on-chain: your address, your key's fingerprint, one name from your key, and the
              proofs on it. Your email stays off unless you say so.
            </p>
            <p className="helper" style={{ marginBottom: 24 }}>
              You'll need a wallet, a PGP key with <code>gpg</code> in a terminal <em>(desktop only)</em>,
              and a little ETH for the fee.
            </p>
          </>
        )}
      </div>

      <div className="steps">
          <StepConnect
            active={step === 1}
            done={step > 1}
          />

          {authorized && <SubmitAuthorization handoff={authorized} isConnected={isConnected} />}
          {recordHandoff && !wrongWallet && <SetRecordPanel handoff={recordHandoff} isConnected={isConnected} />}

          {isConnected && !authorized && !recordHandoff && (
            <div className="attest-tabs" role="tablist">
              <button role="tab" className={`attest-tab ${tab === 'claims' ? 'active' : ''}`} onClick={() => setTab('claims')}>
                Your claims{myLoaded && activeClaims.length > 0 && <span className="attest-tab-count">{activeClaims.length}</span>}
              </button>
              <button role="tab" className={`attest-tab ${tab === 'new' ? 'active' : ''}`} onClick={() => {
                // After a publish, "New claim" starts over.
                if (published) { setPublished(false); setPgpData(null); setPaste(''); setIncludeEmail(false); setLinkUsed(true) }
                setTab('new')
              }}>
                New claim
              </button>
            </div>
          )}

          {isConnected && !authorized && !recordHandoff && tab === 'claims' && (
            <YourAttestations address={address} attestations={myClaims} count={myCount} refetch={refetchMine} onCreate={() => setTab('new')} handoff={!wrongWallet ? updateHandoff : null} />
          )}

          {isConnected && !authorized && !recordHandoff && tab === 'new' && (
            <>
              <StepSign
                active={step === 2}
                done={step > 2}
                locked={published}
                address={address}
                expectedFingerprint={linkClaim?.fingerprint || null}
                includeEmail={includeEmail}
                setIncludeEmail={setIncludeEmail}
                onVerified={setPgpData}
                paste={paste}
                setPaste={setPaste}
                fromLink={!!(linkClaim && !wrongWallet && linkClaim.key && linkClaim.signature)}
              />

              <StepAttest
                active={step === 3}
                done={published}
                attestation={attestation}
                activeClaims={activeClaims}
                replaceIndex={replaceIndex}
                setReplaceIndex={setReplaceIndex}
                onPublish={() => { setPublished(true); refetchMine() }}
              />
            </>
          )}
      </div>

      {!handoff && (
        <p className="helper attest-cli">
          Rather use a terminal? The Thurin CLI does this and more:<br />
          <code>npx @thurinlabs/thurin attest</code> · <a href="https://docs.thurin.id/#/cli" target="_blank" rel="noopener noreferrer">docs</a>
        </p>
      )}
    </>
  )
}
