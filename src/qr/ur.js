// Uniform Resources (BCR-2020-005) for `ur:bytes`, the transport the Keycard Shell speaks: one QR,
// or an animated series whose first round is the pieces in order and whose later frames are
// fountain mixes. Ported from the Shell's own C (app/ur, app/crypto/xoshiro256.c) so frames decode
// exactly as it encodes them; tests check it against the @ngraveio/bc-ur reference.
// No dependencies: SHA-256 comes from WebCrypto.

const WORDS = 'ableacidalsoapexaquaarchatomauntawayaxisbackbaldbarnbeltbetabiasbluebodybragbrewbulbbuzzcalmcashcatschefcityclawcodecolacookcostcruxcurlcuspcyandarkdatadaysdelidicedietdoordowndrawdropdrumdulldutyeacheasyechoedgeepicevenexamexiteyesfactfairfernfigsfilmfishfizzflapflewfluxfoxyfreefrogfuelfundgalagamegeargemsgiftgirlglowgoodgraygrimgurugushgyrohalfhanghardhawkheathelphighhillholyhopehornhutsicedideaidleinchinkyintoirisironitemjadejazzjoinjoltjowljudojugsjumpjunkjurykeepkenokeptkeyskickkilnkingkitekiwiknoblamblavalazyleaflegsliarlimplionlistlogoloudloveluaulucklungmainmanymathmazememomenumeowmildmintmissmonknailnavyneednewsnextnoonnotenumbobeyoboeomitonyxopenovalowlspaidpartpeckplaypluspoempoolposepuffpumapurrquadquizraceramprealredorichroadrockroofrubyruinrunsrustsafesagascarsetssilkskewslotsoapsolosongstubsurfswantacotasktaxitenttiedtimetinytoiltombtoystriptunatwinuglyundouniturgeuservastveryvetovialvibeviewvisavoidvowswallwandwarmwaspwavewaxywebswhatwhenwhizwolfworkyankyawnyellyogayurtzapszerozestzinczonezoom'
const MINIMAL = new Map()
for (let i = 0; i < 256; i++) MINIMAL.set(WORDS[i * 4] + WORDS[i * 4 + 3], i)

// Untrusted input: a QR is whatever the camera sees. The Shell's own limits, and then some.
const MAX_PARTS = 128
const MAX_MESSAGE_BYTES = 16384

// ─── CRC32, bytewords ─────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(bytes) {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const u32be = n => new Uint8Array([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])

function bytewordsEncode(bytes) {
  const all = new Uint8Array(bytes.length + 4)
  all.set(bytes); all.set(u32be(crc32(bytes)), bytes.length)
  return Array.from(all, b => WORDS[b * 4] + WORDS[b * 4 + 3]).join('')
}

function bytewordsDecode(text) {
  const s = text.toLowerCase()
  if (s.length % 2 || s.length < 10) throw new Error('not bytewords')
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) {
    const v = MINIMAL.get(s.slice(i * 2, i * 2 + 2))
    if (v === undefined) throw new Error('not bytewords')
    out[i] = v
  }
  const body = out.subarray(0, out.length - 4)
  const sum = out.subarray(out.length - 4)
  if (crc32(body) !== ((sum[0] << 24 | sum[1] << 16 | sum[2] << 8 | sum[3]) >>> 0)) throw new Error('checksum')
  return body
}

// ─── The bit of CBOR UR needs ────────────────────────────────────────────────

