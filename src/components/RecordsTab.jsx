import { useEffect, useState } from 'react'
import { useReadContracts } from 'wagmi'
import { IDENTITY_KINDS, recordKind, decodeRecord, parseRecord } from '@thurinlabs/identity-kit'
import { REGISTRY_ADDRESS, REGISTRY_ABI, CHAIN } from '../wagmiConfig'

// Records on the claim this page speaks for: the kinds Thurin knows, read in one multicall
// and rendered each its own way. The contract looks records up by kind and cannot list
// them, so this is a curated view and says so. Read-only: owners set records from the CLI.
// Reads use the app's own wagmi (the kit is a sibling link with a second wagmi copy);
// the kit supplies the kinds and the parsers.

const DOCS = 'https://docs.thurin.id/#/records'
const KIND_LABEL = {
  'thurin.railgun': 'Pay privately',
  'thurin.security': 'Security contact',
  'thurin.successor': 'Successor key',
  'thurin.affiliation': 'Affiliation',
  'thurin.canary': 'Canary',
  'thurin.private': 'Private',
  'thurin.disclosure': 'Disclosure',
}

function copy(text, e) {
  navigator.clipboard.writeText(text)
  const btn = e?.target
  if (!btn) return
  const original = btn.textContent
  btn.textContent = 'copied'
  setTimeout(() => { btn.textContent = original }, 1200)
}

function identityHref(who) {
  return /^0x[0-9a-fA-F]{40}$/.test(who) ? `/eth/${who}` : `/ens/${encodeURIComponent(who)}`
}

function Body({ r }) {
  const d = r.data
  if (!r.valid) {
    return (
      <>
        <pre className="value" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{r.text}</pre>
        <div className="value" style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>{r.reason}</div>
      </>
    )
  }
  switch (d.type) {
    case 'railgun':
      return (
        <>
          <div className="value" style={{ wordBreak: 'break-all' }}>{d.address} <button className="copy-btn" onClick={(e) => copy(d.address, e)}>copy</button></div>
          <div className="value" style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>A Railgun 0zk address. Payments to it are shielded; only the owner sees them.</div>
        </>
      )
    case 'security':
      return (
        <>
          <div className="value">{d.url ? <a href={d.url} target="_blank" rel="noopener noreferrer" className="fingerprint-link">{d.url}</a> : d.contact}</div>
          <div className="value" style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>Where to send sensitive reports. Encrypt to the key on this claim.</div>
        </>
      )
    case 'successor':
      return (
        <>
          <div className="value"><a href={`/pgp/${d.fingerprint.toUpperCase()}`} className="fingerprint-link">{d.fingerprint.toUpperCase()}</a></div>
          <div className="value" style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>The key that replaces this one.</div>
        </>
      )
    case 'affiliation':
      return (
        <>
          <div className="value"><a href={identityHref(d.with)} className="fingerprint-link">{d.with}</a>{d.role && <span style={{ color: 'var(--color-text-muted)' }}> · {d.role}</span>}</div>
          <div className="value" style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>Stated by this identity. Not yet acknowledged by the other side.</div>
        </>
      )
    case 'canary':
      return (
        <>
          <div className="value">
            {d.date}
            {d.clearsigned && d.verified === true && <span className="status-badge verified" style={{ marginLeft: 8 }} title="Clearsigned by the key on this claim; the signature verifies">verified</span>}
            {d.clearsigned && d.verified === false && <span className="status-badge unverified" style={{ marginLeft: 8 }} title={d.reason || 'The signature does not verify against the key on this claim'}>unverified</span>}
            {d.clearsigned && d.verified === null && <span className="status-badge neutral" style={{ marginLeft: 8 }} title="Clearsigned, not checked">signed</span>}
            {!d.clearsigned && <span className="status-badge neutral" style={{ marginLeft: 8 }} title="Plain text, not signed">unsigned</span>}
          </div>
          <pre className="value" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{d.statement}</pre>
        </>
      )
    case 'encrypted':
      return (
        <div className="value" style={{ color: 'var(--color-text-muted)' }}>
          Encrypted, {r.bytes} bytes{d.recipients !== null && `, for ${d.recipients} key${d.recipients === 1 ? '' : 's'}`}. Readable only by {r.kind === 'thurin.private' ? 'the owner' : 'the people it was encrypted to'}.
        </div>
      )
    default:
      return <pre className="value" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{r.text}</pre>
  }
}

export default function RecordsTab({ owner, index, armoredKey }) {
  const enabled = !!owner && index !== null && index !== undefined
  const { data: raw, isLoading } = useReadContracts({
    contracts: enabled ? IDENTITY_KINDS.map(kind => ({
      address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'record', args: [owner, BigInt(index), recordKind(kind)], chainId: CHAIN.id,
    })) : [],
    query: { enabled },
  })
  const [records, setRecords] = useState(null)

  useEffect(() => {
    if (!raw) return
    let live = true
    ;(async () => {
      const out = []
      for (let i = 0; i < IDENTITY_KINDS.length; i++) {
        const r = raw[i]
        const text = r?.status === 'success' ? decodeRecord(r.result) : ''
        if (text) out.push(await parseRecord(IDENTITY_KINDS[i], text, { armoredKey: armoredKey || undefined }))
      }
      if (live) setRecords(out)
    })()
    return () => { live = false }
  }, [raw, armoredKey])

  if (!enabled) {
    return (
      <div className="detail-history">
        <div className="mono-box">
          <div className="label">Records</div>
          <div className="value" style={{ color: 'var(--color-text-muted)' }}>Records live on a verified claim. This identity has none yet.</div>
        </div>
      </div>
    )
  }
  if (isLoading || records === null) {
    return <div className="status info" style={{ marginTop: 2 }}>Reading records…</div>
  }
  return (
    <div className="detail-history">
      {records.length === 0 ? (
        <div className="mono-box" style={{ marginBottom: 2 }}>
          <div className="label">Records</div>
          <div className="value" style={{ color: 'var(--color-text-muted)' }}>No records on this claim.</div>
          <div className="proof-docs-footer">
            <a href={DOCS} target="_blank" rel="noopener noreferrer">what records are</a>
          </div>
        </div>
      ) : records.map(r => (
        <div key={r.kind} className="mono-box" style={{ marginBottom: 2 }}>
          <div className="label">{KIND_LABEL[r.kind] || r.kind} <span style={{ color: 'var(--color-text-muted)', textTransform: 'none', letterSpacing: 0 }}>· {r.kind}</span></div>
          <Body r={r} />
        </div>
      ))}
      <div style={{ fontFamily: 'var(--mono)', color: 'var(--color-text-muted)', fontSize: 12, marginTop: 8 }}>
        Records Thurin knows about, on claim #{index}. Set from the CLI: thurin record set &lt;kind&gt; &lt;value&gt; · <a href={DOCS} target="_blank" rel="noopener noreferrer" className="fingerprint-link">the kinds</a>
      </div>
    </div>
  )
}
