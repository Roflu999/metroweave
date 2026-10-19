export type LatLng = [number, number];
export interface Station {
  id: string;
  name: string;
  lat: number;
  lng: number;
  code?: string;
  accessible?: boolean;
  transferGroup?: string;
  isWaypoint?: boolean;
  grade?: "above" | "at" | "below";
  info?: string;
}
export interface Route {
  id: string;
  name: string;
  shortName: string;
  color: string;
  mode:
    | "metro"
    | "rail"
    | "tram"
    | "monorail"
    | "maglev"
    | "light-metro"
    | "bus"
    | "brt"
    | "ferry"
    | "gondola"
    | "air"
    | "high-speed-rail";
  visible: boolean;
  groupId?: string;
  icon?:
    | "circle"
    | "square"
    | "diamond"
    | "triangle"
    | "hexagon"
    | "pentagon"
    | "heart"
    | "plus"
    | "star";
  pattern?: "solid" | "dashed" | "dotted" | "dash-dot";
}
export interface LineGroup {
  id: string;
  name: string;
  visible: boolean;
}
export interface Service {
  id: string;
  routeId: string;
  name: string;
  kind: "local" | "express" | "limited" | "shuttle";
  stationIds: string[];
  skippedStationIds: string[];
  waypoints: Record<string, LatLng[]>;
  loop: boolean;
  direction: "both" | "forward";
  headway: number;
  speed: number;
  dwell: number;
  shape?: LatLng[];
  /** Ordered physical track traversals. An omitted field uses legacy station geometry. */
  trackPath?: TrackTraversal[];
  /** Occurrence-specific stopping, overriding skippedStationIds when provided. */
  stopPattern?: boolean[];
}
export interface Junction {
  id: string;
  name: string;
  lat: number;
  lng: number;
}
export interface TrackTraversal {
  trackId: string;
  reverse?: boolean;
}
export interface Track {
  id: string;
  name?: string;
  fromId: string;
  toId: string;
  /** Full polyline; endpoint coordinates are normalized to the referenced nodes. */
  geometry: LatLng[];
  kind: "main" | "passing" | "siding" | "connector";
  direction: "both" | "forward";
  speedLimit?: number;
}
export interface PassingLoop {
  id: string;
  name: string;
  stationId: string;
  entryId: string;
  exitId: string;
  mainTrackIds: string[];
  bypassTrackIds: string[];
}
export interface ImportMetadata {
  format: string;
  importedAt: string;
  lossReport: string[];
  original: Record<string, unknown>;
}
export interface Source {
  title: string;
  url: string;
  license?: string;
  accessed?: string;
}
export interface Network {
  version: 1;
  id: string;
  name: string;
  city: string;
  country: string;
  description: string;
  stations: Station[];
  routes: Route[];
  services: Service[];
  sources: Source[];
  dataStatus: "demo" | "imported" | "osm" | "gtfs" | "custom";
  center: LatLng;
  zoom: number;
  updatedAt: string;
  junctions?: Junction[];
  tracks?: Track[];
  passingLoops?: PassingLoop[];
  importMetadata?: ImportMetadata;
  lineGroups?: LineGroup[];
}
export interface CatalogEntry {
  id: string;
  city: string;
  country: string;
  name: string;
  lat: number;
  lng: number;
  url: string;
  region: string;
}
