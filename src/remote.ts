/**
 * Remote control: a small HTTP API on 127.0.0.1 so a script or an agent can do what the UI and the hotkeys do: list the
 * windows, start a recording from a feature file, move between steps, add notes, close cases and read the state.
 *
 * Off unless ⚙ Settings → "Allow remote control" is on. While it runs, its port and a random token are written to
 * remote.json in the user-data folder, readable only by the user; every request must send the token. bin/rasto-remote.js
 * (CLI) and bin/rasto-mcp.js (MCP server) read that file.
 */
import { app } from 'electron';
import { randomBytes, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import http from 'http';
import path from 'path';

export interface RemoteHandlers {
  /** GET /windows */
  windows(): Promise<unknown>;
  /** GET /tabs: the tabs of the browser on the debugging port (recordable headless) */
  tabs(): Promise<unknown>;
  /** POST /record { feature, window | tab, subject?, config?, run? } */
  record(body: Record<string, unknown>): Promise<unknown>;
  /** POST /control { action } */
  control(action: string): Promise<unknown>;
  /** POST /note { text }: a note on the step on screen */
  note(text: string): Promise<unknown>;
  /** GET /status */
  status(): Promise<unknown>;
}

const MAX_BODY_BYTES = 64 * 1024;

let server: http.Server | null = null;
let token = '';

export function remoteInfoPath(): string {
  return path.join(app.getPath('userData'), 'remote.json');
}

function authorized(request: http.IncomingMessage): boolean {
  const sent = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
  const expected = Buffer.from(token);
  return sent.length === expected.length && timingSafeEqual(sent, expected);
}

async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new Error('Request body too large');
  }
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

async function route(request: http.IncomingMessage, handlers: RemoteHandlers): Promise<[number, unknown]> {
  const key = `${request.method} ${request.url}`;
  if (key === 'GET /status') return [200, await handlers.status()];
  if (key === 'GET /windows') return [200, await handlers.windows()];
  if (key === 'GET /tabs') return [200, await handlers.tabs()];
  if (key === 'POST /record') return [200, await handlers.record(await readBody(request))];
  if (key === 'POST /control') return [200, await handlers.control(String((await readBody(request)).action ?? ''))];
  if (key === 'POST /note') return [200, await handlers.note(String((await readBody(request)).text ?? ''))];
  return [404, { ok: false, error: `Unknown request: ${key}` }];
}

export async function startRemote(handlers: RemoteHandlers): Promise<void> {
  if (server) return;
  token = randomBytes(24).toString('hex');

  const created = http.createServer((request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (!authorized(request)) {
      reply(401, { ok: false, error: 'Missing or wrong token' });
      return;
    }
    route(request, handlers)
      .then(([status, body]) => reply(status, body))
      .catch((error: Error) => reply(500, { ok: false, error: error.message }));
  });

  // Port 0: the OS picks a free one; only this machine can connect.
  await new Promise<void>((resolve, reject) => {
    created.once('error', reject);
    created.listen(0, '127.0.0.1', resolve);
  });
  server = created;
  const { port } = created.address() as { port: number };
  await fs.writeFile(remoteInfoPath(), JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
  // The mode above only applies to a new file; a leftover one keeps its permissions otherwise.
  await fs.chmod(remoteInfoPath(), 0o600);
}

export async function stopRemote(): Promise<void> {
  const closing = server;
  if (!closing) return;
  // Cleared first, so a start that comes while requests are still finishing creates a new server.
  server = null;
  token = '';
  await fs.rm(remoteInfoPath(), { force: true });
  await new Promise<void>((resolve) => closing.close(() => resolve()));
}
