/**
 * Renderer (plain script, no imports).
 *
 * Guided flow: ① Cases (load + queue) → ② What to record (source + live preview) → ③ Save to → recording → done.
 * The chosen screen/window is drawn onto a canvas with a banner showing the current Gherkin step, and the canvas is
 * what gets recorded. Global hotkeys (handled in main) move between steps, pause, and close cases with a result.
 */

const CAPTURE_FPS = 15;
const FLASH_MS = 2000;
const BANNER_FONT = '-apple-system, "Segoe UI", Roboto, sans-serif';
const BANNER_BACKGROUND = 'rgba(15, 23, 42, 0.9)';
/** Same blue as .guide-number in hud.css. */
const GUIDE_BADGE_COLOR = '#3b82f6';
/** How long a guide's title card and each part card stay on screen. */
const CARD_MS = 3000;
const CARD_LINES = 3;
const IS_MAC = navigator.platform.toUpperCase().includes('MAC');

type View = 'cases' | 'source' | 'save' | 'recording' | 'done' | 'history';

interface Step {
  keyword: string;
  text: string;
  extra?: string[];
  background?: boolean;
  part?: string;
  /** A guide's part as "Part partNumber of partCount", worked out once in buildCase. */
  partNumber?: number;
  partCount?: number;
}

/** A case ready to record: Background included (if chosen) and Examples placeholders filled in. */
interface ActiveCase {
  id: string;
  /** Banner / queue label, e.g. "C101 · Guest". */
  label: string;
  /** Examples row value (e.g. "Guest"), used in the file name. */
  row: string | null;
  title: string;
  /** A Markdown guide (guide.ts): numbered banner, ends with Done and a closing card, recorded on its own. */
  guide: boolean;
  steps: Step[];
}

const HOTKEY_LABELS: Record<HotkeyAction, string> = {
  next: 'Next step',
  previous: 'Previous step',
  pause: 'Pause / resume',
  pass: 'Case passed',
  fail: 'Case failed',
  blocked: 'Case blocked',
  note: 'Add a note',
};

const RESULT_STYLE: Record<CaseResult, { label: string; color: string }> = {
  pass: { label: 'PASSED', color: '#1f9d55' },
  fail: { label: 'FAILED', color: '#e5484d' },
  blocked: { label: 'BLOCKED', color: '#d97706' },
};

/** The step card's colour for a result: darker than RESULT_STYLE, so its white text stays readable. */
const CARD_RESULT_COLORS: Record<CaseResult, string> = { pass: '#15803d', fail: '#b91c1c', blocked: '#b45309' };

const BANNER_KEYWORD_COLORS: Record<string, string> = {
  Given: '#60a5fa',
  When: '#fbbf24',
  Then: '#34d399',
  And: '#cbd5e1',
  But: '#f87171',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------------------------------------------------------------
// State

let view: View = 'cases';
let settings: AppSettings | null = null;

// Cases
let loadedFeature: GherkinFeature | null = null;
let scenarioIndex = 0;
let rowIndex = 0;
let runTests: RunTest[] = [];
/** The TestRail run last loaded (R100): step ③ offers to post the results to it. */
let loadedRunId: number | null = null;
/** How posting the last recording to TestRail went, for the Done screen and the remote status. */
let testrailOutcome: { state: 'posting' | 'done' | 'error'; run: string; cases?: TestRailCaseOutcome[]; error?: string } | null = null;
let queue: ActiveCase[] = [];

// Source + preview
let selectedSource: CaptureSource | null = null;
let stream: MediaStream | null = null;
/** A browser tab recorded through DevTools (kind 'tab'): its latest frame, drawn like a captured window's. */
let tabFrame: HTMLImageElement | null = null;
let tabStreaming = false;
/** The tab's viewport in CSS pixels (from the last frame), to place clicks on the canvas. */
let tabViewport = { width: 0, height: 0 };
/** The recorded tab's sensitive fields (viewport CSS px), pixelated on every frame; see screencast.ts. */
let blurRects: [number, number, number, number][] = [];
const blurCanvas = document.createElement('canvas');
/** Clicks being drawn as ripples, and the label of the last click or typing (screencast.ts inputTracker). */
let inputRipples: { x: number; y: number; at: number }[] = [];
let inputLabel: { text: string; until: number } | null = null;
/** The step card's bottom corner: the setting, until a click lands under the card and it moves to the other one. */
let cardCorner: 'left' | 'right' | null = null;
/** The last note, shown above the step card for NOTE_MS. */
let noteShown: { text: string; until: number } | null = null;
const NOTE_MS = 4000;
const NOTE_MAX_LENGTH = 500;
/** Where the card was last drawn, in canvas pixels, to know when a click lands under it. */
let cardRect = { x: 0, y: 0, w: 0, h: 0 };
const RIPPLE_MS = 700;
const INPUT_LABEL_MS = 1800;
let drawHandle: number | undefined;

// Recording
// Not named `recorder`: that would clash with the global `window.recorder` API the preload exposes.
let mediaRecorder: MediaRecorder | null = null;
/** Chunks go to main (unsaved.ts) as they come, one after another; finishing waits for the last one. */
let chunkWrites: Promise<void> = Promise.resolve();
let snapshotHandle: number | undefined;
let timerHandle: number | undefined;
let runCases: ActiveCase[] = [];
let runIndex = 0;
let activeCase: ActiveCase | null = null;
let stepIndex = 0;
let paused = false;
let activeMs = 0;
let segmentStart = 0;
let runStartedAt = '';
let finishing = false;
/** A case's result, shown for FLASH_MS on the step card (and the HUD): with the step it happened on and what comes next. */
let flash: { text: string; color: string; until: number; result?: CaseResult; label?: string; step?: { keyword: string; text: string }; at?: string; trailer?: string } | null = null;
/** A guide's title card and part cards, one after another over the whole frame (see showCards). */
interface GuideCard {
  kicker: string;
  title: string;
  from: number;
  until: number;
}
let cards: GuideCard[] = [];
/** The parts whose card was already shown in this recording: going back and forward again doesn't repeat it. */
let shownParts = new Set<number>();
/** The card the HUD was last told about, to update the HUD when a card starts or ends. */
let hudCardTitle: string | null = null;
let loggedCases: LoggedCase[] = [];
/** 'captured', or why the browser console couldn't be; undefined when it's off in ⚙ Settings. */
let browserConsole: string | undefined;
/** Same for the network (.har). */
let browserNetwork: string | undefined;
/** Wall-clock marks (start, pauses, resumes) so main can place the .har's requests in the video. */
let timeline: TimelineMark[] = [];
let lastSavedPath = '';
/** True while the finished recording is being compressed and saved. */
let compressing = false;
let countdownUntil = 0;
let countdownHandle: number | undefined;

// Settings dialog
let capturingAction: HotkeyAction | null = null;

const canvasEl = $<HTMLCanvasElement>('canvas');
const ctx = canvasEl.getContext('2d') as CanvasRenderingContext2D;
const sourceVideo = document.createElement('video');
sourceVideo.muted = true;

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

function setStatus(text: string, kind: 'info' | 'ok' | 'error' = 'info'): void {
  const status = $<HTMLDivElement>('status');
  status.textContent = text;
  status.dataset.kind = kind;
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function isRecording(): boolean {
  return mediaRecorder !== null && mediaRecorder.state !== 'inactive';
}

function elapsedMs(): number {
  return activeMs + (isRecording() && !paused ? Date.now() - segmentStart : 0);
}

function prettyAccelerator(accelerator: string): string {
  if (!accelerator) return '—';
  if (!IS_MAC) return accelerator.replace('Control', 'Ctrl').replace('Command', 'Win');
  const symbols: Record<string, string> = {
    Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘',
    Right: '→', Left: '←', Up: '↑', Down: '↓', Space: '␣',
  };
  return accelerator.split('+').map((part) => symbols[part] ?? part).join('');
}

function acceleratorFromEvent(event: KeyboardEvent): string | null {
  const keyMap: Record<string, string> = {
    ArrowRight: 'Right', ArrowLeft: 'Left', ArrowUp: 'Up', ArrowDown: 'Down',
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace',
    PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End',
  };
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  else if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) key = event.code;
  else key = keyMap[event.code];
  if (!key) return null;

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push(IS_MAC ? 'Command' : 'Super');
  return [...modifiers, key].join('+');
}

function stepLine(step: Step, className = 'step-line'): HTMLDivElement {
  const line = el('div', className);
  if (step.keyword) line.append(el('span', `kw kw-${step.keyword}`, step.keyword), ' ');
  line.append(step.text);
  return line;
}

/** Background and scenario steps are numbered separately: "Background 2/4", "Step 3/10". */
function stepPosition(c: ActiveCase, index: number): { section: string; position: number; total: number } {
  const backgroundCount = c.steps.filter((s) => s.background).length;
  if (c.steps[index]?.background) return { section: 'Background', position: index + 1, total: backgroundCount };
  return { section: 'Step', position: index - backgroundCount + 1, total: c.steps.length - backgroundCount };
}

// ---------------------------------------------------------------------------------------------------------------------
// Navigation

const FLOW: View[] = ['cases', 'source', 'save'];

function canLeave(from: View): string | null {
  if (from === 'cases' && !queue.length && !currentCase()) return 'Load a case first.';
  if (from === 'source' && !selectedSource) return 'Pick a window or screen to record.';
  return null;
}

/**
 * Adds cases to the queue and returns the status message. A guide is recorded on its own: adding one replaces the
 * queue, and adding cases replaces a queued guide.
 */
function addToQueue(cases: ActiveCase[], what: string): string {
  if (!cases.length) return `Nothing to add (${queue.length} in the queue).`;
  const addingGuide = cases.some((c) => c.guide);
  const replacing = queue.length > 0 && (addingGuide || queue.some((c) => c.guide));
  if (replacing) queue = [];
  queue.push(...cases);
  renderQueue();
  if (addingGuide) return `${what} queued. A guide is recorded on its own${replacing ? ', so it replaced the queue' : ''}.`;
  return `${what} added${replacing ? ' in place of the queued guide' : ''} (${queue.length} in the queue).`;
}

/** Leaving ① with an empty queue records the loaded case on its own. */
function queueLoadedCaseIfEmpty(): void {
  if (queue.length) return;
  const c = currentCase();
  if (c) queue.push(c);
  renderQueue();
}

function showView(next: View): void {
  view = next;
  document.querySelectorAll<HTMLElement>('.view').forEach((v) => (v.hidden = v.dataset.view !== next));

  const flowIndex = FLOW.indexOf(next);
  document.querySelectorAll<HTMLButtonElement>('.stepper-item').forEach((item) => {
    const index = FLOW.indexOf(item.dataset.goto as View);
    item.classList.toggle('active', index === flowIndex);
    item.classList.toggle('done', flowIndex > index || next === 'done');
    item.disabled = next === 'recording';
  });
  document.querySelector('.stepper')?.classList.toggle('hidden', next === 'recording');
  const historyBtn = $<HTMLButtonElement>('open-history');
  historyBtn.classList.toggle('active', next === 'history');
  historyBtn.disabled = next === 'recording';
  if (next !== 'history') $<HTMLVideoElement>('hr-video').pause();

  document.querySelector('.actionbar')?.classList.toggle('hidden', !FLOW.includes(next));
  $<HTMLButtonElement>('back').disabled = flowIndex <= 0;
  $<HTMLButtonElement>('next').textContent =
    next === 'save' ? '● Start recording' : next === 'cases' ? 'Next: what to record →' : 'Next: save to →';

  if (next === 'source') void enterSource();
  if (next === 'save') void enterSave();
  if (next === 'cases') stopPreview();
}

function goNext(): void {
  const problem = canLeave(view);
  if (problem) {
    setStatus(problem, 'error');
    return;
  }
  if (view === 'cases') queueLoadedCaseIfEmpty();
  if (view === 'save') {
    void startRecording();
    return;
  }
  showView(FLOW[FLOW.indexOf(view) + 1]);
}

function goBack(): void {
  const index = FLOW.indexOf(view);
  if (index > 0) showView(FLOW[index - 1]);
}

// ---------------------------------------------------------------------------------------------------------------------
// ① Cases

function substitute(text: string, headers: string[], row: string[]): string {
  return headers.reduce((acc, header, i) => acc.split(`<${header}>`).join(row[i] ?? ''), text);
}

/** Numbers a guide's parts: each new "## " heading (even a repeated one) starts the next part. */
function numberParts(steps: Step[]): Step[] {
  let number = 0;
  steps.forEach((step, i) => {
    if (step.part && (i === 0 || steps[i - 1].part !== step.part)) number += 1;
    if (step.part) step.partNumber = number;
  });
  steps.forEach((step) => {
    if (step.part) step.partCount = number;
  });
  return steps;
}

function buildCase(feature: GherkinFeature, sIndex: number, rIndex: number, withBackground: boolean): ActiveCase {
  const scenario = feature.scenarios[sIndex];
  const examples = scenario.examples;
  const row = examples?.rows[rIndex];
  const fill = (step: GherkinStep, background: boolean): Step => ({
    keyword: step.keyword,
    text: examples && row ? substitute(step.text, examples.headers, row) : step.text,
    extra: examples && row ? step.extra.map((line) => substitute(line, examples.headers, row)) : step.extra,
    background,
    part: step.part,
  });
  const guide = feature.kind === 'guide';
  const id = guide ? 'GUIDE' : scenario.caseId ?? 'CASE';
  const title = examples && row ? substitute(scenario.name || feature.name, examples.headers, row) : scenario.name || feature.name;
  return {
    id,
    label: guide ? 'Guide' : row ? `${id} · ${row[0]}` : id,
    row: row ? row[0] : null,
    title,
    guide,
    steps: numberParts([
      ...(withBackground ? feature.background.map((s) => fill(s, true)) : []),
      ...scenario.steps.map((s) => fill(s, false)),
    ]),
  };
}

function currentCase(): ActiveCase | null {
  if (!loadedFeature || !loadedFeature.scenarios.length) return null;
  return buildCase(loadedFeature, scenarioIndex, rowIndex, $<HTMLInputElement>('include-bg').checked);
}

function renderCaseCard(): void {
  const card = $<HTMLDivElement>('case-card');
  $<HTMLDivElement>('cases-empty').hidden =
    !!loadedFeature || !$<HTMLDivElement>('run-box').hidden || !$<HTMLDivElement>('paste-box').hidden;
  card.hidden = !loadedFeature;
  if (!loadedFeature) return;

  const scenario = loadedFeature.scenarios[scenarioIndex];
  const isGuide = loadedFeature.kind === 'guide';
  $<HTMLDivElement>('case-id').textContent = isGuide ? 'Guide' : scenario.caseId ?? 'No case id';
  $<HTMLLabelElement>('include-bg-label').hidden = isGuide;
  $<HTMLDivElement>('case-name').textContent = (currentCase() as ActiveCase).title;

  const select = $<HTMLSelectElement>('scenario-select');
  select.hidden = loadedFeature.scenarios.length <= 1;
  select.innerHTML = '';
  loadedFeature.scenarios.forEach((s, i) => {
    const option = el('option', '', `${s.caseId ? `${s.caseId} · ` : ''}${s.name}`);
    option.value = String(i);
    option.selected = i === scenarioIndex;
    select.appendChild(option);
  });

  const examples = scenario.examples;
  $<HTMLDivElement>('rows').hidden = !examples;
  $<HTMLButtonElement>('add-all-rows').hidden = !examples || examples.rows.length < 2;
  const chips = $<HTMLDivElement>('row-chips');
  chips.innerHTML = '';
  examples?.rows.forEach((row, i) => {
    const chip = el('button', `chip${i === rowIndex ? ' selected' : ''}`, row[0]);
    chip.type = 'button';
    chip.title = examples.headers.map((h, j) => `${h}: ${row[j]}`).join('\n');
    chip.addEventListener('click', () => {
      rowIndex = i;
      renderCaseCard();
    });
    chips.appendChild(chip);
  });

  const c = currentCase() as ActiveCase;
  const bgCount = c.steps.filter((s) => s.background).length;
  $<HTMLElement>('steps-summary').textContent = `${c.steps.length - bgCount} steps${bgCount ? ` + ${bgCount} Background` : ''}`;
  const list = $<HTMLDivElement>('case-steps');
  list.innerHTML = '';
  let lastGroup = '';
  for (const step of c.steps) {
    const group = step.background ? 'Background' : isGuide ? 'Steps' : 'Scenario';
    if (group !== lastGroup) {
      list.appendChild(el('div', 'step-group', group));
      lastGroup = group;
    }
    list.appendChild(stepLine(step));
  }
}

function useFeature(feature: GherkinFeature, source: string): void {
  if (!feature.scenarios.length) {
    setStatus(`${source}: no Scenario found.`, 'error');
    return;
  }
  loadedFeature = feature;
  scenarioIndex = 0;
  rowIndex = 0;
  $<HTMLInputElement>('include-bg').checked = settings?.preferences.includeBackground ?? true;
  $<HTMLDivElement>('paste-box').hidden = true;
  renderCaseCard();
  setStatus(`${source} loaded.`, 'ok');
}

function renderRunTests(): void {
  const filter = $<HTMLInputElement>('run-filter').value.trim().toLowerCase();
  const list = $<HTMLUListElement>('run-tests');
  list.innerHTML = '';
  runTests
    .filter((t) => !filter || `${t.caseId} ${t.title} ${t.status}`.toLowerCase().includes(filter))
    .forEach((test) => {
      const li = el('li');
      const pill = el('span', 'pill', test.status);
      pill.dataset.status = test.status.toLowerCase();
      li.append(pill, el('b', '', test.caseId), el('span', 'title', test.title));
      li.addEventListener('click', () => void loadInput(test.caseId));
      list.appendChild(li);
    });
}

async function loadInput(input: string): Promise<void> {
  const value = input.trim();
  if (!value) return;
  const loadBtn = $<HTMLButtonElement>('case-load');
  loadBtn.disabled = true;
  setStatus(`Loading ${value} from TestRail…`);
  const result = await window.recorder.testrailLoad(value);
  loadBtn.disabled = false;

  if (!result.ok) {
    setStatus(`TestRail: ${result.error}`, 'error');
    return;
  }
  if (result.kind === 'run') {
    runTests = result.run.tests;
    loadedRunId = result.run.id;
    $<HTMLInputElement>('out-run').value = `R${result.run.id}`;
    $<HTMLDivElement>('run-title').textContent = `Run ${result.run.id} · ${result.run.name} · ${runTests.length} tests`;
    $<HTMLDivElement>('run-box').hidden = false;
    $<HTMLInputElement>('run-filter').value = '';
    renderRunTests();
    renderCaseCard();
    setStatus('Click a test to load it.', 'ok');
    $<HTMLInputElement>('run-filter').focus();
  } else {
    useFeature(result.feature, value);
  }
}

function renderQueue(): void {
  const list = $<HTMLOListElement>('queue');
  list.innerHTML = '';
  $<HTMLSpanElement>('queue-count').textContent = String(queue.length);
  $<HTMLButtonElement>('clear-queue').disabled = !queue.length;

  if (!queue.length) {
    list.appendChild(el('li', 'empty', 'No cases yet'));
    return;
  }
  queue.forEach((c, i) => {
    const li = el('li');
    const who = el('div', 'who');
    who.append(el('b', '', c.label), el('div', '', c.title));
    const actions = el('span', 'actions');
    const action = (label: string, title: string, disabled: boolean, onClick: () => void) => {
      const b = el('button', '', label);
      b.type = 'button';
      b.title = title;
      b.disabled = disabled;
      b.addEventListener('click', onClick);
      actions.appendChild(b);
    };
    action('↑', 'Move up', i === 0, () => moveQueued(i, -1));
    action('↓', 'Move down', i === queue.length - 1, () => moveQueued(i, 1));
    action('✕', 'Remove', false, () => {
      queue.splice(i, 1);
      renderQueue();
    });
    li.append(el('span', 'n', String(i + 1)), who, actions);
    list.appendChild(li);
  });
}

function moveQueued(index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= queue.length) return;
  [queue[index], queue[target]] = [queue[target], queue[index]];
  renderQueue();
}

