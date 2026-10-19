import { useState, useRef, useEffect, useMemo, type ReactNode } from "react";
import {
  Map as MapIcon,
  Globe2,
  Plus,
  Search,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  MousePointer2,
  MapPin,
  Route as RouteIcon,
  Spline,
  Trash2,
  Undo2,
  Redo2,
  Download,
  Upload,
  Share2,
  Layers,
  Maximize,
  Minus,
  Play,
  Pause,
  TrainFront,
  Zap,
  GitBranch,
  Repeat2,
  MoveUp,
  MoveDown,
  Copy,
  X,
  HelpCircle,
  FolderOpen,
  Save,
  ExternalLink,
  Navigation,
  Settings2,
  Clock,
  Accessibility,
  Eye,
  EyeOff,
  Loader2,
  ArrowDownToLine,
  Menu,
  Waypoints,
} from "lucide-react";
import { zlibSync, unzlibSync, strToU8, strFromU8 } from "fflate";
import type { Network, Service, Route, LatLng, CatalogEntry } from "./types";
import { demoNetwork, emptyNetwork } from "./data";
import {
  uid,
  validateNetwork,
  getNetworkStats,
  findJourney,
  routeDistance,
} from "./engine";
import { normalizeDraft, insertWaypoint, boundHistory } from "./editor";
import {
  importGTFS,
  importGeoJSON,
  exportGeoJSON,
  importOSM,
} from "./importers";
import MapCanvas, { type MapTool, type MapAPI } from "./MapCanvas";
type ModalName =
  | "atlas"
  | "library"
  | "import"
  | "export"
  | "help"
  | "route"
  | "project"
  | "new"
  | "sources"
  | null;
const STORE = "metroweave.autosave.v1",
  LIBRARY = "metroweave.library.v1";
