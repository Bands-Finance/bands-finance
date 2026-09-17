"""
Mr Bands' desk, built from code.   blender -b -P web/3d/build_desk.py -- <out.glb> [<out.blend>] [<preview.png>]

One diorama the dashboard's camera travels through (web/src/stage). Everything is modelled here so the
scene is reproducible and so it can be opened in Blender and art-directed by hand: move a prop or a
camera station, run the export again, and the site follows.

Conventions the web side relies on:
  - Blender units are decimetres-ish; Z is up here and the exporter turns it into glTF's Y up.
  - z = 0 is the top of the blotter. The web stage draws the paper ground at z = GROUND_Z below it.
  - MATERIAL NAMES are the contract with the engraving shader (Paper, Bill, Page, Ivory, Brass, Wood,
    Felt, Ink, Strap, Ember, Glass, Tape). Colours here are only for looking at the file in Blender.
  - Proto.* objects are prototypes the web stage instances from live data (one Stack per bin, one Coin
    per 0.1 SOL of fees, one Tray and Cursor per open band). They are parked under the desk.
  - Cam.<name> / Look.<name> empties are the camera stations of the scroll journey; a beat on the page names its station.
  - A custom property outline=0 asks the web stage not to draw an ink contour around that object.
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT_GLB = argv[0] if len(argv) > 0 else "desk.glb"
OUT_BLEND = argv[1] if len(argv) > 1 else None
OUT_PNG = argv[2] if len(argv) > 2 else None

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
root = scene.collection

# ---------------------------------------------------------------- materials
PALETTE = {
    "Paper": (0.93, 0.89, 0.80), "Bill": (0.90, 0.87, 0.76), "Page": (0.95, 0.92, 0.84), "Ivory": (0.96, 0.93, 0.85),
    "Brass": (0.72, 0.56, 0.28), "Wood": (0.36, 0.23, 0.14), "Felt": (0.80, 0.76, 0.66), "Ink": (0.06, 0.05, 0.045),
    "Strap": (1.0, 0.30, 0.03), "Ember": (1.0, 0.25, 0.02), "Glass": (0.85, 0.9, 0.9), "Tape": (0.96, 0.93, 0.85),
}
MATS = {}
for name, rgb in PALETTE.items():
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = 0.35 if name == "Brass" else 0.7
    bsdf.inputs["Metallic"].default_value = 1.0 if name == "Brass" else 0.0
    if name == "Glass":
        bsdf.inputs["Alpha"].default_value = 0.18
        m.blend_method = "BLEND" if hasattr(m, "blend_method") else m.blend_method
    m.diffuse_color = (*rgb, 0.25 if name == "Glass" else 1)
    MATS[name] = m

# ---------------------------------------------------------------- helpers
def link(obj, parent=None):
    root.objects.link(obj)
    if parent is not None:
        obj.parent = parent
    return obj

def empty(name, loc=(0, 0, 0), parent=None):
    e = bpy.data.objects.new(name, None)
    e.location = loc
    e.empty_display_size = 0.4
    return link(e, parent)

def finish(obj, mat, bevel=0.03, segments=2, smooth=True, outline=True):
    obj.data.materials.append(MATS[mat])
    if smooth:
        for p in obj.data.polygons:
            p.use_smooth = True
    if bevel and bevel > 0:
        b = obj.modifiers.new("Bevel", "BEVEL")
        b.width = bevel
        b.segments = segments
        b.limit_method = "ANGLE"
        b.angle_limit = math.radians(40)
        w = obj.modifiers.new("Weighted", "WEIGHTED_NORMAL")
        w.keep_sharp = False
        w.weight = 80
    if not outline:
        obj["outline"] = 0
    return obj

def mesh_obj(name, bm, parent=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return link(bpy.data.objects.new(name, me), parent)

def box(name, size, loc, mat, bevel=0.03, rot=(0, 0, 0), parent=None, outline=True, segments=2):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= size[0]; v.co.y *= size[1]; v.co.z *= size[2]
    o = mesh_obj(name, bm, parent)
    o.location = loc
    o.rotation_euler = rot
    return finish(o, mat, bevel, segments, outline=outline)

def cyl(name, r, h, loc, mat, bevel=0.03, rot=(0, 0, 0), parent=None, r2=None, verts=48, outline=True, segments=2, cap=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=verts, radius1=r, radius2=r if r2 is None else r2, depth=h)
    o = mesh_obj(name, bm, parent)
    o.location = loc
    o.rotation_euler = rot
    return finish(o, mat, bevel, segments, outline=outline)

def sphere(name, r, loc, mat, parent=None, scale=(1, 1, 1), outline=True):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=r)
    o = mesh_obj(name, bm, parent)
    o.location = loc
    o.scale = scale
    return finish(o, mat, 0, outline=outline)

def torus(name, R, r, loc, mat, parent=None, rot=(0, 0, 0), scale=(1, 1, 1), seg=48, ring=12, outline=True):
    bm = bmesh.new()
    for i in range(seg):
        a = 2 * math.pi * i / seg
        for j in range(ring):
            b = 2 * math.pi * j / ring
            bm.verts.new(((R + r * math.cos(b)) * math.cos(a), (R + r * math.cos(b)) * math.sin(a), r * math.sin(b)))
    bm.verts.ensure_lookup_table()
    for i in range(seg):
        for j in range(ring):
            a0 = i * ring + j; a1 = i * ring + (j + 1) % ring
            b0 = ((i + 1) % seg) * ring + j; b1 = ((i + 1) % seg) * ring + (j + 1) % ring
            bm.faces.new((bm.verts[a0], bm.verts[b0], bm.verts[b1], bm.verts[a1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = mesh_obj(name, bm, parent)
    o.location = loc; o.rotation_euler = rot; o.scale = scale
    return finish(o, mat, 0, outline=outline)

def ribbon(name, pts, width, mat, parent=None, samples=14):
    """A flat paper ribbon along a Catmull-Rom centreline; u runs across it, v along it (for the shader's edge lines)."""
    P = [Vector(p) for p in pts]
    P = [P[0] + (P[0] - P[1])] + P + [P[-1] + (P[-1] - P[-2])]
    line = []
    for i in range(1, len(P) - 2):
        for s in range(samples):
            t = s / samples
            p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
            line.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    line.append(P[-2])
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    rows, total, acc = [], 0.0, [0.0]
    for i in range(1, len(line)):
        total += (line[i] - line[i - 1]).length
        acc.append(total)
    for i, c in enumerate(line):
        tan = (line[min(i + 1, len(line) - 1)] - line[max(i - 1, 0)]).normalized()
        side = tan.cross(Vector((0, 0, 1)))
        side = side.normalized() if side.length > 1e-4 else Vector((0, 1, 0))
        rows.append((bm.verts.new(c - side * width / 2), bm.verts.new(c + side * width / 2)))
    for i in range(len(rows) - 1):
        f = bm.faces.new((rows[i][0], rows[i + 1][0], rows[i + 1][1], rows[i][1]))
        vs = [(0, acc[i]), (0, acc[i + 1]), (1, acc[i + 1]), (1, acc[i])]
        for loop, (u, v) in zip(f.loops, vs):
            loop[uv].uv = (u, v / width)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = mesh_obj(name, bm, parent)
    return finish(o, mat, 0, outline=False)

def text(name, body, size, loc, mat, parent=None, rot=(0, 0, 0), extrude=0.012, font=None, align="CENTER", spacing=1.0):
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = body; cu.size = size; cu.extrude = extrude; cu.align_x = align; cu.align_y = "CENTER"; cu.space_character = spacing
    if font: cu.font = font
    cu.resolution_u = 3
    o = link(bpy.data.objects.new(name, cu), parent)
    o.location = loc; o.rotation_euler = rot
    o.data.materials.append(MATS[mat])
    o["outline"] = 0
    return o

FONT = None
for cand in ("/System/Library/Fonts/Supplemental/Copperplate.ttc", "/System/Library/Fonts/Supplemental/Didot.ttc"):
    if os.path.exists(cand):
        try:
            FONT = bpy.data.fonts.load(cand); break
        except Exception as e:
            print("font failed", cand, e)

# ---------------------------------------------------------------- the desk
desk = empty("Desk")
GROUND_Z = -0.22
blot = box("Blotter", (31, 15.4, 0.22), (0, 0.5, -0.11), "Felt", bevel=0.09, parent=desk, segments=3)
# a stitched leather border is four thin rails just inside the blotter's edge
for i, (sx, sy, x, y) in enumerate([(30.0, 0.07, 0, -6.7), (30.0, 0.07, 0, 7.7), (0.07, 14.47, -15.0, 0.5), (0.07, 14.47, 15.0, 0.5)]):
    box(f"Blotter.Rule.{i}", (sx, sy, 0.012), (x, y, 0.006), "Ink", bevel=0, parent=desk, outline=False)

# ---- top hat
hat = empty("Hat", (-11.5, 3.5, 0), desk)
hat.scale = (1.3, 1.3, 1.3)
cyl("Hat.Brim", 2.05, 0.09, (0, 0, 0.045), "Ink", 0.04, parent=hat).scale = (1.0, 0.9, 1.0)
torus("Hat.BrimRoll", 2.02, 0.07, (0, 0, 0.07), "Ink", parent=hat, scale=(1.0, 0.9, 1.0))
cyl("Hat.Crown", 1.2, 2.35, (0, 0, 0.09 + 2.35 / 2), "Ink", 0.07, parent=hat, r2=1.34, segments=3)
cyl("Hat.Band", 1.235, 0.5, (0, 0, 0.09 + 0.27), "Strap", 0.015, parent=hat, r2=1.262)

# ---- the pixel shades, lying by the hat
shades = empty("Shades", (-7.4, 5.9, 0), desk)
shades.scale = (1.35, 1.35, 1.35)
PX = 0.17
ROWS = ["1111111111111111", "0111110001111100", "0111110001111100", "0011100000111000"]
for r, row in enumerate(ROWS):
    run = None
    for c, ch in enumerate(row + "0"):
        if ch == "1" and run is None: run = c
        if ch != "1" and run is not None:
            w = c - run
            box(f"Shades.{r}.{run}", (w * PX, PX, 0.07), ((run + w / 2 - 8) * PX, -r * PX, 0.035), "Ink", 0.012, parent=shades)
            run = None
shades.rotation_euler = (0, 0, math.radians(-14))

# ---- ashtray and cigar
ash = empty("Ashtray", (-12.4, -4.4, 0), desk)
ash.scale = (1.15, 1.15, 1.15)
cyl("Ashtray.Dish", 1.25, 0.28, (0, 0, 0.14), "Brass", 0.05, parent=ash, r2=1.4)
cyl("Ashtray.Well", 1.08, 0.04, (0, 0, 0.275), "Ink", 0, parent=ash, outline=False)
cig = empty("Cigar", (0.55, 0.35, 0.47), ash)
cig.rotation_euler = (0, math.radians(-7), math.radians(24))
cyl("Cigar.Body", 0.15, 2.3, (0, 0, 0), "Wood", 0.05, rot=(0, math.pi / 2, 0), parent=cig, verts=24)
cyl("Cigar.Band", 0.158, 0.26, (0.55, 0, 0), "Strap", 0.008, rot=(0, math.pi / 2, 0), parent=cig, verts=24)
cyl("Cigar.Ash", 0.15, 0.3, (-1.28, 0, 0), "Paper", 0.04, rot=(0, math.pi / 2, 0), parent=cig, verts=24)
cyl("Cigar.Ember", 0.152, 0.07, (-1.12, 0, 0), "Ember", 0, rot=(0, math.pi / 2, 0), parent=cig, verts=24, outline=False)
empty("Smoke.Origin", (-1.42, 0, 0.05), cig)

# ---- the cane, laid along the back of the blotter
cane = empty("Cane", (-3.0, 7.05, 0.13), desk)
cane.rotation_euler = (0, 0, math.radians(1.6))
cyl("Cane.Shaft", 0.11, 19.0, (0, 0, 0), "Ink", 0.02, rot=(0, math.pi / 2, 0), parent=cane, verts=20, r2=0.085)
sphere("Cane.Knob", 0.3, (-9.7, 0, 0.12), "Brass", parent=cane, scale=(1.15, 1, 1))
cyl("Cane.Collar", 0.135, 0.5, (-9.2, 0, 0), "Brass", 0.02, rot=(0, math.pi / 2, 0), parent=cane, verts=20)
cyl("Cane.Ferrule", 0.09, 0.45, (9.45, 0, 0), "Brass", 0.02, rot=(0, math.pi / 2, 0), parent=cane, verts=20)

# ---- the fee dish, at the right end of the rows
dish = empty("Dish", (9.7, -0.7, 0), desk)
dish.scale = (1.12, 1.12, 1.12)
cyl("Dish.Plate", 1.75, 0.1, (0, 0, 0.05), "Brass", 0.03, parent=dish)
torus("Dish.Rim", 1.72, 0.13, (0, 0, 0.16), "Brass", parent=dish)
empty("Dish.Coins", (0, 0, 0.1), dish)

# ---- the ticker under its glass dome, back right; the tape runs forward to the ledger
tick = empty("Ticker", (11.7, 4.1, 0), desk)
tick.scale = (1.22, 1.22, 1.22)
cyl("Ticker.Base", 1.95, 0.5, (0, 0, 0.25), "Wood", 0.08, parent=tick, segments=3)
cyl("Ticker.Plinth", 1.55, 0.14, (0, 0, 0.57), "Brass", 0.03, parent=tick)
for s in (-1, 1):
    box(f"Ticker.Plate.{s}", (1.5, 0.1, 1.5), (0, 0.55 * s, 1.39), "Brass", 0.04, parent=tick)
    cyl(f"Ticker.Boss.{s}", 0.2, 0.08, (0, 0.62 * s, 1.55), "Brass", 0.02, rot=(math.pi / 2, 0, 0), parent=tick, verts=24)
cyl("Ticker.Wheel.A", 0.52, 0.34, (-0.2, -0.17, 1.55), "Ink", 0.03, rot=(math.pi / 2, 0, 0), parent=tick, verts=36)
cyl("Ticker.Wheel.B", 0.52, 0.34, (-0.2, 0.2, 1.55), "Ivory", 0.03, rot=(math.pi / 2, 0, 0), parent=tick, verts=36)
cyl("Ticker.Axle", 0.07, 1.5, (-0.2, 0, 1.55), "Brass", 0.01, rot=(math.pi / 2, 0, 0), parent=tick, verts=16)
cyl("Ticker.Gear", 0.36, 0.08, (0.45, 0.42, 1.1), "Brass", 0.015, rot=(math.pi / 2, 0, 0), parent=tick, verts=14)
cyl("Ticker.Spool", 0.42, 0.3, (0.5, 0, 1.0), "Paper", 0.03, rot=(math.pi / 2, 0, 0), parent=tick, verts=32)
for x in (-0.6, 0.6):
    cyl(f"Ticker.Post.{x}", 0.06, 1.5, (x, 0, 1.39), "Brass", 0.01, parent=tick, verts=16)
# the dome: an open cylinder and a hemisphere, one skin
bm = bmesh.new()
R, H, SEG = 1.5, 1.9, 48
ringsv = []
for k in range(0, 9):
    a = (math.pi / 2) * k / 8
    ringsv.append((R * math.cos(a), H + R * math.sin(a)))
prof = [(R, 0.0), (R, H * 0.5)] + ringsv
vs = []
for (rr, zz) in prof:
    vs.append([bm.verts.new((rr * math.cos(2 * math.pi * i / SEG), rr * math.sin(2 * math.pi * i / SEG), zz)) for i in range(SEG)] if rr > 1e-4 else [bm.verts.new((0, 0, zz))])
for a, b in zip(vs[:-1], vs[1:]):
    for i in range(SEG):
        j = (i + 1) % SEG
        if len(b) == 1: bm.faces.new((a[i], a[j], b[0]))
        else: bm.faces.new((a[i], a[j], b[j], b[i]))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
dome = mesh_obj("Ticker.Dome", bm, tick)
dome.location = (0, 0, 0.64)
finish(dome, "Glass", 0)
cyl("Ticker.DomeFoot", 1.56, 0.1, (0, 0, 0.66), "Brass", 0.03, parent=tick)
sphere("Ticker.Finial", 0.13, (0, 0, 0.64 + H + R + 0.1), "Brass", parent=tick)
# the tape: from the type wheel, out past the dish on its right, over the open ledger and off the blotter's front edge.
# Written in desk coordinates and brought into the ticker's own space (it is scaled).
TAPE_WORLD = [(10.75, 3.9, 1.98), (10.0, 3.3, 1.55), (10.3, 2.3, 0.5), (11.9, 1.3, 0.04), (13.3, 0.2, 0.26), (13.5, -1.2, 0.04),
              (12.7, -2.3, 0.3), (12.0, -3.3, 0.58), (11.9, -4.6, 0.66), (12.8, -5.6, 0.56), (13.6, -6.6, 0.2), (13.2, -7.6, 0.04), (12.0, -8.1, -0.18)]
TK = (11.7, 4.1, 0.0); TS = 1.22
ribbon("Ticker.Tape", [((x - TK[0]) / TS, (y - TK[1]) / TS, (z - TK[2]) / TS) for (x, y, z) in TAPE_WORLD], 0.34 / TS * 1.15, "Tape", parent=tick)

# ---- the ledger, open, front right, with his pen
led = empty("Ledger", (11.0, -4.3, 0), desk)
led.rotation_euler = (0, 0, math.radians(-9))
box("Ledger.Cover", (6.3, 4.4, 0.12), (0, 0, 0.06), "Ink", 0.05, parent=led)
box("Ledger.Page.L", (2.95, 4.1, 0.34), (-1.52, 0, 0.27), "Page", 0.06, rot=(0, math.radians(3.5), 0), parent=led, segments=3)
box("Ledger.Page.R", (2.95, 4.1, 0.34), (1.52, 0, 0.27), "Page", 0.06, rot=(0, math.radians(-3.5), 0), parent=led, segments=3)
box("Ledger.Marker", (0.22, 5.0, 0.012), (0.12, -0.55, 0.47), "Strap", 0, parent=led, outline=False)
pen = empty("Pen", (1.7, -0.3, 0.55), led)
pen.rotation_euler = (0, math.radians(2), math.radians(38))
cyl("Pen.Body", 0.085, 2.2, (0, 0, 0), "Ink", 0.02, rot=(0, math.pi / 2, 0), parent=pen, verts=20)
cyl("Pen.Nib", 0.085, 0.4, (1.3, 0, 0), "Brass", 0.005, rot=(0, math.pi / 2, 0), parent=pen, verts=20, r2=0.008)
cyl("Pen.Ring", 0.095, 0.1, (0.7, 0, 0), "Brass", 0.01, rot=(0, math.pi / 2, 0), parent=pen, verts=20)

# ---- a bound pile of notes by the hat: his idle SOL (the web stage shows or hides it)
vault = empty("Vault", (-11.9, -0.9, 0), desk)
vault.scale = (1.12, 1.12, 1.12)
for i, (x, y, rz, n) in enumerate([(0, 0, 8, 3), (1.35, 1.0, -12, 2), (-0.2, 1.9, 3, 1)]):
    for k in range(n):
        g = empty(f"Vault.{i}.{k}", (x, y, k * 0.56), vault)
        g.rotation_euler = (0, 0, math.radians(rz + (k * 5 - 4)))
        box(f"Vault.Notes.{i}.{k}", (2.1, 1.0, 0.54), (0, 0, 0.27), "Bill", 0.035, parent=g)
        box(f"Vault.Strap.{i}.{k}", (0.42, 1.02, 0.56), (0, 0, 0.27), "Strap", 0.012, parent=g)

# ---- the abacus of fees: a plinth along the front of the blotter with a brass rail of seats. The web stage stands a
#      column of coins on each seat, one seat a time bucket (an hour or a day), so what he earned reads as a bar chart.
CHART_SEATS = 24
CHART_PITCH = 0.62
chart = empty("Chart", (-2.2, -5.35, 0), desk)
CH_LEN = CHART_SEATS * CHART_PITCH + 0.7
box("Chart.Plinth", (CH_LEN, 1.5, 0.22), (0, 0, 0.11), "Wood", 0.05, parent=chart, segments=3)
box("Chart.Rail.F", (CH_LEN - 0.2, 0.06, 0.06), (0, -0.62, 0.25), "Brass", 0.012, parent=chart)
box("Chart.Rail.B", (CH_LEN - 0.2, 0.06, 0.06), (0, 0.62, 0.25), "Brass", 0.012, parent=chart)
box("Chart.Scale", (CH_LEN - 0.3, 0.3, 0.05), (0, -0.98, 0.04), "Ivory", 0.015, parent=chart, rot=(math.radians(-24), 0, 0))
for i in range(CHART_SEATS):
    x = (i - (CHART_SEATS - 1) / 2) * CHART_PITCH
    cyl(f"Chart.Seat.{i:02d}", 0.27, 0.025, (x, 0, 0.23), "Brass", 0.006, parent=chart, verts=24, outline=False)
    if i % 6 == 0:
        box(f"Chart.Tick.{i:02d}", (0.03, 0.2, 0.012), (x, -0.98, 0.1), "Ink", 0, parent=chart, outline=False, rot=(math.radians(-24), 0, 0))
seats = empty("Chart.Seats", (-(CHART_SEATS - 1) / 2 * CHART_PITCH, 0, 0.245), chart)
seats["count"] = CHART_SEATS; seats["pitch"] = CHART_PITCH

# ---------------------------------------------------------------- prototypes (instanced by the web stage)
protos = empty("Protos", (0, 0, -40))
ROW_LEN = 16.0          # the scale's length: the web stage maps the band and its margins onto this
TRAY_D = 2.7            # tray depth (Y)
# Tray: origin at the centre of the scale's length, z = 0 on the blotter
tray = empty("Proto.Tray", (0, 0, 0), protos)
box("Tray.Base", (ROW_LEN + 1.0, TRAY_D, 0.16), (0, 0, 0.08), "Wood", 0.04, parent=tray)
box("Tray.Back", (ROW_LEN + 1.0, 0.16, 0.5), (0, TRAY_D / 2 - 0.08, 0.25), "Wood", 0.035, parent=tray)
for s in (-1, 1):
    box(f"Tray.End.{s}", (0.16, TRAY_D, 0.5), (s * (ROW_LEN / 2 + 0.42), 0, 0.25), "Wood", 0.035, parent=tray)
box("Tray.Scale", (ROW_LEN + 0.6, 0.62, 0.2), (0, -TRAY_D / 2 + 0.31, 0.26), "Ivory", 0.03, parent=tray, rot=(math.radians(-16), 0, 0))
box("Tray.Rail", (ROW_LEN + 0.6, 0.07, 0.07), (0, -TRAY_D / 2 - 0.02, 0.2), "Brass", 0.012, parent=tray)
box("Tray.RailBack", (ROW_LEN + 0.6, 0.07, 0.07), (0, TRAY_D / 2 + 0.02, 0.52), "Brass", 0.012, parent=tray)
if FONT:
    t = text("Tray.Name", "MR BANDS  ·  LIQUIDITY IN BETWEEN", 0.2, (0, -TRAY_D / 2 - 0.004, 0.08), "Ink", parent=tray, rot=(math.radians(90), 0, 0), font=FONT, spacing=1.25, extrude=0.004)

# Cursor: origin on the hairline, at the tray's centreline
cur = empty("Proto.Cursor", (0, 0, 0), protos)
for s, zt in ((-1, 0.2), (1, 0.52)):
    box(f"Cursor.Shoe.{s}", (0.7, 0.2, 0.2), (0, s * (TRAY_D / 2 + 0.02), zt), "Brass", 0.03, parent=cur)
box("Cursor.Post.F", (0.5, 0.09, 1.25), (0, -TRAY_D / 2 - 0.02, 0.2 + 0.62), "Brass", 0.02, parent=cur)
box("Cursor.Post.B", (0.5, 0.09, 0.93), (0, TRAY_D / 2 + 0.02, 0.52 + 0.46), "Brass", 0.02, parent=cur)
box("Cursor.Frame.L", (0.06, TRAY_D + 0.1, 0.07), (-0.22, 0, 1.43), "Brass", 0.012, parent=cur)
box("Cursor.Frame.R", (0.06, TRAY_D + 0.1, 0.07), (0.22, 0, 1.43), "Brass", 0.012, parent=cur)
box("Cursor.Glass", (0.38, TRAY_D + 0.04, 0.025), (0, 0, 1.43), "Glass", 0, parent=cur, outline=False)
box("Cursor.Hairline", (0.03, TRAY_D + 0.08, 0.035), (0, 0, 1.43), "Strap", 0, parent=cur, outline=False)
box("Cursor.Pointer", (0.035, 0.035, 0.85), (0, -TRAY_D / 2 + 0.3, 0.95), "Strap", 0, parent=cur, outline=False)
cyl("Cursor.Knob", 0.13, 0.16, (0, -TRAY_D / 2 - 0.02, 1.53), "Brass", 0.03, parent=cur, verts=24)

# Stack: a unit-wide bundle (x is scaled to the bin's pitch), origin at its foot
stack = box("Proto.Stack", (1.0, 1.72, 0.56), (0, 0.18, 0.28), "Bill", 0.03, parent=protos)
strap = box("Proto.Strap", (1.012, 0.4, 0.572), (0, 0.18, 0.28), "Strap", 0.012, parent=protos)
# Chip: what a bin holds once the price has crossed it, the token he bought. A dark slab, no strap.
chip = box("Proto.Chip", (1.0, 1.72, 0.3), (0, 0.18, 0.15), "Ink", 0.03, parent=protos)
coin = cyl("Proto.Coin", 0.3, 0.06, (0, 0, 0.03), "Brass", 0.014, parent=protos, verts=32)
for o in (stack, strap, chip, coin):
    # the transforms are baked so an instance matrix is the only transform the web stage applies
    bpy.context.view_layer.objects.active = o

# ---------------------------------------------------------------- camera stations (beat index)
# Each station is a NAME the page asks for (a beat says which station it stands at), a camera, what it looks at, a field of
# view, what it follows (the web stage slides a "cursor" station to where the price is and a "row0"/"row1" station to that tray),
# and a drift: how far the camera may wander while a long block of words scrolls past (the ledger list).
STATIONS = [
    # name       cam (x, y, z)             look (x, y, z)          fov  follow     drift (x, y, z)     note
    ("hero",     (19.0, -25.0, 8.5),       (2.5, 0.0, 5.2),        33,  "",        (0, 0, 0),          "the desk as a landscape along the bottom of the window, the words in the sky above it"),
    ("rows",     (-11.0, -12.0, 5.5),      (1.0, -0.5, 0.3),       32,  "",        (0, 0, 0),          "he lays SOL under the price: down the rows"),
    ("cursor",   (2.5, -9.5, 4.2),         (0.6, -1.2, 0.6),       30,  "cursor",  (0, 0, 0),          "traders cross his band: on the cursor"),
    ("row0",     (-9.5, -8.9, 6.4),        (0.5, -1.9, 0.4),                  30,  "row0",    (1.5, 0, 0),        "what he holds: the first tray, corner to corner"),
    ("row1",     (-9.5, -4.7, 6.4),        (0.5, 2.3, 0.4),                     30,  "row1",    (1.5, 0, 0),        "what he holds: the second tray"),
    ("vault",    (-19.0, -9.0, 5.0),       (-11.6, -0.4, 1.0),     30,  "",        (0, 0, 0),          "he holds nothing: his SOL stacked by the hat"),
    ("dish",     (5.2, -8.4, 7.2),         (9.5, -0.9, 0.2),       28,  "",        (0, 0, 0),          "fees fall: the dish"),
    ("chart",    (9.0, -12.0, 4.2),        (1.5, -5.3, 0.7),            30,  "",        (-2.0, 0, 0),       "what he made: the abacus of fees"),
    ("plan",     (-1.4, -7.5, 29.0),       (-1.4, -0.4, 0.0),      30,  "",        (0, 0, 0),          "price walks away, he lays the band again: the plan view"),
    ("ledger",   (17.5, -12.5, 7.0),       (11.3, -3.4, 0.5),      30,  "",        (0, 0, 0),          "every move on the record: tape and ledger"),
    ("tape",     (18.5, -4.0, 6.0),        (12.0, 1.6, 1.2),       30,  "",        (0, -3.5, -0.4),    "what he did: the ticker and its tape, the camera following the tape out as the list scrolls"),
    ("hat",      (-17.5, -7.5, 4.4),       (-10.6, 3.0, 1.7),      30,  "",        (0, 0, 0),          "the close: his hat, his shades, his cigar"),
]
for (name, c, l, fov, follow, drift, note) in STATIONS:
    e = empty(f"Cam.{name}", c); e["fov"] = fov; e["note"] = note; e["follow"] = follow; e["station"] = name
    e["drift_x"] = drift[0]; e["drift_y"] = drift[1]; e["drift_z"] = drift[2]
    empty(f"Look.{name}", l)

# ---------------------------------------------------------------- bake transforms of prototypes, export
bpy.context.view_layer.update()
scene["ground_z"] = GROUND_Z
scene["row_len"] = ROW_LEN
scene["tray_depth"] = TRAY_D
info = empty("Info"); info["ground_z"] = GROUND_Z; info["row_len"] = ROW_LEN; info["tray_depth"] = TRAY_D

# text must be mesh before export
for o in [o for o in scene.objects if o.type == "FONT"]:
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.convert(target="MESH")

if OUT_BLEND:
    # a camera and a sun so the file opens to something when Zach looks at it in Blender
    cam_d = bpy.data.cameras.new("Preview"); cam_d.lens = 60
    cam = link(bpy.data.objects.new("Preview.Camera", cam_d)); cam.location = STATIONS[0][1]
    look = Vector(STATIONS[0][2]); d = look - Vector(cam.location)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    sun_d = bpy.data.lights.new("Key", "SUN"); sun_d.energy = 3.0
    sun = link(bpy.data.objects.new("Preview.Key", sun_d)); sun.rotation_euler = (math.radians(48), 0, math.radians(-32))

os.makedirs(os.path.dirname(os.path.abspath(OUT_GLB)), exist_ok=True)
bpy.ops.object.select_all(action="DESELECT")
for o in scene.objects:
    if not o.name.startswith("Preview."):
        o.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_extras=True, export_cameras=False, export_lights=False, export_materials="EXPORT",
                          export_texcoords=True, export_normals=True, export_animations=False)
print("exported", OUT_GLB, os.path.getsize(OUT_GLB), "bytes")

if OUT_BLEND:
    # for a human: bring the prototypes up beside the desk so they can be seen and edited
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(OUT_BLEND))
    print("saved", OUT_BLEND)

if OUT_PNG:
    protos.location = (-2.0, -1.9, 0)   # show one tray in place for the preview only
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"; scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_cavity = True; scene.display.shading.show_shadows = True; scene.display.shading.show_object_outline = True
    scene.render.resolution_x = 1600; scene.render.resolution_y = 1000
    scene.render.filepath = os.path.abspath(OUT_PNG)
    scene.world = bpy.data.worlds.new("W"); 
    scene.render.film_transparent = False
    bpy.ops.render.render(write_still=True)
    print("rendered", OUT_PNG)
