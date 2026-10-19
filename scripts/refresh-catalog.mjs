/**
 * Rebuild the discoverable world-system directory, not track or timetable data.
 * Run: node scripts/refresh-catalog.mjs
 * Uses only Node's standard library and the two Wikimedia source endpoints.
 * Wikipedia data is CC BY-SA 4.0; preserve the metadata and source links.
 */
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = "https://en.wikipedia.org/wiki/List_of_metro_systems";
const headers = {
  "User-Agent":
    "MetroWeave/1.0 (open-source educational transit design; Wikipedia source attribution retained)",
};
const decode = (text) =>
  text.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ndash|mdash);/gi,
    (_, entity) => {
      if (entity[0] === "#")
        return String.fromCodePoint(
          entity[1].toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10),
        );
      return {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " ",
        ndash: "–",
        mdash: "—",
      }[entity.toLowerCase()];
    },
  );
const strip = (html) =>
  decode(
    html
      .replace(/<(sup|style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
const attr = (html, key) => {
  const match = html.match(
    new RegExp(`\\b${key}=(?:"([^"]*)"|'([^']*)')`, "i"),
  );
  return decode(match?.[1] ?? match?.[2] ?? "");
};
async function get(url) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok)
    throw new Error(`Source request returned ${response.status}: ${url}`);
  return response.text();
}

const cached = process.argv.indexOf("--from-html");
const html =
  cached >= 0
    ? await readFile(path.resolve(process.argv[cached + 1]), "utf8")
    : await get(source);
const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(
  (m) => m[1],
);
const main = tables.find(
  (table) =>
    (table.match(/<tr\b/gi)?.length ?? 0) > 200 &&
    strip(table.slice(0, table.indexOf("</tr>"))).includes("Name"),
);
if (!main)
  throw new Error(
    "Operating-system table was not found. Review source structure before refreshing.",
  );
const spans = new Map();
const parsed = [];
for (const [, rowHtml] of main.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
  let column = 0;
  const row = [];
  const appendSpans = () => {
    while (spans.has(column)) {
      const item = spans.get(column);
      row.push(item.cell);
      if (--item.remaining === 0) spans.delete(column);
      column++;
    }
  };
  for (const [, attrs, content] of rowHtml.matchAll(
    /<(?:td|th)\b([^>]*)>([\s\S]*?)<\/(?:td|th)>/gi,
  )) {
    appendSpans();
    const cell = {
      text: strip(content),
      links: [
        ...content
          .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, "")
          .matchAll(/<a\b([^>]+)>/gi),
      ]
        .map((m) => attr(m[1], "href"))
        .filter(
          (h) =>
            /^(?:https:\/\/en\.wikipedia\.org)?\/wiki\//.test(h) &&
            !h.includes("/wiki/File:"),
        ),
    };
    const colspan = Number(attr(attrs, "colspan") || 1),
      rowspan = Number(attr(attrs, "rowspan") || 1);
    for (let i = 0; i < colspan; i++) {
      row.push(cell);
      if (rowspan > 1) spans.set(column, { cell, remaining: rowspan - 1 });
      column++;
    }
  }
  appendSpans();
  if (row.length >= 3 && row[0].links.length && row[1].links.length)
    parsed.push({
      name: row[0].text,
      city: row[1].text,
      country: row[2].text,
      url: new URL(row[0].links[0], source).href,
      cityUrl: new URL(row[1].links[0], source).href,
    });
}
if (parsed.length < 200)
  throw new Error(
    `Only ${parsed.length} source rows found; refusing to replace catalog.`,
  );

const title = (url) =>
  decodeURIComponent(new URL(url).pathname.replace("/wiki/", "")).replaceAll(
    "_",
    " ",
  );
