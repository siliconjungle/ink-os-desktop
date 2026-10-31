import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm, readdir, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ConnectionStore, connectionOrigin, probeRemoteConnection } from '../src/connections.mjs';

const host = 'https://host.invalid', other = 'https://other.invalid', legacy = 'https://legacy.invalid', instance = '1'.repeat(32), otherInstance = '2'.repeat(32), token = 'fixture-owner-credential-123456789';
const hash = value => createHash('sha256').update(value).digest('hex');
function ownerReceipt(pid = process.pid) { return { format: 'ink-os-process-receipt-v1', pid, platform: 'fixture', provider: 'fixture-start-v1', hostHash: hash('fixture-host'), scopeHash: hash('fixture-scope'), startHash: hash('fixture-start-' + pid) }; }
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ink-connections-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const hosts = new Map([[host, { instanceId: instance }], [other, { instanceId: otherInstance }], [legacy, {}]]), calls = [], ownership = { state: 'unverified', verified: false }, checks = []; let hook = async () => undefined;
  const fetcher = async (url, options) => {
    const u = new URL(url); calls.push({ url, method: options.method, authorization: options.headers.Authorization });
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    const intercepted = await hook(u, options); if (intercepted !== undefined) return intercepted;
    const h = hosts.get(u.origin); assert.ok(h, 'Only explicit fixture origins may be contacted');
    if (u.pathname === '/api/health') { assert.equal(options.headers.Authorization, undefined); return Response.json({ ok: true, engine: 'Ink', version: 12, ...h }); }
    assert.equal(u.pathname, '/api/v1/me'); assert.ok(options.headers.Authorization?.startsWith('Bearer ')); return Response.json(h.principal || { namespace: 'os', accountId: 'fixture-owner' });
  };
  const options = { directory, fetcher, captureOwner: async () => ({ verified: true, receipt: ownerReceipt() }), checkOwner: async (receipt, context) => { checks.push({ receipt, context }); return { ...ownership }; } };
  const store = await new ConnectionStore(options).open();
  return { directory, store, hosts, calls, ownership, checks, options, hook: fn => { hook = fn; } };
}
async function add(f, options = {}) { return f.store.addRemote({ label: 'Remote', url: host, token, ...options }); }
async function select(f, profileId) { const client = await f.store.getClient(profileId); return f.store.activate(profileId, { expectedRevision: client.selection.revision, verifiedBinding: client.binding }); }
async function local(f, { url = 'http://127.0.0.1:4318', instanceId = instance, credential = token } = {}) {
  const path = join(f.directory, 'instances', 'default'); await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(join(path, 'client.json'), JSON.stringify({ url, token: credential, instanceId, hostPid: 1234 }), { mode: 0o600 }); await writeFile(join(path, 'instance.json'), JSON.stringify({ id: instanceId, adminToken: credential }), { mode: 0o600 }); f.hosts.set(url, { instanceId }); return path;
}

test('a new store defaults to local without probing, creating a local instance or bootstrapping tools', async t => {
  const f = await fixture(t), list = await f.store.list(), context = await f.store.activeSelection(); assert.equal(list.activeProfileId, 'local-default'); assert.equal(list.profiles.length, 1); assert.equal(context.kind, 'local'); assert.equal(context.startLocal, true); assert.equal(context.url, null); assert.equal(context.partition, null); assert.equal(f.calls.length, 0);
  assert.deepEqual((await readdir(f.directory)).sort(), ['connections', 'connections.json']); await assert.rejects(f.store.getClient(), { code: 'LOCAL_START_REQUIRED' });
  const source = await readFile(new URL('../src/connections.mjs', import.meta.url), 'utf8'); assert.equal(/^import.*(?:electron|local-instance|native-toolchain|child_process)/m.test(source), false);
});

