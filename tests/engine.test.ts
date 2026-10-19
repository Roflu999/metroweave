import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findJourney,
  getNetworkStats,
  haversine,
  routeDistance,
  serviceCoordinates,
  serviceSegmentCoordinates,
  validateNetwork,
} from "../src/engine";
import type { Network, Service } from "../src/types";

function fixture(): Network {
  return {
    version: 1,
    id: "test",
    name: "Test network",
    city: "Test",
    country: "Test",
    description: "",
    dataStatus: "custom",
    center: [0, 0],
    zoom: 12,
    updatedAt: "2026-10-19T00:00:00Z",
    sources: [],
    stations: [
      { id: "a", name: "Alpha", lat: 0, lng: 0 },
      { id: "b", name: "Beta", lat: 0, lng: 0.01 },
      { id: "c", name: "Central", lat: 0, lng: 0.02 },
      { id: "d", name: "Delta", lat: 0.01, lng: 0.01 },
      { id: "e", name: "Echo", lat: -0.01, lng: 0.01 },
    ],
    routes: [
      {
        id: "r",
        name: "Red",
        shortName: "R",
        color: "#ee3344",
        visible: true,
        mode: "metro",
      },
    ],
    services: [service("local", ["a", "b", "c"])],
  };
}

function service(
  id: string,
  stationIds: string[],
  partial: Partial<Service> = {},
): Service {
  return {
    id,
    routeId: "r",
    name: id,
    kind: "local",
    stationIds,
    skippedStationIds: [],
    waypoints: {},
    loop: false,
    direction: "both",
    headway: 4,
    speed: 60,
    dwell: 60,
    ...partial,
  };
}

test("distance handles coincident points, the antimeridian and antipodes", () => {
  assert.equal(haversine([0, 0], [0, 0]), 0);
  assert.ok(Math.abs(haversine([0, 179.9], [0, -179.9]) - 22.239) < 0.01);
  assert.ok(Number.isFinite(haversine([0, 0], [0, 180])));
});

test("local timing includes an initial expected wait and intermediate dwell, not destination dwell", () => {
  const network = fixture();
  const journey = findJourney(network, "a", "c");
  assert.ok(journey);
  assert.equal(journey.transfers, 0);
  assert.deepEqual(journey.legs[0].stationIds, ["a", "b", "c"]);
  assert.ok(
    Math.abs(
      journey.minutes - (2 + routeDistance(network, network.services[0]) + 1),
    ) < 1e-8,
  );
  assert.ok(Math.abs(journey.legs[0].minutes - journey.minutes) < 1e-8);
});

test("express trains pass through skipped stations but cannot board or alight there", () => {
  const network = fixture();
  network.services = [
    service("express", ["a", "b", "c"], {
      kind: "express",
      skippedStationIds: ["b"],
    }),
  ];
  const journey = findJourney(network, "a", "c");
  assert.ok(journey);
  assert.deepEqual(journey.legs[0].stationIds, ["a", "b", "c"]);
  assert.ok(
    Math.abs(
      journey.minutes - (2 + routeDistance(network, network.services[0])),
    ) < 1e-8,
  );
  assert.equal(findJourney(network, "a", "b"), null);
  assert.equal(findJourney(network, "b", "c"), null);
  assert.equal(serviceCoordinates(network, network.services[0]).length, 3);
});

test("the fastest compatible service wins, even with a longer expected wait", () => {
  const network = fixture();
  network.services[0].dwell = 300;
  network.services.push(
    service("express", ["a", "b", "c"], {
      kind: "express",
      skippedStationIds: ["b"],
      headway: 8,
    }),
  );
  assert.equal(findJourney(network, "a", "c")?.legs[0].serviceId, "express");
  assert.equal(findJourney(network, "a", "b")?.legs[0].serviceId, "local");
});

