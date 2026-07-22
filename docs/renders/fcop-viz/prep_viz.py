"""Prepare compact viz_data_<map-id>.json for the Blender arena overlay.

Usage: python prep_viz.py <MISSION> <MAP_ID>
  e.g. python prep_viz.py Conft urban-jungle

Reads the RE-repo extraction (extracted/logic/<MISSION>/{actors,nets}.json) and
emits everything the Blender build needs, all in the 0-based grid frame
(col=x, row=z). No coordinate transform here — Blender aligns grid -> its space
by centre-to-centre (logic bbox centre -> glb bbox centre) per map.
"""
import json
import os
import sys
from collections import Counter

MISSION = sys.argv[1] if len(sys.argv) > 1 else "Mp"
MAP_ID = sys.argv[2] if len(sys.argv) > 2 else "la-cantina"

SRC = rf"D:/github/amigo-labs/fcop-reverse-engineering/extracted/logic/{MISSION}"
OUT = os.path.join(os.path.dirname(__file__), f"viz_data_{MAP_ID}.json")

acts = json.load(open(os.path.join(SRC, "actors.json")))
nets = json.load(open(os.path.join(SRC, "nets.json")))

SCALE = 8192.0  # raw ACT unit -> grid cell


def by_type(t):
    return [a for a in acts if a["act_type"] == t]


def trigger_kind(p):
    f = set(p["flags"])
    if "action_button" in f:
        return "button"
    if p["width_raw"] >= 10000:
        return "proximity"
    return "watch"


triggers = []
for t in by_type(95):
    p = t["params"]
    triggers.append({
        "id": t["matching"], "x": t["x"], "z": t["z"],
        "w": p["width_raw"] / SCALE, "l": p["length_raw"] / SCALE,
        "h": p["height_raw"] / SCALE, "kind": trigger_kind(p),
    })

turrets = [{"x": a["x"], "z": a["z"], "team": a["params"]["team"]} for a in by_type(8)]
neutrals = [{"x": a["x"], "z": a["z"]} for a in by_type(36)]
bases = [{"x": a["x"], "z": a["z"], "team": a["params"]["team"]} for a in by_type(28)]
spawns = [{"x": a["x"], "z": a["z"]} for a in by_type(1)]
pickups = [{"x": a["x"], "z": a["z"]} for a in by_type(16)]

lanes = []
for net in nets:
    nodes = [{"x": n["x"], "z": n["z"]} for n in net["nodes"]]
    idx = {n["i"]: k for k, n in enumerate(net["nodes"])}
    seen, edges = set(), []
    for n in net["nodes"]:
        a = idx[n["i"]]
        for nb in n.get("neighbours", []):
            if nb not in idx:
                continue
            b = idx[nb]
            key = (min(a, b), max(a, b))
            if key in seen or a == b:
                continue
            seen.add(key)
            edges.append([a, b])
    lanes.append({"nodes": nodes, "edges": edges})

data = {
    "map": MAP_ID, "mission": MISSION,
    "triggers": triggers, "turrets": turrets, "neutrals": neutrals,
    "bases": bases, "spawns": spawns, "pickups": pickups, "lanes": lanes,
}
json.dump(data, open(OUT, "w"), indent=1)

# summary + logic bbox (the centre Blender will align to)
xs, zs = [], []
for g in ("triggers", "turrets", "neutrals", "bases", "spawns", "pickups"):
    for a in data[g]:
        xs.append(a["x"]); zs.append(a["z"])
for ln in lanes:
    for n in ln["nodes"]:
        xs.append(n["x"]); zs.append(n["z"])
print(f"[{MAP_ID}] wrote {os.path.basename(OUT)}")
print(f"  triggers={len(triggers)} {dict(Counter(t['kind'] for t in triggers))} "
      f"turrets={len(turrets)} neutrals={len(neutrals)} bases={len(bases)} "
      f"spawns={len(spawns)} pickups={len(pickups)} lanes={len(lanes)}")
print(f"  LOGIC bbox: col[{min(xs):.1f},{max(xs):.1f}] c={(min(xs)+max(xs))/2:.2f}  "
      f"row[{min(zs):.1f},{max(zs):.1f}] c={(min(zs)+max(zs))/2:.2f}")
