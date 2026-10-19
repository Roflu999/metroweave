import test from "node:test";
import assert from "node:assert/strict";
import { emptyNetwork } from "../src/data";
import type { Network } from "../src/types";
import {
  validateNetwork,
  serviceCoordinates,
  serviceStopsAt,
  findJourney,
  trackPathNodes,
  routeDistance,
} from "../src/engine";
import {
  materializeInfrastructure,
  createPassingLoop,
  usePassingLoop,
  branchFromLoop,
} from "../src/infrastructure";
import { normalizeDraft } from "../src/editor";
import {
  addTrack,
  appendTrack,
  moveNode,
  insertTrackPoint,
  setOccurrenceStop,
  expressStopPattern,
  reverseServicePath,
} from "../src/trackEditing";
function fixture(): Network {
  const n = emptyNetwork({ city: "Test", country: "Test", lat: 0, lng: 0 });
  n.stations = [
    { id: "a", name: "A", lat: 0, lng: 0 },
    { id: "b", name: "B", lat: 0, lng: 1 },
    { id: "c", name: "C", lat: 1, lng: 1 },
  ];
  n.routes = [
    {
      id: "r",
      name: "Route",
      shortName: "R",
      color: "#123456",
      mode: "metro",
      visible: true,
    },
  ];
  n.services = [
    {
      id: "s",
      routeId: "r",
      name: "Local",
      kind: "local",
      stationIds: ["a", "b"],
      skippedStationIds: [],
      waypoints: {},
      loop: false,
      direction: "both",
      headway: 5,
      speed: 40,
      dwell: 30,
    },
  ];
  return n;
}
test("moving a node on an endpoint-only track leaves a valid complete geometry", () => {
  const n = fixture();
  n.tracks = [
    {
      id: "t",
      fromId: "a",
      toId: "b",
      geometry: [],
      kind: "main",
      direction: "both",
    },
  ];
  moveNode(n, "a", [0.1, 0.2]);
  assert.deepEqual(n.tracks[0].geometry, [
    [0.1, 0.2],
    [0, 1],
  ]);
  assert.doesNotThrow(() => validateNetwork(n));
});
test("a bidirectional service cannot silently take a one-way physical track", () => {
  const n = fixture(),
    t = addTrack(n, "b", "c");
  t.direction = "forward";
  assert.throws(() => appendTrack(n, "s", t.id), /one way/i);
  n.services[0].direction = "forward";
  appendTrack(n, "s", t.id);
  assert.deepEqual(n.services[0].stationIds, ["a", "b", "c"]);
  assert.doesNotThrow(() => validateNetwork(n));
});
test("a service can trace through nonboarding junctions then rejoin a station", () => {
  const n = fixture();
  n.junctions = [{ id: "j", name: "Junction", lat: 0.5, lng: 1.2 }];
  const first = addTrack(n, "b", "j"),
    second = addTrack(n, "j", "c");
  appendTrack(n, "s", first.id);
  assert.deepEqual(n.services[0].stationIds, ["a", "b"]);
  appendTrack(n, "s", second.id);
  assert.deepEqual(n.services[0].stationIds, ["a", "b", "c"]);
  assert.doesNotThrow(() => validateNetwork(n));
  assert.ok(findJourney(n, "a", "c"));
  assert.equal(findJourney(n, "a", "j"), null);
  assert.ok(
    serviceCoordinates(n, n.services[0]).some(
      (p) => p[0] === 0.5 && p[1] === 1.2,
    ),
  );
});
test("track tracing rejects a disconnected section instead of teleporting a service", () => {
  const n = fixture();
  n.stations.push({ id: "d", name: "D", lat: 2, lng: 2 });
  const t = addTrack(n, "c", "d");
  assert.throws(() => appendTrack(n, "s", t.id), /does not connect/i);
  assert.deepEqual(n.services[0].stationIds, ["a", "b"]);
});

test("appending after an implicit ring retains the circuit and its closing station call", () => {
  const n = fixture(),
    s = n.services[0];
  n.stations.push({ id: "d", name: "D", lat: 2, lng: 2 });
  s.stationIds = ["a", "b", "c"];
  s.loop = true;
  s.direction = "forward";
  materializeInfrastructure(n);
  const circuit = structuredClone(s.trackPath),
    extension = addTrack(n, "a", "d");
  appendTrack(n, s.id, extension.id);
  assert.equal(s.loop, false);
  assert.deepEqual(s.stationIds, ["a", "b", "c", "a", "d"]);
  assert.deepEqual(s.stopPattern, [true, true, true, true, true]);
  assert.deepEqual(s.trackPath!.slice(0, -1), circuit);
  assert.deepEqual(trackPathNodes(n, s), ["a", "b", "c", "a", "d"]);
  assert.deepEqual(findJourney(n, "c", "a")?.legs[0].stationIds, ["c", "a"]);
  assert.deepEqual(findJourney(n, "c", "d")?.legs[0].stationIds, [
    "c",
    "a",
    "d",
  ]);
  assert.doesNotThrow(() => validateNetwork(n));
});

