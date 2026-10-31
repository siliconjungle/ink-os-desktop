import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { NativeToolchain, nativeToolchainPlan, NATIVE_TOOLCHAIN_RELEASE, NATIVE_TOOLCHAIN_DEFAULT_RESERVE_BYTES, NATIVE_TOOLCHAIN_ESTIMATED_BYTES } from '../src/native-toolchain.mjs';
import { parseVerificationArguments, verifyNativeToolchain, verificationReserveBytes, VERIFIER_DEFAULT_RESERVE_BYTES, archiveFailureDiagnostic, retainToolchainNotices, noticeFailureDiagnostic, NATIVE_NOTICE_LIMITS } from '../scripts/verify-native-toolchain.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function tar(entries) {
  const result = [];
  for (const { name, body = '', type = '0', link = '', mode = 0o755 } of entries) {
    const bytes = Buffer.from(body), header = Buffer.alloc(512);
    const split = name.length > 100 ? name.lastIndexOf('/') : -1;
    header.write(split < 0 ? name : name.slice(split + 1), 0, 100);
    if (split >= 0) header.write(name.slice(0, split), 345, 155);
    header.write(mode.toString(8).padStart(7, '0') + '\0', 100);
    header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write(type, 156); header.write(link, 157, 100);
    header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    result.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...result, Buffer.alloc(1024)]));
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ink-toolchain-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const linker = join(root, 'apple-clang'), sdk = join(root, 'MacOSX.sdk');
  await writeFile(linker, 'fixture'); await chmod(linker, 0o700);
  await mkdir(join(sdk, 'usr/lib'), { recursive: true }); await writeFile(join(sdk, 'usr/lib/libSystem.tbd'), 'fixture');
  let downloads = 0, executions = 0;
  const data = new Map();
  const make = directory => new NativeToolchain({ directory, platform: 'darwin', arch: 'arm64', freeBytes: async () => 200 * 1024 ** 3,
    execute: async (command, args) => { executions++; if (command === '/usr/bin/xcrun') return { stdout: args.includes('--find') ? linker : sdk }; assert.equal(command, linker); return { stdout: 'Apple clang fixture' }; },
    fetch: async (url, config) => { downloads++; assert.equal(config.redirect, 'error'); assert.ok(config.signal); return new Response(data.get(url), { status: 200 }); }, ...options });
  const service = make(join(root, 'cache'));
  const plan = structuredClone(service.plan);
  plan.components.forEach(component => {
    const path = component.name === 'rust-std' ? `lib/rustlib/${plan.target}/lib/libstd-fixture.rlib` : `bin/${component.name}`;
    const bytes = tar([{ name: `${component.root}/${component.component}/manifest.in`, body: `file:${path}\n` }, { name: `${component.root}/${component.component}/${path}`, body: `${component.name} fixture` }]);
    component.sha256 = hash(bytes); data.set(component.url, bytes);
  });
  // Only tests replace reviewed archive pins, so no network or real compiler is installed.
  service.plan = plan;
  return { root, service, data, plan, make: () => { const other = make(service.directory); other.plan = structuredClone(plan); return other; }, downloads: () => downloads, executions: () => executions };
}

