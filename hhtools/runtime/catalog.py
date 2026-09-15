"""Describe the actual registered HTTP contract for SDK, MCP, and Web clients."""

from __future__ import annotations

from copy import deepcopy

from fastapi.routing import APIRoute

from hhtools.contracts.runtime import OperationDescriptor

from .boundary import PREFIX, required_scope


def operation_catalog(app) -> list[dict]:
    specification = app.openapi()
    definitions = specification.get("components", {}).get("schemas", {})

    def schema(value):
        # Preserve recursive references and supply their definitions at the root.
        def rewrite(node):
            if isinstance(node, dict):
                return {
                    k: (
                        v.replace("#/components/schemas/", "#/$defs/")
                        if k == "$ref"
                        else rewrite(v)
                    )
                    for k, v in node.items()
                }
            if isinstance(node, list):
                return [rewrite(item) for item in node]
            return node

        result = rewrite(deepcopy(value))
        selected = {}
        pending = [value]
        while pending:
            node = pending.pop()
            if isinstance(node, dict):
                reference = node.get("$ref", "")
                name = reference.removeprefix("#/components/schemas/")
                if name in definitions and name not in selected:
                    selected[name] = definitions[name]
                    pending.append(definitions[name])
                pending.extend(node.values())
            elif isinstance(node, list):
                pending.extend(node)
        if selected:
            result["$defs"] = rewrite(selected)
        return result

    operations = []
    for route in app.routes:
        if not isinstance(route, APIRoute) or not route.path.startswith(
            (PREFIX + "/", "/api/agent/v1/")
        ):
            continue
        if not route.include_in_schema:
            continue
        for method in sorted(route.methods or []):
            entry = specification["paths"][route.path].get(method.lower())
            if entry is None:
                continue
            properties = {}
            required = []
            path_parameters = []
            query_parameters = []
            for parameter in entry.get("parameters", []):
                if parameter["in"] not in {"path", "query"}:
                    continue
                name = parameter["name"]
                properties[name] = parameter.get("schema", {})
                if parameter.get("required"):
                    required.append(name)
                (path_parameters if parameter["in"] == "path" else query_parameters).append(name)
            body_parameter = None
            content = entry.get("requestBody", {}).get("content", {})
            if "application/json" in content:
                body_parameter = "request"
                properties[body_parameter] = content["application/json"]["schema"]
                if entry["requestBody"].get("required"):
                    required.append(body_parameter)
            elif content:
                continue  # Binary transfer has a separate bounded data channel.
            response = next(
                (value for key, value in entry.get("responses", {}).items() if key.startswith("2")),
                {},
            )
            output = response.get("content", {}).get("application/json", {}).get("schema", {})
            if not output:
                continue
            execution = "query" if method == "GET" else "command"
            if (
                route.path.endswith(("/jobs", "/jobs/start", "/retarget/start"))
                and method == "POST"
            ):
                execution = "job"
            elif "/previews" in route.path:
                execution = "session"
            operations.append(
                OperationDescriptor(
                    name="hhtools_" + route.name,
                    description=(entry.get("description") or entry.get("summary") or route.name),
                    method=method,
                    path=route.path,
                    scope=required_scope(method, route.path),
                    execution=execution,
                    input_schema=schema(
                        {
                            "type": "object",
                            "properties": properties,
                            "required": required,
                            "additionalProperties": False,
                        }
                    ),
                    output_schema=schema(output),
                    body_parameter=body_parameter,
                    path_parameters=path_parameters,
                    query_parameters=query_parameters,
                ).model_dump(mode="json")
            )
    names = [item["name"] for item in operations]
    if len(names) != len(set(names)):
        raise RuntimeError("Runtime operation names must be unique")
    return operations
