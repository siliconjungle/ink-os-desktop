import { readFile, writeFile, mkdir, mkdtemp, access } from 'node:fs/promises';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { LocalInstance, localPort } from '../src/local-instance.mjs';
import { runtimeEnvironment } from '../src/runtime.mjs';

const execute = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const releasePath = resolve(process.argv[2] || 'release.json'), output = dirname(releasePath);
const release = JSON.parse(await readFile(releasePath));
assert.equal(release.format, 'ink-os-desktop-package-v1');
assert.equal(release.platform, process.platform); assert.equal(release.architecture, process.arch);
const ephemeralRunner = process.env.INK_OS_VERIFY_EPHEMERAL_RUNNER === '1';
if (ephemeralRunner) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_OS, 'macOS');
  assert.equal(process.env.RUNNER_ARCH, 'ARM64');
  assert.match(process.env.GITHUB_RUN_ID || '', /^[1-9][0-9]*$/);
  assert.match(process.env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
}
const bundle = process.env.INK_OS_VERIFY_BUNDLE ? resolve(process.env.INK_OS_VERIFY_BUNDLE) : resolve(output, release.bundle), inside = relative(output, bundle);
if (!process.env.INK_OS_VERIFY_BUNDLE) assert.ok(inside !== '..' && !inside.startsWith('..' + sep));
assert.equal(hash(await readFile(join(output, release.artifact))), release.artifactSha256);
const contents = process.platform === 'darwin' ? join(bundle, 'Ink OS.app', 'Contents') : bundle;
const resources = join(contents, process.platform === 'darwin' ? 'Resources' : 'resources');
const executable = join(contents, ...(process.platform === 'darwin' ? ['MacOS'] : []), 'ink-os-desktop');
const cliPath = join(process.platform === 'darwin' ? resources : dirname(executable), 'ink-os');
assert.equal(hash(await readFile(join(resources, 'tools', 'package-manifest.json'))), release.manifestSha256);
const manifest = JSON.parse(await readFile(join(resources, 'tools', 'package-manifest.json')));
for (const path of ['src/connections.mjs', 'src/connection-controller.mjs', 'src/connection-layout.mjs', 'src/connections-ui.html', 'src/connections-ui.mjs', 'src/connections-preload.cjs', 'assets/icon.svg']) assert.ok(manifest.app.some(entry => entry.path === path && /^[a-f0-9]{64}$/.test(entry.sha256)), 'Missing packaged Connections input: ' + path);
for (const path of ['cli.mjs', 'connections.mjs', 'connection-layout.mjs', 'runtime.mjs']) { const entry = manifest.tools.find(entry => entry.path === path); assert.ok(entry, 'Missing packaged CLI input: ' + path); assert.equal(hash(await readFile(join(resources, 'tools', path))), entry.sha256); }
assert.ok(manifest.runtime.some(entry => entry.path === 'server/process-receipt.mjs'), 'Missing bundled connection ownership support');
assert.equal(hash(await readFile(join(resources, 'icon.png'))), release.icon.pngSha256);
for (const name of ['ELECTRON-LICENSE', 'LICENSES.chromium.html']) assert.equal(hash(await readFile(join(resources, 'licenses', name))), release.runtimeNotices[name]);
if (process.platform === 'darwin') {
  await execute('codesign', ['--verify', '--deep', '--strict', join(bundle, 'Ink OS.app')]);
  const iconName = (await execute('plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', join(contents, 'Info.plist')])).stdout.trim();
  assert.equal(hash(await readFile(join(resources, iconName))), release.icon.icnsSha256);
}
const root = fileURLToPath(new URL('..', import.meta.url)), directory = await mkdtemp(join(root, '.local', 'package-proof-'));
const retentionPath = join(root, 'storage-retention.json');
async function retain(completed) {
  const saved = JSON.parse(await readFile(retentionPath)), key = relative(root, directory);
  delete saved.keep[key]; delete saved.safe_to_remove[key];
  saved[completed ? 'safe_to_remove' : 'keep'][key] = completed ? 'Completed generated packaged-runtime proof instance, source and tool blockers; selected result and exact builder/pins are retained.' : 'Active required packaged-runtime validation; preserve its instance and source until the owned host exits.';
  await writeFile(retentionPath, JSON.stringify(saved, null, 2) + '\n');
}
await retain(false);
await writeFile(join(directory, 'storage-retention.json'), JSON.stringify({ keep: { 'data': 'Active packaged instance.', 'source': 'Explicitly generated test source.', 'no-tools': 'Development-tool blockers.', 'storage-retention.json': 'Validation retention policy.' }, safe_to_remove: {} }, null, 2) + '\n');
const noTools = join(directory, 'no-tools'); await mkdir(noTools);
for (const name of ['node', 'git', 'cargo', 'rustc']) await writeFile(join(noTools, name), '#!/bin/sh\necho "Unexpected external development tool" >&2\nexit 87\n', { mode: 0o755 });
const path = noTools + ':/usr/bin:/bin', desktopData = join(directory, 'data'), data = join(desktopData, 'instances', 'default');
const instance = new LocalInstance({ platformDirectory: join(resources, 'platform'), executable, electron: true, directory: data, port: await localPort(data), runtimeEnvironment: { ...runtimeEnvironment(resources, { directory: data }), PATH: path } });
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME|GIT_)/.test(name)));
Object.assign(env, { PATH: path, INK_OS_DESKTOP_DATA_DIR: desktopData });
const cli = async (...args) => JSON.parse((await execute(cliPath, args, { env, maxBuffer: 4 * 1024 * 1024 })).stdout);
let client;
try {
  client = await instance.start();
  assert.deepEqual(await cli('apps', 'list'), []);
  const native = await cli('native', 'status');
  assert.equal(native.available, false);
  assert.equal(native.buildAvailable, Boolean(native.installable));
  await assert.rejects(access(join(data, 'native-toolchains')), { code: 'ENOENT' });
  const source = join(directory, 'source'); await cli('init', source, '--slug', 'packaged-proof', '--title', 'Packaged Ink proof');
  const deployment = await cli('deploy', source);
  assert.equal((await cli('ink', 'run', deployment.appId, 'add', '--input', '[3]', '--backend', 'javascript')).valueWire, '3');
  const javascriptSource = join(directory, 'javascript-source'); await mkdir(javascriptSource);
  await writeFile(join(javascriptSource, 'ink-app.json'), JSON.stringify({ slug: 'packaged-javascript-proof', title: 'Packaged JavaScript proof', entry: 'index.html' }));
  const page = '<!doctype html><p>Packaged local Git artifacts</p>';
  await writeFile(join(javascriptSource, 'index.html'), page);
  const gitRoot = join(resources, 'git'), gitEnv = { ...env, GIT_EXEC_PATH: join(gitRoot, 'libexec', 'git-core'), GIT_TEMPLATE_DIR: join(gitRoot, 'share', 'git-core', 'templates') };
  const git = (...args) => execute(join(gitRoot, 'bin', 'git'), args, { env: gitEnv });
  await git('init', '-b', 'main', javascriptSource); await git('-C', javascriptSource, 'add', '.');
  await git('-C', javascriptSource, '-c', 'user.name=Ink OS', '-c', 'user.email=ink-os@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + join(javascriptSource, '.git', 'no-hooks'), 'commit', '-m', 'Commit packaged JavaScript proof');
  const javascript = await cli('deploy', javascriptSource), jsStatus = await cli('apps', 'status', javascript.appId);
  assert.match(JSON.parse(jsStatus.app.body).projectId, /^[a-f0-9]{32}$/);
  const verifyPage = async () => {
    const launch = await cli('launch', javascript.appId), opened = await fetch(launch.url, { redirect: 'manual' }); assert.equal(opened.status, 302);
    const cookie = opened.headers.get('set-cookie').split(';')[0], headers = { Cookie: cookie };
    assert.equal((await fetch(launch.origin)).status, 401);
    const response = await fetch(launch.origin, { headers }); assert.equal(response.status, 200); assert.equal(await response.text(), page);
    const range = await fetch(launch.origin, { headers: { ...headers, Range: 'bytes=2-9' } }); assert.equal(range.status, 206); assert.equal(await range.text(), page.slice(2, 10));
  };
  await verifyPage();
  await instance.stop(); const restarted = await instance.start();
  assert.equal(restarted.url, client.url); assert.equal(restarted.instanceId, client.instanceId);
  const total = await cli('ink', 'run', deployment.appId, 'total'); assert.equal(total.valueWire, '3');
  assert.equal(total.backend, 'javascript');
  await verifyPage();
  const proof = { format: 'ink-os-packaged-runtime-proof-v1', platformSource: release.platformSource, artifactSha256: release.artifactSha256, manifestSha256: release.manifestSha256, electron: release.electron, platform: process.platform, architecture: process.arch, relocatedBundle: !!process.env.INK_OS_VERIFY_BUNDLE, observed: ['The packaged Electron executable ran its bundled platform independently of the source checkout.', 'Fresh instance had zero apps.', 'The packaged CLI captured the default desktop Local selection without an explicit CLI configuration.', 'External node, git, cargo and rustc names were blocked on PATH.', 'The packaged CLI initialized local Git source, compiled and deployed an Ink app, and changed its state to 3.', 'A compatible JavaScript runtime remained usable with no native toolchain.', 'The packaged CLI imported local JavaScript Git source and served its authenticated, content-verified artifact and byte range before and after restart.', 'Saved state, instance identity and address survived host restart.'], limits: ['Host-runtime and CLI proof; graphical packaged-window testing is recorded separately.', 'This host is not a clean virtual machine.', 'Managed native toolchains and notarized distribution remain separate work.'] };
  proof.desktopSource = release.desktopSource;
  proof.verifierSha256 = hash(await readFile(fileURLToPath(import.meta.url)));
  if (ephemeralRunner) {
    proof.ci = { repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, commit: process.env.GITHUB_SHA, runnerOS: process.env.RUNNER_OS, runnerArchitecture: process.env.RUNNER_ARCH };
    proof.limits[1] = 'Fresh GitHub-hosted macOS runner; this is not a graphical first-launch or Gatekeeper acceptance test.';
  }
  await mkdir(join(root, 'evidence'), { recursive: true });
  await writeFile(join(root, 'evidence', 'packaged-runtime.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof, null, 2));
} finally { await instance.stop(); await retain(true); }
