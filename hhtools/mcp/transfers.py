"""Client-side file transfer rooted in explicitly configured local directories."""

from pathlib import Path

from mcp.types import Tool, ToolAnnotations

from hhtools.client.runtime import client_error
from hhtools.contracts import ArtifactDescriptor, AssetBundle, AssetKind


class LocalTransfers:
    def __init__(self, client, roots):
        self.client = client
        self.roots = tuple(Path(root).expanduser().resolve(strict=True) for root in roots)
        if not all(root.is_dir() for root in self.roots):
            raise ValueError("Transfer roots must be directories")

    def tools(self):
        properties = {"type": "string", "minLength": 1}
        return [
            Tool(
                name="upload_local_file",
                description=(
                    "Upload a local file or directory bundle under configured transfer "
                    "roots. Resume with the upload_id from an interrupted transfer. "
                    "Paths refer to the MCP host, not the Runtime host."
                ),
                input_schema={
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "source_path": properties,
                        "kind": {"type": "string", "enum": [kind.value for kind in AssetKind]},
                        "upload_id": {"type": "string", "pattern": "^[a-f0-9]{32}$"},
                    },
                    "required": ["source_path", "kind"],
                },
                output_schema=AssetBundle.model_json_schema(),
                annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False),
            ),
            Tool(
                name="download_artifact",
                description=(
                    "Download a verified job artifact to a local path under configured "
                    "transfer roots. Existing files require overwrite=true. "
                    "Interrupted downloads resume from verified artifact identity."
                ),
                input_schema={
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "job_id": properties,
                        "artifact_id": properties,
                        "destination_path": properties,
                        "overwrite": {"type": "boolean", "default": False},
                    },
                    "required": ["job_id", "artifact_id", "destination_path"],
                },
                output_schema=ArtifactDescriptor.model_json_schema(),
                annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True),
            ),
        ]

    def path(self, value):
        path = Path(value).expanduser().absolute()
        if any(part.is_symlink() for part in (path, *path.parents)):
            raise client_error("TRANSFER_PATH_FORBIDDEN", "Transfer paths must not contain links.")
        resolved = path.resolve()
        if not any(resolved.is_relative_to(root) for root in self.roots):
            raise client_error(
                "TRANSFER_PATH_FORBIDDEN", "Path is outside configured transfer roots."
            )
        return resolved

    def call(self, name, arguments):
        try:
            if name == "upload_local_file":
                source = self.path(arguments["source_path"])
                if not source.is_file() and not source.is_dir():
                    raise client_error(
                        "INPUT_NOT_FOUND", "Select a local file or directory bundle."
                    )
                return self.client.upload(
                    source, kind=arguments["kind"], upload_id=arguments.get("upload_id")
                )
            return self.client.download(
                arguments["job_id"],
                arguments["artifact_id"],
                self.path(arguments["destination_path"]),
                overwrite=arguments.get("overwrite", False),
            )
        except OSError as error:
            raise client_error(
                "LOCAL_FILE_ERROR", "Local transfer files could not be accessed."
            ) from error
