import { strFromU8, unzipSync } from "fflate";
import type {
  CatalogEntry,
  LatLng,
  Network,
  Route,
  Service,
  Station,
} from "./types";
import {
  serviceCoordinates,
  serviceSegmentGeometries,
  serviceStopsAt,
  validateNetwork,
} from "./engine";
import { copyJSONData } from "./backup";
export { exportNetworkCSV } from "./backup";

type Row = Record<string, string>;
const MB = 1024 * 1024;
const COLORS = [
  "#8a61ff",
  "#20bba6",
  "#f08d47",
  "#e65785",
  "#4a9dea",
  "#d4b03c",
  "#ce67d7",
  "#72ac55",
];
const MAX_ROWS = 1_500_000;
const now = () => new Date().toISOString();
const key = (prefix: string, id: string) => {
  const encoded = encodeURIComponent(id);
  if (encoded.length <= 120) return `${prefix}-${encoded}`;
  let hash = 2166136261;
  for (const c of id) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return `${prefix}-${encoded.slice(0, 110)}-${(hash >>> 0).toString(36)}`;
};
const validCoord = (lat: number, lng: number) =>
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lng) <= 180;
const numeric = (value: unknown) =>
  (typeof value === "string" && value.trim() === "") ||
  value === null ||
  value === undefined
    ? NaN
    : Number(value);
const text = (value: unknown, fallback = "") =>
  typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : fallback;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const color = (value: unknown, index: number) =>
  /^#?[0-9a-f]{6}$/i.test(text(value))
    ? `#${text(value).replace(/^#/, "")}`
    : COLORS[index % COLORS.length];
