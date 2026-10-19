export type LatLng = [number, number];
export interface Station {
  id: string;
  name: string;
  lat: number;
  lng: number;
  code?: string;
  accessible?: boolean;
  transferGroup?: string;
}
export interface Route {
  id: string;
  name: string;
  shortName: string;
  color: string;
  mode: "metro" | "rail" | "tram" | "monorail" | "maglev" | "light-metro";
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
