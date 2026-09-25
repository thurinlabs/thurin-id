/**
 * Thurin's own URLs for the host this copy is served from: the .id sites on thurin.id; on ENS
 * (id.thurinlabs.eth, or a gateway like .eth.limo) the same suffix, so a visitor who came in
 * without DNS is never handed back to it. Docs have no ENS name and stay on docs.thurin.id.
 */
export function siteLinks(hostname = window.location.hostname) {
  const h = hostname.toLowerCase()
  const gateway = h.match(/\.eth(\.[a-z0-9.-]+)$/)   // ".limo", ".link", ...
  const suffix = h.endsWith('.eth') ? '.eth' : gateway ? `.eth${gateway[1]}` : null
  if (suffix) {
    return {
      onEns: true,
      self: window.location.origin,
      company: `https://thurinlabs${suffix}`,
      privacy: `https://thurinlabs${suffix}/privacy/`,
      docs: 'https://docs.thurin.id',
    }
  }
  return {
    onEns: false,
    self: h === 'thurin.id' ? 'https://thurin.id' : window.location.origin,
    company: 'https://thurinlabs.id',
    privacy: 'https://thurinlabs.id/privacy/',
    docs: 'https://docs.thurin.id',
  }
}
