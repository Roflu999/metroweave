# Data and research

MetroWeave separates a world directory, geographic route imports, and editable design plans. These have different evidence and accuracy limits.

## World directory

`public/data/catalog.json` contains **234 entries, 215 named city/area labels, and 63 countries** from the operating-systems table in [Wikipedia's List of metro systems](https://en.wikipedia.org/wiki/List_of_metro_systems). It was fetched on **19 October 2026**, revision **1380242078**, following the list linked from the user's [Rapid transit](https://en.wikipedia.org/wiki/Rapid_transit) reference. The catalog retains its source, revision, SHA-256 of the downloaded HTML, snapshot date, scope, license and per-entry article links.

The source's definition governs inclusion. Separate operators can be separate entries within one city. Some light metros and metropolitan systems are included in the source; commuter rail, tram, people-mover and other categories may be excluded. The introductory city total in the article differs from a count of distinct row labels. MetroWeave reports the actual extracted row counts and does not reinterpret that introductory total as audited world coverage. Planned systems in the separate construction table are excluded.

City map centers come from the primary coordinate attached to each linked city/area article through the [Wikipedia API](https://en.wikipedia.org/w/api.php). Where a city article has no primary coordinate, its linked Wikidata entity's Earth `P625` coordinate is used. Each entry records `coordinateSource`; Nagpur and Navi Mumbai use this fallback in the delivered snapshot. City centers are search aids, not system extents, station positions, or track geometry. A broad continent group is provided for browsing; transcontinental countries use one group consistently.

Wikipedia contributions are available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The directory adapts the factual name/city/country fields and links from the list; maintain its attribution and license metadata when redistributing it. Wikidata structured data is [CC0](https://www.wikidata.org/wiki/Wikidata:Licensing).

Refresh from the project directory with Node 20 or later:

```sh
node scripts/refresh-catalog.mjs
```

The script uses Node's standard library, fetches only the operating table, expands row spans, retrieves city coordinates, validates identifiers and required coordinates, and replaces the catalog only after all checks pass. Network access to Wikipedia and Wikidata is needed when refreshing. To reproduce the parsing of an archived source HTML file while fetching current coordinates:

```sh
node scripts/refresh-catalog.mjs --from-html /path/to/metro-list.html
```

The source can change. A refresh is a new snapshot and does not silently certify every entry's operating status against its transport authority.

## Editable London demonstration

The initial **London, reimagined** project contains 54 approximate real-world station locations, seven fictional routes and nine service patterns. It demonstrates a local/express shared corridor, branches through different central trunks, a loop, a limited service and a shuttle. Station names and approximate locations are geographic inspiration; alignments, route names, services, accessibility settings, frequency, speed and dwell are design assumptions. It is not a TfL network or passenger timetable.

The express pattern includes all path stations in `stationIds` and identifies pass-through locations in `skippedStationIds`. Passing a station does not allow boarding there. A route can own multiple service patterns, including different branches and directions. `loop` closes the last-to-first segment. Frequencies are minutes; dwell is seconds; speed is kilometres per hour. Timing calculations are estimates based on design inputs.

## Geographic imports and completeness

The bundled **Glasgow Subway real station topology** (`public/data/glasgow-reference.json`) is a second, non-fictional example. Its 15 station names and both circular stopping sequences were checked against the [official SPT map and its accessible description](https://www.spt.co.uk/travel-with-spt/subway/maps-stations/) on 19 October 2026. The Outer Circle runs clockwise; the Inner Circle runs anticlockwise, with every station served in both directions. Each service has 15 unique stops and a closing segment back to Buchanan Street. Fifteen individually linked Wikipedia station articles provide primary station-site coordinates, with exact article revision IDs retained in the source links. Partick's coordinate describes the railway/subway interchange site rather than a surveyed subway platform.

Glasgow is shown with **straight station connections, not surveyed track geometry**. There is no imported live timetable; headway, speed and dwell values are editable planning assumptions. The snapshot does not claim live operating status or verified accessibility. Rebuild the coordinate snapshot with `node scripts/make-glasgow-reference.mjs`; review the SPT stopping order before refreshing. Attempts to obtain the complete Glasgow OSM route geometry during this build failed with public Overpass server errors, so no OSM geometry is claimed for this example.

OpenStreetMap route relations describe ordered stops/platforms and track members. [The subway route documentation](https://wiki.openstreetmap.org/wiki/Tag:route%3Dsubway) recommends a relation for each direction; branches and stopping variations must remain separate service patterns. Source tags and completeness vary. [Overpass QL](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL) can retrieve current relations and their geometry for a geographic area, but a bounded query may miss the outer portions of a system or pick up neighbouring systems.

OpenStreetMap data requires [OpenStreetMap attribution and ODbL compliance](https://www.openstreetmap.org/copyright). Imports should be reviewed for missing station names, track discontinuities, platform duplicates, express stopping patterns and directions. Source geometry does not by itself establish an official timetable. GTFS schedules, where provided by an authority, can represent separate trip patterns and their stopping order; their agency license and feed date remain relevant.

The directory makes all source-listed systems discoverable. It does **not** bundle a verified station-by-station and track-by-track reconstruction of every system in the world. The editor's flexible service model, geographic imports and user-supplied data are the path to building those depictions.

## Delivered snapshot validation

Two independent parsers extracted and compared the source's operating-system rows against the delivered JSON by system name, city, country and decoded article URL: **234 source rows, 234 output rows, zero missing and zero extra**. All map centers were checked for numeric geographic bounds. No construction-table entries are included. These checks establish extraction coverage, not independent factual verification of the source.
