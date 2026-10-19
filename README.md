# MetroWeave

A local-first transit map studio inspired by [MetroDreamin](https://metrodreamin.com/), built with an independent interface and codebase. Design branching lines, loops and express services on an interactive geographic map, or import real transit data.

**Live app:** [roflu999.github.io/metroweave](https://roflu999.github.io/metroweave/) · **Source:** [Roflu999/metroweave](https://github.com/Roflu999/metroweave)

## Run locally

Requires Node.js 22.12 or newer (Node 24 recommended).

```powershell
npm install
npm run dev
```

Open http://127.0.0.1:5173. Double-click `Start-MetroWeave.cmd` on Windows to serve a production build (it builds first if necessary). If `dist/` is already included, the production server needs only Node, without installed npm dependencies. For the production build:

```powershell
npm run build
npm run preview
```

Open http://127.0.0.1:4173. `npm test` runs the routing and importer regression suite. An existing machine-wide npm proxy may need correcting on your machine; this project never changes global npm settings.

## What you can do

- Add and move stations on a world street map; change their names, coordinates, station codes and step-free design settings.
- Create metro, rail, tram, monorail, maglev and light-metro lines with custom colors and badges.
- Create multiple ordered service patterns per line: branches sharing a trunk, loops, one-way services, shuttles, local and express overlays. Revisit the same station for returning or figure-eight paths.
- Toggle each pattern's station stops independently. Skipped stations remain part of its physical path, but cannot be used to board or alight on that pattern.
- Add and drag intermediate geometry points. Crossed lines do not automatically create interchanges; shared station IDs and explicit walking groups do.
- Configure headways, speed and dwell. The journey planner includes expected waiting, in-vehicle travel, dwell and transfers.
- Browse 234 sourced metro-system directory entries, open a workspace at any city, and request current OpenStreetMap route relations. The directory is bundled for offline access.
- Import local GTFS ZIP feeds, GeoJSON station/route collections, and complete MetroWeave project JSON files. Processing happens in the browser.
- Autosave current work; save named snapshots; undo/redo; export project JSON, geographic SVG, or GeoJSON; share small projects in self-contained URL fragments.
- Preview moving trains, toggle station labels and individual lines, and switch between geographic and 45-degree diagram rendering.

## Coverage and accuracy

This app can author networks anywhere in the world. **It does not ship a complete, verified track-and-service dataset for every metro system.** The world atlas is a sourced system directory, not a claim of complete geometry coverage. Its 234 operating-system source rows correspond to 215 named areas and 63 countries in the captured Wikipedia revision. Definitions and source tables can change.

A second bundled example uses the actual 15-station Glasgow Subway stop order from SPT, with sourced station coordinates and straight connections. It is available at the top of the world atlas and explicitly distinguishes station topology from surveyed track geometry.

The included London map contains 54 approximate station locations, seven **fictional** lines and nine service patterns. It illustrates the model and is explicitly labeled a sandbox. It is not a TfL passenger map. Accessibility, services, headways and speeds are design assumptions.

OpenStreetMap import is a bounded city-area query. Community geometry and route relations can be incomplete, inconsistent or outdated. A line may travel outside the query area; some systems contain no suitable relations. OSM stop/platform membership does not reliably encode express, rush-hour or calendar-specific stopping patterns. Review imports against the operator's maps and feeds.

GTFS import preserves distinct ordered trip patterns and available shapes, but does not reproduce calendars, frequencies, live service, fares, platform-specific boarding restrictions or an executable timetable. Exact duplicates are grouped, and browser resource limits apply. Check DATA.md for details. Large national feeds may need splitting to a metro or agency first.

The train preview follows geometry at configured speed; it does not model acceleration, dwell, dispatch frequency, signalling, collisions or overtaking. Journey times are planning estimates, not passenger information. Diagram view inserts 45-degree bends between existing coordinates, rather than automatically solving an optimized schematic layout. SVG export is geographic and omits basemap tiles.

Current model limits: all occurrences of the same station ID share one stop/pass choice within a pattern; waypoints between the same ordered pair are shared for repeated traversals. Represent independently operated platforms or stopping behavior using separate station IDs, linked by a walking group where appropriate. Parallel tracks and overtaking infrastructure can be drawn as separate services, but are not a signalling simulation.

## Controls and persistence

`V` select/move, `S` station, `D` extend selected service, `B` geometry, `E` erase, `Escape` select, `Delete` delete selected station, `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Shift+Z` redo, `Ctrl/Cmd+S` save snapshot. The inspector lets you reorder and remove stations, change stop/pass choices and edit service settings. Create a branch after inspecting its desired branch-point station, or use Branch to copy half the current path and extend it.

Switching projects automatically keeps the previous project as a snapshot where browser storage permits.

Autosave and My maps live in this browser's localStorage. They are not synchronized or backed up to a server. Export JSON for durable backups. Sharing uses compressed data in the URL fragment; the recipient receives a copy and later edits do not sync. Large projects must be shared as files. Basemap tiles, fonts and OSM imports need internet access; a previously loaded app can edit bundled/local data without them.

## GitHub Pages

The checked-in Actions workflow tests, builds and deploys the static app on pushes to `main`. `base: './'` makes asset paths work on both account and repository Pages URLs.

1. Create a repository and push this directory as its root.
2. In **Settings → Pages → Build and deployment → Source**, select **GitHub Actions** (or configure that through the API).
3. Push to `main`, or run the workflow manually.
4. Open the URL reported by the `deploy` job. GitHub hosting has no application database and maps stay in each user's browser.

```powershell
git remote add origin https://github.com/YOUR_ACCOUNT/metroweave.git
git push -u origin main
```

## Architecture

React + TypeScript + Vite, Leaflet basemap/overlay rendering, fflate ZIP/compression, Lucide icons. Static hosting, no API keys, backend or sign-in required. Core entity types are in `src/types.ts`; `src/engine.ts` owns validation, geometry and occurrence-aware journey routing; `src/importers.ts` owns GTFS, GeoJSON and OSM ingestion. Coordinates are `[latitude, longitude]` internally and standard `[longitude, latitude]` in GeoJSON. Distances are km; speed km/h; headway minutes; dwell seconds.

## Sources and licenses

See [DATA.md](DATA.md) for dataset provenance, revision, coverage checks and licenses. Map tiles: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), under the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). Do not bulk prefetch tiles. Network metadata comes from the user-supplied [Rapid transit](https://en.wikipedia.org/wiki/Rapid_transit) article and its linked [List of metro systems](https://en.wikipedia.org/wiki/List_of_metro_systems) (CC BY-SA 4.0). Interface icons: [Lucide](https://lucide.dev/) (ISC). Interface fonts: DM Sans and Manrope via Google Fonts (SIL Open Font License). GTFS follows the [official schedule reference](https://gtfs.org/documentation/schedule/reference/). Transit-operator/GTFS licenses remain those of the imported feed. MetroDreamin is credited as inspiration; its code, database, branding and user maps have not been copied.

Application code: MIT. Bundled Wikipedia-derived directory: CC BY-SA 4.0, as documented in DATA.md. External map data and imported files retain their original licenses.
