import { useEffect, useState } from 'react'
import { useReadContract, useWriteContract, usePublicClient } from 'wagmi'
import { contractErrorText, pageRecords, parseRecord, checkRecordValue } from '@thurinlabs/identity-kit'
import { REGISTRY_ADDRESS, REGISTRY_ABI, CHAIN, EXPLORER_URL } from '../wagmiConfig'
import { KIND_LABEL } from '../recordLabels'

// Records on the claim this page speaks for, from `recordsOf`: Thurin's kinds first, each rendered
// its own way, then anyone else's (reverse-dot names) as plain text, in the order they were set.
// Visitors read; the claim's owner, connected, can set, edit, and clear the plain Thurin kinds and
// clear any other (the encrypted kinds stay CLI-only until the browser can encrypt; the release
// list is kept by `thurin record add-release`, which hashes the checksum file). The kit supplies
// the kinds, order, and parsers.

const DOCS = 'https://docs.thurin.id/#/records'
// What the owner can write from the page. private and disclosure stay read-only here: they're
// encrypted, and on-chain history is forever.
const EDITABLE = ['thurin.railgun', 'thurin.security', 'thurin.successor', 'thurin.affiliation', 'thurin.canary']
const HINT = {
  'thurin.railgun': 'Your Railgun 0zk address, so people can pay you privately by name.',
  'thurin.security': 'Where to send sensitive reports: an email, a URL, or a line of instructions. Senders encrypt to the key on this claim.',
  'thurin.successor': 'The fingerprint of the key that replaces this one.',
  'thurin.affiliation': 'JSON: {"v":1,"with":"thurinlabs.eth","role":"founder"}. One side’s statement until the other side sets a matching one.',
  'thurin.canary': () => `A dated statement, e.g. "All keys under my control as of ${today()}." Paste it clearsigned by this key and the page shows it verified.`,
}
const hintFor = (kind) => (typeof HINT[kind] === 'function' ? HINT[kind]() : HINT[kind])

