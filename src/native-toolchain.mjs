import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, writeFile, rename, rm, mkdtemp, lstat, readlink, symlink, statfs, access, realpath } from 'node:fs/promises';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createGunzip } from 'node:zlib';

const execute = promisify(execFile);
const GiB = 1024 ** 3;
export const NATIVE_TOOLCHAIN_DEFAULT_RESERVE_BYTES = 2 * GiB;
export const NATIVE_TOOLCHAIN_ESTIMATED_BYTES = 5 * GiB;
const hashes = {
  'aarch64-apple-darwin': ['c1a23d0ac24da25eca730d87d74d7f6f771d48167fc93e45d79f0e12f486c8d9', '178581665d8b3af41f3fe21cb8a48aa7eb65ab4c567f53f3661a3a6c9b182f2e', 'a5c160197236f68cc8627a573545fd883d4d98856fb654a6d6aa5883ff1bdcc7'],
  'x86_64-apple-darwin': ['316060175a1dadca74cc8a16ed52c19c9a0d68c70c3937b33694f56c79bf1036', '56229b6257f31496cdeabd3d734debc0e1bc16ac2926e497497a47a84ba9d048', 'c5dfa11ccc724faec277e420ff6b33cfa6567b9ac6fa9e5d712a19c662d8c36c'],
};

// Release pins copied from https://static.rust-lang.org/dist/channel-rust-1.96.0.toml.
// These hashes are a release-review trust anchor, never fetched from a mutable channel at runtime.
export const NATIVE_TOOLCHAIN_RELEASE = Object.freeze({ version: '1.96.0', date: '2026-05-28', manifest: 'https://static.rust-lang.org/dist/channel-rust-1.96.0.toml' });
export function nativeToolchainPlan(platform = process.platform, arch = process.arch) {
  const target = platform === 'darwin' ? { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }[arch] : undefined;
  if (!target) return { supported: false, reason: `Managed native builds are not yet supported on ${platform}/${arch}. Use the JavaScript runtime or a host with a separately provisioned native toolchain.` };
  const components = ['rustc', 'cargo', 'rust-std'].map((name, index) => ({ name, sha256: hashes[target][index], url: `https://static.rust-lang.org/dist/${NATIVE_TOOLCHAIN_RELEASE.date}/${name}-${NATIVE_TOOLCHAIN_RELEASE.version}-${target}.tar.gz`, root: `${name}-${NATIVE_TOOLCHAIN_RELEASE.version}-${target}`, component: name === 'rust-std' ? `rust-std-${target}` : name }));
  const identity = createHash('sha256').update(JSON.stringify(components)).digest('hex');
  return { supported: true, ...NATIVE_TOOLCHAIN_RELEASE, target, components, identity, cacheKey: `rust-${NATIVE_TOOLCHAIN_RELEASE.version}-${target}-${identity.slice(0, 16)}` };
}
const failure = (code, message) => Object.assign(Error(message), { code });
const inside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
const safePath = value => {
  const name = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..') || name.includes('\0')) throw failure('INK_TOOLCHAIN_ARCHIVE', 'Unsafe toolchain archive path.');
  return name;
};
async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return true; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

