/**
 * Electron main process: owns the window, the global hotkeys and the settings, lists capturable screens/windows, loads
 * cases (TestRail, .feature, pasted text), saves + compresses recordings with their step log, and serves the optional
 * remote control (see remote.ts).
 */
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, safeStorage, screen, shell, systemPreferences } from 'electron';
import { promises as fs, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { compress } from './compress';
import { RawRequest, startBrowserCapture, stopBrowserCapture } from './capture';
import { listTabs } from './devtools';
import { buildHar } from './har';
import { Feature, hasGherkinStructure, parseGherkin } from './gherkin';
import { parseGuide } from './guide';
import { baseName, guideToken, isGuideRun, listHistory, NetworkSummary, nextSeq, outputFolder, RecordingMeta, writeChapters, writeStepLog } from './output';
import { remoteInfoPath, startRemote, stopRemote } from './remote';
import { startScreencast, stopScreencast, tabThumbnail } from './screencast';
import { HotkeyAction, loadSettings, OutputSettings, Preferences, remember, saveSettings, Settings } from './settings';
import { credentialSource, loadCase, loadRun, parseCaseId, setCredentials, testConnection } from './testrail';


let mainWindow: BrowserWindow | null = null;
let hudWindow: BrowserWindow | null = null;
let settings: Settings;
/** `--hidden` (or RASTO_HIDDEN=1): never show the main window by itself, e.g. for an agent recording a headless browser. */
const startHidden = process.argv.includes('--hidden') || process.env.RASTO_HIDDEN === '1';

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    title: 'Rasto',
    show: !startHidden,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The banner is composited in this window while you work in the browser; without this, Chromium throttles the
      // hidden window's timers and the recording freezes.
      backgroundThrottling: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'static', 'index.html'));

  // Surface renderer and preload errors in the terminal that ran `npm start`.
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer] ${message} (${path.basename(sourceId)}:${line})`);
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[preload] ${path.basename(preloadPath)}: ${error.message}`);
  });

  // Development aid: RASTO_SNAPSHOT=<file.png> renders this window (only this window) to a PNG and quits.
  const snapshot = process.env.RASTO_SNAPSHOT;
  if (snapshot) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        // RASTO_SNAPSHOT_JS runs in the page first (e.g. to load a case), then waits RASTO_SNAPSHOT_DELAY again.
        if (process.env.RASTO_SNAPSHOT_JS) {
          await mainWindow?.webContents.executeJavaScript(process.env.RASTO_SNAPSHOT_JS);
          await new Promise((resolve) => setTimeout(resolve, Number(process.env.RASTO_SNAPSHOT_DELAY ?? 1500)));
        }
        // RASTO_SNAPSHOT_TARGET=hud captures the recording HUD instead of the main window.
        const target = process.env.RASTO_SNAPSHOT_TARGET === 'hud' ? hudWindow : mainWindow;
        const image = await target?.webContents.capturePage();
        if (image) await fs.writeFile(snapshot, image.toPNG());
        app.quit();
      }, Number(process.env.RASTO_SNAPSHOT_DELAY ?? 1500));
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Recording HUD: a small always-on-top bar shown while recording, kept out of screen captures. The main window keeps
// compositing and recording while hidden (backgroundThrottling is off); the HUD only displays state and sends actions.

const HUD_WIDTH = 660;
const HUD_HEIGHT = 124;