test('strict profile probes identity before owner credential, privately restarts and shares one GUI/CLI active selection', async t => {
  const f = await fixture(t), added = await add(f); assert.equal(added.profile.expectedInstanceId, instance); assert.equal(added.profile.mode, 'instance'); assert.equal((await f.store.list()).activeProfileId, 'local-default');
  assert.deepEqual(f.calls.slice(0, 2).map(call => [new URL(call.url).pathname, call.authorization]), [['/api/health', undefined], ['/api/v1/me', 'Bearer ' + token]]);
  const context = await select(f, added.profile.id); assert.equal(context.startLocal, false); assert.equal(context.instanceDirectory, null); assert.equal(context.url, host);
  const listed = JSON.stringify(await f.store.list()), registry = await readFile(join(f.directory, 'connections.json'), 'utf8'); assert.ok(!listed.includes(token)); assert.ok(!registry.includes(token)); assert.ok(!context.partition.includes(token)); assert.ok(!context.partition.includes('host.invalid'));
  assert.equal((await stat(context.clientConfigPath)).mode & 0o777, 0o600); assert.equal((await stat(join(f.directory, 'connections.json'))).mode & 0o777, 0o600);
  const reopened = await new ConnectionStore(f.options).open(), gui = await reopened.activeSelection(), cli = await reopened.resolveCLI(); assert.deepEqual(gui, cli); assert.equal(gui.profileId, added.profile.id); assert.equal((await reopened.getClient()).token, token);
});

test('identity mismatch, redirects and response-origin changes never receive a saved credential', async t => {
  const f = await fixture(t), added = await add(f); f.calls.length = 0; f.hosts.get(host).instanceId = otherInstance;
  await assert.rejects(f.store.getClient(added.profile.id), { code: 'INSTANCE_MISMATCH' }); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].authorization, undefined);
  f.hosts.get(host).instanceId = instance;
  for (const response of [new Response(null, { status: 302, headers: { Location: other } }), (() => { const r = Response.json({ ok: true, engine: 'Ink', version: 'fixture', instanceId: instance }); Object.defineProperty(r, 'url', { value: other + '/api/health' }); return r; })()]) {
    f.calls.length = 0; f.hook(u => u.pathname === '/api/health' ? response : undefined); await assert.rejects(f.store.getClient(added.profile.id)); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].authorization, undefined);
  }
});

test('legacy compatibility is explicit, has no invented identity and upgrades only through an explicit new binding', async t => {
  const f = await fixture(t); await assert.rejects(add(f, { url: legacy }), { code: 'INSTANCE_MISMATCH' });
  const added = await add(f, { url: legacy, mode: 'origin-compatibility' }); assert.equal(added.profile.expectedInstanceId, null); let client = await f.store.getClient(added.profile.id); assert.equal(client.identityVerified, false); assert.equal(client.instanceId, null); assert.equal(client.binding.mode, 'origin-compatibility'); await f.store.activate(added.profile.id, { expectedRevision: client.selection.revision, verifiedBinding: client.binding });
  const previous = await f.store.activeSelection(); f.hosts.get(legacy).instanceId = otherInstance; f.calls.length = 0; await assert.rejects(f.store.getClient(added.profile.id), { code: 'IDENTITY_UPGRADE_REQUIRED' }); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].authorization, undefined);
  const upgraded = await f.store.upgradeRemoteIdentity(added.profile.id, { expectedInstanceId: otherInstance, expectedRevision: (await f.store.list()).revision }); assert.equal(upgraded.profile.expectedInstanceId, otherInstance); assert.equal(upgraded.profile.mode, 'instance'); client = await f.store.getClient(added.profile.id); assert.equal(client.identityVerified, true); assert.notEqual(client.selection.partition, previous.partition); assert.notEqual(client.clientConfigPath, previous.clientConfigPath);
});

test('service/app principals cannot sign into the desktop account profile', async t => {
  for (const account of [{ namespace: 'a'.repeat(32), accountId: 'fixture' }, { namespace: 'os' }, { namespace: 'os', accountId: 'fixture', type: 'service', keyId: 'service-key', scopes: ['computer'] }, { namespace: 'os', accountId: 'fixture', leaseId: 'lease' }, { namespace: 'os', accountId: 'fixture', type: 'app' }]) {
    const f = await fixture(t); f.hosts.get(host).principal = account; await assert.rejects(add(f), { code: 'OWNER_ACCOUNT_REQUIRED' }); assert.equal((await f.store.list()).profiles.length, 1); assert.deepEqual(await readdir(join(f.directory, 'connections')), []);
  }
});

