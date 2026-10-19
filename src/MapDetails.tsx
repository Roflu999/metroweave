import { useState } from "react";
import { Plus, Trash2, MapPin, Layers } from "lucide-react";
import type { Network, Route, Station } from "./types";
import { uid, serviceStopsAt } from "./engine";
export const TRANSPORT_MODES = [
  "metro",
  "rail",
  "high-speed-rail",
  "light-metro",
  "tram",
  "monorail",
  "maglev",
  "bus",
  "brt",
  "ferry",
  "gondola",
  "air",
] as const;
export function RouteAppearance({
  network: n,
  route,
  onEdit,
}: {
  network: Network;
  route: Route;
  onEdit: (fn: (d: Network) => void) => unknown;
}) {
  return (
    <>
      <div className="field-row">
        <label className="field">
          Badge shape
          <select
            value={route.icon || "square"}
            onChange={(e) =>
              onEdit((d) => {
                d.routes.find((r) => r.id === route.id)!.icon = e.target
                  .value as Route["icon"];
              })
            }
          >
            {[
              "circle",
              "square",
              "diamond",
              "triangle",
              "hexagon",
              "pentagon",
              "heart",
              "plus",
              "star",
            ].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Line pattern
          <select
            value={route.pattern || "solid"}
            onChange={(e) =>
              onEdit((d) => {
                d.routes.find((r) => r.id === route.id)!.pattern = e.target
                  .value as Route["pattern"];
              })
            }
          >
            {["solid", "dashed", "dotted", "dash-dot"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        Line group
        <select
          value={route.groupId || ""}
          onChange={(e) =>
            onEdit((d) => {
              d.routes.find((r) => r.id === route.id)!.groupId =
                e.target.value || undefined;
            })
          }
        >
          <option value="">Ungrouped</option>
          {n.lineGroups?.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
export function StationDetails({
  station,
  onEdit,
}: {
  station: Station;
  onEdit: (fn: (d: Network) => void) => unknown;
}) {
  return (
    <>
      <label className="field">
        Station information
        <textarea
          rows={3}
          value={station.info || ""}
          placeholder="Platform notes, facilities, or design notes"
          onChange={(e) =>
            onEdit((d) => {
              d.stations.find((s) => s.id === station.id)!.info =
                e.target.value;
            })
          }
        />
      </label>
      <div className="field-row">
        <label className="field">
          Track grade
          <select
            value={station.grade || "at"}
            onChange={(e) =>
              onEdit((d) => {
                d.stations.find((s) => s.id === station.id)!.grade = e.target
                  .value as Station["grade"];
              })
            }
          >
            <option value="above">Elevated</option>
            <option value="at">At ground level</option>
            <option value="below">Underground</option>
          </select>
        </label>
      </div>
      <label className="check-field">
        <input
          type="checkbox"
          checked={station.isWaypoint || false}
          onChange={(e) =>
            onEdit((d) => {
              const node = d.stations.find((s) => s.id === station.id)!;
              node.isWaypoint = e.target.checked;
              if (node.isWaypoint)
                d.services.forEach((s) => {
                  const stops = s.stationIds.map((id, i) =>
                    id === node.id ? false : serviceStopsAt(s, i),
                  );
                  s.stopPattern = stops;
                });
            })
          }
        />
        <MapPin size={14} /> Geometry waypoint (no boarding)
      </label>
    </>
  );
}
export function LineGroups({
  network: n,
  onEdit,
}: {
  network: Network;
  onEdit: (fn: (d: Network) => void) => unknown;
}) {
  const [name, setName] = useState("");
  return (
    <section className="line-groups">
      <div className="section-title">LINE GROUPS</div>
      {n.lineGroups?.map((g) => (
        <div className="line-group-row" key={g.id}>
          <label className="toggle-row">
            <span>
              <Layers size={14} />
              {g.name}
            </span>
            <input
              type="checkbox"
              checked={g.visible}
              onChange={(e) =>
                onEdit((d) => {
                  d.lineGroups!.find((x) => x.id === g.id)!.visible =
                    e.target.checked;
                })
              }
            />
          </label>
          <button
            className="icon-btn"
            aria-label={`Remove group ${g.name}`}
            onClick={() =>
              onEdit((d) => {
                d.lineGroups = d.lineGroups?.filter((x) => x.id !== g.id);
                d.routes.forEach((r) => {
                  if (r.groupId === g.id) r.groupId = undefined;
                });
              })
            }
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <form
        className="group-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onEdit((d) => {
            (d.lineGroups ??= []).push({
              id: uid("group"),
              name: name.trim(),
              visible: true,
            });
          });
          setName("");
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New group name"
          aria-label="New line group name"
          maxLength={100}
        />
        <button
          className="icon-btn"
          title="Create line group"
          aria-label="Create line group"
        >
          <Plus size={16} />
        </button>
      </form>
      <p className="subtle">
        Assign lines to groups in Line settings. Group visibility changes the
        map, while journey planning still uses the full network.
      </p>
    </section>
  );
}
