/**
 * Turns the requests capture.ts collected into a HAR 1.2 file (opens in Chrome / Firefox DevTools and HAR viewers).
 * Only what happened while recording is kept. Each entry also says where it is in the video: `_videoTime`, `_case`,
 * `_step` (and `_paused` when it happened while paused, so it isn't in the video).
 *
 * Unless ⚙ Settings → "Keep secrets" is on, secrets are replaced with REDACTED: credential headers (Cookie,
 * Set-Cookie, Authorization, API keys, CSRF tokens) and, in URLs, form bodies and JSON bodies, any value whose name
 * looks like a password, token, secret, API key or session.
 */
import type { RawRequest } from './capture';
import { formatTime, LoggedCase } from './output';

/** Where the recording was at a moment of wall-clock time: sent by the renderer at start, each pause and each resume. */
export interface TimelineMark {
  /** Epoch ms. */
  wall: number;
  /** Video time at that moment. */
  atMs: number;
  /** The recording was paused from this mark on. */
  paused?: boolean;
}

export const REDACTED = 'REDACTED';

const SECRET_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token',
]);

/** "access_token", "X-Session-Id", "newPassword", "client_secret", … */
export function isSecretName(name: string): boolean {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /password|passwd|secret|token|apikey|credential|cardnumber|ccnum|cvv|cvc|iban/.test(key) || /(pwd|auth|session|sessionid|sid|otp|signature|ssn)$/.test(key);
}

/** Absolute or relative (a redirect's Location often is). */
export function redactUrl(url: string): string {
  try {
    const relative = !/^[a-z][a-z0-9+.-]*:/i.test(url);
    const parsed = new URL(url, 'http://relative.invalid');
    let changed = false;
    for (const name of [...new Set(parsed.searchParams.keys())]) {
      if (!isSecretName(name)) continue;
      parsed.searchParams.set(name, REDACTED);
      changed = true;
    }
    if (!changed) return url;
    return relative ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
  } catch {
    return url;
  }
}

/** Headers whose value is a URL that can carry secrets in its query. */
const URL_HEADERS = new Set(['location', 'referer', 'content-location']);

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, isSecretName(key) && (typeof inner !== 'object' || inner === null) ? REDACTED : redactJson(inner)]),
    );
  }
  return value;
}

/** Redacts a text body by its type: form fields and JSON values with secret names. Other text is kept as is. */
export function redactBody(text: string, mimeType: string): string {
  if (/x-www-form-urlencoded/i.test(mimeType)) {
    const params = new URLSearchParams(text);
    let changed = false;
    for (const name of [...new Set(params.keys())]) {
      if (!isSecretName(name)) continue;
      params.set(name, REDACTED);
      changed = true;
    }
    return changed ? params.toString() : text;
  }
  if (/json/i.test(mimeType)) {
    try {
      return JSON.stringify(redactJson(JSON.parse(text)));
    } catch {
      return text;
    }
  }
  return text;
}

function headerList(headers: Record<string, string>, keepSecrets: boolean): { name: string; value: string }[] {
  // The browser joins repeated headers (Set-Cookie) with newlines.
  return Object.entries(headers).flatMap(([name, value]) =>
    String(value).split('\n').map((line) => {
      const key = name.toLowerCase();
      if (keepSecrets) return { name, value: line };
      if (SECRET_HEADERS.has(key)) return { name, value: REDACTED };
      return { name, value: URL_HEADERS.has(key) ? redactUrl(line) : line };
    }),
  );
}

