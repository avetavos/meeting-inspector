// Spike (spec risk #3): how accurate is Thai-with-English-tech-terms on 30s chunks?
//
//   1. cat spike/asr-accuracy/script.th.txt
//   2. record yourself reading it in the app, then stop
//   3. npm run asr:score
//
// Runs the app's real Chunker and Whisper over mic.wav, so the number describes
// the pipeline we ship rather than a one-shot transcription of the whole file.
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { Chunker } from '../../src/main/chunker.ts'
import { Whisper } from '../../src/main/whisper.ts'

const NOTES = join(homedir(), 'Documents', 'MeetingNotes')
const SCRIPT = new URL('script.th.txt', import.meta.url)

function parseScript(text) {
  const lines = text.split('\n')
  const terms = (lines.find((l) => l.startsWith('TERMS:')) ?? '')
    .slice('TERMS:'.length)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const reference = lines
    .filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('TERMS:'))
    .join(' ')
  return { terms, reference }
}

/** Thai has no word spacing, so whitespace and punctuation carry no signal here. */
const normalize = (s) =>
  s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s.,!?"'()ๆ๏๚๛-]/gu, '')

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = row
  }
  return prev[b.length]
}

async function newestMeeting() {
  const dirs = (await readdir(NOTES, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
  const dir = dirs.at(-1)
  if (!dir) throw new Error(`no meetings in ${NOTES} — record yourself reading the script first`)
  return join(NOTES, dir)
}

function pcmFrom(wav) {
  // Our own writer, so the header is always the plain 44-byte one.
  return new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length))
}

const dir = process.argv[2] ?? (await newestMeeting())
const track = process.argv[3] ?? 'mic'
const { terms, reference } = parseScript(await readFile(SCRIPT, 'utf8'))
const pcm = pcmFrom(await readFile(join(dir, `${track}.wav`)))
console.log(`meeting: ${basename(dir)}  track: ${track}  ${(pcm.length / 16000).toFixed(1)}s\n`)

const segments = []
const whisper = await Whisper.start(
  'th',
  (_t, batch) => segments.push(...batch),
  () => {},
)

const chunker = new Chunker()
const chunks = []
for (let i = 0; i < pcm.length; i += 1600) {
  const chunk = chunker.push(pcm.subarray(i, Math.min(i + 1600, pcm.length)))
  if (chunk) chunks.push(chunk)
}
const tail = chunker.flush()
if (tail) chunks.push(tail)

for (const chunk of chunks) whisper.enqueue(track, chunk)
console.log(`${chunks.length} chunks (${chunks.map((c) => (c.pcm.length / 16000).toFixed(0)).join('s, ')}s)`)
while (whisper.depth > 0) await new Promise((r) => setTimeout(r, 300))
whisper.stop()

segments.sort((a, b) => a.t0 - b.t0)
const hypothesis = segments.map((s) => s.text).join(' ')

const [ref, hyp] = [normalize(reference), normalize(hypothesis)]
const cer = editDistance(ref, hyp) / ref.length
const hits = terms.filter((t) => normalize(hypothesis).includes(normalize(t)))
const misses = terms.filter((t) => !hits.includes(t))

console.log('\n--- transcript ---')
for (const s of segments) console.log(`${s.t0.toFixed(1).padStart(6)}s  ${s.text}`)

console.log('\n--- score ---')
console.log(`CER          ${(cer * 100).toFixed(1)}%  (${ref.length} reference chars)`)
console.log(`term recall  ${hits.length}/${terms.length}  (${((hits.length / terms.length) * 100).toFixed(0)}%)`)
if (misses.length) console.log(`missed       ${misses.join(', ')}`)
console.log('\nCER counts Thai wording drift too. The term recall line is the one that decides')
console.log('whether summaries will be usable — read the transcript above before trusting either.')
