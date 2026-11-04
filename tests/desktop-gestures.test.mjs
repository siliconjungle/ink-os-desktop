import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, readFile, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {DesktopGestureSettings, sendDesktopSwipe, bindDesktopSwipes} from '../src/desktop-gestures.mjs';

function fixture() {
  const window = new EventEmitter(), sent = [];
  let url = 'https://ink.example/', focused = true, destroyed = false, children = [];
  Object.assign(window, {webContents:{getURL:() => url, send:(...args) => sent.push(args)}, isFocused:() => focused, isDestroyed:() => destroyed, getChildWindows:() => children});
  return {window, sent, url:value => url=value, focused:value => focused=value, destroyed:value => destroyed=value, children:value => children=value};
}
test('native horizontal swipes reach only a focused desktop on the selected origin', () => {
  const f = fixture();
  for (const direction of ['up','down','unknown',1]) assert.equal(sendDesktopSwipe(f.window, direction, 'https://ink.example'), false);
  assert.equal(sendDesktopSwipe(f.window, 'left', 'https://ink.example'), true);
  f.focused(false); assert.equal(sendDesktopSwipe(f.window, 'right', 'https://ink.example'), false);
  f.focused(true); f.url('https://other.example'); assert.equal(sendDesktopSwipe(f.window, 'right', 'https://ink.example'), false);
  f.url('https://ink.example'); f.children([{isVisible:() => true}]); assert.equal(sendDesktopSwipe(f.window, 'right', 'https://ink.example'), false);
  f.children([]); f.destroyed(true); assert.equal(sendDesktopSwipe(f.window, 'right', 'https://ink.example'), false);
  assert.deepEqual(f.sent, [['ink:desktop-swipe','left']]);
});
test('swipe listeners honor the setting, debounce duplicate events and clean up', () => {
  const f = fixture(); let time = 0, enabled = true;
  bindDesktopSwipes(f.window, {origin:'https://ink.example', enabled:() => enabled, now:() => time});
  f.window.emit('swipe', {}, 'left'); time=100; f.window.emit('swipe', {}, 'left');
  time=500; f.window.emit('swipe', {}, 'right');
  enabled=false; time=1000; f.window.emit('swipe', {}, 'left');
  assert.deepEqual(f.sent, [['ink:desktop-swipe','left'],['ink:desktop-swipe','right']]);
  f.window.emit('closed'); assert.equal(f.window.listenerCount('swipe'), 0);
});
test('desktop gesture preferences survive restart with private file permissions', async t => {
  const directory = await mkdtemp(join(tmpdir(),'ink-gestures-')); t.after(() => rm(directory,{recursive:true,force:true}));
  const settings = await new DesktopGestureSettings(directory).open(); assert.equal(settings.enabled, false);
  await Promise.all([settings.setEnabled(false), settings.setEnabled(true), settings.setEnabled(false)]);
  assert.equal((await new DesktopGestureSettings(directory).open()).enabled, false);
  assert.equal((await stat(settings.file)).mode & 0o777, 0o600);
});
test('sandboxed preload exposes a direction-only subscription and can unsubscribe', async () => {
  const ipc = new EventEmitter(); let api;
  const source = await readFile(new URL('../src/desktop-preload.cjs', import.meta.url),'utf8');
  runInNewContext(source, {require:name => {assert.equal(name,'electron'); return {ipcRenderer:ipc,contextBridge:{exposeInMainWorld:(name,value) => {assert.equal(name,'inkDesktopGestures'); api=value;}}};}});
  const received = [], unsubscribe = api.onSwipe(value => received.push(value));
  ipc.emit('ink:desktop-swipe', {}, 'left'); ipc.emit('ink:desktop-swipe', {}, 'up'); ipc.emit('ink:desktop-swipe', {}, {direction:'right'});
  unsubscribe(); ipc.emit('ink:desktop-swipe', {}, 'right');
  assert.deepEqual(received, ['left']); assert.deepEqual(Object.keys(api), ['onSwipe']);
});
