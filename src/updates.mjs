import { constants } from 'node:fs';
import { readFile, mkdir, lstat, realpath, open, link, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const number = value => Number.isSafeInteger(value) && value > 0;
const hash = value => createHash('sha256').update(value).digest('hex');
const version = value => {if(typeof value!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))return null;const parts=value.split('.').map(Number);return parts.every(part=>Number.isSafeInteger(part)&&part<=1000000)?parts:null;};
function compare(a,b) { for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]-b[i];return a[3]-b[3]; }
async function bounded(response, limit) {
  if(Number(response.headers.get('content-length')||0)>limit){await response.body?.cancel();throw Error('Update metadata exceeds its bound.');}
  const parts=[];let size=0;for await(const part of response.body||[]){size+=part.length;if(size>limit)throw Error('Update metadata exceeds its bound.');parts.push(part);}return Buffer.concat(parts,size);
}
export async function updateConfiguration() { return JSON.parse(await readFile(new URL('./updates-config.json',import.meta.url),'utf8')); }

/** Published GitHub release metadata is the publisher authority. Credentials
 * go only to the API; CDN redirects receive no Authorization header. Preview
 * artifacts are verified downloads for deliberate installer-based updates. */
export class DesktopUpdates {
  #token;
  constructor({repository,channel='preview',version:installedVersion,build,platform=process.platform,architecture=process.arch,token,fetch:fetcher=globalThis.fetch,apiOrigin='https://api.github.com',assetOrigins=['https://release-assets.githubusercontent.com','https://objects.githubusercontent.com'],allowLoopbackHTTP=false}={}) {
    if(typeof repository!=='string'||!/^[-\w.]+\/[-\w.]+$/.test(repository)||repository.includes('..')||!['preview','stable'].includes(channel)||!version(installedVersion)||!number(build)||!['darwin','linux','win32'].includes(platform)||!['arm64','x64'].includes(architecture)||token!==undefined&&(typeof token!=='string'||!token||/[\r\n\0]/.test(token)))throw Error('Invalid desktop update configuration.');
    const origin=new URL(apiOrigin);if(origin.origin!==apiOrigin||!(apiOrigin==='https://api.github.com'||allowLoopbackHTTP&&origin.protocol==='http:'&&['127.0.0.1','[::1]'].includes(origin.hostname)))throw Error('Invalid update API origin.');
    for(const value of assetOrigins){const url=new URL(value);if(url.origin!==value||!(url.protocol==='https:'||allowLoopbackHTTP&&url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)))throw Error('Invalid update asset origin.');}
    this.#token=token;Object.assign(this,{repository,channel,installedVersion,build,platform,architecture,fetcher,apiOrigin,assetOrigins,active:null});
  }
  get releaseURL(){return'https://github.com/'+this.repository+'/releases';}
  headers(accept){return{Accept:accept,'X-GitHub-Api-Version':'2022-11-28',...(this.#token?{Authorization:'Bearer '+this.#token}:{})};}
  async fetch(url,options){try{return await this.fetcher(url,options);}catch{throw Error('Unable to contact the update service.');}}
  async json(path){
    const response=await this.fetch(this.apiOrigin+'/repos/'+this.repository+path,{redirect:'error',headers:this.headers('application/vnd.github+json'),signal:AbortSignal.timeout(30000)});
    if(!response.ok){await response.body?.cancel();throw Error('Update service returned HTTP '+response.status+'.');}try{return JSON.parse((await bounded(response,2*1024*1024)).toString('utf8'));}catch{throw Error('Update service returned invalid bounded metadata.');}
  }
  async asset(id,{signal}={}){
    if(!number(id))throw Error('Invalid release asset identity.');
    let url=new URL(this.apiOrigin+'/repos/'+this.repository+'/releases/assets/'+id),api=true;
    for(let i=0;i<4;i++){
      const response=await this.fetch(url,{redirect:'manual',signal,headers:api?this.headers('application/octet-stream'):{Accept:'application/octet-stream'}});
      if(response.status===200)return response;
      if(![301,302,303,307,308].includes(response.status)){await response.body?.cancel();throw Error('Release asset returned HTTP '+response.status+'.');}
      const location=response.headers.get('location');await response.body?.cancel();if(!location)throw Error('Release asset redirect has no destination.');
      url=new URL(location,url);if(url.username||url.password||url.hash||!this.assetOrigins.includes(url.origin))throw Error('Release asset redirect is outside the configured CDN.');api=false;
    }
    throw Error('Release asset exceeded its redirect bound.');
  }
  tag(release){
    const match=/^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-preview\.([1-9]\d*))?$/.exec(release.tag_name||'');
    if(!match||release.draft!==false||!Number.isFinite(Date.parse(release.published_at))||!number(release.id)||!version(match[1])||!number(Number(match[2]||1)))return null;
    if(this.channel==='preview'? !match[2]||release.prerelease!==true : release.prerelease!==false||!!match[2])return null;
    return[...version(match[1]),Number(match[2]||1)];
  }
  async inspect(release){
    const rank=this.tag(release);if(!rank||!Array.isArray(release.assets)||release.assets.length>100)throw Error('Invalid published desktop release.');
    const manifests=release.assets.filter(asset=>asset.name==='release.json'&&asset.state==='uploaded');if(manifests.length!==1)throw Error('Published update needs one release.json.');
    const response=await this.asset(manifests[0].id,{signal:AbortSignal.timeout(30000)}),raw=await bounded(response,128*1024),manifest=JSON.parse(raw.toString('utf8'));
    if(this.channel==='stable'&&number(manifest.build))rank[3]=manifest.build;
    if(manifests[0].digest&&manifests[0].digest!=='sha256:'+hash(raw))throw Error('Release metadata checksum changed.');
    if(manifest.format!=='ink-os-desktop-package-v1'||!version(manifest.version)||manifest.version!==rank.slice(0,3).join('.')||manifest.build!==undefined&&manifest.build!==rank[3]||!hex(manifest.artifactSha256)||manifest.desktopSource?.dirty!==false||!/^[a-f0-9]{40}$/.test(manifest.desktopSource.commit)||!/^[a-f0-9]{40}$/.test(manifest.platformSource?.commit))throw Error('Published update manifest has invalid source or version bindings.');
    if(manifest.platform!==this.platform||manifest.architecture!==this.architecture)return null;
    const extension=this.platform==='darwin'?'dmg':'tar.gz',name='ink-os-'+manifest.version+'-'+this.platform+'-'+this.architecture+'.'+extension;
    if(manifest.artifact!==name)throw Error('Invalid update artifact filename.');
    const artifacts=release.assets.filter(asset=>asset.name===name&&asset.state==='uploaded');
    if(artifacts.length!==1||!number(artifacts[0].id)||!number(artifacts[0].size)||artifacts[0].size>512*1024*1024||artifacts[0].digest&&artifacts[0].digest!=='sha256:'+manifest.artifactSha256)throw Error('Update artifact disagrees with its release manifest.');
    const available=compare(rank,[...version(this.installedVersion),this.build])>0;
    return{available,repository:this.repository,releaseId:release.id,tag:release.tag_name,version:manifest.version,build:rank[3],releaseURL:this.releaseURL+'/tag/'+encodeURIComponent(release.tag_name),manifestSha256:hash(raw),assetId:artifacts[0].id,artifact:name,bytes:artifacts[0].size,sha256:manifest.artifactSha256,platformCommit:manifest.platformSource.commit,desktopCommit:manifest.desktopSource.commit,signing:manifest.signing,notarized:manifest.notarized===true,installation:'manual'};
  }
  async check(){
    const releases=await this.json('/releases?per_page=30');if(!Array.isArray(releases)||releases.length>30)throw Error('Invalid bounded release listing.');
    const ordered=releases.map(release=>({release,rank:this.tag(release)})).filter(item=>item.rank).sort((a,b)=>compare(b.rank,a.rank));
    for(const{release}of ordered){const candidate=await this.inspect(release);if(candidate)return candidate;}
    return{available:false,version:this.installedVersion,build:this.build,releaseURL:this.releaseURL};
  }
  async verify(path,candidate){
    const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const before=await file.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||before.size!==BigInt(candidate.bytes))throw Error('Downloaded update size or identity changed.');const digest=createHash('sha256');for await(const bytes of file.createReadStream({autoClose:false}))digest.update(bytes);const after=await file.stat({bigint:true});if(before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||digest.digest('hex')!==candidate.sha256)throw Error('Downloaded update failed checksum verification.');}
    finally{await file.close();}
    return path;
  }
  async download(candidate,{directory,progress=()=>{}}={}){
    if(this.active)throw Error('An update download is already active.');if(!number(candidate?.releaseId)||candidate.repository!==this.repository||!directory)throw Error('Check this configured update source before downloading.');
    const controller=new AbortController(),task=this.downloadOwned(candidate,{directory,progress,signal:controller.signal});this.active={controller,task};try{return await task;}finally{this.active=null;}
  }
  async downloadOwned(candidate,{directory,progress,signal}){
    const current=await this.inspect(await this.json('/releases/'+candidate.releaseId));if(!current?.available||current.manifestSha256!==candidate.manifestSha256||current.assetId!==candidate.assetId||current.sha256!==candidate.sha256||current.bytes!==candidate.bytes)throw Error('Published update changed after checking.');
    const root=resolve(directory);await mkdir(root,{recursive:true,mode:0o700});const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077||await realpath(root)!==root||process.getuid&&info.uid!==process.getuid())throw Error('Update cache must be an owned private directory.');
    const path=join(root,current.sha256.slice(0,16)+'-'+current.artifact),temporary=join(root,'.download-'+randomBytes(12).toString('hex'));let file,response;
    try{await lstat(path);await this.verify(path,current);return{...current,path};}catch(error){if(error.code!=='ENOENT')throw error;}
    try{
      file=await open(temporary,'wx',0o600);response=await this.asset(current.assetId,{signal:AbortSignal.any([signal,AbortSignal.timeout(300000)])});let bytes=0;const digest=createHash('sha256');
      for await(const part of response.body||[]){signal.throwIfAborted();bytes+=part.length;if(bytes>current.bytes)throw Error('Update download exceeds its committed size.');digest.update(part);let offset=0;while(offset<part.length){const{bytesWritten}=await file.write(part,offset,part.length-offset);if(!bytesWritten)throw Error('Update download write stopped.');offset+=bytesWritten;}progress(bytes/current.bytes);}
      if(bytes!==current.bytes||digest.digest('hex')!==current.sha256)throw Error('Update download is incomplete or corrupt.');signal.throwIfAborted();await file.sync();await file.close();file=null;await link(temporary,path);await unlink(temporary);const parent=await open(root,'r');try{await parent.sync();}finally{await parent.close();}return{...current,path};
    }finally{await response?.body?.cancel().catch(()=>{});await file?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  async cancel(){const active=this.active;if(active){active.controller.abort();await active.task.catch(()=>{});}}
}
export async function desktopUpdateCLI({args,directory,environment=process.env,print=value=>console.log(JSON.stringify(value,null,2))}){
  const[action,...rest]=args,options={};if(!['check','download'].includes(action))throw Error('Use desktop update check or desktop update download.');
  for(let i=0;i<rest.length;i++){const key=rest[i].slice(2);if(!rest[i].startsWith('--')||!['repository','channel','directory'].includes(key)||Object.hasOwn(options,key)||!rest[i+1]||rest[i+1].startsWith('--'))throw Error('Invalid desktop update option.');options[key]=rest[++i];}
  const config=await updateConfiguration(),updater=new DesktopUpdates({...config,...(options.repository?{repository:options.repository}:{}),...(options.channel?{channel:options.channel}:{}),token:environment.INK_OS_UPDATE_TOKEN});
  const candidate=await updater.check(),result=action==='download'&&candidate.available?await updater.download(candidate,{directory:options.directory||join(directory,'updates')}):candidate;print(result);return result;
}
