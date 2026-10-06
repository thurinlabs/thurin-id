// @vitest-environment node
// Our ur:bytes decoder against the @ngraveio/bc-ur reference (test-only): the same messages, the
// same animated frames, including the fountain frames a camera sees after missing some.
import { describe, it, expect } from 'vitest'
import { UR, UREncoder, URDecoder as RefDecoder } from '@ngraveio/bc-ur'
import { URDecoder, encodeBytesUR, partIndexes, crc32 } from '../src/qr/ur.js'

const bytes = n => Uint8Array.from({ length: n }, (_, i) => (i * 131 + 7) & 0xff)
const encoderFor = (data, frag = 60) => new UREncoder(UR.fromBuffer(Buffer.from(data)), frag)

// a seeded shuffle, so a failure reproduces
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) }

describe('ur:bytes', () => {
  it('reads a single-part QR', async () => {
    const data = bytes(40)
    const d = new URDecoder()
    expect(await d.receive(UREncoder.encodeSinglePart(UR.fromBuffer(Buffer.from(data))))).toBe(true)
    expect(Array.from(d.result)).toEqual(Array.from(data))
  })

  it('writes single-part QRs the reference reads', () => {
    const data = bytes(90)
    const ref = new RefDecoder()
    ref.receivePart(encodeBytesUR(data).toLowerCase())
    expect(ref.isSuccess()).toBe(true)
    expect(Array.from(ref.resultUR().decodeCBOR())).toEqual(Array.from(data))
  })

  it('reads an animated QR frame by frame', async () => {
    const data = bytes(700)
    const enc = encoderFor(data)
    const d = new URDecoder()
    let n = 0
    while (!(await d.receive(enc.nextPart()))) n++
    expect(n + 1).toBe(enc.fragmentsLength)
    expect(Array.from(d.result)).toEqual(Array.from(data))
  })

  it('picks the same pieces for fountain frames as the reference', async () => {
    // The reference's chooseFragments is the spec; ours is a port of the Shell's C.
    const { chooseFragments } = await import('@ngraveio/bc-ur/dist/fountainUtils.js')
    for (const seqLen of [2, 3, 7, 12, 40, 128]) {
      const checksum = crc32(bytes(seqLen * 3))
      for (let seqNum = seqLen + 1; seqNum < seqLen + 60; seqNum++) {
        const ours = (await partIndexes(seqNum, checksum, seqLen)).slice().sort((a, b) => a - b)
        const theirs = chooseFragments(seqNum, seqLen, checksum).slice().sort((a, b) => a - b)
        expect(ours, `seqLen ${seqLen} seqNum ${seqNum}`).toEqual(theirs)
      }
    }
  })

  it('assembles from fountain frames alone, after missing the whole first round', async () => {
    const data = bytes(1200)
    const enc = encoderFor(data, 50)
    for (let i = 0; i < enc.fragmentsLength; i++) enc.nextPart()   // the camera missed all of these
    const d = new URDecoder()
    let frames = 0
    while (!(await d.receive(enc.nextPart()))) if (++frames > 500) throw new Error('never finished')
    expect(Array.from(d.result)).toEqual(Array.from(data))
  })

  it('assembles with frames dropped at random', async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = rng(seed)
      const data = bytes(900 + seed * 37)
      const enc = encoderFor(data, 45)
      const d = new URDecoder()
      let frames = 0
      for (;;) {
        const part = enc.nextPart()
        if (r() < 0.4) continue   // 40% of frames lost
        if (await d.receive(part)) break
        if (++frames > 1000) throw new Error(`seed ${seed}: never finished`)
      }
      expect(Array.from(d.result), `seed ${seed}`).toEqual(Array.from(data))
    }
  })

  it('starts over when a different animation appears', async () => {
    const a = encoderFor(bytes(500)), b = encoderFor(bytes(600))
    const d = new URDecoder()
    await d.receive(a.nextPart()); await d.receive(a.nextPart())
    while (!(await d.receive(b.nextPart()))) { /* keep reading b */ }
    expect(d.result.length).toBe(600)
  })

  it('refuses junk and oversize claims', async () => {
    const d = new URDecoder()
    for (const bad of ['', 'hello', 'ur:crypto-psbt/abcd', 'UR:BYTES/xxxx', 'ur:bytes/1-2/lpadaxcy', 'https://thurin.id']) {
      await expect(d.receive(bad), bad).rejects.toThrow()
    }
    // a part announcing 10,000 pieces is refused before anything is allocated
    const huge = new UREncoder(UR.fromBuffer(Buffer.from(bytes(200))), 10).nextPart().replace(/^ur:bytes\/1-\d+\//, 'ur:bytes/1-10000/')
    await expect(d.receive(huge)).rejects.toThrow()
  })
})
