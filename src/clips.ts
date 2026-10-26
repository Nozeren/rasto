/**
 * What is made from a saved recording besides the MP4 itself:
 *
 * - Steps inside the MP4: a chapter per step (players list them and jump to them) and a subtitle track with the step,
 *   so the file explains itself without Rasto. Added by a quick copy pass, no re-encoding.
 * - Clips: with several cases, one MP4 per case (from its first step to its result, flash included), and for every
 *   failed case the last seconds before Fail. Saved in a folder named like the recording:
 *     <seq>_<cases>_<overall>/<case>_<result>.mp4, <case>_fail_last-20s.mp4
 */
import { promises as fs } from 'fs';
import path from 'path';
import { runFfmpeg } from './compress';
import { caseToken, formatTime, isGuideRun, LoggedCase, RecordingMeta, shownResult } from './output';

/** How long a result stays on screen after Pass / Fail / Blocked (renderer FLASH_MS); clips keep it. */
export const RESULT_FLASH_MS = 2000;
const MIN_SEGMENT_MS = 100;

export interface Segment {
  startMs: number;
  endMs: number;
  title: string;
}

export function caseLabel(c: LoggedCase): string {
  if (c.guide) return c.title;
  return c.row ? `${c.id} · ${c.row}` : c.id;
}

/** Every step as it was shown, in order, until the next one (or the end): chapters and subtitles. */
export function stepSegments(meta: Pick<RecordingMeta, 'cases' | 'durationMs'>): Segment[] {
  const shown = meta.cases.flatMap((c) =>
    c.steps.map((s) => ({
      atMs: s.atMs,
      title: c.guide
        ? `${s.position}. ${s.text}`
        : `${caseLabel(c)} · ${s.section} ${s.position}/${s.total}: ${`${s.keyword} ${s.text}`.trim()}`,
    })),
  );
  return shown
    .map((s, i) => ({ startMs: s.atMs, endMs: Math.min(shown[i + 1]?.atMs ?? meta.durationMs, meta.durationMs), title: s.title }))
    .filter((s) => s.endMs - s.startMs >= MIN_SEGMENT_MS);
}

