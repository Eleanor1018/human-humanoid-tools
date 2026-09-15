"""Bounded validation diagnostics without echoing input values or exception context."""


def validation_details(errors):
    fields = []
    for item in errors[:20]:
        fields.append(
            {
                "path": [str(part)[:80] for part in item.get("loc", ())[:12] if part != "body"],
                "type": item.get("type", "value_error"),
            }
        )
    return {"fields": fields, "truncated": len(errors) > 20}


def schema_error_details(error):
    field = {
        "path": [str(part)[:80] for part in list(error.absolute_path)[:12]],
        "type": error.validator,
    }
    if error.validator in {"enum", "const", "type", "minimum", "maximum", "required"}:
        field["expected"] = error.validator_value
    return {"fields": [field]}
