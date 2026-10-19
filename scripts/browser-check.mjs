/** Visual smoke test. Set BASE_URL, CHROMIUM_EXECUTABLE, QA_OUTPUT_DIR as needed. */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const output = path.resolve(process.env.QA_OUTPUT_DIR || ".local/screenshots");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  headless: true,
});
try {
  const context = await browser.newContext({
    viewport: { width: 1536, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.BASE_URL || "http://127.0.0.1:5173", {
    waitUntil: "networkidle",
  });
  await page.screenshot({
    path: path.join(output, "studio-desktop.png"),
    fullPage: true,
  });
  console.log(
    JSON.stringify({
      title: await page.title(),
      stations: await page.locator(".station-marker-container").count(),
      routes: await page.locator(".line-card").count(),
      mapSize: await page.locator(".map-canvas").boundingBox(),
      errors,
    }),
  );
  const overlaps = await page
    .locator(".station-label")
    .evaluateAll((labels) => {
      const rects = labels
        .filter((e) => getComputedStyle(e).visibility !== "hidden")
        .map((e) => e.getBoundingClientRect());
      let count = 0;
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i],
            b = rects[j];
          if (
            a.left < b.right &&
            a.right > b.left &&
            a.top < b.bottom &&
            a.bottom > b.top
          )
            count++;
        }
      return { visible: rects.length, overlaps: count };
    });
  console.log("Station labels", overlaps);
  await page
    .locator(".main-nav button")
    .filter({ hasText: "World atlas" })
    .click();
  await page.getByRole("textbox", { name: "Search world atlas" }).fill("Tokyo");
  await page.locator(".city-card").first().waitFor({ timeout: 15000 });
  console.log("Tokyo cards", await page.locator(".city-card").count());
  await page.screenshot({ path: path.join(output, "atlas-desktop.png") });
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Play train preview" }).click();
  await page.waitForTimeout(500);
  console.log(
    "Animated train paths",
    await page.locator(".leaflet-overlay-pane path").count(),
  );
  await page.getByRole("button", { name: "Pause train preview" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(output, "studio-mobile.png"),
    fullPage: true,
  });
  const dimensions = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: innerWidth,
  }));
  console.log("Mobile dimensions", dimensions, "errors", errors);
  if (
    errors.length ||
    dimensions.scroll > dimensions.width ||
    overlaps.overlaps
  )
    throw Error("Visual smoke verification failed");
} finally {
  await browser.close();
}
