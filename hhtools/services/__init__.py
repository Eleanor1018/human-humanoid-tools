"""Transport-neutral application services for HHTools clients.

The Web UI, JSON CLI, REST API, and MCP adapter must call this layer rather
than importing one another.  Solver and calibration algorithms stay in their
existing modules; services only discover capabilities and orchestrate them.
"""

from .capabilities import CapabilitiesService

__all__ = ["CapabilitiesService"]
