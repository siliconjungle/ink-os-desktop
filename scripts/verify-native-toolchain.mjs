import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile, readFile, rm, lstat, statfs, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { NativeToolchain, nativeToolchainPlan, NATIVE_TOOLCHAIN_DEFAULT_RESERVE_BYTES, NATIVE_TOOLCHAIN_ESTIMATED_BYTES } from '../src/native-toolchain.mjs';

const GiB = 1024 ** 3, script = fileURLToPath(import.meta.url);
export const VERIFIER_DEFAULT_RESERVE_BYTES = 100 * GiB;
export const NATIVE_NOTICE_LIMITS = Object.freeze({ fileBytes: 128 * 1024 ** 2, totalBytes: 512 * 1024 ** 2, files: 2000 });
export const API_BOOTSTRAP_INSTALLER_SOURCE = `import {readFile,writeFile} from 'node:fs/promises';
const installer=await import(process.env.INK_VERIFY_BASE_INSTALLER_URL);
export const nativeToolchainPlan=installer.nativeToolchainPlan;
export class NativeToolchain extends installer.NativeToolchain {
 constructor(options){const reserveBytes=Number(process.env.INK_VERIFY_NATIVE_RESERVE_BYTES);if(!Number.isSafeInteger(reserveBytes)||reserveBytes<0)throw Error('Invalid verifier reserve');super({...options,reserveBytes});}
 async ensure(){const saved=JSON.parse(await readFile(process.env.INK_VERIFY_NATIVE_JOBS_PATH,'utf8'));const job=saved.jobs?.find(value=>value.status==='running'&&value.phase==='toolchain');if(saved.version!==1||!job||job.toolchain?.identity!==nativeToolchainPlan().identity||!['artifactId','compatibilityKey','sourceIdentity'].every(key=>/^[a-f0-9]{64}$/.test(job[key]))||!/^[a-f0-9]{32}$/.test(job.id))throw Error('Native job was not durable before bootstrap');await writeFile(process.env.INK_VERIFY_NATIVE_MARKER_PATH,JSON.stringify({queuedDurablyBeforeEnsure:true,jobId:job.id,artifactId:job.artifactId,compatibilityKey:job.compatibilityKey,sourceIdentity:job.sourceIdentity,toolchainIdentity:job.toolchain.identity,status:job.status,phase:job.phase}),{flag:'wx',mode:0o600,flush:true});return super.ensure();}
}
`;
const apiUnavailableInstallerSource = `const installer=await import(process.env.INK_VERIFY_BASE_INSTALLER_URL);export const nativeToolchainPlan=installer.nativeToolchainPlan;export class NativeToolchain {async inspect(){return {available:false,installable:false,code:'INK_TOOLCHAIN_APPLE_SDK'};}async ensure(){throw Error('Unexpected compiler bootstrap during cached execution');}}\n`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => Object.assign(Error(message), { code });
export const RUST_SMOKE_SOURCE = `fn main() {
    let sum: u64 = (1..=10).sum();
    assert_eq!(sum, 55);
    let value = String::from("Ink ✓");
    assert_eq!(value.chars().count(), 5);
    println!("{{\\\"ok\\\":true,\\\"sum\\\":{},\\\"unicode\\\":\\\"{}\\\"}}", sum, value);
}
`;
const cargoManifest = `[package]
name = "ink-managed-toolchain-proof"
version = "0.0.0"
edition = "2021"
[workspace]
[profile.release]
debug = 0
incremental = false
`;
const cargoLock = `version = 4
[[package]]
name = "ink-managed-toolchain-proof"
version = "0.0.0"
`;
const inkSource = 'module managed_proof; state Total:u32=0; fn scale(xs:List<u32>,factor:u32)->List<u32>{return xs.map(fn(x)=>x*factor);} change add(n:u32)->u32 reads(Total) writes(Total){Total=Total+n;return Total;} query total()->u32 reads(Total){return Total;}';

export function parseVerificationArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help') { options.help = true; continue; }
    if (flag === '--ephemeral-runner') { if (options.ephemeralRunner) throw fail('INK_VERIFY_ARGUMENT', 'Duplicate ephemeral-runner option.'); options.ephemeralRunner = true; continue; }
    if (flag === '--api-bootstrap') { if (options.apiBootstrap) throw fail('INK_VERIFY_ARGUMENT', 'Duplicate API bootstrap option.'); options.apiBootstrap = true; continue; }
    const key = { '--output': 'output', '--platform-dir': 'platformDirectory', '--reserve-gib': 'reserveGiB' }[flag];
    if (!key || options[key] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw fail('INK_VERIFY_ARGUMENT', 'Unknown, duplicate or incomplete verifier option.');
    options[key] = args[++index];
  }
  if (!options.help && !options.output) throw fail('INK_VERIFY_ARGUMENT', 'An explicit --output proof path is required.');
  if (!options.help && options.apiBootstrap && !options.platformDirectory) throw fail('INK_VERIFY_ARGUMENT', 'API bootstrap verification requires --platform-dir.');
  if (options.reserveGiB !== undefined) {
    if (!options.ephemeralRunner || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(options.reserveGiB)) throw fail('INK_VERIFY_ARGUMENT', 'Reserve overrides require --ephemeral-runner and a numeric --reserve-gib.');
    options.reserveGiB = Number(options.reserveGiB);
    if (!Number.isSafeInteger(options.reserveGiB * GiB) || options.reserveGiB > 100) throw fail('INK_VERIFY_ARGUMENT', 'Reserve override must be between zero and 100 GiB.');
  }
  return options;
}

