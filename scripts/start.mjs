import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';

const require = createRequire(import.meta.url);
function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
let executable;
try { executable = require('electron'); await access(executable); }
catch {
  console.log('Installing the pinned Electron runtime.');
  const installed = await run(process.execPath, [require.resolve('electron/install.js')]);
  if (installed.code !== 0) throw Error('Electron installation failed. Retry npm start when the download is available.');
  delete require.cache[require.resolve('electron')];
  executable = require('electron'); await access(executable);
}
const result = await run(executable, ['.', ...process.argv.slice(2)]);
process.exitCode = result.code ?? 1;
