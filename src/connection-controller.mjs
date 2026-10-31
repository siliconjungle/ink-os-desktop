import { connectionOrigin } from './connections.mjs';

const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
const messages = {
  INVALID_ORIGIN: 'Enter an HTTPS origin without a path, credentials or URL parameters.', INSTANCE_MISMATCH: 'This host identity does not match the saved connection. Legacy hosts need explicit origin compatibility.',
  IDENTITY_UPGRADE_REQUIRED: 'This host now has an instance identity. Pin its identity in Connections before signing in.', OWNER_ACCOUNT_REQUIRED: 'Use an Ink OS account credential, not an app or service credential.', DESKTOP_SCOPE_REQUIRED: 'This account key needs the computer scope to sign in to the desktop.',
  HOST_DRAINING: 'This host is finishing work for maintenance. Your current connection stays open.', CONNECTION_UNAVAILABLE: 'The host could not be reached securely.', CONNECTION_REJECTED: 'The host rejected connection verification.', INVALID_HEALTH: 'This origin did not identify a supported Ink OS host.', INVALID_IDENTITY: 'The host returned an invalid instance identity.',
  LOGIN_REJECTED: 'The host did not accept desktop sign-in.', LOGIN_COOKIE_INVALID: 'The host did not return a valid desktop session cookie.', ORIGIN_MISMATCH: 'Connection verification returned another origin.',
  REVISION_CONFLICT: 'The saved selection changed. Refresh Connections and try again.', UNVERIFIED_BINDING: 'The connection changed during verification. Try opening it again.', CONNECTIONS_LOCKED: 'Another connection operation may still be active. Existing profiles were preserved.',
  PROFILE_IN_USE: 'Switch away from this profile before removing it.', PROFILE_NOT_FOUND: 'That saved connection no longer exists.', INVALID_LABEL: 'Give the connection a short label.', INVALID_CREDENTIAL: 'Provide a valid account credential.', LOCAL_START_REQUIRED: 'Open the local connection before using its CLI.',
  UNSAFE_FILE: 'A connection file is not private or is a symlink. It was preserved.', UNSAFE_PATH: 'A connection path contains an unsafe alias. It was preserved.', CLIENT_MISMATCH: 'The saved client does not match this connection. No credential was sent.',
  INVALID_STORE: 'The private connection registry could not be verified.', RESPONSE_BOUND: 'The host returned an oversized verification response.', INVALID_JSON: 'The host returned invalid verification data.', PROFILE_BOUND: 'The saved connection limit has been reached.', GENERATION_BOUND: 'The retained client configuration limit has been reached.',
  SESSION_ACCOUNT_MISMATCH: 'This credential now identifies another account. Explicitly update it in Connections to open a separate browser session.', LEGACY_SESSION_UNVERIFIED: 'The historical account could not be verified. Its browser data was preserved.', SESSION_BOUNDARY_MISMATCH: 'Historical browser data belongs to another host boundary and was preserved.'
};
export function safeConnectionError(error) { const code = Object.hasOwn(messages, error?.code) ? error.code : 'CONNECTION_FAILED'; return Object.freeze({ code, message: messages[code] || 'The connection could not be opened. Your current window and local work were preserved.' }); }

export function trustedConnectionSender(event, window, trustedURL) {
  try { return !!window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === trustedURL && window.webContents.getURL() === trustedURL; } catch { return false; }
}
/** Electron's navigation details describe the target frame, not its initiator.
 * App iframe redirects may leave the host origin; the main frame may not. Older
 * Electron versions supply the frame flag in the fourth positional argument. */
