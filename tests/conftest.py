"""Local HTTP adapters are exercised over an explicit loopback transport."""

from __future__ import annotations

from importlib.util import find_spec

import pytest


@pytest.fixture(autouse=True)
def loopback_test_client(monkeypatch):
    if find_spec("starlette") is None or find_spec("httpx") is None:
        # Portable contract-only environments do not install the Web extra.
        return
    from starlette.testclient import TestClient

    original_init = TestClient.__init__

    def initialize(client_instance, *args, **kwargs):
        if len(args) < 2:
            kwargs.setdefault("base_url", "http://127.0.0.1")
        kwargs.setdefault("client", ("127.0.0.1", 50000))
        original_init(client_instance, *args, **kwargs)

    monkeypatch.setattr(TestClient, "__init__", initialize)


@pytest.fixture(scope="module")
def grounding_robot_pair(tmp_path_factory):
    from xml.etree.ElementTree import Element, SubElement, tostring

    from hhtools.robot.base import RobotPreset
    from hhtools.robot.loader import load_robot

    topology = {
        "hips": (None, (0, 0, 0)),
        "spine": ("hips", (0, 0, 0.12)),
        "chest": ("spine", (0, 0, 0.15)),
        "neck": ("chest", (0, 0, 0.12)),
        "head": ("neck", (0, 0, 0.10)),
    }
    for side, direction in (("left", 1), ("right", -1)):
        topology.update(
            {
                f"{side}_shoulder": ("chest", (0, direction * 0.18, 0)),
                f"{side}_elbow": (f"{side}_shoulder", (0, direction * 0.24, 0)),
                f"{side}_wrist": (f"{side}_elbow", (0, direction * 0.22, 0)),
                f"{side}_hip": ("hips", (0, direction * 0.10, -0.10)),
                f"{side}_knee": (f"{side}_hip", (0, 0, -0.30)),
                f"{side}_ankle": (f"{side}_knee", (0, 0, -0.30)),
            }
        )
    models = []
    for name, scale in (("fixture_source", 1.0), ("fixture_target", 1.2)):
        root = tmp_path_factory.mktemp(name)
        document = Element("robot", name=name)
        for bone, (parent, offset) in topology.items():
            link = SubElement(document, "link", name=bone)
            visual = SubElement(link, "visual", name=f"{bone}_visual")
            foot = bone.endswith("ankle")
            SubElement(visual, "origin", xyz=f"0 0 {-0.035 * scale if foot else 0}")
            geometry = SubElement(visual, "geometry")
            dimensions = (0.20, 0.10, 0.07) if foot else (0.04, 0.04, 0.04)
            SubElement(geometry, "box", size=" ".join(str(value * scale) for value in dimensions))
            if parent is not None:
                joint = SubElement(document, "joint", name=f"{bone}_joint", type="revolute")
                SubElement(joint, "parent", link=parent)
                SubElement(joint, "child", link=bone)
                SubElement(joint, "origin", xyz=" ".join(str(value * scale) for value in offset))
                SubElement(joint, "axis", xyz="0 1 0")
                SubElement(joint, "limit", lower="-2", upper="2", effort="50", velocity="10")
        urdf = root / "robot.urdf"
        urdf.write_text(tostring(document, encoding="unicode"))
        preset = RobotPreset(
            name=name,
            display_name=name,
            root_dir=root,
            urdf_path=urdf,
            ik_map={bone: bone for bone in topology},
            feet={"left_contact_link": "left_ankle", "right_contact_link": "right_ankle"},
        )
        models.append(load_robot(preset, compile_mjcf=False))
    return tuple(models)
