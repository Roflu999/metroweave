import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import {
  exportGeoJSON,
  importGeoJSON,
  importGTFS,
  importOSM,
  networkFromOSM,
  parseCsv,
} from "../src/importers";
import { validateNetwork } from "../src/engine";
import type { CatalogEntry, Network } from "../src/types";

const city: CatalogEntry = {
  id: "fixture",
  city: "Fixture City",
  country: "Test",
  name: "Fixture Metro",
  lat: 0,
  lng: 0,
  url: "https://en.wikipedia.org/wiki/Rapid_transit",
  region: "Test",
};
function archive(files: Record<string, string>): ArrayBuffer {
  const bytes = zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, body]) => [name, strToU8(body)]),
    ),
  );
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
function gtfsFiles(): Record<string, string> {
  return {
    "feed/stops.txt":
      'stop_id,stop_name,stop_lat,stop_lon,parent_station,wheelchair_boarding\np,"Harbor, North",0,0,,1\na,Harbor platform,,,p,0\nb,Central,0,0.01,,\nc,East,0,0.02,,\nz,Bus stop,1,1,,\n',
    "feed/routes.txt":
      "route_id,route_short_name,route_long_name,route_type,route_color\nr,A,Harbor line,1,EE1122\nbus,B,Bus route,3,123456\n",
    "feed/trips.txt":
      "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\nr,weekday,local,East local,0,east\nr,weekend,local2,East local,0,east\nr,weekday,reverse,Harbor local,1,west\nr,weekday,express,East express,0,east\nr,weekday,pass,East express pass-through,0,east\nbus,weekday,bus-trip,Bus,0,\n",
    "feed/stop_times.txt":
      "trip_id,stop_id,stop_sequence,pickup_type,drop_off_type\nlocal,c,30,0,0\nlocal,a,10,0,0\nlocal,b,20,0,0\nlocal2,a,1,0,0\nlocal2,b,2,0,0\nlocal2,c,3,0,0\nreverse,c,1,0,0\nreverse,b,2,0,0\nreverse,a,3,0,0\nexpress,a,1,0,0\nexpress,c,2,0,0\npass,a,1,0,0\npass,b,2,1,1\npass,c,3,0,0\nbus-trip,z,1,0,0\n",
    "feed/shapes.txt":
      "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\neast,0,0.02,3\neast,0,0,1\neast,0,0.01,2\nwest,0,0.02,1\nwest,0,0.01,2\nwest,0,0,3\n",
    "feed/frequencies.txt":
      "trip_id,start_time,end_time,headway_secs\nlocal,08:00:00,09:00:00,120\nlocal,09:00:00,10:00:00,240\n",
    "feed/agency.txt":
      "agency_id,agency_name,agency_url,agency_timezone\na,Fixture Transit,https://example.org,Etc/UTC\n",
  };
}

test("CSV handles a BOM, quoted newlines and escaped quotes without changing field content", () => {
  assert.deepEqual(
    parseCsv(
      '\uFEFFid,name,notes\r\n1,"Harbor, North","Two\nlines and ""quotes"""\r\n2,East,\r\n',
    ),
    [
      { id: "1", name: "Harbor, North", notes: 'Two\nlines and "quotes"' },
      { id: "2", name: "East", notes: "" },
    ],
  );
  assert.throws(() => parseCsv('id,name\n1,"open'), /unterminated/);
  assert.throws(() => parseCsv("id,id\n1,2"), /unique/);
  assert.throws(() => parseCsv("id,name\n1,2,3"), /expected 2/);
});

test("GTFS preserves ordered direction/shape/stop patterns, parent groups, express skips and honest assumptions", async () => {
  const network = await importGTFS(archive(gtfsFiles()));
  assert.equal(network.routes.length, 1);
  assert.equal(network.routes[0].color, "#EE1122");
  assert.equal(
    network.services.length,
    4,
    "duplicate calendar trips collapse; distinct stop patterns remain",
  );
  const local = network.services.find((s) => s.name === "East local")!;
  const reverse = network.services.find((s) => s.name === "Harbor local")!;
  const express = network.services.find((s) => s.name === "East express")!;
  const pass = network.services.find(
    (s) => s.name === "East express pass-through",
  )!;
  assert.deepEqual(local.stationIds, [
    "gtfs-stop-a",
    "gtfs-stop-b",
    "gtfs-stop-c",
  ]);
  assert.deepEqual(reverse.stationIds, [
    "gtfs-stop-c",
    "gtfs-stop-b",
    "gtfs-stop-a",
  ]);
  assert.deepEqual(reverse.shape, [
    [0, 0.02],
    [0, 0.01],
    [0, 0],
  ]);
  assert.equal(local.headway, 4);
  assert.equal(express.direction, "forward");
  assert.equal(express.kind, "express");
  assert.deepEqual(
    express.stationIds,
    local.stationIds,
    "a verified longer same-terminal pattern supplies physical pass-through stops",
  );
  assert.deepEqual(express.skippedStationIds, ["gtfs-stop-b"]);
  assert.deepEqual(pass.skippedStationIds, ["gtfs-stop-b"]);
  assert.equal(
    network.stations.find((s) => s.id === "gtfs-stop-a")?.transferGroup,
    "gtfs-stop-p",
  );
  assert.equal(
    network.stations.find((s) => s.id === "gtfs-stop-a")?.accessible,
    true,
  );
  assert.equal(network.stations.find((s) => s.id === "gtfs-stop-a")?.lat, 0);
  assert.ok(!network.stations.some((s) => s.id === "gtfs-stop-z"));
  assert.match(network.description, /service calendars/);
  assert.match(network.description, /planning assumptions/);
  assert.deepEqual(validateNetwork(network), network);
});

