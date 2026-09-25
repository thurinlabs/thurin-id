import * as openpgp from 'openpgp'
import { hexToBytes, hexToString } from 'viem'

// A stored payload as armored text, synchronously. Older claims store armored text; lean claims
// (registry v3 format) store raw OpenPGP bytes, armored here so displays, copy buttons, and the
// kit's text-based helpers keep working. The kit's async `payloadText` does the same.
export function payloadText(hex, kind) {
  if (!hex || hex === '0x') return null
  const bytes = hexToBytes(hex)
  if (bytes[0] === 0x2d) return hexToString(hex) // '-': armored or clearsigned text
  return openpgp.armor(kind === 'key' ? openpgp.enums.armor.publicKey : openpgp.enums.armor.signature, bytes)
}
