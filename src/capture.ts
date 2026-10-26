/**
 * Browser capture while recording, from a Chrome / Edge started with --remote-debugging-port (see devtools.ts):
 *
 * - console: console.* calls, uncaught exceptions and the browser's own messages (failed requests, security and
 *   deprecation warnings), sent one by one so the renderer can file each under the step on screen. Debug / verbose
 *   noise is dropped.
 * - network: every request with its headers, timings and (text, up to 1 MB) bodies, collected here and turned into a
 *   .har by har.ts when the recording is saved.
 *
 * One connection to the browser; every tab, including ones opened during the run, is attached as it appears.
 */
import { browserUrl, DevTools } from './devtools';

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
  /** Where it came from: "url:line" when the browser says. */
  source?: string;
}

/** One request as the browser reported it; har.ts turns it into a HAR entry. */
export interface RawRequest {
  /** When it was sent, epoch ms. */
  wallMs: number;
  /** The browser's monotonic clock, in seconds, for the timings. */
  startTs: number;
  resourceType?: string;
  request: { method: string; url: string; headers: Record<string, string>; postData?: string };
  /** The headers as sent on the wire (cookies included), when the browser reports them. */
  wireRequestHeaders?: Record<string, string>;
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
    protocol?: string;
    remoteIPAddress?: string;
    fromCache: boolean;
    timing?: Record<string, number>;
  };
  wireResponseHeaders?: Record<string, string>;
  responseTs?: number;
  finishedTs?: number;
  encodedLength?: number;
  /** Why it failed (net::ERR_…), or 'canceled'. */
  failed?: string;
  body?: { text: string; base64: boolean };
}

export interface CaptureOptions {
  console: boolean;
  network: boolean;
}

const MAX_TEXT = 2000;
export const MAX_BODY_BYTES = 1024 * 1024;
const BODY_WAIT_MS = 5000;

let connection: DevTools | null = null;
let requests = new Map<string, RawRequest>();
let finished: RawRequest[] = [];
let bodyFetches: Promise<unknown>[] = [];

interface ObjectPreview {
  subtype?: string;
  overflow?: boolean;
  properties?: { name: string; type: string; value?: string }[];
}

/** An object's preview as DevTools shows it inline: {a: 1, b: 'x'} or [1, 2, …]. */
function previewText(preview: ObjectPreview): string {
  const array = preview.subtype === 'array';
  const parts = (preview.properties ?? []).map((p) => {
    const value = p.type === 'string' ? `'${p.value}'` : p.value ?? p.type;
    return array ? value : `${p.name}: ${value}`;
  });
  if (preview.overflow) parts.push('…');
  return array ? `[${parts.join(', ')}]` : `{${parts.join(', ')}}`;
}

/** RemoteObject → text, roughly as DevTools prints it. */
function describe(value: { type?: string; subtype?: string; value?: unknown; unserializableValue?: string; description?: string; preview?: ObjectPreview }): string {
  if (value.unserializableValue) return value.unserializableValue;
  if (value.type === 'string') return String(value.value);
  if (value.value !== undefined) return JSON.stringify(value.value);
  // Errors and functions read better as their description (message + stack, source).
  if (value.preview && value.subtype !== 'error' && value.type !== 'function') return previewText(value.preview);
  return value.description ?? value.type ?? '';
}

function level(type: string): ConsoleEntry['level'] | null {
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'warning' || type === 'warn') return 'warn';
  if (type === 'info') return 'info';
  if (type === 'log' || type === 'dir' || type === 'table' || type === 'trace') return 'log';
  return null; // debug, verbose, timing, …
}

function where(url?: string, line?: number): string | undefined {
  if (!url) return undefined;
  return line !== undefined ? `${url}:${line + 1}` : url;
}

/** Turns one DevTools event into a console entry, or null when it isn't one we keep (or is older than `since`). */
function toEntry(method: string, params: any, since: number): ConsoleEntry | null {
  if (method === 'Runtime.consoleAPICalled') {
    const kept = level(params.type);
    if (!kept || params.timestamp < since) return null;
    const frame = params.stackTrace?.callFrames?.[0];
    return { level: kept, text: (params.args ?? []).map(describe).join(' '), source: where(frame?.url, frame?.lineNumber) };
  }
  if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails ?? {};
    if (params.timestamp < since) return null;
    return { level: 'error', text: details.exception?.description ?? details.text ?? 'Uncaught exception', source: where(details.url, details.lineNumber) };
  }
  if (method === 'Log.entryAdded') {
    const entry = params.entry ?? {};
    const kept = level(entry.level);
    // Log.enable replays what the tab logged before: only keep what happens from now on.
    if (!kept || entry.timestamp < since) return null;
    return { level: kept, text: entry.text ?? '', source: where(entry.url, entry.lineNumber) };
  }
  return null;
}

/** Bodies worth keeping in a HAR: text, JSON, XML, scripts, forms. Images, fonts and media are left out. */
function isText(mimeType: string): boolean {
  return /^text\/|^application\/(json|javascript|ecmascript|xml|x-www-form-urlencoded|graphql|[\w.+-]*\+(json|xml))\b/i.test(mimeType);
}

