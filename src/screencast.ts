/**
 * Recording a browser tab without a window on screen: a headless Chrome / Edge (or any one started with
 * --remote-debugging-port) streams the tab's frames over the DevTools protocol (Page.startScreencast). The renderer
 * draws them with the banner, exactly like a captured window. No screen permission, nothing shown on screen.
 *
 * Frames only come when the page changes; the renderer keeps drawing the last one.
 */
import { DevTools, listTabs } from './devtools';

export interface Frame {
  /** JPEG, base64. */
  data: string;
}

const MAX_SIZE = { maxWidth: 1920, maxHeight: 1080 };

let connection: DevTools | null = null;

/** Starts streaming the tab `tabId` of the browser on `port`; `onFrame` gets every frame. */
export async function startScreencast(port: number, tabId: string, onFrame: (frame: Frame) => void): Promise<void> {
  stopScreencast();
  const tab = (await listTabs(port)).find((t) => t.id === tabId);
  if (!tab) throw new Error('that tab is gone: list the tabs again');

  const devtools = await DevTools.connect(tab.webSocketDebuggerUrl);
  devtools.onEvent((method, params) => {
    if (method !== 'Page.screencastFrame') return;
    // Unacknowledged frames stop the stream.
    devtools.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => undefined);
    onFrame({ data: params.data });
  });
  connection = devtools;
  await devtools.send('Page.enable');
  await devtools.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1, ...MAX_SIZE });
  // A still page sends one frame and then nothing: ask for a fresh one so the preview starts at once.
  await devtools.send('Page.bringToFront').catch(() => undefined);
}

export function stopScreencast(): void {
  connection?.send('Page.stopScreencast').catch(() => undefined);
  connection?.close();
  connection = null;
}

/** A small JPEG of the tab for the source picker (data URL), or '' when it can't be taken. */
export async function tabThumbnail(webSocketDebuggerUrl: string): Promise<string> {
  let devtools: DevTools | null = null;
  try {
    devtools = await DevTools.connect(webSocketDebuggerUrl);
    const shot = await Promise.race([
      devtools.send('Page.captureScreenshot', { format: 'jpeg', quality: 50 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ]);
    return `data:image/jpeg;base64,${shot.data}`;
  } catch {
    return '';
  } finally {
    devtools?.close();
  }
}