test("GTFS refuses absent required files, duplicate table names, and unsafe expanded sizes", async () => {
  await assert.rejects(
    importGTFS(archive({ "routes.txt": "route_id,route_type\nr,1\n" })),
    /missing stops.txt/,
  );
  await assert.rejects(
    importGTFS(
      archive({
        ...gtfsFiles(),
        "other/stops.txt": gtfsFiles()["feed/stops.txt"],
      }),
    ),
    /multiple stops.txt/,
  );
  const bytes = new Uint8Array(archive(gtfsFiles()));
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length - 46; i++)
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint32(i + 24, 250 * 1024 * 1024, true);
      break;
    }
  await assert.rejects(importGTFS(bytes.buffer), /browser import limit/);
});

test("GTFS distinguishes tram/monorail/rail route types and excludes bus records", async () => {
  const files = gtfsFiles();
  files["feed/routes.txt"] = "route_id,route_type\nr,12\n";
  assert.equal((await importGTFS(archive(files))).routes[0].mode, "monorail");
  files["feed/routes.txt"] = "route_id,route_type\nr,900\n";
  assert.equal((await importGTFS(archive(files))).routes[0].mode, "tram");
  files["feed/routes.txt"] = "route_id,route_type\nr,2\n";
  assert.equal((await importGTFS(archive(files))).routes[0].mode, "rail");
});

test("GTFS does not invent intermediate express stops on a different physical alignment", async () => {
  const files = gtfsFiles();
  files["feed/trips.txt"] = files["feed/trips.txt"].replace(
    "express,East express,0,east",
    "express,East express,0,alternate",
  );
  files["feed/shapes.txt"] +=
    "alternate,0,0,1\nalternate,0.1,0.01,2\nalternate,0,0.02,3\n";
  const imported = await importGTFS(archive(files)),
    express = imported.services.find((s) => s.name === "East express")!;
  assert.deepEqual(express.stationIds, ["gtfs-stop-a", "gtfs-stop-c"]);
  assert.deepEqual(express.skippedStationIds, []);
});

test("GeoJSON matches intermediate station points in path order and separates MultiLineString parts", () => {
  const imported = importGeoJSON({
    type: "FeatureCollection",
    features: [
      ...[
        [0.01, "B"],
        [0.02, "C"],
        [0, "A"],
      ].map(([lng, id]) => ({
        type: "Feature",
        id,
        properties: { name: id },
        geometry: { type: "Point", coordinates: [lng, 0] },
      })),
      {
        type: "Feature",
        properties: { routeId: "r", name: "Red", color: "#ff0000" },
        geometry: {
          type: "MultiLineString",
          coordinates: [
            [
              [0, 0],
              [0.01, 0],
              [0.02, 0],
            ],
            [
              [1, 1],
              [1.01, 1],
            ],
          ],
        },
      },
    ],
  });
  assert.deepEqual(imported.services[0].stationIds, ["A", "B", "C"]);
  assert.equal(imported.routes.length, 1);
  assert.equal(imported.services.length, 2);
  assert.equal(imported.stations.length, 5);
  assert.match(imported.description, /endpoint stations were generated/);
  assert.deepEqual(imported.services[0].shape, [
    [0, 0],
    [0, 0.01],
    [0, 0.02],
  ]);
});

test("GeoJSON roundtrip preserves service kinds, platform groups, curves, loops and source metadata", async () => {
  const network = await importGTFS(archive(gtfsFiles()));
  network.services[0].waypoints = {
    "gtfs-stop-a:gtfs-stop-b": [[0.005, 0.005]],
  };
  network.services[0].dwell = 0;
  network.services[0].direction = "both";
  const restored = importGeoJSON(
    JSON.parse(JSON.stringify(exportGeoJSON(network))),
  );
  assert.deepEqual(restored, network);
  delete network.services[0].shape;
  const withoutShape = importGeoJSON(exportGeoJSON(network));
  assert.deepEqual(withoutShape.services[0], network.services[0]);
  network.routes.push({
    ...network.routes[0],
    id: "draft-route",
    shortName: "Draft",
    visible: false,
  });
  network.services.push({
    ...network.services[0],
    id: "draft-service",
    routeId: "draft-route",
    stationIds: [],
    skippedStationIds: [],
    waypoints: {},
    shape: undefined,
  });
  assert.deepEqual(
    importGeoJSON(exportGeoJSON(network)),
    validateNetwork(network),
    "unused routes and empty service drafts survive through native metadata",
  );
  network.services[0].loop = true;
  const exported = exportGeoJSON(network) as {
    features: {
      properties: Record<string, unknown>;
      geometry: { coordinates: unknown[] };
    }[];
  };
  const loopGeometry = exported.features.find(
    (f) => objectServiceId(f.properties.service) === network.services[0].id,
  )!.geometry.coordinates;
  assert.deepEqual(
    loopGeometry[0],
    loopGeometry.at(-1),
    "an implicit loop exports as a closed GIS path",
  );
});

