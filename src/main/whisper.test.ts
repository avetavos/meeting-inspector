import assert from 'node:assert/strict'
import { chmod, copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// models.ts reads MODELS_DIR at import time, so this has to land first — same
// requirement download.test.ts has.
const DIR = await mkdtemp(join(tmpdir(), 'whisper-test-'))
process.env['MODELS_DIR'] = DIR

// whisper.ts resolves BIN from this at import time too. The first test below only
// needs it to exist; the second overwrites its content with a real (fake) server.
const bin = join(DIR, 'whisper-server')
await writeFile(bin, '')
process.env['WHISPER_SERVER'] = bin

const { Whisper } = await import('./whisper.ts')
const { ASR_MODELS } = await import('./download.ts')
const { model } = await import('./models.ts')

// The VAD model whisper-server always needs, regardless of which ASR model is picked.
await writeFile(model('ggml-silero-v5.1.2.bin'), '')

/**
 * vad.ts's own in-process Silero detector (a different model file from the one just
 * above — that one is whisper-server's own `-vm` flag) needs a real, working model to
 * classify anything as speech: an empty or missing file does not make it fall back the
 * way requireFiles()-gated code does — sherpa-onnx-node logs "vad is nullptr" and
 * every call silently no-ops instead of throwing, so hasSpeech() ends up returning
 * false for every chunk regardless of content. Copied read-only from the real model
 * directory (never written to) so the enqueue/pump() test below exercises the actual
 * gate instead of a hallway around it; skipped if this machine does not have it.
 */
const REAL_VAD_MODEL = join(homedir(), 'whisper-models', 'silero_vad.onnx')
const SPEECH_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'spike', 'fixtures', 'two-speakers.wav')
let realSpeechGate = true
await copyFile(REAL_VAD_MODEL, model('silero_vad.onnx')).catch(() => {
  realSpeechGate = false
})

test('whisper: the selected ASR model is what gets required, not whichever one happens to exist', async () => {
  // Simulate a machine where only 'large' was ever downloaded (e.g. from before this
  // setting existed) — 'turbo' is what is actually selected now.
  await writeFile(model(ASR_MODELS.large.file), '')

  await assert.rejects(
    Whisper.start({
      language: 'th',
      model: model(ASR_MODELS.turbo.file),
      onSegments: () => {},
      onDepth: () => {},
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      // The real risk this guards against: picking the small model must not still
      // demand — or silently load — the 3GB one just because it happens to be on disk.
      assert.ok(err.message.includes(ASR_MODELS.turbo.file), `expected the turbo file to be named missing: ${err.message}`)
      assert.ok(!err.message.includes(ASR_MODELS.large.file), `large-v3 should not be mentioned at all: ${err.message}`)
      return true
    },
  )
})

/**
 * A whisper-server stand-in for the test below: answers the startup probe (any GET)
 * and, on POST /inference, echoes back whichever `language` form field it received
 * instead of actually transcribing anything.
 */
const FAKE_SERVER = `#!/usr/bin/env node
const http = require('node:http')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
http.createServer((req, res) => {
  if (req.method !== 'POST') { res.end('ok'); return }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('latin1')
    const m = /name="language"\\r\\n\\r\\n([^\\r\\n]*)/.exec(body)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ segments: [{ start: 0, end: 1, text: m ? m[1] : '' }] }))
  })
}).listen(port, '127.0.0.1')
`

test('whisper: Whisper.transcribeOnce sends its own language argument on the real /inference request', async () => {
  // The old version of this test called inferenceBody() directly — nothing proved
  // Whisper.transcribe() actually uses it, so reverting transcribe() to build its own
  // (wrong) body inline would still have passed. This drives Whisper end to end
  // against a stand-in server, so what actually leaves the process is what gets
  // checked. opts.language ('th') is the spawn-time -l flag; the argument passed to
  // transcribeOnce is the per-request override, deliberately different from it so a
  // regression back to reading opts.language would fail this.
  await writeFile(model(ASR_MODELS.turbo.file), '')
  await writeFile(bin, FAKE_SERVER)
  await chmod(bin, 0o755)

  const whisper = await Whisper.start({
    language: 'th',
    model: model(ASR_MODELS.turbo.file),
    onSegments: () => {},
    onDepth: () => {},
  })
  try {
    const text = await whisper.transcribeOnce(new Int16Array(10), 'en')
    assert.equal(text, 'en', 'the fake server echoes back whatever language field it received')
  } finally {
    whisper.stop()
  }
})

test(
  "whisper: enqueue()/pump() — the real FIFO batch queue, not transcribeOnce — carries each job's own language, not a shared setting",
  { skip: !realSpeechGate && 'no real silero_vad.onnx on this machine — see REAL_VAD_MODEL above' },
  async () => {
    // The previous version of this test was titled for enqueue()/the batch queue but
    // its body only ever called transcribeOnce, which bypasses the FIFO (and pump()'s
    // hasSpeech gate) entirely — the regression this exists to catch (enqueue()
    // dropping `language` off the Job so transcribe() falls back to the spawn-time -l
    // flag) would have left it green. Driving it through enqueue()/drain() for real
    // means the PCM has to actually survive pump()'s hasSpeech gate — genuine recorded
    // speech (the same fixture voices.test.ts uses), not a loud tone: a real Silero
    // model does not hear a synthetic waveform as speech, only real speech does.
    await writeFile(model(ASR_MODELS.turbo.file), '')
    await writeFile(bin, FAKE_SERVER)
    await chmod(bin, 0o755)

    const wav = await readFile(SPEECH_FIXTURE)
    const speech = new Int16Array(wav.buffer, wav.byteOffset + 44, Math.min(32000, (wav.length - 44) / 2))

    const received: { track: string; language: string }[] = []
    const whisper = await Whisper.start({
      language: 'th', // the spawn-time -l flag — every job below must override it
      model: model(ASR_MODELS.turbo.file),
      noiseFilter: async () => 'low',
      onSegments: (track, segments) => {
        for (const s of segments) received.push({ track, language: s.text })
      },
      onDepth: () => {},
    })
    try {
      // Two different tracks, two different languages, spanning what a batch pass over
      // meetings recorded in different languages actually queues — the whole point of
      // a per-Job language instead of a spawn-time setting.
      whisper.enqueue('loopback', { pcm: speech, startSec: 0 }, 'en')
      whisper.enqueue('mic', { pcm: speech, startSec: 1 }, 'th')
      await whisper.drain()

      assert.deepEqual(received, [
        { track: 'loopback', language: 'en' },
        { track: 'mic', language: 'th' },
      ])
    } finally {
      whisper.stop()
    }
  },
)