test('pins exact official release and only the two bounded macOS targets', () => {
  assert.equal(NATIVE_TOOLCHAIN_RELEASE.version, '1.96.0');
  const arm = nativeToolchainPlan('darwin', 'arm64'), intel = nativeToolchainPlan('darwin', 'x64');
  assert.equal(arm.target, 'aarch64-apple-darwin'); assert.equal(intel.target, 'x86_64-apple-darwin');
  assert.notEqual(arm.cacheKey, intel.cacheKey);
  for (const plan of [arm, intel]) for (const component of plan.components) { assert.match(component.url, /^https:\/\/static\.rust-lang\.org\/dist\/2026-05-28\//); assert.match(component.sha256, /^[0-9a-f]{64}$/); }
  for (const [platform, arch] of [['linux', 'x64'], ['win32', 'x64'], ['darwin', 'ia32']]) assert.equal(nativeToolchainPlan(platform, arch).supported, false);
});

test('unsupported hosts and absent Apple SDK fail before fetching', async t => {
  const unsupported = new NativeToolchain({ directory: '/unused', platform: 'linux', fetch: () => assert.fail('must not fetch') });
  assert.equal((await unsupported.inspect()).code, 'INK_TOOLCHAIN_UNSUPPORTED');
  await assert.rejects(unsupported.ensure(), { code: 'INK_TOOLCHAIN_UNSUPPORTED' });
  const { service, downloads } = await fixture(t, { execute: async () => { throw Error('xcrun absent'); } });
  assert.equal((await service.inspect()).code, 'INK_TOOLCHAIN_APPLE_SDK');
  await assert.rejects(service.ensure(), { code: 'INK_TOOLCHAIN_APPLE_SDK' }); assert.equal(downloads(), 0);
});

test('product reserves 2 GiB plus its 5 GiB installation estimate before downloading', async t => {
  const { service, downloads } = await fixture(t, { freeBytes: async () => 6 * 1024 ** 3 });
  assert.equal(service.reserveBytes, NATIVE_TOOLCHAIN_DEFAULT_RESERVE_BYTES);
  assert.equal(service.reserveBytes, 2 * 1024 ** 3);
  assert.equal(service.estimatedBytes, NATIVE_TOOLCHAIN_ESTIMATED_BYTES);
  assert.equal(service.estimatedBytes, 5 * 1024 ** 3);
  await assert.rejects(service.ensure(), { code: 'INK_TOOLCHAIN_DISK_RESERVE' }); assert.equal(downloads(), 0);
  assert.deepEqual(await readdir(service.directory), []);
});

test('fixture component install is atomic, private, integrity checked and reused', async t => {
  const { service, downloads, make } = await fixture(t);
  assert.equal((await service.inspect()).code, 'INK_TOOLCHAIN_MISSING');
  const first = await service.ensure();
  assert.equal(first.available, true); assert.equal(downloads(), 3);
  assert.equal(first.runtimeEnvironment.INK_NATIVE_CARGO, join(service.prefix, 'bin/cargo'));
  assert.equal(first.runtimeEnvironment.INK_NATIVE_RUSTC, join(service.prefix, 'bin/rustc'));
  assert.ok(first.runtimeEnvironment.CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER);
  assert.equal(first.release.version, '1.96.0');
  for (const component of service.plan.components) assert.match(await readFile(join(service.prefix, `share/ink-toolchain-manifests/${component.name}/manifest.in`), 'utf8'), /^file:/);
  await assert.rejects(readFile(join(service.prefix, 'manifest.in')), { code: 'ENOENT' });
  assert.equal((await lstat(service.prefix)).mode & 0o777, 0o700);
  assert.equal((await lstat(first.cargo)).mode & 0o777, 0o700);
  assert.equal((await make().inspect()).available, true);
  assert.equal((await make().ensure()).cargo, first.cargo); assert.equal(downloads(), 3);
  assert.deepEqual((await readdir(service.directory)).sort(), ['cargo-home', service.plan.cacheKey].sort());
  await writeFile(first.rustc, 'corrupted');
  assert.equal((await service.inspect()).code, 'INK_TOOLCHAIN_INTEGRITY');
  await assert.rejects(service.ensure(), { code: 'INK_TOOLCHAIN_INTEGRITY' });
  assert.equal(await readFile(first.rustc, 'utf8'), 'corrupted'); assert.equal(downloads(), 3);
});

test('simultaneous calls and independent service instances share one installation', async t => {
  const { service, make, downloads } = await fixture(t);
  const a = service.ensure(), b = service.ensure(); assert.equal(a, b);
  const [first, second, third] = await Promise.all([a, b, make().ensure()]);
  assert.equal(first.cargo, second.cargo); assert.equal(first.cargo, third.cargo); assert.equal(downloads(), 3);
});

test('hash failure cleans only its staging and lock, then a retry succeeds', async t => {
  const { service, data, plan } = await fixture(t);
  await mkdir(service.directory, { mode: 0o700 }); await writeFile(join(service.directory, 'unrelated-proof.txt'), 'retain');
  const component = plan.components[0], original = data.get(component.url); data.set(component.url, Buffer.from('bad archive'));
  await assert.rejects(service.ensure(), { code: 'INK_TOOLCHAIN_INTEGRITY' });
  assert.deepEqual(await readdir(service.directory), ['unrelated-proof.txt']);
  data.set(component.url, original); assert.equal((await service.ensure()).available, true);
  assert.equal(await readFile(join(service.directory, 'unrelated-proof.txt'), 'utf8'), 'retain');
});

test('bounded stream downloads reject declared and undeclared overflows', async t => {
  for (const declared of [false, true]) {
    const { service } = await fixture(t, { maxDownloadBytes: 8, fetch: async () => new Response(Buffer.alloc(9), { headers: declared ? { 'content-length': '9' } : {} }) });
    await assert.rejects(service.ensure(), { code: 'INK_TOOLCHAIN_DOWNLOAD_LIMIT' }); assert.deepEqual(await readdir(service.directory), []);
  }
});

test('network failure preserves clean retry state', async t => {
  const { service } = await fixture(t, { fetch: async () => { throw Error('network unavailable'); } });
  await assert.rejects(service.ensure(), /network unavailable/); assert.deepEqual(await readdir(service.directory), []);
});

test('live and malformed locks stay untouched and waits are bounded', async t => {
  const { service, downloads } = await fixture(t, { lockTimeoutMs: 0 });
  await mkdir(service.directory, { mode: 0o700 });
  const path = join(service.directory, `${service.plan.cacheKey}.lock`);
  for (const contents of [JSON.stringify({ pid: process.pid, token: 'active-owner' }), '']) {
    await writeFile(path, contents);
    await assert.rejects(service.ensure(), { code: 'INK_TOOLCHAIN_BUSY' });
    assert.equal(await readFile(path, 'utf8'), contents);
  }
  assert.equal(downloads(), 0);
});

test('dead installer lock is diagnosed without racing to steal another installation', async t => {
  const { service, downloads } = await fixture(t, { lockTimeoutMs: 0 });
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  await mkdir(service.directory, { mode: 0o700 });
  const path = join(service.directory, `${service.plan.cacheKey}.lock`), contents = JSON.stringify({ pid: child.pid, token: 'exited-installer' });
  await writeFile(path, contents);
  await assert.rejects(service.ensure(), { code: 'INK_TOOLCHAIN_STALE_LOCK' });
  assert.equal(await readFile(path, 'utf8'), contents); assert.equal(downloads(), 0);
  await rm(path); assert.equal((await service.ensure()).available, true);
});

test('rejects a shared writable cache instead of changing its permissions', async t => {
  const { service, downloads } = await fixture(t);
  await mkdir(service.directory, { mode: 0o755 });
  await assert.rejects(service.ensure(), { code: 'INK_TOOLCHAIN_CACHE' });
  assert.equal((await lstat(service.directory)).mode & 0o777, 0o755); assert.equal(downloads(), 0);
});

test('incomplete committed caches are preserved instead of replaced', async t => {
  const { service, downloads } = await fixture(t);
  await mkdir(service.prefix, { recursive: true, mode: 0o700 }); await writeFile(join(service.prefix, 'proof.txt'), 'retain');
  await assert.rejects(service.ensure(), { code: 'INK_TOOLCHAIN_INTEGRITY' });
  assert.equal(await readFile(join(service.prefix, 'proof.txt'), 'utf8'), 'retain'); assert.equal(downloads(), 0);
});

test('verified but unsafe archives cannot traverse or expand past budget', async t => {
  const cases = [
    { entry: { name: '../escaped', body: 'evil' }, code: 'INK_TOOLCHAIN_ARCHIVE' },
    { entry: { name: '/absolute', body: 'evil' }, code: 'INK_TOOLCHAIN_ARCHIVE' },
    { entry: { name: 'PLACEHOLDER', type: '2', link: '../../../../escaped' }, code: 'INK_TOOLCHAIN_ARCHIVE' },
    { entry: { name: 'PLACEHOLDER', body: 'x'.repeat(3000) }, code: 'INK_TOOLCHAIN_ARCHIVE_LIMIT', maxExpandedBytes: 1024 },
  ];
  for (const scenario of cases) {
    const { service, data } = await fixture(t, scenario.maxExpandedBytes ? { maxExpandedBytes: scenario.maxExpandedBytes } : {});
    const component = service.plan.components[0];
    const bytes = tar([{ ...scenario.entry, name: scenario.entry.name.replace('PLACEHOLDER', `${component.root}/${component.component}/bin/rustc`) }]);
    component.sha256 = hash(bytes); data.set(component.url, bytes);
    await assert.rejects(service.ensure(), { code: scenario.code }); assert.deepEqual(await readdir(service.directory), []);
  }
});

test('archive reader supports GNU long paths and bounded PAX paths', async t => {
  const { service, data } = await fixture(t);
  const component = service.plan.components[0], name = `${component.root}/${component.component}/bin/rustc`;
  const paxValue = `path=${name}\n`; let length = paxValue.length + 3;
  while (String(length).length + 1 + paxValue.length !== length) length = String(length).length + 1 + paxValue.length;
  const bytes = tar([{ name: 'PaxHeader', type: 'x', body: `${length} ${paxValue}` }, { name: 'short-name', body: 'rustc fixture' }, { name: 'LongLink', type: 'L', body: `${component.root}/${component.component}/lib/${'a'.repeat(110)}\0` }, { name: 'short-name', body: 'long path fixture' }]);
  component.sha256 = hash(bytes); data.set(component.url, bytes);
  assert.equal((await service.ensure()).available, true);
  assert.equal(await readFile(join(service.prefix, `lib/${'a'.repeat(110)}`), 'utf8'), 'long path fixture');
});

test('safe relative symlinks are deferred and verified before cache reuse', async t => {
  const { service, data } = await fixture(t);
  const component = service.plan.components[0], base = `${component.root}/${component.component}`;
  const bytes = tar([{ name: `${base}/bin/rustc`, body: 'rustc fixture' }, { name: `${base}/bin/rustdoc`, type: '2', link: 'rustc' }]);
  component.sha256 = hash(bytes); data.set(component.url, bytes);
  assert.equal((await service.ensure()).available, true); assert.equal((await service.inspect()).available, true);
  assert.equal(await readFile(join(service.prefix, 'bin/rustdoc'), 'utf8'), 'rustc fixture');
});

test('shared component files can repeat only with identical bytes, size and executable mode', async t => {
  for (const differing of [false, true]) {
    const { service, data } = await fixture(t);
    for (const component of service.plan.components) {
      const path = component.name === 'rust-std' ? `lib/rustlib/${service.plan.target}/lib/libstd-fixture.rlib` : `bin/${component.name}`;
      const bytes = tar([
        { name: `${component.root}/${component.component}/manifest.in`, body: `file:${path}\n` },
        { name: `${component.root}/${component.component}/${path}`, body: `${component.name} fixture` },
        { name: `${component.root}/${component.component}/share/doc/rust/LICENSE-MIT`, body: differing && component.name === 'cargo' ? 'DIFFERENT' : 'identical' },
      ]);
      component.sha256 = hash(bytes); data.set(component.url, bytes);
    }
    if (differing) {
      await assert.rejects(service.ensure(), error => {
        assert.equal(error.code, 'INK_TOOLCHAIN_ARCHIVE_CONFLICT');
        assert.deepEqual(archiveFailureDiagnostic(error), { component: 'cargo', entry: 'share/doc/rust/LICENSE-MIT', reason: 'duplicate-content-mismatch' }); return true;
      });
      assert.deepEqual(await readdir(service.directory), []);
    } else {
      assert.equal((await service.ensure()).available, true);
      const receipt = JSON.parse(await readFile(join(service.prefix, 'receipt.json'), 'utf8'));
      assert.equal(receipt.inventory.filter(item => item.path === 'share/doc/rust/LICENSE-MIT').length, 1);
    }
  }
});

test('archive failure proof diagnostics retain only bounded relative entry context', () => {
  assert.equal(archiveFailureDiagnostic({ archiveEntry: '/private/user/key', archiveComponent: 'other', archiveReason: 'secret value' }), undefined);
  assert.deepEqual(archiveFailureDiagnostic({ archiveEntry: '../secret', archiveComponent: 'rustc', archiveReason: 'eexist' }), { component: 'rustc', reason: 'eexist' });
});

test('verifier streams a large aggregate Rust notice beyond the obsolete 4 MiB limit without changing bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ink-rust-notice-')); t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = join(root, 'cache'), directory = join(root, 'notices'); await mkdir(join(prefix, 'share/doc/rust'), { recursive: true }); await mkdir(directory);
  const body = Buffer.alloc(5 * 1024 ** 2, 65), path = 'share/doc/rust/COPYRIGHT.html'; await writeFile(join(prefix, path), body);
  const result = await retainToolchainNotices({ prefix, directory, inventory: [{ path, sha256: hash(body) }] });
  assert.equal(result[0].bytes, body.length); assert.equal(hash(await readFile(join(directory, result[0].retainedFile))), hash(body));
  assert.equal(NATIVE_NOTICE_LIMITS.fileBytes, 128 * 1024 ** 2); assert.equal(NATIVE_NOTICE_LIMITS.totalBytes, 512 * 1024 ** 2);
});