test("an implicit closing call preserves the ring's skipped first stop", () => {
  const n = fixture(),
    s = n.services[0];
  s.stationIds = ["a", "b", "c"];
  s.stopPattern = [false, true, true];
  s.loop = true;
  s.direction = "forward";
  const extension = addTrack(n, "a", "b");
  appendTrack(n, s.id, extension.id);
  assert.deepEqual(s.stationIds, ["a", "b", "c", "a", "b"]);
  assert.deepEqual(s.stopPattern, [false, true, true, false, true]);
  assert.equal(findJourney(n, "c", "a"), null);
  assert.ok(findJourney(n, "c", "b"));
  assert.doesNotThrow(() => validateNetwork(n));
});

test("appending an explicitly closed ring keeps its independent closing stop flag", () => {
  const n = fixture(),
    s = n.services[0];
  s.stationIds = ["a", "b", "c", "a"];
  s.stopPattern = [true, true, true, false];
  s.loop = true;
  s.direction = "forward";
  const extension = addTrack(n, "a", "b");
  appendTrack(n, s.id, extension.id);
  assert.deepEqual(s.stationIds, ["a", "b", "c", "a", "b"]);
  assert.deepEqual(s.stopPattern, [true, true, true, false, true]);
  assert.equal(findJourney(n, "c", "a"), null);
  assert.ok(findJourney(n, "c", "b"));
  assert.doesNotThrow(() => validateNetwork(n));
});

test("a one-station ring through a junction retains the return visit when extended", () => {
  const n = fixture(),
    s = n.services[0];
  n.junctions = [{ id: "j", name: "Junction", lat: 1, lng: 0 }];
  const outward = addTrack(n, "a", "j"),
    returning = addTrack(n, "j", "a"),
    extension = addTrack(n, "a", "b");
  s.stationIds = ["a"];
  s.loop = true;
  s.direction = "forward";
  s.trackPath = [{ trackId: outward.id }, { trackId: returning.id }];
  appendTrack(n, s.id, extension.id);
  assert.deepEqual(s.stationIds, ["a", "a", "b"]);
  assert.deepEqual(s.stopPattern, [true, true, true]);
  assert.deepEqual(trackPathNodes(n, s), ["a", "j", "a", "b"]);
  assert.doesNotThrow(() => validateNetwork(n));
});
test("editing a track bend inserts at the nearest section and preserves its other vertices", () => {
  const n = fixture();
  n.tracks = [
    {
      id: "t",
      fromId: "a",
      toId: "c",
      geometry: [
        [0, 0],
        [0, 2],
        [1, 2],
        [1, 1],
      ],
      kind: "connector",
      direction: "both",
    },
  ];
  insertTrackPoint(n, "t", [0, 1]);
  assert.deepEqual(n.tracks[0].geometry, [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 2],
    [1, 1],
  ]);
});
test("stop choices are independent for multiple visits to the same station", () => {
  const n = fixture(),
    s = n.services[0];
  s.stationIds = ["a", "b", "a"];
  setOccurrenceStop(s, 2, false);
  assert.equal(serviceStopsAt(s, 0), true);
  assert.equal(serviceStopsAt(s, 2), false);
  setOccurrenceStop(s, 1, false);
  assert.deepEqual(s.stopPattern, [true, false, false]);
});

test("express duplication preserves a bypassed cadence stop and its physical track path", () => {
  const n = fixture(),
    s = n.services[0];
  n.stations.push(
    { id: "d", name: "D", lat: 2, lng: 2 },
    { id: "e", name: "E", lat: 3, lng: 2 },
  );
  s.stationIds = ["a", "b", "c", "d", "e"];
  s.stopPattern = [true, true, true, false, true];
  s.trackPath = [
    { trackId: addTrack(n, "a", "b").id },
    { trackId: addTrack(n, "b", "c").id },
    { trackId: addTrack(n, "c", "e").id },
  ];
  const path = structuredClone(s.trackPath),
    express = {
      ...structuredClone(s),
      id: "express",
      stopPattern: expressStopPattern(s),
    };
  n.services.push(express);
  normalizeDraft(n);
  assert.deepEqual(express.stopPattern, [true, false, false, false, true]);
  assert.deepEqual(express.trackPath, path);
  assert.doesNotThrow(() => validateNetwork(n));
  const original = structuredClone(s);
  assert.throws(
    () => setOccurrenceStop(s, 3, true, n),
    /stop occurrence.*missing or out of order/i,
  );
  assert.deepEqual(s, original);
});

