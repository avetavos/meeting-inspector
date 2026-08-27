import Anthropic from '@anthropic-ai/sdk'

export type Provider = 'claude' | 'openai' | 'gemini' | 'xai'
export type Cost = { inputTokens: number; outputTokens: number; usd: number }
export type ProviderInfo = { label: string; model: string; price: readonly [number, number] }

/**
 * Model ids and prices move faster than this file does — everything volatile lives
 * here, and the model is overridable per provider in settings so a new release does
 * not need a code change. Prices are $/1M tokens, checked 2026-08-27.
 */
export const PROVIDERS = {
  claude: { label: 'Claude', model: 'claude-opus-5', price: [5, 25] },
  openai: { label: 'OpenAI', model: 'gpt-5.6', price: [4, 20] },
  gemini: { label: 'Gemini', model: 'gemini-3.7-flash', price: [0.75, 3.75] },
  xai: { label: 'xAI Grok', model: 'grok-4.6', price: [2, 6] },
} as const satisfies Record<Provider, ProviderInfo>

const SYSTEM = `คุณคือผู้ช่วยสรุปการประชุมของทีมพัฒนาซอฟต์แวร์ไทย

เขียนสรุปเป็นภาษาไทย แต่คงศัพท์เทคนิคไว้เป็นภาษาอังกฤษอย่างที่ทีมพูดกันจริง — deploy, pull request, staging, migration ไม่ต้องแปล

transcript มาจากการถอดเสียงอัตโนมัติ มีคำเพี้ยนได้ เดาจากบริบทได้ถ้ามั่นใจ แต่ถ้าไม่แน่ใจว่าใครพูดหรือพูดว่าอะไร ให้เขียนว่าไม่ชัดเจน ห้ามแต่งเติมสิ่งที่ไม่ได้อยู่ใน transcript

โครงสร้างที่ต้องการ:

## หัวข้อที่คุย
## ข้อสรุปและการตัดสินใจ
## Action item
ใคร / ทำอะไร / เมื่อไหร่ — ถ้าไม่ได้ระบุเวลาให้เขียนว่า "ไม่ได้ระบุ" อย่าเดาเอง
## เรื่องที่ยังค้าง

ถ้าข้อสรุปช่วงต้นถูกล้มไปช่วงท้าย ให้เขียนถึงข้อสรุปสุดท้าย ไม่ใช่ข้อแรก`

const priced = (provider: Provider, inputTokens: number, outputTokens: number): Cost => {
  const [input, output] = PROVIDERS[provider].price
  return {
    inputTokens,
    outputTokens,
    usd: (inputTokens * input + outputTokens * output) / 1_000_000,
  }
}

export const modelFor = (provider: Provider, override?: string): string =>
  override?.trim() || PROVIDERS[provider].model

/**
 * Only Claude can price a request before running it. Elsewhere the run reports what
 * it actually cost — spec §9 wants a measured number, not an estimate, and a made-up
 * pre-flight figure would be exactly the estimate it warns against.
 */
export async function estimate(transcript: string, apiKey: string, model: string): Promise<Cost> {
  const { input_tokens } = await new Anthropic({ apiKey }).messages.countTokens({
    model,
    system: SYSTEM,
    messages: [{ role: 'user', content: transcript }],
  })
  return priced('claude', input_tokens, 0)
}

export async function summarize(
  provider: Provider,
  model: string,
  transcript: string,
  apiKey: string,
  onDelta: (text: string) => void,
): Promise<{ text: string; cost: Cost }> {
  const run =
    provider === 'claude'
      ? claude
      : provider === 'gemini'
        ? gemini
        : (t: string, k: string, m: string, d: (s: string) => void) =>
            // xAI serves the OpenAI chat-completions shape, so one implementation covers both.
            openAiCompatible(provider === 'xai' ? 'https://api.x.ai/v1' : 'https://api.openai.com/v1', t, k, m, d)

  const { text, inputTokens, outputTokens } = await run(transcript, apiKey, model, onDelta)
  return { text, cost: priced(provider, inputTokens, outputTokens) }
}

type Result = { text: string; inputTokens: number; outputTokens: number }

// The whole transcript goes in one request (spec §9): every model here holds a
// three-hour meeting, and summarizing piecewise hides the thing most worth catching —
// a decision made early and reversed later reads as two unrelated conclusions.

async function claude(transcript: string, apiKey: string, model: string, onDelta: (s: string) => void): Promise<Result> {
  const stream = new Anthropic({ apiKey }).beta.messages.stream({
    model,
    max_tokens: 32_000,
    system: SYSTEM,
    messages: [{ role: 'user', content: transcript }],
    thinking: { type: 'adaptive' },
    // Route around a policy decline instead of returning nothing; "default" picks the
    // fallback by refusal category so there is no model list to keep current.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  })
  stream.on('text', onDelta)

  const message = await stream.finalMessage()
  if (message.stop_reason === 'refusal') {
    throw new Error(`Claude ปฏิเสธคำขอ (${message.stop_details?.category ?? 'ไม่ระบุ'})`)
  }
  return {
    text: message.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  }
}

async function openAiCompatible(
  baseUrl: string,
  transcript: string,
  apiKey: string,
  model: string,
  onDelta: (s: string) => void,
): Promise<Result> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      stream: true,
      // Without this the stream never reports usage and the cost line would be blank.
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: transcript },
      ],
      // No token cap on purpose: newer models renamed the parameter, and a summary
      // that stops mid-sentence is worse than one that runs a little long.
    }),
  })
  await throwIfFailed(res)

  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  for await (const data of sse(res)) {
    if (data === '[DONE]') break
    const chunk = JSON.parse(data) as {
      choices?: { delta?: { content?: string } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const delta = chunk.choices?.[0]?.delta?.content
    if (delta) {
      text += delta
      onDelta(delta)
    }
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? 0
      outputTokens = chunk.usage.completion_tokens ?? 0
    }
  }
  return { text, inputTokens, outputTokens }
}

async function gemini(transcript: string, apiKey: string, model: string, onDelta: (s: string) => void): Promise<Result> {
  // generateContent rather than the newer Interactions API: it is still fully
  // supported and its streaming shape is one field deep.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: transcript }] }],
    }),
  })
  await throwIfFailed(res)

  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  for await (const data of sse(res)) {
    const chunk = JSON.parse(data) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    }
    for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
      if (!part.text) continue
      text += part.text
      onDelta(part.text)
    }
    if (chunk.usageMetadata) {
      inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens
      outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens
    }
  }
  return { text, inputTokens, outputTokens }
}

async function throwIfFailed(res: Response): Promise<void> {
  if (res.ok && res.body) return
  throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 400)}`)
}

/** Both non-Claude APIs stream plain `data:` SSE lines; only the payload shape differs. */
async function* sse(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.startsWith('data:')) yield line.slice(5).trim()
    }
  }
}
