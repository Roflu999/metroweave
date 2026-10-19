import { useEffect, useRef } from "react";
import L from "leaflet";
import type { Network, LatLng, Service } from "./types";
import {
  serviceCoordinates,
  serviceSegmentGeometries,
  haversine,
  serviceStopsAt,
  isServiceVisible,
} from "./engine";
import {
  createBasemapLayer,
  OFFLINE_BASEMAP,
  type BasemapSource,
} from "./basemaps";
import { createSVG } from "./svg";
export type MapTool =
  | "select"
  | "station"
  | "draw"
  | "bend"
  | "erase"
  | "junction"
  | "track";
export interface MapAPI {
  fit: () => void;
  zoom: (n: number) => void;
  locate: (p: LatLng) => void;
  svg: () => string;
}
type Props = {
  network: Network;
  selectedService: string;
  selectedStation: string | null;
  tool: MapTool;
  labels: boolean;
  basemap: boolean;
  mapSource: BasemapSource;
  offline: boolean;
  showInfrastructure: boolean;
  selectedTrackId: string | null;
  selectedJunctionId: string | null;
  schematic: boolean;
  playing: boolean;
  simulationSpeed: number;
  focusKey: number;
  onStation: (id: string) => void;
  onMove: (id: string, p: LatLng) => void;
  onClick: (p: LatLng) => void;
  onBend: (from: string, to: string, p: LatLng) => void;
  onWaypointMove: (key: string, index: number, p: LatLng) => void;
  onTrack: (id: string) => void;
  onJunction: (id: string) => void;
  onTrackBend: (id: string, p: LatLng) => void;
  onTrackPointMove: (id: string, index: number, p: LatLng) => void;
  onMapError: (message: string) => void;
  apiRef: React.RefObject<MapAPI | null>;
};
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export default function MapCanvas(p: Props) {
  const host = useRef<HTMLDivElement>(null),
    map = useRef<L.Map | null>(null),
    layer = useRef<L.LayerGroup | null>(null),
    tiles = useRef<L.Layer | null>(null),
    latest = useRef(p),
    elapsed = useRef(0);
  latest.current = p;
  const fit = () => {
    const n = latest.current.network;
    const points: LatLng[] = n.stations.map((s) => [s.lat, s.lng]);
    if (latest.current.showInfrastructure) {
      points.push(...(n.junctions || []).map((j) => [j.lat, j.lng] as LatLng));
      for (const track of n.tracks || [])
        for (const point of track.geometry) points.push(point);
    }
    if (points.length)
      map.current?.fitBounds(L.latLngBounds(points), {
        padding: [65, 65],
        maxZoom: 13,
        animate: false,
      });
    else map.current?.setView(n.center, n.zoom);
  };
  useEffect(() => {
    if (!host.current) return;
    const m = L.map(host.current, {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: false,
      minZoom: 2,
      maxZoom: 19,
      worldCopyJump: true,
      doubleClickZoom: false,
    }).setView(p.network.center, p.network.zoom);
    map.current = m;
    layer.current = L.layerGroup().addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) =>
      latest.current.onClick([e.latlng.wrap().lat, e.latlng.wrap().lng]),
    );
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(host.current);
    fit();
    p.apiRef.current = {
      fit,
      zoom: (n) => m.setZoom(m.getZoom() + n),
      locate: (point) => m.flyTo(point, Math.max(m.getZoom(), 14)),
      svg: () => exportSVG(latest.current.network),
    };
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
    };
  }, []);
  useEffect(() => {
    fit();
    elapsed.current = 0;
  }, [p.focusKey]);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    let cancelled = false,
      fallbackTimer: ReturnType<typeof setTimeout> | undefined,
      failed = 0,
      loaded = 0,
      usingFallback = false;
    if (tiles.current) {
      tiles.current.remove();
      tiles.current = null;
    }
    if (!p.basemap || p.schematic) return;
    const source =
      p.offline && p.mapSource.type === "online"
        ? OFFLINE_BASEMAP
        : p.mapSource;
    void createBasemapLayer(source)
      .then((layer) => {
        if (cancelled) {
          layer.remove();
          return;
        }
        tiles.current = layer;
        if (source.type === "online") {
          layer.on("loading", () => {
            failed = 0;
            loaded = 0;
          });
          layer.on("tileload", () => {
            loaded++;
          });
          layer.on("tileerror", () => {
            failed++;
            if (fallbackTimer) clearTimeout(fallbackTimer);
            fallbackTimer = setTimeout(() => {
              if (cancelled || usingFallback || failed < 2 || loaded) return;
              usingFallback = true;
              void createBasemapLayer(OFFLINE_BASEMAP)
                .then((overview) => {
                  if (cancelled) {
                    overview.remove();
                    return;
                  }
                  layer.remove();
                  tiles.current = overview;
                  overview.addTo(m);
                  latest.current.onMapError(
                    "Online tiles are unavailable. Using the offline world overview; choose a local map archive for street detail.",
                  );
                })
                .catch(() => {});
            }, 1200);
          });
        }
        layer.addTo(m);
      })
      .catch(async (e) => {
        if (cancelled) return;
        latest.current.onMapError((e as Error).message);
        if (source.id !== OFFLINE_BASEMAP.id) {
          try {
            const layer = await createBasemapLayer(OFFLINE_BASEMAP);
            if (!cancelled) {
              tiles.current = layer;
              layer.addTo(m);
            }
          } catch {
            /* Editing remains available without a basemap. */
          }
        }
      });
    return () => {
      cancelled = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (tiles.current) {
        tiles.current.remove();
        tiles.current = null;
      }
    };
  }, [p.basemap, p.schematic, p.mapSource, p.offline]);
  useEffect(() => {
    const m = map.current,
      g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const n = p.network,
      active = n.services.find((s) => s.id === p.selectedService),
      selectedRoute = n.routes.find((r) => r.id === active?.routeId);
    const all = n.services
      .filter((s) => isServiceVisible(n, s))
      .sort(
        (a, b) =>
          Number(a.id === p.selectedService) -
          Number(b.id === p.selectedService),
      );
    const seen = new Set<string>();
    for (const s of all) {
      const route = n.routes.find((r) => r.id === s.routeId)!;
      const selected = s.id === p.selectedService;
      const full = serviceCoordinates(n, s);
      if (full.length < 2) continue;
      // Shared geometry is drawn once unless an explicit service is selected.
      const signature = route.id + JSON.stringify(full);
      if (seen.has(signature) && !selected) continue;
      seen.add(signature);
      let coords = full;
      if (p.schematic) {
        coords = [];
        for (let i = 0; i < full.length - 1; i++) {
          const a = m.project(full[i]),
            b = m.project(full[i + 1]);
          const dx = b.x - a.x,
            dy = b.y - a.y,
            small = Math.min(Math.abs(dx), Math.abs(dy));
          const c = L.point(
            a.x + Math.sign(dx) * small,
            a.y + Math.sign(dy) * small,
          );
          coords.push(full[i], [m.unproject(c).lat, m.unproject(c).lng]);
        }
        coords.push(full[full.length - 1]);
      }
      L.polyline(coords, {
        color: "#ffffff",
        weight: selected ? 10 : 8,
        opacity: 0.95,
        lineCap: "round",
        interactive: false,
      }).addTo(g);
      const path = L.polyline(coords, {
        color: route.color,
        weight: selected ? 6 : 4.5,
        opacity: !selectedRoute || route.id === selectedRoute.id ? 1 : 0.62,
        dashArray:
          s.kind === "express"
            ? "12 5"
            : route.pattern === "dashed"
              ? "9 5"
              : route.pattern === "dotted"
                ? "2 7"
                : route.pattern === "dash-dot"
                  ? "10 4 2 4"
                  : undefined,
        lineJoin: "round",
        lineCap: "round",
        bubblingMouseEvents: false,
      }).addTo(g);
      path.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e.originalEvent);
        if (latest.current.tool === "bend" && selected) {
          let best = Infinity,
            key: [string, string] = ["", ""];
          const v = m.latLngToLayerPoint(e.latlng);
          for (const segment of serviceSegmentGeometries(n, s)) {
            const seg = segment.coordinates;
            for (let j = 0; j < seg.length - 1; j++) {
              const a = m.latLngToLayerPoint(seg[j]),
                b = m.latLngToLayerPoint(seg[j + 1]);
              const d = L.LineUtil.pointToSegmentDistance(v, a, b);
              if (d < best) {
                best = d;
                key = [segment.fromId, segment.toId];
              }
            }
          }
          if (key[0])
            latest.current.onBend(...key, [
              e.latlng.wrap().lat,
              e.latlng.wrap().lng,
            ]);
        }
      });
    }
    if (p.showInfrastructure) {
      for (const track of n.tracks || []) {
        const from =
            n.stations.find((v) => v.id === track.fromId) ||
            n.junctions?.find((v) => v.id === track.fromId),
          to =
            n.stations.find((v) => v.id === track.toId) ||
            n.junctions?.find((v) => v.id === track.toId);
        if (!from || !to) continue;
        const coords: LatLng[] = [
            [from.lat, from.lng],
            ...track.geometry.slice(1, -1),
            [to.lat, to.lng],
          ],
          selected = track.id === p.selectedTrackId;
        const line = L.polyline(coords, {
          color: selected
            ? "#204f45"
            : track.kind === "passing"
              ? "#188e9c"
              : "#74867a",
          weight: selected ? 7 : 2.5,
          opacity: selected ? 1 : 0.75,
          dashArray:
            track.kind === "passing"
              ? "5 4"
              : track.kind === "siding"
                ? "2 4"
                : undefined,
          bubblingMouseEvents: false,
        }).addTo(g);
        line.getElement()?.setAttribute("data-track-id", track.id);
        line.bindTooltip(escape(track.name || `${track.kind} track`), {
          sticky: true,
        });
        line.on("click", (event: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(event.originalEvent);
          if (
            latest.current.tool === "bend" &&
            latest.current.selectedTrackId === track.id
          )
            latest.current.onTrackBend(track.id, [
              event.latlng.wrap().lat,
              event.latlng.wrap().lng,
            ]);
          else latest.current.onTrack(track.id);
        });
        if (selected && p.tool === "bend")
          track.geometry.slice(1, -1).forEach((point, i) => {
            const marker = L.marker(point, {
              icon: L.divIcon({
                className: "bend-marker track-vertex",
                iconSize: [11, 11],
                iconAnchor: [5, 5],
              }),
              draggable: true,
              bubblingMouseEvents: false,
            }).addTo(g);
            marker.on("dragend", () => {
              const at = marker.getLatLng().wrap();
              latest.current.onTrackPointMove(track.id, i + 1, [
                at.lat,
                at.lng,
              ]);
            });
          });
      }
      for (const junction of n.junctions || []) {
        const selected = junction.id === p.selectedJunctionId;
        const marker = L.marker([junction.lat, junction.lng], {
          icon: L.divIcon({
            className: `junction-marker-container ${selected ? "selected" : ""}`,
            html: '<span class="junction-dot"></span>',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
          }),
          title: junction.name,
          draggable: p.tool === "select",
          bubblingMouseEvents: false,
          zIndexOffset: 1800,
        }).addTo(g);
        marker.getElement()?.setAttribute("data-junction-id", junction.id);
        marker.on("click", (e) => {
          L.DomEvent.stopPropagation(e.originalEvent);
          latest.current.onJunction(junction.id);
        });
        marker.on("dragend", () => {
          const at = marker.getLatLng().wrap();
          latest.current.onMove(junction.id, [at.lat, at.lng]);
        });
        if (selected)
          marker.bindTooltip(escape(junction.name), {
            permanent: true,
            direction: "right",
            offset: [8, 0],
            className: "station-label active-label",
          });
      }
    }
    const memberships = new Map<string, Set<string>>();
    n.services.forEach((s) =>
      s.stationIds
        .filter((_id, index) => serviceStopsAt(s, index))
        .forEach((id) => {
          if (!isServiceVisible(n, s)) return;
          if (!memberships.has(id)) memberships.set(id, new Set());
          memberships.get(id)!.add(s.routeId);
        }),
    );
    const labelItems: {
      marker: L.Marker;
      tooltip: L.Tooltip;
      priority: number;
    }[] = [];
    for (const station of n.stations) {
      const member = memberships.get(station.id),
        sel = station.id === p.selectedStation,
        inActive = active?.stationIds.includes(station.id),
        skipped =
          station.isWaypoint ||
          Boolean(
            active?.stationIds.includes(station.id) &&
              !active?.stationIds.some(
                (id, index) =>
                  id === station.id && serviceStopsAt(active, index),
              ),
          );
      const color = sel
        ? "#1b463c"
        : (inActive ? selectedRoute?.color : "#56655f") || "#56655f";
      const icon = L.divIcon({
        className: "station-marker-container",
        html: `<span class="station-dot ${station.isWaypoint ? "waypoint " : ""}${sel ? "selected " : ""}${skipped ? "skipped " : ""}${(member?.size || 0) > 1 ? "interchange" : ""}" style="--station-color:${/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color) ? color : "#56655f"}"></span>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
      const marker = L.marker([station.lat, station.lng], {
        icon,
        draggable: p.tool === "select",
        keyboard: true,
        title: station.name,
        bubblingMouseEvents: false,
        zIndexOffset: sel ? 2000 : inActive ? 1000 : 0,
      }).addTo(g);
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e.originalEvent);
        latest.current.onStation(station.id);
      });
      marker.on("dragend", () => {
        const pos = marker.getLatLng().wrap();
        latest.current.onMove(station.id, [pos.lat, pos.lng]);
      });
      if (p.labels && (!station.isWaypoint || sel || p.showInfrastructure)) {
        marker.bindTooltip(escape(station.name), {
          permanent: true,
          direction: "right",
          offset: [8, 0],
          className: `station-label ${sel ? "active-label" : ""}`,
          opacity: 1,
          interactive: false,
        });
        const tooltip = marker.getTooltip();
        if (tooltip) {
          const element = tooltip.getElement();
          if (element) element.style.visibility = "hidden";
          labelItems.push({
            marker,
            tooltip,
            priority: sel ? 3 : (member?.size || 0) > 1 ? 2 : inActive ? 1 : 0,
          });
        }
      }
    }
    if (active && p.tool === "bend")
      for (const [key, points] of Object.entries(active.waypoints)) {
        points.forEach((pos, i) => {
          const marker = L.marker(pos, {
            icon: L.divIcon({
              className: "bend-marker",
              iconSize: [10, 10],
              iconAnchor: [5, 5],
            }),
            draggable: true,
            bubblingMouseEvents: false,
          }).addTo(g);
          marker.on("dragend", () => {
            const point = marker.getLatLng().wrap();
            latest.current.onWaypointMove(key, i, [point.lat, point.lng]);
          });
        });
      }
    let labelFrame = 0;
    const layoutLabels = () => {
      const viewport = m.getContainer().getBoundingClientRect(),
        size = m.getSize(),
        cell = 80;
      type Box = { left: number; right: number; top: number; bottom: number };
      const grid = new Map<string, Box[]>(),
        placements: { element: HTMLElement; visible: boolean }[] = [];
      const sorted = [...labelItems].sort((a, b) => b.priority - a.priority);
      for (const item of sorted) {
        const element = item.tooltip.getElement();
        if (!element) continue;
        const point = m.latLngToContainerPoint(item.marker.getLatLng());
        if (
          point.x < 0 ||
          point.y < 0 ||
          point.x > size.x ||
          point.y > size.y
        ) {
          placements.push({ element, visible: false });
          continue;
        }
        const rect = element.getBoundingClientRect(),
          box = {
            left: rect.left - viewport.left - 4,
            right: rect.right - viewport.left + 4,
            top: rect.top - viewport.top - 3,
            bottom: rect.bottom - viewport.top + 3,
          };
        if (
          box.right < 0 ||
          box.left > size.x ||
          box.bottom < 0 ||
          box.top > size.y
        ) {
          placements.push({ element, visible: false });
          continue;
        }
        let collision = false;
        const x0 = Math.floor(box.left / cell),
          x1 = Math.floor(box.right / cell),
          y0 = Math.floor(box.top / cell),
          y1 = Math.floor(box.bottom / cell);
        for (let x = x0; x <= x1 && !collision; x++)
          for (let y = y0; y <= y1 && !collision; y++)
            for (const other of grid.get(`${x}:${y}`) || []) {
              if (
                box.left < other.right &&
                box.right > other.left &&
                box.top < other.bottom &&
                box.bottom > other.top
              ) {
                collision = true;
                break;
              }
            }
        const visible = !collision || item.priority === 3;
        placements.push({ element, visible });
        if (visible)
          for (let x = x0; x <= x1; x++)
            for (let y = y0; y <= y1; y++) {
              const key = `${x}:${y}`;
              if (!grid.has(key)) grid.set(key, []);
              grid.get(key)!.push(box);
            }
      }
      for (const { element, visible } of placements)
        element.style.visibility = visible ? "visible" : "hidden";
    };
    const scheduleLabels = () => {
      cancelAnimationFrame(labelFrame);
      labelFrame = requestAnimationFrame(layoutLabels);
    };
    m.on("moveend zoomend resize", scheduleLabels);
    scheduleLabels();
    return () => {
      cancelAnimationFrame(labelFrame);
      m.off("moveend zoomend resize", scheduleLabels);
    };
  }, [
    p.network,
    p.selectedService,
    p.selectedStation,
    p.labels,
    p.tool,
    p.schematic,
    p.showInfrastructure,
    p.selectedTrackId,
    p.selectedJunctionId,
  ]);
  useEffect(() => {
    const m = map.current;
    if (!m || !p.playing) return;
    const trainGroup = L.layerGroup().addTo(m),
      trains: {
        marker: L.CircleMarker;
        s: Service;
        coords: LatLng[];
        dist: number[];
        length: number;
      }[] = [];
    for (const s of p.network.services) {
      const route = p.network.routes.find((r) => r.id === s.routeId);
      if (!route || !isServiceVisible(p.network, s)) continue;
      const coords = serviceCoordinates(p.network, s);
      if (coords.length < 2) continue;
      const dist = [0];
      for (let i = 1; i < coords.length; i++)
        dist.push(dist[i - 1] + haversine(coords[i - 1], coords[i]));
      const length = dist[dist.length - 1];
      if (!length) continue;
      const marker = L.circleMarker(coords[0], {
        radius: 4,
        color: "#fff",
        weight: 2,
        fillColor: route.color,
        fillOpacity: 1,
        interactive: false,
      }).addTo(trainGroup);
      trains.push({ marker, s, coords, dist, length });
    }
    let frame = 0,
      last = performance.now();
    const animate = (now: number) => {
      elapsed.current += ((now - last) / 1000) * p.simulationSpeed;
      last = now;
      for (const [i, t] of trains.entries()) {
        const cycle =
          t.length + (t.s.direction === "both" && !t.s.loop ? t.length : 0);
        let d = ((elapsed.current * t.s.speed) / 3600 + i * 0.37) % cycle;
        if (d > t.length) d = 2 * t.length - d;
        let j = 1;
        while (j < t.dist.length - 1 && t.dist[j] < d) j++;
        const f = (d - t.dist[j - 1]) / (t.dist[j] - t.dist[j - 1] || 1);
        t.marker.setLatLng([
          t.coords[j - 1][0] + (t.coords[j][0] - t.coords[j - 1][0]) * f,
          t.coords[j - 1][1] + (t.coords[j][1] - t.coords[j - 1][1]) * f,
        ]);
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(frame);
      trainGroup.remove();
    };
  }, [p.playing, p.network, p.simulationSpeed]);
  return (
    <div
      ref={host}
      className={`map-canvas tool-${p.tool} ${p.schematic ? "schematic" : ""}`}
      aria-label="Interactive transit map"
    />
  );
}
export function exportSVG(n: Network) {
  return createSVG(n);
}
