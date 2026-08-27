// Spike (spec risk #3): how accurate is Thai-with-English-tech-terms on 30s chunks?
//
//   1. cat spike/asr-accuracy/script.th.txt
//   2. record yourself reading it in the app, then stop
//   3. npm run asr:score
//
// Runs the app's real Chunker and Whisper over mic.wav, so the number describes
// the pipeline we ship rather than a one-shot transcription of the whole file.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { Chunker } from '../../src/main/chunker.ts'
import { Whisper } from '../../src/main/whisper.ts'

const NOTES = join(homedir(), 'Documents', 'MeetingNotes')
const SCRIPTS = new URL('scripts/', import.meta.url).pathname
const CORPUS = new URL('corpus/', import.meta.url).pathname

function parseScript(text) {
  const lines = text.split('\n')
  const terms = (lines.find((l) => l.startsWith('TERMS:')) ?? '')
    .slice('TERMS:'.length)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const spoken = lines.filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('TERMS:'))
  // A multi-speaker script prefixes each line with who says it. Nobody reads the
  // prefix out loud, so counting it as reference text would inflate CER.
  const speakers = [...new Set(spoken.map((l) => /^([^:]{1,20}):\s/.exec(l)?.[1]).filter(Boolean))]
  const reference = spoken.map((l) => l.replace(/^[^:]{1,20}:\s*/, '')).join(' ')
  return { terms, reference, speakers }
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

// npm run asr:score -- <script> [meeting-dir] [track]
const scripts = (await readdir(SCRIPTS)).filter((f) => f.endsWith('.txt')).sort()
const wanted = process.argv[2]
const scriptFile = scripts.find((f) => f.startsWith(wanted ?? '')) ?? scripts[0]
if (!scriptFile) throw new Error('no scripts found')

const dir = process.argv[3] ?? (await newestMeeting())
const track = process.argv[4] ?? 'mic'
const { terms, reference, speakers } = parseScript(await readFile(join(SCRIPTS, scriptFile), 'utf8'))
if (speakers.length > 1) console.log(`คนพูดในบทนี้: ${speakers.join(', ')} (${speakers.length} คน)`)
const pcm = pcmFrom(await readFile(join(dir, `${track}.wav`)))
// Say both out loud. Scoring the wrong recording against the wrong script produces
// a catastrophic-looking number that means nothing, and it is easy to miss.
console.log(`script:  ${scriptFile}`)
console.log(`meeting: ${basename(dir)}  track: ${track}  ${(pcm.length / 16000).toFixed(1)}s\n`)

async function transcribe(prompt) {
  const segments = []
  const whisper = await Whisper.start({
    language: 'th',
    prompt,
    onSegments: (_t, batch) => segments.push(...batch),
    onDepth: () => {},
  })
  for (const chunk of chunks) whisper.enqueue(track, chunk)
  while (whisper.depth > 0) await new Promise((r) => setTimeout(r, 300))
  whisper.stop()
  return segments.sort((a, b) => a.t0 - b.t0)
}

const chunker = new Chunker()
const chunks = []
for (let i = 0; i < pcm.length; i += 1600) {
  const chunk = chunker.push(pcm.subarray(i, Math.min(i + 1600, pcm.length)))
  if (chunk) chunks.push(chunk)
}
const tail = chunker.flush()
if (tail) chunks.push(tail)
console.log(`${chunks.length} chunks (${chunks.map((c) => (c.pcm.length / 16000).toFixed(0)).join('s, ')}s)`)

function score(segments) {
  const hypothesis = segments.map((s) => s.text).join(' ')
  const [ref, hyp] = [normalize(reference), normalize(hypothesis)]
  const hits = terms.filter((t) => hyp.includes(normalize(t)))
  return {
    segments,
    cer: editDistance(ref, hyp) / ref.length,
    hits,
    misses: terms.filter((t) => !hits.includes(t)),
  }
}

// Same audio, same chunk boundaries, one variable: does seeding the decoder with
// the team's vocabulary rescue the terms it otherwise mishears?
const runs = [
  ['no prompt   ', score(await transcribe(undefined))],
  ['with prompt ', score(await transcribe(terms.join(', ')))],
]

for (const [label, r] of runs) {
  console.log(`\n--- ${label.trim()} ---`)
  for (const s of r.segments) console.log(`${s.t0.toFixed(1).padStart(6)}s  ${s.text}`)
}

console.log('\n--- score ---')
console.log(`${''.padEnd(13)}CER     terms`)
for (const [label, r] of runs) {
  console.log(`${label} ${(r.cer * 100).toFixed(1).padStart(5)}%   ${r.hits.length}/${terms.length}   missed: ${r.misses.join(', ') || '-'}`)
}
const best = runs[1][1]
if (best.cer > 0.5) {
  console.log('\n⚠️  CER สูงผิดปกติ — น่าจะให้คะแนนคนละบทกับที่อ่าน ลองระบุบทให้ตรง')
}

// A read-aloud recording is audio with a known-correct transcript, which is exactly
// what fine-tuning would need later. Keep the pair rather than only the score.
await mkdir(CORPUS, { recursive: true })
await writeFile(
  join(CORPUS, `${basename(dir)}.json`),
  JSON.stringify({ script: scriptFile, meeting: basename(dir), track, audio: join(dir, `${track}.wav`),
    reference, hypothesis: best.segments.map((s) => s.text).join(' '), cer: best.cer,
    terms: { found: best.hits, missed: best.misses } }, null, 2) + '\n',
)
console.log(`\nเก็บคู่ เสียง+บทที่ถูกต้อง ไว้ที่ spike/asr-accuracy/corpus/${basename(dir)}.json`)
console.log('CER counts Thai wording drift too, so it moves when you paraphrase the script.')
console.log('The terms column is the one that decides whether summaries end up usable.')
