"""Inspect serialization headers without depending on NumPy's private exports."""

import io
from types import SimpleNamespace

import numpy as np
import pytest
from numpy.lib import format as npformat

from hhtools.services.asset_execution_policy import AssetExecutionPolicy


@pytest.mark.parametrize("version", [(1, 0), (2, 0)])
@pytest.mark.parametrize("dtype, expected", [(np.float64, False), (object, True)])
def test_header_inspection_uses_public_numpy_api(monkeypatch, version, dtype, expected):
    stream = io.BytesIO()
    npformat.write_array(stream, np.array([1, 2], dtype=dtype), version=version)
    stream.seek(0)
    public = SimpleNamespace(
        read_magic=npformat.read_magic,
        read_array_header_1_0=npformat.read_array_header_1_0,
        read_array_header_2_0=npformat.read_array_header_2_0,
    )
    monkeypatch.setattr(np.lib, "format", public)
    assert AssetExecutionPolicy._object_array(stream) is expected


def test_unknown_header_versions_require_trust():
    stream = io.BytesIO(npformat.magic(3, 0))
    assert AssetExecutionPolicy._object_array(stream) is True
