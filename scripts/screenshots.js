/**
 * Regenerates the README images: docs/screenshots/*.png and docs/demo.gif. Run with: npm run screenshots
 *
 * Runs the real app against a throwaway profile and a demo shop (scripts/screenshots/shop.html) in a headless Chrome on
 * its own debugging port, then records a real run of scripts/screenshots/checkout.feature through the remote control:
 * one case passes, one fails. The shop is served from the DevTools connection as https://shop.example, so nothing goes
 * to the network. Every window is rendered offscreen at its own size, and windows and screens aren't listed (on Wayland
 * that opens the screen-share picker), so nothing of your desktop ends up in the images.
 *
 * Needs Chrome or Chromium (CHROME_PATH to pick one) and a display server for Electron.
 */
const Module = require('module');
const electron = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'screenshots');
const OUT = path.join(ROOT, 'docs');
const PORT = 9333;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rasto-screenshots-'));
const USER_DATA = path.join(TMP, 'profile');
const HOME = path.join(TMP, 'home');
const OUTPUT_ROOT = path.join(HOME, 'Desktop');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- The app, offscreen ---------------------------------------------------------------------------------------------

const windows = [];
class OffscreenWindow extends electron.BrowserWindow {
  constructor(options = {}) {
    super({ ...options, show: false, webPreferences: { ...(options.webPreferences ?? {}), offscreen: true } });
    windows.push(this);
  }
  // A shown window would be resized by a tiling window manager.
  show() {}
  showInactive() {}
  focus() {}
}
const noScreens = { getSources: async () => [] };
const patched = new Proxy(electron, {
  get: (target, key) => (key === 'BrowserWindow' ? OffscreenWindow : key === 'desktopCapturer' ? noScreens : target[key]),
});
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? patched : load.call(this, request, ...rest);
};

fs.mkdirSync(USER_DATA, { recursive: true });
fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
fs.writeFileSync(path.join(USER_DATA, 'settings.json'), JSON.stringify({
  output: { root: OUTPUT_ROOT, subject: 'checkout', config: 'staging_chrome' },
  recent: { subjects: ['checkout', 'login'], configs: ['staging_chrome', 'staging_firefox'] },
  preferences: {
    countdownSec: 0, remoteControl: true, browserConsole: true, browserNetwork: true, browserPort: PORT,
    showInput: true, clips: true, failureClipSec: 8,
  },
}));
electron.app.setName('Rasto');
electron.app.setPath('userData', USER_DATA);
require(path.join(ROOT, 'dist', 'main.js'));

const mainWindow = () => windows[0];
const hudWindow = () => windows.find((w) => w !== windows[0] && !w.isDestroyed());

/** Shows the throwaway output folder as ~/Desktop, as it would read on a real machine. */
const TILDE = `document.querySelectorAll('body *').forEach((el) => { for (const n of el.childNodes)
  if (n.nodeType === 3 && n.nodeValue.includes(${JSON.stringify(HOME)})) n.nodeValue = n.nodeValue.split(${JSON.stringify(HOME)}).join('~'); });`;

async function shot(name, { js = '', delay = 800, target = 'main' } = {}) {
  const win = mainWindow();
  win.setContentSize(1200, 820);
  if (js) await win.webContents.executeJavaScript(`(async () => { ${js} })()`);
  await wait(delay);
  await win.webContents.executeJavaScript(TILDE);
  await wait(250); // let the offscreen window repaint
  const image = await (target === 'hud' ? hudWindow() : win).webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'screenshots', `${name}.png`), image.toPNG());
  console.log(`docs/screenshots/${name}.png`);
}

function remote(...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'bin', 'rasto-remote.js'), ...args],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', RASTO_USER_DATA: USER_DATA } },
      (_error, stdout) => { try { resolve(JSON.parse(stdout)); } catch { resolve(null); } });
  });
}

// --- The demo shop in a headless Chrome ------------------------------------------------------------------------------

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ...['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'].flatMap((name) =>
      (process.env.PATH ?? '').split(path.delimiter).map((dir) => path.join(dir, name))),
  ];
  const found = candidates.find((file) => file && fs.existsSync(file));
  if (!found) throw new Error('Chrome or Chromium not found: set CHROME_PATH');
  return found;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let body = ''; res.on('data', (d) => (body += d)); res.on('end', () => resolve(JSON.parse(body))); })
      .on('error', reject);
  });
}

