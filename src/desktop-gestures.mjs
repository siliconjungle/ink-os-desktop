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

export function bindDesktopSwipes(window, {origin, enabled = () => true, now = () => performance.now(), scrollGeneration, schedule=setTimeout, unschedule=clearTimeout} = {}) {
  const contents = window.webContents;
  const disposeFrames = bindFrameWheelBridge(contents, origin);
  const publishActivity = () => {
    try {
      if (!window.isDestroyed() && new URL(contents.getURL()).origin === new URL(origin).origin) contents.send('ink:desktop-active', window.isFocused());
    } catch {}
  };
  let generation = scrollGeneration?.();
  let releaseTimer, waitingForRelease=false,lastX=0,lastY=0;
  const publishEnd=cancelled=>{
    if(!waitingForRelease)return;
    waitingForRelease=false;unschedule(releaseTimer);
    try {if(!window.isDestroyed()&&new URL(contents.getURL()).origin===new URL(origin).origin)contents.send('ink:desktop-gesture-end',cancelled===true);}catch{}
  };
  const pollRelease=()=>{
    if(!waitingForRelease)return;
    if(window.isDestroyed()||!window.isFocused()){publishEnd(true);return;}
    const state=scrollGeneration.state();
    if(state.generation===generation&&(state.x!==lastX||state.y!==lastY)){
      lastX=state.x;lastY=state.y;
      try{if(new URL(contents.getURL()).origin===new URL(origin).origin&&!window.getChildWindows().some(child=>child.isVisible()))contents.send('ink:desktop-gesture-move',{x:lastX,y:lastY});}catch{}
    }
    // Poll physical state even while the trackpad is held motionless. No idle timeout.
    if(state.ended===generation){publishEnd(state.cancelled);return;}
    releaseTimer=schedule(pollRelease,8);
  };
  const gestureStart = (_event, input) => {
    let began = input.type === 'gestureScrollBegin' && !scrollGeneration;
    if (input.type === 'mouseWheel' && scrollGeneration) {
      const next = scrollGeneration();
      began = next !== generation;
      generation = next;
    }
    if (began && window.isFocused() && !window.getChildWindows().some(child => child.isVisible())) {
      try {if (new URL(contents.getURL()).origin === new URL(origin).origin) {
        publishEnd(false);contents.send('ink:desktop-gesture-start');
        if(scrollGeneration?.state){lastX=0;lastY=0;waitingForRelease=true;releaseTimer=schedule(pollRelease,8);}
      }} catch {}
    }
    if(!scrollGeneration?.state&&['gestureScrollEnd','gestureScrollCancel'].includes(input.type)){
      waitingForRelease=true;publishEnd(input.type==='gestureScrollCancel');
    }
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
    unschedule(releaseTimer);waitingForRelease=false;
    window.removeListener('swipe', swipe); window.removeListener('closed', dispose);
    window.removeListener('focus', publishActivity); window.removeListener('blur', publishActivity);
    contents.removeListener('did-finish-load', publishActivity); contents.removeListener('input-event', gestureStart);
    disposeFrames();
  };
  window.on('swipe', swipe);
  window.once('closed', dispose);
  return dispose;
}
