"""Render orthographic view sheets of all Metropolis .glb assets from Blender.

Runs inside a Blender instance (interactive addon or --background). Iterates over
the shipped model files and writes front/back/left/top/iso PNGs to
docs/renders/<category>/<asset>-<view>.png.

Coordinate frame (docs/specs/assets.md §4): Y-up, meters, +Z = forward.
The 4 axis views + isometric are framed per model via its world bounding sphere,
so each asset fills its frame regardless of size.

Usage (interactive, via MCP execute_blender_code):
    RENDER_ONLY = ["runner"]        # optional: filter by asset key OR category
    exec(compile(open(r"...render_assets.py", encoding="utf-8").read(),
                 "render_assets.py", "exec"))
    result = {"written": WRITTEN, "warnings": WARNINGS}

Usage (headless):
    blender --background --python tools/render/render_assets.py
"""

import math
import os

import bpy
from mathutils import Matrix, Vector

# --- Configuration --------------------------------------------------------

REPO = r"D:\github\amigo-labs\amigo-metropolis"
MODELS = os.path.join(REPO, "packages", "client", "public", "models")
UNITS = os.path.join(MODELS, "units")
OUT = os.path.join(REPO, "docs", "renders")
MAPS_DIR = os.path.join(REPO, "packages", "sim", "maps")

# Arena combat-zone previews (level-select thumbnails). Isometric, zoomed onto
# the playable area (worldExtent = (size-1)*cellSize from the map JSON) so the
# flat terrain skirt and the mesh edge stay out of frame. Written next to each
# arena .glb as preview.png (served at /models/<id>/preview.png).
ARENA_KEYS = [
    "bug-hunt", "hollywood-keys", "la-cantina",
    "proving-ground", "urban-jungle", "venice-beach",
]
PREVIEW_RES = 1024
# Desired framing: ortho_scale = combat_zone_size * PREVIEW_ZOOM. This is then
# clamped by an automatic mesh-fit (see max_ortho_on_mesh) so the iso frame never
# reaches past the arena into the grey background / mesh edge.
PREVIEW_ZOOM = 0.72
# Preview camera direction (Blender Z-up). Steeper than the QC-sheet iso (which is
# ~32° elevation) so it looks down more: less "seeing across" the map means the
# frame stays inside the arena footprint and framing is uniform across layouts.
PREVIEW_DIR = Vector((1.0, -1.0, 1.9))  # azimuth 45°, elevation ~53°

# Per-map fine-tuning: `zoom` overrides PREVIEW_ZOOM; `ox`/`oy` nudge the frame
# centre in Blender units (X = sim east, Y = sim north-flipped). Arenas differ in
# how their combat zone sits inside the mesh, so a couple need a tighter crop /
# shift to keep the edge out of frame. Keys absent -> defaults.
PREVIEW_OVERRIDES: dict[str, dict[str, float]] = {
    # Venice Beach is a long map with a large dark-water quadrant; nudge the frame
    # toward the built structures and tighten so water doesn't dominate.
    "venice-beach": {"ox": 40.0, "zoom": 0.6},
}

# (category, asset-key, absolute glb path, square resolution)
ASSETS = [
    ("arenas", "bug-hunt", os.path.join(MODELS, "bug-hunt", "bug-hunt.glb"), 1600),
    ("arenas", "hollywood-keys", os.path.join(MODELS, "hollywood-keys", "hollywood-keys.glb"), 1600),
    ("arenas", "la-cantina", os.path.join(MODELS, "la-cantina", "la-cantina.glb"), 1600),
    ("arenas", "proving-ground", os.path.join(MODELS, "proving-ground", "proving-ground.glb"), 1600),
    ("arenas", "urban-jungle", os.path.join(MODELS, "urban-jungle", "urban-jungle.glb"), 1600),
    ("arenas", "venice-beach", os.path.join(MODELS, "venice-beach", "venice-beach.glb"), 1600),
    ("turrets", "turret", os.path.join(UNITS, "turret.glb"), 1024),
    ("units", "runner", os.path.join(UNITS, "runner.glb"), 1024),
    ("units", "guardian", os.path.join(UNITS, "guardian.glb"), 1024),
    ("units", "juggernaut", os.path.join(UNITS, "juggernaut.glb"), 1024),
    ("units", "fortress", os.path.join(UNITS, "fortress.glb"), 1024),
    ("units", "warden", os.path.join(UNITS, "warden.glb"), 1024),
    ("figures", "avatar-walker", os.path.join(UNITS, "avatar-walker.glb"), 1024),
    ("figures", "avatar-hover", os.path.join(UNITS, "avatar-hover.glb"), 1024),
    ("props", "console", os.path.join(UNITS, "console.glb"), 1024),
]