// ---------------------------------------------------------------------------------------------------------------------
// ② What to record

let allSources: CaptureSource[] = [];

async function enterSource(): Promise<void> {
  if (!allSources.length) await loadSources();
  else renderSources();
  if (selectedSource && !previewing()) void startPreview();
}

/** A source is being drawn into the canvas: a captured window or screen, or a browser tab's frames. */
function previewing(): boolean {
  return stream !== null || (tabStreaming && tabFrame !== null);
}

async function loadSources(): Promise<void> {
  const warning = $<HTMLDivElement>('access-warning');
  const access = await window.recorder.screenAccess();
  warning.hidden = access === 'granted';
  if (access !== 'granted') {
    warning.innerHTML = '';
    warning.append(document.createTextNode(
      `Screen Recording permission is "${access}", so other apps' windows are hidden. Allow it for Electron (or your terminal), then restart the app. `,
    ));
    const open = el('button', 'link', 'Open the setting');
    open.type = 'button';
    open.addEventListener('click', () => void window.recorder.openScreenSettings());
    warning.appendChild(open);
  }

  try {
    // Tabs of the browser on the debugging port come first: they can be recorded even when it runs headless.
    const [tabs, sources] = await Promise.all([window.recorder.listTabs(), window.recorder.listSources()]);
    allSources = [...tabs, ...sources];
  } catch (error) {
    setStatus(`Could not list screens and windows: ${(error as Error).message}`, 'error');
    allSources = [];
  }
  renderSources();
}

function renderSources(): void {
  const filter = $<HTMLInputElement>('source-filter').value.trim().toLowerCase();
  const grid = $<HTMLDivElement>('sources');
  grid.innerHTML = '';
  allSources
    .filter((s) => !filter || s.name.toLowerCase().includes(filter))
    .forEach((source) => {
      const card = el('button', `source${selectedSource?.id === source.id ? ' selected' : ''}`);
      card.type = 'button';
      card.title = source.name;
      const img = el('img');
      img.src = source.thumbnail;
      img.alt = '';
      card.append(img, el('span', 'kind', source.kind), el('span', 'name', source.name));
      card.addEventListener('click', () => {
        selectedSource = source;
        renderSources();
        void startPreview();
      });
      grid.appendChild(card);
    });
}

function stopPreview(): void {
  if (isRecording()) return;
  window.clearInterval(drawHandle);
  drawHandle = undefined;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  sourceVideo.srcObject = null;
  if (tabStreaming) void window.recorder.screencastStop();
  tabStreaming = false;
  tabFrame = null;
  inputRipples = [];
  inputLabel = null;
  blurRects = [];
}

let firstFrame: (() => void) | null = null;

window.recorder.onFrame(({ data, viewport }) => {
  if (!tabStreaming) return;
  tabViewport = viewport;
  const image = new Image();
  image.onload = () => {
    tabFrame = image;
    firstFrame?.();
    firstFrame = null;
  };
  image.src = `data:image/jpeg;base64,${data}`;
});

function inputText(event: InputEvent): string {
  if (event.kind === 'click') return `Click · ${event.text}`;
  if (event.kind === 'type') return `Type · ${event.text}: ${event.value ?? ''}`;
  if (event.kind === 'select') return `Choose · ${event.text}: ${event.value ?? ''}`;
  return `Key · ${event.text}`;
}

/** A click or typing in the recorded tab: drawn on the next frames, and logged under the step on screen. */
window.recorder.onInput((event) => {
  if (!tabStreaming) return;
  const now = Date.now();
  if (event.kind === 'click' && event.x !== undefined && event.y !== undefined) {
    inputRipples.push({ x: event.x, y: event.y, at: now });
    dodgeCard(event.x, event.y);
  }
  inputLabel = { text: inputText(event), until: now + INPUT_LABEL_MS };
  if (!isRecording()) return;
  const step = loggedCases[loggedCases.length - 1]?.steps.at(-1);
  if (!step) return;
  const actions = (step.actions ??= []);
  const last = actions.at(-1);
  // Typing in the same field is one action holding its final value.
  if (event.kind === 'type' && last?.kind === 'type' && last.text === event.text) {
    last.value = event.value;
    return;
  }
  actions.push({ kind: event.kind, text: event.text, ...(event.value !== undefined ? { value: event.value } : {}), atMs: elapsedMs() });
});

/** A click (viewport px) under the step card, or just around it, moves the card to the other bottom corner. */
function dodgeCard(x: number, y: number): void {
  if (!tabViewport.width || !cardRect.w) return;
  const cx = (x * canvasEl.width) / tabViewport.width;
  const cy = (y * canvasEl.height) / tabViewport.height;
  const margin = (canvasEl.height / 540) * 24;
  const under = cx > cardRect.x - margin && cx < cardRect.x + cardRect.w + margin && cy > cardRect.y - margin && cy < cardRect.y + cardRect.h + margin;
  if (under) cardCorner = (cardCorner ?? settings?.preferences.labelCorner ?? 'left') === 'left' ? 'right' : 'left';
}

/**
 * Pixelates the sensitive fields: each area (plus a margin, so a field that just moved stays covered) is shrunk to
 * blocks of about 12 px and drawn back without smoothing. Nothing of the original pixels is kept in the video.
 */
function drawBlur(width: number, height: number): void {
  if (!blurRects.length || !tabViewport.width) return;
  const sx = width / tabViewport.width;
  const sy = height / tabViewport.height;
  const margin = 6 * sx;
  const block = Math.max(8, Math.round(12 * sx));
  const bctx = blurCanvas.getContext('2d');
  if (!bctx) return;
  for (const [x, y, w, h] of blurRects) {
    const left = Math.max(0, Math.floor(x * sx - margin));
    const top = Math.max(0, Math.floor(y * sy - margin));
    const right = Math.min(width, Math.ceil((x + w) * sx + margin));
    const bottom = Math.min(height, Math.ceil((y + h) * sy + margin));
    const bw = right - left;
    const bh = bottom - top;
    if (bw < 2 || bh < 2) continue;
    blurCanvas.width = Math.max(1, Math.round(bw / block));
    blurCanvas.height = Math.max(1, Math.round(bh / block));
    bctx.imageSmoothingEnabled = true;
    bctx.drawImage(canvasEl, left, top, bw, bh, 0, 0, blurCanvas.width, blurCanvas.height);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(blurCanvas, 0, 0, blurCanvas.width, blurCanvas.height, left, top, bw, bh);
    ctx.restore();
  }
}

window.recorder.onBlurRects((rects) => {
  if (tabStreaming) blurRects = rects;
});

