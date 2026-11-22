"""Interaction-mesh object samples are sized like the object, in the solver frame."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np

from hhtools.core.scene import SceneObject
from hhtools.retarget.interaction_mesh.pipeline import InteractionMeshPipeline


def test_object_box_samples_use_metric_extents_and_the_scene_scale() -> None:
    # An OmniContact-style prop: a 30 cm box whose mesh is in centimetres (vertex scale 0.01).
    # ``extents`` are already metres; the vertex scale must not shrink the box again.
    box = SceneObject(
        "box",
        positions=np.array([[1.0, 2.0, 0.5]]),
        quaternions=np.array([[0.0, 0.0, 0.0, 1.0]]),
        extents=np.array([0.30, 0.20, 0.10]),
        scale=0.01,
    )
    fake = SimpleNamespace(cfg=SimpleNamespace(object_surface_samples=4000))
    positions, points = InteractionMeshPipeline._build_scaled_object_points(
        fake, SimpleNamespace(objects=[box]), 0.1, 0.8
    )
    np.testing.assert_allclose(positions[0][0], [0.8, 1.6, 0.32], atol=1e-6)
    span = np.ptp(points[0][0], axis=0)
    np.testing.assert_allclose(span, np.array([0.30, 0.20, 0.10]) * 0.8, rtol=0.02)
