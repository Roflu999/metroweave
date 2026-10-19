import L from "leaflet";
import { FileSource, PMTiles, TileType, leafletRasterLayer } from "pmtiles";
import type { FeatureCollection, Geometry } from "geojson";

export interface BasemapSource {
  id: string;
  name: string;
  type:
    | "overview"
    | "online"
    | "geojson"
    | "pmtiles-file"
    | "pmtiles-url"
    | "xyz";
  url?: string;
  attribution: string;
  description?: string;
  bytes?: number;
  filename?: string;
  storage?: "bundled" | "indexeddb" | "session" | "server";
  needsReattach?: boolean;
  bounds?: [number, number, number, number];
  minZoom?: number;
  maxZoom?: number;
}
export const ONLINE_BASEMAP: BasemapSource = {
  id: "osm-online",
  name: "OpenStreetMap · online",
  type: "online",
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: "© OpenStreetMap contributors",
  storage: "server",
  description:
    "Interactive online viewing. These standard tiles are never prefetched or stored by the offline worker.",
};
export const DEFAULT_BASEMAP = ONLINE_BASEMAP;
export const OFFLINE_BASEMAP: BasemapSource = {
  id: "offline-overview",
  name: "Offline world overview",
  type: "overview",
  attribution: "Made with Natural Earth",
  storage: "bundled",
  description:
    "A low-detail global overview. Add your own full-world or regional PMTiles archive for street detail.",
};
const DB = "metroweave-offline-maps",
  VERSION = 1;
const sessionFiles = new Map<string, File>();
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      for (const name of ["sources", "packs", "files"])
        if (!r.result.objectStoreNames.contains(name))
          r.result.createObjectStore(name, { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () =>
      reject(r.error ?? new Error("Offline map storage is unavailable."));
  });
}
async function readStore<T>(name: string, id?: string): Promise<T> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const r = id
        ? db.transaction(name).objectStore(name).get(id)
        : db.transaction(name).objectStore(name).getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}
async function writeStores(
  items: { store: string; value?: unknown; remove?: string }[],
): Promise<void> {
  if (!items.length) return;
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        [...new Set(items.map((i) => i.store))],
        "readwrite",
      );
      for (const item of items) {
        if (item.remove) tx.objectStore(item.store).delete(item.remove);
        else tx.objectStore(item.store).put(item.value);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(
          tx.error ??
            new Error("Could not store map pack. Browser storage may be full."),
        );
      tx.onabort = () =>
        reject(tx.error ?? new Error("Map storage was cancelled."));
    });
  } finally {
    db.close();
  }
}
const newId = () => `map-${crypto.randomUUID()}`;
const escaped = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const plainMetadata = (value: unknown) =>
  typeof value === "string"
    ? value
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 400)
    : "";

export async function listBasemapSources(): Promise<BasemapSource[]> {
  const records = await readStore<BasemapSource[]>("sources");
  return [
    DEFAULT_BASEMAP,
    OFFLINE_BASEMAP,
    ...records.map((s) => ({
      ...s,
      needsReattach:
        s.type === "pmtiles-file" &&
        s.storage === "session" &&
        !sessionFiles.has(s.id),
    })),
  ];
}
export async function removeBasemapSource(id: string): Promise<void> {
  if (id === OFFLINE_BASEMAP.id || id === ONLINE_BASEMAP.id) return;
  sessionFiles.delete(id);
  await writeStores([
    { store: "sources", remove: id },
    { store: "packs", remove: id },
    { store: "files", remove: id },
  ]);
}

