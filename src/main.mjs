import { app, BrowserWindow, session, shell, dialog, Menu, ipcMain } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectionStore, connectionOrigin } from './connections.mjs';
import { ConnectionController, authenticateConnection, connectionNavigationGuard, safeConnectionError, trustedConnectionSender, dispatchConnectionAction } from './connection-controller.mjs';
import { canonicalProfileDirectorySync, connectionLayout, connectionOwnerHelpers } from './connection-layout.mjs';
import { LocalInstance, localPort } from './local-instance.mjs';
import { runtimeEnvironment } from './runtime.mjs';
import { DesktopUpdates,updateConfiguration } from './updates.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), uiURL = new URL('./connections-ui.html', import.meta.url).href, uiFile = fileURLToPath(new URL('./connections-ui.html', import.meta.url)), preload = fileURLToPath(new URL('./connections-preload.cjs', import.meta.url));
let instance, store, controller, layout, connectionsWindow, opening, initializing, updater,checkingUpdate,pendingInstaller,quitting = false,quitReady=false;
app.setName('Ink OS');
const dataDirectory = canonicalProfileDirectorySync(process.env, process.env.INK_OS_DESKTOP_DATA_DIR || app.getPath('userData'));
app.setPath('userData', dataDirectory); app.setPath('sessionData', dataDirectory);
const icon = () => app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(root, 'assets', 'icon.png');
async function initialize() {
  return initializing ||= (async () => {
    const directory = dataDirectory;
    layout = await connectionLayout({ applicationRoot: root, resources: app.isPackaged ? process.resourcesPath : root, packaged: app.isPackaged });
    store = await new ConnectionStore({ directory, ...await connectionOwnerHelpers(layout) }).open();
    controller = new ConnectionController({ store, isQuitting: () => quitting,
      startLocal: async selection => { if (!instance) instance = new LocalInstance({ platformDirectory: layout.platformDirectory, directory: selection.instanceDirectory, port: await localPort(selection.instanceDirectory), electron: true, runtimeEnvironment: runtimeEnvironment(layout.resources, { directory: selection.instanceDirectory, development: layout.development }) }); await instance.start(); },
      authenticate: client => authenticateConnection(client, session.fromPartition(client.selection.partition).cookies),
      createWindow: selection => {
        const window = new BrowserWindow({ show: false, width: 1440, height: 960, minWidth: 800, minHeight: 560, title: 'Ink OS', icon: icon(), backgroundColor: '#101010', webPreferences: { partition: selection.partition, nodeIntegration: false, contextIsolation: true, sandbox: true } });
        window.webContents.setWindowOpenHandler(({ url }) => { try { const parsed = new URL(url); if (['https:', 'http:'].includes(parsed.protocol)) void shell.openExternal(parsed.href); } catch {} return { action: 'deny' }; });
        window.webContents.on('before-input-event', (event, input) => {
          const command = process.platform === 'darwin' ? input.meta : input.control;
          if (input.type === 'keyDown' && command && !input.alt && !input.shift && input.key === ',') { event.preventDefault(); openConnections(); }
        });
        const guardOrigin = connectionNavigationGuard(selection.url);
        window.webContents.on('will-navigate', guardOrigin); window.webContents.on('will-redirect', guardOrigin);
        return window;
      }, onCommit: async () => { await updateMenu(); notifyConnections(); }
    });
    if (app.dock) app.dock.setIcon(icon()); await updateMenu();
  })().catch(error => { initializing = null; throw error; });
}
function notifyConnections() { if (connectionsWindow && !connectionsWindow.isDestroyed()) connectionsWindow.webContents.send('ink:connections-changed'); }
function showFailure(error) { const safe = safeConnectionError(error); dialog.showErrorBox('Ink OS connection', safe.message); }
function openConnections() { void showConnections().catch(showFailure); }
function checkForUpdates(){
  if(quitting||checkingUpdate)return;
  checkingUpdate=(async()=>{
    updater ||= new DesktopUpdates({...await updateConfiguration(),token:process.env.INK_OS_UPDATE_TOKEN});
    let candidate;
    try{candidate=await updater.check();}
    catch{const result=await dialog.showMessageBox({type:'info',title:'Ink OS updates',message:'The release feed is unavailable.',detail:'Private preview releases require repository access. You can open the release page in your browser, or supply INK_OS_UPDATE_TOKEN for verified in-app downloads.',buttons:['Open releases','Close'],cancelId:1});if(result.response===0)await shell.openExternal(updater.releaseURL);return;}
    if(!candidate.available){await dialog.showMessageBox({type:'info',title:'Ink OS updates',message:'Ink OS is up to date.',buttons:['OK']});return;}
    const choice=await dialog.showMessageBox({type:'info',title:'Ink OS updates',message:'Ink OS '+candidate.tag+' is available.',detail:'Download a verified installer for this Mac. Your local data and saved connections stay in your Ink OS profile.',buttons:['Download','View release','Later'],cancelId:2});
    if(choice.response===1){await shell.openExternal(candidate.releaseURL);return;}if(choice.response!==0)return;
    let downloaded;
    try{downloaded=await updater.download(candidate,{directory:join(dataDirectory,'updates'),progress:value=>controller?.currentWindow?.setProgressBar(value)});}finally{controller?.currentWindow?.setProgressBar(-1);}
    if(quitting)return;
    const install=await dialog.showMessageBox({type:'info',title:'Ink OS update ready',message:'The installer is downloaded and verified.',detail:'Ink OS will finish local work before quitting. Then replace the application using the installer. This development preview is not notarized.',buttons:['Quit and open installer','Later'],cancelId:1});
    if(install.response===0){pendingInstaller=downloaded;app.quit();}
  })().catch(()=>dialog.showErrorBox('Ink OS updates','The update could not be verified or downloaded. The installed application has not been changed.')).finally(()=>checkingUpdate=null);
}
async function switchConnection(id, options) { await initialize(); const result = await controller.open(id, options); notifyConnections(); return result; }
async function updateMenu() {
  const saved = await store.list();
  const connectItems = saved.profiles.map(profile => ({ label: profile.label.replaceAll('&', '&&'), type: 'radio', checked: profile.id === saved.activeProfileId, click: () => void switchConnection(profile.id).catch(showFailure) }));
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu', submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Connections…', accelerator: 'CmdOrCtrl+,', click: openConnections }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [{ label: 'Open Ink OS', accelerator: 'CmdOrCtrl+N', click: () => void open() }, { label: 'Connections…', accelerator: process.platform === 'darwin' ? undefined : 'CmdOrCtrl+,', click: openConnections }, { label:'Check for updates…',accelerator:'CmdOrCtrl+Shift+U',click:checkForUpdates }, { type: 'separator' }, { role: process.platform === 'darwin' ? 'close' : 'quit' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { label: 'Connections', submenu: [...connectItems, { type: 'separator' }, { label: 'Connect to a host…', click: openConnections }, { label: 'Manage connections…', click: openConnections }] }, { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
async function showConnections() {
  await initialize(); if (connectionsWindow && !connectionsWindow.isDestroyed()) { connectionsWindow.show(); connectionsWindow.focus(); return; }
  const window = new BrowserWindow({ width: 660, height: 760, minWidth: 520, minHeight: 620, title: 'Connections', icon: icon(), backgroundColor: '#151515', webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true } });
  connectionsWindow = window; window.once('closed', () => { if (connectionsWindow === window) connectionsWindow = null; });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); window.webContents.on('will-navigate', (event, destination) => { if (destination !== uiURL) event.preventDefault(); });
  await window.loadFile(uiFile);
}
ipcMain.handle('ink:connections', async (event, request) => {
  if (!trustedConnectionSender(event, connectionsWindow, uiURL)) return { ok: false, error: { code: 'FORBIDDEN', message: 'This request is available only in Connections.' } };
  try {
    const result = await dispatchConnectionAction(request, { store, open: switchConnection, close: () => connectionsWindow.close(), changed: async () => { await updateMenu(); notifyConnections(); } });
    return { ok: true, result };
  } catch (error) { return { ok: false, error: safeConnectionError(error) }; }
});
async function startupSelection() {
  if (!process.env.INK_OS_REMOTE_URL) return (await store.list()).activeProfileId;
  const url = connectionOrigin(process.env.INK_OS_REMOTE_URL), saved = await store.list(), mode = process.env.INK_OS_REMOTE_MODE;
  if (mode !== undefined && !['instance', 'origin-compatibility'].includes(mode)) throw Object.assign(Error(), { code: 'INVALID_BINDING' });
  const existing = saved.profiles.find(profile => profile.kind === 'remote' && profile.url === url && (mode === undefined || profile.mode === mode)); if (existing) return existing.id;
  return (await store.addRemote({ label: 'Hosted Ink OS', url, mode: mode || 'instance' })).profile.id;
}
function open() {
  if (quitting) return;
  if (!app.isReady()) return app.whenReady().then(open);
  if (controller?.currentWindow && !controller.currentWindow.isDestroyed()) { const window = controller.currentWindow; if (window.isMinimized()) window.restore(); window.show(); window.focus(); return; }
  return opening ||= initialize().then(startupSelection).then(switchConnection).catch(async error => { showFailure(error); try { await showConnections(); } catch (failure) { showFailure(failure); } }).finally(() => { opening = null; });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => void open()); app.on('activate', () => void open());
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {if(quitReady)return;event.preventDefault();if(quitting)return;quitting=true;controller?.currentWindow?.hide();connectionsWindow?.hide();void(async()=>{await updater?.cancel();await Promise.resolve(instance?.starting).catch(()=>{});if(instance?.running)await instance.stop();if(pendingInstaller){await updater.verify(pendingInstaller.path,pendingInstaller);const failure=await shell.openPath(pendingInstaller.path);if(failure)throw Error('Installer could not be opened.');}quitReady=true;app.quit();})().catch(error=>{quitting=false;showFailure(error);controller?.currentWindow?.show();});});
  void app.whenReady().then(open);
}
