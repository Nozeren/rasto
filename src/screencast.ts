/**
 * Recording a browser tab without a window on screen: a headless Chrome / Edge (or any one started with
 * --remote-debugging-port) streams the tab's frames over the DevTools protocol (Page.startScreencast). The renderer
 * draws them with the banner, exactly like a captured window. No screen permission, nothing shown on screen.
 *
 * Frames only come when the page changes; the renderer keeps drawing the last one.
 *
 * A headless tab has no mouse pointer, so clicks and typing would be invisible: given `onInput`, a small listener
 * reports them (inputTracker) and the renderer draws a ripple where the click landed and a label for what was typed.
 * The listener runs in an isolated world (like an extension's content script): the page's own scripts can't see it,
 * and the page's DOM is left untouched; only its events are read. Password and secret-looking fields are masked
 * (always ••••••, so not even their length shows). Input inside iframes is not tracked.
 *
 * The same listener reports where the sensitive fields are (passwords, card fields, anything marked data-rasto-blur), and
 * the renderer pixelates those parts of the frame before they reach the video.
 *
 * A listener can't be removed once its connection is closed, and the next connection's binding reaches every world of
 * that name, so each screencast's listener carries its own token and only reports with it are taken. Otherwise a tab
 * previewed and then recorded would report every click twice.
 */
import { randomBytes } from 'crypto';
import { DevTools, listTabs } from './devtools';

export interface Frame {
  /** JPEG, base64. */
  data: string;
  /** The page's viewport in CSS pixels, to place clicks on the frame. */
  viewport: { width: number; height: number };
}

/** A click, typing in a field, a choice in a list, or a special key (Enter, Tab, Escape, shortcuts). */
export interface InputEvent {
  kind: 'click' | 'type' | 'select' | 'key';
  /** Click position in CSS pixels of the viewport. */
  x?: number;
  y?: number;
  /** What was clicked, the field's name, or the key ("Enter", "Ctrl+A"). */
  text: string;
  /** What the field holds now (masked when secret). */
  value?: string;
}

const WORLD = 'rasto-input';
const BINDING = '__rastoInput';

/** Runs in the isolated world of every document of the tab; reports through the binding, tagged with `token`. */
export const inputTracker = (token: string): string => `(() => {
  if (globalThis.__rastoInput_${token}) return;
  globalThis.__rastoInput_${token} = true;
  const send = (event) => { try { ${BINDING}(JSON.stringify({ ...event, token: '${token}' })); } catch {} };
  const clean = (text, max = 60) => {
    const one = String(text ?? '').replace(/\\s+/g, ' ').trim();
    return one.length > max ? one.slice(0, max - 1) + '…' : one;
  };
  const SECRET = /pass(word|wd)?|pwd|secret|token|api.?key|credential|otp|one.?time|pin\\b|cvv|cvc|security.?code|card.?number|cc-number|cc-csc/i;
  const secret = (el) => el.type === 'password' || SECRET.test([el.name, el.id, el.autocomplete, el.getAttribute?.('aria-label'), el.placeholder].join(' '));
  const fieldName = (el) => clean(el.labels?.[0]?.innerText || el.getAttribute?.('aria-label') || el.placeholder || el.name || el.id || el.tagName?.toLowerCase(), 40);
  const target = (event) => event.composedPath().find((n) => n instanceof Element) ?? event.target;
  const clickable = (el) => el.closest?.('a, button, input, select, textarea, label, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [onclick]') ?? el;
  const describe = (el) => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return fieldName(el);
    return clean(el.getAttribute?.('aria-label') || el.innerText || el.title || el.alt || el.getAttribute?.('href') || el.tagName?.toLowerCase(), 40);
  };
  addEventListener('pointerdown', (event) => {
    if (!event.isPrimary) return;
    send({ kind: 'click', x: event.clientX, y: event.clientY, text: describe(clickable(target(event))) });
  }, true);
  addEventListener('input', (event) => {
    const el = target(event);
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.isContentEditable) return;
    if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) {
      send({ kind: 'select', text: fieldName(el), value: el.checked ? 'checked' : 'unchecked' });
      return;
    }
    const value = el.isContentEditable ? el.innerText : el.value;
    send({ kind: 'type', text: el.isContentEditable ? 'text' : fieldName(el), value: secret(el) ? '••••••' : clean(value, 80) });
  }, true);
  addEventListener('change', (event) => {
    const el = target(event);
    if (el instanceof HTMLSelectElement) send({ kind: 'select', text: fieldName(el), value: clean([...el.selectedOptions].map((o) => o.text).join(', '), 60) });
  }, true);
  const SPECIAL = new Set(['Enter', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);
  addEventListener('keydown', (event) => {
    const modifier = event.ctrlKey || event.metaKey || event.altKey;
    if (event.repeat || ['Control', 'Meta', 'Alt', 'Shift'].includes(event.key) || (!SPECIAL.has(event.key) && !modifier)) return;
    const keys = [event.ctrlKey && 'Ctrl', event.metaKey && 'Cmd', event.altKey && 'Alt', event.shiftKey && modifier && 'Shift', event.key.length === 1 ? event.key.toUpperCase() : event.key];
    send({ kind: 'key', text: keys.filter(Boolean).join('+') });
  }, true);

  // Where the sensitive fields are on screen, so the video can blur them: secret-looking fields (as above), card
  // fields, and anything the page marks with data-rasto-blur or class rasto-blur. Sent when it changes: on scroll and
  // resize at once, else checked every 200 ms.
  const sensitive = (el) => el.matches('[data-rasto-blur], .rasto-blur')
    || ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && (secret(el) || /^cc-/.test(el.autocomplete || '')));
  let lastRects = '';
  const reportRects = () => {
    const rects = [];
    for (const el of document.querySelectorAll('input, textarea, [data-rasto-blur], .rasto-blur')) {
      if (!sensitive(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      rects.push([Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]);
      if (rects.length >= 50) break;
    }
    const key = JSON.stringify(rects);
    if (key === lastRects) return;
    lastRects = key;
    send({ kind: 'blur', rects });
  };
  addEventListener('scroll', reportRects, true);
  addEventListener('resize', reportRects);
  setInterval(reportRects, 200);
  reportRects();
})();`;

