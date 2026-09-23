import { useEffect, useState } from 'react'
import { useReadContracts, useWriteContract, usePublicClient } from 'wagmi'
import { IDENTITY_KINDS, recordKind, decodeRecord, parseRecord, encodeRecord } from '@thurinlabs/identity-kit'
import { REGISTRY_ADDRESS, REGISTRY_ABI, CHAIN, EXPLORER_URL } from '../wagmiConfig'

// Records on the claim this page speaks for: the kinds Thurin knows, read in one multicall
// and rendered each its own way. The contract looks records up by kind and cannot list
// them, so this is a curated view and says so. Visitors read; the claim's owner, connected,
// can set, edit, and clear the plain kinds from here (the encrypted kinds stay CLI-only until
// the browser can encrypt). Reads and writes use the app's own wagmi (the kit is a sibling
// link with a second wagmi copy); the kit supplies the kinds, parsers, and encoding.

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
// What the owner can write from the page. private/disclosure need encryption: CLI for now.
const EDITABLE = ['thurin.railgun', 'thurin.security', 'thurin.successor', 'thurin.affiliation', 'thurin.canary']
const HINT = {
  'thurin.railgun': 'Your Railgun 0zk address, so people can pay you privately by name.',
  'thurin.security': 'Where to send sensitive reports: an email, a URL, or a line of instructions. Senders encrypt to the key on this claim.',
  'thurin.successor': 'The fingerprint of the key that replaces this one.',
  'thurin.affiliation': 'JSON: {"v":1,"with":"thurinlabs.eth","role":"founder"}. One side’s statement until the other side sets a matching one.',
  'thurin.canary': 'A dated statement, e.g. "All keys under my control as of 2026-09-23." Paste it clearsigned by this key and the page shows it verified.',
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

// The owner's form: pick a kind, type a value, one transaction. Validation is the kit's
// parser, so what the page would refuse to render can't be published from here.
function RecordForm({ index, armoredKey, existing, initialKind, initialValue, onDone, onCancel }) {
  const [kind, setKind] = useState(initialKind || 'thurin.security')
  const [value, setValue] = useState(initialValue || '')
  const [check, setCheck] = useState(null)
  const [status, setStatus] = useState(null)
  const { writeContractAsync } = useWriteContract()
  const client = usePublicClient({ chainId: CHAIN.id })

  useEffect(() => {
    let live = true
    if (!value.trim()) { setCheck(null); return }
    parseRecord(kind, value, { armoredKey: armoredKey || undefined }).then(r => { if (live) setCheck(r) })
    return () => { live = false }
  }, [kind, value, armoredKey])

  const bytes = new TextEncoder().encode(value).length
  const tooBig = bytes > 1024
  const canSend = value.trim() && check?.valid && !tooBig && status?.type !== 'info'
  const replaces = existing.some(r => r.kind === kind)

  const send = async () => {
    try {
      const hex = encodeRecord(value)
      setStatus({ type: 'info', msg: 'Sending transaction…' })
      const hash = await writeContractAsync({ address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'setRecord', args: [BigInt(index), recordKind(kind), hex], chainId: CHAIN.id })
      setStatus({ type: 'info', msg: `Waiting for confirmation… tx ${hash.slice(0, 10)}…` })
      const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 4_000 })
      if (receipt.status === 'success') { setStatus({ type: 'ok', msg: '✓ Record set.', hash }); onDone() }
      else setStatus({ type: 'err', msg: `Transaction reverted. Tx: ${hash}` })
    } catch (err) {
      setStatus({ type: 'err', msg: err.shortMessage || err.message })
    }
  }

  return (
    <div className="mono-box record-form" style={{ marginTop: 8 }}>
      <div className="label">{replaces ? 'Replace' : 'Set'} a record on claim #{index}</div>
      <div className="record-form-row">
        <select value={kind} onChange={e => { setKind(e.target.value); setStatus(null) }} disabled={!!initialKind}>
          {EDITABLE.map(k => <option key={k} value={k}>{KIND_LABEL[k]} · {k}</option>)}
        </select>
      </div>
      <div className="value" style={{ color: 'var(--color-text-muted)', marginBottom: 6 }}>{HINT[kind]}</div>
      <textarea value={value} onChange={e => { setValue(e.target.value); setStatus(null) }} rows={kind === 'thurin.canary' ? 6 : 2} spellCheck={false} placeholder={kind === 'thurin.affiliation' ? '{"v":1,"with":"…"}' : ''} />
      <div className="value" style={{ color: tooBig ? 'var(--color-error)' : 'var(--color-text-muted)', marginTop: 4 }}>
        {bytes} / 1024 bytes
        {check && !check.valid && <span style={{ color: 'var(--color-error)' }}> · {check.reason}</span>}
        {check?.valid && check.data.type === 'canary' && check.data.clearsigned && <span> · signature {check.data.verified ? 'verifies against this claim’s key' : 'does not verify against this claim’s key'}</span>}
        {check?.valid && check.data.type === 'canary' && !check.data.clearsigned && <span> · plain text; clearsign it with this key to show it verified</span>}
      </div>
      <div className="row" style={{ marginTop: 8, gap: 8 }}>
        <button className="btn btn-primary" onClick={send} disabled={!canSend}>{status?.type === 'info' ? 'Publishing…' : replaces ? 'Replace record' : 'Set record'}</button>
        {onCancel && <button className="btn" onClick={onCancel} disabled={status?.type === 'info'}>Cancel</button>}
      </div>
      {status && (
        <div className={`status ${status.type}`} style={{ marginTop: 8 }}>
          {status.msg}{status.hash && EXPLORER_URL && <> · <a href={`${EXPLORER_URL}/tx/${status.hash}`} target="_blank" rel="noopener noreferrer">view transaction</a></>}
        </div>
      )}
    </div>
  )
}

