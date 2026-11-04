import {bindFrameWheelBridge} from './frame-wheel-bridge.mjs';
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
  const contents = window.webContents;
  const disposeFrames = bindFrameWheelBridge(contents, origin);
  const publishActivity = () => {
    try {
      if (!window.isDestroyed() && new URL(contents.getURL()).origin === new URL(origin).origin) contents.send('ink:desktop-active', window.isFocused());
    } catch {}
  };
  const gestureStart = (_event, input) => {
    if (input.type === 'gestureScrollBegin' && window.isFocused()) contents.send('ink:desktop-gesture-start');
  };
  window.on('focus', publishActivity);
  window.on('blur', publishActivity);
  contents.on('did-finish-load', publishActivity);
  contents.on('input-event', gestureStart);
  let last = -Infinity;
  const swipe = (_event, direction) => {
    if (!enabled() || !['left', 'right'].includes(direction)) return;
    const time = now();
    if (time - last < 400) return;
    if (sendDesktopSwipe(window, direction, origin)) last = time;
  };
  const dispose = () => {
    window.removeListener('swipe', swipe); window.removeListener('closed', dispose);
    window.removeListener('focus', publishActivity); window.removeListener('blur', publishActivity);
    contents.removeListener('did-finish-load', publishActivity); contents.removeListener('input-event', gestureStart);
    disposeFrames();
  };
  window.on('swipe', swipe);
  window.once('closed', dispose);
  return dispose;
}
