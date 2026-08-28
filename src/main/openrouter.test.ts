import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AUDIO_TOKENS_PER_SEC, audioModels, parseSegments, wavBase64 } from './openrouter.ts'

test('openrouter: a model reply becomes segments placed inside the meeting, however it was wrapped', () => {
  // The shape asked for.
  assert.deepEqual(parseSegments('[{"start":1,"end":3,"text":"สวัสดีครับ"}]', 60, 30), [
    { t0: 61, t1: 63, text: 'สวัสดีครับ' },
  ])
  // Wrapped in a fence, with a sentence in front — recoverable, and worth recovering.
  assert.deepEqual(parseSegments('Sure!\n```json\n[{"start":0,"end":2,"text":"hi"}]\n```', 10, 30), [
    { t0: 10, t1: 12, text: 'hi' },
  ])
  // An empty array is a real answer — the clip had no speech — not a parse failure, so
  // it must not fall through to "keep the whole reply as one line".
  assert.deepEqual(parseSegments('[]', 0, 30), [])

  // Prose that ignored the instruction is still a correct transcript of the clip; losing
  // it because of its shape would be the worse failure.
  assert.deepEqual(parseSegments('เอาละครับ เริ่มประชุมกันเลย', 20, 30), [
    { t0: 20, t1: 50, text: 'เอาละครับ เริ่มประชุมกันเลย' },
  ])
  assert.deepEqual(parseSegments('   ', 20, 30), [], 'nothing said, nothing recorded')

  // Times are bounded by the clip: a hallucinated end must not push a line past the end
  // of the meeting, and must never land before its own start.
  assert.deepEqual(parseSegments('[{"start":-5,"end":9000,"text":"x"}]', 100, 30), [
    { t0: 100, t1: 130, text: 'x' },
  ])
  assert.deepEqual(parseSegments('[{"start":10,"end":2,"text":"x"}]', 0, 30), [{ t0: 10, t1: 10, text: 'x' }])
})

test('openrouter: only models that take audio are offered, priced per hour, cheapest first', () => {
  const models = audioModels([
    { id: 'text/only', name: 'Text only', architecture: { input_modalities: ['text'] }, pricing: { prompt: '0.000001' } },
    {
      id: 'cheap/audio',
      name: 'Cheap',
      architecture: { input_modalities: ['text', 'audio'] },
      pricing: { prompt: '0.0000001', audio: '0.0000003' },
    },
    {
      id: 'dear/audio',
      name: 'Dear',
      architecture: { input_modalities: ['audio'] },
      pricing: { prompt: '0.0000001', audio: '0.000003' },
    },
    // Prices audio as ordinary prompt tokens — offerable, but there is no hourly figure
    // to give, so it sorts last rather than looking like the cheapest.
    { id: 'no/audio-price', name: 'Unpriced', architecture: { input_modalities: ['audio'] }, pricing: { prompt: '0.0000002' } },
    // The router's own auto model prices everything as -1 ("depends what it picks").
    { id: 'openrouter/auto', name: 'Auto', architecture: { input_modalities: ['audio'] }, pricing: { prompt: '-1' } },
  ])

  assert.deepEqual(models.map((m) => m.id), ['cheap/audio', 'dear/audio', 'no/audio-price'])
  assert.equal(models[0]!.usdPerMillionAudio, 0.3)
  // 0.0000003 * 32 tokens/s * 3600s
  assert.ok(Math.abs(models[0]!.usdPerHour! - 0.0000003 * AUDIO_TOKENS_PER_SEC * 3600) < 1e-9)
  assert.equal(models[2]!.usdPerHour, null, 'no audio price means no hourly estimate, not a fake one')
})

test('openrouter: a chunk is sent as a real WAV file, not raw samples', () => {
  const pcm = Int16Array.from([0, 1, -1, 32767])
  const bytes = Buffer.from(wavBase64(pcm), 'base64')
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF')
  assert.equal(bytes.subarray(8, 12).toString(), 'WAVE')
  assert.equal(bytes.length, 44 + pcm.byteLength)
  assert.equal(bytes.readUInt32LE(40), pcm.byteLength, 'the data chunk size must match what was actually appended')
})