export function connectionNavigationGuard(origin) {
  const expected = new URL(origin); if (expected.origin !== origin) fail('INVALID_ORIGIN', 'Bind navigation to an exact host origin');
  return (details, legacyURL, _legacyIsInPlace, legacyIsMainFrame) => {
    const modernFrame = details?.isMainFrame, legacyFrame = typeof legacyIsMainFrame === 'boolean' ? legacyIsMainFrame : undefined;
    const consistent = !(typeof modernFrame === 'boolean' && legacyFrame !== undefined && modernFrame !== legacyFrame);
    const frame = typeof modernFrame === 'boolean' ? modernFrame : modernFrame === undefined ? legacyFrame : undefined;
    if (consistent && frame === false) return true;
    let allowed = false;
    if (consistent && frame === true) {
      const destination = details?.url === undefined ? legacyURL : details.url;
      try { const url = new URL(destination); allowed = typeof destination === 'string' && url.origin === origin && !url.username && !url.password; } catch {}
    }
    // Unknown/malformed frame metadata cannot bypass the main-frame boundary.
    if (!allowed) details.preventDefault(); return allowed;
  };
}
export function validateConnectionAction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype || typeof input.action !== 'string') fail('INVALID_INPUT', 'Invalid connection request');
  const keys = { list: ['action'], connect: ['action', 'label', 'url', 'mode', 'token'], select: ['action', 'profileId'], credential: ['action', 'profileId', 'token', 'revision'], upgrade: ['action', 'profileId', 'revision'], remove: ['action', 'profileId', 'revision'], close: ['action'] }[input.action];
  if (!keys || Object.keys(input).some(key => !keys.includes(key)) || Object.getOwnPropertySymbols(input).length) fail('INVALID_INPUT', 'Unsupported connection request');
  if (input.profileId !== undefined && !/^(?:local-default|[a-f0-9]{32})$/.test(input.profileId)) fail('INVALID_INPUT', 'Invalid connection identity');
  if (['select', 'credential', 'upgrade', 'remove'].includes(input.action) && !input.profileId) fail('INVALID_INPUT', 'Provide a connection identity');
  if (['credential', 'upgrade', 'remove'].includes(input.action) && (!Number.isSafeInteger(input.revision) || input.revision < 0)) fail('INVALID_INPUT', 'Provide the current selection revision');
  if (input.action === 'connect' && (typeof input.label !== 'string' || input.label.length > 80 || typeof input.url !== 'string' || input.url.length > 2048 || !['instance', 'origin-compatibility'].includes(input.mode))) fail('INVALID_INPUT', 'Invalid connection fields');
  if (input.token !== undefined && (typeof input.token !== 'string' || input.token.length > 4096) || input.action === 'credential' && !input.token) fail('INVALID_INPUT', 'Invalid credential input');
  return input;
}
export async function dispatchConnectionAction(request, { store, open, close, changed }) {
  const input = validateConnectionAction(request);
  if (input.action === 'list') return store.list();
  if (input.action === 'close') { close(); return { closed: true }; }
  let result;
  if (input.action === 'connect') {
    const added = await store.addRemote({ label: input.label, url: input.url, mode: input.mode, ...(input.token ? { token: input.token } : {}) });
    await open(added.profile.id); result = await store.list();
  } else if (input.action === 'select') { await open(input.profileId); result = await store.list(); }
  else if (input.action === 'credential') { await store.saveCredential(input.profileId, input.token, { expectedRevision: input.revision }); await open(input.profileId, { forceReauthenticate: true }); result = await store.list(); }
  else if (input.action === 'upgrade') { await store.upgradeRemoteIdentity(input.profileId, { expectedRevision: input.revision }); await open(input.profileId); result = await store.list(); }
  else if (input.action === 'remove') { await store.removeProfile(input.profileId, { expectedRevision: input.revision }); result = await store.list(); }
  await changed(); return result;
}
function sessionCookie(response, origin) {
  const headers = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean), candidates = headers.filter(header => /^ink_os_session=/.test(header));
  if (candidates.length !== 1 || candidates[0].length > 16384 || /[\r\n\0]/.test(candidates[0])) fail('LOGIN_COOKIE_INVALID', 'Invalid desktop session cookie');
  const [pair, ...attributes] = candidates[0].split(';'), value = pair.slice('ink_os_session='.length), options = new Map(attributes.map(attribute => { const at = attribute.indexOf('='); return [attribute.slice(0, at < 0 ? undefined : at).trim().toLowerCase(), at < 0 ? '' : attribute.slice(at + 1).trim()]; }));
  if (!/^[A-Za-z0-9._~-]{1,8192}$/.test(value) || !options.has('httponly') || options.has('domain') && options.get('domain').toLowerCase() !== new URL(origin).hostname || options.has('path') && options.get('path') !== '/') fail('LOGIN_COOKIE_INVALID', 'Invalid desktop session cookie scope');
  const cookie = { url: origin, name: 'ink_os_session', value, path: '/', httpOnly: true, secure: new URL(origin).protocol === 'https:', sameSite: 'lax' };
  if (options.has('max-age')) { const seconds = options.get('max-age'); if (!/^\d+$/.test(seconds) || Number(seconds) < 1 || Number(seconds) > 31536000) fail('LOGIN_COOKIE_INVALID', 'Invalid desktop session lifetime'); cookie.expirationDate = Math.floor(Date.now() / 1000) + Number(seconds); }
  return cookie;
}
export async function authenticateConnection(client, cookies, { fetcher = fetch } = {}) {
  if (!client.token) return { authenticated: false };
  const selection = client.selection, origin = connectionOrigin(client.url, { local: selection.kind === 'local' });
  if (origin !== selection.url || client.binding?.origin !== origin || client.binding?.profileId !== selection.profileId || !client.authenticated || client.principal?.namespace !== 'os' || !client.principal.accountId) fail('UNVERIFIED_BINDING', 'Verify this account connection before signing in');
  let response;
  try { response = await fetcher(new URL('/login', origin).href, { method: 'POST', redirect: 'error', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: client.token }), signal: AbortSignal.timeout(10000) }); }
  catch { fail('LOGIN_REJECTED', 'Desktop sign-in transport failed'); }
  try {
    if (response.status !== 200 || response.redirected) fail('LOGIN_REJECTED', 'Desktop sign-in was rejected');
    if (response.url) { const url = new URL(response.url); if (url.origin !== origin || url.pathname !== '/login' || url.search || url.hash) fail('ORIGIN_MISMATCH', 'Desktop sign-in returned another endpoint'); }
    const cookie = sessionCookie(response, origin); await cookies.set(cookie); await cookies.flushStore?.(); return { authenticated: true };
  } finally { await response.body?.cancel().catch(() => {}); }
}

