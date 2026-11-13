"""Sphere collision models for the FRAX floor and self-collision constraints.

frax's ``FloorConstraint`` / ``SelfCollisionConstraint`` work on spheres
attached to links.  The model for a robot comes from, in priority order:

1. ``frax_collision.yaml`` in the robot folder (bubblify format, hand-edited):

   .. code-block:: yaml

       collision_spheres:
         left_ankle_roll_link:
           - {center: [0.05, 0.0, -0.03], radius: 0.01}
       self_collision_pairs:
         - [left_elbow_link, torso_link]
       sole_links: [left_ankle_roll_link, right_ankle_roll_link]

2. frax's hand-tuned Unitree G1 model, when the robot has G1's joints and links.
3. An automatic model: sphere chains fitted to each link's MuJoCo collision
   geometry, plus small spheres at the toe, heel and side extremes of each
   foot sole.  Links of each ``ik_map`` slot are checked against the slots
   listed in ``_SELF_COLLISION_SLOT_PAIRS``.  Robots without collision
   geometry fall back to the Newton backend's ground-collision capsules.

Two filters run on every model, evaluated at the URDF zero pose (all joints
at 0, which is a standing pose for the supported humanoids):

* the floor constraint skips spheres whose bottom is less than
  ``_FLOOR_CLEARANCE`` above the soles (e.g. the end of a shin near a low
  ankle), which would otherwise hold the foot off the floor;
* self-collision skips sphere pairs that already touch (neighbouring links).

``hhtools robot frax-collision <name>`` writes the model in use as a
``frax_collision.yaml`` starting point.
"""

from __future__ import annotations

import logging
import math
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import yaml
from numpy.typing import NDArray

from hhtools.retarget.frax_backend._urdf import zero_pose_link_transforms

if TYPE_CHECKING:
    from hhtools.robot.loader import URDFRobotModel

_log = logging.getLogger(__name__)

__all__ = [
    "COLLISION_FILENAME",
    "CollisionLayout",
    "CollisionSpec",
    "auto_collision_spec",
    "collision_spec_for_robot",
    "dump_collision_spec",
    "frax_g1_collision_spec",
    "load_collision_spec",
    "to_frax_collision_data",
]

COLLISION_FILENAME = "frax_collision.yaml"

Sphere = tuple[tuple[float, float, float], float]

_SOLE_SPHERE_RADIUS = 0.01
#: Points within this height of a foot's lowest point count as its sole.
_SOLE_BAND = 0.01
#: Floor spheres must clear the sole by this much at the zero pose ...
_FLOOR_CLEARANCE = 0.025
#: ... unless they are part of the sole themselves (bottom within this band).
_FLOOR_SOLE_BAND = 0.005
#: Self-collision sphere pairs closer than this at the zero pose are skipped.
_SC_REST_CLEARANCE = 0.01
_MAX_SPHERES_PER_LINK = 5
_MIN_LINK_EXTENT = 0.01
_MIN_SPHERE_RADIUS = 0.01
_MAX_SPHERE_RADIUS = 0.15
_RADIUS_PERCENTILE = 80.0

#: Limb pairs checked for self-collision, by ik_map slot (mirrored automatically).
_SELF_COLLISION_SLOT_PAIRS: tuple[tuple[str, str], ...] = (
    ("left_elbow", "hips"),
    ("left_elbow", "chest"),
    ("left_wrist", "hips"),
    ("left_wrist", "chest"),
    ("left_elbow", "right_elbow"),
    ("left_elbow", "right_wrist"),
    ("left_wrist", "right_wrist"),
    ("left_elbow", "left_hip"),
    ("left_elbow", "left_knee"),
    ("left_wrist", "left_hip"),
    ("left_wrist", "left_knee"),
    ("left_wrist", "right_hip"),
    ("left_wrist", "right_knee"),
    ("left_hip", "right_hip"),
    ("left_hip", "right_knee"),
    ("left_knee", "right_knee"),
    ("left_ankle", "right_ankle"),
    ("left_ankle", "right_knee"),
)


