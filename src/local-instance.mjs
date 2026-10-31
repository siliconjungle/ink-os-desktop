import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';

function localURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('The saved local instance address is invalid.');
  return url;
}
export async function localPort(directory) {
  try { return Number(localURL(JSON.parse(await readFile(join(directory, 'client.json'), 'utf8')).url).port); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
const processAlive = pid => { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

export class LocalInstance {
  constructor({ platformDirectory, directory, port, executable = process.execPath, electron = false }) {
    Object.assign(this, { platformDirectory: resolve(platformDirectory), directory: resolve(directory), port, executable, electron });
  }
  get running() { return this.attached || Number.isInteger(this.process?.pid) && this.process.exitCode === null && this.process.signalCode === null; }
  start() {
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.starting) return this.starting;
    if (!this.attached && this.running && this.client) return Promise.resolve(this.client);
    this.starting = this.launch().catch(async error => { await this.stop(); throw error; }).finally(() => { this.starting = null; });
    return this.starting;
  }
  async launch() {
    this.failure = undefined; this.client = undefined; this.attached = false;
    const existing = await this.attachExisting();
    if (existing) return existing;
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(INK_|FLY_|AWS_|S3_|BUCKET_NAME)/.test(name)));
    Object.assign(env, { NODE_ENV: 'production', PORT: String(this.port), INK_OS_DATA_DIR: this.directory, INK_OS_HOSTING: 'local', ...(this.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) });
    this.process = spawn(this.executable, [join(this.platformDirectory, 'scripts/start.mjs')], { cwd: this.platformDirectory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.output = '';
    this.process.stdout.on('data', bytes => this.output = (this.output + bytes).slice(-8192));
    this.process.stderr.on('data', bytes => this.output = (this.output + bytes).slice(-8192));
    this.process.on('error', error => { this.failure = error; });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (this.failure || this.process.exitCode !== null || this.process.signalCode !== null) throw Error('Local instance failed to start: ' + (this.failure?.message || this.output));
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          const client = JSON.parse(await readFile(join(this.directory, 'client.json'), 'utf8'));
          const health = await response.json();
          if (health.instanceId !== client.instanceId || client.hostPid !== this.process.pid || health.draining || localURL(client.url).origin !== `http://127.0.0.1:${this.port}`) continue;
          const auth = await fetch(client.url + '/api/v1/me', { headers: { authorization: 'Bearer ' + client.token }, redirect: 'error', signal: AbortSignal.timeout(1000) });
          if (auth.ok) return this.client = client;
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Local instance did not become ready.');
  }
  async attachExisting() {
    let client, identity;
    try { client = JSON.parse(await readFile(join(this.directory, 'client.json'), 'utf8')); identity = JSON.parse(await readFile(join(this.directory, 'instance.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const url = localURL(client.url);
    if (client.token !== identity.adminToken) throw Error('Local credentials do not match this instance.');
    let response;
    try { response = await fetch(url.origin + '/api/health', { redirect: 'error', signal: AbortSignal.timeout(1000) }); }
    catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED') throw Error('The saved local address did not respond. Close its existing host before starting another one.');
      if (processAlive(client.hostPid)) throw Error('The existing local host is still starting or stopping. Its process was preserved.');
      return null;
    }
    const health = await response.json();
    if (!response.ok || health.instanceId !== identity.id) throw Error('The saved local address belongs to another service. No credentials were sent.');
    if (health.draining) throw Error('The existing local host is finishing background jobs before stopping.');
    const auth = await fetch(url.origin + '/api/v1/me', { headers: { authorization: 'Bearer ' + client.token }, redirect: 'error', signal: AbortSignal.timeout(1000) });
    if (!auth.ok) throw Error('Local instance authentication failed.');
    this.port = Number(url.port); this.process = undefined; this.attached = true;
    return this.client = { ...client, instanceId: identity.id };
  }
  stop() {
    if (this.stopping) return this.stopping;
    if (this.attached) { this.attached = false; this.client = undefined; return Promise.resolve(); }
    if (!this.running) return Promise.resolve();
    const child = this.process;
    this.stopping = new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); }).finally(() => { this.stopping = null; this.client = undefined; });
    return this.stopping;
  }
}
