// The Keycard Shell's OpenPGP requests (keycard-shell app/openpgp/openpgp_protocol.c): a definite
// CBOR map in fixed key order, carried as ur:bytes. The Shell derives the key itself; the request
// never names a path or fingerprint. Its answers are plain OpenPGP: the certificate for
// CREATE_IDENTITY, a detached canonical-text signature packet for SIGN_MESSAGE.
import { cbor, encodeBytesUR } from './ur.js'

const VERSION = 1
const OP_CREATE_IDENTITY = 1
const OP_SIGN_MESSAGE = 2
export const NAME_MAX = 255        // OPENPGP_UID_MAX_LEN
export const MESSAGE_MAX = 104     // OPENPGP_MESSAGE_MAX_LEN

const ascii = s => new TextEncoder().encode(s)
const u32 = n => {
  if (!Number.isInteger(n) || n <= 0 || n > 0xffffffff) throw new Error('A time the Shell can take is needed.')
  return cbor.uint(n)
}

/** The same rule the Shell applies before it shows a name: printable ASCII only. */
export function nameProblem(name) {
  if (!name) return 'Enter a name.'
  if (!/^[\x20-\x7e]+$/.test(name)) return 'Letters, numbers, and plain punctuation only: the device shows exactly these characters.'
  if (name.length > NAME_MAX) return `At most ${NAME_MAX} characters.`
  return null
}

/** CREATE_IDENTITY: { 1: version, 2: op, 3: name, 4: creation time }. */
export function identityRequest(name, creationTime) {
  const problem = nameProblem(name)
  if (problem) throw new Error(problem)
  return encodeBytesUR(cbor.map([
    [1, cbor.uint(VERSION)], [2, cbor.uint(OP_CREATE_IDENTITY)],
    [3, cbor.bytes(ascii(name))], [4, u32(creationTime)],
  ]))
}

/** SIGN_MESSAGE: { 1: version, 2: op, 3: message, 4: key creation time, 5: signature time }. */
export function signRequest(message, keyCreated, signatureTime) {
  const bytes = ascii(message)
  if (!/^[\x20-\x7e\r\n]+$/.test(message) || bytes.length > MESSAGE_MAX) throw new Error("The device can't show this line.")
  if (signatureTime < keyCreated) throw new Error("The signature can't be older than the key.")
  return encodeBytesUR(cbor.map([
    [1, cbor.uint(VERSION)], [2, cbor.uint(OP_SIGN_MESSAGE)],
    [3, cbor.bytes(bytes)], [4, u32(keyCreated)], [5, u32(signatureTime)],
  ]))
}

// The answers are checked properly by the same code that checks a paste (identity-kit: right key,
// exact statement, exact address). Here only: is this the kind of packet the step expects?
const packetTag = b => (b[0] & 0x40 ? b[0] & 0x3f : (b[0] >> 2) & 0x0f)

/** The certificate from CREATE_IDENTITY: starts with a public-key packet. */
export function readIdentityAnswer(bytes) {
  if (!(bytes?.length > 8) || !(bytes[0] & 0x80) || packetTag(bytes) !== 6) throw new Error("That QR isn't a key from the device.")
  return bytes
}

/** The detached signature from SIGN_MESSAGE: one signature packet. */
export function readSignatureAnswer(bytes) {
  if (!(bytes?.length > 8) || !(bytes[0] & 0x80) || packetTag(bytes) !== 2) throw new Error("That QR isn't a signature from the device.")
  return bytes
}
