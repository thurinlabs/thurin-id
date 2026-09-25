// Hand-off from the Thurin CLI: `thurin attest --no-key` does the PGP half (sign,
// export, check) and prints /attest#handoff=<base64url JSON>. The page reads the
// fragment, fills the signature and key in, and lets the connected wallet publish.
// A fragment never reaches a server, so the payload goes from that terminal to this
// browser and nowhere else. Format mirrors thurin-cli/src/lib/handoff.ts (format 2):
// `key` is the raw key as 0x hex; `signature` is the raw signature as 0x hex, or a whole
// clearsigned message as text; `keepRecords` (reattest) and `reason` (revoke) are optional.
//
// With `authorization` (from `--authorize`) the owner has already signed the write as
// EIP-712 typed data, so *any* wallet can publish it through the registry's `…For`
// functions and pay the fee. The typed data is rebuilt from the other fields, never
// carried, so what the page shows is what was signed.

const OPS = ['attest', 'reattest', 'update-key', 'revoke', 'set-record', 'mark-compromised']
const REASONS = ['', 'compromised', 'retired', 'other']   // what an owner can give to revoke; "superseded" comes only from reattest
const HEX = /^0x([0-9a-f]{2})+$/i
const KEY_TAGS = ['98', '99', '9a', 'c6']          // public-key packet, old- or new-style header
const SIG_TAGS = ['88', '89', '8a', 'c2']          // signature packet
const isKeyHex = (v) => typeof v === 'string' && HEX.test(v) && KEY_TAGS.includes(v.slice(2, 4).toLowerCase())
const isSignature = (v) => typeof v === 'string' && ((HEX.test(v) && SIG_TAGS.includes(v.slice(2, 4).toLowerCase())) || v.startsWith('-----BEGIN PGP SIGNED MESSAGE-----'))

// The fragment is `<base64url JSON>[.<base64url key>[.<base64url signature>]]`: the key and signature
// ride as their own raw bytes (half the length of hex inside the JSON). A signature part starting
// with '-' is a clearsigned message (text); anything else is a raw signature packet.
function bytesFromBase64Url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - b64.length % 4) % 4))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}
function base64UrlFromBytes(bytes) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const toHex = (bytes) => '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
/** Bytes back to what a hand-off carries: text if they start with '-', else 0x hex. */
const payloadValue = (bytes) => (bytes[0] === 0x2d ? new TextDecoder().decode(bytes) : toHex(bytes))
/** 0x hex → its bytes; text → its UTF-8 bytes. */
function payloadBytes(v) {
  if (/^0x([0-9a-fA-F]{2})+$/.test(v)) return Uint8Array.from(v.slice(2).match(/../g), h => parseInt(h, 16))
  return new TextEncoder().encode(v)
}

// The link carries an unpublished address-to-key link and maybe a permission anyone can use until
// its deadline, so it doesn't stay in the address bar, history, or synced history: it moves to this
// tab's sessionStorage (so a reload still works) and is dropped once used (forgetHandoff).
const STASH = 'thurin-handoff'
export function forgetHandoff() { try { sessionStorage.removeItem(STASH) } catch { /* private mode */ } }

/** The hand-off in the current URL (or this tab's stash), or null. Throws only for a fragment that claims to be one and isn't. */
export function readHandoff() {
  let frag = window.location.hash.match(/^#handoff=([A-Za-z0-9_.-]+)$/)?.[1] ?? null
  if (frag) {
    try { sessionStorage.setItem(STASH, frag) } catch { /* private mode: a reload loses it */ }
    history.replaceState(null, '', window.location.pathname + window.location.search)
  } else {
    try { frag = sessionStorage.getItem(STASH) } catch { frag = null }
  }
  if (!frag) return null
  let h
  try {
    const [json, keyPart, sigPart] = frag.split('.')
    h = JSON.parse(new TextDecoder().decode(bytesFromBase64Url(json)))
    if (h && keyPart) h.key = payloadValue(bytesFromBase64Url(keyPart))
    if (h && sigPart) h.signature = payloadValue(bytesFromBase64Url(sigPart))
  } catch { throw new Error('This link is damaged. Copy the whole link again from the terminal.') }
  if (h?.v !== 2) throw new Error('This link is from an older version. Make a new one with an up-to-date CLI.')
  if (!OPS.includes(h.op)) throw new Error("This page doesn't know what this link asks for. Update the CLI, or open the link on the latest thurin.id.")
  if (!/^0x[0-9a-f]{40}$/.test(h.owner || '')) throw new Error('This link has no valid owner. Make a new one with the CLI.')
  if (!/^[0-9A-F]{40}$/.test(h.fingerprint || '')) throw new Error('This link names no valid key. Make a new one with the CLI.')
  const needsKey = h.op === 'attest' || h.op === 'reattest' || h.op === 'update-key', needsSig = h.op === 'attest' || h.op === 'reattest'
  if (h.op === 'set-record' && (typeof h.kind !== 'string' || typeof h.value !== 'string')) throw new Error('This link names no record. Make a new one with the CLI.')
  if (needsKey && !isKeyHex(h.key)) throw new Error('This link carries no key. Make a new one with the CLI.')
  if (needsSig && !isSignature(h.signature)) throw new Error('This link carries no signature. Make a new one with the CLI.')
  if (h.reason != null && !REASONS.includes(h.reason)) throw new Error(`Unknown revoke reason "${h.reason}".`)
  if (h.keepRecords != null && typeof h.keepRecords !== 'boolean') throw new Error('This link is damaged. Make a new one with the CLI.')
  if (h.op !== 'attest' && !Number.isInteger(h.index)) throw new Error('The hand-off names no claim index.')
  let authorization = null
  if (h.authorization != null) {
    const a = h.authorization
    if (!Number.isInteger(a.nonce) || a.nonce < 0) throw new Error("This link's permission is damaged. Make a new one with the CLI.")
    if (!Number.isInteger(a.deadline) || a.deadline <= 0) throw new Error("This link's permission is damaged. Make a new one with the CLI.")
    if (!/^0x[0-9a-f]{130}$/i.test(a.signature || '')) throw new Error("This link's permission is damaged. Make a new one with the CLI.")
    authorization = { nonce: a.nonce, deadline: a.deadline, signature: a.signature }
  }
  if ((h.op === 'revoke' || h.op === 'mark-compromised') && !authorization) throw new Error('A revoke link needs a signed permission. To revoke your own claim, use Your claims on this page.')
  return {
    op: h.op, network: String(h.network || 'mainnet'), owner: h.owner, fingerprint: h.fingerprint,
    key: h.key ?? null, signature: h.signature ?? null, index: h.index ?? null, includeEmail: !!h.includeEmail,
    kind: h.kind ?? null, value: h.value ?? null, keepRecords: h.keepRecords !== false, reason: h.reason ?? '',
    authorization,
  }
}

/** The fragment value for a hand-off, as the CLI would print it. */
export function encodeHandoff(h) {
  const { key, signature, ...rest } = h
  const parts = [base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(rest)))]
  if (key) parts.push(base64UrlFromBytes(payloadBytes(key)))
  if (signature) parts.push(base64UrlFromBytes(payloadBytes(signature)))
  return parts.join('.')
}
