import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-opus-5'

/** $ per token, from the published Claude Opus 5 rates. */
const PRICE = { input: 5 / 1_000_000, output: 25 / 1_000_000 }

export type Cost = { inputTokens: number; outputTokens: number; usd: number }

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

const request = (transcript: string) => ({
  model: MODEL,
  max_tokens: 32_000,
  system: SYSTEM,
  // The whole transcript goes in one request (spec §9): a 1M context holds a 3h meeting,
  // and summarizing piecewise hides exactly the things worth catching — a decision made
  // early and reversed later reads as two unrelated conclusions.
  messages: [{ role: 'user' as const, content: transcript }],
})

/** Real numbers before spending anything (spec §9) — Thai runs more tokens per word. */
export async function estimate(transcript: string, apiKey: string): Promise<Cost> {
  const client = new Anthropic({ apiKey })
  const { input_tokens } = await client.messages.countTokens(request(transcript))
  return { inputTokens: input_tokens, outputTokens: 0, usd: input_tokens * PRICE.input }
}

export async function summarize(
  transcript: string,
  apiKey: string,
  onDelta: (text: string) => void,
): Promise<{ text: string; cost: Cost }> {
  const client = new Anthropic({ apiKey })

  // Streaming is not optional here: a long transcript would otherwise sit past the
  // HTTP timeout with nothing on screen.
  const stream = client.beta.messages.stream({
    ...request(transcript),
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

  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  const { input_tokens, output_tokens } = message.usage
  return {
    text,
    cost: {
      inputTokens: input_tokens,
      outputTokens: output_tokens,
      usd: input_tokens * PRICE.input + output_tokens * PRICE.output,
    },
  }
}