const centers = new Map();
const coordinateSources = new Map();
async function coordinates(titles) {
  for (let offset = 0; offset < titles.length; offset += 50) {
    const batch = titles.slice(offset, offset + 50);
    const query = new URLSearchParams({
      action: "query",
      format: "json",
      prop: "coordinates|pageprops",
      ppprop: "wikibase_item",
      titles: batch.join("|"),
      colimit: "max",
      redirects: "1",
    });
    const payload = JSON.parse(
      await get(`https://en.wikipedia.org/w/api.php?${query}`),
    );
    if (payload.error) throw new Error(payload.error.info);
    const aliases = new Map(
      [
        ...(payload.query.normalized ?? []),
        ...(payload.query.redirects ?? []),
      ].map((x) => [x.from, x.to]),
    );
    const pages = Object.values(payload.query.pages);
    const pageCoords = new Map(
      pages
        .filter((p) => p.coordinates?.[0])
        .map((p) => [p.title, p.coordinates[0]]),
    );
    const wikiSources = new Map(
      pages
        .filter((p) => p.coordinates?.[0])
        .map((p) => [
          p.title,
          `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replaceAll(" ", "_"))}`,
        ]),
    );
    const fallback = pages.filter(
      (p) => !p.coordinates?.[0] && p.pageprops?.wikibase_item,
    );
    if (fallback.length) {
      const wikidata = new URLSearchParams({
        action: "wbgetentities",
        format: "json",
        ids: fallback.map((p) => p.pageprops.wikibase_item).join("|"),
        props: "claims",
      });
      const entities = JSON.parse(
        await get(`https://www.wikidata.org/w/api.php?${wikidata}`),
      ).entities;
      for (const page of fallback) {
        const qid = page.pageprops.wikibase_item;
        const claims = entities[qid]?.claims?.P625 ?? [];
        const claim =
          claims.find((c) => c.rank === "preferred" && c.mainsnak?.datavalue) ??
          claims.find((c) => c.rank !== "deprecated" && c.mainsnak?.datavalue);
        const c = claim?.mainsnak.datavalue.value;
        if (c && c.globe === "http://www.wikidata.org/entity/Q2") {
          pageCoords.set(page.title, {
            lat: c.latitude,
            lon: c.longitude,
            globe: "earth",
          });
          wikiSources.set(page.title, `https://www.wikidata.org/wiki/${qid}`);
        }
      }
    }
    for (const original of batch) {
      let canonical = original;
      for (let i = 0; i < 5 && aliases.has(canonical); i++)
        canonical = aliases.get(canonical);
      const c = pageCoords.get(canonical);
      if (c && c.globe === "earth") {
        centers.set(original, [c.lat, c.lon]);
        coordinateSources.set(original, wikiSources.get(canonical));
      }
    }
    console.log(
      `City coordinates: ${Math.min(offset + 50, titles.length)}/${titles.length}`,
    );
  }
}
await coordinates([...new Set(parsed.map((row) => title(row.cityUrl)))]);
const missing = parsed.filter((row) => !centers.has(title(row.cityUrl)));
if (missing.length) {
  await coordinates([...new Set(missing.map((row) => title(row.url)))]);
  for (const row of missing)
    if (centers.has(title(row.url))) {
      centers.set(title(row.cityUrl), centers.get(title(row.url)));
      coordinateSources.set(
        title(row.cityUrl),
        coordinateSources.get(title(row.url)),
      );
    }
}
const unresolved = parsed.filter((row) => !centers.has(title(row.cityUrl)));
if (unresolved.length)
  throw new Error(
    `Coordinates need review: ${unresolved.map((r) => r.city).join(", ")}`,
  );

const regionCountries = {
  Africa: ["Algeria", "Egypt", "Nigeria"],
  Europe: [
    "Austria",
    "Belarus",
    "Belgium",
    "Bulgaria",
    "Czech Republic",
    "Denmark",
    "Finland",
    "France",
    "Germany",
    "Greece",
    "Hungary",
    "Italy",
    "Netherlands",
    "Norway",
    "Poland",
    "Portugal",
    "Romania",
    "Russia",
    "Spain",
    "Sweden",
    "Switzerland",
    "Ukraine",
    "United Kingdom",
  ],
  Asia: [
    "Armenia",
    "Azerbaijan",
    "Bangladesh",
    "China",
    "Georgia",
    "India",
    "Indonesia",
    "Iran",
    "Japan",
    "Kazakhstan",
    "Malaysia",
    "North Korea",
    "Pakistan",
    "Philippines",
    "Qatar",
    "Saudi Arabia",
    "Singapore",
    "South Korea",
    "Taiwan",
    "Thailand",
    "Turkey",
    "United Arab Emirates",
    "Uzbekistan",
    "Vietnam",
  ],
  "North America": [
    "Canada",
    "Dominican Republic",
    "Mexico",
    "Panama",
    "United States",
  ],
  "South America": [
    "Argentina",
    "Brazil",
    "Chile",
    "Colombia",
    "Ecuador",
    "Peru",
    "Venezuela",
  ],
  Oceania: ["Australia"],
};
const systems = parsed.map((row) => {
  const [lat, lng] = centers.get(title(row.cityUrl));
  const id = title(row.url)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const region = Object.entries(regionCountries).find(([, countries]) =>
    countries.includes(row.country),
  )?.[0];
  if (!region) throw new Error(`Add regional grouping for ${row.country}.`);
  return {
    id,
    city: row.city,
    country: row.country,
    name: row.name,
    lat,
    lng,
    url: row.url,
    region,
    coordinateSource: coordinateSources.get(title(row.cityUrl)),
  };
});
if (new Set(systems.map((s) => s.id)).size !== systems.length)
  throw new Error("Duplicate source identifiers need review.");
const snapshotDate = new Date().toISOString().slice(0, 10);
const revision =
  html.match(/"wgRevisionId":(\d+)/)?.[1] ??
  html.match(/property="mw:revisionId"[^>]*content="(\d+)"/)?.[1];
const catalog = {
  snapshotDate,
  source,
  sourceRevision: revision ?? null,
  sourceSha256: createHash("sha256").update(html).digest("hex"),
  license: "CC BY-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  scope:
    "Rows in the operating systems table of Wikipedia List of metro systems. Source inclusion criteria apply; this is a discoverable directory, not verified complete world track or timetable data.",
  coordinateNote:
    "Coordinates are primary coordinates of the linked city/area article from the Wikipedia API, with linked Wikidata P625 coordinates as fallback, used only as map search centers. Each row retains coordinateSource. They are not station coordinates or system bounds. Region is a broad browsing group; transcontinental countries use one group.",
  count: systems.length,
  cityCount: new Set(systems.map((s) => `${s.city}|${s.country}`)).size,
  countryCount: new Set(systems.map((s) => s.country)).size,
  systems,
};
await mkdir(path.join(root, "public/data"), { recursive: true });
await writeFile(
  path.join(root, "public/data/catalog.json"),
  JSON.stringify(catalog, null, 2) + "\n",
  "utf8",
);
console.log(
  `Saved ${catalog.count} system entries, ${catalog.cityCount} named areas, ${catalog.countryCount} countries (${snapshotDate}).`,
);