// No installer scripts, shell, sudo, rustup, global PATH/configuration changes, or system package manager.
export class NativeToolchain {
  constructor({ directory, platform = process.platform, arch = process.arch, reserveBytes = NATIVE_TOOLCHAIN_DEFAULT_RESERVE_BYTES, estimatedBytes = NATIVE_TOOLCHAIN_ESTIMATED_BYTES, downloadTimeoutMs = 120000, lockTimeoutMs = 15000, maxDownloadBytes = 512 * 1024 ** 2, maxExpandedBytes = 3 * GiB, fetch: fetchImpl = globalThis.fetch, execute: executeImpl = execute, freeBytes = async path => { const info = await statfs(path); return info.bavail * info.bsize; } } = {}) {
    if (!directory) throw Error('A private native-toolchain cache directory is required.');
    if (![reserveBytes, estimatedBytes, downloadTimeoutMs, lockTimeoutMs, maxDownloadBytes, maxExpandedBytes].every(value => Number.isSafeInteger(value) && value >= 0)) throw Error('Invalid native-toolchain resource limit.');
    Object.assign(this, { directory: resolve(directory), plan: nativeToolchainPlan(platform, arch), reserveBytes, estimatedBytes, downloadTimeoutMs, lockTimeoutMs, maxDownloadBytes, maxExpandedBytes, fetch: fetchImpl, execute: executeImpl, freeBytes });
  }
  get prefix() { return join(this.directory, this.plan.cacheKey || 'unsupported'); }
  async prerequisites() {
    if (!this.plan.supported) return { available: false, code: 'INK_TOOLCHAIN_UNSUPPORTED', reason: this.plan.reason };
    try {
      const [compiler, sdk] = await Promise.all([
        this.execute('/usr/bin/xcrun', ['--sdk', 'macosx', '--find', 'clang'], { timeout: 5000, maxBuffer: 65536 }),
        this.execute('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { timeout: 5000, maxBuffer: 65536 }),
      ]);
      const linker = compiler.stdout.trim(), sdkRoot = sdk.stdout.trim();
      if (!isAbsolute(linker) || !isAbsolute(sdkRoot)) throw Error('Invalid Apple developer-tool paths.');
      await Promise.all([access(linker, 1), access(join(sdkRoot, 'usr/lib/libSystem.tbd'))]);
      await this.execute(linker, ['--version'], { timeout: 5000, maxBuffer: 65536 });
      return { available: true, linker, sdkRoot };
    } catch {
      return { available: false, code: 'INK_TOOLCHAIN_APPLE_SDK', reason: 'Native builds require working Apple Command Line Tools or Xcode, including clang and the macOS SDK. Install them using Apple’s supported installer, then retry. Ink OS does not install or redistribute Apple developer tools.' };
    }
  }
  environment(prerequisite) {
    const cargo = join(this.prefix, 'bin/cargo'), rustc = join(this.prefix, 'bin/rustc');
    return { cargo, rustc, prefix: this.prefix, version: this.plan.version, target: this.plan.target, release: this.plan, runtimeEnvironment: {
      INK_NATIVE_CARGO: cargo, INK_NATIVE_RUSTC: rustc, RUSTC: rustc,
      CARGO_HOME: join(this.directory, 'cargo-home'), CC: prerequisite.linker, SDKROOT: prerequisite.sdkRoot,
      [`CARGO_TARGET_${this.plan.target.toUpperCase().replaceAll('-', '_')}_LINKER`]: prerequisite.linker,
    } };
  }
  async inspect() {
    const prerequisite = await this.prerequisites();
    if (!prerequisite.available) return { ...prerequisite, release: this.plan };
    try {
      await this.verify(this.prefix);
      return { available: true, managed: true, ...this.environment(prerequisite) };
    } catch (error) {
      if (error.code === 'ENOENT') return { available: false, code: 'INK_TOOLCHAIN_MISSING', installable: true, release: this.plan, reason: 'The pinned native Rust toolchain has not been installed in this profile.' };
      return { available: false, code: error.code || 'INK_TOOLCHAIN_INTEGRITY', release: this.plan, reason: error.message };
    }
  }
  ensure() {
    if (!this.pending) this.pending = this.install().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async install() {
    const prerequisite = await this.prerequisites();
    if (!prerequisite.available) throw failure(prerequisite.code, prerequisite.reason);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const cacheInfo = await lstat(this.directory);
    if (!cacheInfo.isDirectory() || (cacheInfo.mode & 0o077) || process.getuid && cacheInfo.uid !== process.getuid()) throw failure('INK_TOOLCHAIN_CACHE', 'Native-toolchain cache must be a private directory owned by the current user (mode 0700).');
    const release = await this.acquire();
    let staging;
    try {
      try { await this.verify(this.prefix); await this.prepareCargoHome(); return { available: true, managed: true, ...this.environment(prerequisite) }; }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // Never replace a committed directory: a native build may still be reading it.
        try { await lstat(this.prefix); throw failure('INK_TOOLCHAIN_INTEGRITY', 'The managed toolchain cache is incomplete. Preserve it and select a new cache directory to repair.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const free = await this.freeBytes(this.directory);
      if (!Number.isFinite(free) || free < this.reserveBytes + this.estimatedBytes) throw failure('INK_TOOLCHAIN_DISK_RESERVE', `Native toolchain installation needs ${this.estimatedBytes} bytes in addition to the ${this.reserveBytes}-byte free-space reserve.`);
      staging = await mkdtemp(join(this.directory, '.install-'));
      const prefix = join(staging, 'prefix'); await mkdir(prefix, { mode: 0o700 });
      const inventory = [], budget = { expanded: 0, entries: 0 };
      for (const component of this.plan.components) {
        const archive = join(staging, `${component.name}.tar.gz`);
        await this.download(component, archive);
        await this.extract(archive, prefix, component, inventory, budget);
        await rm(archive);
      }
      if (!inventory.some(item => item.path === 'bin/rustc') || !inventory.some(item => item.path === 'bin/cargo') || !inventory.some(item => item.path.startsWith(`lib/rustlib/${this.plan.target}/lib/`) && item.path.includes('libstd-'))) throw failure('INK_TOOLCHAIN_ARCHIVE', 'Rust distribution is missing required compiler, Cargo or standard-library files.');
      await writeFile(join(prefix, 'receipt.json'), JSON.stringify({ identity: this.plan.identity, inventory }), { mode: 0o600 });
      await this.verify(prefix);
      await rename(prefix, this.prefix);
      await this.prepareCargoHome();
      return { available: true, managed: true, ...this.environment(prerequisite) };
    } finally {
      try { if (staging) await rm(staging, { recursive: true, force: true }); }
      finally { await release(); }
    }
  }
  async prepareCargoHome() {
    const path = join(this.directory, 'cargo-home');
    await mkdir(path, { mode: 0o700, recursive: true });
    const info = await lstat(path);
    if (!info.isDirectory() || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) throw failure('INK_TOOLCHAIN_CACHE', 'The private managed Cargo home has unsafe permissions or ownership.');
  }
  async acquire() {
    const path = join(this.directory, `${this.plan.cacheKey}.lock`), token = randomUUID(), deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        const handle = await open(path, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); }
        finally { await handle.close(); }
        return async () => { const owner = JSON.parse(await readFile(path, 'utf8')); if (owner.token === token) await rm(path); };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = JSON.parse(await readFile(path, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') continue; }
        // A malformed/in-progress lock is never stolen; only a demonstrably dead process can be recovered.
        if (owner && !alive(owner.pid)) throw failure('INK_TOOLCHAIN_STALE_LOCK', `A previous installer exited before releasing ${path}. Its PID ${owner.pid} is no longer running. Remove only that lock file after confirming no installer is active, then retry. Existing toolchains were preserved.`);
        if (Date.now() >= deadline) throw failure('INK_TOOLCHAIN_BUSY', 'Another process owns the native-toolchain installation lock. Its work was preserved; retry later.');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }
  async download(component, path) {
    const url = new URL(component.url);
    if (url.protocol !== 'https:' || url.hostname !== 'static.rust-lang.org' || url.username || url.password || url.port) throw failure('INK_TOOLCHAIN_DOWNLOAD', 'Untrusted Rust distribution URL.');
    const response = await this.fetch(url.href, { redirect: 'error', signal: AbortSignal.timeout(this.downloadTimeoutMs) });
    if (!response.ok || !response.body) throw failure('INK_TOOLCHAIN_DOWNLOAD', `Rust distribution download failed (${response.status}).`);
    const length = Number(response.headers.get('content-length'));
    if (length > this.maxDownloadBytes) { await response.body.cancel(); throw failure('INK_TOOLCHAIN_DOWNLOAD_LIMIT', 'Rust distribution download exceeds its size limit.'); }
    const handle = await open(path, 'wx', 0o600), hash = createHash('sha256'); let count = 0;
    try {
      for await (const bytes of response.body) {
        count += bytes.length;
        if (count > this.maxDownloadBytes) throw failure('INK_TOOLCHAIN_DOWNLOAD_LIMIT', 'Rust distribution download exceeds its size limit.');
        hash.update(bytes); await handle.writeFile(bytes);
      }
    } finally { await handle.close(); }
    if (hash.digest('hex') !== component.sha256) throw failure('INK_TOOLCHAIN_INTEGRITY', 'Rust distribution SHA-256 verification failed. Nothing was installed.');
  }
  async verify(prefix) {
    if (!(await lstat(prefix)).isDirectory()) throw failure('INK_TOOLCHAIN_INTEGRITY', 'Managed Rust cache prefix must be a directory.');
    const canonicalPrefix = await realpath(prefix);
    const receiptPath = join(prefix, 'receipt.json');
    if ((await lstat(receiptPath)).size > 16 * 1024 ** 2) throw failure('INK_TOOLCHAIN_INTEGRITY', 'Managed Rust cache receipt exceeds its limit.');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    if (receipt.identity !== this.plan.identity || !Array.isArray(receipt.inventory) || !receipt.inventory.length || receipt.inventory.length > 100000) throw failure('INK_TOOLCHAIN_INTEGRITY', 'Managed Rust cache receipt does not match the pinned release.');
    for (const item of receipt.inventory) {
      const path = join(prefix, safePath(item.path)), info = await lstat(path);
      if (item.link !== undefined) {
        if (!info.isSymbolicLink() || await readlink(path) !== item.link || !inside(canonicalPrefix, await realpath(path))) throw failure('INK_TOOLCHAIN_INTEGRITY', 'Managed Rust cache link verification failed.');
      } else if (!info.isFile() || !inside(canonicalPrefix, await realpath(path)) || await digest(path) !== item.sha256) throw failure('INK_TOOLCHAIN_INTEGRITY', 'Managed Rust cache file verification failed.');
    }
    await Promise.all([access(join(prefix, 'bin/cargo'), 1), access(join(prefix, 'bin/rustc'), 1)]);
  }
  async extract(archive, prefix, component, inventory, budget) {
    // Parse tar ourselves to avoid depending on tar/xz or executing distribution install.sh.
    const input = createReadStream(archive), stream = input.pipe(createGunzip());
    input.on('error', error => stream.destroy(error));
    const iterator = stream[Symbol.asyncIterator](); let buffer = Buffer.alloc(0), finished = false;
    const read = async size => {
      const chunks = []; let remaining = size;
      while (remaining) {
        if (!buffer.length) {
          const next = await iterator.next();
          if (next.done) throw failure('INK_TOOLCHAIN_ARCHIVE', 'Truncated Rust distribution archive.');
          buffer = next.value; budget.expanded += buffer.length;
          if (budget.expanded > this.maxExpandedBytes) throw failure('INK_TOOLCHAIN_ARCHIVE_LIMIT', 'Expanded Rust distribution exceeds its size limit.');
        }
        const count = Math.min(remaining, buffer.length); chunks.push(buffer.subarray(0, count)); buffer = buffer.subarray(count); remaining -= count;
      }
      return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    };
    const text = bytes => bytes.toString('utf8').split('\0')[0];
    let extended = {}, longName, longLink, currentEntry; const links = [];
    try {
      while (!finished) {
        const header = await read(512);
        if (header.every(byte => byte === 0)) { finished = true; break; }
        if (++budget.entries > 100000) throw failure('INK_TOOLCHAIN_ARCHIVE_LIMIT', 'Rust distribution has too many entries.');
        const number = bytes => { const value = text(bytes).trim(); if (!/^[0-7]+$/.test(value)) throw failure('INK_TOOLCHAIN_ARCHIVE', 'Invalid tar number.'); return parseInt(value, 8); };
        const checksum = number(header.subarray(148, 156));
        if (header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0) !== checksum) throw failure('INK_TOOLCHAIN_ARCHIVE', 'Invalid tar checksum.');
        const size = number(header.subarray(124, 136)), type = String.fromCharCode(header[156] || 48);
        if (!Number.isSafeInteger(size) || size > this.maxExpandedBytes) throw failure('INK_TOOLCHAIN_ARCHIVE_LIMIT', 'Invalid Rust archive entry size.');
        if (['x', 'L', 'K'].includes(type)) {
          if (size > 1024 ** 2) throw failure('INK_TOOLCHAIN_ARCHIVE_LIMIT', 'Rust archive metadata exceeds its limit.');
          const value = await read(size); await read((512 - size % 512) % 512);
          if (type === 'L') longName = text(value);
          else if (type === 'K') longLink = text(value);
          else {
            let offset = 0; extended = {};
            while (offset < value.length) {
              const end = value.indexOf(32, offset), length = Number(value.subarray(offset, end).toString());
              if (end < offset || !Number.isSafeInteger(length) || length <= end - offset + 1 || offset + length > value.length) throw failure('INK_TOOLCHAIN_ARCHIVE', 'Invalid tar extended metadata.');
              const entry = value.subarray(end + 1, offset + length - 1).toString(), equals = entry.indexOf('=');
              extended[entry.slice(0, equals)] = entry.slice(equals + 1); offset += length;
            }
          }
          continue;
        }
        if (extended.size !== undefined && Number(extended.size) !== size) throw failure('INK_TOOLCHAIN_ARCHIVE', 'Unsupported tar extended size.');
        currentEntry = undefined;
        const tarPrefix = header.subarray(257, 263).toString() === 'ustar\0' ? text(header.subarray(345, 500)) : '';
        const name = safePath(extended.path || longName || `${tarPrefix ? tarPrefix + '/' : ''}${text(header.subarray(0, 100))}`);
        const link = extended.linkpath || longLink || text(header.subarray(157, 257));
        extended = {}; longName = longLink = undefined;
        const marker = `${component.root}/${component.component}/`;
        const license = ['LICENSE-APACHE', 'LICENSE-MIT', 'COPYRIGHT'].find(file => name === `${component.root}/${file}`);
        const selected = name.startsWith(marker) || Boolean(license);
        // rust-installer adds a distinct manifest.in to every component directory;
        // it is installer metadata, not a shared file to install at prefix/manifest.in.
        const manifest = name === marker + 'manifest.in';
        const path = license ? `share/ink-toolchain-licenses/${component.name}/${license}` : manifest ? `share/ink-toolchain-manifests/${component.name}/manifest.in` : selected ? safePath(name.slice(marker.length)) : undefined;
        currentEntry = path;
        if (!['0', '5', '2'].includes(type)) throw failure('INK_TOOLCHAIN_ARCHIVE', `Unsupported Rust archive entry type ${type}.`);
        if (selected && type === '5') await mkdir(join(prefix, path), { recursive: true, mode: 0o700 });
        else if (selected && type === '2') {
          if (isAbsolute(link) || link.includes('\\') || !inside(prefix, resolve(dirname(join(prefix, path)), link))) throw failure('INK_TOOLCHAIN_ARCHIVE', 'Unsafe Rust archive link.');
          links.push({ path, link });
        }
        let handle, hash, duplicate;
        if (selected && type === '0') {
          await mkdir(dirname(join(prefix, path)), { recursive: true, mode: 0o700 });
          const mode = number(header.subarray(100, 108)) & 0o111 ? 0o700 : 0o600;
          try { handle = await open(join(prefix, path), 'wx', mode); }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const info = await lstat(join(prefix, path));
            if (!info.isFile() || info.size !== size || (info.mode & 0o111 ? 0o700 : 0o600) !== mode) throw Object.assign(failure('INK_TOOLCHAIN_ARCHIVE_CONFLICT', 'Rust components contain incompatible entries at the same relative path.'), { archiveReason: 'duplicate-type-size-or-mode' });
            duplicate = true;
          }
          hash = createHash('sha256');
        }
        try { for (let remaining = size; remaining;) { const count = Math.min(remaining, 65536), bytes = await read(count); hash?.update(bytes); if (handle) await handle.writeFile(bytes); remaining -= count; } }
        finally { await handle?.close(); }
        if (hash) {
          const sha256 = hash.digest('hex');
          if (duplicate) {
            if (await digest(join(prefix, path)) !== sha256) throw Object.assign(failure('INK_TOOLCHAIN_ARCHIVE_CONFLICT', 'Rust components contain different bytes at the same relative path.'), { archiveReason: 'duplicate-content-mismatch' });
          } else inventory.push({ path, sha256 });
        }
        await read((512 - size % 512) % 512);
      }
      // Exhaust gzip to validate its checksum and bound trailing compressed data.
      if (buffer.some(byte => byte !== 0)) throw failure('INK_TOOLCHAIN_ARCHIVE', 'Unexpected trailing Rust archive data.');
      while (true) {
        const next = await iterator.next(); if (next.done) break;
        budget.expanded += next.value.length;
        if (budget.expanded > this.maxExpandedBytes) throw failure('INK_TOOLCHAIN_ARCHIVE_LIMIT', 'Expanded Rust distribution exceeds its size limit.');
        if (next.value.some(byte => byte !== 0)) throw failure('INK_TOOLCHAIN_ARCHIVE', 'Unexpected trailing Rust archive data.');
      }
      for (const item of links) {
        currentEntry = item.path;
        await mkdir(dirname(join(prefix, item.path)), { recursive: true, mode: 0o700 });
        try { await symlink(item.link, join(prefix, item.path)); inventory.push(item); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (!(await lstat(join(prefix, item.path))).isSymbolicLink() || await readlink(join(prefix, item.path)) !== item.link) throw Object.assign(failure('INK_TOOLCHAIN_ARCHIVE_CONFLICT', 'Rust components contain incompatible links at the same relative path.'), { archiveReason: 'duplicate-link-mismatch' });
        }
      }
    } catch (error) {
      const filesystemCode = typeof error.code === 'string' && /^E[A-Z0-9_]{1,30}$/.test(error.code);
      const result = filesystemCode ? failure(error.code === 'EEXIST' ? 'INK_TOOLCHAIN_ARCHIVE_CONFLICT' : 'INK_TOOLCHAIN_ARCHIVE_IO', 'Rust archive materialization failed at a relative distribution entry.') : error;
      if (currentEntry) result.archiveEntry = currentEntry.slice(0, 240);
      result.archiveComponent = component.name;
      result.archiveReason = error.archiveReason || (filesystemCode ? error.code.toLowerCase() : 'archive-validation-failed');
      throw result;
    } finally { stream.destroy(); input.destroy(); }
  }
}
