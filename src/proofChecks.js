// Proofs are checked only when the visitor asks: checking asks each platform (GitHub, a DNS
// resolver, a Farcaster node, a Mastodon server the identity's owner picked…) directly, so each
// sees the visitor's IP and which identity they're looking at. "Always check" is saved in this
// browser only.
import { useEffect, useState } from 'react'

const KEY = 'thurin-check-proofs'
const EVENT = 'thurin-check-proofs'

export const CHECK_NOTE = "Checking asks each platform directly, so they see your IP and which identity you're looking at."

export function alwaysCheckProofs() {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

export function setAlwaysCheckProofs(on) {
  try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY) } catch { /* storage blocked */ }
  window.dispatchEvent(new Event(EVENT))
}

/** The setting, live: flipping it in the footer updates the page. */
export function useAlwaysCheckProofs() {
  const [on, setOn] = useState(alwaysCheckProofs)
  useEffect(() => {
    const update = () => setOn(alwaysCheckProofs())
    window.addEventListener(EVENT, update)
    return () => window.removeEventListener(EVENT, update)
  }, [])
  return on
}