function openHud(): void {
  if (hudWindow) return;
  const area = screen.getPrimaryDisplay().workArea;
  hudWindow = new BrowserWindow({
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
    x: Math.round(area.x + (area.width - HUD_WIDTH) / 2),
    y: area.y + 12,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#1c1c1e',
    title: 'Rasto HUD',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Above normal windows, on every Desktop, and excluded from screen capture (macOS / Windows).
  hudWindow.setAlwaysOnTop(true, 'floating');
  hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  hudWindow.setContentProtection(true);
  hudWindow.loadFile(path.join(__dirname, '..', 'static', 'hud.html'));
  // showInactive: appear without taking focus away from the browser being tested.
  hudWindow.once('ready-to-show', () => hudWindow?.showInactive());
  hudWindow.on('closed', () => {
    hudWindow = null;
  });
  hudWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[hud] ${message} (${path.basename(sourceId)}:${line})`);
  });
  mainWindow?.hide();
}

function closeHud(): void {
  if (!hudWindow) return;
  hudWindow.destroy();
  hudWindow = null;
  if (startHidden) return;
  mainWindow?.show();
  mainWindow?.focus();
}

ipcMain.handle('hud-open', async () => openHud());
ipcMain.handle('hud-close', async () => closeHud());
ipcMain.on('hud-state', (_event, state: unknown) => hudWindow?.webContents.send('hud-state', state));
ipcMain.on('hud-action', (_event, action: string) => {
  if (action === 'show-main') {
    mainWindow?.show();
    mainWindow?.focus();
    return;
  }
  // Buttons behave exactly like the hotkeys (plus "stop").
  mainWindow?.webContents.send('hotkey', action);
});

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

ipcMain.handle('list-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith('screen') ? 'screen' : 'window',
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

/** The tabs of the browser on the debugging port, as sources; [] when no browser is listening. */
async function tabSources(thumbnails = true) {
  const tabs = await listTabs(settings.preferences.browserPort).catch(() => []);
  return Promise.all(tabs.map(async (tab) => ({
    id: `tab:${tab.id}`,
    name: tab.title || tab.url,
    url: tab.url,
    kind: 'tab' as const,
    thumbnail: thumbnails ? await tabThumbnail(tab.webSocketDebuggerUrl) : '',
  })));
}

ipcMain.handle('list-tabs', async () => tabSources());

ipcMain.handle('screencast-start', async (_event, tabId: string) => {
  try {
    await startScreencast(settings.preferences.browserPort, tabId, (frame) => mainWindow?.webContents.send('browser-frame', frame.data));
    return { ok: true };
  } catch (error) {
    stopScreencast();
    return failure(error);
  }
});
ipcMain.handle('screencast-stop', async () => stopScreencast());

ipcMain.handle('save-recording', async (_event, data: ArrayBuffer, meta: RecordingMeta) => {
  const folder = outputFolder(settings.output);
  await fs.mkdir(folder, { recursive: true });
  const base = baseName(await nextSeq(folder), meta.cases);
  const raw = path.join(os.tmpdir(), `${base}_${timestamp()}.webm`);
  const output = path.join(folder, `${base}.mp4`);

  await fs.writeFile(raw, Buffer.from(data));
  try {
    const maxBytes = settings.preferences.maxMb * 1024 * 1024;
    const result = await compress(raw, output, meta.durationMs / 1000, maxBytes, (fraction, preset) => {
      mainWindow?.webContents.send('compress-progress', { fraction, preset });
    });
    await fs.unlink(raw);
    let network: NetworkSummary | undefined;
    if (meta.network === 'captured' && capturedRequests) {
      // The .har is extra: the video and its step log are saved even if it can't be written.
      const har = `${base}.har`;
      const built = buildHar(capturedRequests, meta.timeline, meta, settings.preferences.keepSecrets, app.getVersion());
      await fs.writeFile(path.join(folder, har), JSON.stringify(built.har, null, 1))
        .then(() => (network = { har, ...built.summary }))
        .catch((error: Error) => console.error(`[save] har: ${error.message}`));
    }
    capturedRequests = null;
    const log = path.join(folder, `${base}.json`);
    await writeStepLog(log, output, settings.output, meta, network);
    if (isGuideRun(meta.cases)) {
      // The chapters are extra: the video and its step log are saved even if they can't be written.
      await writeChapters(path.join(folder, `${base}.md`), meta).catch((error: Error) => console.error(`[save] chapters: ${error.message}`));
    }
    settings.recent = {
      subjects: remember(settings.recent.subjects, settings.output.subject),
      configs: remember(settings.recent.configs, settings.output.config),
    };
    await saveSettings(settings);
    return { ok: true, ...result, log, network };
  } catch (error) {
    // Keep the raw capture so nothing is lost; tell the user where it is.
    return { ok: false, error: (error as Error).message, raw };
  }
});

// Browser console and network (⚙ Settings → Browser): console entries go to the renderer, which files them under the
// current step; requests stay here until the recording is saved as a .har.
let capturedRequests: RawRequest[] | null = null;

ipcMain.handle('browser-start', async (_event, options: { console: boolean; network: boolean }) => {
  capturedRequests = null;
  try {
    await startBrowserCapture(settings.preferences.browserPort, options, (entry) => mainWindow?.webContents.send('console-entry', entry));
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
});
ipcMain.handle('browser-stop', async () => {
  capturedRequests = await stopBrowserCapture();
});

ipcMain.handle('guide-file-token', async (_event, title: string) => guideToken(title));

ipcMain.handle('preview-output', async () => {
  const folder = outputFolder(settings.output);
  return { folder, seq: await nextSeq(folder), output: settings.output };
});

ipcMain.handle('set-output', async (_event, output: Partial<OutputSettings>) => {
  settings.output = { ...settings.output, ...output };
  await saveSettings(settings);
  const folder = outputFolder(settings.output);
  return { folder, seq: await nextSeq(folder), output: settings.output };
});

ipcMain.handle('set-preferences', async (_event, preferences: Partial<Preferences>) => {
  settings.preferences = { ...settings.preferences, ...preferences };
  await saveSettings(settings);
  await applyRemoteControl();
  return settings;
});

ipcMain.handle('choose-output-root', async () => {
  if (!mainWindow) return null;
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Where should recordings be saved?',
    defaultPath: settings.output.root,
    properties: ['openDirectory', 'createDirectory'],
  });
  return picked.canceled || !picked.filePaths.length ? null : picked.filePaths[0];
});

// macOS hides other apps' windows from desktopCapturer until Screen Recording is granted; other OSes need nothing.
ipcMain.handle('screen-access', async () => {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('screen');
});

ipcMain.handle('open-screen-settings', async () => {
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
});

ipcMain.handle('history-list', async () => listHistory(settings.output.root));

ipcMain.handle('copy-text', async (_event, text: string) => clipboard.writeText(text));

ipcMain.handle('reveal', async (_event, filePath: string) => {
  shell.showItemInFolder(filePath);
});

/**
 * (Re)registers every global hotkey from `settings`. Returns the actions whose accelerator could not be registered
 * (invalid, or already taken by another app).
 */
function registerHotkeys(): HotkeyAction[] {
  globalShortcut.unregisterAll();
  const failed: HotkeyAction[] = [];

  for (const [action, accelerator] of Object.entries(settings.hotkeys) as [HotkeyAction, string][]) {
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, () => mainWindow?.webContents.send('hotkey', action));
    } catch {
      ok = false;
    }
    if (!ok) failed.push(action);
  }
  return failed;
}

ipcMain.handle('get-settings', async () => ({ settings, failed: registerHotkeys() }));

// ---------------------------------------------------------------------------------------------------------------------
// Case sources. Each handler returns { ok, ... } instead of throwing, so the renderer can show the message.

function failure(error: unknown): { ok: false; error: string } {
  return { ok: false, error: (error as Error).message };
}

/** A Markdown guide, Gherkin, or bare steps (wrapped in a Scenario): the content decides, not the file name. */
function parseSteps(text: string): Feature {
  return parseGuide(text) ?? parseGherkin(hasGherkinStructure(text) ? text : `Scenario: Pasted steps\n${text}`);
}

ipcMain.handle('parse-steps', async (_event, text: string) => {
  try {
    return { ok: true, feature: parseSteps(text) };
  } catch (error) {
    return failure(error);
  }
});

ipcMain.handle('open-feature', async () => {
  if (!mainWindow) return { ok: false, error: 'No window' };
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a feature file or a guide',
    properties: ['openFile'],
    filters: [
      { name: 'Feature file or guide', extensions: ['feature', 'md', 'markdown'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, error: '' };

  try {
    const filePath = picked.filePaths[0];
    return { ok: true, path: filePath, feature: parseSteps(await fs.readFile(filePath, 'utf-8')) };
  } catch (error) {
    return failure(error);
  }
});

ipcMain.handle('testrail-load', async (_event, input: string) => {
  try {
    const value = input.trim();
    // "R100" / "run 100" / "100 run" load a run; anything that looks like a case id loads a case.
    const runMatch = /^(?:r|run)\s*(\d+)$/i.exec(value);
    if (runMatch) {
      return { ok: true, kind: 'run', run: await loadRun(Number(runMatch[1])) };
    }
    const caseId = parseCaseId(value);
    if (caseId === null) {
      return { ok: false, error: 'Type a case (C1234) or a run (R100)' };
    }
    return { ok: true, kind: 'case', feature: await loadCase(caseId) };
  } catch (error) {
    return failure(error);
  }
});

ipcMain.handle('set-hotkey', async (_event, action: HotkeyAction, accelerator: string) => {
  const inUse = (Object.entries(settings.hotkeys) as [HotkeyAction, string][])
    .find(([other, value]) => other !== action && value === accelerator);
  if (inUse) {
    return { ok: false, error: `Already used for "${inUse[0]}"`, settings };
  }

  const previous = settings.hotkeys[action];
  settings.hotkeys[action] = accelerator;
  const failed = registerHotkeys();

  if (failed.includes(action)) {
    // Taken by another app or not a valid combination: keep the old one.
    settings.hotkeys[action] = previous;
    registerHotkeys();
    return { ok: false, error: `${accelerator} could not be registered (used by another app, or not allowed)`, settings };
  }

  await saveSettings(settings);
  return { ok: true, settings };
});

// ---------------------------------------------------------------------------------------------------------------------
// Remote control (⚙ Settings → Allow remote control). Listing windows happens here; everything else is asked of the
// renderer, which owns the flow, so a remote recording goes through exactly the same code as a manual one.

const RENDERER_TIMEOUT_MS = 30_000;
const pendingReplies = new Map<number, (result: unknown) => void>();
let nextRequestId = 1;

function askRenderer(command: string, args: unknown = {}): Promise<unknown> {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve({ ok: false, error: 'The Rasto window is closed' });
  const id = nextRequestId++;
  mainWindow.webContents.send('remote-command', { id, command, args });
  return new Promise((resolve) => {
    pendingReplies.set(id, resolve);
    setTimeout(() => {
      if (pendingReplies.delete(id)) resolve({ ok: false, error: 'Rasto did not answer within 30 s; check the status before retrying' });
    }, RENDERER_TIMEOUT_MS);
  });
}

ipcMain.on('remote-reply', (_event, id: number, result: unknown) => {
  pendingReplies.get(id)?.(result);
  pendingReplies.delete(id);
});

async function remoteWindows(): Promise<unknown> {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
  return { ok: true, windows: sources.map((s) => ({ name: s.name, kind: s.id.startsWith('screen') ? 'screen' : 'window' })) };
}

async function remoteTabs(): Promise<unknown> {
  const port = settings.preferences.browserPort;
  try {
    const tabs = await listTabs(port);
    return { ok: true, port, tabs: tabs.map((t) => ({ title: t.title, url: t.url })) };
  } catch (error) {
    return { ok: false, error: `${(error as Error).message} (start it with --remote-debugging-port=${port}, e.g. headless)` };
  }
}

async function remoteRecord(body: Record<string, unknown>): Promise<unknown> {
  const featurePath = String(body.feature ?? '');
  if (!path.isAbsolute(featurePath)) return { ok: false, error: 'feature must be an absolute path to a .feature file or a .md guide' };
  if (!body.window && !body.tab) return { ok: false, error: 'window (part of a window or screen title) or tab (part of a browser tab title or URL) is required' };
  try {
    const feature = parseSteps(await fs.readFile(featurePath, 'utf-8'));
    const target = body.tab ? { tab: String(body.tab) } : { window: String(body.window) };
    return await askRenderer('record', { feature, source: path.basename(featurePath), ...target, subject: body.subject, config: body.config });
  } catch (error) {
    return failure(error);
  }
}

let remoteChange: Promise<void> = Promise.resolve();

/** Starts or stops the API to match the setting, one change at a time; if it can't start, the setting goes back off. */
function applyRemoteControl(): Promise<void> {
  remoteChange = remoteChange.then(async () => {
    if (!settings.preferences.remoteControl) {
      await stopRemote();
      return;
    }
    try {
      await startRemote({
        windows: remoteWindows,
        tabs: remoteTabs,
        record: remoteRecord,
        control: (action) => askRenderer('control', { action }),
        status: () => askRenderer('status'),
      });
    } catch (error) {
      console.error(`[remote] could not start: ${(error as Error).message}`);
      await stopRemote();
      settings.preferences.remoteControl = false;
      await saveSettings(settings);
    }
  });
  return remoteChange;
}

// ---------------------------------------------------------------------------------------------------------------------
// TestRail credentials (Settings). The API key never leaves main in plain text and is stored encrypted.

function decryptKey(): string {
  const encrypted = settings.testrail.apiKeyEncrypted;
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return '';
  }
}

function applyTestRailCredentials(): void {
  setCredentials({ url: settings.testrail.url, user: settings.testrail.user, apiKey: decryptKey() });
}

function testRailInfo() {
  return {
    url: settings.testrail.url,
    user: settings.testrail.user,
    hasKey: !!settings.testrail.apiKeyEncrypted,
    source: credentialSource(),
    encryption: safeStorage.isEncryptionAvailable(),
  };
}

ipcMain.handle('get-testrail', async () => testRailInfo());

/** `apiKey` undefined keeps the stored key, '' removes it. */
ipcMain.handle('set-testrail', async (_event, input: { url: string; user: string; apiKey?: string }) => {
  if (input.apiKey !== undefined && input.apiKey !== '' && !safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'The system keychain is not available, so the API key cannot be stored safely.', info: testRailInfo() };
  }
  settings.testrail.url = input.url.trim();
  settings.testrail.user = input.user.trim();
  if (input.apiKey !== undefined) {
    settings.testrail.apiKeyEncrypted = input.apiKey
      ? safeStorage.encryptString(input.apiKey.trim()).toString('base64')
      : '';
  }
  await saveSettings(settings);
  applyTestRailCredentials();
  return { ok: true, info: testRailInfo() };
});

ipcMain.handle('test-testrail', async () => {
  try {
    await testConnection();
    return { ok: true, info: testRailInfo() };
  } catch (error) {
    return { ok: false, error: (error as Error).message, info: testRailInfo() };
  }
});

/**
 * Brings Rasto forward: while recording, the HUD (the main window stays hidden so it isn't in the way); otherwise the
 * main window, restored if it was minimized and recreated if it was closed.
 */
function bringToFront(): void {
  if (hudWindow) {
    hudWindow.showInactive();
    hudWindow.moveTop();
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// One Rasto at a time: launching it again (Dock, `open -a Rasto`, a launcher) focuses the running one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', bringToFront);

  app.whenReady().then(async () => {
    settings = await loadSettings();
    // Writes the file under the new app name on first run, so settings migrated from test-recorder stick.
    await saveSettings(settings);
    applyTestRailCredentials();
    createWindow();
    await applyRemoteControl();
    // macOS: clicking the Dock icon or `open -a Rasto` while it runs.
    app.on('activate', bringToFront);
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Synchronous: the app exits before an async clean-up would finish, and a stale file points the CLI at a dead port.
  rmSync(remoteInfoPath(), { force: true });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