test('normal OS member account keys with computer scope are allowed; lower-scope account keys are refused for GUI profiles', async t => {
  const f = await fixture(t); f.hosts.get(host).principal = { namespace: 'os', accountId: 'fixture-member', admin: false, keyId: 'member-key', scopes: ['computer', 'world:read', 'world:write'] };
  const added = await add(f), client = await f.store.getClient(added.profile.id); assert.equal(client.authenticated, true); assert.equal(client.principal.accountId, 'fixture-member'); assert.equal((await select(f, added.profile.id)).profileId, added.profile.id);
  const g = await fixture(t); g.hosts.get(host).principal = { namespace: 'os', accountId: 'fixture-member', admin: false, keyId: 'read-only-key', scopes: ['world:read'] }; await assert.rejects(add(g), { code: 'DESKTOP_SCOPE_REQUIRED' }); assert.equal((await g.store.list()).profiles.length, 1);
});

test('captured CLI configs isolate credential generations while same-account rotation preserves the browser partition', async t => {
  const f = await fixture(t), first = await add(f), second = await add(f, { label: 'Other', url: other }); await select(f, first.profile.id);
  const captured = await f.store.resolveCLI(), before = await readFile(captured.clientConfigPath); await select(f, second.profile.id); assert.equal((await f.store.resolveCLI()).profileId, second.profile.id); assert.equal(captured.profileId, first.profile.id); assert.deepEqual(await readFile(captured.clientConfigPath), before);
  assert.notEqual((await f.store.prepareSelection(first.profile.id)).partition, (await f.store.prepareSelection(second.profile.id)).partition);
  const replacement = token + '-new'; await f.store.saveCredential(first.profile.id, replacement, { expectedRevision: (await f.store.list()).revision });
  const fresh = await f.store.getClient(first.profile.id); assert.equal(fresh.token, replacement); assert.notEqual(fresh.clientConfigPath, captured.clientConfigPath); assert.equal(fresh.selection.partition, captured.partition); assert.equal(JSON.parse(before).token, token); assert.deepEqual(await readFile(captured.clientConfigPath), before);
});

test('account changes and anonymous-to-account transitions isolate browser data; unexpected principal drift is refused', async t => {
  const f = await fixture(t), added = await add(f), original = await f.store.prepareSelection(added.profile.id);
  f.hosts.get(host).principal = { namespace: 'os', accountId: 'different-account' };
  await assert.rejects(f.store.getClient(added.profile.id), { code: 'SESSION_ACCOUNT_MISMATCH' });
  await f.store.saveCredential(added.profile.id, token + '-different-account'); const changed = await f.store.getClient(added.profile.id); assert.notEqual(changed.selection.partition, original.partition);
  assert.equal((await f.store.get(added.profile.id)).profile.session.accountHash, hash(JSON.stringify(['os', 'different-account'])));
  const anonymous = await add(f, { label: 'Anonymous', token: undefined }), before = await f.store.getClient(anonymous.profile.id); assert.equal(before.authenticated, false); assert.equal(anonymous.profile.session.accountHash, null);
  await f.store.saveCredential(anonymous.profile.id, token); const authenticated = await f.store.getClient(anonymous.profile.id); assert.equal(authenticated.authenticated, true); assert.notEqual(authenticated.selection.partition, before.selection.partition);
  const reopened = await new ConnectionStore(f.options).open(); assert.equal((await reopened.getClient(added.profile.id)).selection.partition, changed.selection.partition);
});

async function legacyGenerations(f) {
  const added = await add(f); await f.store.saveCredential(added.profile.id, token + '-rotated');
  const registryPath = join(f.directory, 'connections.json'), state = JSON.parse(await readFile(registryPath)); delete state.profiles.find(profile => profile.id === added.profile.id).session;
  await writeFile(registryPath, JSON.stringify(state)); const original = [];
  for (let version = 0; version < 2; version++) { const path = join(f.directory, 'connections', added.profile.id, 'client-' + version + '.json'), client = JSON.parse(await readFile(path)); delete client.session; const bytes = Buffer.from(JSON.stringify(client)); await writeFile(path, bytes); original.push({ path, bytes }); }
  return { id: added.profile.id, original };
}

