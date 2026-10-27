/**
 * Client for Rasto's remote control (src/remote.ts), shared by the CLI (rasto-remote.js) and the MCP server
 * (rasto-mcp.js). Reads the port and token that Rasto writes to remote.json while ⚙ "Allow remote control" is on.
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

/** Rasto's user-data folder, as Electron names it (app data folder + product name); RASTO_USER_DATA overrides it. */
function userDataFolder() {
  if (process.env.RASTO_USER_DATA) return process.env.RASTO_USER_DATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Rasto');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Rasto');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'Rasto');
}

function readConnection() {
  try {
    return JSON.parse(fs.readFileSync(path.join(userDataFolder(), 'remote.json'), 'utf-8'));
  } catch {
    throw new Error('Rasto is not reachable: open Rasto and turn on ⚙ Settings → "Allow remote control".');
  }
}

/** Sends one request to the running Rasto and resolves with its JSON answer. */
function request(method, route, body) {
  const { port, token } = readConnection();
  const payload = body === undefined ? '' : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: route, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Unexpected answer from Rasto (HTTP ${res.statusCode})`));
          }
        });
      },
    );
    req.on('error', () => reject(new Error('Rasto is not reachable: is it still running with remote control on?')));
    req.end(payload);
  });
}

module.exports = {
  status: () => request('GET', '/status'),
  windows: () => request('GET', '/windows'),
  tabs: () => request('GET', '/tabs'),
  record: ({ feature, window, tab, subject, config, run }) => request('POST', '/record', { feature: path.resolve(feature), window, tab, subject, config, run }),
  control: (action) => request('POST', '/control', { action }),
  note: (text) => request('POST', '/note', { text }),
};
