import type { Network, LatLng, Track, Service } from "./types";
import {
  uid,
  serviceStopsAt,
  matchTrackOccurrences,
  trackPathNodes,
  serviceCoordinates,
  haversine,
} from "./engine";
import { materializeInfrastructure } from "./infrastructure";
export function nodePosition(n: Network, id: string): LatLng {
  const node =
    n.stations.find((s) => s.id === id) ||
    n.junctions?.find((j) => j.id === id);
  if (!node) throw Error("The selected track endpoint no longer exists.");
  return [node.lat, node.lng];
}
export function addTrack(n: Network, fromId: string, toId: string): Track {
  if (fromId === toId) throw Error("Connect two different nodes.");
  const track: Track = {
    id: uid("track"),
    fromId,
    toId,
    name: "Track section",
    kind: "connector",
    direction: "both",
    geometry: [nodePosition(n, fromId), nodePosition(n, toId)],
    speedLimit: 80,
  };
  (n.tracks ??= []).push(track);
  return track;
}
export function moveNode(n: Network, id: string, point: LatLng) {
  const node =
    n.stations.find((s) => s.id === id) ||
    n.junctions?.find((j) => j.id === id);
  if (!node) return;
  node.lat = point[0];
  node.lng = point[1];
  for (const track of n.tracks || []) {
    if (track.fromId !== id && track.toId !== id) continue;
    if (track.geometry.length < 2) {
      track.geometry = [
        nodePosition(n, track.fromId),
        nodePosition(n, track.toId),
      ];
      continue;
    }
    if (track.fromId === id) track.geometry[0] = [...point];
    if (track.toId === id)
      track.geometry[track.geometry.length - 1] = [...point];
  }
  n.services
    .filter((s) => s.stationIds.includes(id))
    .forEach((s) => (s.shape = undefined));
}
export function appendTrack(n: Network, serviceId: string, trackId: string) {
  materializeInfrastructure(n);
  const s = n.services.find((s) => s.id === serviceId),
    t = n.tracks?.find((t) => t.id === trackId);
  if (!s || !t) throw Error("Choose a service and track section first.");
  if (t.direction === "forward" && s.direction === "both")
    throw Error(
      "This track is one way. Change the service to one way before using it.",
    );
  const last = s.trackPath?.at(-1),
    lastTrack = n.tracks?.find((t) => t.id === last?.trackId);
  const tail = lastTrack
    ? last?.reverse
      ? lastTrack.fromId
      : lastTrack.toId
    : s.stationIds.at(-1);
  let reverse = false;
  if (tail) {
    if (t.fromId === tail) reverse = false;
    else if (t.toId === tail && t.direction === "both") reverse = true;
    else
      throw Error(
        "This track does not connect to the service tail in an allowed direction.",
      );
  }
  const from = reverse ? t.toId : t.fromId,
    to = reverse ? t.fromId : t.toId;
  if (!s.stationIds.length) {
    if (!n.stations.some((st) => st.id === from))
      throw Error(
        "Start a service at a station before tracing through junctions.",
      );
    s.stationIds = [from];
    s.stopPattern = [true];
  }
  const stops = s.stationIds.map((_, i) => serviceStopsAt(s, i));
  if (s.loop && s.trackPath?.length && tail === s.stationIds[0]) {
    const closingVisit = matchTrackOccurrences(s, trackPathNodes(n, s)).at(-1);
    // The ring's closing call becomes an ordinary visit once its path continues
    // outward. Keep an explicitly listed closing visit and its own stop flag.
    if (closingVisit?.nodeIndex !== s.trackPath.length) {
      s.stationIds.push(tail);
      stops.push(stops[0]);
    }
  }
  s.trackPath ??= [];
  s.trackPath.push({ trackId, reverse });
  if (n.stations.some((st) => st.id === to)) {
    s.stationIds.push(to);
    stops.push(!n.stations.find((st) => st.id === to)?.isWaypoint);
  }
  s.stopPattern = stops;
  s.loop = false;
  s.shape = undefined;
  s.waypoints = {};
  return s;
}
export function insertTrackPoint(n: Network, trackId: string, p: LatLng) {
  const t = n.tracks?.find((t) => t.id === trackId);
  if (!t) throw Error("Select a track section first.");
  const points =
    t.geometry.length > 1
      ? t.geometry
      : [nodePosition(n, t.fromId), nodePosition(n, t.toId)];
  let best = Infinity,
    index = 1;
  const k = Math.cos((p[0] * Math.PI) / 180);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      ax = (a[1] - p[1]) * k,
      ay = a[0] - p[0],
      dx = (b[1] - a[1]) * k,
      dy = b[0] - a[0];
    const u = Math.max(
      0,
      Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)),
    );
    const d = (ax + u * dx) ** 2 + (ay + u * dy) ** 2;
    if (d < best) {
      best = d;
      index = i;
    }
  }
  t.geometry = [...points.slice(0, index), p, ...points.slice(index)];
}
export function expressStopPattern(s: Service): boolean[] {
  return s.stationIds.map(
    (_, index) =>
      serviceStopsAt(s, index) &&
      (index === 0 || index === s.stationIds.length - 1 || index % 3 === 0),
  );
}
/** Reverse a service without changing the physical infrastructure it uses. */
export function reverseServicePath(n: Network, serviceId: string): Service {
  const s = n.services.find((service) => service.id === serviceId);
  if (!s) throw Error("Choose an existing service to reverse.");
  const reverseKeys = new Map<string, string>();
  const pair = (from: string, to: string) => {
    reverseKeys.set(`${from}:${to}`, `${to}:${from}`);
    reverseKeys.set(`${to}:${from}`, `${from}:${to}`);
  };
  for (let i = 1; i < s.stationIds.length; i++)
    pair(s.stationIds[i - 1], s.stationIds[i]);
  if (s.loop && s.stationIds.length > 1)
    pair(s.stationIds.at(-1)!, s.stationIds[0]);
  const reversed: Service = {
    ...s,
    stationIds: [...s.stationIds].reverse(),
    stopPattern: s.stationIds.map((_, i) => serviceStopsAt(s, i)).reverse(),
    shape: s.shape?.map((point) => [...point] as LatLng).reverse(),
    waypoints: Object.fromEntries(
      Object.entries(s.waypoints).map(([key, points]) => [
        reverseKeys.get(key) ?? key,
        points.map((point) => [...point] as LatLng).reverse(),
      ]),
    ),
  };
  if (s.trackPath?.length) {
    const tracks = new Map(n.tracks?.map((track) => [track.id, track]));
    for (const traversal of s.trackPath) {
      const track = tracks.get(traversal.trackId);
      if (!track)
        throw Error("This service references a missing track section.");
      if (track.direction === "forward")
        throw Error(
          "This service uses a one-way track. Choose a reverse route or make the track bidirectional before reversing the service.",
        );
    }
    const nodes = trackPathNodes(n, s),
      matches = matchTrackOccurrences(s, nodes, true);
    reversed.trackPath = [...s.trackPath].reverse().map((traversal) => ({
      trackId: traversal.trackId,
      reverse: !traversal.reverse,
    }));
    if (s.loop) {
      if (nodes[0] !== nodes.at(-1))
        throw Error(
          "The ring's physical track path must be closed before reversing it.",
        );
      const lastVisit = matches.at(-1),
        boundary = lastVisit ? s.trackPath.length - lastVisit.nodeIndex : 0;
      if (boundary > 0 && boundary < reversed.trackPath.length)
        reversed.trackPath = [
          ...reversed.trackPath.slice(boundary),
          ...reversed.trackPath.slice(0, boundary),
        ];
    }
    matchTrackOccurrences(reversed, trackPathNodes(n, reversed), true);
  } else if (s.loop && s.shape?.length) {
    // Include the legacy renderer's closing section, then start the reversed
    // polyline at its new first station so monotonic shape matching stays valid.
    const points = serviceCoordinates(n, s)
      .map((point) => [...point] as LatLng)
      .reverse();
    const first = n.stations.find(
      (station) => station.id === reversed.stationIds[0],
    );
    if (points.length > 1 && first) {
      let boundary = 0,
        distance = Infinity;
      for (let i = 0; i < points.length - 1; i++) {
        const d = haversine([first.lat, first.lng], points[i]);
        if (d < distance) {
          distance = d;
          boundary = i;
        }
      }
      reversed.shape = [
        ...points.slice(boundary, -1),
        ...points.slice(0, boundary + 1),
      ];
    }
  }
  Object.assign(s, reversed);
  return s;
}
export function setOccurrenceStop(
  s: Service,
  index: number,
  stop: boolean,
  network?: Network,
) {
  if (index < 0 || index >= s.stationIds.length)
    throw Error("Stop occurrence is out of range.");
  const pattern = s.stationIds.map((_, i) => serviceStopsAt(s, i));
  pattern[index] = stop;
  if (network && s.trackPath?.length) {
    const nodes = trackPathNodes(network, s);
    try {
      matchTrackOccurrences({ ...s, stopPattern: pattern }, nodes, true);
    } catch {
      throw Error(
        "This stop occurrence is missing or out of order in the physical path. Assign the platform track for this visit before adding a stop.",
      );
    }
  }
  s.stopPattern = pattern;
}