/** Ripples where the tab was clicked (under the banner). */
function drawRipples(width: number, height: number): void {
  const now = Date.now();
  inputRipples = inputRipples.filter((r) => now - r.at < RIPPLE_MS);
  if (!inputRipples.length || !tabViewport.width) return;
  const scale = Math.max(0.6, width / 1280);
  for (const ripple of inputRipples) {
    const t = (now - ripple.at) / RIPPLE_MS;
    const x = (ripple.x * width) / tabViewport.width;
    const y = (ripple.y * height) / tabViewport.height;
    ctx.beginPath();
    ctx.arc(x, y, (10 + 26 * t) * scale, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 59, 48, ${0.22 * (1 - t)})`;
    ctx.fill();
    ctx.lineWidth = 3 * scale;
    ctx.strokeStyle = `rgba(255, 59, 48, ${1 - t})`;
    ctx.stroke();
    if (t < 0.5) {
      ctx.beginPath();
      ctx.arc(x, y, 5 * scale, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 59, 48, 0.9)';
      ctx.fill();
    }
  }
}

/** Streams a browser tab's frames (screencast.ts) and sizes the video to the first one. */
async function startTabPreview(source: CaptureSource): Promise<void> {
  tabStreaming = true;
  const arrived = new Promise<boolean>((resolve) => {
    firstFrame = () => resolve(true);
    window.setTimeout(() => resolve(false), 5000);
  });
  const result = await window.recorder.screencastStart(source.id.replace(/^tab:/, ''));
  if (!result.ok || !(await arrived)) {
    tabStreaming = false;
    firstFrame = null;
    setStatus(`Could not record the tab "${source.name}": ${result.ok ? 'no frame from the browser within 5 s' : result.error}`, 'error');
    return;
  }
  const frame = tabFrame as HTMLImageElement;
  // Even sizes: H.264 needs them.
  canvasEl.width = frame.naturalWidth - (frame.naturalWidth % 2);
  canvasEl.height = frame.naturalHeight - (frame.naturalHeight % 2);
  drawHandle = window.setInterval(drawFrame, 1000 / CAPTURE_FPS);
  $<HTMLParagraphElement>('preview-caption').textContent =
    `Browser tab "${source.name}" · ${canvasEl.width}×${canvasEl.height}. This is what the video will look like.`;
  setStatus(`Will record the browser tab "${source.name}".`, 'ok');
}

/** Captures the selected source and draws it with the banner, so the preview is exactly the video. */
async function startPreview(): Promise<void> {
  if (!selectedSource) return;
  stopPreview();
  if (selectedSource.kind === 'tab') {
    await startTabPreview(selectedSource);
    return;
  }
  const constraints = {
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: selectedSource.id, maxFrameRate: CAPTURE_FPS } },
  } as unknown as MediaStreamConstraints;

  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    setStatus(`Could not capture "${selectedSource.name}": ${(error as Error).message}`, 'error');
    return;
  }
  sourceVideo.srcObject = stream;
  await sourceVideo.play();
  const { width = 1920, height = 1080 } = stream.getVideoTracks()[0].getSettings();
  canvasEl.width = width;
  canvasEl.height = height;
  drawHandle = window.setInterval(drawFrame, 1000 / CAPTURE_FPS);
  $<HTMLParagraphElement>('preview-caption').textContent =
    `${selectedSource.name} · ${width}×${height}. This is what the video will look like.`;
  setStatus(`Will record "${selectedSource.name}".`, 'ok');
}

// ---------------------------------------------------------------------------------------------------------------------
// ③ Save to

async function enterSave(): Promise<void> {
  applyOutputPreview(await window.recorder.previewOutput());
  fillDatalist('recent-subjects', settings?.recent.subjects ?? []);
  fillDatalist('recent-configs', settings?.recent.configs ?? []);

  const cases = $<HTMLOListElement>('summary-cases');
  cases.innerHTML = '';
  queue.forEach((c) => cases.appendChild(el('li', '', `${c.label}: ${c.title}`)));
  $<HTMLDivElement>('summary-source').textContent = selectedSource ? `${selectedSource.kind}: ${selectedSource.name}` : '—';

  const keys = $<HTMLTableElement>('summary-keys');
  keys.innerHTML = '';
  if (settings) {
    const hotkeys = settings.hotkeys;
    const guide = queue.some((c) => c.guide);
    (Object.keys(HOTKEY_LABELS) as HotkeyAction[]).forEach((action) => {
      // A guide ends with Done (the Pass hotkey) and has no Fail or Blocked.
      if (guide && (action === 'fail' || action === 'blocked')) return;
      const tr = el('tr');
      const key = el('td');
      key.appendChild(el('kbd', '', prettyAccelerator(hotkeys[action])));
      tr.append(key, el('td', '', guide && action === 'pass' ? 'Guide done' : HOTKEY_LABELS[action]));
      keys.appendChild(tr);
    });
  }
}

function fillDatalist(id: string, values: string[]): void {
  const list = $<HTMLDataListElement>(id);
  list.innerHTML = '';
  values.forEach((v) => {
    const option = el('option');
    option.value = v;
    list.appendChild(option);
  });
}

function caseToken(c: ActiveCase): string {
  return (c.row ? `${c.id}.${c.row.toLowerCase()}` : c.id).replace(/[^\w.@-]/g, '-');
}

function applyOutputPreview(preview: OutputPreview): void {
  $<HTMLInputElement>('out-subject').value = preview.output.subject;
  $<HTMLInputElement>('out-config').value = preview.output.config;
  $<HTMLElement>('out-root').textContent = preview.output.root;
  $<HTMLElement>('settings-root').textContent = preview.output.root;
  const number = String(preview.seq).padStart(2, '0');
  const guide = queue.find((c) => c.guide);
  const preview_ = $<HTMLElement>('file-preview');
  if (!guide) {
    preview_.textContent = `${preview.folder}/${number}_${queue.map(caseToken).join('-') || '<cases>'}_<result>.mp4`;
    return;
  }
  // A guide's name comes from main (output.ts), so the preview is exactly the name the file will get.
  void window.recorder.guideFileToken(guide.title).then((token) => (preview_.textContent = `${preview.folder}/${number}_${token}.mp4`));
}

async function saveOutput(): Promise<void> {
  applyOutputPreview(await window.recorder.setOutput({
    subject: $<HTMLInputElement>('out-subject').value,
    config: $<HTMLInputElement>('out-config').value,
  }));
}

async function changeRoot(): Promise<void> {
  const root = await window.recorder.chooseOutputRoot();
  if (root) applyOutputPreview(await window.recorder.setOutput({ root }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Banner + compositing

function fitText(text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * Splits the text into lines no wider than maxWidth in the current font, breaking words that are too long on their own
 * (a URL, a path); past maxLines, the last line ends with an ellipsis.
 */
function wrapText(text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && ctx.measureText(`${last} ${word}`).width <= maxWidth) {
      lines[lines.length - 1] = `${last} ${word}`;
      continue;
    }
    let rest = word;
    while (ctx.measureText(rest).width > maxWidth) {
      let cut = rest.length - 1;
      while (cut > 1 && ctx.measureText(rest.slice(0, cut)).width > maxWidth) cut -= 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    lines.push(rest);
  }
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), fitText(`${lines.slice(maxLines - 1).join(' ')}`, maxWidth)];
}

/** The card for a step that starts a part ("Part 2 of 3" + its heading), or null. */
function partCard(c: ActiveCase, index: number): Pick<GuideCard, 'kicker' | 'title'> | null {
  const step = c.steps[index];
  if (!step?.part || c.steps[index - 1]?.partNumber === step.partNumber) return null;
  return { kicker: `Part ${step.partNumber} of ${step.partCount}`, title: step.part };
}

/** The guide card on screen now, if any. Cards run on recorded time, so a pause holds them. */
function currentCard(): GuideCard | null {
  const now = elapsedMs();
  return cards.find((card) => card.from <= now && now < card.until) ?? null;
}

/**
 * Shows the cards one after another, CARD_MS each. They replace any card still on screen, so a part card is never shown
 * late, under the steps of the part it introduces.
 */
function showCards(next: Pick<GuideCard, 'kicker' | 'title'>[]): void {
  let from = elapsedMs();
  cards = next.map((card) => {
    const shown = { ...card, from, until: from + CARD_MS };
    from += CARD_MS;
    return shown;
  });
  pushHud();
}

/** A guide's card over the whole frame (dimmed): a small kicker ("Guide", "Part 1 of 2") and the title, wrapped. */
function drawCard(width: number, height: number, card: GuideCard): void {
  ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
  ctx.fillRect(0, 0, width, height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const titleFont = Math.round(Math.min(width, height) * 0.05);
  const kickerFont = Math.round(titleFont * 0.45);
  ctx.font = `700 ${titleFont}px ${BANNER_FONT}`;
  const lines = wrapText(card.title, width * 0.8, CARD_LINES);
  const top = height / 2 - ((lines.length - 1) * titleFont * 1.3) / 2;

  ctx.font = `700 ${kickerFont}px ${BANNER_FONT}`;
  ctx.fillStyle = GUIDE_BADGE_COLOR;
  ctx.fillText(card.kicker.toUpperCase(), width / 2, top - titleFont * 1.2);

  ctx.font = `700 ${titleFont}px ${BANNER_FONT}`;
  ctx.fillStyle = '#ffffff';
  lines.forEach((line, n) => ctx.fillText(line, width / 2, top + n * titleFont * 1.3));
  ctx.textAlign = 'left';
}

/** A guide's banner: the step number in a badge, the step, and "4/8 · Title" muted on the right. */
function drawGuideBanner(c: ActiveCase, index: number, y: number, width: number, barHeight: number): void {
  const step = c.steps[index];
  const pad = Math.round(barHeight * 0.35);
  const font = Math.round(barHeight * 0.42);
  const mid = y + barHeight / 2;
  const radius = Math.round(barHeight * 0.32);

  ctx.fillStyle = BANNER_BACKGROUND;
  ctx.fillRect(0, y, width, barHeight);

  ctx.fillStyle = GUIDE_BADGE_COLOR;
  ctx.beginPath();
  ctx.arc(pad + radius, mid, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `700 ${Math.round(radius * 1.1)}px ${BANNER_FONT}`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.fillText(String(index + 1), pad + radius, mid);
  ctx.textAlign = 'left';

  ctx.font = `500 ${font}px ${BANNER_FONT}`;
  const where = step.part ? `Part ${step.partNumber} · ${index + 1}/${c.steps.length}` : `${index + 1}/${c.steps.length} · ${c.title}`;
  const info = fitText(where, width * 0.3);
  const infoWidth = ctx.measureText(info).width;
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(info, width - pad - infoWidth, mid);

  const x = pad + radius * 2 + pad;
  ctx.font = `600 ${font}px ${BANNER_FONT}`;
  ctx.fillStyle = '#f8fafc';
  ctx.fillText(fitText(step.text, width - x - infoWidth - 3 * pad), x, mid);
}

function drawBanner(width: number, height: number): void {
  // Before recording, the preview shows the first step of the first queued case.
  const c = activeCase ?? queue[0] ?? currentCase();
  const index = activeCase ? stepIndex : 0;
  const step = c?.steps[index];
  if (!c || !step) return;

  const barHeight = Math.max(36, Math.round(height * 0.055));
  const y = height - barHeight;
  const pad = Math.round(barHeight * 0.35);
  const font = Math.round(barHeight * 0.42);
  const mid = y + barHeight / 2;
  ctx.textBaseline = 'middle';

  const card = currentCard();
  if (card) {
    drawCard(width, height, card);
    return;
  }

  if (c.guide && !(flash && Date.now() < flash.until)) {
    drawGuideBanner(c, index, y, width, barHeight);
    return;
  }
  drawStepCard(width, height, c, index);
}

/** A note, as a yellow chip just above the step card, in the same corner. */
function drawNoteChip(text: string, cardX: number, cardY: number, cardWidth: number, corner: 'left' | 'right', width: number, s: number, size: number): void {
  const font = Math.round(size * 1.15);
  const pad = 8 * s;
  const height = font * 1.9;
  ctx.font = `600 ${font}px ${BANNER_FONT}`;
  const shown = fitText(`Note · ${text}`, width * 0.46 - 2 * pad);
  const chipWidth = Math.min(width * 0.46, ctx.measureText(shown).width + 2 * pad);
  const x = corner === 'left' ? cardX : cardX + cardWidth - chipWidth;
  const y = cardY - 6 * s - height;
  ctx.fillStyle = '#fde68a';
  ctx.beginPath();
  ctx.roundRect(x, y, chipWidth, height, 8 * s);
  ctx.fill();
  ctx.fillStyle = '#422006';
  ctx.fillText(shown, x + pad, y + height / 2);
}

const CARD_MONO = 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace';

/** "2/3", or "Background 1/2" for a Background step. */
function shortPosition(c: ActiveCase, index: number): string {
  const { section, position, total } = stepPosition(c, index);
  return section === 'Step' ? `${position}/${total}` : `${section} ${position}/${total}`;
}

/**
 * The step card, in a bottom corner. Two lines: the case, its progress (one segment per step), the step number and the
 * last click or typing; then the step itself, big. On a result the card takes the result's colour and keeps the step it
 * happened on. Sized from the video's height (designed at 540 px), so it reads the same on any recording.
 */
function drawStepCard(width: number, height: number, c: ActiveCase, index: number): void {
  const s = height / 540;
  const pad = 12 * s;
  const margin = 16 * s;
  const small = Math.round(11 * s);
  const big = Math.round(18 * s);
  const gap = 5 * s;
  const maxWidth = width * 0.46;
  const result = flash && Date.now() < flash.until && flash.result ? flash : null;
  const step = result?.step ?? c.steps[index];
  const now = Date.now();
  const action = !result && tabStreaming && inputLabel && now < inputLabel.until ? inputLabel.text : '';

  // Line 1, measured first: [case] [progress | RESULT badge] [2/3 | at 3/3] [last action | next / end of run]
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${small}px ${CARD_MONO}`;
  const label = result?.label ?? c.label;
  const labelWidth = ctx.measureText(label).width;
  const segmentsWidth = 64 * s;
  ctx.font = `800 ${small}px ${BANNER_FONT}`;
  const badgeText = result ? RESULT_STYLE[result.result as CaseResult].label : '';
  const badgeWidth = result ? ctx.measureText(badgeText).width + 10 * s : 0;
  ctx.font = `600 ${small}px ${BANNER_FONT}`;
  const position = result ? `at ${result.at}` : shortPosition(c, index);
  const positionWidth = ctx.measureText(position).width;
  const extra = result ? result.trailer ?? '' : action;
  const fixed = labelWidth + (result ? badgeWidth : segmentsWidth) + positionWidth + 3 * 8 * s;

  // Line 2: the step.
  ctx.font = `700 ${big}px ${BANNER_FONT}`;
  const keywordWidth = ctx.measureText(`${step.keyword} `).width;
  const fullTextWidth = ctx.measureText(step.text).width;
  ctx.font = `400 ${small}px ${BANNER_FONT}`;
  const extraWidth = extra ? Math.min(ctx.measureText(extra).width + 10 * s + (result ? 0 : 14 * s), maxWidth) : 0;

  // A little slack: sized to exactly the text, rounding could make the text "not fit" and get cut.
  const cardWidth = Math.min(maxWidth, Math.ceil(Math.max(fixed + extraWidth, keywordWidth + fullTextWidth) + 2 * pad + 2 * s));
  const cardHeight = 2 * pad + small * 1.3 + gap + big * 1.25;
  const corner = cardCorner ?? settings?.preferences.labelCorner ?? 'left';
  const x0 = corner === 'left' ? margin : width - cardWidth - margin;
  const y0 = height - margin - cardHeight;
  cardRect = { x: x0, y: y0, w: cardWidth, h: cardHeight };

  ctx.fillStyle = result ? CARD_RESULT_COLORS[result.result as CaseResult] : 'rgba(15, 23, 42, 0.92)';
  ctx.beginPath();
  ctx.roundRect(x0, y0, cardWidth, cardHeight, 10 * s);
  ctx.fill();

  const mid1 = y0 + pad + (small * 1.3) / 2;
  let x = x0 + pad;
  ctx.font = `700 ${small}px ${CARD_MONO}`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, x, mid1);
  x += labelWidth + 8 * s;

  if (result) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(x, mid1 - small * 0.75, badgeWidth, small * 1.5, 4 * s);
    ctx.fill();
    ctx.font = `800 ${small}px ${BANNER_FONT}`;
    ctx.fillStyle = CARD_RESULT_COLORS[result.result as CaseResult];
    ctx.fillText(badgeText, x + 5 * s, mid1);
    x += badgeWidth + 8 * s;
  } else {
    // One segment per step (done, now, next); a long case gets one bar that fills up.
    const count = c.steps.length;
    const h = 3 * s;
    if (count <= 16) {
      const each = (segmentsWidth - (count - 1) * 3 * s) / count;
      for (let i = 0; i < count; i++) {
        ctx.fillStyle = i < index ? '#64748b' : i === index ? '#ffffff' : '#334155';
        ctx.beginPath();
        ctx.roundRect(x + i * (each + 3 * s), mid1 - h / 2, each, h, h / 2);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = '#334155';
      ctx.beginPath();
      ctx.roundRect(x, mid1 - h / 2, segmentsWidth, h, h / 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.roundRect(x, mid1 - h / 2, (segmentsWidth * (index + 1)) / count, h, h / 2);
      ctx.fill();
    }
    x += segmentsWidth + 8 * s;
  }

  ctx.font = `600 ${small}px ${BANNER_FONT}`;
  ctx.fillStyle = result ? '#fee2e2' : '#cbd5e1';
  ctx.fillText(position, x, mid1);
  x += positionWidth + 10 * s;

  if (extra) {
    ctx.font = `${result ? 400 : 500} ${small}px ${BANNER_FONT}`;
    ctx.fillStyle = result ? '#fee2e2' : '#fca5a5';
    if (!result) {
      // A small pointer before the last click or typing.
      ctx.beginPath();
      ctx.moveTo(x, mid1 - 5 * s);
      ctx.lineTo(x + 7 * s, mid1 + 1 * s);
      ctx.lineTo(x + 3.5 * s, mid1 + 1.5 * s);
      ctx.lineTo(x + 2 * s, mid1 + 5 * s);
      ctx.closePath();
      ctx.fill();
      x += 12 * s;
    }
    ctx.fillText(fitText(extra, x0 + cardWidth - pad - x), x, mid1);
  }

  if (!result && noteShown && now < noteShown.until) drawNoteChip(noteShown.text, x0, y0, cardWidth, corner, width, s, small);

  const mid2 = y0 + pad + small * 1.3 + gap + (big * 1.25) / 2;
  x = x0 + pad;
  ctx.font = `700 ${big}px ${BANNER_FONT}`;
  ctx.fillStyle = result ? 'rgba(255, 255, 255, 0.8)' : BANNER_KEYWORD_COLORS[step.keyword] ?? '#e2e8f0';
  ctx.fillText(step.keyword, x, mid2);
  x += keywordWidth;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(fitText(step.text, x0 + cardWidth - pad - x), x, mid2);
}

function drawFrame(): void {
  if (tabStreaming) {
    if (!tabFrame) return;
    ctx.drawImage(tabFrame, 0, 0, canvasEl.width, canvasEl.height);
    drawBlur(canvasEl.width, canvasEl.height);
    drawRipples(canvasEl.width, canvasEl.height);
  } else {
    if (sourceVideo.readyState < 2) return;
    ctx.drawImage(sourceVideo, 0, 0, canvasEl.width, canvasEl.height);
  }
  drawBanner(canvasEl.width, canvasEl.height);
}

// ---------------------------------------------------------------------------------------------------------------------
// Recording

function renderRecording(): void {
  if (!activeCase) return;
  const step = activeCase.steps[stepIndex];
  const { section, position, total } = stepPosition(activeCase, stepIndex);
  $<HTMLSpanElement>('rec-case').textContent = activeCase.label;
  $<HTMLSpanElement>('rec-progress').textContent = `Case ${runIndex + 1} of ${runCases.length}`;
  $<HTMLDivElement>('rec-position').textContent = `${section} ${position}/${total}`;
  const kw = $<HTMLSpanElement>('rec-keyword');
  kw.textContent = step?.keyword ?? '';
  kw.className = `kw kw-${step?.keyword ?? ''}`;
  $<HTMLSpanElement>('rec-text').textContent = step?.text ?? '';

  const list = $<HTMLDivElement>('rec-steps');
  list.innerHTML = '';
  let lastGroup = '';
  activeCase.steps.forEach((s, i) => {
    const group = s.background ? 'Background' : 'Scenario';
    if (group !== lastGroup) {
      list.appendChild(el('div', 'step-group', group));
      lastGroup = group;
    }
    const line = stepLine(s, `step-line${i === stepIndex ? ' current' : i < stepIndex ? ' done' : ''}`);
    line.addEventListener('click', () => goToStep(i));
    list.appendChild(line);
  });
  list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });

  $<HTMLButtonElement>('res-pass').textContent = activeCase.guide ? '✓ Done' : '✓ Pass';
  $<HTMLButtonElement>('res-fail').hidden = activeCase.guide;
  $<HTMLButtonElement>('res-blocked').hidden = activeCase.guide;

  $<HTMLButtonElement>('step-prev').disabled = stepIndex === 0;
  $<HTMLButtonElement>('step-next').disabled = stepIndex >= activeCase.steps.length - 1;
}