function onNetwork(devtools: DevTools, method: string, params: any, sessionId: string | undefined, since: number): void {
  const key = `${sessionId}:${params.requestId}`;
  if (method === 'Network.requestWillBeSent') {
    const wallMs = params.wallTime * 1000;
    const previous = requests.get(key);
    if (previous && params.redirectResponse) {
      // A redirect reuses the request id: close the first hop with the redirect response, then start the next one.
      previous.response = toResponse(params.redirectResponse);
      previous.responseTs = previous.finishedTs = params.timestamp;
      finished.push(previous);
    }
    const url: string = params.request.url;
    if (wallMs < since || /^(data|blob):/.test(url)) {
      requests.delete(key);
      return;
    }
    const entry: RawRequest = {
      wallMs,
      startTs: params.timestamp,
      resourceType: params.type,
      request: { method: params.request.method, url, headers: params.request.headers ?? {}, postData: params.request.postData },
    };
    requests.set(key, entry);
    if (params.request.hasPostData && params.request.postData === undefined) {
      bodyFetches.push(
        devtools.send('Network.getRequestPostData', { requestId: params.requestId }, sessionId)
          .then((result) => (entry.request.postData = result.postData))
          .catch(() => undefined),
      );
    }
    return;
  }
  const entry = requests.get(key);
  if (!entry) return;
  if (method === 'Network.requestWillBeSentExtraInfo') {
    entry.wireRequestHeaders = params.headers;
  } else if (method === 'Network.responseReceivedExtraInfo') {
    entry.wireResponseHeaders = params.headers;
  } else if (method === 'Network.responseReceived') {
    entry.response = toResponse(params.response);
    entry.responseTs = params.timestamp;
  } else if (method === 'Network.loadingFinished') {
    entry.finishedTs = params.timestamp;
    entry.encodedLength = params.encodedDataLength;
    requests.delete(key);
    finished.push(entry);
    if (entry.response && isText(entry.response.mimeType) && params.encodedDataLength <= MAX_BODY_BYTES) {
      bodyFetches.push(
        devtools.send('Network.getResponseBody', { requestId: params.requestId }, sessionId)
          .then((result) => {
            if (result.body.length <= MAX_BODY_BYTES * (result.base64Encoded ? 4 / 3 : 1)) entry.body = { text: result.body, base64: result.base64Encoded };
          })
          .catch(() => undefined), // gone (the tab navigated or closed): the entry is kept without its body
      );
    }
  } else if (method === 'Network.loadingFailed') {
    entry.finishedTs = params.timestamp;
    entry.failed = params.canceled ? 'canceled' : params.errorText;
    requests.delete(key);
    finished.push(entry);
  }
}

function toResponse(response: any): NonNullable<RawRequest['response']> {
  return {
    status: response.status,
    statusText: response.statusText ?? '',
    headers: response.headers ?? {},
    mimeType: response.mimeType ?? '',
    protocol: response.protocol,
    remoteIPAddress: response.remoteIPAddress,
    fromCache: !!(response.fromDiskCache || response.fromServiceWorker || response.fromPrefetchCache),
    timing: response.timing,
  };
}

/**
 * Connects to the browser on `port`; from now on calls `onConsole` for each console entry (when `options.console`)
 * and collects requests (when `options.network`). Rejects with a message for the user when no browser is listening.
 */
export async function startBrowserCapture(port: number, options: CaptureOptions, onConsole: (entry: ConsoleEntry) => void): Promise<void> {
  connection?.close();
  connection = null;
  requests = new Map();
  finished = [];
  bodyFetches = [];

  const devtools = await DevTools.connect(await browserUrl(port));
  const since = Date.now();

  devtools.onEvent((method, params, sessionId) => {
    // A tab, existing or new: attach to it (its events then come with a sessionId).
    if (method === 'Target.targetCreated' && params.targetInfo.type === 'page') {
      devtools.send('Target.attachToTarget', { targetId: params.targetInfo.targetId, flatten: true }).catch(() => undefined);
      return;
    }
    if (method === 'Target.attachedToTarget') {
      const session = params.sessionId;
      if (options.console) {
        devtools.send('Runtime.enable', {}, session).catch(() => undefined);
        devtools.send('Log.enable', {}, session).catch(() => undefined);
      }
      if (options.network) {
        // Keep bodies around until they are read, up to the size a HAR keeps.
        devtools.send('Network.enable', { maxResourceBufferSize: 2 * MAX_BODY_BYTES, maxTotalBufferSize: 100 * MAX_BODY_BYTES }, session).catch(() => undefined);
      }
      return;
    }
    if (method.startsWith('Network.')) {
      if (options.network) onNetwork(devtools, method, params, sessionId, since);
      return;
    }
    const entry = options.console ? toEntry(method, params, since) : null;
    if (entry) onConsole({ ...entry, text: entry.text.slice(0, MAX_TEXT) });
  });

  connection = devtools;
  // Reports every existing tab as targetCreated, then each new one.
  await devtools.send('Target.setDiscoverTargets', { discover: true });
}

/** Stops capturing and returns the requests seen (unfinished ones included), once their bodies are read. */
export async function stopBrowserCapture(): Promise<RawRequest[]> {
  const devtools = connection;
  connection = null;
  if (!devtools) return [];
  await Promise.race([Promise.allSettled(bodyFetches), new Promise((resolve) => setTimeout(resolve, BODY_WAIT_MS))]);
  devtools.close();
  const all = [...finished, ...requests.values()].sort((a, b) => a.wallMs - b.wallMs);
  requests = new Map();
  finished = [];
  bodyFetches = [];
  return all;
}
