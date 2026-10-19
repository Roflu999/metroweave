# Verification — 19 October 2026

| Check | Result |
| --- | --- |
| Node regression suite (`npm test`) | **37 passed, 0 failed** |
| TypeScript and production bundle (`npm run build`) | **Passed** |
| Browser functional run | **12 of 12 stages passed; no uncaught page errors** |
| Desktop and mobile visual checks | **1536 × 1000 and 390 × 844 reviewed; no horizontal overflow** |
| Station-label collision audit | **34 visible labels; 0 overlaps in the audited view** |
| Local production HTTP and repository-prefix asset paths | **Passed; Glasgow reference loads; no browser errors** |
| Directory source-to-output comparison | **234 source rows, 234 delivered entries; 0 missing and 0 extra** |

The browser report ran against `http://127.0.0.1:5173` on 19 October 2026, from 10:02:29 to 10:03:06 UTC. Its twelve stages covered project/line creation, shared stations, express stop changes, branches and loops, geometry insertion/dragging, stop reordering/removal with undo/redo, global station deletion with undo/redo, autosave and JSON validation, journey planning, GeoJSON upload, GTFS ZIP upload, and an edited share-link project surviving reload.

The regression suite covers occurrence-aware routing, express boarding restrictions, directions and loops, explicit interchanges, geometry distances, malformed imports, topology cleanup, bounded history, GTFS/GeoJSON/OSM parsing, and SVG export. SVG checks include polar coordinates and a 150,000-vertex source shape. Directory provenance and the independent row comparison are documented in [DATA.md](DATA.md).

Live OSM retrieval was **not verified successfully**: public Overpass endpoints returned server/rate-limit errors during this run. Parser, endpoint fallback and cancellation checks use controlled fixtures; they do not establish live endpoint availability or worldwide data completeness.

The Glasgow example has sourced station positions and the official 15-station circular stopping order, drawn as straight station connections. It does **not** claim surveyed track geometry or a live timetable. The London example is explicitly fictional. The 234-entry atlas is a system directory, not a verified worldwide track database.

GitHub Pages publishing remains **pending repository selection**. A deployment workflow is included; no GitHub deployment or public URL is claimed by these checks. The completed production build is running locally at http://127.0.0.1:5173. HTTP checks confirmed the application and both datasets return 200, source files are not served, unsupported methods return 405, and the same dist artifact runs successfully under a simulated GitHub repository prefix.
