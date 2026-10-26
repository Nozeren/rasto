/**
 * Posts a saved recording to a TestRail run: for each case with a TestRail id and a result, a result (Pass / Fail /
 * Blocked, the time it took, a comment with every step and its time in the video) with the evidence attached: the
 * case's clip (or the whole video), its failure clip, the step log and the .har.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { caseLabel, caseSpans, SavedClip } from './clips';
import { formatTime, isGuideRun, LoggedCase, NetworkSummary, RecordingMeta } from './output';
import { addAttachmentToResult, addResultForCase, parseCaseId, STATUS_ID } from './testrail';

export interface SavedRecording {
  /** Absolute paths. */
  video: string;
  log: string;
  har?: string;
  /** Paths relative to the recording's folder (as in the step log). */
  clips: SavedClip[];
  meta: RecordingMeta;
  subject: string;
  config: string;
  network?: NetworkSummary;
}

export interface CaseOutcome {
  case: string;
  status: 'posted' | 'skipped' | 'error';
  detail: string;
}

/** TestRail's elapsed format ("1m 5s"); undefined under a second, which TestRail refuses. */
export function elapsed(ms: number): string | undefined {
  const total = Math.round(ms / 1000);
  if (total < 1) return undefined;
  const parts = [[Math.floor(total / 3600), 'h'], [Math.floor(total / 60) % 60, 'm'], [total % 60, 's']] as const;
  return parts.filter(([n]) => n > 0).map(([n, unit]) => `${n}${unit}`).join(' ');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

async function harCounts(har: string | undefined, label: string): Promise<{ requests: number; failed: number } | null> {
  if (!har) return null;
  try {
    const entries = JSON.parse(await fs.readFile(har, 'utf-8')).log.entries as { _case?: string; response: { status: number; _error?: string } }[];
    const mine = entries.filter((e) => e._case === label);
    const failed = mine.filter((e) => e.response.status >= 400 || (e.response.status === 0 && e.response._error !== 'canceled')).length;
    return { requests: mine.length, failed };
  } catch {
    return null;
  }
}

export async function resultComment(recording: SavedRecording, c: LoggedCase, span: { startMs: number; endMs: number }): Promise<string> {
  const lines = [
    `Recorded with Rasto: **${path.basename(recording.video)}**, from ${formatTime(span.startMs)} to ${formatTime(span.endMs)}`,
    `Subject / config: ${recording.subject} / ${recording.config}`,
  ];
  if (c.row) lines.push(`Examples row: ${c.row}`);
  lines.push('', 'Steps (time in the video):');
  for (const s of c.steps) lines.push(`- ${formatTime(s.atMs)} · ${s.section} ${s.position}/${s.total}: ${`${s.keyword} ${s.text}`.trim()}`);

  const entries = c.steps.flatMap((s) => s.console ?? []);
  if (recording.meta.browserConsole === 'captured') {
    const errors = entries.filter((e) => e.level === 'error').length;
    const warnings = entries.filter((e) => e.level === 'warn').length;
    lines.push('', `Browser console: ${errors || warnings ? [errors && plural(errors, 'error'), warnings && plural(warnings, 'warning')].filter(Boolean).join(', ') : 'no errors or warnings'} (in the step log)`);
  }
  const network = await harCounts(recording.har, caseLabel(c));
  if (network) lines.push(`Network: ${plural(network.requests, 'request')}${network.failed ? `, ${network.failed} failed` : ''} (in the .har)`);
  return lines.join('\n');
}

/** Posts every case of `recording` to run `runId`, one after another; never throws, each case says how it went. */
export async function postRun(runId: number, recording: SavedRecording): Promise<CaseOutcome[]> {
  if (isGuideRun(recording.meta.cases)) return [];
  const folder = path.dirname(recording.video);
  const spans = caseSpans(recording.meta);
  const outcomes: CaseOutcome[] = [];

  for (const span of spans) {
    const c = span.case;
    const label = caseLabel(c);
    const caseId = parseCaseId(c.id);
    if (caseId === null) {
      outcomes.push({ case: label, status: 'skipped', detail: 'no TestRail case id (a @C<id> tag, or a case loaded from TestRail)' });
      continue;
    }
    if (!c.result) {
      outcomes.push({ case: label, status: 'skipped', detail: 'no result (the recording stopped before Pass / Fail / Blocked)' });
      continue;
    }

    let resultId: number;
    try {
      const posted = await addResultForCase(runId, caseId, {
        status_id: STATUS_ID[c.result],
        comment: await resultComment(recording, c, span),
        ...(elapsed(span.endMs - span.startMs) ? { elapsed: elapsed(span.endMs - span.startMs) } : {}),
      });
      resultId = posted.id;
    } catch (error) {
      outcomes.push({ case: label, status: 'error', detail: (error as Error).message });
      continue;
    }

    const mine = recording.clips.filter((clip) => clip.case === label);
    const caseClip = mine.find((clip) => clip.kind === 'case');
    const files = [
      caseClip ? path.join(folder, caseClip.file) : recording.video,
      ...mine.filter((clip) => clip.kind === 'failure').map((clip) => path.join(folder, clip.file)),
      recording.log,
      ...(recording.har ? [recording.har] : []),
    ];
    const failed: string[] = [];
    for (const file of files) {
      await addAttachmentToResult(resultId, file).catch((error: Error) => failed.push(`${path.basename(file)}: ${error.message}`));
    }
    const attached = files.length - failed.length;
    outcomes.push({
      case: label,
      status: 'posted',
      detail: `${c.result}, ${plural(attached, 'attachment')}${failed.length ? `; not attached: ${failed.join('; ')}` : ''}`,
    });
  }
  return outcomes;
}
