import { useEffect, useMemo, useState } from 'react'
import { useEnsName, useEnsAvatar } from 'wagmi'
import { normalize } from 'viem/ens'
import { useAttestations, parsePgpKey, identifyProof, verifyProof, displayUrl } from '@thurinlabs/identity-kit'
import { CHAIN } from '../wagmiConfig'

// Plain-language labels for the rows a visitor sees.
const PROVIDER_LABELS = { dns: 'Website' }

function shortAddress(a) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function formatFingerprint(fp) {
  return fp.toUpperCase().replace(/(.{4})/g, '$1 ').trim()
}

function safeNormalize(name) {
  try { return normalize(name) } catch { return undefined }
}

function Tick() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 6.5 L5 9 L9.5 3.5" />
    </svg>
  )
}

function Row({ label, value, status, ok }) {
  // status null = still checking: the row is there, the verdict is not
  return (
    <div className={`lookup-row${status ? ' lookup-row-done' : ''}`}>
      <span className="lookup-row-label">{label}</span>
      <span className="lookup-row-value">{value}</span>
      <span className={`lookup-row-status${status ? (ok ? ' ok' : ' bad') : ''}`}>
        {status ? <>{ok && <Tick />}{status}</> : '…'}
      </span>
    </div>
  )
}

/**
 * Live preview of the identity the visitor is typing. Runs the real lookup
 * through identity-kit as soon as the input resolves to an address, and
 * renders each check as it lands. Nothing is scripted: a proof that stops
 * verifying says so.
 *
 * Props: `address` (null while the typed value is still resolving), `name`
 * (the ENS name typed, if any), `resolving`, `notFound` (a name that does not
 * resolve), `onOpen(value)` for the full-page link.
 */
export default function LookupPreview({ address, name, resolving, notFound, neynarApiKey, onOpen }) {
  const { claims, isLoading } = useAttestations(address || undefined)

  // A typed address gets its ENS name and avatar back; a typed name gets its avatar.
  const { data: reverseName } = useEnsName({
    address: !name && address ? address : undefined,
    chainId: CHAIN.id,
    query: { enabled: !name && !!address },
  })
  const displayName = name || reverseName || null
  const { data: avatar } = useEnsAvatar({
    name: displayName ? safeNormalize(displayName) : undefined,
    chainId: CHAIN.id,
    query: { enabled: !!displayName },
  })

  const claim = useMemo(
    () => claims.find(c => !c.revoked && c.verification?.verified) || null,
    [claims],
  )
  const verifying = !claim && claims.some(c => !c.revoked && c.verification == null)
  const noClaim = !isLoading && claims.length > 0 && !verifying && !claim
  const empty = !!address && !isLoading && claims.length === 0

  // Proofs from the on-chain key, verified one by one so rows land as they finish.
  const [proofs, setProofs] = useState([])
  const [results, setResults] = useState({})
  const [parsed, setParsed] = useState(false)
  useEffect(() => {
    setProofs([])
    setResults({})
    setParsed(false)
    if (!claim?.pgpPublicKey) return
    let cancelled = false
    ;(async () => {
      const info = await parsePgpKey(claim.pgpPublicKey)
      if (cancelled || !info) return
      const found = info.notations.map(identifyProof).filter(Boolean)
      const seen = new Set()
      const unique = found.filter(p => (seen.has(p.url) ? false : seen.add(p.url)))
      setProofs(unique)
      setParsed(true)
      unique.forEach(async (p) => {
        let r
        try {
          r = await verifyProof(p, claim.fingerprint, neynarApiKey)
        } catch (err) {
          r = { verified: false, reason: err.message }
        }
        if (!cancelled) setResults(prev => ({ ...prev, [p.url]: r }))
      })
    })()
    return () => { cancelled = true }
  }, [claim, neynarApiKey])

  const allDone = !!claim && parsed && proofs.every(p => results[p.url])
  const headline = displayName || (address ? shortAddress(address) : null)
  const openValue = name || address

  return (
    <div className="lookup-preview" aria-live="polite">
      <div className="lookup-preview-head">
        {avatar
          ? <img className="lookup-preview-avatar" src={avatar} alt="" />
          : <div className="lookup-preview-avatar lookup-preview-avatar-empty" aria-hidden="true">
              {headline ? headline[0].toUpperCase() : '?'}
            </div>}
        <div className="lookup-preview-who">
          <div className="lookup-preview-name">
            {notFound ? 'No such name' : (headline || 'Looking up…')}
          </div>
          {address && <div className="lookup-preview-address">{address}</div>}
        </div>
      </div>

      {notFound && (
        <p className="lookup-preview-note">That name does not resolve to an address.</p>
      )}

      {empty && (
        <p className="lookup-preview-note">No claim on Thurin for this identity yet.</p>
      )}

      {address && !empty && (
        <>
          <Row
            label="Ethereum"
            value={`${shortAddress(address)} · published this claim`}
            status={isLoading ? null : (noClaim ? 'no active claim' : 'on record')}
            ok={!noClaim}
          />
          {(claim || verifying || noClaim) && (
            <Row
              label="PGP key"
              value={formatFingerprint((claim || claims.find(c => !c.revoked) || claims[0]).fingerprint)}
              status={claim ? 'matches' : (noClaim ? 'does not match' : null)}
              ok={!!claim}
            />
          )}
          {proofs.map(p => {
            const r = results[p.url]
            return (
              <Row
                key={p.url}
                label={PROVIDER_LABELS[p.provider] || p.label}
                value={displayUrl(p)}
                status={r ? (r.verified ? 'confirmed' : 'not confirmed') : null}
                ok={!!r?.verified}
              />
            )
          })}
        </>
      )}

      {(address || resolving) && !notFound && (
        <div className={`lookup-preview-foot${allDone ? ' lookup-preview-foot-done' : ''}`}>
          <span>{allDone ? 'checked just now, in your browser · nothing passed through us' : 'checking in your browser…'}</span>
          {openValue && (
            <a href={name ? `/ens/${name}` : `/eth/${address}`}
              onClick={(e) => { if (onOpen) { e.preventDefault(); onOpen() } }}>
              Full identity →
            </a>
          )}
        </div>
      )}
    </div>
  )
}
