/**
 * Thurin's own URLs, chosen by the host this copy of the app is served from.
 *
 * On thurin.id the links go to the .id sites. Served from ENS (id.thurinlabs.eth
 * natively, or through a gateway like id.thurinlabs.eth.limo) they stay on ENS,
 * using the same gateway suffix, so a visitor who came in without touching DNS
 * never gets handed back to it. Docs have no ENS name yet and stay on docs.thurin.id.
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
