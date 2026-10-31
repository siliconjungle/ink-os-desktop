import { app, BrowserWindow, session, shell, dialog } from 'electron';
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalInstance, localPort } from './local-instance.mjs';
import { runtimeEnvironment } from './runtime.mjs';

let instance, window, opening, quitting = false;
const root = fileURLToPath(new URL('..', import.meta.url));
app.setName('Ink OS');
if (process.env.INK_OS_DESKTOP_DATA_DIR) {
  const directory = resolve(process.env.INK_OS_DESKTOP_DATA_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 }); app.setPath('userData', directory);
}
async function endpoint() {
  if (process.env.INK_OS_REMOTE_URL) {
    const parsed = new URL(process.env.INK_OS_REMOTE_URL);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw Error('Remote instances require HTTPS without URL credentials.');
    return { url: parsed.href };
  }
  const directory = join(app.getPath('userData'), 'instances', 'default');
  if (!instance) instance = new LocalInstance({
    platformDirectory: process.env.INK_OS_PLATFORM_DIR || (app.isPackaged ? join(process.resourcesPath, 'platform') : resolve(root, '../ink-os-platform')),
    directory, port: await localPort(directory), electron: true,
    ...(app.isPackaged ? { runtimeEnvironment: runtimeEnvironment(process.resourcesPath) } : {}),
  });
  return instance.start();
}
async function createWindow() {
  const client = await endpoint(), partition = 'persist:ink-' + createHash('sha256').update(client.instanceId || new URL(client.url).origin).digest('hex').slice(0, 24);
  if (client.token) {
    const response = await fetch(client.url + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: client.token }) });
    if (!response.ok) throw Error('Local desktop authentication failed.');
    const cookie = response.headers.get('set-cookie').split(';')[0], index = cookie.indexOf('=');
    await session.fromPartition(partition).cookies.set({ url: client.url, name: cookie.slice(0, index), value: cookie.slice(index + 1), httpOnly: true, sameSite: 'lax' });
  }
  const current = new BrowserWindow({ width: 1440, height: 960, minWidth: 800, minHeight: 560, title: 'Ink OS', backgroundColor: '#101010', webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window = current;
  current.once('closed', () => { if (window === current) window = null; });
  current.webContents.setWindowOpenHandler(({ url }) => {
    const parsed = new URL(url); if (['https:', 'http:'].includes(parsed.protocol)) void shell.openExternal(parsed.href);
    return { action: 'deny' };
  });
  current.webContents.on('will-navigate', (event, destination) => { try { if (new URL(destination).origin !== new URL(client.url).origin) event.preventDefault(); } catch { event.preventDefault(); } });
  await current.loadURL(client.url);
}
function open() {
  if (quitting) return;
  if (!app.isReady()) return app.whenReady().then(open);
  if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); return; }
  return opening ||= createWindow().catch(async error => { dialog.showErrorBox('Ink OS could not start', error.message); await instance?.stop(); app.quit(); }).finally(() => { opening = null; });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => void open());
  app.on('activate', () => void open());
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (quitting || !instance?.running) return;
    event.preventDefault(); quitting = true; window?.hide();
    void instance.stop().finally(() => app.quit());
  });
  void app.whenReady().then(open);
}
