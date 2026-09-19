// Hand-off from the Thurin CLI: `thurin attest --no-key` does the PGP half (sign,
// export, check) and prints /attest#handoff=<base64url JSON>. The page reads the
// fragment, fills the signature and key in, and lets the connected wallet publish.
// A fragment never reaches a server, so the payload goes from that terminal to this
// browser and nowhere else. Format mirrors thurin-cli/src/lib/handoff.ts (v1).

const OPS = ['attest', 'reattest', 'update-key']

function fromBase64Url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - b64.length % 4) % 4))
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** The hand-off in the current URL, or null. Throws only for a fragment that claims to be one and isn't. */
export function readHandoff() {
  const m = window.location.hash.match(/^#handoff=([A-Za-z0-9_-]+)$/)
  if (!m) return null
  let h
  try { h = JSON.parse(fromBase64Url(m[1])) } catch { throw new Error('This link is damaged: the hand-off could not be read.') }
  if (h?.v !== 1) throw new Error(`This link uses hand-off format ${h?.v ?? '?'}; this page reads format 1. Update the CLI or the page.`)
  if (!OPS.includes(h.op)) throw new Error(`Unknown hand-off operation "${h.op}".`)
  if (!/^0x[0-9a-f]{40}$/.test(h.owner || '')) throw new Error('The hand-off has no valid owner address.')
  if (!/^[0-9A-F]{40}$/.test(h.fingerprint || '')) throw new Error('The hand-off has no valid fingerprint.')
  if (typeof h.key !== 'string' || !h.key.includes('BEGIN PGP PUBLIC KEY BLOCK')) throw new Error('The hand-off carries no public key.')
  if (h.op !== 'update-key' && (typeof h.signature !== 'string' || !h.signature.includes('BEGIN PGP SIGNED MESSAGE'))) throw new Error('The hand-off carries no signed statement.')
  if (h.op !== 'attest' && !Number.isInteger(h.index)) throw new Error('The hand-off names no claim index.')
  return {
    op: h.op, network: String(h.network || 'mainnet'), owner: h.owner, fingerprint: h.fingerprint,
    key: h.key, signature: h.signature ?? null, index: h.index ?? null, includeEmail: !!h.includeEmail,
  }
}
