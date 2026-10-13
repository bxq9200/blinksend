const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const handlers = {
    'app:get-state': () => ({ self: { name: 'QA-PC', ips: ['192.168.1.2'], downloadDir: 'F:\\Downloads', conflictPolicy: 'keep-both', version: '0.3.0' }, devices: [], history: [], update: { status: 'current', currentVersion: '0.3.0' } }),
    'config:set-conflict-policy': (_event, conflictPolicy) => ({ downloadDir: 'F:\\Downloads', conflictPolicy }),
    'update:check': () => ({ status: 'available', currentVersion: '0.3.0', latestVersion: '0.4.0', notes: 'Test release notes' }),
    'transfer:accept': () => ({ ok: true }), 'transfer:reject': () => ({ ok: true }),
  };
  for (const [name, handler] of Object.entries(handlers)) ipcMain.handle(name, handler);
  const window = new BrowserWindow({ show: false, width: 1120, height: 680, frame: false, webPreferences: { preload: path.join(__dirname, '../src/preload.js'), sandbox: false } });
  await window.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  const request = { id: 'qa', fileName: 'a.txt', relativePath: 'A-very-long-folder-name/'.repeat(12) + 'a.txt', size: 999999, from: { name: 'REMOTE-PC' } };
  window.webContents.send('transfer:incoming-request', request);
  const output = path.join(__dirname, '../dist/qa');
  await fs.mkdir(output, { recursive: true });
  for (const [width, height] of [[920, 620], [1120, 680], [1500, 900]]) {
    window.setSize(width, height);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await window.webContents.executeJavaScript(`(() => {
      const list = document.querySelector('#requests');
      const card = document.querySelector('.request');
      const actions = [...document.querySelectorAll('.request-actions button')];
      const buttonRects = actions.map(button => { const r = button.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
      const c = card.getBoundingClientRect();
      return { overflow: list.scrollWidth > list.clientWidth, buttons: buttonRects, withinCard: buttonRects.every(r => r.x >= c.x && r.x + r.width <= c.right && r.y + r.height <= c.bottom), policy: document.querySelector('#conflictPolicy').value, version: document.querySelector('#appVersion').textContent };
    })()`);
    if (result.overflow || !result.withinCard || result.buttons.length !== 2 || result.buttons.some((r) => r.height !== 32)) throw new Error(JSON.stringify(result));
    let capture = (await window.webContents.capturePage()).toPNG();
    if (!capture.length) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      capture = (await window.webContents.capturePage()).toPNG();
    }
    if (!capture.length) throw new Error('Empty screenshot');
    await fs.writeFile(path.join(output, `main-${width}.png`), capture);
    console.log(JSON.stringify({ viewport: [width, height], ...result }));
  }
  await window.webContents.executeJavaScript("document.querySelector('#updateBtn').click(); document.querySelector('#checkUpdateBtn').click()");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const available = await window.webContents.executeJavaScript("document.querySelector('#updateDialog').open && !document.querySelector('#downloadUpdateBtn').hidden");
  if (!available) throw new Error('Update dialog missing available state');
  await fs.writeFile(path.join(output, 'update.png'), (await window.webContents.capturePage()).toPNG());
  window.destroy();
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
