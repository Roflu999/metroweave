import type {
  LatLng,
  Network,
  PassingLoop,
  Service,
  Track,
  TrackTraversal,
} from "./types";
import {
  haversine,
  matchTrackOccurrences,
  resolveTrackPath,
  serviceSegmentGeometries,
  serviceStopsAt,
  trackCoordinates,
  uid,
} from "./engine";

const copy = <T>(value: T): T => structuredClone(value);
const pointOf = (node: { lat: number; lng: number }): LatLng => [
  node.lat,
  node.lng,
];
const reversePath = (path: TrackTraversal[]) =>
  [...path]
    .reverse()
    .map((item) => ({
      trackId: item.trackId,
      ...(item.reverse ? {} : { reverse: true }),
    }));
const signature = (from: string, to: string, points: LatLng[]) =>
  JSON.stringify([
    from,
    to,
    points.map((point) => point.map((value) => Math.round(value * 1e7) / 1e7)),
  ]);

/** Promote legacy service geometry to shared physical tracks, without inventing junctions at crossings. */
export function materializeInfrastructure(network: Network): Network {
  network.junctions ??= [];
  network.tracks ??= [];
  network.passingLoops ??= [];
  const existing = new Map<string, { track: Track; reverse: boolean }[]>();
  const indexTrack = (track: Track) => {
    if (track.kind !== "main" && track.kind !== "connector") return;
    const points = trackCoordinates(network, track);
    for (const reverse of [false, true]) {
      const key = reverse
        ? signature(track.toId, track.fromId, [...points].reverse())
        : signature(track.fromId, track.toId, points);
      if (!existing.has(key)) existing.set(key, []);
      existing.get(key)!.push({ track, reverse });
    }
  };
  network.tracks.forEach(indexTrack);
  const names = new Map(
    network.stations.map((station) => [station.id, station.name]),
  );
  for (const service of network.services) {
    if (service.trackPath !== undefined) continue;
    const path: TrackTraversal[] = [];
    for (const segment of serviceSegmentGeometries(network, service)) {
      const key = signature(segment.fromId, segment.toId, segment.coordinates);
      const shared = existing
        .get(key)
        ?.find(
          (item) =>
            item.track.direction === "both" ||
            (!item.reverse && service.direction === "forward"),
        );
      if (shared)
        path.push({
          trackId: shared.track.id,
          ...(shared.reverse ? { reverse: true } : {}),
        });
      else {
        const track: Track = {
          id: uid("track"),
          name: `${names.get(segment.fromId) ?? segment.fromId} — ${names.get(segment.toId) ?? segment.toId}`.slice(
            0,
            300,
          ),
          fromId: segment.fromId,
          toId: segment.toId,
          geometry: copy(
            segment.coordinates.length > 1
              ? segment.coordinates
              : [segment.coordinates[0], segment.coordinates[0]],
          ),
          kind: "main",
          direction: "both",
        };
        network.tracks.push(track);
        indexTrack(track);
        path.push({ trackId: track.id });
      }
    }
    service.trackPath = path;
    service.shape = undefined;
    service.waypoints = {};
  }
  return network;
}

function interpolate(a: LatLng, b: LatLng, fraction: number): LatLng {
  const delta = ((b[1] - a[1] + 540) % 360) - 180;
  const lng = a[1] + delta * fraction;
  return [a[0] + (b[0] - a[0]) * fraction, ((lng + 540) % 360) - 180];
}

function cutPolyline(
  points: LatLng[],
  distance: number,
): { before: LatLng[]; after: LatLng[]; point: LatLng } {
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    const length = haversine(points[i - 1], points[i]);
    if (travelled + length >= distance) {
      const point = interpolate(
        points[i - 1],
        points[i],
        Math.max(0, Math.min(1, (distance - travelled) / (length || 1))),
      );
      return {
        before: [...points.slice(0, i), point],
        after: [point, ...points.slice(i)],
        point,
      };
    }
    travelled += length;
  }
  throw new Error("The approach track is too short for this passing loop.");
}

function lanePath(
  network: Network,
  ids: string[],
  fromId: string,
): TrackTraversal[] {
  const tracks = new Map(
    (network.tracks ?? []).map((track) => [track.id, track]),
  );
  let cursor = fromId;
  return ids.map((id) => {
    const track = tracks.get(id);
    if (!track) throw new Error(`Missing infrastructure track ${id}`);
    if (track.fromId === cursor) {
      cursor = track.toId;
      return { trackId: id };
    }
    if (track.toId === cursor && track.direction === "both") {
      cursor = track.fromId;
      return { trackId: id, reverse: true };
    }
    throw new Error(
      "Passing-loop lane contains disconnected or wrong-way tracks.",
    );
  });
}