@dataclass
class CollisionSpec:
    """Spheres per URDF link (link frame) and link pairs checked for self-collision."""

    spheres: dict[str, list[Sphere]] = field(default_factory=dict)
    self_collision_pairs: list[tuple[str, str]] = field(default_factory=list)
    source: str = "auto"
    #: Foot links; their lowest sphere defines the floor height at the zero pose.
    sole_links: tuple[str, ...] = ()

    @property
    def sphere_count(self) -> int:
        return sum(len(v) for v in self.spheres.values())

    def signature(self) -> tuple:
        """Hashable content key, for solver caches."""
        return (
            tuple(
                (
                    link,
                    tuple(
                        (tuple(round(c, 6) for c in center), round(r, 6)) for center, r in spheres
                    ),
                )
                for link, spheres in sorted(self.spheres.items())
            ),
            tuple(sorted(tuple(sorted(p)) for p in self.self_collision_pairs)),
            # Sole links set the floor height and which spheres keep off the floor.
            tuple(sorted(self.sole_links)),
        )


@dataclass
class CollisionLayout:
    """A :class:`CollisionSpec` laid out for one ``frax.Robot``."""

    collision_data: dict[str, tuple]
    #: Flat sphere indices the floor constraint applies to.
    floor_sphere_idxs: tuple[int, ...]
    num_spheres: int
    num_self_collision_pairs: int
    skipped_links: tuple[str, ...] = ()
    skipped_rest_pairs: int = 0


# ---------------------------------------------------------------------------
# File format
# ---------------------------------------------------------------------------


def _parse_spheres(raw: Any, where: str) -> dict[str, list[Sphere]]:
    if not isinstance(raw, dict):
        raise ValueError(f"{where}: collision_spheres must map link names to sphere lists")
    out: dict[str, list[Sphere]] = {}
    for link, items in raw.items():
        spheres: list[Sphere] = []
        for item in items or []:
            if not isinstance(item, dict) or "center" not in item or "radius" not in item:
                raise ValueError(f"{where}: {link}: each sphere needs 'center' and 'radius'")
            center = [float(x) for x in item["center"]]
            radius = float(item["radius"])
            if len(center) != 3 or not all(math.isfinite(c) for c in center):
                raise ValueError(f"{where}: {link}: invalid sphere center {item['center']!r}")
            if not (math.isfinite(radius) and radius > 0.0):
                raise ValueError(f"{where}: {link}: invalid sphere radius {item['radius']!r}")
            spheres.append(((center[0], center[1], center[2]), radius))
        if spheres:
            out[str(link)] = spheres
    return out


def load_collision_spec(path: Path, *, source: str | None = None) -> CollisionSpec:
    """Read a bubblify-style collision YAML."""
    path = Path(path)
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected a mapping with 'collision_spheres'")
    spheres = _parse_spheres(data.get("collision_spheres", {}), str(path))
    pairs: list[tuple[str, str]] = []
    for pair in data.get("self_collision_pairs", []) or []:
        if not isinstance(pair, list | tuple) or len(pair) != 2:
            raise ValueError(f"{path}: self_collision_pairs entries must be [link_a, link_b]")
        pairs.append((str(pair[0]), str(pair[1])))
    sole_links = data.get("sole_links", []) or []
    if not isinstance(sole_links, list | tuple):
        raise ValueError(f"{path}: sole_links must be a list of link names")
    return CollisionSpec(
        spheres=spheres,
        self_collision_pairs=pairs,
        source=source or f"file:{path.name}",
        sole_links=tuple(str(x) for x in sole_links),
    )


def dump_collision_spec(spec: CollisionSpec) -> str:
    """Serialize ``spec`` in the ``frax_collision.yaml`` format."""
    doc = {
        "collision_spheres": {
            link: [
                {"center": [round(float(c), 5) for c in center], "radius": round(float(r), 5)}
                for center, r in spheres
            ]
            for link, spheres in spec.spheres.items()
        },
        "self_collision_pairs": [list(p) for p in spec.self_collision_pairs],
        "sole_links": list(spec.sole_links),
    }
    header = (
        f"# FRAX collision model (source: {spec.source}).  Sphere centers are in each\n"
        "# link's frame.  Keep this file beside robot.yaml to replace the automatic model.\n"
    )
    return header + yaml.safe_dump(
        doc, sort_keys=False, default_flow_style=None, allow_unicode=True
    )


