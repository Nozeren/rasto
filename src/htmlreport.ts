/**
 * The shareable report: one self-contained .html next to the recording, made from its step log and .har, so it can be
 * sent to someone without Rasto and opened offline. It holds the video (embedded up to EMBED_MAX_BYTES, else played from
 * the .mp4 next to it), the cases and their results, and every step with its time (click to jump the video there), the
 * clicks and typing, the console errors and warnings, and the failed requests while it was on screen.
 *
 * It only shows what the step log and the .har already hold, where secrets are already masked. Everything from the page
 * under test (console text, URLs, typed values) is escaped, so nothing in it can run in the report.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { HistoryRequest, readHarRequests } from './output';

/** Bigger videos aren't embedded (the report would get unwieldy to send): the report plays the .mp4 next to it. */
const EMBED_MAX_BYTES = 25 * 1024 * 1024;

interface LogStep {
  at: string;
  step: string;
  text: string;
  console?: { at: string; level: string; text: string; source?: string; paused?: boolean }[];
  actions?: { at: string; kind: string; text: string; value?: string }[];
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

function stepHtml(step: LogStep, requests: HistoryRequest[]): string {
  const errors = step.console?.filter((e) => e.level === 'error') ?? [];
  const warnings = step.console?.filter((e) => e.level === 'warn') ?? [];
  const failed = requests.filter((r) => r.failed);
  const summary = [
    errors.length && `${errors.length} error${errors.length > 1 ? 's' : ''}`,
    warnings.length && `${warnings.length} warning${warnings.length > 1 ? 's' : ''}`,
    requests.length && (failed.length ? `${failed.length} of ${requests.length} requests failed` : `${requests.length} request${requests.length > 1 ? 's' : ''}`),
    step.actions?.length && `${step.actions.length} click${step.actions.length > 1 ? 's' : ''} / typing`,
  ].filter(Boolean);

  const time = (at: string | number) => {
    const s = typeof at === 'number' ? at : seconds(at);
    const label = typeof at === 'number' ? `${String(Math.floor(at / 60)).padStart(2, '0')}:${(at % 60).toFixed(1).padStart(4, '0')}` : at;
    return `<button class="t" data-t="${s}">${escape(label)}</button>`;
  };
  const events = [
    ...(step.actions ?? []).map((a) => ({ at: seconds(a.at), html: `${time(a.at)}<span>${escape(a.kind[0].toUpperCase() + a.kind.slice(1))} · ${escape(a.text)}${a.value !== undefined ? `: ${escape(a.value)}` : ''}</span>` })),
    ...[...errors, ...warnings].map((e) => ({ at: seconds(e.at), html: `${time(e.at)}<span class="${e.level === 'error' ? 'err' : 'warn'}">${escape(e.text)}${e.source ? ` <small>${escape(e.source)}</small>` : ''}</span>` })),
    ...failed.map((r) => ({ at: r.at, html: `${time(r.at)}<span class="err">${escape(r.method)} ${r.status || escape(r.error ?? 'failed')} ${escape(r.url)}</span>` })),
  ].sort((a, b) => a.at - b.at);

  const bad = errors.length || failed.length;
  return `<li class="step">
    <div class="row">${time(step.at)}<span class="label">${escape(step.step)}</span><span class="text">${escape(step.text)}</span></div>
    ${summary.length ? `<details${bad ? ' open' : ''}><summary class="${bad ? 'err' : ''}">${summary.join(' · ')}</summary>
      <ul class="events">${events.map((e) => `<li>${e.html}</li>`).join('')}</ul></details>` : ''}
  </li>`;
}

export function reportHtml(log: StepLog, videoSrc: string, requests: HistoryRequest[]): string {
  const byStep = requestsByStep(log.cases, requests);
  const consoleOf = (level: string) => log.cases.flatMap((c) => c.steps.flatMap((s) => s.console ?? [])).filter((e) => e.level === level).length;
  const network = typeof log.network === 'object' ? log.network : null;
  const started = new Date(log.startedAt);
  const chips = [
    `<span class="pill ${escape(log.overall)}">${escape(RESULT_LABEL[log.overall] ?? log.overall)}</span>`,
    consoleOf('error') || consoleOf('warn') ? `<span class="chip err">Console: ${plural(consoleOf('error'), 'error')}, ${plural(consoleOf('warn'), 'warning')}</span>` : '',
    network ? `<span class="chip${network.failed ? ' err' : ''}">Network: ${plural(network.requests, 'request')}${network.failed ? `, ${network.failed} failed` : ''}</span>` : '',
  ].join('');
  const clips = log.clips?.length
    ? `<h2>Clips</h2><ul class="clips">${log.clips.map((c) => `<li><button class="t" data-t="${seconds(c.from)}" data-end="${seconds(c.to)}">${escape(c.from)} → ${escape(c.to)}</button> ${escape(c.case)} <small>${c.kind === 'failure' ? 'before Fail' : 'case'}</small></li>`).join('')}</ul>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(log.video)} · Rasto report</title>
<style>
  :root{--bg:#f6f7f9;--card:#fff;--ink:#1f2328;--muted:#656d76;--line:#d8dee4;--accent:#0969da;--pass:#1a7f37;--fail:#cf222e;--blocked:#bc4c00;--warn:#9a6700}
  @media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161b22;--ink:#e6edf3;--muted:#8d96a0;--line:#30363d;--accent:#4493f8;--pass:#3fb950;--fail:#f85149;--blocked:#db6d28;--warn:#d29922}}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  main{max-width:1440px;margin:0 auto;padding:24px 16px 60px}
  header .brand{color:var(--muted);font-size:13px;font-weight:600} h1{font-size:22px;margin:4px 0 6px;word-break:break-all}
  .meta{color:var(--muted);font-size:14px} .chips{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 18px}
  .pill,.chip{display:inline-block;border-radius:99px;padding:2px 10px;font-size:13px;font-weight:700;border:1px solid var(--line)}
  .pill.pass{color:var(--pass);border-color:var(--pass)} .pill.fail{color:var(--fail);border-color:var(--fail)} .pill.blocked,.pill.incomplete{color:var(--blocked);border-color:var(--blocked)}
  .chip.err{color:var(--fail)}
    /* The video stays in view while the steps scroll: beside them on a wide screen, above them (capped) on a narrow one. */
  .layout{display:grid;grid-template-columns:minmax(0,1fr);gap:0 24px;align-items:start}
  .player{position:sticky;top:0;z-index:1;background:var(--bg);padding:8px 0}
  video{width:100%;max-height:40vh;border-radius:10px;background:#000;display:block}
  @media (min-width:1100px){.layout{grid-template-columns:minmax(0,1.2fr) minmax(0,1fr)} .player{top:16px;padding:0} video{max-height:calc(100vh - 32px)}}
  h2{font-size:17px;margin:26px 0 8px} section.case{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:0 0 14px}
  .case-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap} .case-head b{font-family:ui-monospace,monospace}
  ul{list-style:none;margin:0;padding:0} .step{border-top:1px solid var(--line);padding:7px 0} .step:first-child{border-top:0}
  .row{display:flex;gap:12px;align-items:baseline} .label{color:var(--muted);font-size:13px;min-width:92px} .text{flex:1}
  button.t{font:600 13px ui-monospace,monospace;color:var(--accent);background:none;border:0;padding:0;cursor:pointer;min-width:58px;text-align:left}
  button.t:hover{text-decoration:underline} li.current>.row .text{font-weight:700}
  details{margin:4px 0 0 70px} summary{cursor:pointer;color:var(--muted);font-size:13px} summary.err{color:var(--fail)}
  .events li{display:flex;gap:10px;font-size:13px;padding:2px 0} .events span{word-break:break-word} small{color:var(--muted)}
  .err{color:var(--fail)} .warn{color:var(--warn)} .clips li{padding:3px 0}
  footer{color:var(--muted);font-size:12px;margin-top:30px}
  @media print{video{display:none} details{display:block} details>*{display:block}}
</style></head>
<body><main>
<header><div class="brand">● Rasto report</div><h1>${escape(log.video)}</h1>
<div class="meta">${escape(log.subject)} / ${escape(log.config)} · ${escape(isNaN(started.getTime()) ? log.startedAt : started.toLocaleString('en-GB'))} · ${escape(log.duration)}</div>
<div class="chips">${chips}</div></header>
<div class="layout">
<div class="player"><video id="video" controls preload="metadata" src="${escape(videoSrc)}"></video></div>
<div class="steps">
${log.cases.map((c) => `<section class="case">
  <div class="case-head"><span class="pill ${escape(c.result)}">${escape(RESULT_LABEL[c.result] ?? c.result)}</span><b>${escape(caseName(c))}</b><span>${escape(c.title)}</span></div>
  <ul>${c.steps.map((s) => stepHtml(s, byStep.get(s) ?? [])).join('')}</ul>
</section>`).join('')}
${clips}
</div>
</div>
<footer>Made by Rasto from ${escape(log.video.replace(/\.mp4$/, '.json'))}${network ? ` and ${escape(network.har)}` : ''}. Click a time to jump the video there.</footer>
</main>
<script>
  const video = document.getElementById('video');
  let end = null;
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button.t');
    if (!button) return;
    video.currentTime = Number(button.dataset.t);
    end = button.dataset.end ? Number(button.dataset.end) : null;
    // The video is always in view (it stays put while the steps scroll), so the page doesn't move.
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
  const file = logFile.replace(/\.json$/, '.html');
  await fs.writeFile(file, reportHtml(log, videoSrc, requests));
  return file;
}
