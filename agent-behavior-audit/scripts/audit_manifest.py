#!/usr/bin/env python3
"""Validate and summarize complete agent-behavior audit coverage manifests."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


class ManifestError(ValueError):
    pass


def require_string(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManifestError(f"{path} must be a non-empty string")
    return value


def require_string_list(value: Any, path: str) -> list[str]:
    if not isinstance(value, list):
        raise ManifestError(f"{path} must be an array")
    items = [require_string(item, f"{path}[]") for item in value]
    if len(items) != len(set(items)):
        raise ManifestError(f"{path} contains duplicate session ids")
    return items


def reasoned_ids(value: Any, path: str) -> dict[str, str]:
    if not isinstance(value, list):
        raise ManifestError(f"{path} must be an array")
    result: dict[str, str] = {}
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise ManifestError(f"{path}[{index}] must be an object")
        session_id = require_string(item.get("sessionId"), f"{path}[{index}].sessionId")
        reason = require_string(item.get("reason"), f"{path}[{index}].reason")
        if session_id in result:
            raise ManifestError(f"{path} contains duplicate session id {session_id}")
        result[session_id] = reason
    return result


def validate_source(source: Any, index: int) -> dict[str, int]:
    path = f"sources[{index}]"
    if not isinstance(source, dict):
        raise ManifestError(f"{path} must be an object")
    for field in (
        "sourceId",
        "device",
        "account",
        "surface",
        "checkedAt",
        "sourceUpdatedAt",
    ):
        require_string(source.get(field), f"{path}.{field}")
    if source.get("coverageMode") != "complete":
        raise ManifestError(f"{path}.coverageMode must be complete")
    if source.get("samplingUsed") is not False:
        raise ManifestError(f"{path}.samplingUsed must be false")

    freshness = source.get("freshnessStatus")
    if freshness not in {"current", "stale", "unknown"}:
        raise ManifestError(f"{path}.freshnessStatus is invalid")
    freshness_reason = source.get("freshnessReason")
    if freshness in {"stale", "unknown"}:
        require_string(freshness_reason, f"{path}.freshnessReason")
    elif freshness_reason is not None:
        raise ManifestError(f"{path}.freshnessReason must be null when current")

    discovered = set(require_string_list(source.get("discoveredSessionIds"), f"{path}.discoveredSessionIds"))
    readable = set(require_string_list(source.get("readableSessionIds"), f"{path}.readableSessionIds"))
    analyzed = set(require_string_list(source.get("analyzedSessionIds"), f"{path}.analyzedSessionIds"))
    unreadable = set(reasoned_ids(source.get("unreadable"), f"{path}.unreadable"))
    excluded = set(reasoned_ids(source.get("excluded"), f"{path}.excluded"))

    if readable & unreadable:
        raise ManifestError(f"{path} marks sessions both readable and unreadable")
    if discovered != readable | unreadable:
        raise ManifestError(f"{path} does not account for every discovered session")
    if analyzed & excluded:
        raise ManifestError(f"{path} marks sessions both analyzed and excluded")
    if readable != analyzed | excluded:
        raise ManifestError(f"{path} does not account for every readable session")

    return {
        "discovered": len(discovered),
        "readable": len(readable),
        "analyzed": len(analyzed),
        "unreadable": len(unreadable),
        "excluded": len(excluded),
        "fresh": int(freshness == "current"),
    }


def validate_manifest(manifest: Any) -> dict[str, Any]:
    if not isinstance(manifest, dict):
        raise ManifestError("manifest must be an object")
    if manifest.get("schemaVersion") != 1:
        raise ManifestError("schemaVersion must be 1")
    require_string(manifest.get("auditId"), "auditId")

    period = manifest.get("period")
    if not isinstance(period, dict):
        raise ManifestError("period must be an object")
    for field in ("start", "end", "timezone"):
        require_string(period.get(field), f"period.{field}")

    baseline = manifest.get("baseline")
    if not isinstance(baseline, dict):
        raise ManifestError("baseline must be an object")
    kind = baseline.get("kind")
    verdict = manifest.get("verdict")
    if kind == "first-complete-month":
        if baseline.get("priorAuditId") is not None or verdict != "baseline":
            raise ManifestError("first complete month requires null priorAuditId and baseline verdict")
    elif kind == "comparison":
        require_string(baseline.get("priorAuditId"), "baseline.priorAuditId")
        if verdict not in {"improved", "regressed", "mixed"}:
            raise ManifestError("comparison verdict must be improved, regressed, or mixed")
    else:
        raise ManifestError("baseline.kind is invalid")

    sources = manifest.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ManifestError("sources must be a non-empty array")
    source_ids: set[str] = set()
    totals = {
        "sources": len(sources),
        "discovered": 0,
        "readable": 0,
        "analyzed": 0,
        "unreadable": 0,
        "excluded": 0,
        "freshSources": 0,
    }
    for index, source in enumerate(sources):
        source_totals = validate_source(source, index)
        source_id = source["sourceId"]
        if source_id in source_ids:
            raise ManifestError(f"duplicate sourceId {source_id}")
        source_ids.add(source_id)
        for key, value in source_totals.items():
            totals["freshSources" if key == "fresh" else key] += value
    return totals


def load_manifest(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ManifestError(str(error)) from error


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("validate", "summarize"))
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    try:
        totals = validate_manifest(load_manifest(args.manifest))
    except ManifestError as error:
        if args.json:
            print(json.dumps({"valid": False, "error": str(error)}, sort_keys=True))
        else:
            print(f"invalid: {error}", file=sys.stderr)
        return 1

    result = {"valid": True, **totals}
    if args.json or args.command == "summarize":
        print(json.dumps(result, sort_keys=True))
    else:
        print("valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
