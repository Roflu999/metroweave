import type {
  LatLng,
  Network,
  Route,
  Service,
  Source,
  Station,
  Track,
  TrackTraversal,
  Junction,
  PassingLoop,
  ImportMetadata,
  LineGroup,
} from "./types";

/** Coordinates throughout the app are [latitude, longitude]. Distances are kilometres. */
export function uid(prefix = "id"): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`;
}

export function haversine(a: LatLng, b: LatLng): number {
  const radians = Math.PI / 180;
  const dLat = (b[0] - a[0]) * radians;
  const dLng = (b[1] - a[1]) * radians;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * radians) *
      Math.cos(b[0] * radians) *
      Math.sin(dLng / 2) ** 2;
  return (
    6371.0088 *
    2 *
    Math.atan2(Math.sqrt(Math.min(1, h)), Math.sqrt(Math.max(0, 1 - h)))
  );
}

function lineDistance(points: LatLng[]): number {
  let distance = 0;
  for (let i = 1; i < points.length; i++)
    distance += haversine(points[i - 1], points[i]);
  return distance;
}

function deduplicate(points: LatLng[]): LatLng[] {
  return points.filter(
    (point, i) =>
      i === 0 || point[0] !== points[i - 1][0] || point[1] !== points[i - 1][1],
  );
}

export interface ServiceSegment {
  fromId: string;
  toId: string;
  fromIndex: number;
  toIndex: number;
  coordinates: LatLng[];
  distance: number;
  travelMinutes: number;
}

export function serviceStopsAt(service: Service, occurrence: number): boolean {
  if (
    !Number.isInteger(occurrence) ||
    occurrence < 0 ||
    occurrence >= service.stationIds.length
  )
    return false;
  return (
    service.stopPattern?.[occurrence] ??
    !service.skippedStationIds.includes(service.stationIds[occurrence])
  );
}

export function isServiceVisible(network: Network, service: Service): boolean {
  const route = network.routes.find((route) => route.id === service.routeId);
  return (
    !!route?.visible &&
    (!route.groupId ||
      network.lineGroups?.find((group) => group.id === route.groupId)
        ?.visible !== false)
  );
}

const endpointMaps = new WeakMap<
  Network,
  {
    stations: Station[];
    stationCount: number;
    junctions: Junction[] | undefined;
    junctionCount: number;
    nodes: Map<string, Station | Junction>;
  }
>();
function endpointMap(network: Network): Map<string, Station | Junction> {
  const cached = endpointMaps.get(network);
  if (
    cached &&
    cached.stations === network.stations &&
    cached.stationCount === network.stations.length &&
    cached.junctions === network.junctions &&
    cached.junctionCount === (network.junctions?.length ?? 0)
  )
    return cached.nodes;
  const nodes = new Map<string, Station | Junction>(
    [...network.stations, ...(network.junctions ?? [])].map((node) => [
      node.id,
      node,
    ]),
  );
  endpointMaps.set(network, {
    stations: network.stations,
    stationCount: network.stations.length,
    junctions: network.junctions,
    junctionCount: network.junctions?.length ?? 0,
    nodes,
  });
  return nodes;
}
const physicalTrackMaps = new WeakMap<
  Network,
  { tracks: Track[] | undefined; count: number; map: Map<string, Track> }
>();
function physicalTrackMap(network: Network): Map<string, Track> {
  const cached = physicalTrackMaps.get(network);
  if (
    cached &&
    cached.tracks === network.tracks &&
    cached.count === (network.tracks?.length ?? 0)
  )
    return cached.map;
  const map = new Map(network.tracks?.map((track) => [track.id, track]) ?? []);
  physicalTrackMaps.set(network, {
    tracks: network.tracks,
    count: network.tracks?.length ?? 0,
    map,
  });
  return map;
}

export function trackCoordinates(
  network: Network,
  track: Track,
  reverse = false,
): LatLng[] {
  const nodes = endpointMap(network);
  const from = nodes.get(track.fromId),
    to = nodes.get(track.toId);
  if (!from || !to)
    throw new Error(`Track ${track.id} references a missing endpoint`);
  const coordinates = deduplicate([
    [from.lat, from.lng],
    ...track.geometry.slice(1, -1),
    [to.lat, to.lng],
  ]);
  return reverse ? coordinates.reverse() : coordinates;
}

export interface ResolvedTrackSegment {
  trackId: string;
  fromId: string;
  toId: string;
  reverse: boolean;
  coordinates: LatLng[];
  distance: number;
  travelMinutes: number;
}

export function resolveTrackPath(
  network: Network,
  service: Service,
): ResolvedTrackSegment[] {
  const tracks = physicalTrackMap(network),
    nodes = endpointMap(network);
  return (service.trackPath ?? []).map((traversal) => {
    const track = tracks.get(traversal.trackId);
    if (!track)
      throw new Error(
        `Service ${service.id} references missing track ${traversal.trackId}`,
      );
    const fromId = traversal.reverse ? track.toId : track.fromId,
      toId = traversal.reverse ? track.fromId : track.toId;
    const from = nodes.get(fromId),
      to = nodes.get(toId);
    if (!from || !to)
      throw new Error(`Track ${track.id} references a missing endpoint`);
    const interior = track.geometry.slice(1, -1);
    const coordinates = deduplicate([
      [from.lat, from.lng],
      ...(traversal.reverse ? interior.reverse() : interior),
      [to.lat, to.lng],
    ]);
    const distance = lineDistance(coordinates);
    return {
      trackId: track.id,
      fromId,
      toId,
      reverse: !!traversal.reverse,
      coordinates,
      distance,
      travelMinutes:
        (distance /
          Math.min(service.speed, track.speedLimit ?? service.speed)) *
        60,
    };
  });
}

export function trackPathNodes(network: Network, service: Service): string[] {
  const path = resolveTrackPath(network, service);
  return path.length
    ? [path[0].fromId, ...path.map((segment) => segment.toId)]
    : [];
}

/** Only an explicitly listed, stopping occurrence can become a boarding point. */
export function matchTrackOccurrences(
  service: Service,
  nodeIds: string[],
  strict = false,
): { occurrence: number; nodeIndex: number }[] {
  const required = new Map<number, number>();
  const positions = new Map<string, number[]>();
  nodeIds.forEach((id, index) => {
    if (!positions.has(id)) positions.set(id, []);
    positions.get(id)!.push(index);
  });
  const nextIndex = (id: string, cursor: number) => {
    const indexes = positions.get(id) ?? [];
    let left = 0,
      right = indexes.length;
    while (left < right) {
      const mid = (left + right) >> 1;
      if (indexes[mid] < cursor) left = mid + 1;
      else right = mid;
    }
    return indexes[left] ?? -1;
  };
  let cursor = 0;
  for (let i = 0; i < service.stationIds.length; i++) {
    if (!serviceStopsAt(service, i)) continue;
    const index = nextIndex(service.stationIds[i], cursor);
    if (index < 0) {
      if (strict)
        throw new Error(
          `Stopping station ${service.stationIds[i]} occurrence ${i + 1} is missing or out of order in the track path`,
        );
      continue;
    }
    required.set(i, index);
    cursor = index + 1;
  }
  const matches: { occurrence: number; nodeIndex: number }[] = [];
  const limits = new Array<number>(service.stationIds.length);
  let nextRequired = nodeIds.length;
  for (let i = service.stationIds.length - 1; i >= 0; i--) {
    limits[i] = nextRequired;
    if (required.has(i)) nextRequired = required.get(i)!;
  }
  cursor = 0;
  for (let i = 0; i < service.stationIds.length; i++) {
    const requiredIndex = required.get(i);
    if (requiredIndex !== undefined) {
      matches.push({ occurrence: i, nodeIndex: requiredIndex });
      cursor = requiredIndex + 1;
      continue;
    }
    const index = nextIndex(service.stationIds[i], cursor);
    if (index >= 0 && index < limits[i]) {
      matches.push({ occurrence: i, nodeIndex: index });
      cursor = index + 1;
    }
  }
  return matches;
}

function physicalServiceSegments(
  network: Network,
  service: Service,
): ServiceSegment[] {
  const path = resolveTrackPath(network, service);
  if (!path.length) return [];
  const nodes = [path[0].fromId, ...path.map((segment) => segment.toId)];
  const matches = matchTrackOccurrences(service, nodes);
  const segments: ServiceSegment[] = [];
  const add = (
    from: { occurrence: number; nodeIndex: number },
    to: { occurrence: number; nodeIndex: number },
    wrap = false,
  ) => {
    const parts = wrap
      ? [...path.slice(from.nodeIndex), ...path.slice(0, to.nodeIndex)]
      : path.slice(from.nodeIndex, to.nodeIndex);
    if (!parts.length) return;
    segments.push({
      fromId: service.stationIds[from.occurrence],
      toId: service.stationIds[to.occurrence],
      fromIndex: from.occurrence,
      toIndex: to.occurrence,
      coordinates: deduplicate(parts.flatMap((part) => part.coordinates)),
      distance: parts.reduce((sum, part) => sum + part.distance, 0),
      travelMinutes: parts.reduce((sum, part) => sum + part.travelMinutes, 0),
    });
  };
  for (let i = 1; i < matches.length; i++) add(matches[i - 1], matches[i]);
  if (service.loop && matches.length) {
    const first = matches[0],
      last = matches.at(-1)!;
    const explicitClosure =
      first.nodeIndex === 0 &&
      last.nodeIndex === path.length &&
      service.stationIds[first.occurrence] ===
        service.stationIds[last.occurrence];
    if (!explicitClosure) add(last, first, true);
  }
  return segments;
}

/** Match occurrences monotonically, so two visits to a crossing remain separate. */
function shapePositions(shape: LatLng[], stops: LatLng[]): number[] {
  if (!shape.length || !stops.length) return [];
  const stopProgress = [0];
  for (let i = 1; i < stops.length; i++)
    stopProgress.push(stopProgress[i - 1] + haversine(stops[i - 1], stops[i]));
  const total = stopProgress.at(-1) || 1;
  // Keep large imported shapes responsive. The original vertices, not the samples,
  // are retained when the resulting segments are cut out below.
  const stride = Math.max(
    1,
    Math.ceil((shape.length * stops.length) / 3_000_000),
  );
  let cursor = 0;
  return stops.map((stop, stopIndex) => {
    let best = cursor;
    let bestScore = Infinity;
    const consider = (index: number) => {
      // A very small progress term resolves repeated coordinates without overriding
      // the station's physical location (at most ten metres over the whole shape).
      const score =
        haversine(stop, shape[index]) +
        Math.abs(
          index / Math.max(1, shape.length - 1) -
            stopProgress[stopIndex] / total,
        ) *
          0.01;
      if (score < bestScore) {
        best = index;
        bestScore = score;
      }
    };
    for (let i = cursor; i < shape.length; i += stride) consider(i);
    consider(shape.length - 1);
    const coarseBest = best;
    for (
      let i = Math.max(cursor, coarseBest - stride);
      i <= Math.min(shape.length - 1, coarseBest + stride);
      i++
    )
      consider(i);
    cursor = best;
    return best;
  });
}

function serviceSegments(
  network: Network,
  service: Service,
  stationMap = new Map(
    network.stations.map((station) => [station.id, station]),
  ),
): ServiceSegment[] {
  if (service.trackPath?.length)
    return physicalServiceSegments(network, service);
  const ids = [...service.stationIds];
  if (service.loop && ids.length > 1 && ids[0] !== ids.at(-1)) ids.push(ids[0]);
  const stops = ids
    .map((id) => stationMap.get(id))
    .map((station) =>
      station ? ([station.lat, station.lng] as LatLng) : undefined,
    );
  const shape = service.shape ?? [];
  const positions =
    shape.length > 1 && stops.every(Boolean)
      ? shapePositions(shape, stops as LatLng[])
      : [];
  const segments: ServiceSegment[] = [];
  for (let i = 1; i < ids.length; i++) {
    const from = stops[i - 1],
      to = stops[i];
    if (!from || !to) continue;
    const directWaypoints = service.waypoints?.[`${ids[i - 1]}:${ids[i]}`];
    const reverseWaypoints = service.waypoints?.[`${ids[i]}:${ids[i - 1]}`];
    const middle =
      directWaypoints ??
      (reverseWaypoints
        ? [...reverseWaypoints].reverse()
        : positions.length
          ? shape.slice(positions[i - 1], positions[i] + 1)
          : []);
    const coordinates = deduplicate([from, ...middle, to]);
    const distance = lineDistance(coordinates);
    segments.push({
      fromId: ids[i - 1],
      toId: ids[i],
      fromIndex: i - 1,
      toIndex: i === service.stationIds.length ? 0 : i,
      coordinates,
      distance,
      travelMinutes: (distance / service.speed) * 60,
    });
  }
  return segments;
}

/** Bulk geometry avoids rematching a source shape for each individual segment. */
export function serviceSegmentGeometries(
  network: Network,
  service: Service,
): ServiceSegment[] {
  return serviceSegments(network, service);
}

/** An optional occurrence index disambiguates repeated station pairs. */
export function serviceSegmentCoordinates(
  network: Network,
  service: Service,
  fromId: string,
  toId: string,
  occurrenceIndex?: number,
): LatLng[] {
  const segments = serviceSegments(network, service);
  const segment = segments.find(
    (item) =>
      item.fromId === fromId &&
      item.toId === toId &&
      (occurrenceIndex === undefined || item.fromIndex === occurrenceIndex),
  );
  if (segment) return segment.coordinates;
  const reverse = segments.find(
    (item) =>
      item.fromId === toId &&
      item.toId === fromId &&
      (occurrenceIndex === undefined || item.toIndex === occurrenceIndex),
  );
  return reverse ? [...reverse.coordinates].reverse() : [];
}

/** Includes physical pass-through stations; skippedStationIds only changes stopping. */
export function serviceCoordinates(
  network: Network,
  service: Service,
): LatLng[] {
  if (service.trackPath?.length)
    return deduplicate(
      resolveTrackPath(network, service).flatMap(
        (segment) => segment.coordinates,
      ),
    );
  const segments = serviceSegments(network, service);
  if (segments.length)
    return deduplicate(segments.flatMap((segment) => segment.coordinates));
  const station = network.stations.find(
    (item) => item.id === service.stationIds[0],
  );
  return station ? [[station.lat, station.lng]] : [];
}

export function routeDistance(network: Network, service: Service): number {
  if (service.trackPath?.length)
    return resolveTrackPath(network, service).reduce(
      (sum, segment) => sum + segment.distance,
      0,
    );
  return serviceSegments(network, service).reduce(
    (sum, segment) => sum + segment.distance,
    0,
  );
}

export function getNetworkStats(network: Network) {
  const stations = new Map(
    network.stations.map((station) => [station.id, station]),
  );
  const stationRoutes = new Map<string, Set<string>>();
  const stationGroups = new Map(
    network.stations.map((station) => [
      station.id,
      station.transferGroup
        ? `group:${station.transferGroup}`
        : `station:${station.id}`,
    ]),
  );
  const groupMembers = new Map<string, Set<string>>();
  const tracks = new Set<string>();
  let routeKm = 0,
    trackKm = 0;
  for (const service of network.services) {
    for (const [index, id] of service.stationIds.entries()) {
      if (!serviceStopsAt(service, index) || stations.get(id)?.isWaypoint)
        continue;
      const group = stationGroups.get(id) ?? `station:${id}`;
      if (!stationRoutes.has(group)) stationRoutes.set(group, new Set());
      stationRoutes.get(group)!.add(service.routeId);
      if (!groupMembers.has(group)) groupMembers.set(group, new Set());
      groupMembers.get(group)!.add(id);
    }
    if (network.tracks?.length) {
      routeKm += routeDistance(network, service);
      continue;
    }
    for (const segment of serviceSegments(network, service, stations)) {
      routeKm += segment.distance;
      for (let i = 1; i < segment.coordinates.length; i++) {
        const a = segment.coordinates[i - 1],
          b = segment.coordinates[i];
        const forward = JSON.stringify([a, b]),
          backward = JSON.stringify([b, a]);
        const key = forward < backward ? forward : backward;
        if (!tracks.has(key)) {
          tracks.add(key);
          trackKm += haversine(a, b);
        }
      }
    }
  }
  const interchanges = [...stationRoutes].filter(
    ([group, routes]) =>
      routes.size > 1 || (groupMembers.get(group)?.size ?? 0) > 1,
  ).length;
  if (network.tracks?.length)
    trackKm = network.tracks.reduce(
      (sum, track) => sum + lineDistance(trackCoordinates(network, track)),
      0,
    );
  return {
    stations: network.stations.filter((station) => !station.isWaypoint).length,
    waypoints: network.stations.filter((station) => station.isWaypoint).length,
    routes: network.routes.length,
    services: network.services.length,
    interchanges,
    routeKm,
    trackKm,
    expressServices: network.services.filter(
      (service) => service.kind === "express" || service.kind === "limited",
    ).length,
    junctions: network.junctions?.length ?? 0,
    tracks: network.tracks?.length ?? 0,
    passingLoops: network.passingLoops?.length ?? 0,
  };
}

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(path, "expected an object");
  return value as Record<string, unknown>;
}
function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  if (value.length > max)
    fail(path, `at most ${max.toLocaleString()} items are supported`);
  return value;
}
function string(
  value: unknown,
  path: string,
  max = 300,
  empty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.trim()) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    fail(
      path,
      `expected ${empty ? "text" : "non-empty text"} of at most ${max} characters`,
    );
  return value;
}
function identifier(value: unknown, path: string): string {
  const id = string(value, path, 160);
  if (
    /[\r\n\t]/.test(id) ||
    ["__proto__", "prototype", "constructor"].includes(id)
  )
    fail(path, "invalid identifier");
  return id;
}
function number(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    fail(path, `expected a finite number between ${min} and ${max}`);
  return value;
}
function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected true or false");
  return value;
}
function enumeration<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (!allowed.includes(value as T))
    fail(path, `expected one of ${allowed.join(", ")}`);
  return value as T;
}
function coordinate(value: unknown, path: string): LatLng {
  const pair = array(value, path, 2);
  if (pair.length !== 2) fail(path, "expected [latitude, longitude]");
  return [
    number(pair[0], `${path}[0]`, -90, 90),
    number(pair[1], `${path}[1]`, -180, 180),
  ];
}
function uniqueIds<T extends { id: string }>(
  entities: T[],
  path: string,
): Set<string> {
  const ids = new Set<string>();
  for (const entity of entities) {
    if (ids.has(entity.id)) fail(path, `duplicate ID ${entity.id}`);
    ids.add(entity.id);
  }
  return ids;
}

function cloneJSONRecord(input: unknown): Record<string, unknown> {
  object(input, "importMetadata.original");
  let count = 0,
    characters = 0;
  const ancestors = new WeakSet<object>(),
    maximumBytes = 20 * 1024 * 1024;
  const copy = (value: unknown, depth: number): unknown => {
    if (++count > 500_000 || depth > 64)
      fail(
        "importMetadata.original",
        "original JSON exceeds the node/depth safety limit",
      );
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value))
        fail(
          "importMetadata.original",
          "original JSON contains a non-finite number",
        );
      return value;
    }
    if (typeof value === "string") {
      characters += value.length;
      if (characters > maximumBytes)
        fail("importMetadata.original", "original JSON exceeds 20 MB");
      return value;
    }
    if (!value || typeof value !== "object")
      fail(
        "importMetadata.original",
        "original data must contain JSON-safe values only",
      );
    if (ancestors.has(value))
      fail("importMetadata.original", "original JSON contains a cycle");
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      fail(
        "importMetadata.original",
        "original data must contain plain JSON objects",
      );
    ancestors.add(value);
    let result: unknown;
    if (Array.isArray(value))
      result = value.map((item) => copy(item, depth + 1));
    else
      result = Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
          characters += key.length;
          if (characters > maximumBytes)
            fail("importMetadata.original", "original JSON exceeds 20 MB");
          return [key, copy(item, depth + 1)];
        }),
      );
    ancestors.delete(value);
    return result;
  };
  const result = copy(input, 0) as Record<string, unknown>;
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength > maximumBytes
  )
    fail("importMetadata.original", "original JSON exceeds 20 MB");
  return result;
}

/** Validate and copy untrusted project files. Unknown fields are deliberately discarded. */
export function validateNetwork(input: unknown): Network {
  const root = object(input, "Project");
  if (root.version !== 1)
    fail("version", "unsupported project format; expected version 1");
  const stations: Station[] = array(root.stations, "stations", 50_000).map(
    (value, i) => {
      const station = object(value, `stations[${i}]`),
        path = `stations[${i}]`;
      return {
        id: identifier(station.id, `${path}.id`),
        name: string(station.name, `${path}.name`),
        lat: number(station.lat, `${path}.lat`, -90, 90),
        lng: number(station.lng, `${path}.lng`, -180, 180),
        ...(station.code === undefined
          ? {}
          : { code: string(station.code, `${path}.code`, 80, true) }),
        ...(station.accessible === undefined
          ? {}
          : { accessible: bool(station.accessible, `${path}.accessible`) }),
        ...(station.isWaypoint === undefined
          ? {}
          : { isWaypoint: bool(station.isWaypoint, `${path}.isWaypoint`) }),
        ...(station.grade === undefined
          ? {}
          : {
              grade: enumeration(station.grade, `${path}.grade`, [
                "above",
                "at",
                "below",
              ] as const),
            }),
        ...(station.info === undefined
          ? {}
          : { info: string(station.info, `${path}.info`, 20_000, true) }),
        ...(station.transferGroup === undefined
          ? {}
          : {
              transferGroup: identifier(
                station.transferGroup,
                `${path}.transferGroup`,
              ),
            }),
      };
    },
  );
  const stationIds = uniqueIds(stations, "stations");
  const lineGroups: LineGroup[] = array(
    root.lineGroups ?? [],
    "lineGroups",
    3000,
  ).map((value, i) => {
    const entry = object(value, `lineGroups[${i}]`),
      path = `lineGroups[${i}]`;
    return {
      id: identifier(entry.id, `${path}.id`),
      name: string(entry.name, `${path}.name`),
      visible: bool(entry.visible, `${path}.visible`),
    };
  });
  const groupIds = uniqueIds(lineGroups, "lineGroups");
  const routes: Route[] = array(root.routes, "routes", 3_000).map(
    (value, i) => {
      const route = object(value, `routes[${i}]`),
        path = `routes[${i}]`;
      const color = string(route.color, `${path}.color`, 7);
      if (!/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(color))
        fail(`${path}.color`, "expected a hexadecimal colour such as #2563eb");
      const groupId =
        route.groupId === undefined
          ? undefined
          : identifier(route.groupId, `${path}.groupId`);
      if (groupId !== undefined && !groupIds.has(groupId))
        fail(`${path}.groupId`, `unknown line group ${groupId}`);
      return {
        id: identifier(route.id, `${path}.id`),
        name: string(route.name, `${path}.name`),
        shortName: string(route.shortName, `${path}.shortName`, 40),
        color,
        mode: enumeration(route.mode, `${path}.mode`, [
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
        ]),
        visible: bool(route.visible, `${path}.visible`),
        ...(groupId === undefined ? {} : { groupId }),
        ...(route.icon === undefined
          ? {}
          : {
              icon: enumeration(route.icon, `${path}.icon`, [
                "circle",
                "square",
                "diamond",
                "triangle",
                "hexagon",
                "pentagon",
                "heart",
                "plus",
                "star",
              ] as const),
            }),
        ...(route.pattern === undefined
          ? {}
          : {
              pattern: enumeration(route.pattern, `${path}.pattern`, [
                "solid",
                "dashed",
                "dotted",
                "dash-dot",
              ] as const),
            }),
      };
    },
  );
  const routeIds = uniqueIds(routes, "routes");
  let totalReferences = 0,
    totalCoordinates = 0;
  const parseGeometry = (
    points: unknown,
    path: string,
    max: number,
  ): LatLng[] => {
    const entries = array(points, path, max);
    totalCoordinates += entries.length;
    if (totalCoordinates > 2_000_000)
      fail(path, "project exceeds 2,000,000 geometry coordinates");
    return entries.map((point, index) =>
      coordinate(point, `${path}[${index}]`),
    );
  };
  const junctions: Junction[] = array(
    root.junctions ?? [],
    "junctions",
    50_000,
  ).map((value, i) => {
    const entry = object(value, `junctions[${i}]`),
      path = `junctions[${i}]`;
    const id = identifier(entry.id, `${path}.id`);
    if (stationIds.has(id))
      fail(`${path}.id`, "junction and station IDs must be distinct");
    return {
      id,
      name: string(entry.name, `${path}.name`),
      lat: number(entry.lat, `${path}.lat`, -90, 90),
      lng: number(entry.lng, `${path}.lng`, -180, 180),
    };
  });
  const junctionIds = uniqueIds(junctions, "junctions"),
    nodeIds = new Set([...stationIds, ...junctionIds]);
  const tracks: Track[] = array(root.tracks ?? [], "tracks", 100_000).map(
    (value, i) => {
      const entry = object(value, `tracks[${i}]`),
        path = `tracks[${i}]`;
      const fromId = identifier(entry.fromId, `${path}.fromId`),
        toId = identifier(entry.toId, `${path}.toId`);
      if (!nodeIds.has(fromId) || !nodeIds.has(toId))
        fail(path, "track references an unknown endpoint");
      const geometry = parseGeometry(
        entry.geometry ?? [],
        `${path}.geometry`,
        200_000,
      );
      if (geometry.length === 1)
        fail(
          `${path}.geometry`,
          "use an empty straight segment or a full polyline with at least two coordinates",
        );
      return {
        id: identifier(entry.id, `${path}.id`),
        ...(entry.name === undefined
          ? {}
          : { name: string(entry.name, `${path}.name`, 300, true) }),
        fromId,
        toId,
        geometry,
        kind: enumeration(entry.kind, `${path}.kind`, [
          "main",
          "passing",
          "siding",
          "connector",
        ]),
        direction: enumeration(entry.direction, `${path}.direction`, [
          "both",
          "forward",
        ]),
        ...(entry.speedLimit === undefined
          ? {}
          : {
              speedLimit: number(
                entry.speedLimit,
                `${path}.speedLimit`,
                1,
                1500,
              ),
            }),
      };
    },
  );
  uniqueIds(tracks, "tracks");
  const trackMap = new Map(tracks.map((track) => [track.id, track]));
  let totalTrackReferences = 0;
  const services: Service[] = array(root.services, "services", 10_000).map(
    (value, i) => {
      const service = object(value, `services[${i}]`),
        path = `services[${i}]`;
      const routeId = identifier(service.routeId, `${path}.routeId`);
      if (!routeIds.has(routeId))
        fail(`${path}.routeId`, `unknown route ${routeId}`);
      const ids = array(service.stationIds, `${path}.stationIds`, 20_000).map(
        (id, j) => {
          const result = identifier(id, `${path}.stationIds[${j}]`);
          if (!stationIds.has(result))
            fail(`${path}.stationIds[${j}]`, `unknown station ${result}`);
          return result;
        },
      );
      totalReferences += ids.length;
      if (totalReferences > 500_000)
        fail("services", "project exceeds 500,000 station references");
      const ownStations = new Set(ids);
      const skippedStationIds = [
        ...new Set(
          array(
            service.skippedStationIds ?? [],
            `${path}.skippedStationIds`,
            20_000,
          ).map((id, j) => {
            const result = identifier(id, `${path}.skippedStationIds[${j}]`);
            if (!ownStations.has(result))
              fail(
                `${path}.skippedStationIds[${j}]`,
                "skipped station must occur in this service",
              );
            return result;
          }),
        ),
      ];
      const loop = bool(service.loop, `${path}.loop`);
      const stopPattern =
        service.stopPattern === undefined
          ? undefined
          : array(service.stopPattern, `${path}.stopPattern`, 20_000).map(
              (value, j) => bool(value, `${path}.stopPattern[${j}]`),
            );
      if (stopPattern && stopPattern.length !== ids.length)
        fail(
          `${path}.stopPattern`,
          "must contain one boolean for each station occurrence",
        );
      const trackPath: TrackTraversal[] | undefined =
        service.trackPath === undefined
          ? undefined
          : array(service.trackPath, `${path}.trackPath`, 100_000).map(
              (value, j) => {
                const item = object(value, `${path}.trackPath[${j}]`);
                const trackId = identifier(
                  item.trackId,
                  `${path}.trackPath[${j}].trackId`,
                );
                if (!trackMap.has(trackId))
                  fail(`${path}.trackPath[${j}]`, `unknown track ${trackId}`);
                return {
                  trackId,
                  ...(item.reverse === undefined
                    ? {}
                    : {
                        reverse: bool(
                          item.reverse,
                          `${path}.trackPath[${j}].reverse`,
                        ),
                      }),
                };
              },
            );
      totalTrackReferences += trackPath?.length ?? 0;
      if (totalTrackReferences > 1_000_000)
        fail("services", "project exceeds 1,000,000 track traversals");
      const segmentKeys = new Set<string>();
      const addKeys = (a: string, b: string) => {
        segmentKeys.add(`${a}:${b}`);
        segmentKeys.add(`${b}:${a}`);
      };
      for (let j = 1; j < ids.length; j++) addKeys(ids[j - 1], ids[j]);
      if (loop && ids.length > 1) addKeys(ids.at(-1)!, ids[0]);
      const waypointEntries = Object.entries(
        object(service.waypoints ?? {}, `${path}.waypoints`),
      );
      if (waypointEntries.length > 40_000)
        fail(`${path}.waypoints`, "too many waypoint segments");
      const parseCoordinates = (
        points: unknown,
        pointPath: string,
        max: number,
      ) => {
        return parseGeometry(points, pointPath, max);
      };
      const waypoints = Object.fromEntries(
        waypointEntries.map(([key, points]) => {
          if (!segmentKeys.has(key))
            fail(`${path}.waypoints`, `unknown service segment ${key}`);
          return [
            key,
            parseCoordinates(points, `${path}.waypoints[${key}]`, 50_000),
          ];
        }),
      );
      return {
        id: identifier(service.id, `${path}.id`),
        routeId,
        name: string(service.name, `${path}.name`),
        kind: enumeration(service.kind, `${path}.kind`, [
          "local",
          "express",
          "limited",
          "shuttle",
        ]),
        stationIds: ids,
        skippedStationIds,
        waypoints,
        loop,
        direction: enumeration(service.direction, `${path}.direction`, [
          "both",
          "forward",
        ]),
        headway: number(service.headway, `${path}.headway`, 0.25, 1440),
        speed: number(service.speed, `${path}.speed`, 1, 700),
        dwell: number(service.dwell, `${path}.dwell`, 0, 1800),
        ...(stopPattern === undefined ? {} : { stopPattern }),
        ...(trackPath === undefined ? {} : { trackPath }),
        ...(service.shape === undefined
          ? {}
          : {
              shape: parseCoordinates(service.shape, `${path}.shape`, 200_000),
            }),
      };
    },
  );
  uniqueIds(services, "services");
  let expandedPathCoordinates = 0;
  for (const [index, service] of services.entries()) {
    if (service.trackPath === undefined) continue;
    if (!service.trackPath.length) {
      if (service.stationIds.length > 1)
        fail(
          `services[${index}].trackPath`,
          "an empty physical path is allowed only for a zero/one-station draft",
        );
      continue;
    }
    const path: string[] = [];
    let serviceCoordinates = 0;
    for (const traversal of service.trackPath) {
      const track = trackMap.get(traversal.trackId)!;
      serviceCoordinates += Math.max(2, track.geometry.length);
      expandedPathCoordinates += Math.max(2, track.geometry.length);
      if (serviceCoordinates > 1_000_000 || expandedPathCoordinates > 6_000_000)
        fail(
          `services[${index}].trackPath`,
          "expanded physical path geometry exceeds browser limits; simplify tracks or split the project",
        );
      if (traversal.reverse && track.direction === "forward")
        fail(
          `services[${index}].trackPath`,
          `track ${track.id} cannot be traversed backwards`,
        );
      if (service.direction === "both" && track.direction === "forward")
        fail(
          `services[${index}].direction`,
          `a bidirectional service cannot use one-way track ${track.id}`,
        );
      const from = traversal.reverse ? track.toId : track.fromId,
        to = traversal.reverse ? track.fromId : track.toId;
      if (path.length && path.at(-1) !== from)
        fail(
          `services[${index}].trackPath`,
          `disconnected tracks before ${track.id}`,
        );
      if (!path.length) path.push(from);
      path.push(to);
    }
    if (service.loop && path[0] !== path.at(-1))
      fail(
        `services[${index}].trackPath`,
        "a looping service must have a physically closed track path",
      );
    try {
      matchTrackOccurrences(service, path, true);
    } catch (error) {
      fail(
        `services[${index}].trackPath`,
        error instanceof Error ? error.message : "invalid station order",
      );
    }
  }
  const passingLoops: PassingLoop[] = array(
    root.passingLoops ?? [],
    "passingLoops",
    20_000,
  ).map((value, i) => {
    const entry = object(value, `passingLoops[${i}]`),
      path = `passingLoops[${i}]`;
    const stationId = identifier(entry.stationId, `${path}.stationId`),
      entryId = identifier(entry.entryId, `${path}.entryId`),
      exitId = identifier(entry.exitId, `${path}.exitId`);
    if (
      !stationIds.has(stationId) ||
      !nodeIds.has(entryId) ||
      !nodeIds.has(exitId) ||
      entryId === exitId ||
      stationId === entryId ||
      stationId === exitId
    )
      fail(
        path,
        "passing loop needs a station and two distinct valid approach endpoints",
      );
    const parseLane = (
      raw: unknown,
      lane: string,
    ): { ids: string[]; nodes: string[] } => {
      const ids = array(raw, `${path}.${lane}`, 50_000).map((id, j) =>
        identifier(id, `${path}.${lane}[${j}]`),
      );
      if (!ids.length)
        fail(`${path}.${lane}`, "a lane must contain at least one track");
      const nodes = [entryId];
      for (const id of ids) {
        const track = trackMap.get(id);
        if (!track) fail(`${path}.${lane}`, `unknown track ${id}`);
        if (track.fromId === nodes.at(-1)) nodes.push(track.toId);
        else if (track.toId === nodes.at(-1) && track.direction === "both")
          nodes.push(track.fromId);
        else
          fail(
            `${path}.${lane}`,
            "lane tracks must form a connected, permitted path from entry to exit",
          );
      }
      if (nodes.at(-1) !== exitId)
        fail(`${path}.${lane}`, "lane does not reach its exit");
      return { ids, nodes };
    };
    const main = parseLane(entry.mainTrackIds, "mainTrackIds"),
      bypass = parseLane(entry.bypassTrackIds, "bypassTrackIds");
    if (!main.nodes.includes(stationId) || bypass.nodes.includes(stationId))
      fail(
        path,
        "main lane must serve the station; bypass lane must avoid its platform",
      );
    if (main.ids.some((id) => bypass.ids.includes(id)))
      fail(path, "main and bypass lanes must use distinct tracks");
    return {
      id: identifier(entry.id, `${path}.id`),
      name: string(entry.name, `${path}.name`),
      stationId,
      entryId,
      exitId,
      mainTrackIds: main.ids,
      bypassTrackIds: bypass.ids,
    };
  });
  uniqueIds(passingLoops, "passingLoops");
  const sources: Source[] = array(root.sources ?? [], "sources", 500).map(
    (value, i) => {
      const source = object(value, `sources[${i}]`),
        path = `sources[${i}]`;
      const url = string(source.url, `${path}.url`, 3_000);
      try {
        if (!["http:", "https:"].includes(new URL(url).protocol))
          fail(`${path}.url`, "expected an HTTP or HTTPS URL");
      } catch {
        fail(`${path}.url`, "expected an HTTP or HTTPS URL");
      }
      return {
        title: string(source.title, `${path}.title`, 500),
        url,
        ...(source.license === undefined
          ? {}
          : {
              license: string(source.license, `${path}.license`, 2_000, true),
            }),
        ...(source.accessed === undefined
          ? {}
          : {
              accessed: string(source.accessed, `${path}.accessed`, 80, true),
            }),
      };
    },
  );
  const updatedAt = string(root.updatedAt, "updatedAt", 80);
  if (!Number.isFinite(Date.parse(updatedAt)))
    fail("updatedAt", "expected a valid date");
  let importMetadata: ImportMetadata | undefined;
  if (root.importMetadata !== undefined) {
    const metadata = object(root.importMetadata, "importMetadata");
    const importedAt = string(
      metadata.importedAt,
      "importMetadata.importedAt",
      80,
    );
    if (!Number.isFinite(Date.parse(importedAt)))
      fail("importMetadata.importedAt", "expected a valid date");
    importMetadata = {
      format: string(metadata.format, "importMetadata.format", 80),
      importedAt,
      lossReport: array(
        metadata.lossReport,
        "importMetadata.lossReport",
        1000,
      ).map((message, i) =>
        string(message, `importMetadata.lossReport[${i}]`, 2000, true),
      ),
      original: cloneJSONRecord(metadata.original),
    };
  }
  return {
    version: 1,
    id: identifier(root.id, "id"),
    name: string(root.name, "name"),
    city: string(root.city, "city", 300, true),
    country: string(root.country, "country", 300, true),
    description: string(root.description, "description", 20_000, true),
    stations,
    routes,
    services,
    sources,
    dataStatus: enumeration(root.dataStatus, "dataStatus", [
      "demo",
      "imported",
      "osm",
      "gtfs",
      "custom",
    ]),
    center: coordinate(root.center, "center"),
    zoom: number(root.zoom, "zoom", 0, 22),
    updatedAt,
    ...(root.junctions === undefined ? {} : { junctions }),
    ...(root.tracks === undefined ? {} : { tracks }),
    ...(root.passingLoops === undefined ? {} : { passingLoops }),
    ...(importMetadata === undefined ? {} : { importMetadata }),
    ...(root.lineGroups === undefined ? {} : { lineGroups }),
  };
}

export interface JourneyLeg {
  serviceId: string;
  fromId: string;
  toId: string;
  stationIds: string[];
  minutes: number;
}
export interface Journey {
  legs: JourneyLeg[];
  minutes: number;
  transfers: number;
}

interface RideNode {
  service: Service;
  occurrence: number;
  direction: 1 | -1;
  stationId: string;
  stops: boolean;
  phase: "arrive" | "depart";
  next?: number;
  travel?: number;
  dwellOverride?: number;
}
interface QueueEntry {
  node: number;
  minutes: number;
  transfers: number;
}
interface Step {
  previous: number;
  action: "board" | "ride" | "dwell";
  minutes: number;
}
class MinHeap {
  private values: QueueEntry[] = [];
  private less(a: QueueEntry, b: QueueEntry) {
    return (
      a.minutes < b.minutes ||
      (a.minutes === b.minutes && a.transfers < b.transfers)
    );
  }
  push(value: QueueEntry) {
    let index = this.values.push(value) - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.less(value, this.values[parent])) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }
  pop(): QueueEntry | undefined {
    if (!this.values.length) return undefined;
    const first = this.values[0],
      last = this.values.pop()!;
    if (this.values.length) {
      let index = 0;
      while (index * 2 + 1 < this.values.length) {
        let child = index * 2 + 1;
        if (
          child + 1 < this.values.length &&
          this.less(this.values[child + 1], this.values[child])
        )
          child++;
        if (!this.less(this.values[child], last)) break;
        this.values[index] = this.values[child];
        index = child;
      }
      this.values[index] = last;
    }
    return first;
  }
}

/** Expected-time routing. Service headway is minutes, speed km/h, dwell seconds.
 * A shared station ID connects platforms; different IDs require a transferGroup.
 * Platform changes allow three minutes plus half the next service's headway.
 */
export function findJourney(
  network: Network,
  fromId: string,
  toId: string,
): Journey | null {
  const stations = new Map(
    network.stations.map((station) => [station.id, station]),
  );
  if (!stations.has(fromId) || !stations.has(toId)) return null;
  if (stations.get(fromId)?.isWaypoint || stations.get(toId)?.isWaypoint)
    return null;
  if (fromId === toId) return { legs: [], minutes: 0, transfers: 0 };
  const group = (id: string) =>
    stations.get(id)?.transferGroup
      ? `group:${stations.get(id)!.transferGroup}`
      : `station:${id}`;
  const fromGroup = group(fromId),
    toGroup = group(toId);
  const nodes: RideNode[] = [];
  const platforms = new Map<string, number[]>();
  for (const service of network.services) {
    if (service.stationIds.length < 2) continue;
    const segments = serviceSegments(network, service, stations);
    for (const direction of (service.direction === "both" ? [1, -1] : [1]) as (
      | 1
      | -1
    )[]) {
      const departureNodes: number[] = [],
        arrivalNodes: number[] = [];
      for (let i = 0; i < service.stationIds.length; i++) {
        const stationId = service.stationIds[i];
        const stops =
          serviceStopsAt(service, i) && !stations.get(stationId)?.isWaypoint;
        arrivalNodes.push(
          nodes.push({
            service,
            occurrence: i,
            direction,
            stationId,
            stops,
            phase: "arrive",
          }) - 1,
        );
        const departure =
          nodes.push({
            service,
            occurrence: i,
            direction,
            stationId,
            stops,
            phase: "depart",
          }) - 1;
        departureNodes.push(departure);
        if (stops && stations.has(stationId)) {
          const key = group(stationId);
          if (!platforms.has(key)) platforms.set(key, []);
          platforms.get(key)!.push(departure);
        }
      }
      for (let i = 0; i < arrivalNodes.length; i++)
        nodes[arrivalNodes[i]].next = departureNodes[i];
      for (const segment of segments) {
        const fromIndex = direction === 1 ? segment.fromIndex : segment.toIndex;
        const toIndex = direction === 1 ? segment.toIndex : segment.fromIndex;
        nodes[departureNodes[fromIndex]].next = arrivalNodes[toIndex];
        nodes[departureNodes[fromIndex]].travel = segment.travelMinutes;
      }
      // An explicitly repeated loop terminus is the same occurrence boundary.
      if (service.loop && service.stationIds[0] === service.stationIds.at(-1)) {
        const last = service.stationIds.length - 1;
        const seamStops =
          (serviceStopsAt(service, 0) || serviceStopsAt(service, last)) &&
          !stations.get(service.stationIds[0])?.isWaypoint;
        const firstArrival =
          direction === 1 ? arrivalNodes[last] : arrivalNodes[0];
        const nextArrival =
          direction === 1 ? arrivalNodes[0] : arrivalNodes[last];
        const nextDeparture =
          direction === 1 ? departureNodes[0] : departureNodes[last];
        nodes[firstArrival].next = nextArrival;
        nodes[firstArrival].dwellOverride = 0;
        nodes[nextArrival].dwellOverride = seamStops ? service.dwell / 60 : 0;
        if (seamStops) {
          const key = group(service.stationIds[0]);
          if (!platforms.has(key)) platforms.set(key, []);
          if (!platforms.get(key)!.includes(nextDeparture))
            platforms.get(key)!.push(nextDeparture);
        }
      }
    }
  }
  const distance = new Float64Array(nodes.length).fill(Infinity);
  const changes = new Int32Array(nodes.length).fill(2_147_483_647);
  const previous = new Map<number, Step>();
  const queue = new MinHeap();
  const relax = (
    node: number,
    minutes: number,
    transfers: number,
    step: Step,
  ) => {
    if (
      minutes < distance[node] - 1e-9 ||
      (Math.abs(minutes - distance[node]) <= 1e-9 && transfers < changes[node])
    ) {
      distance[node] = minutes;
      changes[node] = transfers;
      previous.set(node, step);
      queue.push({ node, minutes, transfers });
    }
  };
  for (const node of platforms.get(fromGroup) ?? []) {
    if (nodes[node].next === undefined) continue;
    const minutes =
      nodes[node].service.headway / 2 +
      (nodes[node].stationId === fromId ? 0 : 3);
    relax(node, minutes, 0, { previous: -1, action: "board", minutes });
  }
  let bestNode = fromGroup === toGroup ? -2 : -1,
    bestMinutes = fromGroup === toGroup ? 3 : Infinity,
    bestTransfers = fromGroup === toGroup ? 0 : Infinity,
    finalWalk = 0;
  let current: QueueEntry | undefined;
  while ((current = queue.pop())) {
    const index = current.node,
      node = nodes[index];
    if (
      current.minutes !== distance[index] ||
      current.transfers !== changes[index]
    )
      continue;
    if (current.minutes > bestMinutes) break;
    if (node.phase === "depart") {
      if (node.next !== undefined) {
        const minutes = node.travel ?? 0;
        relax(node.next, current.minutes + minutes, current.transfers, {
          previous: index,
          action: "ride",
          minutes,
        });
      }
      continue;
    }
    const stops = node.stops;
    if (stops && group(node.stationId) === toGroup) {
      const walk = node.stationId === toId ? 0 : 3,
        total = current.minutes + walk;
      if (
        total < bestMinutes - 1e-9 ||
        (Math.abs(total - bestMinutes) <= 1e-9 &&
          current.transfers < bestTransfers)
      ) {
        bestNode = index;
        bestMinutes = total;
        bestTransfers = current.transfers;
        finalWalk = walk;
      }
    }
    if (node.next !== undefined) {
      const minutes =
        node.dwellOverride ?? (stops ? node.service.dwell / 60 : 0);
      relax(node.next, current.minutes + minutes, current.transfers, {
        previous: index,
        action: "dwell",
        minutes,
      });
    }
    if (stops) {
      for (const next of platforms.get(group(node.stationId)) ?? []) {
        if (next === node.next || nodes[next].next === undefined) continue;
        const minutes = 3 + nodes[next].service.headway / 2;
        relax(next, current.minutes + minutes, current.transfers + 1, {
          previous: index,
          action: "board",
          minutes,
        });
      }
    }
  }
  if (bestNode === -1) return null;
  if (bestNode === -2) return { legs: [], minutes: 3, transfers: 0 };
  const steps: { node: number; step: Step }[] = [];
  let cursor = bestNode;
  while (cursor !== -1) {
    const step = previous.get(cursor);
    if (!step) return null;
    steps.push({ node: cursor, step });
    cursor = step.previous;
  }
  steps.reverse();
  const legs: JourneyLeg[] = [];
  let leg: JourneyLeg | undefined;
  for (const { node: index, step } of steps) {
    const node = nodes[index];
    if (step.action === "board") {
      leg = {
        serviceId: node.service.id,
        fromId: node.stationId,
        toId: node.stationId,
        stationIds: [node.stationId],
        minutes: step.minutes,
      };
      legs.push(leg);
    } else if (leg) {
      leg.minutes += step.minutes;
      if (step.action === "ride") {
        leg.stationIds.push(node.stationId);
        leg.toId = node.stationId;
      }
    }
  }
  if (legs.length) legs.at(-1)!.minutes += finalWalk;
  return { legs, minutes: bestMinutes, transfers: bestTransfers };
}
