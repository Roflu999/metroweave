import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDraft, insertWaypoint, boundHistory } from "../src/editor";
import { validateNetwork, serviceCoordinates } from "../src/engine";
import type { Network } from "../src/types";

function fixture(): Network {
  return {
    version: 1,
    id: "test",
    name: "Example",
    city: "",
    country: "",
    description: "",
    center: [0, 0],
    zoom: 12,
    updatedAt: "2026-10-19T00:00:00Z",
    dataStatus: "custom",
    sources: [],
    stations: [
      { id: "a", name: "A", lat: 0, lng: 0 },
      { id: "b", name: "B", lat: 0, lng: 2 },
      { id: "c", name: "C", lat: 1, lng: 2 },
    ],
    routes: [
      {
        id: "r",
        name: "Route",
        shortName: "R",
        mode: "metro",
        visible: true,
        color: "#123456",
      },
    ],
    services: [
      {
        id: "s",
        routeId: "r",
        name: "Local",
        kind: "local",
        stationIds: ["a", "b", "c"],
        skippedStationIds: [],
        waypoints: {},
        loop: false,
        direction: "both",
        speed: 40,
        headway: 5,
        dwell: 30,
      },
    ],
  };
}

test("topology cleanup removes obsolete skipped stops and geometry but retains valid reverse keys", () => {
  const network = fixture(),
    service = network.services[0];
  service.skippedStationIds = ["b", "c", "b"];
  service.waypoints = { "b:a": [[0.1, 1]], "b:c": [[0.5, 2]], "c:a": [[1, 1]] };
  service.stationIds = ["a", "b"];
  normalizeDraft(network);
  assert.deepEqual(service.skippedStationIds, ["b"]);
  assert.deepEqual(service.waypoints, { "b:a": [[0.1, 1]] });
  assert.doesNotThrow(() => validateNetwork(network));
});

test("implicit loop-closing geometry survives only while its stations remain adjacent", () => {
  const network = fixture(),
    service = network.services[0];
  service.loop = true;
  service.waypoints = { "c:a": [[1, 0]], "b:a": [[0.1, 1]] };
  normalizeDraft(network);
  assert.ok(service.waypoints["c:a"]);
  service.loop = false;
  normalizeDraft(network);
  assert.ok(!service.waypoints["c:a"]);
  assert.ok(service.waypoints["b:a"]);
});

test("editing permits temporarily blank names while save normalization produces reopenable projects", () => {
  const network = fixture();
  network.name = "";
  network.stations[0].name = " ";
  network.routes[0].shortName = "";
  network.services[0].name = "";
  normalizeDraft(network);
  assert.equal(network.name, "");
  normalizeDraft(network, true);
  assert.equal(network.name, "Untitled network");
  assert.equal(network.stations[0].name, "Station 1");
  assert.equal(network.routes[0].shortName, "1");
  assert.doesNotThrow(() => validateNetwork(network));
});

test("deleting a station removes references and invalidates source shape without merging occurrences", () => {
  const network = fixture(),
    service = network.services[0];
  service.stationIds = ["a", "b", "a", "c"];
  service.shape = [
    [0, 0],
    [0, 2],
    [0, 0],
    [1, 2],
  ];
  network.stations = network.stations.filter((station) => station.id !== "b");
  normalizeDraft(network);
  assert.deepEqual(service.stationIds, ["a", "a", "c"]);
  assert.equal(service.shape, undefined);
});

test("bends insert into the nearest existing segment instead of always appending", () => {
  const network = fixture(),
    service = network.services[0];
  service.waypoints = {
    "a:b": [
      [0, 0.8],
      [0, 1.5],
    ],
  };
  const ways = insertWaypoint(network, service, "a", "b", [0.1, 0.4]);
  assert.deepEqual(ways["a:b"], [
    [0.1, 0.4],
    [0, 0.8],
    [0, 1.5],
  ]);
  assert.deepEqual(service.waypoints["a:b"], [
    [0, 0.8],
    [0, 1.5],
  ]);
  const middle = insertWaypoint(network, service, "a", "b", [0.1, 1.2]);
  assert.deepEqual(middle["a:b"], [
    [0, 0.8],
    [0.1, 1.2],
    [0, 1.5],
  ]);
});

test("reverse geometry and implicit loop edges accept ordered bends", () => {
  const network = fixture(),
    service = network.services[0];
  service.waypoints = {
    "b:a": [
      [0, 1.5],
      [0, 0.5],
    ],
  };
  const ways = insertWaypoint(network, service, "a", "b", [0.1, 1]);
  assert.deepEqual(ways["a:b"], [
    [0, 0.5],
    [0.1, 1],
    [0, 1.5],
  ]);
  assert.ok(!ways["b:a"]);
  service.loop = true;
  assert.deepEqual(insertWaypoint(network, service, "c", "a", [1, 0])["c:a"], [
    [1, 0],
  ]);
});

test("adding a custom bend preserves other imported source-shape segments", () => {
  const network = fixture(),
    service = network.services[0];
  service.shape = [
    [0, 0],
    [0.5, 0],
    [0.5, 2],
    [0, 2],
    [0.5, 2.5],
    [1, 2],
  ];
  const ways = insertWaypoint(network, service, "a", "b", [0.6, 1]);
  service.waypoints = ways;
  service.shape = undefined;
  const geometry = serviceCoordinates(network, service);
  assert.ok(geometry.some(([lat, lng]) => lat === 0.5 && lng === 2.5));
  assert.ok(geometry.some(([lat, lng]) => lat === 0.6 && lng === 1));
  assert.doesNotThrow(() => validateNetwork(network));
});

test("history keeps the latest snapshots within both count and geometry budgets", () => {
  const snapshots = Array.from({ length: 80 }, (_, i) => ({
    ...fixture(),
    name: String(i),
  }));
  assert.equal(boundHistory(snapshots).length, 60);
  const bounded = boundHistory(snapshots, 60, 21);
  assert.deepEqual(
    bounded.map((network) => network.name),
    ["77", "78", "79"],
  );
  assert.equal(boundHistory(snapshots, 60, 1).length, 1);
  assert.deepEqual(boundHistory([]), []);
});
