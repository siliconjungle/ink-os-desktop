import { open, mkdir, lstat, rename, link, unlink, chmod, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, dirname, parse, relative, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const FORMAT = 'ink-os-desktop-connections-v1', CLIENT = 'ink-os-desktop-client-v1', LOCAL = 'local-default';
const LIMITS = Object.freeze({ profiles: 64, generations: 64, profileDirectories: 128, registryBytes: 256 * 1024, clientBytes: 16 * 1024, responseBytes: 64 * 1024, requestMs: 10000 });
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
const hex = (value, length) => typeof value === 'string' && new RegExp('^[a-f0-9]{' + length + '}$').test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0') && !Object.getOwnPropertySymbols(value).length && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor);
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
const validID = id => id === LOCAL || hex(id, 32);
const validSession = (session, version) => exact(session, ['accountHash', 'generation']) && (session.accountHash === null || hex(session.accountHash, 64)) && Number.isInteger(session.generation) && session.generation >= 0 && session.generation < LIMITS.generations && session.generation <= version;
const accountHash = checked => checked.principal ? digest(JSON.stringify(['os', checked.principal.accountId])) : null;
const sameSession = (a, b) => a?.accountHash === b?.accountHash && a?.generation === b?.generation;
const partitionFor = (profile, generation = profile.session?.generation ?? profile.credentialVersion) => 'persist:ink-profile-' + profile.id + '-' + digest(JSON.stringify([profile.url, profile.mode, profile.expectedInstanceId, generation ?? null])).slice(0, 24);
const label = value => { if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) fail('INVALID_LABEL', 'Give this connection a short label'); return value.trim(); };
const tokenValue = value => { if (typeof value !== 'string' || value.length < 16 || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) fail('INVALID_CREDENTIAL', 'Provide a valid credential separately from the connection URL'); return value; };
const decode = bytes => { try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('INVALID_JSON', 'Connection data is not valid JSON'); } };

