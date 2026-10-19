import http from 'node:http';
import {createReadStream} from 'node:fs';
import {stat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const defaultRoot=fileURLToPath(new URL('../dist/',import.meta.url));
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.geojson':'application/geo+json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.woff2':'font/woff2','.ttf':'font/ttf','.ico':'image/x-icon','.pmtiles':'application/vnd.pmtiles','.pbf':'application/x-protobuf','.mvt':'application/vnd.mapbox-vector-tile'};
const mapExtensions=new Set(['.pmtiles','.png','.jpg','.jpeg','.webp','.avif','.pbf','.mvt','.json','.geojson']);
const inside=(base,target)=>target===base||target.startsWith(base+path.sep);
/** Single byte ranges only. Number offsets cover current full-world archives. */
export function parseRange(value,size){
  const match=/^bytes=(\d*)-(\d*)$/.exec(value??'');
  if(!match||(!match[1]&&!match[2])||!Number.isSafeInteger(size)||size<=0)return null;
  let start,end;
  if(!match[1]){const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return null;start=Math.max(0,size-suffix);end=size-1;}
  else{start=Number(match[1]);end=match[2]?Number(match[2]):size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||start>end)return null;end=Math.min(end,size-1);}
  return {start,end,length:end-start+1};
}
export function createRequestHandler({root=defaultRoot,mapsDir=process.env.METROWEAVE_MAPS_DIR,corsOrigin=process.env.METROWEAVE_MAPS_CORS||'*'}={}){
  const rootPromise=realpath(path.resolve(root)),mapsPromise=mapsDir?realpath(path.resolve(mapsDir)):undefined;
  return async(req,res)=>{
    try{
      const url=new URL(req.url||'/','http://localhost');
      let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{res.writeHead(400);res.end('Invalid URL');return;}
      const isMap=pathname.startsWith('/maps/');
      if(isMap){res.setHeader('Access-Control-Allow-Origin',corsOrigin);res.setHeader('Access-Control-Expose-Headers','Accept-Ranges, Content-Range, Content-Length, ETag, Last-Modified');res.setHeader('Access-Control-Allow-Methods','GET, HEAD, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Range, If-Range, If-None-Match');}
      if(req.method==='OPTIONS'&&isMap){res.writeHead(204);res.end();return;}
      if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;}
      if(pathname.includes('\0')||pathname.includes('\\')){res.writeHead(403);res.end('Forbidden');return;}
      if(isMap&&!mapsPromise){res.writeHead(404);res.end('Local map directory is not configured. Set METROWEAVE_MAPS_DIR.');return;}
      const base=await(isMap?mapsPromise:rootPromise);
      const relative=isMap?pathname.slice('/maps/'.length):pathname==='/'?'index.html':pathname.slice(1);
      if(isMap&&!mapExtensions.has(path.extname(relative).toLowerCase())){res.writeHead(403);res.end('Unsupported map file');return;}
      const target=path.resolve(base,relative);
      if(!inside(base,target)){res.writeHead(403);res.end('Forbidden');return;}
      const resolved=await realpath(target);
      if(!inside(base,resolved)){res.writeHead(403);res.end('Forbidden');return;}
      const info=await stat(resolved);if(!info.isFile())throw Error('Not a file');
      const etag=`"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
      res.setHeader('Content-Type',mime[path.extname(resolved).toLowerCase()]||'application/octet-stream');
      res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
      res.setHeader('Accept-Ranges','bytes');res.setHeader('ETag',etag);res.setHeader('Last-Modified',info.mtime.toUTCString());
      res.setHeader('Cache-Control',isMap?'public, max-age=3600':pathname.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache');
      if(pathname==='/sw.js')res.setHeader('Service-Worker-Allowed','/');
      if(req.headers['if-none-match']===etag){res.writeHead(304);res.end();return;}
      const ifRange=req.headers['if-range'];
      const applyRange=req.headers.range&&(!ifRange||ifRange===etag||ifRange===info.mtime.toUTCString());
      let range;
      if(applyRange){range=parseRange(req.headers.range,info.size);if(!range){res.writeHead(416,{'Content-Range':`bytes */${info.size}`,'Content-Length':0});res.end();return;}res.setHeader('Content-Range',`bytes ${range.start}-${range.end}/${info.size}`);}
      res.setHeader('Content-Length',range?range.length:info.size);res.writeHead(range?206:200);
      if(req.method==='HEAD'){res.end();return;}
      const stream=createReadStream(resolved,range?{start:range.start,end:range.end}:{});
      res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
    }catch(error){if(!res.headersSent){res.writeHead(error?.code==='EACCES'?403:404,{'Content-Type':'text/plain; charset=utf-8'});res.end('File not found');}else res.destroy();}
  };
}
const isMain=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){
  try{await stat(path.join(defaultRoot,'index.html'));if(process.env.METROWEAVE_MAPS_DIR)await realpath(process.env.METROWEAVE_MAPS_DIR);}catch{console.error('Build or configured map directory missing. Run npm run build and verify METROWEAVE_MAPS_DIR.');process.exit(1);}
  const port=Number(process.env.PORT||5173),host=process.env.HOST||'127.0.0.1';
  const server=http.createServer(createRequestHandler());
  server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is in use. Choose another PORT.`:error.message);process.exit(1);});
  server.listen(port,host,()=>console.log(`MetroWeave: http://${host}:${port}\nMap archives: ${process.env.METROWEAVE_MAPS_DIR?'configured at /maps/ (streaming byte ranges)':'set METROWEAVE_MAPS_DIR to enable /maps/'}\nPress Ctrl+C to stop.`));
}
