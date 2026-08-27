import json
import tempfile
import unittest
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from audit_manifest import ManifestError, validate_manifest


def valid_manifest():
    return {
        "schemaVersion": 1,
        "auditId": "2026-09-fleet",
        "period": {
            "start": "2026-09-01T00:00:00+01:00",
            "end": "2026-10-01T00:00:00+01:00",
            "timezone": "Europe/London",
        },
        "baseline": {"kind": "first-complete-month", "priorAuditId": None},
        "verdict": "baseline",
        "sources": [
            {
                "sourceId": "device-a:account-a:codex",
                "device": "device-a",
                "account": "account-a",
                "surface": "codex",
                "checkedAt": "2026-10-02T09:00:00+01:00",
                "sourceUpdatedAt": "2026-09-30T18:20:00+01:00",
                "freshnessStatus": "current",
                "freshnessReason": None,
                "coverageMode": "complete",
                "samplingUsed": False,
                "discoveredSessionIds": ["s1", "s2", "s3"],
                "readableSessionIds": ["s1", "s2"],
                "analyzedSessionIds": ["s1"],
                "unreadable": [{"sessionId": "s3", "reason": "permission denied"}],
                "excluded": [{"sessionId": "s2", "reason": "synthetic test"}],
            }
        ],
    }


class AuditManifestTests(unittest.TestCase):
    def test_accepts_complete_accounting(self):
        totals = validate_manifest(valid_manifest())
        self.assertEqual(totals["discovered"], 3)
        self.assertEqual(totals["analyzed"], 1)
        self.assertEqual(totals["freshSources"], 1)

    def test_rejects_sampled_manifest(self):
        manifest = valid_manifest()
        manifest["sources"][0]["coverageMode"] = "sample"
        manifest["sources"][0]["samplingUsed"] = True
        with self.assertRaisesRegex(ManifestError, "coverageMode"):
            validate_manifest(manifest)

    def test_rejects_unaccounted_discovered_sessions(self):
        manifest = valid_manifest()
        manifest["sources"][0]["discoveredSessionIds"].append("s4")
        with self.assertRaisesRegex(ManifestError, "every discovered"):
            validate_manifest(manifest)

    def test_rejects_unexplained_unknown_freshness(self):
        manifest = valid_manifest()
        manifest["sources"][0]["freshnessStatus"] = "unknown"
        with self.assertRaisesRegex(ManifestError, "freshnessReason"):
            validate_manifest(manifest)

    def test_rejects_missing_source_update_evidence(self):
        manifest = valid_manifest()
        manifest["sources"][0]["sourceUpdatedAt"] = None
        with self.assertRaisesRegex(ManifestError, "sourceUpdatedAt"):
            validate_manifest(manifest)


if __name__ == "__main__":
    unittest.main()