test('notice retention enforces file/aggregate bounds and rejects changed bytes with safe contextual diagnostics', async t => {
  for (const kind of ['file', 'total', 'integrity']) {
    const root = await mkdtemp(join(tmpdir(), 'ink-rust-notice-limit-')); t.after(() => rm(root, { recursive: true, force: true }));
    const prefix = join(root, 'cache'), directory = join(root, 'notices'); await mkdir(prefix); await mkdir(directory);
    await writeFile(join(prefix, 'LICENSE'), 'notice'); await writeFile(join(prefix, 'COPYRIGHT'), 'notice');
    const inventory = [{ path: 'LICENSE', sha256: kind === 'integrity' ? '0'.repeat(64) : hash('notice') }, { path: 'COPYRIGHT', sha256: hash('notice') }];
    const limits = { files: 3, fileBytes: kind === 'file' ? 5 : 10, totalBytes: kind === 'total' ? 10 : 30 };
    await assert.rejects(retainToolchainNotices({ prefix, inventory, directory, limits }), error => {
      const context = noticeFailureDiagnostic(error); assert.equal(context.kind, kind); assert.ok(['LICENSE', 'COPYRIGHT'].includes(context.entry)); assert.ok(!JSON.stringify(context).includes(root)); return true;
    });
    assert.equal((await readdir(directory)).length, kind === 'total' ? 1 : 0);
  }
});