const clone = <T,>(v: T): T => structuredClone(v);
function initialNetwork() {
  try {
    const hash = location.hash;
    if (hash.startsWith("#map=")) {
      if (hash.length > 800000) throw Error("Shared map is too large");
      const raw = atob(hash.slice(5));
      if (raw.length > 600000) throw Error("Shared map is too large");
      const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      return validateNetwork(
        JSON.parse(
          strFromU8(unzlibSync(bytes, { out: new Uint8Array(5_000_000) })),
        ),
      );
    }
    const saved = localStorage.getItem(STORE);
    if (saved) return validateNetwork(JSON.parse(saved));
  } catch (e) {
    console.warn("Saved map could not be restored", e);
  }
  return clone(demoNetwork);
}
const date = () => new Date().toISOString();
function download(name: string, value: string, type = "application/json") {
  const blob = new Blob([value], { type }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null),
    closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const dialogs = document.querySelectorAll("[role=dialog]");
      if (dialogs[dialogs.length - 1] !== ref.current) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const nodes = ref.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),a,input,select,textarea,[tabindex="0"]',
        );
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">METROWEAVE STUDIO</span>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-btn"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export default function App() {
  const [history, setHistory] = useState<{
    past: Network[];
    present: Network;
    future: Network[];
  }>(() => ({ past: [], present: initialNetwork(), future: [] }));
  const n = history.present;
  const [selectedService, setSelectedService] = useState(
      n.services[0]?.id || "",
    ),
    [selectedStation, setSelectedStation] = useState<string | null>(null),
    [tool, setTool] = useState<MapTool>("select"),
    [modal, setModal] = useState<ModalName>(null),
    [tab, setTab] = useState<"service" | "journey" | "layers">("service");
  const [labels, setLabels] = useState(true),
    [basemap, setBasemap] = useState(true),
    [schematic, setSchematic] = useState(false),
    [playing, setPlaying] = useState(false),
    [simulationSpeed, setSimulationSpeed] = useState(60),
    [focusKey, setFocusKey] = useState(0),
    [search, setSearch] = useState(""),
    [atlasSearch, setAtlasSearch] = useState(""),
    [atlasRegion, setAtlasRegion] = useState("All regions"),
    [catalog, setCatalog] = useState<{
      systems: CatalogEntry[];
      snapshotDate: string;
      coordinateNote?: string;
    } | null>(null),
    [catalogError, setCatalogError] = useState(""),
    [toast, setToast] = useState(""),
    [saved, setSaved] = useState("Saved locally"),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [mobilePanel, setMobilePanel] = useState<"routes" | "inspector" | null>(
      null,
    );
  const [journeyFrom, setJourneyFrom] = useState(""),
    [journeyTo, setJourneyTo] = useState(""),
    [confirm, setConfirm] = useState<{
      title: string;
      description: string;
      action: () => void;
    } | null>(null),
    [library, setLibrary] = useState<Network[]>(() => {
      try {
        return JSON.parse(localStorage.getItem(LIBRARY) || "[]").map(
          validateNetwork,
        );
      } catch {
        return [];
      }
    });
  const mapAPI = useRef<MapAPI | null>(null),
    upload = useRef<HTMLInputElement>(null),
    abort = useRef<AbortController | null>(null),
    toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const service =
      n.services.find((s) => s.id === selectedService) || n.services[0],
    route = n.routes.find((r) => r.id === service?.routeId),
    station = n.stations.find((s) => s.id === selectedStation),
    stats = useMemo(() => getNetworkStats(n), [n]);
  const announce = (s: string) => {
    setToast(s);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 4500);
  };
  const update = (fn: (draft: Network) => void) =>
    setHistory((h) => {
      const next = clone(h.present);
      fn(next);
      normalizeDraft(next);
      next.updatedAt = date();
      return {
        past: boundHistory([...h.past, h.present]),
        present: next,
        future: [],
      };
    });
  const patchService = (patch: Partial<Service>) => {
    if (service)
      update((d) => {
        Object.assign(d.services.find((s) => s.id === service.id)!, patch);
      });
  };
  const undo = () =>
    setHistory((h) =>
      h.past.length
        ? {
            past: h.past.slice(0, -1),
            present: h.past[h.past.length - 1],
            future: [h.present, ...h.future],
          }
        : h,
    );
  const redo = () =>
    setHistory((h) =>
      h.future.length
        ? {
            past: [...h.past, h.present],
            present: h.future[0],
            future: h.future.slice(1),
          }
        : h,
    );
  const load = (net: Network) => {
    if (n.stations.length || n.routes.length) {
      const previous = normalizeDraft(clone(n), true),
        next = [previous, ...library.filter((v) => v.id !== previous.id)].slice(
          0,
          24,
        );
      setLibrary(next);
      try {
        localStorage.setItem(LIBRARY, JSON.stringify(next));
      } catch {
        console.warn(
          "Previous map snapshot is retained in memory only; browser storage is full.",
        );
      }
    }
    setHistory({ past: [], present: clone(net), future: [] });
    setSelectedService(net.services[0]?.id || "");
    setSelectedStation(null);
    setJourneyFrom("");
    setJourneyTo("");
    setTool("select");
    setFocusKey((k) => k + 1);
    setModal(null);
    setPlaying(false);
    setError("");
    announce(`Opened ${net.name}`);
  };
  useEffect(() => {
    if (location.hash.startsWith("#map="))
      window.history.replaceState(
        null,
        "",
        location.pathname + location.search,
      );
  }, []);
  useEffect(() => {
    setSaved("Saving…");
    const persist = () => {
      try {
        localStorage.setItem(
          STORE,
          JSON.stringify(normalizeDraft(clone(n), true)),
        );
        setSaved("Saved locally");
      } catch {
        setSaved("Storage full · export a backup");
      }
    };
    const timer = setTimeout(persist, 400);
    window.addEventListener("pagehide", persist);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", persist);
    };
  }, [n]);
  useEffect(() => {
    if (modal !== "atlas" || catalog) return;
    let live = true;
    fetch(`${import.meta.env.BASE_URL}data/catalog.json`)
      .then((r) => {
        if (!r.ok) throw Error("Could not load the world directory");
        return r.json();
      })
      .then((d) => {
        if (live) setCatalog(d);
      })
      .catch((e) => setCatalogError(String(e.message)));
    return () => {
      live = false;
    };
  }, [modal, catalog]);
  const saveMap = () => {
    try {
      const next = [
        normalizeDraft(clone(n), true),
        ...library.filter((v) => v.id !== n.id),
      ].slice(0, 24);
      localStorage.setItem(LIBRARY, JSON.stringify(next));
      setLibrary(next);
      announce("Snapshot saved to My maps");
    } catch {
      announce("Browser storage is full. Export a project backup.");
    }
  };
  const deleteStation = (id: string) => {
    const s = n.stations.find((s) => s.id === id);
    if (!s) return;
    setConfirm({
      title: `Delete ${s.name}?`,
      description:
        "This removes the station from every service. You can undo this change.",
      action: () => {
        update((d) => {
          d.stations = d.stations.filter((s) => s.id !== id);
          d.services.forEach((s) => {
            s.stationIds = s.stationIds.filter((x) => x !== id);
            s.skippedStationIds = s.skippedStationIds.filter((x) => x !== id);
            s.waypoints = {};
            s.shape = undefined;
          });
        });
        setSelectedStation(null);
      },
    });
  };
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable]",
        ) ||
        modal ||
        confirm
      )
        return;
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === "z") {
          e.preventDefault();
          e.shiftKey ? redo() : undo();
        }
        if (e.key.toLowerCase() === "s") {
          e.preventDefault();
          saveMap();
        }
        return;
      }
      if (e.key === "/") {
        e.preventDefault();
        setMobilePanel("routes");
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLInputElement>(".sidebar-search input")
            ?.focus(),
        );
        return;
      }
      const keys: Record<string, MapTool> = {
        v: "select",
        s: "station",
        d: "draw",
        b: "bend",
        e: "erase",
      };
      if (keys[e.key.toLowerCase()]) setTool(keys[e.key.toLowerCase()]);
      if (e.key === "Escape") {
        setTool("select");
        setSelectedStation(null);
      }
      if (e.key === "Delete" && selectedStation) deleteStation(selectedStation);
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  });
  const addStation = (point: LatLng) => {
    const id = uid("st");
    update((d) => {
      d.stations.push({
        id,
        name: `Station ${d.stations.length + 1}`,
        lat: point[0],
        lng: point[1],
        accessible: true,
      });
      if (tool === "draw" && service) {
        const s = d.services.find((s) => s.id === service.id)!;
        s.stationIds.push(id);
        s.shape = undefined;
      }
    });
    setSelectedStation(id);
    if (tool === "draw") setSelectedStation(null);
  };
  const stationClick = (id: string) => {
    if (tool === "erase") {
      deleteStation(id);
      return;
    }
    if (tool === "draw") {
      if (!service) {
        announce("Create a line first to draw a service.");
        return;
      }
      if (service.stationIds[service.stationIds.length - 1] === id) return;
      patchService({
        stationIds: [...service.stationIds, id],
        shape: undefined,
      });
      announce("Station appended to service");
      return;
    }
    setSelectedStation(id);
    setTab("service");
  };
  const onMapClick = (point: LatLng) => {
    if (tool === "station" || tool === "draw") {
      if (tool === "draw" && !service) {
        setModal("route");
        return;
      }
      addStation(point);
    } else setSelectedStation(null);
  };
  const addBend = (from: string, to: string, point: LatLng) => {
    if (!service) return;
    patchService({
      waypoints: insertWaypoint(n, service, from, to, point),
      shape: undefined,
    });
    announce("Geometry point added. Drag the square to reshape this segment.");
  };
  const addRoute = (form: HTMLFormElement) => {
    const f = new FormData(form),
      id = uid("rt"),
      sid = uid("sv");
    const name = String(f.get("name")).trim();
    if (!name) return;
    update((d) => {
      d.routes.push({
        id,
        name,
        shortName: String(f.get("shortName") || d.routes.length + 1).slice(
          0,
          8,
        ),
        color: String(f.get("color")),
        mode: f.get("mode") as Route["mode"],
        visible: true,
      });
      d.services.push({
        id: sid,
        routeId: id,
        name: `${name} · local`,
        kind: "local",
        stationIds: [],
        skippedStationIds: [],
        waypoints: {},
        loop: false,
        direction: "both",
        headway: 5,
        speed: 40,
        dwell: 30,
      });
    });
    setSelectedService(sid);
    setSelectedStation(null);
    setModal(null);
    setTool("draw");
    announce("Click stations or empty space on the map to build the route.");
  };
  const duplicateService = (kind: "express" | "branch") => {
    if (!service) return;
    const id = uid("sv"),
      next = clone(service);
    next.id = id;
    next.name = `${route?.shortName || ""} ${kind === "express" ? "Express" : "Branch " + n.services.filter((s) => s.routeId === service.routeId).length}`;
    next.kind = kind === "express" ? "express" : "local";
    if (kind === "express") {
      next.skippedStationIds = next.stationIds.filter(
        (_, i) => i > 0 && i < next.stationIds.length - 1 && i % 3 !== 0,
      );
    } else {
      const idx = selectedStation
        ? next.stationIds.indexOf(selectedStation)
        : -1;
      next.stationIds = next.stationIds.slice(
        0,
        idx >= 0 ? idx + 1 : Math.max(1, Math.ceil(next.stationIds.length / 2)),
      );
      next.skippedStationIds = next.skippedStationIds.filter((s) =>
        next.stationIds.includes(s),
      );
      next.shape = undefined;
      next.loop = false;
    }
    update((d) => {
      d.services.push(next);
    });
    setSelectedService(id);
    setSelectedStation(null);
    setTool(kind === "branch" ? "draw" : "select");
    announce(
      kind === "express"
        ? "Express created. Choose exactly which stations it serves."
        : "Branch created from the existing trunk. Click to extend it.",
    );
  };
  const removeRoute = () => {
    if (!route) return;
    setConfirm({
      title: `Delete ${route.name}?`,
      description:
        "Its service patterns will be removed. Stations remain in the project.",
      action: () => {
        update((d) => {
          d.routes = d.routes.filter((r) => r.id !== route.id);
          d.services = d.services.filter((s) => s.routeId !== route.id);
        });
        setSelectedService(
          n.services.find((s) => s.routeId !== route.id)?.id || "",
        );
      },
    });
  };
  const handleFile = async (file: File) => {
    setError("");
    setBusy(`Importing ${file.name}…`);
    try {
      if (file.size > 60 * 1024 * 1024)
        throw Error("Please use a file smaller than 60 MB.");
      let net: Network;
      if (file.name.toLowerCase().endsWith(".zip"))
        net = await importGTFS(await file.arrayBuffer());
      else {
        const data = JSON.parse(await file.text());
        net =
          data.type === "FeatureCollection"
            ? importGeoJSON(data)
            : validateNetwork(data);
      }
      load(validateNetwork(net));
      announce(
        `Imported ${net.stations.length} stations and ${net.services.length} service patterns`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
      if (upload.current) upload.current.value = "";
    }
  };
  const openCity = (city: CatalogEntry) => {
    load(emptyNetwork(city));
    setModal(null);
    announce(
      "Empty workspace opened. Import community tracks or a local GTFS feed to populate it.",
    );
  };
  const fetchCity = async (city: CatalogEntry) => {
    abort.current = new AbortController();
    setBusy(`Fetching ${city.city} from OpenStreetMap…`);
    setError("");
    try {
      const net = await importOSM(city, abort.current.signal);
      load(validateNetwork(net));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
      abort.current = null;
    }
  };
  const loadGlasgow = async () => {
    try {
      const response = await fetch(
        `${import.meta.env.BASE_URL}data/glasgow-reference.json`,
      );
      if (!response.ok) throw Error("Could not load the Glasgow reference");
      load(validateNetwork(await response.json()));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const share = async () => {
    try {
      const bytes = zlibSync(
        strToU8(JSON.stringify(normalizeDraft(clone(n), true))),
      );
      if (bytes.length > 50000)
        throw Error(
          "This map is too large for a share link. Export a project JSON instead.",
        );
      let binary = "";
      bytes.forEach((b) => (binary += String.fromCharCode(b)));
      const url = `${location.origin}${location.pathname}#map=${btoa(binary)}`;
      await navigator.clipboard.writeText(url);
      announce("Self-contained map link copied");
    } catch (e) {
      announce(
        e instanceof Error
          ? e.message
          : "Clipboard unavailable. Export a project instead.",
      );
    }
  };
  const journey = useMemo(
    () =>
      journeyFrom && journeyTo ? findJourney(n, journeyFrom, journeyTo) : null,
    [n, journeyFrom, journeyTo],
  );
  const filteredRoutes = n.routes.filter(
    (r) =>
      !search ||
      `${r.name} ${r.shortName}`.toLowerCase().includes(search.toLowerCase()),
  );
  const stationResults = search
    ? n.stations
        .filter((s) => s.name.toLowerCase().includes(search.toLowerCase()))
        .slice(0, 7)
    : [];
  const catalogSystems = (catalog?.systems || []).filter(
    (c) =>
      (atlasRegion === "All regions" || c.region === atlasRegion) &&
      `${c.city} ${c.country} ${c.name}`
        .toLowerCase()
        .includes(atlasSearch.toLowerCase()),
  );
  const setActiveService = (id: string) => {
    setSelectedService(id);
    setSelectedStation(null);
    setTab("service");
  };
  const exportFile = (type: "json" | "geojson" | "svg") => {
    try {
      const slug =
          n.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") ||
          "metroweave-project",
        ready = normalizeDraft(clone(n), true);
      if (type === "svg")
        download(`${slug}.svg`, mapAPI.current!.svg(), "image/svg+xml");
      else
        download(
          `${slug}.${type}`,
          JSON.stringify(
            type === "json" ? ready : exportGeoJSON(ready),
            null,
            2,
          ),
        );
      announce(`${type.toUpperCase()} exported`);
    } catch (e) {
      announce((e as Error).message);
    }
  };
  return (
    <div className="studio">
      <header className="topbar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setModal("help");
          }}
          aria-label="MetroWeave home"
        >
          <span className="brand-mark">
            <Waypoints size={25} />
          </span>
          <span>
            metro<span className="brand-light">weave</span>
            <small>TRANSIT MAP STUDIO</small>
          </span>
        </a>
        <nav className="main-nav" aria-label="Main navigation">
          <button className="nav-current">
            <MapIcon size={15} /> Studio
          </button>
          <button onClick={() => setModal("atlas")}>
            <Globe2 size={15} /> World atlas{" "}
            <span className="tiny-label">EXPLORE</span>
          </button>
          <button onClick={() => setModal("library")}>
            <FolderOpen size={15} /> My maps
          </button>
        </nav>
        <div className="header-actions">
          <span className="save-state">
            <span />
            {saved}
          </span>
          <button
            className="icon-btn"
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
            disabled={!history.past.length}
            onClick={undo}
          >
            <Undo2 size={17} />
          </button>
          <button
            className="icon-btn"
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
            disabled={!history.future.length}
            onClick={redo}
          >
            <Redo2 size={17} />
          </button>
          <span className="divider" />
          <button
            className="text-btn export-trigger"
            onClick={() => setModal("export")}
          >
            <Download size={16} /> Export
          </button>
          <button className="primary small" onClick={share}>
            <Share2 size={14} /> Share map
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside
          className={`sidebar ${mobilePanel === "routes" ? "mobile-open" : ""}`}
        >
          <div className="project-intro">
            <span className="eyebrow">
              YOUR WORKSPACE <span className="local-tag">LOCAL</span>
            </span>
            <button
              className="project-title"
              onClick={() => setModal("project")}
            >
              {n.name}
              <ChevronDown size={16} />
            </button>
            <p>
              <MapPin size={12} />
              {n.city || "Imported network"}
              {n.country ? `, ${n.country}` : ""}
            </p>
          </div>
          <div className="sidebar-search">
            <Search size={16} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find a line or station…"
              aria-label="Find a line or station"
            />
            <kbd>/</kbd>
          </div>
          <div className="sidebar-heading">
            <span>
              NETWORK LINES <b>{n.routes.length.toString().padStart(2, "0")}</b>
            </span>
            <button
              className="icon-btn"
              aria-label="Add line"
              title="Add line"
              onClick={() => setModal("route")}
            >
              <Plus size={17} />
            </button>
          </div>
          <div className="route-list">
            {filteredRoutes.map((r) => {
              const services = n.services.filter((s) => s.routeId === r.id),
                ids = new Set(services.flatMap((s) => s.stationIds));
              return (
                <div
                  key={r.id}
                  className={`line-card ${route?.id === r.id ? "active" : ""}`}
                >
                  <button
                    className="line-main"
                    onClick={() => {
                      setActiveService(services[0]?.id || "");
                      setMobilePanel(null);
                    }}
                  >
                    <span
                      className="line-badge"
                      style={{ background: r.color }}
                    >
                      {r.shortName}
                    </span>
                    <span className="line-description">
                      <strong>{r.name}</strong>
                      <small>
                        {ids.size} stations <span>·</span> {services.length}{" "}
                        {services.length === 1 ? "pattern" : "patterns"}
                      </small>
                    </span>
                    <ChevronRight size={15} />
                  </button>
                  {route?.id === r.id && (
                    <div className="service-list">
                      {services.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => setActiveService(s.id)}
                          className={service?.id === s.id ? "selected" : ""}
                        >
                          <span
                            className="service-dot"
                            style={{ background: r.color }}
                          />
                          {s.name.replace(`${r.name} · `, "")}
                          <span className="pattern-kind">
                            {s.kind === "express" ? (
                              <Zap size={11} />
                            ) : s.loop ? (
                              <Repeat2 size={11} />
                            ) : s.kind === "shuttle" ? (
                              <ArrowLeft size={11} />
                            ) : null}
                            {s.kind}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {stationResults.length > 0 && (
              <div className="station-results">
                <span className="eyebrow">STATIONS</span>
                {stationResults.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      stationClick(s.id);
                      mapAPI.current?.locate([s.lat, s.lng]);
                    }}
                  >
                    <MapPin size={13} />
                    {s.name}
                    <ArrowUpRight size={12} />
                  </button>
                ))}
              </div>
            )}
            {filteredRoutes.length === 0 && !stationResults.length && (
              <div className="empty-state">
                <RouteIcon size={24} />
                <p>
                  {search
                    ? "No matching lines or stations."
                    : "Your next network starts here."}
                </p>
                <button className="text-btn" onClick={() => setModal("route")}>
                  Create a line <Plus size={14} />
                </button>
              </div>
            )}
          </div>
          <button className="add-line" onClick={() => setModal("route")}>
            <Plus size={16} /> Add a new line
          </button>
          <div className="sidebar-bottom">
            <div className="inspiration-card">
              <span className="inspiration-icon">
                <Globe2 size={22} />
              </span>
              <div>
                <strong>A world of connections.</strong>
                <p>
                  Start with a real city.
                  <br />
                  Imagine what comes next.
                </p>
                <button onClick={() => setModal("atlas")}>
                  Explore the world atlas <ArrowUpRight size={13} />
                </button>
              </div>
            </div>
            <div className="sidebar-footer">
              <button onClick={() => setModal("help")}>
                <HelpCircle size={14} /> Guide & shortcuts
              </button>
              <button
                title="Sources and attribution"
                aria-label="Sources and attribution"
                onClick={() => setModal("sources")}
              >
                <ExternalLink size={13} />
              </button>
            </div>
          </div>
        </aside>
        <main className="map-workspace">
          <div className="map-topline">
            <div className="map-context">
              <span className="dot-status" />
              {n.dataStatus === "demo"
                ? "IMAGINED NETWORK"
                : n.dataStatus === "custom"
                  ? "CUSTOM NETWORK"
                  : n.dataStatus === "imported"
                    ? "IMPORTED NETWORK"
                    : `${n.dataStatus.toUpperCase()} IMPORT`}
              <span className="map-context-divider">/</span>
              {n.city.toUpperCase()}
            </div>
            <button
              className="map-description"
              onClick={() => setModal("sources")}
            >
              {n.dataStatus === "demo"
                ? "A sandbox for big ideas"
                : "View sources & coverage"}
              <ArrowUpRight size={12} />
            </button>
          </div>
          <MapCanvas
            network={n}
            selectedService={service?.id || ""}
            selectedStation={selectedStation}
            tool={tool}
            labels={labels}
            basemap={basemap}
            schematic={schematic}
            playing={playing}
            simulationSpeed={simulationSpeed}
            focusKey={focusKey}
            onStation={stationClick}
            onMove={(id, point) =>
              update((d) => {
                const s = d.stations.find((s) => s.id === id)!;
                s.lat = point[0];
                s.lng = point[1];
                d.services
                  .filter((v) => v.stationIds.includes(id))
                  .forEach((v) => (v.shape = undefined));
              })
            }
            onClick={onMapClick}
            onBend={addBend}
            onWaypointMove={(key, index, point) => {
              if (service) {
                const ways = clone(service.waypoints);
                ways[key][index] = point;
                patchService({ waypoints: ways, shape: undefined });
              }
            }}
            apiRef={mapAPI}
          />
          <div className="map-title">
            <span className="eyebrow">MAKE ROOM FOR POSSIBILITY</span>
            <h1>
              {n.city || n.name},
              <span>
                {["demo", "custom"].includes(n.dataStatus)
                  ? "reimagined."
                  : "connected."}
              </span>
            </h1>
            <p>Every great city starts with a connection.</p>
          </div>
          <div
            className="drawing-tools"
            role="toolbar"
            aria-label="Map editing tools"
          >
            {(
              [
                {
                  id: "select",
                  icon: MousePointer2,
                  title: "Select & move (V)",
                },
                { id: "station", icon: MapPin, title: "Add station (S)" },
                { id: "draw", icon: RouteIcon, title: "Extend service (D)" },
                { id: "bend", icon: Spline, title: "Edit geometry (B)" },
                { id: "erase", icon: Trash2, title: "Delete station (E)" },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setTool(t.id);
                  if (t.id === "draw") setSelectedStation(null);
                }}
                aria-label={t.title}
                title={t.title}
                className={tool === t.id ? "active" : ""}
              >
                <t.icon size={20} />
              </button>
            ))}
            <span className="tool-separator" />
            <button
              onClick={() => setModal("import")}
              title="Import a network"
              aria-label="Import a network"
            >
              <Upload size={19} />
            </button>
          </div>
          <div className="view-toggle">
            <button
              className={!schematic ? "selected" : ""}
              onClick={() => setSchematic(false)}
            >
              <Globe2 size={13} /> Geographic
            </button>
            <button
              className={schematic ? "selected" : ""}
              onClick={() => setSchematic(true)}
            >
              <RouteIcon size={13} /> Diagram
            </button>
          </div>
          <div className="map-legend">
            <span>
              <i className="legend-local" />
              Local
            </span>
            <span>
              <i className="legend-express" />
              Express
            </span>
            <span>
              <i className="legend-interchange" />
              Interchange
            </span>
          </div>
          <div className="map-controls">
            <button
              aria-label="Map layers"
              title="Map layers"
              onClick={() => {
                setTab("layers");
                setMobilePanel("inspector");
              }}
            >
              <Layers size={18} />
            </button>
            <span />
            <button
              aria-label="Zoom in"
              title="Zoom in"
              onClick={() => mapAPI.current?.zoom(1)}
            >
              <Plus size={19} />
            </button>
            <button
              aria-label="Zoom out"
              title="Zoom out"
              onClick={() => mapAPI.current?.zoom(-1)}
            >
              <Minus size={19} />
            </button>
            <span />
            <button
              aria-label="Fit network"
              title="Fit network"
              onClick={() => mapAPI.current?.fit()}
            >
              <Maximize size={17} />
            </button>
          </div>
          <div className="tool-hint">
            <span className="hint-key">
              {tool === "select"
                ? "V"
                : tool === "station"
                  ? "S"
                  : tool === "draw"
                    ? "D"
                    : tool === "bend"
                      ? "B"
                      : "E"}
            </span>
            {tool === "select"
              ? "Click to inspect · Drag a station to move it"
              : tool === "station"
                ? "Click anywhere to place a station"
                : tool === "draw"
                  ? `Building ${service?.name || "a new service"} · Click a station or the map`
                  : tool === "bend"
                    ? "Click the selected service to add a bend · Drag squares to reshape"
                    : "Click a station to delete it"}
            <button onClick={() => setModal("help")} aria-label="Editing help">
              <HelpCircle size={13} />
            </button>
          </div>
          <div className="mobile-buttons">
            <button
              onClick={() =>
                setMobilePanel(mobilePanel === "routes" ? null : "routes")
              }
            >
              <Menu size={16} /> Lines
            </button>
            <button
              onClick={() =>
                setMobilePanel(mobilePanel === "inspector" ? null : "inspector")
              }
            >
              <Settings2 size={16} /> Inspector
            </button>
          </div>
        </main>
        <aside
          className={`inspector ${mobilePanel === "inspector" ? "mobile-open" : ""}`}
        >
          <div className="inspector-tabs">
            <button
              className={tab === "service" ? "selected" : ""}
              onClick={() => setTab("service")}
            >
              Inspector
            </button>
            <button
              className={tab === "journey" ? "selected" : ""}
              onClick={() => setTab("journey")}
            >
              Journey
            </button>
            <button
              className={tab === "layers" ? "selected" : ""}
              onClick={() => setTab("layers")}
            >
              Layers
            </button>
          </div>
          <div className="inspector-content">
            {tab === "service" &&
              (station ? (
                <>
                  <button
                    className="back-link"
                    onClick={() => setSelectedStation(null)}
                  >
                    <ArrowLeft size={13} /> Back to service
                  </button>
                  <div className="inspector-title">
                    <span className="station-icon">
                      <MapPin size={21} />
                    </span>
                    <div>
                      <span className="eyebrow">STATION DETAILS</span>
                      <h2>{station.name}</h2>
                    </div>
                  </div>
                  <label className="field">
                    Station name
                    <input
                      value={station.name}
                      maxLength={140}
                      onChange={(e) =>
                        update((d) => {
                          d.stations.find((s) => s.id === station.id)!.name =
                            e.target.value;
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    Station code
                    <input
                      value={station.code || ""}
                      maxLength={20}
                      placeholder="Optional"
                      onChange={(e) =>
                        update((d) => {
                          d.stations.find((s) => s.id === station.id)!.code =
                            e.target.value;
                        })
                      }
                    />
                  </label>
                  <div className="field-row">
                    <label className="field">
                      Latitude
                      <input
                        type="number"
                        step="0.0001"
                        min="-85"
                        max="85"
                        value={station.lat}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && Math.abs(v) <= 85)
                            update((d) => {
                              d.stations.find((s) => s.id === station.id)!.lat =
                                v;
                              d.services
                                .filter((s) =>
                                  s.stationIds.includes(station.id),
                                )
                                .forEach((s) => (s.shape = undefined));
                            });
                        }}
                      />
                    </label>
                    <label className="field">
                      Longitude
                      <input
                        type="number"
                        step="0.0001"
                        min="-180"
                        max="180"
                        value={station.lng}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && Math.abs(v) <= 180)
                            update((d) => {
                              d.stations.find((s) => s.id === station.id)!.lng =
                                v;
                              d.services
                                .filter((s) =>
                                  s.stationIds.includes(station.id),
                                )
                                .forEach((s) => (s.shape = undefined));
                            });
                        }}
                      />
                    </label>
                  </div>
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={station.accessible ?? false}
                      onChange={(e) =>
                        update((d) => {
                          d.stations.find(
                            (s) => s.id === station.id,
                          )!.accessible = e.target.checked;
                        })
                      }
                    />
                    <Accessibility size={15} />
                    {station.accessible === undefined
                      ? "Step-free access (not specified)"
                      : "Step-free access"}
                  </label>
                  <label className="field">
                    Walking interchange group
                    <input
                      placeholder="Same value links separate platforms"
                      value={station.transferGroup || ""}
                      onChange={(e) =>
                        update((d) => {
                          d.stations.find(
                            (s) => s.id === station.id,
                          )!.transferGroup = e.target.value || undefined;
                        })
                      }
                    />
                    <small>
                      Use the same group on nearby stations to allow walking
                      transfers in the journey planner.
                    </small>
                  </label>
                  <div className="section-title">SERVICES AT THIS STATION</div>
                  <div className="station-services">
                    {n.services
                      .filter((s) => s.stationIds.includes(station.id))
                      .map((s) => (
                        <button
                          key={s.id}
                          onClick={() => setActiveService(s.id)}
                        >
                          <span
                            style={{
                              background: n.routes.find(
                                (r) => r.id === s.routeId,
                              )?.color,
                            }}
                          />
                          {s.name}
                          <small>
                            {s.skippedStationIds.includes(station.id)
                              ? "passes"
                              : "stops"}
                          </small>
                        </button>
                      ))}
                  </div>
                  {service?.stationIds.includes(station.id) && (
                    <button
                      className="secondary full"
                      onClick={() => duplicateService("branch")}
                    >
                      <GitBranch size={15} /> Branch selected service from here
                    </button>
                  )}
                  <button
                    className="secondary full"
                    onClick={() => {
                      setJourneyFrom(station.id);
                      setTab("journey");
                    }}
                  >
                    <Navigation size={15} /> Plan a journey from here
                  </button>
                  <button
                    className="danger-link"
                    onClick={() => deleteStation(station.id)}
                  >
                    <Trash2 size={14} /> Delete station
                  </button>
                </>
              ) : service && route ? (
                <>
                  <div className="inspector-title">
                    <span
                      className="big-badge"
                      style={{ background: route.color }}
                    >
                      {route.shortName}
                    </span>
                    <div>
                      <span className="eyebrow">LINE & SERVICE</span>
                      <h2>{route.name}</h2>
                      <span className="service-type">
                        <span style={{ background: route.color }} />
                        {service.kind === "express"
                          ? "Express service"
                          : service.loop
                            ? "Orbital service"
                            : "Local service"}
                      </span>
                    </div>
                  </div>
                  <div className="service-summary">
                    <div>
                      <strong>
                        {
                          service.stationIds.filter(
                            (s) => !service.skippedStationIds.includes(s),
                          ).length
                        }
                      </strong>
                      <span>stops</span>
                    </div>
                    <div>
                      <strong>
                        {routeDistance(n, service).toFixed(1)}
                        <small> km</small>
                      </strong>
                      <span>route length</span>
                    </div>
                    <div>
                      <strong>
                        {service.headway}
                        <small> min</small>
                      </strong>
                      <span>headway</span>
                    </div>
                  </div>
                  <label className="field compact">
                    Service pattern
                    <select
                      value={service.id}
                      onChange={(e) => setActiveService(e.target.value)}
                    >
                      {n.services
                        .filter((s) => s.routeId === route.id)
                        .map((s) => (
                          <option value={s.id} key={s.id}>
                            {s.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="field compact">
                    Service name
                    <input
                      value={service.name}
                      maxLength={140}
                      onChange={(e) => patchService({ name: e.target.value })}
                    />
                  </label>
                  <div className="pattern-actions">
                    <button
                      onClick={() => duplicateService("express")}
                      title="Duplicate as an express pattern"
                    >
                      <Zap size={14} /> Express
                    </button>
                    <button
                      onClick={() => duplicateService("branch")}
                      title="Duplicate a trunk and extend a new branch"
                    >
                      <GitBranch size={14} /> Branch
                    </button>
                    <button
                      className={service.loop ? "toggled" : ""}
                      onClick={() => patchService({ loop: !service.loop })}
                      aria-pressed={service.loop}
                    >
                      <Repeat2 size={14} /> Loop
                    </button>
                  </div>
                  <div className="section-heading">
                    <span className="section-title">STOPPING PATTERN</span>
                    <span className="count-label">
                      {service.stationIds.length} on path
                    </span>
                  </div>
                  <p className="subtle stopping-help">
                    {service.kind === "express"
                      ? "Filled circles stop. Hollow circles pass through."
                      : "Click a stop circle to change whether trains stop."}
                  </p>
                  <ol className="stop-list">
                    {service.stationIds.map((id, index) => {
                      const st = n.stations.find((s) => s.id === id);
                      if (!st) return null;
                      const skipped = service.skippedStationIds.includes(id);
                      return (
                        <li
                          key={`${id}-${index}`}
                          style={
                            {
                              "--line-color": route.color,
                            } as React.CSSProperties
                          }
                        >
                          <button
                            className={`stop-circle ${skipped ? "skip" : ""}`}
                            title={
                              skipped
                                ? "Passes through — click to stop"
                                : "Stops here — click to skip"
                            }
                            aria-label={`${skipped ? "Make stop at" : "Skip"} ${st.name}`}
                            onClick={() =>
                              patchService({
                                skippedStationIds: skipped
                                  ? service.skippedStationIds.filter(
                                      (x) => x !== id,
                                    )
                                  : [...service.skippedStationIds, id],
                              })
                            }
                          />
                          <button
                            className="stop-name"
                            onClick={() => {
                              setSelectedStation(id);
                              mapAPI.current?.locate([st.lat, st.lng]);
                            }}
                          >
                            {st.name}
                            {skipped && <small>PASS</small>}
                          </button>
                          <div className="stop-actions">
                            <button
                              title="Move stop up"
                              aria-label={`Move ${st.name} up`}
                              disabled={index === 0}
                              onClick={() => {
                                const ids = [...service.stationIds];
                                [ids[index], ids[index - 1]] = [
                                  ids[index - 1],
                                  ids[index],
                                ];
                                patchService({
                                  stationIds: ids,
                                  shape: undefined,
                                  waypoints: {},
                                });
                              }}
                            >
                              <MoveUp size={11} />
                            </button>
                            <button
                              title="Move stop down"
                              aria-label={`Move ${st.name} down`}
                              disabled={index === service.stationIds.length - 1}
                              onClick={() => {
                                const ids = [...service.stationIds];
                                [ids[index], ids[index + 1]] = [
                                  ids[index + 1],
                                  ids[index],
                                ];
                                patchService({
                                  stationIds: ids,
                                  shape: undefined,
                                  waypoints: {},
                                });
                              }}
                            >
                              <MoveDown size={11} />
                            </button>
                            <button
                              title="Remove from this service"
                              aria-label={`Remove ${st.name} from service`}
                              onClick={() =>
                                patchService({
                                  stationIds: service.stationIds.filter(
                                    (_, i) => i !== index,
                                  ),
                                  shape: undefined,
                                  waypoints: {},
                                })
                              }
                            >
                              <X size={11} />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                  <button
                    className="extend-button"
                    onClick={() => {
                      setTool("draw");
                      setSelectedStation(null);
                    }}
                  >
                    <Plus size={14} /> Extend this service
                  </button>
                  <details
                    className="advanced"
                    open={service.stationIds.length === 0}
                  >
                    <summary>
                      <Settings2 size={14} /> Service settings
                      <ChevronDown size={13} />
                    </summary>
                    <div className="field-row">
                      <label className="field">
                        Pattern type
                        <select
                          value={service.kind}
                          onChange={(e) =>
                            patchService({
                              kind: e.target.value as Service["kind"],
                            })
                          }
                        >
                          <option value="local">Local</option>
                          <option value="express">Express</option>
                          <option value="limited">Limited</option>
                          <option value="shuttle">Shuttle</option>
                        </select>
                      </label>
                      <label className="field">
                        Direction
                        <select
                          value={service.direction}
                          onChange={(e) =>
                            patchService({
                              direction: e.target.value as Service["direction"],
                            })
                          }
                        >
                          <option value="both">Both ways</option>
                          <option value="forward">One way</option>
                        </select>
                      </label>
                    </div>
                    <div className="field-row">
                      <label className="field">
                        Headway (min)
                        <input
                          type="number"
                          min="0.5"
                          max="180"
                          step="0.5"
                          value={service.headway}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (v >= 0.5 && v <= 180)
                              patchService({ headway: v });
                          }}
                        />
                      </label>
                      <label className="field">
                        Speed (km/h)
                        <input
                          type="number"
                          min="5"
                          max="600"
                          value={service.speed}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (v >= 5 && v <= 600) patchService({ speed: v });
                          }}
                        />
                      </label>
                    </div>
                    <label className="field">
                      Dwell per stop (seconds)
                      <input
                        type="number"
                        min="0"
                        max="600"
                        value={service.dwell}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (v >= 0 && v <= 600) patchService({ dwell: v });
                        }}
                      />
                    </label>
                    <button
                      className="secondary full"
                      onClick={() =>
                        patchService({
                          stationIds: [...service.stationIds].reverse(),
                          shape: service.shape
                            ? [...service.shape].reverse()
                            : undefined,
                        })
                      }
                    >
                      <Repeat2 size={13} /> Reverse stopping order
                    </button>
                    <button
                      className="secondary full"
                      onClick={() =>
                        patchService({ waypoints: {}, shape: undefined })
                      }
                    >
                      <Spline size={13} /> Reset custom geometry
                    </button>
                    {n.services.filter((s) => s.routeId === route.id).length >
                      1 && (
                      <button
                        className="danger-link"
                        onClick={() => {
                          update((d) => {
                            d.services = d.services.filter(
                              (s) => s.id !== service.id,
                            );
                          });
                          setSelectedService(
                            n.services.find(
                              (s) =>
                                s.routeId === route.id && s.id !== service.id,
                            )?.id || "",
                          );
                        }}
                      >
                        <Trash2 size={12} /> Delete this pattern
                      </button>
                    )}
                  </details>
                  <details className="advanced">
                    <summary>
                      <RouteIcon size={14} /> Line settings
                      <ChevronDown size={13} />
                    </summary>
                    <label className="field">
                      Line name
                      <input
                        value={route.name}
                        onChange={(e) =>
                          update((d) => {
                            d.routes.find((r) => r.id === route.id)!.name =
                              e.target.value;
                          })
                        }
                      />
                    </label>
                    <div className="field-row">
                      <label className="field">
                        Badge
                        <input
                          value={route.shortName}
                          maxLength={8}
                          onChange={(e) =>
                            update((d) => {
                              d.routes.find(
                                (r) => r.id === route.id,
                              )!.shortName = e.target.value;
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        Colour
                        <input
                          type="color"
                          value={route.color}
                          onChange={(e) =>
                            update((d) => {
                              d.routes.find((r) => r.id === route.id)!.color =
                                e.target.value;
                            })
                          }
                        />
                      </label>
                    </div>
                    <label className="field">
                      Mode
                      <select
                        value={route.mode}
                        onChange={(e) =>
                          update((d) => {
                            d.routes.find((r) => r.id === route.id)!.mode = e
                              .target.value as Route["mode"];
                          })
                        }
                      >
                        {[
                          "metro",
                          "rail",
                          "tram",
                          "monorail",
                          "maglev",
                          "light-metro",
                        ].map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                    </label>
                    <button className="danger-link" onClick={removeRoute}>
                      <Trash2 size={13} /> Delete line and its patterns
                    </button>
                  </details>
                </>
              ) : (
                <div className="empty-state">
                  <RouteIcon size={32} />
                  <h3>Connect your first stations.</h3>
                  <p>Create a line, then click the map to build its path.</p>
                  <button className="primary" onClick={() => setModal("route")}>
                    <Plus size={15} /> Create a line
                  </button>
                </div>
              ))}
            {tab === "journey" && (
              <>
                <div className="inspector-title">
                  <span className="station-icon">
                    <Navigation size={22} />
                  </span>
                  <div>
                    <span className="eyebrow">EXPLORE CONNECTIONS</span>
                    <h2>Journey planner</h2>
                  </div>
                </div>
                <p className="muted">
                  Find a path through your network, including express patterns
                  and walking interchanges.
                </p>
                <label className="field">
                  From
                  <select
                    value={journeyFrom}
                    onChange={(e) => setJourneyFrom(e.target.value)}
                  >
                    <option value="">Choose a station</option>
                    {n.stations.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="swap-button"
                  aria-label="Swap origin and destination"
                  onClick={() => {
                    setJourneyFrom(journeyTo);
                    setJourneyTo(journeyFrom);
                  }}
                >
                  <Repeat2 size={15} />
                </button>
                <label className="field">
                  To
                  <select
                    value={journeyTo}
                    onChange={(e) => setJourneyTo(e.target.value)}
                  >
                    <option value="">Choose a station</option>
                    {n.stations.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                {journeyFrom &&
                  journeyTo &&
                  (journey ? (
                    <div className="journey-result">
                      <div>
                        <strong>
                          {Math.ceil(journey.minutes)} <small>min</small>
                        </strong>
                        <span>
                          {journey.transfers}{" "}
                          {journey.transfers === 1 ? "transfer" : "transfers"}
                        </span>
                      </div>
                      {journey.legs.map((leg, i) => {
                        const s = n.services.find(
                            (s) => s.id === leg.serviceId,
                          ),
                          r = n.routes.find((r) => r.id === s?.routeId);
                        return (
                          <div className="journey-leg" key={i}>
                            <span
                              className="journey-leg-color"
                              style={{ background: r?.color || "#90a19a" }}
                            />
                            <strong>{s?.name || "Walk to interchange"}</strong>
                            <p>
                              {
                                n.stations.find((s) => s.id === leg.fromId)
                                  ?.name
                              }
                              <ArrowRight size={12} />
                              {n.stations.find((s) => s.id === leg.toId)?.name}
                            </p>
                            <small>
                              {Math.ceil(leg.minutes)} min
                              {s?.kind === "express" ? " · Express" : ""}
                            </small>
                          </div>
                        );
                      })}
                      <p className="subtle">
                        Planning estimate: geometry, configured speed, stop
                        dwell and half-headway waiting. Includes 3 minutes per
                        interchange. No live timetable.
                      </p>
                    </div>
                  ) : (
                    <div className="notice">
                      No service path connects these stations. Check stopping
                      patterns, directions and interchange groups.
                    </div>
                  ))}
                <div className="inspector-note">
                  <Clock size={16} />
                  <p>
                    Design decisions change journeys. Try an express pattern and
                    compare the result.
                  </p>
                </div>
              </>
            )}
            {tab === "layers" && (
              <>
                <div className="inspector-title">
                  <span className="station-icon">
                    <Layers size={22} />
                  </span>
                  <div>
                    <span className="eyebrow">YOUR MAP, YOUR VIEW</span>
                    <h2>Map layers</h2>
                  </div>
                </div>
                <label className="toggle-row">
                  <span>
                    <MapIcon size={16} /> Street basemap
                  </span>
                  <input
                    type="checkbox"
                    checked={basemap}
                    onChange={(e) => setBasemap(e.target.checked)}
                  />
                </label>
                <label className="toggle-row">
                  <span>
                    <MapPin size={16} /> Station labels
                  </span>
                  <input
                    type="checkbox"
                    checked={labels}
                    onChange={(e) => setLabels(e.target.checked)}
                  />
                </label>
                <label className="toggle-row">
                  <span>
                    <RouteIcon size={16} /> Diagram view
                  </span>
                  <input
                    type="checkbox"
                    checked={schematic}
                    onChange={(e) => setSchematic(e.target.checked)}
                  />
                </label>
                <p className="subtle">
                  Diagram view draws 45° bends between station coordinates. It
                  is a simplified geographic view, rather than an optimized
                  schematic layout.
                </p>
                <div className="section-title">LINE VISIBILITY</div>
                {n.routes.map((r) => (
                  <label key={r.id} className="toggle-row">
                    <span>
                      <i
                        className="color-square"
                        style={{ background: r.color }}
                      />
                      {r.name}
                    </span>
                    <input
                      type="checkbox"
                      checked={r.visible}
                      onChange={(e) =>
                        update((d) => {
                          d.routes.find((v) => v.id === r.id)!.visible =
                            e.target.checked;
                        })
                      }
                    />
                  </label>
                ))}
                <button
                  className="secondary full"
                  onClick={() => mapAPI.current?.fit()}
                >
                  <Maximize size={14} /> Fit entire network
                </button>
                <button
                  className="secondary full"
                  onClick={() => setModal("sources")}
                >
                  <ExternalLink size={14} /> Sources & coverage
                </button>
              </>
            )}
          </div>
          <div className="inspector-bottom">
            <span className="green-dot" />
            <span>Built for the way cities really work.</span>
            <GitBranch size={13} />
          </div>
        </aside>
      </div>
      <footer className="simulation-bar">
        <div className="simulation-label">
          <span className="train-icon">
            <TrainFront size={20} />
          </span>
          <div>
            <strong>Bring your network to life</strong>
            <span>
              Geometry preview <span>·</span> No timetable simulation
            </span>
          </div>
        </div>
        <div className="playback">
          <button
            className={`play-button ${playing ? "playing" : ""}`}
            aria-label={playing ? "Pause train preview" : "Play train preview"}
            onClick={() => setPlaying(!playing)}
          >
            {playing ? (
              <Pause size={17} />
            ) : (
              <Play size={17} fill="currentColor" />
            )}
          </button>
          <div className="simulation-wave">
            <i className={playing ? "animated" : ""} />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <select
            aria-label="Preview speed"
            value={simulationSpeed}
            onChange={(e) => setSimulationSpeed(Number(e.target.value))}
          >
            <option value="15">15× speed</option>
            <option value="60">60× speed</option>
            <option value="180">180× speed</option>
          </select>
        </div>
        <div className="network-stats">
          <div>
            <strong>{stats.routes}</strong>
            <span>lines</span>
          </div>
          <div>
            <strong>{stats.stations}</strong>
            <span>stations</span>
          </div>
          <div>
            <strong>{stats.services}</strong>
            <span>patterns</span>
          </div>
          <div>
            <strong>
              {stats.trackKm.toFixed(1)}
              <small> km</small>
            </strong>
            <span>track estimate</span>
          </div>
        </div>
      </footer>
      <input
        ref={upload}
        className="visually-hidden"
        type="file"
        accept=".json,.geojson,.zip"
        onChange={(e) => {
          if (e.target.files?.[0]) void handleFile(e.target.files[0]);
        }}
        aria-label="Import project file"
      />
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {modal && (
        <Modal
          title={
            modal === "atlas"
              ? "A world worth connecting."
              : modal === "library"
                ? "Your ideas, kept close."
                : modal === "import"
                  ? "Start with real connections."
                  : modal === "export"
                    ? "Take your network with you."
                    : modal === "route"
                      ? "Make a new connection."
                      : modal === "new"
                        ? "Your next great network."
                        : modal === "project"
                          ? "Project details"
                          : modal === "sources"
                            ? "Sources & coverage"
                            : "Welcome to MetroWeave."
          }
          subtitle={
            modal === "atlas"
              ? "Discover metro systems around the world. Open a workspace or import community route data."
              : modal === "import"
                ? "Bring a project, geographic network or transit feed into the studio."
                : undefined
          }
          wide={modal === "atlas" || modal === "help"}
          onClose={() => {
            if (!busy) setModal(null);
          }}
        >
          {modal === "atlas" && (
            <>
              <button
                className="reference-banner"
                onClick={() => void loadGlasgow()}
              >
                <span className="city-icon">
                  <Repeat2 size={21} />
                </span>
                <span>
                  <strong>Explore a real network: Glasgow Subway</strong>
                  <small>
                    15 stations · Both circular directions · SPT-verified stop
                    order
                  </small>
                </span>
                <ArrowUpRight size={17} />
              </button>
              <div className="atlas-search-row">
                <div className="sidebar-search">
                  <Search size={18} />
                  <input
                    value={atlasSearch}
                    onChange={(e) => setAtlasSearch(e.target.value)}
                    placeholder="Try Tokyo, São Paulo, or South Korea…"
                    aria-label="Search world atlas"
                  />
                </div>
                <select
                  value={atlasRegion}
                  onChange={(e) => setAtlasRegion(e.target.value)}
                  aria-label="Filter region"
                >
                  <option>All regions</option>
                  {Array.from(new Set(catalog?.systems.map((c) => c.region)))
                    .sort()
                    .map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                </select>
              </div>
              <div className="atlas-meta">
                <span>{catalogSystems.length} systems in the directory</span>
                <span>
                  Wikipedia snapshot · {catalog?.snapshotDate || "loading"}
                </span>
              </div>
              <div className="atlas-grid">
                {catalogError && (
                  <div className="error-notice">{catalogError}</div>
                )}
                {!catalog && !catalogError && (
                  <div className="empty-state">
                    <Loader2 className="spin" />
                    Loading the world directory…
                  </div>
                )}
                {catalogSystems.slice(0, 250).map((c) => (
                  <article className="city-card" key={c.id}>
                    <div className="city-card-heading">
                      <span className="city-icon">
                        <Globe2 size={20} />
                      </span>
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noreferrer"
                        title="System reference"
                      >
                        <ArrowUpRight size={15} />
                      </a>
                    </div>
                    <span className="eyebrow">{c.country}</span>
                    <h3>{c.city}</h3>
                    <p>{c.name}</p>
                    <div className="city-actions">
                      <button className="text-btn" onClick={() => openCity(c)}>
                        Open workspace <ArrowRight size={13} />
                      </button>
                      <button
                        className="icon-btn"
                        title={`Import ${c.city} tracks from OpenStreetMap`}
                        aria-label={`Import ${c.city} tracks`}
                        disabled={!!busy}
                        onClick={() => void fetchCity(c)}
                      >
                        <ArrowDownToLine size={16} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              <div className="notice">
                <Globe2 size={17} />
                <p>
                  This is a system directory, not a complete worldwide track
                  database. Imports use community data and may omit routes or
                  stopping patterns. {catalog?.coordinateNote}
                </p>
              </div>
              <button
                className="text-btn"
                onClick={() => {
                  load(clone(demoNetwork));
                }}
              >
                Try the London sandbox <ArrowUpRight size={13} />
              </button>
            </>
          )}
          {modal === "library" && (
            <>
              <div className="library-actions">
                <button className="primary" onClick={() => setModal("new")}>
                  <Plus size={16} /> New map
                </button>
                <button className="secondary" onClick={saveMap}>
                  <Save size={16} /> Save current snapshot
                </button>
              </div>
              {library.length ? (
                library.map((v) => (
                  <div className="library-item" key={v.id}>
                    <span className="city-icon">
                      <MapIcon size={20} />
                    </span>
                    <button onClick={() => load(v)}>
                      <strong>{v.name}</strong>
                      <small>
                        {v.city} · {v.routes.length} lines · {v.stations.length}{" "}
                        stations
                      </small>
                    </button>
                    <button
                      className="icon-btn"
                      aria-label={`Delete saved ${v.name}`}
                      onClick={() => {
                        const next = library.filter((s) => s.id !== v.id);
                        localStorage.setItem(LIBRARY, JSON.stringify(next));
                        setLibrary(next);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              ) : (
                <div className="empty-state">
                  <FolderOpen size={32} />
                  <h3>A home for your networks.</h3>
                  <p>
                    Save a snapshot to keep it here. Your current work autosaves
                    separately in this browser.
                  </p>
                </div>
              )}
              <div className="notice">
                Maps are stored on this device and browser. Export a project
                JSON for a durable backup or to move it to another device.
              </div>
            </>
          )}
          {modal === "import" && (
            <>
              <button
                className="upload-zone"
                disabled={!!busy}
                onClick={() => upload.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files[0])
                    void handleFile(e.dataTransfer.files[0]);
                }}
              >
                <span>
                  <Upload size={27} />
                </span>
                <strong>Drop a network here</strong>
                <p>or click to choose a file</p>
                <small>
                  MetroWeave JSON · GeoJSON · GTFS ZIP · up to 60 MB
                </small>
              </button>
              <div className="import-types">
                <div>
                  <strong>Project JSON</strong>
                  <p>
                    Restore all stations, route geometry, branches and service
                    settings.
                  </p>
                </div>
                <div>
                  <strong>GeoJSON</strong>
                  <p>
                    Import station points and route lines with geographic
                    coordinates.
                  </p>
                </div>
                <div>
                  <strong>GTFS schedule feed</strong>
                  <p>
                    Import routes, trip patterns, stations and shapes.
                    Timetables and service dates are not simulated.
                  </p>
                </div>
              </div>
              <button
                className="secondary full"
                onClick={() => setModal("atlas")}
              >
                <Globe2 size={15} /> Import from the world atlas
              </button>
            </>
          )}
          {modal === "export" && (
            <>
              <div className="export-options">
                {[
                  {
                    key: "json",
                    icon: FolderOpen,
                    title: "Project file",
                    desc: "All geometry, stations and service settings. Reopen it in MetroWeave.",
                    tag: ".JSON",
                  },
                  {
                    key: "svg",
                    icon: MapIcon,
                    title: "Vector map",
                    desc: "A clean, scalable geographic map for printing and illustration.",
                    tag: ".SVG",
                  },
                  {
                    key: "geojson",
                    icon: Globe2,
                    title: "Geographic data",
                    desc: "Station and route features for GIS software and other tools.",
                    tag: ".GEOJSON",
                  },
                ].map((x) => (
                  <button
                    key={x.key}
                    onClick={() =>
                      exportFile(x.key as "json" | "svg" | "geojson")
                    }
                  >
                    <span className="city-icon">
                      <x.icon size={22} />
                    </span>
                    <div>
                      <strong>{x.title}</strong>
                      <p>{x.desc}</p>
                    </div>
                    <span className="format-tag">{x.tag}</span>
                    <Download size={17} />
                  </button>
                ))}
              </div>
              <div className="notice">
                Vector exports contain the transit network without street-map
                tiles. Source attribution is included in your project file.
              </div>
              <button className="secondary full" onClick={share}>
                <Share2 size={15} /> Copy a self-contained share link
              </button>
            </>
          )}
          {modal === "route" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                addRoute(e.currentTarget);
              }}
            >
              <label className="field">
                Line name
                <input
                  name="name"
                  required
                  autoFocus
                  placeholder="e.g. Riverside line"
                  maxLength={100}
                />
              </label>
              <div className="field-row">
                <label className="field">
                  Badge
                  <input
                    name="shortName"
                    required
                    placeholder={`${n.routes.length + 1}`}
                    defaultValue={`${n.routes.length + 1}`}
                    maxLength={8}
                  />
                </label>
                <label className="field">
                  Line colour
                  <input
                    name="color"
                    type="color"
                    defaultValue={
                      [
                        "#36866b",
                        "#cf6a54",
                        "#6489b5",
                        "#af8f46",
                        "#9473aa",
                        "#d68c56",
                      ][n.routes.length % 6]
                    }
                  />
                </label>
              </div>
              <label className="field">
                Mode
                <select name="mode">
                  {[
                    "metro",
                    "rail",
                    "tram",
                    "monorail",
                    "maglev",
                    "light-metro",
                  ].map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </label>
              <div className="notice">
                Each line can have multiple service patterns: local, express,
                branches and loops. Start by drawing its first pattern.
              </div>
              <button className="primary full" type="submit">
                <Plus size={15} /> Create line & start drawing
              </button>
            </form>
          )}
          {modal === "new" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget),
                  net = emptyNetwork();
                net.name = String(f.get("name"));
                net.city = String(f.get("city"));
                net.country = String(f.get("country"));
                net.center = [Number(f.get("lat")), Number(f.get("lng"))];
                net.zoom = 12;
                load(net);
              }}
            >
              <label className="field">
                Project name
                <input
                  name="name"
                  required
                  defaultValue="My new network"
                  maxLength={140}
                />
              </label>
              <div className="field-row">
                <label className="field">
                  City
                  <input name="city" required defaultValue="London" />
                </label>
                <label className="field">
                  Country
                  <input
                    name="country"
                    required
                    defaultValue="United Kingdom"
                  />
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  Center latitude
                  <input
                    type="number"
                    min="-85"
                    max="85"
                    step="any"
                    name="lat"
                    defaultValue={51.5074}
                    required
                  />
                </label>
                <label className="field">
                  Center longitude
                  <input
                    type="number"
                    min="-180"
                    max="180"
                    step="any"
                    name="lng"
                    defaultValue={-0.1278}
                    required
                  />
                </label>
              </div>
              <button className="primary full" type="submit">
                <Plus size={15} /> Create empty map
              </button>
              <button
                className="text-btn"
                type="button"
                onClick={() => setModal("atlas")}
              >
                Choose a real city from the atlas <ArrowUpRight size={14} />
              </button>
            </form>
          )}
          {modal === "project" && (
            <>
              <label className="field">
                Project name
                <input
                  value={n.name}
                  maxLength={140}
                  onChange={(e) =>
                    update((d) => {
                      d.name = e.target.value;
                    })
                  }
                />
              </label>
              <div className="field-row">
                <label className="field">
                  City
                  <input
                    value={n.city}
                    onChange={(e) =>
                      update((d) => {
                        d.city = e.target.value;
                      })
                    }
                  />
                </label>
                <label className="field">
                  Country
                  <input
                    value={n.country}
                    onChange={(e) =>
                      update((d) => {
                        d.country = e.target.value;
                      })
                    }
                  />
                </label>
              </div>
              <label className="field">
                About this network
                <textarea
                  value={n.description}
                  rows={4}
                  onChange={(e) =>
                    update((d) => {
                      d.description = e.target.value;
                    })
                  }
                />
              </label>
              <button
                className="primary full"
                onClick={() => {
                  saveMap();
                  setModal(null);
                }}
              >
                <Save size={15} /> Save snapshot to My maps
              </button>
              <button
                className="secondary full"
                onClick={() => setModal("new")}
              >
                <Plus size={15} /> Start another map
              </button>
              <button
                className="text-btn"
                onClick={() =>
                  setConfirm({
                    title: "Open the London sandbox?",
                    description:
                      "Your current work will be replaced. Save a snapshot or export first if you want to keep it.",
                    action: () => load(clone(demoNetwork)),
                  })
                }
              >
                Open demonstration network <ArrowUpRight size={13} />
              </button>
            </>
          )}
          {modal === "sources" && (
            <>
              <div className="source-status">
                <span className="format-tag">{n.dataStatus.toUpperCase()}</span>
                <h3>{n.name}</h3>
                <p>{n.description}</p>
              </div>
              {n.sources.map((s, i) => (
                <a
                  className="source-link"
                  href={s.url}
                  key={i}
                  target="_blank"
                  rel="noreferrer"
                >
                  <div>
                    <strong>{s.title}</strong>
                    <small>
                      {s.license || "Reference"}
                      {s.accessed ? ` · accessed ${s.accessed}` : ""}
                    </small>
                  </div>
                  <ArrowUpRight size={16} />
                </a>
              ))}
              <div className="notice">
                MetroWeave is an independent map studio inspired by
                MetroDreamin. The bundled network is an imagined design using
                real place names. Imported networks retain their source labels.
                Verify imported geometry and service patterns against the
                operator before treating them as accurate current operations.
              </div>
              <a
                className="text-btn"
                href="https://en.wikipedia.org/wiki/Rapid_transit"
                target="_blank"
                rel="noreferrer"
              >
                Read the rapid-transit reference <ExternalLink size={13} />
              </a>
            </>
          )}
          {modal === "help" && (
            <>
              <p className="help-intro">
                A map is a possibility. Build lines that branch, loop and share
                tracks, then decide exactly where each service stops.
              </p>
              <div className="help-grid">
                <div>
                  <span className="city-icon">
                    <RouteIcon size={24} />
                  </span>
                  <h3>Draw the network.</h3>
                  <p>
                    Add a line, select Extend, then click the map or existing
                    stations. Click the same station again to make a returning
                    path.
                  </p>
                </div>
                <div>
                  <span className="city-icon">
                    <GitBranch size={24} />
                  </span>
                  <h3>Think beyond a line.</h3>
                  <p>
                    Branch copies a trunk into a new pattern. Loop joins its
                    last station to its first. Different services can share the
                    same stations.
                  </p>
                </div>
                <div>
                  <span className="city-icon">
                    <Zap size={24} />
                  </span>
                  <h3>Make it express.</h3>
                  <p>
                    Duplicate an express pattern, then toggle its stop circles.
                    Skipped stations stay on the path without becoming boarding
                    points.
                  </p>
                </div>
                <div>
                  <span className="city-icon">
                    <Spline size={24} />
                  </span>
                  <h3>Get the details right.</h3>
                  <p>
                    Use Geometry, then click the selected path to add a bend.
                    Drag squares to reshape it. Select mode lets you move
                    stations.
                  </p>
                </div>
              </div>
              <div className="shortcut-grid">
                {[
                  ["V", "Select & move"],
                  ["S", "Add station"],
                  ["D", "Extend service"],
                  ["B", "Edit geometry"],
                  ["E", "Delete station"],
                  ["Ctrl Z", "Undo"],
                  ["Ctrl ⇧ Z", "Redo"],
                  ["Ctrl S", "Save snapshot"],
                ].map(([k, v]) => (
                  <div key={k}>
                    <kbd>{k}</kbd>
                    <span>{v}</span>
                  </div>
                ))}
              </div>
              <div className="notice">
                Autosave keeps your current project in this browser. My maps
                stores snapshots. Export JSON for backups. The train preview
                follows geometry only; the journey planner estimates waits and
                travel times from your settings.
              </div>
              <div className="modal-actions">
                <button className="secondary" onClick={() => setModal("atlas")}>
                  <Globe2 size={15} /> Explore world atlas
                </button>
                <button className="primary" onClick={() => setModal(null)}>
                  Let's build <ArrowRight size={15} />
                </button>
              </div>
            </>
          )}
          {error && (
            <div className="error-notice" role="alert">
              {error}
            </div>
          )}
          {busy && (
            <div className="busy-overlay">
              <Loader2 className="spin" size={24} />
              <strong>{busy}</strong>
              <p>Large networks can take a minute.</p>
              {abort.current && (
                <button
                  className="secondary"
                  onClick={() => abort.current?.abort()}
                >
                  Cancel import
                </button>
              )}
            </div>
          )}
        </Modal>
      )}
      {confirm && (
        <Modal title={confirm.title} onClose={() => setConfirm(null)}>
          <p className="muted">{confirm.description}</p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="primary danger"
              onClick={() => {
                confirm.action();
                setConfirm(null);
              }}
            >
              Continue
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
