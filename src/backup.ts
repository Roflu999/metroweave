import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Network } from "./types";
import { validateNetwork } from "./engine";

const MB = 1024 * 1024;
const MAX_JSON_BYTES = 100 * MB;
const MAX_ZIP_BYTES = 60 * MB;
const MANIFEST = "workspace.json";

export interface WorkspaceBundle {
  format: "metroweave-workspace";
  version: 1;
  exportedAt: string;
  currentProjectId: string;
  projects: Network[];
  settings: Record<string, unknown>;
  importedSourceMetadata?: Record<string, unknown>;
  offlineMaps?: unknown;
  [key: string]: unknown;
}
export interface WorkspaceInput {
  projects: Network[];
  currentProjectId: string;
  settings?: Record<string, unknown>;
  exportedAt?: string;
  importedSourceMetadata?: Record<string, unknown>;
  offlineMaps?: unknown;
  [key: string]: unknown;
}

/** Copy JSON data without invoking accessors or toJSON hooks. Unknown source fields remain ordinary data. */
export function copyJSONData<T>(
  value: T,
  label = "JSON data",
  byteLimit = MAX_JSON_BYTES,
): T {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 1_500_000 || depth > 64)
      throw new Error(
        `${label} exceeds the supported JSON complexity (1,500,000 values / 64 levels).`,
      );
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v !== "object")
      throw new Error(
        `${label} must contain only JSON values; nonfinite numbers and undefined values are not supported.`,
      );
    if (ancestors.has(v))
      throw new Error(`${label} contains a circular reference.`);
    const proto = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null)
      throw new Error(`${label} must contain plain JSON objects.`);
    if (Object.getOwnPropertySymbols(v).length)
      throw new Error(`${label} contains unsupported symbol properties.`);
    ancestors.add(v);
    let result: unknown;
    if (Array.isArray(v)) {
      result = Array.from({ length: v.length }, (_, i) => {
        const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
        if (!descriptor || !("value" in descriptor))
          throw new Error(`${label} contains an array hole or accessor.`);
        return visit(descriptor.value, depth + 1);
      });
    } else {
      const entries = Object.entries(Object.getOwnPropertyDescriptors(v));
      result = Object.fromEntries(
        entries.map(([key, descriptor]) => {
          if (!("value" in descriptor))
            throw new Error(`${label} contains an accessor property.`);
          return [key, visit(descriptor.value, depth + 1)];
        }),
      );
    }
    ancestors.delete(v);
    return result;
  };
  const copied = visit(value, 0) as T;
  if (strToU8(JSON.stringify(copied)).byteLength > byteLimit)
    throw new Error(
      `${label} exceeds the ${Math.round(byteLimit / MB)} MB browser limit.`,
    );
  return copied;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function isWorkspaceBundle(input: unknown): input is WorkspaceBundle {
  return record(input) && input.format === "metroweave-workspace";
}

function validateBundle(
  input: unknown,
  requireFormat: boolean,
): WorkspaceBundle {
  if (!record(input))
    throw new Error("A workspace backup must be a JSON object.");
  if (
    (requireFormat && input.format !== "metroweave-workspace") ||
    (input.format !== undefined && input.format !== "metroweave-workspace")
  )
    throw new Error(
      "This is not a MetroWeave workspace backup. Import a project, GeoJSON or GTFS file using its own import option.",
    );
  if (
    (requireFormat && input.version !== 1) ||
    (input.version !== undefined && input.version !== 1)
  )
    throw new Error(
      "Unsupported workspace version; this application supports version 1.",
    );
  if (
    !Array.isArray(input.projects) ||
    input.projects.length === 0 ||
    input.projects.length > 100
  )
    throw new Error("A workspace backup must contain 1 to 100 projects.");
  const projects = input.projects.map((value, i) => {
    try {
      return validateNetwork(value);
    } catch (e) {
      throw new Error(
        `Workspace project ${i + 1}: ${e instanceof Error ? e.message : "invalid project"}`,
      );
    }
  });
  const ids = new Set(projects.map((p) => p.id));
  if (ids.size !== projects.length)
    throw new Error(
      "Workspace project IDs must be unique. Keep one latest project per ID.",
    );
  if (
    typeof input.currentProjectId !== "string" ||
    !ids.has(input.currentProjectId)
  )
    throw new Error(
      "The currentProjectId must identify one of the projects in the workspace.",
    );
  const settings = input.settings ?? {};
  if (!record(settings))
    throw new Error("Workspace settings must be a JSON object.");
  const exportedAt = input.exportedAt ?? new Date().toISOString();
  if (
    typeof exportedAt !== "string" ||
    !Number.isFinite(Date.parse(exportedAt))
  )
    throw new Error("Workspace exportedAt must be a valid date.");
  if (
    input.importedSourceMetadata !== undefined &&
    !record(input.importedSourceMetadata)
  )
    throw new Error("Workspace importedSourceMetadata must be a JSON object.");
  // Preserve unrecognized top-level extension fields, as well as per-project import provenance.
  const copiedSettings = copyJSONData(settings, "Workspace settings", 2 * MB);
  const normalized = Object.fromEntries(
    Object.entries({ ...input, projects, settings: copiedSettings }).filter(
      ([, value]) => value !== undefined,
    ),
  );
  const copied = copyJSONData(normalized, "Workspace backup");
  return {
    ...copied,
    format: "metroweave-workspace",
    version: 1,
    exportedAt,
    projects,
    currentProjectId: input.currentProjectId,
    settings: copiedSettings,
  };
}

