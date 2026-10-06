// The key a QR device could sign for, taken from the connected address's own claim: the claim
// that counts (the kit's rule), and only a secp256k1 key, the only kind a Keycard Shell makes.
// Any other key the device couldn't sign for, so offering it would only end in a failed check.
import { keyStanding, parsePgpKey } from '@thurinlabs/identity-kit'

/** `claims` in chain order (oldest first), as readClaims returns them. */
export async function deviceKeyFromClaims(claims) {
  const standing = keyStanding(claims ?? [])
  if (standing.kind !== 'verified' || !standing.claim?.pgpPublicKey) return null
  const info = await parsePgpKey(standing.claim.pgpPublicKey).catch(() => null)
  if (!info?.created || info.algorithm !== 'secp256k1') return null
  return { bytes: standing.claim.pgpPublicKey, info, created: Math.floor(Date.parse(info.created) / 1000) }
}
