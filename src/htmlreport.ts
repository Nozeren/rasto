/**
 * The shareable report: one self-contained .html next to the recording, made from its step log and .har, so it can be
 * sent to someone without Rasto and opened offline. It holds the video (embedded up to EMBED_MAX_BYTES, else played from
 * the .mp4 next to it), the cases and their results, and every step with its time (click to jump the video there), the
 * clicks and typing, the console errors and warnings, and the failed requests while it was on screen. It opens with what
 * a developer wants first: what failed, where, and the errors before it. The step log and the .har ride inside it as
 * downloads, so the one file is all there is to send.
 *
 * It only shows what the step log and the .har already hold, where secrets are already masked. Everything from the page
 * under test (console text, URLs, typed values) is escaped, so nothing in it can run in the report.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { HistoryRequest, readHarRequests } from './output';

/** Bigger videos aren't embedded (the report would get unwieldy to send): the report plays the .mp4 next to it. */
const EMBED_MAX_BYTES = 25 * 1024 * 1024;
/** A bigger .har stays out of the report (it's next to the video). */
const ATTACH_MAX_BYTES = 15 * 1024 * 1024;

interface LogStep {
  at: string;
  step: string;
  text: string;
  console?: { at: string; level: string; text: string; source?: string; paused?: boolean }[];
  actions?: { at: string; kind: string; text: string; value?: string }[];
  notes?: { at: string; text: string }[];
}

interface LogCase {
  id: string;
  row: string | null;
  title: string;
  result: string;
  steps: LogStep[];
}

interface StepLog {
  kind?: string;
  video: string;
  subject: string;
  config: string;
  startedAt: string;
  duration: string;
  overall: string;
  network?: { har: string; requests: number; failed: number } | string;
  clips?: { case: string; kind: string; file: string; from: string; to: string }[];
  cases: LogCase[];
}

const escape = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);

