import { Fragment, useState, useCallback, useMemo, useEffect } from 'react'
import { useAccount, useWriteContract, useReadContract, useReadContracts } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import * as openpgp from 'openpgp'
import { createPublicClient, http, stringToHex, hexToString } from 'viem'
import { stripEmailUserIDs, hasEmailUserID, parsePgpKey, identifyProof, fingerprintToBytes, bytesToFingerprint } from '@thurinlabs/identity-kit'
import { REGISTRY_ADDRESS, REGISTRY_ABI, RPC_URL, CHAIN, EXPLORER_URL } from '../wagmiConfig'

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

// Extract a 40-char hex fingerprint from GPG output or raw input
function extractFingerprint(input) {
  // Strip all whitespace and see if there's a 40-char hex string hiding in there
  const hex = input.replace(/\s/g, '').match(/[0-9A-Fa-f]{40}/)
  return hex ? hex[0].toUpperCase() : null
}

// The message GPG signs — must match exactly
function gpgPayload(address) {
  return `I control the Ethereum address: ${address.toLowerCase()}`
}

// Must match PGPRegistry.MAX_KEY_BYTES (8 KB). The on-chain key only needs to
// verify the attestation signature and carry the proof notations, so a minimal
// export stays well under this — and every byte costs gas.
const MAX_PUBKEY_BYTES = 8192

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

// ─── Step 2: Your email — a deliberate, visible choice ───────────────────────
// 'hide' publishes a key with every email user ID removed (the default path);
// 'show' publishes the key exactly as exported. The choice is made before any
// signing so the rest of the flow can adapt to it.

