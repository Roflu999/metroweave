import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  classifyArchive,
  copyJSONData,
  exportNetworkCSV,
  exportWorkspaceZIP,
  isWorkspaceBundle,
  parseWorkspace,
  serialiseWorkspace,
} from "../src/backup";
import {
  exportGeoJSON,
  exportNetworkToMetroDreamin,
  importGeoJSON,
  importMetroDreamin,
  isMetroDreamin,
  parseCsv,
} from "../src/importers";
import { validateNetwork } from "../src/engine";
import type { Network } from "../src/types";

function sourceMap() {
  return {
    systemDoc: {
      systemId: "a-user-map",
      title: "Source title",
      lastUpdated: 1700000000000,
      ownerUserId: "source-author",
      score: { value: 17 },
    },
    groupsDisplayed: ["g"],
    map: {
      title: "Connections, everywhere",
      caption: "Source caption\nwith a second line.",
      stations: {
        a: {
          id: "a",
          name: "Alpha",
          lat: "51.5",
          lng: "-0.13",
          grade: "below",
          info: "A public description.",
        },
        w: {
          id: "w",
          isWaypoint: true,
          lat: 51.505,
          lng: -0.12,
          grade: "above",
        },
        b: { id: "b", name: "Beta", lat: 51.5, lng: -0.11, grade: "at" },
        c: { id: "c", name: "Gamma", lat: 51.5, lng: -0.09 },
        orphan: {
          id: "orphan",
          name: "Orphan",
          lat: 51.52,
          lng: -0.08,
          info: { extra: ["all", 0, false, null] },
        },
      },
      lines: {
        r: {
          id: "r",
          name: "Red, original",
          color: "#123456",
          mode: "RAPID",
          stationIds: ["a", "w", "b", "a", "c"],
          waypointOverrides: ["b"],
          lineGroupId: "g",
          icon: "heart",
          unknownLineProperty: { preserve: true },
        },
        f: {
          id: "f",
          name: "Harbor Ferry",
          color: "#abcdef",
          mode: "FERRY",
          stationIds: ["b", "c"],
        },
      },
      interchanges: {
        i: { id: "i", stationIds: ["a", "b"], unknown: 1 },
        j: { id: "j", stationIds: ["b", "c"] },
      },
      lineGroups: { g: { id: "g", label: "City services", extra: "retained" } },
      customZones: [{ title: "Keep this", coordinates: [1, 2] }],
    },
    externalMetadata: {
      hidden: false,
      value: 0,
      text: "Never discard unknown export data.",
    },
  };
}