test('verified legacy migration preserves the exact current old partition and every immutable historical client', async t => {
  const f = await fixture(t), legacy = await legacyGenerations(f), previous = await f.store.prepareSelection(legacy.id), revision = (await f.store.list()).revision;
  assert.equal(previous.sessionBound, false); const client = await f.store.getClient(legacy.id); assert.equal(client.selection.sessionBound, true); assert.equal(client.selection.partition, previous.partition); assert.equal(client.selection.credentialVersion, 2); assert.equal(client.selection.revision, revision + 1);
  for (const input of legacy.original) assert.deepEqual(await readFile(input.path), input.bytes);
  const retained = await f.store.retainedSessions(legacy.id); assert.deepEqual(retained.sessions.map(session => session.accountBound), [false, false, true]); assert.equal(retained.sessions[1].partition, previous.partition); assert.equal(retained.sessions[2].partition, previous.partition); assert.ok(!JSON.stringify(retained).includes(token));
  const older = retained.sessions[0].partition; await f.store.recoverLegacySession(legacy.id, { credentialVersion: 0, expectedRevision: retained.revision }); assert.equal((await f.store.getClient(legacy.id)).selection.partition, older);
  for (const input of legacy.original) assert.deepEqual(await readFile(input.path), input.bytes);
});

test('revoked or different-account historical credentials cannot adopt old caches and all bytes remain retained', async t => {
  for (const historical of ['revoked', 'other-account']) {
    const f = await fixture(t), legacy = await legacyGenerations(f); await f.store.getClient(legacy.id); const before = await f.store.prepareSelection(legacy.id), registry = await readFile(join(f.directory, 'connections.json'));
    f.hook((url, options) => url.pathname === '/api/v1/me' && options.headers.Authorization === 'Bearer ' + token ? historical === 'revoked' ? Response.json({}, { status: 401 }) : Response.json({ namespace: 'os', accountId: 'historical-other-account' }) : undefined);
    await assert.rejects(f.store.recoverLegacySession(legacy.id, { credentialVersion: 0, expectedRevision: before.revision }), { code: 'LEGACY_SESSION_UNVERIFIED' }); assert.deepEqual(await readFile(join(f.directory, 'connections.json')), registry); assert.equal((await f.store.prepareSelection(legacy.id)).partition, before.partition);
    for (const input of legacy.original) assert.deepEqual(await readFile(input.path), input.bytes);
  }
});

test('rotating an unbound revoked legacy credential does not infer ownership of its previous partition', async t => {
  const f = await fixture(t), legacy = await legacyGenerations(f), before = await f.store.prepareSelection(legacy.id);
  f.hook((url, options) => url.pathname === '/api/v1/me' && options.headers.Authorization === 'Bearer ' + token + '-rotated' ? Response.json({}, { status: 401 }) : undefined);
  await f.store.saveCredential(legacy.id, token + '-new'); assert.notEqual((await f.store.getClient(legacy.id)).selection.partition, before.partition);
  for (const input of legacy.original) assert.deepEqual(await readFile(input.path), input.bytes);
});

test('malformed session bindings and mismatched client bindings are rejected before credential transport', async t => {
  for (const session of [{ accountHash: null, generation: 64 }, { accountHash: 'x'.repeat(64), generation: 0 }, { accountHash: null, generation: -1 }, { accountHash: null, generation: 0, extra: true }]) {
    const f = await fixture(t), added = await add(f), path = join(f.directory, 'connections.json'), state = JSON.parse(await readFile(path)); state.profiles.find(profile => profile.id === added.profile.id).session = session; await writeFile(path, JSON.stringify(state)); f.calls.length = 0; await assert.rejects(f.store.getClient(added.profile.id), { code: 'INVALID_STORE' }); assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t), added = await add(f), context = await f.store.prepareSelection(added.profile.id), client = JSON.parse(await readFile(context.clientConfigPath)); client.session.accountHash = null; await writeFile(context.clientConfigPath, JSON.stringify(client)); f.calls.length = 0; await assert.rejects(f.store.getClient(added.profile.id), { code: 'CLIENT_MISMATCH' }); assert.equal(f.calls.length, 0);
});

