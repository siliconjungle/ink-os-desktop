import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export class LocalInstance {
  constructor({ platformDirectory, directory, port, executable = process.execPath, electron = false }) {
    Object.assign(this, { platformDirectory: resolve(platformDirectory), directory: resolve(directory), port, executable, electron });
  }
  async start() {
    if (this.process) throw Error('This instance is already starting or running.');
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME)/.test(name)));
    Object.assign(env, { NODE_ENV: 'production', PORT: String(this.port), INK_OS_DATA_DIR: this.directory, INK_OS_HOSTING: 'local', ...(this.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) });
    this.process = spawn(this.executable, [join(this.platformDirectory, 'scripts/start.mjs')], { cwd: this.platformDirectory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.output = '';
    this.process.stdout.on('data', bytes => this.output = (this.output + bytes).slice(-8192));
    this.process.stderr.on('data', bytes => this.output = (this.output + bytes).slice(-8192));
    this.process.on('error', error => { this.failure = error; });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (this.failure || this.process.exitCode !== null) throw Error('Local instance failed to start: ' + (this.failure?.message || this.output));
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/api/health`);
        if (response.ok) {
          this.client = JSON.parse(await readFile(join(this.directory, 'client.json'), 'utf8'));
          const auth = await fetch(this.client.url + '/api/v1/me', { headers: { authorization: 'Bearer ' + this.client.token } });
          if (auth.ok) return this.client;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Local instance did not become ready.');
  }
  async stop() {
    if (!this.process || this.process.exitCode !== null || this.process.signalCode !== null) return;
    await new Promise(resolve => { this.process.once('exit', resolve); this.process.kill('SIGTERM'); });
  }
}