/** The caller owns actual Electron sessions/windows and the local host. This
 * controller has no stop/spawn API; switching cannot terminate local work. */
export class ConnectionController {
  constructor({ store, startLocal, createWindow, authenticate = async () => {}, onCommit = async () => {}, isQuitting = () => false }) { Object.assign(this, { store, startLocal, createWindow, authenticate, onCommit, isQuitting, currentWindow: null, currentSelection: null, tail: Promise.resolve() }); }
  open(profileId, options) { const task = this.tail.then(() => this.openNow(profileId, options)); this.tail = task.catch(() => {}); return task; }
  async openNow(profileId, { forceReauthenticate = false } = {}) {
    if (this.isQuitting()) fail('CONNECTION_FAILED', 'The application is quitting');
    const prepared = await this.store.prepareSelection(profileId);
    const sameWindow = this.currentWindow && !this.currentWindow.isDestroyed() && this.currentSelection?.profileId === prepared.profileId && this.currentSelection.partition === prepared.partition;
    if (sameWindow && prepared.sessionBound && !forceReauthenticate && this.currentSelection.credentialVersion === prepared.credentialVersion && (await this.store.list()).activeProfileId === prepared.profileId) { if (this.currentWindow.isMinimized?.()) this.currentWindow.restore(); this.currentWindow.show(); this.currentWindow.focus(); return this.currentSelection; }
    if (prepared.startLocal) await this.startLocal(prepared);
    const client = await this.store.getClient(prepared.profileId); let candidate;
    try {
      await this.authenticate(client);
      if (this.isQuitting()) fail('CONNECTION_FAILED', 'The application is quitting');
      if (sameWindow && this.currentSelection.partition === client.selection.partition && !this.currentWindow.isDestroyed()) {
        const selection = await this.store.activate(prepared.profileId, { expectedRevision: client.selection.revision, verifiedBinding: client.binding }); this.currentSelection = selection;
        if (this.currentWindow.isMinimized?.()) this.currentWindow.restore(); this.currentWindow.show(); this.currentWindow.focus(); try { await this.onCommit(selection); } catch {} return selection;
      }
      candidate = await this.createWindow(client.selection);
      await candidate.loadURL(client.url);
      if (candidate.isDestroyed() || this.isQuitting()) fail('CONNECTION_FAILED', 'Connection window closed before activation');
      const loadedURL = candidate.webContents?.getURL?.() ?? candidate.getURL?.();
      if (loadedURL && new URL(loadedURL).origin !== client.url) fail('ORIGIN_MISMATCH', 'The connection window left its verified origin');
      const selection = await this.store.activate(prepared.profileId, { expectedRevision: client.selection.revision, verifiedBinding: client.binding });
      const previous = this.currentWindow; this.currentWindow = candidate; this.currentSelection = selection;
      candidate.once?.('closed', () => { if (this.currentWindow === candidate) { this.currentWindow = null; this.currentSelection = null; } });
      candidate.show(); candidate.focus(); if (previous && previous !== candidate && !previous.isDestroyed()) previous.close();
      try { await this.onCommit(selection); } catch { /* A committed window stays usable if a menu refresh fails. */ } return selection;
    } catch (error) { if (candidate && candidate !== this.currentWindow && !candidate.isDestroyed()) candidate.destroy(); throw error; }
  }
}
