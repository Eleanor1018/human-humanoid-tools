"""MuJoCo offscreen rendering of HHTools kinematic scene data."""

from __future__ import annotations

import base64
import io
import time
from xml.etree.ElementTree import Element, SubElement, tostring

import numpy as np


class PreviewRenderer:
    """Keep camera control, scene transforms, and rendering in one process-local loop."""

    def __init__(self, scene, width: int, height: int):
        import mujoco

        self.mj = mujoco
        self.scene = scene
        self.frame = 0
        self.playing = True
        self._started = time.monotonic()
        self._offset = 0.0
        if scene.robot_model is not None and scene.robot_model.mujoco_model is None:
            from hhtools.services.runtime_control import RuntimeServiceError

            raise RuntimeServiceError(
                "PREVIEW_ROBOT_UNSUPPORTED",
                "This robot is not supported by the MuJoCo preview backend.",
            )
        environment = scene.data["motion"] or {}
        self._has_terrain = bool(environment.get("terrain"))
        if scene.robot_model is not None and scene.robot_model.mujoco_model is not None:
            self.model = scene.robot_model.mujoco_model
            self.model.vis.global_.offwidth = max(width, self.model.vis.global_.offwidth)
            self.model.vis.global_.offheight = max(height, self.model.vis.global_.offheight)
        else:
            xml = Element("mujoco")
            visual = SubElement(xml, "visual")
            SubElement(visual, "global", offwidth=str(width), offheight=str(height))
            world = SubElement(xml, "worldbody")
            SubElement(world, "light", pos="0 -2 4", dir="0 0 -1", directional="true")
            if not self._has_terrain:
                SubElement(world, "geom", type="plane", size="10 10 0.01", rgba="0.22 0.25 0.27 1")
            self.model = mujoco.MjModel.from_xml_string(tostring(xml, encoding="unicode"))
        environment = scene.data["motion"] or {}
        terrain = environment.get("terrain")
        objects = environment.get("objects", [])
        if terrain or any(item.get("glb_base64") for item in objects):
            if scene.robot_model is not None:
                path = scene.robot_model.preset.urdf_path.parent / "preview-scene.xml"
                scene.robot_model.write_mjcf(path)
                spec = mujoco.MjSpec.from_file(str(path))
            else:
                spec = mujoco.MjSpec.from_string(tostring(xml, encoding="unicode"))
            if terrain:
                spec.add_mesh(
                    name="hhtools_terrain",
                    uservert=np.asarray(terrain["vertices"]).ravel(),
                    userface=np.asarray(terrain["faces"]).ravel(),
                    inertia=mujoco.mjtMeshInertia.mjMESH_INERTIA_SHELL,
                )
                spec.worldbody.add_geom(
                    type=mujoco.mjtGeom.mjGEOM_MESH,
                    meshname="hhtools_terrain",
                    contype=0,
                    conaffinity=0,
                    rgba=[0.3, 0.38, 0.43, 1],
                )
            for index, item in enumerate(objects):
                if not item.get("glb_base64"):
                    continue
                import trimesh

                mesh = trimesh.load(
                    io.BytesIO(base64.b64decode(item["glb_base64"])),
                    file_type="glb",
                    force="mesh",
                    process=False,
                )
                name = f"hhtools_object_{index}"
                spec.add_mesh(
                    name=name,
                    uservert=np.asarray(mesh.vertices).ravel(),
                    userface=np.asarray(mesh.faces).ravel(),
                    inertia=mujoco.mjtMeshInertia.mjMESH_INERTIA_SHELL,
                )
                spec.worldbody.add_geom(
                    name=name,
                    type=mujoco.mjtGeom.mjGEOM_MESH,
                    meshname=name,
                    contype=0,
                    conaffinity=0,
                    rgba=[0.83, 0.45, 0.21, 1],
                )
            self.model = spec.compile()
            self.model.vis.global_.offwidth = max(width, self.model.vis.global_.offwidth)
            self.model.vis.global_.offheight = max(height, self.model.vis.global_.offheight)
        self._objects = objects
        self.state = mujoco.MjData(self.model)
        self.model.vis.headlight.ambient[:] = [0.55, 0.55, 0.55]
        self.model.vis.headlight.diffuse[:] = [0.85, 0.85, 0.85]
        mujoco.mj_forward(self.model, self.state)
        self.renderer = mujoco.Renderer(self.model, height=height, width=width, max_geom=10000)
        self.camera = mujoco.MjvCamera()
        mujoco.mjv_defaultCamera(self.camera)
        motion = scene.data["motion"]
        if motion and motion.get("positions"):
            values = np.asarray(motion["positions"][0])
            lower, upper = values.min(axis=0), values.max(axis=0)
        elif scene.data["robot_trajectory"]:
            roots = np.asarray(
                [frame["root"][:3] for frame in scene.data["robot_trajectory"]["frames"]]
            )
            lower, upper = roots.min(axis=0), roots.max(axis=0) + [0, 0, 1.5]
        elif scene.robot_model is not None and self.model.ngeom:
            radii = self.model.geom_rbound[:, None]
            lower = (self.state.geom_xpos - radii).min(axis=0)
            upper = (self.state.geom_xpos + radii).max(axis=0)
        else:
            lower, upper = np.array([-0.5, -0.5, 0]), np.array([0.5, 0.5, 1.8])
        self.camera.lookat[:] = (lower + upper) / 2
        self.camera.distance = max(2.5, float(np.linalg.norm(upper - lower)) * 1.5)
        self.camera.azimuth = 135
        self.camera.elevation = -15

    def input(self, event):
        action = event.action
        if action == "orbit":
            self.camera.azimuth += event.x
            self.camera.elevation = max(-89, min(0, self.camera.elevation + event.y))
        elif action == "zoom":
            self.camera.distance = max(0.2, min(100, event.value))
        elif action == "seek":
            self.frame = min(self.scene.frame_count - 1, int(event.value))
            self._offset = self.frame / max(1, self.scene.frame_count - 1) * self.scene.duration
            self._started = time.monotonic()
        elif action == "pause":
            self._offset += time.monotonic() - self._started
            self.playing = False
        elif action == "play":
            self._started = time.monotonic()
            self.playing = True

    def _robot(self, index):
        trajectory = self.scene.data["robot_trajectory"]
        if not trajectory:
            return
        from scipy.spatial.transform import Rotation

        frame = trajectory["frames"][index]
        root = frame.get("root", [0, 0, 0, 0, 0, 0, 1])
        root_rotation = Rotation.from_quat(root[3:]).as_matrix()
        root_position = np.asarray(root[:3], dtype=float)
        root_position[2] += frame.get("mesh_z_lift", 0)
        for geom_id in range(self.model.ngeom):
            body_id = self.model.geom_bodyid[geom_id]
            link = self.mj.mj_id2name(self.model, self.mj.mjtObj.mjOBJ_BODY, body_id)
            matrix = frame["links"].get(link)
            if matrix is None:
                continue
            transform = np.asarray(matrix).reshape(4, 4)
            rotation = root_rotation @ transform[:3, :3]
            local = np.empty(9)
            self.mj.mju_quat2Mat(local, self.model.geom_quat[geom_id])
            self.state.geom_xmat[geom_id] = (rotation @ local.reshape(3, 3)).ravel()
            self.state.geom_xpos[geom_id] = (
                root_position
                + root_rotation @ transform[:3, 3]
                + rotation @ self.model.geom_pos[geom_id]
            )

    def render(self, *, frame: int | None = None):
        if frame is not None:
            self.frame = min(max(0, frame), self.scene.frame_count - 1)
        elif self.playing and self.scene.duration > 0:
            elapsed = (self._offset + time.monotonic() - self._started) % self.scene.duration
            self.frame = int(elapsed / self.scene.duration * max(1, self.scene.frame_count - 1))
        self._robot(self.frame)
        from scipy.spatial.transform import Rotation

        for index, item in enumerate(self._objects):
            if not item.get("glb_base64") or not item.get("positions"):
                continue
            sample = min(
                len(item["positions"]) - 1,
                round(
                    self.frame / max(1, self.scene.frame_count - 1) * (len(item["positions"]) - 1)
                ),
            )
            geom_id = self.mj.mj_name2id(
                self.model, self.mj.mjtObj.mjOBJ_GEOM, f"hhtools_object_{index}"
            )
            rotation = Rotation.from_quat(item["quaternions"][sample]).as_matrix()
            local = np.empty(9)
            self.mj.mju_quat2Mat(local, self.model.geom_quat[geom_id])
            self.state.geom_xpos[geom_id] = (
                np.asarray(item["positions"][sample]) + rotation @ self.model.geom_pos[geom_id]
            )
            self.state.geom_xmat[geom_id] = (rotation @ local.reshape(3, 3)).ravel()
        motion = self.scene.data["motion"]
        if motion and motion.get("positions"):
            pose = np.asarray(motion["positions"][min(self.frame, len(motion["positions"]) - 1)])
            self.camera.lookat[:] = (pose.min(axis=0) + pose.max(axis=0)) / 2
        self.renderer.update_scene(self.state, camera=self.camera)
        for item in self._objects:
            if item.get("glb_base64") or not item.get("positions"):
                continue
            sample = min(self.frame, len(item["positions"]) - 1)
            geom = self.renderer.scene.geoms[self.renderer.scene.ngeom]
            rotation = Rotation.from_quat(item["quaternions"][sample]).as_matrix()
            self.mj.mjv_initGeom(
                geom,
                self.mj.mjtGeom.mjGEOM_BOX,
                np.asarray(item["extents"]) / 2,
                np.asarray(item["positions"][sample]),
                rotation.ravel(),
                np.array([0.83, 0.45, 0.21, 1], dtype=np.float32),
            )
            self.renderer.scene.ngeom += 1
        if (
            self.scene.robot_model is not None
            and not self._has_terrain
            and self.renderer.scene.ngeom < self.renderer.scene.maxgeom
        ):
            ground = (
                0
                if self.scene.data["robot_trajectory"]
                else -float(self.scene.data["robot"].get("ground_offset_z", 0))
            )
            geom = self.renderer.scene.geoms[self.renderer.scene.ngeom]
            self.mj.mjv_initGeom(
                geom,
                self.mj.mjtGeom.mjGEOM_PLANE,
                np.array([10, 10, 0.01]),
                np.array([0.0, 0.0, ground]),
                np.eye(3).ravel(),
                np.array([0.3, 0.34, 0.36, 1], dtype=np.float32),
            )
            self.renderer.scene.ngeom += 1
        motion = self.scene.data["motion"]
        if motion and motion.get("positions"):
            position = np.asarray(
                motion["positions"][min(self.frame, len(motion["positions"]) - 1)]
            )
            for joint, parent in enumerate(motion["parent_indices"]):
                if parent < 0 or self.renderer.scene.ngeom >= self.renderer.scene.maxgeom:
                    continue
                geom = self.renderer.scene.geoms[self.renderer.scene.ngeom]
                self.mj.mjv_initGeom(
                    geom,
                    self.mj.mjtGeom.mjGEOM_CAPSULE,
                    np.array([0.025, 0.025, 0.025]),
                    np.zeros(3),
                    np.eye(3).ravel(),
                    np.array([0.12, 0.85, 0.6, 1.0], dtype=np.float32),
                )
                self.mj.mjv_connector(
                    geom, self.mj.mjtGeom.mjGEOM_CAPSULE, 0.025, position[parent], position[joint]
                )
                self.renderer.scene.ngeom += 1
        return self.renderer.render()

    def close(self):
        self.renderer.close()