async function fileHash(path) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}
async function freeBytes(path) { const value = await statfs(path); return value.bavail * value.bsize; }
const safeCode = error => /^[A-Z][A-Z0-9_]{0,80}$/.test(String(error?.code)) ? error.code : 'INK_VERIFY_FAILED';
export function hostFailureDiagnostic(text) {
  const bounded = String(text).slice(0, 16384), code = bounded.match(/\b(ERR_[A-Z0-9_]{1,60})\b/)?.[1];
  const packageName = bounded.match(/Cannot find package ['"]([^'"]+)['"]/)?.[1];
  const missingPackage = ['vite', 'ws', '@aws-sdk/client-s3'].includes(packageName) ? packageName : undefined;
  const category = /\bSyntaxError\b/.test(bounded) ? 'syntax-error' : undefined;
  return code || missingPackage || category ? { ...(code ? { code } : {}), ...(missingPackage ? { missingPackage } : {}), ...(category ? { category } : {}) } : undefined;
}
export function archiveFailureDiagnostic(error) {
  const component = ['rustc', 'cargo', 'rust-std'].includes(error?.archiveComponent) ? error.archiveComponent : undefined;
  const entry = typeof error?.archiveEntry === 'string' && error.archiveEntry.length <= 240 && !error.archiveEntry.startsWith('/') && !error.archiveEntry.includes('\\') && !error.archiveEntry.split('/').some(part => !part || part === '.' || part === '..') && /^[a-zA-Z0-9._+@/-]+$/.test(error.archiveEntry) ? error.archiveEntry : undefined;
  const reason = typeof error?.archiveReason === 'string' && /^[a-z0-9_-]{1,64}$/.test(error.archiveReason) ? error.archiveReason : undefined;
  return component || entry || reason ? { ...(component ? { component } : {}), ...(entry ? { entry } : {}), ...(reason ? { reason } : {}) } : undefined;
}
export function noticeFailureDiagnostic(error) {
  const entry = archiveFailureDiagnostic({ archiveEntry: error?.noticeEntry })?.entry;
  const kind = ['file', 'total', 'count', 'integrity'].includes(error?.noticeLimitKind) ? error.noticeLimitKind : undefined;
  if (!kind) return undefined;
  return { kind, ...(entry ? { entry } : {}), ...Object.fromEntries(['noticeBytes', 'noticeTotalBytes', 'noticeLimitBytes'].filter(key => Number.isSafeInteger(error[key]) && error[key] >= 0).map(key => [key, error[key]])) };
}

/** Stream every required regular distribution notice without loading a large aggregate
 *  COPYRIGHT.html into memory. Limits apply both before and during copying. */
export async function retainToolchainNotices({ prefix, inventory, directory, limits = NATIVE_NOTICE_LIMITS }) {
  if (!limits || Object.keys(limits).length !== 3 || Object.keys(NATIVE_NOTICE_LIMITS).some(key => !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > NATIVE_NOTICE_LIMITS[key])) throw fail('INK_VERIFY_LICENSE_LIMIT', 'Invalid notice evidence budget.');
  const records = []; let total = 0;
  const limited = (kind, entry, bytes, limit) => Object.assign(fail('INK_VERIFY_LICENSE_LIMIT', 'Distribution notice exceeds its evidence budget.'), { noticeLimitKind: kind, noticeEntry: entry, noticeBytes: bytes, noticeTotalBytes: total, noticeLimitBytes: limit });
  for (const entry of inventory.filter(item => item.link === undefined && /(?:license|copyright)/i.test(item.path))) {
    if (!archiveFailureDiagnostic({ archiveEntry: entry.path })?.entry) throw fail('INK_VERIFY_LICENSE_PATH', 'Invalid relative distribution notice path.');
    if (records.length >= limits.files) throw limited('count', entry.path, records.length + 1, limits.files);
    const source = join(prefix, entry.path), info = await lstat(source);
    if (!info.isFile()) throw fail('INK_VERIFY_LICENSE_PATH', 'Distribution notice must be a regular file.');
    if (info.size > limits.fileBytes) throw limited('file', entry.path, info.size, limits.fileBytes);
    if (total + info.size > limits.totalBytes) throw limited('total', entry.path, info.size, limits.totalBytes);
    const retainedFile = `${String(records.length + 1).padStart(4, '0')}-${hash(entry.path).slice(0, 16)}.txt`, destination = join(directory, retainedFile);
    const output = await open(destination, 'wx', 0o600), digest = createHash('sha256'); let bytes = 0, complete = false;
    try {
      for await (const part of createReadStream(source)) {
        bytes += part.length;
        if (bytes > limits.fileBytes) throw limited('file', entry.path, bytes, limits.fileBytes);
        if (total + bytes > limits.totalBytes) throw limited('total', entry.path, bytes, limits.totalBytes);
        digest.update(part); await output.writeFile(part);
      }
      const sha256 = digest.digest('hex');
      if (bytes !== info.size || sha256 !== entry.sha256) throw Object.assign(fail('INK_VERIFY_LICENSE_INTEGRITY', 'Distribution notice differs from the verified installation receipt.'), { noticeLimitKind: 'integrity', noticeEntry: entry.path, noticeBytes: bytes });
      total += bytes; records.push({ distributionPath: entry.path, retainedFile, sha256, bytes }); complete = true;
    } finally { await output.close(); if (!complete) await rm(destination, { force: true }); }
  }
  if (!records.length) throw fail('INK_VERIFY_LICENSE_MISSING', 'The distribution did not retain its required license notices.');
  return records;
}
function rustVersion(text) {
  const field = name => text.split('\n').find(line => line.startsWith(name + ': '))?.slice(name.length + 2).trim();
  const release = field('release'), host = field('host'), commitHash = field('commit-hash'), commitDate = field('commit-date'), llvm = field('LLVM version');
  if (!/^\d+\.\d+\.\d+$/.test(release || '') || !/^[a-z0-9_-]+$/.test(host || '') || !/^[a-f0-9]{40}$/.test(commitHash || '') || !/^\d{4}-\d{2}-\d{2}$/.test(commitDate || '') || !/^[0-9.]+$/.test(llvm || '')) throw fail('INK_VERIFY_VERSION', 'Unexpected rustc version response.');
  return { release, host, commitHash, commitDate, llvm };
}
function cargoVersion(text) {
  const match = /^cargo (\d+\.\d+\.\d+) \(([a-f0-9]+) (\d{4}-\d{2}-\d{2})\)\s*$/.exec(text);
  if (!match) throw fail('INK_VERIFY_VERSION', 'Unexpected Cargo version response.');
  return { release: match[1], commitHash: match[2], commitDate: match[3] };
}