export function connectionOrigin(value, { local = false } = {}) {
  if (typeof value !== 'string' || !/^https?:\/\/[^/?#\s\\]+\/?$/i.test(value)) fail('INVALID_ORIGIN', 'Provide only the connection origin without a path or URL parameters');
  let url; try { url = new URL(value); } catch { fail('INVALID_ORIGIN', 'Provide an absolute connection origin'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (local ? url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port : url.protocol !== 'https:')) fail('INVALID_ORIGIN', local ? 'Local connections require a plain loopback HTTP origin' : 'Remote connections require a plain HTTPS origin without credentials or URL parameters');
  return url.origin;
}
async function responseJSON(response, limit) {
  if (response.status !== 200 || response.redirected) { await response.body?.cancel(); fail('CONNECTION_REJECTED', 'The connection endpoint rejected verification'); }
  const length = response.headers.get('content-length'); if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) { await response.body?.cancel(); fail('RESPONSE_BOUND', 'Connection verification response exceeds its bound'); }
  const chunks = []; let size = 0; const reader = response.body?.getReader();
  try { if (reader) while (true) { const part = await reader.read(); if (part.done) break; if (!(part.value instanceof Uint8Array)) fail('INVALID_RESPONSE', 'Connection verification requires raw JSON bytes'); size += part.value.length; if (size > limit) fail('RESPONSE_BOUND', 'Connection verification response exceeds its bound'); chunks.push(Buffer.from(part.value)); } }
  catch (error) { await reader?.cancel().catch(() => {}); if (error.code) throw error; fail('CONNECTION_UNAVAILABLE', 'The connection response could not be verified'); }
  finally { reader?.releaseLock(); }
  return decode(Buffer.concat(chunks, size));
}
function principal(value) {
  if (!plain(value) || value.namespace !== 'os' || typeof value.accountId !== 'string' || !value.accountId || value.accountId.length > 256 || /[\x00-\x20\x7f]/.test(value.accountId) || value.leaseId || value.appId || ['service', 'app', 'lease'].includes(value.type)) fail('OWNER_ACCOUNT_REQUIRED', 'Desktop sign-in requires an OS account credential');
  if (value.keyId != null || ['api-key', 'key'].includes(value.type)) {
    if (typeof value.keyId !== 'string' || !value.keyId || value.keyId.length > 256 || /[\x00-\x20\x7f]/.test(value.keyId) || !Array.isArray(value.scopes) || value.scopes.length > 256 || value.scopes.some(scope => typeof scope !== 'string' || scope.length > 128) || !value.scopes.includes('computer')) fail('DESKTOP_SCOPE_REQUIRED', 'An account API key needs the computer scope for desktop sign-in');
  }
  return { namespace: 'os', accountId: value.accountId };
}
async function probe({ url, expectedInstanceId = null, mode = 'instance', token, fetcher = fetch, local = false, limits = LIMITS }) {
  const origin = connectionOrigin(url, { local });
  if (!['instance', 'origin-compatibility'].includes(mode) || local && mode !== 'instance' || mode === 'origin-compatibility' && expectedInstanceId !== null || expectedInstanceId !== null && !hex(expectedInstanceId, 32)) fail('INVALID_BINDING', 'Choose an explicit valid instance or origin compatibility binding');
  if (token !== undefined) tokenValue(token);
  const get = async (path, credential) => {
    let response; try { response = await fetcher(new URL(path, origin).href, { method: 'GET', credentials: 'omit', redirect: 'error', headers: credential === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', Authorization: 'Bearer ' + credential }, signal: AbortSignal.timeout(limits.requestMs) }); }
    catch { fail('CONNECTION_UNAVAILABLE', 'The connection endpoint could not be reached securely'); }
    if (response.url) { let actual; try { actual = new URL(response.url); } catch { fail('INVALID_RESPONSE', 'Connection response has an invalid origin'); } if (actual.origin !== origin || actual.pathname !== path || actual.search || actual.hash) { await response.body?.cancel(); fail('ORIGIN_MISMATCH', 'Connection verification returned another endpoint'); } }
    return responseJSON(response, limits.responseBytes);
  };
  // Public health must succeed before any supplied credential can leave this process.
  const health = await get('/api/health');
  if (!plain(health) || health.ok !== true || health.engine !== 'Ink' || !(typeof health.version === 'string' && health.version.length > 0 && health.version.length <= 128 || Number.isSafeInteger(health.version) && health.version >= 0) || health.draining !== undefined && typeof health.draining !== 'boolean') fail('INVALID_HEALTH', 'The origin did not identify a supported Ink OS host');
  const advertised = Object.hasOwn(health, 'instanceId');
  if (advertised && !hex(health.instanceId, 32)) fail('INVALID_IDENTITY', 'The host advertised an invalid instance identity');
  if (mode === 'origin-compatibility' && advertised) fail('IDENTITY_UPGRADE_REQUIRED', 'This host now advertises an identity; explicitly pin it before using saved credentials');
  if (mode === 'instance' && (!advertised || expectedInstanceId !== null && health.instanceId !== expectedInstanceId)) fail('INSTANCE_MISMATCH', 'The host identity does not match this connection');
  if (health.draining === true) fail('HOST_DRAINING', 'The host is finishing work for maintenance');
  const account = token === undefined ? null : principal(await get('/api/v1/me', token));
  return freeze({ url: origin, mode, instanceId: advertised ? health.instanceId : null, identityVerified: mode === 'instance', authenticated: !!account, ...(account ? { principal: account } : {}) });
}
export function probeRemoteConnection(options) { return probe({ ...options, local: false, limits: LIMITS }); }

async function safePath(path, { create = false } = {}) {
  const absolute = resolve(path); let current = parse(absolute).root;
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) { current = join(current, part); let stat; try { stat = await lstat(current); } catch (error) { if (error.code !== 'ENOENT') throw error; if (!create) return absolute; await mkdir(current, { mode: 0o700 }); stat = await lstat(current); } if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH', 'Connection directories must not contain symlinks'); }
  return absolute;
}
async function readPrivate(path, limit) {
  await safePath(dirname(path)); let file;
  try { const leaf = await lstat(path); if (leaf.isSymbolicLink()) fail('UNSAFE_FILE', 'Connection files must not be symlinks'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { const stat = await file.stat(); if (!stat.isFile() || stat.size > limit || process.platform !== 'win32' && (stat.mode & 0o077)) fail('UNSAFE_FILE', 'Connection files must be bounded private regular files'); const bytes = Buffer.alloc(stat.size + 1); let n = 0; while (n < bytes.length) { const part = await file.read(bytes, n, bytes.length - n, n); if (!part.bytesRead) break; n += part.bytesRead; } if (n !== stat.size) fail('INPUT_CHANGED', 'Connection file changed during read'); return bytes.subarray(0, n); } finally { await file.close(); }
}
async function syncDirectory(path) { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }
async function publish(path, bytes, replace = false) {
  await safePath(dirname(path)); if (replace) await readPrivate(path, LIMITS.registryBytes);
  const temporary = path + '.' + randomBytes(12).toString('hex') + '.partial'; let file;
  try { file = await open(temporary, 'wx', 0o600); await file.writeFile(bytes); await file.sync(); await file.close(); file = null; if (replace) await rename(temporary, path); else { await link(temporary, path); await unlink(temporary); } await syncDirectory(dirname(path)); }
  finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function validOwner(value) { return exact(value, ['format', 'pid', 'platform', 'provider', 'hostHash', 'scopeHash', 'startHash']) && value.format === 'ink-os-process-receipt-v1' && Number.isInteger(value.pid) && value.pid > 0 && ['hostHash', 'scopeHash', 'startHash'].every(key => hex(value[key], 64)) && ['platform', 'provider'].every(key => typeof value[key] === 'string' && /^[a-z0-9-]{1,80}$/.test(value[key])); }

/** Metadata and immutable private client generations only. This module never
 * imports Electron, LocalInstance, native bootstrap code, or a child process. */
export class ConnectionStore {
  constructor({ directory, fetcher = fetch, captureOwner, checkOwner } = {}) {
    if (!directory) fail('MISSING_DIRECTORY', 'Provide the desktop profile directory');
    Object.assign(this, { directory: resolve(directory), fetcher, captureOwner, checkOwner, path: join(resolve(directory), 'connections.json'), tail: Promise.resolve(), ready: false, bindings: new WeakMap() });
  }
  serial(run) { const task = this.tail.then(run); this.tail = task.catch(() => {}); return task; }
  async lock(run) {
    const path = join(this.directory, 'connections.lock'); let captured;
    try { captured = await this.captureOwner?.({ directory: this.directory }); } catch {}
    const owner = captured?.verified && validOwner(captured.receipt) ? captured.receipt : null, bytes = Buffer.from(JSON.stringify({ format: 'ink-os-connections-lock-v1', owner })); let file;
    try { file = await open(path, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const old = await readPrivate(path, 4096); let saved; try { saved = decode(old); } catch { fail('CONNECTIONS_LOCKED', 'Connection metadata has an ambiguous lock owner'); }
      if (saved?.format !== 'ink-os-connections-lock-v1' || !validOwner(saved.owner) || typeof this.checkOwner !== 'function') fail('CONNECTIONS_LOCKED', 'Connection metadata has no verified lock owner');
      const checked = await this.checkOwner(saved.owner, { directory: this.directory }); if (!checked?.verified || !['gone', 'different-process'].includes(checked.state)) fail('CONNECTIONS_LOCKED', 'Connection metadata has a live, foreign or unverified owner');
      const claim = path + '.' + digest(old) + '.claim'; let claimed = false;
      try {
        try { await link(path, claim); claimed = true; } catch { fail('CONNECTIONS_LOCKED', 'Connection lock recovery is already claimed'); }
        const current = await readPrivate(path, 4096), linked = await readPrivate(claim, 4096), a = await lstat(path), b = await lstat(claim);
        if (!current?.equals(old) || !linked?.equals(old) || a.dev !== b.dev || a.ino !== b.ino) fail('CONNECTIONS_LOCKED', 'Connection lock changed during recovery');
        const again = await this.checkOwner(saved.owner, { directory: this.directory }); if (!again?.verified || !['gone', 'different-process'].includes(again.state)) fail('CONNECTIONS_LOCKED', 'Connection lock owner could not be confirmed gone');
        file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW || 0)); const stat = await file.stat(); if (stat.dev !== b.dev || stat.ino !== b.ino) fail('CONNECTIONS_LOCKED', 'Connection lock inode changed'); await file.truncate(0); await file.writeFile(bytes); await file.sync();
      } catch (failure) { await file?.close(); file = null; throw failure; } finally { if (claimed) await unlink(claim); }
    }
    try { if ((await file.stat()).size === 0) { await file.writeFile(bytes); await file.sync(); } await syncDirectory(this.directory); return await run(); }
    finally { await file.close(); await unlink(path); await syncDirectory(this.directory); }
  }
  validate(state) {
    if (!exact(state, ['format', 'revision', 'activeProfileId', 'profiles']) || state.format !== FORMAT || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.profiles) || !state.profiles.length || state.profiles.length > LIMITS.profiles) fail('INVALID_STORE', 'Connection registry is invalid or exceeds its bounds');
    const ids = new Set(); let local = 0;
    for (const profile of state.profiles) {
      if (!plain(profile) || !validID(profile.id) || ids.has(profile.id) || label(profile.label) !== profile.label) fail('INVALID_STORE', 'Connection profile identity is invalid'); ids.add(profile.id);
      if (profile.kind === 'local') { if (!exact(profile, ['id', 'kind', 'label', 'instance']) || profile.id !== LOCAL || profile.instance !== 'default') fail('INVALID_STORE', 'The default local profile is invalid'); local++; }
      else if (profile.kind === 'remote') { if (!exact(profile, ['id', 'kind', 'label', 'url', 'mode', 'expectedInstanceId', 'credentialVersion', ...(Object.hasOwn(profile, 'session') ? ['session'] : [])]) || !hex(profile.id, 32) || connectionOrigin(profile.url) !== profile.url || !['instance', 'origin-compatibility'].includes(profile.mode) || profile.mode === 'instance' && !hex(profile.expectedInstanceId, 32) || profile.mode === 'origin-compatibility' && profile.expectedInstanceId !== null || !Number.isInteger(profile.credentialVersion) || profile.credentialVersion < 0 || profile.credentialVersion >= LIMITS.generations || Object.hasOwn(profile, 'session') && !validSession(profile.session, profile.credentialVersion)) fail('INVALID_STORE', 'Remote connection binding is invalid'); }
      else fail('INVALID_STORE', 'Unsupported connection kind');
    }
    if (local !== 1 || !ids.has(state.activeProfileId)) fail('INVALID_STORE', 'Connection registry has no selected profile or local default'); return state;
  }
  async state() { const bytes = await readPrivate(this.path, LIMITS.registryBytes); if (!bytes) fail('MISSING_STORE', 'Open the connection store first'); return this.validate(decode(bytes)); }
  async persist(state) { this.validate(state); const bytes = Buffer.from(JSON.stringify(state)); if (bytes.length > LIMITS.registryBytes) fail('STORE_BOUND', 'Connection registry exceeds its byte bound'); await publish(this.path, bytes, true); }
  async open() {
    await safePath(this.directory, { create: true }); await chmod(this.directory, 0o700); await safePath(join(this.directory, 'connections'), { create: true }); await chmod(join(this.directory, 'connections'), 0o700);
    if (!await readPrivate(this.path, LIMITS.registryBytes)) await this.serial(() => this.lock(async () => { if (!await readPrivate(this.path, LIMITS.registryBytes)) await publish(this.path, Buffer.from(JSON.stringify({ format: FORMAT, revision: 0, activeProfileId: LOCAL, profiles: [{ id: LOCAL, kind: 'local', label: 'Local', instance: 'default' }] }))); }));
    await this.state(); this.ready = true; return this;
  }
  async list() { const state = await this.state(); return freeze({ revision: state.revision, activeProfileId: state.activeProfileId, profiles: state.profiles.map(profile => ({ ...profile, active: profile.id === state.activeProfileId })) }); }
  find(state, id) { if (!validID(id)) fail('INVALID_PROFILE', 'Provide an existing profile identity'); const profile = state.profiles.find(profile => profile.id === id); if (!profile) fail('PROFILE_NOT_FOUND', 'Connection profile was not found'); return profile; }
  async get(id) { const state = await this.state(); return freeze({ revision: state.revision, profile: { ...this.find(state, id) } }); }
  configPath(profile, version = profile.credentialVersion) { return profile.kind === 'local' ? join(this.directory, 'instances', 'default', 'client.json') : join(this.directory, 'connections', profile.id, 'client-' + version + '.json'); }
  async client(profile) {
    const path = this.configPath(profile), raw = await readPrivate(path, LIMITS.clientBytes); if (!raw) { if (profile.kind === 'local') fail('LOCAL_START_REQUIRED', 'Start or attach the selected local instance before authenticating'); fail('MISSING_CLIENT', 'The selected connection client configuration is missing'); }
    const client = decode(raw); if (!plain(client)) fail('CLIENT_MISMATCH', 'Private client configuration is invalid');
    if (profile.kind === 'remote') { const keys = ['format', 'profileId', 'kind', 'url', 'mode', 'expectedInstanceId', 'credentialVersion', ...(Object.hasOwn(profile, 'session') ? ['session'] : []), ...(Object.hasOwn(client, 'token') ? ['token'] : [])]; if (!exact(client, keys) || client.format !== CLIENT || client.profileId !== profile.id || client.kind !== 'remote' || client.url !== profile.url || client.mode !== profile.mode || client.expectedInstanceId !== profile.expectedInstanceId || client.credentialVersion !== profile.credentialVersion || profile.session && (!validSession(client.session, client.credentialVersion) || !sameSession(client.session, profile.session) || (client.session.accountHash === null) !== !Object.hasOwn(client, 'token'))) fail('CLIENT_MISMATCH', 'Private client configuration differs from the selected profile'); }
    else {
      const identityBytes = await readPrivate(join(this.directory, 'instances', 'default', 'instance.json'), LIMITS.clientBytes); if (!identityBytes) fail('LOCAL_START_REQUIRED', 'Local instance identity is unavailable'); const identity = decode(identityBytes);
      if (!plain(identity) || !hex(client.instanceId, 32) || identity.id !== client.instanceId || identity.adminToken !== client.token || connectionOrigin(client.url, { local: true }) !== client.url) fail('CLIENT_MISMATCH', 'Local client and private instance identity disagree');
    }
    if (Object.hasOwn(client, 'token')) tokenValue(client.token);
    return { client, path, rawSHA256: digest(raw) };
  }
  context(state, profile, client) {
    const url = profile.kind === 'remote' ? profile.url : client?.url || null, expectedInstanceId = profile.kind === 'remote' ? profile.expectedInstanceId : client?.instanceId || null, mode = profile.kind === 'remote' ? profile.mode : 'instance';
    return freeze({ revision: state.revision, profileId: profile.id, kind: profile.kind, label: profile.label, url, mode, expectedInstanceId, credentialVersion: profile.kind === 'remote' ? profile.credentialVersion : null, sessionBound: profile.kind === 'local' || !!profile.session, partition: url ? partitionFor({ ...profile, url, mode, expectedInstanceId }) : null, clientConfigPath: this.configPath(profile), instanceDirectory: profile.kind === 'local' ? join(this.directory, 'instances', 'default') : null, startLocal: profile.kind === 'local' });
  }
  async prepareSelection(id) {
    const state = await this.state(), profile = this.find(state, id || state.activeProfileId); let client;
    if (profile.kind === 'local') { try { ({ client } = await this.client(profile)); } catch (error) { if (error.code !== 'LOCAL_START_REQUIRED') throw error; } }
    return this.context(state, profile, client);
  }
  activeSelection() { return this.prepareSelection(); }
  async resolveCLI() { return (await this.getClient()).selection; }
  async getClient(id) {
    let state = await this.state(), profile = this.find(state, id || state.activeProfileId), loaded = await this.client(profile); const expectedInstanceId = profile.kind === 'remote' ? profile.expectedInstanceId : loaded.client.instanceId;
    const checked = await probe({ url: loaded.client.url, expectedInstanceId, mode: profile.kind === 'remote' ? profile.mode : 'instance', token: loaded.client.token, local: profile.kind === 'local', fetcher: this.fetcher });
    if (profile.kind === 'remote') {
      if (profile.session && profile.session.accountHash !== accountHash(checked)) fail('SESSION_ACCOUNT_MISMATCH', 'The verified account differs from this browser session; explicitly update the credential');
      if (!profile.session) ({ state, profile, loaded } = await this.bindLegacySession(state, profile, loaded, checked));
    }
    const selection = this.context(state, profile, loaded.client), binding = freeze({ profileId: profile.id, kind: profile.kind, origin: checked.url, mode: checked.mode, expectedInstanceId, instanceId: checked.instanceId, identityVerified: checked.identityVerified, authenticated: checked.authenticated, credentialVersion: selection.credentialVersion });
    this.bindings.set(binding, { profileSHA256: digest(JSON.stringify(profile)), clientSHA256: loaded.rawSHA256, revision: state.revision });
    return freeze({ url: checked.url, ...(loaded.client.token ? { token: loaded.client.token } : {}), instanceId: checked.instanceId, identityVerified: checked.identityVerified, authenticated: checked.authenticated, ...(checked.principal ? { principal: checked.principal } : {}), clientConfigPath: loaded.path, selection, binding });
  }
  cas(state, expectedRevision) { if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== state.revision) fail('REVISION_CONFLICT', 'The selected connection changed; reload its current revision'); }
  async bindLegacySession(snapshot, profile, loaded, checked) {
    return this.serial(() => this.lock(async () => {
      const state = await this.state(); this.cas(state, snapshot.revision); const current = this.find(state, profile.id), now = await this.client(current);
      if (digest(JSON.stringify(current)) !== digest(JSON.stringify(profile)) || now.rawSHA256 !== loaded.rawSHA256) fail('REVISION_CONFLICT', 'The legacy connection changed during account verification');
      const saved = await this.writeClient({ ...current, session: { accountHash: accountHash(checked), generation: current.credentialVersion } }, now.client.token, current.credentialVersion + 1);
      state.profiles = state.profiles.map(row => row.id === saved.id ? saved : row); state.revision++; await this.persist(state);
      return { state, profile: saved, loaded: await this.client(saved) };
    }));
  }
  async activate(id, { expectedRevision, verifiedBinding } = {}) {
    const snapshot = await this.state(); this.cas(snapshot, expectedRevision); const profile = this.find(snapshot, id), proof = this.bindings.get(verifiedBinding);
    if (!proof || proof.revision !== snapshot.revision || proof.profileSHA256 !== digest(JSON.stringify(profile)) || verifiedBinding.profileId !== id || verifiedBinding.kind !== profile.kind) fail('UNVERIFIED_BINDING', 'Activate only a freshly verified binding for this exact profile');
    const loaded = await this.client(profile), context = this.context(snapshot, profile, loaded.client);
    if (proof.clientSHA256 !== loaded.rawSHA256 || verifiedBinding.origin !== context.url || verifiedBinding.mode !== context.mode || verifiedBinding.expectedInstanceId !== context.expectedInstanceId || verifiedBinding.credentialVersion !== context.credentialVersion) fail('UNVERIFIED_BINDING', 'The verified connection binding no longer matches its client configuration');
    await probe({ url: context.url, expectedInstanceId: context.expectedInstanceId, mode: context.mode, local: profile.kind === 'local', fetcher: this.fetcher });
    return this.serial(() => this.lock(async () => { const state = await this.state(); this.cas(state, expectedRevision); const current = this.find(state, id), now = await this.client(current); if (digest(JSON.stringify(current)) !== proof.profileSHA256 || now.rawSHA256 !== proof.clientSHA256) fail('UNVERIFIED_BINDING', 'The connection changed before activation'); if (state.activeProfileId !== id) { state.activeProfileId = id; state.revision++; await this.persist(state); } return this.context(state, current, now.client); }));
  }
  async writeClient(profile, token, start = profile.credentialVersion) {
    const directory = join(this.directory, 'connections', profile.id); await safePath(directory, { create: true }); await chmod(directory, 0o700);
    for (let version = start; version < LIMITS.generations; version++) {
      const next = { ...profile, credentialVersion: version }, client = { format: CLIENT, profileId: profile.id, kind: 'remote', url: profile.url, mode: profile.mode, expectedInstanceId: profile.expectedInstanceId, credentialVersion: version, ...(profile.session ? { session: profile.session } : {}), ...(token === undefined ? {} : { token }) }, bytes = Buffer.from(JSON.stringify(client)), path = this.configPath(next), existing = await readPrivate(path, LIMITS.clientBytes);
      if (bytes.length > LIMITS.clientBytes) fail('CLIENT_BOUND', 'Private client configuration exceeds its bound');
      if (existing) { if (existing.equals(bytes)) return next; continue; }
      await publish(path, bytes); return next;
    }
    fail('GENERATION_BOUND', 'Private client generation limit reached');
  }
  async addRemote({ label: name, url, mode = 'instance', expectedInstanceId = null, token } = {}) {
    name = label(name); if (token !== undefined) { tokenValue(token); if (name.includes(token)) fail('INVALID_LABEL', 'Connection labels must not contain credentials'); }
    const checked = await probe({ url, expectedInstanceId, mode, token, fetcher: this.fetcher });
    return this.serial(() => this.lock(async () => { const state = await this.state(); if (state.profiles.length >= LIMITS.profiles || (await readdir(join(this.directory, 'connections'))).length >= LIMITS.profileDirectories) fail('PROFILE_BOUND', 'Connection profile retention limit reached'); const profile = { id: randomBytes(16).toString('hex'), kind: 'remote', label: name, url: checked.url, mode, expectedInstanceId: checked.instanceId, credentialVersion: 0, session: { accountHash: accountHash(checked), generation: 0 } }, saved = await this.writeClient(profile, token); state.profiles.push(saved); state.revision++; await this.persist(state); return freeze({ revision: state.revision, profile: { ...saved } }); }));
  }
  async saveCredential(id, token, { expectedRevision } = {}) { return this.updateRemote(id, { token, expectedRevision }); }
  async upgradeRemoteIdentity(id, { expectedInstanceId = null, token, expectedRevision } = {}) { return this.updateRemote(id, { token, expectedInstanceId, expectedRevision, upgrade: true }); }
  async updateRemote(id, { token, expectedInstanceId, expectedRevision, upgrade = false }) {
    const snapshot = await this.state(), profile = this.find(snapshot, id); if (profile.kind !== 'remote') fail('INVALID_PROFILE', 'Local credentials are owned by their local instance');
    if (expectedRevision === undefined) expectedRevision = snapshot.revision; this.cas(snapshot, expectedRevision);
    const previous = await this.client(profile); if (upgrade && profile.mode !== 'origin-compatibility') fail('INVALID_BINDING', 'Only explicit legacy connections require identity upgrade');
    if (token === undefined) { if (!upgrade) fail('INVALID_CREDENTIAL', 'Provide the replacement credential explicitly'); token = previous.client.token; }
    if (token !== undefined) { tokenValue(token); if (profile.label.includes(token)) fail('INVALID_LABEL', 'Connection labels must not contain credentials'); }
    const checked = await probe({ url: profile.url, mode: upgrade ? 'instance' : profile.mode, expectedInstanceId: upgrade ? expectedInstanceId : profile.expectedInstanceId, token, fetcher: this.fetcher });
    let previousSession = profile.session;
    if (!previousSession && !upgrade) { try { const old = await probe({ url: profile.url, mode: profile.mode, expectedInstanceId: profile.expectedInstanceId, token: previous.client.token, fetcher: this.fetcher }); previousSession = { accountHash: accountHash(old), generation: profile.credentialVersion }; } catch { /* An unverified historical account never grants cache reuse. */ } }
    const session = { accountHash: accountHash(checked), generation: !upgrade && previousSession && previousSession.accountHash === accountHash(checked) ? previousSession.generation : profile.credentialVersion + 1 };
    return this.serial(() => this.lock(async () => { const state = await this.state(); this.cas(state, expectedRevision); const current = this.find(state, id), now = await this.client(current); if (digest(JSON.stringify(current)) !== digest(JSON.stringify(profile)) || now.rawSHA256 !== previous.rawSHA256) fail('REVISION_CONFLICT', 'Connection profile changed during verification'); if (!upgrade && profile.session && token === previous.client.token && sameSession(profile.session, session)) return freeze({ revision: state.revision, profile: { ...current } }); const saved = await this.writeClient({ ...current, mode: checked.mode, expectedInstanceId: checked.instanceId, session }, token, current.credentialVersion + 1); state.profiles = state.profiles.map(row => row.id === id ? saved : row); state.revision++; await this.persist(state); return freeze({ revision: state.revision, profile: { ...saved } }); }));
  }
  async historicalClient(profile, version) {
    if (profile.kind !== 'remote' || !Number.isInteger(version) || version < 0 || version >= LIMITS.generations) fail('INVALID_PROFILE', 'Provide a retained remote client generation');
    const raw = await readPrivate(this.configPath(profile, version), LIMITS.clientBytes); if (!raw) return null;
    const client = decode(raw), keys = ['format', 'profileId', 'kind', 'url', 'mode', 'expectedInstanceId', 'credentialVersion', ...(Object.hasOwn(client || {}, 'session') ? ['session'] : []), ...(Object.hasOwn(client || {}, 'token') ? ['token'] : [])];
    if (!exact(client, keys) || client.format !== CLIENT || client.profileId !== profile.id || client.kind !== 'remote' || client.credentialVersion !== version || connectionOrigin(client.url) !== client.url || !['instance', 'origin-compatibility'].includes(client.mode) || (client.mode === 'instance' ? !hex(client.expectedInstanceId, 32) : client.expectedInstanceId !== null) || Object.hasOwn(client, 'session') && (!validSession(client.session, version) || (client.session.accountHash === null) !== !Object.hasOwn(client, 'token'))) fail('CLIENT_MISMATCH', 'A retained client generation is malformed; its browser data was preserved');
    if (Object.hasOwn(client, 'token')) tokenValue(client.token);
    return { client, rawSHA256: digest(raw), profile: { id: profile.id, kind: 'remote', label: profile.label, url: client.url, mode: client.mode, expectedInstanceId: client.expectedInstanceId, credentialVersion: version, ...(client.session ? { session: client.session } : {}) } };
  }
  async retainedSessions(id) {
    const state = await this.state(), profile = this.find(state, id), sessions = [];
    if (profile.kind !== 'remote') fail('INVALID_PROFILE', 'Local browser state belongs to its local instance');
    for (let version = 0; version < LIMITS.generations; version++) {
      const retained = await this.historicalClient(profile, version); if (!retained) continue;
      sessions.push({ credentialVersion: version, partition: partitionFor(retained.profile), current: version === profile.credentialVersion, accountBound: !!retained.client.session, recovery: retained.client.session ? 'account-bound' : 'requires-old-and-current-account-verification' });
    }
    return freeze({ revision: state.revision, profileId: id, sessions });
  }
  async recoverLegacySession(id, { credentialVersion, expectedRevision } = {}) {
    const snapshot = await this.state(); this.cas(snapshot, expectedRevision); const profile = this.find(snapshot, id), current = await this.client(profile), retained = await this.historicalClient(profile, credentialVersion);
    if (!profile.session || !retained || retained.client.session) fail('LEGACY_SESSION_UNVERIFIED', 'Select an unbound retained generation and verify the current connection first');
    if (retained.profile.url !== profile.url || retained.profile.mode !== profile.mode || retained.profile.expectedInstanceId !== profile.expectedInstanceId) fail('SESSION_BOUNDARY_MISMATCH', 'Historical browser data belongs to another host boundary and was preserved');
    const options = { url: profile.url, mode: profile.mode, expectedInstanceId: profile.expectedInstanceId, fetcher: this.fetcher };
    const checked = await probe({ ...options, token: current.client.token });
    if (accountHash(checked) === null || accountHash(checked) !== profile.session.accountHash) fail('LEGACY_SESSION_UNVERIFIED', 'The current account cannot prove ownership of historical browser data');
    let old; try { old = await probe({ ...options, token: retained.client.token }); } catch { fail('LEGACY_SESSION_UNVERIFIED', 'The historical credential cannot verify its account; its browser data was preserved'); }
    if (accountHash(old) === null || accountHash(old) !== accountHash(checked)) fail('LEGACY_SESSION_UNVERIFIED', 'The historical account differs or is unknown; its browser data was preserved');
    return this.serial(() => this.lock(async () => {
      const state = await this.state(); this.cas(state, expectedRevision); const now = this.find(state, id), loaded = await this.client(now), oldNow = await this.historicalClient(now, credentialVersion);
      if (digest(JSON.stringify(now)) !== digest(JSON.stringify(profile)) || loaded.rawSHA256 !== current.rawSHA256 || oldNow?.rawSHA256 !== retained.rawSHA256) fail('REVISION_CONFLICT', 'The retained connection changed during recovery');
      const saved = await this.writeClient({ ...now, session: { accountHash: accountHash(checked), generation: credentialVersion } }, loaded.client.token, now.credentialVersion + 1);
      state.profiles = state.profiles.map(row => row.id === id ? saved : row); state.revision++; await this.persist(state); return freeze({ revision: state.revision, profile: { ...saved } });
    }));
  }
  async removeProfile(id, { expectedRevision } = {}) {
    return this.serial(() => this.lock(async () => { const state = await this.state(); this.cas(state, expectedRevision); const profile = this.find(state, id); if (profile.kind === 'local' || state.activeProfileId === id) fail('PROFILE_IN_USE', 'Switch away from a remote profile before removing it'); state.profiles = state.profiles.filter(row => row.id !== id); state.revision++; await this.persist(state); return freeze({ removed: true, revision: state.revision, retainedClientConfigs: true }); }));
  }
}
