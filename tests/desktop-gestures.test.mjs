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
  const contents = new EventEmitter();
  Object.assign(contents, {getURL:() => url, send:(...args) => sent.push(args), mainFrame:{framesInSubtree:[]}});
  Object.assign(window, {webContents:contents, isFocused:() => focused, isDestroyed:() => destroyed, getChildWindows:() => children});
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
  assert.deepEqual(received, ['left']); assert.deepEqual(Object.keys(api), ['isActive','onGestureStart','onSwipe','onGestureEnd','onGestureMove']);
  assert.equal(api.isActive(),false);
  ipc.emit('ink:desktop-active', {}, true); assert.equal(api.isActive(),true);
  ipc.emit('ink:desktop-active', {}, false); assert.equal(api.isActive(),false);
  let starts=0; const stop=api.onGestureStart(()=>starts++);
  ipc.emit('ink:desktop-gesture-start', {}); stop(); ipc.emit('ink:desktop-gesture-start', {});
  assert.equal(starts,1);
  const phases=[],stopEnd=api.onGestureEnd(value=>phases.push(value)),stopMove=api.onGestureMove(value=>phases.push([value.x,value.y]));
  ipc.emit('ink:desktop-gesture-move',{}, {x:12,y:-30});ipc.emit('ink:desktop-gesture-move',{}, {x:Infinity,y:1});
  ipc.emit('ink:desktop-gesture-end',{}, true);stopEnd();stopMove();ipc.emit('ink:desktop-gesture-end',{}, false);
  assert.deepEqual(phases,[[12,-30],true]);
});

test('foreground state follows the native window and gesture starts are independent of internal app selection', () => {
  const f=fixture();
  bindDesktopSwipes(f.window,{origin:'https://ink.example',enabled:()=>false});
  f.window.webContents.emit('did-finish-load');
  f.window.webContents.emit('input-event',{}, {type:'gestureScrollBegin'});
  f.focused(false); f.window.emit('blur');
  f.window.webContents.emit('input-event',{}, {type:'gestureScrollBegin'});
  f.focused(true); f.window.emit('focus');
  f.window.webContents.emit('input-event',{}, {type:'gestureScrollBegin'});
  assert.deepEqual(f.sent,[['ink:desktop-active',true],['ink:desktop-gesture-start'],['ink:desktop-active',false],['ink:desktop-active',true],['ink:desktop-gesture-start']]);
  f.window.emit('closed');
  assert.equal(f.window.webContents.listenerCount('input-event'),0);
});

test('physical Mac scroll starts rearm rapid swipes without clicks or synthetic gesture events', () => {
  const f=fixture(); let generation=0;
  bindDesktopSwipes(f.window,{origin:'https://ink.example',enabled:()=>false,scrollGeneration:()=>generation});
  const wheel=()=>f.window.webContents.emit('input-event',{}, {type:'mouseWheel'});
  generation++; wheel(); // First physical swipe.
  wheel(); wheel(); // Movement and momentum do not rearm it.
  generation++; wheel(); // Another swipe while the old momentum is still arriving.
  wheel();
  generation++; wheel(); // Same direction also starts a new gesture.
  f.window.webContents.emit('input-event',{}, {type:'gestureScrollBegin'}); // No double reset.
  assert.deepEqual(f.sent,Array.from({length:3},()=>['ink:desktop-gesture-start']));
  f.focused(false); generation++; wheel();
  f.focused(true); f.url('https://other.example/'); generation++; wheel();
  f.url('https://ink.example/'); f.children([{isVisible:()=>true}]); generation++; wheel();
  assert.equal(f.sent.length,3);
  f.window.emit('closed'); generation++; wheel();
  assert.equal(f.sent.length,3);
});


test('physical movement and release continue through paused fingers and consumed renderer wheel events',()=>{
  const f=fixture(),queue=new Set();let state={generation:0,ended:0,cancelled:false,x:0,y:0};
  const generation=()=>state.generation;generation.state=()=>state;
  bindDesktopSwipes(f.window,{origin:'https://ink.example',scrollGeneration:generation,schedule:callback=>{queue.add(callback);return callback;},unschedule:callback=>queue.delete(callback)});
  const tick=()=>{const callback=queue.values().next().value;queue.delete(callback);callback?.();};
  state={generation:1,ended:0,cancelled:false,x:40,y:0};
  f.window.webContents.emit('input-event',{}, {type:'mouseWheel'});tick();
  for(let i=0;i<100;i++)tick();
  assert.deepEqual(f.sent,[['ink:desktop-gesture-start'],['ink:desktop-gesture-move',{x:40,y:0}]],'A held trackpad must not be treated as release');
  // Native state advances even if the old app frame has been parked by a preview.
  state.x=100;tick();state.ended=1;tick();
  assert.deepEqual(f.sent.slice(-2),[['ink:desktop-gesture-move',{x:100,y:0}],['ink:desktop-gesture-end',false]]);
  assert.equal(queue.size,0);
  state={generation:2,ended:1,cancelled:false,x:-50,y:0};f.window.webContents.emit('input-event',{}, {type:'mouseWheel'});tick();
  state.ended=2;state.cancelled=true;tick();
  assert.deepEqual(f.sent.slice(-1),[['ink:desktop-gesture-end',true]]);
  f.window.emit('closed');assert.equal(queue.size,0);
});
