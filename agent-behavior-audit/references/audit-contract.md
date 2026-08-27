# Agent behavior audit contract

The private audit output contains one coverage manifest plus reports and
sanitized fixtures. Raw transcripts stay outside Git.

## Coverage manifest

```json
{
  "schemaVersion": 1,
  "auditId": "2026-09-fleet",
  "period": {
    "start": "2026-09-01T00:00:00+01:00",
    "end": "2026-10-01T00:00:00+01:00",
    "timezone": "Europe/London"
  },
  "baseline": {
    "kind": "first-complete-month",
    "priorAuditId": null
  },
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
      "freshnessReason": null,
      "coverageMode": "complete",
      "samplingUsed": false,
      "discoveredSessionIds": ["session-1"],
      "readableSessionIds": ["session-1"],
      "analyzedSessionIds": ["session-1"],
      "unreadable": [],
      "excluded": []
    }
  ]
}
```

Each source is one device, account, harness, and native store combination.
Session identity needs to be stable only within that source. Preserve raw native
identifiers in the private manifest when they are safe; otherwise store a
content-addressed private alias with a separate local mapping.

Coverage must satisfy both equations for every source:

```text
discovered = readable + unreadable
readable = analyzed + excluded
```

The sets must be disjoint at each equation. Every unreadable or excluded item
has a non-empty reason. `coverageMode` is always `complete` and `samplingUsed`
is always `false` for a quantitative audit.

`freshnessStatus` is `current`, `stale`, or `unknown`. Stale and unknown sources
require `freshnessReason`. The manifest validator checks these invariants but
does not decide semantic behavior labels.

## Evidence groups

Use distinct private groups:

```text
agents/
├── findings/     quality-admitted evidence and provenance
├── reports/      monthly audit reports and coverage manifests
├── fixtures/     sanitized positive, failure, and clean-negative regressions
└── promotions/   links from findings to public skill or project changes
```

Reports may refer to cold raw evidence by stable private identity and checksum.
Do not copy raw transcripts into the synchronized Git repository.

## Comparison contract

`baseline.kind` is `first-complete-month` only for Month 0; `priorAuditId` is
null and `verdict` is `baseline`. Later comparable audits use
`baseline.kind: "comparison"`, name the prior complete audit, and use
`improved`, `regressed`, or `mixed`.

Every reported rate includes numerator, denominator, collection method, and
confidence. A collection-method change is reported beside the comparison and
may make a metric non-comparable.
