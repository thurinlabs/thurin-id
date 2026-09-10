import { useState, useCallback, useMemo } from 'react'
import { useAccount, useWriteContract, useReadContract, useReadContracts } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { mainnet } from 'wagmi/chains'
import * as openpgp from 'openpgp'
import { REGISTRY_ADDRESS, REGISTRY_ABI } from '../wagmiConfig'

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

// Must match PGPRegistry.MAX_PAYLOAD_BYTES (16 KB). The on-chain key only needs to
// verify the attestation signature, so a minimal export stays well under this.
const MAX_PUBKEY_BYTES = 16384

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
        <p className="helper">Connect your wallet to get started. Your address will be sealed into the identity claim. Already have one? <a href="/" rel="noopener noreferrer">Look it up</a>.</p>
      )}

      <ConnectButton showBalance={false} />
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
        <span className={`step-num ${active ? 'active-num' : ''}`}>02 //</span>
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

// ─── Step 3: GPG Sign ETH Address ────────────────────────────────────────────

function StepSignGpg({ active, done, address, expectedFingerprint, onVerified, pgpSig, setPgpSig }) {
  const [status, setStatus] = useState(null)
  const [isVerifying, setIsVerifying] = useState(false)
  const [needsManualKey, setNeedsManualKey] = useState(false)
  const [manualPubKey, setManualPubKey] = useState('')
  const [pendingMessage, setPendingMessage] = useState(null) // stash parsed message for manual key flow

  const command = address && expectedFingerprint
    ? `echo "${gpgPayload(address)}" | gpg --clearsign --armor -u ${expectedFingerprint}`
    : address
    ? `echo "${gpgPayload(address)}" | gpg --clearsign --armor`
    : `echo "connect wallet first" | gpg --clearsign --armor`

  const exportCommand = expectedFingerprint
    ? `gpg --export-options export-minimal,no-export-attributes --armor --export ${expectedFingerprint}`
    : `gpg --export-options export-minimal,no-export-attributes --armor --export you@email.com`

  // Verify signature against a public key (shared by both flows)
  const verifySig = useCallback(async (message, publicKey, signedText, keyId) => {
    const verificationResult = await openpgp.verify({
      message,
      verificationKeys: publicKey,
    })

    const { verified } = verificationResult.signatures[0]
    await verified // throws if invalid

    const fingerprint = publicKey.getFingerprint().toUpperCase()

    // Verify the signing key matches the fingerprint from Step 2
    if (expectedFingerprint && fingerprint !== expectedFingerprint.toUpperCase()) {
      setStatus({
        type: 'err',
        msg: `Key mismatch: you signed with key ${fingerprint.slice(0, 8)}... but Step 2 fingerprint is ${expectedFingerprint.slice(0, 8)}... — sign with the correct key.`
      })
      return false
    }

    const armoredPublicKey = publicKey.armor()

    // The on-chain payload is capped (PGPRegistry.MAX_PAYLOAD_BYTES). A well-used key
    // with many notations/self-sigs can exceed it — but the on-chain key only needs to
    // verify the seal, so route the user to paste a minimal export instead of failing.
    const pubKeyBytes = new TextEncoder().encode(armoredPublicKey).length
    if (pubKeyBytes > MAX_PUBKEY_BYTES) {
      setPendingMessage({ message, signedText, keyId })
      setNeedsManualKey(true)
      setStatus({
        type: 'err',
        msg: `Your public key is ${(pubKeyBytes / 1024).toFixed(1)} KB — over the ${MAX_PUBKEY_BYTES / 1024} KB on-chain limit. Paste a minimal export below (the export command now uses --export-minimal).`,
      })
      return false
    }

    // Extract rich metadata from the key
    const primaryUser = await publicKey.getPrimaryUser()
    const userIDs = publicKey.users.map(u => u.userID?.userID).filter(Boolean)
    const keyAlgo = publicKey.keyPacket.algorithm
    const keyBits = publicKey.keyPacket.getBitSize?.() ?? null
    const createdAt = publicKey.keyPacket.created?.toISOString() ?? null
    const expirationTime = await publicKey.getExpirationTime()
    const expiresAt = expirationTime && expirationTime !== Infinity
      ? new Date(expirationTime).toISOString() : null
    const subkeyCount = publicKey.subkeys?.length ?? 0

    setStatus({ type: 'ok', msg: `✓ Valid signature from key ${fingerprint}` })
    onVerified({
      pgpSig: pgpSig.trim(),
      signedText,
      keyId,
      fingerprint,
      armoredPublicKey,
      pgpMeta: {
        userIDs,
        algorithm: keyAlgo,
        bits: keyBits,
        createdAt,
        expiresAt,
        subkeys: subkeyCount,
      },
    })
    return true
  }, [pgpSig, onVerified, expectedFingerprint])

  // Main verify: try keyserver first, fall back to manual paste
  const handleVerify = useCallback(async () => {
    if (!pgpSig.trim()) {
      setStatus({ type: 'err', msg: 'Paste your PGP signed message above.' })
      return
    }

    setIsVerifying(true)
    setNeedsManualKey(false)
    setStatus({ type: 'info', msg: 'Verifying PGP signature…' })

    try {
      const message = await openpgp.readCleartextMessage({ cleartextMessage: pgpSig.trim() })

      const signedText = message.getText().trim()
      const expected = gpgPayload(address)

      if (!signedText.toLowerCase().includes(address.toLowerCase())) {
        setStatus({ type: 'err', msg: `Signed text doesn't contain your address. Expected: "${expected}"` })
        setIsVerifying(false)
        return
      }

      const sigPackets = message.signature.packets
      if (!sigPackets || sigPackets.length === 0) {
        setStatus({ type: 'err', msg: 'No signature packet found in PGP message.' })
        setIsVerifying(false)
        return
      }

      const keyId = sigPackets[0].issuerKeyID?.toHex()?.toUpperCase()
      setStatus({ type: 'info', msg: `Fetching public key ${keyId} from keys.openpgp.org…` })

      try {
        const resp = await fetch(`https://keys.openpgp.org/vks/v1/by-keyid/${keyId}`)
        if (!resp.ok) throw new Error('Key not found on keyserver')
        const armored = await resp.text()
        const publicKey = await openpgp.readKey({ armoredKey: armored })

        await verifySig(message, publicKey, signedText, keyId)
      } catch (fetchErr) {
        // Keyserver failed — prompt for manual key paste
        setPendingMessage({ message, signedText, keyId })
        setNeedsManualKey(true)
        setStatus({
          type: 'info',
          msg: `Could not fetch key from keyserver (${fetchErr.message}). Paste your public key below to verify locally.`
        })
      }
    } catch (err) {
      setStatus({ type: 'err', msg: `Verification failed: ${err.message}` })
    } finally {
      setIsVerifying(false)
    }
  }, [pgpSig, address, verifySig])

  // Manual key verification
  const handleManualVerify = useCallback(async () => {
    if (!manualPubKey.trim() || !pendingMessage) return

    setIsVerifying(true)
    setStatus({ type: 'info', msg: 'Verifying signature against your public key…' })

    try {
      const publicKey = await openpgp.readKey({ armoredKey: manualPubKey.trim() })
      const ok = await verifySig(pendingMessage.message, publicKey, pendingMessage.signedText, pendingMessage.keyId)
      if (ok) setNeedsManualKey(false)
    } catch (err) {
      setStatus({ type: 'err', msg: `Verification failed: ${err.message}` })
    } finally {
      setIsVerifying(false)
    }
  }, [manualPubKey, pendingMessage, verifySig])

  return (
    <div className={`step ${active ? 'active' : ''} ${done ? 'done' : ''}`}>
      <div className="step-header">
        <span className={`step-num ${active ? 'active-num' : ''}`}>03 //</span>
        <span className="step-title">Sign ETH Address with PGP</span>
        {done && <span className="step-badge">✓ complete</span>}
      </div>

      {active && (
        <div className="fade-in">
          <p className="helper">
            In your terminal, run this command to sign your Ethereum address with your PGP key:
          </p>

          <div className="command-block">
            <span className="prompt">$ </span>
            {command}
          </div>
          <button className="btn btn-sm" onClick={(e) => copyToClipboard(command, e)} style={{ marginTop: 8 }}>
            copy command
          </button>

          <p className="helper" style={{ marginTop: 16 }}>
            Then paste the entire output (including the <code>-----BEGIN PGP SIGNED MESSAGE-----</code> header) below:
          </p>

          <textarea
            className="pgp-input"
            placeholder={`-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\nI control the Ethereum address: 0x...\n-----BEGIN PGP SIGNATURE-----\n\n...\n-----END PGP SIGNATURE-----`}
            value={pgpSig}
            onChange={e => setPgpSig(e.target.value)}
            spellCheck={false}
          />

          <div className="status info" style={{ marginTop: 16, marginBottom: 16 }}>
            <strong>Upload your key to keys.openpgp.org</strong> — this lets Thurin fetch your latest key data
            (identity proofs, third-party signatures) even after publishing. Without it, only the key
            snapshot from publish time is shown.
            <div style={{ marginTop: 8 }}>
              <a href="https://keys.openpgp.org/upload" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>
                Upload via browser
              </a>
              <span style={{ margin: '0 8px' }}>or</span>
              <code>gpg --export {expectedFingerprint || 'YOUR_FINGERPRINT'} | curl -T - https://keys.openpgp.org</code>
            </div>
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={handleVerify} disabled={isVerifying || !pgpSig.trim()}>
              {isVerifying ? 'Verifying…' : 'Verify PGP Signature'}
            </button>
          </div>

          {status && <div className={`status ${status.type}`}>{status.msg}</div>}

          {needsManualKey && (
            <div className="fade-in" style={{ marginTop: 20 }}>
              <p className="helper">
                Export your public key with:
              </p>
              <div className="command-block">
                <span className="prompt">$ </span>
                {exportCommand}
              </div>
              <button className="btn btn-sm" onClick={(e) => copyToClipboard(exportCommand, e)} style={{ marginTop: 8 }}>
                copy command
              </button>

              <p className="helper" style={{ marginTop: 16 }}>
                Paste the full public key block below:
              </p>
              <textarea
                className="pgp-input"
                style={{ minHeight: 140 }}
                placeholder={`-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n...\n-----END PGP PUBLIC KEY BLOCK-----`}
                value={manualPubKey}
                onChange={e => setManualPubKey(e.target.value)}
                spellCheck={false}
              />
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn btn-primary" onClick={handleManualVerify} disabled={isVerifying || !manualPubKey.trim()}>
                  {isVerifying ? 'Verifying…' : 'Verify with Public Key'}
                </button>
              </div>
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

function StepAttest({ active, done, attestation, onPublish }) {
  const [copied, setCopied] = useState(false)
  const [publishStatus, setPublishStatus] = useState(null)
  const [txHash, setTxHash] = useState(null)

  const { writeContractAsync } = useWriteContract()

  if (!active && !done) return (
    <div className={`step`}>
      <div className="step-header">
        <span className="step-num">04 //</span>
        <span className="step-title">Generate & Publish Identity Claim</span>
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

      const hash = await writeContractAsync({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: 'attest',
        args: [attestation.gpgFingerprint, attestation.gpgSignature, attestation.gpgPublicKey],
        chainId: mainnet.id,
      })

      setTxHash(hash)
      setPublishStatus({ type: 'info', msg: `Waiting for confirmation… tx: ${hash.slice(0, 10)}…` })

      const { createPublicClient, http } = await import('viem')
      const rpcUrl = import.meta.env.VITE_ALCHEMY_RPC_URL
      const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) })
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
        <span className={`step-num ${active && !done ? 'active-num' : ''}`}>04 //</span>
        <span className="step-title">Generate & Publish Identity Claim</span>
        {done && <span className="step-badge">✓ sealed</span>}
      </div>

      {done && attestation && (
        <div className="fade-in">
          <div className="status ok">
            Identity claim sealed on-chain. Your ETH address and PGP key are now cryptographically linked.
          </div>

          <div style={{ marginTop: 16 }} className="row">
            <a href={explorerUrl} className="btn btn-primary" target="_blank" rel="noopener noreferrer">
              View identity
            </a>
            {txHash && (
              <>
                <a className="btn btn-sm" href={`https://etherscan.io/tx/${txHash}`} target="_blank" rel="noopener noreferrer">
                  View Transaction
                </a>
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
            Both signatures are verified. This JSON is your identity claim — a cryptographic proof that your
            ETH wallet and PGP key are controlled by the same person. Publish it on-chain to make it queryable.
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
            The contract stores the fingerprint↔address mapping on-chain. The PGP signature itself
            lives in the event log — verifiable by anyone, forever.
          </p>

          <button className="btn btn-primary" onClick={handlePublish} disabled={publishStatus?.type === 'info'}>
            {publishStatus?.type === 'info' ? 'Publishing…' : 'Publish to Registry'}
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

function YourAttestations({ address }) {
  const [revokeStatus, setRevokeStatus] = useState({})
  const { writeContractAsync } = useWriteContract()


  const { data: count, refetch: refetchCount } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: 'attestationCount',
    args: [address],
    chainId: mainnet.id,
  })

  const numCount = count !== undefined ? Number(count) : 0

  const contracts = useMemo(() => {
    if (!numCount) return []
    return Array.from({ length: numCount }, (_, i) => ({
      address: REGISTRY_ADDRESS,
      abi: REGISTRY_ABI,
      functionName: 'getAttestation',
      args: [address, BigInt(i)],
      chainId: mainnet.id,
    }))
  }, [address, numCount])

  const { data: allAtt, refetch: refetchAtt } = useReadContracts({
    contracts,
    query: { enabled: contracts.length > 0 },
  })

  const attestations = useMemo(() => {
    if (!allAtt) return []
    return allAtt
      .map((item, index) => {
        if (item.status !== 'success') return null
        const [fingerprint, createdAt, revoked] = item.result
        return { index, fingerprint, createdAt: Number(createdAt), revoked }
      })
      .filter(Boolean)
      .reverse()
  }, [allAtt])

  if (numCount === 0) return null

  const handleRevoke = async (index) => {
    try {
      setRevokeStatus(s => ({ ...s, [index]: { type: 'info', msg: 'Sending revoke…' } }))

      const hash = await writeContractAsync({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: 'revoke',
        args: [BigInt(index)],
        chainId: mainnet.id,
      })

      setRevokeStatus(s => ({ ...s, [index]: { type: 'info', msg: `Waiting for confirmation…` } }))

      const { createPublicClient, http } = await import('viem')
      const rpcUrl = import.meta.env.VITE_ALCHEMY_RPC_URL
      const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) })
      await client.waitForTransactionReceipt({ hash, pollingInterval: 4_000 })

      setRevokeStatus(s => ({ ...s, [index]: { type: 'ok', msg: 'Revoked.' } }))
      refetchCount()
      refetchAtt()
    } catch (err) {
      setRevokeStatus(s => ({ ...s, [index]: { type: 'err', msg: err.shortMessage || err.message } }))
    }
  }

  const activeCount = attestations.filter(a => !a.revoked).length

  return (
    <div className="step active">
      <div className="step-header">
        <span className="step-num active-num">00 //</span>
        <span className="step-title">Your Identity Claims</span>
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
              <tr key={a.index}>
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
                <td>
                  {!a.revoked && (
                    <button
                      className="btn btn-sm"
                      onClick={() => handleRevoke(a.index)}
                      disabled={revokeStatus[a.index]?.type === 'info'}
                    >
                      {revokeStatus[a.index]?.type === 'info' ? 'Revoking…' : 'Revoke'}
                    </button>
                  )}
                  {revokeStatus[a.index] && revokeStatus[a.index].type !== 'info' && (
                    <span className={`status ${revokeStatus[a.index].type}`} style={{ marginLeft: 8, fontSize: '12px' }}>
                      {revokeStatus[a.index].msg}
                    </span>
                  )}
                </td>
              </tr>
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

  // Derive active step
  const step = !isConnected ? 1
    : !ethData ? 2
    : !pgpData ? 3
    : 4

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
        <p className="helper">
          <strong>Attesting</strong> binds your Ethereum address and your PGP key (your encryption key)
          into one verifiable identity — the two vouch for each other, anchored on-chain. Once sealed,
          your address, PGP key, and social proofs resolve as a single identity on thurin.id, with a card
          you can embed anywhere.
        </p>
        <p className="helper">To create a claim you'll need:</p>
        <ul className="helper" style={{ margin: '8px 0 24px 20px', lineHeight: 1.7 }}>
          <li>an Ethereum wallet</li>
          <li>a PGP key, with <code>gpg</code> in a terminal <em>(desktop only)</em></li>
          <li>some ETH for gas</li>
        </ul>
      </div>

      <div className="steps">
          <StepConnect
            active={step === 1}
            done={step > 1}
          />

          {isConnected && <YourAttestations address={address} />}

          <StepSignEth
            active={step === 2}
            done={step > 2}
            fingerprint={ethData?.fingerprint}
            onSigned={data => setEthData(data)}
          />

          <StepSignGpg
            active={step === 3}
            done={step > 3}
            address={address}
            expectedFingerprint={ethData?.fingerprint}
            pgpSig={pgpSigText}
            setPgpSig={setPgpSigText}
            onVerified={data => setPgpData(data)}
          />

          <StepAttest
            active={step === 4}
            done={published}
            attestation={attestation}
            onPublish={() => setPublished(true)}
          />
      </div>
    </>
  )
}