export function serialiseWorkspace(
  input: WorkspaceInput | WorkspaceBundle,
): string {
  const bundle = validateBundle(input, false);
  const output = JSON.stringify(bundle, null, 2);
  if (strToU8(output).byteLength > MAX_JSON_BYTES)
    throw new Error(
      "The serialized workspace exceeds the 100 MB browser limit. Export projects separately.",
    );
  return output;
}

function zipFiles(
  buffer: ArrayBuffer,
  extract: boolean,
): { names: string[]; manifest?: Uint8Array } {
  if (buffer.byteLength > MAX_ZIP_BYTES)
    throw new Error("The archive exceeds the 60 MB browser import limit.");
  const names: string[] = [];
  const seen = new Set<string>();
  let manifestCount = 0;
  let zip: Record<string, Uint8Array>;
  try {
    zip = unzipSync(new Uint8Array(buffer), {
      filter: (file) => {
        const basename = file.name.split(/[\\/]/).at(-1)!.toLowerCase();
        if (!basename) return false;
        if (
          seen.has(basename) &&
          [
            MANIFEST,
            "stops.txt",
            "routes.txt",
            "trips.txt",
            "stop_times.txt",
          ].includes(basename)
        )
          throw new Error(`Duplicate archive table: ${basename}.`);
        seen.add(basename);
        names.push(basename);
        if (names.length > 10000)
          throw new Error("The archive contains more than 10,000 files.");
        if (basename !== MANIFEST) return false;
        manifestCount++;
        if (file.originalSize > MAX_JSON_BYTES)
          throw new Error(
            "The expanded workspace exceeds the 100 MB browser import limit.",
          );
        return extract;
      },
    });
  } catch (e) {
    throw new Error(
      `Unable to open archive: ${e instanceof Error ? e.message : "invalid ZIP"}`,
    );
  }
  const gtfs = ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt"].every(
    (name) => seen.has(name),
  );
  if (manifestCount && gtfs)
    throw new Error(
      "The archive contains both a workspace backup and a GTFS feed. Import one format at a time.",
    );
  const entry = Object.entries(zip).find(
    ([name]) => name.split(/[\\/]/).at(-1)!.toLowerCase() === MANIFEST,
  );
  return { names, ...(entry ? { manifest: entry[1] } : {}) };
}

export function classifyArchive(
  buffer: ArrayBuffer,
): "workspace" | "gtfs" | "unknown" {
  const { names } = zipFiles(buffer, false);
  if (names.includes(MANIFEST)) return "workspace";
  if (
    ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt"].every((name) =>
      names.includes(name),
    )
  )
    return "gtfs";
  return "unknown";
}

export function parseWorkspace(
  input: string | ArrayBuffer | unknown,
): WorkspaceBundle {
  let value = input;
  if (input instanceof ArrayBuffer) {
    const bytes = new Uint8Array(input);
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const { manifest } = zipFiles(input, true);
      if (!manifest)
        throw new Error(
          `This is not a workspace ZIP: ${MANIFEST} is missing. GTFS ZIP files must use the transit-feed importer.`,
        );
      value = strFromU8(manifest);
    } else {
      if (bytes.byteLength > MAX_JSON_BYTES)
        throw new Error(
          "Workspace JSON exceeds the 100 MB browser import limit.",
        );
      value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
  }
  if (typeof value === "string") {
    if (
      value.length > MAX_JSON_BYTES ||
      strToU8(value).byteLength > MAX_JSON_BYTES
    )
      throw new Error(
        "Workspace JSON exceeds the 100 MB browser import limit.",
      );
    try {
      value = JSON.parse(value.replace(/^\uFEFF/, ""));
    } catch {
      throw new Error("Workspace backup is not valid JSON.");
    }
  }
  return validateBundle(value, true);
}

