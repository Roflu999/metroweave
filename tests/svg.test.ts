import { test } from "node:test";
import assert from "node:assert/strict";
import { createSVG } from "../src/svg";
import type { LatLng, Network } from "../src/types";

function fixture(): Network {
  return {
    version: 1,
    id: "test",
    name: 'A <metro> & "friends"',
    city: "",
    country: "",
    description: "",
    center: [0, 0],
    zoom: 12,
    updatedAt: "2026-10-19T00:00:00Z",
    dataStatus: "custom",
    sources: [{ title: "Original source", url: "https://example.com" }],
    stations: [
      { id: "a", name: "A & B", lat: 0, lng: 0 },
      { id: "b", name: "B", lat: 0, lng: 1 },
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
        stationIds: ["a", "b"],
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

test("vector exports escape user text and embed source metadata and route legends", () => {
  const svg = createSVG(fixture());
  assert.ok(svg.startsWith("<svg "));
  assert.ok(svg.endsWith("</svg>"));
  assert.ok(svg.includes("A &lt;metro&gt; &amp; &quot;friends&quot;"));
  assert.ok(svg.includes("A &amp; B"));
  assert.ok(svg.includes("https://example.com"));
  assert.ok(svg.includes("R · Route"));
  assert.ok(!svg.includes("NaN"));
});

test("Mercator poles and coincident stations produce finite geographic SVG coordinates", () => {
  const network = fixture();
  network.stations[0].lat = 90;
  network.stations[1].lat = -90;
  const polar = createSVG(network);
  assert.ok(!/NaN|Infinity/.test(polar));
  network.stations[1] = { ...network.stations[0], id: "b" };
  assert.ok(!/NaN|Infinity/.test(createSVG(network)));
});

test("large valid source shapes export without exceeding JavaScript function argument limits", () => {
  const network = fixture();
  network.services[0].shape = Array.from(
    { length: 150_000 },
    (_, i) => [0, i / 149_999] as LatLng,
  );
  const svg = createSVG(network);
  assert.ok(svg.includes("<polyline"));
  assert.ok(!/NaN|Infinity/.test(svg));
  assert.ok(svg.length > 1_000_000);
});

test("label limits keep every station marker and full station name tooltip", () => {
  const network = fixture();
  network.stations = Array.from({ length: 1502 }, (_, i) => ({
    id: `station-${i}`,
    name: `Station ${i}`,
    lat: i / 10000,
    lng: i / 10000,
  }));
  network.services = [];
  const svg = createSVG(network);
  assert.equal((svg.match(/<circle /g) || []).length, 1502);
  assert.ok(svg.includes("1,500 of 1,502 station labels shown"));
  assert.ok(svg.includes("<title>Station 1501</title>"));
});

test("vector exports respect group visibility and explicit route patterns", () => {
  const network = fixture();
  network.routes[0].pattern = "dash-dot";
  assert.ok(createSVG(network).includes('stroke-dasharray="12 5 2 5"'));
  network.lineGroups = [{ id: "hidden", name: "Hidden", visible: false }];
  network.routes[0].groupId = "hidden";
  const hidden = createSVG(network);
  assert.ok(!hidden.includes('data-service-id="s"'));
  assert.ok(hidden.includes("0 visible lines"));
});

test("unused tracks, passing lanes and non-boarding junctions remain visible in infrastructure exports", () => {
  const network = fixture();
  network.junctions = [
    { id: "j1", name: "Approach <one>", lat: 0.02, lng: 0 },
    { id: "j2", name: "Approach two", lat: 0.02, lng: 1 },
  ];
  network.tracks = [
    {
      id: "unused",
      name: "Unused passing track",
      fromId: "j1",
      toId: "j2",
      geometry: [],
      kind: "passing",
      direction: "both",
    },
  ];
  network.stations.push({
    id: "waypoint",
    name: "Geometry node",
    lat: 0,
    lng: 0.5,
    isWaypoint: true,
  });
  const svg = createSVG(network);
  assert.ok(svg.includes('data-track-id="unused"'));
  assert.ok(svg.includes('data-junction-id="j1"'));
  assert.ok(svg.includes("Approach &lt;one&gt;"));
  assert.ok(svg.includes("Track junction; no passenger boarding"));
  assert.ok(svg.includes("2 passenger stations, 1 geometry waypoints"));
  assert.ok(svg.includes("Geometry waypoint; no passenger boarding"));
  assert.equal((svg.match(/<circle /g) || []).length, 2);
  const without = createSVG(network, { showInfrastructure: false });
  assert.ok(!without.includes('data-track-id="unused"'));
  assert.ok(!without.includes('data-junction-id="j1"'));
});
