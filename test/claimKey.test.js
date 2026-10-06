// @vitest-environment node
// Which claim key the QR flow offers: the counted claim's, and only a secp256k1 one.
import { describe, it, expect } from 'vitest'
import * as openpgp from 'openpgp'
import { answer } from '../scripts/pretend-shell.mjs'
import { identityRequest } from '../src/qr/keycard.js'
import { deviceKeyFromClaims } from '../src/qr/claimKey.js'

const claim = (pgpPublicKey, { verified = true, revoked = false, index = 0 } = {}) =>
  ({ index, pgpPublicKey, revoked, verification: { verified } })

describe('the key from your claim', () => {
  it('offers a counted secp256k1 key (a Shell key)', async () => {
    const shellKey = openpgp.armor(openpgp.enums.armor.publicKey, await answer(identityRequest('Shell', Math.floor(Date.now() / 1000) - 60)))
    const k = await deviceKeyFromClaims([claim(shellKey)])
    expect(k?.info.algorithm).toBe('secp256k1')
    expect(k?.created).toBeGreaterThan(0)
  }, 60_000)

  it('offers nothing for an ed25519 key, an unverified claim, a revoked one, or no claim', async () => {
    const { publicKey } = await openpgp.generateKey({ type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ name: 'gpg user' }] })
    expect(await deviceKeyFromClaims([claim(publicKey)])).toBeNull()
    const shellKey = openpgp.armor(openpgp.enums.armor.publicKey, await answer(identityRequest('Shell', Math.floor(Date.now() / 1000) - 60)))
    expect(await deviceKeyFromClaims([claim(shellKey, { verified: false })])).toBeNull()
    expect(await deviceKeyFromClaims([claim(shellKey, { revoked: true })])).toBeNull()
    expect(await deviceKeyFromClaims([])).toBeNull()
    expect(await deviceKeyFromClaims(undefined)).toBeNull()
  }, 60_000)

  it('follows the claim that counts: the newest verified one', async () => {
    const { publicKey } = await openpgp.generateKey({ type: 'ecc', curve: 'ed25519Legacy', userIDs: [{ name: 'newer gpg key' }] })
    const shellKey = openpgp.armor(openpgp.enums.armor.publicKey, await answer(identityRequest('Shell', Math.floor(Date.now() / 1000) - 60)))
    // older Shell claim, newer gpg claim: the gpg one counts, so nothing is offered
    expect(await deviceKeyFromClaims([claim(shellKey, { index: 0 }), claim(publicKey, { index: 1 })])).toBeNull()
    // and the other way round
    expect(await deviceKeyFromClaims([claim(publicKey, { index: 0 }), claim(shellKey, { index: 1 })])).not.toBeNull()
  }, 60_000)
})
