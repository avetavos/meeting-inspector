/**
 * The meetings-list batch queue (spec item 4): 'manual' mode (and any 'after'/'live'
 * meeting a previous attempt failed on) leaves a recording untranscribed until the
 * user picks it from the list, one or many at once. No Electron import here on
 * purpose — index.ts wires this to the real whisper pass; tests drive it with a stub
 * `transcribe` so the queue's own sequencing is checked without spawning whisper-server.
 */

export type BatchProgress = { id: string; index: number; total: number }
export type BatchItemStatus = 'done' | 'failed'

/**
 * Runs `ids` one at a time, in that order — never in parallel, two whisper passes at
 * once would double the memory this whole feature exists to control. A failure on one
 * meeting is reported through `onItemDone` and does not stop the rest of the queue.
 *
 * `signal` is checked before each meeting starts, so a cancel takes effect before the
 * next one begins, and is also handed to `transcribe`, which is expected to check it
 * mid-pass and throw if aborted. Either way, this function only ever calls `onItemDone`
 * with 'done' after `transcribe` resolves — a meeting that throws because it was
 * aborted is reported 'failed' like any other error, but nothing here marks it done, so
 * it is left exactly as "not transcribed yet" reads it (spec item 2 — the caller never
 * gets asked to write a "done" marker for it).
 */
export async function runBatch(
  ids: string[],
  transcribe: (id: string, onProgress: (fraction: number) => void, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  onStart: (progress: BatchProgress) => void,
  onProgress: (progress: BatchProgress, fraction: number) => void,
  onItemDone: (progress: BatchProgress, status: BatchItemStatus, error?: string) => void,
): Promise<{ cancelled: boolean }> {
  for (const [i, id] of ids.entries()) {
    if (signal.aborted) break
    const progress: BatchProgress = { id, index: i + 1, total: ids.length }
    onStart(progress)
    try {
      await transcribe(id, (fraction) => onProgress(progress, fraction), signal)
      onItemDone(progress, 'done')
    } catch (err) {
      onItemDone(progress, 'failed', err instanceof Error ? err.message : String(err))
    }
  }
  return { cancelled: signal.aborted }
}
