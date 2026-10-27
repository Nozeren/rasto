/**
 * Where a recording goes and what it is called:
 *   <root>/<subject>/<config>/<seq>_<cases>_<overall>.mp4   (+ the same name with .json for the step log)
 * e.g. ~/Desktop/checkout/staging_chrome/03_C101.guest-C102_fail.mp4
 *
 * A guide is named after its title, without a result, and also gets a .md with its steps as chapters:
 *   <seq>_<title>.mp4 (+ .json, .md), e.g. 01_export-a-report-as-csv.mp4
 */
import { promises as fs } from 'fs';
import path from 'path';
import type { SavedClip } from './clips';
import type { TimelineMark } from './har';
import { OutputSettings } from './settings';

export type CaseResult = 'pass' | 'fail' | 'blocked';

export interface LoggedStep {
  section: string;
  position: number;
  total: number;
  keyword: string;
  text: string;
  /** A guide's part (its "## " heading), for the chapters. */
  part?: string;
  /** Time in the final video (paused time excluded), in milliseconds. */
  atMs: number;
  /** What the browser logged while this step was on screen (⚙ Settings → Browser console). */
  console?: LoggedConsoleEntry[];
  /** What was clicked and typed while this step was on screen (a recorded browser tab, screencast.ts). */
  actions?: LoggedAction[];
  /** Notes the tester (hotkey, HUD) or a script / agent (remote control) added while this step was on screen. */
  notes?: { text: string; atMs: number }[];
}

export interface LoggedAction {
  kind: 'click' | 'type' | 'select' | 'key';
  text: string;
  value?: string;
  atMs: number;
}

export interface LoggedConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
  source?: string;
  atMs: number;
  /** Logged while the recording was paused: not in the video, kept at the pause point. */
  paused?: boolean;
}

export interface LoggedCase {
  id: string;
  /** Examples row value (e.g. "Guest") for an outline, else null. */
  row: string | null;
  title: string;
  result: CaseResult | null;
  /** When Pass / Fail / Blocked was given, in video time: where the case's clip ends (clips.ts). */
  resultAtMs?: number;
  /** A Markdown guide (guide.ts): it ends with Done, recorded as 'pass'. */
  guide?: boolean;
  steps: LoggedStep[];
}

export interface RecordingMeta {
  startedAt: string;
  durationMs: number;
  cases: LoggedCase[];
  /** Set when the browser console was asked for: 'captured', or why it wasn't. */
  browserConsole?: string;
  /** Same for the network (.har). */
  network?: string;
  /** Wall-clock marks (start, pauses, resumes), to place the .har's requests in the video. */
  timeline: TimelineMark[];
}

