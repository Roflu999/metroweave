/* Build replaces both markers. External tiles, /maps/, and byte-range responses are never cached. */
const VERSION='__BUILD_VERSION__';
const PRECACHE=/*__PRECACHE__*/[];
const scope=new URL(self.registration.scope);
const PREFIX='metroweave-app-'+encodeURIComponent(scope.pathname)+'-';
const CACHE=PREFIX+VERSION;
const allowed=new Set(PRECACHE.map(path=>new URL(path,scope).href));
self.addEventListener('install',event=>{event.waitUntil((async()=>{if(!PRECACHE.length)return;const cache=await caches.open(CACHE);await cache.addAll(PRECACHE.map(path=>new Request(new URL(path,scope),{cache:'reload'})));})());});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith(PREFIX)&&key!==CACHE)await caches.delete(key);await self.clients.claim();for(const client of await self.clients.matchAll())client.postMessage({type:'OFFLINE_STATUS',ready:PRECACHE.length>0,version:VERSION});})());});
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting();if(event.data?.type==='STATUS')event.source?.postMessage({type:'OFFLINE_STATUS',ready:PRECACHE.length>0,version:VERSION});});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==scope.origin||!url.pathname.startsWith(scope.pathname)||request.headers.has('range')||url.pathname.includes('/maps/')||url.pathname.endsWith('.pmtiles'))return;
  if(request.mode==='navigate'){
    event.respondWith((async()=>{const cache=await caches.open(CACHE);try{const response=await fetch(request);if(response.ok)return response;throw new Error('Navigation failed');}catch{return await cache.match(new URL('index.html',scope))||Response.error();}})());return;
  }
  if(!allowed.has(url.href))return;
  event.respondWith((async()=>{const cache=await caches.open(CACHE);const cached=await cache.match(request);if(cached)return cached;const response=await fetch(request);if(response.ok&&response.status===200)await cache.put(request,response.clone());return response;})());
});