/** The HUD's flash: a result, or the guide card on screen ("Part 1 of 2: Check that the columns exist"). */
function hudFlash(): { text: string; color: string; until: number } | null {
  const card = currentCard();
  hudCardTitle = card?.title ?? null;
  // The HUD counts in wall-clock time; the card's end in recorded time is converted for it.
  return card ? { text: `${card.kicker}: ${card.title}`, color: GUIDE_BADGE_COLOR, until: Date.now() + card.until - elapsedMs() } : flash;
}

/** Sends what the floating HUD needs to show; called on every change while recording. */
function pushHud(): void {
  if (!activeCase) return;
  const step = activeCase.steps[stepIndex];
  const { section, position, total } = stepPosition(activeCase, stepIndex);
  window.recorder.hudState({
    guide: activeCase.guide,
    label: activeCase.guide ? activeCase.title : activeCase.label,
    section,
    position,
    total,
    keyword: step?.keyword ?? '',
    text: step?.text ?? '',
    caseIndex: runIndex,
    caseCount: runCases.length,
    paused,
    activeMs,
    segmentStart,
    flash: hudFlash(),
    canPrevious: stepIndex > 0,
    canNext: stepIndex < activeCase.steps.length - 1,
    finishing,
    countdownUntil,
  });
}

function goToStep(index: number): void {
  if (!activeCase || countdownUntil) return;
  const target = Math.max(0, Math.min(activeCase.steps.length - 1, index));
  if (target === stepIndex) return;
  const forward = target > stepIndex;
  stepIndex = target;
  const card = forward && isRecording() && activeCase.guide ? partCard(activeCase, target) : null;
  const partNumber = activeCase.steps[target].partNumber;
  if (card && partNumber && !shownParts.has(partNumber)) {
    shownParts.add(partNumber);
    showCards([card]);
  }
  renderRecording();
  drawFrame();
  if (isRecording()) {
    logStep();
    pushHud();
  }
}

function startCaseLog(): void {
  if (!activeCase) return;
  loggedCases.push({ id: activeCase.id, row: activeCase.row, title: activeCase.title, result: null, guide: activeCase.guide, steps: [] });
  logStep();
}

function logStep(): void {
  const current = loggedCases[loggedCases.length - 1];
  const step = activeCase?.steps[stepIndex];
  if (!current || !step || !activeCase) return;
  const { section, position, total } = stepPosition(activeCase, stepIndex);
  current.steps.push({ section, position, total, keyword: step.keyword, text: step.text, part: step.part, atMs: elapsedMs() });
}

/** A browser console entry goes under the step on screen (between cases: the last step of the case just closed). */
window.recorder.onConsoleEntry((entry) => {
  if (!isRecording()) return;
  const step = loggedCases[loggedCases.length - 1]?.steps.at(-1);
  if (!step) return;
  // While paused it isn't in the video: it is kept at the pause point and marked.
  (step.console ??= []).push({ ...entry, atMs: elapsedMs(), ...(paused ? { paused: true } : {}) });
});

/** Starts the browser console / network capture that ⚙ Settings asks for, and notes whether it worked. */
async function startBrowserCapture(): Promise<void> {
  const wanted = { console: !!settings?.preferences.browserConsole, network: !!settings?.preferences.browserNetwork };
  browserConsole = undefined;
  browserNetwork = undefined;
  if (!wanted.console && !wanted.network) return;
  const result = await window.recorder.browserStart(wanted);
  const state = result.ok ? 'captured' : `not captured: ${result.error}`;
  if (wanted.console) browserConsole = state;
  if (wanted.network) browserNetwork = state;
}

async function startRecording(): Promise<void> {
  if (!queue.length || !selectedSource) return;
  await saveOutput();
  if (!previewing()) await startPreview();
  if (!previewing()) return;
  await startBrowserCapture();
  // A browser tab is recorded without the HUD or a countdown: there's no window to switch to, and nothing on screen.
  const headless = selectedSource.kind === 'tab';

  runCases = queue.map((c) => ({ ...c, steps: c.steps.map((s) => ({ ...s })) }));
  runIndex = 0;
  activeCase = runCases[0];
  stepIndex = 0;
  loggedCases = [];
  finishing = false;
  flash = null;
  cardCorner = null;
  noteShown = null;
  paused = false;
  activeMs = 0;
  segmentStart = Date.now();

  showView('recording');
  renderRecording();
  setStatus('');
  $<HTMLSpanElement>('rec-timer').textContent = '00:00';

  // Count down on the HUD first, so the video doesn't open with you switching to the browser.
  const countdownMs = headless ? 0 : Math.max(0, settings?.preferences.countdownSec ?? 3) * 1000;
  countdownUntil = countdownMs ? Date.now() + countdownMs + 400 : 0;
  if (!headless) await window.recorder.hudOpen();
  // The HUD page needs a moment to load before it can receive its first state.
  window.setTimeout(pushHud, 400);
  if (countdownUntil) {
    $<HTMLSpanElement>('rec-progress').textContent = 'Starting…';
    countdownHandle = window.setTimeout(() => void beginCapture(), countdownUntil - Date.now());
  } else {
    await beginCapture();
  }
}

/** The step log as it stands, for the crash copy next to the capture and for saving. */
function currentMeta(): RecordingMeta {
  return { startedAt: runStartedAt, durationMs: elapsedMs(), cases: loggedCases, browserConsole, network: browserNetwork, timeline };
}