// Bound captured output without killing any process. CI should set a job-level timeout.
// Every spawned command is awaited through close before its private inputs are retired.
async function command(executable, args, options, observations, role) {
  const started = Date.now();
  const child = spawn(executable, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const buffers = { stdout: [], stderr: [] }, counts = { stdout: 0, stderr: 0 }, digests = { stdout: createHash('sha256'), stderr: createHash('sha256') };
  for (const name of ['stdout', 'stderr']) child[name].on('data', bytes => {
    digests[name].update(bytes);
    counts[name] += bytes.length;
    if (counts[name] <= 1024 ** 2) buffers[name].push(bytes);
  });
  let launchError;
  child.on('error', error => { launchError = error; });
  const [code, signal] = await new Promise(resolve => child.once('close', (code, signal) => resolve([code, signal])));
  const stdout = Buffer.concat(buffers.stdout).toString('utf8'), stderr = Buffer.concat(buffers.stderr).toString('utf8');
  observations.push({ role, exitCode: code, signal: signal || null, durationMs: Date.now() - started, stdoutBytes: counts.stdout, stderrBytes: counts.stderr, stdoutSha256: digests.stdout.digest('hex'), stderrSha256: digests.stderr.digest('hex') });
  // A failed Cargo/platform operation may leave a descendant after its parent exits.
  // Probe only our command's separate process group; never signal it to stop.
  if (child.pid) {
    let active = true;
    try { process.kill(-child.pid, 0); } catch (error) { active = error.code !== 'ESRCH'; }
    if (active) throw Object.assign(fail('INK_VERIFY_PROCESS_DRAIN', 'An owned command still has active descendants. Preserve its generated inputs.'), { preserveProfile: true });
  }
  if (launchError) throw fail(safeCode(launchError), 'Verification command could not start.');
  if (code !== 0 || signal) throw fail('INK_VERIFY_COMMAND', 'Verification command failed.');
  if (counts.stdout > 1024 ** 2 || counts.stderr > 1024 ** 2) throw fail('INK_VERIFY_OUTPUT_LIMIT', 'Verification command exceeded its captured-output budget.');
  return { stdout, stderr };
}

async function inkWorker(platformDirectory, directory) {
  const [{ NativeInk }, compiler] = await Promise.all([
    import(pathToFileURL(join(platformDirectory, 'server/native-ink.mjs')).href),
    import(pathToFileURL(join(platformDirectory, 'server/ink-compiler.mjs')).href),
  ]);
  const native = new NativeInk(directory, { cargo: process.env.INK_NATIVE_CARGO, rustc: process.env.INK_NATIVE_RUSTC });
  assert.equal((await native.availability()).available, true);
  const artifact = await compiler.compileInk(inkSource);
  const javascript = await import('data:text/javascript;base64,' + Buffer.from(artifact.javascript).toString('base64'));
  const built = await native.build(inkSource, { namespace: 'managed-toolchain-proof' });
  assert.equal(built.cached, false);
  const values = [[1, 3, 7], 3];
  const scaled = await native.run(built.id, { namespace: 'managed-toolchain-proof', entry: 'scale', args: values });
  assert.deepEqual(scaled.output, javascript.callOwned('scale', values));
  const mutation = await native.run(built.id, { namespace: 'managed-toolchain-proof', entry: 'add', args: [9] });
  const state = javascript.createState();
  await state.restore(new Uint8Array(Buffer.from(mutation.snapshot, 'base64')));
  assert.equal(state.invoke('total', []).result, 9);
  state.invoke('add', [5]);
  const restored = await native.run(built.id, { namespace: 'managed-toolchain-proof', entry: 'total', args: [], snapshot: Buffer.from(await state.checkpoint()).toString('base64') });
  assert.equal(restored.output.result, 14);
  assert.equal((await native.build(inkSource, { namespace: 'managed-toolchain-proof' })).cached, true);
  const compilerInfo = await compiler.compilerInfo();
  return { status: 'passed', sourceSha256: hash(inkSource), javascriptSha256: hash(artifact.javascript), rustSha256: hash(artifact.rust), compilerSha256: compilerInfo.sha256,
    nativeModuleSha256: await fileHash(join(platformDirectory, 'server/native-ink.mjs')), nativeLockSha256: await fileHash(join(platformDirectory, 'server/native-runtime.lock')),
    observed: ['Compiled generated Rust using the managed toolchain.', 'Native and JavaScript list-function values matched.', 'Native state restored in JavaScript with value 9.', 'JavaScript state restored in native execution with value 14.', 'A repeat native build reused its verified artifact.'] };
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function apiRequest(port, path, { token, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method, agent: false, headers: { Connection: 'close', Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}) } }, response => {
      const chunks = []; let size = 0;
      response.on('data', part => { size += part.length; if (size > 8 * 1024 ** 2) request.destroy(fail('INK_VERIFY_HTTP_LIMIT', 'Owned API response exceeded its budget.')); else chunks.push(part); });
      response.once('error', reject);
      response.once('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode < 200 || response.statusCode >= 300) throw Object.assign(fail('INK_VERIFY_API_RESPONSE', 'Owned API request failed.'), { httpStatus: response.statusCode, responseSha256: hash(Buffer.concat(chunks)) });
          resolve(value);
        } catch (error) { error.httpStatus ??= response.statusCode; error.responseSha256 ??= hash(Buffer.concat(chunks)); error.code ??= 'INK_VERIFY_API_JSON'; reject(error); }
      });
    });
    request.once('error', reject); request.setTimeout(15000, () => request.destroy(fail('INK_VERIFY_HTTP_TIMEOUT', 'Owned API request timed out.'))); request.end(bytes);
  });
}

