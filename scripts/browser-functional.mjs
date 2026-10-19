/** Isolated functional regression. Node 24+, npm install, and Playwright Chromium are required.
 * Optional: BASE_URL, CHROMIUM_EXECUTABLE, QA_OUTPUT_DIR. Never uses a personal browser profile.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { validateNetwork } from "../src/engine.ts";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:5173";
const output = process.env.QA_OUTPUT_DIR
  ? path.resolve(process.env.QA_OUTPUT_DIR)
  : await mkdtemp(path.join(tmpdir(), "metroweave-functional-"));
await mkdir(output, { recursive: true });
const STORE = "metroweave.autosave.v1";
const report = {
  startedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  checks: [],
  pageErrors: [],
  success: false,
};
let browser,
  context,
  page,
  stage = "launch";
const tile = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/hoAAAAASUVORK5CYII=",
  "base64",
);
async function makeContext() {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  // External street tiles are outside this functional test; deterministic local UI checks need no network.
  await ctx.route("https://tile.openstreetmap.org/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: tile }),
  );
  return ctx;
}
function captureErrors(p) {
  p.on("pageerror", (e) => report.pageErrors.push(e.message));
}
async function state(p = page) {
  return p.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, STORE);
}
async function until(predicate, message, p = page) {
  let snapshot;
  await expect
    .poll(
      async () => {
        snapshot = await state(p);
        return snapshot && predicate(snapshot);
      },
      { timeout: 12000, message },
    )
    .toBe(true);
  return snapshot;
}
async function check(name, fn) {
  stage = name;
  const start = Date.now();
  console.log(`RUN  ${name}`);
  await fn();
  report.checks.push({
    name,
    status: "pass",
    milliseconds: Date.now() - start,
  });
  console.log(`PASS ${name}`);
}
async function mapClick(x, y) {
  const map = page.getByLabel("Interactive transit map");
  const box = await map.boundingBox();
  assert.ok(box, "map has a layout box");
  await map.click({ position: { x: box.width * x, y: box.height * y } });
}
// Use title selectors because Leaflet marker labels are map tooltips rather than form labels.
async function clickStation(name) {
  await page
    .locator(`.station-marker-container[title=${JSON.stringify(name)}]`)
    .click();
}
async function selectService(id) {
  await page
    .getByRole("combobox", { name: /^Service pattern/ })
    .selectOption(id);
}
async function importFile(name, body) {
  await page
    .getByRole("button", { name: "Import a network", exact: true })
    .click();
  await page
    .getByLabel("Import project file", { exact: true })
    .setInputFiles({
      name,
      mimeType: name.endsWith(".zip") ? "application/zip" : "application/json",
      buffer: Buffer.isBuffer(body) ? body : Buffer.from(body),
    });
}
async function downloadProject() {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: /^Project file/ }).click();
  const download = await pending;
  const file = path.join(output, download.suggestedFilename());
  await download.saveAs(file);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  return {
    file,
    network: validateNetwork(JSON.parse(await readFile(file, "utf8"))),
  };
}
function gtfsFixture() {
  const files = {
    "agency.txt":
      "agency_id,agency_name,agency_url,agency_timezone\na,QA Feed,https://example.org,Europe/London\n",
    "stops.txt":
      "stop_id,stop_name,stop_lat,stop_lon\na,Feed Alpha,51.50,-0.14\nb,Feed Beta,51.50,-0.12\nc,Feed Gamma,51.50,-0.10\n",
    "routes.txt":
      "route_id,route_short_name,route_long_name,route_type,route_color\nr,U1,QA Underground,1,346B8A\n",
    "trips.txt":
      "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\nr,all,local,Local to Gamma,0,main\nr,all,express,Express to Gamma,0,main\n",
    "stop_times.txt":
      "trip_id,stop_id,stop_sequence\nlocal,a,1\nlocal,b,2\nlocal,c,3\nexpress,a,1\nexpress,c,2\n",
    "shapes.txt":
      "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nmain,51.50,-0.14,1\nmain,51.50,-0.12,2\nmain,51.50,-0.10,3\n",
  };
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([name, value]) => [name, strToU8(value)]),
      ),
    ),
  );
}

try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE }
      : {}),
  });
  context = await makeContext();
  page = await context.newPage();
  captureErrors(page);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.getByLabel("Interactive transit map").waitFor();
  let mainId, branchId, expressId, edited;
  await check(
    "create an empty project and first line through the UI",
    async () => {
      await page.getByRole("button", { name: "My maps", exact: true }).click();
      await page.getByRole("button", { name: "New map", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("Project name", { exact: true })
        .fill("Functional QA network");
      await dialog.getByLabel("City", { exact: true }).fill("QA London");
      await dialog.getByLabel("Country", { exact: true }).fill("Test");
      await dialog
        .getByRole("button", { name: "Create empty map", exact: true })
        .click();
      await until(
        (n) =>
          n.name === "Functional QA network" &&
          n.stations.length === 0 &&
          n.routes.length === 0,
        "blank project autosaves",
      );
      await page.getByRole("button", { name: "Add line", exact: true }).click();
      await page
        .getByRole("dialog")
        .getByLabel("Line name", { exact: true })
        .fill("QA Main");
      await page
        .getByRole("dialog")
        .getByLabel("Badge", { exact: true })
        .fill("Q");
      await page
        .getByRole("button", {
          name: "Create line & start drawing",
          exact: true,
        })
        .click();
      for (const [x, y] of [
        [0.28, 0.44],
        [0.45, 0.44],
        [0.63, 0.44],
        [0.78, 0.62],
      ])
        await mapClick(x, y);
      const n = await until(
        (n) => n.stations.length === 4 && n.services[0].stationIds.length === 4,
        "drawing adds four ordered stations",
      );
      mainId = n.services[0].id;
      assert.deepEqual(
        n.services[0].stationIds,
        n.stations.map((s) => s.id),
      );
      validateNetwork(n);
    },
  );
  await check("reuse existing stations on another line", async () => {
    await page.getByRole("button", { name: "Add line", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Line name", { exact: true })
      .fill("QA Connector");
    await page
      .getByRole("dialog")
      .getByLabel("Badge", { exact: true })
      .fill("C");
    await page
      .getByRole("button", { name: "Create line & start drawing", exact: true })
      .click();
    await clickStation("Station 2");
    await clickStation("Station 4");
    const n = await until(
      (n) => n.routes.length === 2 && n.services[1].stationIds.length === 2,
      "existing stations form the connector",
    );
    assert.equal(n.stations.length, 4);
    assert.deepEqual(n.services[1].stationIds, [
      n.stations[1].id,
      n.stations[3].id,
    ]);
    await page
      .locator(".line-card")
      .filter({ has: page.getByText("QA Main", { exact: true }) })
      .locator(".line-main")
      .click();
  });
  await check("duplicate an express and toggle its stops", async () => {
    await page.getByRole("button", { name: "Express", exact: true }).click();
    let n = await until(
      (n) =>
        n.services.length === 3 && n.services.some((s) => s.kind === "express"),
      "express pattern exists",
    );
    const express = n.services.find((s) => s.kind === "express");
    expressId = express.id;
    assert.deepEqual(
      express.stationIds,
      n.services.find((s) => s.id === mainId).stationIds,
    );
    assert.equal(express.skippedStationIds.length, 2);
    await page
      .getByRole("button", { name: "Make stop at Station 2", exact: true })
      .click();
    n = await until(
      (n) =>
        n.services.find((s) => s.id === expressId).skippedStationIds.length ===
        1,
      "stop toggle updates express boarding",
    );
    assert.equal(
      n.services.find((s) => s.id === expressId).skippedStationIds[0],
      n.stations[2].id,
    );
  });
  await check(
    "branch an existing trunk, extend it and close a loop",
    async () => {
      await selectService(mainId);
      await page.getByRole("button", { name: "Branch", exact: true }).click();
      let n = await until(
        (n) => n.services.length === 4,
        "branch pattern was duplicated",
      );
      branchId = n.services.at(-1).id;
      assert.deepEqual(
        n.services.at(-1).stationIds,
        n.services[0].stationIds.slice(0, 2),
      );
      await mapClick(0.62, 0.72);
      await until(
        (n) =>
          n.stations.length === 5 &&
          n.services.find((s) => s.id === branchId).stationIds.length === 3,
        "branch has its own extension",
      );
      await page.getByRole("button", { name: "Loop", exact: true }).click();
      n = await until(
        (n) => n.services.find((s) => s.id === branchId).loop,
        "loop property autosaves",
      );
      assert.equal(n.services.find((s) => s.id === mainId).loop, false);
    },
  );
  await check("insert and drag a custom geometry point", async () => {
    await selectService(mainId);
    await page
      .getByRole("button", { name: "Edit geometry (B)", exact: true })
      .click();
    const selectedPath = page
      .locator(
        '.leaflet-overlay-pane path.leaflet-interactive[stroke="#36866b"]',
      )
      .last();
    const point = await selectedPath.evaluate((el) => {
      const p = el.getPointAtLength(el.getTotalLength() * 0.18),
        m = el.getScreenCTM();
      return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
    });
    await page.mouse.click(point.x, point.y);
    let n = await until(
      (n) =>
        Object.values(n.services.find((s) => s.id === mainId).waypoints).flat()
          .length === 1,
      "path click adds geometry",
    );
    const before = JSON.stringify(
      n.services.find((s) => s.id === mainId).waypoints,
    );
    const square = await page.locator(".bend-marker").first().boundingBox();
    assert.ok(square);
    await page.mouse.move(
      square.x + square.width / 2,
      square.y + square.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(square.x + 30, square.y + 30, { steps: 8 });
    await page.mouse.up();
    n = await until(
      (n) =>
        JSON.stringify(n.services.find((s) => s.id === mainId).waypoints) !==
        before,
      "dragged bend saves its new coordinates",
    );
    validateNetwork(n);
  });
  await check(
    "reorder and remove service stops with undo and redo",
    async () => {
      const original = (await state()).services.find(
        (s) => s.id === mainId,
      ).stationIds;
      await page
        .getByRole("button", { name: "Move Station 2 up", exact: true })
        .click();
      let n = await until(
        (n) =>
          n.services.find((s) => s.id === mainId).stationIds[0] === original[1],
        "stop reordering changes first station",
      );
      assert.deepEqual(
        n.services.find((s) => s.id === mainId).waypoints,
        {},
        "reordering invalidates old geometry",
      );
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await until(
        (n) =>
          n.services.find((s) => s.id === mainId).stationIds[0] ===
            original[0] &&
          Object.keys(n.services.find((s) => s.id === mainId).waypoints)
            .length === 1,
        "undo restores order and geometry",
      );
      await page.getByRole("button", { name: "Redo", exact: true }).click();
      await until(
        (n) =>
          n.services.find((s) => s.id === mainId).stationIds[0] === original[1],
        "redo reapplies reordering",
      );
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await until(
        (n) =>
          n.services.find((s) => s.id === mainId).stationIds[0] === original[0],
        "undo returns to normal order",
      );
      await page
        .getByRole("button", {
          name: "Remove Station 2 from service",
          exact: true,
        })
        .click();
      n = await until(
        (n) => n.services.find((s) => s.id === mainId).stationIds.length === 3,
        "remove stop affects only its service",
      );
      assert.equal(n.stations.length, 5);
      assert.ok(
        n.services
          .find((s) => s.id === expressId)
          .stationIds.includes(original[1]),
      );
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await until(
        (n) => n.services.find((s) => s.id === mainId).stationIds.length === 4,
        "undo restores removed stop",
      );
    },
  );
  await check(
    "delete a station globally, then undo and redo safely",
    async () => {
      await page
        .getByRole("button", { name: "Delete station (E)", exact: true })
        .click();
      await clickStation("Station 5");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Continue", exact: true })
        .click();
      let n = await until(
        (n) => n.stations.length === 4,
        "global delete removes the station",
      );
      assert.equal(
        n.services.find((s) => s.id === branchId).stationIds.length,
        2,
      );
      validateNetwork(n);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await until(
        (n) => n.stations.length === 5,
        "undo restores global station deletion",
      );
      await page.getByRole("button", { name: "Redo", exact: true }).click();
      await until(
        (n) => n.stations.length === 4,
        "redo removes the station again",
      );
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      edited = await until(
        (n) => n.stations.length === 5,
        "restore complete edited map",
      );
    },
  );
  await check(
    "autosave survives reload and project JSON validates in Node",
    async () => {
      await page.reload({ waitUntil: "networkidle" });
      const restored = await until(
        (n) => n.id === edited.id && n.stations.length === 5,
        "saved map restores",
      );
      assert.deepEqual(restored, edited);
      const exported = await downloadProject();
      assert.deepEqual(exported.network, edited);
    },
  );
  await check(
    "journey planner finds routes through the edited network",
    async () => {
      await page.getByRole("button", { name: "Journey", exact: true }).click();
      await page
        .getByRole("combobox", { name: /^From/ })
        .selectOption(edited.stations[0].id);
      await page
        .getByRole("combobox", { name: /^To/ })
        .selectOption(edited.stations[3].id);
      await expect(page.locator(".journey-result")).toBeVisible();
      await expect(page.locator(".journey-result")).toContainText(
        "No live timetable",
      );
      await page
        .getByRole("combobox", { name: /^To/ })
        .selectOption(edited.stations[4].id);
      await expect(page.locator(".journey-result")).toContainText("Branch");
      await page
        .getByRole("button", { name: "Inspector", exact: true })
        .click();
    },
  );
  await check("GeoJSON imports through the real file input", async () => {
    const stations = [
      ["g-a", "Geo Alpha", -0.14],
      ["g-b", "Geo Beta", -0.12],
      ["g-c", "Geo Gamma", -0.1],
    ];
    const geo = {
      type: "FeatureCollection",
      properties: { name: "QA GeoJSON" },
      features: [
        ...stations.map(([id, name, lng]) => ({
          type: "Feature",
          id,
          properties: { name },
          geometry: { type: "Point", coordinates: [lng, 51.5] },
        })),
        {
          type: "Feature",
          properties: {
            routeId: "geo-r",
            name: "Geo Route",
            service: {
              name: "Geo express",
              kind: "express",
              stationIds: stations.map((s) => s[0]),
              skippedStationIds: ["g-b"],
              direction: "both",
            },
          },
          geometry: {
            type: "LineString",
            coordinates: stations.map((s) => [s[2], 51.5]),
          },
        },
      ],
    };
    await importFile("qa.geojson", JSON.stringify(geo));
    const n = await until(
      (n) => n.name === "QA GeoJSON" && n.stations.length === 3,
      "GeoJSON replaces the current workspace",
    );
    assert.equal(n.services[0].kind, "express");
    assert.deepEqual(n.services[0].skippedStationIds, ["g-b"]);
    validateNetwork(n);
  });
  await check(
    "GTFS ZIP imports ordered local and express patterns",
    async () => {
      await importFile("qa-gtfs.zip", gtfsFixture());
      const n = await until(
        (n) => n.dataStatus === "gtfs" && n.services.length === 2,
        "GTFS feed imports in the browser",
      );
      assert.equal(n.stations.length, 3);
      assert.equal(n.routes.length, 1);
      const express = n.services.find((s) => s.kind === "express");
      assert.equal(express.skippedStationIds.length, 1);
      await selectService(express.id);
      await expect(
        page.getByRole("button", {
          name: "Make stop at Feed Beta",
          exact: true,
        }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Journey", exact: true }).click();
      await page
        .getByRole("combobox", { name: /^From/ })
        .selectOption(n.stations[0].id);
      await page
        .getByRole("combobox", { name: /^To/ })
        .selectOption(n.stations[2].id);
      await expect(page.locator(".journey-result")).toBeVisible();
      validateNetwork(n);
    },
  );
  await check(
    "project JSON restores and an edited share link survives reload",
    async () => {
      await importFile("edited-network.json", JSON.stringify(edited));
      await until(
        (n) => n.id === edited.id && n.stations.length === 5,
        "project JSON restores edited network",
      );
      await page.bringToFront();
      await page
        .getByRole("button", { name: "Share map", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText(
        "Self-contained map link copied",
      );
      const url = await page.evaluate(() => navigator.clipboard.readText());
      assert.ok(url.includes("#map="));
      const sharedContext = await makeContext();
      try {
        const shared = await sharedContext.newPage();
        captureErrors(shared);
        await shared.goto(url, { waitUntil: "networkidle" });
        assert.deepEqual(
          await until(
            (n) => n.id === edited.id,
            "shared map opens in an empty browser context",
            shared,
          ),
          edited,
        );
        assert.equal(
          new URL(shared.url()).hash,
          "",
          "consumed share hash is removed so it cannot overwrite edits",
        );
        await shared.locator(".project-title").click();
        await shared
          .getByRole("dialog")
          .getByLabel("Project name", { exact: true })
          .fill("Shared map after editing");
        await shared
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
        await until(
          (n) => n.name === "Shared map after editing",
          "shared map edits autosave",
          shared,
        );
        await shared.reload({ waitUntil: "networkidle" });
        const persisted = await until(
          (n) => n.name === "Shared map after editing",
          "reload keeps edits instead of resetting to the original share",
          shared,
        );
        assert.equal(persisted.stations.length, 5);
        validateNetwork(persisted);
        await shared.screenshot({
          path: path.join(output, "functional-final.png"),
          fullPage: true,
        });
      } finally {
        await sharedContext.close();
      }
      assert.equal(
        (await state()).name,
        edited.name,
        "isolated shared context does not overwrite original storage",
      );
    },
  );
  assert.deepEqual(report.pageErrors, [], "no uncaught browser errors");
  report.success = true;
} catch (error) {
  report.checks.push({
    name: stage,
    status: "fail",
    error: error.stack || String(error),
  });
  console.error(`FAIL ${stage}\n${error.stack || error}`);
  if (page)
    await page
      .screenshot({
        path: path.join(output, "functional-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(output, "functional-report.json"),
    JSON.stringify(report, null, 2),
  );
  await browser?.close();
  console.log(
    `Functional report: ${path.join(output, "functional-report.json")}`,
  );
}
