import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runtimeEnvironment } from '../src/runtime.mjs';

test('packaged owner runtime selects plain bundled installer and its own profile cache', () => {
  const resources = join('/desktop', 'Resources'), directory = join('/private-profile', 'instances/default');
  const environment = runtimeEnvironment(resources, { directory });
  assert.equal(environment.INK_OS_GIT_ROOT, join(resources, 'git'));
  assert.equal(environment.INK_OS_MANAGED_NATIVE_MODULE, join(resources, 'tools/native-toolchain.mjs'));
  assert.equal(environment.INK_OS_MANAGED_NATIVE_DIRECTORY, join(directory, 'native-toolchains'));
  assert.equal(Object.values(environment).some(value => value.includes('.asar')), false);
});

test('development runtime selects the checked-out owner installer without pointing Git at absent bundled tools', () => {
  const root = join('/workspace', 'desktop'), directory = join('/profile', 'instance');
  const environment = runtimeEnvironment(root, { directory, development: true });
  assert.equal(environment.INK_OS_GIT_ROOT, undefined);
  assert.equal(environment.INK_OS_MANAGED_NATIVE_MODULE, join(root, 'src/native-toolchain.mjs'));
  assert.equal(environment.INK_OS_MANAGED_NATIVE_DIRECTORY, join(directory, 'native-toolchains'));
  assert.equal(environment.INK_NATIVE_CARGO, undefined); assert.equal(environment.INK_NATIVE_RUSTC, undefined);
});
