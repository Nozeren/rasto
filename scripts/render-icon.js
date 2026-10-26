/**
 * Renders build/icon.svg to build/icon.png (1024×1024, transparent) with Electron, so no image library is needed.
 * electron-builder turns icon.png into the macOS .icns. Run with: npm run icon
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 1024;
const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf-8');
const html = `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  let image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  if (image.getSize().width !== SIZE) image = image.resize({ width: SIZE, height: SIZE, quality: 'best' });
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), image.toPNG());
  console.log(`build/icon.png written (${image.getSize().width}×${image.getSize().height})`);
  app.quit();
});