const distance = (a: LatLng, b: LatLng) => {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad,
    dLng = (b[1] - a[1]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
};
const position = (s: Station): LatLng => [s.lat, s.lng];
const centerOf = (stations: Station[]): LatLng =>
  stations.length
    ? [
        stations.reduce((n, s) => n + s.lat, 0) / stations.length,
        stations.reduce((n, s) => n + s.lng, 0) / stations.length,
      ]
    : [0, 0];
const baseNetwork = (
  name: string,
  dataStatus: Network["dataStatus"],
): Network => ({
  version: 1,
  id: `import-${Date.now().toString(36)}`,
  name,
  city: "",
  country: "",
  description: "",
  stations: [],
  routes: [],
  services: [],
  sources: [],
  dataStatus,
  center: [0, 0],
  zoom: 11,
  updatedAt: now(),
});
const baseService = (
  id: string,
  routeId: string,
  stationIds: string[],
): Service => ({
  id,
  routeId,
  name: "Local",
  kind: "local",
  stationIds,
  skippedStationIds: [],
  waypoints: {},
  loop: stationIds.length > 2 && stationIds[0] === stationIds.at(-1),
  direction: "forward",
  headway: 8,
  speed: 36,
  dwell: 30,
});

/** RFC-style CSV: preserves quoted commas, escaped quotes, multiline values, and UTF-8 BOMs. */
export function parseCsv(input: string): Row[] {
  if (input.length > 180 * MB)
    throw new Error(
      "A GTFS table exceeds the 180 MB browser import limit. Split or simplify the feed.",
    );
  const source = input.replace(/^\uFEFF/, "");
  const rows: Row[] = [];
  let headers: string[] | undefined,
    fields: string[] = [],
    field = "",
    quoted = false,
    closedQuote = false;
  const finishRow = () => {
    fields.push(field);
    field = "";
    closedQuote = false;
    if (fields.length > 1000)
      throw new Error("CSV exceeds the 1,000-column browser import limit.");
    if (fields.every((v) => v === "")) {
      fields = [];
      return;
    }
    if (!headers) {
      headers = fields.map((v) => v.trim());
      if (new Set(headers).size !== headers.length || headers.some((v) => !v))
        throw new Error("CSV headers must be unique and nonempty.");
    } else {
      if (fields.length !== headers.length)
        throw new Error(
          `CSV row ${rows.length + 2} has ${fields.length} fields; expected ${headers.length}.`,
        );
      rows.push(Object.fromEntries(headers.map((h, i) => [h, fields[i]])));
      if (rows.length > MAX_ROWS)
        throw new Error(
          `GTFS table exceeds ${MAX_ROWS.toLocaleString()} rows. Use a smaller regional feed.`,
        );
    }
    fields = [];
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else field += c;
    } else if (c === "," || c === "\n" || c === "\r") {
      if (c === ",") {
        fields.push(field);
        field = "";
        closedQuote = false;
        if (fields.length > 1000)
          throw new Error("CSV exceeds the 1,000-column browser import limit.");
      } else {
        finishRow();
        if (c === "\r" && source[i + 1] === "\n") i++;
      }
    } else if (c === '"' && field === "" && !closedQuote) quoted = true;
    else if (closedQuote) {
      if (c !== " " && c !== "\t")
        throw new Error(
          `Unexpected character after a closing CSV quote near position ${i}.`,
        );
    } else if (c === '"')
      throw new Error(
        `Unexpected quote in unquoted CSV field near position ${i}.`,
      );
    else field += c;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  if (field || fields.length || closedQuote) finishRow();
  return rows;
}

function gtfsMode(raw: string): Route["mode"] | undefined {
  const n = Number(raw);
  if (n === 1 || (n >= 400 && n <= 404)) return "metro";
  if (n === 12 || n === 405) return "monorail";
  if (n === 0 || (n >= 900 && n < 1000)) return "tram";
  if (n === 2 || (n >= 100 && n < 200)) return "rail";
  return undefined;
}

/** Imports topology and trip variants, not an active timetable or real-time service. */
export async function importGTFS(buffer: ArrayBuffer): Promise<Network> {
  if (buffer.byteLength > 80 * MB)
    throw new Error(
      "This ZIP exceeds the 80 MB browser import limit. Use a smaller regional GTFS feed.",
    );
  const wanted = new Set([
    "stops.txt",
    "routes.txt",
    "trips.txt",
    "stop_times.txt",
    "shapes.txt",
    "frequencies.txt",
    "agency.txt",
    "feed_info.txt",
    "attributions.txt",
  ]);
  const found = new Set<string>();
  let expanded = 0;
  let zip: Record<string, Uint8Array>;
  try {
    zip = unzipSync(new Uint8Array(buffer), {
      filter: (f) => {
        const name = f.name.split(/[\\/]/).at(-1)!.toLowerCase();
        if (!wanted.has(name)) return false;
        if (found.has(name))
          throw new Error(
            `The ZIP contains multiple ${name} tables. Import one feed at a time.`,
          );
        found.add(name);
        expanded += f.originalSize;
        if (f.originalSize > 180 * MB || expanded > 240 * MB)
          throw new Error(
            "Expanded GTFS tables exceed the 240 MB browser import limit.",
          );
        return true;
      },
    });
  } catch (e) {
    throw new Error(
      `Unable to open GTFS ZIP: ${e instanceof Error ? e.message : "invalid archive"}`,
    );
  }
  const tables = new Map(
    Object.entries(zip).map(([n, v]) => [
      n.split(/[\\/]/).at(-1)!.toLowerCase(),
      v,
    ]),
  );
  for (const file of ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt"])
    if (!tables.has(file)) throw new Error(`GTFS ZIP is missing ${file}.`);
  const read = (name: string) =>
    tables.has(name) ? parseCsv(strFromU8(tables.get(name)!)) : [];
  const requireColumns = (rows: Row[], columns: string[], file: string) => {
    if (!rows.length) throw new Error(`${file} contains no data rows.`);
    for (const column of columns)
      if (!(column in rows[0]))
        throw new Error(`${file} is missing the ${column} column.`);
  };
  const routeRows = read("routes.txt"),
    stopRows = read("stops.txt"),
    tripRows = read("trips.txt");
  requireColumns(routeRows, ["route_id", "route_type"], "routes.txt");
  requireColumns(stopRows, ["stop_id"], "stops.txt");
  requireColumns(tripRows, ["trip_id", "route_id"], "trips.txt");
  const agency = read("agency.txt"),
    feed = read("feed_info.txt")[0];
  const name =
    feed?.feed_publisher_name ||
    agency
      .map((a) => a.agency_name)
      .filter(Boolean)
      .join(" / ") ||
    "Imported GTFS network";
  const network = baseNetwork(name, "gtfs");
  const routeMap = new Map<string, Route>();
  for (const r of routeRows) {
    const mode = gtfsMode(r.route_type);
    if (!mode) continue;
    if (routeMap.has(r.route_id))
      throw new Error(`Duplicate GTFS route_id: ${r.route_id}`);
    const route: Route = {
      id: key("gtfs-route", r.route_id),
      name: r.route_long_name || r.route_short_name || r.route_id,
      shortName: r.route_short_name || r.route_id,
      color: color(r.route_color, routeMap.size),
      mode,
      visible: true,
    };
    routeMap.set(r.route_id, route);
    network.routes.push(route);
  }
  if (!network.routes.length)
    throw new Error(
      "No metro, rail, tram, or monorail routes were found in this GTFS feed.",
    );
  const allStops = new Map<string, Row>();
  for (const r of stopRows) {
    if (allStops.has(r.stop_id))
      throw new Error(`Duplicate GTFS stop_id: ${r.stop_id}`);
    allStops.set(r.stop_id, r);
  }
  const usedStops = new Map<string, Station>();
  let invalidStops = 0,
    noBoarding = 0;
  const getStation = (id: string): Station | undefined => {
    if (usedStops.has(id)) return usedStops.get(id);
    const r = allStops.get(id);
    if (!r) {
      invalidStops++;
      return;
    }
    const parent = allStops.get(r.parent_station);
    const lat = numeric(r.stop_lat || parent?.stop_lat),
      lng = numeric(r.stop_lon || parent?.stop_lon);
    if (!validCoord(lat, lng)) {
      invalidStops++;
      return;
    }
    const station: Station = {
      id: key("gtfs-stop", id),
      name: r.stop_name || parent?.stop_name || id,
      lat,
      lng,
    };
    if (r.stop_code) station.code = r.stop_code;
    if (r.parent_station)
      station.transferGroup = key("gtfs-stop", r.parent_station);
    const access =
      r.wheelchair_boarding && r.wheelchair_boarding !== "0"
        ? r.wheelchair_boarding
        : parent?.wheelchair_boarding;
    if (access === "1" || access === "2") station.accessible = access === "1";
    usedStops.set(id, station);
    return station;
  };
  const trips = new Map<string, Row>();
  for (const t of tripRows)
    if (routeMap.has(t.route_id)) {
      if (trips.has(t.trip_id))
        throw new Error(`Duplicate GTFS trip_id: ${t.trip_id}`);
      trips.set(t.trip_id, t);
    }
  const times = new Map<string, Row[]>();
  const timeRows = read("stop_times.txt");
  requireColumns(
    timeRows,
    ["trip_id", "stop_id", "stop_sequence"],
    "stop_times.txt",
  );
  for (const r of timeRows)
    if (trips.has(r.trip_id)) {
      if (!Number.isFinite(numeric(r.stop_sequence)))
        throw new Error(`Invalid stop_sequence for trip ${r.trip_id}.`);
      const list = times.get(r.trip_id) || [];
      list.push(r);
      times.set(r.trip_id, list);
    }
  const shapes = new Map<string, { seq: number; p: LatLng }[]>();
  const requestedShapes = new Set(
    Array.from(trips.values(), (t) => t.shape_id).filter(Boolean),
  );
  for (const r of read("shapes.txt"))
    if (requestedShapes.has(r.shape_id)) {
      const p: LatLng = [numeric(r.shape_pt_lat), numeric(r.shape_pt_lon)],
        seq = numeric(r.shape_pt_sequence);
      if (!validCoord(...p) || !Number.isFinite(seq)) continue;
      const list = shapes.get(r.shape_id) || [];
      list.push({ seq, p });
      shapes.set(r.shape_id, list);
    }
  const shapePaths = new Map(
    Array.from(shapes, ([id, list]) => [
      id,
      list.sort((a, b) => a.seq - b.seq).map((v) => v.p),
    ]),
  );
  const frequencies = new Map<string, number[]>();
  for (const r of read("frequencies.txt")) {
    const seconds = numeric(r.headway_secs);
    if (trips.has(r.trip_id) && seconds > 0 && seconds <= 86400) {
      const f = frequencies.get(r.trip_id) || [];
      f.push(seconds / 60);
      frequencies.set(r.trip_id, f);
    }
  }
  const patterns = new Map<
    string,
    { service: Service; frequencies: number[]; direction: string }
  >();
  for (const [tripId, t] of trips) {
    const ordered = (times.get(tripId) || []).sort(
      (a, b) => Number(a.stop_sequence) - Number(b.stop_sequence),
    );
    const served: string[] = [],
      skipped: string[] = [],
      boarding = new Set<string>();
    for (const r of ordered) {
      const s = getStation(r.stop_id);
      if (!s) continue;
      if (served.at(-1) !== s.id) served.push(s.id);
      if (r.pickup_type === "1" && r.drop_off_type === "1") {
        skipped.push(s.id);
        noBoarding++;
      } else boarding.add(s.id);
    }
    const skippedOnly = [...new Set(skipped)].filter((id) => !boarding.has(id));
    if (served.filter((id) => !skippedOnly.includes(id)).length < 2) continue;
    const signature = JSON.stringify([
      t.route_id,
      t.direction_id || "",
      served,
      skippedOnly,
      t.shape_id || "",
    ]);
    const existing = patterns.get(signature);
    if (existing) {
      existing.frequencies.push(...(frequencies.get(tripId) || []));
      continue;
    }
    if (patterns.size >= 10000)
      throw new Error(
        "The feed has more than 10,000 distinct rail service patterns. Import a smaller regional feed.",
      );
    const route = routeMap.get(t.route_id)!;
    const service = baseService(
      `gtfs-service-${patterns.size + 1}`,
      route.id,
      served,
    );
    service.name =
      t.trip_headsign ||
      t.trip_short_name ||
      `Direction ${t.direction_id || "0"}`;
    service.speed =
      route.mode === "rail" ? 60 : route.mode === "tram" ? 24 : 36;
    service.skippedStationIds = skippedOnly;
    const label = `${service.name} ${route.name}`;
    service.kind = /\bexpress\b|特快|急行|快速|快线/i.test(label)
      ? "express"
      : /\blimited\b|区间|區間/i.test(label)
        ? "limited"
        : /\bshuttle\b|接驳|接駁/i.test(label)
          ? "shuttle"
          : "local";
    const path = shapePaths.get(t.shape_id);
    if (path && path.length >= 2) service.shape = path;
    patterns.set(signature, {
      service,
      frequencies: [...(frequencies.get(tripId) || [])],
      direction: t.direction_id || "",
    });
  }
  for (const { service, frequencies: values } of patterns.values()) {
    if (values.length) {
      values.sort((a, b) => a - b);
      service.headway = Math.max(
        0.25,
        Math.round(values[Math.floor(values.length / 2)] * 100) / 100,
      );
    }
    network.services.push(service);
  }
  if (!network.services.length)
    throw new Error(
      "No rail trips have at least two valid boarding/alighting stops.",
    );
  // Infer skipped stops only against an actual longer, same-direction pattern with matching terminals.
  const grouped = new Map<string, Service[]>();
  for (const { service, direction } of patterns.values()) {
    const g = `${service.routeId}|${direction}|${service.stationIds[0]}|${service.stationIds.at(-1)}`;
    const list = grouped.get(g) || [];
    list.push(service);
    grouped.set(g, list);
  }
  const stationById = new Map([...usedStops.values()].map((s) => [s.id, s]));
  let inferenceWork = 0;
  for (const group of grouped.values()) {
    if (group.length > 150) continue; // Avoid quadratic work for unusually varied feeds; explicit GTFS pass-throughs remain intact.
    const longest = [...group].sort(
      (a, b) => b.stationIds.length - a.stationIds.length,
    );
    for (const s of group)
      for (const other of longest) {
        if (other.stationIds.length <= s.stationIds.length) break;
        let i = 0;
        for (const id of other.stationIds) if (id === s.stationIds[i]) i++;
        if (i === s.stationIds.length) {
          const missing = other.stationIds.filter(
            (id) => !s.stationIds.includes(id),
          );
          // A stop subsequence alone does not establish a shared corridor: express tracks may take a different alignment.
          if (!s.shape || !other.shape) continue;
          if (s.shape !== other.shape) {
            const work =
              s.shape.length * (missing.length + other.stationIds.length);
            if (work > 250000 || inferenceWork + work > 3000000) continue;
            inferenceWork += work;
            if (
              !missing.every(
                (id) =>
                  projection(position(stationById.get(id)!), s.shape!)
                    .distance <= 0.15,
              ) ||
              !followsStops(
                s.shape,
                other.stationIds.map((id) => position(stationById.get(id)!)),
              )
            )
              continue;
          }
          s.skippedStationIds = [
            ...new Set([...s.skippedStationIds, ...missing]),
          ];
          s.stationIds = [...other.stationIds];
          if (s.kind === "local") s.kind = "limited";
          break;
        }
      }
  }
  network.stations = [...usedStops.values()];
  const usedRoutes = new Set(network.services.map((s) => s.routeId));
  network.routes = network.routes.filter((r) => usedRoutes.has(r.id));
  network.center = centerOf(network.stations);
  const notes = [
    `Imported ${network.routes.length} rail routes and ${network.services.length} ordered trip patterns, including direction and shape variants.`,
    "All feed dates are combined; service calendars, stop times, fares, transfers.txt rules and real-time operations are not modeled. Headways are planning assumptions unless a pattern has frequencies.txt values (median headway). Speed and dwell are editable assumptions.",
  ];
  if (routeRows.length > routeMap.size)
    notes.push(
      `${routeRows.length - routeMap.size} non-rail routes were excluded.`,
    );
  if (invalidStops)
    notes.push(
      `${invalidStops} trip-stop references had missing or invalid coordinates and were omitted; verify continuity.`,
    );
  if (noBoarding)
    notes.push(
      "Stops with both pickup and drop-off unavailable are retained as skipped stops.",
    );
  const shapeCount = network.services.filter((s) => s.shape).length;
  if (shapeCount < network.services.length)
    notes.push(
      `${network.services.length - shapeCount} patterns have no valid shape and use straight station connections.`,
    );
  notes.push(
    "Skipped stops inferred from longer patterns require a verified shared shape alignment. Parent-station groups are retained; platform-level stops are not merged.",
  );
  network.description = notes.join(" ");
  const publisherUrl = feed?.feed_publisher_url || agency[0]?.agency_url;
  if (publisherUrl && /^https?:\/\//i.test(publisherUrl))
    network.sources.push({
      title: name,
      url: publisherUrl,
      license: "Check the feed publisher’s reuse terms",
      accessed: now().slice(0, 10),
    });
  network.sources.push({
    title: "GTFS Schedule reference",
    url: "https://gtfs.org/documentation/schedule/reference/",
    accessed: now().slice(0, 10),
  });
  return validateNetwork(network);
}

function coordinates(raw: unknown): LatLng[] {
  if (!Array.isArray(raw))
    throw new Error("GeoJSON coordinates must be an array.");
  return raw.map((p) => {
    if (!Array.isArray(p) || p.length < 2)
      throw new Error("Invalid GeoJSON coordinate.");
    const lat = numeric(p[1]),
      lng = numeric(p[0]);
    if (!validCoord(lat, lng))
      throw new Error(
        "GeoJSON coordinate is outside valid longitude/latitude bounds.",
      );
    return [lat, lng];
  });
}

function projection(
  point: LatLng,
  path: LatLng[],
): { distance: number; along: number } {
  let closest = Infinity,
    along = 0,
    cumulative = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1],
      b = path[i],
      scale = Math.cos((point[0] * Math.PI) / 180);
    const dx = (b[1] - a[1]) * scale,
      dy = b[0] - a[0];
    const denominator = dx * dx + dy * dy;
    const t = denominator
      ? Math.max(
          0,
          Math.min(
            1,
            ((point[1] - a[1]) * scale * dx + (point[0] - a[0]) * dy) /
              denominator,
          ),
        )
      : 0;
    const segmentLength = distance(a, b),
      d = distance(point, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    if (d < closest) {
      closest = d;
      along = cumulative + segmentLength * t;
    }
    cumulative += segmentLength;
  }
  return { distance: closest, along };
}

/** Standard Point/LineString/MultiLineString GeoJSON plus lossless MetroWeave properties. */
export function importGeoJSON(input: unknown): Network {
  const root = object(input);
  const features =
    root.type === "FeatureCollection"
      ? root.features
      : root.type === "Feature"
        ? [root]
        : [{ type: "Feature", geometry: root, properties: {} }];
  if (!Array.isArray(features) || features.length > 150000)
    throw new Error("GeoJSON must contain at most 150,000 features.");
  const native = object(root.metroweave),
    metadata = object(native.network);
  if (native.formatVersion !== undefined && native.formatVersion !== 1)
    throw new Error("Unsupported MetroWeave GeoJSON metadata version.");
  const network = baseNetwork(
    text(
      metadata.name,
      text(object(root.properties).name, "Imported GeoJSON network"),
    ),
    "imported",
  );
  network.city = text(metadata.city);
  network.country = text(metadata.country);
  if (native.formatVersion === 1) {
    if (metadata.junctions !== undefined)
      network.junctions = metadata.junctions as Network["junctions"];
    if (metadata.tracks !== undefined)
      network.tracks = metadata.tracks as Network["tracks"];
    if (metadata.passingLoops !== undefined)
      network.passingLoops = metadata.passingLoops as Network["passingLoops"];
    if (metadata.lineGroups !== undefined)
      network.lineGroups = metadata.lineGroups as Network["lineGroups"];
    if (metadata.importMetadata !== undefined)
      network.importMetadata =
        metadata.importMetadata as Network["importMetadata"];
  }
  const points: Station[] = [],
    pending: {
      path: LatLng[];
      props: Record<string, unknown>;
      part: number;
    }[] = [];
  const ids = new Set<string>();
  let vertices = 0,
    ignored = 0,
    generated = 0;
  for (const raw of features) {
    const feature = object(raw),
      geometry = object(feature.geometry),
      props = object(feature.properties);
    if (
      native.formatVersion === 1 &&
      (props.entity === "junction" || props.entity === "track")
    )
      continue;
    if (geometry.type === "Point") {
      const p = coordinates([geometry.coordinates])[0];
      vertices++;
      const data = object(props.station);
      const id = text(
        data.id || props.stationId || feature.id || props.id,
        `geo-station-${points.length + 1}`,
      );
      if (ids.has(id)) throw new Error(`Duplicate GeoJSON station ID: ${id}`);
      ids.add(id);
      const s: Station = {
        id,
        name: text(data.name || props.name, `Station ${points.length + 1}`),
        lat: p[0],
        lng: p[1],
      };
      const code = text(data.code || props.code),
        transferGroup = text(data.transferGroup || props.transferGroup);
      if (code) s.code = code;
      if (transferGroup) s.transferGroup = transferGroup;
      if (typeof (data.accessible ?? props.accessible) === "boolean")
        s.accessible = (data.accessible ?? props.accessible) as boolean;
      if (typeof (data.isWaypoint ?? props.isWaypoint) === "boolean")
        s.isWaypoint = (data.isWaypoint ?? props.isWaypoint) as boolean;
      if (["above", "at", "below"].includes(text(data.grade ?? props.grade)))
        s.grade = (data.grade ?? props.grade) as Station["grade"];
      if (typeof (data.info ?? props.info) === "string")
        s.info = (data.info ?? props.info) as string;
      points.push(s);
    } else if (
      geometry.type === "LineString" ||
      geometry.type === "MultiLineString"
    ) {
      const lines =
        geometry.type === "LineString"
          ? [geometry.coordinates]
          : geometry.coordinates;
      if (!Array.isArray(lines))
        throw new Error("Invalid MultiLineString coordinates.");
      for (let part = 0; part < lines.length; part++) {
        const path = coordinates(lines[part]);
        vertices += path.length;
        if (path.length >= 2) pending.push({ path, props, part });
      }
    } else ignored++;
    if (vertices > 500000)
      throw new Error(
        "GeoJSON exceeds the 500,000 coordinate browser limit. Simplify or split the file.",
      );
  }
  network.stations = points;
  const routeMap = new Map<string, Route>(),
    stationMap = new Map(points.map((s) => [s.id, s]));
  if (native.formatVersion === 1 && Array.isArray(metadata.routes)) {
    const seed = validateNetwork({ ...network, routes: metadata.routes });
    for (const route of seed.routes) routeMap.set(route.id, route);
  }
  const ensureEndpoint = (p: LatLng, name: string) => {
    let nearest: Station | undefined,
      best = 0.3;
    for (const s of network.stations) {
      const d = distance(p, position(s));
      if (d < best) {
        best = d;
        nearest = s;
      }
    }
    if (nearest) return nearest;
    let id = `geo-endpoint-${++generated}`;
    while (ids.has(id)) id = `geo-endpoint-${++generated}`;
    const station = { id, name, lat: p[0], lng: p[1] };
    network.stations.push(station);
    stationMap.set(id, station);
    ids.add(id);
    return station;
  };
  for (let i = 0; i < pending.length; i++) {
    const { path, props, part } = pending[i],
      routeData = object(props.route),
      serviceData = object(props.service);
    const routeId = text(
      routeData.id || props.routeId || props.route_id || props.ref,
      `geo-route-${i + 1}`,
    );
    if (!routeMap.has(routeId)) {
      const mode = text(routeData.mode || props.mode);
      const route: Route = {
        id: routeId,
        name: text(
          routeData.name || props.route_name || props.name,
          `Route ${routeMap.size + 1}`,
        ),
        shortName: text(
          routeData.shortName || props.ref || props.shortName,
          String(routeMap.size + 1),
        ),
        color: color(
          routeData.color || props.color || props.stroke,
          routeMap.size,
        ),
        mode: [
          "metro",
          "rail",
          "tram",
          "monorail",
          "maglev",
          "light-metro",
          "bus",
          "brt",
          "ferry",
          "gondola",
          "air",
          "high-speed-rail",
        ].includes(mode)
          ? (mode as Route["mode"])
          : "metro",
        visible: routeData.visible !== false,
      };
      routeMap.set(routeId, route);
    }
    const explicit = serviceData.stationIds || props.stationIds;
    let stationIds: string[];
    if (
      Array.isArray(explicit) &&
      explicit.every((id) => typeof id === "string" && stationMap.has(id))
    )
      stationIds = [...explicit] as string[];
    else {
      let minLat = Infinity,
        maxLat = -Infinity,
        minLng = Infinity,
        maxLng = -Infinity;
      for (const p of path) {
        minLat = Math.min(minLat, p[0]);
        maxLat = Math.max(maxLat, p[0]);
        minLng = Math.min(minLng, p[1]);
        maxLng = Math.max(maxLng, p[1]);
      }
      const candidates = points.filter(
        (s) =>
          s.lat >= minLat - 0.003 &&
          s.lat <= maxLat + 0.003 &&
          s.lng >= minLng - 0.01 &&
          s.lng <= maxLng + 0.01,
      );
      if (candidates.length * path.length > 10_000_000)
        throw new Error(
          "GeoJSON station matching is too complex. Add explicit stationIds or simplify route geometry.",
        );
      const projected = candidates
        .map((s) => ({ s, ...projection(position(s), path) }))
        .filter((p) => p.distance <= 0.15);
      const start = ensureEndpoint(
          path[0],
          `${routeMap.get(routeId)!.shortName} start`,
        ),
        end = ensureEndpoint(
          path.at(-1)!,
          `${routeMap.get(routeId)!.shortName} end`,
        );
      let length = 0;
      for (let j = 1; j < path.length; j++)
        length += distance(path[j - 1], path[j]);
      projected.push(
        { s: start, distance: 0, along: 0 },
        { s: end, distance: 0, along: length },
      );
      projected.sort((a, b) => a.along - b.along);
      stationIds = projected
        .map((p) => p.s.id)
        .filter((id, j, array) => j === 0 || id !== array[j - 1]);
      if (
        distance(path[0], path.at(-1)!) < 0.03 &&
        stationIds[0] !== stationIds.at(-1)
      )
        stationIds.push(stationIds[0]);
    }
    if (stationIds.length < 2) continue;
    const service = baseService(
      text(serviceData.id || props.serviceId, `geo-service-${i + 1}`) +
        (part ? `-part-${part + 1}` : ""),
      routeId,
      stationIds,
    );
    service.name = text(
      serviceData.name || props.service_name || props.name,
      "Local",
    );
    if (
      ["local", "express", "limited", "shuttle"].includes(
        text(serviceData.kind || props.kind),
      )
    )
      service.kind = text(serviceData.kind || props.kind) as Service["kind"];
    if (serviceData.direction === "both" || props.direction === "both")
      service.direction = "both";
    if (typeof serviceData.loop === "boolean") service.loop = serviceData.loop;
    for (const [field, min, max] of [
      ["headway", 0.25, 1440],
      ["speed", 1, 700],
      ["dwell", 0, 1800],
    ] as const) {
      const n = numeric(serviceData[field] ?? props[field]);
      if (Number.isFinite(n) && n >= min && n <= max) service[field] = n;
    }
    if (Array.isArray(serviceData.skippedStationIds))
      service.skippedStationIds = serviceData.skippedStationIds.filter(
        (id) => typeof id === "string" && stationIds.includes(id),
      );
    if (serviceData.stopPattern !== undefined)
      service.stopPattern = serviceData.stopPattern as boolean[];
    if (native.formatVersion === 1 && serviceData.trackPath !== undefined)
      service.trackPath = serviceData.trackPath as Service["trackPath"];
    const waypoints = object(serviceData.waypoints);
    for (const [segment, raw] of Object.entries(waypoints)) {
      if (!Array.isArray(raw)) continue;
      const pairs = raw.map((p) =>
        Array.isArray(p)
          ? ([numeric(p[0]), numeric(p[1])] as LatLng)
          : ([NaN, NaN] as LatLng),
      );
      if (pairs.every((p) => validCoord(...p)))
        Object.defineProperty(service.waypoints, segment, {
          value: pairs,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
    // Native exports distinguish station-connection geometry from a source shape.
    if (native.formatVersion === 1 && serviceData.shape !== undefined)
      service.shape = serviceData.shape as LatLng[];
    else if (native.formatVersion !== 1 || props.hasSourceShape === true)
      service.shape = path;
    network.services.push(service);
  }
  network.routes = [...routeMap.values()];
  if (native.formatVersion === 1 && Array.isArray(metadata.draftServices))
    network.services.push(...(metadata.draftServices as Service[]));
  if (native.formatVersion === 1 && Array.isArray(metadata.serviceOrder)) {
    if (
      metadata.serviceOrder.some((id) => typeof id !== "string") ||
      new Set(metadata.serviceOrder).size !== metadata.serviceOrder.length
    )
      throw new Error(
        "Native GeoJSON serviceOrder must contain unique service IDs.",
      );
    const order = new Map(metadata.serviceOrder.map((id, i) => [id, i]));
    network.services.sort(
      (a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity),
    );
  }
  if (
    !network.stations.length &&
    !network.services.length &&
    native.formatVersion !== 1
  )
    throw new Error(
      "No supported Point, LineString or MultiLineString features were found.",
    );
  if (
    new Set(network.services.map((s) => s.id)).size !== network.services.length
  )
    throw new Error("GeoJSON has duplicate service IDs.");
  network.center = centerOf(network.stations);
  if (
    Array.isArray(metadata.center) &&
    validCoord(numeric(metadata.center[0]), numeric(metadata.center[1]))
  )
    network.center = [Number(metadata.center[0]), Number(metadata.center[1])];
  if (numeric(metadata.zoom) >= 1 && numeric(metadata.zoom) <= 22)
    network.zoom = Number(metadata.zoom);
  if (Array.isArray(metadata.sources))
    network.sources = metadata.sources
      .map((s) => object(s))
      .filter((s) => /^https?:\/\//i.test(text(s.url)))
      .map((s) => ({
        title: text(s.title, "Imported source"),
        url: text(s.url),
        ...(typeof s.license === "string" ? { license: s.license } : {}),
        ...(typeof s.accessed === "string" ? { accessed: s.accessed } : {}),
      }));
  network.description =
    native.formatVersion === 1
      ? text(metadata.description)
      : "Imported geographic paths. Station order is inferred within 150 m of each path unless explicit stationIds are provided. MultiLineStrings become separate service patterns. Headway, speed and dwell are planning assumptions.";
  if (generated)
    network.description += ` ${generated} endpoint stations were generated; add and verify intermediate stops before journey planning.`;
  if (ignored)
    network.description += ` ${ignored} unsupported or empty features were ignored.`;
  if (native.formatVersion === 1) {
    if (typeof metadata.id === "string") network.id = metadata.id;
    if (typeof metadata.updatedAt === "string")
      network.updatedAt = metadata.updatedAt;
    if (
      ["demo", "imported", "osm", "gtfs", "custom"].includes(
        text(metadata.dataStatus),
      )
    )
      network.dataStatus = metadata.dataStatus as Network["dataStatus"];
  }
  return validateNetwork(network);
}

export function exportGeoJSON(network: Network): object {
  const routeMap = new Map(network.routes.map((r) => [r.id, r]));
  const {
    stations: _stations,
    services: _services,
    routes: _routes,
    ...metadata
  } = network;
  return {
    type: "FeatureCollection",
    metroweave: {
      formatVersion: 1,
      network: {
        ...metadata,
        routes: network.routes,
        serviceOrder: network.services.map((s) => s.id),
        draftServices: network.services.filter((s) => s.stationIds.length < 2),
      },
    },
    features: [
      ...network.stations.map((s) => ({
        type: "Feature",
        id: s.id,
        properties: { name: s.name, stationId: s.id, station: s },
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
      })),
      ...(network.junctions ?? []).map((j) => ({
        type: "Feature",
        id: j.id,
        properties: { entity: "junction", name: j.name, junction: j },
        geometry: { type: "Point", coordinates: [j.lng, j.lat] },
      })),
      ...(network.tracks ?? []).map((t) => ({
        type: "Feature",
        id: t.id,
        properties: { entity: "track", track: t },
        geometry: {
          type: "LineString",
          coordinates: t.geometry.map((p) => [p[1], p[0]]),
        },
      })),
      ...network.services
        .filter((s) => s.stationIds.length >= 2)
        .map((s) => {
          const path: LatLng[] = s.trackPath?.length
            ? serviceCoordinates(network, s)
            : s.shape?.length
              ? [...s.shape]
              : serviceCoordinates(network, s);
          if (path.length === 1) path.push(path[0]);
          return {
            type: "Feature",
            id: s.id,
            properties: {
              name: s.name,
              service: s,
              route: routeMap.get(s.routeId),
              hasSourceShape: !!s.shape?.length,
            },
            geometry: {
              type: "LineString",
              coordinates: path.map((p) => [p[1], p[0]]),
            },
          };
        }),
    ],
  };
}

interface OSMMember {
  type: string;
  ref: number;
  role?: string;
  lat?: number;
  lon?: number;
  geometry?: { lat: number; lon: number }[];
}
interface OSMElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  members?: OSMMember[];
  geometry?: { lat: number; lon: number }[];
}

/** Stitches actual connected track endpoints. Disconnected ways are never bridged as a claimed track shape. */
function stitchWays(
  segments: LatLng[][],
  first?: LatLng,
): LatLng[] | undefined {
  const remaining = segments.filter((p) => p.length >= 2).map((p) => [...p]);
  if (!remaining.length || remaining.length > 2500) return;
  let startIndex = 0,
    reverse = false,
    best = Infinity;
  if (first)
    for (let i = 0; i < remaining.length; i++)
      for (const rev of [false, true]) {
        const d = distance(first, rev ? remaining[i].at(-1)! : remaining[i][0]);
        if (d < best) {
          best = d;
          startIndex = i;
          reverse = rev;
        }
      }
  const path = remaining.splice(startIndex, 1)[0];
  if (reverse) path.reverse();
  if (path.length > 150000) return;
  while (remaining.length) {
    let index = -1,
      flip = false,
      gap = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const forwardGap = distance(path.at(-1)!, remaining[i][0]),
        reverseGap = distance(path.at(-1)!, remaining[i].at(-1)!);
      if (forwardGap < gap) {
        index = i;
        flip = false;
        gap = forwardGap;
      }
      if (reverseGap < gap) {
        index = i;
        flip = true;
        gap = reverseGap;
      }
    }
    if (index < 0 || gap > 0.05) return;
    const segment = remaining.splice(index, 1)[0];
    if (flip) segment.reverse();
    for (let j = gap < 0.001 ? 1 : 0; j < segment.length; j++)
      path.push(segment[j]);
    if (path.length > 150000) return;
  }
  return path;
}

function followsStops(path: LatLng[], stops: LatLng[]): boolean {
  const stride = Math.max(
    1,
    Math.ceil((path.length * stops.length) / 3_000_000),
  );
  let cursor = 0;
  for (let i = 0; i < stops.length; i++) {
    let closest = Infinity,
      best = cursor,
      score = Infinity;
    const consider = (index: number) => {
      const d = distance(stops[i], path[index]);
      const candidate =
        d +
        Math.abs(
          index / Math.max(1, path.length - 1) -
            i / Math.max(1, stops.length - 1),
        ) *
          0.005;
      if (candidate < score) {
        score = candidate;
        best = index;
        closest = d;
      }
    };
    for (let j = cursor; j < path.length; j += stride) consider(j);
    consider(path.length - 1);
    const sampled = best;
    for (
      let j = Math.max(cursor, sampled - stride);
      j <= Math.min(path.length - 1, sampled + stride);
      j++
    )
      consider(j);
    if (closest > 0.75) return false;
    cursor = best;
  }
  return true;
}

export function networkFromOSM(city: CatalogEntry, input: unknown): Network {
  const data = object(input);
  if (data.remark)
    throw new Error(
      `OpenStreetMap query did not complete: ${text(data.remark).slice(0, 240)}`,
    );
  if (!Array.isArray(data.elements) || data.elements.length > 200000)
    throw new Error("OpenStreetMap returned an invalid or oversized result.");
  const elements = data.elements as OSMElement[],
    lookup = new Map(elements.map((e) => [`${e.type}/${e.id}`, e]));
  const relations = elements.filter(
    (e) =>
      e.type === "relation" &&
      e.tags?.type === "route" &&
      ["subway", "light_rail", "monorail", "train"].includes(e.tags.route),
  );
  const network = baseNetwork(city.name, "osm");
  network.city = city.city;
  network.country = city.country;
  network.center = [city.lat, city.lng];
  const stations = new Map<string, Station>(),
    stationsByName = new Map<string, Station[]>(),
    routes = new Map<string, Route>();
  let missingStops = 0,
    missingShapes = 0,
    discarded = 0;
  const memberPosition = (m: OSMMember): LatLng | undefined => {
    const e = lookup.get(`${m.type}/${m.ref}`);
    let p: LatLng = [
      numeric(m.lat ?? e?.lat ?? e?.center?.lat),
      numeric(m.lon ?? e?.lon ?? e?.center?.lon),
    ];
    if (validCoord(...p)) return p;
    const geometry = m.geometry || e?.geometry;
    if (geometry?.length) {
      const mid = geometry[Math.floor(geometry.length / 2)];
      p = [mid.lat, mid.lon];
      if (validCoord(...p)) return p;
    }
    return;
  };
  for (const rel of relations) {
    const tags = rel.tags!,
      members = rel.members || [];
    const stopMembers = members.filter((m) =>
      /^stop(?:_|$)/.test(m.role || ""),
    );
    const platforms = members.filter((m) =>
      /^platform(?:_|$)/.test(m.role || ""),
    );
    const chosen =
      stopMembers.filter((m) => memberPosition(m)).length >= 2
        ? stopMembers
        : platforms;
    const stationIds: string[] = [];
    for (const m of chosen) {
      const p = memberPosition(m);
      if (!p) {
        missingStops++;
        continue;
      }
      const id = `osm-${m.type}-${m.ref}`,
        source = lookup.get(`${m.type}/${m.ref}`),
        name =
          source?.tags?.name ||
          source?.tags?.["name:en"] ||
          source?.tags?.ref ||
          `Unnamed OSM stop ${m.ref}`;
      if (!stations.has(id)) {
        const station: Station = { id, name, lat: p[0], lng: p[1] };
        if (
          source?.tags?.wheelchair === "yes" ||
          source?.tags?.wheelchair === "no"
        )
          station.accessible = source.tags.wheelchair === "yes";
        if (source?.tags?.ref) station.code = source.tags.ref;
        // Nearby directional stop positions share a transfer group only when their names also match.
        const siblings = stationsByName.get(name) || [];
        const sibling = siblings.find((s) => distance(position(s), p) < 0.2);
        station.transferGroup = sibling?.transferGroup || sibling?.id || id;
        stations.set(id, station);
        siblings.push(station);
        stationsByName.set(name, siblings);
      }
      if (stationIds.at(-1) !== id) stationIds.push(id);
    }
    if (stationIds.length < 2) {
      discarded++;
      continue;
    }
    const group = tags.ref
      ? `${tags.network || tags.operator || city.id}|${tags.route}|${tags.ref}`
      : `relation-${rel.id}`;
    let route = routes.get(group);
    if (!route) {
      route = {
        id: key("osm-route", group),
        name: tags.ref
          ? `${tags.network || city.city} ${tags.ref}`
          : tags.name || `Route ${rel.id}`,
        shortName: tags.ref || String(routes.size + 1),
        color: color(tags.colour || tags.color, routes.size),
        mode:
          tags.route === "monorail"
            ? "monorail"
            : tags.route === "train"
              ? "rail"
              : tags.route === "light_rail"
                ? "light-metro"
                : "metro",
        visible: true,
      };
      routes.set(group, route);
    }
    const service = baseService(`osm-service-${rel.id}`, route.id, stationIds);
    service.name =
      tags.name ||
      [tags.from, tags.to].filter(Boolean).join(" → ") ||
      "Imported service";
    service.loop = tags.roundtrip === "yes" || service.loop;
    if (service.loop && stationIds[0] !== stationIds.at(-1))
      service.stationIds.push(stationIds[0]);
    if (/express|急行|快速|特快/i.test(tags.service || service.name))
      service.kind = "express";
    const ways = members
      .filter((m) => m.type === "way" && !/^(platform|stop)/.test(m.role || ""))
      .map((m) =>
        (m.geometry || lookup.get(`way/${m.ref}`)?.geometry || [])
          .map((p) => [p.lat, p.lon] as LatLng)
          .filter((p) => validCoord(...p)),
      );
    const shape = stitchWays(ways, position(stations.get(stationIds[0])!));
    const stops = service.stationIds.map((id) => position(stations.get(id)!));
    if (shape && followsStops(shape, stops)) service.shape = shape;
    else if (shape && followsStops([...shape].reverse(), stops))
      service.shape = [...shape].reverse();
    else missingShapes++;
    network.services.push(service);
  }
  const usedStations = new Set(
    network.services.flatMap((service) => service.stationIds),
  );
  network.stations = [...stations.values()].filter((s) =>
    usedStations.has(s.id),
  );
  network.routes = [...routes.values()];
  if (!network.services.length)
    throw new Error(
      "No route relations with at least two ordered stops were found near this city. Try an official GTFS feed or import GeoJSON. OSM coverage and route tagging vary.",
    );
  network.description = `OpenStreetMap route relations selected within 80 km of ${city.city}; complete selected relations may extend beyond the selection area. Includes subway, light rail, monorail, and explicitly urban/metro train routes. Ordered relation stop/platform members and connected track geometry are preserved. Community coverage may be incomplete or outdated; verify against operator data. Headway, speed and dwell are planning assumptions; no timetable is imported. ${missingShapes} service patterns use station connections because contiguous track geometry could not be verified. ${discarded} relations with fewer than two usable ordered stops were excluded.${missingStops ? ` ${missingStops} stop members had no usable coordinates.` : ""}`;
  network.sources = [
    {
      title: "© OpenStreetMap contributors",
      url: "https://www.openstreetmap.org/copyright",
      license: "Open Database License (ODbL)",
      accessed: now().slice(0, 10),
    },
    {
      title: `${city.city} rapid transit reference`,
      url: city.url,
      accessed: now().slice(0, 10),
    },
  ];
  return validateNetwork(network);
}

async function limitedResponse(
  response: Response,
  limit: number,
): Promise<string> {
  if (Number(response.headers.get("content-length")) > limit)
    throw new Error(
      "OpenStreetMap result exceeds the 32 MB browser limit. Use a regional GTFS feed.",
    );
  if (!response.body) {
    const raw = await response.text();
    if (raw.length > limit)
      throw new Error("OpenStreetMap result is too large.");
    return raw;
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let size = 0,
    output = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error(
          "OpenStreetMap result exceeds the 32 MB browser limit.",
        );
      }
      output += decoder.decode(next.value, { stream: true });
    }
    output += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return output;
}

export async function importOSM(
  city: CatalogEntry,
  signal?: AbortSignal,
  endpointOverride?: string,
): Promise<Network> {
  if (!validCoord(city.lat, city.lng))
    throw new Error("City coordinates are invalid.");
  let endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  if (endpointOverride?.trim()) {
    let url: URL;
    try {
      url = new URL(endpointOverride.trim());
    } catch {
      throw new Error(
        "The Overpass endpoint must be an absolute HTTP or HTTPS URL.",
      );
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error(
        "The Overpass endpoint must use HTTP or HTTPS and cannot contain credentials.",
      );
    if (url.href.length > 3000)
      throw new Error("The Overpass endpoint URL is too long.");
    endpoints = [url.href];
  }
  const query = `[out:json][timeout:45][maxsize:33554432];(relation["type"="route"]["route"~"^(subway|light_rail|monorail)$"](around:80000,${city.lat},${city.lng});relation["type"="route"]["route"="train"]["service"~"^(urban|metro)$"](around:80000,${city.lat},${city.lng});)->.routes;(.routes;node(r.routes);way(r.routes););out body geom;`;
  const errors: string[] = [];
  for (const endpoint of endpoints) {
    if (signal?.aborted)
      throw new DOMException("Import cancelled.", "AbortError");
    const controller = new AbortController(),
      cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        signal: controller.signal,
        credentials: "omit",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw = await limitedResponse(response, 32 * MB);
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error("The Overpass server returned an invalid response.");
      }
      const network = networkFromOSM(city, data);
      network.sources.push({
        title: "Overpass route data endpoint",
        url: endpoint,
        accessed: now().slice(0, 10),
      });
      return network;
    } catch (e) {
      if (signal?.aborted)
        throw new DOMException("Import cancelled.", "AbortError");
      errors.push(
        `${new URL(endpoint).hostname}: ${controller.signal.aborted ? "request timed out" : e instanceof Error ? e.message : "request failed"}`,
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
    }
  }
  throw new Error(
    `Live OSM import could not complete. ${errors.join(" · ")}. You can retry later or import an official GTFS ZIP / GeoJSON file.`,
  );
}

interface MetroDreaminContainer {
  map: Record<string, unknown>;
  document: Record<string, unknown>;
}
function metroDreaminContainer(
  input: unknown,
): MetroDreaminContainer | undefined {
  const root = object(input);
  const document = object(
    root.systemDoc ?? root.systemDocData ?? root.initialSystemDocData,
  );
  for (const candidate of [
    root.map,
    root.system,
    root.systemData,
    root.mapData,
    object(root.data).map,
    root.data,
    root,
    document,
  ]) {
    const map = object(candidate);
    if (
      map.stations !== null &&
      typeof map.stations === "object" &&
      map.lines !== null &&
      typeof map.lines === "object"
    )
      return { map, document };
  }
  const partitions = root.partitions ?? object(root.map).partitions;
  if (partitions && typeof partitions === "object") {
    const parts = Array.isArray(partitions)
      ? partitions
      : Object.values(object(partitions));
    if (parts.length > 1000)
      throw new Error("MetroDreamin export has more than 1,000 partitions.");
    const map: Record<string, unknown> = {
      title: document.title ?? root.title,
    };
    let found = false;
    for (const raw of parts) {
      const part = object(object(raw).data ?? raw);
      for (const collection of [
        "stations",
        "lines",
        "interchanges",
        "lineGroups",
      ]) {
        if (part[collection] === undefined) continue;
        found = true;
        const merged = object(map[collection]);
        for (const [id, value] of Object.entries(object(part[collection]))) {
          if (
            id in merged &&
            JSON.stringify(merged[id]) !== JSON.stringify(value)
          )
            throw new Error(
              `Conflicting MetroDreamin partition ${collection} ID: ${id}.`,
            );
          Object.defineProperty(merged, id, {
            value,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        map[collection] = merged;
      }
    }
    if (found && map.stations !== undefined && map.lines !== undefined)
      return { map, document };
  }
  return;
}

export function isMetroDreamin(input: unknown): boolean {
  return !!metroDreaminContainer(input);
}
function sourceEntries(
  value: unknown,
  collection: string,
  maximum: number,
): [string, Record<string, unknown>][] {
  if (value === undefined) return [];
  if (value === null || typeof value !== "object")
    throw new Error(`MetroDreamin ${collection} must be an object or array.`);
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [text(object(v).id, String(i)), v])
    : Object.entries(value);
  if (entries.length > maximum)
    throw new Error(
      `MetroDreamin ${collection} exceeds the ${maximum.toLocaleString()} item limit.`,
    );
  const ids = new Set<string>();
  return entries.map(([id, v]) => {
    if (!id || ids.has(id))
      throw new Error(
        `Duplicate or empty MetroDreamin ${collection} ID: ${id}.`,
      );
    ids.add(id);
    if (v === null || typeof v !== "object" || Array.isArray(v))
      throw new Error(`MetroDreamin ${collection} ${id} is not an object.`);
    return [id, object(v)];
  });
}

const MD_MODES: Record<string, { mode: Route["mode"]; speed: number }> = {
  RAPID: { mode: "metro", speed: 60 },
  LIGHT: { mode: "light-metro", speed: 54 },
  TRAM: { mode: "tram", speed: 36 },
  REGIONAL: { mode: "rail", speed: 100 },
  MLDISTANCE: { mode: "rail", speed: 160 },
  HSR: { mode: "high-speed-rail", speed: 300 },
  BUS: { mode: "bus", speed: 24 },
  BRT: { mode: "brt", speed: 48 },
  FERRY: { mode: "ferry", speed: 42 },
  GONDOLA: { mode: "gondola", speed: 20 },
  AIR: { mode: "air", speed: 600 },
};

/** Interoperability adapter based on the author's public map schema; imports only a user-provided export. */
export function importMetroDreamin(input: unknown): Network {
  const original = copyJSONData(
    object(input),
    "MetroDreamin source export",
    20 * MB,
  );
  const located = metroDreaminContainer(original);
  if (!located)
    throw new Error(
      "No MetroDreamin map was found. Expected stations and lines, directly or inside map/system plus optional systemDoc metadata.",
    );
  const { map, document } = located;
  const root = object(original),
    warnings: string[] = [];
  let shortened = 0;
  const label = (raw: unknown, fallback: string, maximum = 300) => {
    const s = text(raw, fallback).trim() || fallback;
    if (s.length > maximum) shortened++;
    return s.slice(0, maximum);
  };
  const network = baseNetwork(
    label(
      map.title ?? document.title ?? root.title ?? map.name,
      "Imported MetroDreamin map",
    ),
    "imported",
  );
  const originalId = text(document.systemId ?? root.systemId ?? map.id);
  if (originalId) network.id = key("md-map", originalId);
  network.city = label(map.city ?? document.city ?? root.city, "", 300);
  network.country = label(
    map.country ?? document.country ?? root.country,
    "",
    300,
  );
  network.description = label(
    map.caption ?? document.caption ?? map.description ?? root.caption,
    "",
    20000,
  );
  const stations = sourceEntries(map.stations, "stations", 50000),
    lines = sourceEntries(map.lines, "lines", 3000);
  const stationMap = new Map<string, Station>(),
    groupMap = new Map<string, string>();
  for (const [id, raw] of stations) {
    const lat = numeric(raw.lat),
      lng = numeric(raw.lng ?? raw.lon);
    if (!validCoord(lat, lng))
      throw new Error(
        `MetroDreamin station ${id} has invalid latitude/longitude; no partial map was imported.`,
      );
    const station: Station = {
      id: key("md-station", id),
      name: label(
        raw.name,
        raw.isWaypoint === true ? `Waypoint ${id}` : `Station ${id}`,
      ),
      lat,
      lng,
    };
    if (typeof raw.isWaypoint === "boolean")
      station.isWaypoint = raw.isWaypoint;
    if (["above", "at", "below"].includes(text(raw.grade)))
      station.grade = raw.grade as Station["grade"];
    if (typeof raw.info === "string") station.info = label(raw.info, "", 20000);
    if (raw.code !== undefined) station.code = label(raw.code, "", 80);
    if (typeof raw.accessible === "boolean")
      station.accessible = raw.accessible;
    stationMap.set(id, station);
    network.stations.push(station);
  }
  if (
    new Set(network.stations.map((s) => s.id)).size !== network.stations.length
  )
    throw new Error("Source station identifiers collide after conversion.");
  const groups = sourceEntries(map.lineGroups, "lineGroups", 3000);
  if (map.lineGroups !== undefined) {
    network.lineGroups = groups.map(([id, raw]) => {
      const groupId = key("md-group", id);
      groupMap.set(id, groupId);
      const shown = Array.isArray(root.groupsDisplayed)
        ? root.groupsDisplayed.map(String).includes(id)
        : raw.visible !== false;
      return {
        id: groupId,
        name: label(raw.label ?? raw.name, `Group ${id}`),
        visible: shown,
      };
    });
  }
  for (const [id, raw] of lines) {
    const modeKey = text(raw.mode, "RAPID").toUpperCase(),
      definition = MD_MODES[modeKey];
    if (!definition)
      throw new Error(
        `MetroDreamin line ${id} uses unsupported mode ${modeKey}; the original map was not partially imported.`,
      );
    const route: Route = {
      id: key("md-route", id),
      name: label(raw.name, `Line ${id}`),
      shortName: label(raw.shortName ?? raw.ref ?? raw.name, id, 40),
      color: color(raw.color ?? raw.colour, network.routes.length),
      mode: definition.mode,
      visible: raw.visible !== false,
    };
    if (!/^#?[0-9a-f]{6}$/i.test(text(raw.color ?? raw.colour)))
      warnings.push(
        `Line ${id} had an unsupported color and uses a fallback; the original color remains archived.`,
      );
    const group = text(raw.lineGroupId ?? raw.groupId);
    if (groupMap.has(group)) route.groupId = groupMap.get(group);
    else if (group)
      warnings.push(
        `Line ${id} references missing group ${group}; its original group reference is archived.`,
      );
    if (
      !group &&
      Array.isArray(root.groupsDisplayed) &&
      !root.groupsDisplayed.map(String).includes(modeKey)
    )
      route.visible = false;
    if (
      [
        "circle",
        "diamond",
        "heart",
        "plus",
        "star",
        "square",
        "triangle",
        "hexagon",
        "pentagon",
      ].includes(text(raw.icon))
    )
      route.icon = raw.icon as Route["icon"];
    else if (raw.icon)
      warnings.push(
        `Line ${id} icon ${text(raw.icon)} is archived but has no supported badge representation.`,
      );
    if (["solid", "dashed", "dotted", "dash-dot"].includes(text(raw.pattern)))
      route.pattern = raw.pattern as Route["pattern"];
    network.routes.push(route);
    if (!Array.isArray(raw.stationIds))
      throw new Error(
        `MetroDreamin line ${id} has no ordered stationIds array.`,
      );
    if (raw.stationIds.length > 20000)
      throw new Error(
        `MetroDreamin line ${id} exceeds 20,000 station/waypoint visits.`,
      );
    const ordered = raw.stationIds.map((v) => text(v));
    for (const stopId of ordered)
      if (!stationMap.has(stopId))
        throw new Error(
          `MetroDreamin line ${id} references missing station ${stopId}; no partial map was imported.`,
        );
    const ids = ordered.map((sourceId) => stationMap.get(sourceId)!.id);
    const service = baseService(key("md-service", id), route.id, ids);
    service.name = route.name;
    const overrides = new Set(
      Array.isArray(raw.waypointOverrides)
        ? raw.waypointOverrides.map(String)
        : [],
    );
    service.stopPattern = ordered.map(
      (sourceId) =>
        !stationMap.get(sourceId)!.isWaypoint && !overrides.has(sourceId),
    );
    service.skippedStationIds = [
      ...new Set(ids.filter((_, i) => !service.stopPattern![i])),
    ];
    service.kind = overrides.size ? "express" : "local";
    service.direction = raw.direction === "forward" ? "forward" : "both";
    service.loop =
      raw.loop === true || (ids.length > 2 && ids[0] === ids.at(-1));
    service.speed = definition.speed;
    if (numeric(raw.headway) >= 0.25 && numeric(raw.headway) <= 1440)
      service.headway = Number(raw.headway);
    if (numeric(raw.dwell) >= 0 && numeric(raw.dwell) <= 1800)
      service.dwell = Number(raw.dwell);
    if (ids.length >= 2)
      service.shape = ordered.map((sourceId) =>
        position(stationMap.get(sourceId)!),
      );
    network.services.push(service);
  }
  // Source interchanges form connected walking groups, including overlapping exported groups.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let current = id;
    while (parent.has(current) && parent.get(current) !== current)
      current = parent.get(current)!;
    let next = id;
    while (parent.has(next) && parent.get(next) !== current) {
      const previous = parent.get(next)!;
      parent.set(next, current);
      next = previous;
    }
    return current;
  };
  for (const [id, raw] of sourceEntries(
    map.interchanges,
    "interchanges",
    10000,
  )) {
    if (!Array.isArray(raw.stationIds)) {
      warnings.push(
        `Interchange ${id} had no stationIds; its full data is archived.`,
      );
      continue;
    }
    const members = raw.stationIds.map(String);
    if (members.some((sourceId) => !stationMap.has(sourceId)))
      throw new Error(
        `MetroDreamin interchange ${id} references a missing station.`,
      );
    for (const sourceId of members) {
      if (!parent.has(sourceId)) parent.set(sourceId, sourceId);
      if (members[0]) parent.set(find(sourceId), find(members[0]));
    }
  }
  for (const [sourceId, station] of stationMap)
    if (parent.has(sourceId))
      station.transferGroup = key("md-transfer", find(sourceId));
  network.center = centerOf(network.stations);
  const centroid = object(document.centroid ?? map.centroid ?? root.center);
  if (validCoord(numeric(centroid.lat), numeric(centroid.lng)))
    network.center = [Number(centroid.lat), Number(centroid.lng)];
  if (
    numeric(map.zoom ?? document.zoom) >= 1 &&
    numeric(map.zoom ?? document.zoom) <= 22
  )
    network.zoom = Number(map.zoom ?? document.zoom);
  const updated = document.lastUpdated ?? map.lastUpdated;
  if (
    (typeof updated === "string" || typeof updated === "number") &&
    Number.isFinite(new Date(updated).getTime())
  )
    network.updatedAt = new Date(updated).toISOString();
  if (shortened)
    warnings.push(
      `${shortened} labels or text fields were shortened to editor limits; complete original text is retained in the archived source.`,
    );
  warnings.push(
    "All provided source JSON is retained in importMetadata.original, including unrecognized properties. This imports the supplied file only, not MetroDreamin accounts or its public map database.",
  );
  warnings.push(
    "Ordered station/waypoint visits, per-line waypoint overrides, coordinates, colors, supported modes, grades, string station info, line groups and supported badge icons are editable. Other source properties remain archived.",
  );
  warnings.push(
    "Headway and dwell are planning assumptions unless supplied as explicit fields. Mode speeds are editable estimates. Animation acceleration/pause settings, score/ridership/cost results, map styling, community content and ownership are not operational models. Walking interchanges use MetroWeave’s configured planning rules.",
  );
  if (
    stations.some(([, s]) => s.info !== undefined && typeof s.info !== "string")
  )
    warnings.push(
      "Structured station info remains intact in the original archive; only string info is copied to the editable station description.",
    );
  if (warnings.length > 1000) {
    const additional = warnings.length - 999;
    warnings.splice(999);
    warnings.push(
      `${additional} additional conversion notices were condensed; all affected source fields remain in the archived original.`,
    );
  }
  network.importMetadata = {
    format: "metrodreamin",
    importedAt: now(),
    lossReport: warnings,
    original,
  };
  network.sources = [
    {
      title: "MetroDreamin public map schema",
      url: "https://github.com/the-nemz/metro-dreamin/blob/master/util/constants.js",
      accessed: now().slice(0, 10),
    },
  ];
  if (originalId)
    network.sources.unshift({
      title: `Original MetroDreamin map: ${network.name}`,
      url: `https://metrodreamin.com/view/${encodeURIComponent(originalId)}`,
      accessed: now().slice(0, 10),
    });
  return validateNetwork(network);
}

/** A MetroDreamin-schema map plus a MetroWeave extension retaining features the source schema cannot represent. */
export function exportNetworkToMetroDreamin(input: Network): object {
  const n = validateNetwork(input);
  const stationLookup = new Map(n.stations.map((s) => [s.id, s])),
    routeLookup = new Map(n.routes.map((r) => [r.id, r]));
  const original =
    n.importMetadata?.format === "metrodreamin"
      ? copyJSONData(
          n.importMetadata.original,
          "Original source export",
          20 * MB,
        )
      : {};
  const container = metroDreaminContainer(original);
  const oldMap = container?.map ?? {},
    output: Record<string, unknown> = original;
  const map =
    output.stations !== undefined && output.lines !== undefined
      ? output
      : { ...oldMap };
  if (map !== output) output.map = map;
  const oldStations = sourceEntries(oldMap.stations, "stations", 50000),
    oldLines = sourceEntries(oldMap.lines, "lines", 3000),
    oldGroups = sourceEntries(oldMap.lineGroups, "lineGroups", 3000);
  const oldStationById = new Map(
    oldStations.map(([id, data]) => [key("md-station", id), { id, data }]),
  );
  const oldLineByService = new Map(
    oldLines.map(([id, data]) => [key("md-service", id), { id, data }]),
  );
  const oldLineByRoute = new Map(
    oldLines.map(([id, data]) => [key("md-route", id), { id, data }]),
  );
  const oldGroupById = new Map(
    oldGroups.map(([id, data]) => [key("md-group", id), { id, data }]),
  );
  const usedStationIds = new Set(oldStations.map(([id]) => id)),
    usedLineIds = new Set(oldLines.map(([id]) => id)),
    usedGroupIds = new Set(oldGroups.map(([id]) => id));
  const fresh = (used: Set<string>) => {
    let i = used.size;
    while (used.has(String(i))) i++;
    const id = String(i);
    used.add(id);
    return id;
  };
  const stationIds = new Map<string, string>(),
    groupIds = new Map<string, string>();
  const nativeStations: Record<string, unknown> = {},
    nativeLines: Record<string, unknown> = {},
    nativeGroups: Record<string, unknown> = {},
    nativeInterchanges: Record<string, unknown> = {};
  const define = (
    target: Record<string, unknown>,
    id: string,
    value: unknown,
  ) =>
    Object.defineProperty(target, id, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  for (const station of n.stations) {
    const old = oldStationById.get(station.id),
      id = old?.id ?? fresh(usedStationIds);
    stationIds.set(station.id, id);
    const data: Record<string, unknown> = {
      ...old?.data,
      id,
      name: station.name,
      lat: station.lat,
      lng: station.lng,
    };
    if (station.isWaypoint) data.isWaypoint = true;
    else delete data.isWaypoint;
    if (station.grade !== undefined) data.grade = station.grade;
    else delete data.grade;
    if (station.info !== undefined) data.info = station.info;
    if (station.code !== undefined) data.code = station.code;
    if (station.accessible !== undefined) data.accessible = station.accessible;
    define(nativeStations, id, data);
  }
  for (const group of n.lineGroups ?? []) {
    const old = oldGroupById.get(group.id),
      id = old?.id ?? fresh(usedGroupIds);
    groupIds.set(group.id, id);
    define(nativeGroups, id, {
      ...old?.data,
      id,
      label: group.name,
      visible: group.visible,
    });
  }
  const report = [
    "Each service pattern is exported as its own MetroDreamin line. Original unknown source fields remain present when their source object still exists. Use MetroWeave project/workspace JSON for a lossless editable backup.",
  ];
  const waypointCache = new Map<string, string>();
  let nativeStationCount = n.stations.length;
  for (const station of n.stations.filter((s) => s.isWaypoint))
    waypointCache.set(
      `${station.lat}|${station.lng}`,
      stationIds.get(station.id)!,
    );
  const waypoint = (p: LatLng, label = "Geometry waypoint") => {
    const coordinateKey = `${p[0]}|${p[1]}`,
      existing = waypointCache.get(coordinateKey);
    if (existing) return existing;
    if (nativeStationCount >= 50000)
      throw new Error(
        "MetroDreamin-compatible geometry exceeds 50,000 station/waypoint nodes. Export a MetroWeave project JSON instead.",
      );
    nativeStationCount++;
    const id = fresh(usedStationIds);
    define(nativeStations, id, {
      id,
      lat: p[0],
      lng: p[1],
      name: label,
      isWaypoint: true,
    });
    waypointCache.set(coordinateKey, id);
    return id;
  };
  const modes: Record<Route["mode"], string> = {
    metro: "RAPID",
    "light-metro": "LIGHT",
    tram: "TRAM",
    rail: "REGIONAL",
    "high-speed-rail": "HSR",
    bus: "BUS",
    brt: "BRT",
    ferry: "FERRY",
    gondola: "GONDOLA",
    air: "AIR",
    monorail: "RAPID",
    maglev: "HSR",
  };
  const patterns = [...n.services];
  for (const route of n.routes)
    if (!patterns.some((s) => s.routeId === route.id))
      patterns.push(baseService(`export-draft-${route.id}`, route.id, []));
  let mixedOccurrences = 0,
    extraModes = 0;
  for (const service of patterns) {
    const route = routeLookup.get(service.routeId)!;
    const old = oldLineByService.get(service.id),
      fallback = oldLineByRoute.get(route.id);
    const id = old && !(old.id in nativeLines) ? old.id : fresh(usedLineIds);
    const prior = old?.data ?? fallback?.data ?? {};
    const sourceMode = text(prior.mode, "RAPID").toUpperCase();
    const mode =
      MD_MODES[sourceMode]?.mode === route.mode
        ? sourceMode
        : modes[route.mode];
    if (route.mode === "monorail" || route.mode === "maglev") extraModes++;
    const visits = new Map<string, Set<boolean>>();
    service.stationIds.forEach((stationId, i) => {
      const set = visits.get(stationId) ?? new Set<boolean>();
      set.add(serviceStopsAt(service, i));
      visits.set(stationId, set);
    });
    const stopId = (stationId: string, occurrence: number) => {
      const station = stationLookup.get(stationId)!;
      if (
        !serviceStopsAt(service, occurrence) &&
        visits.get(stationId)!.size > 1 &&
        !station.isWaypoint
      ) {
        mixedOccurrences++;
        return waypoint(
          [station.lat, station.lng],
          `Pass-through at ${station.name}`,
        );
      }
      return stationIds.get(stationId)!;
    };
    const ordered: string[] = service.stationIds.length
      ? [stopId(service.stationIds[0], 0)]
      : [];
    for (const segment of serviceSegmentGeometries(n, service)) {
      for (const p of segment.coordinates.slice(1, -1))
        ordered.push(waypoint(p));
      ordered.push(stopId(segment.toId, segment.toIndex));
    }
    const overrides = [
      ...new Set(
        service.stationIds
          .filter(
            (stationId, i) =>
              !serviceStopsAt(service, i) &&
              visits.get(stationId)!.size === 1 &&
              !stationLookup.get(stationId)?.isWaypoint,
          )
          .map((stationId) => stationIds.get(stationId)!),
      ),
    ];
    const data: Record<string, unknown> = {
      ...prior,
      id,
      name: service.name,
      color: route.color,
      mode,
      stationIds: ordered,
      waypointOverrides: overrides,
      headway: service.headway,
      dwell: service.dwell,
      direction: service.direction,
      visible: route.visible,
    };
    if (route.groupId && groupIds.has(route.groupId))
      data.lineGroupId = groupIds.get(route.groupId);
    else delete data.lineGroupId;
    if (
      route.icon &&
      ["circle", "diamond", "heart", "plus", "star"].includes(route.icon)
    )
      data.icon = route.icon;
    else delete data.icon;
    if (route.pattern !== undefined) data.pattern = route.pattern;
    define(nativeLines, id, data);
  }
  const walkingGroups = new Map<string, string[]>();
  for (const station of n.stations)
    if (station.transferGroup) {
      const members = walkingGroups.get(station.transferGroup) ?? [];
      members.push(stationIds.get(station.id)!);
      walkingGroups.set(station.transferGroup, members);
    }
  let interchangeIndex = 0;
  for (const members of walkingGroups.values())
    if (members.length > 1) {
      const id = String(interchangeIndex++);
      define(nativeInterchanges, id, { id, stationIds: members });
    }
  map.title = n.name;
  map.caption = n.description;
  map.stations = nativeStations;
  map.lines = nativeLines;
  map.lineGroups = nativeGroups;
  map.interchanges = nativeInterchanges;
  output.systemDoc = {
    ...container?.document,
    title: n.name,
    caption: n.description,
    lastUpdated: Date.parse(n.updatedAt),
    centroid: { lat: n.center[0], lng: n.center[1] },
  };
  output.meta = {
    ...object(output.meta),
    nextStationId: fresh(usedStationIds),
    nextLineId: fresh(usedLineIds),
    nextLineGroupId: fresh(usedGroupIds),
    nextInterchangeId: String(interchangeIndex),
  };
  output.groupsDisplayed = [
    ...new Set([
      ...(n.lineGroups ?? [])
        .filter((g) => g.visible)
        .map((g) => groupIds.get(g.id)),
      ...Object.values(nativeLines)
        .map(object)
        .filter((line) => !line.lineGroupId && line.visible !== false)
        .map((line) => text(line.mode)),
    ]),
  ];
  if (mixedOccurrences)
    report.push(
      `${mixedOccurrences} repeated station visits have differing stopping flags; pass-through visits become separate waypoint nodes because MetroDreamin applies overrides by station ID.`,
    );
  if (extraModes)
    report.push(
      `${extraModes} monorail/maglev patterns use the nearest MetroDreamin mode; the exact modes remain in the MetroWeave extension.`,
    );
  report.push(
    "Physical track/junction/passing-loop identities, occurrence stop patterns, planning assumptions and source import reports are retained in the MetroWeave extension. MetroDreamin may ignore that extension and line direction/dash properties.",
  );
  const { importMetadata: provenance, ...project } = n;
  output.metroweave = {
    ...object(output.metroweave),
    format: "metroweave-compatible-export",
    version: 1,
    project,
    ...(provenance
      ? {
          originalSource: provenance.original,
          sourceImportMetadata: {
            format: provenance.format,
            importedAt: provenance.importedAt,
            lossReport: provenance.lossReport,
          },
        }
      : {}),
    compatibilityReport: report,
  };
  return copyJSONData(output, "MetroDreamin-compatible export", 100 * MB);
}
