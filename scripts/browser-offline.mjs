/** Real production offline regression. Isolated browser context; no personal profile.
 * BASE_URL, CHROMIUM_EXECUTABLE and QA_OUTPUT_DIR may be supplied.
 * Standard OSM tiles are fulfilled with one pixel; no tile download or viewport crawl.
 */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,expect} from '@playwright/test';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=process.env.BASE_URL||'http://127.0.0.1:5173';
const output=process.env.QA_OUTPUT_DIR?path.resolve(process.env.QA_OUTPUT_DIR):await mkdtemp(path.join(tmpdir(),'metroweave-offline-'));
await mkdir(output,{recursive:true});
const manifestResponse=await fetch(new URL('offline-manifest.json',base.endsWith('/')?base:base+'/'),{signal:AbortSignal.timeout(30000),cache:'no-store'});
if(!manifestResponse.ok)throw new Error(`The target offline manifest returned ${manifestResponse.status}. Build and deploy the offline assets first.`);
const manifest=await manifestResponse.json();
const workshop=JSON.parse(await readFile(path.join(root,'public/data/advanced-workshop.json'),'utf8'));
const report={startedAt:new Date().toISOString(),baseUrl:base,buildVersion:manifest.version,checks:[],pageErrors:[],googleFontRequests:[],externalRequests:[],success:false};
const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/hoAAAAASUVORK5CYII=','base64');
function rasterArchive(){
  // A tiny valid PMTiles v3 fixture, not geographic source data: one PNG at z0.
  const metadata=Buffer.from(JSON.stringify({name:'Offline QA raster',format:'png',attribution:'MetroWeave synthetic QA fixture'}));
  const directory=Buffer.from([1,0,1,pixel.length,1]),header=Buffer.alloc(127);header.write('PMTiles',0);header[7]=3;
  const u64=(offset,value)=>header.writeBigUInt64LE(BigInt(value),offset);
  u64(8,127);u64(16,directory.length);u64(24,127+directory.length);u64(32,metadata.length);u64(40,127+directory.length+metadata.length);u64(48,0);u64(56,127+directory.length+metadata.length);u64(64,pixel.length);u64(72,1);u64(80,1);u64(88,1);
  header[96]=1;header[97]=1;header[98]=1;header[99]=2;header[100]=0;header[101]=0;header.writeInt32LE(-1800000000,102);header.writeInt32LE(-850000000,106);header.writeInt32LE(1800000000,110);header.writeInt32LE(850000000,114);header[118]=0;header.writeInt32LE(-1278000,119);header.writeInt32LE(515074000,123);
  return Buffer.concat([header,directory,metadata,pixel]);
}
let browser,context,page,offlineEmulation=false,stage='launch';
async function check(name,fn){stage=name;await fn();report.checks.push({name,passed:true});console.log('PASS',name);}
async function state(){return page.evaluate(()=>{const raw=localStorage.getItem('metroweave.autosave.v1');return raw?JSON.parse(raw):null;});}
async function until(fn,message){await expect.poll(async()=>fn(await state()),{timeout:15000,message}).toBe(true);return state();}
async function readDB(dbName,store,key){return page.evaluate(({dbName,store,key})=>new Promise((resolve,reject)=>{const r=indexedDB.open(dbName);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const q=key===undefined?db.transaction(store).objectStore(store).getAll():db.transaction(store).objectStore(store).get(key);q.onsuccess=()=>{resolve(q.result);db.close();};q.onerror=()=>{reject(q.error);db.close();};};}),{dbName,store,key});}
async function closeDialog(){await page.getByRole('button',{name:'Close dialog',exact:true}).click();}
try{
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  context=await browser.newContext({viewport:{width:1600,height:1000},serviceWorkers:'allow'});
  await context.route('**/*',async route=>{const url=new URL(route.request().url());if(url.origin===new URL(base).origin){await route.continue();return;}report.externalRequests.push(url.href);if(/fonts\.(googleapis|gstatic)\.com/.test(url.hostname))report.googleFontRequests.push(url.href);if(url.hostname==='tile.openstreetmap.org'&&!offlineEmulation){await route.fulfill({status:200,contentType:'image/png',body:pixel});return;}await route.abort();});
  page=await context.newPage();page.on('pageerror',error=>report.pageErrors.push(error.message));
  await check('production worker installs exact local assets without Google Fonts',async()=>{
    await page.goto(base,{waitUntil:'domcontentloaded'});await page.getByLabel('Interactive transit map').waitFor();
    await expect(page.getByRole('button',{name:'Offline & map servers',exact:true})).toContainText('Offline ready',{timeout:20000});
    await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
    const cached=await page.evaluate(async()=>{const names=(await caches.keys()).filter(n=>n.startsWith('metroweave-app-'));return Promise.all(names.map(async name=>({name,urls:(await(await caches.open(name)).keys()).map(r=>r.url)})));});
    const active=cached.find(c=>c.name.endsWith(manifest.version));assert.ok(active,'Current build cache exists');
    const expected=manifest.files.map(f=>new URL(f,base.endsWith('/')?base:base+'/').href).sort();assert.deepEqual(active.urls.sort(),expected);
    assert.ok(active.urls.every(url=>new URL(url).origin===new URL(base).origin&&!url.includes('/maps/')&&!url.endsWith('.pmtiles')));
    assert.equal(report.googleFontRequests.length,0);report.cache={name:active.name,assets:active.urls.length,bytes:manifest.bytes};
    const fonts=await page.evaluate(async()=>{await document.fonts.ready;const faces=[...document.fonts].map(f=>({family:f.family,status:f.status}));return {dm:faces.some(f=>f.family.replaceAll('"','')==='DM Sans'&&f.status==='loaded'),manrope:faces.some(f=>f.family.replaceAll('"','')==='Manrope'&&f.status==='loaded'),faces};});assert.ok(fonts.dm&&fonts.manrope);report.localFonts=fonts;
  });
  await check('editor reloads with all network disabled and falls back to world overview',async()=>{
    offlineEmulation=true;await context.setOffline(true);
    // Older explicitly supplied Chromium executables need the legacy CDP state
    // override as well as Playwright's request emulation to update navigator.onLine.
    if(await page.evaluate(()=>navigator.onLine)){const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});}
    await page.waitForFunction(()=>navigator.onLine===false,{timeout:5000});
    assert.equal(await page.evaluate(()=>fetch(`offline-negative-probe-${Date.now()}`).then(()=>false,()=>true)),true,'Uncached network requests must fail');
    await page.reload({waitUntil:'domcontentloaded'});await page.getByLabel('Interactive transit map').waitFor();
    assert.equal(await page.evaluate(()=>fetch(`offline-negative-probe-${Date.now()}`).then(()=>false,()=>true)),true,'Uncached network requests must also fail after reload');report.networkDisabledBeforeAndAfterReload=true;
    await expect(page.getByRole('button',{name:'Offline & map servers',exact:true})).toHaveText('Offline');
    await expect(page.locator('.leaflet-control-attribution')).toContainText('Natural Earth',{timeout:15000});
    await page.screenshot({path:path.join(output,'offline-editor.png'),fullPage:true});
  });
  await check('world atlas and real Glasgow topology load offline',async()=>{
    await page.getByRole('button',{name:/World atlas/}).first().click();await page.getByLabel('Search world atlas',{exact:true}).fill('Tokyo');
    await expect(page.locator('.atlas-grid')).toContainText('Tokyo');
    await page.getByRole('button',{name:/Explore a real network: Glasgow Subway/}).click();
    const network=await until(n=>n?.city==='Glasgow'&&n.stations.length===15,'Glasgow reference loads from worker cache');assert.equal(network.services.length,2);assert.ok(network.services.every(s=>s.loop));report.glasgowStations=network.stations.length;
  });
  await check('offline project edits persist in both browser stores and survive reload',async()=>{
    await page.locator('.project-title').click();await page.getByRole('dialog').getByLabel('Project name',{exact:true}).fill('Offline Glasgow QA');await closeDialog();
    await until(n=>n?.name==='Offline Glasgow QA','Offline project rename autosaves');
    await expect.poll(async()=>(await readDB('metroweave-workspace','state','workspace'))?.current?.name,{timeout:10000}).toBe('Offline Glasgow QA');
    await page.reload({waitUntil:'domcontentloaded'});await expect(page.locator('.project-title')).toHaveText('Offline Glasgow QA');const network=await state();assert.equal(network.stations.length,15);
  });
  await check('advanced infrastructure workshop loads entirely offline',async()=>{
    await page.getByRole('button',{name:'My maps',exact:true}).click();await page.getByRole('button',{name:/Advanced track workshop/}).click();
    const network=await until(n=>n?.id===workshop.id,'Workshop loads from cache');assert.equal(network.stations.length,workshop.stations.length);assert.deepEqual(Object.keys(network).sort(),Object.keys(workshop).sort());report.workshop={name:network.name,stations:network.stations.length,services:network.services.length};
  });
  await check('user GeoJSON basemap persists offline across browser reload',async()=>{
    await page.getByRole('button',{name:'Offline & map servers',exact:true}).click();
    const geojson={type:'FeatureCollection',features:[{type:'Feature',properties:{category:'park',name:'Offline QA park'},geometry:{type:'Polygon',coordinates:[[[-0.15,51.50],[-0.10,51.50],[-0.10,51.53],[-0.15,51.53],[-0.15,51.50]]]}}]};
    await page.getByLabel('Offline map file',{exact:true}).setInputFiles({name:'offline-qa-map.geojson',mimeType:'application/geo+json',buffer:Buffer.from(JSON.stringify(geojson))});
    await expect(page.locator('.map-source-list')).toContainText('offline-qa-map.geojson');await closeDialog();
    await expect(page.locator('.leaflet-control-attribution')).toContainText('User supplied map data');
    const sources=await readDB('metroweave-offline-maps','sources');const source=sources.find(s=>s.name==='offline-qa-map.geojson');assert.ok(source&&source.storage==='indexeddb');
    const pack=await readDB('metroweave-offline-maps','packs',source.id);assert.deepEqual(pack.data,geojson);
    await expect.poll(async()=>(await readDB('metroweave-workspace','state','workspace'))?.settings?.basemapSourceId,{timeout:10000}).toBe(source.id);
    await page.reload({waitUntil:'domcontentloaded'});await expect(page.locator('.leaflet-control-attribution')).toContainText('User supplied map data',{timeout:15000});
    await page.getByRole('button',{name:'Offline & map servers',exact:true}).click();await expect(page.locator('.map-source-list .selected')).toContainText('offline-qa-map.geojson');await page.screenshot({path:path.join(output,'offline-map-pack.png'),fullPage:true});await closeDialog();report.geojsonPersistence=true;
  });
  await check('local PMTiles FileSource renders and persists offline after reload',async()=>{
    await page.getByRole('button',{name:'Offline & map servers',exact:true}).click();
    const archive=rasterArchive();await page.getByLabel('Offline map file',{exact:true}).setInputFiles({name:'offline-qa-raster.pmtiles',mimeType:'application/vnd.pmtiles',buffer:archive});
    await expect(page.locator('.map-source-list .selected')).toContainText('offline-qa-raster.pmtiles');await closeDialog();
    await expect(page.locator('.leaflet-control-attribution')).toContainText('MetroWeave synthetic QA fixture');
    await expect.poll(()=>page.locator('.leaflet-tile-loaded').count(),{timeout:10000}).toBeGreaterThan(0);
    const source=(await readDB('metroweave-offline-maps','sources')).find(s=>s.filename==='offline-qa-raster.pmtiles');assert.equal(source.storage,'indexeddb');
    const stored=await readDB('metroweave-offline-maps','files',source.id);assert.ok(stored.file);assert.equal(await page.evaluate(({id})=>new Promise((resolve,reject)=>{const r=indexedDB.open('metroweave-offline-maps');r.onsuccess=()=>{const db=r.result,q=db.transaction('files').objectStore('files').get(id);q.onsuccess=()=>{resolve(q.result.file.size);db.close();};q.onerror=()=>reject(q.error);};}),{id:source.id}),archive.length);
    await expect.poll(async()=>(await readDB('metroweave-workspace','state','workspace'))?.settings?.basemapSourceId,{timeout:10000}).toBe(source.id);
    await page.reload({waitUntil:'domcontentloaded'});await expect(page.locator('.leaflet-control-attribution')).toContainText('MetroWeave synthetic QA fixture',{timeout:15000});await expect.poll(()=>page.locator('.leaflet-tile-loaded').count(),{timeout:10000}).toBeGreaterThan(0);
    report.pmtilesPersistence={bytes:archive.length,type:'PNG',storage:'indexeddb',rendered:true};
  });
  assert.equal(report.googleFontRequests.length,0);assert.deepEqual(report.pageErrors,[]);report.success=true;console.log('OFFLINE QA PASSED',output);
}catch(error){report.failure={stage,message:error instanceof Error?error.message:String(error)};console.error('OFFLINE QA FAILED',stage,error);if(page){report.diagnostics=await page.evaluate(async()=>({online:navigator.onLine,indicator:document.querySelector('.offline-indicator')?.textContent,attribution:document.querySelector('.leaflet-control-attribution')?.textContent,controller:navigator.serviceWorker.controller?.scriptURL,cacheKeys:await caches.keys(),world:await fetch('data/world-overview.geojson').then(r=>({status:r.status,worker:r.headers.get('cache-control')})).catch(e=>({error:e.message}))})).catch(()=>null);await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');await context?.close();await browser?.close();}
