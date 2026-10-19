import type { LatLng, Network } from "./types";
import { serviceCoordinates } from "./engine";

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );
const clip = (value: string, maximum: number) =>
  value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
const MAX_MERCATOR_LATITUDE = 85.05112878;

/** Standalone geographic vector export, bounded for large valid imported feeds. */
export function createSVG(network: Network): string {
  if (!network.stations.length)
    throw new Error("Add stations before exporting a map.");
  const width = 1600,
    height = 1100,
    padding = 85,
    labelLimit = 1500;
  const routes = new Map(network.routes.map((route) => [route.id, route]));
  const visibleRoutes = network.routes.filter((route) => route.visible);
  const services = network.services
    .filter((service) => routes.get(service.routeId)?.visible)
    .map((service) => ({
      service,
      coordinates: serviceCoordinates(network, service),
    }));
  const anchor = network.stations[0].lng;
  const project = (point: LatLng): LatLng => {
    const lat = Math.max(
      -MAX_MERCATOR_LATITUDE,
      Math.min(MAX_MERCATOR_LATITUDE, Number.isFinite(point[0]) ? point[0] : 0),
    );
    const lng = Number.isFinite(point[1]) ? point[1] : anchor;
    const wrapped = ((((lng - anchor + 180) % 360) + 360) % 360) - 180 + anchor;
    return [
      wrapped,
      (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 180) / Math.PI,
    ];
  };
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  const include = (point: LatLng) => {
    const [x, y] = project(point);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };
  for (const station of network.stations) include([station.lat, station.lng]);
  for (const { coordinates } of services)
    for (const point of coordinates) include(point);
  const legend = visibleRoutes.slice(0, 32),
    legendRows = Math.ceil(legend.length / 4);
  const legendHeight =
    legendRows * 19 + (visibleRoutes.length > legend.length ? 19 : 0);
  const top = 95,
    bottom =
      height -
      80 -
      legendHeight -
      (network.stations.length > labelLimit ? 18 : 0);
  const spanX = maxX - minX,
    spanY = maxY - minY;
  const scale = Math.min(
    (width - padding * 2) / (spanX || 0.05),
    (bottom - top) / (spanY || 0.05),
  );
  const offsetX = padding + (width - padding * 2 - spanX * scale) / 2;
  const offsetY = top + (bottom - top - spanY * scale) / 2;
  const xy = (point: LatLng): [number, number] => {
    const [x, y] = project(point);
    return [offsetX + (x - minX) * scale, offsetY + (maxY - y) * scale];
  };
  const position = (point: LatLng) =>
    xy(point)
      .map((value) => value.toFixed(2))
      .join(",");
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="map-title map-description">`,
    `<title id="map-title">${escape(network.name)}</title>`,
    `<desc id="map-description">Geographic transit network: ${network.stations.length} stations, ${visibleRoutes.length} visible lines, ${services.length} service patterns. Planning map; source references are embedded in metadata.</desc>`,
    `<metadata>${escape(JSON.stringify({ application: "MetroWeave", name: network.name, dataStatus: network.dataStatus, updatedAt: network.updatedAt, sources: network.sources }))}</metadata>`,
    '<rect width="100%" height="100%" fill="#f8f7f2"/>',
    '<g stroke-linecap="round" stroke-linejoin="round" font-family="Arial,sans-serif">',
  ];
  for (const { service, coordinates } of services) {
    if (coordinates.length < 2) continue;
    const route = routes.get(service.routeId)!,
      points = coordinates.map(position).join(" ");
    parts.push(
      `<g><title>${escape(route.name)} — ${escape(service.name)}</title><polyline points="${points}" fill="none" stroke="white" stroke-width="10"/><polyline points="${points}" fill="none" stroke="${escape(route.color)}" stroke-width="6"${service.kind === "express" ? ' stroke-dasharray="12 5"' : ""}/></g>`,
    );
  }
  for (let i = 0; i < network.stations.length; i++) {
    const station = network.stations[i],
      [x, y] = xy([station.lat, station.lng]);
    const px = x.toFixed(2),
      py = y.toFixed(2);
    parts.push(
      `<g><title>${escape(station.name)}</title><circle cx="${px}" cy="${py}" r="5" fill="white" stroke="#30463c" stroke-width="2"/>`,
    );
    if (i < labelLimit)
      parts.push(
        `<text x="${(x + 10).toFixed(2)}" y="${(y + 4).toFixed(2)}" font-size="11" fill="#30463c" paint-order="stroke" stroke="#f8f7f2" stroke-width="3">${escape(clip(station.name, 85))}</text>`,
      );
    parts.push("</g>");
  }
  const legendTop = height - 65 - legendHeight;
  for (let i = 0; i < legend.length; i++) {
    const route = legend[i],
      x = padding + (i % 4) * 357,
      y = legendTop + Math.floor(i / 4) * 19;
    parts.push(
      `<g><title>${escape(route.name)}</title><path d="M${x},${y} h22" stroke="${escape(route.color)}" stroke-width="5"/><text x="${x + 32}" y="${y + 4}" font-size="11" fill="#30463c">${escape(clip(`${route.shortName} · ${route.name}`, 43))}</text></g>`,
    );
  }
  if (visibleRoutes.length > legend.length)
    parts.push(
      `<text x="${padding}" y="${legendTop + legendRows * 19 + 4}" font-size="11" fill="#637067">${visibleRoutes.length - legend.length} additional visible lines are retained in the map.</text>`,
    );
  if (network.stations.length > labelLimit)
    parts.push(
      `<text x="${padding}" y="${legendTop - 13}" font-size="11" fill="#637067">${labelLimit.toLocaleString("en-US")} of ${network.stations.length.toLocaleString("en-US")} station labels shown; every station marker and its name tooltip is retained.</text>`,
    );
  const credits = network.sources.map((source) => source.title).join(" / ");
  parts.push(
    `<text x="60" y="45" fill="#204f45" font-size="24" font-weight="bold">${escape(clip(network.name, 95))}</text>`,
    `<text x="60" y="${height - 28}" font-size="10" fill="#637067">MetroWeave · ${escape(network.dataStatus)}${credits ? ` · ${escape(clip(credits, 195))}` : ""}</text>`,
    "</g></svg>",
  );
  return parts.join("");
}
