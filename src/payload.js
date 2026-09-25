import * as openpgp from 'openpgp'
import { hexToBytes, hexToString } from 'viem'

// Raw key or signature bytes as armored text; a clearsigned message comes back as stored.
function payloadText(hex, kind) {
  if (!hex || hex === '0x') return null
  const bytes = hexToBytes(hex)
  if (bytes[0] === 0x2d) return hexToString(hex) // '-': armored or clearsigned text
  return openpgp.armor(kind === 'key' ? openpgp.enums.armor.publicKey : openpgp.enums.armor.signature, bytes)
}

/** A hand-off's key or signature as the armored text the paste box expects (a clearsigned message passes through). */
export function asArmor(v, kind) {
  return typeof v === 'string' && /^0x([0-9a-fA-F]{2})+$/.test(v) ? payloadText(v, kind) : v
}