function physicalNetwork(): Network {
  return validateNetwork({
    version: 1,
    id: "physical",
    name: "Physical plan",
    city: "Test",
    country: "Test",
    description: "Fixture",
    dataStatus: "custom",
    center: [0, 0],
    zoom: 13,
    updatedAt: "2026-10-19T00:00:00Z",
    sources: [],
    stations: [
      {
        id: "a",
        name: "Alpha",
        lat: 0,
        lng: -0.01,
        grade: "below",
        info: "One\nTwo",
      },
      { id: "b", name: "=Literal name", lat: 0, lng: 0 },
      { id: "c", name: "Gamma", lat: 0, lng: 0.01 },
    ],
    junctions: [
      { id: "e", name: "Entry", lat: 0, lng: -0.005 },
      { id: "x", name: "Exit", lat: 0, lng: 0.005 },
    ],
    tracks: [
      {
        id: "ae",
        fromId: "a",
        toId: "e",
        geometry: [
          [0, -0.01],
          [0, -0.005],
        ],
        kind: "main",
        direction: "both",
      },
      {
        id: "eb",
        fromId: "e",
        toId: "b",
        geometry: [
          [0, -0.005],
          [0, 0],
        ],
        kind: "main",
        direction: "both",
      },
      {
        id: "bx",
        fromId: "b",
        toId: "x",
        geometry: [
          [0, 0],
          [0, 0.005],
        ],
        kind: "main",
        direction: "both",
      },
      {
        id: "xc",
        fromId: "x",
        toId: "c",
        geometry: [
          [0, 0.005],
          [0, 0.01],
        ],
        kind: "main",
        direction: "both",
      },
      {
        id: "ex",
        fromId: "e",
        toId: "x",
        geometry: [
          [0, -0.005],
          [0.001, 0],
          [0, 0.005],
        ],
        kind: "passing",
        direction: "both",
        speedLimit: 120,
      },
    ],
    passingLoops: [
      {
        id: "passing",
        name: "Beta passing tracks",
        stationId: "b",
        entryId: "e",
        exitId: "x",
        mainTrackIds: ["eb", "bx"],
        bypassTrackIds: ["ex"],
      },
    ],
    lineGroups: [{ id: "g", name: "Test group", visible: false }],
    routes: [
      {
        id: "r",
        name: "Main",
        shortName: "M",
        color: "#123456",
        mode: "metro",
        visible: true,
        groupId: "g",
        icon: "star",
        pattern: "dash-dot",
      },
    ],
    services: [
      {
        id: "draft",
        routeId: "r",
        name: "Draft first",
        kind: "local",
        stationIds: [],
        skippedStationIds: [],
        waypoints: {},
        loop: false,
        direction: "both",
        headway: 5,
        speed: 40,
        dwell: 30,
        trackPath: [],
      },
      {
        id: "return",
        routeId: "r",
        name: "Out and back",
        kind: "local",
        stationIds: ["a", "b", "c", "b", "a"],
        skippedStationIds: [],
        stopPattern: [true, true, true, false, true],
        waypoints: {},
        loop: true,
        direction: "forward",
        headway: 5,
        speed: 40,
        dwell: 30,
        shape: [
          [0, -0.01],
          [0, 0],
          [0, 0.01],
          [0, 0],
          [0, -0.01],
        ],
        trackPath: [
          { trackId: "ae" },
          { trackId: "eb" },
          { trackId: "bx" },
          { trackId: "xc" },
          { trackId: "xc", reverse: true },
          { trackId: "bx", reverse: true },
          { trackId: "eb", reverse: true },
          { trackId: "ae", reverse: true },
        ],
      },
      {
        id: "express",
        routeId: "r",
        name: "Bypass",
        kind: "express",
        stationIds: ["a", "c"],
        skippedStationIds: [],
        stopPattern: [true, true],
        waypoints: {},
        loop: false,
        direction: "both",
        headway: 8,
        speed: 80,
        dwell: 20,
        trackPath: [{ trackId: "ae" }, { trackId: "ex" }, { trackId: "xc" }],
      },
    ],
    importMetadata: {
      format: "fixture",
      importedAt: "2026-10-19T00:00:00Z",
      lossReport: ["A literal note"],
      original: { untouched: ["all", 0, false, null] },
    },
  });
}
const arrayBuffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

test("MetroDreamin imports repeated visits, waypoints, modes, overrides, grades, groups, icons and complete original JSON", () => {
  const source = sourceMap(),
    n = importMetroDreamin(source);
  assert.equal(isMetroDreamin(source), true);
  assert.equal(isMetroDreamin(n), false);
  assert.equal(n.name, source.map.title);
  assert.equal(n.description, source.map.caption);
  assert.equal(n.stations.length, 5);
  assert.equal(
    n.stations.find((s) => s.id === "md-station-w")?.isWaypoint,
    true,
  );
  assert.equal(n.stations.find((s) => s.id === "md-station-a")?.grade, "below");
  assert.equal(
    n.stations.find((s) => s.id === "md-station-a")?.info,
    "A public description.",
  );
  assert.deepEqual(n.services[0].stationIds, [
    "md-station-a",
    "md-station-w",
    "md-station-b",
    "md-station-a",
    "md-station-c",
  ]);
  assert.deepEqual(n.services[0].stopPattern, [true, false, false, true, true]);
  assert.deepEqual(n.services[0].shape?.[1], [51.505, -0.12]);
  assert.equal(n.routes[1].mode, "ferry");
  assert.equal(n.routes[0].icon, "heart");
  assert.equal(n.routes[0].groupId, n.lineGroups?.[0].id);
  assert.equal(n.lineGroups?.[0].name, "City services");
  const groups = n.stations
    .filter((s) => ["Alpha", "Beta", "Gamma"].includes(s.name))
    .map((s) => s.transferGroup);
  assert.equal(
    new Set(groups).size,
    1,
    "overlapping interchange groups stay connected",
  );
  assert.deepEqual(n.importMetadata?.original, source);
  assert.match(
    n.importMetadata!.lossReport.join(" "),
    /Structured station info remains intact/,
  );
  assert.deepEqual(
    source,
    sourceMap(),
    "import does not mutate the supplied source",
  );
  assert.deepEqual(validateNetwork(n), n);
});