# ---------------------------------------------------------------------------
# frax's tuned Unitree G1 model
# ---------------------------------------------------------------------------


def _urdf_topology(root: ET.Element) -> dict[str, tuple[str, str]]:
    return {
        j.get("name"): (j.find("parent").get("link"), j.find("child").get("link"))
        for j in root.findall("joint")
        if j.find("parent") is not None and j.find("child") is not None
    }


#: frax's G1 model is reused only for URDFs this close to frax's own G1.
_G1_MAX_JOINT_ORIGIN_DELTA = 0.03
_G1_MAX_SOLE_HEIGHT_DELTA = 0.01
_G1_MAX_SOLE_EXTENT_DELTA = 0.025


def _fixed_parents(urdf_root: ET.Element) -> dict[str, str]:
    """child link → parent link, for links attached by fixed joints."""
    return {
        j.find("child").get("link"): j.find("parent").get("link")
        for j in urdf_root.findall("joint")
        if j.get("type") == "fixed" and j.find("child") is not None and j.find("parent") is not None
    }


def _movable_joint_origins_match(ours: ET.Element, reference: ET.Element, names) -> bool:
    from hhtools.retarget.frax_backend._urdf import origin_transform

    our_joints = {j.get("name"): j for j in ours.findall("joint")}
    ref_joints = {j.get("name"): j for j in reference.findall("joint")}
    for name in names:
        a, b = our_joints.get(name), ref_joints.get(name)
        if a is None or b is None or a.get("type") != b.get("type"):
            return False
        delta = np.abs(origin_transform(a)[:3, 3] - origin_transform(b)[:3, 3]).max()
        if float(delta) > _G1_MAX_JOINT_ORIGIN_DELTA:
            return False
    return True


def _sole_spheres_match(
    spheres: list[Sphere],
    world_from_link: NDArray[np.float64],
    link_points: NDArray[np.float64],
) -> bool:
    """Whether a foot's sole spheres cover its real sole (zero pose, world frame)."""
    if not spheres or link_points.shape[0] < 3:
        return False
    R, t = world_from_link[:3, :3], world_from_link[:3, 3]
    world = link_points @ R.T + t
    sole = world[world[:, 2] <= world[:, 2].min() + _SOLE_BAND]
    centres = np.asarray([R @ np.asarray(c) + t for c, _r in spheres])
    radii = np.asarray([r for _c, r in spheres])
    bottoms = centres[:, 2] - radii
    low = bottoms <= bottoms.min() + _SOLE_BAND
    if abs(float(bottoms.min()) - float(sole[:, 2].min())) > _G1_MAX_SOLE_HEIGHT_DELTA:
        return False
    for axis in (0, 1):
        lo = float((centres[low, axis] - radii[low]).min())
        hi = float((centres[low, axis] + radii[low]).max())
        if (
            abs(lo - float(sole[:, axis].min())) > _G1_MAX_SOLE_EXTENT_DELTA
            or abs(hi - float(sole[:, axis].max())) > _G1_MAX_SOLE_EXTENT_DELTA
        ):
            return False
    return True