function objectServiceId(value: unknown): string | undefined {
  return value && typeof value === "object" && "id" in value
    ? String(value.id)
    : undefined;
}

test("GeoJSON rejects invalid coordinates and duplicate IDs", () => {
  assert.throws(
    () => importGeoJSON({ type: "Point", coordinates: [181, 0] }),
    /bounds/,
  );
  assert.throws(
    () =>
      importGeoJSON({
        type: "FeatureCollection",
        features: [1, 2].map(() => ({
          type: "Feature",
          id: "same",
          properties: {},
          geometry: { type: "Point", coordinates: [0, 0] },
        })),
      }),
    /Duplicate/,
  );
});

const osmFixture = (disconnected = false) => ({
  elements: [
    {
      type: "relation",
      id: 100,
      tags: {
        type: "route",
        route: "subway",
        ref: "1",
        network: "Fixture",
        name: "A → C",
        colour: "#123456",
      },
      members: [
        { type: "node", ref: 1, role: "stop", lat: 0, lon: 0 },
        { type: "node", ref: 2, role: "stop", lat: 0, lon: 0.01 },
        { type: "node", ref: 3, role: "stop", lat: 0, lon: 0.02 },
        {
          type: "way",
          ref: 20,
          role: "",
          geometry: [
            { lat: 0, lon: 0.01 },
            { lat: 0, lon: 0 },
          ],
        },
        {
          type: "way",
          ref: 21,
          role: "",
          geometry: disconnected
            ? [
                { lat: 5, lon: 5 },
                { lat: 5, lon: 5.01 },
              ]
            : [
                { lat: 0, lon: 0.02 },
                { lat: 0, lon: 0.01 },
              ],
        },
      ],
    },
    ...[1, 2, 3].map((id, i) => ({
      type: "node",
      id,
      lat: 0,
      lon: i * 0.01,
      tags: { name: ["A", "B", "C"][i] },
    })),
  ],
});

test("OSM uses ordered stop roles and reverses/stitches actual way geometry without inventing track gaps", () => {
  const network = networkFromOSM(city, osmFixture());
  assert.deepEqual(network.services[0].stationIds, [
    "osm-node-1",
    "osm-node-2",
    "osm-node-3",
  ]);
  assert.deepEqual(network.services[0].shape, [
    [0, 0],
    [0, 0.01],
    [0, 0.02],
  ]);
  assert.equal(network.services[0].direction, "forward");
  assert.equal(network.sources[0].license, "Open Database License (ODbL)");
  const broken = networkFromOSM(city, osmFixture(true));
  assert.equal(broken.services[0].shape, undefined);
  assert.match(
    broken.description,
    /1 service patterns use station connections/,
  );
  assert.throws(
    () =>
      networkFromOSM(city, { remark: "runtime error: timeout", elements: [] }),
    /did not complete/,
  );
});

test("OSM import falls back to a second endpoint and honors preexisting cancellation", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    if (urls.length === 1) return new Response("busy", { status: 429 });
    return new Response(JSON.stringify(osmFixture()), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const imported: Network = await importOSM(city);
    assert.equal(imported.services.length, 1);
    assert.equal(urls.length, 2);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      importOSM(city, controller.signal),
      (e) => e instanceof DOMException && e.name === "AbortError",
    );
    assert.equal(urls.length, 2, "a cancelled request never starts a fetch");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OSM uses only the configured HTTP endpoint and rejects credentials or non-HTTP protocols", async () => {
  const originalFetch = globalThis.fetch,
    urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    assert.equal(init?.credentials, "omit");
    return new Response(JSON.stringify(osmFixture()));
  };
  try {
    await importOSM(city, undefined, "http://127.0.0.1:8081/api/interpreter");
    assert.deepEqual(urls, ["http://127.0.0.1:8081/api/interpreter"]);
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      return new Response("unavailable", { status: 503 });
    };
    await assert.rejects(
      importOSM(
        city,
        undefined,
        "https://overpass.example.org/api/interpreter",
      ),
      /could not complete/,
    );
    assert.deepEqual(
      urls,
      [
        "http://127.0.0.1:8081/api/interpreter",
        "https://overpass.example.org/api/interpreter",
      ],
      "a configured endpoint never falls back to public servers",
    );
    await assert.rejects(
      importOSM(city, undefined, "file:///private/data"),
      /HTTP or HTTPS/,
    );
    await assert.rejects(
      importOSM(
        city,
        undefined,
        "https://name:secret@example.org/api/interpreter",
      ),
      /cannot contain credentials/,
    );
    await assert.rejects(
      importOSM(city, undefined, "/relative"),
      /absolute HTTP/,
    );
    assert.equal(urls.length, 2, "invalid endpoints never start a request");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
