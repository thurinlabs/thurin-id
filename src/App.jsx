import { useState, useEffect, useCallback, useMemo } from 'react'
import { version } from '../package.json'
import { useReadContract, useReadContracts, useEnsAddress, useEnsName, useEnsAvatar } from 'wagmi'
import { createPublicClient, http, hexToString } from 'viem'
import { normalize } from 'viem/ens'
import { REGISTRY_ADDRESS, REGISTRY_ABI, RPC_URL, NETWORK, CHAIN, EXPLORER_URL } from './wagmiConfig'
import { fingerprintHash, bytesToFingerprint, keyIdToBytes } from '@thurinlabs/identity-kit'
import {
  ThurinCard,
  IdentityKitProvider,
  identifyProof,
  verifyProof,
  displayUrl,
  proofHref,
  proofSecondaryHref,
  parsePgpKey,
  verifyAttestation,
  fetchEFPGraph,
} from '@thurinlabs/identity-kit'
import '@thurinlabs/identity-kit/styles'
import { siteLinks } from './links'
import Attest from './components/Attest'
import LookupPreview from './components/LookupPreview'

const chainClient = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URL),
})

// ─── helpers ────────────────────────────────────────────────────────────────

function detectInputType(value) {
  const trimmed = value.trim()
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return 'address'
  if (/^[0-9a-fA-F]{40}$/.test(trimmed)) return 'fingerprint'
  if (/^[0-9a-fA-F]{16}$/.test(trimmed)) return 'keyId'
  if (trimmed.includes('.') && trimmed.length > 3) return 'ens'
  return null
}

function safeNormalize(name) {
  try { return normalize(name) } catch { return null }
}