/** Folder/file safe: spaces and separators become "-", anything unusual is dropped. */
export function slug(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[^\w.@-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function outputFolder(output: OutputSettings): string {
  return path.join(output.root, slug(output.subject) || 'rasto', slug(output.config) || 'default');
}

/** Next sequence number: one more than the highest "NN_" prefix already in the folder. */
export async function nextSeq(folder: string): Promise<number> {
  let highest = 0;
  try {
    for (const name of await fs.readdir(folder)) {
      const match = /^(\d+)[a-z]?_/i.exec(name);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
  } catch {
    // Folder does not exist yet: start at 1.
  }
  return highest + 1;
}

const GUIDE_NAME_MAX = 80;

/** A case's result as shown and logged: a guide that ended with Done is 'done' (it is recorded as 'pass'). */
export function shownResult(c: LoggedCase): string | null {
  return c.guide && c.result ? 'done' : c.result;
}

/** A guide is recorded on its own, so a run with a guide has exactly that one case. */
export function isGuideRun(cases: LoggedCase[]): boolean {
  return cases.length === 1 && !!cases[0].guide;
}

/** A guide's title in a file name: lowercase words joined with "-", e.g. export-a-report-as-csv. */
export function guideToken(title: string): string {
  return slug(title.toLowerCase()).replace(/[.@]/g, '-').replace(/-+/g, '-').slice(0, GUIDE_NAME_MAX).replace(/^-|-$/g, '') || 'guide';
}

/** fail beats blocked beats pass; a case without a result (stopped early) makes the run incomplete. A guide is done or incomplete. */
export function overallResult(cases: LoggedCase[]): string {
  if (isGuideRun(cases)) return cases[0].result ? 'done' : 'incomplete';
  if (!cases.length || cases.every((c) => c.result === null)) return 'result';
  if (cases.some((c) => c.result === 'fail')) return 'fail';
  if (cases.some((c) => c.result === null)) return 'incomplete';
  if (cases.some((c) => c.result === 'blocked')) return 'blocked';
  return 'pass';
}

export function caseToken(c: LoggedCase): string {
  return slug(c.row ? `${c.id}.${c.row.toLowerCase()}` : c.id);
}

export function baseName(seq: number, cases: LoggedCase[]): string {
  const number = String(seq).padStart(2, '0');
  if (isGuideRun(cases)) {
    return `${number}_${guideToken(cases[0].title)}${cases[0].result ? '' : '_incomplete'}`;
  }
  const ids = cases.map(caseToken).join('-') || 'recording';
  return `${number}_${ids}_${overallResult(cases)}`;
}

export function formatTime(ms: number): string {
  const total = ms / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

/** What the .har holds, for the step log: its file name and how many requests (and failed ones) it has. */
export interface NetworkSummary {
  har: string;
  requests: number;
  failed: number;
}

export async function writeStepLog(
  file: string,
  video: string,
  output: OutputSettings,
  meta: RecordingMeta,
  extras: { network?: NetworkSummary; clips?: SavedClip[] } = {},
): Promise<void> {
  const { network, clips } = extras;
  const guide = isGuideRun(meta.cases);
  const log = {
    ...(guide ? { kind: 'guide' } : {}),
    video: path.basename(video),
    subject: output.subject,
    config: output.config,
    startedAt: meta.startedAt,
    duration: formatTime(meta.durationMs),
    overall: overallResult(meta.cases),
    ...(meta.browserConsole ? { browserConsole: meta.browserConsole } : {}),
    ...(network ? { network } : meta.network ? { network: meta.network } : {}),
    ...(clips?.length ? { clips } : {}),
    cases: meta.cases.map((c) => ({
      id: c.id,
      row: c.row,
      title: c.title,
      result: shownResult(c) ?? 'not recorded',
      steps: c.steps.map((s) => ({
        at: formatTime(s.atMs),
        step: `${s.section} ${s.position}/${s.total}`,
        text: `${s.keyword} ${s.text}`.trim(),
        ...(s.console?.length
          ? { console: s.console.map((e) => ({ at: formatTime(e.atMs), level: e.level, text: e.text, ...(e.source ? { source: e.source } : {}), ...(e.paused ? { paused: true } : {}) })) }
          : {}),
        ...(s.actions?.length
          ? { actions: s.actions.map((a) => ({ at: formatTime(a.atMs), kind: a.kind, text: a.text, ...(a.value !== undefined ? { value: a.value } : {}) })) }
          : {}),
        ...(s.notes?.length ? { notes: s.notes.map((n) => ({ at: formatTime(n.atMs), text: n.text })) } : {}),
      })),
    })),
  };
  await fs.writeFile(file, JSON.stringify(log, null, 2));
}

/**
 * A guide's steps as chapters: the title, then each step with the time it first appears in the video ("00:04 2. …"),
 * ready to paste as video chapters or to read as the written guide.
 */
/** Whole seconds as "mm:ss", the format video chapters use. */
function chapterTime(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export async function writeChapters(file: string, meta: RecordingMeta): Promise<void> {
  const guide = meta.cases[0];
  const firstSeen = new Map<number, LoggedStep>();
  for (const step of guide.steps.filter((s) => s.section !== 'Background')) {
    if (!firstSeen.has(step.position)) firstSeen.set(step.position, step);
  }
  const lines: string[] = [];
  let part: string | undefined;
  for (const step of [...firstSeen.values()].sort((a, b) => a.position - b.position)) {
    if (step.part && step.part !== part) {
      part = step.part;
      lines.push('', `## ${part}`);
    }
    lines.push(`${chapterTime(step.atMs)} ${step.position}. ${step.text}`);
  }
  await fs.writeFile(file, `# ${guide.title}\n\n${lines.join('\n').trim()}\n`);
}

export interface HistoryEntry {
  /** 'guide' for a guide's recording; test runs leave it out. */
  kind?: 'guide';
  log: string;
  video: string;
  videoExists: boolean;
  bytes: number;
  subject: string;
  config: string;
  startedAt: string;
  duration: string;
  overall: string;
  cases: { id: string; row: string | null; title: string; result: string; steps: HistoryStep[] }[];
  /** 'captured', or why not; absent when the console was off. */
  browserConsole?: string;
  /** The .har next to the video (absolute), when there is one. */
  har?: string;
  network?: NetworkSummary;
  /** Paths absolute. */
  clips: SavedClip[];
}

/** A step as the step log has it, with what happened during it. */
export interface HistoryStep {
  at: string;
  step: string;
  text: string;
  console?: { at: string; level: string; text: string; source?: string; paused?: boolean }[];
  actions?: { at: string; kind: string; text: string; value?: string }[];
  notes?: { at: string; text: string }[];
}

export interface HistoryRequest {
  /** Seconds into the video. */
  at: number;
  method: string;
  url: string;
  status: number;
  error?: string;
  failed: boolean;
}

const MAX_HISTORY_REQUESTS = 5000;

/** The requests of a .har, for the History screen: when, what, and whether it failed. */
export async function readHarRequests(har: string): Promise<HistoryRequest[]> {
  const entries = JSON.parse(await fs.readFile(har, 'utf-8')).log.entries as {
    _videoTime?: string;
    request: { method: string; url: string };
    response: { status: number; _error?: string };
  }[];
  return entries.slice(0, MAX_HISTORY_REQUESTS).map((e) => {
    const [m, s] = (e._videoTime ?? '00:00').split(':');
    const error = e.response._error;
    return {
      at: Number(m) * 60 + Number(s),
      method: e.request.method,
      url: e.request.url.length > 300 ? `${e.request.url.slice(0, 299)}…` : e.request.url,
      status: e.response.status,
      ...(error ? { error } : {}),
      failed: e.response.status >= 400 || (e.response.status === 0 && error !== 'canceled'),
    };
  });
}

/**
 * Lists recorded runs, newest first, by reading the step logs under <root>/<subject>/<config>/. Only files that look
 * like Rasto logs (a "video" name and a "cases" list) are kept; anything else in those folders is ignored.
 */
export async function listHistory(root: string): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];
  const subdirs = async (dir: string) =>
    (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));

  for (const subjectDir of await subdirs(root)) {
    for (const configDir of await subdirs(subjectDir)) {
      const files = await fs.readdir(configDir).catch(() => [] as string[]);
      for (const file of files.filter((f) => f.endsWith('.json'))) {
        const log = path.join(configDir, file);
        try {
          const data = JSON.parse(await fs.readFile(log, 'utf-8'));
          if (typeof data.video !== 'string' || !Array.isArray(data.cases)) continue;
          const video = path.join(configDir, data.video);
          const stat = await fs.stat(video).catch(() => null);
          const har = typeof data.network === 'object' && data.network?.har ? path.join(configDir, data.network.har) : undefined;
          const harExists = har ? !!(await fs.stat(har).catch(() => null)) : false;
          entries.push({
            kind: data.kind === 'guide' ? 'guide' : undefined,
            log,
            video,
            videoExists: !!stat,
            bytes: stat?.size ?? 0,
            subject: data.subject ?? path.basename(subjectDir),
            config: data.config ?? path.basename(configDir),
            startedAt: data.startedAt ?? '',
            duration: data.duration ?? '',
            overall: data.overall ?? '',
            cases: data.cases,
            ...(data.browserConsole ? { browserConsole: data.browserConsole } : {}),
            ...(harExists ? { har, network: data.network } : {}),
            clips: (Array.isArray(data.clips) ? (data.clips as SavedClip[]) : []).map((c) => ({ ...c, file: path.join(configDir, c.file) })),
          });
        } catch {
          // Not JSON, or not ours.
        }
      }
    }
  }
  return entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