function StepEmailChoice({ active, done, choice, onChoose }) {
  const cards = [
    {
      id: 'hide',
      title: 'Keep my email off-chain',
      tag: 'recommended',
      body: 'Only a name from your key goes on-chain — never the email. You may need to add a name to your key; the next steps show how.',
    },
    {
      id: 'show',
      title: 'Include my email',
      tag: 'if it\'s already public',
      body: 'Your full key goes on-chain, email and all, so people can encrypt to you at that address. Choose this only if your email is already public. It can\'t be removed later.',
    },
  ]
  return (
    <div className={`step ${active ? 'active' : ''} ${done ? 'done' : ''}`}>
      <div className="step-header">
        <span className={`step-num ${active ? 'active-num' : ''}`}>02 //</span>
        <span className="step-title">Your Email</span>
        {done && <span className="step-badge">{choice === 'hide' ? '✓ off-chain' : '✓ included'}</span>}
      </div>

      {(active || done) && (
        <div className="fade-in">
          <p className="helper">
            Your PGP key carries your name and email. The email does <strong>not</strong> have to go on-chain.
            Pick one:
          </p>
          <div className="choice-cards">
            {cards.map(c => (
              <button
                key={c.id}
                type="button"
                className={`choice-card ${choice === c.id ? 'selected' : ''}`}
                onClick={() => onChoose(c.id)}
              >
                <span className="choice-tag">{c.tag}</span>
                <h3>{c.title}</h3>
                <p>{c.body}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Step 2: Enter GPG Fingerprint ───────────────────────────────────────────
// Note: no wallet signature here. ETH control is proven by msg.sender of the
// publish tx in Step 4, which carries this fingerprint. We only need to capture it.

function StepSignEth({ active, done, onSigned, fingerprint: confirmedFp }) {
  const [fingerprint, setFingerprint] = useState('')
  const [status, setStatus] = useState(null)

  const detected = fingerprint.trim() ? extractFingerprint(fingerprint) : null

  const handleContinue = useCallback(() => {
    if (!detected) {
      setStatus({ type: 'err', msg: 'Could not find a 40-character fingerprint in your input.' })
      return
    }
    onSigned({ fingerprint: detected })
  }, [detected, onSigned])

  return (
    <div className={`step ${active ? 'active' : ''} ${done ? 'done' : ''}`}>
      <div className="step-header">
        <span className={`step-num ${active ? 'active-num' : ''}`}>03 //</span>
        <span className="step-title">Enter Your PGP Fingerprint</span>
        {done && <span className="step-badge">✓ complete</span>}
      </div>

      {active && (
        <div className="fade-in">
          <p className="helper">
            Run <code>gpg --fingerprint</code> and paste the output below. We'll find the fingerprint automatically.<br/>Don't have a PGP key? <a href="https://docs.thurin.id/#/guides/getting-started" target="_blank" rel="noopener noreferrer">Follow the getting started guide</a>.
          </p>

          <div className="command-block">
            <span className="prompt">$ </span>
            gpg --fingerprint your@email.com
          </div>
          <button className="btn btn-sm" onClick={(e) => copyToClipboard('gpg --fingerprint your@email.com', e)} style={{ marginTop: 8, marginBottom: 16 }}>
            copy command
          </button>

          <textarea
            className="pgp-input"
            style={{ minHeight: 100 }}
            placeholder={`pub   ed25519 2024-11-23 [SC]\n      03E5 3D80 7CE3 8C13 0ED4  2ECE CD3D 0D7F 0C9E 5FB8\nuid           [ultimate] You <you@email.com>\nsub   cv25519 2024-11-23 [E]`}
            value={fingerprint}
            onChange={e => setFingerprint(e.target.value)}
            spellCheck={false}
          />

          {detected && (
            <div className="mono-box fade-in" style={{ marginTop: 12, marginBottom: 16 }}>
              <div className="label">detected fingerprint</div>
              <div className="value">{detected}</div>
            </div>
          )}

          {fingerprint.trim() && !detected && (
            <div className="status err" style={{ marginTop: 12, marginBottom: 16 }}>
              No 40-character fingerprint found in your input.
            </div>
          )}

          <button className="btn btn-primary" onClick={handleContinue} disabled={!detected}>
            Use This Fingerprint
          </button>

          {status && <div className={`status ${status.type}`}>{status.msg}</div>}
        </div>
      )}

      {done && !active && (
        <div className="mono-box">
          <div className="label">gpg fingerprint</div>
          <div className="value">{confirmedFp}</div>
        </div>
      )}
    </div>
  )
}

// ─── Step 3: Prepare key + sign ETH address ──────────────────────────────────
//
// What goes on-chain is the user's *exported* key with every email user ID
// removed (unless they opt in). The keyserver is never consulted: keys.openpgp.org
// only serves user IDs with a verified email and drops non-email user IDs, so it
// can't supply the published identity that carries the proof notations.

function StepSignGpg({ active, done, address, expectedFingerprint, onVerified, pgpSig, setPgpSig, includeEmail }) {
  const [status, setStatus] = useState(null)
  const [isVerifying, setIsVerifying] = useState(false)
  const [pubKeyText, setPubKeyText] = useState('')
  // Set once the signature verifies: the full key + the parsed message, so the
  // published key can be recomputed when the opt-in toggles.
  const [verified, setVerified] = useState(null) // { armoredFull, signedText, keyId, fingerprint, publicKey }
  const [preview, setPreview] = useState(null)   // { kept, removed, proofsPublished, proofsTotal, bytes }

  const fpr = expectedFingerprint || 'YOUR_FINGERPRINT'
  const addUidCommand = `gpg --quick-add-uid ${fpr} thurin`
  const exportCommand = `gpg --export-options export-minimal,no-export-attributes --armor --export ${fpr}`
  const command = address
    ? `echo "${gpgPayload(address)}" | gpg --clearsign --armor -u ${fpr}`
    : `echo "connect wallet first" | gpg --clearsign --armor`

  // Derive the key that will be published from the verified full key + opt-in.
  useEffect(() => {
    if (!verified) return
    let cancelled = false
    ;(async () => {
      const full = verified.armoredFull
      const fullInfo = await parsePgpKey(full)
      const proofsTotal = fullInfo ? fullInfo.notations.filter(n => identifyProof(n)).length : 0

      let armored, kept, removed
      if (includeEmail) {
        armored = full
        kept = fullInfo?.userIDs ?? []
        removed = []
      } else {
        const stripped = await stripEmailUserIDs(full)
        if (!stripped) {
          if (cancelled) return
          setPreview(null)
          onVerified(null)
          setStatus({
            type: 'err',
            msg: 'This key has no name without an email. Add one with the command above, re-export, paste the new key, and verify again — or choose "email included".',
          })
          return
        }
        armored = stripped.armored; kept = stripped.kept; removed = stripped.removed
      }

      const bytes = new TextEncoder().encode(armored).length
      if (bytes > MAX_PUBKEY_BYTES) {
        if (cancelled) return
        setPreview(null)
        onVerified(null)
        setStatus({ type: 'err', msg: `The key to publish is ${(bytes / 1024).toFixed(1)} KB — over the ${MAX_PUBKEY_BYTES / 1024} KB on-chain limit. Use the minimal export command above.` })
        return
      }

      const pubInfo = await parsePgpKey(armored)
      const proofsPublished = pubInfo ? pubInfo.notations.filter(n => identifyProof(n)).length : 0
      if (cancelled) return
      setPreview({ kept, removed, proofsPublished, proofsTotal, bytes })
      setStatus({ type: 'ok', msg: `✓ Valid signature from key ${verified.fingerprint}` })
      onVerified({
        pgpSig: pgpSig.trim(),
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

  const handleVerify = useCallback(async () => {
    if (!pgpSig.trim()) { setStatus({ type: 'err', msg: 'Paste your PGP signed message.' }); return }
    if (!pubKeyText.trim()) { setStatus({ type: 'err', msg: 'Paste your exported public key.' }); return }
    setIsVerifying(true)
    setVerified(null)
    setPreview(null)
    setStatus({ type: 'info', msg: 'Verifying PGP signature…' })
    try {
      const message = await openpgp.readCleartextMessage({ cleartextMessage: pgpSig.trim() })
      const signedText = message.getText().trim()
      if (!signedText.toLowerCase().includes(address.toLowerCase())) {
        setStatus({ type: 'err', msg: `Signed text doesn't contain your address. Expected: "${gpgPayload(address)}"` })
        return
      }
      const sigPackets = message.signature.packets
      if (!sigPackets || sigPackets.length === 0) {
        setStatus({ type: 'err', msg: 'No signature packet found in PGP message.' })
        return
      }
      const keyId = sigPackets[0].issuerKeyID?.toHex()?.toUpperCase()

      const publicKey = await openpgp.readKey({ armoredKey: pubKeyText.trim() })
      const { signatures } = await openpgp.verify({ message, verificationKeys: publicKey })
      await signatures[0].verified // throws if invalid

      const fingerprint = publicKey.getFingerprint().toUpperCase()
      if (expectedFingerprint && fingerprint !== expectedFingerprint.toUpperCase()) {
        setStatus({ type: 'err', msg: `Key mismatch: you signed with key ${fingerprint.slice(0, 8)}... but Step 2 fingerprint is ${expectedFingerprint.slice(0, 8)}... — sign with the correct key.` })
        return
      }
      const expirationTime = await publicKey.getExpirationTime()
      const expiresAt = expirationTime && expirationTime !== Infinity ? new Date(expirationTime).toISOString() : null
      setVerified({ armoredFull: publicKey.armor(), signedText, keyId, fingerprint, publicKey, expiresAt })
    } catch (err) {
      setStatus({ type: 'err', msg: `Verification failed: ${err.message}` })
    } finally {
      setIsVerifying(false)
    }
  }, [pgpSig, pubKeyText, address, expectedFingerprint])

  return (
    <div className={`step ${active ? 'active' : ''} ${done ? 'done' : ''}`}>
      <div className="step-header">
        <span className={`step-num ${active ? 'active-num' : ''}`}>04 //</span>
        <span className="step-title">Sign your address with your key</span>
        {done && <span className="step-badge">✓ complete</span>}
      </div>

      {active && (
        <div className="fade-in">
          {!includeEmail && (
            <div className="status info" style={{ marginBottom: 16 }}>
              <strong>First, give your key a name with no email on it</strong> — that name is what people see. Add one (skip if you have one):
              <div className="command-block" style={{ marginTop: 8 }}><span className="prompt">$ </span>{addUidCommand}</div>
              <button className="btn btn-sm" onClick={(e) => copyToClipboard(addUidCommand, e)} style={{ marginTop: 8 }}>copy command</button>
              <div style={{ marginTop: 8 }}>Your proofs go on that name — <a href="https://docs.thurin.id/#/guides/gnupg" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>how</a>.</div>
            </div>
          )}

          <p className="helper">This step proves the key is yours: your PGP key signs a line naming your address.</p>
          <p className="helper" style={{ marginTop: 12 }}>1. Sign your Ethereum address with your PGP key:</p>
          <div className="command-block"><span className="prompt">$ </span>{command}</div>
          <button className="btn btn-sm" onClick={(e) => copyToClipboard(command, e)} style={{ marginTop: 8 }}>copy command</button>
          <p className="helper" style={{ marginTop: 12 }}>
            Paste the entire output (including the <code>-----BEGIN PGP SIGNED MESSAGE-----</code> header):
          </p>
          <textarea
            className="pgp-input"
            placeholder={`-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\nI control the Ethereum address: 0x...\n-----BEGIN PGP SIGNATURE-----\n\n...\n-----END PGP SIGNATURE-----`}
            value={pgpSig}
            onChange={e => setPgpSig(e.target.value)}
            spellCheck={false}
          />

          <p className="helper" style={{ marginTop: 16 }}>2. Export your public key:</p>
          <div className="command-block"><span className="prompt">$ </span>{exportCommand}</div>
          <button className="btn btn-sm" onClick={(e) => copyToClipboard(exportCommand, e)} style={{ marginTop: 8 }}>copy command</button>
          <p className="helper" style={{ marginTop: 12 }}>Paste the full public key block:</p>
          <textarea
            className="pgp-input"
            style={{ minHeight: 140 }}
            placeholder={`-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n...\n-----END PGP PUBLIC KEY BLOCK-----`}
            value={pubKeyText}
            onChange={e => setPubKeyText(e.target.value)}
            spellCheck={false}
          />

          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={handleVerify} disabled={isVerifying || !pgpSig.trim() || !pubKeyText.trim()}>
              {isVerifying ? 'Verifying…' : 'Verify PGP Signature'}
            </button>
          </div>

          {status && <div className={`status ${status.type}`}>{status.msg}</div>}

          {verified && (
            <div className="mono-box fade-in" style={{ marginTop: 16 }}>
              <div className="label">Going on-chain</div>
              {preview ? (
                <>
                  <div className="value">Name: {preview.kept.join(', ')}</div>
                  {preview.removed.length > 0 && (
                    <div className="value" style={{ color: 'var(--color-text-muted)' }}>
                      Left out (has an email): {preview.removed.join(', ')}
                    </div>
                  )}
                  <div className="value">Proofs: {preview.proofsPublished}</div>
                  {preview.proofsPublished === 0 && preview.proofsTotal > 0 && (
                    <div className="status err" style={{ marginTop: 8 }}>
                      Your {preview.proofsTotal} proof{preview.proofsTotal === 1 ? ' is' : 's are'} on the name being left out, so none will show.
                      Move them to the published name (see "how" above), re-export, and verify again — or publish now and re-attest later.
                    </div>
                  )}
                  <div className="value" style={{ color: 'var(--color-text-muted)' }}>{(preview.bytes / 1024).toFixed(1)} KB</div>
                </>
              ) : (
                <div className="value" style={{ color: 'var(--color-text-muted)' }}>Nothing yet — see the message above.</div>
              )}
            </div>
          )}
        </div>
      )}

      {done && !active && (
        <div className="mono-box">
          <div className="label">pgp signature verified</div>
          <div className="value">✓</div>
        </div>
      )}
    </div>
  )
}

// ─── Step 4: Generate Identity Claim ─────────────────────────────────────────

function StepAttest({ active, done, attestation, onPublish, activeClaims = [], replaceIndex, setReplaceIndex }) {
  const [copied, setCopied] = useState(false)
  const [publishStatus, setPublishStatus] = useState(null)
  const [txHash, setTxHash] = useState(null)

  const { writeContractAsync } = useWriteContract()

  if (!active && !done) return (
    <div className={`step`}>
      <div className="step-header">
        <span className="step-num">05 //</span>
        <span className="step-title">Publish</span>
      </div>
    </div>
  )

  const handleCopy = () => {
    copyToClipboard(JSON.stringify(attestation, null, 2))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

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
        <span className={`step-num ${active && !done ? 'active-num' : ''}`}>05 //</span>
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
            <button className="btn btn-sm" onClick={handleCopy}>
              {copied ? '✓ copied' : 'Copy JSON'}
            </button>
          </div>

        </div>
      )}

      {active && !done && attestation && (
        <div className="fade-in">
          <p className="helper">
            Your signature checks out. This step proves the address is yours: publishing from your connected
            wallet puts the claim on-chain, and only that wallet can do it. This is what will be stored:
          </p>

          <div className="attestation-output">
            <div className="attestation-output-header">
              <span>attestation.json</span>
              <button className="btn btn-sm" onClick={handleCopy}>
                {copied ? '✓ copied' : 'copy json'}
              </button>
            </div>
            <pre>{JSON.stringify(attestation, null, 2)}</pre>
          </div>

          <hr className="divider" />

          <p className="helper">
            Your address, the fingerprint, the signed line, and the key. Readable by anyone, from any Ethereum
            node, for good. It can be revoked later but not erased.
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

          <button className="btn btn-primary" onClick={handlePublish} disabled={publishStatus?.type === 'info'}>
            {publishStatus?.type === 'info' ? 'Publishing…' : (replaceIndex !== null && replaceIndex !== undefined ? 'Replace & Publish' : 'Publish to Registry')}
          </button>

          {publishStatus && <div className={`status ${publishStatus.type}`}>{publishStatus.msg}</div>}
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
function UpdateKeyPanel({ claim, address, hasEmail = false, onDone, onCancel }) {
  const [keyText, setKeyText] = useState('')
  const [withEmail, setWithEmail] = useState(hasEmail) // defaults to what the claim holds today
  const [preview, setPreview] = useState(null)
  const [status, setStatus] = useState(null)
  const [result, setResult] = useState(null) // { hash, proofs, kept } once the update is confirmed
  const { writeContractAsync } = useWriteContract()

  useEffect(() => {
    let cancelled = false
    setPreview(null)
    setStatus(null)
    const text = keyText.trim()
    if (!text) return
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
        if (!stripped) { setStatus({ type: 'err', msg: 'This key has no name without an email. Add one (gpg --quick-add-uid <fingerprint> thurin), re-export, and paste again — or tick "Include my email".' }); return }
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
        Update the key on claim #{claim.index}. Add or change proof notations on your published name, then
        export the same key and paste it below. No new signature is needed.
      </p>
      <p className="helper" style={{ marginTop: 12 }}>Your email. Pick one:</p>
      <div className="choice-cards">
        <button type="button" className={`choice-card ${!withEmail ? 'selected' : ''}`} onClick={() => { setWithEmail(false); setStatus(null) }}>
          <span className="choice-tag">{hasEmail ? 'removes it' : 'as it is now'}</span>
          <h3>Keep my email off-chain</h3>
          <p>Only the names without an email go on-chain.</p>
        </button>
        <button type="button" className={`choice-card ${withEmail ? 'selected' : ''}`} onClick={() => { setWithEmail(true); setStatus(null) }}>
          <span className="choice-tag">{hasEmail ? 'as it is now' : 'adds it'}</span>
          <h3>Include my email</h3>
          <p>The whole key goes on-chain, email and all. It can't be removed later.</p>
        </button>
      </div>

      <p className="helper" style={{ marginTop: 12 }}>1. Export your public key:</p>
      <div className="command-block"><span className="prompt">$ </span>{exportCommand}</div>
      <button className="btn btn-sm" onClick={(e) => copyToClipboard(exportCommand, e)} style={{ marginTop: 8 }}>copy command</button>

      <p className="helper" style={{ marginTop: 12 }}>2. Paste the full public key block:</p>
      <textarea
        className="pgp-input"
        style={{ minHeight: 140 }}
        placeholder={`-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n...\n-----END PGP PUBLIC KEY BLOCK-----`}
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

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn btn-primary" onClick={handleUpdate} disabled={!preview || status?.type === 'info'}>
          {status?.type === 'info' ? 'Updating…' : 'Update key'}
        </button>
        <button className="btn btn-sm" onClick={onCancel}>cancel</button>
      </div>
      {status && <div className={`status ${status.type}`}>{status.msg}</div>}
    </div>
  )
}

function YourAttestations({ address, attestations, count, refetch, onCreate }) {
  const [revokeStatus, setRevokeStatus] = useState({})
  const [emailByIndex, setEmailByIndex] = useState({}) // index → true when the on-chain key has an email user ID
  const [updating, setUpdating] = useState(null)       // index of the claim whose key is being updated
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
            {attestations.map(a => (
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
                    <UpdateKeyPanel claim={a} address={address} hasEmail={!!emailByIndex[a.index]} onDone={refetch} onCancel={() => setUpdating(null)} />
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

  // State flowing through the steps
  const [ethData, setEthData]   = useState(null)   // { fingerprint }
  const [pgpData, setPgpData]   = useState(null)   // { pgpSig, signedText, keyId, fingerprint, armoredPublicKey, pgpMeta }
  const [pgpSigText, setPgpSigText] = useState('') // textarea value
  const [published, setPublished] = useState(false)
  const [emailChoice, setEmailChoice] = useState(null) // 'hide' | 'show'
  const [replaceIndex, setReplaceIndex] = useState(null) // claim to revoke in the same tx, if any
  const { attestations: myClaims, count: myCount, refetch: refetchMine, loaded: myLoaded } = useMyAttestations(address)
  const activeClaims = useMemo(() => myClaims.filter(c => !c.revoked), [myClaims])

  // Tabs: returning users land on their claims, first-timers on the wizard.
  const [tab, setTab] = useState(null) // 'claims' | 'new'
  useEffect(() => {
    if (tab !== null || !myLoaded) return
    setTab(activeClaims.length > 0 ? 'claims' : 'new')
  }, [myLoaded, activeClaims.length, tab])
  useEffect(() => { if (!isConnected) setTab(null) }, [isConnected])

  // Default to replacing the active claim for the same key (the registry allows one per key).
  useEffect(() => {
    if (!ethData?.fingerprint) return
    const same = activeClaims.find(c => c.fingerprint === ethData.fingerprint.toLowerCase())
    setReplaceIndex(same ? same.index : null)
  }, [ethData?.fingerprint, activeClaims])

  // Derive active step
  const step = !isConnected ? 1
    : !emailChoice ? 2
    : !ethData ? 3
    : !pgpData ? 4
    : 5

  // Build final attestation object. The ETH side of the claim is the publish tx
  // itself (msg.sender + fingerprint), so no separate ETH signature is stored.
  const attestation = ethData && pgpData ? {
    version: '3',
    timestamp: new Date().toISOString(),
    ethAddress: address,
    gpgFingerprint: ethData.fingerprint,
    gpgSignedMessage: pgpData.signedText,
    gpgSignature: pgpData.pgpSig,
    gpgPublicKey: pgpData.armoredPublicKey,
    gpgKeyId: pgpData.keyId,
    gpgMeta: pgpData.pgpMeta,
  } : null

  return (
    <>
      <div className="attest-intro" style={{ maxWidth: 640, margin: '0 auto', padding: '0 16px' }}>
        {isConnected && myLoaded && activeClaims.length > 0 ? (
          <p className="helper">
            Attest links your Ethereum address to your PGP key. This wallet already has a claim:
            update or replace it under <strong>Your claims</strong>, or make a new one.
          </p>
        ) : (
          <>
            <p className="helper">
              Attest links your Ethereum address to your PGP key, so anyone can check that both belong to
              the same person. It takes a few minutes and one transaction.
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

          {isConnected && (
            <div className="attest-tabs" role="tablist">
              <button role="tab" className={`attest-tab ${tab === 'claims' ? 'active' : ''}`} onClick={() => setTab('claims')}>
                Your claims{myLoaded && activeClaims.length > 0 && <span className="attest-tab-count">{activeClaims.length}</span>}
              </button>
              <button role="tab" className={`attest-tab ${tab === 'new' ? 'active' : ''}`} onClick={() => setTab('new')}>
                New claim
              </button>
            </div>
          )}

          {isConnected && tab === 'claims' && (
            <YourAttestations address={address} attestations={myClaims} count={myCount} refetch={refetchMine} onCreate={() => setTab('new')} />
          )}

          {isConnected && tab === 'new' && (
            <>
              <StepEmailChoice
                active={step === 2}
                done={step > 2}
                choice={emailChoice}
                onChoose={setEmailChoice}
              />

              <StepSignEth
                active={step === 3}
                done={step > 3}
                fingerprint={ethData?.fingerprint}
                onSigned={data => setEthData(data)}
              />

              <StepSignGpg
                active={step === 4}
                done={step > 4}
                includeEmail={emailChoice === 'show'}
                address={address}
                expectedFingerprint={ethData?.fingerprint}
                pgpSig={pgpSigText}
                setPgpSig={setPgpSigText}
                onVerified={data => setPgpData(data)}
              />

              <StepAttest
                active={step === 5}
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
    </>
  )
}