test('activation requires the exact verifier-issued binding and CAS revision; failed GUI preparation leaves selection unchanged', async t => {
  const f = await fixture(t), first = await add(f), client = await f.store.getClient(first.profile.id);
  await assert.rejects(f.store.activate(first.profile.id, { expectedRevision: client.selection.revision, verifiedBinding: { ...client.binding } }), { code: 'UNVERIFIED_BINDING' }); assert.equal((await f.store.list()).activeProfileId, 'local-default');
  await add(f, { url: other, label: 'Other' }); await assert.rejects(f.store.activate(first.profile.id, { expectedRevision: client.selection.revision, verifiedBinding: client.binding }), { code: 'REVISION_CONFLICT' }); assert.equal((await f.store.list()).activeProfileId, 'local-default');
  const fresh = await f.store.getClient(first.profile.id); f.hosts.get(host).instanceId = otherInstance; f.calls.length = 0; await assert.rejects(f.store.activate(first.profile.id, { expectedRevision: fresh.selection.revision, verifiedBinding: fresh.binding }), { code: 'INSTANCE_MISMATCH' }); assert.equal((await f.store.list()).activeProfileId, 'local-default'); assert.ok(f.calls.every(call => call.authorization === undefined));
});

test('local identity and owner checks precede authentication; switching back never changes local data', async t => {
  const f = await fixture(t), localRoot = await local(f), original = await readFile(join(localRoot, 'instance.json')), client = await f.store.getClient(); assert.equal(client.instanceId, instance); assert.equal(client.selection.startLocal, true);
  const remote = await add(f); await select(f, remote.profile.id); await select(f, 'local-default'); assert.deepEqual(await readFile(join(localRoot, 'instance.json')), original); assert.equal((await f.store.resolveCLI()).kind, 'local');
  f.hosts.get('http://127.0.0.1:4318').instanceId = otherInstance; f.calls.length = 0; await assert.rejects(f.store.getClient(), { code: 'INSTANCE_MISMATCH' }); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].authorization, undefined);
});

test('URLs, health shape, body bounds and non-JSON errors fail before any credential request', async t => {
  const f = await fixture(t);
  for (const url of ['http://host.invalid', 'https://owner:secret@host.invalid', host + '/path', host + '/path/..', host + '/%2e%2e', host + '?token=secret', host + '?', host + '#secret', 'file:///tmp/host']) await assert.rejects(probeRemoteConnection({ url, token, fetcher: f.options.fetcher }), { code: 'INVALID_ORIGIN' }); assert.equal(f.calls.length, 0);
  assert.throws(() => connectionOrigin('http://127.0.0.1:4318?token=secret', { local: true }), { code: 'INVALID_ORIGIN' });
  for (const response of [Response.json({ ok: true, engine: 'Other', version: 'fixture' }), Response.json({ ok: true, engine: 'Ink', version: 'fixture', instanceId: 'invalid' }), new Response('not JSON'), new Response(Buffer.alloc(65537)), new Response('{}', { headers: { 'Content-Length': '999999' } })]) {
    f.calls.length = 0; f.hook(() => response); await assert.rejects(probeRemoteConnection({ url: host, token, fetcher: f.options.fetcher })); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].authorization, undefined);
  }
});

test('symlinked or insecure owned files and changed client origins are rejected before credential use', async t => {
  const f = await fixture(t), added = await add(f), context = await f.store.prepareSelection(added.profile.id), raw = await readFile(context.clientConfigPath); f.calls.length = 0;
  const changed = JSON.parse(raw); changed.url = other; await writeFile(context.clientConfigPath, JSON.stringify(changed)); await assert.rejects(f.store.getClient(added.profile.id), { code: 'CLIENT_MISMATCH' }); assert.equal(f.calls.length, 0);
  await rm(context.clientConfigPath); await symlink(join(f.directory, 'connections.json'), context.clientConfigPath); await assert.rejects(f.store.getClient(added.profile.id), { code: 'UNSAFE_FILE' }); assert.equal(f.calls.length, 0);
  await rm(context.clientConfigPath); await writeFile(context.clientConfigPath, raw, { mode: 0o644 }); if (process.platform !== 'win32') await assert.rejects(f.store.getClient(added.profile.id), { code: 'UNSAFE_FILE' });
  const g = await fixture(t), outside = await realpath(await mkdtemp(join(tmpdir(), 'ink-connections-outside-'))); t.after(() => rm(outside, { recursive: true, force: true })); await rm(join(g.directory, 'connections'), { recursive: true }); await symlink(outside, join(g.directory, 'connections')); await assert.rejects(new ConnectionStore(g.options).open(), { code: 'UNSAFE_PATH' });
});