# Blender is Z-up. The glTF importer maps glTF (x, y, z) -> Blender (x, -z, y),
# so the assets' authored forward (+Z) becomes Blender -Y and authored up (+Y)
# becomes Blender +Z. All view directions below are therefore in Blender's frame.
# view -> (camera offset direction from center, world-up hint for the framing)
_UP = Vector((0.0, 0.0, 1.0))
VIEWS = {
    "front": (Vector((0.0, -1.0, 0.0)), _UP),  # camera on the authored-front (+Z) side
    "back": (Vector((0.0, 1.0, 0.0)), _UP),
    "left": (Vector((-1.0, 0.0, 0.0)), _UP),
    # top-down: front (Blender -Y) points to the image top.
    "top": (Vector((0.0, 0.0, 1.0)), Vector((0.0, -1.0, 0.0))),
    "iso": (Vector((1.0, -1.0, 0.9)).normalized(), _UP),
}

# Names of the persistent rig objects that survive between assets.
CAM_NAME = "RenderCam"
SUN_NAME = "KeySun"
FILL_NAME = "FillSun"
TOP_NAME = "TopSun"

WRITTEN: list[str] = []
WARNINGS: list[str] = []


# --- Scene setup ----------------------------------------------------------

def set_engine() -> str:
    """Prefer EEVEE Next (4.2+), fall back to legacy EEVEE."""
    scene = bpy.context.scene
    for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = engine
            return engine
        except TypeError:
            continue
    return scene.render.engine


def setup_world() -> None:
    """Neutral mid-dark studio backdrop: enough ambient fill, good contrast
    against the desaturated units without blowing out textured arenas."""
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg is not None:
        bg.inputs[0].default_value = (0.35, 0.36, 0.40, 1.0)
        bg.inputs[1].default_value = 1.0
    bpy.context.scene.world = world


def make_light(name: str, energy: float, rot_deg: tuple[float, float, float]) -> None:
    data = bpy.data.lights.new(name, type="SUN")
    data.energy = energy
    obj = bpy.data.objects.new(name, data)
    obj.rotation_euler = tuple(math.radians(a) for a in rot_deg)
    bpy.context.scene.collection.objects.link(obj)


def make_camera() -> bpy.types.Object:
    data = bpy.data.cameras.new(CAM_NAME)
    data.type = "ORTHO"
    obj = bpy.data.objects.new(CAM_NAME, data)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.scene.camera = obj
    return obj


def wipe_all() -> None:
    """Full clean slate so re-runs in the same session don't accumulate
    duplicate rig objects (RenderCam.001, ...) that break the keep-list."""
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.cameras, bpy.data.lights):
        for block in list(coll):
            if block.users == 0:
                coll.remove(block)


def setup_rig() -> bpy.types.Object:
    set_engine()
    wipe_all()
    setup_world()
    # Key + fill + top. FCOP meshes carry inconsistent normals; the ambient world
    # plus lights from three directions keep every face legible (see make_two_sided).
    make_light(SUN_NAME, 2.2, (55.0, 0.0, 30.0))
    make_light(FILL_NAME, 1.0, (-40.0, 0.0, -150.0))
    make_light(TOP_NAME, 0.8, (0.0, 0.0, 0.0))  # straight down, lights top faces
    scene = bpy.context.scene
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.resolution_percentage = 100
    # Standard view transform: show the baked texture/vertex colors as authored
    # instead of AgX's filmic desaturation. No creative look, no exposure lift.
    try:
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
        scene.view_settings.exposure = 0.0
        scene.view_settings.gamma = 1.0
    except (AttributeError, TypeError):
        pass
    try:
        scene.eevee.taa_render_samples = 32
    except (AttributeError, TypeError):
        pass
    return make_camera()


# --- Per-asset helpers ----------------------------------------------------

_KEEP = {CAM_NAME, SUN_NAME, FILL_NAME, TOP_NAME}


def clear_imported() -> None:
    """Delete everything except the persistent camera + lights."""
    for obj in list(bpy.data.objects):
        if obj.name not in _KEEP:
            bpy.data.objects.remove(obj, do_unlink=True)
    # Purge orphaned meshes/materials/images so re-imports stay clean and cheap.
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for block in list(coll):
            if block.users == 0:
                coll.remove(block)


def import_glb(path: str) -> list[bpy.types.Object]:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before]


def world_bounds(objs: list[bpy.types.Object]) -> tuple[Vector, float, bool]:
    mn = Vector((1e18, 1e18, 1e18))
    mx = Vector((-1e18, -1e18, -1e18))
    found = False
    for obj in objs:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            wc = obj.matrix_world @ Vector(corner)
            mn.x, mn.y, mn.z = min(mn.x, wc.x), min(mn.y, wc.y), min(mn.z, wc.z)
            mx.x, mx.y, mx.z = max(mx.x, wc.x), max(mx.y, wc.y), max(mx.z, wc.z)
            found = True
    if not found:
        return Vector((0.0, 0.0, 0.0)), 1.0, False
    center = (mn + mx) * 0.5
    radius = (mx - mn).length * 0.5
    return center, max(radius, 0.001), True


