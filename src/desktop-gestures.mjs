import {readFile, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';

export class DesktopGestureSettings {
  constructor(directory) {this.file = join(directory, 'desktop-gestures.json'); this.enabled = false; this.saving = Promise.resolve();}
  async open() {
    try {this.enabled = JSON.parse(await readFile(this.file, 'utf8')).enabled === true;}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
    return this;
  }
  setEnabled(value) {
    const enabled = value === true;
    const saved = this.saving.then(async () => {
      const temporary = this.file + '.tmp';
      await writeFile(temporary, JSON.stringify({enabled}) + '\n', {mode:0o600});
      await rename(temporary, this.file);
      this.enabled = enabled;
    });
    this.saving = saved.catch(() => {});
    return saved;
  }

}

/** The main process sends only a direction to the trusted desktop's main frame. */
export function sendDesktopSwipe(window, direction, origin) {
  if (!['left', 'right'].includes(direction) || !window || window.isDestroyed() || !window.isFocused()) return false;
  try {if (new URL(window.webContents.getURL()).origin !== new URL(origin).origin) return false;} catch {return false;}
  if (window.getChildWindows().some(child => child.isVisible())) return false;
  window.webContents.send('ink:desktop-swipe', direction);
  return true;
}

export function bindDesktopSwipes(window, {origin, enabled = () => true, now = () => performance.now()} = {}) {
  let last = -Infinity;
  const swipe = (_event, direction) => {
    if (!enabled() || !['left', 'right'].includes(direction)) return;
    const time = now();
    if (time - last < 400) return;
    if (sendDesktopSwipe(window, direction, origin)) last = time;
  };
  const dispose = () => {window.removeListener('swipe', swipe); window.removeListener('closed', dispose);};
  window.on('swipe', swipe);
  window.once('closed', dispose);
  return dispose;
}
