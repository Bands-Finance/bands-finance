"""
Mr Bands' desk, built from code.   blender -b -P web/3d/build_desk.py -- web/3d/desk.glb web/3d/desk.blend [<preview.png>]

One diorama the dashboard's camera travels through (web/src/stage). Everything is modelled here so the
scene is reproducible and so it can be opened in Blender and art-directed by hand: move a prop or a
camera station, run the export again, and the site follows.

Conventions the web side relies on:
  - Blender units are decimetres-ish; Z is up here and the exporter turns it into glTF's Y up.
  - z = 0 is the top of the blotter. The web stage draws the paper ground at z = GROUND_Z below it.
  - MATERIAL NAMES are the contract with the engraving shader (Paper, Bill, Page, Ivory, Brass, Wood,
    Felt, Ink, Cloth, Stripe, Shoe, Strap, Ember, Glass, Tape). Colours here are only for looking at the file in Blender.
  - Proto.* objects are prototypes the web stage instances from live data (one Stack per bin, one Coin
    per 0.1 SOL of fees, one Tray and Cursor per open band). They are parked under the desk.
  - Cam.<name> / Look.<name> empties are the camera stations of the scroll journey; a beat on the page names its station.
  - A custom property outline=0 asks the web stage not to draw an ink contour around that object.
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector, Matrix, Quaternion

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
    "Cloth": (0.42, 0.40, 0.37), "Stripe": (0.55, 0.53, 0.50), "Shoe": (0.08, 0.07, 0.06),
    "Hat": (0.06, 0.05, 0.045),   # the figure's hat: Ink's colour, its own (matte) engraving spec
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

def cyl(name, r, h, loc, mat, bevel=0.03, rot=(0, 0, 0), parent=None, r2=None, verts=32, outline=True, segments=2, cap=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=verts, radius1=r, radius2=r if r2 is None else r2, depth=h)
    o = mesh_obj(name, bm, parent)
    o.location = loc
    o.rotation_euler = rot
    return finish(o, mat, bevel, segments, outline=outline)

def sphere(name, r, loc, mat, parent=None, scale=(1, 1, 1), outline=True, seg=(24, 12)):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg[0], v_segments=seg[1], radius=r)
    o = mesh_obj(name, bm, parent)
    o.location = loc
    o.scale = scale
    return finish(o, mat, 0, outline=outline)

def bone(name, a, b, r, mat, parent=None, r2=None, verts=20, bevel=0.02, outline=True):
    """A cylinder from a to b (a limb, a cane, a cigar): its axis along the segment, its ends at the two points."""
    a, b = Vector(a), Vector(b)
    d = b - a
    o = cyl(name, r, d.length, (a + b) / 2, mat, bevel, parent=parent, r2=r2, verts=verts, outline=outline)
    o.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    return o

def torus(name, R, r, loc, mat, parent=None, rot=(0, 0, 0), scale=(1, 1, 1), seg=36, ring=8, outline=True):
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

def hat_stripe(name, r_of, z0, z1, width, mat, parent=None, lift=0.025, samples=18, top_r=None):
    """The orange stripe of the hat (the model sheet: it runs up the front of the crown, over the top and down the back).
    r_of(z) is the crown's radius at height z (z0 the brim, z1 the top); the strip floats `lift` off the surface."""
    P, N = [], []
    for i in range(samples + 1):                       # up the front
        z = z0 + (z1 - z0) * i / samples
        P.append(Vector((0, -r_of(z), z))); N.append(Vector((0, -1, 0)))
    rt = top_r if top_r is not None else r_of(z1)
    for i in range(1, samples):                        # across the top
        y = -rt + 2 * rt * i / samples
        P.append(Vector((0, y, z1))); N.append(Vector((0, 0, 1)))
    for i in range(samples, -1, -1):                   # down the back
        z = z0 + (z1 - z0) * i / samples
        P.append(Vector((0, r_of(z), z))); N.append(Vector((0, 1, 0)))
    # round the two top corners a little: blend the normals near them
    for k in range(1, len(P) - 1):
        N[k] = (N[k - 1] + N[k] * 2 + N[k + 1]).normalized()
    bm = bmesh.new()
    rows = []
    for c, n in zip(P, N):
        o = c + n * lift
        rows.append((bm.verts.new(o + Vector((-width / 2, 0, 0))), bm.verts.new(o + Vector((width / 2, 0, 0)))))
    for i in range(len(rows) - 1):
        bm.faces.new((rows[i][0], rows[i + 1][0], rows[i + 1][1], rows[i][1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = mesh_obj(name, bm, parent)
    so = o.modifiers.new("Solid", "SOLIDIFY"); so.thickness = 0.03; so.offset = 1
    return finish(o, mat, 0, outline=False)

def text(name, body, size, loc, mat, parent=None, rot=(0, 0, 0), extrude=0.012, font=None, align="CENTER", spacing=1.0):
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = body; cu.size = size; cu.extrude = extrude; cu.align_x = align; cu.align_y = "CENTER"; cu.space_character = spacing
    if font: cu.font = font
    cu.resolution_u = 1
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

# ---------------------------------------------------------------- mesh modelling: lofts and hands (subdivision surfaces)
# Metaballs make a face; they do not make tailoring or a hand. These build proper meshes the way a character modeller
# blocks them out: a coat as a surface skinned over cross-section rings, a hand as one box-modelled piece, both smoothed
# by a Subdivision Surface modifier (applied at export).
def subsurf(o, levels=2):
    m = o.modifiers.new("Subsurf", "SUBSURF"); m.levels = levels; m.render_levels = levels
    return m

def ellipse(c, rx, ry, n, rot=None, a0=0.0, a1=360.0):
    """n points round an ellipse centred at c (radii rx along x, ry along y, in the ring's own plane z = 0), from angle
    a0 to a1 (an open arc when they are not a full turn), rotated by the quaternion rot: one loft ring."""
    full = abs(abs(a1 - a0) - 360.0) < 1e-6
    pts = []
    for i in range(n):
        t = a0 + (a1 - a0) * (i / n if full else i / (n - 1))
        p = Vector((rx * math.cos(math.radians(t)), ry * math.sin(math.radians(t)), 0.0))
        pts.append(Vector(c) + (rot @ p if rot else p))
    return pts

def tube_rings(path, radii, n=12):
    """Rings set perpendicular to a path (a sleeve, a leg): one per path point, radius radii[i] (a number, or an (rx, ry)
    pair for an oval), the ring's x axis kept as level as the path allows."""
    P = [Vector(p) for p in path]
    rings = []
    for i, c in enumerate(P):
        t = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized()
        q = Vector((0, 0, 1)).rotation_difference(t)
        r = radii[min(i, len(radii) - 1)]
        rx, ry = (r if isinstance(r, (tuple, list)) else (r, r))
        rings.append(ellipse(c, rx, ry, n, q))
    return rings

def loft(name, rings, mat, parent=None, closed=True, cap_start=False, cap_end=False, levels=2, thickness=None, outline=True, smooth=True):
    """A surface skinned over rings (lists of points, all the same length, in the parent's space): consecutive rings are
    joined by quads; `closed` joins each ring's last point to its first (a tube) or leaves it an open sheet (a coat
    with its front open); caps close the ends; `thickness` adds a Solidify (a cloth shell with an inside and a rolled
    edge); `levels` of subdivision smooth the whole thing."""
    bm = bmesh.new()
    rows = [[bm.verts.new(Vector(p)) for p in r] for r in rings]
    n = len(rows[0])
    for a, b in zip(rows, rows[1:]):
        for i in range(n if closed else n - 1):
            j = (i + 1) % n
            bm.faces.new((a[i], a[j], b[j], b[i]))
    if cap_start:
        bm.faces.new(tuple(reversed(rows[0])))
    if cap_end:
        bm.faces.new(tuple(rows[-1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = mesh_obj(name, bm, parent)
    if levels:
        subsurf(o, levels)
    if thickness:
        so = o.modifiers.new("Solid", "SOLIDIFY"); so.thickness = thickness; so.offset = -1
    return finish(o, mat, 0, smooth=smooth, outline=outline)

def hand(name, mat, parent=None, at=(0, 0, 0), rot=None, mirror=False, size=1.0,
         curl=((30, 40, 30), (35, 45, 35), (40, 50, 35), (45, 55, 40)), spread=(-8, -3, 3, 9),
         thumb=(35, 25), thumb_curl=(20, 30), levels=2, outline=True):
    """ONE-PIECE hand: a palm block with four fingers and a thumb grown from it, smoothed by subdivision (~2.7k tris).
    Built in a hand frame: the wrist at the origin, the fingers along +z, the back of the hand toward +y, the thumb on
    the -x side (mirror=True puts it on +x: the other hand). curl = per finger (index..little) the bend at its three
    joints in degrees, toward the palm; spread = each finger's splay; thumb = (out, forward) angles of the thumb's root
    and thumb_curl its two joints. `at` and `rot` (a quaternion) place it in the parent's space; size scales it
    (1.0 = a palm 0.62 wide, 0.58 long). Returns (object, marks): marks are points in the parent's space -
    "wrist", "palm" (the palm's centre), "back", "knuckle0..3", "tip0..3" (index..little), "thumb_root", "thumb_tip" -
    so a cigar can be laid between two fingertips and a cane's knob under the palm by construction."""
    S = size
    marks = {}
    W, L, T = 0.62 * S, 0.58 * S, 0.24 * S
    cols = [(-0.5 + i / 4) * W for i in range(5)]
    rows = (0.0, 0.42 * L, L)
    bm = bmesh.new()
    def place(p):
        q = Vector((-p.x if mirror else p.x, p.y, p.z))
        if rot:
            q = rot @ q
        return q + Vector(at)
    LV, V = {}, {}
    for li, y in enumerate((T / 2, -T / 2)):                 # 0 = the back of the hand, 1 = the palm
        for ri, z in enumerate(rows):
            for ci, x in enumerate(cols):
                p = Vector((x * (0.86 if ri == 0 else 1.0), y, z))
                LV[(li, ri, ci)] = p
                V[(li, ri, ci)] = bm.verts.new(place(p))
    def face(*keys):
        bm.faces.new(tuple(V[k] for k in keys))
    for ri in range(2):
        for ci in range(4):
            face((0, ri, ci), (0, ri, ci + 1), (0, ri + 1, ci + 1), (0, ri + 1, ci))
            face((1, ri, ci), (1, ri + 1, ci), (1, ri + 1, ci + 1), (1, ri, ci + 1))
    for ci in range(4):                                       # the wrist end (the cuff covers it)
        face((0, 0, ci), (1, 0, ci), (1, 0, ci + 1), (0, 0, ci + 1))
    face((0, 1, 4), (0, 2, 4), (1, 2, 4), (1, 1, 4)); face((0, 0, 4), (0, 1, 4), (1, 1, 4), (1, 0, 4))   # little-finger side
    face((0, 1, 0), (1, 1, 0), (1, 2, 0), (0, 2, 0))                                                   # thumb side, above the thumb
    def grow(base_keys, c0, d, a, nrm, segs, hw, hn):
        """segments of a finger from a base quad: each bends about the axis a by its angle, tapers a little, and the
        tip is capped"""
        ring = [V[k] for k in base_keys]
        for k, (ln, ang) in enumerate(segs):
            R = Matrix.Rotation(math.radians(ang), 3, a)   # a positive angle bends toward the palm
            d, nrm = (R @ d).normalized(), (R @ nrm).normalized()
            c0 = c0 + d * ln
            tp = 1.0 - 0.12 * (k + 1)
            corners = [c0 + nrm * hn * tp - a * hw * tp, c0 + nrm * hn * tp + a * hw * tp,
                       c0 - nrm * hn * tp + a * hw * tp, c0 - nrm * hn * tp - a * hw * tp]
            nxt = [bm.verts.new(place(p)) for p in corners]
            for i in range(4):
                bm.faces.new((ring[i], ring[(i + 1) % 4], nxt[(i + 1) % 4], nxt[i]))
            ring = nxt
        bm.faces.new(tuple(ring))
        return c0
    lengths = ((0.30, 0.22, 0.17), (0.33, 0.25, 0.18), (0.31, 0.23, 0.17), (0.25, 0.19, 0.15))
    for f in range(4):
        keys = ((0, 2, f), (0, 2, f + 1), (1, 2, f + 1), (1, 2, f))
        c0 = sum((LV[k] for k in keys), Vector()) / 4
        Rs = Matrix.Rotation(math.radians(spread[f]), 3, Vector((0, 1, 0)))
        d, a, nrm = Rs @ Vector((0, 0, 1)), Rs @ Vector((1, 0, 0)), Vector((0, 1, 0))
        marks[f"knuckle{f}"] = place(c0)
        marks[f"tip{f}"] = place(grow(keys, c0, d, a, nrm, [(lengths[f][k] * S, curl[f][k]) for k in range(3)], W / 8, T / 2))
    # the thumb, from the lower quad of the thumb side
    keys = ((0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0))
    c0 = sum((LV[k] for k in keys), Vector()) / 4
    out, fw = math.radians(thumb[0]), math.radians(thumb[1])
    d = Vector((-math.cos(fw) * math.cos(out), -math.cos(fw) * math.sin(out), math.sin(fw))).normalized()
    a = (Vector((0, 0, 1)) - d * d.z).normalized()
    nrm = a.cross(d).normalized()
    marks["thumb_root"] = place(c0)
    marks["thumb_tip"] = place(grow(keys, c0, d, a, nrm, [(0.30 * S, thumb_curl[0]), (0.24 * S, thumb_curl[1])], 0.21 * L, T / 2))
    marks["wrist"], marks["palm"], marks["back"] = place(Vector((0, 0, 0))), place(Vector((0, -T / 2, L * 0.5))), place(Vector((0, T / 2, L * 0.5)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = mesh_obj(name, bm, parent)
    if levels:
        subsurf(o, levels)
    return finish(o, mat, 0, outline=outline), marks

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
hat_stripe("Hat.Stripe", lambda z: 1.2 + (1.34 - 1.2) * (z - 0.09) / 2.35, 0.09, 0.09 + 2.35, 0.62, "Strap", parent=hat)

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
R, H, SEG = 1.5, 1.9, 36
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


# ---- Mr Bands himself, standing on the blotter behind his rows (the reference: web/3d/ref/mr-bands-full.png)
#      Every soft form is a METABALL family (one per material) so the masses merge into one sculpted surface: the head with its
#      jowls and nose, the hands with their fingers, the coat with its shoulders and sleeves, the waistcoat belly, the striped
#      trousers, the handlebar moustache. The crisp things stay primitives: the hat, the pixel shades, the bow tie, the cigar,
#      the cane, the buttons. Proportions are the reference's (a stout man, not a big-headed toy): ~13.3 tall to the hat's top,
#      the head a seventh of that, the legs nearly half. He faces the front of the desk (-y), turned toward the hero camera.
FIG_AT = (3.6, 5.3, 0.0)
FIG_YAW = 18
fig = empty("Figure", FIG_AT, desk)
fig.rotation_euler = (0, 0, math.radians(FIG_YAW))
RAD = math.radians
from mathutils import Quaternion, Matrix
# the head is its own frame: turned a little to his left and lifted, chin up, the cigar hand beside the cheek
head = empty("Fig.Head", (0, -0.05, 10.82), fig)   # lowered 0.23 (round 3 judges): the jowls sit in the collar, no neck column
head.rotation_euler = (RAD(-3), 0, RAD(14))
bpy.context.view_layer.update()

# metaballs: at stiffness 4 and threshold 0.6 the visible surface stands at 0.684 of the element's radius (measured)
MBK = 0.684
class Family:
    """One metaball object per material, its elements given in a parent's space and stored in world space."""
    def __init__(self, name, res):
        self.mb = bpy.data.metaballs.new(name); self.mb.resolution = res; self.mb.render_resolution = res; self.mb.threshold = 0.6
        self.ob = bpy.data.objects.new(name, self.mb); root.objects.link(self.ob)
    def _el(self, kind, parent, p):
        e = self.mb.elements.new(); e.type = kind; e.stiffness = 4.0
        e.co = parent.matrix_world @ Vector(p)
        return e
    def ball(self, parent, p, R):
        e = self._el("BALL", parent, p); e.radius = R / MBK
    def ell(self, parent, p, semi, rot=None):
        e = self._el("ELLIPSOID", parent, p); e.radius = 1.0
        e.size_x, e.size_y, e.size_z = (semi[0] / MBK, semi[1] / MBK, semi[2] / MBK)
        e.rotation = parent.matrix_world.to_quaternion() @ (rot or Quaternion())
    def cap(self, parent, a, b, R):
        """a limb: the caps' centres at the two joints"""
        wa, wb = parent.matrix_world @ Vector(a), parent.matrix_world @ Vector(b)
        d = wb - wa
        e = self.mb.elements.new(); e.type = "CAPSULE"; e.stiffness = 4.0
        e.co = (wa + wb) / 2; e.radius = R / MBK; e.size_x = max(0.01, d.length / 2)
        e.rotation = Vector((1, 0, 0)).rotation_difference(d.normalized())
    def mesh(self, name, mat, decimate, smooth=2):
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(self.ob.evaluated_get(dg))
        o = bpy.data.objects.new(name, me); root.objects.link(o)
        o.parent = fig; o.matrix_world = Matrix.Identity(4)
        dm = o.modifiers.new("Decimate", "DECIMATE"); dm.ratio = decimate
        sm = o.modifiers.new("Smooth", "SMOOTH"); sm.factor = 0.5; sm.iterations = smooth
        finish(o, mat, 0)
        root.objects.unlink(self.ob); bpy.data.objects.remove(self.ob); bpy.data.metaballs.remove(self.mb)
        return o

yaw = lambda deg: Quaternion((0, 0, 1), RAD(deg))
pitch = lambda deg: Quaternion((1, 0, 0), RAD(deg))
roll = lambda deg: Quaternion((0, 1, 0), RAD(deg))

# the families, all open at once so every region of the figure may add to any of them; they are meshed at the end
class F:
    legs = Family("MBStripe", 0.09)    # the trousers
    coat = Family("MBInk", 0.09)       # the coat, the shoes
    vest = Family("MBCloth", 0.09)     # the waistcoat
    skin = Family("MBIvory", 0.045)    # head, neck, hands (fine: nostrils, concha, creases are 0.05-0.09 features)
    paper = Family("MBPaper", 0.045)   # moustache, hair, shirt
    shoe = Family("MBShoe", 0.06)      # the shoes: their own family and material, so the engraving can polish them

# Each region below is one function; a region may add elements to any family and any primitive under `fig` or `head`.
# Coordinates are the figure's own (z up, feet at z = 0, facing -y, +x his left / the viewer's right) or the head's.
# Levels: ankle 0.5, knee 3.1, waist 5.9, belly 6.9, chest 8.3, shoulder 9.35, chin 10.15, head centre 10.82, brim front ~11.3, hat top ~12.6.

# >>> region: legs-shoes
def region_legs_shoes():
    """The trousers - seat, full thighs, a pressed crease down the front of each leg and, as the model sheet has them, NO
    turn-up: the cloth runs straight down and ends in one finished hem that breaks over the shoe - and the oxfords: a low
    slim last in its own polished family (F.shoe / "Shoe") on a thin welted sole with a stacked heel, a fine flush cap-toe
    seam, two quarter panels with the lacing throat carved down between them and four lace bars lying in it.
    He stands with his left leg (viewer's right) forward, the rear foot turned out, weight on the front leg."""

    def carve(fam, parent, p, semi, rot=None, k=2.4):
        """a metaball element that SUBTRACTS (the Family class only adds): used to cut the lacing throat into the vamp"""
        e = fam.mb.elements.new(); e.type = "ELLIPSOID"; e.stiffness = k
        e.co = parent.matrix_world @ Vector(p)
        e.radius = 1.0
        e.size_x, e.size_y, e.size_z = (semi[0] / MBK, semi[1] / MBK, semi[2] / MBK)
        e.rotation = parent.matrix_world.to_quaternion() @ (rot or Quaternion())
        e.use_negative = True
        return e

    # ---- the trousers.  hip -> knee -> ankle; the forward leg swung out and turned, the rear leg under him, its toe out
    LEGS = [
        # tag, hip,                 knee,                ankle
        ("L", (0.45, -0.30, 5.95), (0.95, -0.66, 3.15), (1.15, -1.06, 0.87), -10),
        ("R", (-0.45, -0.05, 5.95), (-0.70, 0.40, 3.15), (-0.88, 0.50, 0.87), 7),
    ]
    F.legs.ell(fig, (0, 0.20, 5.85), (0.96, 0.84, 0.68))            # the seat: a wide flat mass, not a pouch
    for tag, hip, knee, ank, tilt in LEGS:
        def at(z, hip=hip, knee=knee, ank=ank):
            """the leg's axis at height z (extrapolated below the ankle), so every detail hangs off the real centre line"""
            a, b = (hip, knee) if z >= knee[2] else (knee, ank)
            t = (a[2] - z) / (a[2] - b[2])
            return (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
        A = lambda z: (at(z)[0], at(z)[1], z)
        # full at the thigh, then an EVEN taper to the hem in three 0.03 steps the 0.09 resolution smooths out, so the
        # outer contour is one straight line from knee to shoe with no kink at mid-shin
        F.legs.cap(fig, hip, knee, 0.54)                            # thigh
        F.legs.cap(fig, knee, A(2.55), 0.43)
        F.legs.cap(fig, A(2.55), A(1.90), 0.40)
        F.legs.cap(fig, A(1.90), A(1.00), 0.365)                    # the cloth ends INSIDE the hem band
        F.legs.ell(fig, (at(5.05)[0], at(5.05)[1] - 0.02, 5.05), (0.54, 0.58, 0.95))   # thigh fullness
        # the pressed front crease: one soft ridge standing ~0.06 proud down the thigh and down the shin, dying out
        # above the break so no tail can re-emerge below it as a nib
        F.legs.ell(fig, (at(4.55)[0], at(4.55)[1] - 0.455, 4.55), (0.10, 0.16, 1.55), pitch(tilt))
        F.legs.ell(fig, (at(2.40)[0], at(2.40)[1] - 0.355, 2.40), (0.09, 0.14, 1.10), pitch(tilt))
        # the break: one shallow fold across the front of the shin where the trouser lands on the shoe
        F.legs.ell(fig, (at(1.34)[0], at(1.34)[1] - 0.330, 1.34), (0.29, 0.075, 0.055))
        F.legs.ell(fig, (at(1.12)[0], at(1.12)[1] - 0.320, 1.12), (0.24, 0.060, 0.045))
        # the hem: NO turn-up (the sheet). One short cone of cloth on the leg's own axis, ~0.014 proud of the trouser at
        # the top (a hairline the metaball can never poke through, so nothing serrates) and 0.02 proud at the bottom: the
        # ONE edge round the bottom of the leg is the finished hem, a clean ring on the shoe's throat, nosing forward
        bone(f"Fig.Trouser.Hem.{tag}", (at(0.60)[0], at(0.60)[1] - 0.055, 0.60), A(0.86), 0.390, "Stripe",
             parent=fig, r2=0.380, verts=28, bevel=0.014)

    # ---- the oxfords.  one builder per foot: everything is placed t forward of the ankle and w across it.
    #      The upper is its own metaball family (F.shoe / "Shoe"): the engraving polishes that material, so the leather
    #      carries a broad gleam and the dark lines are the cap seam, the laces and the welt (sole and heel stay Ink).
    def oxford(tag, ank, ydeg):
        sy, cy = math.sin(RAD(ydeg)), math.cos(RAD(ydeg))
        d, u = (sy, -cy), (cy, sy)                      # toe direction and across-the-foot, in plan
        P = lambda t, w, z: (ank[0] + t * d[0] + w * u[0], ank[1] + t * d[1] + w * u[1], z)
        Y, TILT = RAD(ydeg), RAD(6)                     # the foot pitches 6 deg, heel up on its stacked heel
        # long and low, a pointed-oval toe: height ~0.3 of the length
        F.shoe.ell(fig, P(0.42, 0, 0.36), (0.34, 0.80, 0.20), yaw(ydeg) @ pitch(6))     # the last
        F.shoe.ell(fig, P(1.02, 0, 0.265), (0.28, 0.30, 0.175), yaw(ydeg) @ pitch(6))   # the toe CAP
        F.shoe.ell(fig, P(1.20, 0, 0.225), (0.17, 0.20, 0.125), yaw(ydeg) @ pitch(6))   # the flat tip
        F.shoe.ell(fig, P(0.16, 0, 0.43), (0.29, 0.34, 0.21), yaw(ydeg))                # the instep
        F.shoe.ell(fig, P(0.00, 0, 0.46), (0.31, 0.23, 0.30), yaw(ydeg))                # the throat, filling the hem
        F.shoe.ell(fig, P(-0.27, 0, 0.35), (0.26, 0.19, 0.26), yaw(ydeg))               # the counter, walling down to the heel
        # the lacing: two quarter panels standing ~0.04 proud of the vamp with the throat cut down between them, so the
        # laces lie IN a V and the shoe is not a loaf with sticks on it
        for s in (-1, 1):
            F.shoe.ell(fig, P(0.44, s * 0.165, 0.500), (0.16, 0.30, 0.060), yaw(ydeg) @ pitch(6))
        carve(F.shoe, fig, P(0.48, 0, 0.600), (0.070, 0.26, 0.075), yaw(ydeg) @ pitch(6), k=2.2)
        # the sole: ONE thin slab standing a little proud of the upper all round, so the welt takes a single edge line
        sl = cyl(f"Fig.Shoe.{tag}.Sole", 1.0, 0.065, P(0.42, 0, 0.128), "Ink", 0.012, parent=fig, verts=32, segments=1)
        sl.scale = (0.355, 0.915, 1.0)
        sl.rotation_euler = (TILT, 0, Y)
        # the heel: one stacked block, its back flush with the counter, its top tucked into the tilted sole
        hl = cyl(f"Fig.Shoe.{tag}.Heel", 1.0, 0.19, P(-0.27, 0, 0.095), "Ink", 0.012, parent=fig, verts=24, segments=1)
        hl.scale = (0.275, 0.200, 1.0)
        hl.rotation_euler = (0, 0, Y)
        # the cap-toe seam: a fine thread fitted to the last's section, flush with the leather - a dark line with the
        # shoe's own gleam on either side of it, not a strap over the toe
        torus(f"Fig.Shoe.{tag}.Cap", 0.296, 0.020, P(0.80, 0, 0.314), "Ink",
              parent=fig, rot=(RAD(96), 0, Y), scale=(1.0, 0.60, 1.0), seg=32, ring=6)
        # the quarter edges, half sunk in the leather, and four lace bars set down in the throat between them
        for s in (-1, 1):
            bone(f"Fig.Shoe.{tag}.QtrEdge.{s}", P(0.26, s * 0.140, 0.622), P(0.78, s * 0.078, 0.477), 0.012, "Ink",
                 parent=fig, verts=8, bevel=0)
        for i, (t, z, hw, a) in enumerate(((0.40, 0.580, 0.118, 1), (0.51, 0.551, 0.105, -1),
                                           (0.62, 0.528, 0.092, 1), (0.73, 0.518, 0.079, -1))):
            bone(f"Fig.Shoe.{tag}.Lace.{i}", P(t - 0.012 * a, -hw, z), P(t + 0.012 * a, hw, z), 0.014, "Ink",
                 parent=fig, verts=8, bevel=0)

    oxford("L", (1.15, -1.06), 30)
    oxford("R", (-0.88, 0.50), -30)
# <<< region: legs-shoes

# >>> region: coat-torso
def region_coat_torso():
    """The suit, CUT AND SEWN - no lumps, no pasted plates.

    ONE TABLE (RING) is the coat: at each height, the centre of the section (the belly carries it forward), its half
    width, its depth in front and behind, and the x where its FRONT EDGE falls. The body is a single lofted shell of
    OPEN-FRONT rings - broad sloping shoulders, a V the belly pushes apart, a hem below the knee that hangs straight
    down the sides - with a Solidify thickness so every edge rolls. The NOTCH LAPELS are not laid on that shell: they
    ARE it. Each ring carries two extra columns beyond its front edge, so the cloth folds back outward along the roll
    line and the coat's own cut edge runs up the lapel, round the notch and into the gorge. The COLLAR is draped down
    the shoulders BY ARC LENGTH off the neck hole, so it lies on the cloth wherever the cloth happens to be, and its
    ends flare up into two points with the notch left open between them and the lapels.

    Everything else is computed from the same table and therefore touches the garment by construction: the flap
    POCKETS on the skirt, the breast welt with its three-point square, the HALF-BELT at the back with two buttons and
    the VENT overlapping below it. The SLEEVES are tubes swept along the arms to the contract wrists and ended in
    turned-back CUFFS with the white shirt cuff inside them.

    Under the coat: a lofted WAISTCOAT over the belly with a POINTED HEM, five brass buttons, a welt pocket with the
    watch half in it and the chain swagged up to the middle button; a narrow shirt V under a winged collar; the
    orange butterfly BOW TIE, three lofts, with a knot."""

    # ---------------------------------------------------------------- the coat's cross-sections
    RING = [
        # z      cy     rx    ryf   ryb    ex     the front edge / roll line
        (9.72,  0.05, 0.76, 0.58, 0.62, 0.30),   # the neck hole the collar is sewn to
        (9.56,  0.08, 1.10, 0.68, 0.76, 0.40),
        (9.36,  0.08, 1.55, 0.82, 0.90, 0.48),   # the shoulder, sloping out of the collar
        (9.10,  0.06, 1.61, 0.94, 0.99, 0.54),
        (8.60,  0.04, 1.58, 1.06, 1.04, 0.60),   # chest
        (8.00,  0.00, 1.52, 1.18, 1.07, 0.65),
        (7.40, -0.06, 1.49, 1.28, 1.10, 0.70),   # the belly pushes the fronts apart
        (6.85, -0.10, 1.48, 1.33, 1.13, 0.73),
        (6.35, -0.08, 1.47, 1.29, 1.15, 0.74),
        (5.75, -0.04, 1.46, 1.28, 1.17, 0.74),   # waist
        (5.00, -0.04, 1.48, 1.26, 1.16, 0.68),
        (4.20, -0.12, 1.56, 1.40, 1.17, 0.72),
        (3.40, -0.18, 1.60, 1.55, 1.20, 0.80),   # the hem, just below the knee, clear of the striding leg
    ]
    # the lapel, per ring: how far out its fold rolls (xm) and where its outer edge - the coat's own cut edge - lands
    # (xe), each with its own drop in z, so the two top rows draw the lapel's TOP EDGE falling away to its point.
    LAPEL = {1: (0.56, -0.06), 2: (0.80, -0.12), 3: (1.30, 0.10), 4: (1.00, 0.0),
             5: (0.98, 0.0), 6: (0.95, 0.0)}
    NARC = 16                       # points round the open arc of each ring
    ZT, ZB = RING[0][0], RING[-1][0]

    def P(z):
        """the section at height z, interpolated down the table"""
        if z >= ZT: return RING[0][1:]
        if z <= ZB: return RING[-1][1:]
        for a, b in zip(RING, RING[1:]):
            if b[0] <= z <= a[0]:
                t = (a[0] - z) / (a[0] - b[0])
                return tuple(a[i] + (b[i] - a[i]) * t for i in range(1, 6))
        return RING[-1][1:]

    def front_y(x, z, out=0.0):
        """the y of the coat's FRONT surface at (|x|, z), pushed `out` forward"""
        cy, rx, ryf, ryb, ex = P(z)
        t = min(1.0, abs(x) / rx)
        return cy - ryf * math.sqrt(max(0.0, 1.0 - t * t)) - out

    def back_y(x, z, out=0.0):
        cy, rx, ryf, ryb, ex = P(z)
        t = min(1.0, abs(x) / rx)
        return cy + ryb * math.sqrt(max(0.0, 1.0 - t * t)) + out

    def fp(x, z, out=0.0):
        return Vector((x, front_y(x, z, out), z))

    def bp(x, z, out=0.0):
        return Vector((x, back_y(x, z, out), z))

    def body_pt(z, ang, out=0.0):
        """the point on the shell at height z and plan angle ang (0 = +x, 90 = the back, 270 = the front)"""
        cy, rx, ryf, ryb, ex = P(z)
        c, s = math.cos(RAD(ang)), math.sin(RAD(ang))
        ry = ryb if s > 0 else ryf
        n = Vector((c / rx, s / ry, 0.0))
        n = n.normalized() if n.length > 1e-9 else Vector((0, 1, 0))
        return Vector((rx * c, cy + ry * s, z)) + n * out

    def drape(ang, dist, out=0.03, z0=None):
        """walk DOWN the shell from the neck hole in direction ang until `dist` of cloth has been laid: where a
        collar of that width comes to rest, whatever the shoulder is doing underneath"""
        z = ZT if z0 is None else z0
        p = body_pt(z, ang, out)
        acc = 0.0
        while z > 8.4 and acc < dist:
            q = body_pt(z - 0.015, ang, out)
            acc += (q - p).length
            p, z = q, z - 0.015
        return p

    # ---------------------------------------------------------------- the coat's body, lapels and all
    rings = []
    for i, (z, cy, rx, ryf, ryb, ex) in enumerate(RING):
        g = 2 * math.degrees(math.asin(min(0.995, ex / rx)))
        arc = []
        for p in ellipse((0, cy, z), rx, 1.0, NARC, None, -90 + g / 2, 270 - g / 2):
            dy = p.y - cy
            arc.append(Vector((p.x, cy + dy * (ryb if dy > 0 else ryf), z)))
        lap = LAPEL.get(i)
        cols = {}
        for sx, edge in ((1, arc[0]), (-1, arc[-1])):
            if lap is None:      # no lapel here: a hairline of cloth turning back inside, the coat's finished edge
                cols[sx] = [edge + Vector((sx * 0.030, 0.045, 0.0)), edge + Vector((sx * 0.018, 0.016, 0.0))]
            else:
                xe, dze = lap
                xm = ex + 0.32 * (xe - ex)
                w = min(1.0, (xe - ex) / 0.45)     # near the gorge the lapel is narrow: it must not stand up as a fin
                cols[sx] = [Vector((sx * xe, front_y(xe, z, 0.018 + 0.040 * w), z + dze)),   # the cut edge, off the chest
                            Vector((sx * xm, front_y(xm, z, 0.035 + 0.085 * w), z + 0.35 * dze))]   # the roll, proud
        rings.append(cols[1] + arc + list(reversed(cols[-1])))
    loft("Fig.Coat.Body", rings, "Ink", parent=fig, closed=False, levels=1, thickness=0.075)

    # ---------------------------------------------------------------- the collar, turned down over the shoulders
    g0 = 2 * math.degrees(math.asin(RING[0][5] / RING[0][2]))
    A0, A1 = -90 + g0 / 2, 270 - g0 / 2                     # the collar spans exactly the coat's neck opening
    crings = []
    CN = 12
    for k in range(CN):
        t = k / (CN - 1.0)
        ang = A0 + (A1 - A0) * t
        u = abs(2 * t - 1.0)
        fl = max(0.0, (u - 0.55) / 0.45) ** 1.4             # the two ends flare up into the notch
        sx = 1.0 if ang < 90 else -1.0
        base = body_pt(ZT, ang, 0.0)
        stand = body_pt(ZT, ang, 0.05) + Vector((0, 0, 0.30 - 0.13 * u * u))
        W = 0.42 + 0.20 * fl
        mid = drape(ang, W * 0.45, 0.035)
        edge = drape(ang, W, 0.035)
        nrm = Vector((mid.x, mid.y - P(mid.z)[0], 0.0))
        nrm = nrm.normalized() if nrm.length > 1e-6 else Vector((0, 1, 0))
        fold = mid + nrm * 0.07 + Vector((sx * 0.08 * fl, 0, 0.19 - 0.07 * u * u + 0.08 * fl))
        edge = edge + Vector((sx * 0.34 * fl, -0.05 * fl, 0.15 * fl))
        tip = max(0.0, (u - 0.86) / 0.14)            # the collar dies in a point, not a paddle
        edge = fold + (edge - fold) * (1.0 - 0.35 * tip)
        crings.append([base, stand, fold, edge])
    loft("Fig.Collar.Coat", crings, "Ink", parent=fig, closed=False, levels=2, thickness=0.05)

    # ---------------------------------------------------------------- sleeves, cuffs, shirt cuffs
    # the arms keep last round's pose: the right elbow tucked in and the forearm rising so the hand sits beside the
    # cheek, the left hanging to the cane. Both END at the wrist points of the contract, along the contract direction.
    ARMS = {
        "R": (Vector((1.57, -1.41, 9.91)), Vector((-0.20, -0.24, 0.56)).normalized(),
              [(1.30, 0.16, 9.10), (1.76, 0.02, 8.60), (2.06, -0.42, 8.02), (2.16, -0.78, 7.68),
               (1.99, -1.05, 8.30), (1.87, -1.13, 8.82)],
              [0.52, 0.47, 0.43, 0.39, 0.35, 0.32]),
        "L": (Vector((-2.30, -0.85, 5.84)), Vector((0.0, -0.41, -0.86)).normalized(),
              [(-1.32, 0.18, 9.16), (-1.82, 0.24, 8.50), (-2.18, 0.16, 7.82), (-2.32, -0.02, 7.24),
               (-2.31, -0.26, 6.86)],
              [0.52, 0.47, 0.43, 0.38, 0.33]),
    }
    for tag, (W, u, path, radii) in ARMS.items():
        c1 = W - u * 0.20                              # the cuff's mouth, the wrist just out of it
        c0 = W - u * 0.70                              # where the cuff is turned back on the sleeve
        sleeve = list(path) + [tuple(W - u * 0.76), tuple(c0 + u * 0.06)]
        rr = list(radii) + [0.295, 0.285]
        loft(f"Fig.Sleeve.{tag}", tube_rings(sleeve, rr, 12), "Ink", parent=fig,
             cap_start=True, cap_end=True, levels=1)
        cuff = [tuple(c0), tuple(c0 + u * 0.05), tuple(c0 + (c1 - c0) * 0.62), tuple(c1)]
        loft(f"Fig.Cuff.Coat.{tag}", tube_rings(cuff, [0.30, 0.375, 0.375, 0.355], 12), "Ink", parent=fig,
             levels=1, thickness=0.05)
        loft(f"Fig.Cuff.{tag}", tube_rings([tuple(c1 - u * 0.10), tuple(W + u * 0.03)], [0.255, 0.25], 12),
             "Paper", parent=fig, cap_start=True, cap_end=True, levels=1)
        side = Vector((0, 0, 1)).cross(u).normalized() * (1 if tag == "R" else -1)
        sphere(f"Fig.Cuff.Button.{tag}", 0.058, tuple(c0 + (c1 - c0) * 0.45 + side * 0.37), "Ink",
               parent=fig, seg=(10, 6))
        sphere(f"Fig.Cuff.Link.{tag}", 0.07, tuple(c1 + u * 0.14 - side * 0.22), "Brass", parent=fig, seg=(8, 5))

    # ---------------------------------------------------------------- the back: half-belt, its buttons, the vent
    belt = []
    for i in range(9):
        x = -1.04 + 2.08 * i / 8.0
        belt.append([bp(x, 6.58, 0.032), bp(x, 6.14, 0.032)])
    loft("Fig.Coat.HalfBelt", belt, "Ink", parent=fig, closed=False, levels=0, thickness=0.075, smooth=False)
    for sx in (-1, 1):
        sphere(f"Fig.Coat.Belt.Button.{sx}", 0.105, tuple(bp(sx * 0.50, 6.36, 0.135)), "Ink",
               parent=fig, scale=(1, 0.45, 1), seg=(10, 5))
    vent = []
    for i in range(4):
        x = 0.40 * i / 3.0
        o = 0.085 - 0.145 * (i / 3.0)
        vent.append([bp(x, z, o) for z in (6.34, 5.30, 4.35, 3.40)])
    loft("Fig.Coat.Vent", vent, "Ink", parent=fig, closed=False, levels=0, thickness=0.05, smooth=False)

    # ---------------------------------------------------------------- pockets, and the two waist buttons
    for sx in (-1, 1):
        flap = []
        for i in range(5):
            x = 1.06 + 0.40 * i / 4.0
            flap.append([Vector((sx * x, front_y(x, 5.46, 0.03), 5.46)),
                         Vector((sx * x, front_y(x, 5.14, 0.075), 5.14))])
        loft(f"Fig.Coat.Flap.{sx}", flap, "Ink", parent=fig, closed=False, levels=1, thickness=0.05)
        for j, z in enumerate((6.90, 6.38)):
            bx = P(z)[4] + 0.16
            sphere(f"Fig.Coat.Button.{j}.{sx}", 0.082, (sx * bx, front_y(bx, z, 0.035), z), "Ink",
                   parent=fig, scale=(1, 0.28, 1), seg=(10, 5))
    # the breast pocket, outside the lapel: a welt and a square folded into three points standing over it
    welt = []
    for i in range(4):
        x = 1.04 + 0.24 * i / 3.0
        welt.append([Vector((x, front_y(x, 8.20, 0.04), 8.20)), Vector((x, front_y(x, 8.08, 0.04), 8.08))])
    loft("Fig.Welt", welt, "Ink", parent=fig, closed=False, levels=0, thickness=0.05, smooth=False)
    bl = bmesh.new()
    B = [bl.verts.new(tuple(fp(x, 8.19, 0.055))) for x in (1.06, 1.12, 1.18, 1.24)]
    T = [bl.verts.new(tuple(fp(x, z, 0.070))) for (x, z) in ((1.09, 8.34), (1.15, 8.38), (1.21, 8.31))]
    for i in range(3):
        bl.faces.new((B[i], T[i], B[i + 1]))
        if i < 2:
            bl.faces.new((B[i + 1], T[i], T[i + 1]))
    bmesh.ops.recalc_face_normals(bl, faces=bl.faces)
    sq = mesh_obj("Fig.Square", bl, fig)
    ss = sq.modifiers.new("Solid", "SOLIDIFY"); ss.thickness = 0.035; ss.offset = 0
    finish(sq, "Paper", 0.006, 1)

    # ---------------------------------------------------------------- the waistcoat
    VRING = [
        (9.25,  0.06, 0.84, 0.66),
        (8.60,  0.02, 1.02, 0.84),
        (7.95, -0.02, 1.08, 0.94),
        (7.30, -0.06, 1.10, 1.00),
        (6.70, -0.08, 1.08, 1.00),
        (6.20, -0.05, 1.02, 0.95),
        (5.92,  0.00, 0.92, 0.86),
    ]

    def VP(z):
        if z >= VRING[0][0]: return VRING[0][1:]
        if z <= VRING[-1][0]: return VRING[-1][1:]
        for a, b in zip(VRING, VRING[1:]):
            if b[0] <= z <= a[0]:
                t = (a[0] - z) / (a[0] - b[0])
                return tuple(a[i] + (b[i] - a[i]) * t for i in range(1, 4))
        return VRING[-1][1:]

    def vest_y(x, z, out=0.0):
        cy, rx, ry = VP(z)
        t = min(1.0, abs(x) / rx)
        return cy - ry * math.sqrt(max(0.0, 1.0 - t * t)) - out

    VN = 16
    vrings = [ellipse((0, cy, z), rx, ry, VN) for (z, cy, rx, ry) in VRING]
    hem = []                                    # the POINTED hem: the front of the last ring dips to a point
    for p in ellipse((0, VRING[-1][1], 0.0), VRING[-1][2] * 0.97, VRING[-1][3] * 0.97, VN):
        f = max(0.0, -(p.y - VRING[-1][1]) / VRING[-1][3])
        hem.append(Vector((p.x, p.y, VRING[-1][0] - 0.06 - 0.40 * f ** 2.2)))
    vrings.append(hem)
    loft("Fig.Waistcoat", vrings, "Cloth", parent=fig, cap_start=True, cap_end=True, levels=1)
    stand = []
    for i in range(9):
        z = 8.55 - (8.55 - 5.62) * i / 8.0
        stand.append([Vector((-0.11, vest_y(-0.11, z, 0.012), z)), Vector((0.15, vest_y(0.15, z, 0.012), z))])
    loft("Fig.Vest.Stand", stand, "Cloth", parent=fig, closed=False, levels=1, thickness=0.035)
    for i, z in enumerate((8.28, 7.76, 7.24, 6.72, 6.20)):
        sphere(f"Fig.Vest.Button.{i}", 0.082, (0.02, vest_y(0.02, z, 0.062), z), "Brass",
               parent=fig, scale=(1, 0.45, 1), seg=(10, 5))
    # the welt pocket, the watch half sunk in it, and the chain swagged up to the middle button
    vwelt = []
    for i in range(4):
        x = -0.80 + 0.44 * i / 3.0
        vwelt.append([Vector((x, vest_y(x, 6.80, 0.035), 6.80)), Vector((x, vest_y(x, 6.66, 0.035), 6.66))])
    loft("Fig.Vest.Pocket", vwelt, "Ink", parent=fig, closed=False, levels=0, thickness=0.04, smooth=False)
    wx = -0.58
    cyl("Fig.Watch", 0.15, 0.05, (wx, vest_y(wx, 6.86, 0.005), 6.86), "Brass", 0.012,
        rot=(RAD(90), 0, 0), parent=fig, verts=18, segments=1)
    CH = []
    for i in range(11):
        t = i / 10.0
        x = 0.02 - 0.60 * t
        z = 7.24 - 0.30 * t - 0.26 * math.sin(math.pi * t)
        CH.append((x, vest_y(x, z, 0.055), z))
    for i in range(len(CH) - 1):
        bone(f"Fig.Chain.{i}", CH[i], CH[i + 1], 0.026, "Brass", parent=fig, verts=6, bevel=0)

    # ---------------------------------------------------------------- shirt, winged collar, bow tie
    SH = ((9.98, 0.30, -0.44), (9.70, 0.30, -0.54), (9.35, 0.27, -0.63), (9.00, 0.21, -0.70), (8.62, 0.10, -0.76))
    loft("Fig.Shirt", [[Vector((-w, y, z)), Vector((0, y - 0.05, z)), Vector((w, y, z))] for (z, w, y) in SH],
         "Paper", parent=fig, closed=False, levels=1, thickness=0.05)
    cyl("Fig.Collar", 0.62, 0.42, (0, -0.02, 9.80), "Paper", 0.03, parent=fig, verts=20, r2=0.56)
    for sx in (-1, 1):
        bl = bmesh.new()
        v = (bl.verts.new((sx * 0.10, -0.52, 9.99)), bl.verts.new((sx * 0.40, -0.40, 9.92)),
             bl.verts.new((sx * 0.32, -0.60, 9.74)))
        bl.faces.new(v)
        bmesh.ops.recalc_face_normals(bl, faces=bl.faces)
        wg = mesh_obj(f"Fig.Collar.Wing.{sx}", bl, fig)
        ws = wg.modifiers.new("Solid", "SOLIDIFY"); ws.thickness = 0.05; ws.offset = 0
        finish(wg, "Paper", 0.008, 1)
    # the bow (the sheet's accessories panel): a BUTTERFLY - a small knot, two FLAT wings pinched at the knot and flaring
    # tall at their ends, standing out in front of the shirt (a wing that curved back round the neck was swallowed by
    # the lapels and read as a balloon). Each ring is a thin rounded slab in the y-z plane, so the wing has a straight
    # top edge and a straight bottom edge and a flat face, which is what a bow is.
    BZ, BY = 9.56, -0.80
    box("Fig.Bow.Knot", (0.19, 0.17, 0.24), (0, BY - 0.02, BZ), "Strap", 0.05, parent=fig, segments=3)
    def slab(x, y, z, tall, deep):
        h, d = tall / 2 - deep / 2, deep / 2
        return [Vector((x, y + dy, z + dz)) for (dy, dz) in ((-d, h), (0, h + d * 0.6), (d, h), (d, 0), (d, -h), (0, -h - d * 0.6), (-d, -h), (-d, 0))]
    for sx in (-1, 1):
        wrings = []
        for (ux, tall, deep) in ((0.09, 0.15, 0.08), (0.20, 0.19, 0.09), (0.36, 0.28, 0.08), (0.50, 0.34, 0.07), (0.56, 0.33, 0.06)):
            wrings.append(slab(sx * ux, BY + 0.10 * (ux / 0.56) ** 2, BZ + 0.01 * (ux / 0.56), tall, deep))
        loft(f"Fig.Bow.Wing.{sx}", wrings, "Strap", parent=fig, cap_start=True, cap_end=True, levels=1)
# <<< region: coat-torso

# >>> region: head-face
def region_head_face():
    """The head, the moustache and the hair, MODELLED - lofted surfaces under subdivision, not metaballs.

    The metaball head could not make a face any more than it could make a hand: every element left a lump and
    the engraving hatched each one, so the cheeks, the jowls and the chin read as a bag of bumps and the
    moustache as a bent tube with a knob.  Everything here is a SURFACE SKINNED OVER RINGS, and there are only
    seven forms in the whole region - skull+neck, nose, moustache, mouth, teeth, ear, hair - because the
    engraving reads big smooth shapes and punishes small ones.

    From the MODEL SHEET's head panel (web/3d/ref/mr-bands-sheet.png):
      SKULL   one loft from the neck to the crown: round, a little wider than deep, the jowls the widest rings
              and pushed forward, then two rings of DOUBLE CHIN rolling forward before they narrow into the
              NECK, which is the same loft's last rings - so there is no join anywhere from the collar to the
              crown and no crease for the hatching to find.
      NOSE    a SMALL button: five rings, the tip 0.2 proud of the cheek plane, sitting below the shades'
              bottom row and above the moustache; the moustache projects further, as the sheet's profile has it.
      MOUSTACHE  the big white HANDLEBAR: one swept tube per side from the philtrum, taller than it is deep so
              it has a top edge and a bottom edge, thickest over the lip, tapering out along the cheek to a tip
              that curls UP past the face's silhouette.  Its centreline is laid ON the skin by face_y, so the
              wing wraps the cheek instead of flying off it as a horn, and the two sides cross the midline and
              fuse under the nose, which parts them exactly where a moustache parts.
      MOUTH   the LAUGHING crescent: one lens-shaped tube, 1.05 wide and 0.26 tall in the middle, its corners
              cocked UP under the moustache's wings, sunk into the face so what the engraving draws is a dark
              crescent in the skin, with a bar of Paper TEETH along its top edge.
      EAR     one shell per side: rings stacked up the ear's own height, each a lens through the skull, so the
              ear is a plate with a thick middle and edges that land ON the cheek - no floating rim, no pebble.
              It breaks the silhouette by 0.12 and is bare in front, as the sheet's side and 3/4 views have it.
      HAIR    ONE white shell round the back of the head: arcs from the temple round the nape, lofted into a
              sheet and given thickness, wide under the brim, arching OVER the ears and dropping to a free edge
              at the nape.  It is one mass, not a band of tufts, and nothing rises above the brim (head z 0.44).
    Room is left for the other region: the shades' plate at head z -0.04..0.38 on radius ~0.98 (the skull is
    0.95 there, so the lenses stand proud and their inner face is buried), the brim at 0.44, the arms at
    z ~0.32 outside the hair, the cigar hand beside his left cheek.  No eyebrows: the shades cover them."""

    # ---------------------------------------------------------------- the skull, the jowls, the neck: ONE loft
    N = 14             # points round each ring
    SH = 0.967         # a 14-gon's Catmull-Clark limit circle is 0.967 of it: the tables below are 3% oversize
    # (z, rx, ry, cy)  rx across, ry fore-and-aft, cy the ring's centre in y (negative pushes the face forward)
    SKULL = [
        (-1.30, 0.52, 0.52,  0.10),   # the neck's foot, inside the collar (fig z ~9.53, collar 9.59..10.01)
        (-1.18, 0.56, 0.56,  0.06),   # the neck: one tube of radius ~0.55, as the collar asks
        (-1.06, 0.64, 0.66,  0.00),   # under the jaw
        (-0.94, 0.78, 0.81, -0.10),   # the lower roll of the double chin, coming forward
        (-0.82, 0.87, 0.87, -0.14),   # the upper roll: the chin itself, sitting on it
        (-0.66, 0.94, 0.90, -0.13),
        (-0.48, 0.99, 0.92, -0.11),   # the jowls: the widest rings, and the furthest forward
        (-0.28, 1.02, 0.92, -0.06),
        (-0.08, 1.02, 0.91, -0.02),   # the cheeks
        ( 0.14, 1.00, 0.90,  0.00),   # the shades' bottom rows
        ( 0.34, 0.96, 0.87,  0.02),   # the shades' top row
        ( 0.54, 0.87, 0.79,  0.04),   # the forehead, all of it in the brim's shadow
        ( 0.72, 0.72, 0.66,  0.05),
        ( 0.88, 0.49, 0.45,  0.06),
        ( 1.00, 0.19, 0.18,  0.06),   # the crown, capped
    ]
    loft("Fig.Head.Skull", [ellipse((0, cy, z), rx, ry, N) for (z, rx, ry, cy) in SKULL],
         "Ivory", parent=head, cap_start=True, cap_end=True, levels=2)

    def profile(z):
        """the skull's ring at height z (its limit values), interpolated from the table"""
        if z <= SKULL[0][0]:
            r = SKULL[0]
        elif z >= SKULL[-1][0]:
            r = SKULL[-1]
        else:
            r = SKULL[0]
            for a, b in zip(SKULL, SKULL[1:]):
                if a[0] <= z <= b[0]:
                    t = (z - a[0]) / (b[0] - a[0])
                    r = [a[i] + (b[i] - a[i]) * t for i in range(4)]
                    break
        return r[1] * SH, r[2] * SH, r[3]

    def face_y(x, z, lift=0.0, hug=1.0):
        """where the skin is at (x, z), `lift` proud of it.  Everything laid on the face is placed against this,
        so nothing floats off the cheek and nothing sinks into it; `hug` clamps |x| to a fraction of the ring so a
        form may run past the silhouette (a moustache tip) and still keep the cheek's depth."""
        rx, ry, cy = profile(z)
        xx = max(-hug * rx, min(hug * rx, x))
        return cy - ry * math.sqrt(max(0.0, 1.0 - (xx / rx) ** 2)) - lift

    # ---------------------------------------------------------------- the nose: a small button
    NOSE = [(-0.04, -0.83, 0.10, 0.08),   # (z, cy, rx, ry) the root, flush with the face under the shades' bridge
            (-0.13, -0.93, 0.15, 0.135),
            (-0.23, -0.99, 0.200, 0.170),  # the bulb: its tip at y -1.16, 0.2 proud of the cheek plane
            (-0.33, -0.96, 0.175, 0.150),
            (-0.42, -0.90, 0.10, 0.09)]    # the base, running into the moustache
    loft("Fig.Head.Nose", [ellipse((0, cy, z), rx, ry, 12) for (z, cy, rx, ry) in NOSE],
         "Ivory", parent=head, cap_start=True, cap_end=True, levels=1)

    # ---------------------------------------------------------------- the handlebar MOUSTACHE
    # (x, z, tall, deep, lift): the wing's centreline in x and z, its section, and how far it stands off the skin.
    # tube_rings turns a ring's own x up when its path runs sideways, so (tall, deep) makes a swept plane with a
    # top edge and a bottom edge - not the round rod of the last round.  The last two points curl UP.
    MOU = [(-0.10, -0.41, 0.150, 0.120, 0.055),   # across the midline: the two wings fuse under the nose
           ( 0.18, -0.46, 0.175, 0.130, 0.065),   # thickest over the lip
           ( 0.44, -0.47, 0.170, 0.125, 0.070),
           ( 0.68, -0.44, 0.145, 0.110, 0.080),
           ( 0.88, -0.35, 0.125, 0.092, 0.090),   # sweeping up the cheek, still with some mass in it
           ( 1.00, -0.23, 0.092, 0.075, 0.095),
           ( 1.07, -0.13, 0.066, 0.056, 0.095),
           ( 1.09, -0.04, 0.044, 0.040, 0.090),
           ( 1.06,  0.03, 0.022, 0.024, 0.082)]   # the tip, curled up past the cheek's silhouette
    for sx in (-1, 1):
        path = [(sx * x, face_y(sx * x, z, lift, 0.93), z) for (x, z, _t, _d, lift) in MOU]
        loft(f"Fig.Moustache.{sx}", tube_rings(path, [(m[2], m[3]) for m in MOU], 8),
             "Paper", parent=head, cap_start=True, cap_end=True, levels=2)

    # ---------------------------------------------------------------- the laughing MOUTH and its teeth
    # (x, z, tall, deep): the crescent's centreline, 1.05 across, 0.26 tall in the middle, corners cocked up
    # under the moustache's wings.  Sunk 0.04 into the skin, so the dark shape is a crescent cut in the face.
    MOUTH = [(-0.52, -0.60, 0.035, 0.05), (-0.37, -0.70, 0.090, 0.080), (-0.19, -0.77, 0.120, 0.094),
             ( 0.00, -0.79, 0.130, 0.100),
             ( 0.19, -0.77, 0.120, 0.094), ( 0.37, -0.70, 0.090, 0.080), ( 0.52, -0.60, 0.035, 0.05)]
    loft("Fig.Mouth", tube_rings([(x, face_y(x, z, -0.04), z) for (x, z, _t, _d) in MOUTH],
                                 [(m[2], m[3]) for m in MOUTH], 10),
         "Ink", parent=head, cap_start=True, cap_end=True, levels=1)
    # the upper TEETH: a narrow Paper bar along the crescent's top edge, standing just proud of the Ink
    loft("Fig.Teeth", tube_rings([(x, face_y(x, z, 0.045), z + tall - 0.058) for (x, z, tall, _d) in MOUTH],
                                 [(0.050, 0.055)] * 3 + [(0.055, 0.060)] + [(0.050, 0.055)] * 3, 8),
         "Paper", parent=head, cap_start=True, cap_end=True, levels=1)

    # ---------------------------------------------------------------- the EARS
    # Rings stacked up the ear's own height, each a LENS through the skull (thick in the middle, thin at the
    # front and back edges), so the shell stands 0.12 proud where it is read and its edges land on the cheek.
    EAR = [(-0.44, -0.08, 0.050, 0.070),   # (z, cy, through, fore-aft) the lobe, tucked forward
           (-0.30, -0.06, 0.105, 0.140),
           (-0.12, -0.02, 0.135, 0.195),   # the widest of it, level with the cheek's widest ring
           ( 0.04,  0.02, 0.125, 0.180),
           ( 0.17,  0.05, 0.055, 0.100)]   # the top, leaning back under the hair's arch
    # the HELIX: one smooth ridge rolled along the shell's own outline, front over the top and down the back,
    # open at the lobe.  It is the one line inside the ear, and it is what makes the oval read as an ear from
    # the side and the three-quarter instead of as a blank pad.
    RIM = [(-0.30, -0.172, 0.043, 0.030), (-0.12, -0.176, 0.061, 0.045), (0.04, -0.124, 0.055, 0.046),
           ( 0.17,  0.050, 0.033, 0.042),
           ( 0.04,  0.164, 0.055, 0.046), (-0.12, 0.136, 0.061, 0.045), (-0.30, 0.052, 0.043, 0.030)]
    for sx in (-1, 1):
        loft(f"Fig.Ear.{sx}", [ellipse((sx * 0.98, cy, z), th, fa, 12) for (z, cy, th, fa) in EAR],
             "Ivory", parent=head, cap_start=True, cap_end=True, levels=1)
        loft(f"Fig.Ear.Rim.{sx}", tube_rings([(sx * (0.98 + dx), y, z) for (z, y, dx, _r) in RIM],
                                             [r[3] for r in RIM], 8),
             "Ivory", parent=head, cap_start=True, cap_end=True, levels=1)

    # ---------------------------------------------------------------- the white HAIR: one shell round the back
    # An arc per height from his left temple round the nape to his right, lofted into a sheet and solidified.
    # Above the ears it reaches forward to the temples; below them it stops behind the ear, so the arcs' ends
    # draw a hairline arching OVER each ear with the temple in front of it bare.  Each arc's last two points
    # are pulled INSIDE the skull, so the sheet has no cut edge standing off the face - the hairline is the
    # curve where hair meets skin, not a slab - and the bottom edge DRAPES, lowest at the nape.
    # (z, a0, a1, out): height, the arc's ends as azimuths (0 = his left ear, 90 = the nape, 180 = his right).
    HAIR = [( 0.41, -26, 206, 0.022),   # the top edge, tucked under the brim (its underside is at z 0.44)
            ( 0.30, -22, 202, 0.045),
            ( 0.20, -12, 192, 0.065),   # the hairline crosses just above the ear's top (z 0.17)
            ( 0.11,  -2, 182, 0.074),
            ( 0.00,   4, 176, 0.078),   # behind the ear now, close in to it
            (-0.16,   6, 174, 0.080),
            (-0.34,   8, 172, 0.076),
            (-0.40,  10, 170, 0.066)]   # the free bottom edge; its z drapes with the curve below
    NH = 18
    rings = []
    for k, (z, a0, a1, out) in enumerate(HAIR):
        row = []
        for i in range(NH):
            t = math.radians(a0 + (a1 - a0) * i / (NH - 1))
            f = min(1.0, min(i, NH - 1 - i) / 1.0)          # the ends dive into the skull: no slab edge
            o = out * f - 0.030 * (1 - f)
            zz = z - (0.20 * math.sin(t) if k == len(HAIR) - 1 else 0.0)   # the drape at the nape
            rx, ry, cy = profile(zz)
            row.append(Vector(((rx + o) * math.cos(t), cy + (ry + o) * math.sin(t), zz)))
        rings.append(row)
    loft("Fig.Hair", rings, "Paper", parent=head, closed=False, levels=1, thickness=0.075)
# <<< region: head-face

# >>> region: hat-shades
def region_hat_shades():
    """The pixel shades and the top hat, built to the MODEL SHEET (web/3d/ref/mr-bands-sheet.png).

    The shades are ONE mesh (a 16x4 grid of cells swept round an ellipse in front of the face) so the engraving
    draws a single contour round the stepped icon instead of outlining all 42 pixels into a dotted grid.  The
    plate is seated ON the face: its radius falls off toward the ends (1.01 at the bridge, 0.96 at the temples)
    so the icon stays proud where it is read and grazes the temple ridge where it ends, with no gap under the
    outer steps.  A hairline bridge bar is tucked under row 0 inside the nose notch - thin enough that the notch
    still reads three rows deep.  Each temple ARM is a WIRE now: a 0.05 rod swept through six knots, with a
    discrete hinge BLOCK at the lens corner, a ball JOINT where it turns the temple and a tip that hooks down
    behind the ear, so the side and back stations read line-joint-hook instead of the dumbbell the fat rod drew.
    Nothing is carved out of the brow: the forehead is a broad shallow dome sharing the skull's own curvature.
    THE HAT is the sheet's now, not the old drawing's.  It is TALLER: 1.65 of visible crown on a 2.24 base -
    the sheet's own 0.73 - nearly straight-sided, a slight waist, a sixth of flare to the lip, then a chamfer
    to a FLAT top (the sheet's top view is a flat oval with only its edge rolled; smooth shading turns the
    chamfer into that roll).  The brim is WIDE - 1.54x the crown's base - swept from a closed profile and
    displaced into a saddle: flat where the crown seats, curling up at the SIDES, dipping at the front and less
    at the back, a rolled outer edge, plain underneath.  Its top lands at fig z ~12.98.
    THE ORANGE IS A VERTICAL STRIPE, a bit over a quarter of the crown's width: from the brim line at the front
    centre straight up the crown, across the top front to back, and down the back (hat_stripe on the crown's
    own radius).  The horizontal BAND and its bow are GONE - the sheet has neither, and the pair of them cost
    more triangles than the stripe and the new arms together.
    It is worn nearly level, tipped a touch to his right (empty at head z 0.44, pitch -2, roll -7).  A NEGATIVE
    pitch LIFTS the brim's front, so only two degrees are taken where the last round took eight: the brim's
    underside now runs 0.084 - under one pixel - above the lens tops, and the forehead is a strip in the brim's
    shadow instead of the band of bare lit skin it was.
    """
    # ---------------------------------------------------------------- the pixel shades
    SPX = 0.105                      # one pixel
    RI, RO = 0.82, 1.01              # inner radius (buried in the skull) and outer radius (the lens face)
    XS, YS = 1.05, 0.98              # the lens ellipse: wider across than the skull, so the plate is flatter
    Z0 = 0.33                        # centre of the top row: clear of the nose, under the brow
    dA = SPX / 0.98                  # angular pitch
    NC, NR = 16, 4
    lit = lambda c, r: 0 <= c < NC and 0 <= r < NR and ROWS[r][c] == "1"
    # the forehead: ONE broad shallow dome, as wide as the brow and as deep as the skull's own curve, so the strip
    # under the brim hatches as one tone (the old narrow browline stood off the skull and read as a sweatband)

    bm = bmesh.new()
    cache = {}
    def V(i, j, k):
        key = (i, j, k)
        if key not in cache:
            a = (i - NC / 2) * dA
            # the plate's radius falls off toward its ends: proud at the bridge, sunk onto the temple ridge at the ends
            R = (RI if k == 0 else RO) * (1 - 0.09 * math.sin(a) ** 2)
            cache[key] = bm.verts.new((XS * R * math.sin(a), -YS * R * math.cos(a), Z0 + SPX / 2 - j * SPX))
        return cache[key]
    for r in range(NR):
        for c in range(NC):
            if not lit(c, r):
                continue
            bm.faces.new((V(c, r, 1), V(c + 1, r, 1), V(c + 1, r + 1, 1), V(c, r + 1, 1)))
            bm.faces.new((V(c, r + 1, 0), V(c + 1, r + 1, 0), V(c + 1, r, 0), V(c, r, 0)))
            if not lit(c - 1, r): bm.faces.new((V(c, r, 0), V(c, r, 1), V(c, r + 1, 1), V(c, r + 1, 0)))
            if not lit(c + 1, r): bm.faces.new((V(c + 1, r + 1, 0), V(c + 1, r + 1, 1), V(c + 1, r, 1), V(c + 1, r, 0)))
            if not lit(c, r - 1): bm.faces.new((V(c, r, 0), V(c + 1, r, 0), V(c + 1, r, 1), V(c, r, 1)))
            if not lit(c, r + 1): bm.faces.new((V(c, r + 1, 1), V(c + 1, r + 1, 1), V(c + 1, r + 1, 0), V(c, r + 1, 0)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # a wider chamfer than the plate had: it is what lights the steps, and the stepped edge is the whole icon
    finish(mesh_obj("Fig.Shades", bm, head), "Ink", 0.022, 1)
    # the bridge: a HAIRLINE across the nose notch (cols 6-8, so its centre is half a pixel left of zero), tucked
    # right under row 0's bottom edge and sunk behind the lens face, so the notch still reads three rows deep
    bone("Fig.Shades.Bridge", (-0.205, -0.930, 0.262), (0.100, -0.930, 0.262), 0.012, "Ink", parent=head, verts=8, bevel=0, outline=False)

    # -- one temple arm per side: a single swept rod (Catmull-Rom through the lens end, the temple, the ear top and
    #    a hook behind the ear).  Thin - 0.05 across, half a pixel - so it draws as a LINE and not as a black lump
    #    where it leaves the lens; the two joints the eye wants are separate solids (a hinge block, a ball).
    def rod(name, knots, radii, mat, ring=8, seg=2, parent=head):
        K = [Vector(k) for k in knots]
        E = [K[0] + (K[0] - K[1])] + K + [K[-1] + (K[-1] - K[-2])]
        RE = [radii[0]] + list(radii) + [radii[-1]]
        P, R = [], []
        for i in range(1, len(E) - 2):
            for t in (j / seg for j in range(seg)):
                p0, p1, p2, p3 = E[i - 1], E[i], E[i + 1], E[i + 2]
                P.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
                R.append(RE[i] * (1 - t) + RE[i + 1] * t)
        P.append(E[-2]); R.append(RE[-2])
        tans = []
        for i in range(len(P)):
            t = P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]
            tans.append(t.normalized() if t.length > 1e-6 else Vector((0, 0, 1)))
        ref = Vector((0, 0, 1))
        bm = bmesh.new()
        rings, frames = [], []
        for i, p in enumerate(P):
            u = tans[i].cross(ref).normalized()
            v = tans[i].cross(u).normalized()
            frames.append((u, v))
            rings.append([bm.verts.new(p + (u * math.cos(a) + v * math.sin(a)) * R[i])
                          for a in (2 * math.pi * k / ring for k in range(ring))])
        for i in range(len(rings) - 1):
            for k in range(ring):
                bm.faces.new((rings[i][k], rings[i + 1][k], rings[i + 1][(k + 1) % ring], rings[i][(k + 1) % ring]))
        for end in (0, -1):                                    # a domed cap on each end
            p, r = P[end], R[end]
            t = -tans[0] if end == 0 else tans[-1]
            u, v = frames[end]
            apex = bm.verts.new(p + t * r * 0.8)
            for k in range(ring):
                bm.faces.new((rings[end][k], apex, rings[end][(k + 1) % ring]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        return finish(mesh_obj(name, bm, parent), mat, 0)
    for sx in (-1, 1):
        # the lens corner, the temple, over the ear, then the tip turned DOWN behind it (the sheet's side views)
        rod(f"Fig.Shades.Arm.{sx}",
            ((sx * 0.775, -0.645, 0.336), (sx * 0.945, -0.470, 0.332), (sx * 1.048, -0.250, 0.318),
             (sx * 1.085, -0.010, 0.292), (sx * 1.075, 0.180, 0.215), (sx * 1.022, 0.290, 0.085)),
            (0.026, 0.026, 0.026, 0.024, 0.022, 0.018), "Ink", ring=8)
        # the hinge: a small block at the lens corner, the one place the arm is allowed to be thicker than a line
        box(f"Fig.Shades.Hinge.{sx}", (0.070, 0.048, 0.088), (sx * 0.793, -0.636, 0.336), "Ink", 0.006,
            rot=(0, 0, RAD(sx * -32)), parent=head, segments=1)
        # the bend: a ball twice the wire's thickness, so the side and back stations see a joint, not a kink
        sphere(f"Fig.Shades.Bend.{sx}", 0.033, (sx * 1.048, -0.250, 0.318), "Ink", parent=head, seg=(10, 6), outline=False)

    # ---------------------------------------------------------------- the hat, worn nearly level
    # A NEGATIVE pitch LIFTS the brim's front (z' = y sin th + z cos th, and his face is at -y), so only two
    # degrees are taken here: at -8 the front stood a sixth of a unit above the lenses and the hat read as
    # tipped back.  The roll drops his right side, the tilt the sheet's front view has.
    fhat = empty("Fig.Hat", (0, 0.10, 0.44), head)
    fhat.rotation_euler = (RAD(-2), RAD(-7), 0)
    # the brim: a closed profile (inner wall, top, rolled outer edge, underside) swept round and displaced into a
    # saddle - flat where the crown seats, curling up at the SIDES, dipping at the front and (less) at the back.
    # The sheet's brim is WIDE: 1.54x the crown's base.  Its underside is plain - no lining, as in the sheet.
    PROF = [(1.00, 0.050), (1.58, 0.040), (1.72, 0.012), (1.72, -0.036), (1.58, -0.058), (1.00, -0.050)]
    SEG, NP = 40, 6
    bm = bmesh.new()
    rings = []
    for i in range(SEG):
        a = 2 * math.pi * i / SEG                              # a = 0 at his left, 90 at the back, -90 at the face
        row = []
        for (u, w) in PROF:
            t = max(0.0, (u - 1.05) / 0.67)                    # 0 at the crown's foot, 1 at the outer edge
            s = t * t                                          # the curl is all in the outer half of the brim
            dz = 0.28 * s * math.cos(a) ** 4 - 0.060 * s * math.sin(a) ** 2 - 0.055 * s * max(0.0, -math.sin(a))
            row.append(bm.verts.new((u * math.cos(a), u * math.sin(a) * 0.93, w + dz)))
        rings.append(row)
    for i in range(SEG):
        j = (i + 1) % SEG
        for k in range(NP):
            k2 = (k + 1) % NP
            bm.faces.new((rings[i][k], rings[j][k], rings[j][k2], rings[i][k2]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    brim = mesh_obj("Fig.Hat.Brim", bm, fhat)
    brim.location = (0, 0, 0.04)
    finish(brim, "Hat", 0.012, 1)
    # the crown: ONE lathed surface, so the engraving draws a single contour round the whole hat instead of an
    # ellipse at every joint.  TALL and nearly straight-sided, as the sheet's hat details are: 1.65 of visible
    # height on a 2.24 base (the sheet's 0.73), a slight waist and a sixth of flare to the lip, then a CHAMFER
    # to a FLAT top - the sheet's top view shows a flat oval with only its edge rolled, and smooth shading turns
    # the chamfer into that roll.  The lip sits exactly on one of the stripe's samples (ZLIP below) so the strip
    # runs down the chamfer instead of cutting the corner: a chord across a rolled lip lets the black crown
    # print through the orange, and that was the one place the stripe could go wrong.
    ZTOP, SZ0, SN = 1.740, 0.020, 24                           # the crown's top; the stripe's foot and sample count
    ZLIP = SZ0 + (ZTOP - SZ0) * (SN - 1) / SN                  # 1.668: the last stripe sample before the top
    CROWN = [(1.120, 0.045), (1.112, 0.430), (1.128, 0.800), (1.162, 1.120), (1.216, 1.390), (1.258, 1.540),
             (1.285, ZLIP), (1.180, ZTOP)]
    bm = bmesh.new()
    rings = []
    for (r, z) in CROWN:
        rings.append([bm.verts.new((r * math.cos(2 * math.pi * i / SEG), r * math.sin(2 * math.pi * i / SEG), z)) for i in range(SEG)])
    for k in range(len(rings) - 1):
        for i in range(SEG):
            j = (i + 1) % SEG
            bm.faces.new((rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]))
    apex = bm.verts.new((0, 0, ZTOP))                          # the top is FLAT: the apex is level with the last ring
    for i in range(SEG):
        bm.faces.new((rings[-1][i], rings[-1][(i + 1) % SEG], apex))
    bm.faces.new(list(reversed(rings[0])))                     # the foot, closed and buried in the brim
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    finish(mesh_obj("Fig.Hat.Crown", bm, fhat), "Hat", 0)
    # THE STRIPE (the model sheet's front, back and TOP views): orange up the front of the crown from the brim
    # line, across the top front to back, and down the back - NOT a band round the crown, and no bow.  It is
    # laid on the crown's own radius so it hugs the waist and the flare, and it starts below the brim's top
    # surface so no end shows.  0.64 wide: a bit over a quarter of the crown, as drawn.
    def crown_r(z):
        for (r0, za), (r1, zb) in zip(CROWN, CROWN[1:]):
            if z <= zb or (r1, zb) == CROWN[-1]:
                t = 0.0 if zb <= za else max(0.0, min(1.0, (z - za) / (zb - za)))
                return r0 + (r1 - r0) * t
        return CROWN[-1][0]
    hat_stripe("Fig.Hat.Stripe", crown_r, SZ0, ZTOP, 0.64, "Strap", parent=fhat, lift=0.012, samples=SN, top_r=crown_r(ZTOP))
# <<< region: hat-shades

# >>> region: hands-props
def region_hands_props():
    """Both hands are MODELLED now - one piece each, a palm block with four jointed fingers and a thumb grown out of
    it and smoothed by subdivision (hand()) - instead of the metaball lump with tubes pushed into it that the last
    round drew.  What the engraving has to carry at hero distance is the SILHOUETTE, so each hand is built round one
    idea: the right hand is a PINCH (ring and little rolled into the palm, index and middle straight and splayed
    apart with the cigar wedged between their tips), the left hand is a FIST (all four fingers curled hard over the
    cane's knob, the thumb laid down its body side).  Nothing is stuck on: the cigar is laid from the returned tip
    marks and the knob is set under the returned palm mark, so pinch and grip are true by construction.

    The right hand rises out of the coat's cuff beside his cheek, the back of the hand to the viewer and the palm to
    the face, the index uppermost.  The cigar crosses the pinch - a short butt below it, the long body rising up and
    OUTBOARD, clear of the brim - with one Strap band by the fingers, a grey Paper ash and an Ember ring sunk flush
    under both its neighbours so no second band can print.  Three flattened wisps lift from the ash and lean further
    outboard as they climb, so the smoke never crosses the hat.
    The left hand comes down out of its cuff onto the cane: the knob sits in the curl of the fingers with only a
    crescent of brass showing, the decorated ring and the collar below the grip carry the sheet's cane detail, and
    the shaft runs straight from under the collar to the ferrule, planted forward and wide of his foot.
    Both hands end AT the cuff's mouth (the coat region builds the cuffs); their wrist stumps are pushed 0.16 back
    inside the cuff so the shirt's white ring closes round the wrist by itself.
    """
    # -- one smoke wisp: a tube swept along a Catmull-Rom curve through its knots, domed at both ends, squashed in y
    #    so it hatches as a SHEET and not as a wire, and drawn with no ink contour.
    def wisp(name, knots, radii, ring=5, seg=3, flat=0.60):
        K = [Vector(k) for k in knots]
        E = [K[0] + (K[0] - K[1])] + K + [K[-1] + (K[-1] - K[-2])]
        RE = [radii[0]] + list(radii) + [radii[-1]]
        P, R = [], []
        for i in range(1, len(E) - 2):
            for t in (j / seg for j in range(seg)):
                p0, p1, p2, p3 = E[i - 1], E[i], E[i + 1], E[i + 2]
                P.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
                R.append(RE[i] * (1 - t) + RE[i + 1] * t)
        P.append(E[-2]); R.append(RE[-2])
        squash = lambda v: Vector((v.x, v.y * flat, v.z))
        tans = []
        for i in range(len(P)):
            t = P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]
            tans.append(t.normalized() if t.length > 1e-6 else Vector((0, 0, 1)))
        avg = sum(tans, Vector()) / len(tans)
        ref = Vector((0, 0, 1)) if abs(avg.normalized().z) < 0.8 else Vector((1, 0, 0))
        bm = bmesh.new()
        rings, frames = [], []
        for i, p in enumerate(P):
            u = tans[i].cross(ref).normalized()
            v = tans[i].cross(u).normalized()
            frames.append((u, v))
            rings.append([bm.verts.new(p + squash((u * math.cos(a) + v * math.sin(a)) * R[i]))
                          for a in (2 * math.pi * k / ring for k in range(ring))])
        for i in range(len(rings) - 1):
            for k in range(ring):
                bm.faces.new((rings[i][k], rings[i + 1][k], rings[i + 1][(k + 1) % ring], rings[i][(k + 1) % ring]))
        for end in (0, -1):
            p, r = P[end], R[end]
            t = -tans[0] if end == 0 else tans[-1]
            u, v = frames[end]
            mid = [bm.verts.new(p + squash(t * (0.52 * r) + (u * math.cos(a) + v * math.sin(a)) * (0.78 * r)))
                   for a in (2 * math.pi * k / ring for k in range(ring))]
            apex = bm.verts.new(p + squash(t * r))
            for k in range(ring):
                bm.faces.new((rings[end][k], mid[k], mid[(k + 1) % ring], rings[end][(k + 1) % ring]))
                bm.faces.new((mid[k], apex, mid[(k + 1) % ring]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        return finish(mesh_obj(name, bm, fig), "Paper", 0, outline=False)

    def frame(zdir, backdir):
        """the quaternion that lays the hand frame (fingers +z, back of the hand +y) along a forearm direction with
        the back of the hand turned toward `backdir`."""
        z = Vector(zdir).normalized()
        b = Vector(backdir)
        y = (b - z * b.dot(z)).normalized()
        return Matrix((y.cross(z), y, z)).transposed().to_quaternion()

    # ---------------------------------------------------------------- the right hand: the PINCH, beside the cheek
    RW = Vector((1.57, -1.41, 9.91))                     # the contract wrist: the mouth of the coat's shirt cuff
    RD = Vector((-0.20, -0.24, 0.56)).normalized()       # the forearm arrives along this; the hand continues it
    RQ = frame(RD, (0.66, -0.74, 0.10))                  # the back of the hand to the viewer, the palm to his cheek
    # index and middle nearly straight and splayed 16 degrees apart (a 0.33 gap at the tips: the cigar's width);
    # ring and little folded hard into the palm, so the fist's outline is a closed mass with two fingers off it
    _, RM = hand("Fig.Hand.R", "Ivory", fig, at=RW - RD * 0.16, rot=RQ, size=1.00,
                 curl=((26, 30, 16), (20, 26, 14), (78, 90, 62), (86, 96, 66)),
                 spread=(-15, 1, 7, 14), thumb=(44, 24), thumb_curl=(32, 44))
    RN = RQ @ Vector((0, -1, 0))                         # the palm's normal, pointing at his cheek

    # ---------------------------------------------------------------- the cigar, laid on the pinch by construction
    PIN = (RM["tip0"] + RM["tip1"]) / 2 + RN * 0.05      # just inside the two fingertips' pads
    CD = Vector((0.72, -0.26, 0.64)).normalized()        # rising up and OUTBOARD, clear of the brim
    BUTT, TIP = PIN - CD * 0.34, PIN + CD * 1.20
    bone("Fig.Cigar", BUTT, TIP, 0.155, "Wood", parent=fig, r2=0.146, verts=14, bevel=0.006)
    bone("Fig.Cigar.Band", BUTT + CD * 0.08, BUTT + CD * 0.20, 0.165, "Strap", parent=fig, verts=12, bevel=0.006)
    # the ember is a 0.02 hairline sunk UNDER both neighbours (wrapper 0.146, ember 0.142, ash 0.152 starting back
    # over it), so the engraving draws a dark seam there and cannot print a second Strap ring
    bone("Fig.Cigar.Ember", TIP - CD * 0.01, TIP + CD * 0.01, 0.142, "Ember", parent=fig, verts=14, bevel=0, outline=False)
    bone("Fig.Cigar.Ash", TIP - CD * 0.01, TIP + CD * 0.30, 0.152, "Paper", parent=fig, r2=0.108, verts=14, bevel=0.004)
    ASH = TIP + CD * 0.32
    empty("Fig.Smoke", ASH, fig)
    # three flattened ribbons, every one leaning further outboard (+x) and forward (-y) as it climbs, so the plume
    # drifts away from the crown instead of standing in it
    for tag, dx, dy, ks in (("A", 0.00, 0.00, ((0.04, 0.10, 0.30), (0.30, 0.16, 0.74), (0.20, 0.24, 1.22), (0.58, 0.32, 1.70), (0.52, 0.40, 2.16))),
                            ("B", 0.16, 0.04, ((0.10, 0.06, 0.22), (0.38, 0.14, 0.60), (0.30, 0.22, 1.06), (0.66, 0.30, 1.50))),
                            ("C", -0.12, 0.02, ((-0.02, 0.08, 0.18), (-0.18, 0.16, 0.54), (0.02, 0.24, 0.94), (-0.10, 0.32, 1.30)))):
        knots = [(ASH.x + dx + k[0], ASH.y - dy - k[1], ASH.z + k[2]) for k in ks]
        radii = (0.05, 0.09, 0.12, 0.10, 0.02)[:len(knots) - 1] + (0.02,)
        wisp(f"Fig.Smoke.{tag}", knots, radii)

    # ---------------------------------------------------------------- the left hand: the FIST, closed on the knob
    LW = Vector((-2.30, -0.85, 5.84))                    # the contract wrist at the left cuff's mouth
    LD = Vector((0.0, -0.41, -0.86)).normalized()        # down and forward, onto the knob
    LQ = frame(LD, (-0.58, -0.80, 0.0))                  # the back of the hand outboard and to the viewer
    _, LM = hand("Fig.Hand.L", "Ivory", fig, at=LW - LD * 0.16, rot=LQ, mirror=True, size=1.00,
                 curl=((66, 80, 54), (70, 84, 56), (68, 82, 54), (64, 78, 52)),
                 spread=(-6, -2, 2, 7), thumb=(70, 50), thumb_curl=(22, 26))
    LN = LQ @ Vector((0, -1, 0))                         # the palm's normal: the knob sits along it
    # the knob goes in the middle of the hole the curled fingers make - the mean of the two middle knuckles and
    # their tips - so the grip is true by construction and only a crescent of brass shows below the little finger
    KNOB = (LM["knuckle1"] + LM["knuckle2"] + LM["tip1"] + LM["tip2"]) / 4 + LN * 0.02

    # ---------------------------------------------------------------- the cane
    FERR = Vector((-2.95, -1.80, 0.02))
    SD = (FERR - KNOB).normalized()
    sphere("Fig.Cane.Knob", 0.235, tuple(KNOB), "Brass", parent=fig, scale=(1.0, 1.0, 0.90), seg=(12, 7))
    # the sheet's decorated knob: one raised ring round its waist, set square to the shaft - the one piece of
    # decoration big enough to survive the engraving
    torus("Fig.Cane.Ring", 0.205, 0.040, tuple(KNOB + SD * 0.05), "Brass", parent=fig, seg=14, ring=5,
          rot=tuple(SD.to_track_quat("Z", "Y").to_euler()))
    bone("Fig.Cane.Collar", KNOB + SD * 0.20, KNOB + SD * 0.52, 0.104, "Brass", parent=fig, r2=0.096, verts=14, bevel=0.012)
    torus("Fig.Cane.CollarRing", 0.098, 0.030, tuple(KNOB + SD * 0.50), "Brass", parent=fig, seg=12, ring=5,
          rot=tuple(SD.to_track_quat("Z", "Y").to_euler()))
    bone("Fig.Cane.Shaft", KNOB + SD * 0.46, FERR, 0.078, "Ink", parent=fig, r2=0.058, verts=14, bevel=0.01)
    bone("Fig.Cane.Ferrule", FERR - SD * 0.34, FERR, 0.072, "Brass", parent=fig, verts=8, bevel=0.012)
# <<< region: hands-props

region_legs_shoes()
region_coat_torso()
region_head_face()
region_hat_shades()
region_hands_props()
# the families become meshes: (name, material, decimate ratio) - smooth surfaces take decimation well
F.legs.mesh("Fig.Trousers", "Stripe", 0.45)
F.coat.mesh("Fig.Coat", "Ink", 0.3)
F.vest.mesh("Fig.Waistcoat", "Cloth", 0.35)
F.skin.mesh("Fig.Skin", "Ivory", 0.5, smooth=1)
F.paper.mesh("Fig.Paper", "Paper", 0.55, smooth=1)
F.shoe.mesh("Fig.Shoes", "Shoe", 0.45, smooth=1)   # finer, so the polish highlight does not facet

# ---------------------------------------------------------------- the trousers' stripe coordinates
# The pinstripes are drawn by the web shader from a CYLINDRICAL UV laid round each leg's own axis (u round the leg, v the
# height), so they hang straight down a leg however it tilts or curves: world-space stripe planes wandered into loops.
def stripe_uvs():
    finv = fig.matrix_world.inverted()
    tr = bpy.data.objects.get("Fig.Trousers")
    if tr is None:
        return
    objs = [o for o in bpy.data.objects if o.type == "MESH" and o.data.materials and o.data.materials[0].name == "Stripe"]
    # each leg's axis by height, from the trousers' own vertices (his left leg is +x in his frame)
    bins = {}
    for v in tr.data.vertices:
        q = finv @ (tr.matrix_world @ v.co)
        b = bins.setdefault(("L" if q.x > 0 else "R", int(q.z / 0.25)), [0.0, 0.0, 0])
        b[0] += q.x; b[1] += q.y; b[2] += 1
    axis = {}
    for (tag, i), (sx, sy, n) in bins.items():
        axis.setdefault(tag, []).append(((i + 0.5) * 0.25, sx / n, sy / n))
    for rows in axis.values():
        rows.sort()
    def at(tag, z):
        rows = axis[tag]
        if z <= rows[0][0]:
            return rows[0][1], rows[0][2]
        for (z0, x0, y0), (z1, x1, y1) in zip(rows, rows[1:]):
            if z <= z1:
                t = (z - z0) / max(1e-6, z1 - z0)
                return x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
        return rows[-1][1], rows[-1][2]
    for o in objs:
        me = o.data
        uv = me.uv_layers.get("Leg") or me.uv_layers.new(name="Leg")
        M = finv @ o.matrix_world
        for poly in me.polygons:
            for li in poly.loop_indices:
                q = M @ me.vertices[me.loops[li].vertex_index].co
                tag = "L" if q.x > 0 else "R"
                ax, ay = at(tag, q.z)
                dx, dy = q.x - ax, q.y - ay
                th = math.atan2(dy, dx if tag == "L" else -dx)   # the seam falls on the inside of each leg
                uv.data[li].uv = (th / (2 * math.pi) + 0.5, q.z)
stripe_uvs()

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
stack = box("Proto.Stack", (1.0, 1.72, 0.56), (0, 0.18, 0.28), "Bill", 0.03, parent=protos, segments=1)
strap = box("Proto.Strap", (1.012, 0.4, 0.572), (0, 0.18, 0.28), "Strap", 0.012, parent=protos, segments=1)
# Chip: what a bin holds once the price has crossed it, the token he bought. A dark slab, no strap.
chip = box("Proto.Chip", (1.0, 1.72, 0.3), (0, 0.18, 0.15), "Ink", 0.03, parent=protos, segments=1)
# the coin is drawn hundreds of times (the dish, the abacus): sixteen sides and one bevel step are plenty at any distance it is seen from
coin = cyl("Proto.Coin", 0.3, 0.06, (0, 0, 0.03), "Brass", 0.014, parent=protos, verts=16, segments=1)
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
    ("rows",     (-10.0, -11.0, 9.6),      (1.0, -0.5, -2.6),      32,  "",        (0, 0, 0),          "he lays SOL under the price: down the rows"),
    ("cursor",   (2.5, -9.5, 6.2),         (0.6, -1.2, -0.2),      30,  "cursor",  (0, 0, 0),          "traders cross his band: on the cursor"),
    # The row stations stand high and close (about 50 degrees down) so the frame's top edge falls on the blotter just short
    # of Mr Bands, who stands at FIG_AT right behind the trays: from the old low three-quarter his shins hung from the top
    # of the "what he holds" chapter. A tilt below the tray (look z under the desk) keeps his shoes off the picture even when
    # the web stage slides the station along the tray to the price. The second tray sits closer to him, so its look drops
    # further (the tray sits in the upper part of the frame), which is as much as the geometry allows: with the price at the
    # very top of the band the station slides right, he stands straight behind the look point, and his shoes reach the nav.
    ("row0",     (-6.5, -8.7, 11.0),       (0.5, -1.9, -1.6),      30,  "row0",    (1.5, 0, 0),        "what he holds: the first tray, from high on its left, the bundles the subject"),
    ("row1",     (-6.5, -4.5, 11.0),       (0.5, 2.3, -3.2),       30,  "row1",    (1.5, 0, 0),        "what he holds: the second tray, the same high view slid back one row, tilted so the tray sits high in the frame"),
    ("vault",    (-19.0, -9.0, 5.0),       (-11.6, -0.4, 1.0),     30,  "",        (0, 0, 0),          "he holds nothing: his SOL stacked by the hat"),
    ("dish",     (5.2, -8.4, 7.2),         (9.5, -0.9, 0.2),       28,  "",        (0, 0, 0),          "fees fall: the dish"),
    ("chart",    (9.0, -12.0, 4.2),        (1.5, -5.3, 0.7),            30,  "",        (-2.0, 0, 0),       "what he made: the abacus of fees"),
    ("plan",     (-1.4, -7.5, 29.0),       (-1.4, -0.4, 0.0),      30,  "",        (0, 0, 0),          "price walks away, he lays the band again: the plan view"),
    ("ledger",   (17.5, -12.5, 7.0),       (11.3, -3.4, 0.5),      30,  "",        (0, 0, 0),          "every move on the record: tape and ledger"),
    # Thirteen units off, with the look point at the dome's middle and a touch wider, so the dome stands whole with air above the
    # finial and the tape's first bends run out past the dish toward the ledger in the lower left; the old station was so close
    # the ticker read as a wall of hatching with no edge. Seen from the front-right rather than the right, so Mr Bands' legs
    # (he stands behind the trays, level with the dome's middle in this view) fall on the left under the chapter's words instead
    # of between the words and the dome. The drift is shorter than it was, so the start of the chapter (the camera half a drift
    # forward) keeps the finial under the top edge.
    ("tape",     (17.5, -10.0, 7.5),       (12.0, 1.0, 2.6),       32,  "",        (0, -2.0, -0.3),    "what he did: the ticker and its tape, the camera following the tape out as the list scrolls"),
    ("hat",      (-17.5, -7.5, 4.4),       (-10.6, 3.0, 1.7),      30,  "",        (0, 0, 0),          "his hat, his shades, his cigar, laid on the desk"),
    ("hands",    (8.65, 0.42, 10.92),       (5.50, 4.20, 10.55),    24,  "",        (0, 0, 0),          "the cigar hand: cuff, fist, band, ember and ash"),
    ("shoes",    (7.4, 1.3, 3.6),            (3.8, 5.1, 0.35),       22,  "",        (0, 0, 0),          "his oxfords from a low three-quarter on his left: welt, heel and laces"),
    # Field of view 44 (not 40) so the full length, shoes and the cane's ferrule included, fits a 1440x900 window at the start
    # of the turn, with the same look point; the end portrait inherits the width through zoom_to and gains a little headroom.
    ("him",      (-0.6, -15.6, 8.3),       (3.6, 5.3, 7.4),        44,  "",        (0, 0, 0),          "the close: the man himself, full length; as the chapter scrolls the camera walks once round him and closes on his face"),
]
# what a station does while its chapter scrolls (web/src/stage/DeskStage.ts place()): a turn round the look point, in degrees;
# the distance it closes to, as a factor; how far the look point lifts (the eyes rising from the chest to the face)
TURNS = {"him": {"orbit_deg": 360, "zoom_to": 0.5, "rise": 3.0}}
for (name, c, l, fov, follow, drift, note) in STATIONS:
    e = empty(f"Cam.{name}", c); e["fov"] = fov; e["note"] = note; e["follow"] = follow; e["station"] = name
    e["drift_x"] = drift[0]; e["drift_y"] = drift[1]; e["drift_z"] = drift[2]
    for k, v in TURNS.get(name, {}).items():
        e[k] = v
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
    st = next((st for st in STATIONS if st[0] == os.environ.get("PREVIEW_STATION", "hero")), STATIONS[0])
    # PREVIEW_CAM="x,y,z" PREVIEW_LOOK="x,y,z" PREVIEW_FOV=30 (desk coordinates) frame the preview anywhere
    vec = lambda k, d: tuple(float(v) for v in os.environ[k].split(",")) if os.environ.get(k) else d
    cam = link(bpy.data.objects.new("Preview.Camera", cam_d)); cam.location = vec("PREVIEW_CAM", st[1])
    cam_d.angle = math.radians(float(os.environ.get("PREVIEW_FOV", st[3])) * 1.6)
    look = Vector(vec("PREVIEW_LOOK", st[2])); d = look - Vector(cam.location)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    sun_d = bpy.data.lights.new("Key", "SUN"); sun_d.energy = 3.0
    sun = link(bpy.data.objects.new("Preview.Key", sun_d)); sun.rotation_euler = (math.radians(48), 0, math.radians(-32))
    # saved BEFORE the merge below, so every prop is still its own object for editing by hand
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(OUT_BLEND))
    print("saved", OUT_BLEND)

# ---------------------------------------------------------------- one mesh per material for the web
# The .blend above keeps every prop as its own object, for editing. The site draws each mesh twice (the plate and its ink
# contour), so for the export the static desk is joined into one object per material (contoured and uncontoured apart), and
# each prototype's parts likewise. Modifiers are applied first so the bevels and their hardened normals survive the join.
def apply_and_join(objs, name, parent=None, outline=True):
    objs = [o for o in objs if o.type == "MESH"]
    if not objs:
        return None
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.convert(target="MESH")   # applies the bevel and weighted-normal modifiers, keeps the normals
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = name
    if parent is not None:
        mw = joined.matrix_world.copy()
        joined.parent = parent
        joined.matrix_world = mw
    if not outline:
        joined["outline"] = 0
    elif "outline" in joined:
        del joined["outline"]
    return joined

def merge_by_material(objs, prefix, parent=None):
    groups = {}
    for o in objs:
        if o.type != "MESH" or not o.data.materials:
            continue
        # a note and a page are drawn in their own space (the border, the rules): they stay their own objects
        if o.data.materials[0].name in ("Bill", "Page"):
            continue
        key = (o.data.materials[0].name, o.get("outline", 1) != 0)
        groups.setdefault(key, []).append(o)
    out = []
    for (mat, outlined), members in groups.items():
        out.append(apply_and_join(members, f"{prefix}.{mat}{'' if outlined else '.Plain'}", parent, outlined))
    return out

def descendants(root):
    out = []
    for c in root.children:
        out.append(c)
        out.extend(descendants(c))
    return out

static = [o for o in descendants(desk) if o.type == "MESH"]
merge_by_material(static, "Desk", parent=desk)
for proto_name in ("Proto.Tray", "Proto.Cursor"):
    pe = bpy.data.objects[proto_name]
    merge_by_material([o for o in descendants(pe) if o.type == "MESH"], proto_name, parent=pe)
# empties that lost their children are still needed (Dish.Coins, Chart.Seats, Smoke.Origin, the props' groups): they stay

os.makedirs(os.path.dirname(os.path.abspath(OUT_GLB)), exist_ok=True)
bpy.ops.object.select_all(action="DESELECT")
for o in scene.objects:
    if not o.name.startswith("Preview."):
        o.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format="GLB", use_selection=True, export_apply=True, export_yup=True,
                          export_extras=True, export_cameras=False, export_lights=False, export_materials="EXPORT",
                          export_texcoords=True, export_normals=True, export_animations=False)
print("exported", OUT_GLB, os.path.getsize(OUT_GLB), "bytes")

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
