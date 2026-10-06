// @vitest-environment node
// Requests byte-for-byte as the Shell's parser expects (openpgp_protocol.c), read back through
// the bc-ur reference as the Shell's scanner would see them.
import { describe, it, expect } from 'vitest'
import { URDecoder as RefDecoder } from '@ngraveio/bc-ur'
import { identityRequest, signRequest, nameProblem, readIdentityAnswer, readSignatureAnswer } from '../src/qr/keycard.js'

const hex = b => Buffer.from(b).toString('hex')
function payloadOf(ur) {
  const ref = new RefDecoder()
  ref.receivePart(ur.toLowerCase())
  expect(ref.isSuccess()).toBe(true)
  return ref.resultUR().decodeCBOR()   // the bytes inside ur:bytes: the request map
}

describe('Keycard Shell requests', () => {
  const statement = 'I control the Ethereum address: 0xe52d69d6eed7b82f06c072f752c6dc222f5cb548'

  it('SIGN_MESSAGE: { 1: 1, 2: 2, 3: message, 4: key time, 5: signature time }, definite, in order', () => {
    const ur = signRequest(statement, 0x6a000000, 0x6a0000ff)
    expect(ur).toMatch(/^UR:BYTES\/[A-Z]+$/)
    const msg = Buffer.from(statement).toString('hex')
    expect(hex(payloadOf(ur))).toBe(`a5010102020358${(74).toString(16)}${msg}041a6a000000051a6a0000ff`)
  })

  it('CREATE_IDENTITY: { 1: 1, 2: 1, 3: name, 4: creation time }', () => {
    const ur = identityRequest('Ben Woodall', 1790000000)
    expect(hex(payloadOf(ur))).toBe(`a40101020103${'4b' + Buffer.from('Ben Woodall').toString('hex')}041a${(1790000000).toString(16).padStart(8, '0')}`)
  })

  it('fits one QR: the statement request is short', () => {
    expect(signRequest(statement, 1, 2).length).toBeLessThan(300)
  })

  it('refuses what the Shell would refuse', () => {
    expect(nameProblem('Zoë')).toMatch(/plain punctuation/)
    expect(nameProblem('')).toMatch(/Enter a name/)
    expect(nameProblem('x'.repeat(256))).toMatch(/255/)
    expect(nameProblem('Ben Woodall <mail@benwoodall.com>')).toBeNull()
    expect(() => signRequest('x'.repeat(105), 1, 2)).toThrow()
    expect(() => signRequest('emoji 🔑', 1, 2)).toThrow()
    expect(() => signRequest(statement, 10, 9)).toThrow(/older than the key/)
    expect(() => signRequest(statement, 0, 9)).toThrow()
  })

  it('tells a key from a signature', () => {
    const pubkey = Uint8Array.from([0xc6, 0x4f, 0x04, 1, 2, 3, 4, 5, 6, 7])   // new-format tag 6
    const oldPubkey = Uint8Array.from([0x98, 0x4f, 0x04, 1, 2, 3, 4, 5, 6, 7]) // old-format tag 6
    const sig = Uint8Array.from([0xc2, 0x5e, 0x04, 1, 2, 3, 4, 5, 6, 7])       // tag 2
    expect(readIdentityAnswer(pubkey)).toBe(pubkey)
    expect(readIdentityAnswer(oldPubkey)).toBe(oldPubkey)
    expect(readSignatureAnswer(sig)).toBe(sig)
    expect(() => readIdentityAnswer(sig)).toThrow(/key from the device/)
    expect(() => readSignatureAnswer(pubkey)).toThrow(/signature from the device/)
    expect(() => readSignatureAnswer(new Uint8Array(3))).toThrow()
  })
})