/** Starts the actual recording once the countdown is over. */
async function beginCapture(): Promise<void> {
  countdownUntil = 0;
  countdownHandle = undefined;
  // The capture file must exist before the first chunk (it carries the WebM header).
  await window.recorder.captureBegin();
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
  mediaRecorder = new MediaRecorder(canvasEl.captureStream(CAPTURE_FPS), { mimeType });
  chunkWrites = Promise.resolve();
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size === 0) return;
    const data = event.data;
    chunkWrites = chunkWrites.then(async () => window.recorder.captureChunk(await data.arrayBuffer()));
  };
  mediaRecorder.onstop = () => void finishRecording();
  mediaRecorder.start(1000);

  paused = false;
  activeMs = 0;
  segmentStart = Date.now();
  timeline = [{ wall: segmentStart, atMs: 0 }];
  runStartedAt = new Date().toISOString();
  startCaseLog();
  cards = [];
  shownParts = new Set();
  if (activeCase?.guide) {
    const firstPart = partCard(activeCase, 0);
    if (firstPart) shownParts.add(1);
    showCards([{ kicker: 'Guide', title: activeCase.title }, ...(firstPart ? [firstPart] : [])]);
  }

  timerHandle = window.setInterval(() => {
    $<HTMLSpanElement>('rec-timer').textContent = formatDuration(elapsedMs());
    if ((currentCard()?.title ?? null) !== hudCardTitle) pushHud();
  }, 250);
  // If Rasto crashes, the capture on disk is saved later with this step log (at most 2 s old).
  snapshotHandle = window.setInterval(() => window.recorder.captureSnapshot(currentMeta()), 2000);
  renderRecording();
  pushHud();
}

/** Stop during the countdown: nothing was recorded, go back to step ③. */
async function cancelCountdown(): Promise<void> {
  window.clearTimeout(countdownHandle);
  countdownHandle = undefined;
  countdownUntil = 0;
  activeCase = null;
  await window.recorder.browserStop();
  await window.recorder.hudClose();
  showView('save');
  setStatus('Recording cancelled before it started.');
}

function togglePause(): void {
  if (!isRecording() || !mediaRecorder || finishing) return;
  const dot = document.querySelector('.rec-dot');
  if (paused) {
    mediaRecorder.resume();
    segmentStart = Date.now();
    timeline.push({ wall: segmentStart, atMs: activeMs });
    paused = false;
    $<HTMLButtonElement>('pause').textContent = 'Ⅱ Pause';
    dot?.classList.remove('paused');
  } else {
    mediaRecorder.pause();
    activeMs += Date.now() - segmentStart;
    timeline.push({ wall: Date.now(), atMs: activeMs, paused: true });
    paused = true;
    $<HTMLButtonElement>('pause').textContent = '▶ Resume';
    dot?.classList.add('paused');
  }
  pushHud();
}

function recordResult(result: CaseResult): void {
  if (!isRecording() || finishing || paused || !activeCase) return;
  // A guide only ends with Done (the Pass hotkey and button).
  if (activeCase.guide && result !== 'pass') return;
  const current = loggedCases[loggedCases.length - 1];
  if (!current) return;
  current.result = result;
  current.resultAtMs = elapsedMs();

  if (activeCase.guide) {
    // A guide ends on its last step: no closing card.
    finishing = true;
    pushHud();
    stopRecording();
    return;
  }

  const next = runCases[runIndex + 1];
  const step = activeCase.steps[stepIndex];
  const done = loggedCases.filter((c) => c.result);
  const tally = (['pass', 'fail', 'blocked'] as const)
    .map((r) => [done.filter((c) => c.result === r).length, { pass: 'passed', fail: 'failed', blocked: 'blocked' }[r]] as const)
    .filter(([n]) => n)
    .map(([n, word]) => `${n} ${word}`)
    .join(', ');
  flash = {
    text: `${activeCase.label} — ${RESULT_STYLE[result].label}${next ? `  →  next: ${next.label}` : '  ·  end of run'}`,
    color: RESULT_STYLE[result].color,
    until: Date.now() + FLASH_MS,
    result,
    label: activeCase.label,
    step: step ? { keyword: step.keyword, text: step.text } : undefined,
    at: shortPosition(activeCase, stepIndex),
    trailer: next ? `next: ${next.label}` : `end of run · ${tally}`,
  };

  if (next) {
    runIndex += 1;
    activeCase = next;
    stepIndex = 0;
    startCaseLog();
    renderRecording();
  } else {
    finishing = true;
    // Leave the flash in the video before stopping.
    window.setTimeout(stopRecording, FLASH_MS);
  }
  pushHud();
}

function stopRecording(): void {
  if (countdownUntil) {
    void cancelCountdown();
    return;
  }
  if (!isRecording()) return;
  cards = [];
  if (!paused) activeMs += Date.now() - segmentStart;
  paused = false;
  window.clearInterval(timerHandle);
  window.clearInterval(snapshotHandle);
  mediaRecorder?.stop();
  document.querySelector('.rec-dot')?.classList.remove('paused');
  $<HTMLButtonElement>('pause').textContent = 'Ⅱ Pause';
}

/** " · browser console: 3 errors, 1 warning" for the Done screen; empty when the console is off. */
function consoleSummary(meta: RecordingMeta): string {
  if (!meta.browserConsole) return '';
  if (meta.browserConsole !== 'captured') return ` · browser console ${meta.browserConsole}`;
  const entries = meta.cases.flatMap((c) => c.steps.flatMap((s) => s.console ?? []));
  const count = (level: string, word: string) => {
    const n = entries.filter((e) => e.level === level).length;
    return n ? `${n} ${word}${n === 1 ? '' : 's'}` : '';
  };
  const counts = [count('error', 'error'), count('warn', 'warning')].filter(Boolean).join(', ');
  return ` · browser console: ${counts || `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, no errors`}`;
}

/** " · network: 42 requests, 2 failed (01_….har)" for the Done screen; empty when the network is off. */
function networkSummary(meta: RecordingMeta, network?: { har: string; requests: number; failed: number }): string {
  if (!meta.network) return '';
  if (meta.network !== 'captured') return ` · network ${meta.network}`;
  if (!network) return ' · network: the .har could not be written';
  const requests = `${network.requests} request${network.requests === 1 ? '' : 's'}`;
  return ` · network: ${requests}${network.failed ? `, ${network.failed} failed` : ''} (.har)`;
}

async function finishRecording(): Promise<void> {
  await window.recorder.browserStop();
  const meta: RecordingMeta = { ...currentMeta(), durationMs: activeMs };
  mediaRecorder = null;
  activeCase = null;
  stopPreview();
  await window.recorder.hudClose();

  showView('done');
  setStatus('');
  $<HTMLDivElement>('done-icon').textContent = '⏳';
  $<HTMLDivElement>('done-title').textContent = `Compressing ${formatDuration(activeMs)} of video…`;
  $<HTMLElement>('done-file').textContent = '';
  $<HTMLDivElement>('done-meta').textContent = '';
  const progress = $<HTMLProgressElement>('progress');
  progress.value = 0;
  progress.hidden = false;
  renderDoneCases();
  setDoneActions(false);

  testrailOutcome = null;
  renderTestRail();
  $<HTMLButtonElement>('record-again').hidden = false;
  compressing = true;
  await chunkWrites;
  const result = await window.recorder.saveRecording(meta);
  compressing = false;
  await showSaveResult(result, meta);
  const run = $<HTMLInputElement>('out-run').value.trim();
  if (result.ok && run && !loggedCases.some((c) => c.guide)) await postToTestRail(run);
}

/** The Done screen once a recording is saved (or failed to): file, size, what else was saved. */
async function showSaveResult(result: SaveResult, meta: RecordingMeta | null): Promise<void> {
  $<HTMLProgressElement>('progress').hidden = true;
  setDoneActions(true);
  if (result.ok) {
    lastSavedPath = result.path;
    const failed = loggedCases.some((c) => c.result === 'fail');
    $<HTMLDivElement>('done-icon').textContent = failed ? '⚠️' : '✅';
    $<HTMLDivElement>('done-title').textContent = 'Recording saved';
    $<HTMLElement>('done-file').textContent = result.path.split(/[\\/]/).pop() ?? result.path;
    const clips = result.clips?.length ? ` · ${result.clips.length} clip${result.clips.length === 1 ? '' : 's'} in the folder of the same name` : '';
    $<HTMLDivElement>('done-meta').textContent = meta
      ? `${formatBytes(result.bytes)} · ${formatDuration(meta.durationMs)} · steps as chapters and subtitles · step log${result.report ? ' and HTML report' : ''} saved next to it${clips}${consoleSummary(meta)}${networkSummary(meta, result.network)} · ${result.path.replace(/[\\/][^\\/]+$/, '')}`
      : `${formatBytes(result.bytes)} · step log saved next to it${clips} · ${result.path.replace(/[\\/][^\\/]+$/, '')}`;
    settings = (await window.recorder.getSettings()).settings;
  } else {
    lastSavedPath = result.raw;
    $<HTMLDivElement>('done-icon').textContent = '❌';
    $<HTMLDivElement>('done-title').textContent = 'Compression failed';
    $<HTMLDivElement>('done-meta').textContent = `${result.error}. The raw capture was kept at ${result.raw}`;
  }
}

/** Posts the recording just saved to a TestRail run, and shows how each case went. */
async function postToTestRail(run: string): Promise<void> {
  testrailOutcome = { state: 'posting', run };
  renderTestRail();
  const result = await window.recorder.testrailPost(run);
  testrailOutcome = result.ok
    ? { state: 'done', run: `R${result.run}`, cases: result.cases }
    : { state: 'error', run, error: result.error };
  renderTestRail();
}