function formatDate(unixTimestamp) {
  if (!unixTimestamp) return '—'
  return new Date(unixTimestamp * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
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

// ─── Path routing ───────────────────────────────────────────────────────────

// Path routes (/eth/…, /attest) only work where the host serves index.html for
// unknown paths: thurin.id (nginx @fallback), *.eth.limo (honours the IPFS
// `_redirects` file shipped in public/), and the Vite dev/preview servers.
// Anywhere else — e.g. a raw /ipfs/<cid>/ path gateway — fall back to #/ routes.
export function usesPathRouting() {
  const h = window.location.hostname
  return h === 'thurin.id' || h.endsWith('.eth.limo') || h === 'localhost' || h === '127.0.0.1'
}

function parseRoute() {
  // Legacy hash routes: rewrite to a path where path routing works, else parse the hash directly
  const hash = window.location.hash.replace(/^#\/?/, '')
  if (hash) {
    const slash = hash.indexOf('/')
    if (slash !== -1) {
      const prefix = hash.slice(0, slash).toLowerCase()
      const value = decodeURIComponent(hash.slice(slash + 1))
      if (value && (prefix === 'eth' || prefix === 'pgp' || prefix === 'ens')) {
        if (usesPathRouting()) {
          window.history.replaceState(null, '', `/${prefix}/${encodeURIComponent(value)}`)
        } else {
          // Path gateway — parse the hash route directly
          return { type: prefix === 'eth' ? 'address' : prefix === 'pgp' ? (/^[0-9a-fA-F]{16}$/i.test(value) ? 'keyId' : 'fingerprint') : 'ens', value }
        }
      }
    }
  }

  const path = window.location.pathname.replace(/^\/?/, '')
  if (!path) return null

  const slash = path.indexOf('/')
  if (slash === -1) return null

  const prefix = path.slice(0, slash).toLowerCase()
  const value = decodeURIComponent(path.slice(slash + 1))
  if (!value) return null

  if (prefix === 'eth' && /^0x[0-9a-fA-F]{40}$/.test(value)) return { type: 'address', value }
  if (prefix === 'pgp' && /^[0-9a-fA-F]{40}$/i.test(value)) return { type: 'fingerprint', value }
  if (prefix === 'pgp' && /^[0-9a-fA-F]{16}$/i.test(value)) return { type: 'keyId', value }
  if (prefix === 'ens') return { type: 'ens', value }

  return null
}

function pushRoute(type, value) {
  const prefix = type === 'address' ? 'eth' : (type === 'fingerprint' || type === 'keyId') ? 'pgp' : 'ens'
  if (usesPathRouting()) {
    const newPath = `/${prefix}/${encodeURIComponent(value)}`
    if (window.location.pathname !== newPath) {
      window.history.pushState(null, '', newPath)
    }
  } else {
    // Path gateway — use hash routing
    const newHash = `#/${prefix}/${encodeURIComponent(value)}`
    if (window.location.hash !== newHash) {
      window.location.hash = newHash
    }
  }
}

// ─── Topbar ─────────────────────────────────────────────────────────────────

function ThemeSelect({ storageKey }) {
  const [theme, setTheme] = useState(
    () => localStorage.getItem(storageKey) || 'thurin'
  )

  const handleChange = (e) => {
    const id = e.target.value
    setTheme(id)
    document.documentElement.dataset.theme = id
    localStorage.setItem(storageKey, id)
  }

  return (
    <select className="theme-select" value={theme} onChange={handleChange}>
      <option value="thurin">Thurin</option>
      <option value="dark">Dark</option>
      <option value="light">Light</option>
    </select>
  )
}

function Topbar({ isAttest }) {
  return (
    <nav className="topbar">
      {/* One product, one chrome. The route is read once on mount, so moving
          between / and /attest is a full page load, not a pushState. */}
      <a href="/" className="topbar-title" onClick={(e) => { if (isAttest) return; e.preventDefault(); window.history.pushState(null, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); }}
         style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <svg viewBox="20 20 76 76" xmlns="http://www.w3.org/2000/svg" width="36" height="36">
          <path d="M25 80 Q25 25 50 25 Q75 25 75 50" fill="none" stroke="#7c9a3e" strokeWidth="4" strokeLinecap="round"/>
          <path d="M33 75 Q33 35 50 35 Q67 35 67 52" fill="none" stroke="#7c9a3e" strokeWidth="4" strokeLinecap="round"/>
          <path d="M41 70 Q41 45 50 45 Q59 45 59 55" fill="none" stroke="#c9a227" strokeWidth="4" strokeLinecap="round"/>
          <path d="M50 65 L50 53" fill="none" stroke="#c9a227" strokeWidth="4" strokeLinecap="round"/>
          <circle cx="72" cy="72" r="12" fill="none" stroke="#c9a227" strokeWidth="3.5"/>
          <line x1="81" y1="81" x2="92" y2="92" stroke="#c9a227" strokeWidth="3.5" strokeLinecap="round"/>
        </svg>
        <span className="topbar-wordmark">Thurin<span className="topbar-wordmark-accent">.id</span></span>
        {NETWORK !== 'mainnet' && (
          <span className="status-badge" title={`Reading the ${NETWORK} registry — nothing here touches mainnet`}
            style={{ marginLeft: 10, fontSize: 10, borderColor: 'var(--color-secondary)', color: 'var(--color-secondary)' }}>
            {NETWORK} testnet
          </span>
        )}
      </a>
      <div className="topbar-right">
        {isAttest ? (
          <a href="/" className="topbar-action-link">
            Look up an identity
          </a>
        ) : (
          <a href="/attest" className="topbar-action-link">
            Create identity claim
          </a>
        )}
        <ThemeSelect storageKey="thurin-theme" />
      </div>
    </nav>
  )
}

// ─── PGP Key Info ──────────────────────────────────────────────────────────

function PgpKeyInfo({ armoredKey }) {
  const [keyInfo, setKeyInfo] = useState(null)
  const [showKey, setShowKey] = useState(false)
  const [proofResults, setProofResults] = useState({})

  // The on-chain key is the source of truth for the published identity and its
  // proofs. No keyserver: keys.openpgp.org only serves email-verified user IDs
  // and drops non-email ones, so it can't carry the published identity.
  useEffect(() => {
    if (!armoredKey) return
    let cancelled = false
    parsePgpKey(armoredKey).then((info) => { if (!cancelled && info) setKeyInfo(info) })
    return () => { cancelled = true }
  }, [armoredKey])

  // Verify identity proofs
  useEffect(() => {
    if (!keyInfo) return
    let cancelled = false

    const proofs = keyInfo.notations
      .map((n, i) => ({ ...identifyProof(n), index: i }))
      .filter(p => p && p.provider !== 'unknown')

    if (proofs.length === 0) return

    // Set all to pending
    const pending = {}
    for (const p of proofs) pending[p.index] = { status: 'pending' }
    setProofResults(pending)

    Promise.all(
      proofs.map(p =>
        verifyProof(p, keyInfo.fingerprint, import.meta.env.VITE_NEYNAR_API_KEY).then(result => ({ index: p.index, result }))
      )
    ).then(results => {
      if (cancelled) return
      const next = {}
      for (const { index, result } of results) {
        next[index] = { status: result.verified ? 'verified' : 'unverified', reason: result.reason }
      }
      setProofResults(next)
    })

    return () => { cancelled = true }
  }, [keyInfo])

  if (!keyInfo) return null

  return (
    <div className="detail-history">
      <div className="detail-label">
        PGP Key Details
      </div>

      {keyInfo.userIDs.length > 0 && (
        <div className="mono-box" style={{ marginBottom: 2 }}>
          {/* Every user ID stored on-chain. The attest flow strips emails unless the
              owner chose to include them, so what shows here is what they published. */}
          <div className="label">Published identity</div>
          {keyInfo.userIDs.map((uid, i) => <div key={i} className="value">{uid}</div>)}
        </div>
      )}

      {(() => {
        const thurinProofs = keyInfo.notations
          .map((n, i) => ({ notation: n, index: i, proof: identifyProof(n) }))
          .filter(p => p.proof)
        return (
          <div className="mono-box" style={{ marginBottom: 2 }}>
            <div className="label">Identity Proofs</div>
            {thurinProofs.length === 0 ? (
              <div className="value" style={{ color: 'var(--color-text-muted)' }}>No proofs found</div>
            ) : thurinProofs.map(({ index, proof }) => {
              const result = proofResults[index]
              const clean = displayUrl(proof)
              const href = proofHref(proof)
              const secondary = proofSecondaryHref(proof)
              return (
                <div key={index} className="proof-row">
                  {result ? (
                    result.status === 'pending' ? (
                      <span className="proof-icon pending" title="Checking...">&#8943;</span>
                    ) : result.status === 'verified' ? (
                      <span className="proof-icon verified" title="Proof verified: target contains openpgp4fpr token matching this key">&#10003;</span>
                    ) : (
                      <span className="proof-icon unverified" title={result.reason}>&#10007;</span>
                    )
                  ) : null}
                  <span className="proof-provider">{proof.label}</span>
                  {href ? (
                    <a href={href} className="proof-link" target="_blank" rel="noopener noreferrer">{clean}</a>
                  ) : (
                    <span className="proof-link">{clean}</span>
                  )}
                  {secondary && (
                    <a href={secondary} className="proof-secondary" target="_blank" rel="noopener noreferrer">proof</a>
                  )}
                </div>
              )
            })}
            <div className="proof-docs-footer">
              <a href="https://docs.thurin.id/#/guides/proofs" target="_blank" rel="noopener noreferrer">how to add proofs</a>
            </div>
          </div>
        )
      })()}

      <div className="mono-box" style={{ marginBottom: 2 }}>
        <div className="label">Key Info</div>
        <div className="value">{keyInfo.algorithm}</div>
        <div style={{ marginTop: 4 }}>
          <span style={{ color: 'var(--color-text-muted)' }}>Created: </span>
          <span className="value">{keyInfo.created ? new Date(keyInfo.created).toLocaleDateString() : '—'}</span>
        </div>
        {keyInfo.expires && (
          <div>
            <span style={{ color: 'var(--color-text-muted)' }}>Expires: </span>
            <span className="value">{new Date(keyInfo.expires).toLocaleDateString()}</span>
          </div>
        )}
        {keyInfo.subkeys.length > 0 && (
          <div>
            <span style={{ color: 'var(--color-text-muted)' }}>Subkeys: </span>
            <span className="value">{keyInfo.subkeys.length}</span>
          </div>
        )}
      </div>

      <div className="mono-box">
        <button
          className="pubkey-toggle"
          onClick={() => setShowKey(v => !v)}
        >
          {showKey ? 'Hide' : 'Show'} Public Key
        </button>
        {showKey && (
          <>
            <pre className="pubkey-block">{armoredKey}</pre>
            <div className="pubkey-actions">
              <button className="copy-btn" onClick={(e) => copyToClipboard(armoredKey, e)}>copy</button>
              <button className="copy-btn" onClick={() => {
                const blob = new Blob([armoredKey], { type: 'application/pgp-keys' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `${keyInfo.fingerprint}.asc`
                a.click()
                URL.revokeObjectURL(url)
              }}>download .asc</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Address Detail ─────────────────────────────────────────────────────────

function AddressDetail({ address, ensName, ensAvatar, attestations, count, isLoading, error }) {
  const activeCount = attestations.filter(a => !a.revoked).length
  const latest = attestations[0] // newest first

  if (isLoading) {
    return <div className="status info" style={{ marginTop: 24 }}>Querying registry...</div>
  }

  if (error) {
    return <div className="status err" style={{ marginTop: 24 }}>Query failed: {error.shortMessage || error.message}</div>
  }

  return (
    <div className="detail-page fade-in">
      <div className="detail-header">
        <div className="detail-header-content">
          {ensAvatar && <img src={ensAvatar} alt="" className="ens-avatar" />}
          <div>
            <div className="detail-label">Address</div>
            <div className="detail-address-row">
              <span className="detail-address">{address}</span>
              <button className="copy-btn" onClick={(e) => copyToClipboard(address, e)}>copy</button>
              {EXPLORER_URL && (
                <a
                  className="detail-link"
                  href={`${EXPLORER_URL}/address/${address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  etherscan
                </a>
              )}
            </div>
            {ensName && <div className="detail-ens">{ensName}</div>}
          </div>
        </div>
      </div>

      <div className="detail-summary">
        <div className="detail-label">Summary</div>
        <div className="summary-grid">
          <div className="summary-item">
            <span className="summary-value">{count}</span>
            <span className="summary-key">Total</span>
          </div>
          <div className="summary-item">
            <span className="summary-value">{activeCount}</span>
            <span className="summary-key">Active</span>
          </div>
          <div className="summary-item">
            <span className="summary-value">{count - activeCount}</span>
            <span className="summary-key">Revoked</span>
          </div>
        </div>
        {latest && !latest.revoked && (
          <div className="mono-box" style={{ marginTop: 12 }}>
            <div className="label">current fingerprint</div>
            <div className="value">{latest.fingerprint.toUpperCase()}</div>
            {latest.verification && (
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className={`status-badge ${latest.verification.verified ? 'verified' : 'unverified'}`}
                  title={latest.verification.verified ? 'PGP signature verified: the clearsign block in the event log is valid for this key and binds it to this address' : latest.verification.reason}>
                  {latest.verification.verified ? 'pgp verified' : 'unverified'}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* The identity panel only renders for a verified, non-revoked claim. A
          claim's stored public key is not authoritative until its signature
          verifies and binds the key to this address, so unverified or revoked
          key data is never used to display an identity. */}
      {latest && latest.pgpPublicKey && latest.verification?.verified && !latest.revoked ? (
        <PgpKeyInfo armoredKey={latest.pgpPublicKey} />
      ) : latest && latest.pgpPublicKey && latest.verification === null ? (
        <div className="detail-history">
          <div className="mono-box" style={{ marginBottom: 2 }}>
            <div className="label">Identity Proofs</div>
            <div className="value" style={{ color: 'var(--color-text-muted)' }}>Verifying signature…</div>
          </div>
        </div>
      ) : latest && latest.pgpPublicKey ? (
        <div className="detail-history">
          <div className="mono-box" style={{ marginBottom: 2 }}>
            <div className="label">Identity Proofs</div>
            <div className="value" style={{ color: 'var(--color-text-muted)' }}>
              {latest.revoked
                ? 'This claim has been revoked — key data not shown.'
                : 'Signature not verified — key data not shown.'}
            </div>
            <div className="proof-docs-footer">
              <a href="https://docs.thurin.id/#/guides/proofs" target="_blank" rel="noopener noreferrer">how proofs work</a>
            </div>
          </div>
        </div>
      ) : attestations.length > 0 && (
        <div className="detail-history">
          <div className="mono-box" style={{ marginBottom: 2 }}>
            <div className="label">Identity Proofs</div>
            <div className="value" style={{ color: 'var(--color-text-muted)' }}>No proofs found</div>
            <div className="proof-docs-footer">
              <a href="https://docs.thurin.id/#/guides/proofs" target="_blank" rel="noopener noreferrer">how to add proofs</a>
            </div>
          </div>
        </div>
      )}

      <EfpSection address={address} />

      {attestations.length > 0 && (
        <div className="detail-history">
          <div className="detail-label">Seal History</div>
          <div className="attestation-table-wrap">
            <table className="attestation-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Fingerprint</th>
                  <th>Date</th>
                  <th>Status <span className="info-icon" title="Active: identity claim is live on-chain. Revoked: owner has revoked this seal.">?</span></th>
                  <th>PGP <span className="info-icon" title="Verified: the PGP clearsign block stored in the event log is cryptographically valid for this key and binds it to this address. Unverified: signature check failed or PGP data is missing.">?</span></th>
                </tr>
              </thead>
              <tbody>
                {attestations.map(a => (
                  <tr key={a.index}>
                    <td className="att-index">{a.index}</td>
                    <td>
                      <a href={`/pgp/${a.fingerprint.toUpperCase()}`} className="fingerprint-link">
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
                      {a.verification ? (
                        <span className={`status-badge ${a.verification.verified ? 'verified' : 'unverified'}`}>
                          {a.verification.verified ? 'verified' : 'unverified'}
                        </span>
                      ) : (
                        <span className="status-badge" style={{ opacity: 0.4 }}>...</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {attestations.length === 0 && (
        <div className="status info" style={{ marginTop: 2 }}>
          No identity claims found for this address.
          <div style={{ marginTop: 8 }}>
            <a href="/attest" className="fingerprint-link">
              Create an identity claim →
            </a>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── EFP (Ethereum Follow Protocol) ─────────────────────────────────────────

function EfpSection({ address }) {
  const [graph, setGraph] = useState(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (!address) return
    let cancelled = false
    setIsLoading(true)
    setGraph(null)

    fetchEFPGraph(address).then(result => {
      if (cancelled) return
      setGraph(result)
      setIsLoading(false)
    })

    return () => { cancelled = true }
  }, [address])

  const hasEfp = !!graph

  if (!isLoading && !hasEfp) return null
  if (isLoading) return (
    <div className="detail-history">
      <div className="detail-label">Social Graph</div>
      <div className="mono-box" style={{ marginBottom: 2 }}>
        <div className="value" style={{ color: 'var(--color-text-muted)' }}>Loading EFP data...</div>
      </div>
    </div>
  )

  return (
    <div className="detail-history">
      <div className="detail-label">
        Social Graph
        <span style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginLeft: 8, fontWeight: 'normal' }}>
          via <a href="https://efp.app" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>EFP</a>
        </span>
      </div>
      <div className="mono-box" style={{ marginBottom: 2 }}>
        <div className="summary-grid" style={{ marginBottom: graph.top8.length > 0 ? 12 : 0 }}>
          <div className="summary-item">
            <span className="summary-value">{graph.followers}</span>
            <span className="summary-key">Followers</span>
          </div>
          <div className="summary-item">
            <span className="summary-value">{graph.following}</span>
            <span className="summary-key">Following</span>
          </div>
        </div>
        {graph.top8.length > 0 && (
          <>
            <div className="label">Top 8</div>
            <div className="efp-top8">
              {graph.top8.map((addr, i) => (
                <EfpFollowItem key={i} address={addr} />
              ))}
            </div>
          </>
        )}
      </div>
      <div style={{ textAlign: 'right', marginTop: 4 }}>
        <a
          href={`https://efp.app/${address}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}
        >
          view full profile on efp.app
        </a>
      </div>
    </div>
  )
}

function EfpFollowItem({ address }) {
  const { data: ensName } = useEnsName({
    address,
    chainId: CHAIN.id,
    query: { enabled: !!address },
  })
  return (
    <a href={`/eth/${address}`} className="efp-top8-item" title={address}>
      {ensName || `${address.slice(0, 8)}...${address.slice(-4)}`}
    </a>
  )
}

function ClaimAddressCell({ address }) {
  const { data: ensName } = useEnsName({
    address,
    chainId: CHAIN.id,
    query: { enabled: !!address },
  })
  const { data: ensAvatar } = useEnsAvatar({
    name: ensName ? safeNormalize(ensName) : undefined,
    chainId: CHAIN.id,
    query: { enabled: !!ensName },
  })
  return (
    <div className="claim-address-cell">
      {ensAvatar && <img src={ensAvatar} alt="" className="ens-avatar-sm" />}
      <div>
        <a href={`/eth/${address}`} className="address-link">
          {ensName || `${address.slice(0, 8)}...${address.slice(-6)}`}
        </a>
      </div>
    </div>
  )
}

// ─── Fingerprint Detail ─────────────────────────────────────────────────────

function FingerprintDetail({ fingerprint }) {
  const [claims, setClaims] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)
  const [verifications, setVerifications] = useState({})

  // Fetch all Attested events for this fingerprint via indexed fingerprintHash
  useEffect(() => {
    if (!REGISTRY_ADDRESS || !fingerprint) return
    let cancelled = false
    setIsLoading(true)
    setError(null)

    async function load() {
      try {
        // v2: the registry indexes owners by keccak256 of the raw fingerprint bytes,
        // and stores every claim's signature + key readably.
        const fpLower = fingerprint.toLowerCase()
        const owners = await chainClient.readContract({
          address: REGISTRY_ADDRESS,
          abi: REGISTRY_ABI,
          functionName: 'addressesFor',
          args: [fingerprintHash(fpLower)],
        })

        if (cancelled) return

        const matching = []
        for (const addr of owners) {
          const rows = await chainClient.readContract({
            address: REGISTRY_ADDRESS,
            abi: REGISTRY_ABI,
            functionName: 'attestationsOf',
            args: [addr],
          })
          for (let idx = 0; idx < rows.length; idx++) {
            const row = rows[idx]
            if (bytesToFingerprint(row.fingerprint) !== fpLower) continue
            let pgpSignature = null, pgpPublicKey = null
            try {
              const [sigHex, keyHex] = await chainClient.readContract({
                address: REGISTRY_ADDRESS,
                abi: REGISTRY_ABI,
                functionName: 'getPayload',
                args: [addr, BigInt(idx)],
              })
              pgpSignature = hexToString(sigHex)
              pgpPublicKey = hexToString(keyHex)
            } catch {}
            matching.push({
              address: addr,
              index: idx,
              fingerprint: fpLower,
              pgpSignature,
              pgpPublicKey,
              timestamp: Number(row.createdAt),
              revoked: Number(row.revokedAt) !== 0,
            })
          }
        }

        if (!cancelled) {
          setClaims(matching)
          setIsLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err)
          setIsLoading(false)
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [fingerprint])

  // Verify PGP proofs for each claim
  useEffect(() => {
    if (claims.length === 0) return
    let cancelled = false
    async function run() {
      const results = {}
      for (const claim of claims) {
        const key = `${claim.address}-${claim.index}`
        if (claim.pgpPublicKey && claim.pgpSignature) {
          results[key] = await verifyAttestation({
            pgpPublicKey: claim.pgpPublicKey,
            pgpSignature: claim.pgpSignature,
            fingerprint: claim.fingerprint,
            ethAddress: claim.address,
          })
        } else {
          results[key] = { verified: false, reason: 'No PGP data' }
        }
      }
      if (!cancelled) setVerifications(results)
    }
    run()
    return () => { cancelled = true }
  }, [claims])

  // Only a verified, non-revoked claim may drive the identity panel — there is
  // deliberately no fallback to unverified claims, since a claim's stored key
  // is not authoritative until its signature verifies and binds it to the
  // address.
  const bestClaim = useMemo(() => {
    for (const claim of claims) {
      const key = `${claim.address}-${claim.index}`
      if (!claim.revoked && verifications[key]?.verified) return claim
    }
    return null
  }, [claims, verifications])

  // Distinguishes "still verifying" from "verified, nothing passed" so a
  // legitimate identity is never briefly quarantined while checks are in flight.
  const verificationsReady = claims.length > 0 &&
    claims.every(c => verifications[`${c.address}-${c.index}`] !== undefined)

  if (isLoading) {
    return <div className="status info" style={{ marginTop: 24 }}>Querying registry...</div>
  }

  if (error) {
    return <div className="status err" style={{ marginTop: 24 }}>Query failed: {error.message}</div>
  }

  const activeClaims = claims.filter(c => !c.revoked)
  const revokedClaims = claims.filter(c => c.revoked)

  return (
    <div className="detail-page fade-in">
      <div className="detail-header">
        <div className="detail-label">PGP Fingerprint</div>
        <div className="detail-address-row">
          <span className="detail-address">{fingerprint.toUpperCase()}</span>
          <button className="copy-btn" onClick={(e) => copyToClipboard(fingerprint.toUpperCase(), e)}>copy</button>
        </div>
      </div>

      <div className="detail-summary">
        <div className="detail-label">Claims ({claims.length})</div>
        {activeClaims.length > 0 ? (
          <div className="attestation-table-wrap">
            <table className="attestation-table">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Date</th>
                  <th>Status <span className="info-icon" title="Active: identity claim is live on-chain. Revoked: owner has revoked this seal.">?</span></th>
                  <th>PGP <span className="info-icon" title="Verified: the PGP clearsign block stored in the event log is cryptographically valid for this key and binds it to this address. Unverified: signature check failed or PGP data is missing.">?</span></th>
                </tr>
              </thead>
              <tbody>
                {activeClaims.map(claim => {
                  const key = `${claim.address}-${claim.index}`
                  const v = verifications[key]
                  return (
                    <tr key={key}>
                      <td><ClaimAddressCell address={claim.address} /></td>
                      <td className="att-date">{formatDate(claim.timestamp)}</td>
                      <td><span className="status-badge active">active</span></td>
                      <td>
                        {v ? (
                          <span className={`status-badge ${v.verified ? 'verified' : 'unverified'}`}
                            title={v.verified ? 'PGP signature verified' : v.reason}>
                            {v.verified ? 'verified' : 'unverified'}
                          </span>
                        ) : (
                          <span className="status-badge" style={{ opacity: 0.4 }}>...</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {revokedClaims.map(claim => {
                  const key = `${claim.address}-${claim.index}`
                  return (
                    <tr key={key} style={{ opacity: 0.5 }}>
                      <td><ClaimAddressCell address={claim.address} /></td>
                      <td className="att-date">{formatDate(claim.timestamp)}</td>
                      <td><span className="status-badge revoked">revoked</span></td>
                      <td></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="status info" style={{ marginTop: 0 }}>
            No active claims found for this fingerprint.
            <div style={{ marginTop: 8 }}>
              <a href="/attest" className="fingerprint-link">
                Create an identity claim →
              </a>
            </div>
          </div>
        )}
      </div>

      {bestClaim?.pgpPublicKey ? (
        <PgpKeyInfo armoredKey={bestClaim.pgpPublicKey} />
      ) : claims.length > 0 && (
        <div className="detail-history">
          <div className="mono-box" style={{ marginBottom: 2 }}>
            <div className="label">Identity Proofs</div>
            <div className="value" style={{ color: 'var(--color-text-muted)' }}>
              {!verificationsReady
                ? 'Verifying signatures…'
                : 'No verified claim for this fingerprint — key data not shown.'}
            </div>
            <div className="proof-docs-footer">
              <a href="https://docs.thurin.id/#/guides/proofs" target="_blank" rel="noopener noreferrer">how proofs work</a>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Explorer ───────────────────────────────────────────────────────────────

function Explorer() {
  const links = useMemo(() => siteLinks(), [])
  const [query, setQuery] = useState(() => parseRoute()?.value || '')
  const [submitted, setSubmitted] = useState(() => parseRoute())
  const [cardTheme, setCardTheme] = useState(
    () => document.documentElement.dataset.theme || 'thurin'
  )

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setCardTheme(document.documentElement.dataset.theme || 'thurin')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  const inputType = detectInputType(query)

  // On mount + popstate, parse route and auto-submit
  useEffect(() => {
    function onRoute() {
      const route = parseRoute()
      if (route) {
        setQuery(route.value)
        setSubmitted(route)
      } else if (window.location.pathname === '/') {
        setQuery('')
        setSubmitted(null)
      }
    }
    onRoute()
    window.addEventListener('popstate', onRoute)
    window.addEventListener('hashchange', onRoute)
    return () => {
      window.removeEventListener('popstate', onRoute)
      window.removeEventListener('hashchange', onRoute)
    }
  }, [])

  // Resolve key ID (16 hex chars) → full fingerprint via the registry's key-ID index
  const [keyIdResolving, setKeyIdResolving] = useState(false)
  const [keyIdError, setKeyIdError] = useState(null)
  useEffect(() => {
    if (submitted?.type !== 'keyId') return
    let cancelled = false
    setKeyIdResolving(true)
    setKeyIdError(null)

    const keyId = keyIdToBytes(submitted.value)
    ;(async () => {
      try {
        if (!keyId) throw new Error('Not a valid key ID')
        const fps = await chainClient.readContract({
          address: REGISTRY_ADDRESS,
          abi: REGISTRY_ABI,
          functionName: 'fingerprintsForKeyId',
          args: [keyId],
        })
        if (cancelled) return
        if (fps.length === 0) throw new Error('No attestation in the registry for this key ID')
        const fullFingerprint = bytesToFingerprint(fps[0]).toUpperCase()
        setQuery(fullFingerprint)
        setSubmitted({ type: 'fingerprint', value: fullFingerprint })
        pushRoute('fingerprint', fullFingerprint)
        setKeyIdResolving(false)
      } catch (err) {
        if (cancelled) return
        setKeyIdError(err.message)
        setKeyIdResolving(false)
      }
    })()

    return () => { cancelled = true }
  }, [submitted?.type, submitted?.value])

  // ─── Live preview of what is being typed ────────────────────────────────
  // Debounced so a keystroke burst is one lookup; cleared once a lookup is submitted.
  const [preview, setPreview] = useState(null)
  useEffect(() => {
    if (submitted || !inputType) { setPreview(null); return }
    const value = query.trim()
    const id = setTimeout(() => setPreview({ type: inputType, value }), 350)
    return () => clearTimeout(id)
  }, [query, inputType, submitted])

  const previewEns = preview?.type === 'ens' ? safeNormalize(preview.value) : null
  const { data: previewEnsAddress, isLoading: previewEnsLoading, isFetched: previewEnsFetched } = useEnsAddress({
    name: previewEns || undefined,
    chainId: CHAIN.id,
    query: { enabled: !!previewEns },
  })

  // Fingerprint / key ID → address through the registry's own indexes.
  const [previewIndexed, setPreviewIndexed] = useState({ key: null, address: null, done: false })
  useEffect(() => {
    if (!preview || (preview.type !== 'fingerprint' && preview.type !== 'keyId')) return
    let cancelled = false
    const key = `${preview.type}:${preview.value}`
    setPreviewIndexed({ key, address: null, done: false })
    ;(async () => {
      try {
        let fps
        if (preview.type === 'keyId') {
          const keyId = keyIdToBytes(preview.value)
          fps = keyId ? await chainClient.readContract({ address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'fingerprintsForKeyId', args: [keyId] }) : []
        } else {
          fps = ['0x' + preview.value.toLowerCase()]
        }
        let found = null
        for (const fp of fps) {
          const owners = await chainClient.readContract({ address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'addressesFor', args: [fingerprintHash(fp)] })
          if (owners.length) { found = owners[owners.length - 1]; break }
        }
        if (!cancelled) setPreviewIndexed({ key, address: found, done: true })
      } catch {
        if (!cancelled) setPreviewIndexed({ key, address: null, done: true })
      }
    })()
    return () => { cancelled = true }
  }, [preview?.type, preview?.value])

  const previewAddress = !preview ? null
    : preview.type === 'address' ? preview.value
    : preview.type === 'ens' ? (previewEnsAddress || null)
    : (previewIndexed.key === `${preview.type}:${preview.value}` ? previewIndexed.address : null)
  const previewResolving = !!preview && !previewAddress && (
    preview.type === 'ens' ? previewEnsLoading || !previewEnsFetched
    : preview.type === 'address' ? false
    : !(previewIndexed.key === `${preview.type}:${preview.value}` && previewIndexed.done))
  const previewNotFound = !!preview && !previewAddress && !previewResolving

  const handleLookup = useCallback(() => {
    if (!inputType) return
    const value = query.trim()
    if (inputType === 'keyId') {
      setSubmitted({ type: 'keyId', value })
      pushRoute('keyId', value)
    } else {
      setSubmitted({ type: inputType, value })
      pushRoute(inputType, value)
    }
  }, [query, inputType])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleLookup()
  }

  // ─── ENS resolution ─────────────────────────────────────────────────────

  const normalizedEns = submitted?.type === 'ens' ? safeNormalize(submitted.value) : null
  const {
    data: ensResolvedAddress,
    isLoading: ensLoading,
    error: ensError,
  } = useEnsAddress({
    name: normalizedEns,
    chainId: CHAIN.id,
    query: { enabled: !!normalizedEns },
  })

  const lookupAddress = submitted?.type === 'address' ? submitted.value
    : submitted?.type === 'ens' ? ensResolvedAddress
    : null

  const {
    data: reverseEns,
  } = useEnsName({
    address: submitted?.type === 'address' ? submitted.value : undefined,
    chainId: CHAIN.id,
    query: { enabled: submitted?.type === 'address' },
  })

  // ─── Contract reads ─────────────────────────────────────────────────────

  // Step 1: the owner's full history in one call (v2 `attestationsOf`)
  const {
    data: attestationRows,
    isLoading: countLoading,
    error: countError,
  } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: 'attestationsOf',
    args: lookupAddress ? [lookupAddress] : undefined,
    chainId: CHAIN.id,
    query: { enabled: !!REGISTRY_ADDRESS && !!lookupAddress },
  })

  const attestationCount = attestationRows !== undefined ? BigInt(attestationRows.length) : undefined
  const count = attestationRows ? attestationRows.length : 0

  // Step 2: the stored signature + key for each claim (`getPayload`, multicall)
  const payloadContracts = useMemo(() => {
    if (!lookupAddress || !REGISTRY_ADDRESS || count === 0) return []
    return Array.from({ length: count }, (_, i) => ({
      address: REGISTRY_ADDRESS,
      abi: REGISTRY_ABI,
      functionName: 'getPayload',
      args: [lookupAddress, BigInt(i)],
      chainId: CHAIN.id,
    }))
  }, [lookupAddress, count])

  const {
    data: payloads,
    isLoading: payloadsLoading,
    error: attestationsError,
  } = useReadContracts({
    contracts: payloadContracts,
    query: { enabled: payloadContracts.length > 0 },
  })
  const attestationsLoading = countLoading || payloadsLoading

  // Step 3: Post-process into display-ready data (newest first)
  const attestationsRaw = useMemo(() => {
    if (!attestationRows) return []
    return attestationRows
      .map((row, index) => {
        const p = payloads?.[index]
        let pgpSignature = null, pgpPublicKey = null
        if (p?.status === 'success') {
          pgpSignature = hexToString(p.result[0])
          pgpPublicKey = hexToString(p.result[1])
        }
        const revokedAt = Number(row.revokedAt)
        return {
          index,
          fingerprint: bytesToFingerprint(row.fingerprint),
          createdAt: Number(row.createdAt),
          revoked: revokedAt !== 0,
          revokedAt: revokedAt || null,
          messageVersion: Number(row.messageVersion),
          pgpSignature,
          pgpPublicKey,
        }
      })
      .reverse()
  }, [attestationRows, payloads])

  // Step 5: Verify PGP proofs for each attestation
  const [verifications, setVerifications] = useState({})
  useEffect(() => {
    if (attestationsRaw.length === 0 || !lookupAddress) return
    let cancelled = false
    async function run() {
      const results = {}
      for (const att of attestationsRaw) {
        if (att.pgpPublicKey && att.pgpSignature) {
          results[att.index] = await verifyAttestation({
            pgpPublicKey: att.pgpPublicKey,
            pgpSignature: att.pgpSignature,
            fingerprint: att.fingerprint,
            ethAddress: lookupAddress,
          })
        } else {
          results[att.index] = { verified: false, reason: 'No PGP data stored' }
        }
      }
      if (!cancelled) setVerifications(results)
    }
    run()
    return () => { cancelled = true }
  }, [attestationsRaw, lookupAddress])

  // Merge verification results into attestations
  const attestations = useMemo(() => {
    return attestationsRaw.map(a => ({
      ...a,
      verification: verifications[a.index] || null,
    }))
  }, [attestationsRaw, verifications])

  const isAddressLookup = submitted?.type === 'address' || submitted?.type === 'ens'
  const isLoading = (isAddressLookup && (countLoading || attestationsLoading)) || ensLoading
  const error = countError || attestationsError
  const noContract = !REGISTRY_ADDRESS

  // Derive ENS name for display
  const displayEns = submitted?.type === 'ens' ? submitted.value
    : submitted?.type === 'address' ? reverseEns
    : null

  const { data: ensAvatar } = useEnsAvatar({
    name: displayEns ? safeNormalize(displayEns) : undefined,
    chainId: CHAIN.id,
    query: { enabled: !!displayEns },
  })

  return (
    <>
      {!submitted && (
        <section className="home-hero">
          <h1 className="home-tagline">Prove more.</h1>
          <h1 className="home-tagline home-tagline-2">Reveal less.</h1>
          <p className="home-lede">
            Prove an online identity is really yours. Anyone can check it, no company
            holds it, and nothing about you goes public unless you choose.
          </p>
        </section>
      )}
      <div className={submitted ? 'search-section' : 'search-section search-section-home'}>
        <div className="lookup-input-row">
          <input
            className="text-input"
            placeholder="ENS name, Ethereum address, or PGP fingerprint"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
          />
          <button
            className="btn btn-primary"
            onClick={handleLookup}
            disabled={!inputType}
          >
            Lookup
          </button>
        </div>

        {query.trim() && !inputType && (
          <div className="status info" style={{ marginTop: 12 }}>
            Enter a valid ETH address (0x, 42 chars), ENS name (e.g. vitalik.eth), PGP fingerprint (40 hex chars), or key ID (16 hex chars).
          </div>
        )}

        {query.trim() && inputType && (submitted || !preview) && (
          <div className="lookup-detected" style={{ marginTop: 8 }}>
            Detected: <span className="lookup-type">{inputType === 'keyId' ? 'key ID' : inputType}</span>
          </div>
        )}
        {!submitted && (
          <>
            {preview && (
              <IdentityKitProvider
                rpcUrl={RPC_URL}
                neynarApiKey={import.meta.env.VITE_NEYNAR_API_KEY}
                network={NETWORK}
              >
                <LookupPreview
                  key={`${preview.type}:${preview.value}`}
                  address={previewAddress}
                  name={preview.type === 'ens' ? preview.value : null}
                  resolving={previewResolving}
                  notFound={previewNotFound}
                  neynarApiKey={import.meta.env.VITE_NEYNAR_API_KEY}
                  onOpen={handleLookup}
                />
              </IdentityKitProvider>
            )}
          </>
        )}
      </div>

      {!submitted && (
        <>
          <IdentityKitProvider
            rpcUrl={RPC_URL}
            neynarApiKey={import.meta.env.VITE_NEYNAR_API_KEY}
            network={NETWORK}
            baseUrl={links.self}
          >
            <section className="home-cards">
              <ThurinCard ens="thurinlabs.eth" theme={cardTheme} />
              <ThurinCard ens="vitalik.eth" theme={cardTheme} />
            </section>
            <p className="home-cards-link">
              <a href={`${links.docs}/#/sdk`} target="_blank" rel="noopener noreferrer">Put your own card on any site →</a>
            </p>
          </IdentityKitProvider>
          <section className="home-rules">
            <div className="home-rule">
              <h3>Nothing in the middle.</h3>
              <p>There is no Thurin server holding your identity. It lives on Ethereum, a public record no company controls, and your browser checks it directly.</p>
            </div>
            <div className="home-rule">
              <h3>Your key stays put.</h3>
              <p>It is stored where you published it, so it can’t be swapped, lost, or quietly changed by someone else.</p>
            </div>
            <div className="home-rule">
              <h3>Your email stays private.</h3>
              <p>Nothing about you goes public unless you choose it. Publish a name, not a life.</p>
            </div>
          </section>
          <section className="home-close">
            <p>Want your own? <a href="/attest">Attest</a> takes a few minutes and one transaction.</p>
            <a className="home-roadmap" href={`${links.docs}/#/roadmap`} target="_blank" rel="noopener noreferrer">What’s coming: the roadmap →</a>
          </section>
        </>
      )}

      <div className="lookup-results">
        {/* Key ID resolving */}
        {keyIdResolving && (
          <div className="status info" style={{ marginTop: 24 }}>
            Resolving key ID {submitted?.value}...
          </div>
        )}
        {keyIdError && (
          <div className="status err" style={{ marginTop: 24 }}>
            Could not resolve key ID: {keyIdError}
          </div>
        )}

        {/* ENS resolving */}
        {submitted?.type === 'ens' && ensLoading && (
          <div className="status info" style={{ marginTop: 24 }}>
            Resolving {submitted.value}...
          </div>
        )}

        {/* ENS resolution failed */}
        {submitted?.type === 'ens' && !ensLoading && ensError && (
          <div className="status err" style={{ marginTop: 24 }}>
            Could not resolve ENS name: {ensError.shortMessage || ensError.message}
          </div>
        )}

        {/* ENS resolved but no address found */}
        {submitted?.type === 'ens' && !ensLoading && !ensError && !ensResolvedAddress && (
          <div className="status err" style={{ marginTop: 24 }}>
            No address found for {submitted.value}
          </div>
        )}

        {/* Contract not deployed — fallback with whatever data we have */}
        {noContract && submitted && (submitted.type !== 'ens' || ensResolvedAddress) && (
          <div className="result-card fade-in" style={{ marginTop: 24 }}>
            <div className="result-card-header">
              <span className="result-card-label">Registry Status</span>
            </div>
            <div className="result-card-body">
              <div className="status info">
                The PGPRegistry contract is not yet deployed. Once deployed to Sepolia, lookups will query on-chain data.
                <div style={{ marginTop: 8 }}>
                  <a href="/attest" className="fingerprint-link">
                    Create an identity claim →
                  </a>
                </div>
              </div>
              {submitted.type === 'ens' && ensResolvedAddress && (
                <>
                  <div className="mono-box" style={{ marginTop: 16 }}>
                    <div className="label">ens name</div>
                    <div className="value">{submitted.value}</div>
                  </div>
                  <div className="mono-box" style={{ marginTop: 8 }}>
                    <div className="label">resolved address</div>
                    <div className="value">{ensResolvedAddress}</div>
                  </div>
                </>
              )}
              {submitted.type === 'address' && (
                <div className="mono-box" style={{ marginTop: 16 }}>
                  <div className="label">queried address</div>
                  <div className="value">
                    {submitted.value}
                    {reverseEns && <span className="ens-reverse"> ({reverseEns})</span>}
                  </div>
                </div>
              )}
              {submitted.type === 'fingerprint' && (
                <div className="mono-box" style={{ marginTop: 16 }}>
                  <div className="label">queried fingerprint</div>
                  <div className="value">{submitted.value}</div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Address/ENS detail page */}
        {!noContract && isAddressLookup && lookupAddress && attestationCount !== undefined && (
          <AddressDetail
            address={lookupAddress}
            ensName={displayEns}
            ensAvatar={ensAvatar}
            attestations={attestations}
            count={count}
            isLoading={attestationsLoading}
            error={attestationsError}
          />
        )}

        {/* Fingerprint detail page */}
        {!noContract && submitted?.type === 'fingerprint' && (
          <FingerprintDetail fingerprint={submitted.value} />
        )}

        {/* Loading (contract reads) */}
        {!noContract && isLoading && submitted && !ensLoading && (
          <div className="status info" style={{ marginTop: 24 }}>
            Querying registry...
          </div>
        )}
      </div>
    </>
  )
}

// ─── Root App ───────────────────────────────────────────────────────────────

export default function App() {
  const isAttest = typeof window !== 'undefined' && window.location.pathname.startsWith('/attest')
  const links = useMemo(() => siteLinks(), [])

  useEffect(() => {
    document.title = isAttest ? 'Thurin.id — Attest' : 'Thurin.id — Prove more. Reveal less.'
  }, [isAttest])

  return (
    <div className="app">
      <Topbar isAttest={isAttest} />

      {isAttest ? <Attest /> : <Explorer />}

      <footer className="footer">
        <span className="footer-version">thurin v{version}</span>
        <div className="footer-columns">
          <div className="footer-col">
            <span className="footer-col-label">Home</span>
            <a href={links.company} target="_blank" rel="noopener noreferrer">Thurin Labs</a>
            <a href="/attest">Attest</a>
            <a href={links.privacy} target="_blank" rel="noopener noreferrer">Privacy</a>
          </div>
          <div className="footer-col">
            <span className="footer-col-label">Social</span>
            <a href="https://x.com/thurinlabs" target="_blank" rel="noopener noreferrer">X</a>
            <a href="https://farcaster.xyz/thurinlabs.eth" target="_blank" rel="noopener noreferrer">Farcaster</a>
            <a href="https://www.linkedin.com/company/thurin-labs/" target="_blank" rel="noopener noreferrer">LinkedIn</a>
          </div>
          <div className="footer-col">
            <span className="footer-col-label">Dev</span>
            <a href="https://github.com/thurinlabs" target="_blank" rel="noopener noreferrer">GitHub</a>
            <a href="https://codeberg.org/thurinlabs" target="_blank" rel="noopener noreferrer">Codeberg</a>
            <a href={links.docs} target="_blank" rel="noopener noreferrer">Docs</a>
            <a href={`${links.docs}/#/roadmap`} target="_blank" rel="noopener noreferrer">Roadmap</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
