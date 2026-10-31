import { app, BrowserWindow, session, shell, dialog } from 'electron';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalInstance } from './local-instance.mjs';

let instance, window;
const root = fileURLToPath(new URL('..', import.meta.url));
async function availablePort() {
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
async function open() {
  const remote = process.env.INK_OS_REMOTE_URL;
  let url;
  if (remote) {
    const parsed = new URL(remote);
    if (parsed.protocol !== 'https:') throw Error('Remote instances require HTTPS.');
    url = parsed.href;
  } else {
    instance = new LocalInstance({
      platformDirectory: process.env.INK_OS_PLATFORM_DIR || resolve(root, '../ink-os-platform'),
      directory: join(app.getPath('userData'), 'instances', 'default'),
      port: await availablePort(), electron: true,
    });
    const client = await instance.start(); url = client.url;
    const response = await fetch(url + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: client.token }) });
    if (!response.ok) throw Error('Local desktop authentication failed.');
    const cookie = response.headers.get('set-cookie').split(';')[0], index = cookie.indexOf('=');
    await session.defaultSession.cookies.set({ url, name: cookie.slice(0, index), value: cookie.slice(index + 1), httpOnly: true, sameSite: 'lax' });
  }
  window = new BrowserWindow({ width: 1440, height: 960, minWidth: 800, minHeight: 560, title: 'Ink OS', backgroundColor: '#101010', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const parsed = new URL(url); if (['https:', 'http:'].includes(parsed.protocol)) void shell.openExternal(parsed.href);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, destination) => { if (new URL(destination).origin !== new URL(url).origin) event.preventDefault(); });
  await window.loadURL(url);
}
await app.whenReady();
try { await open(); } catch (error) { dialog.showErrorBox('Ink OS could not start', error.message); await instance?.stop(); app.quit(); }
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (window && !window.isDestroyed()) window.show(); else void open(); });
let quitting = false;
app.on('before-quit', event => {
  if (quitting || !instance) return;
  event.preventDefault(); quitting = true;
  void instance.stop().finally(() => app.quit());
});