function renderTestRail(): void {
  const box = $<HTMLDivElement>('done-testrail');
  box.innerHTML = '';
  box.hidden = !testrailOutcome;
  if (!testrailOutcome) return;
  const { state, run } = testrailOutcome;
  if (state === 'posting') {
    box.append(el('div', 'label', `Posting to TestRail ${run}…`));
    return;
  }
  if (state === 'error') {
    box.append(el('div', 'label', `TestRail ${run}: not posted`), el('div', 'error', testrailOutcome.error ?? ''));
    return;
  }
  const cases = testrailOutcome.cases ?? [];
  const posted = cases.filter((c) => c.status === 'posted').length;
  box.append(el('div', 'label', `TestRail ${run}: ${posted} of ${cases.length} case${cases.length === 1 ? '' : 's'} posted`));
  const list = el('ul');
  for (const c of cases) {
    const li = el('li', c.status);
    li.append(el('b', '', `${c.status === 'posted' ? '✓' : c.status === 'skipped' ? '–' : '✗'} ${c.case}`), document.createTextNode(` ${c.detail}`));
    list.appendChild(li);
  }
  box.appendChild(list);
  if (cases.some((c) => c.status === 'error')) {
    const retry = el('button', 'link', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => void postToTestRail(run));
    box.appendChild(retry);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Recordings left by a crash (unsaved.ts): offered on the Cases screen, saved the usual way or discarded

async function renderUnsaved(): Promise<void> {
  const box = $<HTMLDivElement>('unsaved');
  const found = await window.recorder.unsavedList();
  box.innerHTML = '';
  box.hidden = !found.length;
  for (const u of found) {
    const row = el('div', 'unsaved-row');
    const when = u.startedAt ? new Date(u.startedAt).toLocaleString() : 'unknown time';
    row.append(el('div', 'text', `A recording didn't finish saving: ${u.cases.join(', ') || 'no cases'} · ${when} · ${formatDuration(u.durationMs)} · ${formatBytes(u.bytes)}`));
    const save = el('button', 'primary', 'Save it');
    save.type = 'button';
    save.addEventListener('click', () => void recoverUnsaved(u));
    const discard = el('button', '', 'Discard');
    discard.type = 'button';
    discard.addEventListener('click', async () => {
      if (!window.confirm('Discard this recording? It cannot be recovered afterwards.')) return;
      await window.recorder.unsavedDiscard(u.id);
      await renderUnsaved();
    });
    row.append(save, discard);
    box.appendChild(row);
  }
}

async function recoverUnsaved(u: UnsavedRecording): Promise<void> {
  loggedCases = [];
  testrailOutcome = null;
  renderTestRail();
  showView('done');
  $<HTMLDivElement>('done-icon').textContent = '⏳';
  $<HTMLDivElement>('done-title').textContent = `Saving the unfinished recording (${formatDuration(u.durationMs)})…`;
  $<HTMLElement>('done-file').textContent = '';
  $<HTMLDivElement>('done-meta').textContent = `Into ${u.folder}`;
  $<HTMLOListElement>('done-cases').innerHTML = '';
  // Its cases aren't loaded: "the same cases again" would record whatever is queued.
  $<HTMLButtonElement>('record-again').hidden = true;
  const progress = $<HTMLProgressElement>('progress');
  progress.value = 0;
  progress.hidden = false;
  setDoneActions(false);
  compressing = true;
  const result = await window.recorder.unsavedSave(u.id);
  compressing = false;
  await showSaveResult(result, null);
  await renderUnsaved();
}

/** A case's result as shown: a guide that ended with Done shows 'done' (it is recorded as 'pass'). Same as output.ts. */
function shownResult(c: LoggedCase): string | null {
  return c.guide && c.result ? 'done' : c.result;
}

function renderDoneCases(): void {
  const list = $<HTMLOListElement>('done-cases');
  list.innerHTML = '';
  loggedCases.forEach((c) => {
    const li = el('li');
    const result = shownResult(c);
    const pill = el('span', 'pill', result ? RESULT_LABEL[result] : 'NO RESULT');
    if (result) pill.dataset.result = result;
    const who = el('div', 'who');
    who.append(el('b', '', c.guide ? 'Guide' : c.row ? `${c.id} · ${c.row}` : c.id), el('div', '', c.title));
    li.append(pill, who);
    list.appendChild(li);
  });
}

function setDoneActions(enabled: boolean): void {
  ['show-folder', 'record-again', 'new-run'].forEach((id) => ($<HTMLButtonElement>(id).disabled = !enabled));
}

// ---------------------------------------------------------------------------------------------------------------------
// History: past runs, read from the step logs; play a video and jump to any step

let historyEntries: HistoryEntry[] = [];
let selectedRun: HistoryEntry | null = null;
let runMarks: { seconds: number; el: HTMLButtonElement }[] = [];

const RESULT_LABEL: Record<string, string> = { pass: 'PASSED', fail: 'FAILED', blocked: 'BLOCKED', done: 'DONE', 'not recorded': 'NO RESULT' };

function resultPill(result: string, text?: string): HTMLSpanElement {
  const pill = el('span', 'pill', text ?? RESULT_LABEL[result] ?? result.toUpperCase());
  pill.dataset.result = result;
  return pill;
}

/** "01:23.4" → 83.4 */
function parseAt(at: string): number {
  const [m, s] = at.split(':');
  return Number(m) * 60 + Number(s);
}

function fileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return `file://${normalized.startsWith('/') ? '' : '/'}${normalized.split('/').map(encodeURIComponent).join('/')}`;
}

async function openHistory(): Promise<void> {
  if (isRecording() || countdownUntil) return;
  showView('history');
  setStatus('Reading recordings…');
  historyEntries = await window.recorder.historyList();
  setStatus(`${historyEntries.length} recording(s) in ${settings?.output.root ?? 'the parent folder'}.`);
  renderHistoryList();
  if (selectedRun) {
    const again = historyEntries.find((e) => e.log === selectedRun?.log);
    if (again) selectRun(again);
  }
}

function renderHistoryList(): void {
  const text = $<HTMLInputElement>('history-filter').value.trim().toLowerCase();
  const result = $<HTMLSelectElement>('history-result').value;
  const kind = $<HTMLSelectElement>('history-kind').value;
  const list = $<HTMLDivElement>('history-list');
  list.innerHTML = '';

  const shown = historyEntries.filter((e) => {
    const haystack = [e.subject, e.config, e.video, ...e.cases.map((c) => `${c.id} ${c.row ?? ''} ${c.title}`)].join(' ').toLowerCase();
    const kindOk = !kind || (kind === 'guide') === (e.kind === 'guide');
    const resultOk = !result || e.overall === result || e.cases.some((c) => c.result === result);
    return (!text || haystack.includes(text)) && kindOk && resultOk;
  });
  if (!shown.length) {
    const empty = el('div', 'empty');
    empty.append(el('div', 'empty-title', historyEntries.length ? 'No recordings match' : 'No recordings yet'),
      el('div', '', historyEntries.length ? 'Change the filter.' : 'Recordings you make appear here.'));
    list.appendChild(empty);
    return;
  }

  let lastDay = '';
  for (const entry of shown) {
    const date = entry.startedAt ? new Date(entry.startedAt) : null;
    const day = date ? date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : 'Unknown date';
    if (day !== lastDay) {
      list.appendChild(el('div', 'history-day', day));
      lastDay = day;
    }
    const card = el('button', `run${selectedRun?.log === entry.log ? ' selected' : ''}`);
    card.type = 'button';
    const top = el('div', 'run-top');
    top.append(
      el('span', '', date ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''),
      el('span', 'where', `${entry.subject} / ${entry.config}`),
      el('span', '', `${entry.duration}${entry.videoExists ? ` · ${formatBytes(entry.bytes)}` : ' · missing'}`),
    );
    const cases = el('div', 'run-cases');
    if (entry.kind === 'guide') cases.append(resultPill('guide', 'GUIDE'), resultPill(entry.overall), el('span', 'hint', entry.cases[0]?.title ?? ''));
    else entry.cases.forEach((c) => cases.appendChild(resultPill(c.result, `${c.id}${c.row ? ` · ${c.row}` : ''}`)));
    card.append(top, el('div', 'run-file', entry.video.split(/[\\/]/).pop() ?? entry.video), cases);
    card.addEventListener('click', () => selectRun(entry));
    list.appendChild(card);
  }
}

function selectRun(entry: HistoryEntry): void {
  selectedRun = entry;
  renderHistoryList();
  $<HTMLDivElement>('history-empty').hidden = true;
  $<HTMLDivElement>('history-run').hidden = false;
  $<HTMLDivElement>('hr-where').textContent = `${entry.subject} / ${entry.config}`;
  $<HTMLDivElement>('hr-file').textContent = entry.video.split(/[\\/]/).pop() ?? entry.video;
  const when = entry.startedAt ? new Date(entry.startedAt).toLocaleString() : '';
  $<HTMLDivElement>('hr-meta').textContent = `${when} · ${entry.duration}${entry.videoExists ? ` · ${formatBytes(entry.bytes)}` : ''} · overall ${entry.overall}`;

  const video = $<HTMLVideoElement>('hr-video');
  video.hidden = !entry.videoExists;
  $<HTMLDivElement>('hr-missing').hidden = entry.videoExists;
  if (entry.videoExists) video.src = fileUrl(entry.video);
  else video.removeAttribute('src');
  $<HTMLButtonElement>('hr-show').disabled = !entry.videoExists;
  $<HTMLButtonElement>('hr-report').disabled = !entry.videoExists;
  // A guide's steps come from its .md file, not from TestRail.
  $<HTMLButtonElement>('hr-load').hidden = entry.kind === 'guide';

  renderEvidence(entry, null);
  renderClips(entry);
  showPlaying(entry, null);
  renderHistorySteps(entry, null);
  // The requests come from the .har: read it after the rest is shown, and only use it if this run is still selected.
  if (entry.har) {
    void window.recorder.historyNetwork(entry.har).then((result) => {
      if (selectedRun !== entry || !result.ok) return;
      renderEvidence(entry, result.requests);
      renderHistorySteps(entry, result.requests);
    });
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** A small pill for the evidence row; `kind` colours it (error, warn, ok, muted). */
function chip(text: string, kind: 'error' | 'warn' | 'ok' | 'muted' | 'note' | '' = ''): HTMLSpanElement {
  const node = el('span', `chip${kind ? ` ${kind}` : ''}`, text);
  return node;
}

/** What the recording holds besides the video: console, network, clicks and typing, clips. */
function renderEvidence(entry: HistoryEntry, requests: HistoryRequest[] | null): void {
  const box = $<HTMLDivElement>('hr-evidence');
  box.innerHTML = '';
  const steps = entry.cases.flatMap((c) => c.steps);
  if (entry.browserConsole === 'captured') {
    const entries = steps.flatMap((s) => s.console ?? []);
    const errors = entries.filter((e) => e.level === 'error').length;
    const warnings = entries.filter((e) => e.level === 'warn').length;
    box.append(errors || warnings
      ? chip(`Console: ${[errors && plural(errors, 'error'), warnings && plural(warnings, 'warning')].filter(Boolean).join(', ')}`, errors ? 'error' : 'warn')
      : chip('Console: no errors', 'ok'));
  } else if (entry.browserConsole) {
    box.append(chip(`Console ${entry.browserConsole}`, 'muted'));
  }
  if (entry.network) {
    const failed = requests ? requests.filter((r) => r.failed).length : entry.network.failed;
    const total = requests ? requests.length : entry.network.requests;
    box.append(chip(`Network: ${plural(total, 'request')}${failed ? `, ${failed} failed` : ''}`, failed ? 'error' : 'ok'));
    const show = el('button', 'link', 'Show .har');
    show.type = 'button';
    show.addEventListener('click', () => entry.har && void window.recorder.reveal(entry.har));
    box.append(show);
  }
  const actions = steps.reduce((n, s) => n + (s.actions?.length ?? 0), 0);
  if (actions) box.append(chip(plural(actions, 'click / typing'), ''));
  const notes = steps.reduce((n, s) => n + (s.notes?.length ?? 0), 0);
  if (notes) box.append(chip(plural(notes, 'note'), 'note'));
  if (entry.clips.length) box.append(chip(plural(entry.clips.length, 'clip'), ''));
  box.hidden = !box.childElementCount;
}

function renderClips(entry: HistoryEntry): void {
  const list = $<HTMLDivElement>('hr-clips');
  list.innerHTML = '';
  $<HTMLDivElement>('hr-clips-box').hidden = !entry.clips.length;
  for (const clip of entry.clips) {
    const button = el('button', `hr-clip${clip.kind === 'failure' ? ' failure' : ''}`);
    button.type = 'button';
    button.title = clip.file;
    button.append(
      el('b', '', clip.case),
      el('span', '', clip.kind === 'failure' ? 'before Fail' : 'case'),
      el('span', 'hint', `${clip.from} → ${clip.to}`),
    );
    button.addEventListener('click', () => playClip(entry, clip));
    list.appendChild(button);
  }
}

/** Says when a clip is playing instead of the whole recording, with the way back. */
function showPlaying(entry: HistoryEntry, clip: SavedClip | null): void {
  const box = $<HTMLDivElement>('hr-playing');
  box.innerHTML = '';
  box.hidden = !clip;
  if (!clip) return;
  box.append(document.createTextNode(`Playing the clip ${clip.file.split(/[\\/]/).pop()} (${clip.from} → ${clip.to} of the recording). `));
  const back = el('button', 'link', 'Back to the whole recording');
  back.type = 'button';
  back.addEventListener('click', () => jumpTo(entry, parseAt(clip.from), false));
  box.appendChild(back);
}

function playClip(entry: HistoryEntry, clip: SavedClip): void {
  const video = $<HTMLVideoElement>('hr-video');
  video.hidden = false;
  video.src = fileUrl(clip.file);
  showPlaying(entry, clip);
  void video.play();
}

/** Plays the whole recording from `seconds` (switching back from a clip if one is playing). */
function jumpTo(entry: HistoryEntry, seconds: number, play = true): void {
  if (!entry.videoExists) return;
  const video = $<HTMLVideoElement>('hr-video');
  const whole = fileUrl(entry.video);
  const seek = () => {
    video.currentTime = seconds;
    if (play) void video.play();
  };
  showPlaying(entry, null);
  if (video.src === whole) {
    seek();
    return;
  }
  video.src = whole;
  video.addEventListener('loadedmetadata', seek, { once: true });
}

function actionText(a: { kind: string; text: string; value?: string }): string {
  if (a.kind === 'click') return `Click · ${a.text}`;
  if (a.kind === 'type') return `Type · ${a.text}: ${a.value ?? ''}`;
  if (a.kind === 'select') return `Choose · ${a.text}: ${a.value ?? ''}`;
  return `Key · ${a.text}`;
}

/** The steps, each with what happened while it was on screen (folded, with a one-line summary). */
function renderHistorySteps(entry: HistoryEntry, requests: HistoryRequest[] | null): void {
  const steps = $<HTMLDivElement>('hr-steps');
  // Keep the steps that were unfolded unfolded when the requests arrive.
  const open = new Set([...steps.querySelectorAll<HTMLDetailsElement>('details[open]')].map((d) => d.dataset.key));
  steps.innerHTML = '';
  runMarks = [];
  const rows = entry.cases.flatMap((c, ci) => c.steps.map((step, si) => ({ c, step, key: `${ci}:${si}`, seconds: parseAt(step.at) })));
  // A request belongs to the step on screen when it was made: the last one shown at or before it.
  const byRow = new Map<string, HistoryRequest[]>();
  for (const request of requests ?? []) {
    const row = [...rows].reverse().find((r) => r.seconds <= request.at + 0.05) ?? rows[0];
    if (!row) continue;
    byRow.set(row.key, [...(byRow.get(row.key) ?? []), request]);
  }

  let lastCase: HistoryEntry['cases'][number] | null = null;
  for (const { c, step, key, seconds } of rows) {
    if (c !== lastCase) {
      lastCase = c;
      const head = el('div', 'hr-case');
      head.append(resultPill(c.result), el('span', '', entry.kind === 'guide' ? 'Guide' : `${c.id}${c.row ? ` · ${c.row}` : ''}`), el('span', 'hint', c.title));
      steps.appendChild(head);
    }
    const row = el('button', 'hr-step');
    row.type = 'button';
    row.append(el('span', 'at', step.at), el('span', 'pos', step.step), el('span', '', step.text));
    row.addEventListener('click', () => jumpTo(entry, seconds));
    steps.appendChild(row);
    runMarks.push({ seconds, el: row });

    const extras = stepExtras(entry, step, byRow.get(key) ?? []);
    if (!extras) continue;
    extras.dataset.key = key;
    if (open.has(key)) extras.open = true;
    steps.appendChild(extras);
  }
  if (!rows.length) {
    // Cases without steps still show their result.
    for (const c of entry.cases) {
      const head = el('div', 'hr-case');
      head.append(resultPill(c.result), el('span', '', `${c.id}${c.row ? ` · ${c.row}` : ''}`), el('span', 'hint', c.title));
      steps.appendChild(head);
    }
  }
}

/** The folded list under a step: console errors / warnings, failed requests, clicks and typing; null when none. */
function stepExtras(entry: HistoryEntry, step: HistoryStep, requests: HistoryRequest[]): HTMLDetailsElement | null {
  const problems = (step.console ?? []).filter((e) => e.level === 'error' || e.level === 'warn');
  const logs = (step.console ?? []).length - problems.length;
  const failed = requests.filter((r) => r.failed);
  const actions = step.actions ?? [];
  const notes = step.notes ?? [];
  if (!problems.length && !failed.length && !actions.length && !notes.length && !logs && !requests.length) return null;

  const errors = problems.filter((e) => e.level === 'error').length;
  const warnings = problems.length - errors;
  const parts = [
    errors && plural(errors, 'error'),
    warnings && plural(warnings, 'warning'),
    requests.length && (failed.length ? `${failed.length} of ${plural(requests.length, 'request')} failed` : plural(requests.length, 'request')),
    actions.length && plural(actions.length, 'click / typing'),
    notes.length && plural(notes.length, 'note'),
    logs && plural(logs, 'log'),
  ].filter(Boolean) as string[];

  const details = el('details', `hr-extras${errors || failed.length ? ' bad' : warnings ? ' warn' : ''}`);
  details.appendChild(el('summary', '', parts.join(' · ')));
  const list = el('ul');
  type Item = { seconds: number; at: string; kind: string; text: string; detail?: string };
  const items: Item[] = [
    ...problems.map((e) => ({ seconds: parseAt(e.at), at: e.at, kind: e.level, text: e.text.split('\n')[0], detail: e.source })),
    ...failed.map((r) => ({
      seconds: r.at,
      at: formatAt(r.at),
      kind: 'request',
      text: `${r.method} ${r.status || r.error || 'failed'} ${r.url}`,
    })),
    ...actions.map((a) => ({ seconds: parseAt(a.at), at: a.at, kind: 'action', text: actionText(a) })),
    ...notes.map((n) => ({ seconds: parseAt(n.at), at: n.at, kind: 'note', text: `Note · ${n.text}` })),
  ].sort((a, b) => a.seconds - b.seconds);
  for (const item of items) {
    const li = el('li', item.kind);
    const at = el('button', 'at link', item.at);
    at.type = 'button';
    at.addEventListener('click', () => jumpTo(entry, item.seconds));
    li.append(at, el('span', 'text', item.text));
    if (item.detail) li.title = item.detail;
    list.appendChild(li);
  }
  if (logs) list.appendChild(el('li', 'muted', `${plural(logs, 'console.log')} more in the step log`));
  if (requests.length > failed.length) list.appendChild(el('li', 'muted', `${plural(requests.length - failed.length, 'request')} that worked, in the .har`));
  details.appendChild(list);
  return details;
}

/** 83.4 → "01:23.4" */
function formatAt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${String(m).padStart(2, '0')}:${(seconds - m * 60).toFixed(1).padStart(4, '0')}`;
}

/** Highlights the step being shown while the video plays. */
$<HTMLVideoElement>('hr-video').addEventListener('timeupdate', (event) => {
  const t = (event.target as HTMLVideoElement).currentTime;
  let current: HTMLButtonElement | null = null;
  for (const mark of runMarks) if (mark.seconds <= t + 0.05) current = mark.el;
  runMarks.forEach((m) => m.el.classList.toggle('current', m.el === current));
});

/** Loads the run's cases again (from TestRail, same Examples row) into the queue. */
async function loadRunCases(entry: HistoryEntry): Promise<void> {
  const loadBtn = $<HTMLButtonElement>('hr-load');
  loadBtn.disabled = true;
  const withBg = settings?.preferences.includeBackground ?? true;
  const built: ActiveCase[] = [];
  const skipped: string[] = [];
  for (const c of entry.cases) {
    setStatus(`Loading ${c.id} from TestRail…`);
    const result = await window.recorder.testrailLoad(c.id);
    if (!result.ok || result.kind !== 'case') {
      skipped.push(c.id);
      continue;
    }
    const examples = result.feature.scenarios[0].examples;
    const rowIndex = c.row && examples ? Math.max(0, examples.rows.findIndex((r) => r[0] === c.row)) : 0;
    built.push(buildCase(result.feature, 0, rowIndex, withBg));
  }
  loadBtn.disabled = false;
  const added = addToQueue(built, `${built.length} case(s)`);
  showView('cases');
  setStatus(`${added}${skipped.length ? ` Not found in TestRail: ${skipped.join(', ')}.` : ''}`, skipped.length ? 'error' : 'ok');
}

// ---------------------------------------------------------------------------------------------------------------------
// Remote control (⚙ Settings → Allow remote control; see remote.ts). Each command goes through the same functions as
// the UI and the hotkeys, so a remote recording is identical to a manual one.

/** 'done' ends a guide; it is the Pass hotkey under the name a guide uses. */
const REMOTE_ACTIONS = ['next', 'previous', 'pause', 'pass', 'fail', 'blocked', 'done', 'stop'];

function runAction(action: HotkeyAction | 'stop'): void {
  if (view !== 'recording') return;
  if (action === 'next') goToStep(stepIndex + 1);
  else if (action === 'previous') goToStep(stepIndex - 1);
  else if (action === 'pause') togglePause();
  else if (action === 'stop') stopRecording();
  else if (action === 'note') window.recorder.noteOpen();
  else recordResult(action);
}

/**
 * A note on the step on screen (hotkey, HUD, the recording view, or remote control): kept in the step log under that
 * step, and shown above the step card in the video for a few seconds. One line, at most NOTE_MAX_LENGTH characters.
 */
function addNote(raw: string): { ok: true; note: string; step: string } | { ok: false; error: string } {
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX_LENGTH);
  if (!text) return { ok: false, error: 'The note is empty' };
  if (!isRecording() || !activeCase) return { ok: false, error: 'Not recording' };
  const step = loggedCases[loggedCases.length - 1]?.steps.at(-1);
  if (!step) return { ok: false, error: 'No step on screen yet' };
  (step.notes ??= []).push({ text, atMs: elapsedMs() });
  noteShown = { text, until: Date.now() + NOTE_MS };
  return { ok: true, note: text, step: `${step.section} ${step.position}/${step.total}` };
}

function remoteStatus(): Record<string, unknown> {
  const step = activeCase?.steps[stepIndex];
  const guide = activeCase?.guide ?? (loggedCases[0]?.guide || queue.some((c) => c.guide));
  const saved = view === 'done' && !compressing ? lastSavedPath : null;
  return {
    ok: true,
    view,
    kind: guide ? 'guide' : 'cases',
    recording: isRecording(),
    countdown: countdownUntil > 0,
    paused,
    compressing,
    case: activeCase ? { label: activeCase.label, title: activeCase.title, number: runIndex + 1, of: runCases.length } : null,
    step: activeCase && step ? { number: stepIndex + 1, of: activeCase.steps.length, keyword: step.keyword, text: step.text } : null,
    results: loggedCases.map((c) => ({ id: c.id, row: c.row, title: c.title, result: c.result })),
    saved,
    chapters: saved && guide ? saved.replace(/\.mp4$/, '.md') : null,
    card: currentCard()?.title ?? null,
    testrail: testrailOutcome,
  };
}

/**
 * Picks the window by title, then loads the feature, queues every scenario (every Examples row) and starts recording.
 * The window is checked first, so a call that fails leaves the loaded case and the queue as they were.
 */
async function remoteRecord(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (view === 'recording') return { ok: false, error: 'Already recording' };
  if (compressing) return { ok: false, error: 'The previous video is still being saved; check the status again in a moment' };
  const feature = args.feature as GherkinFeature;
  if (!feature.scenarios.length) return { ok: false, error: 'The feature has no Scenario' };

  let source: CaptureSource | undefined;
  if (typeof args.tab === 'string') {
    // A browser tab (headless or not): only the tabs are listed, so no screen capture is involved at all.
    const wanted = args.tab.toLowerCase();
    const tabs = await window.recorder.listTabs();
    source = tabs.find((t) => t.name.toLowerCase().includes(wanted) || (t.url ?? '').toLowerCase().includes(wanted));
    if (!source) {
      return { ok: false, error: `No browser tab title or URL contains "${args.tab}" (debugging port ${settings?.preferences.browserPort})`, tabs: tabs.map((t) => `${t.name} · ${t.url}`) };
    }
  } else {
    await loadSources();
    const wanted = String(args.window).toLowerCase();
    source = allSources.find((s) => s.kind !== 'tab' && s.name.toLowerCase().includes(wanted));
    if (!source) {
      return { ok: false, error: `No window or screen title contains "${args.window}"`, windows: allSources.filter((s) => s.kind !== 'tab').map((s) => s.name) };
    }
  }
  selectedSource = source;
  // A preview of another source may still be running: capture this one.
  await startPreview();
  if (!previewing()) return { ok: false, error: `Could not capture "${source.name}"` };

  useFeature(feature, String(args.source));
  const withBackground = settings?.preferences.includeBackground ?? true;
  queue = feature.scenarios.flatMap((scenario, i) =>
    (scenario.examples?.rows.length ? scenario.examples.rows : [null]).map((_, row) => buildCase(feature, i, row, withBackground)),
  );
  renderQueue();

  // startRecording saves what the ③ fields hold, so fill them: the current output, with the subject/config asked for.
  applyOutputPreview(await window.recorder.previewOutput());
  if (typeof args.subject === 'string') $<HTMLInputElement>('out-subject').value = args.subject;
  if (typeof args.config === 'string') $<HTMLInputElement>('out-config').value = args.config;
  // Posting to TestRail only when the caller asks: a remote run never inherits a run typed in the UI.
  $<HTMLInputElement>('out-run').value = typeof args.run === 'string' ? args.run : '';
  await startRecording();
  if (!activeCase) return { ok: false, error: `Could not start recording "${source.name}"` };
  return { ok: true, cases: queue.map((c) => c.label), ...(source.kind === 'tab' ? { tab: source.name } : { window: source.name }) };
}

/** Why an action would be ignored right now (the hotkeys ignore it silently; a remote caller gets told). */
function ignoredBecause(action: string): string | null {
  if (countdownUntil) return 'the countdown is still running';
  if (finishing) return 'the last case is closed and the video is being finished';
  if (paused && ['next', 'previous', 'pass', 'fail', 'blocked', 'done'].includes(action)) return 'the recording is paused';
  if (activeCase?.guide && (action === 'fail' || action === 'blocked')) return 'a guide ends with Done (done or pass), not Fail or Blocked';
  if (!activeCase?.guide && action === 'done') return 'done ends a guide; close a test case with pass, fail or blocked';
  if (action === 'next' && activeCase && stepIndex >= activeCase.steps.length - 1) return 'this is already the last step';
  if (action === 'previous' && stepIndex === 0) return 'this is already the first step';
  return null;
}

async function answerRemote(request: RemoteRequest): Promise<unknown> {
  if (request.command === 'status') return remoteStatus();
  if (request.command === 'record') return remoteRecord(request.args);
  if (request.command === 'note') return addNote(String(request.args.text ?? ''));

  const action = String(request.args.action);
  if (!REMOTE_ACTIONS.includes(action)) return { ok: false, error: `Unknown action "${action}"; use ${REMOTE_ACTIONS.join(', ')}` };
  if (view !== 'recording') return { ok: false, error: 'Not recording', view };
  const ignored = action === 'stop' ? null : ignoredBecause(action);
  if (ignored) return { ...remoteStatus(), ok: false, error: `Ignored: ${ignored}` };
  runAction(action === 'done' ? 'pass' : (action as HotkeyAction | 'stop'));
  return remoteStatus();
}

// ---------------------------------------------------------------------------------------------------------------------
// Settings dialog

function renderHotkeys(failed: HotkeyAction[] = []): void {
  if (!settings) return;
  const hotkeys = settings.hotkeys;
  const container = $<HTMLDivElement>('hotkeys');
  container.innerHTML = '';
  (Object.keys(HOTKEY_LABELS) as HotkeyAction[]).forEach((action) => {
    const capturing = capturingAction === action;
    const row = el('div', `hotkey${failed.includes(action) ? ' failed' : ''}`);
    const key = el('kbd', capturing ? 'capturing' : '', capturing ? 'Press keys…' : prettyAccelerator(hotkeys[action]));
    const change = el('button', '', capturing ? 'Cancel' : 'Change');
    change.type = 'button';
    change.addEventListener('click', () => {
      capturingAction = capturing ? null : action;
      renderHotkeys();
    });
    row.append(el('span', '', HOTKEY_LABELS[action]), key, change);
    container.appendChild(row);
  });
}

function showTestRailInfo(info: TestRailInfo, message = '', kind: 'info' | 'ok' | 'error' = 'info'): void {
  $<HTMLInputElement>('tr-url').value = info.url;
  $<HTMLInputElement>('tr-user').value = info.user;
  const key = $<HTMLInputElement>('tr-key');
  key.value = '';
  key.placeholder = info.hasKey ? '•••••••• saved (type to replace)' : 'Paste your TestRail API key';
  const sourceText = {
    settings: 'Using the details saved here.',
    environment: 'Using the TESTRAIL_* environment variables (start-up terminal). Save details here to use them from the Dock too.',
    none: 'Not set up yet.',
  }[info.source];
  const state = $<HTMLSpanElement>('tr-state');
  state.textContent = message || (info.encryption ? sourceText : `${sourceText} The system keychain is unavailable, so the key can't be saved.`);
  state.dataset.kind = kind;
}

async function saveTestRail(): Promise<boolean> {
  const apiKey = $<HTMLInputElement>('tr-key').value.trim();
  const result = await window.recorder.setTestRail({
    url: $<HTMLInputElement>('tr-url').value,
    user: $<HTMLInputElement>('tr-user').value,
    // Empty field keeps the stored key.
    apiKey: apiKey || undefined,
  });
  if (result.ok) showTestRailInfo(result.info, 'Saved. The API key is stored encrypted in the system keychain.', 'ok');
  else showTestRailInfo(result.info, result.error, 'error');
  return result.ok;
}

async function openSettings(): Promise<void> {
  const loaded = await window.recorder.getSettings();
  settings = loaded.settings;
  renderHotkeys(loaded.failed);
  $<HTMLElement>('settings-root').textContent = settings.output.root;
  $<HTMLInputElement>('max-mb').value = String(settings.preferences.maxMb);
  $<HTMLInputElement>('pref-bg').checked = settings.preferences.includeBackground;
  $<HTMLInputElement>('countdown').value = String(settings.preferences.countdownSec);
  $<HTMLSelectElement>('label-corner').value = settings.preferences.labelCorner;
  $<HTMLInputElement>('pref-remote').checked = settings.preferences.remoteControl;
  $<HTMLInputElement>('pref-console').checked = settings.preferences.browserConsole;
  $<HTMLInputElement>('pref-network').checked = settings.preferences.browserNetwork;
  $<HTMLInputElement>('pref-secrets').checked = settings.preferences.keepSecrets;
  $<HTMLInputElement>('browser-port').value = String(settings.preferences.browserPort);
  $<HTMLInputElement>('pref-clips').checked = settings.preferences.clips;
  $<HTMLInputElement>('pref-input').checked = settings.preferences.showInput;
  $<HTMLInputElement>('pref-blur').checked = settings.preferences.blurSensitive;
  $<HTMLInputElement>('failure-clip').value = String(settings.preferences.failureClipSec);
  showTestRailInfo(await window.recorder.getTestRail());
  $<HTMLDialogElement>('settings').showModal();
}

document.addEventListener('keydown', async (event) => {
  if (!capturingAction || !settings) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'Escape') {
    capturingAction = null;
    renderHotkeys();
    return;
  }
  const accelerator = acceleratorFromEvent(event);
  if (!accelerator) return;
  if (!/(Control|Alt|Command|Super)\+/.test(accelerator)) {
    setStatus('A hotkey needs Ctrl, Alt or Cmd, so it does not fire while you type.', 'error');
    return;
  }
  const action = capturingAction;
  capturingAction = null;
  const result = await window.recorder.setHotkey(action, accelerator);
  settings.hotkeys = result.settings.hotkeys;
  renderHotkeys();
  setStatus(
    result.ok ? `${HOTKEY_LABELS[action]}: ${prettyAccelerator(accelerator)}` : `${HOTKEY_LABELS[action]}: ${result.error}`,
    result.ok ? 'ok' : 'error',
  );
}, true);

// ---------------------------------------------------------------------------------------------------------------------
// Wiring

$<HTMLButtonElement>('next').addEventListener('click', goNext);
$<HTMLButtonElement>('back').addEventListener('click', goBack);
document.querySelectorAll<HTMLButtonElement>('.stepper-item').forEach((item) =>
  item.addEventListener('click', () => {
    const from = FLOW.indexOf(view);
    const to = FLOW.indexOf(item.dataset.goto as View);
    // Forward only through steps that are complete.
    for (let i = from; i < to; i++) {
      const problem = canLeave(FLOW[i]);
      if (problem) {
        setStatus(problem, 'error');
        return;
      }
    }
    if (view === 'cases' && to > 0) queueLoadedCaseIfEmpty();
    showView(FLOW[to]);
  }),
);

$<HTMLInputElement>('case-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void loadInput($<HTMLInputElement>('case-input').value);
});
$<HTMLButtonElement>('case-load').addEventListener('click', () => void loadInput($<HTMLInputElement>('case-input').value));
$<HTMLInputElement>('run-filter').addEventListener('input', renderRunTests);
$<HTMLButtonElement>('open-feature').addEventListener('click', async () => {
  const result = await window.recorder.openFeature();
  if (!result.ok) {
    if (result.error) setStatus(result.error, 'error');
    return;
  }
  useFeature(result.feature, result.path.split(/[\\/]/).pop() ?? 'Feature file');
});
$<HTMLButtonElement>('toggle-paste').addEventListener('click', () => {
  const box = $<HTMLDivElement>('paste-box');
  box.hidden = !box.hidden;
  renderCaseCard();
  if (!box.hidden) $<HTMLTextAreaElement>('paste-text').focus();
});
$<HTMLButtonElement>('paste-use').addEventListener('click', async () => {
  const result = await window.recorder.parseSteps($<HTMLTextAreaElement>('paste-text').value);
  if (result.ok) useFeature(result.feature, 'Pasted steps');
  else setStatus(result.error, 'error');
});
$<HTMLSelectElement>('scenario-select').addEventListener('change', (event) => {
  scenarioIndex = Number((event.target as HTMLSelectElement).value);
  rowIndex = 0;
  renderCaseCard();
});
$<HTMLInputElement>('include-bg').addEventListener('change', renderCaseCard);
$<HTMLButtonElement>('add-queue').addEventListener('click', () => {
  const c = currentCase();
  if (!c) return;
  setStatus(addToQueue([c], c.guide ? c.title : c.label), 'ok');
});
$<HTMLButtonElement>('add-all-rows').addEventListener('click', () => {
  const feature = loadedFeature;
  if (!feature) return;
  const rows = feature.scenarios[scenarioIndex].examples?.rows ?? [];
  const withBg = $<HTMLInputElement>('include-bg').checked;
  setStatus(addToQueue(rows.map((_, i) => buildCase(feature, scenarioIndex, i, withBg)), `${rows.length} rows`), 'ok');
});
$<HTMLButtonElement>('clear-queue').addEventListener('click', () => {
  queue = [];
  renderQueue();
});