test("MetroDreamin supports direct maps and partition exports and fails instead of dropping broken data", () => {
  const source = sourceMap();
  assert.equal(importMetroDreamin(source.map).routes.length, 2);
  const { stations, lines, interchanges, lineGroups } = source.map;
  const partitioned = {
    systemDoc: source.systemDoc,
    partitions: [
      { data: { stations, lines } },
      { data: { interchanges, lineGroups } },
    ],
  };
  assert.equal(importMetroDreamin(partitioned).stations.length, 5);
  const broken = sourceMap();
  broken.map.lines.r.stationIds.push("missing");
  assert.throws(() => importMetroDreamin(broken), /references missing station/);
  const mode = sourceMap();
  mode.map.lines.r.mode = "UNKNOWN";
  assert.throws(() => importMetroDreamin(mode), /unsupported mode/);
  assert.equal(
    importMetroDreamin({ stations: {}, lines: {} }).stations.length,
    0,
  );
  assert.throws(
    () => importMetroDreamin({ systemDoc: { title: "Metadata only" } }),
    /No MetroDreamin map/,
  );
});

test("MetroDreamin-compatible export updates editable source fields, retains original unknown data and archives unsupported physical semantics", () => {
  const original = sourceMap(),
    n = importMetroDreamin(original);
  n.stations[0].name = "Alpha edited";
  n.name = "Edited title";
  const result = exportNetworkToMetroDreamin(n) as ReturnType<
    typeof sourceMap
  > & {
    metroweave: {
      originalSource: unknown;
      project: unknown;
      compatibilityReport: string[];
    };
  };
  assert.equal(result.map.title, "Edited title");
  assert.equal(result.map.stations.a.name, "Alpha edited");
  assert.deepEqual(result.map.customZones, original.map.customZones);
  assert.deepEqual(result.externalMetadata, original.externalMetadata);
  assert.deepEqual(
    result.map.lines.r.unknownLineProperty,
    original.map.lines.r.unknownLineProperty,
  );
  assert.deepEqual(
    result.metroweave.originalSource,
    original,
    "complete source survives even when interchange groups are normalized",
  );
  assert.equal(
    importMetroDreamin(result).stations.find((s) => s.name === "Alpha edited")
      ?.lat,
    51.5,
  );
  const physical = physicalNetwork();
  const exported = exportNetworkToMetroDreamin(physical) as {
    map: {
      stations: Record<string, { isWaypoint?: boolean }>;
      lines: Record<string, unknown>;
    };
    metroweave: {
      project: Record<string, unknown>;
      compatibilityReport: string[];
    };
  };
  assert.equal(Object.keys(exported.map.lines).length, 3);
  assert.ok(Object.values(exported.map.stations).some((s) => s.isWaypoint));
  assert.deepEqual(
    exported.metroweave.project.passingLoops,
    physical.passingLoops,
  );
  assert.match(
    exported.metroweave.compatibilityReport.join(" "),
    /repeated station visits/,
  );
  assert.ok(
    importMetroDreamin(exported).services.some((s) => s.name === "Bypass"),
  );
});

test("native GeoJSON preserves physical infrastructure, occurrence stop flags, source data and draft service order", () => {
  const n = physicalNetwork();
  const geo = exportGeoJSON(n) as {
    features: { properties: { entity?: string } }[];
  };
  assert.equal(
    geo.features.filter((f) => f.properties.entity === "junction").length,
    2,
  );
  assert.equal(
    geo.features.filter((f) => f.properties.entity === "track").length,
    5,
  );
  const restored = importGeoJSON(JSON.parse(JSON.stringify(geo)));
  assert.deepEqual(restored, n);
  assert.deepEqual(restored.services[1].stopPattern, [
    true,
    true,
    true,
    false,
    true,
  ]);
  assert.deepEqual(
    importGeoJSON(exportGeoJSON(importMetroDreamin(sourceMap()))).importMetadata
      ?.original,
    sourceMap(),
  );
});

test("complete workspace JSON and ZIP retain projects, current selection, UI, offline packs, source metadata and extensions", () => {
  const n = physicalNetwork(),
    other = importMetroDreamin(sourceMap());
  n.services[0].shape = undefined; // Normal typed editor state, omitted from canonical saved project.
  const settings = {
    labels: false,
    diagram: true,
    selectedService: "return",
    tools: { panel: "tracks" },
  };
  const offlineMaps = {
    sources: [{ id: "local", attribution: "Example source" }],
    geojsonPacks: [
      { id: "pack", data: { type: "FeatureCollection", features: [] } },
    ],
  };
  const serialized = serialiseWorkspace({
    projects: [n, other],
    currentProjectId: other.id,
    settings,
    offlineMaps,
    importedSourceMetadata: { external: "all preserved" },
    customExtension: { value: [false, 0] },
    exportedAt: "2026-10-19T00:00:00Z",
  });
  const restored = parseWorkspace(serialized);
  assert.equal(isWorkspaceBundle(restored), true);
  assert.deepEqual(restored.projects, [validateNetwork(n), other]);
  assert.equal(restored.currentProjectId, other.id);
  assert.deepEqual(restored.settings, settings);
  assert.deepEqual(restored.offlineMaps, offlineMaps);
  assert.deepEqual(restored.customExtension, { value: [false, 0] });
  const zipped = exportWorkspaceZIP(restored);
  assert.equal(classifyArchive(arrayBuffer(zipped)), "workspace");
  assert.deepEqual(parseWorkspace(arrayBuffer(zipped)), restored);
  assert.deepEqual(
    parseWorkspace(arrayBuffer(strToU8("\uFEFF" + serialized))),
    restored,
  );
});

