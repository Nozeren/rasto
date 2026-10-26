#!/usr/bin/env node
/**
 * Finishes an Electron install that Node 26 left half-done.
 *
 * Electron's own install.js unzips with `extract-zip`, which on Node 26 exits mid-extraction with code 0: the app is
 * partly extracted and `path.txt` is never written, so `electron .` fails with "Electron failed to install correctly".
 * This re-extracts the already-downloaded zip with the system `unzip` (or `tar` on Windows) and writes `path.txt`.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const { version } = require(path.join(electronDir, 'package.json'));
const platformPath = { darwin: 'Electron.app/Contents/MacOS/Electron', win32: 'electron.exe' }[process.platform] || 'electron';

if (fs.existsSync(path.join(electronDir, 'path.txt')) && fs.existsSync(path.join(electronDir, 'dist', platformPath))) {
  console.log(`Electron ${version} is already installed.`);
  process.exit(0);
}

const cacheRoots = {
  darwin: path.join(os.homedir(), 'Library', 'Caches', 'electron'),
  win32: path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache'),
  linux: path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron'),
};
const cacheRoot = process.env.electron_config_cache || cacheRoots[process.platform] || cacheRoots.linux;
const zipName = `electron-v${version}-${process.platform}-${process.arch}.zip`;

function findZip(dir) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findZip(full);
      if (found) return found;
    } else if (entry.name === zipName) {
      return full;
    }
  }
  return null;
}

const zip = findZip(cacheRoot);
if (!zip) {
  console.error(`Could not find ${zipName} under ${cacheRoot}. Run "node node_modules/electron/install.js" once to download it.`);
  process.exit(1);
}

const dist = path.join(electronDir, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);
if (process.platform === 'win32') {
  execFileSync('tar', ['-xf', zip, '-C', dist], { stdio: 'inherit' });
} else {
  execFileSync('unzip', ['-q', zip, '-d', dist], { stdio: 'inherit' });
}
fs.writeFileSync(path.join(electronDir, 'path.txt'), platformPath);
console.log(`Electron ${version} extracted from ${zip}`);
