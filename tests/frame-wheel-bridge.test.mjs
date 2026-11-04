import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runInNewContext} from 'node:vm';
import {installFrameWheelBridge,bindFrameWheelBridge} from '../src/frame-wheel-bridge.mjs';

function page() {
  const listeners=new Map(),messages=[],child={},parent={postMessage:(...args)=>messages.push(args)};
  const window={parent, addEventListener:(name,fn)=>listeners.set(name,fn)};
  runInNewContext('('+installFrameWheelBridge.toString()+')()', {window, document:{querySelectorAll:()=>[{contentWindow:child}]}});
  return {window,listeners,messages,child};
}
test('app and nested frames forward trusted wheel input without app selection or native APIs', () => {
  const p=page(); let prevented=0;
  p.listeners.get('wheel')({isTrusted:true,deltaX:90,deltaY:1,deltaMode:0,preventDefault:()=>prevented++,stopImmediatePropagation:()=>{}});
  assert.equal(prevented,1); assert.equal(p.messages.length,1); assert.equal(p.messages[0][0].deltaX,90);
  p.listeners.get('wheel')({isTrusted:true,deltaX:0,deltaY:90,deltaMode:0,preventDefault:()=>prevented++});
  assert.equal(prevented,1); assert.equal(p.messages.length,2);
  p.listeners.get('wheel')({isTrusted:false,deltaX:100,deltaY:0,deltaMode:0}); assert.equal(p.messages.length,2);
  p.listeners.get('message')({source:p.child,data:p.messages[0][0]}); assert.equal(p.messages.length,3);
  p.listeners.get('message')({source:{},data:p.messages[0][0]}); assert.equal(p.messages.length,3);
});
test('pinch zoom and malformed wheel input cannot claim the desktop gesture', () => {
  const p=page(); let prevented=0;
  p.listeners.get('wheel')({isTrusted:true,deltaX:100,deltaY:0,deltaMode:0,ctrlKey:true,preventDefault:()=>prevented++});
  p.listeners.get('wheel')({isTrusted:true,deltaX:Infinity,deltaY:0,deltaMode:0,preventDefault:()=>prevented++});
  assert.equal(prevented,0); assert.equal(p.messages.length,1);
});
test('native frame bridge is installed after each document load and removed on disposal', async () => {
  const contents=new EventEmitter(),frame=new EventEmitter(),code=[];
  Object.assign(frame,{isDestroyed:()=>false,detached:false,executeJavaScript:async value=>{code.push(value);}});
  Object.assign(contents,{getURL:()=> 'https://ink.example/',mainFrame:{framesInSubtree:[]}});
  const dispose=bindFrameWheelBridge(contents,'https://ink.example');
  contents.emit('frame-created',{}, {frame});
  frame.emit('dom-ready'); frame.emit('dom-ready');
  assert.equal(code.length,2); assert.ok(code[0].includes('installFrameWheelBridge'));
  dispose(); frame.emit('dom-ready'); assert.equal(code.length,2);
  assert.equal(contents.listenerCount('frame-created'),0);
});