function splitTrack(
  network: Network,
  track: Track,
  distance: number,
  junctionId: string,
  junctionName: string,
): [Track, Track] {
  const split = cutPolyline(trackCoordinates(network, track), distance);
  network.junctions!.push({
    id: junctionId,
    name: junctionName.slice(0, 300),
    lat: split.point[0],
    lng: split.point[1],
  });
  const first: Track = {
    ...track,
    id: uid("track"),
    toId: junctionId,
    geometry: split.before,
  };
  const second: Track = {
    ...track,
    id: uid("track"),
    fromId: junctionId,
    geometry: split.after,
  };
  // Preserve the direction of every service sharing the original physical track.
  for (const service of network.services)
    if (service.trackPath)
      service.trackPath = service.trackPath.flatMap((item) =>
        item.trackId !== track.id
          ? [item]
          : item.reverse
            ? [
                { trackId: second.id, reverse: true },
                { trackId: first.id, reverse: true },
              ]
            : [{ trackId: first.id }, { trackId: second.id }],
      );
  for (const loop of network.passingLoops ?? [])
    for (const field of ["mainTrackIds", "bypassTrackIds"] as const) {
      let cursor = loop.entryId;
      const replacement: string[] = [];
      const map = new Map(network.tracks!.map((item) => [item.id, item]));
      for (const id of loop[field]) {
        const current = map.get(id)!;
        const reverse = current.toId === cursor && current.fromId !== cursor;
        replacement.push(
          ...(id === track.id
            ? reverse
              ? [second.id, first.id]
              : [first.id, second.id]
            : [id]),
        );
        cursor = reverse ? current.fromId : current.toId;
      }
      loop[field] = replacement;
    }
  network.tracks = network.tracks!.filter((item) => item.id !== track.id);
  network.tracks.push(first, second);
  return [first, second];
}

export interface PassingLoopOptions {
  name?: string;
  side?: "left" | "right";
  offsetMeters?: number;
  lengthMeters?: number;
  serviceId?: string;
}

