# Offline use and a full-world map server

The existing online OpenStreetMap map remains the default. The installed app can reopen without an internet connection after its first successful production load. A bundled, public-domain Natural Earth map supplies a **low-detail world overview**. Detailed offline streets require a PMTiles archive or a map pack that you supply; no planet archive has been downloaded, and no database has been initialized by this project.

## What is installed offline

Run `npm run build` and `npm start`, then open the localhost URL once while connected. `build-offline.mjs` hashes the finished build and creates an exact cache manifest covering the HTML, every Vite asset/chunk, local fonts, icons, world overview, system directory and bundled reference networks. Check that the app reports offline readiness before disconnecting. The service worker handles navigation with an offline fallback and prompts through the app when a new build is waiting; accepting the update activates it and reloads the app. Localhost and HTTPS are supported service-worker origins. Opening `index.html` directly from disk is not.

No standard `tile.openstreetmap.org` tile is prefetched, put in the app's service-worker cache, or copied into an archive. [OSMF's tile policy prohibits offline bulk downloading](https://operations.osmfoundation.org/policies/tiles/). Normal interactive viewing uses the browser's standard HTTP cache. Offline detail comes from licensed data archives, rather than a tile scraping feature.

The world layer is [Natural Earth 1:110m Admin 0 Countries](https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_admin_0_countries.geojson), fetched 19 October 2026. It is [public-domain cartography](https://www.naturalearthdata.com/about/terms-of-use/), intended for global orientation rather than street precision. DM Sans and Manrope are bundled locally under the SIL Open Font License, with licenses in `public/fonts`. No Google Fonts request is required.

## Browser map packs and backups

GeoJSON basemaps up to 40 MB are validated and stored in IndexedDB. PMTiles is the efficient choice for larger areas: its `FileSource` reads just the needed byte slices. An archive is never read into one large JavaScript buffer. PMTiles archives up to 250 MB can be copied directly into IndexedDB as a File/Blob for use after reload, subject to browser quota. Larger archives stay on disk as session file references and must be reattached after reloading, or served through `/maps/`. A full planet archive belongs on a disk/server, not in browser storage.

Offline map backup exports include GeoJSON data and map source settings. PMTiles file contents are deliberately excluded from the workspace backup: keep the original archive, reattach it after restoring, or retain its server URL. Browser storage belongs to a specific origin (scheme, hostname and port). Moving from localhost to GitHub Pages creates a separate browser store. Browsers can evict non-persistent data under pressure; use the persistent-storage control and keep exported backups.

The built-in Leaflet renderer supports Protomaps MVT archives and raster PNG/JPEG/WebP/AVIF PMTiles. A different vector schema, such as OpenMapTiles, needs matching custom styling; displaying arbitrary MVT data is not a guarantee that its layer names match the built-in Protomaps style. The Leaflet plugin is [in maintenance mode](https://docs.protomaps.com/pmtiles/leaflet); it is retained to preserve this editor's existing Leaflet functionality.

## Full-world setup without Docker

The supplied Node HTTP server already supports large archives with streaming single-range `206` responses, suffix/open-ended ranges, `HEAD`, `416`, ETags, conditional requests and CORS. It reads only the requested bytes. It rejects path traversal and symlinks that leave the configured map directory, and exposes only map-related file extensions. The server binds to `127.0.0.1` by default.

1. Obtain an OSM-derived **Protomaps-schema planet PMTiles archive** separately. Select a current dated build and check its metadata, size, license and checksum using the [official build directory](https://maps.protomaps.com/builds/) and [PMTiles CLI guide](https://docs.protomaps.com/guide/getting-started). Keep enough disk space for the archive plus a replacement copy during updates. The planet is a large independent dataset; its current size must be checked at the provider, not assumed to be a fixed 89 GB.
2. Place the verified file in a dedicated directory, for example `D:\Maps\planet.pmtiles`. NTFS/ext4 or another large-file filesystem is required; FAT32 cannot hold files above 4 GB.
3. From the project directory in PowerShell:

```powershell
$env:METROWEAVE_MAPS_DIR = 'D:\Maps'
npm run build
npm start
```

4. Add a PMTiles URL source in the app: `http://127.0.0.1:5173/maps/planet.pmtiles`, retaining visible OSM/Protomaps attribution. The source remains usable without internet while the local server is running. Do not enable browser DevTools' complete network-offline mode when testing a localhost map server: that also blocks localhost. Disconnect external internet access or block only external domains instead.

Verify the archive service before opening a large map:

```powershell
curl.exe -I http://127.0.0.1:5173/maps/planet.pmtiles
curl.exe -I -H 'Range: bytes=0-126' http://127.0.0.1:5173/maps/planet.pmtiles
```

The second response should be `206` with `Content-Range: bytes 0-126/<archive-size>`. The archive is read directly from disk; it is not added to the app cache. Self-hosted raster XYZ directories can be stored under the same map directory and used with a URL such as `http://127.0.0.1:5173/maps/tiles/{z}/{x}/{y}.png`.

`METROWEAVE_MAPS_CORS` can restrict cross-origin use to your site's origin. For example set it to `https://yourname.github.io`. `HOST=0.0.0.0` enables LAN access, but HTTPS is needed for installing the app on non-localhost origins. An HTTPS public app connecting to an HTTP/private-network server can be blocked by browser mixed-content or private-network rules; an HTTPS reverse proxy on your own host is the reliable deployment. A local-only app avoids that cross-origin topology.

## Docker / Martin full-world deployment

`deploy/compose.yml` supplies the app and an optional [Martin](https://maplibre.org/martin/run-with-docker.html) PMTiles tile backend. Martin is pinned to its verified stable `1.16.1` release. Copy `deploy/.env.example` to `deploy/.env`, point `METROWEAVE_MAPS_DIR` to your dedicated map disk, and put the independently obtained planet archive there. The containers mount the archive read-only. No map data download is part of the Docker build or startup.

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml config
docker compose --env-file deploy/.env -f deploy/compose.yml up -d --build app
docker compose --env-file deploy/.env -f deploy/compose.yml --profile tiles up -d martin
```

The app is at `http://127.0.0.1:5173`. Its `/maps/planet.pmtiles` range endpoint is the simplest Leaflet integration. Martin is at `http://127.0.0.1:3000`; inspect `/catalog` and its TileJSON for the advertised source and tile URLs. Martin serves archive tiles to other clients; it does not invent missing metro stopping patterns. `deploy/martin.yml` discovers PMTiles files under `/maps`. Martin can also serve PostGIS tables, but a database is unnecessary for an existing archive.

Serve public deployments behind an HTTPS reverse proxy, use a real hostname, retain attribution, limit access as appropriate, and monitor disk space/requests. The compose ports deliberately bind to loopback. Replace archives atomically and keep source dates; do not modify an archive in place while clients are making byte-range requests. The browser checks archive identity via ETags, but restarting an active editing session after changing basemaps remains prudent.

**Validation boundary:** the Node map server was executed and tested on this host, including reading a tail range from an 89 GB logical sparse file without downloading or allocating an 89 GB archive. Docker is not installed on this host, so the compose files and pinned Martin configuration were parsed/schema-checked but the containers have not been runtime-tested here. No planet dataset has been downloaded or served.

## “The whole OpenStreetMap server” is several services

| Component                    | What it provides                                                | Prepared here                                                       |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| Offline editor/PWA           | Editing, local projects, transit routing, network import/export | Built application and exact asset cache                             |
| PMTiles / raster tile server | Background cartography from a selected snapshot                 | Executed Node range server; optional Martin compose                 |
| Overpass query database      | Search raw OSM objects and route relations by tags/area         | Separate optional compose blueprint below                           |
| OSM editing API and website  | User accounts, changesets, editing, history                     | Upstream deployment reference; not initialized                      |
| Geocoder                     | Address/name search                                             | A separate Nominatim or other geocoding deployment; not initialized |

A planet PMTiles file is a **rendered/generalized map dataset**, not a raw OSM database and not a complete OSM website clone. It cannot answer arbitrary tag queries or recover every detailed metro service pattern. Conversely, a raw `planet.osm.pbf` file is not immediately a renderable map. Rendering pipelines such as [Planetiler](https://github.com/onthegomap/planetiler) build tiles from raw extracts; they need their own CPU, memory, temporary disk space and style configuration. Obtaining a ready-built compatible archive is the simpler background-map route.

For raw-object queries, `deploy/compose.overpass.yml` is deliberately separate from normal app startup. It follows the [Overpass container maintainer's documented clone mode](https://github.com/wiktorn/Overpass-API). Configure `OVERPASS_DB_DIR` on a dedicated disk and pin `OVERPASS_IMAGE` to a reviewed tag/digest before using it. The file's default image tag follows the upstream publisher; it is not treated as a reproducible lock. **Starting this optional deployment clones and indexes a planet database and is a large download. It has not been started.**

```sh
# Only after provisioning and separately approving the planet import:
# OVERPASS_DB_DIR=/srv/overpass OVERPASS_IMAGE=wiktorn/overpass-api:<reviewed-tag-or-digest> \
#   docker compose -f deploy/compose.overpass.yml up -d
```

Once separately provisioned, its endpoint would be `http://127.0.0.1:8081/api/interpreter`. Enter that address in **Offline & map servers → OSM data query server → Overpass endpoint** to direct world-atlas track imports exclusively to your own query service; leave it blank for the existing public endpoints. This setting is included in complete workspace backups. Full-world Overpass has substantially higher database storage and indexing needs than serving PMTiles; plan dedicated SSD capacity, RAM, import time and replication maintenance from [upstream installation guidance](https://wiki.openstreetmap.org/wiki/Overpass_API/Installation). Do not infer database hardware requirements from a compressed archive's download size. The separate blueprint is syntax-checked, not an executed planet query service.

An editable OSM API/website requires [openstreetmap-website](https://github.com/openstreetmap/openstreetmap-website), PostgreSQL/PostGIS and an OSM API backend/import pipeline. It also creates an independently operated database, not a mirror that can write into the public OSM database automatically. This project does not provision accounts, edit history or a planet-scale editing service. A geocoder similarly needs a separately maintained index.

GitHub Pages can host the static editor and its small offline assets. It cannot run Node, Martin, PostGIS or Overpass, nor is a huge planet archive a sensible Git repository artifact. Keep the data services on your own machine/server, or on HTTP-range-capable object storage with correct CORS and data licenses. For an offline workstation, use the local Node app and the local map disk together.