/** Today as YYYY-MM-DD in the visitor's own time zone. */
function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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
        <pre className="value prose" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{r.text}</pre>
        <div className="value prose" style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>{r.reason}</div>
      </>
    )
  }
  switch (d.type) {
    case 'railgun':
      return (
        <>
          <div className="value" style={{ wordBreak: 'break-all' }}>{d.address} <button className="copy-btn" onClick={(e) => copy(d.address, e)}>copy</button></div>
          <div className="value prose" style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>A Railgun 0zk address. Payments to it are shielded; only the owner sees them.</div>
        </>
      )
    case 'security':
      return (
        <>
          <div className="value">{d.url ? <a href={d.url} target="_blank" rel="noopener noreferrer" className="fingerprint-link">{d.url}</a> : d.contact}</div>
          <div className="value prose" style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>Where to send sensitive reports. Encrypt to the key on this claim.</div>
        </>
      )
    case 'successor':
      return (
        <>
          <div className="value"><a href={`/pgp/${d.fingerprint.toUpperCase()}`} className="fingerprint-link">{d.fingerprint.toUpperCase()}</a></div>
          <div className="value prose" style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>The key that replaces this one.</div>
        </>
      )
    case 'affiliation':
      return (
        <>
          <div className="value"><a href={identityHref(d.with)} className="fingerprint-link">{d.with}</a>{d.role && <span style={{ color: 'var(--color-text-muted)' }}> · {d.role}</span>}</div>
          <div className="value prose" style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>Stated by this identity. The other side's own record would confirm it.</div>
        </>
      )
    case 'canary':
      return (
        <>
          <div className="value">
            {d.date}
            {d.clearsigned && d.verified === true && <span className="status-badge verified" style={{ marginLeft: 8 }} title="Clearsigned by the key on this claim; the signature verifies">verified</span>}
            {d.clearsigned && d.verified === false && (/not signed by this key/i.test(d.reason || '')
              ? <span className="status-badge unverified" style={{ marginLeft: 8 }} title="Signed by a different key than the one on this claim (e.g. before a key change). Sign a new canary with this key.">different key</span>
              : <span className="status-badge unverified" style={{ marginLeft: 8 }} title={d.reason || 'The signature does not verify against the key on this claim'}>unverified</span>)}
            {d.clearsigned && d.verified === null && <span className="status-badge neutral" style={{ marginLeft: 8 }} title="Clearsigned, not checked">signed</span>}
            {!d.clearsigned && <span className="status-badge neutral" style={{ marginLeft: 8 }} title="Plain text, not signed">unsigned</span>}
          </div>
          <pre className="value prose" style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{d.statement}</pre>
        </>
      )
    case 'releases':
      return (
        <>
          {d.releases.map(rel => (
            <div key={rel.name} className="value" style={{ marginBottom: 4 }}>
              {rel.url ? <a href={rel.url} target="_blank" rel="noopener noreferrer" className="fingerprint-link">{rel.name}</a> : rel.name}
              <span style={{ color: 'var(--color-text-muted)' }}> · {rel.date} · sha256 </span>
              <span title={rel.sha256}>{rel.sha256.slice(0, 12)}…</span>
              <button className="copy-btn" style={{ marginLeft: 6 }} onClick={(e) => copy(rel.sha256, e)}>copy</button>
            </div>
          ))}
          <div className="value prose" style={{ color: 'var(--color-text-muted)', marginTop: 4 }}>
            Releases this identity put out, each named by the sha256 of its checksum file. <a href="https://docs.thurin.id/#/guides/verify-release" target="_blank" rel="noopener noreferrer" className="fingerprint-link">How to check a download</a>.
          </div>
        </>
      )
    case 'encrypted':
      return (
        <div className="value prose" style={{ color: 'var(--color-text-muted)' }}>
          Encrypted, {r.bytes} bytes{d.recipients !== null && `, for ${d.recipients} key${d.recipients === 1 ? '' : 's'}`}. Readable only by {r.kind === 'thurin.private' ? 'the owner' : 'the people it was encrypted to'}.
        </div>
      )
    default:
      return <pre className="value prose" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{r.text}</pre>
  }
}

// The canary's signing step: one command with today's date and this claim's key, like the attest page.
function CanaryCommand({ fingerprint }) {
  const command = `printf '%s\\n' 'All keys under my control as of ${today()}.' | gpg --clearsign -u ${fingerprint.toUpperCase()}`
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="value prose" style={{ color: 'var(--color-text-muted)', marginBottom: 6 }}>
        A dated statement, clearsigned by the key on this claim so anyone can check it. Run this (change the words if you like, keep a date), then paste all of its output below:
      </div>
      <div className="command-block wrap"><span className="prompt">$ </span>{command}</div>
      <button className="btn btn-sm" style={{ marginTop: 6 }} onClick={(e) => copy(command, e)}>copy command</button>
    </div>
  )
}

// The owner's form: pick a kind, type a value, one transaction. Validation is the kit's
// parser, so what the page would refuse to render can't be published from here.
function RecordForm({ index, armoredKey, fingerprint, existing, initialKind, initialValue, onDone, onCancel }) {
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
      checkRecordValue(value)
      setStatus({ type: 'info', msg: 'Sending transaction…' })
      const hash = await writeContractAsync({ address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'setRecord', args: [BigInt(index), kind, value], chainId: CHAIN.id })
      setStatus({ type: 'info', msg: `Waiting for confirmation… tx ${hash.slice(0, 10)}…` })
      const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 4_000 })
      if (receipt.status === 'success') { setStatus({ type: 'ok', msg: '✓ Record set.', hash }); onDone() }
      else setStatus({ type: 'err', msg: `The transaction failed, so nothing changed. Tx: ${hash}` })
    } catch (err) {
      setStatus({ type: 'err', msg: contractErrorText(err) ?? err.shortMessage ?? err.message })
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
      {kind === 'thurin.canary' && fingerprint ? (
        <CanaryCommand fingerprint={fingerprint} />
      ) : (
        <div className="value prose" style={{ color: 'var(--color-text-muted)', marginBottom: 6 }}>{hintFor(kind)}</div>
      )}
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
      const hash = await writeContractAsync({ address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'setRecord', args: [BigInt(index), kind, ''], chainId: CHAIN.id })
      const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 4_000 })
      if (receipt.status !== 'success') throw new Error(`The transaction failed, so nothing changed. Tx: ${hash}`)
      onDone()
    } catch (e) { setErr(contractErrorText(e) ?? e.shortMessage ?? e.message); setBusy(false); setArm(false) }
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