def make_two_sided(objs: list[bpy.types.Object]) -> None:
    """FCOP glTF materials are single-sided (doubleSided:false) and the meshes
    carry inconsistent face normals, so backface culling drops faces whose
    normal points away from the camera -> holes. Render both sides for the QC
    sheet so the full geometry is always visible."""
    for obj in objs:
        if obj.type != "MESH":
            continue
        for slot in obj.material_slots:
            if slot.material is not None:
                slot.material.use_backface_culling = False


def ensure_vertex_colors(objs: list[bpy.types.Object]) -> None:
    """Wire a mesh's color attribute into Base Color when nothing else feeds it.

    Textured assets (arenas, atlas units) already have Base Color linked to an
    image and are left untouched; vertex-color-only FCOP units get their baked
    colors shown instead of a flat default.
    """
    for obj in objs:
        if obj.type != "MESH" or not obj.data.color_attributes:
            continue
        col_name = obj.data.color_attributes[0].name
        for slot in obj.material_slots:
            mat = slot.material
            if mat is None or not mat.use_nodes:
                continue
            nt = mat.node_tree
            bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if bsdf is None:
                continue
            base = bsdf.inputs["Base Color"]
            if base.is_linked:
                continue
            vc = nt.nodes.new("ShaderNodeVertexColor")
            vc.layer_name = col_name
            nt.links.new(vc.outputs["Color"], base)


def look_at(cam: bpy.types.Object, loc: Vector, target: Vector, up: Vector) -> None:
    z = (loc - target).normalized()  # camera +Z points away from the subject
    x = up.cross(z)
    if x.length < 1e-6:  # up parallel to view dir -> pick a stable fallback
        x = Vector((1.0, 0.0, 0.0))
    x = x.normalized()
    y = z.cross(x).normalized()
    cam.matrix_world = Matrix((
        (x.x, y.x, z.x, loc.x),
        (x.y, y.y, z.y, loc.y),
        (x.z, y.z, z.z, loc.z),
        (0.0, 0.0, 0.0, 1.0),
    ))


def render_asset(category: str, key: str, path: str, res: int, cam: bpy.types.Object) -> None:
    if not os.path.exists(path):
        WARNINGS.append(f"{key}: missing file {path}")
        return
    clear_imported()
    objs = import_glb(path)
    bpy.context.view_layer.update()
    make_two_sided(objs)
    ensure_vertex_colors(objs)
    center, radius, found = world_bounds(objs)
    if not found:
        WARNINGS.append(f"{key}: no mesh geometry after import")
        return

    scene = bpy.context.scene
    scene.render.resolution_x = res
    scene.render.resolution_y = res
    cam.data.ortho_scale = 2.0 * radius * 1.1
    cam.data.clip_start = 0.01
    cam.data.clip_end = radius * 12.0

    out_dir = os.path.join(OUT, category)
    os.makedirs(out_dir, exist_ok=True)
    for view, (direction, up) in VIEWS.items():
        loc = center + direction * (radius * 3.0)
        look_at(cam, loc, center, up)
        out_path = os.path.join(out_dir, f"{key}-{view}.png")
        scene.render.filepath = out_path
        bpy.ops.render.render(write_still=True)
        WRITTEN.append(out_path)


# --- Entry point ----------------------------------------------------------

def render_all(only: list[str] | None = None) -> None:
    cam = setup_rig()
    for category, key, path, res in ASSETS:
        if only and key not in only and category not in only:
            continue
        render_asset(category, key, path, res, cam)


def read_map_json(map_id: str) -> dict:
    import json

    with open(os.path.join(MAPS_DIR, f"{map_id}.json"), encoding="utf-8") as f:
        return json.load(f)


def combat_zone_sim(data: dict) -> tuple[float, float, float, float, float, float]:
    """Where the fighting happens (spawns, base plots, lanes, turret/outpost/dummy
    spots), in sim space. Returns the bbox (min x, min y, max x, max y) plus the
    point *centroid* (mean x, mean y). Centring on the centroid biases the frame
    toward the built-up structures on asymmetric maps (water/deck on one side),
    while the bbox drives the zoom. Tracks the arena core far better than the mesh
    bbox, since the terrain/water skirt carries no gameplay."""
    xs: list[float] = []
    ys: list[float] = []
    for s in data.get("spawns", []):
        xs.append(s["x"])
        ys.append(s["y"])
    for b in data.get("basePlots", []):
        r = b.get("radius", 0.0)
        xs += [b["x"] - r, b["x"] + r]
        ys += [b["y"] - r, b["y"] + r]
    for name in ("turretSpots", "outpostSpots", "dummySpots"):
        for p in data.get(name, []):
            xs.append(p[0])
            ys.append(p[1])
    for lane in data.get("lanes", []):
        for p in lane:
            xs.append(p[0])
            ys.append(p[1])
    cx = sum(xs) / len(xs)
    cy = sum(ys) / len(ys)
    return min(xs), min(ys), max(xs), max(ys), cx, cy