$<HTMLInputElement>('source-filter').addEventListener('input', renderSources);
$<HTMLButtonElement>('refresh-sources').addEventListener('click', () => void loadSources());

$<HTMLInputElement>('out-subject').addEventListener('change', () => void saveOutput());
$<HTMLInputElement>('out-config').addEventListener('change', () => void saveOutput());
$<HTMLButtonElement>('change-root').addEventListener('click', () => void changeRoot());

$<HTMLButtonElement>('step-prev').addEventListener('click', () => goToStep(stepIndex - 1));
$<HTMLButtonElement>('step-next').addEventListener('click', () => goToStep(stepIndex + 1));
$<HTMLButtonElement>('res-pass').addEventListener('click', () => recordResult('pass'));
$<HTMLButtonElement>('res-fail').addEventListener('click', () => recordResult('fail'));
$<HTMLButtonElement>('res-blocked').addEventListener('click', () => recordResult('blocked'));
$<HTMLButtonElement>('pause').addEventListener('click', togglePause);
$<HTMLButtonElement>('stop').addEventListener('click', stopRecording);

$<HTMLButtonElement>('show-folder').addEventListener('click', () => void window.recorder.reveal(lastSavedPath));
$<HTMLButtonElement>('record-again').addEventListener('click', () => {
  loggedCases = [];
  showView('source');
});
$<HTMLButtonElement>('new-run').addEventListener('click', () => {
  loggedCases = [];
  queue = [];
  renderQueue();
  showView('cases');
});

