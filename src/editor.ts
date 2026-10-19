import type { LatLng, Network, Service } from "./types";
import { matchTrackOccurrences, serviceSegmentGeometries } from "./engine";

/** Keep topology valid after editing. Save-time names never interrupt text editing. */
export function normalizeDraft(network: Network, forSave = false): Network {
  const stations = new Set(network.stations.map((station) => station.id));
  const routes = new Map(network.routes.map((route) => [route.id, route]));
  const groups = new Set(network.lineGroups?.map((group) => group.id) ?? []);
  for (const route of network.routes)
    if (route.groupId && !groups.has(route.groupId)) route.groupId = undefined;
  const nodeIds = new Set([
    ...stations,
    ...(network.junctions?.map((junction) => junction.id) ?? []),
  ]);
  if (network.tracks)
    network.tracks = network.tracks.filter(
      (track) => nodeIds.has(track.fromId) && nodeIds.has(track.toId),
    );
  const tracks = new Map(
    network.tracks?.map((track) => [track.id, track]) ?? [],
  );
  if (network.passingLoops)
    network.passingLoops = network.passingLoops.filter(
      (loop) =>
        stations.has(loop.stationId) &&
        nodeIds.has(loop.entryId) &&
        nodeIds.has(loop.exitId) &&
        [...loop.mainTrackIds, ...loop.bypassTrackIds].every((id) =>
          tracks.has(id),
        ),
    );
  network.services = network.services.filter((service) =>
    routes.has(service.routeId),
  );
  for (const service of network.services) {
    const originalLength = service.stationIds.length;
    if (service.stopPattern && service.stopPattern.length !== originalLength)
      service.stopPattern = undefined;
    if (service.stopPattern)
      service.stopPattern = service.stopPattern.filter((_, index) =>
        stations.has(service.stationIds[index]),
      );
    service.stationIds = service.stationIds.filter((id) => stations.has(id));
    if (service.stationIds.length !== originalLength) service.shape = undefined;
    const ids = new Set(service.stationIds),
      keys = new Set<string>();
    const allow = (a: string, b: string) => {
      keys.add(`${a}:${b}`);
      keys.add(`${b}:${a}`);
    };
    for (let i = 1; i < service.stationIds.length; i++)
      allow(service.stationIds[i - 1], service.stationIds[i]);
    if (service.loop && service.stationIds.length > 1)
      allow(service.stationIds.at(-1)!, service.stationIds[0]);
    service.skippedStationIds = [
      ...new Set(service.skippedStationIds.filter((id) => ids.has(id))),
    ];
    service.waypoints = Object.fromEntries(
      Object.entries(service.waypoints).filter(([key]) => keys.has(key)),
    );
    if (service.trackPath) {
      const pathNodes: string[] = [];
      let invalid = !service.trackPath.length && service.stationIds.length > 1;
      for (const item of service.trackPath) {
        const track = tracks.get(item.trackId);
        if (
          !track ||
          (track.direction === "forward" &&
            (item.reverse || service.direction === "both"))
        ) {
          invalid = true;
          break;
        }
        const from = item.reverse ? track.toId : track.fromId,
          to = item.reverse ? track.fromId : track.toId;
        if (pathNodes.length && pathNodes.at(-1) !== from) {
          invalid = true;
          break;
        }
        if (!pathNodes.length) pathNodes.push(from);
        pathNodes.push(to);
      }
      if (pathNodes.length && service.loop && pathNodes[0] !== pathNodes.at(-1))
        invalid = true;
      if (!invalid && pathNodes.length) {
        try {
          matchTrackOccurrences(service, pathNodes, true);
        } catch {
          invalid = true;
        }
      }
      if (invalid) {
        service.trackPath = undefined;
        service.shape = undefined;
      }
    }
  }
  if (forSave) {
    const name = (value: string, fallback: string, max = 300) =>
      value.trim().slice(0, max) || fallback;
    network.name = name(network.name, "Untitled network");
    network.city = network.city.slice(0, 300);
    network.country = network.country.slice(0, 300);
    network.description = network.description.slice(0, 20_000);
    network.stations.forEach((station, i) => {
      station.name = name(station.name, `Station ${i + 1}`);
      if (station.code !== undefined) station.code = station.code.slice(0, 80);
      if (station.info !== undefined)
        station.info = station.info.slice(0, 20_000);
      if (station.transferGroup !== undefined) {
        const group = station.transferGroup
          .trim()
          .slice(0, 160)
          .replace(/[\u0000-\u001f\u007f]/g, "");
        station.transferGroup =
          group && !["__proto__", "prototype", "constructor"].includes(group)
            ? group
            : undefined;
      }
    });
    network.routes.forEach((route, i) => {
      route.name = name(route.name, `Line ${i + 1}`);
      route.shortName = name(route.shortName, String(i + 1), 40);
    });
    network.services.forEach((service, i) => {
      service.name = name(
        service.name,
        `${routes.get(service.routeId)?.name || `Service ${i + 1}`} · ${service.kind}`,
      );
    });
    network.junctions?.forEach((junction, i) => {
      junction.name = name(junction.name, `Junction ${i + 1}`);
    });
    network.tracks?.forEach((track) => {
      if (track.name !== undefined) track.name = track.name.slice(0, 300);
    });
    network.passingLoops?.forEach((loop, i) => {
      loop.name = name(loop.name, `Passing loop ${i + 1}`);
    });
    network.lineGroups?.forEach((group, i) => {
      group.name = name(group.name, `Line group ${i + 1}`);
    });
  }
  return network;
}