/** Split the two approaches and add a distinct, connected platform-bypassing track. */
export function createPassingLoop(
  network: Network,
  stationId: string,
  options: PassingLoopOptions = {},
): PassingLoop {
  const station = network.stations.find(
    (station) => station.id === stationId && !station.isWaypoint,
  );
  if (!station)
    throw new Error("Select a passenger station to create a passing loop.");
  const offset = options.offsetMeters ?? 60,
    length = options.lengthMeters ?? 600;
  if (
    !Number.isFinite(offset) ||
    offset < 5 ||
    offset > 500 ||
    !Number.isFinite(length) ||
    length < 40 ||
    length > 5000
  )
    throw new Error(
      "Use a loop length of 40–5,000 m and a side offset of 5–500 m.",
    );
  materializeInfrastructure(network);
  const selectedPath =
    network.services.find((service) => service.id === options.serviceId)
      ?.trackPath ?? [];
  const selectedTracks = new Set(selectedPath.map((item) => item.trackId));
  const already = network.passingLoops!.find(
    (loop) =>
      loop.stationId === stationId &&
      (!options.serviceId ||
        loop.mainTrackIds.every((id) => selectedTracks.has(id)) ||
        loop.bypassTrackIds.every((id) => selectedTracks.has(id))),
  );
  if (already) return already;
  let approach: { incoming: Track; outgoing: Track } | undefined;
  const tracks = new Map(network.tracks!.map((track) => [track.id, track]));
  for (const service of network.services) {
    if (options.serviceId && service.id !== options.serviceId) continue;
    const path = resolveTrackPath(network, service);
    for (let i = 0; i < path.length; i++) {
      if (path[i].toId !== stationId) continue;
      const next =
        path[i + 1] ??
        (service.loop && path.at(-1)?.toId === path[0]?.fromId
          ? path[0]
          : undefined);
      if (next?.fromId === stationId && path[i].trackId !== next.trackId) {
        approach = {
          incoming: tracks.get(path[i].trackId)!,
          outgoing: tracks.get(next.trackId)!,
        };
        break;
      }
    }
    if (approach) break;
  }
  if (!approach)
    throw new Error(
      "A passing loop needs two distinct through tracks at this station. Choose a non-terminal stop or a ring.",
    );
  const distanceOf = (track: Track) =>
    trackCoordinates(network, track).reduce(
      (total, point, index, points) =>
        total + (index ? haversine(points[index - 1], point) : 0),
      0,
    );
  const inLength = distanceOf(approach.incoming),
    outLength = distanceOf(approach.outgoing);
  const before = Math.min(length / 2000, inLength * 0.45),
    after = Math.min(length / 2000, outLength * 0.45);
  if (before < 0.01 || after < 0.01)
    throw new Error(
      "Each station approach needs at least 23 metres of usable track.",
    );
  const entryId = uid("junction"),
    exitId = uid("junction");
  const incoming = splitTrack(
    network,
    approach.incoming,
    approach.incoming.toId === stationId ? inLength - before : before,
    entryId,
    `${station.name} approach A`,
  );
  const outgoing = splitTrack(
    network,
    approach.outgoing,
    approach.outgoing.fromId === stationId ? after : outLength - after,
    exitId,
    `${station.name} approach B`,
  );
  const mainIn = incoming.find(
    (track) => track.fromId === stationId || track.toId === stationId,
  )!;
  const mainOut = outgoing.find(
    (track) => track.fromId === stationId || track.toId === stationId,
  )!;
  const entry = pointOf(
      network.junctions!.find((node) => node.id === entryId)!,
    ),
    exit = pointOf(network.junctions!.find((node) => node.id === exitId)!);
  const mid = pointOf(station),
    cos = Math.max(0.001, Math.cos((mid[0] * Math.PI) / 180));
  const dx = (exit[1] - entry[1]) * cos,
    dy = exit[0] - entry[0],
    magnitude = Math.hypot(dx, dy) || 1;
  const side = options.side === "right" ? -1 : 1;
  const shift = (point: LatLng, amount: number): LatLng => [
    point[0] + (((dx / magnitude) * offset) / 111195) * side * amount,
    point[1] - (((dy / magnitude) * offset) / (111195 * cos)) * side * amount,
  ];
  const name = (options.name?.trim() || `${station.name} passing loop`).slice(
    0,
    300,
  );
  const bypass: Track = {
    id: uid("track"),
    name: `${name} bypass`.slice(0, 300),
    fromId: entryId,
    toId: exitId,
    geometry: [
      entry,
      shift(interpolate(entry, mid, 0.35), 0.65),
      shift(mid, 1),
      shift(interpolate(mid, exit, 0.65), 0.65),
      exit,
    ],
    kind: "passing",
    direction:
      mainIn.direction === "both" && mainOut.direction === "both"
        ? "both"
        : "forward",
  };
  network.tracks!.push(bypass);
  const loop: PassingLoop = {
    id: uid("passing"),
    name,
    stationId,
    entryId,
    exitId,
    mainTrackIds: [mainIn.id, mainOut.id],
    bypassTrackIds: [bypass.id],
  };
  network.passingLoops!.push(loop);
  return loop;
}

function sameTraversal(a: TrackTraversal, b: TrackTraversal): boolean {
  return a.trackId === b.trackId && !!a.reverse === !!b.reverse;
}
function syncSkipped(service: Service) {
  const served = new Set(
    service.stationIds.filter((_, index) => serviceStopsAt(service, index)),
  );
  service.skippedStationIds = [
    ...new Set(service.stationIds.filter((id) => !served.has(id))),
  ];
}

