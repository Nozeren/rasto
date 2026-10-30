/**
 * Exposes a small, typed API to the renderer; the renderer never touches Node or the file system directly.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('recorder', {
  listSources: () => ipcRenderer.invoke('list-sources'),
  captureBegin: () => ipcRenderer.invoke('capture-begin'),
  captureChunk: (data: ArrayBuffer) => ipcRenderer.send('capture-chunk', data),
  captureAbort: () => ipcRenderer.invoke('capture-abort'),
  captureSnapshot: (meta: unknown) => ipcRenderer.send('capture-snapshot', meta),
  saveRecording: (meta: unknown) => ipcRenderer.invoke('save-recording', meta),
  unsavedList: () => ipcRenderer.invoke('unsaved-list'),
  unsavedSave: (id: string) => ipcRenderer.invoke('unsaved-save', id),
  unsavedDiscard: (id: string) => ipcRenderer.invoke('unsaved-discard', id),
  testrailPost: (run: string) => ipcRenderer.invoke('testrail-post', run),
  previewOutput: () => ipcRenderer.invoke('preview-output'),
  guideFileToken: (title: string) => ipcRenderer.invoke('guide-file-token', title),
  browserStart: (options: unknown) => ipcRenderer.invoke('browser-start', options),
  browserStop: () => ipcRenderer.invoke('browser-stop'),
  onConsoleEntry: (callback: (entry: unknown) => void) => {
    ipcRenderer.on('console-entry', (_event, entry) => callback(entry));
  },
  listTabs: () => ipcRenderer.invoke('list-tabs'),
  screencastStart: (tabId: string) => ipcRenderer.invoke('screencast-start', tabId),
  screencastStop: () => ipcRenderer.invoke('screencast-stop'),
  onRecordingLost: (callback: (reason: string) => void) => {
    ipcRenderer.on('recording-lost', (_event, reason) => callback(reason));
  },
  onFrame: (callback: (frame: unknown) => void) => {
    ipcRenderer.on('browser-frame', (_event, frame) => callback(frame));
  },
  onInput: (callback: (event: unknown) => void) => {
    ipcRenderer.on('browser-input', (_event, input) => callback(input));
  },
  onBlurRects: (callback: (rects: unknown) => void) => {
    ipcRenderer.on('browser-blur', (_event, rects) => callback(rects));
  },
  setOutput: (output: unknown) => ipcRenderer.invoke('set-output', output),
  chooseOutputRoot: () => ipcRenderer.invoke('choose-output-root'),
  setPreferences: (preferences: unknown) => ipcRenderer.invoke('set-preferences', preferences),
  reveal: (filePath: string) => ipcRenderer.invoke('reveal', filePath),
  historyList: () => ipcRenderer.invoke('history-list'),
  historyNetwork: (har: string) => ipcRenderer.invoke('history-network', har),
  historyReport: (log: string) => ipcRenderer.invoke('history-report', log),
  copyText: (text: string) => ipcRenderer.invoke('copy-text', text),
  screenAccess: () => ipcRenderer.invoke('screen-access'),
  parseSteps: (text: string) => ipcRenderer.invoke('parse-steps', text),
  openFeature: () => ipcRenderer.invoke('open-feature'),
  testrailLoad: (input: string) => ipcRenderer.invoke('testrail-load', input),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getTestRail: () => ipcRenderer.invoke('get-testrail'),
  setTestRail: (input: unknown) => ipcRenderer.invoke('set-testrail', input),
  testTestRail: () => ipcRenderer.invoke('test-testrail'),
  hudOpen: () => ipcRenderer.invoke('hud-open'),
  hudClose: () => ipcRenderer.invoke('hud-close'),
  hudState: (state: unknown) => ipcRenderer.send('hud-state', state),
  hudAction: (action: string) => ipcRenderer.send('hud-action', action),
  noteOpen: () => ipcRenderer.send('note-open'),
  hudNote: (text: string | null) => ipcRenderer.send('hud-note', text),
  onHudNoteOpen: (callback: () => void) => {
    ipcRenderer.on('hud-note-open', () => callback());
  },
  onNoteFocus: (callback: () => void) => {
    ipcRenderer.on('note-focus', () => callback());
  },
  onNoteAdd: (callback: (text: string) => void) => {
    ipcRenderer.on('note-add', (_event, text) => callback(text));
  },
  onHudState: (callback: (state: unknown) => void) => {
    ipcRenderer.on('hud-state', (_event, state) => callback(state));
  },
  setHotkey: (action: string, accelerator: string) => ipcRenderer.invoke('set-hotkey', action, accelerator),
  onHotkey: (callback: (action: string) => void) => {
    ipcRenderer.on('hotkey', (_event, action) => callback(action));
  },
  openScreenSettings: () => ipcRenderer.invoke('open-screen-settings'),
  onCompressProgress: (callback: (progress: { fraction: number; preset: string }) => void) => {
    ipcRenderer.on('compress-progress', (_event, progress) => callback(progress));
  },
  onRemoteCommand: (callback: (request: { id: number; command: string; args: unknown }) => void) => {
    ipcRenderer.on('remote-command', (_event, request) => callback(request));
  },
  remoteReply: (id: number, result: unknown) => ipcRenderer.send('remote-reply', id, result),
});
