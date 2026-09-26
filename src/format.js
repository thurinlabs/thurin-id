// One way to show a fingerprint and a date, everywhere on the site.

/** A full fingerprint in groups of four, uppercase, as gpg prints it. */
export function spacedFingerprint(fpr) {
  return (fpr || '').replace(/\s+/g, '').toUpperCase().match(/.{1,4}/g)?.join(' ') ?? ''
}

const DATE = { month: 'short', day: 'numeric', year: 'numeric' }

/** Unix seconds → "Sep 25, 2026". */
export function formatDate(seconds) {
  if (!seconds) return '—'
  return new Date(seconds * 1000).toLocaleDateString('en-US', DATE)
}

/** An ISO date → "Sep 25, 2026". */
export function formatIsoDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', DATE)
}

/** A claim's state for a badge: "active", "revoked · compromised", "replaced → #2". */
export function claimStateLabel(c) {
  if (!c.revoked && c.state !== 'revoked' && c.state !== 'replaced') return 'active'
  const why = c.revokeReason === 'compromised' || (c.state === 'revoked' && c.revokeReason) ? ` · ${c.revokeReason}` : ''
  return c.state === 'replaced' ? `replaced → #${c.replacedBy}${why}` : `revoked${why}`
}