test("workspace validation rejects duplicate identities, unsupported versions, bad current project and unsafe JSON", () => {
  const n = physicalNetwork();
  assert.throws(
    () => serialiseWorkspace({ projects: [n, n], currentProjectId: n.id }),
    /IDs must be unique/,
  );
  assert.throws(
    () => serialiseWorkspace({ projects: [n], currentProjectId: "missing" }),
    /currentProjectId/,
  );
  assert.throws(
    () =>
      parseWorkspace({
        format: "metroweave-workspace",
        version: 2,
        projects: [n],
        currentProjectId: n.id,
      }),
    /Unsupported workspace version/,
  );
  assert.throws(
    () =>
      serialiseWorkspace({
        projects: [n],
        currentProjectId: n.id,
        settings: { invalid: NaN },
      }),
    /only JSON values/,
  );
  assert.throws(() => parseWorkspace("{invalid"), /not valid JSON/);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => copyJSONData(cycle), /circular/);
  let accessed = false;
  assert.throws(
    () =>
      copyJSONData({
        get bad() {
          accessed = true;
          return "no";
        },
      }),
    /accessor/,
  );
  assert.equal(accessed, false);
});

test("archive classification distinguishes GTFS from workspace and rejects duplicate/mixed ZIPs and huge manifest declarations", () => {
  const gtfs = {
    "stops.txt": strToU8("id\na"),
    "routes.txt": strToU8("id\nr"),
    "trips.txt": strToU8("id\nt"),
    "stop_times.txt": strToU8("id\ns"),
  };
  const gtfsZip = arrayBuffer(zipSync(gtfs));
  assert.equal(classifyArchive(gtfsZip), "gtfs");
  assert.throws(() => parseWorkspace(gtfsZip), /GTFS ZIP files/);
  assert.equal(
    classifyArchive(arrayBuffer(zipSync({ "readme.txt": strToU8("unknown") }))),
    "unknown",
  );
  assert.throws(
    () =>
      classifyArchive(
        arrayBuffer(zipSync({ ...gtfs, "workspace.json": strToU8("{}") })),
      ),
    /both a workspace backup and a GTFS/,
  );
  assert.throws(
    () =>
      classifyArchive(
        arrayBuffer(
          zipSync({
            "a/workspace.json": strToU8("{}"),
            "b/workspace.json": strToU8("{}"),
          }),
        ),
      ),
    /Duplicate archive/,
  );
  const bytes = zipSync({ "workspace.json": strToU8("{}") });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < bytes.length - 46; i++)
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint32(i + 24, 101 * 1024 * 1024, true);
      break;
    }
  assert.throws(
    () => classifyArchive(arrayBuffer(bytes)),
    /expanded workspace/,
  );
});

test("CSV tables expose ordered occurrences and complete track fields, quote text and protect spreadsheet literal names", () => {
  const n = physicalNetwork(),
    tables = exportNetworkCSV(n);
  const stations = parseCsv(tables.stations),
    stops = parseCsv(tables.stops),
    tracks = parseCsv(tables.tracks);
  assert.equal(stations.find((s) => s.station_id === "a")?.info, "One\nTwo");
  assert.equal(
    stations.find((s) => s.station_id === "b")?.name,
    "'=Literal name",
  );
  const returning = stops.filter((s) => s.service_id === "return");
  assert.deepEqual(
    returning.map((s) => s.station_id),
    ["a", "b", "c", "b", "a"],
  );
  assert.deepEqual(
    returning.map((s) => s.stops),
    ["true", "true", "true", "false", "true"],
  );
  assert.equal(tracks.length, 5);
  assert.equal(
    JSON.parse(tracks.find((t) => t.track_id === "ex")!.properties_json)
      .speedLimit,
    120,
  );
  assert.deepEqual(
    JSON.parse(parseCsv(tables.provenance)[0].original_json),
    n.importMetadata!.original,
  );
});