function checkedGeoJSON(input: unknown): FeatureCollection {
  if (!input || typeof input !== "object")
    throw new Error("Map pack must contain GeoJSON.");
  const data = input as FeatureCollection;
  if (
    data.type !== "FeatureCollection" ||
    !Array.isArray(data.features) ||
    data.features.length > 50000
  )
    throw new Error(
      "Use a GeoJSON FeatureCollection with at most 50,000 features.",
    );
  let vertices = 0;
  const coords = (value: unknown, depth = 0): void => {
    if (depth > 8 || !Array.isArray(value))
      throw new Error("Invalid GeoJSON coordinates.");
    if (typeof value[0] === "number") {
      if (
        value.length < 2 ||
        !Number.isFinite(value[0]) ||
        !Number.isFinite(value[1]) ||
        Math.abs(value[0]) > 180 ||
        Math.abs(value[1]) > 90
      )
        throw new Error(
          "Map coordinates must be longitude, latitude in degrees.",
        );
      if (++vertices > 1000000)
        throw new Error("Simplify this map to at most one million vertices.");
    } else for (const child of value) coords(child, depth + 1);
  };
  const geometry = (g: Geometry | null, depth = 0): void => {
    if (!g) return;
    if (depth > 6) throw new Error("GeoJSON geometry nesting is too deep.");
    if (g.type === "GeometryCollection") {
      if (!Array.isArray(g.geometries))
        throw new Error("Invalid geometry collection.");
      g.geometries.forEach((x) => geometry(x, depth + 1));
    } else if (
      [
        "Point",
        "MultiPoint",
        "LineString",
        "MultiLineString",
        "Polygon",
        "MultiPolygon",
      ].includes(g.type)
    )
      coords(g.coordinates);
    else throw new Error("Unsupported GeoJSON geometry.");
  };
  for (const f of data.features) {
    if (f?.type !== "Feature") throw new Error("Invalid GeoJSON feature.");
    geometry(f.geometry);
  }
  return data;
}
export async function importGeoJSONMap(
  file: File,
  name = file.name,
): Promise<BasemapSource> {
  if (file.size > 40 * 1024 * 1024)
    throw new Error(
      "GeoJSON map packs are limited to 40 MB; use a PMTiles archive for larger areas.",
    );
  const data = checkedGeoJSON(JSON.parse(await file.text()));
  const source: BasemapSource = {
    id: newId(),
    name: name.slice(0, 160),
    type: "geojson",
    attribution: "User supplied map data · verify its source license",
    description: "Stored in this browser for offline use.",
    bytes: file.size,
    filename: file.name,
    storage: "indexeddb",
  };
  await writeStores([
    { store: "sources", value: source },
    { store: "packs", value: { id: source.id, data } },
  ]);
  return source;
}
/** FileSource reads byte slices. Large files remain on disk and are never read into a single buffer. */
export async function importPMTilesFile(
  file: File,
  persist = file.size <= 250 * 1024 * 1024,
): Promise<BasemapSource> {
  const archive = new PMTiles(new FileSource(file)),
    header = await archive.getHeader();
  if (header.jsonMetadataLength > 2 * 1024 * 1024)
    throw new Error("Archive metadata exceeds the 2 MB safety limit.");
  const metadata = (await archive.getMetadata()) as Record<string, unknown>;
  if (
    ![
      TileType.Mvt,
      TileType.Png,
      TileType.Jpeg,
      TileType.Webp,
      TileType.Avif,
    ].includes(header.tileType)
  )
    throw new Error(
      "This PMTiles tile encoding is not supported by the Leaflet renderer.",
    );
  if (persist && file.size > 250 * 1024 * 1024)
    throw new Error(
      "Keep archives over 250 MB as disk files or serve them at /maps/. Browser copies are limited to 250 MB.",
    );
  if (persist && navigator.storage?.estimate) {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (quota && quota - usage < file.size * 1.15)
      throw new Error(
        "Insufficient browser quota. Use the archive as a session file or serve it from /maps/.",
      );
  }
  const source: BasemapSource = {
    id: newId(),
    name: file.name,
    type: "pmtiles-file",
    attribution:
      plainMetadata(metadata.attribution) ||
      "Map archive data · verify source license",
    filename: file.name,
    bytes: file.size,
    storage: persist ? "indexeddb" : "session",
    description: persist
      ? "Archive stored in browser; available offline after reload."
      : "Disk archive; reattach this file after reloading. No full archive copy is made.",
    bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
  };
  await writeStores([
    { store: "sources", value: source },
    ...(persist ? [{ store: "files", value: { id: source.id, file } }] : []),
  ]);
  sessionFiles.set(source.id, file);
  return source;
}
export async function reattachPMTilesFile(
  source: BasemapSource,
  file: File,
): Promise<BasemapSource> {
  if (source.type !== "pmtiles-file")
    throw new Error("This source is not a disk archive.");
  if (source.bytes !== file.size || source.filename !== file.name)
    throw new Error(
      "Reattach the original archive with the same name and byte size.",
    );
  await new PMTiles(new FileSource(file)).getHeader();
  sessionFiles.set(source.id, file);
  return { ...source, needsReattach: false };
}
export async function saveTileSource(input: {
  name: string;
  url: string;
  attribution: string;
  type: "xyz" | "pmtiles-url";
}): Promise<BasemapSource> {
  const url = input.url.trim();
  let parsed: URL;
  try {
    parsed = new URL(
      url.replaceAll("{z}", "0").replaceAll("{x}", "0").replaceAll("{y}", "0"),
      location.href,
    );
  } catch {
    throw new Error("Enter a valid map URL.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    throw new Error("Use an HTTP(S) URL without embedded credentials.");
  if (
    input.type === "xyz" &&
    !["{z}", "{x}", "{y}"].every((token) => url.includes(token))
  )
    throw new Error("XYZ URLs must contain {z}, {x} and {y}.");
  const source: BasemapSource = {
    ...input,
    id: newId(),
    url,
    name: input.name.slice(0, 160) || "Self-hosted map",
    attribution: input.attribution.slice(0, 400) || "User supplied map source",
    storage: "server",
    description:
      "Served by your endpoint; availability depends on that server. Use localhost for offline operation.",
  };
  await writeStores([{ store: "sources", value: source }]);
  return source;
}

function geoLayer(data: FeatureCollection, attribution: string): L.GeoJSON {
  return L.geoJSON(data, {
    attribution: escaped(attribution),
    interactive: false,
    style: (f) => {
      const p = f?.properties ?? {},
        category = p.category;
      return category === "road"
        ? {
            color: p.highway === "primary" ? "#d2b884" : "#c2bcae",
            weight: p.highway === "footway" ? 0.7 : 1.6,
            opacity: 0.8,
          }
        : category === "water"
          ? {
              color: "#98bec6",
              fillColor: "#c5dfe2",
              weight: 0.7,
              fillOpacity: 0.9,
            }
          : category === "park"
            ? {
                color: "#a9c6a0",
                fillColor: "#d7e5c6",
                weight: 0.5,
                fillOpacity: 0.7,
              }
            : category === "building"
              ? {
                  color: "#c9c5ba",
                  fillColor: "#e7e2d8",
                  weight: 0.4,
                  fillOpacity: 0.7,
                }
              : category === "rail"
                ? { color: "#b1a7ad", weight: 1, dashArray: "3 3" }
                : {
                    color: "#bac5b1",
                    fillColor: "#dde5d7",
                    weight: 0.6,
                    fillOpacity: 0.75,
                  };
    },
    pointToLayer: (_f, p) =>
      L.circleMarker(p, { radius: 2, color: "#b3c5cd", interactive: false }),
  });
}
export async function createBasemapLayer(
  source: BasemapSource,
): Promise<L.Layer> {
  if (source.type === "overview") {
    const r = await fetch(
      new URL("data/world-overview.geojson", document.baseURI),
    );
    if (!r.ok) throw new Error(`Offline overview could not load: ${r.status}`);
    return geoLayer(
      (await r.json()) as FeatureCollection,
      "Made with Natural Earth · public domain",
    );
  }
  if (source.type === "geojson") {
    const pack = await readStore<{ data: FeatureCollection } | undefined>(
      "packs",
      source.id,
    );
    if (!pack)
      throw new Error(
        "This browser map pack was removed. Import the GeoJSON again.",
      );
    return geoLayer(pack.data, source.attribution);
  }
  if (source.type === "online" || source.type === "xyz")
    return L.tileLayer(source.url!, {
      attribution: escaped(source.attribution),
      maxZoom: 22,
      maxNativeZoom: source.maxZoom ?? 19,
      className: "muted-tiles",
    });
  let archive: PMTiles;
  if (source.type === "pmtiles-file") {
    let file = sessionFiles.get(source.id);
    if (!file && source.storage === "indexeddb") {
      const stored = await readStore<{ file: File } | undefined>(
        "files",
        source.id,
      );
      file = stored?.file;
      if (file) sessionFiles.set(source.id, file);
    }
    if (!file)
      throw new Error(
        "Reattach this PMTiles disk archive after reloading, or serve it from /maps/.",
      );
    archive = new PMTiles(new FileSource(file));
  } else archive = new PMTiles(new URL(source.url!, document.baseURI).href);
  const header = await archive.getHeader();
  (globalThis as typeof globalThis & { L: typeof L }).L = L;
  if (header.tileType === TileType.Mvt) {
    const { leafletLayer } = await import("protomaps-leaflet");
    return leafletLayer({
      url: archive,
      flavor: "light",
      lang: "en",
      attribution: escaped(source.attribution),
      maxDataZoom: header.maxZoom,
    }) as unknown as L.Layer;
  }
  if (
    [TileType.Png, TileType.Jpeg, TileType.Webp, TileType.Avif].includes(
      header.tileType,
    )
  )
    return leafletRasterLayer(archive, {
      attribution: escaped(source.attribution),
      maxNativeZoom: header.maxZoom,
    }) as L.Layer;
  throw new Error(
    "Unsupported PMTiles encoding. Use MVT or raster PNG/JPEG/WebP/AVIF.",
  );
}
export interface OfflineMapExport {
  version: 1;
  sources: BasemapSource[];
  geojsonPacks: { id: string; data: FeatureCollection }[];
}
export async function exportOfflineMaps(): Promise<OfflineMapExport> {
  const sources = await readStore<BasemapSource[]>("sources");
  return {
    version: 1,
    sources: sources.map((s) =>
      s.type === "pmtiles-file"
        ? { ...s, storage: "session", needsReattach: true }
        : s,
    ),
    geojsonPacks: await readStore("packs"),
  };
}
export async function importOfflineMaps(
  input: unknown,
): Promise<Record<string, string>> {
  const payload = input as OfflineMapExport;
  if (
    payload?.version !== 1 ||
    !Array.isArray(payload.sources) ||
    !Array.isArray(payload.geojsonPacks) ||
    payload.sources.length > 100 ||
    payload.geojsonPacks.length > 100
  )
    throw new Error("Invalid offline map backup.");
  const items: { store: string; value: unknown }[] = [];
  const remap = new Map<string, string>();
  for (const source of payload.sources) {
    if (
      !source ||
      typeof source.id !== "string" ||
      typeof source.name !== "string" ||
      !["geojson", "pmtiles-file", "pmtiles-url", "xyz"].includes(source.type)
    )
      throw new Error("Unsupported map source in backup.");
    if (source.url) {
      const u = new URL(
        source.url
          .replaceAll("{z}", "0")
          .replaceAll("{x}", "0")
          .replaceAll("{y}", "0"),
        location.href,
      );
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
        throw new Error("Unsafe map URL in backup.");
    }
    const id = newId();
    remap.set(source.id, id);
    items.push({
      store: "sources",
      value: {
        ...source,
        id,
        ...(source.type === "pmtiles-file"
          ? { storage: "session", needsReattach: true }
          : {}),
      },
    });
  }
  for (const pack of payload.geojsonPacks) {
    const id = remap.get(pack.id);
    if (id)
      items.push({
        store: "packs",
        value: { id, data: checkedGeoJSON(pack.data) },
      });
  }
  await writeStores(items);
  return Object.fromEntries(remap);
}
