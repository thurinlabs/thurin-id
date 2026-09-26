import { Fragment, useState, useEffect, useCallback, useMemo } from 'react'
import { version } from '../package.json'
import { useEnsName, useAccount } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { useSafeAvatar, AvatarImg } from './avatar'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { normalize } from 'viem/ens'
import { REGISTRY_ADDRESS, NETWORK, CHAIN, EXPLORER_URL, typedNameClient, readClient } from './wagmiConfig'
import { keyIdToBytes, normalizeFingerprint, sameFingerprint, readClaims, findOwners, CLAIM_LIMIT } from '@thurinlabs/identity-kit'
import {
  identifyProof,
  verifyProof,
  displayUrl,
  proofHref,
  proofSecondaryHref,
  parsePgpKey,
  claimCheckText,
  expiresSoon,
  expiresSoonText,
  claimFates,
  claimFateText,
} from '@thurinlabs/identity-kit'
import { siteLinks } from './links'
import { spacedFingerprint, formatDate, formatIsoDate, claimStateLabel } from './format'
import Attest from './components/Attest'
import EnsRecordLine from './components/EnsRecordLine'
import AccountMenu from './components/AccountMenu'
import RpcSetting from './components/RpcSetting'
import ProofSetting from './components/ProofSetting'
import { useAlwaysCheckProofs, CHECK_NOTE } from './proofChecks'
import { ReadFailed, EnsNotResolved } from './components/ReadFailed'
import IdentityTabs from './components/IdentityTabs'
import RecordsTab from './components/RecordsTab'

const NO_CLAIMS = []

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

// Path routes (/eth/…, /attest) need a host that serves index.html for unknown paths: thurin.id
// (nginx), *.eth.limo (the `_redirects` file in public/), and Vite. Anywhere else, such as a raw
// /ipfs/<cid>/ gateway, routes fall back to #/.
export function usesPathRouting() {
  const h = window.location.hostname
  return h === 'thurin.id' || h.endsWith('.eth.limo') || h === 'localhost' || h === '127.0.0.1'
}

/** The site's mode, following the toggle (it sets data-theme on <html>). */
function useSiteTheme() {
  const read = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}

/**
 * The address of an ENS name the visitor typed. It may follow the name to a server its owner
 * picked (an offchain name), since there's no other way to answer; nothing else on the site does.
 */
function useTypedEnsAddress(name) {
  const q = useQuery({
    queryKey: ['typed-ens-address', CHAIN.id, name],
    queryFn: async () => (await typedNameClient.getEnsAddress({ name })) ?? null,
    enabled: !!name,
    staleTime: 60_000,
  })
  return { data: q.data ?? undefined, isLoading: q.isLoading, isFetched: q.isFetched, error: q.error }
}

/** Card images are drawn behind thurin.id itself; a copy served elsewhere (an ENS gateway) asks thurin.id. */
function cardHost() {
  const h = window.location.hostname
  return h === 'thurin.id' || h === 'localhost' || h === '127.0.0.1' ? '' : 'https://thurin.id'
}

