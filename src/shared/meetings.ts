import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

export type Segment = { t0: number; t1: number; speaker: string; text: string }

export type Transcript = {
  id: string
  startedAt: string
  durationSec: number
  /** Before diarization: just the two tracks. Step 5 replaces `them` with SPEAKER_xx. */
  speakers: Record<string, string>
  segments: Segment[]
}

export type MeetingMeta = {
  id: string
  title: string
  startedAt: string
  durationSec: number
}

/**
 * Reading side of a meeting archive. Summarizing is not in here on purpose: the app
 * is offline, and whichever assistant is connected does the summarizing from the
 * transcript it pulls through these tools.
 */
export interface MeetingStore {
  list(): Promise<MeetingMeta[]>
  transcript(id: string): Promise<Transcript | null>
}

/** The id is `<date>-<time>-<title>`; the title is whatever follows the stamp. */
export const titleOf = (id: string): string => id.replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '')

/** Meeting ids address storage keys, so refuse anything that could climb out. */
export const safeId = (id: string): boolean => !id.includes('/') && !id.includes('\\') && !id.startsWith('.')

const who = (t: Transcript, speaker: string) => t.speakers[speaker] ?? speaker

export function registerTools(server: McpServer, store: MeetingStore): void {
  const text = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  })

  server.registerTool(
    'list_meetings',
    {
      title: 'List meetings',
      description: 'ทุกการประชุมที่บันทึกไว้ ใหม่สุดก่อน — ใช้หาว่าวันไหนประชุมอะไร',
      inputSchema: z.object({}),
    },
    async () => text(await store.list()),
  )

  server.registerTool(
    'get_transcript',
    {
      title: 'Get transcript',
      description: 'transcript เต็มของการประชุมหนึ่ง พร้อมชื่อคนพูด',
      inputSchema: z.object({ id: z.string().describe('meeting id จาก list_meetings') }),
    },
    async ({ id }) => {
      const transcript = await store.transcript(id)
      if (!transcript) throw new Error(`ไม่พบการประชุม ${id}`)
      return text({
        ...transcript,
        segments: transcript.segments.map((s) => ({ ...s, speakerName: who(transcript, s.speaker) })),
      })
    },
  )

  server.registerTool(
    'search_transcripts',
    {
      title: 'Search transcripts',
      description: 'ค้นข้อความข้ามทุกการประชุม คืน segment ที่ตรงพร้อมบริบทรอบข้าง',
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().int().positive().max(200).default(20),
      }),
    },
    // Straight scan, no index (spec §10). Add one the day this is actually slow.
    async ({ query, limit }) => {
      const needle = query.toLowerCase()
      const hits: unknown[] = []
      for (const meeting of await store.list()) {
        const transcript = await store.transcript(meeting.id)
        if (!transcript) continue
        transcript.segments.forEach((segment, i) => {
          if (hits.length >= limit || !segment.text.toLowerCase().includes(needle)) return
          hits.push({
            meetingId: meeting.id,
            t0: segment.t0,
            speaker: who(transcript, segment.speaker),
            text: segment.text,
            context: transcript.segments
              .slice(Math.max(0, i - 2), i + 3)
              .map((s) => `${who(transcript, s.speaker)}: ${s.text}`),
          })
        })
        if (hits.length >= limit) break
      }
      return text({ query, hits })
    },
  )
}
