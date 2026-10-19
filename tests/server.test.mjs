import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,open,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createRequestHandler,parseRange} from '../scripts/serve.mjs';
test('range parser handles suffix, open-ended and invalid ranges at planet scale',()=>{const size=89_000_000_000;assert.deepEqual(parseRange('bytes=88000000000-',size),{start:88_000_000_000,end:size-1,length:1_000_000_000});assert.deepEqual(parseRange('bytes=-16',size),{start:size-16,end:size-1,length:16});for(const value of ['bytes=0-1,4-8','bytes=-0','bytes=9-8',`bytes=${size}-`,'bytes=-','items=1-2'])assert.equal(parseRange(value,size),null);});
test('map server streams 89 GB sparse archive ranges, HEAD and 416 without buffering archive',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'metroweave-server-')),root=path.join(dir,'dist'),maps=path.join(dir,'maps');await mkdir(root);await mkdir(maps);await writeFile(path.join(root,'index.html'),'app');
  const filename=path.join(maps,'planet.pmtiles');await writeFile(filename,'');
  // NTFS must explicitly mark the file sparse before setting the logical length.
  if(process.platform==='win32')execFileSync('fsutil.exe',['sparse','setflag',filename],{windowsHide:true});
  const archive=await open(filename,'r+');const size=89_000_000_000;await archive.truncate(size);await archive.write(Buffer.from('planet-end'),0,10,size-10);await archive.close();await writeFile(path.join(dir,'secret.json'),'private');
  const server=http.createServer(createRequestHandler({root,mapsDir:maps}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    let r=await fetch(`${base}/maps/planet.pmtiles`,{headers:{Range:`bytes=${size-10}-`}});assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),`bytes ${size-10}-${size-1}/${size}`);assert.equal(await r.text(),'planet-end');assert.equal(r.headers.get('access-control-allow-origin'),'*');
    r=await fetch(`${base}/maps/planet.pmtiles`,{method:'HEAD'});assert.equal(r.status,200);assert.equal(r.headers.get('content-length'),String(size));assert.equal((await r.arrayBuffer()).byteLength,0);
    r=await fetch(`${base}/maps/planet.pmtiles`,{headers:{Range:`bytes=${size}-`}});assert.equal(r.status,416);assert.equal(r.headers.get('content-range'),`bytes */${size}`);
    r=await fetch(`${base}/maps/%2e%2e%2fsecret.json`);assert.equal(r.status,403);
    r=await fetch(`${base}/maps/planet.pmtiles`,{headers:{Range:'bytes=0-4','If-Range':'old-etag'},method:'HEAD'});assert.equal(r.status,200);assert.equal(r.headers.get('content-length'),String(size));
    r=await fetch(`${base}/maps/planet.pmtiles`,{headers:{'If-None-Match':r.headers.get('etag')}});assert.equal(r.status,304);
    r=await fetch(`${base}/maps/planet.pmtiles`,{method:'OPTIONS'});assert.equal(r.status,204);
    try{await symlink(path.join(dir,'secret.json'),path.join(maps,'escape.json'));r=await fetch(`${base}/maps/escape.json`);assert.equal(r.status,403);}catch(error){if(error.code!=='EPERM')throw error;}
  }finally{await new Promise(resolve=>server.close(resolve));assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await rm(dir,{recursive:true,force:true});}
});