test("express stopping never enables a skipped endpoint from the original service", () => {
  const n = fixture(),
    s = n.services[0];
  s.stationIds = ["a", "b", "c", "a"];
  s.skippedStationIds = ["a"];
  assert.deepEqual(expressStopPattern(s), [false, false, false, false]);
});

test("stop toggles reject an absent first visit even when the same platform appears later", () => {
  const n = fixture(),
    s = n.services[0];
  n.stations.push({ id: "d", name: "D", lat: 2, lng: 2 });
  n.junctions = [{ id: "j", name: "Bypass", lat: 0.5, lng: 0 }];
  s.stationIds = ["a", "b", "c", "b", "d"];
  s.stopPattern = [true, false, true, true, true];
  s.trackPath = [
    { trackId: addTrack(n, "a", "j").id },
    { trackId: addTrack(n, "j", "c").id },
    { trackId: addTrack(n, "c", "b").id },
    { trackId: addTrack(n, "b", "d").id },
  ];
  assert.doesNotThrow(() => validateNetwork(n));
  const original = structuredClone(s);
  assert.throws(
    () => setOccurrenceStop(s, 1, true, n),
    /stop occurrence.*missing or out of order/i,
  );
  assert.deepEqual(s, original);
  setOccurrenceStop(s, 3, false, n);
  assert.deepEqual(s.stopPattern, [true, false, true, false, true]);
  setOccurrenceStop(s, 3, true, n);
  assert.deepEqual(s.stopPattern, original.stopPattern);
  assert.deepEqual(s.trackPath, original.trackPath);
  assert.doesNotThrow(() => validateNetwork(n));
});

test("reversing an express service preserves its passing-loop bypass and reverses every traversal", () => {
  const n = fixture(),
    s = n.services[0];
  s.stationIds = ["a", "b", "c"];
  s.direction = "forward";
  const loop = createPassingLoop(n, "b", { serviceId: s.id });
  usePassingLoop(n, s.id, loop.id, "bypass");
  const coordinates = serviceCoordinates(n, s),
    path = structuredClone(s.trackPath!),
    tracks = structuredClone(n.tracks),
    loops = structuredClone(n.passingLoops);
  reverseServicePath(n, s.id);
  assert.deepEqual(s.stationIds, ["c", "b", "a"]);
  assert.deepEqual(s.stopPattern, [true, false, true]);
  assert.deepEqual(
    s.trackPath,
    path.reverse().map((p) => ({ trackId: p.trackId, reverse: !p.reverse })),
  );
  assert.deepEqual(serviceCoordinates(n, s), coordinates.reverse());
  assert.deepEqual(n.tracks, tracks);
  assert.deepEqual(n.passingLoops, loops);
  assert.ok(findJourney(n, "c", "a"));
  assert.equal(findJourney(n, "a", "c"), null);
  assert.equal(findJourney(n, "c", "b"), null);
  assert.doesNotThrow(() => validateNetwork(n));
});

test("reversing an implicit ring rotates its full path to the new station boundary", () => {
  const n = fixture(),
    s = n.services[0];
  s.stationIds = ["a", "b", "c"];
  s.loop = true;
  s.direction = "forward";
  createPassingLoop(n, "c", { serviceId: s.id });
  const ids = s.trackPath!.map((p) => p.trackId).sort(),
    distance = routeDistance(n, s);
  reverseServicePath(n, s.id);
  assert.deepEqual(s.stationIds, ["c", "b", "a"]);
  const nodes = trackPathNodes(n, s);
  assert.equal(nodes[0], "c");
  assert.equal(nodes.at(-1), "c");
  assert.deepEqual(s.trackPath!.map((p) => p.trackId).sort(), ids);
  assert.ok(Math.abs(routeDistance(n, s) - distance) < 1e-8);
  assert.ok(findJourney(n, "a", "c"));
  assert.ok(findJourney(n, "c", "b"));
  assert.doesNotThrow(() => validateNetwork(n));
});

