#!/usr/bin/env python3
"""The adapter replayed over every recorded public pull request breaks no invariant."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

PATH = Path(__file__).resolve().parent / "coderabbit_replay.py"
SPEC = importlib.util.spec_from_file_location("coderabbit_replay", PATH)
assert SPEC and SPEC.loader
REPLAY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPLAY)


class ReplayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.pulls = REPLAY.load()
        cls.violations, cls.checked = REPLAY.replay(cls.pulls)

    def test_the_corpus_is_broad_and_recent(self) -> None:
        self.assertGreaterEqual(len(self.pulls), 200)
        self.assertGreaterEqual(len({pull["repo"] for pull in self.pulls}), 7)
        self.assertGreater(sum(self.checked.values()), 1000)
        since = REPLAY.json.loads(REPLAY.CORPUS.read_text())["since"]
        spec = importlib.util.spec_from_file_location("record_coderabbit", PATH.parent / "record_coderabbit.py")
        assert spec and spec.loader
        recorder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(recorder)
        stale = [f"{pull['repo']}#{pull['number']}" for pull in self.pulls if not recorder.in_window(pull, since)]
        self.assertEqual(stale, [], f"pull requests with CodeRabbit activity before {since}")

    def test_every_violation_is_pinned_and_every_pin_still_occurs(self) -> None:
        found = {item["key"] for item in self.violations}
        pinned = set(REPLAY.pinned())
        self.assertEqual(sorted(found - pinned), [], "unpinned invariant violations")
        self.assertEqual(sorted(pinned - found), [], "pinned violations that no longer occur")


if __name__ == "__main__":
    unittest.main()