function parseRoute() {
  // A #/eth/… route: moved to its path where paths work, else read as it is
  const hash = window.location.hash.replace(/^#\/?/, '')
  if (hash) {
    const slash = hash.indexOf('/')
    if (slash !== -1) {
      const prefix = hash.slice(0, slash).toLowerCase()
      const value = decodeURIComponent(hash.slice(slash + 1))
      if (value && (prefix === 'eth' || prefix === 'pgp' || prefix === 'ens')) {
        const { id, tab } = splitTab(value)
        if (usesPathRouting()) {
          window.history.replaceState(null, '', `/${prefix}/${encodeURIComponent(id)}${tab === 'overview' ? '' : `/${tab}`}`)
        } else {
          // A path gateway: read the hash route
          return { type: prefix === 'eth' ? 'address' : prefix === 'pgp' ? (/^[0-9a-fA-F]{16}$/i.test(id) ? 'keyId' : 'fingerprint') : 'ens', value: id, tab }
        }
      }
    }
  }

  const path = window.location.pathname.replace(/^\/?/, '')
  if (!path) return null

  const slash = path.indexOf('/')
  if (slash === -1) return null

  const prefix = path.slice(0, slash).toLowerCase()
  const raw = decodeURIComponent(path.slice(slash + 1))
  if (!raw) return null
  const { id: value, tab } = splitTab(raw)

  if (prefix === 'eth' && /^0x[0-9a-fA-F]{40}$/.test(value)) return { type: 'address', value, tab }
  if (prefix === 'pgp' && /^[0-9a-fA-F]{40}$/i.test(value)) return { type: 'fingerprint', value, tab }
  if (prefix === 'pgp' && /^[0-9a-fA-F]{16}$/i.test(value)) return { type: 'keyId', value, tab }
  if (prefix === 'ens') return { type: 'ens', value, tab }

  return null
}

// /ens/<name>/claims → { id: '<name>', tab: 'claims' }; no suffix → overview.
const TABS = ['overview', 'claims', 'records']
function splitTab(value) {
  const m = value.match(/^(.*)\/(claims|records)$/)
  return m ? { id: m[1], tab: m[2] } : { id: value, tab: 'overview' }
}

function pushRoute(type, value, tab = 'overview') {
  const prefix = type === 'address' ? 'eth' : (type === 'fingerprint' || type === 'keyId') ? 'pgp' : 'ens'
  const suffix = TABS.includes(tab) && tab !== 'overview' ? `/${tab}` : ''
  if (usesPathRouting()) {
    const newPath = `/${prefix}/${encodeURIComponent(value)}${suffix}`
    if (window.location.pathname !== newPath) {
      window.history.pushState(null, '', newPath)
    }
  } else {
    // A path gateway: hash routes
    const newHash = `#/${prefix}/${encodeURIComponent(value)}${suffix}`
    if (window.location.hash !== newHash) {
      window.location.hash = newHash
    }
  }
}

// ─── Topbar ─────────────────────────────────────────────────────────────────

// Dark (the Thurin look) or light, one icon button: a moon in light mode, a sun in dark.
function ThemeToggle({ storageKey }) {
  const [theme, setTheme] = useState(() => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'))
  const next = theme === 'light' ? 'dark' : 'light'
  const toggle = () => {
    setTheme(next)
    document.documentElement.dataset.theme = next
    try { localStorage.setItem(storageKey, next) } catch { /* private mode: the choice lasts this visit */ }
  }
  return (
    <button className="theme-toggle" onClick={toggle} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
      {theme === 'light' ? (
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
        </svg>
      )}
    </button>
  )
}

function Topbar({ isAttest }) {
  // Your own identity page: by ENS name when the wallet has one, else by address. /attest is a
  // separate page load, so from there it's a plain navigation; elsewhere it's an in-app route.
  const goToIdentity = (account) => {
    const [type, value] = account.ensName ? ['ens', account.ensName] : ['address', account.address]
    if (isAttest) {
      const prefix = type === 'ens' ? 'ens' : 'eth'
      window.location.href = usesPathRouting() ? `/${prefix}/${encodeURIComponent(value)}` : `./#/${prefix}/${encodeURIComponent(value)}`
      return
    }
    pushRoute(type, value)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
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
          <span className="status-badge topbar-network" title={`Reading the ${NETWORK} registry. Nothing here touches mainnet.`}>
            {NETWORK}<span className="topbar-network-word"> testnet</span>
          </span>
        )}
      </a>
      <div className="topbar-right">
        {isAttest ? (
          <a href="/" className="topbar-action-link">
            Search
          </a>
        ) : (
          <a href="/attest" className="topbar-action-link">
            Add key
          </a>
        )}
        {/* One wallet switch for the whole site, needed only on your own pages (records, the ENS
            record). Only the browser knows who you are. */}
        <div className="topbar-connect">
          <ConnectButton.Custom>
            {({ account, chain, mounted, openConnectModal, openChainModal, openAccountModal }) => {
              if (!mounted) return null
              if (!account) return <button className="topbar-action-link topbar-connect-btn" onClick={openConnectModal}>Connect</button>
              if (chain?.unsupported) return <button className="topbar-action-link topbar-connect-btn wrong" onClick={openChainModal} title={`Switch to ${CHAIN.name}`}>Wrong network</button>
              return <AccountMenu label={account.ensName || account.displayName} address={account.address}
                onIdentity={() => goToIdentity(account)} onWallet={openAccountModal} />
            }}
          </ConnectButton.Custom>
        </div>
        <ThemeToggle storageKey="thurin-theme" />
      </div>
    </nav>
  )
}

// ─── PGP Key Info ──────────────────────────────────────────────────────────

