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
 * The meeting being recorded right now, as far as it has got — not a Transcript,
 * because it deliberately is not one yet: there is no `durationSec` that will not
 * change, no diarization, and nothing to call transcribed.
 *
 * `transcribing` is false for a meeting recorded in 'after' or 'manual' mode, where
 * nothing is decoded until the recording ends (settings.ts's TranscribeMode). Saying so
 * matters: an empty `segments` under a mode that transcribes live means nobody has
 * spoken yet, and under a mode that does not it means the words exist but have not been
 * decoded — an assistant that cannot tell those apart will confidently report an empty
 * meeting.
 */
export type LiveMeeting = {
  id: string
  title: string
  startedAt: string
  /** Audio actually recorded so far, which is not wall-clock — a paused meeting stops
   * accumulating (wav.ts's WavWriter.durationSec). */
  recordedSec: number
  transcribing: boolean
  speakers: Record<string, string>
  segments: Segment[]
}

/**
 * Reading side of a meeting archive. Summarizing is not in here on purpose: the app
 * is offline, and whichever assistant is connected does the summarizing from the
 * transcript it pulls through these tools.
 *
 * `live` is the one thing here that is not on disk: the recording still in progress,
 * read straight out of the app's memory. Optional so a store that has no notion of a
 * live session (a test fixture, a future read-only archive) simply does not offer it,
 * and `current_meeting` answers "nothing is being recorded" rather than failing.
 */
export interface MeetingStore {
  list(): Promise<MeetingMeta[]>
  transcript(id: string): Promise<Transcript | null>
  live?(): Promise<LiveMeeting | null>
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

  /**
   * The meeting happening RIGHT NOW — the whole point of asking an assistant something
   * mid-meeting ("what did we just agree to?", "did anyone answer my question?").
   *
   * Separate from `list_meetings`/`get_transcript` rather than folded into them even
   * though the live meeting also reaches disk every few seconds now (index.ts's
   * startLiveFlush): those two answer from a file that is up to fifteen seconds behind
   * and cannot say whether the meeting is still going, and "the meeting I am in" is a
   * question with exactly one answer, not something to find by sorting a list by date.
   */
  server.registerTool(
    'current_meeting',
    {
      title: 'Current meeting',
      description: 'การประชุมที่กำลังอัดอยู่ตอนนี้ พร้อมบทพูดเท่าที่ถอดได้ถึงวินาทีนี้ — ใช้ตอบคำถามระหว่างประชุม',
      inputSchema: z.object({}),
    },
    async () => {
      const live = await store.live?.()
      if (!live) return text({ recording: false })
      return text({
        recording: true,
        ...live,
        segments: live.segments.map((s) => ({ ...s, speakerName: live.speakers[s.speaker] ?? s.speaker })),
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