/** Cold-cache API proof. The wrapper is selected only by verifier-owned host environment;
 *  application inputs never select installer code, cache roots or reserve overrides. */
export async function apiBootstrapAcceptance({ platformDirectory, directory, ephemeralRunner = false, reserveGiB, installerModulePath = fileURLToPath(new URL('../src/native-toolchain.mjs', import.meta.url)), timeoutMs = 12 * 60 * 1000 }) {
  const reserveBytes = verificationReserveBytes({ ephemeralRunner, reserveGiB });
  if (!platformDirectory || !directory || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12 * 60 * 1000) throw fail('INK_VERIFY_ARGUMENT', 'Invalid API bootstrap verification inputs.');
  const cache = join(directory, 'cache'), data = join(directory, 'api-data'), marker = join(directory, 'api-bootstrap-marker.json'), installer = join(directory, 'api-installer.mjs'), unavailable = join(directory, 'api-unavailable-installer.mjs');
  const result = { status: 'failed', hosts: [], selectedReserveBytes: reserveBytes, wrapperSha256: hash(API_BOOTSTRAP_INSTALLER_SOURCE), sourceSha256: hash(inkSource) };
  let host, stage = 'cold-cache-check';
  const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  const stop = async () => {
    if (!host) return;
    const current = host; host = undefined;
    if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill('SIGTERM');
    const ended = await current.closed;
    if (ended.code !== 0 || ended.signal) throw fail('INK_VERIFY_API_HOST_EXIT', 'Owned API host did not drain cleanly.');
  };
  try {
    const expectedRelease = (await import(pathToFileURL(installerModulePath).href)).nativeToolchainPlan();
    if (await exists(cache)) throw fail('INK_VERIFY_API_CACHE_NOT_COLD', 'API bootstrap requires a new empty cache.');
    for (const path of ['api-home', 'api-tmp']) await mkdir(join(directory, path), { recursive: true, mode: 0o700 });
    await writeFile(installer, API_BOOTSTRAP_INSTALLER_SOURCE, { flag: 'wx', mode: 0o600 });
    await writeFile(unavailable, apiUnavailableInstallerSource, { flag: 'wx', mode: 0o600 });
    const start = async (modulePath, role) => {
      const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
      const env = { NODE_ENV: 'production', PORT: String(port), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: join(directory, 'api-home'), TMPDIR: join(directory, 'api-tmp'), INK_OS_DATA_DIR: data, INK_OS_BIND: '127.0.0.1', INK_OS_ORIGIN: origin, INK_OS_NATIVE: '1',
        INK_OS_MANAGED_NATIVE_MODULE: modulePath, INK_OS_MANAGED_NATIVE_DIRECTORY: cache, INK_VERIFY_BASE_INSTALLER_URL: pathToFileURL(installerModulePath).href, INK_VERIFY_NATIVE_RESERVE_BYTES: String(reserveBytes), INK_VERIFY_NATIVE_JOBS_PATH: join(data, 'native-jobs.json'), INK_VERIFY_NATIVE_MARKER_PATH: marker };
      if (process.env.DEVELOPER_DIR) env.DEVELOPER_DIR = process.env.DEVELOPER_DIR;
      const child = spawn(process.execPath, [join(platformDirectory, 'scripts/start.mjs')], { cwd: platformDirectory, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const digest = { stdout: createHash('sha256'), stderr: createHash('sha256') }, counts = { stdout: 0, stderr: 0 };
      let diagnosticText = '', lastProbe;
      for (const name of ['stdout', 'stderr']) child[name].on('data', part => { counts[name] += part.length; digest[name].update(part); if (name === 'stderr' && diagnosticText.length < 16384) diagnosticText += part.toString('utf8').slice(0, 16384 - diagnosticText.length); });
      let spawnError; child.once('error', error => { spawnError = error; });
      const closed = new Promise(resolve => child.once('close', (code, signal) => { result.hosts.push({ role, exitCode: code, signal: signal || null, stdoutBytes: counts.stdout, stderrBytes: counts.stderr, stdoutSha256: digest.stdout.digest('hex'), stderrSha256: digest.stderr.digest('hex'), ...(hostFailureDiagnostic(diagnosticText) ? { diagnostic: hostFailureDiagnostic(diagnosticText) } : {}), ...(lastProbe ? { lastProbe } : {}) }); resolve({ code, signal }); }));
      host = { child, closed };
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (spawnError || child.exitCode !== null || child.signalCode !== null) throw Object.assign(fail('INK_VERIFY_API_HOST_START', 'Owned API host did not start.'), { lastProbe });
        try {
          const health = await apiRequest(port, '/api/health');
          lastProbe = { httpStatus: 200 };
          const client = JSON.parse(await readFile(join(data, 'client.json'), 'utf8'));
          if (health.ok === true && health.instanceId === client.instanceId && client.url === origin) return { port, token: client.token, call: (path, method = 'GET', body) => apiRequest(port, '/api/v1/' + path, { token: client.token, method, body }) };
          lastProbe.code = 'INK_VERIFY_HEALTH_IDENTITY_MISMATCH';
        } catch (error) { lastProbe = { code: safeCode(error), ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}) }; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw Object.assign(fail('INK_VERIFY_API_HOST_TIMEOUT', 'Owned API host readiness timed out.'), { lastProbe });
    };
    stage = 'ordinary-startup-and-status';
    let api = await start(installer, 'api-host-cold-cache');
    assert.deepEqual(await api.call('apps'), []);
    const initialStatus = await api.call('native');
    assert.equal(initialStatus.available, false); assert.equal(initialStatus.installable, true); assert.equal(initialStatus.managed, true);
    assert.equal(await exists(cache), false); assert.equal(await exists(marker), false);
    result.startupAndStatusDidNotInstall = true;
    stage = 'ink-source-release';
    const [compiler, contracts] = await Promise.all([import(pathToFileURL(join(platformDirectory, 'server/ink-compiler.mjs')).href), import(pathToFileURL(join(platformDirectory, 'shared/ink-app.mjs')).href)]);
    const compiled = await compiler.compileInk(inkSource), spec = { version: 1, source: 'server/proof.ink', exports: ['scale', 'add', 'total'] };
    const commands = contracts.inkCommands(spec, contracts.inkEntries(compiled.manifest));
    result.compilerSha256 = (await compiler.compilerInfo()).sha256;
    const app = await api.call('apps', 'POST', { slug: 'managed-api-proof', title: 'Managed native API proof', capabilities: ['code.execute'] });
    const release = await api.call(`apps/${app.id}/releases`, 'POST', { entry: 'index.html', ink: spec, commands, capabilities: ['code.execute'], files: [{ path: 'index.html', base64: Buffer.from('<!doctype html><title>Managed native proof</title>').toString('base64') }, { path: 'server/proof.ink', base64: Buffer.from(inkSource).toString('base64') }] });
    await api.call(`apps/${app.id}/releases/${release.id}/publish`, 'POST', {});
    const invoke = (entry, input, backend) => api.call(`apps/${app.id}/ink/run`, 'POST', { entry, input, ...(backend ? { backend } : {}) });
    assert.equal((await invoke('add', '[2]', 'javascript')).valueWire, '2');
    const scaledJS = await invoke('scale', '[[1,3,7],3]', 'javascript');
    assert.equal(await exists(cache), false); assert.equal(await exists(marker), false);
    stage = 'explicit-api-native-build';
    const accepted = await api.call(`apps/${app.id}/native/build`, 'POST', { releaseId: release.id });
    const deadline = Date.now() + timeoutMs; let job = accepted;
    while (['queued', 'running', 'recovering'].includes(job.status) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 250)); job = await api.call(`apps/${app.id}/native/${accepted.id}`); }
    if (job.status !== 'succeeded') throw fail(typeof job.errorCode === 'string' ? safeCode({ code: job.errorCode }) : 'INK_VERIFY_API_BUILD', 'The explicit API native build did not succeed.');
    const durable = JSON.parse(await readFile(marker, 'utf8'));
    assert.equal(durable.queuedDurablyBeforeEnsure, true); assert.equal(durable.jobId, accepted.id); assert.equal(durable.artifactId, job.artifactId); assert.equal(durable.toolchainIdentity, expectedRelease.identity);
    assert.equal(job.sourceIdentity, compiled.manifest.core_sha256);
    result.durableBootstrap = durable;
    stage = 'api-cross-engine-parity';
    assert.equal((await invoke('scale', '[[1,3,7],3]', 'native')).valueWire, scaledJS.valueWire);
    assert.equal((await invoke('add', '[3]', 'native')).valueWire, '5');
    assert.equal((await invoke('add', '[4]', 'javascript')).valueWire, '9');
    await stop();
    stage = 'cached-artifact-without-build-toolchain';
    api = await start(unavailable, 'api-host-build-toolchain-unavailable');
    const unavailableStatus = await api.call('native');
    assert.equal(unavailableStatus.available, false); assert.equal(unavailableStatus.installable, false); assert.equal(unavailableStatus.buildAvailable, false);
    assert.equal((await api.call(`apps/${app.id}/native/build`, 'POST', { releaseId: release.id })).id, accepted.id);
    assert.equal((await invoke('total', '[]', 'native')).valueWire, '9');
    const automatic = await invoke('total', '[]'); assert.equal(automatic.backend, 'native'); assert.equal(automatic.valueWire, '9');
    result.inkParity = { status: 'passed', mode: 'api', sourceSha256: hash(inkSource), sourceIdentity: job.sourceIdentity, listValueWire: scaledJS.valueWire, stateValues: ['2', '5', '9'], cachedNativeValueWireAfterRestart: '9', observed: ['JavaScript remained usable before installation.', 'Explicit API build durably recorded the job before the real managed installer ran.', 'Native and JavaScript list values matched.', 'Native and JavaScript changes shared persistent state.', 'Verified cached native execution survived restart with build-toolchain availability disabled.'] };
    result.nativeModuleSha256 = await fileHash(join(platformDirectory, 'server/native-ink.mjs'));
    result.nativeJobsSha256 = await fileHash(join(platformDirectory, 'server/native-jobs.mjs'));
    result.managedAdapterSha256 = await fileHash(join(platformDirectory, 'server/managed-native.mjs'));
    result.status = 'passed';
  } catch (error) { result.failure = { stage, code: safeCode(error), ...(error.lastProbe ? { lastProbe: error.lastProbe } : {}), ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}), ...(/^[a-f0-9]{64}$/.test(error.responseSha256 || '') ? { responseSha256: error.responseSha256 } : {}), diagnosticSha256: hash(String(error.message || error)) }; }
  finally { try { await stop(); } catch (error) { result.status = 'failed'; result.drainFailure = { code: safeCode(error) }; } }
  return result;
}