def frax_g1_collision_spec(
    urdf_path: Path, robot: URDFRobotModel | None = None
) -> CollisionSpec | None:
    """frax's tuned G1 spheres, if ``urdf_path`` is a close match for frax's G1.

    Requires the same movable joints with the same parent/child links, joint
    origins within 3 cm of frax's G1 (hhtools' G1 differs by up to 1.9 cm in
    the torso; spheres are expressed in link frames, so they move with the
    meshes), and, when ``robot`` is given, sole spheres that match the real
    foot soles.  Otherwise returns ``None`` and the automatic model is used.
    """
    try:
        from hhtools.retarget.frax_backend._jax_env import import_frax

        import_frax()
        from frax.assets import G1_ASSETS_DIR
        from frax.robots import unitree_g1
    except Exception:
        return None
    try:
        reference_root = ET.parse(G1_ASSETS_DIR / "g1_29dof_rev_1_0.urdf").getroot()
        our_root = ET.parse(urdf_path).getroot()
    except (OSError, ET.ParseError):
        return None
    reference = _urdf_topology(reference_root)
    ours = _urdf_topology(our_root)
    movable_ref = {
        name: pc for name, pc in reference.items() if name in unitree_g1.joint_to_child_mapping
    }
    if not movable_ref or any(ours.get(name) != pc for name, pc in movable_ref.items()):
        return None
    if not _movable_joint_origins_match(our_root, reference_root, movable_ref):
        _log.info("FRAX: URDF has G1's joints but different dimensions; using automatic spheres")
        return None
    spec = load_collision_spec(Path(unitree_g1.collision_model_file), source="frax-g1")
    our_links = {c for _, c in ours.values()} | {p for p, _ in ours.values()}
    spec.spheres = {link: s for link, s in spec.spheres.items() if link in our_links}
    spec.self_collision_pairs = [
        (str(a), str(b))
        for a, b in unitree_g1.self_collision_link_pairs
        if a in spec.spheres and b in spec.spheres
    ]
    spec.sole_links = tuple(
        link for link in ("left_ankle_roll_link", "right_ankle_roll_link") if link in spec.spheres
    )
    mj_model = getattr(robot, "mujoco_model", None) if robot is not None else None
    if mj_model is not None:
        zero_pose = zero_pose_link_transforms(our_root)
        fixed_parent = _fixed_parents(our_root)
        roots = [n for n in zero_pose if n not in {c for _p, c in ours.values()}]
        root_link = roots[0] if len(roots) == 1 else None
        for foot in spec.sole_links:
            points = _link_points(mj_model, foot, zero_pose, fixed_parent, root_link=root_link)
            if not _sole_spheres_match(spec.spheres[foot], zero_pose[foot], points):
                _log.info("FRAX: G1 feet differ from frax's G1 model; using automatic spheres")
                return None
    return spec


# ---------------------------------------------------------------------------
# Automatic model
# ---------------------------------------------------------------------------


def _capsule_spheres(p0, p1, radius: float) -> list[Sphere]:
    a, b = np.asarray(p0, dtype=float), np.asarray(p1, dtype=float)
    length = float(np.linalg.norm(b - a))
    n = max(2, int(math.ceil(length / max(radius, 1e-3))) + 1)
    return [
        (tuple(float(x) for x in a + (b - a) * t), float(radius))  # type: ignore[misc]
        for t in np.linspace(0.0, 1.0, n)
    ]


def _unit_sphere_points(n: int = 64) -> NDArray[np.float64]:
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - 2 * i / n)
    theta = np.pi * (1 + 5**0.5) * i
    return np.c_[np.cos(theta) * np.sin(phi), np.sin(theta) * np.sin(phi), np.cos(phi)]


