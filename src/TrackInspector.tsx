import { useState } from "react";
import {
  GitBranch,
  Plus,
  Repeat2,
  Waypoints,
  Route as RouteIcon,
  Zap,
  Trash2,
  ArrowRight,
  MapPin,
  Settings2,
  Check,
} from "lucide-react";
import type { Network, Service, Track, Junction } from "./types";
import {
  materializeInfrastructure,
  createPassingLoop,
  usePassingLoop,
  branchFromLoop,
} from "./infrastructure";
import { appendTrack } from "./trackEditing";
type Props = {
  network: Network;
  service?: Service;
  selectedStationId: string | null;
  selectedTrackId: string | null;
  selectedJunctionId: string | null;
  onEdit: (fn: (n: Network) => void) => boolean | void;
  onSelectService: (id: string) => void;
  onSelectTrack: (id: string | null) => void;
  onSelectJunction: (id: string | null) => void;
  onTool: (tool: "junction" | "track" | "select" | "draw" | "bend") => void;
  onMessage: (message: string) => void;
  onLoopBranch: () => void;
  onRejoin: () => void;
  showInfrastructure: boolean;
  onShowInfrastructure: (show: boolean) => void;
};
export default function TrackInspector(p: Props) {
  const n = p.network,
    track = n.tracks?.find((t) => t.id === p.selectedTrackId),
    junction = n.junctions?.find((j) => j.id === p.selectedJunctionId),
    [stationId, setStationId] = useState(
      p.selectedStationId || p.service?.stationIds[0] || "",
    ),
    [offset, setOffset] = useState(60);
  const edit = (fn: (n: Network) => void) => {
    if (p.onEdit(fn) === false)
      throw Object.assign(new Error(""), { handled: true });
  };
  const attempt = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      if (!(e as { handled?: boolean }).handled)
        p.onMessage((e as Error).message);
    }
  };
  const createLoop = () =>
    attempt(() => {
      if (!stationId) throw Error("Choose a station on the selected service.");
      edit((d) => {
        createPassingLoop(d, stationId, {
          serviceId: p.service?.id,
          offsetMeters: offset,
        });
      });
      p.onShowInfrastructure(true);
      p.onMessage(
        "Passing loop created with separate platform and bypass tracks. Assign service paths below.",
      );
    });
  return (
    <div className="track-inspector">
      <div className="inspector-title">
        <span className="station-icon">
          <Waypoints size={22} />
        </span>
        <div>
          <span className="eyebrow">PHYSICAL INFRASTRUCTURE</span>
          <h2>Tracks & junctions</h2>
        </div>
      </div>
      <p className="muted">
        Tracks define where trains can run. Service patterns define which paths
        they take and where they stop.
      </p>
      <label className="toggle-row">
        <span>Show track infrastructure</span>
        <input
          type="checkbox"
          checked={p.showInfrastructure}
          onChange={(e) => p.onShowInfrastructure(e.target.checked)}
        />
      </label>
      <div className="track-tool-grid">
        <button
          className="secondary"
          onClick={() => {
            p.onTool("junction");
            p.onShowInfrastructure(true);
          }}
        >
          <Waypoints size={15} /> Add junction
        </button>
        <button
          className="secondary"
          onClick={() => {
            p.onTool("track");
            p.onShowInfrastructure(true);
          }}
        >
          <RouteIcon size={15} /> Connect tracks
        </button>
      </div>
      <button
        className="secondary full"
        onClick={() =>
          attempt(() => {
            edit((d) => {
              materializeInfrastructure(d);
            });
            p.onShowInfrastructure(true);
            p.onMessage(
              "Existing service geometry converted to shared physical tracks.",
            );
          })
        }
      >
        <Settings2 size={14} /> Build tracks from service paths
      </button>
      <div className="infrastructure-stats">
        <span>
          <strong>{n.tracks?.length || 0}</strong> track sections
        </span>
        <span>
          <strong>{n.junctions?.length || 0}</strong> junctions
        </span>
        <span>
          <strong>{n.passingLoops?.length || 0}</strong> passing loops
        </span>
      </div>
      {track && (
        <section className="infrastructure-card">
          <div className="section-heading">
            <span className="section-title">SELECTED TRACK</span>
            <button
              className="icon-btn"
              aria-label="Deselect track"
              onClick={() => p.onSelectTrack(null)}
            >
              ×
            </button>
          </div>
          <label className="field">
            Track name
            <input
              value={track.name || ""}
              placeholder="Track section"
              onChange={(e) =>
                p.onEdit((d) => {
                  d.tracks!.find((t) => t.id === track.id)!.name =
                    e.target.value;
                })
              }
            />
          </label>
          <p className="track-endpoints">
            {nodeName(n, track.fromId)} <ArrowRight size={12} />{" "}
            {nodeName(n, track.toId)}
          </p>
          <div className="field-row">
            <label className="field">
              Track use
              <select
                value={track.kind}
                onChange={(e) =>
                  p.onEdit((d) => {
                    d.tracks!.find((t) => t.id === track.id)!.kind = e.target
                      .value as Track["kind"];
                  })
                }
              >
                {["main", "passing", "siding", "connector"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Direction
              <select
                value={track.direction}
                onChange={(e) =>
                  p.onEdit((d) => {
                    const t = d.tracks!.find((t) => t.id === track.id)!;
                    const neededReverse = d.services.some((s) =>
                      s.trackPath?.some(
                        (v) =>
                          v.trackId === t.id &&
                          (v.reverse || s.direction === "both"),
                      ),
                    );
                    if (e.target.value === "forward" && neededReverse)
                      throw Error(
                        "A service uses this track in reverse. Change that service path before making the track one way.",
                      );
                    t.direction = e.target.value as Track["direction"];
                  })
                }
              >
                <option value="both">Both ways</option>
                <option value="forward">Forward only</option>
              </select>
            </label>
          </div>
          <label className="field">
            Speed limit (km/h)
            <input
              type="number"
              min="1"
              max="700"
              value={track.speedLimit || 80}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v > 0 && v <= 700)
                  p.onEdit((d) => {
                    d.tracks!.find((t) => t.id === track.id)!.speedLimit = v;
                  });
              }}
            />
          </label>
          {p.service && (
            <button
              className="secondary full"
              onClick={() =>
                attempt(() => {
                  edit((d) => {
                    appendTrack(d, p.service!.id, track.id);
                  });
                  p.onMessage("Track appended to the selected service path.");
                })
              }
            >
              <RouteIcon size={13} /> Append track to selected service
            </button>
          )}
          <button className="secondary full" onClick={() => p.onTool("bend")}>
            <Waypoints size={13} /> Edit this track's geometry
          </button>
          <button
            className="danger-link"
            onClick={() =>
              attempt(() => {
                edit((d) => {
                  d.tracks = d.tracks?.filter((t) => t.id !== track.id);
                  d.services.forEach((s) => {
                    if (s.trackPath?.some((v) => v.trackId === track.id))
                      s.trackPath = undefined;
                  });
                  d.passingLoops = d.passingLoops?.filter(
                    (l) =>
                      !l.mainTrackIds.includes(track.id) &&
                      !l.bypassTrackIds.includes(track.id),
                  );
                });
                p.onSelectTrack(null);
              })
            }
          >
            <Trash2 size={13} /> Remove track section
          </button>
        </section>
      )}
      {junction && (
        <section className="infrastructure-card">
          <span className="section-title">SELECTED JUNCTION</span>
          <label className="field">
            Junction name
            <input
              value={junction.name}
              onChange={(e) =>
                p.onEdit((d) => {
                  d.junctions!.find((j) => j.id === junction.id)!.name =
                    e.target.value;
                })
              }
            />
          </label>
          <p className="subtle">
            Junctions connect tracks without creating a boarding station. Drag
            the diamond on the map to move it.
          </p>
          <div className="coordinate-readout">
            {junction.lat.toFixed(5)}, {junction.lng.toFixed(5)}
          </div>
          <button
            className="danger-link"
            onClick={() =>
              attempt(() => {
                edit((d) => {
                  const removed = new Set(
                    d.tracks
                      ?.filter(
                        (t) =>
                          t.fromId === junction.id || t.toId === junction.id,
                      )
                      .map((t) => t.id),
                  );
                  d.tracks = d.tracks?.filter((t) => !removed.has(t.id));
                  d.junctions = d.junctions?.filter(
                    (j) => j.id !== junction.id,
                  );
                  d.services.forEach((s) => {
                    if (s.trackPath?.some((v) => removed.has(v.trackId)))
                      s.trackPath = undefined;
                  });
                  d.passingLoops = d.passingLoops?.filter(
                    (l) =>
                      l.entryId !== junction.id && l.exitId !== junction.id,
                  );
                });
                p.onSelectJunction(null);
              })
            }
          >
            <Trash2 size={13} /> Remove junction & connected tracks
          </button>
        </section>
      )}
      <section className="infrastructure-card">
        <div className="section-title">ADD A PASSING LOOP</div>
        <p className="subtle">
          Create switches before and after a station, with a platform route and
          a separate bypass. Local and express services can use different
          tracks.
        </p>
        <label className="field">
          Station
          <select
            value={stationId}
            onChange={(e) => setStationId(e.target.value)}
          >
            <option value="">Choose a station</option>
            {(p.service?.stationIds || n.stations.map((s) => s.id))
              .filter((id, i, a) => a.indexOf(id) === i)
              .map((id) => (
                <option key={id} value={id}>
                  {nodeName(n, id)}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          Separation (metres)
          <input
            type="number"
            min="15"
            max="500"
            value={offset}
            onChange={(e) => setOffset(Number(e.target.value))}
          />
        </label>
        <button className="primary full" onClick={createLoop}>
          <Plus size={14} /> Create passing loop
        </button>
      </section>
      {(n.passingLoops || []).map((loop) => (
        <section className="infrastructure-card" key={loop.id}>
          <div className="section-heading">
            <strong>{loop.name}</strong>
            <span className="format-tag">PASSING LOOP</span>
          </div>
          <p className="subtle">
            {nodeName(n, loop.stationId)} · Two switches · Independent physical
            paths
          </p>
          {p.service && (
            <>
              <label className="field">
                Selected service
                <input value={p.service.name} readOnly />
              </label>
              <div className="track-tool-grid">
                <button
                  className="secondary"
                  onClick={() =>
                    attempt(() => {
                      edit((d) => {
                        usePassingLoop(d, p.service!.id, loop.id, "main");
                      });
                      p.onMessage("Service assigned to the platform track.");
                    })
                  }
                >
                  <MapPin size={14} /> Platform track
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    attempt(() => {
                      edit((d) => {
                        usePassingLoop(d, p.service!.id, loop.id, "bypass");
                      });
                      p.onMessage(
                        "Service assigned to bypass; the platform stop is skipped.",
                      );
                    })
                  }
                >
                  <Zap size={14} /> Bypass track
                </button>
              </div>
            </>
          )}
        </section>
      ))}
      <section className="infrastructure-card">
        <div className="section-title">RINGS & BRANCHES</div>
        <p className="subtle">
          Start at a ring station, optionally run a complete circuit, then
          branch outward. Rejoin any existing station to create a through
          service.
        </p>
        <button
          className="secondary full"
          disabled={!p.service}
          onClick={p.onLoopBranch}
        >
          <GitBranch size={15} /> Branch from selected service
        </button>
        <button
          className="secondary full"
          disabled={!p.service}
          onClick={p.onRejoin}
        >
          <Repeat2 size={15} /> Rejoin an existing station
        </button>
      </section>
      <div className="notice">
        Track paths preserve topology and speed limits. Signal interlocking,
        rolling-stock dynamics and collision avoidance are not yet simulated.
      </div>
    </div>
  );
}
function nodeName(n: Network, id: string) {
  return (
    n.stations.find((s) => s.id === id)?.name ||
    n.junctions?.find((j) => j.id === id)?.name ||
    id
  );
}