export default function RecordsTab({ owner, index, armoredKey, fingerprint = null, canEdit = false }) {
  const enabled = !!owner && index !== null && index !== undefined
  const { data: raw, isLoading, refetch } = useReadContract({
    address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'recordsOf',
    args: enabled ? [owner, BigInt(index)] : undefined, chainId: CHAIN.id,
    query: { enabled },
  })
  const [records, setRecords] = useState(null)
  const [editing, setEditing] = useState(null)   // a kind being edited, 'new', or null

  useEffect(() => {
    if (!raw) return
    let live = true
    ;(async () => {
      const out = []
      for (const r of pageRecords(raw[0], raw[1])) out.push(await parseRecord(r.kind, r.text, { armoredKey: armoredKey || undefined }))
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
          <div className="value prose" style={{ color: 'var(--color-text-muted)' }}>Records sit on a verified claim, and this identity has none yet.</div>
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
          <div className="value prose" style={{ color: 'var(--color-text-muted)' }}>{canEdit ? 'No records on your claim yet.' : 'No records on this claim.'}</div>
          <div className="proof-docs-footer">
            <a href={DOCS} target="_blank" rel="noopener noreferrer">about records</a>
          </div>
        </div>
      ) : records.map(r => (
        <div key={r.kind} className="mono-box" style={{ marginBottom: 2 }}>
          <div className="label" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {KIND_LABEL[r.kind]
              ? <span>{KIND_LABEL[r.kind]} <span style={{ color: 'var(--color-text-muted)', textTransform: 'none', letterSpacing: 0 }}>· {r.kind}</span></span>
              : <span style={{ textTransform: 'none', letterSpacing: 0 }}>{r.kind}</span>}
            {canEdit && editing !== r.kind && (EDITABLE.includes(r.kind) || !r.kind.startsWith('thurin.')) && (
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                {EDITABLE.includes(r.kind) && <button className="copy-btn" onClick={() => setEditing(r.kind)}>edit</button>}
                <ClearButton index={index} kind={r.kind} onDone={done} />
              </span>
            )}
          </div>
          {editing === r.kind
            ? <RecordForm index={index} armoredKey={armoredKey} fingerprint={fingerprint} existing={records} initialKind={r.kind} initialValue={r.text} onDone={done} onCancel={() => setEditing(null)} />
            : <Body r={r} />}
        </div>
      ))}
      {canEdit && editing === null && (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn btn-small" onClick={() => setEditing('new')}>Set a record</button>
        </div>
      )}
      {canEdit && editing === 'new' && (
        <RecordForm index={index} armoredKey={armoredKey} fingerprint={fingerprint} existing={records} onDone={done} onCancel={() => setEditing(null)} />
      )}
      <div style={{ fontFamily: 'var(--mono)', color: 'var(--color-text-muted)', fontSize: 12, marginTop: 8 }}>
        Records on claim #{index}.{canEdit ? ' You can also set them with the CLI.' : ''} · <a href={DOCS} target="_blank" rel="noopener noreferrer" className="fingerprint-link">about records</a>
      </div>
    </div>
  )
}
