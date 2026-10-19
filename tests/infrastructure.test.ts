import { test } from "node:test";
import assert from "node:assert/strict";
import type { Network, Service } from "../src/types";
import {
  findJourney,
  getNetworkStats,
  isServiceVisible,
  resolveTrackPath,
  routeDistance,
  serviceCoordinates,
  serviceStopsAt,
  trackPathNodes,
  validateNetwork,
} from "../src/engine";
import {
  branchFromLoop,
  createPassingLoop,
  extendServiceTo,
  materializeInfrastructure,
  setServiceLoop,
  usePassingLoop,
} from "../src/infrastructure";
import { normalizeDraft } from "../src/editor";

function service(
  id: string,
  ids: string[],
  changes: Partial<Service> = {},
): Service {
  return {
    id,
    routeId: "r",
    name: id,
    kind: "local",
    stationIds: ids,
    skippedStationIds: [],
    waypoints: {},
    loop: false,
    direction: "both",
    headway: 4,
    speed: 60,
    dwell: 60,
    ...changes,
  };
}
function fixture(): Network {
  return {
    version: 1,
    id: "graph",
    name: "Infrastructure test",
    city: "Example",
    country: "Example",
    description: "Fictional test geometry.",
    center: [0, 0],
    zoom: 12,
    dataStatus: "custom",
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
        color: "#dd2233",
        mode: "metro",
        visible: true,
      },
    ],
    services: [
      service("local", ["a", "b", "c"]),
      service("express", ["a", "b", "c"], {
        kind: "express",
        skippedStationIds: ["b"],
      }),
    ],
  };
}

test("legacy migration shares physical tracks across local, express and reverse services and is idempotent", () => {
  const network = fixture();
  network.services.push(service("reverse", ["c", "b", "a"]));
  const before = network.services.map((item) => routeDistance(network, item));
  materializeInfrastructure(network);
  assert.equal(network.tracks!.length, 2);
  assert.deepEqual(
    network.services[0].trackPath,
    network.services[1].trackPath,
  );
  assert.ok(network.services[2].trackPath!.every((item) => item.reverse));
  assert.deepEqual(
    network.services.map((item) => routeDistance(network, item)),
    before,
  );
  const ids = network.tracks!.map((track) => track.id);
  materializeInfrastructure(network);
  assert.deepEqual(
    network.tracks!.map((track) => track.id),
    ids,
  );
  assert.doesNotThrow(() => validateNetwork(network));
});

test("a passing loop splits shared approaches and routes express trains onto a separate platform-free path", () => {
  const network = fixture();
  const loop = createPassingLoop(network, "b", {
    serviceId: "local",
    offsetMeters: 80,
    lengthMeters: 600,
  });
  assert.equal(network.junctions!.length, 2);
  assert.equal(network.tracks!.length, 5);
  assert.deepEqual(
    trackPathNodes(network, network.services[0]).filter((id) =>
      ["a", "b", "c"].includes(id),
    ),
    ["a", "b", "c"],
  );
  const express = usePassingLoop(network, "express", loop.id, "bypass");
  assert.ok(!trackPathNodes(network, express).includes("b"));
  assert.equal(serviceStopsAt(express, 1), false);
  assert.ok(
    !serviceCoordinates(network, express).some(
      (point) => point[0] === 0 && point[1] === 0.01,
    ),
  );
  assert.deepEqual(
    findJourney({ ...network, services: [express] }, "a", "c")?.legs[0]
      .stationIds,
    ["a", "c"],
  );
  assert.equal(
    findJourney({ ...network, services: [express] }, "a", "b"),
    null,
  );
  assert.doesNotThrow(() => validateNetwork(network));
  usePassingLoop(network, "express", loop.id, "main");
  assert.equal(serviceStopsAt(express, 1), true);
  assert.ok(trackPathNodes(network, express).includes("b"));
  assert.doesNotThrow(() => validateNetwork(network));
});

test("passing lanes work in reverse and do not change the other services sharing the approach", () => {
  const network = fixture();
  network.services.push(
    service("reverse", ["c", "b", "a"], { direction: "forward" }),
  );
  const loop = createPassingLoop(network, "b");
  usePassingLoop(network, "reverse", loop.id, "bypass");
  assert.deepEqual(
    trackPathNodes(network, network.services[2]).filter((id) =>
      ["a", "b", "c"].includes(id),
    ),
    ["c", "a"],
  );
  assert.ok(trackPathNodes(network, network.services[0]).includes("b"));
  assert.equal(
    findJourney({ ...network, services: [network.services[2]] }, "a", "c"),
    null,
  );
  assert.doesNotThrow(() => validateNetwork(network));
});