function cborHead(major, n) {
  if (n < 24) return [major << 5 | n]
  if (n < 0x100) return [major << 5 | 24, n]
  if (n < 0x10000) return [major << 5 | 25, n >> 8, n & 0xff]
  return [major << 5 | 26, n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

export const cbor = {
  uint: n => new Uint8Array(cborHead(0, n)),
  bytes: b => { const h = cborHead(2, b.length), o = new Uint8Array(h.length + b.length); o.set(h); o.set(b, h.length); return o },
  /** A definite map of small uint keys, in the order given (the Shell expects fixed order). */
  map: entries => concat([new Uint8Array(cborHead(5, entries.length)), ...entries.flatMap(([k, v]) => [cbor.uint(k), v])]),
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** Read one CBOR item of the kinds UR uses here: uint, byte string, array. */
function cborRead(b, pos = 0) {
  if (pos >= b.length) throw new Error('cbor: short')
  const major = b[pos] >> 5, info = b[pos] & 31
  let n, p = pos + 1
  if (info < 24) n = info
  else if (info === 24) n = b[p++]
  else if (info === 25) { n = b[p] << 8 | b[p + 1]; p += 2 }
  else if (info === 26) { n = (b[p] << 24 | b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]) >>> 0; p += 4 }
  else throw new Error('cbor: unsupported')
  if (p > b.length) throw new Error('cbor: short')
  if (major === 0) return { value: n, end: p }
  if (major === 2) {
    if (p + n > b.length) throw new Error('cbor: short')
    return { value: b.subarray(p, p + n), end: p + n }
  }
  if (major === 4) {
    if (n > 16) throw new Error('cbor: array too long')
    const items = []
    for (let i = 0; i < n; i++) { const r = cborRead(b, p); items.push(r.value); p = r.end }
    return { value: items, end: p }
  }
  throw new Error('cbor: unsupported')
}

/** The byte string a ur:bytes payload wraps. */
function unwrapBytes(payload) {
  const r = cborRead(payload)
  if (!(r.value instanceof Uint8Array) || r.end !== payload.length) throw new Error('not ur:bytes')
  return r.value
}

// ─── Encoding (requests are small: one QR) ───────────────────────────────────

/** `bytes` as a single-part ur:bytes, uppercase so the QR can use alphanumeric mode. */
export function encodeBytesUR(bytes) {
  return `UR:BYTES/${bytewordsEncode(cbor.bytes(bytes))}`.toUpperCase()
}

// ─── Fountain (matches the Shell's sampler.c and xoshiro256.c) ───────────────

const MASK64 = (1n << 64n) - 1n
const rotl = (x, k) => ((x << BigInt(k)) | (x >> BigInt(64 - k))) & MASK64

class Xoshiro {
  constructor(seed32) {
    this.s = [0, 1, 2, 3].map(i => seed32.slice(i * 8, i * 8 + 8).reduce((v, b) => (v << 8n) | BigInt(b), 0n))
  }
  next() {
    const s = this.s
    const result = (rotl((s[1] * 5n) & MASK64, 7) * 9n) & MASK64
    const t = (s[1] << 17n) & MASK64
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t; s[3] = rotl(s[3], 45)
    return result
  }
  nextDouble() { return Number(this.next()) / 2 ** 64 }   // (double)x / 2^64, as the Shell
  nextInt(low, high) { return Math.floor(this.nextDouble() * (high - low + 1)) + low }
}

/** Vose alias tables for degree weights 1, 1/2, …, 1/len, built in sampler.c's order. */
function samplerTables(len) {
  const probs = new Array(len).fill(0), aliases = new Array(len).fill(0)
  let sum = 0
  for (let i = 0; i < len; i++) sum += 1 / (i + 1)
  const P = Array.from({ length: len }, (_, i) => (1 / (i + 1)) * len / sum)
  const S = [], L = []
  for (let i = len - 1; i >= 0; i--) (P[i] < 1 ? S : L).push(i)
  while (S.length && L.length) {
    const a = S.pop(), g = L.pop()
    probs[a] = P[a]; aliases[a] = g
    P[g] += P[a] - 1
    ;(P[g] < 1 ? S : L).push(g)
  }
  while (L.length) probs[L.pop()] = 1
  while (S.length) probs[S.pop()] = 1
  return { probs, aliases }
}

/** Which pieces (0-based) a frame mixes. */
export async function partIndexes(seqNum, checksum, seqLen, tables = samplerTables(seqLen)) {
  if (seqNum <= seqLen) return [seqNum - 1]
  const seed = new Uint8Array(await crypto.subtle.digest('SHA-256', concat([u32be(seqNum), u32be(checksum)])))
  const rng = new Xoshiro(seed)
  const r1 = rng.nextDouble(), r2 = rng.nextDouble()
  const col = Math.floor(r1 * seqLen)
  let degree = (r2 < tables.probs[col] ? col : tables.aliases[col]) + 1
  const picked = new Set(), out = []
  for (let left = seqLen; degree--; left--) {
    let count = rng.nextInt(1, left), i = 0
    while (count) { if (!picked.has(i)) count--; i++ }
    picked.add(i - 1); out.push(i - 1)
  }
  return out
}

// ─── Decoding ────────────────────────────────────────────────────────────────

const xor = (a, b) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] ^ b[i]; return o }