/** "01:23.4" → 83.4 */
export function seconds(at: string): number {
  return at.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

const FILE_INFO: Record<string, string> = {
  '.har': 'every request with headers and timings, secrets masked: open in Chrome DevTools → Network → Import',
  '.json': 'the step log: each step with its time, console and actions',
};

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

const RESULT_LABEL: Record<string, string> = { pass: 'Passed', fail: 'Failed', blocked: 'Blocked', incomplete: 'Incomplete' };

function caseName(c: LogCase): string {
  return c.row ? `${c.id} · ${c.row}` : c.id;
}

/** Which requests happened while each step was on screen: from its time to the next step's (in any case). */
function requestsByStep(cases: LogCase[], requests: HistoryRequest[]): Map<LogStep, HistoryRequest[]> {
  const steps = cases.flatMap((c) => c.steps).sort((a, b) => seconds(a.at) - seconds(b.at));
  const byStep = new Map<LogStep, HistoryRequest[]>(steps.map((s) => [s, []]));
  for (const request of requests) {
    let owner: LogStep | undefined;
    for (const step of steps) {
      if (seconds(step.at) <= request.at) owner = step;
      else break;
    }
    if (owner) byStep.get(owner)?.push(request);
  }
  return byStep;
}

const clock = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;

/** A time that jumps the video there when clicked. */
const timeButton = (at: string | number, label?: string) => {
  const t = typeof at === 'number' ? at : seconds(at);
  return `<button class="t" data-t="${t}">${escape(label ?? (typeof at === 'number' ? clock(at) : at))}</button>`;
};

interface StepEvidence {
  errors: NonNullable<LogStep['console']>;
  warnings: NonNullable<LogStep['console']>;
  requests: HistoryRequest[];
  failed: HistoryRequest[];
}

function evidence(step: LogStep, requests: HistoryRequest[]): StepEvidence {
  return {
    errors: step.console?.filter((e) => e.level === 'error') ?? [],
    warnings: step.console?.filter((e) => e.level === 'warn') ?? [],
    requests,
    failed: requests.filter((r) => r.failed),
  };
}

/** The step on screen when a case got Fail or Blocked: its last logged step. */
const failingStep = (c: LogCase): LogStep | undefined => (c.result === 'fail' || c.result === 'blocked' ? c.steps[c.steps.length - 1] : undefined);

/** A case's notes, with the step each was made on. */
const notesOf = (c: LogCase) => c.steps.flatMap((s) => (s.notes ?? []).map((n) => ({ ...n, step: s.step })));

/**
 * The console errors and failed requests of a failed case, up to the failure, newest first: the cause often shows a
 * step or two before the check that fails. Each with its time and step.
 */
function problemLines(c: LogCase, byStep: Map<LogStep, HistoryRequest[]>, max = 6): string[] {
  const lines = c.steps.flatMap((step) => {
    const e = evidence(step, byStep.get(step) ?? []);
    const where = `<span class="label">${escape(step.step)}</span>`;
    return [
      ...e.errors.map((x) => ({ at: seconds(x.at), html: `${timeButton(x.at)} ${where} <span class="err">${escape(x.text)}</span>` })),
      ...e.failed.map((r) => ({ at: r.at, html: `${timeButton(r.at)} ${where} <span class="err">${escape(r.method)} ${r.status || escape(r.error ?? 'failed')} ${escape(r.url)}</span>` })),
    ];
  });
  return lines.sort((a, b) => b.at - a.at).slice(0, max).map((l) => l.html);
}

function stepHtml(step: LogStep, requests: HistoryRequest[], failedHere: string | null): string {
  const e = evidence(step, requests);
  const summary = [
    e.errors.length && plural(e.errors.length, 'error'),
    e.warnings.length && plural(e.warnings.length, 'warning'),
    e.requests.length && (e.failed.length ? `${e.failed.length} of ${plural(e.requests.length, 'request')} failed` : plural(e.requests.length, 'request')),
    step.actions?.length && `${plural(step.actions.length, 'click')} / typing`,
    step.notes?.length && plural(step.notes.length, 'note'),
  ].filter(Boolean);

  const events = [
    ...(step.actions ?? []).map((a) => ({ at: seconds(a.at), html: `${timeButton(a.at)}<span>${escape(a.kind[0].toUpperCase() + a.kind.slice(1))} · ${escape(a.text)}${a.value !== undefined ? `: ${escape(a.value)}` : ''}</span>` })),
    ...[...e.errors, ...e.warnings].map((x) => ({ at: seconds(x.at), html: `${timeButton(x.at)}<span class="${x.level === 'error' ? 'err' : 'warn'}">${escape(x.text)}${x.source ? ` <small>${escape(x.source)}</small>` : ''}</span>` })),
    ...e.failed.map((r) => ({ at: r.at, html: `${timeButton(r.at)}<span class="err">${escape(r.method)} ${r.status || escape(r.error ?? 'failed')} ${escape(r.url)}</span>` })),
    ...(step.notes ?? []).map((n) => ({ at: seconds(n.at), html: `${timeButton(n.at)}<span class="note">Note · ${escape(n.text)}</span>` })),
  ].sort((a, b) => a.at - b.at);

  // Notes are what the tester (or the agent) wanted a reader to see: always open.
  const bad = e.errors.length || e.failed.length || failedHere || step.notes?.length;
  return `<li class="step${failedHere ? ' failed-here' : ''}">
    <div class="row">${timeButton(step.at)}<span class="label">${escape(step.step)}</span><span class="text">${escape(step.text)}${failedHere ? ` <span class="here">${failedHere}</span>` : ''}</span></div>
    ${summary.length ? `<details${bad ? ' open' : ''}><summary class="${e.errors.length || e.failed.length ? 'err' : ''}">${summary.join(' · ')}</summary>
      <ul class="events">${events.map((x) => `<li>${x.html}</li>`).join('')}</ul></details>` : ''}
  </li>`;
}

/** Plain text of the run, for "Copy summary" (to paste into a bug ticket). */
function summaryText(log: StepLog, byStep: Map<LogStep, HistoryRequest[]>, when: string): string {
  const lines = [`Rasto report: ${log.video} (${log.subject} / ${log.config}, ${when}, ${log.duration})`, ''];
  for (const c of log.cases) {
    lines.push(`${(RESULT_LABEL[c.result] ?? c.result).toUpperCase()}  ${caseName(c)}  ${c.title}`);
    for (const step of c.steps) {
      lines.push(`  ${step.at}  ${step.step.padEnd(15)} ${step.text}`);
      for (const n of step.notes ?? []) lines.push(`    ${n.at}  note: ${n.text}`);
    }
    const at = failingStep(c);
    if (at) {
      lines.push(`  → ${RESULT_LABEL[c.result]} at ${at.at}, ${at.step}: ${at.text}`);
      for (const step of c.steps) {
        const e = evidence(step, byStep.get(step) ?? []);
        for (const x of e.errors) lines.push(`    ${x.at} console error (${step.step}): ${x.text}`);
        for (const r of e.failed) lines.push(`    ${clock(r.at)} request failed (${step.step}): ${r.method} ${r.status || r.error || 'failed'} ${r.url}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Files carried inside the report, for the "Files" downloads: name and contents. */
export interface Attachment {
  name: string;
  data: Buffer;
  type: string;
}

export function reportHtml(log: StepLog, videoSrc: string, requests: HistoryRequest[], attachments: Attachment[] = []): string {
  const byStep = requestsByStep(log.cases, requests);
  const consoleOf = (level: string) => log.cases.flatMap((c) => c.steps.flatMap((s) => s.console ?? [])).filter((e) => e.level === level).length;
  const network = typeof log.network === 'object' ? log.network : null;
  const started = new Date(log.startedAt);
  const when = isNaN(started.getTime()) ? log.startedAt : started.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const problems = log.cases.filter(failingStep);
  const passed = log.cases.filter((c) => c.result === 'pass').length;

  const headline = problems.length
    ? `${problems.length} of ${plural(log.cases.length, 'case')} ${problems.every((c) => c.result === 'blocked') ? 'blocked' : 'failed'}`
    : log.cases.length ? `${log.cases.length === 1 ? 'The case' : `All ${log.cases.length} cases`} passed` : 'Recording';
  const chips = [
    consoleOf('error') || consoleOf('warn') ? `<span class="chip${consoleOf('error') ? ' err' : ''}">Console: ${plural(consoleOf('error'), 'error')}, ${plural(consoleOf('warn'), 'warning')}</span>` : '',
    network ? `<span class="chip${network.failed ? ' err' : ''}">Network: ${plural(network.requests, 'request')}${network.failed ? `, ${network.failed} failed` : ''}</span>` : '',
    `<span class="chip">${plural(passed, 'case')} passed</span>`,
  ].join('');

  // What a developer wants first: what broke, where, and the evidence, one click from the moment in the video.
  const panel = problems.length
    ? `<section class="panel bad"><h2>What went wrong</h2>${problems.map((c) => {
        const at = failingStep(c) as LogStep;
        const lines = problemLines(c, byStep);
        return `<div class="problem">
          <div><span class="pill ${escape(c.result)}">${escape(RESULT_LABEL[c.result])}</span> <b>${escape(caseName(c))}</b> ${escape(c.title)}</div>
          <div class="where">${c.result === 'blocked' ? 'Blocked' : 'Failed'} at ${timeButton(at.at)} <span class="label">${escape(at.step)}</span> ${escape(at.text)}</div>
          ${lines.length ? `<div class="muted small">Errors and failed requests before it, latest first:</div><ul class="lines">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>` : '<div class="muted">No console error or failed request in this case: the video shows what was on screen.</div>'}
          ${notesOf(c).length ? `<div class="muted small">Notes:</div><ul class="lines">${notesOf(c).map((n) => `<li>${timeButton(n.at)} <span class="label">${escape(n.step)}</span> <span class="note">${escape(n.text)}</span></li>`).join('')}</ul>` : ''}
          <button class="t watch" data-t="${Math.max(0, seconds(at.at) - 4)}">▶ Watch the failure</button>
        </div>`;
      }).join('')}</section>`
    : log.cases.length ? `<section class="panel good"><h2>Everything passed</h2><div>${plural(log.cases.length, 'case')}, no failures.</div></section>` : '';

  const clips = log.clips?.length
    ? `<h3>Clips</h3><ul class="clips">${log.clips.map((c) => `<li><button class="t" data-t="${seconds(c.from)}" data-end="${seconds(c.to)}">${escape(c.from)} → ${escape(c.to)}</button> ${escape(c.case)} <small>${c.kind === 'failure' ? 'the seconds before Fail' : 'the whole case'}</small></li>`).join('')}</ul>`
    : '';
  const caseHtml = (c: LogCase) => {
    const failing = failingStep(c);
    const steps = `<ul>${c.steps.map((s) => stepHtml(s, byStep.get(s) ?? [], s === failing ? (c.result === 'blocked' ? 'Blocked here' : 'Failed here') : null)).join('')}</ul>`;
    const head = `<span class="pill ${escape(c.result)}">${escape(RESULT_LABEL[c.result] ?? c.result)}</span><b>${escape(caseName(c))}</b><span>${escape(c.title)}</span>`;
    // Passed cases fold to one line, so the failure is what stands out.
    return c.result === 'pass'
      ? `<section class="case"><details class="fold"><summary class="case-head">${head}<span class="muted">${plural(c.steps.length, 'step')}</span></summary>${steps}</details></section>`
      : `<section class="case"><div class="case-head">${head}</div>${steps}</section>`;
  };

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(headline)} · ${escape(log.video)} · Rasto report</title>
<style>
  :root{--bg:#f6f7f9;--card:#fff;--ink:#1f2328;--muted:#656d76;--line:#d8dee4;--accent:#0969da;--pass:#1a7f37;--fail:#cf222e;--blocked:#bc4c00;--warn:#9a6700;--note:#7a4d00;--bad-bg:#ffebe9;--good-bg:#dafbe1}
  @media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--ink:#e6edf3;--muted:#8d96a0;--line:#30363d;--accent:#4493f8;--pass:#3fb950;--fail:#f85149;--blocked:#db6d28;--warn:#d29922;--note:#e3b341;--bad-bg:#2d1517;--good-bg:#12261a}}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  main{max-width:1440px;margin:0 auto;padding:24px 16px 60px}
  header .brand{color:var(--muted);font-size:13px;font-weight:600} h1{font-size:24px;margin:2px 0 4px}
  .meta{color:var(--muted);font-size:14px;word-break:break-word}
  .bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0 16px}
  .pill,.chip{display:inline-block;border-radius:99px;padding:2px 10px;font-size:13px;font-weight:700;border:1px solid var(--line)}
  .pill.pass{color:var(--pass);border-color:var(--pass)} .pill.fail{color:var(--fail);border-color:var(--fail)} .pill.blocked,.pill.incomplete{color:var(--blocked);border-color:var(--blocked)}
  .chip.err{color:var(--fail)} .muted{color:var(--muted)} .small{font-size:13px}
  .copy{margin-left:auto;font:600 13px system-ui,sans-serif;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:6px 12px;cursor:pointer}
  .panel{border-radius:12px;padding:14px 18px;margin:0 0 18px;border:1px solid var(--line)} .panel h2{font-size:16px;margin:0 0 8px}
  .panel.bad{background:var(--bad-bg);border-color:var(--fail)} .panel.good{background:var(--good-bg);border-color:var(--pass)}
  .problem+.problem{border-top:1px solid var(--line);margin-top:12px;padding-top:12px} .problem b{font-family:ui-monospace,monospace}
  .where{margin:6px 0} .lines{margin:4px 0 8px;font-size:14px} .lines li{padding:1px 0;word-break:break-word}
  button.t.watch{font:700 14px system-ui,sans-serif;color:#fff;background:var(--fail);border-radius:8px;padding:7px 14px;margin-top:6px;min-width:0}
  button.t.watch:hover{text-decoration:none;filter:brightness(1.1)}
  .help{color:var(--muted);font-size:13px;margin:0 0 14px}
  /* The video stays in view while the steps scroll: beside them on a wide screen, above them (capped) on a narrow one. */
  .layout{display:grid;grid-template-columns:minmax(0,1fr);gap:0 24px;align-items:start}
  .player{position:sticky;top:0;z-index:1;background:var(--bg);padding:8px 0}
  video{width:100%;max-height:40vh;border-radius:10px;background:#000;display:block}
  @media (min-width:1100px){.layout{grid-template-columns:minmax(0,1.2fr) minmax(0,1fr)} .player{top:16px;padding:0} video{max-height:calc(100vh - 32px)}}
  h3{font-size:15px;margin:22px 0 8px} section.case{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:0 0 12px}
  .case-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:4px} .case-head b{font-family:ui-monospace,monospace}
  details.fold{margin:0} details.fold>summary{cursor:pointer;margin:0;color:inherit;font-size:15px} details.fold>summary .muted{font-size:13px;margin-left:auto}
  ul{list-style:none;margin:0;padding:0} .step{border-top:1px solid var(--line);padding:7px 0} .case-head+ul>.step:first-child{border-top:0}
  .step.failed-here{border-left:3px solid var(--fail);padding-left:10px;margin-left:-13px;background:linear-gradient(90deg,var(--bad-bg),transparent 60%)}
  .here{display:inline-block;font-size:12px;font-weight:700;color:#fff;background:var(--fail);border-radius:6px;padding:0 7px;margin-left:6px;vertical-align:1px}
  .row{display:flex;gap:12px;align-items:baseline} .label{color:var(--muted);font-size:13px;min-width:92px} .text{flex:1}
  button.t{font:600 13px ui-monospace,monospace;color:var(--accent);background:none;border:0;padding:0;cursor:pointer;min-width:58px;text-align:left}
  button.t:hover{text-decoration:underline} li.current>.row .text{font-weight:700} li.current>.row button.t::before{content:"▶ ";}
  details{margin:4px 0 0 70px} summary{cursor:pointer;color:var(--muted);font-size:13px} summary.err{color:var(--fail)}
  .events li{display:flex;gap:10px;font-size:13px;padding:2px 0} .events span{word-break:break-word} small{color:var(--muted)}
  .err{color:var(--fail)} .warn{color:var(--warn)} .note{color:var(--note);font-weight:600} .clips li,.files li{padding:3px 0}
  .files a{color:var(--accent);font-weight:600;text-decoration:none} .files a:hover{text-decoration:underline}
  footer{color:var(--muted);font-size:12px;margin-top:30px;line-height:1.7}
  @media print{.player,.copy,button.watch{display:none} details{display:block} details>*{display:block}}
</style></head>
<body><main>
<header><div class="brand">● Rasto report</div><h1>${escape(headline)}</h1>
<div class="meta">${escape(log.video)} · ${escape(log.subject)} / ${escape(log.config)} · ${escape(when)} · ${escape(log.duration)}</div>
<div class="bar">${chips}<button class="copy" id="copy" type="button" title="Plain text of the cases, steps and errors, to paste into a ticket">Copy summary</button></div></header>
${panel}
<p class="help">A video of the test with every step listed: click any time (like ${timeButton(log.cases[0]?.steps[0]?.at ?? 0)}) to jump the video there.${problems.length && passed ? ' Passed cases are folded; click one to see its steps.' : ''}</p>
<div class="layout">
<div class="player"><video id="video" controls preload="metadata" src="${escape(videoSrc)}"></video></div>
<div class="steps">${log.cases.map(caseHtml).join('')}${clips}</div>
</div>
${attachments.length ? `<section class="files"><h3>Files</h3><ul>${attachments.map((a) => `<li><a download="${escape(a.name)}" href="data:${a.type};base64,${a.data.toString('base64')}">⬇ ${escape(a.name)}</a> <small>${escape(FILE_INFO[path.extname(a.name)] ?? '')} · ${escape(size(a.data.length))}</small></li>`).join('')}</ul></section>` : ''}
<footer>Recorded with Rasto${network && !attachments.some((a) => a.name.endsWith('.har')) ? `. Every request, with headers and timings, is in <b>${escape(network.har)}</b>, next to the video` : ''}.</footer>
<textarea id="summary-text" hidden readonly>${escape(summaryText(log, byStep, when))}</textarea>
</main>
<script>
  const video = document.getElementById('video');
  let end = null;
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button.t');
    if (!button) return;
    video.currentTime = Number(button.dataset.t);
    end = button.dataset.end ? Number(button.dataset.end) : null;
    // The video stays in view while the page scrolls, so only bring it back when it's above (narrow screens, at the top).
    if (video.getBoundingClientRect().bottom < 0) video.scrollIntoView({ block: 'nearest' });
    video.play().catch(() => {});
  });
  // A clip plays from its start to its end; the current step is highlighted as the video plays.
  const steps = [...document.querySelectorAll('li.step')].map((li) => ({ li, t: Number(li.querySelector('button.t').dataset.t) })).sort((a, b) => a.t - b.t);
  video.addEventListener('timeupdate', () => {
    if (end !== null && video.currentTime >= end) { video.pause(); end = null; }
    let current = null;
    for (const s of steps) if (s.t <= video.currentTime + 0.05) current = s;
    for (const s of steps) s.li.classList.toggle('current', s === current);
  });
  const copy = document.getElementById('copy');
  copy.addEventListener('click', async () => {
    const text = document.getElementById('summary-text').value;
    try { await navigator.clipboard.writeText(text); }
    catch { const area = document.getElementById('summary-text'); area.hidden = false; area.select(); document.execCommand('copy'); area.hidden = true; }
    copy.textContent = 'Copied ✓';
    setTimeout(() => (copy.textContent = 'Copy summary'), 1500);
  });
</script>
</body></html>
`;
}

/** Writes <recording>.html next to the step log `logFile` and returns its path. */
export async function writeReport(logFile: string): Promise<string> {
  const folder = path.dirname(logFile);
  const log = JSON.parse(await fs.readFile(logFile, 'utf-8')) as StepLog;
  const video = path.join(folder, log.video);
  const size = (await fs.stat(video).catch(() => null))?.size ?? Infinity;
  const videoSrc = size <= EMBED_MAX_BYTES ? `data:video/mp4;base64,${(await fs.readFile(video)).toString('base64')}` : encodeURI(log.video);
  const har = typeof log.network === 'object' ? path.join(folder, log.network.har) : null;
  const requests = har ? await readHarRequests(har).catch(() => []) : [];
  // The step log and the .har ride inside the report (downloads), so one file is enough to send.
  const attachments: Attachment[] = [{ name: path.basename(logFile), data: await fs.readFile(logFile), type: 'application/json' }];
  if (har) {
    const data = await fs.readFile(har).catch(() => null);
    if (data && data.length <= ATTACH_MAX_BYTES) attachments.push({ name: path.basename(har), data, type: 'application/json' });
  }
  const file = logFile.replace(/\.json$/, '.html');
  await fs.writeFile(file, reportHtml(log, videoSrc, requests, attachments));
  return file;
}
