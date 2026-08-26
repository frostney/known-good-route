# Contract containment before live evaluation

Use this gate when a model-facing, provider-serialized, tool, persisted, or
intermediate schema feeds a stricter validator, reconciler, state transition, or
canonical artifact.

## Required invariant

For the same trusted application state, every payload accepted by the actual
upstream contract must be accepted by the downstream contract or handled by a
total deterministic application-owned transformation. An upstream-accepted
payload that can fail only at a later validator is a counterexample and blocks
live evaluation.

## Offline gate

1. Capture the actual serialized or advertised upstream schema, not only its
   source declaration. Trace every transformation and downstream validator to
   the canonical state or artifact.
2. Separate model-authored fields from application-owned identity, provenance,
   status, policy, and derived fields. Remove application-owned choices from the
   upstream authoring contract when the application can derive them.
3. Build equivalence classes for discriminators, nullability, required and
   additional fields, ranges, patterns, paths, cross-item identity, duplicates,
   and ordering where they apply. Include sanitized recorded payloads and prior
   canonical transitions.
4. Run a differential matrix or property test. Every upstream-accepted case
   must complete downstream assembly. Invalid cases must fail at the upstream
   boundary. Application-owned mappings must be deterministic and total.
5. Observe at least one relevant counterexample fail before the correction,
   then run the same matrix, recorded replays, and project gate after it.

Do not use a production, live, or paid model run to discover a deterministic
contract gap that this gate can expose. Live evaluation is a later compatibility
or behavioral check. Run it only after the offline gate passes and only when its
cost and external effects are authorized.