const cloneWays = (ways: Record<string, LatLng[]>) =>
  Object.fromEntries(
    Object.entries(ways).map(([key, points]) => [
      key,
      points.map((point) => [...point] as LatLng),
    ]),
  );
const longitudeDelta = (lng: number) =>
  ((((lng + 180) % 360) + 360) % 360) - 180;

function pointToSegmentSquared(point: LatLng, a: LatLng, b: LatLng): number {
  const scale = Math.max(0.000001, Math.cos((point[0] * Math.PI) / 180));
  const ax = longitudeDelta(a[1] - point[1]) * scale,
    ay = a[0] - point[0];
  const bx = longitudeDelta(b[1] - point[1]) * scale,
    by = b[0] - point[0];
  const dx = bx - ax,
    dy = by - ay;
  const fraction = Math.max(
    0,
    Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)),
  );
  return (ax + fraction * dx) ** 2 + (ay + fraction * dy) ** 2;
}

function limitedInteriors(points: LatLng[]): LatLng[] {
  const interior = points.slice(1, -1);
  if (interior.length <= 50_000)
    return interior.map((point) => [...point] as LatLng);
  return Array.from(
    { length: 50_000 },
    (_, i) =>
      [...interior[Math.round((i * (interior.length - 1)) / 49_999)]] as LatLng,
  );
}

/** Insert at the clicked physical segment, retaining order and source geometry. */
export function insertWaypoint(
  network: Network,
  service: Service,
  fromId: string,
  toId: string,
  point: LatLng,
): Record<string, LatLng[]> {
  const ways = cloneWays(service.waypoints);
  if (
    !Number.isFinite(point[0]) ||
    !Number.isFinite(point[1]) ||
    Math.abs(point[0]) > 90 ||
    Math.abs(point[1]) > 180
  )
    return ways;
  const from = network.stations.find((station) => station.id === fromId),
    to = network.stations.find((station) => station.id === toId);
  if (!from || !to) return ways;
  const pairs: [string, string, number][] = [];
  for (let i = 1; i < service.stationIds.length; i++)
    pairs.push([service.stationIds[i - 1], service.stationIds[i], i - 1]);
  if (
    service.loop &&
    service.stationIds.length > 1 &&
    service.stationIds[0] !== service.stationIds.at(-1)
  )
    pairs.push([
      service.stationIds.at(-1)!,
      service.stationIds[0],
      service.stationIds.length - 1,
    ]);
  if (
    !pairs.some(
      ([a, b]) => (a === fromId && b === toId) || (a === toId && b === fromId),
    )
  )
    return ways;
  // Shape is cleared when custom geometry is edited, so retain its other segments.
  if (service.shape?.length || service.trackPath?.length) {
    for (const {
      fromId: a,
      toId: b,
      coordinates: geometry,
    } of serviceSegmentGeometries(network, service)) {
      if (ways[`${a}:${b}`] || ways[`${b}:${a}`]) continue;
      const interior = limitedInteriors(geometry);
      if (interior.length)
        Object.defineProperty(ways, `${a}:${b}`, {
          value: interior,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
  }
  const key = `${fromId}:${toId}`,
    reverseKey = `${toId}:${fromId}`;
  const existing =
    ways[key] ?? (ways[reverseKey] ? [...ways[reverseKey]].reverse() : []);
  const path: LatLng[] = [[from.lat, from.lng], ...existing, [to.lat, to.lng]];
  let insertion = 0,
    closest = Infinity;
  for (let i = 1; i < path.length; i++) {
    const d = pointToSegmentSquared(point, path[i - 1], path[i]);
    if (d < closest) {
      closest = d;
      insertion = i - 1;
    }
  }
  const next = [...existing];
  next.splice(insertion, 0, [...point] as LatLng);
  if (next.length > 50_000) next.splice(insertion > 0 ? insertion - 1 : 1, 1);
  if (reverseKey !== key) delete ways[reverseKey];
  Object.defineProperty(ways, key, {
    value: next,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return ways;
}

/** Bound both undo count and the geometry retained in memory. Newest wins. */
export function boundHistory(
  past: Network[],
  maxSnapshots = 60,
  geometryBudget = 2_000_000,
): Network[] {
  let cost = 0,
    count = 0;
  for (let i = past.length - 1; i >= 0 && count < maxSnapshots; i--) {
    const network = past[i];
    let snapshotCost =
      network.stations.length + (network.junctions?.length ?? 0) + 1;
    for (const track of network.tracks ?? [])
      snapshotCost += track.geometry.length + 2;
    if (network.importMetadata)
      snapshotCost += originalPayloadCost(network.importMetadata.original);
    for (const service of network.services) {
      snapshotCost +=
        service.stationIds.length +
        (service.shape?.length || 0) +
        (service.trackPath?.length ?? 0);
      for (const points of Object.values(service.waypoints))
        snapshotCost += points.length;
    }
    if (count > 0 && cost + snapshotCost > geometryBudget) break;
    cost += snapshotCost;
    count++;
  }
  return count ? past.slice(-count) : [];
}

const originalCosts = new WeakMap<object, number>();
function originalPayloadCost(original: Record<string, unknown>): number {
  const cached = originalCosts.get(original);
  if (cached !== undefined) return cached;
  const cost = Math.max(1, Math.ceil(JSON.stringify(original).length / 16));
  originalCosts.set(original, cost);
  return cost;
}