/** Choose a physical lane; the bypass never becomes a platform stop. */
export function usePassingLoop(
  network: Network,
  serviceId: string,
  loopId: string,
  lane: "main" | "bypass",
): Service {
  materializeInfrastructure(network);
  const service = network.services.find((service) => service.id === serviceId),
    loop = network.passingLoops!.find((loop) => loop.id === loopId);
  if (!service || !loop)
    throw new Error("Select an existing service and passing loop.");
  const main = lanePath(network, loop.mainTrackIds, loop.entryId),
    bypass = lanePath(network, loop.bypassTrackIds, loop.entryId);
  const patterns = [
    { path: main, reverse: false },
    { path: bypass, reverse: false },
    { path: reversePath(main), reverse: true },
    { path: reversePath(bypass), reverse: true },
  ];
  let path = [...(service.trackPath ?? [])];
  const closed =
    service.loop &&
    path.length &&
    resolveTrackPath(network, service)[0].fromId ===
      resolveTrackPath(network, service).at(-1)!.toId;
  if (closed) {
    const crossing = path.findIndex((_, index) =>
      patterns.some(
        (pattern) =>
          pattern.path.length <= path.length &&
          index + pattern.path.length > path.length &&
          pattern.path.every((item, offset) =>
            sameTraversal(item, path[(index + offset) % path.length]),
          ),
      ),
    );
    if (crossing >= 0)
      path = [...path.slice(crossing), ...path.slice(0, crossing)];
  }
  let changes = 0;
  for (let i = 0; i < path.length; ) {
    const match = patterns.find((pattern) =>
      pattern.path.every(
        (item, offset) =>
          path[i + offset] && sameTraversal(item, path[i + offset]),
      ),
    );
    if (!match) {
      i++;
      continue;
    }
    const forward = lane === "main" ? main : bypass,
      replacement = match.reverse ? reversePath(forward) : forward;
    for (const item of replacement) {
      const track = network.tracks!.find((track) => track.id === item.trackId)!;
      if (
        track.direction === "forward" &&
        (item.reverse || service.direction === "both")
      )
        throw new Error(
          "The selected lane is one way and does not permit this service direction. Change the service or physical track direction first.",
        );
    }
    path.splice(i, match.path.length, ...copy(replacement));
    i += replacement.length;
    changes++;
  }
  if (!changes)
    throw new Error(
      "This service does not traverse both approaches of the selected passing loop.",
    );
  service.stopPattern = service.stationIds.map((_, i) =>
    serviceStopsAt(service, i),
  );
  service.stationIds.forEach((id, i) => {
    if (id === loop.stationId) service.stopPattern![i] = lane === "main";
  });
  service.trackPath = path;
  service.shape = undefined;
  service.waypoints = {};
  if (lane === "main" && !service.stationIds.includes(loop.stationId)) {
    const resolved = resolveTrackPath(network, service),
      nodes = [resolved[0].fromId, ...resolved.map((segment) => segment.toId)];
    const matches = matchTrackOccurrences(service, nodes);
    const visits = nodes
      .map((id, index) =>
        id === loop.stationId &&
        !(index === nodes.length - 1 && nodes[0] === id && service.loop)
          ? index
          : -1,
      )
      .filter((index) => index >= 0);
    for (const index of visits.reverse()) {
      const insertion =
        matches.find((match) => match.nodeIndex > index)?.occurrence ??
        service.stationIds.length;
      service.stationIds.splice(insertion, 0, loop.stationId);
      service.stopPattern.splice(insertion, 0, true);
    }
  }
  syncSkipped(service);
  return service;
}

function connect(
  network: Network,
  fromId: string,
  toId: string,
): TrackTraversal {
  const shared = network.tracks!.find(
    (track) =>
      (track.kind === "main" || track.kind === "connector") &&
      track.direction === "both" &&
      ((track.fromId === fromId && track.toId === toId) ||
        (track.fromId === toId && track.toId === fromId)),
  );
  if (shared)
    return {
      trackId: shared.id,
      ...(shared.toId === fromId ? { reverse: true } : {}),
    };
  const nodes = [...network.stations, ...(network.junctions ?? [])],
    from = nodes.find((node) => node.id === fromId),
    to = nodes.find((node) => node.id === toId);
  if (!from || !to)
    throw new Error("A connecting track needs two existing endpoints.");
  const track: Track = {
    id: uid("track"),
    name: `${from.name} — ${to.name}`.slice(0, 300),
    fromId,
    toId,
    geometry: [pointOf(from), pointOf(to)],
    kind: "connector",
    direction: "both",
  };
  network.tracks!.push(track);
  return { trackId: track.id };
}

/** Toggle repeat operation while keeping the physical closing section explicit. */
export function setServiceLoop(
  network: Network,
  serviceId: string,
  enabled: boolean,
): Service {
  const service = network.services.find((service) => service.id === serviceId);
  if (!service) throw new Error("Select an existing service.");
  if (service.loop === enabled) return service;
  if (service.trackPath?.length) {
    const path = resolveTrackPath(network, service),
      nodes = [path[0].fromId, ...path.map((part) => part.toId)];
    if (enabled && nodes[0] !== nodes.at(-1))
      service.trackPath.push(connect(network, nodes.at(-1)!, nodes[0]));
    else if (!enabled && service.stationIds[0] !== service.stationIds.at(-1)) {
      // An implicit closing section is removed from the service, not demolished.
      // Explicit A→…→A station sequences remain complete, finite runs.
      const matches = matchTrackOccurrences(service, nodes),
        first = matches[0],
        last = matches.at(-1);
      if (first && last)
        service.trackPath = service.trackPath.slice(
          first.nodeIndex,
          last.nodeIndex,
        );
    }
    service.shape = undefined;
    service.waypoints = {};
  }
  service.loop = enabled;
  return service;
}

