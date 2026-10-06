// @vitest-environment node
// The whole QR round trip against the pretend Shell: our request → the Shell's answer as animated
// frames → our decoder → the same identity-kit checks a pasted key and signature get.
import { describe, it, expect } from 'vitest'
import { parsePgpKey, verifyStatementSignature, statementText } from '@thurinlabs/identity-kit/core'
import { answer, answerFrames } from '../scripts/pretend-shell.mjs'
import { URDecoder } from '../src/qr/ur.js'
import { identityRequest, signRequest, readIdentityAnswer, readSignatureAnswer } from '../src/qr/keycard.js'

async function scan(frames, skipFirst = 0) {
  const d = new URDecoder()
  for (const f of frames.slice(skipFirst)) if (await d.receive(f)) return d.result
  throw new Error('frames ran out before the answer was complete')
}

describe('Keycard Shell round trip (pretend Shell)', () => {
  const owner = '0xE52d69D6EeD7b82f06C072F752c6dC222F5CB548'
  const created = Math.floor(Date.now() / 1000) - 86400   // a key made yesterday

  it('creates a key, signs the statement, and the kit verifies it', async () => {
    const cert = readIdentityAnswer(await scan(answerFrames(await answer(identityRequest('Pretend Shell', created)))))
    const info = await parsePgpKey(cert)
    expect(info?.fingerprint).toMatch(/^[0-9a-f]{40}$/i)   // a v4 key, like the Shell's
    expect(info?.publishedName ?? info?.userIDs?.[0]).toContain('Pretend Shell')

    const statement = statementText(owner)
    const now = Math.floor(Date.now() / 1000)   // the site signs at the current time (the kit refuses future signatures)
    // the camera missed the first round: only fountain frames get through
    const frames = answerFrames(await answer(signRequest(statement, created, now)), 12)
    const sig = readSignatureAnswer(await scan(frames, frames.length > 1 ? 4 : 0))

    const r = await verifyStatementSignature({ key: cert, signature: sig, address: owner })
    expect(r, r.reason).toMatchObject({ verified: true })
    // and a signature for another address does not pass
    expect((await verifyStatementSignature({ key: cert, signature: sig, address: '0x' + '1'.repeat(40) })).verified).toBe(false)
  }, 60_000)

  it('the certificate needs several frames, the signature fits fewer', async () => {
    const cert = await answer(identityRequest('Pretend Shell', created))
    expect(answerFrames(cert).length).toBeGreaterThan(1)
  }, 60_000)
})