$<HTMLButtonElement>('open-settings').addEventListener('click', () => void openSettings());
$<HTMLButtonElement>('open-history').addEventListener('click', () => void openHistory());
$<HTMLInputElement>('history-filter').addEventListener('input', renderHistoryList);
$<HTMLSelectElement>('history-result').addEventListener('change', renderHistoryList);
$<HTMLSelectElement>('history-kind').addEventListener('change', renderHistoryList);
$<HTMLButtonElement>('history-refresh').addEventListener('click', () => void openHistory());
$<HTMLButtonElement>('hr-show').addEventListener('click', () => selectedRun && void window.recorder.reveal(selectedRun.video));
$<HTMLButtonElement>('hr-report').addEventListener('click', async () => {
  if (!selectedRun) return;
  const result = await window.recorder.historyReport(selectedRun.log);
  if (!result.ok) setStatus(`Could not open the report: ${result.error}`, 'error');
});
$<HTMLButtonElement>('hr-copy').addEventListener('click', async () => {
  if (!selectedRun) return;
  await window.recorder.copyText(selectedRun.video);
  setStatus('Path copied.', 'ok');
});
$<HTMLButtonElement>('hr-load').addEventListener('click', () => selectedRun && void loadRunCases(selectedRun));
$<HTMLButtonElement>('settings-change-root').addEventListener('click', () => void changeRoot());
$<HTMLInputElement>('max-mb').addEventListener('change', async (event) => {
  const value = Math.max(5, Math.min(500, Number((event.target as HTMLInputElement).value) || 50));
  settings = await window.recorder.setPreferences({ maxMb: value });
});
$<HTMLInputElement>('countdown').addEventListener('change', async (event) => {
  const value = Math.max(0, Math.min(10, Math.round(Number((event.target as HTMLInputElement).value) || 0)));
  (event.target as HTMLInputElement).value = String(value);
  settings = await window.recorder.setPreferences({ countdownSec: value });
});
$<HTMLSelectElement>('label-corner').addEventListener('change', async (event) => {
  const value = (event.target as HTMLSelectElement).value === 'right' ? 'right' : 'left';
  settings = await window.recorder.setPreferences({ labelCorner: value });
});
$<HTMLInputElement>('pref-bg').addEventListener('change', async (event) => {
  settings = await window.recorder.setPreferences({ includeBackground: (event.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('pref-remote').addEventListener('change', async (event) => {
  settings = await window.recorder.setPreferences({ remoteControl: (event.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('pref-console').addEventListener('change', async (event) => {
  settings = await window.recorder.setPreferences({ browserConsole: (event.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('pref-blur').addEventListener('change', async (event) => {
  settings = await window.recorder.setPreferences({ blurSensitive: (event.target as HTMLInputElement).checked });
  // The tab being previewed picks it up when its stream restarts.
  if (tabStreaming && !isRecording()) void startPreview();
});
$<HTMLInputElement>('pref-input').addEventListener('change', async (event) => {
  settings = await window.recorder.setPreferences({ showInput: (event.target as HTMLInputElement).checked });
  // The tab being previewed picks it up when its stream restarts.
  if (tabStreaming && !isRecording()) void startPreview();
});
$<HTMLInputElement>('pref-clips').addEventListener('change', async (event) => {
  settings = await window.recorder.setPreferences({ clips: (event.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('failure-clip').addEventListener('change', async (event) => {
  const value = Math.max(0, Math.min(300, Math.round(Number((event.target as HTMLInputElement).value) || 0)));
  (event.target as HTMLInputElement).value = String(value);
  settings = await window.recorder.setPreferences({ failureClipSec: value });
});
$<HTMLInputElement>('pref-network').addEventListener('change', async (event) => {
  settings = await window.recorder.setPreferences({ browserNetwork: (event.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('pref-secrets').addEventListener('change', async (event) => {
  settings = await window.recorder.setPreferences({ keepSecrets: (event.target as HTMLInputElement).checked });
});
$<HTMLInputElement>('browser-port').addEventListener('change', async (event) => {
  const value = Math.round(Number((event.target as HTMLInputElement).value));
  const port = value >= 1024 && value <= 65535 ? value : 9222;
  (event.target as HTMLInputElement).value = String(port);
  settings = await window.recorder.setPreferences({ browserPort: port });
  allSources = [];
});
$<HTMLButtonElement>('tr-save').addEventListener('click', () => void saveTestRail());
$<HTMLButtonElement>('tr-test').addEventListener('click', async () => {
  // Test what is typed: save first if anything changed.
  if (!(await saveTestRail())) return;
  const state = $<HTMLSpanElement>('tr-state');
  state.textContent = 'Connecting…';
  state.dataset.kind = 'info';
  const result = await window.recorder.testTestRail();
  if (result.ok) showTestRailInfo(result.info, 'Connected to TestRail.', 'ok');
  else showTestRailInfo(result.info, result.error, 'error');
});
$<HTMLDialogElement>('settings').addEventListener('close', () => {
  capturingAction = null;
});

window.recorder.onHotkey(runAction);
window.recorder.onNoteFocus(() => $<HTMLInputElement>('note-text').focus());
window.recorder.onNoteAdd((text) => {
  const added = addNote(text);
  if (!added.ok) setStatus(`Note not added: ${added.error}`, 'error');
});
$<HTMLFormElement>('note-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $<HTMLInputElement>('note-text');
  const added = addNote(input.value);
  if (added.ok) {
    input.value = '';
    input.blur();
    setStatus(`Note added to ${added.step}.`, 'ok');
  } else setStatus(`Note not added: ${added.error}`, 'error');
});

window.recorder.onRemoteCommand(async (request) => {
  let result: unknown;
  try {
    result = await answerRemote(request);
  } catch (error) {
    result = { ok: false, error: (error as Error).message };
  }
  window.recorder.remoteReply(request.id, result);
});

window.recorder.onCompressProgress(({ fraction, preset }) => {
  $<HTMLProgressElement>('progress').value = fraction;
  if (preset === 'B') $<HTMLDivElement>('done-title').textContent = 'Still above the size limit, re-encoding smaller…';
  if (preset === 'steps') $<HTMLDivElement>('done-title').textContent = 'Adding the steps as chapters and subtitles…';
  if (preset === 'clips') $<HTMLDivElement>('done-title').textContent = 'Cutting the clips…';
});

void (async () => {
  void renderUnsaved();
  const loaded = await window.recorder.getSettings();
  settings = loaded.settings;
  if (loaded.failed.length) {
    setStatus(
      `Some hotkeys could not be registered (${loaded.failed.map((a) => HOTKEY_LABELS[a]).join(', ')}). Change them in ⚙ Settings.`,
      'error',
    );
  }
  renderQueue();
  renderCaseCard();
  showView('cases');
  $<HTMLInputElement>('case-input').focus();
})();
