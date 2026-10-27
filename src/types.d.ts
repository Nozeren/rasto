/** Shapes shared between preload and renderer (the renderer is a plain script, so these are ambient). */

interface CaptureSource {
  id: string;
  name: string;
  /** 'tab': a tab of the browser on the debugging port, recorded through DevTools (works headless). */
  kind: 'screen' | 'window' | 'tab';
  thumbnail: string;
  /** A tab's address. */
  url?: string;
}

type SaveResult =
  | { ok: true; path: string; bytes: number; preset: string; log: string; network?: { har: string; requests: number; failed: number }; clips?: SavedClip[]; report?: string }
  | { ok: false; error: string; raw: string };

/** A clip saved next to the recording (clips.ts). */
interface SavedClip {
  case: string;
  kind: 'case' | 'failure';
  file: string;
  from: string;
  to: string;
}

/** A capture left by a crash (unsaved.ts), offered on the Cases screen. */
interface UnsavedRecording {
  id: string;
  bytes: number;
  startedAt: string;
  durationMs: number;
  cases: string[];
  folder: string;
}

/** How posting one case to TestRail went (report.ts). */
interface TestRailCaseOutcome {
  case: string;
  status: 'posted' | 'skipped' | 'error';
  detail: string;
}

type TestRailPostResult = { ok: true; run: number; cases: TestRailCaseOutcome[] } | { ok: false; error: string };

type HotkeyAction = 'next' | 'previous' | 'pause' | 'pass' | 'fail' | 'blocked' | 'note';

interface OutputSettings {
  root: string;
  subject: string;
  config: string;
}

interface Preferences {
  maxMb: number;
  includeBackground: boolean;
  countdownSec: number;
  remoteControl: boolean;
  browserConsole: boolean;
  browserNetwork: boolean;
  keepSecrets: boolean;
  browserPort: number;
  clips: boolean;
  failureClipSec: number;
  showInput: boolean;
  labelCorner: 'left' | 'right';
  blurSensitive: boolean;
}

interface AppSettings {
  hotkeys: Record<HotkeyAction, string>;
  output: OutputSettings;
  preferences: Preferences;
  recent: { subjects: string[]; configs: string[] };
}

interface OutputPreview {
  folder: string;
  seq: number;
  output: OutputSettings;
}

type CaseResult = 'pass' | 'fail' | 'blocked';

interface LoggedStep {
  section: string;
  position: number;
  total: number;
  keyword: string;
  text: string;
  part?: string;
  atMs: number;
  console?: LoggedConsoleEntry[];
  actions?: LoggedAction[];
  notes?: { text: string; atMs: number }[];
}

/** A browser console entry (console.ts), as main sends it and as the step log keeps it. */
interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
  source?: string;
}

/** A click, typing, a choice or a special key in a recorded browser tab (screencast.ts). */
interface InputEvent {
  kind: 'click' | 'type' | 'select' | 'key';
  x?: number;
  y?: number;
  text: string;
  value?: string;
}

/** An input event as the step log keeps it: what was done, at what time in the video. */
interface LoggedAction {
  kind: 'click' | 'type' | 'select' | 'key';
  text: string;
  value?: string;
  atMs: number;
}

interface LoggedConsoleEntry extends ConsoleEntry {
  atMs: number;
  paused?: boolean;
}

interface LoggedCase {
  id: string;
  row: string | null;
  title: string;
  result: CaseResult | null;
  resultAtMs?: number;
  guide?: boolean;
  steps: LoggedStep[];
}

interface RecordingMeta {
  startedAt: string;
  durationMs: number;
  cases: LoggedCase[];
  browserConsole?: string;
  network?: string;
  timeline: TimelineMark[];
}

/** Where the recording was at a wall-clock moment (har.ts): at start, each pause and each resume. */
interface TimelineMark {
  wall: number;
  atMs: number;
  paused?: boolean;
}

type SetHotkeyResult = { ok: true; settings: AppSettings } | { ok: false; error: string; settings: AppSettings };

interface GherkinStep {
  keyword: string;
  text: string;
  extra: string[];
  part?: string;
}

interface GherkinScenario {
  name: string;
  tags: string[];
  caseId: string | null;
  steps: GherkinStep[];
  examples: { headers: string[]; rows: string[][] } | null;
}

interface GherkinFeature {
  kind?: 'guide';
  name: string;
  background: GherkinStep[];
  scenarios: GherkinScenario[];
}

interface RunTest {
  testId: number;
  caseId: string;
  title: string;
  status: string;
}

type Failure = { ok: false; error: string };
type ParseResult = { ok: true; feature: GherkinFeature } | Failure;
type OpenFeatureResult = { ok: true; path: string; feature: GherkinFeature } | Failure;
type TestRailResult =
  | { ok: true; kind: 'case'; feature: GherkinFeature }
  | { ok: true; kind: 'run'; run: { id: number; name: string; tests: RunTest[] } }
  | Failure;