export function exportWorkspaceZIP(
  input: WorkspaceInput | WorkspaceBundle,
): Uint8Array {
  const serialized = serialiseWorkspace(input);
  const bytes = zipSync({ [MANIFEST]: strToU8(serialized) }, { level: 6 });
  if (bytes.byteLength > MAX_ZIP_BYTES)
    throw new Error(
      "The compressed workspace exceeds the 60 MB browser limit. Export projects separately.",
    );
  return bytes;
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  let rendered =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  // A leading apostrophe protects literal names/IDs from becoming spreadsheet formulas.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(rendered))
    rendered = `'${rendered}`;
  return /[",\r\n]/.test(rendered)
    ? `"${rendered.replace(/"/g, '""')}"`
    : rendered;
}
function csv(headers: string[], rows: unknown[][]): string {
  return (
    "\uFEFF" +
    [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}

/** Tabular exports, not a GTFS timetable. JSON cells preserve ordered/repeated topology values. */
export function exportNetworkCSV(input: Network): Record<string, string> {
  const n = validateNetwork(input);
  return {
    stations: csv(
      [
        "station_id",
        "name",
        "latitude",
        "longitude",
        "code",
        "accessible",
        "transfer_group",
        "is_waypoint",
        "grade",
        "info",
      ],
      n.stations.map((s) => [
        s.id,
        s.name,
        s.lat,
        s.lng,
        s.code,
        s.accessible,
        s.transferGroup,
        s.isWaypoint,
        s.grade,
        s.info,
      ]),
    ),
    routes: csv(
      [
        "route_id",
        "name",
        "short_name",
        "color",
        "mode",
        "visible",
        "group_id",
        "icon",
        "pattern",
      ],
      n.routes.map((r) => [
        r.id,
        r.name,
        r.shortName,
        r.color,
        r.mode,
        r.visible,
        r.groupId,
        r.icon,
        r.pattern,
      ]),
    ),
    lineGroups: csv(
      ["group_id", "name", "visible"],
      (n.lineGroups ?? []).map((g) => [g.id, g.name, g.visible]),
    ),
    services: csv(
      [
        "service_id",
        "route_id",
        "name",
        "kind",
        "loop",
        "direction",
        "headway_min",
        "speed_kmh",
        "dwell_seconds",
        "station_ids_json",
        "skipped_station_ids_json",
        "stop_pattern_json",
        "track_path_json",
        "waypoints_json",
        "shape_json",
      ],
      n.services.map((s) => [
        s.id,
        s.routeId,
        s.name,
        s.kind,
        s.loop,
        s.direction,
        s.headway,
        s.speed,
        s.dwell,
        s.stationIds,
        s.skippedStationIds,
        s.stopPattern,
        s.trackPath,
        s.waypoints,
        s.shape,
      ]),
    ),
    stops: csv(
      ["service_id", "route_id", "occurrence_index", "station_id", "stops"],
      n.services.flatMap((s) =>
        s.stationIds.map((id, i) => [
          s.id,
          s.routeId,
          i,
          id,
          s.stopPattern?.[i] ?? !s.skippedStationIds.includes(id),
        ]),
      ),
    ),
    junctions: csv(
      ["junction_id", "name", "latitude", "longitude", "properties_json"],
      (n.junctions ?? []).map((j) => [j.id, j.name, j.lat, j.lng, j]),
    ),
    tracks: csv(
      ["track_id", "from_id", "to_id", "kind", "direction", "properties_json"],
      (n.tracks ?? []).map((t) => [
        t.id,
        t.fromId,
        t.toId,
        t.kind,
        t.direction,
        t,
      ]),
    ),
    passingLoops: csv(
      [
        "loop_id",
        "station_id",
        "entry_id",
        "exit_id",
        "main_track_ids_json",
        "bypass_track_ids_json",
        "properties_json",
      ],
      (n.passingLoops ?? []).map((p) => [
        p.id,
        p.stationId,
        p.entryId,
        p.exitId,
        p.mainTrackIds,
        p.bypassTrackIds,
        p,
      ]),
    ),
    sources: csv(
      ["title", "url", "license", "accessed"],
      n.sources.map((s) => [s.title, s.url, s.license, s.accessed]),
    ),
    provenance: csv(
      ["format", "imported_at", "loss_report_json", "original_json"],
      n.importMetadata
        ? [
            [
              n.importMetadata.format,
              n.importMetadata.importedAt,
              n.importMetadata.lossReport,
              n.importMetadata.original,
            ],
          ]
        : [],
    ),
    network: csv(
      [
        "project_id",
        "name",
        "city",
        "country",
        "description",
        "data_status",
        "center_json",
        "zoom",
        "updated_at",
      ],
      [
        [
          n.id,
          n.name,
          n.city,
          n.country,
          n.description,
          n.dataStatus,
          n.center,
          n.zoom,
          n.updatedAt,
        ],
      ],
    ),
  };
}