/** ffmpeg's metadata format: "=", ";", "#", "\" and newlines are escaped with a backslash. */
function escapeMetadata(value: string): string {
  return value.replace(/[=;#\\\n]/g, (c) => `\\${c === '\n' ? 'n' : c}`);
}

export function ffmetadata(segments: Segment[], title: string): string {
  const lines = [';FFMETADATA1', `title=${escapeMetadata(title)}`];
  for (const s of segments) {
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(s.startMs)}`, `END=${Math.round(s.endMs)}`, `title=${escapeMetadata(s.title)}`);
  }
  return `${lines.join('\n')}\n`;
}

function srtTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(Math.floor(t / 3_600_000))}:${pad(Math.floor(t / 60_000) % 60)}:${pad(Math.floor(t / 1000) % 60)},${pad(t % 1000, 3)}`;
}

export function srt(segments: Segment[]): string {
  return segments.map((s, i) => `${i + 1}\n${srtTime(s.startMs)} --> ${srtTime(s.endMs)}\n${s.title}\n`).join('\n');
}

/** Puts the steps into `video` as chapters and a subtitle track (in place). Copies the video: takes a second or two. */
export async function addStepTracks(video: string, meta: RecordingMeta, title: string): Promise<void> {
  const segments = stepSegments(meta);
  if (!segments.length) return;
  const base = video.replace(/\.mp4$/, '');
  const metadataFile = `${base}.chapters.txt`;
  const subtitleFile = `${base}.steps.srt`;
  const output = `${base}.tracks.mp4`;
  await fs.writeFile(metadataFile, ffmetadata(segments, title));
  await fs.writeFile(subtitleFile, srt(segments));
  try {
    await runFfmpeg([
      '-i', video, '-f', 'ffmetadata', '-i', metadataFile, '-i', subtitleFile,
      '-map', '0:v', '-map', '2:s', '-map_metadata', '1', '-map_chapters', '1',
      '-c:v', 'copy', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=Steps',
      '-movflags', '+faststart', output,
    ]);
    await fs.rename(output, video);
  } finally {
    await Promise.all([metadataFile, subtitleFile, output].map((f) => fs.rm(f, { force: true })));
  }
}

export interface ClipPlan {
  case: LoggedCase;
  kind: 'case' | 'failure';
  startMs: number;
  endMs: number;
  /** File name inside the clips folder. */
  file: string;
}

/** Where each case is in the video: from its first step to its result plus the flash (or to the next case / the end). */
export function caseSpans(meta: Pick<RecordingMeta, 'cases' | 'durationMs'>): { case: LoggedCase; startMs: number; endMs: number }[] {
  const cases = meta.cases.filter((c) => c.steps.length);
  return cases.map((c, i) => {
    const startMs = c.steps[0].atMs;
    const next = cases[i + 1]?.steps[0].atMs ?? meta.durationMs;
    const endMs = c.resultAtMs !== undefined ? c.resultAtMs + RESULT_FLASH_MS : next;
    return { case: c, startMs, endMs: Math.min(meta.durationMs, Math.max(endMs, startMs)) };
  });
}

/**
 * The clips to cut: one per case when the run has several, and the last `failureSec` seconds before each Fail (when the
 * case is longer than that; otherwise its clip, or the video itself, already is the failure).
 */
export function planClips(meta: Pick<RecordingMeta, 'cases' | 'durationMs'>, perCase: boolean, failureSec: number): ClipPlan[] {
  if (isGuideRun(meta.cases)) return [];
  const spans = caseSpans(meta);
  const plans: ClipPlan[] = [];
  const names = new Set<string>();
  const unique = (name: string) => {
    let candidate = name;
    for (let n = 2; names.has(candidate); n++) candidate = name.replace(/\.mp4$/, `_${n}.mp4`);
    names.add(candidate);
    return candidate;
  };
  for (const span of spans) {
    const token = caseToken(span.case);
    if (perCase && spans.length > 1) {
      plans.push({ ...span, kind: 'case', file: unique(`${token}_${shownResult(span.case) ?? 'incomplete'}.mp4`) });
    }
    const failedAt = span.case.result === 'fail' ? span.case.resultAtMs : undefined;
    if (failureSec > 0 && failedAt !== undefined && failedAt - span.startMs > failureSec * 1000) {
      plans.push({
        case: span.case,
        kind: 'failure',
        startMs: failedAt - failureSec * 1000,
        endMs: span.endMs,
        file: unique(`${token}_fail_last-${failureSec}s.mp4`),
      });
    }
  }
  return plans;
}

/** The step segments within [startMs, endMs], cut to it and moved to start at 0: a clip's own subtitles. */
export function clipSegments(segments: Segment[], startMs: number, endMs: number): Segment[] {
  return segments
    .filter((s) => s.endMs > startMs && s.startMs < endMs)
    .map((s) => ({ ...s, startMs: Math.max(s.startMs, startMs) - startMs, endMs: Math.min(s.endMs, endMs) - startMs }))
    .filter((s) => s.endMs - s.startMs >= MIN_SEGMENT_MS);
}

/** Cuts [startMs, endMs] of `source` into `output`, frame-accurate, with the steps of that span as subtitles. */
export async function cutClip(source: string, output: string, startMs: number, endMs: number, segments: Segment[]): Promise<void> {
  const subtitles = clipSegments(segments, startMs, endMs);
  const subtitleFile = output.replace(/\.mp4$/, '.srt');
  if (subtitles.length) await fs.writeFile(subtitleFile, srt(subtitles));
  try {
    await runFfmpeg([
      '-ss', (startMs / 1000).toFixed(3), '-i', source, ...(subtitles.length ? ['-i', subtitleFile] : []),
      '-t', ((endMs - startMs) / 1000).toFixed(3),
      '-map', '0:v', ...(subtitles.length ? ['-map', '1:s'] : []), '-map_chapters', '-1',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
      '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=Steps', '-movflags', '+faststart', output,
    ]);
  } finally {
    await fs.rm(subtitleFile, { force: true });
  }
}

export interface SavedClip {
  case: string;
  kind: 'case' | 'failure';
  /** Path relative to the recording's folder. */
  file: string;
  from: string;
  to: string;
}

/** Cuts every planned clip into `<folder>/<base>/`. A clip that fails is skipped (and logged), the others are kept. */
export async function saveClips(video: string, base: string, plans: ClipPlan[], meta: RecordingMeta): Promise<SavedClip[]> {
  if (!plans.length) return [];
  const segments = stepSegments(meta);
  const folder = path.join(path.dirname(video), base);
  await fs.mkdir(folder, { recursive: true });
  const saved: SavedClip[] = [];
  for (const plan of plans) {
    try {
      await cutClip(video, path.join(folder, plan.file), plan.startMs, plan.endMs, segments);
      saved.push({ case: caseLabel(plan.case), kind: plan.kind, file: `${base}/${plan.file}`, from: formatTime(plan.startMs), to: formatTime(plan.endMs) });
    } catch (error) {
      console.error(`[clips] ${plan.file}: ${(error as Error).message}`);
    }
  }
  if (!saved.length) await fs.rm(folder, { recursive: true, force: true });
  return saved;
}
