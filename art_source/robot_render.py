"""Render the Ultron robot bust with Blender (Cycles). Re-render static/art/robot.jpg with Blender (pip install bpy).

Usage: python3 art_source/robot_render.py /absolute/path/out.png 1024 1280 128
Then convert the PNG to JPG (Blender's own JPEG export applies the color transform twice)."""
import math
import sys

import bpy  # must come first: it makes bmesh importable
import bmesh
import numpy as np
from mathutils import Vector

OUT, W, H, SAMPLES = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


# ---------- materials ----------
def principled(name, base, metallic=1.0, rough=0.35, emit=None, strength=0.0, scratches=True):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*base, 1)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = rough
    if emit:
        bsdf.inputs["Emission Color"].default_value = (*emit, 1)
        bsdf.inputs["Emission Strength"].default_value = strength
    if scratches:
        # uneven wear: noise drives roughness, fine noise adds a subtle bump
        tex = nt.nodes.new("ShaderNodeTexNoise"); tex.inputs["Scale"].default_value = 22; tex.inputs["Detail"].default_value = 12
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        ramp.color_ramp.elements[0].position = 0.35; ramp.color_ramp.elements[0].color = (rough * 0.92,) * 3 + (1,)
        ramp.color_ramp.elements[1].position = 0.75; ramp.color_ramp.elements[1].color = (min(1, rough * 1.12),) * 3 + (1,)
        nt.links.new(tex.outputs["Fac"], ramp.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], bsdf.inputs["Roughness"])
        fine = nt.nodes.new("ShaderNodeTexNoise"); fine.inputs["Scale"].default_value = 700; fine.inputs["Detail"].default_value = 8
        bump = nt.nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.015
        nt.links.new(fine.outputs["Fac"], bump.inputs["Height"])
        nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return m


GUNMETAL = principled("gunmetal", (0.16, 0.155, 0.17), rough=0.3)
DARK = principled("dark_armor", (0.06, 0.055, 0.065), rough=0.38)
REDMETAL = principled("red_metal", (0.32, 0.015, 0.02), rough=0.3)
BLACK = principled("rubber", (0.01, 0.01, 0.012), metallic=0.0, rough=0.6, scratches=False)
GLOW = principled("glow", (1, 0.05, 0.05), metallic=0, rough=0.4, emit=(1.0, 0.03, 0.04), strength=45, scratches=False)
GLOW_DIM = principled("glow_dim", (1, 0.05, 0.05), metallic=0, rough=0.4, emit=(1.0, 0.05, 0.05), strength=9, scratches=False)
HOT = principled("hot", (1, 0.8, 0.8), metallic=0, rough=0.4, emit=(1.0, 0.55, 0.5), strength=80, scratches=False)


# ---------- geometry helpers ----------
def mirror(points):
    """Points given for the right side (x >= 0); returns both sides."""
    out = []
    for p in points:
        out.append(p)
        if abs(p[0]) > 1e-6:
            out.append((-p[0], p[1], p[2]))
    return out


def hull(name, points, mat, bevel=0.012, sym=True, smooth=False):
    pts = mirror(points) if sym else points
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    verts = [bm.verts.new(Vector(p)) for p in pts]
    bmesh.ops.convex_hull(bm, input=verts)
    for v in [v for v in bm.verts if not v.link_faces]:
        bm.verts.remove(v)
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    ob.data.materials.append(mat)
    if bevel:
        mod = ob.modifiers.new("bevel", "BEVEL"); mod.width = bevel; mod.segments = 3; mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(25)
    wn = ob.modifiers.new("wn", "WEIGHTED_NORMAL"); wn.keep_sharp = True
    for poly in me.polygons:
        poly.use_smooth = True
    return ob


def box(name, center, size, mat, rot=(0, 0, 0), bevel=0.006):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center, rotation=rot)
    ob = bpy.context.active_object; ob.name = name
    ob.scale = size
    ob.data.materials.append(mat)
    if bevel:
        m = ob.modifiers.new("bevel", "BEVEL"); m.width = bevel; m.segments = 2
    return ob


def tube(name, a, b, r, mat):
    a, b = Vector(a), Vector(b)
    d = b - a
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=d.length, location=(a + b) / 2, vertices=24)
    ob = bpy.context.active_object; ob.name = name
    ob.rotation_mode = "QUATERNION"; ob.rotation_quaternion = d.to_track_quat("Z", "Y")
    ob.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    return ob


