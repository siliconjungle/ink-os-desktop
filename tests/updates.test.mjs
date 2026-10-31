import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp,realpath,readFile,readdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DesktopUpdates } from '../src/updates.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t){
  const directory=await realpath(await mkdtemp(join(tmpdir(),'ink-desktop-update-'))),calls=[],bytes=Buffer.alloc(180000,37);let corrupt=false,redirect,hold=false,releaseHold;
  const manifest={format:'ink-os-desktop-package-v1',version:'0.1.0',build:6,platform:'darwin',architecture:'arm64',artifact:'ink-os-0.1.0-darwin-arm64.dmg',artifactSha256:hash(bytes),desktopSource:{commit:'a'.repeat(40),dirty:false},platformSource:{commit:'b'.repeat(40)},signing:'ad-hoc-development',notarized:false};
  const release={id:7,tag_name:'v0.1.0-preview.6',published_at:'2026-10-30T00:00:00Z',draft:false,prerelease:true,assets:[{id:1,name:'release.json',state:'uploaded',size:1000},{id:2,name:manifest.artifact,state:'uploaded',size:bytes.length,digest:'sha256:'+hash(bytes)}]};
  const cdn=createServer(async(req,res)=>{calls.push({surface:'cdn',path:req.url,authorization:req.headers.authorization});assert.equal(req.headers.authorization,undefined);if(hold&&req.url==='/artifact')await new Promise(done=>{releaseHold=done;});if(res.destroyed)return;const value=req.url==='/manifest'?Buffer.from(JSON.stringify(manifest)):corrupt?Buffer.alloc(bytes.length,1):bytes;res.writeHead(200,{'Content-Length':String(value.length)});res.end(value);});
  cdn.listen(0,'127.0.0.1');await once(cdn,'listening');const assetOrigin='http://127.0.0.1:'+cdn.address().port;
  const api=createServer((req,res)=>{calls.push({surface:'api',path:req.url,authorization:req.headers.authorization});assert.equal(req.headers.authorization,'Bearer fixture-private-update-token');const match=/\/releases\/assets\/(1|2)$/.exec(req.url);if(match){res.writeHead(302,{location:redirect||assetOrigin+(match[1]==='1'?'/manifest':'/artifact')});res.end();return;}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url.includes('?')?[release]:release));});
  api.listen(0,'127.0.0.1');await once(api,'listening');
  t.after(async()=>{releaseHold?.();await new Promise(done=>api.close(done));await new Promise(done=>cdn.close(done));await writeFile(join(directory,'storage-retention.json'),JSON.stringify({keep:{},safe_to_remove:Object.fromEntries((await readdir(directory)).map(name=>[name,'Completed owned update fixture; transports and writers closed, source-defined inputs retained in test.']))}));await rm(directory,{recursive:true});});
  const config={repository:'fixture/desktop',channel:'preview',version:'0.1.0',build:5,platform:'darwin',architecture:'arm64',token:'fixture-private-update-token',apiOrigin:'http://127.0.0.1:'+api.address().port,assetOrigins:[assetOrigin],allowLoopbackHTTP:true};
  return{directory,config,updater:new DesktopUpdates(config),manifest,release,bytes,calls,corrupt:()=>corrupt=true,redirect:value=>redirect=value,hold:()=>hold=true,unblock:()=>releaseHold?.()};
}
test('private release API redirects strip credentials; downloaded preview is version-bound, verified, cached and manually installed',async t=>{
  const f=await fixture(t),candidate=await f.updater.check();assert.equal(candidate.available,true);assert.equal(candidate.installation,'manual');assert.equal(candidate.notarized,false);assert.equal(candidate.signing,'ad-hoc-development');
  assert.ok(!JSON.stringify(f.updater).includes('fixture-private-update-token'));
  assert.equal((await new DesktopUpdates({...f.config,build:6}).check()).available,false);
  f.release.tag_name='v0.1.0';f.release.prerelease=false;assert.equal((await new DesktopUpdates({...f.config,channel:'stable'}).check()).available,true);f.release.tag_name='v0.1.0-preview.6';f.release.prerelease=true;
  const result=await f.updater.download(candidate,{directory:f.directory});assert.deepEqual(await readFile(result.path),f.bytes);assert.equal((await f.updater.download(candidate,{directory:f.directory})).path,result.path);assert.equal(f.calls.filter(call=>call.surface==='cdn'&&call.authorization).length,0);
  await writeFile(result.path,Buffer.alloc(f.bytes.length,0));await assert.rejects(f.updater.verify(result.path,candidate),/checksum/);
});
test('changed, corrupt, foreign-platform and redirected updates cannot publish an artifact',async t=>{
  const f=await fixture(t),candidate=await f.updater.check();f.release.assets[1].id=3;await assert.rejects(f.updater.download(candidate,{directory:f.directory}),/changed/);f.release.assets[1].id=2;
  f.corrupt();await assert.rejects(f.updater.download(candidate,{directory:f.directory}),/corrupt/);assert.deepEqual(await readdir(f.directory),[]);
  f.manifest.architecture='x64';assert.equal((await f.updater.check()).available,false);f.manifest.architecture='arm64';
  f.redirect('https://untrusted.invalid/object');await assert.rejects(f.updater.check(),/outside/);assert.ok(!f.calls.some(call=>call.surface==='cdn'&&call.authorization));
});
test('drafts, malformed manifests and unavailable private feeds fail safely without echoing credentials',async t=>{
  const f=await fixture(t);f.release.draft=true;assert.equal((await f.updater.check()).available,false);f.release.draft=false;f.manifest.desktopSource.dirty=true;await assert.rejects(f.updater.check(),/source or version/);
  const denied=new DesktopUpdates({...f.config,fetch:async()=>new Response('fixture-private-update-token',{status:403})});await assert.rejects(denied.check(),error=>!error.message.includes('fixture-private-update-token')&&error.message.includes('403'));
  const failed=new DesktopUpdates({...f.config,fetch:async()=>{throw Error('fixture-private-update-token');}});await assert.rejects(failed.check(),error=>!error.message.includes('fixture-private-update-token'));
});
test('quitting during an active download cancels its transport and leaves no installable partial output',async t=>{
  const f=await fixture(t),candidate=await f.updater.check();f.hold();const result=f.updater.download(candidate,{directory:f.directory}).then(()=>null,error=>error);
  for(let i=0;i<1000&&!f.calls.some(call=>call.surface==='cdn'&&call.path==='/artifact');i++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.ok(f.updater.active);await f.updater.cancel();assert.ok(await result);f.unblock();assert.deepEqual(await readdir(f.directory),[]);
});
