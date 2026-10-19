/** Rebuild Glasgow's checked stop topology; no surveyed track/timetable data. */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const official = "https://www.spt.co.uk/travel-with-spt/subway/maps-stations/";
// Clockwise station order published in the SPT map's accessible image text.
const outer = [
  "Buchanan Street",
  "St Enoch",
  "Bridge Street",
  "West Street",
  "Shields Road",
  "Kinning Park",
  "Cessnock",
  "Ibrox",
  "Govan",
  "Partick",
  "Kelvinhall",
  "Hillhead",
  "Kelvinbridge",
  "St George's Cross",
  "Cowcaddens",
];
const articles = outer.map((name) =>
  name === "Partick" ? "Partick station" : `${name} subway station`,
);
const headers = {
  "User-Agent":
    "MetroWeave/1.0 (educational transit mapping with source attribution)",
};
const query = new URLSearchParams({
  action: "query",
  format: "json",
  prop: "coordinates|revisions",
  titles: articles.join("|"),
  colimit: "max",
  rvprop: "ids|timestamp",
  redirects: "1",
});
const response = await fetch(`https://en.wikipedia.org/w/api.php?${query}`, {
  headers,
  signal: AbortSignal.timeout(30000),
});
if (!response.ok) throw new Error(`Wikipedia returned ${response.status}`);
const payload = await response.json();
const pages = new Map(
  Object.values(payload.query.pages).map((page) => [page.title, page]),
);
const aliases = new Map(
  [...(payload.query.normalized ?? []), ...(payload.query.redirects ?? [])].map(
    (x) => [x.from, x.to],
  ),
);
const fetchedAt = new Date().toISOString(),
  date = fetchedAt.slice(0, 10);
const id = (name) =>
  `glasgow-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
const stationSources = [];
const stations = outer.map((name, index) => {
  let canonical = articles[index];
  for (let i = 0; i < 5 && aliases.has(canonical); i++)
    canonical = aliases.get(canonical);
  const page = pages.get(canonical),
    coord = page?.coordinates?.[0],
    revision = page?.revisions?.[0];
  if (!coord || coord.globe !== "earth")
    throw new Error(
      `No verified primary station coordinate: ${name} (${canonical})`,
    );
  if (!revision?.revid) throw new Error(`No source revision: ${canonical}`);
  const sourceUrl = `https://en.wikipedia.org/w/index.php?${new URLSearchParams({ title: canonical.replaceAll(" ", "_"), oldid: String(revision.revid) })}`;
  stationSources.push({
    title: `${canonical} — coordinate reference`,
    url: sourceUrl,
    license: "CC BY-SA 4.0",
    accessed: date,
  });
  return { id: id(name), name, lat: coord.lat, lng: coord.lon };
});
const inner = [outer[0], ...outer.slice(1).reverse()];
const makeService = (routeId, name, names) => ({
  id: `${routeId}-service`,
  routeId,
  name,
  kind: "local",
  stationIds: names.map(id),
  skippedStationIds: [],
  waypoints: {},
  loop: true,
  direction: "forward",
  headway: 8,
  speed: 36,
  dwell: 30,
});
const network = {
  version: 1,
  id: "glasgow-verified-topology",
  name: "Glasgow Subway · real station topology",
  city: "Glasgow",
  country: "United Kingdom",
  dataStatus: "imported",
  description: `Station topology verified against SPT's published map on ${date}: all 15 stations, clockwise Outer Circle and anticlockwise Inner Circle. Coordinates come from individually linked Wikipedia station articles. Straight connections are not surveyed track geometry. No operating times were verified: frequency, speed and dwell are editable planning assumptions. This reference does not report live service conditions.`,
  center: [55.8608, -4.2854],
  zoom: 14,
  updatedAt: fetchedAt,
  stations,
  routes: [
    {
      id: "glasgow-outer",
      name: "Outer Circle · clockwise",
      shortName: "O",
      color: "#f47b20",
      mode: "metro",
      visible: true,
    },
    {
      id: "glasgow-inner",
      name: "Inner Circle · anticlockwise",
      shortName: "I",
      color: "#808c9e",
      mode: "metro",
      visible: true,
    },
  ],
  services: [
    makeService("glasgow-outer", "Outer Circle · clockwise", outer),
    makeService("glasgow-inner", "Inner Circle · anticlockwise", inner),
  ],
  sources: [
    {
      title: "SPT Subway maps & stations — both official stopping sequences",
      url: official,
      accessed: date,
    },
    ...stationSources,
  ],
};
if (
  network.stations.length !== 15 ||
  new Set(network.stations.map((s) => s.id)).size !== 15
)
  throw new Error("Expected 15 unique stations.");
for (const service of network.services) {
  if (
    !service.loop ||
    service.direction !== "forward" ||
    service.stationIds.length !== 15 ||
    new Set(service.stationIds).size !== 15
  )
    throw new Error("Invalid directional loop topology.");
  if (service.stationIds.some((id) => !stations.some((s) => s.id === id)))
    throw new Error("Unknown station in service.");
}
if (
  network.services[0].stationIds.slice(1).reverse().join("|") !==
  network.services[1].stationIds.slice(1).join("|")
)
  throw new Error("The circles must run in opposite order.");
await writeFile(
  path.join(root, "public/data/glasgow-reference.json"),
  JSON.stringify(network, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      stations: stations.length,
      services: network.services.length,
      coordinateSources: stationSources.length,
      loops: network.services.map((s) => ({
        name: s.name,
        stations: s.stationIds.map(
          (id) => stations.find((st) => st.id === id).name,
        ),
        closesTo: stations.find((st) => st.id === s.stationIds[0]).name,
      })),
      fetchedAt,
    },
    null,
    2,
  ),
);