# ---------- the head (face looks toward -Y) ----------
def ellipsoid(rx, ry, rz, cz, rings=7, seg=14, zmin=-0.6, front=0.8):
    pts = []
    for i in range(rings + 1):
        el = math.pi / 2 * (zmin + (1 - zmin) * i / rings)
        for j in range(seg + 1):
            az = math.pi * j / seg - math.pi / 2          # right half only; mirror() adds the left
            x, y, z = rx * math.cos(el) * math.cos(az), ry * math.cos(el) * math.sin(az), cz + rz * math.sin(el)
            if y < 0:
                y *= front                                 # flatter face side
            if x >= 0:
                pts.append((x, y, z))
    return pts


hull("skull", ellipsoid(0.8, 1.0, 1.05, 0.35) + [(0.0, 0.1, 1.5), (0.5, 0.4, -0.7), (0.0, 0.5, -0.95)], GUNMETAL, bevel=0.015)

# face plate, slightly proud of the skull
hull("face", [
    (0.0, -1.0, 0.55), (0.34, -0.9, 0.5), (0.6, -0.72, 0.28), (0.62, -0.62, -0.1), (0.46, -0.72, -0.55),
    (0.2, -0.86, -0.92), (0.0, -0.92, -1.02), (0.0, -0.55, -0.9), (0.45, -0.4, -0.45), (0.55, -0.35, 0.3),
], DARK, bevel=0.015)

# crest ridge down the middle
hull("crest", [(0.0, -0.98, 0.75), (0.07, -0.9, 0.8), (0.1, -0.35, 1.3), (0.0, 0.05, 1.5), (0.09, 0.6, 1.25), (0.0, 1.05, 0.9), (0.0, -0.4, 1.32)], REDMETAL, bevel=0.01)

# brow plates (angled, give the eyes a scowl)
for s in (1, -1):
    hull(f"brow{s}", [(s * 0.1, -1.04, 0.48), (s * 0.62, -0.84, 0.66), (s * 0.66, -0.78, 0.56), (s * 0.12, -0.98, 0.36),
                      (s * 0.1, -0.9, 0.42), (s * 0.6, -0.72, 0.58)], GUNMETAL, bevel=0.01, sym=False)
    # dark eye socket and the glowing slit inside it
    hull(f"socket{s}", [(s * 0.12, -0.99, 0.33), (s * 0.58, -0.8, 0.52), (s * 0.6, -0.78, 0.42), (s * 0.15, -0.96, 0.22),
                        (s * 0.15, -0.88, 0.28), (s * 0.55, -0.7, 0.45)], BLACK, bevel=0.004, sym=False)
    hull(f"eye{s}", [(s * 0.17, -1.0, 0.31), (s * 0.54, -0.83, 0.48), (s * 0.55, -0.82, 0.44), (s * 0.19, -0.99, 0.26),
                     (s * 0.19, -0.96, 0.29), (s * 0.52, -0.8, 0.46)], GLOW, bevel=0, sym=False)
    hull(f"pupil{s}", [(s * 0.28, -0.985, 0.33), (s * 0.44, -0.92, 0.42), (s * 0.45, -0.915, 0.405), (s * 0.29, -0.98, 0.31),
                       (s * 0.3, -0.96, 0.33)], HOT, bevel=0, sym=False)
    # cheek armour
    hull(f"cheek{s}", [(s * 0.2, -1.0, 0.08), (s * 0.66, -0.74, 0.18), (s * 0.7, -0.62, -0.25), (s * 0.4, -0.78, -0.62),
                       (s * 0.22, -0.92, -0.38), (s * 0.3, -0.7, 0.0), (s * 0.55, -0.55, -0.2)], GUNMETAL, bevel=0.012, sym=False)
    # swept-back fins
    hull(f"fin{s}", [(s * 0.72, -0.3, 0.9), (s * 0.95, 0.9, 1.45), (s * 1.0, 0.95, 1.3), (s * 0.84, 0.3, 0.3),
                     (s * 0.74, -0.2, 0.55), (s * 0.9, 0.7, 1.0)], REDMETAL if s > 0 else GUNMETAL, bevel=0.012, sym=False)
    # jaw hinge
    tube(f"hinge{s}", (s * 0.66, -0.2, -0.3), (s * 0.84, -0.2, -0.3), 0.12, GUNMETAL)