def max_ortho_on_mesh(cam: bpy.types.Object, radius: float) -> float:
    """Largest ortho_scale whose square frame still lands entirely on the mesh,
    found by casting parallel rays through the frame corners/edge-midpoints and
    shrinking until all hit. Guarantees the preview shows no grey background."""
    scene = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    mw = cam.matrix_world
    right = mw.col[0].to_3d().normalized()
    up = mw.col[1].to_3d().normalized()
    view = (-mw.col[2].to_3d()).normalized()
    loc = mw.translation.copy()
    back = view * (radius * 4.0)
    samples = [(-1, -1), (1, -1), (-1, 1), (1, 1), (-1, 0), (1, 0), (0, -1), (0, 1)]

    def fits(scale: float) -> bool:
        h = scale * 0.5
        for sx, sy in samples:
            origin = loc + right * (sx * h) + up * (sy * h) - back
            if not scene.ray_cast(dg, origin, view)[0]:
                return False
        return True

    hi = radius * 4.0
    if fits(hi):
        return hi
    lo = 0.0
    for _ in range(22):
        mid = (lo + hi) * 0.5
        if fits(mid):
            lo = mid
        else:
            hi = mid
    return max(lo, radius * 0.1)


def render_arena_preview(cam: bpy.types.Object, map_id: str,
                         res: int = PREVIEW_RES, zoom: float = PREVIEW_ZOOM) -> None:
    glb = os.path.join(MODELS, map_id, f"{map_id}.glb")
    if not os.path.exists(glb):
        WARNINGS.append(f"{map_id}: missing arena glb {glb}")
        return
    clear_imported()
    objs = import_glb(glb)
    bpy.context.view_layer.update()
    make_two_sided(objs)
    center, radius, found = world_bounds(objs)  # Blender Z-up: ground=XY, height=Z
    if not found:
        WARNINGS.append(f"{map_id}: no mesh geometry")
        return

    data = read_map_json(map_id)
    extent = (data["size"] - 1) * data["cellSize"]
    sx0, sy0, sx1, sy1, csx, csy = combat_zone_sim(data)
    # meshMap.ts centres the mesh bbox at the arena centre, so sim (x, y) maps to
    # Blender: X = x - extent/2 + meshCentre.x,  Y = extent/2 - y + meshCentre.y
    # (Blender Y is flipped vs sim y because the glTF importer is Z-up).
    half = extent / 2.0
    ov = PREVIEW_OVERRIDES.get(map_id, {})
    # Frame centre = gameplay centroid (biases toward the structures); zoom driven
    # by the gameplay bbox size.
    czone = Vector((
        csx - half + center.x + ov.get("ox", 0.0),
        half - csy + center.y + ov.get("oy", 0.0),
        center.z,
    ))
    czone_size = max(sx1 - sx0, sy1 - sy0, 1.0)

    scene = bpy.context.scene
    scene.render.resolution_x = res
    scene.render.resolution_y = res
    cam.data.clip_start = 0.01
    cam.data.clip_end = radius * 20.0
    # Steep iso (PREVIEW_DIR), aimed at the combat-zone centre.
    direction = PREVIEW_DIR.normalized()
    look_at(cam, czone + direction * (radius * 3.0), czone, Vector((0.0, 0.0, 1.0)))
    # Frame the combat zone, but clamp so the frame never reaches past the mesh.
    target_scale = czone_size * ov.get("zoom", zoom)
    cam.data.ortho_scale = min(target_scale, max_ortho_on_mesh(cam, radius))

    out_path = os.path.join(MODELS, map_id, "preview.png")
    scene.render.filepath = out_path
    bpy.ops.render.render(write_still=True)
    WRITTEN.append(out_path)


def render_previews(only: list[str] | None = None) -> None:
    cam = setup_rig()
    for map_id in ARENA_KEYS:
        if only and map_id not in only:
            continue
        render_arena_preview(cam, map_id)


try:
    _mode = MODE  # type: ignore[name-defined]  # "preview" | None (injected)
except NameError:
    _mode = None
try:
    _only = RENDER_ONLY  # type: ignore[name-defined]  # optional injected filter
except NameError:
    _only = None

if _mode == "preview":
    render_previews(_only)
else:
    render_all(_only)
print(f"[render_assets] wrote {len(WRITTEN)} images, {len(WARNINGS)} warnings")
for _w in WARNINGS:
    print(f"[render_assets] WARN {_w}")