test("different corridors at a shared station can own separate passing loops", () => {
  const network = fixture();
  network.services.push(service("north-south", ["d", "b", "e"]));
  const eastWest = createPassingLoop(network, "b", {
    serviceId: "local",
    name: "East–west loop",
  });
  const northSouth = createPassingLoop(network, "b", {
    serviceId: "north-south",
    name: "North–south loop",
  });
  assert.notEqual(eastWest.id, northSouth.id);
  assert.equal(network.passingLoops!.length, 2);
  usePassingLoop(network, "north-south", northSouth.id, "bypass");
  assert.ok(!trackPathNodes(network, network.services[2]).includes("b"));
  assert.ok(trackPathNodes(network, network.services[0]).includes("b"));
  assert.doesNotThrow(() => validateNetwork(network));
});

test("selecting a one-way passing lane never silently detaches a bidirectional service", () => {
  const network = fixture(),
    loop = createPassingLoop(network, "b");
  network.tracks!.find(
    (track) => track.id === loop.bypassTrackIds[0],
  )!.direction = "forward";
  const original = structuredClone(network.services[0].trackPath);
  assert.throws(
    () => usePassingLoop(network, "local", loop.id, "bypass"),
    /one way/,
  );
  assert.deepEqual(network.services[0].trackPath, original);
  assert.doesNotThrow(() => validateNetwork(network));
});

test("a ring passing loop may straddle the ordered path boundary without breaking closure or stop order", () => {
  const network = fixture();
  network.services = [
    service("ring", ["a", "b", "d"], { loop: true, direction: "forward" }),
  ];
  const loop = createPassingLoop(network, "a");
  usePassingLoop(network, "ring", loop.id, "bypass");
  const nodes = trackPathNodes(network, network.services[0]);
  assert.equal(nodes[0], nodes.at(-1));
  assert.ok(!nodes.includes("a"));
  assert.deepEqual(findJourney(network, "d", "b")?.legs[0].stationIds, [
    "d",
    "b",
  ]);
  assert.equal(findJourney(network, "a", "b"), null);
  assert.doesNotThrow(() => validateNetwork(network));
  usePassingLoop(network, "ring", loop.id, "main");
  assert.deepEqual(findJourney(network, "d", "a")?.legs[0].stationIds, [
    "d",
    "a",
  ]);
  assert.doesNotThrow(() => validateNetwork(network));
});

test("stopPattern distinguishes two visits to the same station in a one-way service", () => {
  const network = fixture();
  network.services = [
    service("repeated", ["a", "b", "c", "b", "d"], {
      direction: "forward",
      headway: 30,
      stopPattern: [true, false, true, true, true],
    }),
  ];
  materializeInfrastructure(network);
  assert.deepEqual(findJourney(network, "a", "b")?.legs[0].stationIds, [
    "a",
    "b",
    "c",
    "b",
  ]);
  assert.equal(findJourney(network, "b", "c"), null);
  assert.deepEqual(findJourney(network, "b", "d")?.legs[0].stationIds, [
    "b",
    "d",
  ]);
  assert.doesNotThrow(() => validateNetwork(network));
});

test("an explicitly duplicated loop boundary honors either stopping occurrence with one dwell", () => {
  for (const flags of [
    [true, true, true, false],
    [false, true, true, true],
  ]) {
    const network = fixture();
    network.services = [
      service("ring", ["a", "b", "c", "a"], {
        loop: true,
        direction: "forward",
        stopPattern: flags,
      }),
    ];
    materializeInfrastructure(network);
    const journey = findJourney(network, "c", "b");
    assert.ok(journey);
    assert.deepEqual(journey.legs[0].stationIds, ["c", "a", "b"]);
    const path = resolveTrackPath(network, network.services[0]);
    assert.ok(
      Math.abs(
        journey.minutes -
          (2 + path[2].travelMinutes + path[0].travelMinutes + 1),
      ) < 1e-8,
    );
    assert.ok(findJourney(network, "a", "b"));
    assert.ok(findJourney(network, "c", "a"));
  }
});