function header(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function httpVersion(protocol?: string): string {
  if (!protocol) return '';
  if (protocol === 'h2') return 'HTTP/2';
  if (protocol === 'h3' || protocol.startsWith('h3-')) return 'HTTP/3';
  return protocol.toUpperCase();
}

/** HAR timings (ms; -1 for a phase that didn't happen), from the browser's ResourceTiming when it has one. */
function timings(r: RawRequest): Record<string, number> {
  const ms = (seconds?: number) => (seconds === undefined ? undefined : seconds * 1000);
  const start = ms(r.startTs)!;
  const responseAt = ms(r.responseTs);
  const end = ms(r.finishedTs) ?? responseAt ?? start;
  const t = r.response?.timing;
  if (!t || t.requestTime === undefined) {
    const wait = Math.max(0, (responseAt ?? end) - start);
    return { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait, receive: Math.max(0, end - (responseAt ?? end)) };
  }
  const base = t.requestTime * 1000;
  const phase = (from: number, to: number) => (from >= 0 && to >= 0 ? Math.max(0, to - from) : -1);
  const firstActivity = [t.dnsStart, t.connectStart, t.sendStart].find((v) => v >= 0) ?? 0;
  return {
    blocked: Math.max(0, base - start + firstActivity),
    dns: phase(t.dnsStart, t.dnsEnd),
    connect: phase(t.connectStart, t.connectEnd),
    ssl: phase(t.sslStart, t.sslEnd),
    send: Math.max(0, t.sendEnd - t.sendStart),
    wait: Math.max(0, t.receiveHeadersEnd - t.sendEnd),
    receive: Math.max(0, end - (base + t.receiveHeadersEnd)),
  };
}

/** Video time of a wall-clock moment, or null before the recording started. */
export function videoTime(marks: TimelineMark[], durationMs: number, wallMs: number): { atMs: number; paused: boolean } | null {
  const mark = [...marks].reverse().find((m) => m.wall <= wallMs);
  if (!mark) return null;
  if (mark.paused) return { atMs: mark.atMs, paused: true };
  return { atMs: Math.min(durationMs, mark.atMs + wallMs - mark.wall), paused: false };
}

/** The case and step on screen at a video time: the last step shown at or before it. */
function stepAt(cases: LoggedCase[], atMs: number): { caseId: string; step: string } | null {
  let found: { caseId: string; step: string } | null = null;
  for (const c of cases) {
    for (const s of c.steps) {
      if (s.atMs > atMs) return found;
      found = { caseId: c.row ? `${c.id} · ${c.row}` : c.id, step: `${s.section} ${s.position}/${s.total}: ${`${s.keyword} ${s.text}`.trim()}` };
    }
  }
  return found;
}

export interface HarSummary {
  requests: number;
  /** HTTP 4xx / 5xx, or no response (network error, blocked). Canceled requests don't count. */
  failed: number;
}

export function buildHar(
  raw: RawRequest[],
  marks: TimelineMark[],
  meta: { durationMs: number; cases: LoggedCase[] },
  keepSecrets: boolean,
  version: string,
): { har: unknown; summary: HarSummary } {
  const summary: HarSummary = { requests: 0, failed: 0 };
  const entries = raw.flatMap((r) => {
    const at = videoTime(marks, meta.durationMs, r.wallMs);
    if (!at) return [];
    summary.requests += 1;
    const response = r.response;
    if ((response && response.status >= 400) || (!response && r.failed !== 'canceled')) summary.failed += 1;

    const clean = (url: string) => (keepSecrets ? url : redactUrl(url));
    const url = clean(r.request.url);
    const requestHeaders = r.wireRequestHeaders ?? r.request.headers;
    const requestType = header(requestHeaders, 'content-type') ?? '';
    const postData = r.request.postData;
    const responseHeaders = r.wireResponseHeaders ?? response?.headers ?? {};
    const time = timings(r);
    const cookieHeader = header(requestHeaders, 'cookie');
    const location = header(responseHeaders, 'location');
    const step = stepAt(meta.cases, at.atMs);

    return [{
      startedDateTime: new Date(r.wallMs).toISOString(),
      time: Object.entries(time).filter(([name, v]) => name !== 'ssl' && v > 0).reduce((sum, [, v]) => sum + v, 0),
      request: {
        method: r.request.method,
        url,
        httpVersion: httpVersion(response?.protocol),
        cookies: keepSecrets && cookieHeader
          ? cookieHeader.split(/;\s*/).filter(Boolean).map((pair) => ({ name: pair.split('=')[0], value: pair.slice(pair.indexOf('=') + 1) }))
          : [],
        headers: headerList(requestHeaders, keepSecrets),
        queryString: [...new URL(url, 'http://x').searchParams].map(([name, value]) => ({ name, value })),
        ...(postData !== undefined
          ? { postData: { mimeType: requestType, text: keepSecrets ? postData : redactBody(postData, requestType) } }
          : {}),
        headersSize: -1,
        bodySize: postData !== undefined ? Buffer.byteLength(postData) : 0,
      },
      response: {
        status: response?.status ?? 0,
        statusText: response?.statusText ?? '',
        httpVersion: httpVersion(response?.protocol),
        cookies: [],
        headers: headerList(responseHeaders, keepSecrets),
        content: {
          size: r.body ? (r.body.base64 ? Buffer.from(r.body.text, 'base64').length : Buffer.byteLength(r.body.text)) : r.encodedLength ?? 0,
          mimeType: response?.mimeType || 'x-unknown',
          ...(r.body
            ? r.body.base64
              ? { text: r.body.text, encoding: 'base64' }
              : { text: keepSecrets ? r.body.text : redactBody(r.body.text, response?.mimeType ?? '') }
            : {}),
        },
        redirectURL: location ? clean(location) : '',
        headersSize: -1,
        bodySize: r.encodedLength ?? -1,
        ...(r.failed ? { _error: r.failed } : {}),
      },
      cache: {},
      timings: time,
      ...(response?.remoteIPAddress ? { serverIPAddress: response.remoteIPAddress } : {}),
      ...(response?.fromCache ? { _fromCache: true } : {}),
      _resourceType: r.resourceType?.toLowerCase(),
      _videoTime: formatTime(at.atMs),
      ...(step ? { _case: step.caseId, _step: step.step } : {}),
      ...(at.paused ? { _paused: true } : {}),
    }];
  });

  return {
    har: { log: { version: '1.2', creator: { name: 'Rasto', version }, pages: [], entries } },
    summary,
  };
}