test("branches require a real change of train and preserve each selected path", () => {
  const network = fixture();
  network.services = [
    service("east", ["a", "b", "c"]),
    service("south", ["a", "b", "e"]),
  ];
  const journey = findJourney(network, "c", "e");
  assert.ok(journey);
  assert.equal(journey.transfers, 1);
  assert.deepEqual(
    journey.legs.map((leg) => leg.serviceId),
    ["east", "south"],
  );
  assert.deepEqual(
    journey.legs.map((leg) => leg.stationIds),
    [
      ["c", "b"],
      ["b", "e"],
    ],
  );
  const travel =
    haversine([0, 0.02], [0, 0.01]) + haversine([0, 0.01], [-0.01, 0.01]);
  assert.ok(Math.abs(journey.minutes - (2 + travel + 3 + 2)) < 1e-8);
});

test("a geometric crossing and nearby stations do not create an interchange", () => {
  const network = fixture();
  network.stations.push({
    id: "near-b",
    name: "Another platform",
    lat: 0,
    lng: 0.010001,
  });
  network.services = [
    service("east", ["a", "b", "c"]),
    service("north-south", ["d", "near-b", "e"]),
  ];
  assert.equal(findJourney(network, "a", "e"), null);
  network.stations.find((station) => station.id === "b")!.transferGroup = "hub";
  network.stations.find((station) => station.id === "near-b")!.transferGroup =
    "hub";
  const journey = findJourney(network, "a", "e");
  assert.ok(journey);
  assert.equal(journey.transfers, 1);
  assert.deepEqual(
    journey.legs.map((leg) => [leg.fromId, leg.toId]),
    [
      ["a", "b"],
      ["near-b", "e"],
    ],
  );
});

test("one-way trains cannot be used backwards, while a loop can wrap past its last station", () => {
  const network = fixture();
  network.services = [
    service("one-way", ["a", "b", "c"], { direction: "forward" }),
  ];
  assert.equal(findJourney(network, "c", "a"), null);
  network.services[0].loop = true;
  const journey = findJourney(network, "c", "b");
  assert.ok(journey);
  assert.deepEqual(journey.legs[0].stationIds, ["c", "a", "b"]);
  assert.equal(journey.transfers, 0);
});

test("an explicitly repeated loop terminus continues in both directions", () => {
  const network = fixture();
  network.services = [service("loop", ["a", "b", "c", "a"], { loop: true })];
  assert.deepEqual(findJourney(network, "c", "b")?.legs[0].stationIds, [
    "c",
    "b",
  ]);
  network.services[0].direction = "forward";
  assert.deepEqual(findJourney(network, "c", "b")?.legs[0].stationIds, [
    "c",
    "a",
    "b",
  ]);
});

test("repeated station occurrences retain their sequence and dwell", () => {
  const network = fixture();
  network.services = [
    service("figure-eight", ["a", "b", "d", "b", "c"], {
      direction: "forward",
      headway: 30,
    }),
  ];
  const journey = findJourney(network, "a", "c");
  assert.ok(journey);
  assert.deepEqual(journey.legs[0].stationIds, ["a", "b", "d", "b", "c"]);
  assert.equal(journey.transfers, 0);
  assert.doesNotThrow(() => validateNetwork(network));
});

test("custom geometry contributes distance and reverse journeys follow it", () => {
  const network = fixture();
  network.services = [
    service("detour", ["a", "c"], {
      waypoints: {
        "a:c": [
          [0.02, 0],
          [0.02, 0.02],
        ],
      },
    }),
  ];
  const points = serviceCoordinates(network, network.services[0]);
  assert.deepEqual(points, [
    [0, 0],
    [0.02, 0],
    [0.02, 0.02],
    [0, 0.02],
  ]);
  assert.deepEqual(
    serviceSegmentCoordinates(network, network.services[0], "c", "a"),
    [...points].reverse(),
  );
  assert.ok(routeDistance(network, network.services[0]) > 6);
  assert.ok(
    Math.abs(
      findJourney(network, "a", "c")!.minutes -
        findJourney(network, "c", "a")!.minutes,
    ) < 1e-8,
  );
});