test("branching from a ring starts at the selected entry and only includes explicitly requested laps", () => {
  const network = fixture();
  network.services = [
    service("ring", ["a", "b", "c"], { loop: true, direction: "forward" }),
  ];
  const direct = branchFromLoop(network, "ring", "b");
  assert.deepEqual(direct.stationIds, ["b"]);
  assert.equal(direct.loop, false);
  assert.deepEqual(direct.trackPath, []);
  network.services.push(direct);
  extendServiceTo(network, direct.id, "d");
  extendServiceTo(network, direct.id, "c");
  assert.deepEqual(direct.stationIds, ["b", "d", "c"]);
  assert.deepEqual(trackPathNodes(network, direct), ["b", "d", "c"]);
  const lap = branchFromLoop(network, "ring", "b", 1);
  network.services.push(lap);
  assert.deepEqual(lap.stationIds, ["b", "c", "a", "b"]);
  assert.equal(lap.loop, false);
  extendServiceTo(network, lap.id, "d");
  extendServiceTo(network, lap.id, "c");
  assert.deepEqual(lap.stationIds, ["b", "c", "a", "b", "d", "c"]);
  assert.deepEqual(trackPathNodes(network, lap), lap.stationIds);
  assert.deepEqual(
    findJourney({ ...network, services: [lap] }, "a", "d")?.legs[0].stationIds,
    ["a", "b", "d"],
  );
  assert.doesNotThrow(() => validateNetwork(network));
});

test("extending an implicit ring replaces its closing section and leaves the physical path closed", () => {
  const network = fixture();
  network.services = [service("ring", ["a", "b", "c"], { loop: true })];
  materializeInfrastructure(network);
  extendServiceTo(network, "ring", "d");
  assert.deepEqual(network.services[0].stationIds, ["a", "b", "c", "d"]);
  assert.deepEqual(trackPathNodes(network, network.services[0]), [
    "a",
    "b",
    "c",
    "d",
    "a",
  ]);
  assert.doesNotThrow(() => validateNetwork(network));
});

test("loop toggles add and remove an implicit closing connector without detaching the service", () => {
  const network = fixture();
  network.services = [network.services[0]];
  materializeInfrastructure(network);
  setServiceLoop(network, "local", true);
  assert.deepEqual(network.services[0].stationIds, ["a", "b", "c"]);
  assert.deepEqual(trackPathNodes(network, network.services[0]), [
    "a",
    "b",
    "c",
    "a",
  ]);
  assert.doesNotThrow(() => validateNetwork(network));
  setServiceLoop(network, "local", false);
  assert.deepEqual(trackPathNodes(network, network.services[0]), [
    "a",
    "b",
    "c",
  ]);
  assert.equal(network.tracks!.length, 3);
  assert.doesNotThrow(() => validateNetwork(network));
  network.services = [
    service("explicit", ["a", "b", "c", "a"], { loop: true }),
  ];
  materializeInfrastructure(network);
  setServiceLoop(network, "explicit", false);
  assert.deepEqual(trackPathNodes(network, network.services[0]), [
    "a",
    "b",
    "c",
    "a",
  ]);
  assert.doesNotThrow(() => validateNetwork(network));
});

test("non-passenger junctions connect tracks without creating passenger interchanges", () => {
  const network = fixture();
  network.junctions = [{ id: "x", name: "Flat crossing", lat: 0, lng: 0.01 }];
  network.tracks = [
    {
      id: "ax",
      fromId: "a",
      toId: "x",
      geometry: [],
      kind: "main",
      direction: "both",
    },
    {
      id: "xc",
      fromId: "x",
      toId: "c",
      geometry: [],
      kind: "main",
      direction: "both",
    },
    {
      id: "dx",
      fromId: "d",
      toId: "x",
      geometry: [],
      kind: "main",
      direction: "both",
    },
    {
      id: "xe",
      fromId: "x",
      toId: "e",
      geometry: [],
      kind: "main",
      direction: "both",
    },
  ];
  network.services = [
    service("east-west", ["a", "c"], {
      trackPath: [{ trackId: "ax" }, { trackId: "xc" }],
    }),
    service("north-south", ["d", "e"], {
      trackPath: [{ trackId: "dx" }, { trackId: "xe" }],
    }),
  ];
  assert.equal(findJourney(network, "a", "e"), null);
  assert.doesNotThrow(() => validateNetwork(network));
});

test("track speed limits constrain journey time independently from service cruising speed", () => {
  const network = fixture();
  network.services = [network.services[0]];
  materializeInfrastructure(network);
  network.tracks![0].speedLimit = 20;
  const parts = resolveTrackPath(network, network.services[0]);
  const expected =
    2 + (parts[0].distance / 20) * 60 + (parts[1].distance / 60) * 60 + 1;
  assert.ok(
    Math.abs(findJourney(network, "a", "c")!.minutes - expected) < 1e-8,
  );
});

