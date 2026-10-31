import { mkdir, realpath, access } from 'node:fs/promises';
import { mkdirSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { profileDirectory } from './runtime.mjs';

export async function canonicalProfileDirectory(environment = process.env, selected = profileDirectory(environment)) {
  const directory = resolve(selected); await mkdir(directory, { recursive: true, mode: 0o700 }); return realpath(directory);
}
// Electron must set sessionData before readiness; do not yield during that setup.
export function canonicalProfileDirectorySync(environment = process.env, selected = profileDirectory(environment)) {
  const directory = resolve(selected); mkdirSync(directory, { recursive: true, mode: 0o700 }); return realpathSync(directory);
}
export async function connectionLayout({ applicationRoot, resources = applicationRoot, packaged, environment = process.env } = {}) {
  if (!applicationRoot) throw Error('Provide the desktop application root');
  if (packaged === undefined) { try { await access(join(resources, 'platform', 'cli', 'bin', 'ink-os.mjs')); packaged = true; } catch { packaged = false; } }
  const platformDirectory = resolve(environment.INK_OS_PLATFORM_DIR || (packaged ? join(resources, 'platform') : join(applicationRoot, '..', 'ink-os-platform')));
  return Object.freeze({ applicationRoot: resolve(applicationRoot), resources: resolve(resources), packaged, development: !packaged, platformDirectory, platformCLI: pathToFileURL(join(platformDirectory, 'cli', 'bin', 'ink-os.mjs')).href, processReceipts: pathToFileURL(join(platformDirectory, 'server', 'process-receipt.mjs')).href });
}
export async function connectionOwnerHelpers(layout, importer = value => import(value)) {
  const module = await importer(layout.processReceipts);
  if (typeof module.captureCurrentProcessReceipt !== 'function' || typeof module.checkProcessReceipt !== 'function') throw Error('The bundled platform is missing connection ownership support');
  return { captureOwner: module.captureCurrentProcessReceipt, checkOwner: module.checkProcessReceipt };
}
