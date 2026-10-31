import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm, readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConnectionStore } from '../src/connections.mjs';
import { ConnectionController, authenticateConnection, connectionNavigationGuard, safeConnectionError, trustedConnectionSender, validateConnectionAction, dispatchConnectionAction } from '../src/connection-controller.mjs';
import { connectionLayout, connectionOwnerHelpers, canonicalProfileDirectory, canonicalProfileDirectorySync } from '../src/connection-layout.mjs';
import { hasExplicitConnection, runDesktopCLI } from '../src/cli.mjs';
import { LocalInstance, localPort } from '../src/local-instance.mjs';

const remote = 'https://remote.invalid', remoteID = 'a'.repeat(32), credential = 'fixture-owner-token-123456789';
test('connection reads do not notify subscribers and mutation-triggered refresh cannot feed back into itself', async () => {
  let reads = 0, notifications = 0; const calls = [], state = { revision: 3, profiles: [] };
  const handlers = { store: { list: async () => { reads++; return state; }, saveCredential: async (...args) => calls.push(['saved', ...args]) },
    open: async (...args) => calls.push(['opened', ...args]), close: () => calls.push(['closed']),
    changed: async () => { if (++notifications > 2) throw Error('Connection notification feedback loop'); calls.push(['notified']); await dispatchConnectionAction({ action: 'list' }, handlers); } };
  assert.equal(await dispatchConnectionAction({ action: 'list' }, handlers), state); assert.equal(reads, 1); assert.equal(notifications, 0);
  await dispatchConnectionAction({ action: 'credential', profileId: remoteID, token: credential, revision: 2 }, handlers);
  assert.equal(notifications, 1); assert.equal(reads, 3);
  assert.deepEqual(calls, [['saved', remoteID, credential, { expectedRevision: 2 }], ['opened', remoteID, { forceReauthenticate: true }], ['notified']]);
  assert.deepEqual(await dispatchConnectionAction({ action: 'close' }, handlers), { closed: true }); assert.equal(notifications, 1);
});
test('rejected connection mutations preserve the current window and send no changed notification', async () => {
  let changed = 0, opened = 0;
  const handlers = { store: { saveCredential: async () => { throw Object.assign(Error('Stale selection'), { code: 'REVISION_CONFLICT' }); } }, open: async () => { opened++; }, changed: async () => { changed++; } };
  await assert.rejects(dispatchConnectionAction({ action: 'credential', profileId: remoteID, token: credential, revision: 0 }, handlers), { code: 'REVISION_CONFLICT' });
  await assert.rejects(dispatchConnectionAction({ action: 'unexpected' }, handlers), { code: 'INVALID_INPUT' }); assert.equal(changed, 0); assert.equal(opened, 0);
});
test('Electron modern/legacy navigation policy binds the main frame while allowing hosted-app iframe redirects', () => {
  // Shapes match the bundled Electron 42 Event<WebContentsWillRedirectEventParams>
  // and the documented deprecated positional signature; no renderer/host calls.
  for (const eventName of ['will-navigate', 'will-redirect']) for (const signature of ['details', 'legacy', 'both']) for (const isMainFrame of [true, false]) for (const destination of [remote + '/desktop', 'https://app.invalid/runtime/']) {
    let prevented = false; const event = { preventDefault() { prevented = true; } }, contents = new EventEmitter();
    if (signature !== 'legacy') Object.assign(event, { url: destination, isMainFrame, isSameDocument: false, frame: null, initiator: null });
    contents.on(eventName, connectionNavigationGuard(remote));
    if (signature === 'details') contents.emit(eventName, event); else contents.emit(eventName, event, destination, false, isMainFrame, 42, isMainFrame ? 1 : 2);
    assert.equal(prevented, isMainFrame && new URL(destination).origin !== remote, [eventName, signature, isMainFrame, destination].join(' '));
  }
  for (const details of [{}, { url: remote }, { url: 'https://app.invalid' }, { isMainFrame: 'false', url: 'https://app.invalid' }, { isMainFrame: true }, { isMainFrame: true, url: 'javascript:alert(1)' }, { isMainFrame: true, url: 'https://user:password@remote.invalid' }]) {
    let prevented = false; const event = { ...details, preventDefault() { prevented = true; } }; assert.equal(connectionNavigationGuard(remote)(event), false); assert.equal(prevented, true);
  }
  let prevented = false; const conflict = { isMainFrame: true, url: 'https://app.invalid', preventDefault() { prevented = true; } }; assert.equal(connectionNavigationGuard(remote)(conflict, remote, false, false), false); assert.equal(prevented, true);
  const local = connectionNavigationGuard('http://127.0.0.1:12345'); let localPrevented = false; local({ isMainFrame: true, url: 'http://127.0.0.1:12346', preventDefault() { localPrevented = true; } }); assert.equal(localPrevented, true);
});
class Window extends EventEmitter {
  constructor(selection, events, load) { super(); Object.assign(this, { selection, events, load, destroyed: false }); }
  isDestroyed() { return this.destroyed; }
  async loadURL(url) { this.url = url; this.events.push(['load', url]); const loaded = await this.load?.(url); if (loaded) this.url = loaded; }
  getURL() { return this.url; }
  show() { this.events.push(['show', this.selection.profileId]); }
  focus() { this.events.push(['focus', this.selection.profileId]); }
  close() { this.events.push(['close', this.selection.profileId]); this.destroyed = true; this.emit('closed'); }
  destroy() { this.events.push(['destroy', this.selection.profileId]); this.destroyed = true; this.emit('closed'); }
}
async function fixture(t, { loopback = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ink-connection-flow-'))), cleanup = [], calls = [], events = [], jars = new Map(); t.after(async () => { for (const close of cleanup) await close(); await rm(directory, { recursive: true, force: true }); }); let hook = async () => undefined;
  const fetcher = async (url, options) => {
    const parsed = new URL(url); if (loopback && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1') return fetch(url, options);
    assert.equal(parsed.origin, remote); calls.push({ path: parsed.pathname, options }); const intercepted = await hook(parsed, options); if (intercepted !== undefined) return intercepted;
    if (parsed.pathname === '/api/health') return Response.json({ ok: true, engine: 'Ink', version: 1, instanceId: remoteID });
    if (parsed.pathname === '/api/v1/me') return Response.json({ namespace: 'os', accountId: 'fixture-owner' });
    assert.equal(parsed.pathname, '/login'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(JSON.parse(options.body).token, credential);
    return Response.json({ ok: true }, { headers: { 'Set-Cookie': 'ink_os_session=fixture-session; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600' } });
  };
  const store = await new ConnectionStore({ directory, fetcher }).open();
  const added = await store.addRemote({ label: 'Hosted', url: remote, token: credential });
  const cookies = partition => { if (!jars.has(partition)) jars.set(partition, []); return { set: async cookie => { jars.get(partition).push(cookie); events.push(['cookie', partition]); }, flushStore: async () => {} }; };
  let localStarts = 0, load;
  const controller = new ConnectionController({ store, startLocal: async () => { localStarts++; throw Error('unexpected local startup'); }, authenticate: client => authenticateConnection(client, cookies(client.selection.partition), { fetcher }), createWindow: async selection => { assert.equal(Object.hasOwn(selection, 'token'), false); return new Window(selection, events, load); } });
  return { directory, store, controller, added, calls, events, jars, cleanup, fetcher, cookies, localStarts: () => localStarts, hook: fn => { hook = fn; }, load: fn => { load = fn; } };
}

test('verified remote switch authenticates only its partition, loads before activation, then closes the previous window', async t => {
  const f = await fixture(t), previous = new Window({ profileId: 'local-default' }, f.events); f.controller.currentWindow = previous;
  f.load(async () => { assert.equal((await f.store.list()).activeProfileId, 'local-default'); assert.equal(previous.isDestroyed(), false); });
  const selected = await f.controller.open(f.added.profile.id); assert.equal(selected.profileId, f.added.profile.id); assert.equal(f.localStarts(), 0); assert.equal(previous.isDestroyed(), true);
  const cookie = f.jars.get(selected.partition)[0]; assert.equal(cookie.name, 'ink_os_session'); assert.equal(cookie.url, remote); assert.equal(cookie.domain, undefined); assert.equal(cookie.httpOnly, true); assert.equal(cookie.secure, true); assert.equal(cookie.sameSite, 'lax');
  assert.ok(f.events.findIndex(([action]) => action === 'cookie') < f.events.findIndex(([action]) => action === 'load')); assert.ok(f.events.findIndex(([action]) => action === 'show') < f.events.findIndex(([action]) => action === 'close'));
  const cli = await f.store.resolveCLI(); assert.equal(cli.clientConfigPath, selected.clientConfigPath); const calls = f.calls.length; await f.controller.open(f.added.profile.id); assert.equal(f.calls.length, calls); assert.equal(f.localStarts(), 0);
});

test('same-account rotation reauthenticates the existing window/partition and explicit reauthentication repairs an unchanged credential', async t => {
  const f = await fixture(t); await f.controller.open(f.added.profile.id); const window = f.controller.currentWindow, original = f.controller.currentSelection, loads = f.events.filter(([action]) => action === 'load').length;
  window.pendingOutbox = [{ id: 'fixture-unsent-edit', bytes: 'retained-local-edit' }]; let logins = 0;
  f.hook((url, options) => {
    if (url.pathname === '/login') { logins++; assert.equal(JSON.parse(options.body).token, credential + '-replacement'); return Response.json({}, { headers: { 'Set-Cookie': 'ink_os_session=replacement-session; Path=/; HttpOnly' } }); }
    return undefined;
  });
  await f.store.saveCredential(f.added.profile.id, credential + '-replacement'); await f.controller.open(f.added.profile.id);
  assert.equal(f.controller.currentWindow, window); assert.equal(window.isDestroyed(), false); assert.equal(f.controller.currentSelection.partition, original.partition); assert.notEqual(f.controller.currentSelection.credentialVersion, original.credentialVersion); assert.equal(logins, 1); assert.equal(f.jars.get(original.partition).at(-1).value, 'replacement-session'); assert.equal(f.events.filter(([action]) => action === 'load').length, loads); assert.equal(window.pendingOutbox[0].bytes, 'retained-local-edit');
  await f.store.saveCredential(f.added.profile.id, credential + '-replacement'); await f.controller.open(f.added.profile.id, { forceReauthenticate: true }); assert.equal(logins, 2); assert.equal(f.controller.currentWindow, window); assert.equal(f.events.filter(([action]) => action === 'load').length, loads);
});

test('an explicitly changed account receives a separate partition and window', async t => {
  const f = await fixture(t); await f.controller.open(f.added.profile.id); const previous = f.controller.currentWindow, partition = f.controller.currentSelection.partition;
  f.hook((url, options) => {
    if (url.pathname === '/api/v1/me') return Response.json({ namespace: 'os', accountId: 'fixture-other-account' });
    if (url.pathname === '/login') return Response.json({}, { headers: { 'Set-Cookie': 'ink_os_session=other-account-session; Path=/; HttpOnly' } });
    return undefined;
  });
  await f.store.saveCredential(f.added.profile.id, credential + '-other'); await f.controller.open(f.added.profile.id); assert.notEqual(f.controller.currentSelection.partition, partition); assert.notEqual(f.controller.currentWindow, previous); assert.equal(previous.isDestroyed(), true); assert.equal(f.jars.size, 2);
});

test('authentication redirect/cookie failure, page load failure and CAS drift preserve the old selection/window', async t => {
  for (const mode of ['redirect', 'foreign-cookie', 'load', 'foreign-page', 'cas']) {
    const f = await fixture(t), previous = new Window({ profileId: 'local-default' }, f.events); f.controller.currentWindow = previous;
    if (mode === 'redirect') f.hook(url => url.pathname === '/login' ? new Response(null, { status: 302, headers: { Location: 'https://foreign.invalid' } }) : undefined);
    if (mode === 'foreign-cookie') f.hook(url => url.pathname === '/login' ? Response.json({}, { headers: { 'Set-Cookie': 'ink_os_session=fixture; HttpOnly; Domain=foreign.invalid; Path=/' } }) : undefined);
    if (mode === 'load') f.load(async () => { throw Error(credential); });
    if (mode === 'foreign-page') f.load(async () => 'https://foreign.invalid/redirected');
    if (mode === 'cas') f.load(async () => { await f.store.addRemote({ label: 'Concurrent metadata change', url: remote }); });
    await assert.rejects(f.controller.open(f.added.profile.id)); assert.equal((await f.store.list()).activeProfileId, 'local-default', mode); assert.equal(previous.isDestroyed(), false, mode); assert.equal(f.controller.currentWindow, previous); assert.equal(f.localStarts(), 0);
    if (['load', 'foreign-page', 'cas'].includes(mode)) assert.ok(f.events.some(([action]) => action === 'destroy')); else assert.equal(f.events.some(([action]) => action === 'load'), false);
  }
  assert.ok(!JSON.stringify(safeConnectionError(Error(credential))).includes(credential));
});

test('desktop sign-in rejects malformed, multiple and foreign cookies and never follows a login redirect', async t => {
  const f = await fixture(t), client = await f.store.getClient(f.added.profile.id); let writes = 0;
  const jar = { set: async () => { writes++; } };
  for (const cookie of ['other=fixture; HttpOnly', 'ink_os_session=fixture; Path=/private; HttpOnly', 'ink_os_session=fixture; Path=/', 'ink_os_session=fixture; HttpOnly; Max-Age=0', 'ink_os_session=fixture; HttpOnly; Domain=foreign.invalid']) {
    await assert.rejects(authenticateConnection(client, jar, { fetcher: async () => Response.json({}, { headers: { 'Set-Cookie': cookie } }) }), { code: 'LOGIN_COOKIE_INVALID' });
  }
  const headers = new Headers(); headers.append('Set-Cookie', 'ink_os_session=one; HttpOnly'); headers.append('Set-Cookie', 'ink_os_session=two; HttpOnly');
  await assert.rejects(authenticateConnection(client, jar, { fetcher: async () => Response.json({}, { headers }) }), { code: 'LOGIN_COOKIE_INVALID' });
  await assert.rejects(authenticateConnection(client, jar, { fetcher: async (_url, options) => { assert.equal(options.redirect, 'error'); return { status: 200, redirected: false, url: 'https://foreign.invalid/login', headers, body: null }; } }), { code: 'ORIGIN_MISMATCH' });
  assert.equal(writes, 0);
});

test('trusted Connections IPC requires the exact window, main frame and file URL, with only bounded allowlisted actions', () => {
  const url = 'file:///app/src/connections-ui.html', frame = { url }, contents = { mainFrame: frame, getURL: () => url }, window = { webContents: contents, isDestroyed: () => false }, event = { sender: contents, senderFrame: frame };
  assert.equal(trustedConnectionSender(event, window, url), true);
  for (const wrong of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: { url } }, { sender: contents, senderFrame: { url: remote } }]) assert.equal(trustedConnectionSender(wrong, window, url), false);
  assert.equal(trustedConnectionSender(event, { ...window, isDestroyed: () => true }, url), false);
  assert.deepEqual(validateConnectionAction({ action: 'list' }), { action: 'list' });
  for (const input of [{ action: 'exec', command: 'anything' }, { action: 'list', token: credential }, { action: 'select', profileId: '../../outside' }, { action: 'remove', profileId: 'local-default' }, { action: 'connect', label: 'Hosted', url: remote, mode: 'instance', token: 'x'.repeat(4097) }]) assert.throws(() => validateConnectionAction(input), { code: 'INVALID_INPUT' });
});

test('default desktop login cannot overwrite an immutable profile config and offline commands need no host', async t => {
  const f = await fixture(t), layout = { resources: '/bundled/resources', packaged: true, development: false }, directory = f.directory;
  await assert.rejects(runDesktopCLI({ args: ['login'], environment: {}, layout, storeFactory: () => { throw Error('login must not touch the profile store'); }, platformMain: () => {} }), /Use Connections/);
  for (const command of ['help', 'init', 'build', 'backup']) {
    let resolved = false; const fakeStore = { open: async () => fakeStore, activeSelection: async () => ({ kind: 'remote', clientConfigPath: '/captured/immutable.json' }), resolveCLI: async () => { resolved = true; throw Error('offline command must not contact host'); } };
    await runDesktopCLI({ args: [command], environment: { INK_OS_DESKTOP_DATA_DIR: directory }, layout, ownerHelpers: async () => ({}), storeFactory: () => fakeStore, platformMain: async (_args, env) => { assert.equal(env.INK_OS_CONFIG, '/captured/immutable.json'); } }); assert.equal(resolved, false);
  }
});

test('CLI explicit connection overrides bypass profile credentials and default CLI captures the shared immutable selection', async t => {
  const f = await fixture(t), layout = { resources: '/bundled/resources', packaged: true, development: false, platformCLI: 'file:///bundled/platform/cli.mjs' };
  for (const environment of [{ INK_OS_CONFIG: '/explicit/client.json' }, { INK_OS_URL: remote }, { INK_OS_TOKEN: credential }, { INK_OS_TOKEN: '' }]) {
    const before = { ...environment }; await runDesktopCLI({ args: ['apps'], environment, layout, storeFactory: () => { throw Error('must not read default profile'); }, platformMain: async (_args, env) => { for (const [key, value] of Object.entries(before)) assert.equal(env[key], value); assert.equal(env.INK_OS_MANAGED_NATIVE_MODULE, undefined); } });
  }
  for (const args of [['--url', remote, 'apps'], ['apps', '--url=' + remote]]) assert.equal(hasExplicitConnection(args, {}), true);
  const client = await f.store.getClient(f.added.profile.id); await f.store.activate(f.added.profile.id, { expectedRevision: client.selection.revision, verifiedBinding: client.binding }); const captured = await f.store.resolveCLI();
  const environment = { INK_OS_DESKTOP_DATA_DIR: f.directory }; let called = false;
  await runDesktopCLI({ args: ['apps'], environment, layout, ownerHelpers: async () => ({}), storeFactory: () => f.store, platformMain: async (_args, env) => { called = true; assert.equal(env.INK_OS_CONFIG, captured.clientConfigPath); assert.equal(env.INK_OS_MANAGED_NATIVE_MODULE, undefined); const original = await readFile(env.INK_OS_CONFIG); await f.store.addRemote({ label: 'New metadata', url: remote }); assert.deepEqual(await readFile(env.INK_OS_CONFIG), original); } }); assert.equal(called, true);
});

test('packaged/dev helper paths and canonical data roots use bundled process receipts without loading a native installer', async t => {
  const f = await fixture(t), packaged = await connectionLayout({ applicationRoot: '/resources/app.asar', resources: '/resources', packaged: true, environment: {} }), development = await connectionLayout({ applicationRoot: '/workspace/ink-os-desktop', packaged: false, environment: {} });
  assert.equal(packaged.processReceipts, 'file:///resources/platform/server/process-receipt.mjs'); assert.equal(development.platformDirectory, '/workspace/ink-os-platform');
  let imported; const capture = () => {}, check = () => {}; const helpers = await connectionOwnerHelpers(packaged, async url => { imported = url; return { captureCurrentProcessReceipt: capture, checkProcessReceipt: check }; }); assert.equal(imported, packaged.processReceipts); assert.equal(helpers.captureOwner, capture); assert.equal(helpers.checkOwner, check);
  assert.equal(await canonicalProfileDirectory({}, f.directory), f.directory);
  assert.equal(canonicalProfileDirectorySync({}, f.directory), f.directory);
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8'); const content = source.slice(source.indexOf('createWindow: selection'), source.indexOf('onCommit:')); assert.ok(!content.includes('preload')); assert.ok(content.includes('nodeIntegration: false')); assert.ok(content.includes('sandbox: true')); assert.ok(source.includes("role: 'editMenu'"));
  const html = await readFile(new URL('../src/connections-ui.html', import.meta.url), 'utf8'); assert.ok(html.includes("connect-src 'none'")); assert.ok(html.includes('type="password"')); assert.ok(html.includes('../assets/icon.svg'));
  assert.ok(source.includes("on('will-redirect', guardOrigin)"));
});

test('minimal packaged CLI tools load from resources and lazily import only bundled receipt helpers', async t => {
  const f = await fixture(t), resources = join(f.directory, 'Resources'), tools = join(resources, 'tools');
  await mkdir(tools, { recursive: true }); await mkdir(join(resources, 'platform', 'cli', 'bin'), { recursive: true }); await mkdir(join(resources, 'platform', 'server'), { recursive: true });
  for (const name of ['cli.mjs', 'connections.mjs', 'connection-layout.mjs', 'runtime.mjs']) await copyFile(new URL('../src/' + name, import.meta.url), join(tools, name));
  await writeFile(join(resources, 'platform', 'cli', 'bin', 'ink-os.mjs'), 'export const main = () => {};');
  await writeFile(join(resources, 'platform', 'server', 'process-receipt.mjs'), 'export const captureCurrentProcessReceipt = async () => ({verified:false}); export const checkProcessReceipt = async () => ({verified:false});');
  const packaged = await import(pathToFileURL(join(tools, 'cli.mjs')).href), environment = { INK_OS_DESKTOP_DATA_DIR: join(f.directory, 'packaged-data') };
  await packaged.runDesktopCLI({ args: ['help'], environment, platformMain: async (_args, env) => { assert.equal(env.INK_OS_GIT_ROOT, join(resources, 'git')); assert.equal(env.INK_OS_MANAGED_NATIVE_MODULE, join(tools, 'native-toolchain.mjs')); assert.equal(env.INK_OS_CONFIG, join(environment.INK_OS_DESKTOP_DATA_DIR, 'instances', 'default', 'client.json')); } });
  const packageSource = await readFile(new URL('../scripts/package.mjs', import.meta.url), 'utf8');
  for (const name of ['connections.mjs', 'connection-layout.mjs']) assert.ok(packageSource.includes("'" + name + "'"));
  assert.ok(packageSource.includes("join(app, 'assets', 'icon.svg')"));
});

test('trusted preload exposes bounded profile actions without raw IPC or token retrieval', async () => {
  const requests = [], listeners = new Map(); let exposed;
  const ipcRenderer = { invoke: async (channel, input) => { requests.push({ channel, input }); return { ok: true }; }, on: (channel, listener) => listeners.set(channel, listener), removeListener: (channel, listener) => { assert.equal(listeners.get(channel), listener); listeners.delete(channel); } };
  runInNewContext(await readFile(new URL('../src/connections-preload.cjs', import.meta.url), 'utf8'), { require: name => { assert.equal(name, 'electron'); return { ipcRenderer, contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'inkConnections'); exposed = value; } } }; } });
  assert.deepEqual(Object.keys(exposed).sort(), ['close', 'connect', 'credential', 'list', 'onChanged', 'remove', 'select', 'upgrade']);
  await exposed.connect({ label: 'Hosted', url: remote, mode: 'instance', token: credential, command: 'ignored' }); assert.equal(requests[0].channel, 'ink:connections'); assert.equal(requests[0].input.command, undefined);
  let argumentsReceived; const unsubscribe = exposed.onChanged((...args) => { argumentsReceived = args; }); listeners.get('ink:connections-changed')({ privateEvent: true }); assert.deepEqual(argumentsReceived, []); unsubscribe(); assert.equal(listeners.size, 0);
});