async function openShop() {
  const chrome = spawn(findChrome(), [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${path.join(TMP, 'chrome')}`, '--window-size=1280,800', '--no-first-run',
    '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    await wait(200);
    page = await getJson(`http://127.0.0.1:${PORT}/json/list`).then((tabs) => tabs.find((t) => t.type === 'page'), () => null);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.on('open', resolve));
  let seq = 0;
  const pending = new Map();
  const cdp = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const html = fs.readFileSync(path.join(FIXTURES, 'shop.html'));
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
    if (msg.method !== 'Fetch.requestPaused') return;
    // The shop's page and its API, answered here. Paying with PayPal fails with a 500.
    const { requestId, request } = msg.params;
    const { pathname } = new URL(request.url);
    let status = 200, type = 'application/json', body = JSON.stringify({ ok: true });
    if (!pathname.startsWith('/api/')) { type = 'text/html'; body = html; }
    else if (pathname === '/api/orders') {
      const paypal = /paypal/.test(request.postData ?? '');
      status = paypal ? 500 : 201;
      body = JSON.stringify(paypal ? { error: 'PAYMENT_PROVIDER_TIMEOUT' } : { order: 48213, status: 'confirmed' });
    }
    ws.send(JSON.stringify({ id: ++seq, method: 'Fetch.fulfillRequest', params: { requestId, responseCode: status,
      responseHeaders: [{ name: 'Content-Type', value: type }], body: Buffer.from(body).toString('base64') } }));
  });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp('Fetch.enable', { patterns: [{ urlPattern: 'https://shop.example/*' }] });
  await cdp('Page.navigate', { url: 'https://shop.example/' });
  await wait(1500);

  const evaluate = async (expression) => (await cdp('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;
  return {
    evaluate,
    async click(selector) {
      const [x, y] = await evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await wait(250);
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await wait(450);
    },
    async type(text) {
      for (const ch of text) { await cdp('Input.insertText', { text: ch }); await wait(55); }
      await wait(300);
    },
    close() { ws.close(); chrome.kill(); },
  };
}

// --- The run ---------------------------------------------------------------------------------------------------------

/** Plays one case of checkout.feature in the shop, stepping Rasto along. */
async function playCase(shop, items, method, result, onTyping) {
  await shop.evaluate(`setup(${items}, '${method}')`);
  await wait(1600);                                  // Given I am logged in as a customer
  await remote('next'); await wait(1400);            // Given I have <items> items in my cart
  await remote('next'); await wait(500);             // When I open the cart
  await shop.click('#open-cart'); await wait(1100);
  await remote('next'); await wait(400);             // And I pay with <method>
  await shop.click('#checkout'); await wait(300);
  await shop.click('#name'); await shop.type('Alex Doe');
  if (onTyping) await onTyping();
  await shop.click('#number'); await shop.type('4242 4242 4242 4242');
  await shop.click('#pay-btn'); await wait(700);
  await remote('next'); await wait(1700);            // Then I see the order confirmation
  if (result === 'pass') { await remote('next'); await wait(1300); } // And I receive a receipt by email
  await remote(result); await wait(2600);
}

const seconds = (at) => at.split(':').reduce((total, part) => total * 60 + Number(part), 0);
const stepLog = (video) => JSON.parse(fs.readFileSync(video.replace(/\.mp4$/, '.json'), 'utf-8'));

/** The GIF: case 1 from opening the cart to its PASSED flash, then case 2 from paying to its FAILED flash. */
async function makeGif(video) {
  const log = stepLog(video);
  const [first, second] = log.cases;
  const a = [seconds(first.steps[2].at) + 1, seconds(second.steps[0].at) + 0.7];
  const b = [seconds(second.steps[3].at) - 0.4, seconds(log.duration)];
  const filter = `[0:v]trim=${a[0]}:${a[1]},setpts=PTS-STARTPTS[a];[0:v]trim=${b[0]}:${b[1]},setpts=PTS-STARTPTS[b];`
    + '[a][b]concat=n=2:v=1,setpts=PTS/1.2,fps=12,scale=760:-1:flags=lanczos,split[x][y];'
    + '[x]palettegen=max_colors=96:stats_mode=diff[p];[y][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
  await new Promise((resolve, reject) => execFile(ffmpeg, ['-loglevel', 'error', '-y', '-i', video, '-filter_complex', filter,
    path.join(OUT, 'demo.gif')], (error) => (error ? reject(error) : resolve())));
  console.log('docs/demo.gif');
}

async function run() {
  await electron.app.whenReady();
  while (!mainWindow() || mainWindow().webContents.isLoading()) await wait(200);
  while (!fs.existsSync(path.join(USER_DATA, 'remote.json'))) await wait(200);
  await wait(1000);
  fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true });
  const shop = await openShop();
  await shop.evaluate("setup(1, 'card')");

  const feature = fs.readFileSync(path.join(FIXTURES, 'checkout.feature'), 'utf-8');
  const $ = (id) => `document.getElementById('${id}')`;
  await shot('cases', { delay: 1000, js: `
    ${$('toggle-paste')}.click(); await new Promise((r) => setTimeout(r, 200));
    ${$('paste-text')}.value = ${JSON.stringify(feature)}; ${$('paste-text')}.dispatchEvent(new Event('input'));
    ${$('paste-use')}.click(); await new Promise((r) => setTimeout(r, 600));
    if (!${$('add-all-rows')}.hidden) ${$('add-all-rows')}.click();
    const details = document.querySelector('#case-card details'); if (details) details.open = true;` });
  await shot('source', { delay: 2000, js: `
    document.querySelector('[data-goto="source"]').click(); ${$('refresh-sources')}.click();
    await new Promise((r) => setTimeout(r, 1500));
    document.querySelector('#sources > *').click();` });
  await shot('save', { js: `
    document.querySelector('[data-goto="save"]').click();
    ${$('out-run')}.value = 'R100'; ${$('out-run')}.dispatchEvent(new Event('input'));` });

  // The real run. A tab recording has no HUD, so it is opened by hand to be captured.
  await remote('record', path.join(FIXTURES, 'checkout.feature'), '--tab', 'Demo Shop', '--subject', 'checkout', '--config', 'staging_chrome');
  await wait(800);
  await mainWindow().webContents.executeJavaScript('window.recorder.hudOpen()');
  await playCase(shop, 1, 'card', 'pass', () => shot('hud', { target: 'hud', delay: 300 }));
  await playCase(shop, 3, 'paypal', 'fail');
  let status;
  for (let i = 0; i < 60 && !status?.saved; i++) { await wait(1000); status = await remote('status'); }
  if (!status?.saved) throw new Error('the recording was not saved');
  await wait(1500);

  const failedAt = seconds(stepLog(status.saved).cases[1].steps[4].at) + 1;
  await shot('done', { delay: 400 });
  await shot('history', { delay: 2600, js: `
    ${$('open-history')}.click();
    setTimeout(() => document.querySelector('#history-list button.run')?.click(), 700);` });
  await shot('history-steps', { delay: 1500, js: `
    document.querySelectorAll('#hr-steps details').forEach((d) => { if (/error|failed/.test(d.textContent)) d.open = true; });
    ${$('hr-video')}.currentTime = ${failedAt};
    [...document.querySelectorAll('#hr-steps details')].find((d) => d.open)?.scrollIntoView({ block: 'center' });` });
  await shot('settings', { delay: 900, js: `
    ${$('open-settings')}.click(); await new Promise((r) => setTimeout(r, 300));
    [...document.querySelectorAll('#settings h3, #settings h4, #settings .section-title, #settings legend')]
      .find((h) => /recording/i.test(h.textContent))?.scrollIntoView();` });

  shop.close();

  await makeGif(status.saved);
}

run().then(
  () => { fs.rmSync(TMP, { recursive: true, force: true }); electron.app.quit(); },
  (error) => { console.error(error); fs.rmSync(TMP, { recursive: true, force: true }); electron.app.exit(1); },
);