/** What the HUD shows; sent by the main window on every change. */
interface HudState {
  /** A guide: a numbered step instead of a keyword, Done instead of Pass / Fail / Blocked. */
  guide: boolean;
  label: string;
  section: string;
  position: number;
  total: number;
  keyword: string;
  text: string;
  caseIndex: number;
  caseCount: number;
  paused: boolean;
  /** Recorded time before the current segment, and when the current segment started (epoch ms). */
  activeMs: number;
  segmentStart: number;
  flash: { text: string; color: string; until: number } | null;
  canPrevious: boolean;
  canNext: boolean;
  finishing: boolean;
  /** Epoch ms when the countdown ends and recording starts; 0 when not counting down. */
  countdownUntil: number;
}

type HudAction = HotkeyAction | 'stop' | 'show-main';

interface TestRailInfo {
  url: string;
  user: string;
  hasKey: boolean;
  source: 'settings' | 'environment' | 'none';
  encryption: boolean;
}

type TestRailSaveResult = { ok: true; info: TestRailInfo } | { ok: false; error: string; info: TestRailInfo };

interface HistoryEntry {
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
  browserConsole?: string;
  har?: string;
  network?: { har: string; requests: number; failed: number };
  clips: SavedClip[];
}

interface HistoryStep {
  at: string;
  step: string;
  text: string;
  console?: { at: string; level: string; text: string; source?: string; paused?: boolean }[];
  actions?: { at: string; kind: string; text: string; value?: string }[];
  notes?: { at: string; text: string }[];
}

interface HistoryRequest {
  at: number;
  method: string;
  url: string;
  status: number;
  error?: string;
  failed: boolean;
}

interface RecorderApi {
  historyList(): Promise<HistoryEntry[]>;
  historyNetwork(har: string): Promise<{ ok: true; requests: HistoryRequest[] } | Failure>;
  historyReport(log: string): Promise<{ ok: true; report: string } | Failure>;
  copyText(text: string): Promise<void>;
  getTestRail(): Promise<TestRailInfo>;
  setTestRail(input: { url: string; user: string; apiKey?: string }): Promise<TestRailSaveResult>;
  testTestRail(): Promise<TestRailSaveResult>;
  hudOpen(): Promise<void>;
  hudClose(): Promise<void>;
  hudState(state: HudState): void;
  hudAction(action: HudAction): void;
  /** Opens the note box: in the HUD when it is open, else in the main window. */
  noteOpen(): void;
  /** The HUD's note box was sent (text) or cancelled (null). */
  hudNote(text: string | null): void;
  onHudNoteOpen(callback: () => void): void;
  onNoteFocus(callback: () => void): void;
  onNoteAdd(callback: (text: string) => void): void;
  onHudState(callback: (state: HudState) => void): void;
  parseSteps(text: string): Promise<ParseResult>;
  openFeature(): Promise<OpenFeatureResult>;
  testrailLoad(input: string): Promise<TestRailResult>;
  getSettings(): Promise<{ settings: AppSettings; failed: HotkeyAction[] }>;
  setHotkey(action: HotkeyAction, accelerator: string): Promise<SetHotkeyResult>;
  onHotkey(callback: (action: HotkeyAction | 'stop') => void): void;
  listSources(): Promise<CaptureSource[]>;
  captureBegin(): Promise<string>;
  captureChunk(data: ArrayBuffer): void;
  /** Closes and deletes the capture in progress (nothing was recorded). */
  captureAbort(): Promise<void>;
  captureSnapshot(meta: RecordingMeta): void;
  saveRecording(meta: RecordingMeta): Promise<SaveResult>;
  unsavedList(): Promise<UnsavedRecording[]>;
  unsavedSave(id: string): Promise<SaveResult>;
  unsavedDiscard(id: string): Promise<void>;
  testrailPost(run: string): Promise<TestRailPostResult>;
  previewOutput(): Promise<OutputPreview>;
  guideFileToken(title: string): Promise<string>;
  browserStart(options: { console: boolean; network: boolean }): Promise<{ ok: true } | Failure>;
  browserStop(): Promise<void>;
  onConsoleEntry(callback: (entry: ConsoleEntry) => void): void;
  listTabs(): Promise<CaptureSource[]>;
  screencastStart(tabId: string): Promise<{ ok: true } | Failure>;
  screencastStop(): Promise<void>;
  onFrame(callback: (frame: { data: string; viewport: { width: number; height: number } }) => void): void;
  onInput(callback: (event: InputEvent) => void): void;
  /** Where the sensitive fields of the recorded tab are: [x, y, width, height] in viewport CSS pixels. */
  onBlurRects(callback: (rects: [number, number, number, number][]) => void): void;
  setOutput(output: Partial<OutputSettings>): Promise<OutputPreview>;
  chooseOutputRoot(): Promise<string | null>;
  setPreferences(preferences: Partial<Preferences>): Promise<AppSettings>;
  reveal(filePath: string): Promise<void>;
  screenAccess(): Promise<'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'>;
  openScreenSettings(): Promise<void>;
  onCompressProgress(callback: (progress: { fraction: number; preset: string }) => void): void;
  onRemoteCommand(callback: (request: RemoteRequest) => void): void;
  remoteReply(id: number, result: unknown): void;
}

/** A remote-control request from main (remote.ts): record, control or status. */
interface RemoteRequest {
  id: number;
  command: 'record' | 'control' | 'status' | 'note';
  args: Record<string, unknown>;
}

interface Window {
  recorder: RecorderApi;
}
