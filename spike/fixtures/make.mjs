// Builds test audio that needs two genuinely different voices.
//   npm run fixtures
// macOS `say` gives us two, which is enough to tell "same speaker" from "different
// speaker" apart. Not committed: it is 700KB of derivable bytes.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'fixtures-'))

const TURNS = [
  ['Kanya', 'สวัสดีครับ วันนี้ผมอยากคุยเรื่อง migration ของฐานข้อมูลก่อนนะครับ'],
  ['Samantha', 'Sure, I looked at the pull request yesterday and I think the index is missing on that column.'],
  ['Kanya', 'ใช่ครับ ผมว่าถ้าเติม index ตัวเดียวน่าจะเร็วขึ้นเยอะเลย'],
  ['Samantha', 'Agreed. Let us deploy it to staging first and watch the error rate for a day.'],
]

const pcm = []
TURNS.forEach(([voice, line], i) => {
  const file = join(work, `${i}.wav`)
  execFileSync('say', ['-v', voice, '--file-format=WAVE', '--data-format=LEI16@16000', '-o', file, line])
  const wav = readFileSync(file)
  const at = wav.indexOf(Buffer.from('data'))
  const size = wav.readUInt32LE(at + 4)
  pcm.push(wav.subarray(at + 8, at + 8 + size), Buffer.alloc(16000)) // half a second between turns
})

const body = Buffer.concat(pcm)
const header = Buffer.alloc(44)
header.write('RIFF', 0)
header.writeUInt32LE(36 + body.length, 4)
header.write('WAVEfmt ', 8)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20)
header.writeUInt16LE(1, 22)
header.writeUInt32LE(16000, 24)
header.writeUInt32LE(32000, 28)
header.writeUInt16LE(2, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(body.length, 40)

const out = join(HERE, 'two-speakers.wav')
writeFileSync(out, Buffer.concat([header, body]))
console.log(`wrote ${out} — ${(body.length / 2 / 16000).toFixed(1)}s, two voices taking turns`)
