// Sign on a QR signing device (the Keycard Shell is the one that speaks this today): the device
// holds the key; this page only shows a request QR and reads the answer with the camera. The answer
// becomes the same paste the gpg path makes, so every check after it is unchanged.
// Loaded only when someone picks "Sign by QR instead".
import { useEffect, useRef, useState } from 'react'
import qrcode from 'qrcode-generator'
import jsQR from 'jsqr'
import { parsePgpKey, statementText } from '@thurinlabs/identity-kit'
import { URDecoder } from '../qr/ur'
import { identityRequest, signRequest, nameProblem, readIdentityAnswer, readSignatureAnswer } from '../qr/keycard'
import { deviceKeyFromClaims } from '../qr/claimKey'
import Fingerprint from './Fingerprint'

const nowSeconds = () => Math.floor(Date.now() / 1000)

/** A QR as crisp SVG. UR text is uppercase so it packs as alphanumeric. */
function QrCode({ text, label }) {
  const qr = qrcode(0, 'L')
  qr.addData(text, /^[0-9A-Z $%*+\-./:]+$/.test(text) ? 'Alphanumeric' : 'Byte')
  qr.make()
  const n = qr.getModuleCount(), cells = []
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) cells.push(`M${c + 4},${r + 4}h1v1h-1z`)
  return (
    <svg className="qr" viewBox={`0 0 ${n + 8} ${n + 8}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width="100%" height="100%" fill="#fff" />
      <path d={cells.join('')} fill="#000" />
    </svg>
  )
}

/**
 * The camera, only while scanning: on when this mounts (after a click), every track stopped when it
 * unmounts. Frames are read here in the tab and never leave it.
 */
function Scanner({ onText, label }) {
  const video = useRef(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let stream = null, raf = 0, stopped = false
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const tick = () => {
      if (stopped) return
      const v = video.current
      if (v && v.readyState >= 2 && v.videoWidth) {
        const scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight))   // enough for a QR, cheap to read
        canvas.width = Math.round(v.videoWidth * scale); canvas.height = Math.round(v.videoHeight * scale)
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
        const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })
        if (code?.data) onText(code.data)
      }
      raf = requestAnimationFrame(tick)
    }
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(s => {
        if (stopped) { s.getTracks().forEach(t => t.stop()); return }
        stream = s
        video.current.srcObject = s
        video.current.play().catch(() => {})
        raf = requestAnimationFrame(tick)
      })
      .catch(() => setError("The camera didn't start. Allow it for this page (this time is enough), or use a photo of the QR."))
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach(t => t.stop())
      if (video.current) video.current.srcObject = null
    }
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps -- onText reads refs; restarting the camera per render would flicker
  return (
    <div className="qr-scanner">
      {error ? <div className="status err">{error}</div> : <video ref={video} muted playsInline aria-label={label} />}
    </div>
  )
}

/** One QR from a photo or screenshot: enough for a single-frame answer. */
async function readPhoto(file) {
  const img = await createImageBitmap(file)
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data ?? null
}

/**
 * Reads the device's answer: the camera (animated QRs, "3 of 7"), or a photo. `read` gets the raw
 * answer bytes and returns what the step keeps, or throws with what to tell the person.
 */
function ScanAnswer({ read, onDone, what }) {
  const decoder = useRef(new URDecoder())
  const busy = useRef(false)
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)

  const take = async text => {
    if (busy.current) return
    busy.current = true
    try {
      const done = await decoder.current.receive(text)
      setProgress({ received: decoder.current.received, total: decoder.current.total })
      if (done) {
        const bytes = decoder.current.result
        decoder.current = new URDecoder()
        setScanning(false)   // unmounts the scanner: the camera stops
        try { onDone(read(bytes)); setError(null) } catch (e) { setError(e.message) }
      }
    } catch {
      // not one of the device's QRs (a phone screen, a sticker): keep looking
    } finally {
      busy.current = false
    }
  }

  return (
    <div>
      {!scanning ? (
        <div className="row" style={{ alignItems: 'center' }}>
          <button type="button" className="btn btn-sm" onClick={() => { setError(null); setProgress(null); setScanning(true) }}>Scan the answer</button>
          <label className="link-btn">
            or a photo of it
            <input type="file" accept="image/*" hidden onChange={async e => {
              const f = e.target.files?.[0]; e.target.value = ''
              if (!f) return
              const text = await readPhoto(f).catch(() => null)
              if (!text) { setError("No QR found in that picture."); return }
              decoder.current = new URDecoder()
              await take(text)
              if (!decoder.current.done && decoder.current.received) setError(`That picture holds one part of ${decoder.current.total}; this answer moves, so scan it with the camera.`)
            }} />
          </label>
        </div>
      ) : (
        <>
          <Scanner onText={take} label={`Camera, reading the device's ${what}`} />
          <div className="row" style={{ alignItems: 'center' }}>
            <span className="helper">{progress?.total > 1 ? `${progress.received} of ${progress.total}` : 'Hold the device steady in view.'} The picture stays in this tab.</span>
            <button type="button" className="link-btn" onClick={() => setScanning(false)}>stop</button>
          </div>
        </>
      )}
      {error && <div className="status err">{error}</div>}
    </div>
  )
}

async function armorOf(type, bytes) {
  const { armor, enums } = await import('openpgp')
  return armor(type === 'signature' ? enums.armor.signature : enums.armor.publicKey, bytes)
}

/**
 * The whole device flow. Ends by handing back the same text a gpg paste would be: the signature
 * block and the key block.
 */
