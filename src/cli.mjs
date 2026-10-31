import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { profileDirectory, runtimeEnvironment } from './runtime.mjs';

const resources = fileURLToPath(new URL('..', import.meta.url));
Object.assign(process.env, runtimeEnvironment(resources));
process.env.INK_OS_CONFIG ||= join(profileDirectory(), 'instances', 'default', 'client.json');
const { main } = await import(new URL('../platform/cli/bin/ink-os.mjs', import.meta.url));
await main().catch(error => { console.error(error.message); process.exitCode = 1; });
