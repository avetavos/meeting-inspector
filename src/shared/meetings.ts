import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

export type Segment = { t0: number; t1: number; speaker: string; text: string }

/**
 * Language spoken IN THE MEETING — what whisper decodes to. Lives here (not
 * settings.ts) so a Transcript can carry it without main/settings.ts's electron
 * import following it into every module that just wants the type. A list (not a bare
 * union) so a third language is one entry here, reused by settings.ts's own
 * validation, rather than a union repeated at every call site.
 */
export const MEETING_LANGUAGES = ['th', 'en'] as const
export type MeetingLanguage = (typeof MEETING_LANGUAGES)[number]

export type Transcript = {
  id: string
  startedAt: string
  durationSec: number
  /** Before diarization: just the two tracks. Step 5 replaces `them` with SPEAKER_xx. */
  speakers: Record<string, string>
  segments: Segment[]
  /**
   * Set the moment an ASR pass over this meeting finishes — 'manual' mode (settings.ts)
   * leaves it unset until the user transcribes the meeting from the meetings list. The
   * explicit signal, not `segments.length === 0`: a meeting where nobody spoke would
   * otherwise look untranscribed forever and be re-run on every batch. Absent on
   * transcripts written before this field existed; store.ts's `meetingDone` reads those
   * as done when they have segments, done without a migration step.
   */
  transcribedAt?: string
  /**
   * Captured once, at session:start, the same way Session.mode is (index.ts) — never
   * re-read from settings mid-meeting, because a meeting recorded under one language
   * setting and transcribed later under another must decode as what was actually
   * spoken, not whatever settings.json says today. Written on every path that produces
   * a transcript, including 'manual' mode's segment-less write at session:stop — that
   * write is the only chance to record it, since 'manual' meetings are transcribed on
   * demand, possibly long after the setting has changed again. Absent on transcripts
   * written before this field existed; store.ts's `resolveLanguage` is the one place
   * that fallback is applied, explicitly, to the current setting.
   */
  language?: MeetingLanguage
  /**
   * Which of `speakers`' names came from voices.ts's cross-meeting recognition, and
   * what that voice was called at the moment it was recognised — set by diarizeMeeting
   * (index.ts) alongside `speakers` itself, for every speaker key `identify()` matched
   * this diarize pass. Recomputed from scratch on every diarize pass, never merged with
   * a previous value: a raw `SPEAKER_00` key means something different every run (a
   * fresh clustering, per diarize.ts/voices.ts's own doc comments), so carrying an old
   * entry forward under a key that now means someone else would be actively wrong.
   *
   * Additive and optional so older transcripts stay readable as-is — absent here reads
   * exactly as it always has, `speakers`/`segments` alone. The `name` half is a fallback
   * for exactly one case: this transcript's `speakerVoices` entry outlives the voice it
   * points at (voices.ts's `forget`) — the id then resolves to nothing, and this is the
   * last known name to fall back to before speakerNames()'s own fallbacks.
   *
   * Resolved into a display name — current name for the id, else this stored name,
   * else the existing fallbacks — by voices.ts's resolveSpeakerNames, applied by main
   * (index.ts) to every Transcript handed to the renderer. Never written back to disk:
   * that resolution runs at read time precisely so a rename never needs to walk and
   * rewrite every transcript that mentions the voice.
   */
  speakerVoices?: Record<string, { voiceId: string; name: string }>
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

const STAMPED = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(?:-(.+))?$/

/**
 * A meeting's title is freetext held in its own `meeting.json` (store.ts), not parsed
 * back out of the folder name — so this is the whole display rule: what the user typed,
 * or, for a meeting nobody named, the time it happened as `DD-MM-YYYY HH:mm`.
 */
export const displayTitle = (title: string, startedAt: string): string => title.trim() || whenLabel(startedAt)

const whenLabel = (iso: string): string => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * The title half of a pre-uuid folder name (`2026-08-28-1900-standup` -> `standup`),
 * empty for one that never had a title and null for a folder name that was never a
 * stamped id at all. Read once, by store.ts's one-shot migration into meeting.json;
 * nothing else parses a title out of an id any more.
 */
export const titlePartOf = (id: string): string | null => {
  const stamped = STAMPED.exec(id)
  return stamped ? (stamped[6] ?? '') : null
}

/**
 * What an untitled meeting started now would end up called — the composer offers it as
 * the title field's placeholder, so "leave this blank" has a visible answer. Routed
 * through the same `displayTitle` the list uses, so the placeholder and the row it
 * turns into cannot drift apart.
 */
export const untitledTitle = (at: Date): string => displayTitle('', at.toISOString())

/**
 * Best-effort `startedAt` for a pre-uuid meeting with no meeting.json and no usable
 * transcript.json — parsed straight from the folder name's own timestamp, so store.ts's
 * migration still has something to record instead of dropping the folder (spec item 3).
 */
export const startedAtFromId = (id: string): string | null => {
  const stamped = STAMPED.exec(id)
  if (!stamped) return null
  const [, year, month, day, hour, minute] = stamped
  return `${year}-${month}-${day}T${hour}:${minute}:00`
}

/**
 * Meeting ids address storage keys, so refuse anything that could climb out — and
 * anything empty, which would otherwise resolve to a stray file sitting in the notes
 * root rather than a meeting folder.
 */
export const safeId = (id: string): boolean =>
  id.length > 0 && !id.includes('/') && !id.includes('\\') && !id.startsWith('.')

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