test("validation rejects broken continuity, wrong-way tracks, missing platform stops and malformed extensions", () => {
  const network = fixture();
  materializeInfrastructure(network);
  const cases: [string, (network: Network) => void, RegExp][] = [
    ["disconnected", (n) => n.services[0].trackPath!.reverse(), /disconnected/],
    [
      "wrong-way",
      (n) => {
        n.services[0].direction = "forward";
        n.services[0].trackPath![0].reverse = true;
        n.tracks![0].direction = "forward";
      },
      /backwards/,
    ],
    [
      "bidirectional over one-way",
      (n) => {
        n.tracks![0].direction = "forward";
      },
      /bidirectional/,
    ],
    [
      "platform order",
      (n) => {
        n.services[0].stationIds = ["c", "a", "b"];
      },
      /missing or out of order/,
    ],
    [
      "missing endpoint",
      (n) => {
        n.tracks![0].fromId = "ghost";
      },
      /unknown endpoint/,
    ],
    [
      "wrong pattern length",
      (n) => {
        n.services[0].stopPattern = [true];
      },
      /one boolean/,
    ],
    [
      "open loop",
      (n) => {
        n.services[0].loop = true;
      },
      /physically closed/,
    ],
    [
      "node identity collision",
      (n) => {
        n.junctions = [{ ...n.stations[0] }];
      },
      /must be distinct/,
    ],
  ];
  for (const [label, mutate, expression] of cases) {
    const input = structuredClone(network);
    mutate(input);
    assert.throws(() => validateNetwork(input), expression, label);
  }
  const loop = createPassingLoop(network, "b");
  usePassingLoop(network, "express", loop.id, "bypass");
  network.services[1].stopPattern![1] = true;
  assert.throws(() => validateNetwork(network), /missing or out of order/);
});

test("graph normalization cleans deletion references and counts only passenger stations", () => {
  const network = fixture();
  createPassingLoop(network, "b");
  network.stations = network.stations.filter((station) => station.id !== "b");
  normalizeDraft(network);
  assert.equal(network.passingLoops!.length, 0);
  assert.ok(
    network.services.every((service) => service.trackPath === undefined),
  );
  assert.doesNotThrow(() => validateNetwork(network));
  network.stations[0].isWaypoint = true;
  assert.equal(getNetworkStats(network).stations, 3);
  assert.equal(findJourney(network, "a", "c"), null);
});

test("line groups affect visibility only and parity/source metadata survive strict validation", () => {
  const network = fixture();
  network.lineGroups = [{ id: "g", name: "Hidden group", visible: false }];
  network.routes[0].groupId = "g";
  network.routes[0].icon = "heart";
  network.routes[0].pattern = "dash-dot";
  network.stations[0].grade = "below";
  network.stations[0].info = "Plain <text> remains text.";
  network.importMetadata = {
    format: "metrodreamin",
    importedAt: "2026-10-19",
    lossReport: [],
    original: { arbitrary: { title: "Original", nodes: [1, true, null] } },
  };
  assert.equal(isServiceVisible(network, network.services[0]), false);
  assert.ok(findJourney(network, "a", "c"));
  const parsed = validateNetwork(network);
  assert.deepEqual(parsed.lineGroups, network.lineGroups);
  assert.deepEqual(parsed.importMetadata, network.importMetadata);
  assert.equal(parsed.stations[0].info, network.stations[0].info);
  parsed.importMetadata!.original.arbitrary = "Changed";
  assert.notDeepEqual(parsed.importMetadata, network.importMetadata);
  const unsafe = structuredClone(network);
  unsafe.importMetadata!.original.bad = Infinity;
  assert.throws(() => validateNetwork(unsafe), /non-finite/);
  const cycle = structuredClone(network);
  cycle.importMetadata!.original.cycle = cycle.importMetadata!.original;
  assert.throws(() => validateNetwork(cycle), /cycle/);
});

test("a walking interchange remains an option rather than overriding a faster frequent shuttle", () => {
  const network = fixture();
  network.stations[0].transferGroup = "g";
  network.stations[1].transferGroup = "g";
  network.services = [
    service("frequent", ["a", "b"], { speed: 120, headway: 0.25 }),
  ];
  const journey = findJourney(network, "a", "b");
  assert.ok(journey && journey.minutes < 3 && journey.legs.length === 1);
});
