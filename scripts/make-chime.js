// Writes mod/sounds/chime.wav, the F16 cold-cache chime: two soft tones, 0.45 s, 16-bit mono at 22.05 kHz.
// Run from the repo root: node scripts/make-chime.js
const fs = require('fs')
const path = require('path')

const RATE = 22050
const TONES = [[880, 0.2], [1320, 0.25]] // Hz, seconds
const samples = []
for (const [hz, sec] of TONES) {
  const n = Math.round(RATE * sec)
  for (let i = 0; i < n; i++) {
    const envelope = Math.min(1, i / (RATE * 0.005)) * Math.exp((-4 * i) / n)
    samples.push(Math.round(Math.sin((2 * Math.PI * hz * i) / RATE) * envelope * 0.5 * 32767))
  }
}
const data = Buffer.alloc(samples.length * 2)
samples.forEach((s, i) => data.writeInt16LE(s, i * 2))
const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + data.length, 4)
header.write('WAVE', 8)
header.write('fmt ', 12)
header.writeUInt32LE(16, 16) // fmt chunk size
header.writeUInt16LE(1, 20) // PCM
header.writeUInt16LE(1, 22) // mono
header.writeUInt32LE(RATE, 24)
header.writeUInt32LE(RATE * 2, 28) // bytes per second
header.writeUInt16LE(2, 32) // block align
header.writeUInt16LE(16, 34) // bits per sample
header.write('data', 36)
header.writeUInt32LE(data.length, 40)
const out = path.join(__dirname, '..', 'mod', 'sounds', 'chime.wav')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, Buffer.concat([header, data]))
console.log(`wrote ${out} (${header.length + data.length} bytes)`)
