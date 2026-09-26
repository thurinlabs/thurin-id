import { useEffect, useState } from 'react'
import { encryptionKeyFor, encryptRefusalText, keyChangedText, encryptTo, formatClaimDate } from '@thurinlabs/identity-kit'
import { spacedFingerprint } from '../format'

// Encrypt a message or a file to an identity, in this tab. The kit picks the key: only the claim
// that counts, with a valid encryption subkey. Nothing is uploaded or fetched; the sender delivers
// the result however they like. No private keys here, so no signing and no decrypting.

const MAX_FILE = 50 * 1024 * 1024 // a guess to measure, not a known limit

/** The kit's answer for these claims (in index order), or null while it works it out. */
export function useEncryptionKey(claims) {
  const [result, setResult] = useState(null)
  useEffect(() => {
    let live = true
    setResult(null)
    encryptionKeyFor(claims ?? []).then(r => { if (live) setResult(r) })
    return () => { live = false }
  }, [claims])
  return result
}

function copy(text, e) {
  navigator.clipboard.writeText(text)
  const btn = e?.target
  if (!btn) return
  const original = btn.textContent
  btn.textContent = 'copied'
  setTimeout(() => { btn.textContent = original }, 1200)
}

function download(data, filename, type) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([data], { type }))
  a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

/** 2.3 MB, 540 KB, 12 bytes. */
function fmtSize(n) {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} bytes`
}

const safeName = (name) => name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'recipient'

export default function EncryptTab({ enc, name, onClaims }) {
  const [text, setText] = useState('')
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [out, setOut] = useState(null) // { armored } | { bytes, filename }
  const [error, setError] = useState(null)

  if (!enc) return <div className="status info" style={{ marginTop: 16 }}>Checking the key…</div>

  if (!enc.ok) {
    return (
      <div className="detail-history">
        <div className="mono-box">
          <div className="label">Encrypt</div>
          <div className="value" style={{ color: 'var(--color-text-muted)' }}>
            {encryptRefusalText(enc)} {onClaims && <a href="#" className="encrypt-link" onClick={e => { e.preventDefault(); onClaims() }}>See claims ›</a>}
          </div>
        </div>
      </div>
    )
  }

  const warning = keyChangedText(enc)
  const fp = enc.claim.fingerprint.toUpperCase()

  async function run() {
    setError(null); setOut(null)
    if (file && file.size > MAX_FILE) { setError(`That file is ${(file.size / 1048576).toFixed(0)} MB; the page encrypts up to 50 MB. Use thurin encrypt for bigger files.`); return }
    setBusy(true)
    try {
      if (file) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        setOut({ bytes: await encryptTo(enc.key, bytes, { filename: file.name }), filename: `${file.name}.gpg` })
      } else {
        setOut({ armored: await encryptTo(enc.key, text) })
      }
    } catch (e) {
      setError(`Couldn't encrypt: ${e?.message || e}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="detail-history encrypt-box">
      <div className="mono-box">
        <div className="label">To</div>
        <div className="value encrypt-to keep-case">{name}</div>
        <div className="value encrypt-fp">{spacedFingerprint(fp)}</div>
        <div className="value encrypt-key">
          encryption subkey {enc.subkey.algorithm}
          {enc.subkey.expires ? ` · expires ${formatClaimDate(enc.subkey.expires)}` : ''}
        </div>
      </div>

      {warning && <div className="claim-check-note encrypt-warning"><p>{warning}</p></div>}

      {!out && (<>
        {file ? (
          <div className="encrypt-filecard">
            <span className="keep-case encrypt-filename">{file.name}</span>
            <span className="encrypt-filesize">{fmtSize(file.size)}</span>
            <button className="btn btn-small" onClick={() => setFile(null)}>Remove</button>
          </div>
        ) : (
          <textarea
            id="encrypt-text"
            name="encrypt-text"
            autoComplete="off"
            className="pgp-input encrypt-input"
            placeholder="Write a message…"
            value={text}
            onChange={e => setText(e.target.value)}
            spellCheck={false}
          />
        )}
        <div className="row encrypt-actions">
          {!file && (
            <label className="btn btn-small encrypt-file">
              <input id="encrypt-file" name="encrypt-file" type="file" onChange={e => { setFile(e.target.files?.[0] ?? null); e.target.value = '' }} />
              or choose a file
            </label>
          )}
          <button className="btn btn-primary" onClick={run} disabled={busy || (!file && !text.trim())}>
            {busy ? 'Encrypting…' : 'Encrypt'}
          </button>
        </div>
      </>)}

      {error && <div className="status err">{error}</div>}

      {out && (
        <div className="encrypt-result">
          {out.armored ? (<>
            <textarea id="encrypt-output" name="encrypt-output" className="pgp-input encrypt-output" readOnly value={out.armored} onFocus={e => e.target.select()} />
            <div className="row encrypt-actions">
              <button className="btn btn-small" onClick={e => copy(out.armored, e)}>Copy</button>
              <button className="btn btn-small" onClick={() => download(out.armored, `message-for-${safeName(name)}.asc`, 'application/pgp-encrypted')}>Download</button>
            </div>
          </>) : (
            <div className="row encrypt-actions">
              <button className="btn btn-primary" onClick={() => download(out.bytes, out.filename, 'application/octet-stream')}>Download</button>
            </div>
          )}
          <p className="helper prose">
            Send it any way you like: email, chat, a file. Only <span className="keep-case">{name}</span> can open it, with gpg or any PGP-ready mail app.
            It isn't signed, so say who you are in the message.
          </p>
          <button className="btn btn-small" onClick={() => { setOut(null); setText(''); setFile(null) }}>Encrypt another</button>
        </div>
      )}
    </div>
  )
}