test("imported shapes are split at ordered station occurrences for accurate route timing", () => {
  const network = fixture();
  network.services = [
    service("shaped", ["a", "b", "c"], {
      shape: [
        [0, 0],
        [0.01, 0],
        [0.01, 0.01],
        [0, 0.01],
        [-0.01, 0.01],
        [-0.01, 0.02],
        [0, 0.02],
      ],
    }),
  ];
  const length = routeDistance(network, network.services[0]);
  assert.ok(length > 6.6);
  assert.ok(
    Math.abs(findJourney(network, "a", "b")!.minutes - (2 + length / 2)) <
      0.001,
  );
  assert.equal(serviceCoordinates(network, network.services[0]).length, 7);
});

test("network statistics count express variants and deduplicate shared track geometry", () => {
  const network = fixture();
  network.services.push(
    service("express", ["a", "b", "c"], {
      kind: "express",
      skippedStationIds: ["b"],
    }),
  );
  const stats = getNetworkStats(network);
  assert.equal(stats.stations, 5);
  assert.equal(stats.services, 2);
  assert.equal(stats.expressServices, 1);
  assert.ok(Math.abs(stats.routeKm - stats.trackKm * 2) < 1e-8);
});

test("validation clones valid projects, retains drafts, and drops unknown fields", () => {
  const input = fixture() as Network & { ignored?: string };
  input.ignored = "<script>ignored</script>";
  input.services.push(service("draft", []));
  const parsed = validateNetwork(input);
  assert.equal(parsed.services.at(-1)!.stationIds.length, 0);
  assert.ok(!("ignored" in parsed));
  parsed.stations[0].name = "Changed";
  assert.equal(input.stations[0].name, "Alpha");
});

test("malformed imports reject invalid references, geometry, unsafe links and duplicate identities", () => {
  const cases: [string, (network: Network) => void, RegExp][] = [
    [
      "station reference",
      (network) => network.services[0].stationIds.push("ghost"),
      /unknown station/,
    ],
    [
      "route reference",
      (network) => (network.services[0].routeId = "ghost"),
      /unknown route/,
    ],
    [
      "non-finite coordinate",
      (network) => (network.stations[0].lat = NaN),
      /finite number/,
    ],
    [
      "out-of-range coordinate",
      (network) => (network.center = [91, 0]),
      /finite number/,
    ],
    [
      "zero speed",
      (network) => (network.services[0].speed = 0),
      /finite number/,
    ],
    [
      "duplicate station",
      (network) => network.stations.push({ ...network.stations[0] }),
      /duplicate ID/,
    ],
    [
      "duplicate service",
      (network) => network.services.push({ ...network.services[0] }),
      /duplicate ID/,
    ],
    [
      "foreign skip",
      (network) => (network.services[0].skippedStationIds = ["d"]),
      /must occur/,
    ],
    [
      "foreign waypoint",
      (network) => (network.services[0].waypoints = { "a:d": [[0, 0]] }),
      /unknown service segment/,
    ],
    [
      "unsafe URL",
      (network) =>
        (network.sources = [{ title: "bad", url: "javascript:alert(1)" }]),
      /HTTP or HTTPS/,
    ],
    [
      "unsafe colour",
      (network) => (network.routes[0].color = "red"),
      /hexadecimal/,
    ],
  ];
  for (const [label, mutate, expected] of cases) {
    const network = fixture();
    mutate(network);
    assert.throws(() => validateNetwork(network), expected, label);
  }
  assert.throws(() => validateNetwork(null), /expected an object/);
  assert.throws(
    () => validateNetwork({ ...fixture(), version: 2 }),
    /unsupported project format/,
  );
  assert.throws(
    () => validateNetwork({ ...fixture(), stations: new Array(50_001) }),
    /at most/,
  );
});

test("empty and disconnected projects give no invented journeys", () => {
  const network = fixture();
  assert.equal(findJourney(network, "a", "d"), null);
  assert.equal(findJourney(network, "missing", "a"), null);
  assert.deepEqual(findJourney(network, "a", "a"), {
    legs: [],
    minutes: 0,
    transfers: 0,
  });
  network.services = [];
  assert.equal(findJourney(network, "a", "c"), null);
});
