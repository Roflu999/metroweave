# Verification — 19 October 2026

| Check                                                                    | Result                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Model, editor, import/export and workspace regression suite (`npm test`) | **85 passed, 0 failed**                                       |
| Local map server (`npm run test:server`)                                 | **2 passed, 0 failed**                                        |
| TypeScript and production bundle (`npm run build`)                       | **Passed**                                                    |
| Original browser workflows                                               | **12 of 12 passed; no uncaught page errors**                  |
| Advanced editor and complete workspace workflows                         | **16 of 16 passed; no uncaught page errors**                  |
| Offline browser workflows (`npm run test:offline`)                       | **7 of 7 passed; no uncaught page errors**                    |
| Desktop / mobile visual review                                           | **1536 × 1000 and 390 × 844; no horizontal overflow**         |
| Station-label collision audit                                            | **34 visible labels, 0 overlaps in the audited view**         |
| Directory source-to-output comparison                                    | **234 source rows, 234 delivered entries; 0 missing / extra** |

The upgraded production app was tested at `http://127.0.0.1:5173`. The original workflows cover creation, station editing, branches/loops, stop ordering, undo/redo, journey planning, GeoJSON/GTFS imports, JSON export and shared projects surviving reload. `scripts/browser-functional.mjs` reproduces these checks.

`scripts/browser-advanced.mjs` verifies MetroDreamin import, unchanged original-source export, clipboard and compatible export, group visibility, complete workspace ZIP recovery into a clean profile, and restoration of a selected GeoJSON basemap plus private Overpass settings. Physical editing checks cover platform/bypass switching, new passing loops, track selection, geometry insertion and dragging, appending tracks, zero-lap and full-lap ring branches, extension/rejoining, independent stopping choices on repeated station visits, reload and complete project export. Additional regressions preserve bypasses when deriving express patterns, preserve physical trunks during non-ring branching/reversal, reject a stop at the wrong repeated visit without changing the project, and gate delayed IndexedDB hydration to prove that new edits and imports survive startup.

`scripts/browser-offline.mjs` verifies the exact 17-asset production cache, actual locally loaded DM Sans/Manrope font faces and zero Google Fonts requests. Uncached requests fail before and after a genuine network-disabled reload; the editor, world overview, directory, Glasgow and workshop still open. Edited projects survive reload in IndexedDB and the compatibility localStorage mirror. GeoJSON background packs restore after reload. A tiny synthetic PMTiles v3 PNG archive renders through FileSource and its stored Blob renders again after offline reload. This tests archive integration; it is not a planet-map rendering audit.

The Node server streams tail ranges from an **89 GB logical sparse file** without buffering or allocating an 89 GB download. Tests exercise HEAD, 206/416, suffix/open-ended ranges, validators, CORS, traversal and symlink restrictions. No planet dataset was downloaded or initialized. Docker is unavailable on this host: compose files and the pinned Martin configuration were parsed/schema-checked, and containers have not been executed. See [OFFLINE.md](OFFLINE.md).

The 85 model tests cover explicit track connectivity/direction/speed limits, platform and bypass selection, loop closure toggles, repeated occurrences, non-boarding junctions/waypoints, journey estimates, editing cleanup, native/GTFS/GeoJSON/OSM parsing, workspace validation and ZIP classification, original-source fidelity and SVG export. SVG robustness includes polar coordinates and 150,000-vertex geometry.

Live public Overpass retrieval previously returned server/rate-limit errors. Controlled endpoint/parser tests establish behavior, not public endpoint availability or complete worldwide geometry. The 234-entry directory is a source snapshot; Glasgow has sourced station topology with straight connections; the London demonstrations and track workshop are fictional. Train previews do not simulate signalling or collision avoidance.

Public repository: [Roflu999/metroweave](https://github.com/Roflu999/metroweave). Website: [MetroWeave](https://roflu999.github.io/metroweave/). The deployment workflow runs the regression suite, server checks and Linux production build before publishing. Local browser test scripts accept `BASE_URL`, `CHROMIUM_EXECUTABLE` and `QA_OUTPUT_DIR` for independent reproduction on either origin.

## Published upgrade

[GitHub Actions run 39247780260](https://github.com/Roflu999/metroweave/actions/runs/39247780260) successfully ran npm ci, all 85 model tests, both server tests, the Linux production build and Pages deployment for application commit `68e90b3cad832611d86832a8bcf449139f60de70`.

The deployed offline build is `66ac0bc95da5630c4826`: all seven offline workflows passed under the actual `/metroweave/` scope, including its exact 17-asset cache, fonts and PMTiles/GeoJSON reloads. All twelve original editing workflows and an uninterrupted run of all sixteen advanced workflows also passed on the public origin, with zero uncaught application errors. During hosted verification, two initial new-page navigations were interrupted by external connection resets/closures; the affected checks passed when retried. These were navigation failures, with no uncaught application errors.

The portable `MetroWeave-ready.zip` was extracted into a fresh folder containing spaces. Its production server started with Node alone and no installed npm dependencies, and every one of the 17 listed offline assets returned HTTP 200 with non-empty content. The local Windows build has cache version `989cc5ab5c1b4a262ab8`; Linux line-ending normalization produces a different exact-byte cache version for the same application source.
