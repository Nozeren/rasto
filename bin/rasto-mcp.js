#!/usr/bin/env node
/**
 * MCP server (stdio) for Rasto's remote control, so an agent can record a run the way a person does with the hotkeys.
 * No dependencies: it speaks the few JSON-RPC messages a tools-only server needs (initialize, tools/list, tools/call).
 *
 *   claude mcp add rasto -- node path/to/rasto/bin/rasto-mcp.js
 */
const readline = require('readline');
const rasto = require('./remote-client');

const TOOLS = [
  {
    name: 'rasto_windows',
    description: 'Lists the windows and screens Rasto can record (their titles), to pick one for rasto_record.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'rasto_tabs',
    description:
      'Lists the tabs (title and URL) of the browser on Rasto\'s debugging port (⚙ Settings → Browser). A tab is ' +
      'recorded through DevTools, so the browser can run headless: pass `tab` to rasto_record instead of `window`.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'rasto_record',
    description:
      'Starts recording a .feature file or a .md guide: every Scenario (every Examples row) is queued, and the first ' +
      'window or screen whose title contains `window` (or the first browser tab whose title or URL contains `tab`) ' +
      'is recorded, with the current step burned into the video. A tab needs no screen and starts at once (no ' +
      'countdown, no HUD). Then drive it with rasto_control.',
    inputSchema: {
      type: 'object',
      properties: {
        feature: { type: 'string', description: 'Path to a .feature file, or a .md guide (# title + numbered steps)' },
        window: { type: 'string', description: 'Part of the window or screen title to record, e.g. "Chromium"' },
        tab: { type: 'string', description: 'Instead of window: part of a browser tab title or URL (see rasto_tabs), e.g. "localhost:3000"' },
        subject: { type: 'string', description: 'Output subject folder (optional, defaults to the last one used)' },
        config: { type: 'string', description: 'Output config folder (optional, defaults to the last one used)' },
        run: { type: 'string', description: 'TestRail run (e.g. "R100") to post each case\'s result to once saved, with its clip, step log and .har attached (optional)' },
      },
      required: ['feature'],
    },
  },
  {
    name: 'rasto_control',
    description:
      'Drives the running recording like the hotkeys: next / previous step, pause (toggles), pass / fail / blocked ' +
      '(closes the current case, the next one starts; after the last one the video is saved), done (ends a guide on ' +
      'its last step), stop. Returns the status. With a guide, wait while the status has a `card` (a title or part ' +
      'card covers the screen) before acting.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['next', 'previous', 'pause', 'pass', 'fail', 'blocked', 'done', 'stop'] } },
      required: ['action'],
    },
  },
  {
    name: 'rasto_note',
    description:
      'Adds a note to the step on screen while recording: it shows above the step label in the video for a few ' +
      'seconds and is kept under that step in the step log, the History, the HTML report and the TestRail comment. ' +
      'Use it to say what you are checking or why ("Checking the total is 27.00", "Retrying: the first login timed ' +
      'out"). One line, up to 500 characters; never put secrets in it.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 500 } },
      required: ['text'],
    },
  },
  {
    name: 'rasto_status',
    description:
      'Rasto state: view, kind (guide or cases), recording / paused / compressing, card (the guide card on screen, ' +
      'or null), current case and step, results, the saved file (plus its chapters .md for a guide), and testrail: how ' +
      'posting to the run went (state posting / done / error, per case). Wait for testrail.state to leave "posting".',
    inputSchema: { type: 'object', properties: {} },
  },
];

const CALLS = {
  rasto_windows: () => rasto.windows(),
  rasto_tabs: () => rasto.tabs(),
  rasto_record: (args) => rasto.record(args),
  rasto_control: (args) => rasto.control(args.action),
  rasto_note: (args) => rasto.note(args.text),
  rasto_status: () => rasto.status(),
};

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

async function callTool(params) {
  const call = CALLS[params.name];
  if (!call) return { content: [{ type: 'text', text: `Unknown tool ${params.name}` }], isError: true };
  try {
    const answer = await call(params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(answer, null, 2) }], isError: answer.ok === false };
  } catch (error) {
    return { content: [{ type: 'text', text: error.message }], isError: true };
  }
}

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) return; // notifications (e.g. notifications/initialized) need no answer

  if (method === 'initialize') {
    send({
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'rasto', version: '0.1.0' },
      },
    });
  } else if (method === 'tools/list') {
    send({ id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    send({ id, result: await callTool(params) });
  } else if (method === 'ping') {
    send({ id, result: {} });
  } else {
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  try {
    void handle(JSON.parse(line));
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } });
  }
});