test("reversing a repeated-station service keeps the bypassed visit independent", () => {
  const n = fixture(),
    s = n.services[0];
  n.stations.push({ id: "d", name: "D", lat: 2, lng: 2 });
  n.junctions = [{ id: "j", name: "Bypass", lat: 0.5, lng: 0 }];
  s.stationIds = ["a", "b", "c", "b", "d"];
  s.stopPattern = [true, false, true, true, true];
  s.direction = "forward";
  s.trackPath = [
    { trackId: addTrack(n, "a", "j").id },
    { trackId: addTrack(n, "j", "c").id },
    { trackId: addTrack(n, "c", "b").id },
    { trackId: addTrack(n, "b", "d").id },
  ];
  reverseServicePath(n, s.id);
  assert.deepEqual(s.stationIds, ["d", "b", "c", "b", "a"]);
  assert.deepEqual(s.stopPattern, [true, true, true, false, true]);
  assert.deepEqual(trackPathNodes(n, s), ["d", "b", "c", "j", "a"]);
  assert.ok(findJourney(n, "d", "b"));
  assert.equal(findJourney(n, "c", "b"), null);
  assert.doesNotThrow(() => validateNetwork(n));
});

test("reversing a route over a one-way track rejects the edit without any mutation", () => {
  const n = fixture(),
    s = n.services[0],
    track = addTrack(n, "a", "b");
  track.direction = "forward";
  s.direction = "forward";
  s.trackPath = [{ trackId: track.id }];
  const original = structuredClone(n);
  assert.throws(() => reverseServicePath(n, s.id), /one-way track/i);
  assert.deepEqual(n, original);
});

test("legacy reversal swaps directional waypoint keys and reverses their bends", () => {
  const n = fixture(),
    s = n.services[0];
  s.stationIds = ["a", "b", "a", "c"];
  s.stopPattern = [true, false, true, true];
  s.waypoints = {
    "a:b": [
      [0.1, 0.2],
      [0.3, 0.4],
    ],
    "b:a": [
      [0.2, 0.8],
      [0.4, 0.5],
    ],
    "a:c": [[0.5, 0.2]],
  };
  const coordinates = serviceCoordinates(n, s);
  reverseServicePath(n, s.id);
  assert.deepEqual(s.stationIds, ["c", "a", "b", "a"]);
  assert.deepEqual(s.stopPattern, [true, true, false, true]);
  assert.deepEqual(s.waypoints["b:a"], [
    [0.3, 0.4],
    [0.1, 0.2],
  ]);
  assert.deepEqual(s.waypoints["a:b"], [
    [0.4, 0.5],
    [0.2, 0.8],
  ]);
  assert.deepEqual(serviceCoordinates(n, s), coordinates.reverse());
  assert.equal(s.trackPath, undefined);
  assert.doesNotThrow(() => validateNetwork(n));
});

test("legacy closed source shapes retain their curved closing section when reversed", () => {
  const n = fixture(),
    s = n.services[0];
  s.stationIds = ["a", "b", "c"];
  s.loop = true;
  s.shape = [
    [0, 0],
    [0.2, 0.5],
    [0, 1],
    [0.5, 1.2],
    [1, 1],
    [0.5, 0.2],
    [0, 0],
  ];
  const coordinates = serviceCoordinates(n, s).reverse(),
    boundary = coordinates.findIndex((p) => p[0] === 1 && p[1] === 1),
    expected = [
      ...coordinates.slice(boundary, -1),
      ...coordinates.slice(0, boundary + 1),
    ],
    distance = routeDistance(n, s);
  reverseServicePath(n, s.id);
  assert.deepEqual(serviceCoordinates(n, s), expected);
  assert.ok(Math.abs(routeDistance(n, s) - distance) < 1e-8);
  assert.equal(s.trackPath, undefined);
  assert.doesNotThrow(() => validateNetwork(n));
});

test("a finite-route branch retains the physical trunk up to the chosen platform", () => {
  const n = fixture(),
    source = n.services[0];
  source.stationIds = ["a", "b", "c"];
  createPassingLoop(n, "b", { serviceId: source.id });
  const nodes = trackPathNodes(n, source),
    branch = branchFromLoop(n, source.id, "b");
  n.services.push(branch);
  assert.equal(branch.loop, false);
  assert.deepEqual(branch.stationIds, ["a", "b"]);
  assert.deepEqual(
    trackPathNodes(n, branch),
    nodes.slice(0, nodes.indexOf("b") + 1),
  );
  assert.ok(branch.trackPath!.length);
  assert.ok(findJourney({ ...n, services: [branch] }, "a", "b"));
  assert.equal(findJourney({ ...n, services: [branch] }, "a", "c"), null);
  assert.doesNotThrow(() => validateNetwork(n));
});