const MAX_SIZE = { maxWidth: 1920, maxHeight: 1080 };

let connection: DevTools | null = null;

/** Sensitive fields to blur, as [x, y, width, height] in CSS pixels of the viewport. */
export type BlurRects = [number, number, number, number][];

/**
 * Starts streaming the tab `tabId` of the browser on `port`; `onFrame` gets every frame, `onInput` the clicks and typing,
 * `onBlur` where the sensitive fields are whenever that changes.
 */
export async function startScreencast(
  port: number,
  tabId: string,
  onFrame: (frame: Frame) => void,
  onInput?: (event: InputEvent) => void,
  onBlur?: (rects: BlurRects) => void,
): Promise<void> {
  stopScreencast();
  const tab = (await listTabs(port)).find((t) => t.id === tabId);
  if (!tab) throw new Error('that tab is gone: list the tabs again');

  const devtools = await DevTools.connect(tab.webSocketDebuggerUrl);
  const token = randomBytes(8).toString('hex');
  devtools.onEvent((method, params) => {
    if (method === 'Runtime.bindingCalled' && params.name === BINDING) {
      try {
        const { token: from, ...event } = JSON.parse(params.payload) as (InputEvent | { kind: 'blur'; rects: BlurRects }) & { token?: string };
        // A listener left by an earlier screencast of this tab.
        if (from !== token) return;
        if (event.kind === 'blur') onBlur?.(event.rects);
        else onInput?.(event);
      } catch {
        // not ours
      }
      return;
    }
    if (method !== 'Page.screencastFrame') return;
    // Unacknowledged frames stop the stream.
    devtools.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => undefined);
    onFrame({ data: params.data, viewport: { width: params.metadata.deviceWidth, height: params.metadata.deviceHeight } });
  });
  connection = devtools;
  await devtools.send('Page.enable');
  if (onInput || onBlur) await trackInput(devtools, token);
  await devtools.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1, ...MAX_SIZE });
  // A still page sends one frame and then nothing: ask for a fresh one so the preview starts at once.
  await devtools.send('Page.bringToFront').catch(() => undefined);
}

/** Installs inputTracker in the isolated world of the current document and of every document the tab loads next. */
async function trackInput(devtools: DevTools, token: string): Promise<void> {
  const source = inputTracker(token);
  await devtools.send('Runtime.enable');
  await devtools.send('Runtime.addBinding', { name: BINDING, executionContextName: WORLD });
  await devtools.send('Page.addScriptToEvaluateOnNewDocument', { source, worldName: WORLD });
  const { frameTree } = await devtools.send('Page.getFrameTree');
  const { executionContextId } = await devtools.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD });
  await devtools.send('Runtime.evaluate', { expression: source, contextId: executionContextId });
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