test('actual owned LocalInstance stays alive when the controller switches to a remote profile', { timeout: 25000 }, async t => {
  const f = await fixture(t, { loopback: true }); let instance;
  f.cleanup.push(async () => { await instance?.stop(); });
  f.controller.startLocal = async selection => { instance ||= new LocalInstance({ platformDirectory: resolve('../ink-os-platform'), directory: selection.instanceDirectory, port: await localPort(selection.instanceDirectory) }); await instance.start(); };
  await f.controller.open('local-default'); assert.equal(instance.running, true); const local = await f.store.getClient('local-default');
  assert.deepEqual((await (await fetch(local.url + '/api/v1/apps', { headers: { Authorization: 'Bearer ' + local.token } })).json()).map(app=>JSON.parse(app.body).slug).sort(), ['finder','ink-environment','preview']);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME)/.test(name)));
  Object.assign(environment, { INK_OS_DESKTOP_DATA_DIR: f.directory, INK_OS_PLATFORM_DIR: instance.platformDirectory });
  const execute = promisify(execFile), cli = new URL('../src/cli.mjs', import.meta.url);
  const listed = await execute(process.execPath, [cli.pathname, 'apps', 'list'], { env: environment, maxBuffer: 1024 * 1024 }); assert.deepEqual(JSON.parse(listed.stdout).map(app=>JSON.parse(app.body).slug).sort(), ['finder','ink-environment','preview']);
  await f.controller.open(f.added.profile.id); assert.equal(instance.running, true); assert.equal((await fetch(local.url + '/api/health')).status, 200); assert.equal((await f.store.resolveCLI()).profileId, f.added.profile.id);
  const help = await execute(process.execPath, [cli.pathname, 'help'], { env: environment, maxBuffer: 1024 * 1024 }); assert.ok(help.stdout.includes('ink-os apps'));
});
