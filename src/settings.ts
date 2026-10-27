/**
 * User settings, stored as JSON in the app's user-data folder: hotkeys and where recordings are saved.
 */
import { app } from 'electron';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export type HotkeyAction = 'next' | 'previous' | 'pause' | 'pass' | 'fail' | 'blocked' | 'note';

export interface OutputSettings {
  /** Parent folder; recordings go to <root>/<subject>/<config>/. */
  root: string;
  subject: string;
  config: string;
}

export interface Preferences {
  /** Re-encode with the smaller preset when the MP4 is bigger than this. */
  maxMb: number;
  /** Default of "Include Background steps" for newly loaded cases. */
  includeBackground: boolean;
  /** Seconds counted down on the HUD before recording starts; 0 starts at once. */
  countdownSec: number;
  /** Serve the local remote-control API (remote.ts), for scripts and agents. */
  remoteControl: boolean;
  /** Save the console of the browser on `browserPort` (started with --remote-debugging-port) in the step log. */
  browserConsole: boolean;
  /** Save that browser's network as a .har next to the video. */
  browserNetwork: boolean;
  /** Keep cookies, credential headers and secret-looking values in the .har instead of redacting them. */
  keepSecrets: boolean;
  /** Recording a browser tab: show clicks (a ripple) and typing (a label) in the video, and log them per step. */
  showInput: boolean;
  /** With several cases, also save a clip per case (clips.ts). */
  clips: boolean;
  /** Also save the last N seconds before each Fail as a clip; 0 turns it off. */
  failureClipSec: number;
  /** The bottom corner of the step label in the video; a tab recording moves it out of the way of clicks. */
  labelCorner: 'left' | 'right';
  /** The browser's --remote-debugging-port: console, network, and recording a headless browser's tab. */
  browserPort: number;
}

export interface Settings {
  hotkeys: Record<HotkeyAction, string>;
  output: OutputSettings;
  preferences: Preferences;
  /** Recently used subjects and configs, newest first, offered as suggestions. */
  recent: { subjects: string[]; configs: string[] };
  /** TestRail access. The API key is encrypted with the OS keychain (Electron safeStorage), stored as base64. */
  testrail: { url: string; user: string; apiKeyEncrypted: string };
}

/** Electron accelerators. "Control+Alt" is Ctrl+Alt on Windows/Linux and ⌃⌥ on macOS. */
export const DEFAULT_SETTINGS: Settings = {
  hotkeys: {
    next: 'Control+Alt+Right',
    previous: 'Control+Alt+Left',
    pause: 'Control+Alt+P',
    pass: 'Control+Alt+1',
    fail: 'Control+Alt+2',
    blocked: 'Control+Alt+3',
    note: 'Control+Alt+N',
  },
  output: {
    root: path.join(os.homedir(), 'Desktop'),
    subject: 'rasto',
    config: 'default',
  },
  preferences: {
    maxMb: 50,
    includeBackground: true,
    countdownSec: 3,
    remoteControl: false,
    browserConsole: false,
    browserNetwork: false,
    keepSecrets: false,
    browserPort: 9222,
    showInput: true,
    clips: true,
    failureClipSec: 20,
    labelCorner: 'left',
  },
  recent: { subjects: [], configs: [] },
  testrail: { url: '', user: '', apiKeyEncrypted: '' },
};

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** Settings written before the app was renamed from "test-recorder" to "Rasto". */
function legacySettingsPath(): string {
  return path.join(app.getPath('appData'), 'test-recorder', 'settings.json');
}

async function readStored(): Promise<Partial<Settings>> {
  try {
    return JSON.parse(await fs.readFile(settingsPath(), 'utf-8')) as Partial<Settings>;
  } catch {
    // First run under the new name: carry the old settings over (hotkeys, recent subjects/configs).
    const legacy = JSON.parse(await fs.readFile(legacySettingsPath(), 'utf-8')) as Partial<Settings>;
    if (legacy.output?.subject === 'test-recorder') legacy.output.subject = 'rasto';
    return legacy;
  }
}

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await readStored();
    return {
      hotkeys: { ...DEFAULT_SETTINGS.hotkeys, ...(stored.hotkeys ?? {}) },
      output: { ...DEFAULT_SETTINGS.output, ...(stored.output ?? {}) },
      preferences: { ...DEFAULT_SETTINGS.preferences, ...(stored.preferences ?? {}) },
      recent: { subjects: stored.recent?.subjects ?? [], configs: stored.recent?.configs ?? [] },
      testrail: { ...DEFAULT_SETTINGS.testrail, ...(stored.testrail ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2));
}

/** Puts `value` first in `list`, without duplicates, keeping at most 10 entries. */
export function remember(list: string[], value: string): string[] {
  const trimmed = value.trim();
  return trimmed ? [trimmed, ...list.filter((v) => v !== trimmed)].slice(0, 10) : list;
}