test('real verifier requires an explicit ephemeral runner for every reserve override', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ink-verifier-guard-')); t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(parseVerificationArguments(['--output', 'proof.json']), { output: 'proof.json' });
  assert.deepEqual(parseVerificationArguments(['--ephemeral-runner', '--reserve-gib', '2', '--output', 'proof.json']), { ephemeralRunner: true, reserveGiB: 2, output: 'proof.json' });
  for (const args of [[], ['--reserve-gib', '2', '--output', 'proof.json'], ['--ephemeral-runner', '--reserve-gib', '-1', '--output', 'proof.json'], ['--ephemeral-runner', '--reserve-gib', 'NaN', '--output', 'proof.json'], ['--ephemeral-runner', '--reserve-gib', '101', '--output', 'proof.json'], ['--output', 'a', '--output', 'b'], ['--unknown']]) assert.throws(() => parseVerificationArguments(args), { code: 'INK_VERIFY_ARGUMENT' });
  for (const options of [{ reserveGiB: 2 }, { ephemeralRunner: 'false', reserveGiB: 2 }, { ephemeralRunner: true, reserveGiB: -1 }, { ephemeralRunner: true, reserveGiB: Infinity }, { ephemeralRunner: true, reserveGiB: 101 }]) await assert.rejects(verifyNativeToolchain({ output: join(root, 'proof.json'), ...options }), { code: 'INK_VERIFY_ARGUMENT' });
  assert.deepEqual(await readdir(root), []);
  assert.equal(new NativeToolchain({ directory: join(root, 'cache') }).reserveBytes, 2 * 1024 ** 3);
  assert.equal(VERIFIER_DEFAULT_RESERVE_BYTES, 100 * 1024 ** 3);
  assert.equal(verificationReserveBytes(), 100 * 1024 ** 3);
  assert.equal(verificationReserveBytes({ ephemeralRunner: true }), 100 * 1024 ** 3);
  assert.equal(verificationReserveBytes({ ephemeralRunner: true, reserveGiB: 2 }), 2 * 1024 ** 3);
  assert.throws(() => verificationReserveBytes({ reserveGiB: 2 }), { code: 'INK_VERIFY_ARGUMENT' });
});