def _geom_points(model, gid: int) -> NDArray[np.float64]:
    """Points sampled on one MuJoCo geom's surface, in its body frame."""
    import mujoco

    gtype = int(model.geom_type[gid])
    c = np.asarray(model.geom_pos[gid], dtype=float)
    qw, qx, qy, qz = (float(x) for x in model.geom_quat[gid])
    R = np.array(
        [
            [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
            [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
            [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
        ]
    )
    size = np.asarray(model.geom_size[gid], dtype=float)
    if gtype == mujoco.mjtGeom.mjGEOM_MESH:
        mid = int(model.geom_dataid[gid])
        start, count = int(model.mesh_vertadr[mid]), int(model.mesh_vertnum[mid])
        local = np.asarray(model.mesh_vert[start : start + count], dtype=float)
    elif gtype == mujoco.mjtGeom.mjGEOM_BOX:
        g = np.linspace(-1.0, 1.0, 7)
        u, v = (a.ravel() for a in np.meshgrid(g, g))
        ones = np.ones_like(u)
        faces = [np.c_[s * ones, u, v] for s in (-1, 1)]
        faces += [np.c_[u, s * ones, v] for s in (-1, 1)]
        faces += [np.c_[u, v, s * ones] for s in (-1, 1)]
        local = np.vstack(faces) * size[:3]
    elif gtype in (mujoco.mjtGeom.mjGEOM_CAPSULE, mujoco.mjtGeom.mjGEOM_CYLINDER):
        r, hl = size[0], size[1]
        ang = np.linspace(0.0, 2 * np.pi, 16, endpoint=False)
        ring = np.c_[np.cos(ang), np.sin(ang)]
        parts = [np.c_[r * ring, np.full(16, z)] for z in np.linspace(-hl, hl, 9)]
        if gtype == mujoco.mjtGeom.mjGEOM_CAPSULE:
            cap = _unit_sphere_points(48) * r
            parts += [cap[cap[:, 2] > 0] + [0, 0, hl], cap[cap[:, 2] < 0] - [0, 0, hl]]
        else:
            parts += [np.c_[f * r * ring, np.full(16, z)] for z in (-hl, hl) for f in (0.0, 0.5)]
        local = np.vstack(parts)
    elif gtype in (mujoco.mjtGeom.mjGEOM_SPHERE, mujoco.mjtGeom.mjGEOM_ELLIPSOID):
        scale = size[:3] if gtype == mujoco.mjtGeom.mjGEOM_ELLIPSOID else np.full(3, size[0])
        local = _unit_sphere_points(64) * scale
    else:
        return np.zeros((0, 3))
    return c + local @ R.T


def _body_points(model, link: str, *, root_link: str | None = None) -> NDArray[np.float64]:
    """Collision-geometry points of ``link`` in its frame (visual meshes if it has none).

    MuJoCo fuses links attached by fixed joints into their parent body and puts
    the geometry of a fixed root link on the world body.
    """
    import mujoco

    bid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, link)
    if bid < 0 and link == root_link:
        bid = 0
    if bid < 0:
        return np.zeros((0, 3))
    gids = [g for g in range(model.ngeom) if int(model.geom_bodyid[g]) == bid]
    colliding = [g for g in gids if int(model.geom_contype[g]) or int(model.geom_conaffinity[g])]
    pts = [_geom_points(model, g) for g in (colliding or gids)]
    pts = [p for p in pts if p.size]
    return np.vstack(pts) if pts else np.zeros((0, 3))


def _link_points(
    mj_model,
    link: str,
    zero_pose: dict[str, NDArray[np.float64]],
    fixed_parent: dict[str, str],
    *,
    root_link: str | None = None,
) -> NDArray[np.float64]:
    """Collision points expressed in ``link``'s frame, even when MuJoCo merged it.

    MuJoCo fuses links attached by fixed joints into the nearest moving
    ancestor body.  For such a link, the ancestor body's points (which then
    include the link's own geometry) are re-expressed in the link frame.
    """
    pts = _body_points(mj_model, link, root_link=root_link)
    if pts.shape[0] or link not in zero_pose:
        return pts
    import mujoco

    ancestor, hops = link, 0
    while ancestor in fixed_parent and hops < 64:
        ancestor, hops = fixed_parent[ancestor], hops + 1
        is_body = mujoco.mj_name2id(mj_model, mujoco.mjtObj.mjOBJ_BODY, ancestor) >= 0
        if ancestor == root_link or is_body:
            break
    if ancestor == link or ancestor not in zero_pose:
        return pts
    merged = _body_points(mj_model, ancestor, root_link=root_link)
    if not merged.shape[0]:
        return merged
    link_from_ancestor = np.linalg.inv(zero_pose[link]) @ zero_pose[ancestor]
    return merged @ link_from_ancestor[:3, :3].T + link_from_ancestor[:3, 3]


def _sole_spheres(
    mj_model,
    link: str,
    world_from_link: NDArray[np.float64],
    *,
    root_link: str | None = None,
    points: NDArray[np.float64] | None = None,
) -> list[Sphere]:
    """Spheres at the four corners of a foot's sole (link frame).

    "Down" is world -Z with every joint at zero; corners are the sole points
    furthest toward toe-left, toe-right, heel-left and heel-right.  ``points``
    (link frame) overrides the MuJoCo body lookup, for links merged into a
    parent body.
    """
    pts = _body_points(mj_model, link, root_link=root_link) if points is None else points
    if pts.shape[0] < 2:
        return []
    R = world_from_link[:3, :3]
    z = pts @ R.T[:, 2]
    sole = pts[z <= z.min() + _SOLE_BAND]
    if sole.shape[0] < 2:
        return []
    sw = sole @ R.T
    picks = sorted(
        {int(np.argmax(sx * sw[:, 0] + sy * sw[:, 1])) for sx in (-1, 1) for sy in (-1, 1)}
    )
    up = R.T @ np.array([0.0, 0.0, 1.0])
    r = _SOLE_SPHERE_RADIUS
    # Sphere bottoms sit at the lowest sole height so all touch the floor together.
    base = sole[picks] - np.outer((sole[picks] @ up) - float(z.min()), up)
    return [(tuple(float(x) for x in p + r * up), r) for p in base]  # type: ignore[misc]


def _fit_link_spheres(
    points: NDArray[np.float64], max_spheres: int = _MAX_SPHERES_PER_LINK
) -> list[Sphere]:
    """A chain of spheres along the principal axis of a link's collision points.

    Radii are a high percentile of the points' distance from the axis, so the
    spheres hug the geometry instead of bounding it.
    """
    if points.shape[0] == 0:
        return []
    mean = points.mean(axis=0)
    centred = points - mean
    if points.shape[0] < 4 or float(np.abs(centred).max()) < _MIN_LINK_EXTENT:
        return []
    _, vecs = np.linalg.eigh(np.cov(centred.T))
    axis = vecs[:, -1]
    t = centred @ axis
    perp = np.linalg.norm(centred - np.outer(t, axis), axis=1)
    r_cross = float(
        np.clip(np.percentile(perp, _RADIUS_PERCENTILE), _MIN_SPHERE_RADIUS, _MAX_SPHERE_RADIUS)
    )
    t_min, t_max = float(t.min()), float(t.max())
    length = t_max - t_min
    n = int(
        np.clip(math.ceil(max(length - 2 * r_cross, 0.0) / (1.5 * r_cross)) + 1, 1, max_spheres)
    )
    if n == 1:
        centres_t = [0.5 * (t_min + t_max)]
    else:
        inset = min(r_cross, 0.5 * length)
        centres_t = list(np.linspace(t_min + inset, t_max - inset, n))
    half = max(0.5 * length / n, 1e-3)
    out: list[Sphere] = []
    for ct in centres_t:
        sel = np.abs(t - ct) <= half
        if not np.any(sel):
            continue
        offset = (centred[sel] - np.outer(t[sel], axis)).mean(axis=0)
        centre = mean + ct * axis + offset
        d = np.linalg.norm(centred[sel] - np.outer(t[sel], axis) - offset, axis=1)
        radius = float(
            np.clip(np.percentile(d, _RADIUS_PERCENTILE), _MIN_SPHERE_RADIUS, _MAX_SPHERE_RADIUS)
        )
        out.append((tuple(float(x) for x in centre), radius))  # type: ignore[misc]
    return out


def _foot_links(preset) -> list[str]:
    feet = preset.feet if isinstance(getattr(preset, "feet", None), dict) else {}
    ik_map = preset.ik_map or {}
    out = []
    for side in ("left", "right"):
        link = feet.get(f"{side}_contact_link") or ik_map.get(f"{side}_ankle")
        if link and link not in out:
            out.append(str(link))
    return out


def _slot_segments(ik_map: dict[str, str], urdf_root: ET.Element) -> dict[str, set[str]]:
    """Links belonging to each ik_map slot: its link plus descendants up to the next slot."""
    children: dict[str, list[str]] = {}
    for parent, child in _urdf_topology(urdf_root).values():
        children.setdefault(parent, []).append(child)
    slot_links = set(ik_map.values())
    out: dict[str, set[str]] = {}
    for slot, link in ik_map.items():
        seg, stack = set(), [link]
        while stack:
            cur = stack.pop()
            if cur in seg:
                continue
            seg.add(cur)
            stack.extend(c for c in children.get(cur, ()) if c not in slot_links)
        out[slot] = seg
    return out


def auto_collision_spec(robot: URDFRobotModel) -> CollisionSpec:
    """Spheres fitted to the robot's collision geometry, plus foot-sole spheres.

    Links without MuJoCo collision geometry fall back to the Newton backend's
    ground-collision capsules (derived from ``ik_map``).
    """
    preset = robot.preset
    if preset.urdf_path is None:
        return CollisionSpec(source="auto")
    urdf_path = Path(preset.urdf_path)
    urdf_root = ET.parse(urdf_path).getroot()
    ik_map = {str(k): str(v) for k, v in (preset.ik_map or {}).items()}
    segments = _slot_segments(ik_map, urdf_root)
    body_links = set().union(*segments.values()) if segments else set()
    feet = _foot_links(preset)
    zero_pose = zero_pose_link_transforms(urdf_root)
    mj_model = getattr(robot, "mujoco_model", None)

    topology = _urdf_topology(urdf_root)
    child_links = {child for _parent, child in topology.values()}
    roots = [
        link.get("name")
        for link in urdf_root.findall("link")
        if link.get("name") not in child_links
    ]
    root_link = roots[0] if len(roots) == 1 else None

    fixed_parent = _fixed_parents(urdf_root)

    spheres: dict[str, list[Sphere]] = {}
    if mj_model is not None:
        for link in sorted(body_links | set(feet)):
            if link in feet:
                if link in zero_pose:
                    points = _link_points(
                        mj_model, link, zero_pose, fixed_parent, root_link=root_link
                    )
                    sole = _sole_spheres(
                        mj_model, link, zero_pose[link], root_link=root_link, points=points
                    )
                    if sole:
                        spheres[link] = sole
                continue
            fitted = _fit_link_spheres(_body_points(mj_model, link, root_link=root_link))
            if fitted:
                spheres[link] = fitted

    if not any(link not in feet for link in spheres):
        from hhtools.retarget.newton_basic.ground_collision_bodies import (
            build_ground_collision_bodies_from_ik_map,
        )

        for body in build_ground_collision_bodies_from_ik_map(ik_map, urdf_path):
            p0, p1, radius = body["capsule"][0], body["capsule"][1], float(body["capsule"][2])
            spheres.setdefault(str(body["body"]), []).extend(_capsule_spheres(p0, p1, radius))

    def mirror(slot: str) -> str:
        if slot.startswith("left_"):
            return "right_" + slot[5:]
        if slot.startswith("right_"):
            return "left_" + slot[6:]
        return slot

    pairs: list[tuple[str, str]] = []
    for a, b in _SELF_COLLISION_SLOT_PAIRS:
        for sa, sb in ((a, b), (mirror(a), mirror(b))):
            for la in sorted(segments.get(sa, ())):
                for lb in sorted(segments.get(sb, ())):
                    if la == lb or la not in spheres or lb not in spheres:
                        continue
                    key = (la, lb) if la < lb else (lb, la)
                    if key not in pairs:
                        pairs.append(key)
    return CollisionSpec(
        spheres=spheres,
        self_collision_pairs=pairs,
        source="auto",
        sole_links=tuple(link for link in feet if link in spheres),
    )


def collision_spec_for_robot(robot: URDFRobotModel) -> CollisionSpec:
    """Collision model for ``robot``: override file, frax's G1 model, or automatic."""
    preset = robot.preset
    if preset.root_dir is not None:
        path = Path(preset.root_dir) / COLLISION_FILENAME
        if path.is_file():
            spec = load_collision_spec(path)
            if not spec.sole_links:
                spec.sole_links = tuple(
                    link for link in _foot_links(preset) if link in spec.spheres
                )
            return spec
    if preset.urdf_path is not None:
        spec = frax_g1_collision_spec(Path(preset.urdf_path), robot)
        if spec is not None:
            return spec
    return auto_collision_spec(robot)


# ---------------------------------------------------------------------------
# Layout for frax
# ---------------------------------------------------------------------------


def to_frax_collision_data(
    spec: CollisionSpec,
    link_frames: dict[str, tuple[int, NDArray[np.float64]]],
    nv: int,
    zero_pose: dict[str, NDArray[np.float64]] | None = None,
) -> CollisionLayout:
    """Express ``spec`` in frax's per-joint-frame ``collision_data`` layout.

    Args:
        spec: Collision model (spheres in link frames).
        link_frames: link → (frax joint index, link frame in that joint frame).
        nv: Number of frax velocity coordinates (joints, including the 6
            floating-base ones).
        zero_pose: Link world transforms at the zero pose, for the floor and
            self-collision filters described in the module docstring.  When
            ``None``, every sphere is a floor sphere and every pair is kept.
    """
    # Per frax joint: (centre in joint frame, radius, link, centre in link frame).
    per_joint: list[list[tuple[tuple[float, ...], float, str, NDArray[np.float64]]]] = [
        [] for _ in range(nv)
    ]
    skipped: list[str] = []
    for link, spheres in spec.spheres.items():
        frame = link_frames.get(link)
        if frame is None:
            skipped.append(link)
            continue
        joint, T = frame
        for center, radius in spheres:
            local = np.asarray(center, dtype=float)
            c = T[:3, :3] @ local + T[:3, 3]
            per_joint[joint].append((tuple(float(x) for x in c), float(radius), link, local))
    if skipped:
        _log.warning("FRAX collision: links not in the robot, spheres skipped: %s", sorted(skipped))

    # frax indexes spheres joint by joint, in this order.
    flat = [entry for spheres in per_joint for entry in spheres]
    radii = np.asarray([r for _c, r, _l, _p in flat], dtype=float)
    link_sphere_idxs: dict[str, list[int]] = {}
    for i, (_c, _r, link, _p) in enumerate(flat):
        link_sphere_idxs.setdefault(link, []).append(i)

    rest: NDArray[np.float64] | None = None  # zero-pose world centres, flat order
    if zero_pose is not None:
        rest = np.zeros((len(flat), 3))
        for i, (_c, _r, link, local) in enumerate(flat):
            T = zero_pose.get(link, np.eye(4))
            rest[i] = T[:3, :3] @ local + T[:3, 3]

    floor_idxs = list(range(len(flat)))
    if rest is not None and flat:
        bottoms = rest[:, 2] - radii
        is_sole = np.asarray([e[2] in spec.sole_links for e in flat], dtype=bool)
        floor_z = float(bottoms[is_sole].min() if is_sole.any() else bottoms.min())
        floor_idxs = [
            i
            for i in range(len(flat))
            if bottoms[i] >= floor_z + _FLOOR_CLEARANCE
            or (bool(is_sole[i]) and bottoms[i] <= floor_z + _FLOOR_SOLE_BAND)
            or (not is_sole.any() and bottoms[i] <= floor_z + _FLOOR_SOLE_BAND)
        ]

    body_pairs: list[tuple[int, int]] = []
    skipped_rest = 0
    seen: set[tuple[int, int]] = set()
    for la, lb in spec.self_collision_pairs:
        if la not in link_sphere_idxs or lb not in link_sphere_idxs or la == lb:
            continue
        if link_frames[la][0] == link_frames[lb][0]:  # one rigid body after merging
            continue
        for ia in link_sphere_idxs[la]:
            for ib in link_sphere_idxs[lb]:
                key = (min(ia, ib), max(ia, ib))
                if key in seen:
                    continue
                seen.add(key)
                if rest is not None:
                    gap = float(np.linalg.norm(rest[ia] - rest[ib])) - radii[ia] - radii[ib]
                    if gap < _SC_REST_CLEARANCE:
                        skipped_rest += 1
                        continue
                body_pairs.append(key)

    data = {
        "positions": tuple(tuple(e[0] for e in spheres) for spheres in per_joint),
        "radii": tuple(tuple(e[1] for e in spheres) for spheres in per_joint),
        "root_positions": (),
        "root_radii": (),
        "root_sc_pairs": (),
        "root_sc_tols": (),
        "body_sc_pairs": tuple(body_pairs),
        "body_sc_tols": tuple(0.0 for _ in body_pairs),
    }
    return CollisionLayout(
        collision_data=data,
        floor_sphere_idxs=tuple(floor_idxs),
        num_spheres=len(flat),
        num_self_collision_pairs=len(body_pairs),
        skipped_links=tuple(sorted(skipped)),
        skipped_rest_pairs=skipped_rest,
    )
