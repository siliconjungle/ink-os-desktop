import { packager } from '@electron/packager';
import { buildIcon } from './build-icon.mjs';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { mkdir, mkdtemp, readFile, writeFile, cp, readdir, lstat, readlink, access, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile), require = createRequire(import.meta.url);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async name => JSON.parse(await readFile(name, 'utf8'));
const run = async (program, args, cwd) => {
  console.log([program, ...args].join(' '));
  const child = spawn(program, args, { cwd, stdio: 'inherit' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(program + ' exited ' + code))); });
};
async function inventory(directory) {
  const entries = [];
  async function visit(current) {
    for (const name of (await readdir(current)).sort()) {
      const full = join(current, name), info = await lstat(full), path = relative(directory, full).split(sep).join('/');
      if (info.isDirectory()) await visit(full);
      else if (info.isSymbolicLink()) {
        const target = await readlink(full), inside = relative(directory, resolve(dirname(full), target));
        if (inside === '..' || inside.startsWith('..' + sep) || target.startsWith('/')) throw Error('External packaged symlink: ' + path);
        await access(full);
        entries.push({ path, link: target });
      } else if (info.isFile()) entries.push({ path, bytes: info.size, executable: !!(info.mode & 0o111), sha256: digest(await readFile(full)) });
      else throw Error('Unsupported packaged file: ' + path);
    }
  }
  await visit(directory); return entries;
}
async function retention(path, reason, completed = false) {
  const name = join(root, 'storage-retention.json'), saved = await json(name), key = relative(root, path).split(sep).join('/');
  delete saved.keep[key]; delete saved.safe_to_remove[key];
  saved[completed ? 'safe_to_remove' : 'keep'][key] = reason;
  await writeFile(name, JSON.stringify(saved, null, 2) + '\n');
}
async function sourceArchives(directory) {
  const sources = await json(join(root, 'upstream-sources.json'));
  const cache = join(root, '.local', 'upstream-sources'); await mkdir(cache, { recursive: true });
  await retention(cache, 'Pinned corresponding Git source and build recipe archives used by the active packaging implementation.');
  for (const source of sources) {
    const name = join(cache, source.name + '.tar.gz'); let bytes;
    try { bytes = await readFile(name); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!bytes || digest(bytes) !== source.sha256) {
      const response = await fetch(source.url); if (!response.ok) throw Error('Source download failed: ' + source.name);
      bytes = Buffer.from(await response.arrayBuffer());
      if (digest(bytes) !== source.sha256) throw Error('Source archive integrity check failed: ' + source.name);
      await writeFile(name, bytes);
    }
    await cp(name, join(directory, source.name + '.tar.gz'));
  }
  await writeFile(join(directory, 'sources.json'), JSON.stringify(sources, null, 2) + '\n');
}
async function bundledGit(directory) {
  const base = dirname(require.resolve('dugite/package.json')), source = join(base, 'git');
  try { await access(join(source, 'bin', 'git')); }
  catch { await run(process.execPath, [join(base, 'script', 'download-git.js')], root); }
  await mkdir(join(directory, 'bin'), { recursive: true });
  await cp(join(source, 'bin', 'git'), join(directory, 'bin', 'git'));
  await cp(join(source, 'share', 'git-core'), join(directory, 'share', 'git-core'), { recursive: true });
  await mkdir(join(directory, 'libexec', 'git-core'), { recursive: true });
  for (const name of await readdir(join(source, 'libexec', 'git-core'))) {
    if (!(name === 'git' || name.startsWith('git-')) || name.startsWith('git-credential-manager') || name === 'git-lfs') continue;
    await cp(join(source, 'libexec', 'git-core', name), join(directory, 'libexec', 'git-core', name), { verbatimSymlinks: true });
  }
  if (process.platform === 'linux') await cp(join(source, 'ssl'), join(directory, 'ssl'), { recursive: true });
  const sources = join(directory, 'sources'); await mkdir(sources); await sourceArchives(sources);
  const license = await execute('tar', ['-xOf', join(sources, 'git.tar.gz'), 'git-a018953688f1b10bddf91bff8747068f5f4746a4/COPYING']);
  await writeFile(join(directory, 'COPYING'), license.stdout);
  await cp(join(base, 'LICENSE'), join(directory, 'DUGITE-LICENSE'));
  await writeFile(join(directory, 'SOURCE-NOTICE.txt'), 'Git is distributed under GPL-2.0. Its complete source and the pinned distribution build recipe are included in sources/. The packaged core excludes Git LFS and Git Credential Manager. Runtime prerequisites and their notices come from the host operating system.\n');
  return { version: (await execute(join(directory, 'bin', 'git'), ['--version'])).stdout.trim(), distribution: (await json(join(base, 'script', 'embedded-git.json')))[process.platform + '-' + process.arch] };
}
async function wrapper(buildPath) {
  const directory = process.platform === 'darwin' ? join(buildPath, 'Ink OS.app', 'Contents', 'Resources') : buildPath;
  const script = `#!/bin/sh\nINK_OS_CLI_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexport ELECTRON_RUN_AS_NODE=1\nexec "$INK_OS_CLI_ROOT/${process.platform === 'darwin' ? '../MacOS/' : ''}ink-os-desktop" "$INK_OS_CLI_ROOT/${process.platform === 'darwin' ? '' : 'resources/'}tools/cli.mjs" "$@"\n`;
  await writeFile(join(directory, 'ink-os'), script); await chmod(join(directory, 'ink-os'), 0o755);
}