test('lock recovery uses only verified owner-gone identity; live, foreign and unknown owners remain preserved', async t => {
  const f = await fixture(t), lockPath = join(f.directory, 'connections.lock'), oldOwner = ownerReceipt(process.pid + 10000), bytes = Buffer.from(JSON.stringify({ format: 'ink-os-connections-lock-v1', owner: oldOwner }));
  for (const result of [{ state: 'same-process', verified: true }, { state: 'foreign-scope', verified: true }, { state: 'unverified', verified: false }, { state: 'gone', verified: false }]) {
    Object.assign(f.ownership, result); await writeFile(lockPath, bytes, { mode: 0o600 }); await assert.rejects(add(f), { code: 'CONNECTIONS_LOCKED' }); assert.deepEqual(await readFile(lockPath), bytes);
  }
  for (const state of ['gone', 'different-process']) { Object.assign(f.ownership, { state, verified: true }); await writeFile(lockPath, bytes, { mode: 0o600 }); const added = await add(f); assert.ok(added.profile.id); }
  assert.ok(f.checks.length >= 4); assert.ok(f.checks.every(check => check.context.directory === f.directory)); assert.ok(!(await readdir(f.directory)).some(path => path.endsWith('.lock') || path.endsWith('.claim')));
  await writeFile(lockPath, JSON.stringify({ pid: process.pid + 10000 }), { mode: 0o600 }); await assert.rejects(add(f), { code: 'CONNECTIONS_LOCKED' });
});

test('removing an inactive remote profile preserves immutable captured configs and local instance bytes', async t => {
  const f = await fixture(t), added = await add(f), context = await f.store.prepareSelection(added.profile.id), raw = await readFile(context.clientConfigPath);
  const result = await f.store.removeProfile(added.profile.id, { expectedRevision: (await f.store.list()).revision }); assert.equal(result.removed, true); assert.equal(result.retainedClientConfigs, true); assert.deepEqual(await readFile(context.clientConfigPath), raw); assert.equal((await f.store.list()).activeProfileId, 'local-default'); await assert.rejects(f.store.removeProfile('local-default', { expectedRevision: result.revision }), { code: 'PROFILE_IN_USE' });
});

test('draining hosts and repeated stale-credential reuse fail before authentication; same-credential saves do not rotate contexts', async t => {
  const f = await fixture(t), added = await add(f), before = await f.store.prepareSelection(added.profile.id), revision = (await f.store.list()).revision;
  const unchanged = await f.store.saveCredential(added.profile.id, token, { expectedRevision: revision }); assert.equal(unchanged.revision, revision); assert.deepEqual(await f.store.prepareSelection(added.profile.id), before);
  f.hosts.get(host).draining = true; f.calls.length = 0; await assert.rejects(f.store.getClient(added.profile.id), { code: 'HOST_DRAINING' }); await assert.rejects(f.store.saveCredential(added.profile.id, token), { code: 'HOST_DRAINING' }); assert.ok(f.calls.every(call => call.authorization === undefined));
});

test('separate store instances enforce activation CAS and a failed credential publication preserves the captured generation', async t => {
  const f = await fixture(t), added = await add(f), second = await new ConnectionStore(f.options).open(), client = await second.getClient(added.profile.id);
  await add(f, { label: 'Other', url: other }); await assert.rejects(second.activate(added.profile.id, { expectedRevision: client.selection.revision, verifiedBinding: client.binding }), { code: 'REVISION_CONFLICT' });
  const captured = await f.store.prepareSelection(added.profile.id), raw = await readFile(captured.clientConfigPath), oldPersist = f.store.persist.bind(f.store); f.store.persist = async () => { throw Error('fixture persistence failure'); };
  await assert.rejects(f.store.saveCredential(added.profile.id, token + '-replacement')); assert.deepEqual(await f.store.prepareSelection(added.profile.id), captured); assert.deepEqual(await readFile(captured.clientConfigPath), raw);
  f.store.persist = oldPersist; const saved = await f.store.saveCredential(added.profile.id, token + '-replacement'); assert.equal(saved.profile.credentialVersion, 1); assert.equal((await f.store.getClient(added.profile.id)).token, token + '-replacement');
});
