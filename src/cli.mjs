import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { ConnectionStore } from './connections.mjs';
import { canonicalProfileDirectory, connectionLayout, connectionOwnerHelpers } from './connection-layout.mjs';
import { runtimeEnvironment } from './runtime.mjs';

export function hasExplicitConnection(args, environment) {
  return ['INK_OS_CONFIG', 'INK_OS_URL', 'INK_OS_TOKEN'].some(key => Object.hasOwn(environment, key)) || args.some(argument => argument === '--url' || argument.startsWith('--url='));
}
export async function runDesktopCLI({ args = process.argv.slice(2), environment = process.env, resources = fileURLToPath(new URL('..', import.meta.url)), layout, storeFactory = options => new ConnectionStore(options), ownerHelpers = connectionOwnerHelpers, platformMain } = {}) {
  if(args[0]==='desktop'&&args[1]==='update')return(await import('./updates.mjs')).desktopUpdateCLI({args:args.slice(2),environment,directory:await canonicalProfileDirectory(environment)});
  layout ||= await connectionLayout({ applicationRoot: resources, resources, environment });
  if (layout.packaged && !environment.INK_OS_GIT_ROOT) environment.INK_OS_GIT_ROOT = join(layout.resources, 'git');
  if (!hasExplicitConnection(args, environment)) {
    if (args[0] === 'login') throw Error('Use Connections to update desktop credentials, or select an explicit INK_OS_CONFIG for an independent CLI login');
    const directory = await canonicalProfileDirectory(environment), helpers = await ownerHelpers(layout), store = await storeFactory({ directory, ...helpers }).open();
    const prepared = await store.activeSelection();
    const offlineCommand = !args.length || ['help', 'init', 'build', 'backup', '--help', '-h'].includes(args[0]);
    const selection = offlineCommand ? prepared : await store.resolveCLI();
    environment.INK_OS_CONFIG = selection.clientConfigPath;
    if (selection.kind === 'local') Object.assign(environment, runtimeEnvironment(layout.resources, { directory: selection.instanceDirectory, development: layout.development }));
  }
  if (!platformMain && environment !== process.env) throw Error('An injected environment requires an injected CLI runner');
  const main = platformMain || (await import(layout.platformCLI)).main;
  return main(args, environment);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runDesktopCLI().catch(error => { console.error(error.message); process.exitCode = 1; });