export function verificationReserveBytes({ ephemeralRunner = false, reserveGiB } = {}) {
  if (typeof ephemeralRunner !== 'boolean') throw fail('INK_VERIFY_ARGUMENT', 'The ephemeral-runner declaration must be an explicit boolean.');
  if (reserveGiB !== undefined && (!ephemeralRunner || !Number.isFinite(reserveGiB) || reserveGiB < 0 || reserveGiB > 100 || !Number.isSafeInteger(reserveGiB * GiB))) throw fail('INK_VERIFY_ARGUMENT', 'Reserve overrides are restricted to explicit ephemeral-runner verification.');
  return reserveGiB === undefined ? VERIFIER_DEFAULT_RESERVE_BYTES : reserveGiB * GiB;
}

export async function verifyNativeToolchain({ output, platformDirectory, ephemeralRunner = false, reserveGiB, apiBootstrap = false } = {}) {
  if (!output) throw fail('INK_VERIFY_ARGUMENT', 'An explicit output proof path is required.');
  const selectedReserveBytes = verificationReserveBytes({ ephemeralRunner, reserveGiB });
  if (typeof apiBootstrap !== 'boolean' || apiBootstrap && !platformDirectory) throw fail('INK_VERIFY_ARGUMENT', 'API bootstrap verification requires an explicit platform directory.');
  const outputPath = resolve(output), noticesDirectory = outputPath + '.licenses';
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  try { await lstat(outputPath); throw fail('INK_VERIFY_OUTPUT_EXISTS', 'The proof output already exists; choose a fresh output path.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // mkdir is also an exclusive claim on this output destination: do not reuse or delete earlier evidence.
  await mkdir(noticesDirectory, { mode: 0o700 });
  const proof = { format: 'ink-os-managed-native-toolchain-proof-v1', status: 'failed', platform: process.platform, architecture: process.arch, startedAt: new Date().toISOString(), release: nativeToolchainPlan(),
    reserve: { productDefaultBytes: NATIVE_TOOLCHAIN_DEFAULT_RESERVE_BYTES, verificationDefaultBytes: VERIFIER_DEFAULT_RESERVE_BYTES, selectedBytes: selectedReserveBytes, estimatedInstallationBytes: NATIVE_TOOLCHAIN_ESTIMATED_BYTES, explicitEphemeralOverride: reserveGiB !== undefined, declaredEphemeralRunner: ephemeralRunner },
    inputs: { verifierSha256: await fileHash(script), installerSha256: await fileHash(fileURLToPath(new URL('../src/native-toolchain.mjs', import.meta.url))), rustSourceSha256: hash(RUST_SMOKE_SOURCE), cargoManifestSha256: hash(cargoManifest), cargoLockSha256: hash(cargoLock) },
    commands: [], licenses: [], licenseArtifacts: '<proof-file>.licenses/<retainedFile>', licenseRetentionLimits: NATIVE_NOTICE_LIMITS, apiBootstrap: { status: apiBootstrap ? 'pending' : 'not-requested' }, inkParity: { status: platformDirectory ? 'pending' : 'not-requested' },
    limits: ['Apple clang and the macOS SDK are preinstalled runner prerequisites; they are not installed or redistributed by this verifier.', 'This proof covers the observed runner architecture, not other hosts.', 'Rust smoke builds have no registry dependencies; optional Ink parity fetches its locked runtime crates.', 'The proof does not establish notarized desktop distribution or a graphical application launch.'] };
  const ownedPaths = ['cache', 'home', 'smoke', 'tmp', 'native', 'api-data', 'api-home', 'api-tmp', 'api-installer.mjs', 'api-unavailable-installer.mjs', 'api-bootstrap-marker.json'];
  let profile, preserveProfile = false, stage = 'host-check';
  try {
    if (!proof.release.supported) throw fail('INK_TOOLCHAIN_UNSUPPORTED', 'This verifier requires a supported macOS runner.');
    profile = await mkdtemp(join(tmpdir(), 'ink-managed-toolchain-proof-'));
    const retentionPath = join(profile, 'storage-retention.json');
    await writeFile(retentionPath, JSON.stringify({ keep: Object.fromEntries([...ownedPaths, 'storage-retention.json'].map(path => [path, 'Active required managed native verification input/output; preserve until owned processes finish.'])), safe_to_remove: {} }), { mode: 0o600 });
    proof.freeBytesBefore = await freeBytes(profile);
    // Workspace verification deliberately overrides the product's smaller customer reserve.
    const toolchain = new NativeToolchain({ directory: join(profile, 'cache'), reserveBytes: selectedReserveBytes });
    stage = 'official-download-and-extraction';
    let managed;
    if (apiBootstrap) {
      stage = 'api-cold-cache-bootstrap';
      const worker = await command(process.execPath, [script, '--internal-api-worker', resolve(platformDirectory), profile, JSON.stringify({ ephemeralRunner, ...(reserveGiB === undefined ? {} : { reserveGiB }) })], { cwd: profile, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}) } }, proof.commands, 'api-cold-cache-bootstrap');
      proof.apiBootstrap = JSON.parse(worker.stdout);
      if (proof.apiBootstrap.status !== 'passed') throw fail('INK_VERIFY_API_BOOTSTRAP', 'Cold-cache API bootstrap acceptance failed.');
      proof.inkParity = proof.apiBootstrap.inkParity;
      managed = await toolchain.inspect(); assert.equal(managed.available, true);
    } else managed = await toolchain.ensure();
    proof.archiveIntegrityAndExtraction = 'passed';
    proof.receiptSha256 = await fileHash(join(managed.prefix, 'receipt.json'));
    const receipt = JSON.parse(await readFile(join(managed.prefix, 'receipt.json'), 'utf8'));
    stage = 'license-retention';
    proof.licenses = await retainToolchainNotices({ prefix: managed.prefix, inventory: receipt.inventory, directory: noticesDirectory });
    const home = join(profile, 'home'), temporary = join(profile, 'tmp'), smoke = join(profile, 'smoke');
    for (const path of [home, temporary, join(smoke, 'src')]) await mkdir(path, { recursive: true, mode: 0o700 });
    const env = { ...managed.runtimeEnvironment, PATH: `${join(managed.prefix, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: temporary,
      CARGO_TARGET_DIR: join(smoke, 'target'), CARGO_INCREMENTAL: '0', CARGO_PROFILE_RELEASE_DEBUG: '0', CARGO_TERM_COLOR: 'never',
      CARGO_ENCODED_RUSTFLAGS: `--remap-path-prefix=${profile}=/ink-toolchain-proof` };
    if (process.env.DEVELOPER_DIR) env.DEVELOPER_DIR = process.env.DEVELOPER_DIR;
    const run = (executable, args, role, cwd = smoke) => command(executable, args, { cwd, env }, proof.commands, role);
    stage = 'installed-tool-execution';
    proof.rustc = rustVersion((await run(managed.rustc, ['-vV'], 'installed-rustc-version')).stdout);
    proof.cargo = cargoVersion((await run(managed.cargo, ['--version'], 'installed-cargo-version')).stdout);
    assert.equal(proof.rustc.release, managed.version); assert.equal(proof.rustc.host, managed.target); assert.equal(proof.cargo.release, managed.version);
    const clang = (await run(env.CC, ['--version'], 'apple-clang-version')).stdout.match(/(?:Apple )?clang version ([0-9.]+)/);
    if (!clang) throw fail('INK_VERIFY_VERSION', 'Unexpected Apple clang version response.');
    const sdk = (await run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-version'], 'apple-sdk-version')).stdout.trim();
    if (!/^[0-9.]+$/.test(sdk)) throw fail('INK_VERIFY_VERSION', 'Unexpected macOS SDK version response.');
    proof.applePrerequisites = { clangVersion: clang[1], sdkVersion: sdk, libSystemSha256: await fileHash(join(env.SDKROOT, 'usr/lib/libSystem.tbd')) };
    await writeFile(join(smoke, 'Cargo.toml'), cargoManifest, { mode: 0o600 });
    await writeFile(join(smoke, 'Cargo.lock'), cargoLock, { mode: 0o600 });
    await writeFile(join(smoke, 'src/main.rs'), RUST_SMOKE_SOURCE, { mode: 0o600 });
    stage = 'rust-smoke-build';
    await run(managed.cargo, ['build', '--locked', '--offline', '--release', '--manifest-path', join(smoke, 'Cargo.toml')], 'installed-cargo-build');
    stage = 'rust-smoke-execution';
    const executable = join(smoke, 'target/release/ink-managed-toolchain-proof');
    const result = JSON.parse((await run(executable, [], 'compiled-rust-smoke')).stdout);
    assert.deepEqual(result, { ok: true, sum: 55, unicode: 'Ink ✓' });
    proof.rustSmoke = { status: 'passed', executableSha256: await fileHash(executable), output: result, networkDependencies: false };
    if (platformDirectory && !apiBootstrap) {
      stage = 'ink-cross-engine-parity';
      const worker = await run(process.execPath, [script, '--internal-ink-worker', resolve(platformDirectory), join(profile, 'native')], 'native-ink-cross-engine-parity', profile);
      const parity = JSON.parse(worker.stdout);
      assert.equal(parity.status, 'passed'); proof.inkParity = parity;
    }
    stage = 'cache-revalidation';
    assert.equal((await toolchain.inspect()).available, true);
    proof.cacheRevalidation = 'passed'; proof.freeBytesAfter = await freeBytes(profile); proof.status = 'passed';
  } catch (error) {
    preserveProfile = error.preserveProfile === true;
    proof.failure = { stage, code: safeCode(error), ...(archiveFailureDiagnostic(error) ? { archive: archiveFailureDiagnostic(error) } : {}), ...(noticeFailureDiagnostic(error) ? { notice: noticeFailureDiagnostic(error) } : {}), diagnosticSha256: hash(String(error.message || error)) };
  } finally {
    if (profile && preserveProfile) proof.ownedProfileCleanup = 'preserved-active-owned-descendants';
    else if (profile) {
      // Every owned subprocess above has closed, including the optional parity worker and its children.
      try {
        await writeFile(join(profile, 'storage-retention.json'), JSON.stringify({ keep: {}, safe_to_remove: Object.fromEntries([...ownedPaths, 'storage-retention.json'].map(path => [path, 'Completed owned generated validation output; exact recipe, pinned inputs and required notices were retained separately.'])) }), { mode: 0o600 });
        await rm(profile, { recursive: true, force: true }); proof.ownedProfileCleanup = 'passed';
      } catch (error) { proof.status = 'failed'; proof.ownedProfileCleanup = 'failed'; proof.cleanupFailure = { code: safeCode(error) }; }
    }
    proof.finishedAt = new Date().toISOString();
    await writeFile(outputPath, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return proof;
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    if (process.argv[2] === '--internal-api-worker') {
      if (process.argv.length !== 6) throw fail('INK_VERIFY_ARGUMENT', 'Invalid internal API worker invocation.');
      const policy = JSON.parse(process.argv[5]);
      console.log(JSON.stringify(await apiBootstrapAcceptance({ platformDirectory: resolve(process.argv[3]), directory: resolve(process.argv[4]), ephemeralRunner: policy.ephemeralRunner, reserveGiB: policy.reserveGiB })));
    } else if (process.argv[2] === '--internal-ink-worker') {
      if (process.argv.length !== 5) throw fail('INK_VERIFY_ARGUMENT', 'Invalid internal worker invocation.');
      console.log(JSON.stringify(await inkWorker(resolve(process.argv[3]), resolve(process.argv[4]))));
    } else {
      const options = parseVerificationArguments(process.argv.slice(2));
      if (options.help) console.log('Usage: node scripts/verify-native-toolchain.mjs --output PATH [--platform-dir PATH] [--api-bootstrap] [--ephemeral-runner --reserve-gib N]\nDownloads and validates the real pinned Rust toolchain on macOS. --api-bootstrap requires --platform-dir and installs only through a durable explicit API build in a fresh host/cache, then verifies cached native state after restart. Verification preserves a 100 GiB reserve plus the 5 GiB installation estimate. The product installer defaults to a configurable 2 GiB reserve plus that estimate. Only an explicit disposable CI runner declaration together with --reserve-gib overrides the verification reserve; --ephemeral-runner alone preserves 100 GiB. Set a CI job timeout. License notices are retained beside PATH in PATH.licenses.');
      else { const proof = await verifyNativeToolchain(options); console.log(JSON.stringify(proof, null, 2)); if (proof.status !== 'passed') process.exitCode = 1; }
    }
  } catch (error) {
    // Raw child diagnostics and local paths never enter the public proof or terminal output.
    console.log(JSON.stringify({ format: 'ink-os-managed-native-toolchain-proof-v1', status: 'failed', failure: { code: safeCode(error), diagnosticSha256: hash(String(error.message || error)) } })); process.exitCode = 1;
  }
}
