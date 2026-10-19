/** Advanced UI regression. Run: node --import tsx scripts/browser-advanced.mjs
 * Requires Node 24+, npm install and Playwright Chromium; isolated browser profiles only.
 * Optional environment: BASE_URL, CHROMIUM_EXECUTABLE, QA_OUTPUT_DIR, QA_START_AT (targeted debugging).
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { parseWorkspace } from '../src/backup.ts';
import { validateNetwork, serviceStopsAt } from '../src/engine.ts';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5173';
const output = process.env.QA_OUTPUT_DIR ? path.resolve(process.env.QA_OUTPUT_DIR) : await mkdtemp(path.join(tmpdir(), 'metroweave-advanced-'));
await mkdir(output, { recursive: true });
const STORE = 'metroweave.autosave.v1';
const START_AT = process.env.QA_START_AT || '';
let started = !START_AT;
const report = { startedAt: new Date().toISOString(), baseUrl: BASE_URL, scope: START_AT ? `Starting at: ${START_AT}` : 'Full regression', checks: [], pageErrors: [], success: false };
const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/hoAAAAASUVORK5CYII=', 'base64');
let browser, page, stage = 'launch', imported, workshop, zeroBranchId, lapBranchId;
async function context() {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.route('https://tile.openstreetmap.org/**', r => r.fulfill({ status: 200, contentType: 'image/png', body: tile }));
  return ctx;
}
const capture = p => p.on('pageerror', e => report.pageErrors.push(e.message));
const state = (p = page) => p.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), STORE);
async function until(predicate, message, p = page) {
  let value; await expect.poll(async () => { value = await state(p); return value && predicate(value); }, { timeout: 15000, message }).toBe(true); return value;
}
async function check(name, fn) { if (!started && name.includes(START_AT)) started = true; if (!started) { report.checks.push({ name, status: 'skipped', reason: 'QA_START_AT targeted run' }); return; } stage = name; const start = Date.now(); console.log(`RUN  ${name}`); await fn(); report.checks.push({ name, status: 'pass', milliseconds: Date.now() - start }); console.log(`PASS ${name}`); }
async function fileImport(p, name, bytes) {
  await p.getByRole('button', { name: 'Import a network', exact: true }).click();
  await p.getByLabel('Import project file', { exact: true }).setInputFiles({ name, mimeType: name.endsWith('.zip') ? 'application/zip' : 'application/json', buffer: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes) });
}
async function selectedService(id) {
  const n = await state(), service = n.services.find(s => s.id === id); assert.ok(service);
  const route = n.routes.find(r => r.id === service.routeId);
  await page.locator('.line-card').filter({ has: page.getByText(route.name, { exact: true }) }).locator('.line-main').click();
  await page.getByRole('combobox', { name: /^Service pattern/ }).selectOption(id);
}
async function tracks() { await page.getByRole('button', { name: 'Tracks', exact: true }).click(); }
async function inspect() { await page.getByRole('button', { name: 'Inspector', exact: true }).click(); }
async function mapClick(x, y) {
  const map = page.getByLabel('Interactive transit map'), box = await map.boundingBox(); assert.ok(box);
  await map.click({ position: { x: box.width * x, y: box.height * y } });
}
async function clickTrack(id) {
  const selector = `path[data-track-id=${JSON.stringify(id)}]`, line = page.locator(selector);
  await expect(line).toHaveCount(1);
  const candidates = await line.evaluate(el => {
    const matrix = el.getScreenCTM();
    return [.2, .35, .5, .65, .8, .1, .9, .27, .73].map(f => { const p = el.getPointAtLength(el.getTotalLength() * f); return { x: matrix.a * p.x + matrix.c * p.y + matrix.e, y: matrix.b * p.x + matrix.d * p.y + matrix.f }; });
  });
  const point = await page.evaluate(({ candidates, id }) => candidates.find(p => document.elementFromPoint(p.x, p.y)?.closest('path')?.getAttribute('data-track-id') === id), { candidates, id });
  assert.ok(point, `track ${id} has a visible clickable section`);
  await page.mouse.click(point.x, point.y);
}
async function locate(name) {
  const search = page.getByLabel('Find a line or station', { exact: true }); await search.fill(name);
  await page.locator('.station-results').getByRole('button', { name: new RegExp(name) }).click(); await search.fill('');
  await page.waitForTimeout(1200); // Leaflet fly-to animation, not an application state assertion.
}
async function exported(buttonName, p = page) {
  const download = p.waitForEvent('download'); await p.getByRole('button', { name: buttonName }).click();
  const result = await download, file = path.join(output, result.suggestedFilename()); await result.saveAs(file); return file;
}
function nativeSource(suffix) {
  return {
    systemDoc: { systemId: `qa-native-${suffix}`, title: `Native ${suffix}`, owner: 'Fixture author', custom: { keep: [false, 0, 'all'] } },
    map: { title: `Native ${suffix}`, caption: 'Complete source data fixture.', stations: {
      a: { id: 'a', name: 'Native Alpha', lat: 51.5, lng: -.14, grade: 'below', info: 'Platform information.' },
      w: { id: 'w', isWaypoint: true, lat: 51.505, lng: -.13 }, b: { id: 'b', name: 'Native Beta', lat: 51.5, lng: -.12 }, c: { id: 'c', name: 'Native Gamma', lat: 51.5, lng: -.10 },
    }, lines: { r: { id: 'r', name: 'Native purple', color: '#7b55c7', mode: 'RAPID', stationIds: ['a', 'w', 'b', 'a', 'c'], waypointOverrides: ['b'], lineGroupId: 'g', icon: 'heart', extra: { retain: true } }, f: { id: 'f', name: 'Native ferry', color: '#44aa88', mode: 'FERRY', stationIds: ['b', 'c'], lineGroupId: 'g' } }, lineGroups: { g: { id: 'g', label: 'Native Group', extra: 'full source' } }, interchanges: { i: { id: 'i', stationIds: ['a', 'b'], originalData: ['keep me'] } }, unknownMapData: { preserve: 'all fields' } },
  };
}

function bypassFixture(repeated = false) {
  const stations = repeated
    ? [['a', 'Bypass Alpha', -.16], ['b', 'Bypass Beta', -.12], ['c', 'Bypass Gamma', -.08], ['d', 'Bypass Delta', -.04]]
    : [['a', 'Fourth Alpha', -.16], ['b', 'Fourth Beta', -.14], ['c', 'Fourth Gamma', -.12], ['d', 'Fourth Delta', -.10], ['e', 'Fourth Epsilon', -.08]];
  const junctions = repeated ? [['p', -.135], ['q', -.105]] : [['p', -.11], ['q', -.09]];
  const nodes = [...stations, ...junctions.map(([id, lng]) => [id, id, lng])];
  const position = id => [51.5, nodes.find(n => n[0] === id)[2]];
  const edges = repeated ? [['ap', 'a', 'p'], ['pq', 'p', 'q'], ['qc', 'q', 'c'], ['cb', 'c', 'b'], ['bd', 'b', 'd']] : [['ab', 'a', 'b'], ['bc', 'b', 'c'], ['cp', 'c', 'p'], ['pq', 'p', 'q'], ['qe', 'q', 'e']];
  const stationIds = repeated ? ['a', 'b', 'c', 'b', 'd'] : ['a', 'b', 'c', 'd', 'e'];
  return validateNetwork({
    version: 1, id: repeated ? 'qa-repeated-bypass' : 'qa-fourth-bypass', name: repeated ? 'QA repeated bypass' : 'QA fourth bypass', city: 'Test city', country: 'Test country', description: 'Synthetic physical-path regression fixture.',
    stations: stations.map(([id, name, lng]) => ({ id, name, lat: 51.5, lng })),
    junctions: junctions.map(([id, lng]) => ({ id, name: `Junction ${id}`, lat: 51.5, lng })),
    tracks: edges.map(([id, fromId, toId]) => ({ id, name: id, fromId, toId, geometry: id === 'pq' ? [position(fromId), [51.502, (position(fromId)[1] + position(toId)[1]) / 2], position(toId)] : [position(fromId), position(toId)], kind: id === 'pq' ? 'passing' : 'main', direction: 'both' })),
    routes: [{ id: 'qa-route', name: 'QA physical route', shortName: 'QA', color: '#3355bb', mode: 'metro', visible: true }],
    services: [{ id: 'qa-source-service', routeId: 'qa-route', name: 'QA source service', kind: 'local', stationIds, skippedStationIds: repeated ? [] : ['d'], stopPattern: repeated ? [true, false, true, true, true] : [true, true, true, false, true], trackPath: edges.map(([trackId]) => ({ trackId })), waypoints: {}, loop: false, direction: 'both', headway: 5, speed: 40, dwell: 30 }],
    sources: [], dataStatus: 'custom', center: [51.5, -.10], zoom: 13, updatedAt: '2026-10-19T00:00:00.000Z',
  });
}

// Hold the actual IndexedDB read callback, rather than racing a timer against React.
// The native transaction completes normally; only delivery to readSavedWorkspace waits.
async function holdWorkspaceHydration(ctx, saved) {
  const seedURL = new URL('__qa_storage_seed', BASE_URL.endsWith('/') ? BASE_URL : `${BASE_URL}/`).href;
  await ctx.route(seedURL, r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Storage fixture</title>' }));
  const seed = await ctx.newPage();
  try {
    await seed.goto(seedURL);
    await seed.evaluate(value => new Promise((resolve, reject) => {
      const request = indexedDB.open('metroweave-workspace', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('state', 'readwrite');
        tx.objectStore('state').put(value, 'workspace');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    }), saved);
  } finally { await seed.close(); }
  await ctx.addInitScript(() => {
    const gate = { pending: [], released: false, release() { this.released = true; this.pending.splice(0).forEach(fn => fn()); } };
    window.__qaHydrationGate = gate;
    const originalGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (key) {
      const request = originalGet.call(this, key);
      if (key === 'workspace' && this.name === 'state' && this.transaction.db.name === 'metroweave-workspace') {
        let handler;
        Object.defineProperty(request, 'onsuccess', { configurable: true, get: () => handler, set: value => { handler = value; } });
        request.addEventListener('success', event => {
          const deliver = () => handler?.call(request, event);
          if (gate.released) deliver(); else gate.pending.push(deliver);
        });
      }
      return request;
    };
  });
}

try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  const ctx = await context(); page = await ctx.newPage(); capture(page);
  await page.goto(BASE_URL, { waitUntil: 'networkidle' }); await page.getByLabel('Interactive transit map').waitFor();
  await check('paste a complete MetroDreamin map including source-only information', async () => {
    const source = nativeSource('paste');
    await page.getByRole('button', { name: 'Import a network', exact: true }).click();
    await page.getByText('Paste MetroDreamin or project JSON', { exact: true }).click();
    await page.getByLabel('Paste map JSON', { exact: true }).fill(JSON.stringify(source));
    await page.getByRole('button', { name: 'Import pasted map', exact: true }).click();
    const n = await until(n => n.name === 'Native paste', 'pasted native map opens');
    assert.deepEqual(n.importMetadata.original, source); assert.equal(n.routes[1].mode, 'ferry'); assert.equal(n.routes[0].icon, 'heart');
    assert.deepEqual(n.services[0].stopPattern, [true, false, false, true, true]); validateNetwork(n);
  });
  await check('native file import and unchanged original-source export', async () => {
    const source = nativeSource('file'); await fileImport(page, 'native.json', JSON.stringify(source));
    imported = await until(n => n.name === 'Native file', 'native file opens');
    await page.getByRole('button', { name: 'Sources and attribution', exact: true }).click();
    const file = await exported('Export original source unchanged');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), source);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'Copy complete project JSON', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Complete project JSON copied');
    const copied = validateNetwork(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))); assert.deepEqual(copied.importMetadata.original, source);
    const compatible = await exported('Export MetroDreamin-compatible map');
    assert.deepEqual(JSON.parse(await readFile(compatible, 'utf8')).metroweave.originalSource, source);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  });
  await check('line-group visibility controls actual rendered route paths', async () => {
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    assert.ok(await page.locator('path.leaflet-interactive[stroke="#7b55c7"]').count());
    await page.getByRole('checkbox', { name: 'Native Group', exact: true }).uncheck();
    await until(n => n.lineGroups[0].visible === false, 'group hides persistently');
    await expect(page.locator('path.leaflet-interactive[stroke="#7b55c7"]')).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Native Group', exact: true }).check();
    await until(n => n.lineGroups[0].visible === true, 'group can be shown again');
    await page.getByRole('checkbox', { name: 'Station labels', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: 'Street basemap', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: 'Diagram view', exact: true }).check();
  });
  await check('complete workspace ZIP restores multiple projects, source archives and settings in a clean profile', async () => {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const file = await exported(/^Complete workspace backup/); await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    const bytes = await readFile(file), bundle = parseWorkspace(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    await writeFile(path.join(output, 'workspace-without-map-packs.zip'), bytes);
    assert.ok(bundle.projects.some(n => n.name === 'Native paste')); assert.ok(bundle.projects.some(n => n.name === 'Native file'));
    assert.equal(bundle.currentProjectId, imported.id); assert.equal(bundle.settings.labels, false); assert.equal(bundle.settings.basemap, false); assert.equal(bundle.settings.schematic, true);
    const restoredContext = await context();
    let restored;
    try {
      restored = await restoredContext.newPage(); capture(restored); await restored.goto(BASE_URL, { waitUntil: 'networkidle' });
      await fileImport(restored, 'workspace.zip', bytes);
      const n = await until(n => n.id === imported.id, 'ZIP restores active project', restored); assert.deepEqual(n.importMetadata.original, nativeSource('file'));
      await restored.getByRole('button', { name: 'Layers', exact: true }).click();
      await expect(restored.getByRole('checkbox', { name: 'Station labels', exact: true })).not.toBeChecked();
      await expect(restored.getByRole('checkbox', { name: 'Street basemap', exact: true })).not.toBeChecked();
      await expect(restored.getByRole('checkbox', { name: 'Diagram view', exact: true })).toBeChecked();
      await restored.getByRole('button', { name: 'My maps', exact: true }).click();
      await expect(restored.locator('.library-item strong').filter({ hasText: 'Native paste' })).toHaveCount(1);
      await restored.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await restored.reload({ waitUntil: 'networkidle' }); await until(n => n.id === imported.id, 'IndexedDB retains restored workspace after reload', restored);
      await restored.getByRole('button', { name: 'Layers', exact: true }).click(); await expect(restored.getByRole('checkbox', { name: 'Diagram view', exact: true })).toBeChecked();
    } catch (error) {
      if (restored) {
        await restored.screenshot({ path: path.join(output, 'workspace-restore-failure.png'), fullPage: true }).catch(() => {});
        await writeFile(path.join(output, 'workspace-restore-failure.txt'), await restored.locator('body').innerText().catch(() => 'Page unavailable'));
      }
      throw error;
    } finally { await restoredContext.close(); }
  });
  await check('workspace restores its selected offline GeoJSON map pack and private Overpass setting', async () => {
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    await page.getByRole('button', { name: 'Offline maps & server sources', exact: true }).click();
    const geojson = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { category: 'park', name: 'QA park' }, geometry: { type: 'Polygon', coordinates: [[[-.15, 51.49], [-.09, 51.49], [-.09, 51.51], [-.15, 51.51], [-.15, 51.49]]] } }] };
    await page.getByLabel('Offline map file', { exact: true }).setInputFiles({ name: 'qa-local-background.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(geojson)) });
    await expect(page.locator('.map-source-list > div.selected strong')).toHaveText('qa-local-background.geojson');
    await page.getByLabel('Overpass endpoint').fill('http://127.0.0.1:8081/api/interpreter');
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Export', exact: true }).click(); const file = await exported(/^Complete workspace backup/); await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    const bytes = await readFile(file), bundle = parseWorkspace(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.notEqual(bundle.settings.basemapSourceId, 'osm-online'); assert.equal(bundle.offlineMaps.geojsonPacks.length, 1);
    const restoredContext = await context(); let restored;
    try {
      restored = await restoredContext.newPage(); capture(restored); await restored.goto(BASE_URL, { waitUntil: 'networkidle' }); await fileImport(restored, 'workspace.zip', bytes);
      await until(n => n.id === imported.id, 'workspace with an offline map pack restores', restored);
      await restored.getByRole('button', { name: 'Layers', exact: true }).click(); await restored.getByRole('button', { name: 'Offline maps & server sources', exact: true }).click();
      await expect(restored.locator('.map-source-list > div.selected strong')).toHaveText('qa-local-background.geojson');
      await expect(restored.getByLabel('Overpass endpoint')).toHaveValue('http://127.0.0.1:8081/api/interpreter');
      await restored.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await restored.getByRole('checkbox', { name: 'Diagram view', exact: true }).uncheck(); await restored.getByRole('checkbox', { name: 'Street basemap', exact: true }).check();
      await expect(restored.locator('.leaflet-overlay-pane path[stroke="#a9c6a0"]')).toHaveCount(1);
      await restored.reload({ waitUntil: 'networkidle' }); await until(n => n.id === imported.id, 'restored map-pack project persists', restored);
      await expect(restored.locator('.leaflet-overlay-pane path[stroke="#a9c6a0"]')).toHaveCount(1);
    } catch (error) {
      if (restored) { await restored.screenshot({ path: path.join(output, 'map-pack-restore-failure.png'), fullPage: true }).catch(() => {}); await writeFile(path.join(output, 'map-pack-restore-failure.txt'), await restored.locator('body').innerText().catch(() => 'Page unavailable')); }
      throw error;
    } finally { await restoredContext.close(); }
  });
  await check('advanced workshop loads a real physical-path example through My maps', async () => {
    await page.getByRole('button', { name: 'Geographic', exact: true }).click();
    await page.getByRole('button', { name: 'My maps', exact: true }).click();
    await page.getByRole('button', { name: /Advanced track workshop/ }).click();
    workshop = await until(n => n.id === 'metroweave-advanced-workshop', 'workshop opens'); validateNetwork(workshop);
    const loop = workshop.passingLoops[0], express = workshop.services.find(s => s.id === 'm-express');
    assert.ok(express.trackPath.some(p => loop.bypassTrackIds.includes(p.trackId)));
    assert.equal(serviceStopsAt(express, express.stationIds.indexOf(loop.stationId)), false);
    await expect(page.getByRole('heading', { name: 'Tracks & junctions' })).toBeVisible();
  });
  await check('switch an express between platform and bypass lanes and create another passing loop', async () => {
    const loop = workshop.passingLoops[0];
    await page.getByRole('button', { name: 'Platform track', exact: true }).click();
    await until(n => { const s = n.services.find(s => s.id === 'm-express'); return serviceStopsAt(s, s.stationIds.indexOf(loop.stationId)) && loop.mainTrackIds.every(id => s.trackPath.some(p => p.trackId === id)); }, 'express can use the platform lane');
    await page.getByRole('button', { name: 'Bypass track', exact: true }).click();
    await until(n => { const s = n.services.find(s => s.id === 'm-express'); return !serviceStopsAt(s, s.stationIds.indexOf(loop.stationId)) && loop.bypassTrackIds.every(id => s.trackPath.some(p => p.trackId === id)); }, 'express uses separate bypass geometry');
    await page.getByRole('combobox', { name: /^Station/ }).selectOption('kilburn');
    await page.getByRole('button', { name: 'Create passing loop', exact: true }).click();
    const n = await until(n => n.passingLoops.length === 2, 'UI creates a new connected passing loop'); assert.equal(n.junctions.length, workshop.junctions.length + 2); validateNetwork(n);
    const added = n.passingLoops.find(p => p.stationId === 'kilburn'); assert.ok(added);
    await page.locator('.infrastructure-card').filter({ has: page.getByText(added.name, { exact: true }) }).getByRole('button', { name: 'Bypass track', exact: true }).click();
    await until(n => n.services.find(s => s.id === 'm-express').trackPath.some(p => added.bypassTrackIds.includes(p.trackId)), 'new passing loop can route the express');
  });
  await check('select an actual track and edit and drag its geometry', async () => {
    const id = workshop.passingLoops[0].bypassTrackIds[0];
    await locate('Finchley Road'); await tracks(); await page.getByRole('button', { name: 'Select & move (V)', exact: true }).click();
    await clickTrack(id); await page.getByLabel('Track name', { exact: true }).fill('QA edited bypass');
    let n = await until(n => n.tracks.find(t => t.id === id).name === 'QA edited bypass', 'track selection exposes its editor');
    const length = n.tracks.find(t => t.id === id).geometry.length;
    await page.getByRole('button', { name: "Edit this track's geometry", exact: true }).click(); await clickTrack(id);
    n = await until(n => n.tracks.find(t => t.id === id).geometry.length === length + 1, 'clicking the selected track inserts a physical geometry point');
    const before = JSON.stringify(n.tracks.find(t => t.id === id).geometry), box = await page.locator('.track-vertex').first().boundingBox(); assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + 30, box.y + 20, { steps: 8 }); await page.mouse.up();
    n = await until(n => JSON.stringify(n.tracks.find(t => t.id === id).geometry) !== before, 'track vertex dragging updates shared infrastructure'); validateNetwork(n);
  });
  await check('zero-lap ring branch starts at the selected station and accepts an appended track', async () => {
    await selectedService('o-loop'); await page.getByRole('button', { name: 'Branch options', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.getByLabel('Branch name', { exact: true }).fill('QA ring zero-lap');
    await dialog.getByRole('combobox', { name: /^Branch point/ }).selectOption('paddington'); await dialog.getByRole('combobox', { name: /^Ring operation/ }).selectOption('0');
    await dialog.getByRole('button', { name: 'Create branch & extend', exact: true }).click();
    let n = await until(n => n.services.some(s => s.name === 'QA ring zero-lap'), 'zero-lap branch is created');
    const s = n.services.find(s => s.name === 'QA ring zero-lap'); zeroBranchId = s.id; assert.deepEqual(s.stationIds, ['paddington']); assert.deepEqual(s.trackPath, []); assert.equal(s.loop, false);
    await locate('Paddington'); await tracks(); await page.getByRole('button', { name: 'Select & move (V)', exact: true }).click();
    const outgoing = n.services.find(s => s.id === 'o-loop').trackPath[0].trackId; await clickTrack(outgoing);
    await page.getByRole('button', { name: 'Append track to selected service', exact: true }).click();
    n = await until(n => n.services.find(s => s.id === zeroBranchId).trackPath.length === 1, 'append control extends along the selected physical track');
    assert.deepEqual(n.services.find(s => s.id === zeroBranchId).stationIds, ['paddington', 'bakerstreet']); validateNetwork(n);
  });
  await check('a zero-lap branch rejoins an existing ring station without adding a circuit', async () => {
    await page.getByRole('button', { name: 'Rejoin an existing station', exact: true }).click();
    await page.getByRole('dialog').getByRole('combobox', { name: /^Rejoin at/ }).selectOption('nottinghill');
    await page.getByRole('button', { name: 'Connect & rejoin', exact: true }).click();
    const n = await until(n => n.services.find(s => s.id === zeroBranchId).stationIds.at(-1) === 'nottinghill', 'branch rejoins the ring');
    assert.deepEqual(n.services.find(s => s.id === zeroBranchId).stationIds, ['paddington', 'bakerstreet', 'nottinghill']); validateNetwork(n);
  });
  await check('a one-lap ring branch completes a circuit, extends and rejoins independently', async () => {
    await selectedService('o-loop'); await page.getByRole('button', { name: 'Branch options', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.getByLabel('Branch name', { exact: true }).fill('QA ring one-lap');
    await dialog.getByRole('combobox', { name: /^Branch point/ }).selectOption('paddington'); await dialog.getByRole('combobox', { name: /^Ring operation/ }).selectOption('1');
    await dialog.getByRole('button', { name: 'Create branch & extend', exact: true }).click();
    let n = await until(n => n.services.some(s => s.name === 'QA ring one-lap'), 'one-lap branch is created');
    const s = n.services.find(s => s.name === 'QA ring one-lap'); lapBranchId = s.id;
    assert.deepEqual(s.stationIds, [...n.services.find(s => s.id === 'o-loop').stationIds, 'paddington']); assert.equal(s.loop, false);
    const count = n.stations.length; await page.getByRole('button', { name: 'Fit network', exact: true }).click(); await mapClick(.64, .75);
    n = await until(n => n.stations.length === count + 1, 'one-lap service extends to a new station');
    const newId = n.stations.at(-1).id; assert.equal(n.services.find(s => s.id === lapBranchId).stationIds.at(-1), newId);
    await page.getByRole('button', { name: 'Rejoin line', exact: true }).click();
    await page.getByRole('dialog').getByRole('combobox', { name: /^Rejoin at/ }).selectOption('nottinghill'); await page.getByRole('button', { name: 'Connect & rejoin', exact: true }).click();
    n = await until(n => n.services.find(s => s.id === lapBranchId).stationIds.at(-1) === 'nottinghill', 'one-lap branch rejoins the existing ring'); validateNetwork(n);
    assert.equal(n.services.find(s => s.id === 'o-loop').loop, true, 'original orbital service remains a ring');
  });
  await check('repeated visits to the same station have independently editable stop flags', async () => {
    await inspect();
    const before = (await state()).services.find(s => s.id === lapBranchId), visits = before.stationIds.map((id, i) => id === 'paddington' ? i : -1).filter(i => i >= 0);
    assert.deepEqual(visits, [0, 13]);
    await page.getByRole('button', { name: 'Skip Paddington', exact: true }).nth(1).click();
    const n = await until(n => !serviceStopsAt(n.services.find(s => s.id === lapBranchId), visits[1]), 'second occurrence becomes pass-through');
    assert.equal(serviceStopsAt(n.services.find(s => s.id === lapBranchId), visits[0]), true); validateNetwork(n);
  });
  await check('advanced infrastructure and occurrence edits survive reload and a full project export', async () => {
    const before = await state(); await page.reload({ waitUntil: 'networkidle' });
    const after = await until(n => n.id === before.id && n.services.some(s => s.id === lapBranchId), 'advanced project restores from device storage'); assert.deepEqual(after, before);
    await page.getByRole('button', { name: 'Export', exact: true }).click(); const file = await exported(/^Project file/); await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    assert.deepEqual(validateNetwork(JSON.parse(await readFile(file, 'utf8'))), before);
    await page.getByRole('button', { name: 'Fit network', exact: true }).click(); await tracks();
    await page.screenshot({ path: path.join(output, 'advanced-final.png'), fullPage: true });
  });
  await check('derived express retains a source bypass at its fourth station occurrence', async () => {
    const fixture = bypassFixture();
    await fileImport(page, 'fourth-bypass.json', JSON.stringify(fixture));
    await until(n => n.id === fixture.id, 'fourth-occurrence bypass fixture opens'); await inspect();
    await page.getByRole('button', { name: 'Express', exact: true }).click();
    const n = await until(n => n.services.length === 2, 'express is derived from the physical source service');
    const source = n.services.find(s => s.id === fixture.services[0].id), express = n.services.find(s => s.id !== source.id);
    assert.equal(express.kind, 'express'); assert.equal(serviceStopsAt(express, 3), false, 'the usual fourth-stop express heuristic must not invent a platform stop on the bypass');
    assert.deepEqual(express.trackPath, fixture.services[0].trackPath); assert.deepEqual(source, fixture.services[0]); validateNetwork(n);
    await selectedService(source.id);
    await page.getByRole('button', { name: 'Branch', exact: true }).click();
    const branched = await until(value => value.services.length === 3, 'a non-ring physical service produces a connected branch');
    const branch = branched.services.find(s => !n.services.some(original => original.id === s.id));
    assert.ok(branch.trackPath?.length, 'non-ring branching retains a physical trunk');
    assert.deepEqual(branch.stationIds, ['a', 'b', 'c']);
    assert.deepEqual(branch.trackPath, fixture.services[0].trackPath.slice(0, 2));
    assert.deepEqual(branched.services.find(s => s.id === source.id), source); validateNetwork(branched);
    await selectedService(branch.id); await inspect();
    await page.getByText('Service settings', { exact: true }).click();
    await page.getByRole('button', { name: 'Reverse stopping order', exact: true }).click();
    const reversed = await until(value => value.services.find(s => s.id === branch.id).stationIds[0] === 'c', 'reverse control reverses the connected physical path');
    const reverseBranch = reversed.services.find(s => s.id === branch.id);
    assert.deepEqual(reverseBranch.stationIds, ['c', 'b', 'a']);
    assert.deepEqual(reverseBranch.trackPath, [{ trackId: 'bc', reverse: true }, { trackId: 'ab', reverse: true }]); validateNetwork(reversed);
  });
  await check('a bypassed first visit cannot borrow the platform from a later visit to the same station', async () => {
    const fixture = bypassFixture(true);
    await fileImport(page, 'repeated-bypass.json', JSON.stringify(fixture));
    const before = await until(n => n.id === fixture.id, 'repeated-station bypass fixture opens'); await inspect();
    await page.getByRole('button', { name: 'Make stop at Bypass Beta', exact: true }).click();
    await expect(page.getByRole('status')).toContainText(/bypass|platform|occurrence|track path/i);
    await expect(page.getByRole('button', { name: 'Make stop at Bypass Beta', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Skip Bypass Beta', exact: true })).toHaveCount(1);
    // Export from the live React state as well as checking the autosave mirror.
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'Copy complete project JSON', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Complete project JSON copied');
    const live = validateNetwork(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())));
    assert.deepEqual(live, before, 'rejected edit preserves the entire current project, including its physical track path and timestamp');
    assert.deepEqual(await state(), before); await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  });
  await check('delayed durable-storage hydration preserves an edit and an import made during boot', async () => {
    for (const action of ['edit', 'import']) {
      const isolated = await context(); let pending;
      try {
        const durable = bypassFixture(); durable.id = 'qa-old-durable'; durable.name = 'Old durable project'; durable.updatedAt = '2099-01-01T00:00:00.000Z';
        await holdWorkspaceHydration(isolated, { current: durable, library: [durable], settings: { labels: false }, savedAt: durable.updatedAt });
        pending = await isolated.newPage(); capture(pending); await pending.goto(BASE_URL, { waitUntil: 'networkidle' });
        await pending.waitForFunction(() => window.__qaHydrationGate?.pending.length > 0);
        const name = action === 'edit' ? 'Edited while storage pending' : 'Imported while storage pending';
        if (action === 'edit') {
          await pending.locator('.project-title').click(); await pending.getByLabel('Project name', { exact: true }).fill(name);
          await pending.getByRole('button', { name: 'Close dialog', exact: true }).click();
        } else {
          const incoming = bypassFixture(true); incoming.id = 'qa-boot-import'; incoming.name = name;
          await fileImport(pending, 'during-boot.json', JSON.stringify(incoming));
        }
        await expect(pending.locator('.project-title')).toContainText(name);
        await pending.evaluate(() => window.__qaHydrationGate.release());
        const current = await until(n => n.name === name, `late storage does not overwrite the boot-time ${action}`, pending);
        assert.notEqual(current.id, durable.id);
        await expect(pending.locator('.save-state')).toContainText('Saved on this device');
        await pending.reload({ waitUntil: 'networkidle' });
        await pending.waitForFunction(() => window.__qaHydrationGate?.pending.length > 0);
        await pending.evaluate(() => window.__qaHydrationGate.release());
        await until(n => n.name === name, `boot-time ${action} remains saved after reload`, pending);
        await expect(pending.locator('.project-title')).toContainText(name);
      } catch (error) {
        if (pending) { await pending.screenshot({ path: path.join(output, `hydration-${action}-failure.png`), fullPage: true }).catch(() => {}); await writeFile(path.join(output, `hydration-${action}-failure.txt`), await pending.locator('body').innerText().catch(() => 'Page unavailable')); }
        throw error;
      } finally { await isolated.close(); }
    }
  });
  assert.equal(started, true, 'QA_START_AT must match a check name'); assert.deepEqual(report.pageErrors, [], 'no uncaught browser errors'); report.success = true;
} catch (e) {
  report.checks.push({ name: stage, status: 'fail', error: e.stack || String(e) }); console.error(`FAIL ${stage}\n${e.stack || e}`); process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(output, 'advanced-failure.png'), fullPage: true }).catch(() => {});
} finally {
  report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'advanced-report.json'), JSON.stringify(report, null, 2)); await browser?.close();
  console.log(`Advanced report: ${path.join(output, 'advanced-report.json')}`);
}
