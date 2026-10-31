import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export function profileDirectory(environment = process.env) {
  if (environment.INK_OS_DESKTOP_DATA_DIR) return environment.INK_OS_DESKTOP_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Ink OS');
  if (process.platform === 'win32') return join(environment.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Ink OS');
  return join(environment.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Ink OS');
}

export function runtimeEnvironment(resources, { directory = join(profileDirectory(), 'instances', 'default'), development = false } = {}) {
  resources = resolve(resources); directory = resolve(directory);
  return {
    ...(development ? {} : { INK_OS_GIT_ROOT: join(resources, 'git') }),
    INK_OS_MANAGED_NATIVE_MODULE: join(resources, development ? 'src' : 'tools', 'native-toolchain.mjs'),
    INK_OS_MANAGED_NATIVE_DIRECTORY: join(directory, 'native-toolchains'),
  };
}
