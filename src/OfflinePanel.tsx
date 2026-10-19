import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  Upload,
  Globe2,
  Server,
  HardDrive,
  Trash2,
  RefreshCw,
  WifiOff,
  ExternalLink,
  FolderOpen,
  Loader2,
} from "lucide-react";
import {
  type BasemapSource,
  listBasemapSources,
  importGeoJSONMap,
  importPMTilesFile,
  saveTileSource,
  removeBasemapSource,
  reattachPMTilesFile,
} from "./basemaps";
import {
  type OfflineStatus,
  getStorageEstimate,
  requestPersistentStorage,
  requestAppUpdate,
} from "./offline";
type Props = {
  status: OfflineStatus;
  source: BasemapSource;
  onSource: (source: BasemapSource) => void;
  onMessage: (message: string) => void;
  overpassEndpoint: string;
  onOverpassEndpoint: (value: string) => void;
};
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;
export default function OfflinePanel({
  status,
  source,
  onSource,
  onMessage,
  overpassEndpoint,
  onOverpassEndpoint,
}: Props) {
  const [sources, setSources] = useState<BasemapSource[]>([]),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [storage, setStorage] = useState<{
      usage: number;
      quota: number;
      persisted: boolean;
    } | null>(null),
    [reattach, setReattach] = useState<BasemapSource | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const refresh = async () => {
    try {
      setSources(await listBasemapSources());
      setStorage(await getStorageEstimate());
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const run = async (fn: () => Promise<void>) => {
    setBusy("Working…");
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const file = async (f: File) =>
    run(async () => {
      const added = reattach
        ? await reattachPMTilesFile(reattach, f)
        : f.name.toLowerCase().endsWith(".pmtiles")
          ? await importPMTilesFile(f)
          : await importGeoJSONMap(f);
      onSource(added);
      setReattach(null);
      onMessage("Local map source is ready.");
    });
  return (
    <div className="offline-panel">
      <div
        className={`offline-status-card ${status.offline ? "is-offline" : ""}`}
      >
        <span>
          {status.offline ? <WifiOff size={25} /> : <CheckCircle2 size={25} />}
        </span>
        <div>
          <strong>
            {status.ready
              ? "App installed for offline use"
              : status.supported
                ? "Preparing offline app"
                : "Offline installation unavailable"}
          </strong>
          <p>
            {status.offline
              ? "You are offline. Editing and saved projects remain available."
              : status.ready
                ? "The editor, fonts, directory and world overview are cached on this device."
                : "Offline installation completes on the production website or local production server."}
          </p>
        </div>
      </div>
      {status.error && <p className="subtle">{status.error}</p>}
      {status.updateAvailable && (
        <button className="primary full" onClick={requestAppUpdate}>
          <RefreshCw size={14} /> Update app & reload
        </button>
      )}
      <div className="section-title">BASEMAP SOURCES</div>
      <p className="muted">
        Keep the existing online map, choose the offline world overview, or
        attach a map archive hosted on your machine.
      </p>
      <div className="map-source-list">
        {sources.map((s) => (
          <div key={s.id} className={s.id === source.id ? "selected" : ""}>
            <button
              onClick={() => {
                if (s.needsReattach) {
                  setReattach(s);
                  picker.current?.click();
                } else onSource(s);
              }}
            >
              <span className="city-icon">
                {s.type === "online" ? (
                  <Globe2 size={19} />
                ) : s.storage === "server" ? (
                  <Server size={19} />
                ) : (
                  <HardDrive size={19} />
                )}
              </span>
              <span>
                <strong>{s.name}</strong>
                <small>
                  {s.needsReattach
                    ? "Reattach original archive"
                    : s.storage === "session"
                      ? "Disk file · current session"
                      : s.storage === "indexeddb"
                        ? "Stored on this device"
                        : s.storage === "bundled"
                          ? "Bundled · works offline"
                          : "Server source"}
                  {s.bytes ? ` · ${mb(s.bytes)}` : ""}
                </small>
              </span>
              {s.id === source.id && <CheckCircle2 size={17} />}
            </button>
            {!["osm-online", "offline-overview"].includes(s.id) && (
              <button
                className="icon-btn"
                aria-label={`Remove ${s.name}`}
                onClick={() =>
                  void run(async () => {
                    await removeBasemapSource(s.id);
                  })
                }
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        ))}
      </div>
      <button
        className="secondary full"
        disabled={!!busy}
        onClick={() => {
          setReattach(null);
          picker.current?.click();
        }}
      >
        <FolderOpen size={16} /> Attach PMTiles or GeoJSON map
      </button>
      <input
        ref={picker}
        className="visually-hidden"
        type="file"
        accept=".pmtiles,.geojson,.json"
        aria-label="Offline map file"
        onChange={(e) => {
          if (e.target.files?.[0]) void file(e.target.files[0]);
          e.target.value = "";
        }}
      />
      <div className="notice">
        <HardDrive size={17} />
        <p>
          Small archives can be kept in browser storage. Large world archives
          stay on disk and can be reattached, or served through the local server
          with HTTP byte-range requests. Complete workspace backups include
          GeoJSON map packs and source settings; PMTiles archives remain
          separate files.
        </p>
      </div>
      <details className="advanced">
        <summary>
          <Server size={15} /> Connect your map server
        </summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void run(async () => {
              const added = await saveTileSource({
                name: String(f.get("name")),
                url: String(f.get("url")),
                type: f.get("type") as "xyz" | "pmtiles-url",
                attribution: String(f.get("attribution")),
              });
              onSource(added);
              onMessage("Map server connected.");
            });
          }}
        >
          <label className="field">
            Source name
            <input name="name" required placeholder="My world map" />
          </label>
          <label className="field">
            Source type
            <select name="type">
              <option value="pmtiles-url">PMTiles archive URL</option>
              <option value="xyz">Raster XYZ tile URL</option>
            </select>
          </label>
          <label className="field">
            URL
            <input
              name="url"
              required
              placeholder="http://127.0.0.1:5173/maps/world.pmtiles"
            />
          </label>
          <label className="field">
            Attribution
            <input
              name="attribution"
              required
              defaultValue="© OpenStreetMap contributors · ODbL"
            />
          </label>
          <button className="primary full" disabled={!!busy}>
            <Server size={15} /> Connect map source
          </button>
        </form>
      </details>
      <div className="section-title">OSM DATA QUERY SERVER</div>
      <label className="field">
        Overpass endpoint
        <input
          value={overpassEndpoint}
          onChange={(e) => onOverpassEndpoint(e.target.value)}
          placeholder="Default public endpoints, or http://127.0.0.1:8081/api/interpreter"
        />
        <small>
          Used by world-atlas track imports. Leave blank for the existing public
          services. A configured private endpoint is used exclusively.
        </small>
      </label>
      <div className="section-title">FULL-WORLD SERVER SETUP</div>
      <p className="muted">
        The deployment folder includes a self-hosted world-map server setup.
        Supply your own licensed PMTiles archive or build it from an OSM planet
        extract. No planet-sized download is started automatically.
      </p>
      <a
        className="secondary full"
        href="https://github.com/Roflu999/metroweave/blob/main/OFFLINE.md"
        target="_blank"
        rel="noreferrer"
      >
        <ExternalLink size={14} /> Setup & storage requirements
      </a>
      {storage && (
        <div className="storage-status">
          <span>
            {mb(storage.usage)} used of {mb(storage.quota)}
          </span>
          <button
            className="text-btn"
            onClick={() =>
              void run(async () => {
                const allowed = await requestPersistentStorage();
                onMessage(
                  allowed
                    ? "Persistent device storage granted."
                    : "Browser storage remains best effort. Keep exported backups.",
                );
              })
            }
          >
            {storage.persisted
              ? "Persistent storage enabled"
              : "Request persistent storage"}
          </button>
        </div>
      )}
      {busy && (
        <p className="working-status">
          <Loader2 size={15} className="spin" />
          {busy}
        </p>
      )}
      {error && (
        <div className="error-notice" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
