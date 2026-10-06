// A pretend Keycard Shell, for tests and for trying the QR flow without a device. It reads a
// request QR (ur:bytes) and answers the way the Shell does (keycard-shell PR #227): CREATE_IDENTITY
// makes a v4 secp256k1 key and returns its certificate; SIGN_MESSAGE returns a detached
// canonical-text signature. Answers come back as animated ur:bytes frames, fountain frames and all.
// Dev only: never bundled. Its throwaway key lives in node_modules/.cache (outside git).
//
//   node scripts/pretend-shell.mjs '<request QR text>' [--frames N]   → one frame per line
import { UR, UREncoder } from '@ngraveio/bc-ur'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { URDecoder } from '../src/qr/ur.js'

// openpgp.js's browser build, by path (its export map offers Node only the build that needs eckey-utils for secp256k1)
const openpgp = await import(new URL('../node_modules/openpgp/dist/openpgp.mjs', import.meta.url).href)

const KEY_FILE = join(dirname(fileURLToPath(import.meta.url)), '../node_modules/.cache/pretend-shell/key.asc')
const config = { rejectCurves: new Set() }   // secp256k1 is off by default in openpgp.js; the Shell uses it

/** The request map, read with the Shell's own rules (definite map, keys 1..n in order). */
function parseRequest(b) {
  let p = 0
  const head = () => {
    const major = b[p] >> 5, info = b[p++] & 31
    let n = info
    if (info === 24) n = b[p++]
    else if (info === 25) { n = b[p] << 8 | b[p + 1]; p += 2 }
    else if (info === 26) { n = (b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]) >>> 0; p += 4 }
    else if (info > 26) throw new Error('unsupported CBOR')
    return { major, n }
  }
  const map = head()
  if (map.major !== 5) throw new Error('not a map')
  const out = {}
  for (let i = 1; i <= map.n; i++) {
    const k = head(); if (k.major !== 0 || k.n !== i) throw new Error(`key ${i} out of order`)
    const v = head()
    if (v.major === 2) { out[i] = b.subarray(p, p + v.n); p += v.n } else if (v.major === 0) out[i] = v.n
    else throw new Error('unexpected value')
  }
  if (p !== b.length) throw new Error('trailing bytes')
  if (out[1] !== 1) throw new Error('version')
  return out
}

// The key this pretend device made, kept in memory (each test worker is its own device) and in
// the file (so the command-line tool can sign in a later run).
let current = null
async function loadKey() {
  return current ?? openpgp.readPrivateKey({ armoredKey: readFileSync(KEY_FILE, 'utf8') })
}

/** CREATE_IDENTITY → the certificate (public key, user ID, self-certification). */
export async function createIdentity(name, creationTime) {
  const { privateKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'secp256k1', userIDs: [{ name }], date: new Date(creationTime * 1000), subkeys: [], format: 'object', config,
  })
  current = privateKey
  mkdirSync(dirname(KEY_FILE), { recursive: true })
  writeFileSync(KEY_FILE, privateKey.armor(), { mode: 0o600 })
  return privateKey.toPublic().write()
}

/** SIGN_MESSAGE → one detached canonical-text signature packet. */
export async function signMessage(message, keyCreated, signatureTime) {
  if (!current && !existsSync(KEY_FILE)) throw new Error('no identity yet: answer a CREATE_IDENTITY first')
  const key = await loadKey()
  if (Math.floor(key.getCreationTime().getTime() / 1000) !== keyCreated) throw new Error("the key creation time doesn't match this device's key")
  const sig = await openpgp.sign({
    message: await openpgp.createMessage({ text: new TextDecoder().decode(message) }),
    signingKeys: key, detached: true, format: 'binary', date: new Date(signatureTime * 1000), config,
  })
  return sig
}

/** Answer one request QR; returns the raw answer bytes. */
export async function answer(requestText) {
  const d = new URDecoder()
  if (!(await d.receive(requestText))) throw new Error('a request is one QR')
  const r = parseRequest(d.result)
  if (r[2] === 1) return createIdentity(new TextDecoder().decode(r[3]), r[4])
  if (r[2] === 2) return signMessage(r[3], r[4], r[5])
  throw new Error(`unknown operation ${r[2]}`)
}

/** The answer as the Shell shows it: each piece once, then fountain frames. */
export function answerFrames(bytes, count, fragment = 80) {
  const enc = new UREncoder(UR.fromBuffer(Buffer.from(bytes)), fragment)
  if (enc.fragmentsLength === 1) return [UREncoder.encodeSinglePart(UR.fromBuffer(Buffer.from(bytes)))]
  return Array.from({ length: count ?? enc.fragmentsLength * 3 }, () => enc.nextPart())
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [request, flag, n] = process.argv.slice(2)
  if (!request) { console.error("usage: node scripts/pretend-shell.mjs '<request QR text>' [--frames N]"); process.exit(2) }
  const bytes = await answer(request)
  for (const f of answerFrames(bytes, flag === '--frames' ? Number(n) : undefined)) console.log(f.toUpperCase())
}