# nose ridge, mouth grille, chin
hull("nose", [(0.0, -1.06, 0.3), (0.07, -1.0, 0.28), (0.09, -0.98, -0.2), (0.0, -1.04, -0.28), (0.05, -0.9, 0.0)], GUNMETAL, bevel=0.008)
hull("mouth", [(0.0, -0.99, -0.4), (0.22, -0.9, -0.42), (0.18, -0.86, -0.85), (0.0, -0.9, -0.92), (0.15, -0.75, -0.6)], BLACK, bevel=0.006)
for i, z in enumerate(np.linspace(-0.5, -0.8, 5)):
    w = 0.17 - i * 0.02
    box(f"grille{i}", (0, -0.965 + i * 0.012, z), (w * 2, 0.02, 0.018), GLOW_DIM, bevel=0.003)
hull("chin", [(0.0, -0.95, -0.95), (0.16, -0.85, -0.97), (0.0, -0.8, -1.12), (0.1, -0.6, -1.0)], REDMETAL, bevel=0.008)

# forehead core
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.055, location=(0, -1.0, 0.66), segments=32, ring_count=16)
bpy.context.active_object.data.materials.append(HOT); bpy.ops.object.shade_smooth()
bpy.ops.mesh.primitive_torus_add(major_radius=0.085, minor_radius=0.022, location=(0, -0.985, 0.66), rotation=(math.pi / 2, 0, 0))
bpy.context.active_object.data.materials.append(GUNMETAL); bpy.ops.object.shade_smooth()

# neck: cables and pistons
for x, r, mat in [(-0.3, 0.07, BLACK), (-0.14, 0.06, GUNMETAL), (0.0, 0.08, BLACK), (0.14, 0.06, GUNMETAL), (0.3, 0.07, BLACK)]:
    tube(f"cable{x}", (x, 0.1, -0.8), (x * 1.5, 0.15, -1.7), r, mat)
tube("glowline", (0.07, -0.02, -0.9), (0.1, 0.0, -1.7), 0.012, GLOW_DIM)
tube("glowline2", (-0.07, -0.02, -0.9), (-0.1, 0.0, -1.7), 0.012, GLOW_DIM)

# shoulders and chest
for s in (1, -1):
    # trapezius rising toward the neck, then the shoulder
    hull(f"trap{s}", [(s * 0.35, -0.3, -1.05), (s * 0.4, 0.45, -1.0), (s * 1.3, -0.4, -1.45), (s * 1.3, 0.55, -1.4),
                      (s * 1.2, -0.7, -2.4), (s * 0.4, -0.8, -2.4), (s * 1.2, 0.6, -2.3)], DARK, bevel=0.02, sym=False)
    hull(f"shoulder{s}", [(s * 1.15, -0.65, -1.35), (s * 2.0, -0.45, -1.4), (s * 2.35, 0.2, -1.9), (s * 2.25, -0.55, -2.8),
                          (s * 1.2, -0.85, -2.8), (s * 1.3, 0.55, -1.35), (s * 2.0, 0.6, -1.9)], GUNMETAL, bevel=0.025, sym=False)
    hull(f"pauldron{s}", [(s * 1.35, -0.8, -1.3), (s * 2.05, -0.62, -1.3), (s * 2.4, -0.2, -1.8), (s * 1.4, -0.95, -1.8),
                          (s * 1.7, 0.2, -1.25)], REDMETAL, bevel=0.018, sym=False)
hull("chest", [(0.0, -0.98, -1.55), (0.55, -0.9, -1.5), (0.8, -0.95, -2.8), (0.0, -1.05, -2.9), (0.35, -0.4, -1.4)], GUNMETAL, bevel=0.02)
hull("sternum", [(0.0, -1.1, -1.75), (0.18, -1.02, -1.8), (0.12, -1.02, -2.6), (0.0, -1.08, -2.7), (0.08, -0.9, -2.2)], REDMETAL, bevel=0.01)
bpy.ops.mesh.primitive_cylinder_add(radius=0.07, depth=0.04, location=(0, -1.1, -2.05), rotation=(math.pi / 2, 0, 0), vertices=48)
bpy.context.active_object.data.materials.append(GLOW)

