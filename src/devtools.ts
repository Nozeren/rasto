/**
 * A minimal DevTools-protocol client for a Chrome / Edge started with --remote-debugging-port: list its tabs, open a
 * connection (to the browser or to one tab), send commands and listen to events. Used by capture.ts (console and
 * network) and screencast.ts (recording a headless browser).
 */
import WebSocket from 'ws';

export interface DevToolsTab {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

const HTTP_TIMEOUT_MS = 2000;
const COMMAND_TIMEOUT_MS = 10_000;

async function getJson<T>(port: number, route: string): Promise<T> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    return (await response.json()) as T;
  } catch {
    throw new Error(`no browser with remote debugging on port ${port}`);
  }
}

/** The browser-wide endpoint (every tab, new tabs as they open). */
export async function browserUrl(port: number): Promise<string> {
  return (await getJson<{ webSocketDebuggerUrl: string }>(port, '/json/version')).webSocketDebuggerUrl;
}

/** The browser's open tabs (pages only: no service workers, extensions, …). */
export async function listTabs(port: number): Promise<DevToolsTab[]> {
  const targets = await getJson<(DevToolsTab & { type: string })[]>(port, '/json/list');
  return targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

type EventHandler = (method: string, params: any, sessionId?: string) => void;

export class DevTools {
  private nextId = 1;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  private handlers: EventHandler[] = [];
  private closeHandlers: (() => void)[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      let message: any;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const waiting = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiting?.reject(new Error(message.error.message));
        else waiting?.resolve(message.result);
        return;
      }
      for (const handler of this.handlers) handler(message.method, message.params ?? {}, message.sessionId);
    });
    ws.on('close', () => {
      for (const waiting of this.pending.values()) waiting.reject(new Error('the browser connection closed'));
      this.pending.clear();
      for (const handler of this.closeHandlers) handler();
    });
    ws.on('error', (error) => console.error(`[devtools] ${error.message}`));
  }

  static async connect(url: string): Promise<DevTools> {
    // No Origin header (Node), so the browser needs no --remote-allow-origins.
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', (error) => reject(new Error(`could not connect to the browser: ${error.message}`)));
    });
    return new DevTools(ws);
  }

  /** Sends a command (to a tab's `sessionId` when given) and resolves with its result. */
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('the browser connection is closed'));
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, COMMAND_TIMEOUT_MS);
      const settle = <T>(done: (value: T) => void) => (value: T) => {
        clearTimeout(timer);
        done(value);
      };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
    });
  }

  onEvent(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  /** Called when the connection ends, whichever side ended it. */
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    this.ws.close();
  }
}
