import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { LocalInstance } from '../src/local-instance.mjs';

test('desktop lifecycle owns a clean local instance and authenticates with its generated credential', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ink-desktop-'));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const instance = new LocalInstance({ platformDirectory: process.env.INK_OS_PLATFORM_DIR || resolve('../ink-os-platform'), directory, port });
  t.after(async () => { await instance.stop(); await rm(directory, { recursive: true, force: true }); });
  const client = await instance.start();
  const response = await fetch(client.url + '/api/v1/apps', { headers: { authorization: 'Bearer ' + client.token } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  assert.equal((await fetch(client.url + '/api/v1/apps')).status, 401);
  await instance.stop();
  assert.notEqual(instance.process.exitCode, undefined);
});