function PgpKeyInfo({ armoredKey, show = 'all' }) {
  const [keyInfo, setKeyInfo] = useState(null)
  const [showKey, setShowKey] = useState(false)
  const [proofResults, setProofResults] = useState({})
  // Proofs are checked when the visitor asks (or always, if they chose that in the footer).
  const alwaysCheck = useAlwaysCheckProofs()
  const [asked, setAsked] = useState(false)
  const checking = asked || alwaysCheck

  // The on-chain key is the published identity. No keyserver: keys.openpgp.org drops user IDs
  // without an email, so it can't carry the name proofs sit on.
  useEffect(() => {
    if (!armoredKey) return
    let cancelled = false
    parsePgpKey(armoredKey).then((info) => { if (!cancelled && info) setKeyInfo(info) })
    return () => { cancelled = true }
  }, [armoredKey])

  // Verify identity proofs, once the visitor asks
  useEffect(() => {
    if (!keyInfo || !checking) return
    let cancelled = false

    const proofs = keyInfo.notations
      .map((n, i) => ({ ...identifyProof(n), index: i }))
      .filter(p => p && p.provider !== 'unknown')

    if (proofs.length === 0) return

    const pending = {}
    for (const p of proofs) pending[p.index] = { status: 'pending' }
    setProofResults(pending)

    Promise.all(
      proofs.map(p =>
        verifyProof(p, keyInfo.fingerprint).then(result => ({ index: p.index, result }))
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
  }, [keyInfo, checking])

  if (!keyInfo) return null

  return (
    <div className="detail-history">
      <div className="detail-label">
        {show === 'key' ? 'PGP Key' : 'PGP Key Details'}
      </div>

      {show !== 'key' && keyInfo.userIDs.length > 0 && (
        <div className="mono-box" style={{ marginBottom: 2 }}>
          {/* Every user ID stored on-chain. The attest flow strips emails unless the
              owner chose to include them, so what shows here is what they published. */}
          <div className="label">Published identity</div>
          {keyInfo.userIDs.map((uid, i) => <div key={i} className="value">{uid}</div>)}
        </div>
      )}

      {show !== 'key' && (() => {
        const thurinProofs = keyInfo.notations
          .map((n, i) => ({ notation: n, index: i, proof: identifyProof(n) }))
          .filter(p => p.proof)
        return (
          <div className="mono-box" style={{ marginBottom: 2 }}>
            <div className="proofs-head">
              <div className="label">Identity Proofs</div>
              {!checking && thurinProofs.length > 0 && (
                <button className="btn btn-small" onClick={() => setAsked(true)}>
                  Check proofs
                </button>
              )}
            </div>
            {thurinProofs.length === 0 ? (
              <div className="value" style={{ color: 'var(--color-text-muted)' }}>No proofs found</div>
            ) : thurinProofs.map(({ index, proof }) => {
              const result = proofResults[index]
              const clean = displayUrl(proof)
              const href = proofHref(proof)
              const secondary = proofSecondaryHref(proof)
              return (
                <div key={index} className={`proof-row${checking ? '' : ' unchecked'}`}>
                  {!checking ? (
                    <span className="proof-icon unchecked" title="Not checked: anyone can write any handle into their own key">&#9675;</span>
                  ) : result ? (
                    result.status === 'pending' ? (
                      <span className="proof-icon pending" title="Checking…">&#8943;</span>
                    ) : result.status === 'verified' ? (
                      <span className="proof-icon verified" title="Checked: the account names this key">&#10003;</span>
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
                  {!checking && <span className="proof-unchecked">not checked</span>}
                </div>
              )
            })}
            {!checking && thurinProofs.length > 0 && <div className="proof-note">{CHECK_NOTE}</div>}
            <div className="proof-docs-footer">
              <a href="https://docs.thurin.id/#/guides/proofs" target="_blank" rel="noopener noreferrer">how to add proofs</a>
            </div>
          </div>
        )
      })()}

      {show !== 'proofs' && (<>
      <div className="mono-box" style={{ marginBottom: 2 }}>
        <div className="label">Key Info</div>
        <div className="value">{keyInfo.algorithm}</div>
        <div style={{ marginTop: 4 }}>
          <span style={{ color: 'var(--color-text-muted)' }}>Created: </span>
          <span className="value">{formatIsoDate(keyInfo.created)}</span>
        </div>
        {keyInfo.expires && (
          <div>
            <span style={{ color: 'var(--color-text-muted)' }}>Expires: </span>
            <span className="value">{formatIsoDate(keyInfo.expires)}</span>
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
      </>)}
    </div>
  )
}

// ─── Claim check note ───────────────────────────────────────────────────────
// The sentence under a claim's badge: why it doesn't count, or that its key expires soon. The
// "If this is yours" fix shows only when the connected wallet owns the claim.

function ClaimCheckNote({ check, soon, isSelf }) {
  if (!check) return null
  if (check.kind !== 'verified') return (
    <div className="claim-check-note">
      <p>{check.sentence}</p>
      {isSelf && check.fix && (
        <p className="claim-check-fix">If this is yours: {check.fix} <a href="/attest">Your claims ›</a></p>
      )}
    </div>
  )
  if (!soon) return null
  return (
    <div className="claim-check-note">
      <p>{expiresSoonText(soon)}</p>
      {isSelf && (
        <p className="claim-check-fix">
          If this is yours: extend it (<code>gpg --quick-set-expire</code>), then Update key at <a href="/attest">thurin.id/attest</a>. No new signature needed.
        </p>
      )}
    </div>
  )
}

// ─── Address Detail ─────────────────────────────────────────────────────────

function AddressDetail({ address, ensName, ensAvatar, attestations, count, tab = 'overview', onTab }) {
  const { address: wallet } = useAccount()
  const isSelf = !!wallet && wallet.toLowerCase() === address.toLowerCase()
  const activeCount = attestations.filter(a => !a.revoked).length
  // The claim this page speaks for: the newest *active* one (a revoked claim can be newer,
  // as after moving a key to another address). Only a fully revoked address shows its last claim.
  const latest = attestations.find(a => !a.revoked) || attestations[0] // newest first
  // Why a claim does or doesn't count, in the kit's words; the "If this is yours" fix only for the owner.
  const fates = useMemo(() => claimFates(attestations), [attestations])
  const check = latest?.verification ? claimCheckText(latest.verification) : null
  const soon = expiresSoon(latest?.verification)

  return (
    <div className="detail-page fade-in">
      <div className="detail-header">
        <div className="detail-header-content">
          <AvatarImg src={ensAvatar} className="ens-avatar" />
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
              {ensName && (
                <a className="detail-link" href={`https://app.ens.domains/${ensName}`} target="_blank" rel="noopener noreferrer">ens</a>
              )}
              <a className="detail-link" href={`https://efp.app/${address}`} target="_blank" rel="noopener noreferrer">efp</a>
            </div>
            {ensName && <div className="detail-ens">{ensName}</div>}
            {isSelf && <div className="detail-self" title="The connected wallet is this address. Records and the ENS record can be set from this page.">this is you</div>}
          </div>
        </div>
      </div>

      <IdentityTabs tab={tab} onTab={onTab} counts={{ claims: count }} />

      {tab === 'records' && (
        <RecordsTab owner={address} index={latest && !latest.revoked && latest.verification?.verified ? latest.index : null} armoredKey={latest?.pgpPublicKey} fingerprint={latest?.fingerprint ?? null} canEdit={isSelf} />
      )}

      {tab === 'claims' && (
        <>
          {latest && latest.pgpPublicKey && latest.verification?.verified && !latest.revoked && (
            <PgpKeyInfo armoredKey={latest.pgpPublicKey} show="key" />
          )}
        </>
      )}

      {tab === 'overview' && (<>
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
            <span className="summary-key">Ended</span>
          </div>
        </div>
        {latest && !latest.revoked && (
          <div className="mono-box" style={{ marginTop: 12 }}>
            <div className="label">current fingerprint</div>
            <div className="value">{spacedFingerprint(latest.fingerprint)}</div>
            {latest.verification && check && (
              <>
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span className={`status-badge ${latest.verification.verified ? 'verified' : 'unverified'}`} title={check.sentence}>
                    {check.label}
                  </span>
                </div>
                <ClaimCheckNote check={check} soon={soon} isSelf={isSelf} />
              </>
            )}
            {ensName && latest.verification?.verified && (
              <EnsRecordLine ensName={ensName} fingerprint={latest.fingerprint} />
            )}
          </div>
        )}
      </div>

      {/* Only a verified, active claim shows an identity: a stored key isn't the owner's until
          its signature binds it to this address. */}
      {latest && latest.pgpPublicKey && latest.verification?.verified && !latest.revoked ? (
        <PgpKeyInfo armoredKey={latest.pgpPublicKey} show="proofs" />
      ) : latest && latest.pgpPublicKey && latest.verification === null ? (
        <div className="detail-history">
          <div className="mono-box" style={{ marginBottom: 2 }}>
            <div className="label">Identity Proofs</div>
            <div className="value" style={{ color: 'var(--color-text-muted)' }}>Not checked: only the newest {CLAIM_LIMIT} claims are read.</div>
          </div>
        </div>
      ) : latest && latest.pgpPublicKey ? (
        <div className="detail-history">
          <div className="mono-box" style={{ marginBottom: 2 }}>
            <div className="label">Identity Proofs</div>
            <div className="value" style={{ color: 'var(--color-text-muted)' }}>
              {latest.revoked
                ? `${claimFateText(fates.get(latest.index) ?? { state: 'revoked', at: latest.revokedAt }) ?? 'This claim has been revoked.'} Key data not shown.`
                : "Key data not shown while this claim doesn't count."}
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

      </>)}

      {tab === 'claims' && attestations.length > 0 && (
        <div className="detail-history">
          <div className="detail-label">Claim History</div>
          <div className="attestation-table-wrap stack">
            <table className="attestation-table stack">
              <thead>
                <tr>
                  <th>#<span className="info-icon" title="The claim's position in this address's history: 0 is the first it ever published. Never reused; records and the CLI's --index refer to it.">?</span></th>
                  <th>Fingerprint</th>
                  <th>Date</th>
                  <th>Status <span className="info-icon" title="Active: the claim is live on-chain. Revoked: its owner revoked it. Replaced: its owner replaced it with a newer claim in one transaction.">?</span></th>
                  <th>PGP <span className="info-icon" title="Checked now, the way gpg does: the key signed the line naming this address, and the key and the subkey that signed are not revoked or expired. Revoked and replaced claims aren't checked.">?</span></th>
                </tr>
              </thead>
              <tbody>
                {/* Active first, then revoked; newest first within each. */}
                {[...attestations].sort((a, b) => (a.revoked === b.revoked ? b.index - a.index : a.revoked ? 1 : -1)).map(a => {
                  const fate = fates.get(a.index) ?? { state: a.revoked ? 'revoked' : 'active' }
                  const rowCheck = !a.revoked && a.verification ? claimCheckText(a.verification) : null
                  const rowSoon = !a.revoked ? expiresSoon(a.verification) : null
                  const note = rowCheck && (!a.verification.verified || rowSoon)
                  return (
                  <Fragment key={a.index}>
                  <tr style={a.revoked ? { opacity: 0.6 } : undefined}>
                    <td className="att-index">{a.index}</td>
                    <td>
                      <a href={`/pgp/${a.fingerprint.toUpperCase()}`} className="fingerprint-link">
                        {a.fingerprint.toUpperCase().slice(0, 8)}...{a.fingerprint.toUpperCase().slice(-8)}
                      </a>
                    </td>
                    <td className="att-date">{formatDate(a.createdAt)}</td>
                    <td>
                      <span className={`status-badge ${a.revoked ? 'revoked' : 'active'}`} title={claimFateText(fate) ?? undefined}>
                        {claimStateLabel(a)}
                      </span>
                    </td>
                    <td>
                      {a.revoked ? (
                        <span className="att-date">—</span>
                      ) : rowCheck ? (
                        <span className={`status-badge ${a.verification.verified ? 'verified' : 'unverified'}`} title={rowCheck.sentence}>
                          {a.verification.verified ? 'verified' : rowCheck.label}
                        </span>
                      ) : (
                        <span className="status-badge" style={{ opacity: 0.6 }} title={`Only the newest ${CLAIM_LIMIT} claims are read and checked`}>not checked</span>
                      )}
                    </td>
                  </tr>
                  {note && (
                    <tr className="att-note-row">
                      <td colSpan={5} style={{ padding: '0 16px 10px' }}>
                        <ClaimCheckNote check={rowCheck} soon={rowSoon} isSelf={isSelf} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab !== 'records' && attestations.length === 0 && (
        <div className="status info" style={{ marginTop: 2 }}>
          No claims for this address yet.
          <div style={{ marginTop: 8 }}>
            <a href="/attest" className="fingerprint-link">
              Add your key →
            </a>
          </div>
        </div>
      )}
    </div>
  )
}

function ClaimAddressCell({ address }) {
  const { data: ensName } = useEnsName({
    address,
    chainId: CHAIN.id,
    query: { enabled: !!address },
  })
  const ensAvatar = useSafeAvatar(ensName)
  return (
    <div className="claim-address-cell">
      <AvatarImg src={ensAvatar} className="ens-avatar-sm" />
      <div>
        <a href={`/eth/${address}`} className="address-link">
          {ensName || `${address.slice(0, 8)}...${address.slice(-6)}`}
        </a>
      </div>
    </div>
  )
}

// ─── Fingerprint Detail ─────────────────────────────────────────────────────

function FingerprintDetail({ fingerprint, tab = 'overview', onTab }) {
  const { address: wallet } = useAccount()
  // Every claim on this fingerprint: its owners, then each owner's claims for it, read and checked by the kit.
  const fp = normalizeFingerprint(fingerprint)
  const { data, isLoading, error } = useQuery({
    queryKey: ['fingerprint', NETWORK, fp],
    queryFn: async () => {
      const matching = []
      for (const { owner } of await findOwners(readClient, { fingerprint: fp }, { registry: REGISTRY_ADDRESS })) {
        for (const c of await readClaims(readClient, owner, { registry: REGISTRY_ADDRESS })) {
          if (sameFingerprint(c.fingerprint, fp)) matching.push({ ...c, address: owner })
        }
      }
      return matching
    },
    enabled: !!fp,
  })
  const claims = data ?? NO_CLAIMS

  // Only a verified, active claim drives the identity panel; there is no unverified fallback.
  const bestClaim = useMemo(() => claims.find(c => !c.revoked && c.verification?.verified) ?? null, [claims])

  if (isLoading) {
    return <div className="status info" style={{ marginTop: 24 }}>Reading the registry…</div>
  }

  if (error) return <ReadFailed error={error} />

  const activeClaims = claims.filter(c => !c.revoked)
  const revokedClaims = claims.filter(c => c.revoked)

  return (
    <div className="detail-page fade-in">
      <div className="detail-header">
        <div className="detail-label">PGP Fingerprint</div>
        <div className="detail-address-row">
          <span className="detail-address">{spacedFingerprint(fingerprint)}</span>
          <button className="copy-btn" onClick={(e) => copyToClipboard(fingerprint.toUpperCase(), e)}>copy</button>
        </div>
      </div>

      <IdentityTabs tab={tab} onTab={onTab} counts={{ claims: claims.length }} />

      {tab === 'records' && (
        <RecordsTab owner={bestClaim?.address ?? null} index={bestClaim ? bestClaim.index : null} armoredKey={bestClaim?.pgpPublicKey} fingerprint={bestClaim?.fingerprint ?? null} canEdit={!!wallet && !!bestClaim && wallet.toLowerCase() === bestClaim.address.toLowerCase()} />
      )}

      {tab === 'claims' && bestClaim?.pgpPublicKey && (
        <PgpKeyInfo armoredKey={bestClaim.pgpPublicKey} show="key" />
      )}

      {tab !== 'records' && (
      <div className="detail-summary">
        <div className="detail-label">Claims ({claims.length})</div>
        {claims.length > 0 && activeClaims.length === 0 && (
          <div className="status info" style={{ marginTop: 0, marginBottom: 12 }}>No active claim for this fingerprint.</div>
        )}
        {claims.length > 0 ? (
          <div className="attestation-table-wrap stack">
            <table className="attestation-table stack">
              <thead>
                <tr>
                  <th>Address</th>
                  <th>Date</th>
                  <th>Status <span className="info-icon" title="Active: the claim counts. Revoked: its owner ended it. Replaced: its owner replaced it with a new claim.">?</span></th>
                  <th>PGP <span className="info-icon" title="Checked now, the way gpg does: the key signed the line naming this address, and the key and the subkey that signed are not revoked or expired. Revoked claims aren't checked.">?</span></th>
                </tr>
              </thead>
              <tbody>
                {activeClaims.map(claim => {
                  const key = `${claim.address}-${claim.index}`
                  const v = claim.verification
                  return (
                    <tr key={key}>
                      <td><ClaimAddressCell address={claim.address} /></td>
                      <td className="att-date">{formatDate(claim.createdAt)}</td>
                      <td><span className="status-badge active">active</span></td>
                      <td>
                        {v ? (
                          <span className={`status-badge ${v.verified ? 'verified' : 'unverified'}`}
                            title={claimCheckText(v).sentence}>
                            {v.verified ? 'verified' : claimCheckText(v).label}
                          </span>
                        ) : (
                          <span className="status-badge" style={{ opacity: 0.6 }} title={`Only the newest ${CLAIM_LIMIT} claims are read and checked`}>not checked</span>
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
                      <td className="att-date">{formatDate(claim.createdAt)}</td>
                      <td><span className="status-badge revoked">{claimStateLabel(claim)}</span></td>
                      <td></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="status info" style={{ marginTop: 0 }}>
            Nobody has claimed this fingerprint.
            <div style={{ marginTop: 8 }}>
              <a href="/attest" className="fingerprint-link">
                Add your key →
              </a>
            </div>
          </div>
        )}
      </div>

      )}

      {tab !== 'overview' ? null : bestClaim?.pgpPublicKey ? (
        <PgpKeyInfo armoredKey={bestClaim.pgpPublicKey} show="proofs" />
      ) : claims.length > 0 && (
        <div className="detail-history">
          <div className="mono-box" style={{ marginBottom: 2 }}>
            <div className="label">Identity Proofs</div>
            <div className="value" style={{ color: 'var(--color-text-muted)' }}>
              No verified claim for this fingerprint, so key data isn't shown.
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
  const siteTheme = useSiteTheme()
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

    ;(async () => {
      try {
        if (!keyIdToBytes(submitted.value)) throw new Error("That isn't a key ID: 16 hex characters.")
        const found = await findOwners(readClient, { keyId: submitted.value }, { registry: REGISTRY_ADDRESS })
        if (cancelled) return
        if (found.length === 0) throw new Error('No claim uses this key ID.')
        const fullFingerprint = found[0].fingerprint.toUpperCase()
        setQuery(fullFingerprint)
        setSubmitted({ type: 'fingerprint', value: fullFingerprint })
        pushRoute('fingerprint', fullFingerprint)
        setKeyIdResolving(false)
      } catch (err) {
        if (cancelled) return
        // Our own sentences as they are; a failed chain read gets a plain one.
        setKeyIdError(/^(That isn't|No claim)/.test(err.message) ? err.message : "Couldn't read the registry. Try again, or change the RPC below.")
        setKeyIdResolving(false)
      }
    })()

    return () => { cancelled = true }
  }, [submitted?.type, submitted?.value])

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
  } = useTypedEnsAddress(normalizedEns)

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

  // The owner's claims, read and checked by the kit; newest first on the page.
  const { data: claimList, isLoading: claimsLoading, error: claimsError } = useQuery({
    queryKey: ['claims', NETWORK, lookupAddress],
    queryFn: () => readClaims(readClient, lookupAddress, { registry: REGISTRY_ADDRESS }),
    enabled: !!lookupAddress,
  })
  const attestations = useMemo(() => (claimList ?? []).slice().reverse(), [claimList])
  const count = claimList?.length ?? 0

  const isAddressLookup = submitted?.type === 'address' || submitted?.type === 'ens'
  const isLoading = (isAddressLookup && claimsLoading) || ensLoading

  // Tabs are routes: switching one pushes /…/claims or /…/records and keeps the lookup.
  const selectTab = (tab) => {
    if (!submitted) return
    pushRoute(submitted.type, submitted.value, tab)
    setSubmitted({ ...submitted, tab })
  }

  const displayEns = submitted?.type === 'ens' ? submitted.value
    : submitted?.type === 'address' ? reverseEns
    : null

  const ensAvatar = useSafeAvatar(displayEns)

  return (
    <>
      {!submitted && (
        <section className="home-hero">
          <h1 className="home-tagline">Look up an identity</h1>
        </section>
      )}
      <div className={submitted ? 'search-section' : 'search-section search-section-home'}>
        <div className="lookup-input-row">
          <input
            className="text-input"
            placeholder="ENS name, address, fingerprint, or key ID"
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
            Search
          </button>
        </div>

        {query.trim() && !inputType && (
          <div className="status info" style={{ marginTop: 12 }}>
            Enter an ENS name, an Ethereum address (0x + 40 hex), a PGP fingerprint (40 hex), or a key ID (16 hex).
          </div>
        )}

        {query.trim() && inputType && (
          <div className="lookup-detected" style={{ marginTop: 8 }}>
            Detected: <span className="lookup-type">{inputType === 'keyId' ? 'key ID' : inputType}</span>
          </div>
        )}
      </div>

      {!submitted && (
        <>
          <section className="home-rules">
            <div className="home-rule">
              <h3>Nothing in the middle</h3>
              <p>No Thurin Labs server holds your identity. It lives on Ethereum, a public record no company controls, and your browser checks it directly.</p>
            </div>
            <div className="home-rule">
              <h3>Your PGP key stays put</h3>
              <p>It is published on-chain where you put it, so no one can swap it or change it behind your back. gpg, git, and your mail client can fetch it from <a href="https://keys.thurin.id" target="_blank" rel="noopener noreferrer">keys.thurin.id</a>.</p>
            </div>
            <div className="home-rule">
              <h3>Your email stays private</h3>
              <p>Emails stay off your key and out of your signature unless you choose to include them. Nothing about you goes public that you didn't put there.</p>
            </div>
          </section>
          {/* An image our server draws: showing it asks no one but thurin.id. */}
          <section className="home-cards">
            <a href="/ens/thurinlabs.eth" className="home-card-image">
              <img src={`${cardHost()}/card/ens/thurinlabs.eth.png${siteTheme === 'light' ? '?theme=light' : ''}`} width="640" height="200" alt="thurinlabs.eth: its PGP key, and whether it's verified on Ethereum" />
            </a>
          </section>
          <p className="home-cards-link">
            <a href={`${links.docs}/#/sdk?id=readme-card`} target="_blank" rel="noopener noreferrer">Get your own card →</a>
          </p>
          <section className="home-close">
            <p><a href="/attest">Adding your key</a> takes a few minutes and one transaction.<br className="home-close-break" /> Or do all of it <a href={`${links.docs}/#/cli`} target="_blank" rel="noopener noreferrer">from a terminal, on your own node</a>.</p>
            <a className="home-roadmap" href={`${links.docs}/#/roadmap`} target="_blank" rel="noopener noreferrer">What’s coming: the roadmap →</a>
          </section>
        </>
      )}

      <div className="lookup-results">
        {/* Key ID resolving */}
        {keyIdResolving && (
          <div className="status info" style={{ marginTop: 24 }}>
            Looking up key ID {submitted?.value}…
          </div>
        )}
        {keyIdError && (
          <div className="status err" style={{ marginTop: 24 }}>
            {keyIdError}
          </div>
        )}

        {/* ENS resolving */}
        {submitted?.type === 'ens' && ensLoading && (
          <div className="status info" style={{ marginTop: 24 }}>
            Resolving {submitted.value}...
          </div>
        )}

        {/* ENS failed or resolved to nothing: "no address" only if the RPC actually answers */}
        {submitted?.type === 'ens' && !ensLoading && (ensError || !ensResolvedAddress) && (
          <EnsNotResolved key={submitted.value} name={submitted.value} error={ensError} />
        )}

        {/* The owner's claim list couldn't be read (AddressDetail needs it to render at all) */}
        {isAddressLookup && lookupAddress && claimsError && (
          <ReadFailed error={claimsError} />
        )}

        {/* Address/ENS detail page */}
        {isAddressLookup && lookupAddress && claimList && (
          <AddressDetail
            address={lookupAddress}
            ensName={displayEns}
            ensAvatar={ensAvatar}
            attestations={attestations}
            count={count}
            tab={submitted.tab || 'overview'}
            onTab={selectTab}
          />
        )}

        {/* Fingerprint detail page */}
        {submitted?.type === 'fingerprint' && (
          <FingerprintDetail fingerprint={submitted.value} tab={submitted.tab || 'overview'} onTab={selectTab} />
        )}

        {/* Loading (contract reads) */}
        {isLoading && submitted && !ensLoading && (
          <div className="status info" style={{ marginTop: 24 }}>
            Reading the registry…
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
    document.title = isAttest ? 'Thurin.id: add your key' : 'Thurin.id: PGP keys on Ethereum'
  }, [isAttest])

  return (
    <div className="app">
      <Topbar isAttest={isAttest} />

      {isAttest ? <Attest /> : <Explorer />}

      <footer className="footer">
        <div className="footer-left">
          <span className="footer-version">Thurin.id v{version}</span>
          <RpcSetting />
          <ProofSetting />
        </div>
        <div className="footer-columns">
          <div className="footer-col">
            <span className="footer-col-label">Home</span>
            <a href={links.company} target="_blank" rel="noopener noreferrer">Thurin Labs</a>
            <a href="/attest">Add key</a>
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