export default function QrSign({ address, claims = [], onResult, onBack }) {
  const [key, setKey] = useState(null)        // { bytes, info, created }
  const [keyText, setKeyText] = useState('')
  const [keyError, setKeyError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [createdAt] = useState(nowSeconds)    // fixed for one request: the device bakes it into the key
  const [signedAt, setSignedAt] = useState(nowSeconds)
  const [got, setGot] = useState(false)
  // The key already claimed from this address, when it's one a device can sign for: one click.
  const [claimKey, setClaimKey] = useState(null)
  useEffect(() => {
    let live = true
    deviceKeyFromClaims(claims).then(k => { if (live) setClaimKey(k) })
    return () => { live = false }
  }, [claims])

  const chooseKey = async (bytesOrText) => {
    setKeyError(null)
    const info = await parsePgpKey(bytesOrText).catch(() => null)
    if (!info?.created) { setKeyError("That isn't a public key this page can read."); return }
    setKey({ bytes: bytesOrText, info, created: Math.floor(Date.parse(info.created) / 1000) })
    setSignedAt(nowSeconds())
  }

  const downloadKey = async () => {
    const text = typeof key.bytes === 'string' ? key.bytes : await armorOf('publicKey', key.bytes)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/pgp-keys' }))
    a.download = `${key.info.fingerprint.toUpperCase()}.asc`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const statement = statementText(address)
  const problem = name ? nameProblem(name) : null

  return (
    <div className="fade-in qr-sign">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <p className="helper" style={{ margin: 0 }}>Sign on your device: it holds the key, this page only shows and reads QR codes.</p>
        <button type="button" className="link-btn" onClick={onBack}>← back to gpg</button>
      </div>

      {!key && !creating && (
        <div className="fade-in" style={{ marginTop: 12 }}>
          <div className="label">1 · your device's public key</div>
          {claimKey && (
            <div className="row" style={{ alignItems: 'center', marginBottom: 10 }}>
              <button type="button" className="btn btn-sm" onClick={() => { setKey(claimKey); setSignedAt(nowSeconds()) }}>Use the key from your claim</button>
              <span className="helper" style={{ margin: 0 }}><Fingerprint value={claimKey.info.fingerprint} /></span>
            </div>
          )}
          <textarea
            name="device-key"
            className="pgp-input"
            style={{ minHeight: 90 }}
            placeholder={'-----BEGIN PGP PUBLIC KEY BLOCK-----\n…'}
            value={keyText}
            onChange={e => setKeyText(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <div className="row" style={{ alignItems: 'center' }}>
            <button type="button" className="btn btn-sm" disabled={!keyText.trim()} onClick={() => chooseKey(keyText.trim())}>Use this key</button>
            <label className="link-btn">
              or open the key file
              <input type="file" accept=".asc,.pgp,.gpg,application/pgp-keys" hidden onChange={async e => {
                const f = e.target.files?.[0]; e.target.value = ''
                if (!f) return
                const b = new Uint8Array(await f.arrayBuffer())
                chooseKey(b[0] === 0x2d ? new TextDecoder().decode(b) : b)
              }} />
            </label>
            <button type="button" className="link-btn" onClick={() => setCreating(true)}>No key on the device yet? Create one</button>
          </div>
          {keyError && <div className="status err">{keyError}</div>}
        </div>
      )}

      {!key && creating && (
        <div className="fade-in" style={{ marginTop: 12 }}>
          <div className="label">1 · create a key on your device</div>
          <input
            name="device-key-name"
            className="key-choice"
            placeholder="A name for the key (no email needed)"
            value={name}
            onChange={e => setName(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            maxLength={255}
          />
          {problem && <div className="status err">{problem}</div>}
          {name && !problem && (
            <div className="fade-in qr-pair">
              <QrCode text={identityRequest(name, createdAt)} label="Request for the device: create a key" />
              <div>
                <p className="helper">Scan this with your device. Check the name it shows, approve, and enter its PIN. Then scan its answer.</p>
                <ScanAnswer what="new key" read={b => readIdentityAnswer(b)} onDone={chooseKey} />
              </div>
            </div>
          )}
          <button type="button" className="link-btn" onClick={() => setCreating(false)} style={{ marginTop: 8 }}>I already have a key</button>
        </div>
      )}

      {key && (
        <div className="fade-in" style={{ marginTop: 12 }}>
          <div className="mono-box">
            <div className="label">device key</div>
            <div className="value"><Fingerprint value={key.info.fingerprint} /></div>
          </div>
          <div className="row" style={{ alignItems: 'center' }}>
            <button type="button" className="link-btn" onClick={downloadKey}>Download your public key</button>
            <button type="button" className="link-btn" onClick={() => { setKey(null); setGot(false) }}>use another key</button>
          </div>
          {/* The device can't show a key again; before a claim, only this file (or creating the
              same name at the same time) brings it back. After a claim it's on-chain anyway. */}
          <p className="helper" style={{ marginTop: 4 }}>
            Created {new Date(key.created * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC. Keep the file: the device can't show this key again.
          </p>

          <div className="label" style={{ marginTop: 16 }}>2 · sign</div>
          <div className="qr-pair">
            <QrCode text={signRequest(statement, key.created, Math.max(signedAt, key.created))} label="Request for the device: sign the line below" />
            <div>
              <p className="helper">Scan this with your device. It should show this line, the key above, and today's date. Approve, then scan its answer.</p>
              <div className="command-block wrap">{statement}</div>
              {got
                ? <div className="status ok">Got the device's signature.</div>
                : <ScanAnswer what="signature" read={b => readSignatureAnswer(b)} onDone={async sig => {
                    onResult(`${await armorOf('signature', sig)}\n${typeof key.bytes === 'string' ? key.bytes : await armorOf('publicKey', key.bytes)}`)
                    setGot(true)
                  }} />}
            </div>
          </div>
          <p className="helper" style={{ fontSize: '0.85em' }}>Works with Keycard Shell.</p>
        </div>
      )}
    </div>
  )
}