/**
 * Feed it every QR the camera reads; it ignores repeats and junk and says when it has the whole
 * message. `received`/`total` drive the "3 of 7" progress.
 */
export class URDecoder {
  constructor() { this.reset() }

  reset() {
    this.key = null          // seqLen/messageLen/checksum of the message being assembled
    this.pieces = new Map()  // index → bytes, once known
    this.mixed = []          // { indexes: Set, data } still mixing several unknown pieces
    this.result = null
  }

  get total() { return this.key?.seqLen ?? 0 }
  get received() { return this.pieces.size }
  get done() { return this.result !== null }

  /** Returns true once complete. Throws only on input that can't be ur:bytes at all. */
  async receive(text) {
    if (this.done) return true
    const m = /^ur:bytes\/(?:(\d+)-(\d+)\/)?([a-z]+)$/i.exec(String(text).trim())
    if (!m) throw new Error('not a ur:bytes QR')
    const body = bytewordsDecode(m[3])
    if (!m[1]) {
      if (body.length > MAX_MESSAGE_BYTES + 8) throw new Error('too large')
      this.result = unwrapBytes(body)
      return true
    }
    const [seqNum, seqLen, messageLen, checksum, data] = cborRead(body).value
    if (![seqNum, seqLen, messageLen, checksum].every(Number.isInteger) || !(data instanceof Uint8Array)) throw new Error('bad part')
    if (seqNum < 1 || seqLen < 1 || seqLen > MAX_PARTS || messageLen < 1 || messageLen > MAX_MESSAGE_BYTES
      || data.length * seqLen < messageLen || data.length > MAX_MESSAGE_BYTES) throw new Error('bad part')
    if (Number(m[1]) !== seqNum || Number(m[2]) !== seqLen) throw new Error('bad part')

    const key = `${seqLen}/${messageLen}/${checksum}/${data.length}`
    if (this.key?.id !== key) {   // a different message started: drop the old one
      this.reset()
      this.key = { id: key, seqLen, messageLen, checksum, fragLen: data.length, tables: samplerTables(seqLen) }
    }
    const indexes = await partIndexes(seqNum, checksum, seqLen, this.key.tables)
    this.add(new Set(indexes), data)
    if (this.pieces.size === seqLen) {
      const all = concat([...Array(seqLen).keys()].map(i => this.pieces.get(i))).subarray(0, messageLen)
      if (crc32(all) !== checksum) { this.reset(); throw new Error('checksum') }
      this.result = unwrapBytes(all)
    }
    return this.done
  }

  /** Reduce a part by every known piece; a single piece left is known, and may unlock others. */
  add(indexes, data) {
    const queue = [{ indexes, data }]
    while (queue.length) {
      let { indexes: ix, data: d } = queue.shift()
      for (const i of [...ix]) if (this.pieces.has(i)) { d = xor(d, this.pieces.get(i)); ix.delete(i) }
      if (ix.size === 0) continue
      if (ix.size === 1) {
        const [i] = ix
        if (this.pieces.has(i)) continue
        this.pieces.set(i, d)
        // pieces just learned may reduce mixes held back
        const held = this.mixed; this.mixed = []
        queue.push(...held)
      } else {
        // Mixes reduce each other: a mix inside another one strips its pieces out of it.
        if (this.mixed.some(h => h.indexes.size === ix.size && [...ix].every(i => h.indexes.has(i)))) continue
        for (const h of this.mixed) {
          if (h.indexes.size < ix.size && [...h.indexes].every(i => ix.has(i))) {
            d = xor(d, h.data); for (const i of h.indexes) ix.delete(i)
          }
        }
        if (ix.size === 1) { queue.push({ indexes: ix, data: d }); continue }
        const held = []
        for (const h of this.mixed) {
          if (h.indexes.size > ix.size && [...ix].every(i => h.indexes.has(i))) {
            const rest = new Set([...h.indexes].filter(i => !ix.has(i)))
            queue.push({ indexes: rest, data: xor(h.data, d) })
          } else held.push(h)
        }
        this.mixed = held
        if (this.mixed.length < MAX_PARTS * 4) this.mixed.push({ indexes: ix, data: d })
      }
    }
  }
}