/** Extend an ordered path to a new or existing station, keeping an explicit graph connected. */
export function extendServiceTo(
  network: Network,
  serviceId: string,
  stationId: string,
): Service {
  const service = network.services.find((service) => service.id === serviceId);
  if (!service || !network.stations.some((station) => station.id === stationId))
    throw new Error("Select an existing service and station.");
  if (service.stationIds.at(-1) === stationId) return service;
  if (service.trackPath !== undefined) {
    network.tracks ??= [];
    network.junctions ??= [];
    if (
      service.loop &&
      service.stationIds.length > 1 &&
      service.stationIds[0] === service.stationIds.at(-1)
    ) {
      service.stationIds.pop();
      service.stopPattern?.pop();
    }
    const resolved = resolveTrackPath(network, service),
      nodes = resolved.length
        ? [resolved[0].fromId, ...resolved.map((segment) => segment.toId)]
        : [];
    if (service.loop && resolved.length) {
      const matches = matchTrackOccurrences(service, nodes),
        first = matches[0],
        last = matches.at(-1);
      if (!first || !last)
        throw new Error("This ring has no station endpoints to extend.");
      service.trackPath = [
        ...service.trackPath.slice(first.nodeIndex, last.nodeIndex),
        connect(network, service.stationIds[last.occurrence], stationId),
        connect(network, stationId, service.stationIds[first.occurrence]),
      ];
    } else {
      const tail = resolved.at(-1)?.toId ?? service.stationIds.at(-1);
      if (tail && tail !== stationId)
        service.trackPath.push(connect(network, tail, stationId));
    }
  }
  service.stationIds.push(stationId);
  service.stopPattern?.push(
    !network.stations.find((station) => station.id === stationId)?.isWaypoint,
  );
  service.shape = undefined;
  service.waypoints = {};
  syncSkipped(service);
  return service;
}

/** A branch starts at the selected ring entry; laps are explicit, never implied closure. */
export function branchFromLoop(
  network: Network,
  serviceId: string,
  stationId: string,
  laps = 0,
): Service {
  if (!Number.isInteger(laps) || laps < 0 || laps > 20)
    throw new Error("Choose between 0 and 20 complete ring laps.");
  materializeInfrastructure(network);
  const source = network.services.find((service) => service.id === serviceId),
    station = network.stations.find((station) => station.id === stationId);
  if (!source || !station || !source.stationIds.includes(stationId))
    throw new Error("Choose a station on the source service.");
  const resolved = resolveTrackPath(network, source),
    nodes = resolved.length
      ? [resolved[0].fromId, ...resolved.map((segment) => segment.toId)]
      : [];
  const start = nodes.indexOf(stationId);
  if (start < 0)
    throw new Error(
      "This service bypasses the selected platform. Select a station on its actual track path.",
    );
  const branch = copy(source);
  branch.id = uid("service");
  branch.name = `${source.name} · branch at ${station.name}`.slice(0, 300);
  branch.loop = false;
  branch.kind = "local";
  branch.shape = undefined;
  branch.waypoints = {};
  if (source.loop) {
    const base = [...source.stationIds],
      flags = base.map((_, i) => serviceStopsAt(source, i));
    if (base.length > 1 && base[0] === base.at(-1)) {
      base.pop();
      flags.pop();
    }
    const index = base.indexOf(stationId),
      ordered = [...base.slice(index), ...base.slice(0, index)],
      stops = [...flags.slice(index), ...flags.slice(0, index)];
    if (
      ordered.length * laps + 1 > 20_000 ||
      source.trackPath!.length * laps > 100_000
    )
      throw new Error(
        "This many laps exceeds the ordered-path browser limit. Choose fewer laps.",
      );
    branch.stationIds = [stationId];
    branch.stopPattern = [!station.isWaypoint];
    branch.trackPath = [];
    const rotated = [
      ...source.trackPath!.slice(start),
      ...source.trackPath!.slice(0, start),
    ];
    for (let lap = 0; lap < laps; lap++) {
      for (let i = 1; i < ordered.length; i++) {
        branch.stationIds.push(ordered[i]);
        branch.stopPattern.push(stops[i]);
      }
      branch.stationIds.push(stationId);
      branch.stopPattern.push(!station.isWaypoint);
      branch.trackPath.push(...copy(rotated));
    }
  } else {
    if (laps) throw new Error("Complete laps apply only to a looping service.");
    const occurrence = source.stationIds.indexOf(stationId),
      match = matchTrackOccurrences(source, nodes).find(
        (match) => match.occurrence === occurrence,
      );
    if (!match)
      throw new Error(
        "Selected station is absent from the actual service path.",
      );
    branch.stationIds = source.stationIds.slice(0, occurrence + 1);
    branch.stopPattern = branch.stationIds.map((_, i) =>
      serviceStopsAt(source, i),
    );
    branch.trackPath = source.trackPath!.slice(0, match.nodeIndex);
  }
  syncSkipped(branch);
  return branch;
}