function ClearButton({ index, kind, onDone }) {
  const [arm, setArm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const { writeContractAsync } = useWriteContract()
  const client = usePublicClient({ chainId: CHAIN.id })
  const clear = async () => {
    try {
      setBusy(true); setErr(null)
      const hash = await writeContractAsync({ address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'setRecord', args: [BigInt(index), recordKind(kind), '0x'], chainId: CHAIN.id })
      const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 4_000 })
      if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`)
      onDone()
    } catch (e) { setErr(e.shortMessage || e.message); setBusy(false); setArm(false) }
  }
  if (!arm) return <button className="copy-btn" onClick={() => setArm(true)}>clear</button>
  return (
    <>
      <button className="copy-btn" onClick={clear} disabled={busy}>{busy ? 'clearing…' : 'confirm clear'}</button>
      {!busy && <button className="copy-btn" onClick={() => setArm(false)}>keep</button>}
      {err && <span className="value" style={{ color: 'var(--color-error)', marginLeft: 8 }}>{err}</span>}
    </>
  )
}

export default function RecordsTab({ owner, index, armoredKey, canEdit = false }) {
  const enabled = !!owner && index !== null && index !== undefined
  const { data: raw, isLoading, refetch } = useReadContracts({
    contracts: enabled ? IDENTITY_KINDS.map(kind => ({
      address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'record', args: [owner, BigInt(index), recordKind(kind)], chainId: CHAIN.id,
    })) : [],
    query: { enabled },
  })
  const [records, setRecords] = useState(null)
  const [editing, setEditing] = useState(null)   // a kind being edited, 'new', or null

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

  const done = () => { setEditing(null); refetch() }

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
          <div className="value" style={{ color: 'var(--color-text-muted)' }}>{canEdit ? 'No records on your claim yet.' : 'No records on this claim.'}</div>
          <div className="proof-docs-footer">
            <a href={DOCS} target="_blank" rel="noopener noreferrer">what records are</a>
          </div>
        </div>
      ) : records.map(r => (
        <div key={r.kind} className="mono-box" style={{ marginBottom: 2 }}>
          <div className="label" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>{KIND_LABEL[r.kind] || r.kind} <span style={{ color: 'var(--color-text-muted)', textTransform: 'none', letterSpacing: 0 }}>· {r.kind}</span></span>
            {canEdit && EDITABLE.includes(r.kind) && editing !== r.kind && (
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button className="copy-btn" onClick={() => setEditing(r.kind)}>edit</button>
                <ClearButton index={index} kind={r.kind} onDone={done} />
              </span>
            )}
          </div>
          {editing === r.kind
            ? <RecordForm index={index} armoredKey={armoredKey} existing={records} initialKind={r.kind} initialValue={r.text} onDone={done} onCancel={() => setEditing(null)} />
            : <Body r={r} />}
        </div>
      ))}
      {canEdit && editing === null && (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn btn-small" onClick={() => setEditing('new')}>Set a record</button>
        </div>
      )}
      {canEdit && editing === 'new' && (
        <RecordForm index={index} armoredKey={armoredKey} existing={records} onDone={done} onCancel={() => setEditing(null)} />
      )}
      <div style={{ fontFamily: 'var(--mono)', color: 'var(--color-text-muted)', fontSize: 12, marginTop: 8 }}>
        Records Thurin knows about, on claim #{index}. {canEdit ? 'Private and disclosure records are set from the CLI, which can encrypt.' : 'Set from the CLI: thurin record set <kind> <value>'} · <a href={DOCS} target="_blank" rel="noopener noreferrer" className="fingerprint-link">the kinds</a>
      </div>
    </div>
  )
}
