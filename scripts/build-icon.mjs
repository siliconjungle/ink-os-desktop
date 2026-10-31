import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const source = new URL('../assets/icon.svg', import.meta.url);
export async function iconPNG(size) {
  return new Resvg(await readFile(source), { fitTo: { mode: 'width', value: size } }).render().asPng();
}
export async function buildIcon(directory) {
  await mkdir(directory, { recursive: true });
  const png = join(directory, 'icon.png'); await writeFile(png, await iconPNG(512));
  if (process.platform !== 'darwin') return { png };
  const iconset = join(directory, 'icon.iconset'); await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    await writeFile(join(iconset, `icon_${size}x${size}.png`), await iconPNG(size));
    await writeFile(join(iconset, `icon_${size}x${size}@2x.png`), await iconPNG(size * 2));
  }
  const icns = join(directory, 'icon.icns');
  await promisify(execFile)('iconutil', ['-c', 'icns', '-o', icns, iconset]);
  return { png, icns };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(new URL('../assets/icon.png', import.meta.url), await iconPNG(512));
}
