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

The existing editor, London demonstration, atlas, map tools and sharing workflow remain available. Additional tools live in the line, station, tracks and offline panels.

- Draw, move and name stations anywhere in the world; edit codes, accessibility, descriptive notes and above/at/below-ground placement. Non-boarding waypoints shape lines without creating passenger stops.
- Create 12 transport modes, custom line colors, nine badge shapes, four line patterns and named line groups with group visibility controls.
- Define multiple service patterns per line: local/express, short turns, shuttles, repeated visits, loops, branches and directions. Stop/pass choices belong to individual occurrences, so a train can serve a station on one visit and pass it on another.
- Model shared physical tracks, switches, one-way sections and speed limits. Add passing loops with separate platform and bypass paths, assign local and express trains to them, and edit individual track geometry.
- Branch at a ring station after zero, one or two complete circuits; extend the branch and rejoin an existing station. Physical paths preserve connections and direction restrictions.
- Plan journeys using service stops, expected waits, travel distance, speed limits, dwell and transfers. Explicit walking groups connect separate stations; crossing lines alone do not create an interchange.
- Browse the sourced 234-entry world-system directory and import OSM route relations through public or your own Overpass endpoint.
- Import MetroDreamin JSON (including supported partitioned exports), GTFS ZIP, GeoJSON and MetroWeave projects. Retain the original MetroDreamin source and a conversion report. Export compatible MetroDreamin JSON, complete project JSON, GeoJSON, SVG, clipboard data and an 11-table CSV ZIP.
- Save snapshots and undo/redo. Export a complete workspace ZIP containing all projects, settings, imported source data and GeoJSON map packs; restore it on another device/origin. PMTiles backing archives remain separate files.
- Reopen the installed production app offline with local fonts, directory, references and a world overview. Attach detailed GeoJSON or PMTiles maps, use your own tile server, and stream disk archives through the local HTTP range server.
- Preview trains, toggle labels/lines/groups and use geographic or 45-degree diagram rendering. Share small projects in compressed URL fragments.

Open **My maps → Advanced track workshop** for an editable passing-loop and ring-branch example. [OFFLINE.md](OFFLINE.md) covers offline installation, map packs and the prepared full-world server setup.

## Coverage and accuracy

This app can author networks anywhere in the world. **It does not ship a complete, verified track-and-service dataset for every metro system.** The world atlas is a sourced system directory, not a claim of complete geometry coverage. Its 234 operating-system source rows correspond to 215 named areas and 63 countries in the captured Wikipedia revision. Definitions and source tables can change.

A second bundled example uses the actual 15-station Glasgow Subway stop order from SPT, with sourced station coordinates and straight connections. It is available at the top of the world atlas and explicitly distinguishes station topology from surveyed track geometry.

The included London map contains 54 approximate station locations, seven **fictional** lines and nine service patterns. It illustrates the model and is explicitly labeled a sandbox. It is not a TfL passenger map. Accessibility, services, headways and speeds are design assumptions.

OpenStreetMap import is a bounded city-area query. Community geometry and route relations can be incomplete, inconsistent or outdated. A line may travel outside the query area; some systems contain no suitable relations. OSM stop/platform membership does not reliably encode express, rush-hour or calendar-specific stopping patterns. Review imports against the operator's maps and feeds.

GTFS import preserves distinct ordered trip patterns and available shapes, but does not reproduce calendars, frequencies, live service, fares, platform-specific boarding restrictions or an executable timetable. Exact duplicates are grouped, and browser resource limits apply. Check DATA.md for details. Large national feeds may need splitting to a metro or agency first.

The train preview follows geometry at configured speed; it does not model acceleration, dwell, dispatch frequency, signalling, collisions or overtaking. Journey times are planning estimates, not passenger information. Diagram view inserts 45-degree bends between existing coordinates, rather than automatically solving an optimized schematic layout. SVG export is geographic and omits basemap tiles.

Physical track paths support separate platform and bypass alignments, repeated traversals and per-occurrence stopping. Legacy service geometry still shares waypoint entries between the same ordered station pair; convert it to physical tracks for independent paths. Signal interlocking, collision avoidance, dispatch and executable timetables are outside the current simulation.

## Controls and persistence

`V` select/move, `S` station, `D` extend selected service, `B` geometry, `J` junction, `T` connect tracks, `E` erase, `Escape` select, `Delete` delete selected station, `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Shift+Z` redo, `Ctrl/Cmd+S` save snapshot. The inspector lets you reorder and remove stations, change stop/pass choices and edit service settings. Create branches at a selected station; ring branches offer an explicit full-circuit choice before leaving. The Tracks panel creates junctions, shared tracks and passing loops.

Switching projects automatically keeps the previous project as a snapshot where browser storage permits.

Autosave and My maps use IndexedDB, with a small-project localStorage mirror for compatibility. Storage belongs to this browser and origin and can be cleared or evicted. Export complete workspace backups for durable copies. Sharing uses compressed data in the URL fragment; the recipient receives a copy and later edits do not sync. Large projects should be shared as files. The production app installs a versioned offline cache; fonts and the world overview are bundled. Online basemaps and public OSM queries need connectivity. Detailed offline maps require a separately supplied archive or map pack.

MetroDreamin file interoperability concerns map data. This deployment has no shared account database, public discovery feed, stars, comments or collaborative server. It does not mirror MetroDreamin's hosted user collection. Native imports preserve the supplied original JSON and report converted or unsupported fields; the MetroWeave project/workspace format preserves the richer physical-track model. Review the compatibility report before using a MetroDreamin export in another application.

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

React + TypeScript + Vite, Leaflet, PMTiles/Protomaps, fflate and Lucide. The static editor requires no API keys or sign-in. IndexedDB stores projects/map packs; a service worker caches the exact production shell. An optional Node server streams large maps and Docker configurations prepare independently hosted data services. Core entity types are in `src/types.ts`; `src/engine.ts` owns validation, geometry and occurrence-aware journey routing; `src/importers.ts` owns GTFS, GeoJSON and OSM ingestion. Coordinates are `[latitude, longitude]` internally and standard `[longitude, latitude]` in GeoJSON. Distances are km; speed km/h; headway minutes; dwell seconds.

## Sources and licenses

See [DATA.md](DATA.md) for dataset provenance, revision, coverage checks and licenses. Map tiles: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), under the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). Do not bulk prefetch tiles. Network metadata comes from the user-supplied [Rapid transit](https://en.wikipedia.org/wiki/Rapid_transit) article and its linked [List of metro systems](https://en.wikipedia.org/wiki/List_of_metro_systems) (CC BY-SA 4.0). Interface icons: [Lucide](https://lucide.dev/) (ISC). Interface fonts: locally bundled DM Sans and Manrope (SIL Open Font License). World overview: public-domain Natural Earth, with provenance in `public/data/world-overview.metadata.json`. GTFS follows the [official schedule reference](https://gtfs.org/documentation/schedule/reference/). Transit-operator/GTFS licenses remain those of the imported feed. MetroDreamin is credited as inspiration; this codebase is independent. User-supplied MetroDreamin files retain their original data and licensing; its hosted database and user collection are not bundled.

Application code: MIT. Bundled Wikipedia-derived directory: CC BY-SA 4.0, as documented in DATA.md. External map data and imported files retain their original licenses.