# ---------- lighting ----------
world = bpy.data.worlds.new("world"); scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.004, 0.001, 0.0015, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0


def area(name, loc, target, energy, color, size):
    bpy.ops.object.light_add(type="AREA", location=loc)
    lt = bpy.context.active_object; lt.name = name
    lt.data.energy = energy; lt.data.color = color; lt.data.size = size
    d = Vector(target) - Vector(loc)
    lt.rotation_mode = "QUATERNION"; lt.rotation_quaternion = d.to_track_quat("-Z", "Y")
    return lt


area("key", (-3.6, -4.4, 3.2), (0, 0, 0.2), 1100, (0.85, 0.9, 1.0), 4.0)      # cool key, upper left
area("rimR", (3.2, 2.6, 1.6), (0, 0, 0.3), 1300, (1.0, 0.06, 0.05), 1.2)     # hard red rim, behind right
area("rimL", (-3.0, 2.8, 0.6), (0, 0, 0.0), 700, (1.0, 0.05, 0.05), 1.5)     # red rim, behind left
area("top", (-0.6, 0.4, 4.4), (0, 0, 0.6), 140, (0.9, 0.9, 1.0), 1.2)        # top edge highlights
area("fill", (1.8, -4.2, -1.2), (0, 0, -0.2), 35, (1.0, 0.2, 0.2), 3.0)      # faint red bounce from below right
area("softbox", (-2.5, -3.5, 4.5), (0, 0, 0.5), 110, (0.8, 0.85, 1.0), 5.0)  # broad overhead reflection
area("strip", (4.5, -1.5, 0.5), (0, 0, 0.0), 220, (1.0, 0.12, 0.1), 0.6)    # thin red strip for side reflections

# ---------- camera ----------
bpy.ops.object.camera_add(location=(-2.0, -8.2, 0.7))
cam = bpy.context.active_object; scene.camera = cam
target = Vector((0.05, 0, -0.35))
cam.rotation_mode = "QUATERNION"; cam.rotation_quaternion = (target - cam.location).to_track_quat("-Z", "Y")
cam.data.lens = 60
cam.data.dof.use_dof = True; cam.data.dof.focus_distance = (target - cam.location).length - 0.9; cam.data.dof.aperture_fstop = 5.6

# ---------- render ----------
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 6
scene.render.resolution_x, scene.render.resolution_y = W, H
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
scene.view_settings.view_transform = "AgX"
try:
    scene.view_settings.look = "AgX - Punchy"
except TypeError:
    pass
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = OUT + ".raw.png"
bpy.ops.render.render(write_still=True)

# ---------- bloom (done here with numpy, so it doesn't depend on compositor APIs) ----------
img = bpy.data.images.load(OUT + ".raw.png")
px = np.array(img.pixels[:], dtype=np.float32).reshape(H, W, 4)[..., :3]


def blur(a, r):
    k = np.exp(-0.5 * (np.arange(-3 * r, 3 * r + 1) / r) ** 2); k /= k.sum()
    pad = len(k) // 2
    a = np.pad(a, ((pad, pad), (0, 0), (0, 0)), mode="edge")
    a = np.stack([np.apply_along_axis(lambda c: np.convolve(c, k, mode="valid"), 0, a[..., i]) for i in range(3)], -1)
    a = np.pad(a, ((0, 0), (pad, pad), (0, 0)), mode="edge")
    return np.stack([np.apply_along_axis(lambda c: np.convolve(c, k, mode="valid"), 1, a[..., i]) for i in range(3)], -1)


bright = np.clip(px - 0.55, 0, None)
glow = sum(blur(bright, r) * w for r, w in ((max(2, W // 300), 0.9), (max(4, W // 90), 0.8), (max(8, W // 30), 0.6)))
out = np.clip(px + glow, 0, 1)
# vignette so the edges fade into the page
yy, xx = np.mgrid[0:H, 0:W]
v = np.clip(1.25 - (((xx - W * 0.5) / (W * 0.62)) ** 2 + ((yy - H * 0.42) / (H * 0.7)) ** 2), 0, 1) ** 1.2
out *= v[..., None]
rgba = np.concatenate([out, np.ones((H, W, 1), np.float32)], -1)
res = bpy.data.images.new("final", W, H)
res.pixels[:] = rgba.ravel()
res.filepath_raw = OUT
res.file_format = "PNG"
res.save()
print("saved", OUT)