if (!['darwin', 'linux'].includes(process.platform)) throw Error('This package builder currently supports macOS and Linux hosts.');
process.chdir(root);
if (process.env.INK_OS_MAC_NOTARY_PROFILE && !process.env.INK_OS_MAC_SIGN_IDENTITY) throw Error('Notarization requires an explicit signing identity.');
const pinned = await json(join(root, 'platform.json'));
if (!/^[a-f0-9]{40}$/.test(pinned.commit)) throw Error('Pin a full platform commit.');
const platform = resolve(process.env.INK_OS_PLATFORM_DIR || join(root, '../ink-os-platform'));
await execute('git', ['-C', platform, 'cat-file', '-e', pinned.commit + '^{commit}']);
const pkg = await json(join(root, 'package.json'));
await mkdir(join(root, '.local'), { recursive: true });
const stage = await mkdtemp(join(root, '.local', 'package-'));
await retention(stage, 'Active required desktop packaging workspace; preserve until this build has completed.');
await writeFile(join(stage, 'storage-retention.json'), JSON.stringify({ keep: Object.fromEntries(['source', 'platform', 'app', 'tools', 'git', 'image', 'electron', 'branding', 'storage-retention.json'].map(name => [name, 'Active required packaging input or output; preserve until completion.'])), safe_to_remove: {} }, null, 2) + '\n');
const source = join(stage, 'source'), runtime = join(stage, 'platform'), app = join(stage, 'app'), tools = join(stage, 'tools'), git = join(stage, 'git');
for (const name of [source, runtime, app, tools, git]) await mkdir(name);
const archive = spawn('git', ['-C', platform, 'archive', '--format=tar', pinned.commit]);
const unpack = spawn('tar', ['-xf', '-', '-C', source]);
const result = child => new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('Source snapshot extraction failed.'))); });
await Promise.all([result(archive), result(unpack), pipeline(archive.stdout, unpack.stdin)]);
await run(process.execPath, [join(source, 'scripts', 'audit-source.mjs'), source], source);
await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts'], source);
await run('npm', ['run', 'build'], source);
await run('npm', ['prune', '--omit=dev', '--ignore-scripts'], source);
const runtimePaths = ['server', 'shared', 'generated', 'ink', 'infra', 'app-runtime', 'sdk', 'cli', 'dist', 'node_modules', 'scripts/start.mjs', 'LICENSE', 'package.json', 'package-lock.json'];
for (const name of runtimePaths) { await mkdir(dirname(join(runtime, name)), { recursive: true }); await cp(join(source, name), join(runtime, name), { recursive: true, verbatimSymlinks: true }); }
await run(process.execPath, [join(source, 'scripts', 'audit-source.mjs'), runtime], source);
await cp(join(root, 'src'), join(app, 'src'), { recursive: true });
await mkdir(join(app, 'assets')); await cp(join(root, 'assets', 'icon.svg'), join(app, 'assets', 'icon.svg'));
await cp(join(root, 'LICENSE'), join(app, 'LICENSE'));
await writeFile(join(app, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, license: pkg.license, type: 'module', main: pkg.main }, null, 2) + '\n');
for (const name of ['cli.mjs', 'runtime.mjs', 'native-toolchain.mjs', 'connections.mjs', 'connection-layout.mjs']) await cp(join(root, 'src', name), join(tools, name));
const embedded = await bundledGit(git);
const icon = await buildIcon(join(stage, 'branding'));
const desktopCommit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
const desktopDirty = !!(await execute('git', ['status', '--porcelain', '--', 'package.json', 'package-lock.json', 'src', 'scripts', 'platform.json', 'upstream-sources.json', 'assets', 'LICENSE'], { cwd: root })).stdout.trim();
const manifest = { format: 'ink-os-desktop-package-v1', inventoryPhase: 'before-code-signing', version: pkg.version, platform: process.platform, architecture: process.arch, electron: pkg.devDependencies.electron, platformSource: pinned, desktopSource: { commit: desktopCommit, dirty: desktopDirty }, icon: { sourceSha256: digest(await readFile(join(root, 'assets', 'icon.svg'))), pngSha256: digest(await readFile(icon.png)), ...(icon.icns ? { icnsSha256: digest(await readFile(icon.icns)) } : {}) }, git: embedded, app: await inventory(app), runtime: await inventory(runtime), tools: await inventory(tools), gitFiles: await inventory(git) };
await writeFile(join(tools, 'package-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await mkdir(join(root, 'release'), { recursive: true });
const output = await mkdtemp(join(root, 'release', pkg.version + '-' + process.platform + '-' + process.arch + '-'));
await retention(output, 'Active desktop package output; preserve until packaging and validation complete.');
const runtimeNotices = {};
const [bundle] = await packager({ dir: app, out: output, name: 'Ink OS', executableName: 'ink-os-desktop', appBundleId: 'org.inkos.desktop', extendInfo: { CFBundleDisplayName: 'Ink OS' }, electronVersion: pkg.devDependencies.electron, platform: process.platform, arch: process.arch, asar: true, prune: false, ...(icon.icns ? { icon: icon.icns } : {}), extraResource: [], tmpdir: join(stage, 'electron'), afterCopyExtraResources: [async ({ buildPath }) => { const resources = process.platform === 'darwin' ? join(buildPath, 'Ink OS.app', 'Contents', 'Resources') : join(buildPath, 'resources'); for (const [name, input] of [['platform', runtime], ['tools', tools], ['git', git]]) { await cp(input, join(resources, name), { recursive: true, verbatimSymlinks: true }); await inventory(join(resources, name)); } await cp(icon.png, join(resources, 'icon.png')); const notices = join(resources, 'licenses'); await mkdir(notices); for (const [input, name] of [['LICENSE', 'ELECTRON-LICENSE'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']]) { const bytes = await readFile(join(buildPath, input)); await writeFile(join(notices, name), bytes); runtimeNotices[name] = digest(bytes); } await wrapper(buildPath); }], ...(process.platform === 'darwin' ? { osxSign: { identity: process.env.INK_OS_MAC_SIGN_IDENTITY || '-', ...(process.env.INK_OS_MAC_SIGN_IDENTITY ? { type: 'distribution' } : { identityValidation: false, type: 'development', optionsForFile: () => ({ hardenedRuntime: false }) }), continueOnError: false }, ...(process.env.INK_OS_MAC_NOTARY_PROFILE ? { osxNotarize: { keychainProfile: process.env.INK_OS_MAC_NOTARY_PROFILE } } : {}) } : {}) });
const artifact = join(output, 'ink-os-' + pkg.version + '-' + process.platform + '-' + process.arch + (process.platform === 'darwin' ? '.dmg' : '.tar.gz'));
if (process.platform === 'darwin') {
  await run('codesign', ['--verify', '--deep', '--strict', join(bundle, 'Ink OS.app')], root);
  const executable = join(bundle, 'Ink OS.app', 'Contents', 'MacOS', 'ink-os-desktop');
  const signature = await execute('codesign', ['-d', '-vv', executable]);
  const hardened = /flags=[^\n]*runtime/.test(signature.stderr);
  if (hardened !== !!process.env.INK_OS_MAC_SIGN_IDENTITY) throw Error('The resulting signature does not match the selected development/distribution mode.');
  const version = await execute(executable, ['-p', 'JSON.stringify(process.versions)'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  if (Number(JSON.parse(version.stdout).node.split('.')[0]) < 24) throw Error('Packaged host requires Node 24 or newer.');
  const image = join(stage, 'image'); await mkdir(image);
  await cp(join(bundle, 'Ink OS.app'), join(image, 'Ink OS.app'), { recursive: true, verbatimSymlinks: true });
  const { symlink } = await import('node:fs/promises'); await symlink('/Applications', join(image, 'Applications'));
  await run('hdiutil', ['create', '-volname', 'Ink OS', '-srcfolder', image, '-ov', '-format', 'UDZO', artifact], root);
} else await run('tar', ['-czf', artifact, '-C', bundle, '.'], root);
const evidence = { ...manifest, runtimeNotices, app: undefined, runtime: undefined, tools: undefined, gitFiles: undefined, manifestSha256: digest(await readFile(join(tools, 'package-manifest.json'))), artifact: artifact.split(sep).at(-1), artifactSha256: digest(await readFile(artifact)), bundle: relative(output, bundle).split(sep).join('/'), signing: process.platform === 'darwin' ? process.env.INK_OS_MAC_SIGN_IDENTITY ? 'developer-identity' : 'ad-hoc-development' : 'unsigned', notarized: process.platform === 'darwin' && !!process.env.INK_OS_MAC_NOTARY_PROFILE };
await writeFile(join(output, 'release.json'), JSON.stringify(evidence, null, 2) + '\n');
await writeFile(join(stage, 'storage-retention.json'), JSON.stringify({keep:{'storage-retention.json':'Completed build retention policy.'},safe_to_remove:Object.fromEntries(['source','platform','app','tools','git','image','electron'].map(name=>[name,'Completed generated packaging output; pinned sources, locks and selected artifact are retained.']))},null,2)+'\n');
await retention(stage, 'Completed generated desktop build inputs and image staging; pinned source, dependency locks, builder and selected artifact manifest are retained.', true);
console.log(JSON.stringify({ artifact, bundle, release: join(output, 'release.json') }, null, 2));
