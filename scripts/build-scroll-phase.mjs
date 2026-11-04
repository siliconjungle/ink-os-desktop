import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('../native/scroll-phase.mm', import.meta.url));

export async function buildScrollPhase(output) {
  if (process.platform !== 'darwin') return;
  const headers = process.env.INK_OS_NODE_HEADERS || resolve(dirname(process.execPath), '../include/node');
  await access(resolve(headers, 'node_api.h'));
  await mkdir(dirname(output), {recursive:true});
  await execute('xcrun', ['clang++', '-std=c++17', '-fblocks', '-fobjc-arc', '-shared', '-fPIC', '-undefined', 'dynamic_lookup',
    '-DNAPI_VERSION=8', '-DNODE_GYP_MODULE_NAME=ink_scroll_phase', '-I'+headers,
    '-framework', 'AppKit', source, '-o', output]);
}
