import { Fragment, useState, useMemo, useEffect } from 'react'
import { useAccount, useWriteContract, useReadContract } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import * as openpgp from 'openpgp'
import { createPublicClient, http, toHex, encodeFunctionData } from 'viem'
import { asArmor } from '../payload'
import { kindLabel } from '../recordLabels'
import { spacedFingerprint, formatDate, claimStateLabel } from '../format'
import { contractErrorText, hasEmailUserID, keyProblemText, sameFingerprint, parsePgpKey, identifyProof, fingerprintToBytes, verifyAttestation, readClaims, verifyStatementSignature, leanKey, claimSignature, signatureEmail } from '@thurinlabs/identity-kit'
import { REGISTRY_ADDRESS, REGISTRY_ABI, RPC_URL, CHAIN, EXPLORER_URL, NETWORK, readClient } from '../wagmiConfig'
import { readHandoff, forgetHandoff } from '../handoff'
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
    btn.textContent = 'copied'
    btn.classList.add('copied')
    setTimeout(() => {
      btn.textContent = original
      btn.classList.remove('copied')
    }, 1200)
  }
}

/** The signed block and the public key block out of one terminal paste (prompts and noise around them are ignored). */
function splitPaste(text) {
  // A detached signature (the command's output) or a whole clearsigned message (gpg --clearsign).
  const sig = text.match(/-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?-----END PGP SIGNATURE-----/)?.[0]
    ?? text.match(/-----BEGIN PGP SIGNATURE-----[\s\S]*?-----END PGP SIGNATURE-----/)?.[0]
    ?? null
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

// The line gpg signs; it must match exactly
function gpgPayload(address) {
  return `I control the Ethereum address: ${address.toLowerCase()}`
}

// PGPRegistry.MAX_KEY_BYTES (16 KB). A minimal export stays well under it, and every byte costs gas.
const MAX_PUBKEY_BYTES = 16384

// One command: sign the line, then print the same key's public half. Without a chosen key it
// takes the first secret key that can sign (gpg's own default unless gpg.conf sets default-key);
// the page shows which key it got, and "Use a different key" names one instead.
const PICK_SIGNING_KEY = `F=$(gpg -K --with-colons | awk -F: '$1=="sec"&&$12~/S/{s=1}s&&$1=="fpr"{print $10;exit}')`
const EXPORT_OPTIONS = 'export-minimal,no-export-attributes'

// Lean format: a detached text-mode signature over the line (no trailing line break) and the key,
// every subkey included. Emails stay in the export so "Include my email" works without
// re-running; the page leaves them out otherwise.
function signCommand(address, key) {
  const sign = `printf '%s' "${gpgPayload(address)}" | gpg --detach-sign --textmode --disable-signer-uid --armor`
  const exp = `gpg --export-options ${EXPORT_OPTIONS} --armor --export`
  return key
    ? `${sign} -u "${key}"; ${exp} "${key}"`
    : `${PICK_SIGNING_KEY}; ${sign} -u $F; ${exp} $F`
}

// ─── Step 1: Connect Wallet ──────────────────────────────────────────────────

function StepConnect({ active, done }) {
  const { isConnected } = useAccount()

  return (
    <div className={`step ${active ? 'active' : ''} ${done ? 'done' : ''}`}>
      <div className="step-header">
        <span className={`step-num ${active ? 'active-num' : ''}`}>01 //</span>
        <span className="step-title">Connect your wallet</span>
        {done && <span className="step-badge">✓ connected</span>}
      </div>

      {!isConnected && (
        <p className="helper">Connect the wallet whose address gets the key. Already have a claim? <a href="/" rel="noopener noreferrer">Search for it</a>.</p>
      )}

      <ConnectButton showBalance={false} />
    </div>
  )
}

// ─── Step 2: Sign ────────────────────────────────────────────────────────────
//
// One paste: the signature and the exported key. The page finds the key that signed, checks it
// as a lookup will, and shows what goes on-chain (emails out unless ticked). No keyserver:
// keys.openpgp.org drops user IDs without an email, so it can't supply the name proofs sit on.

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
      setStatus({ type: 'err', msg: `That's only part of it: the output has a signature and a public key block${sig ? '; the key block is missing' : key ? '; the signature is missing' : ''}. Paste all of it.` })
      return
    }
    setStatus({ type: 'info', msg: 'Checking the signature…' })
    ;(async () => {
      try {
        const clearsigned = sig.includes('-----BEGIN PGP SIGNED MESSAGE-----')
        if (clearsigned) {
          const message = await openpgp.readCleartextMessage({ cleartextMessage: sig })
          if (!message.getText().toLowerCase().includes(address.toLowerCase())) {
            throw new Error(`the signed line doesn't name your connected address. Copy the command again: it has to sign "${gpgPayload(address)}".`)
          }
        }
        const sigPackets = clearsigned
          ? (await openpgp.readCleartextMessage({ cleartextMessage: sig })).signature.packets
          : (await openpgp.readSignature({ armoredSignature: sig })).packets
        const signedText = gpgPayload(address)
        // `--export "<email>"` can print several keys: use the one that made the signature. The
        // check is the kit's, the same one every lookup runs (curve policy, key valid now), over
        // the rebuilt line, which is what a lean claim stores.
        const keys = await openpgp.readKeys({ armoredKeys: key })
        const issuer = sigPackets[0]?.issuerKeyID
        let publicKey = null
        let ownKeyReason = null // the signer's key is in the paste, but the signature didn't verify
        let keyProblem = null   // …because of the key itself (expired, revoked, unsupported): signing again won't help
        for (const k of keys) {
          const v = await verifyStatementSignature({ key: k.armor(), signature: sig, address })
          if (v.verified) { publicKey = k; break }
          if (issuer && k.getKeys(issuer).length) {
            ownKeyReason = v.reason || 'verification failed'
            keyProblem = keyProblemText(await verifyAttestation({ pgpPublicKey: k.armor(), pgpSignature: sig, fingerprint: k.getFingerprint(), ethAddress: address }))
          }
        }
        if (!publicKey && keyProblem) throw new Error(`${keyProblem.sentence} ${keyProblem.fix}`)
        if (!publicKey) throw new Error(ownKeyReason
          ? `the key that signed is in the paste, but its signature doesn't verify (${ownKeyReason}). If \`echo test | gpg --clearsign | gpg --verify\` says BAD too, it's your gpg setup, not this page. Otherwise check the line wasn't changed: it has to be "${gpgPayload(address)}".`
          : `the signature doesn't match the key in the paste. Run the whole command again and paste all of its output.`)
        const fingerprint = publicKey.getFingerprint().toUpperCase()
        if (wantedFingerprint && !sameFingerprint(fingerprint, wantedFingerprint)) {
          throw new Error(`this was signed by ${spacedFingerprint(fingerprint)}, not ${spacedFingerprint(wantedFingerprint)}.`)
        }
        const expirationTime = await publicKey.getExpirationTime()
        const expiresAt = expirationTime && expirationTime !== Infinity ? new Date(expirationTime).toISOString() : null
        const keyId = sigPackets[0]?.issuerKeyID?.toHex()?.toUpperCase() ?? null
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

  // What gets published follows the email switch: the key as raw bytes (emails left out unless
  // ticked, newest self-signatures only) and the signature alone; the
  // line it signs is rebuilt by every reader. A clearsign that signed a trailing line break (made
  // with `echo`) is published whole, so gpg can still verify what the registry returns.
  useEffect(() => {
    if (!verified) return
    let cancelled = false
    ;(async () => {
      const full = verified.armoredFull
      const fullInfo = await parsePgpKey(full)
      const proofsTotal = fullInfo ? fullInfo.notations.filter(n => identifyProof(n)).length : 0

      const lean = await leanKey(full, { includeEmail })
      if (cancelled) return
      if (!lean) {
        setPreview(null); setNeedsName({ proofs: proofsTotal }); setStatus(null); onVerified(null)
        return
      }
      setNeedsName(false)
      if (lean.keyNotationEmails.length) {
        setPreview(null); onVerified(null)
        setStatus({ type: 'err', msg: `A notation on the key itself holds an email (${lean.keyNotationEmails.join(', ')}), and it would go on-chain for good. Remove it with gpg (gpg --edit-key, then notation), export again and paste, or tick "Include my email".` })
        return
      }
      const claimSig = await claimSignature({ signature: verified.sig, key: lean.binary, address })
      if (cancelled) return
      const sigBytes = claimSig?.signature
      if (!sigBytes) {
        setPreview(null); onVerified(null)
        setStatus({ type: 'err', msg: "Couldn't read the signature. Run the command again and paste all of its output." })
        return
      }
      // gpg writes the email into the signature when told the key by email or name; the signature is kept on-chain.
      const signedEmail = await signatureEmail(verified.sig)
      if (cancelled) return
      if (signedEmail && !includeEmail) {
        setPreview(null); onVerified(null)
        setStatus({ type: 'err', msg: `The signature carries your email (${signedEmail}), and it would go on-chain for good. gpg adds it when it's told the key by email or name, or when gpg.conf sets "sender". Run the command above again (it leaves the email out) and paste the new output.` })
        return
      }

      const keyBytes = lean.binary.length
      if (keyBytes > MAX_PUBKEY_BYTES) {
        setPreview(null); onVerified(null)
        setStatus({ type: 'err', msg: `The key to publish is ${(keyBytes / 1024).toFixed(1)} KB, over the ${MAX_PUBKEY_BYTES / 1024} KB on-chain limit. It likely has many signatures or subkeys on it.` })
        return
      }

      // What a lookup will run on the published claim, run now on exactly those bytes.
      const check = await verifyAttestation({ pgpPublicKey: lean.binary, pgpSignature: sigBytes, fingerprint: verified.fingerprint, ethAddress: address })
      if (cancelled) return
      if (!check.verified) {
        setPreview(null); onVerified(null)
        setStatus({ type: 'err', msg: `The key as it would be published doesn't verify (${check.reason}). Nothing was sent.` })
        return
      }

      const pubInfo = await parsePgpKey(lean.binary)
      const proofsPublished = pubInfo ? pubInfo.notations.filter(n => identifyProof(n)).length : 0
      const otherNotes = pubInfo ? pubInfo.notations.filter(n => !identifyProof(n)).map(n => `${n.name}=${n.value}`) : []
      if (cancelled) return
      const bytes = keyBytes + (typeof sigBytes === 'string' ? new TextEncoder().encode(sigBytes).length : sigBytes.length)
      const before = new TextEncoder().encode(full).length + new TextEncoder().encode(verified.sig).length
      setPreview({ kept: lean.kept, removed: lean.removed, proofsPublished, proofsTotal, otherNotes, bytes, before })
      setStatus(null)
      onVerified({
        pgpSig: verified.sig,
        signedText: verified.signedText,
        keyId: verified.keyId,
        fingerprint: verified.fingerprint,
        keyHex: toHex(lean.binary),
        sigHex: toHex(sigBytes),
        pgpMeta: {
          userIDs: lean.kept,
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
            Run this in a terminal. It signs a line naming your Ethereum address and prints your public key.
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
                <div className="value" style={{ color: 'var(--color-text-muted)' }}>Left out (has an email, in the name or a notation): {preview.removed.join(', ')}</div>
              )}
              <div className="value">Proofs: {preview.proofsPublished}</div>
              {preview.otherNotes?.length > 0 && <div className="value" style={{ wordBreak: 'break-all' }}>Other notations: {preview.otherNotes.join(', ')}</div>}
              {preview.proofsPublished === 0 && preview.proofsTotal > 0 && (
                <div className="status err" style={{ marginTop: 8 }}>
                  Your {preview.proofsTotal === 1 ? 'proof is' : `${preview.proofsTotal} proofs are`} on a name being left out, so {preview.proofsTotal === 1 ? "it won't" : 'none will'} show.
                  Add {preview.proofsTotal === 1 ? 'it' : 'them'} to the published name (<a href="https://docs.thurin.id/#/guides/gnupg" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>how</a>),
                  then run the command again, or publish now and update the key later.
                </div>
              )}
              <div className="value" style={{ color: 'var(--color-text-muted)' }}>{(preview.bytes / 1024).toFixed(1)} KB{preview.before ? ` on-chain (${(preview.before / 1024).toFixed(1)} KB as pasted text)` : ''}</div>
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

// ─── Step 3: Publish ─────────────────────────────────────────────────────────

function StepAttest({ active, done, attestation, onPublish, activeClaims = [], replaceIndex, setReplaceIndex }) {
  const [publishStatus, setPublishStatus] = useState(null)
  const [txHash, setTxHash] = useState(null)

  const { writeContractAsync } = useWriteContract()
  const { empty } = useIsEmpty(attestation?.ethAddress)
  const replacing = replaceIndex !== null && replaceIndex !== undefined
  // The replaced claim's records move to the new one; a canary signed by the old key won't verify against a new key.
  const { data: movingRecords } = useReadContract({
    address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'recordsOf',
    args: replacing && attestation?.ethAddress ? [attestation.ethAddress, BigInt(replaceIndex)] : undefined,
    chainId: CHAIN.id, query: { enabled: replacing && !!attestation?.ethAddress },
  })
  const moving = movingRecords ? movingRecords[0].filter((_, i) => movingRecords[1][i]) : []
  // Where this address stands with the key: after "compromised" it can never claim it again.
  const { data: keyStatus } = useReadContract({
    address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'keyStatus',
    args: attestation?.ethAddress && attestation?.gpgFingerprint ? [attestation.ethAddress, fingerprintToBytes(attestation.gpgFingerprint)] : undefined,
    chainId: CHAIN.id, query: { enabled: !!attestation?.ethAddress && !!attestation?.gpgFingerprint },
  })
  const keyCompromised = keyStatus === 'compromised'
  const [oldCompromised, setOldCompromised] = useState(false)   // replacing a stolen key: mark it compromised in the same transaction
  // The names going on-chain, and any email among them (only there when the email box is ticked).
  const publishedNames = attestation?.gpgMeta?.userIDs ?? []
  const publishedEmails = publishedNames.map(u => u.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1]).filter(Boolean)
  const replacedFp = replacing ? activeClaims.find(c => c.index === replaceIndex)?.fingerprint : null
  const newKey = !!replacedFp && !!attestation && !sameFingerprint(replacedFp, attestation.gpgFingerprint)

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

      // Raw signature (or the whole clearsigned message) and key bytes (see the sign step).
      const payload = [
        fingerprintToBytes(attestation.gpgFingerprint),
        attestation.gpgSignatureHex,
        attestation.gpgPublicKeyHex,
      ]
      // `reattest` revokes the chosen claim and publishes the new one in a single transaction; the
      // old claim's records move to the new one. A stolen old key is also marked compromised, in the
      // same transaction (`multicall`), so this address can never claim it again.
      const reattestArgs = [BigInt(replaceIndex ?? 0), ...payload, true]
      const hash = replacing && oldCompromised && newKey
        ? await writeContractAsync({
            address: REGISTRY_ADDRESS,
            abi: REGISTRY_ABI,
            functionName: 'multicall',
            args: [[
              encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'reattest', args: reattestArgs }),
              encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'revoke', args: [BigInt(replaceIndex), 'compromised'] }),
            ]],
            chainId: CHAIN.id,
          })
        : replacing
        ? await writeContractAsync({
            address: REGISTRY_ADDRESS,
            abi: REGISTRY_ABI,
            functionName: 'reattest',
            args: reattestArgs,
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
        setPublishStatus({ type: 'ok', msg: '✓ Published.' })
        onPublish && onPublish()
      } else {
        setPublishStatus({ type: 'err', msg: `The transaction failed, so nothing changed. Tx: ${hash}` })
      }
    } catch (err) {
      setPublishStatus({ type: 'err', msg: contractErrorText(err) ?? err.shortMessage ?? err.message })
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
            Your PGP key is on your Ethereum address now, and anyone can check that both are yours.
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
            Publishing from your connected wallet proves this Ethereum address is yours. What's stored: your
            Ethereum address, this key with the {publishedNames.length > 1 ? 'names' : 'name'} above
            {publishedEmails.length > 0 && <>, including your email ({publishedEmails.join(', ')})</>}, and the
            signed line. Readable by anyone, from any Ethereum node, for good. You can revoke it later but not erase it.
          </p>

          {activeClaims.length > 0 && (
            <div className="mono-box" style={{ marginBottom: 12 }}>
              <div className="label">Replace an existing claim?</div>
              <select
                value={replaceIndex === null || replaceIndex === undefined ? '' : String(replaceIndex)}
                onChange={e => setReplaceIndex(e.target.value === '' ? null : Number(e.target.value))}
                style={{ marginTop: 6, width: '100%', maxWidth: '100%' }}
              >
                <option value="">No — add alongside my active claims</option>
                {activeClaims.map(c => (
                  <option key={c.index} value={String(c.index)}>
                    Yes, replace #{c.index} ({c.fingerprint.toUpperCase().slice(0, 8)}…{c.fingerprint.toUpperCase().slice(-8)}) in the same transaction
                  </option>
                ))}
              </select>
              {replacing && newKey && (
                <label className="checkbox-row" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 8 }}>
                  <input type="checkbox" checked={oldCompromised} onChange={e => setOldCompromised(e.target.checked)} />
                  <span className="helper prose" style={{ margin: 0 }}>The old key was compromised. It's marked so, and this address can never claim it again.</span>
                </label>
              )}
              {replacing && moving.length > 0 && (
                <div className="helper prose" style={{ marginTop: 8 }}>
                  The {moving.length === 1 ? 'record' : 'records'} on #{replaceIndex} ({moving.map(kindLabel).join(', ')}) {moving.length === 1 ? 'moves' : 'move'} to the new claim.
                  {newKey && moving.includes('thurin.canary') && ' Your canary was signed by the old key. After publishing, edit it and sign it again with the new key.'}
                </div>
              )}
              {activeClaims.some(c => sameFingerprint(c.fingerprint, attestation.gpgFingerprint)) && (replaceIndex === null || replaceIndex === undefined) && (
                <div className="status err" style={{ marginTop: 8 }}>
                  This key already has an active claim. Pick it above to replace it: one active claim per key.
                </div>
              )}
            </div>
          )}

          {keyCompromised && (
            <div className="status err" style={{ marginBottom: 12 }}>
              You revoked this key as compromised, so this address can't claim it again. Use a new key.
            </div>
          )}
          {keyStatus === 'revoked' && (
            <p className="helper">You revoked this key before. Publishing makes a new claim; the old one stays revoked.</p>
          )}

          <button className="btn btn-primary" onClick={handlePublish} disabled={publishStatus?.type === 'info' || empty || keyCompromised} title={empty ? 'This address has no ETH for the fee' : keyCompromised ? 'This key was revoked as compromised' : undefined}>
            {publishStatus?.type === 'info' ? 'Publishing…' : (replacing ? 'Replace and publish' : 'Publish')}
          </button>

          {publishStatus && <div className={`status ${publishStatus.type}`}>{publishStatus.msg}</div>}

          {empty && (
            <Authorize
              address={attestation.ethAddress}
              op={replacing ? 'reattest' : 'attest'}
              fields={{ fingerprint: attestation.gpgFingerprint, key: attestation.gpgPublicKeyHex, signature: attestation.gpgSignatureHex, index: replacing ? replaceIndex : undefined, includeEmail: (attestation.gpgMeta?.userIDs || []).some(u => u.includes('@')) }}
              onPublished={hash => { setTxHash(hash); setPublishStatus({ type: 'ok', msg: '✓ Published.' }); onPublish && onPublish() }}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ─── Your claims ─────────────────────────────────────────────────────────────

/** The connected wallet's claims, newest first, read and checked by the kit. */
function useMyAttestations(address) {
  const { data, refetch, isFetched } = useQuery({
    queryKey: ['claims', NETWORK, address],
    queryFn: () => readClaims(readClient, address, { registry: REGISTRY_ADDRESS }),
    enabled: !!address,
  })
  const attestations = useMemo(() => (data ?? []).slice().reverse(), [data])
  return { attestations, count: data?.length ?? 0, refetch, loaded: isFetched }
}

/** Paste a fresh export → (strip emails unless included) → `updateKey`. Same key, new notations, no new signature. */
function UpdateKeyPanel({ claim, address, hasEmail = false, onDone, onCancel, initialKey = null }) {
  const [keyText, setKeyText] = useState(initialKey || '')
  const { empty } = useIsEmpty(address)
  const [withEmail, setWithEmail] = useState(hasEmail) // defaults to what the claim holds today
  const [preview, setPreview] = useState(null)
  const [status, setStatus] = useState(null)
  const [result, setResult] = useState(null) // { hash, proofs, kept } once the update is confirmed
  useEffect(() => { if (result) forgetHandoff() }, [result])   // a used link is dropped from this tab
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
      if (!info) { setStatus({ type: 'err', msg: "That isn't a PGP public key. Paste the whole output of the command above." }); return }
      if (!sameFingerprint(info.fingerprint, claim.fingerprint)) {
        setStatus({ type: 'err', msg: `That key's fingerprint (${info.fingerprint}) is not this claim's key.` })
        return
      }
      // Lean format, as in the sign step: raw bytes, emails out unless ticked.
      const lean = await leanKey(text, { includeEmail: withEmail })
      if (cancelled) return
      if (!lean) {
        const name = (info.userIDs || []).map(u => u.replace(/\s*<[^>]*>/, '').replace(/\s*\([^)]*\)/, '').replace(/["$`\\]/g, '').trim()).find(Boolean) || 'Your Name'
        setStatus({ type: 'err', msg: `This key's only name includes your email. Add a name without it (gpg --quick-add-uid ${claim.fingerprint.toUpperCase()} "${name}"), run the command again and paste, or tick "Include my email".` })
        return
      }
      if (lean.keyNotationEmails.length) { setStatus({ type: 'err', msg: `A notation on the key itself holds an email (${lean.keyNotationEmails.join(', ')}), and it would go on-chain for good. Remove it with gpg (gpg --edit-key, then notation), export again and paste, or tick "Include my email".` }); return }
      const published = await parsePgpKey(lean.binary)
      const proofs = (published?.notations || []).filter(n => identifyProof(n)).length
      const otherNotes = (published?.notations || []).filter(n => !identifyProof(n)).map(n => `${n.name}=${n.value}`)
      setPreview({ keyHex: toHex(lean.binary), kept: lean.kept, removed: lean.removed, proofs, otherNotes, bytes: lean.binary.length, before: new TextEncoder().encode(text).length })
    })()
    return () => { cancelled = true }
  }, [keyText, claim.fingerprint, withEmail])

  const handleUpdate = async () => {
    if (!preview) return
    if (preview.bytes > MAX_PUBKEY_BYTES) { setStatus({ type: 'err', msg: `The key is ${(preview.bytes / 1024).toFixed(1)} KB, over the ${MAX_PUBKEY_BYTES / 1024} KB limit. It likely has many signatures or subkeys on it.` }); return }
    try {
      setStatus({ type: 'info', msg: 'Sending transaction…' })
      const hash = await writeContractAsync({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: 'updateKey',
        args: [BigInt(claim.index), preview.keyHex],
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
        setStatus({ type: 'err', msg: `The transaction failed, so nothing changed. Tx: ${hash}` })
      }
    } catch (err) {
      setStatus({ type: 'err', msg: contractErrorText(err) ?? err.shortMessage ?? err.message })
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
            <div className="value" style={{ color: 'var(--color-text-muted)' }}>Left out (has an email, in the name or a notation): {preview.removed.join(', ')}</div>
          )}
          <div className="value">Proofs: {preview.proofs}</div>
          {preview.otherNotes?.length > 0 && <div className="value" style={{ wordBreak: 'break-all' }}>Other notations: {preview.otherNotes.join(', ')}</div>}
          <div className="value" style={{ color: 'var(--color-text-muted)' }}>{(preview.bytes / 1024).toFixed(1)} KB{preview.before ? ` on-chain (${(preview.before / 1024).toFixed(1)} KB as pasted text)` : ''}</div>
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
          fields={{ fingerprint: claim.fingerprint, key: preview.keyHex, index: claim.index, includeEmail: withEmail }}
          onPublished={hash => { setStatus(null); setResult({ hash, proofs: preview.proofs, kept: preview.kept }); onDone && onDone() }}
        />
      )}
    </div>
  )
}

function YourAttestations({ address, attestations, count, refetch, onCreate, handoff = null }) {
  const [revokeStatus, setRevokeStatus] = useState({})
  const [confirmRevoke, setConfirmRevoke] = useState(null)   // index being confirmed
  const [revokeReason, setRevokeReason] = useState('')
  const [emailByIndex, setEmailByIndex] = useState({}) // index → true when the on-chain key has an email user ID
  // An ended claim can't be marked compromised while the same key has an active claim here.
  const lockedByActive = (a) => a.revoked && a.revokeReason !== 'compromised' && attestations.some(o => !o.revoked && sameFingerprint(o.fingerprint, a.fingerprint))
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
        <span className="step-badge muted">none yet</span>
      </div>
      <p className="helper">This wallet has no claim yet.</p>
      <button className="btn btn-primary" onClick={onCreate}>Create your first claim</button>
    </div>
  )

  const handleRevoke = async (index, reason) => {
    try {
      setConfirmRevoke(null)
      setRevokeStatus(s => ({ ...s, [index]: { type: 'info', msg: 'Sending transaction…' } }))

      const hash = await writeContractAsync({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: 'revoke',
        args: [BigInt(index), reason],
        chainId: CHAIN.id,
      })

      setRevokeStatus(s => ({ ...s, [index]: { type: 'info', msg: `Waiting for confirmation…` } }))

      const client = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) })
      await client.waitForTransactionReceipt({ hash, pollingInterval: 4_000 })

      setRevokeStatus(s => ({ ...s, [index]: { type: 'ok', msg: 'Revoked.' } }))
      refetch()
    } catch (err) {
      setRevokeStatus(s => ({ ...s, [index]: { type: 'err', msg: contractErrorText(err) ?? err.shortMessage ?? err.message } }))
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
            {/* Active first, then revoked; newest first within each, as on the identity page. */}
            {[...attestations].sort((a, b) => (a.revoked === b.revoked ? b.index - a.index : a.revoked ? 1 : -1)).map(a => (
              <Fragment key={a.index}>
              <tr>
                <td className="att-index">{a.index}</td>
                <td>
                  <a href={`/pgp/${a.fingerprint.toUpperCase()}`} className="fingerprint-link">
                    {a.fingerprint.toUpperCase().slice(0, 8)}...{a.fingerprint.toUpperCase().slice(-8)}
                  </a>
                </td>
                <td className="att-date">{formatDate(a.createdAt)}</td>
                <td>
                  <span className={`status-badge ${a.revoked ? 'revoked' : 'active'}`}>{claimStateLabel(a)}</span>
                </td>
                <td className="att-actions-cell">
                  {!a.revoked && (
                    <div className="att-actions">
                      <button className="btn btn-sm" onClick={() => setUpdating(updating === a.index ? null : a.index)}>
                        {updating === a.index ? 'Close' : 'Update'}
                      </button>
                      <button
                        className="btn btn-sm"
                        onClick={() => { setConfirmRevoke(confirmRevoke === a.index ? null : a.index); setRevokeReason('') }}
                        disabled={revokeStatus[a.index]?.type === 'info'}
                      >
                        {revokeStatus[a.index]?.type === 'info' ? 'Revoking…' : 'Revoke'}
                      </button>
                    </div>
                  )}
                  {a.revoked && a.revokeReason !== 'compromised' && (
                    <div className="att-actions">
                      <button
                        className="btn btn-sm"
                        onClick={() => setConfirmRevoke(confirmRevoke === a.index ? null : a.index)}
                        disabled={revokeStatus[a.index]?.type === 'info' || lockedByActive(a)}
                      >
                        {revokeStatus[a.index]?.type === 'info' ? 'Marking…' : 'Mark compromised'}
                      </button>

                    </div>
                  )}
                </td>
              </tr>
              {(revokeStatus[a.index]?.type === 'err' || (!a.revoked && emailByIndex[a.index]) || lockedByActive(a)) && (
                <tr className="att-note-row">
                  <td colSpan={5} style={{ padding: '0 16px 10px' }}>
                    {lockedByActive(a) && (
                      <div className="att-action-note">Mark compromised is off: this key has an active claim here. Revoke that one as compromised instead.</div>
                    )}
                    {!a.revoked && emailByIndex[a.index] && (
                      <div className="lookup-detected" style={{ fontSize: '12px', margin: 0 }}
                        title="The key stored on this claim carries an email user ID. Update the key with 'Include my email' unticked to publish a copy without it; the old copy stays in chain history.">
                        Email included on this claim
                      </div>
                    )}
                    {revokeStatus[a.index]?.type === 'err' && (
                      <div className="status err" style={{ marginTop: 4 }}>{revokeStatus[a.index].msg}</div>
                    )}
                  </td>
                </tr>
              )}
              {confirmRevoke === a.index && a.revoked && (
                <tr key={`${a.index}-compromised`} className="att-update-row">
                  <td colSpan={5} style={{ padding: '4px 8px 12px' }}>
                    <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span className="helper" style={{ margin: 0 }}>Mark #{a.index}'s key as compromised? This address can never claim it again.</span>
                      <button className="btn btn-sm" onClick={() => handleRevoke(a.index, 'compromised')}>Mark compromised</button>
                      <button className="btn btn-sm" onClick={() => setConfirmRevoke(null)}>Keep</button>
                    </div>
                  </td>
                </tr>
              )}
              {confirmRevoke === a.index && !a.revoked && (
                <tr key={`${a.index}-revoke`} className="att-update-row">
                  <td colSpan={5} style={{ padding: '4px 8px 12px' }}>
                    <div className="row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span className="helper" style={{ margin: 0 }}>Revoke #{a.index} for good? Reason:</span>
                      <select value={revokeReason} onChange={e => setRevokeReason(e.target.value)}>
                        <option value="">none given</option>
                        <option value="compromised">compromised: the key may be in someone else's hands (this address can't claim it again)</option>
                        <option value="retired">retired: no longer used</option>
                        <option value="other">other</option>
                      </select>
                      <button className="btn btn-sm" onClick={() => handleRevoke(a.index, revokeReason)}>Revoke</button>
                      <button className="btn btn-sm" onClick={() => setConfirmRevoke(null)}>Keep</button>
                    </div>
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
                      initialKey={handoff && handoff.index === a.index ? asArmor(handoff.key, 'key') : null}
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
  const [pgpData, setPgpData]   = useState(null)   // { pgpSig, signedText, keyId, fingerprint, keyHex, sigHex, pgpMeta }
  const [published, setPublished] = useState(false)
  useEffect(() => { if (published) forgetHandoff() }, [published])   // a used link is dropped from this tab
  const [linkUsed, setLinkUsed] = useState(false) // a CLI link fills one claim; after that, New claim is a normal one
  const linkClaim = claimHandoff && !linkUsed ? claimHandoff : null
  // The paste lives here so switching tabs mid-way doesn't lose it; a CLI link fills it in.
  const [paste, setPaste] = useState(claimHandoff?.key && claimHandoff?.signature ? `${asArmor(claimHandoff.signature, 'signature')}\n${asArmor(claimHandoff.key, 'key')}` : '')
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
    const same = activeClaims.find(c => sameFingerprint(c.fingerprint, pgpData.fingerprint))
    setReplaceIndex(linkClaim?.op === 'reattest' ? linkClaim.index : same ? same.index : null)
  }, [pgpData?.fingerprint, activeClaims, linkClaim])

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
    gpgSignatureHex: pgpData.sigHex,
    gpgPublicKeyHex: pgpData.keyHex,
    gpgKeyId: pgpData.keyId,
    gpgMeta: pgpData.pgpMeta,
  } : null

  return (
    <>
      <div className="attest-intro" style={{ maxWidth: 640 }}>
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
            {{ attest: ' a claim', reattest: ' a replacement claim', 'update-key': ' a key update', revoke: ' a revocation', 'set-record': ' a record', 'mark-compromised': ' a compromised mark' }[authorized.op]},
            so any wallet can publish it and pay the fee. Connect yours, check what it says, and publish.
            Nothing was sent anywhere; the part of the link after <code>#</code> stays in this browser.
          </p>
        ) : handoff ? (
          <>
            <p className="helper">
              This link came from the Thurin CLI. It carries {handoff.op === 'update-key' ? 'an updated key for claim' : handoff.op === 'set-record' ? 'a record for claim' : 'a signed claim for'}{' '}
              {handoff.op === 'update-key' || handoff.op === 'set-record' ? `#${handoff.index} of ` : ''}<strong>{shortAddr(handoff.owner)}</strong>: the wallet that has to publish it.
              Nothing was sent anywhere; the part of the link after <code>#</code> stays in this browser.
            </p>
            <p className="helper" style={{ marginBottom: 24 }}>
              Connect that wallet, check the summary, and publish. Nothing to paste. Anyone can make a link like this,
              so publish only if the key it names is yours: <code>{spacedFingerprint(handoff.fingerprint)}</code>.
            </p>
            {wrongWallet && (
              <div className="status err" style={{ marginBottom: 24 }}>
                Connected as <strong>{shortAddr(address)}</strong>, but this link is for <strong>{shortAddr(handoff.owner)}</strong>.
                Switch to that account in your wallet.
              </div>
            )}
          </>
        ) : isConnected && myLoaded && activeClaims.length > 0 ? (
          <p className="helper">
            Add your PGP key to your Ethereum address. This address already has one: update or replace
            it under <strong>Your claims</strong>, or add another.
          </p>
        ) : (
          <>
            <p className="helper">
              Add your PGP key to your Ethereum address. You sign one line with <code>gpg</code>, paste
              the output here, and publish from your wallet.
            </p>
            <p className="helper" style={{ marginBottom: 24 }}>
              You'll need <code>gpg</code> in a terminal <em>(desktop only)</em> and a little ETH for the fee.
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
          Rather use a terminal? The CLI does the same:<br />
          <code>npx @thurinlabs/thurin attest</code> · <a href="https://docs.thurin.id/#/cli" target="_blank" rel="noopener noreferrer">docs</a>
        </p>
      )}
    </>
  )
}
