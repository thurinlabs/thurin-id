// Animated QR frames → a Y4M video, which Chromium plays as a fake webcam
// (--use-fake-device-for-media-stream --use-file-for-fake-video-capture=<file>). Lets the real
// scanner code read the pretend Shell's answer end to end, headless. Dev only.
//
//   node scripts/qr-video.mjs out.y4m < frames.txt     (one UR frame per line)
import { writeFileSync, readFileSync } from 'node:fs'
import qrcode from 'qrcode-generator'

const W = 640, H = 480, FPS = 10, HOLD = 3   // each QR on screen for 300 ms, like a device's animation

function frameFor(text) {
  const qr = qrcode(0, 'L')
  qr.addData(text, /^[0-9A-Z $%*+\-./:]+$/.test(text) ? 'Alphanumeric' : 'Byte')
  qr.make()
  const n = qr.getModuleCount(), cell = Math.floor((H - 40) / (n + 8))
  const size = cell * (n + 8), x0 = (W - size) >> 1, y0 = (H - size) >> 1
  const y = new Uint8Array(W * H).fill(200)   // grey surroundings: a screen held up to the camera
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    const mr = Math.floor(r / cell) - 4, mc = Math.floor(c / cell) - 4
    const dark = mr >= 0 && mc >= 0 && mr < n && mc < n && qr.isDark(mr, mc)
    y[(y0 + r) * W + x0 + c] = dark ? 0 : 255
  }
  return y
}

export function y4m(frames) {
  const chroma = new Uint8Array((W / 2) * (H / 2)).fill(128)
  const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`)]
  for (const text of frames) {
    const y = frameFor(text)
    for (let i = 0; i < HOLD; i++) parts.push(Buffer.from('FRAME\n'), y, chroma, chroma)
  }
  return Buffer.concat(parts)
}

if (process.argv[1]?.endsWith('qr-video.mjs')) {
  const out = process.argv[2]
  if (!out) { console.error('usage: node scripts/qr-video.mjs out.y4m < frames.txt'); process.exit(2) }
  const frames = readFileSync(0, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
  writeFileSync(out, y4m(frames))
  console.error(`${frames.length} QR frames → ${out}`)
}
