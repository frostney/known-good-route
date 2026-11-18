#!/usr/bin/env python3
"""Every bundled helper runs under `python3 -I` and loads its own sibling modules."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_helper_bytecode import ROOT, entry_points, helper_env, install_copy


def bundled_module_names() -> list[str]:
    """Module names a helper could import from a bundled scripts directory."""
    return sorted({script.stem for script in ROOT.glob("*/scripts/*.py")})


def plant_decoys(directory: Path) -> None:
    """Modules that shadow the bundled ones and fail loudly if imported."""
    for name in bundled_module_names():
        (directory / f"{name}.py").write_text(
            f"raise SystemExit('decoy {name} imported from {directory}')\n",
            encoding="utf-8",
        )


class HelperIsolatedModeTests(unittest.TestCase):
    def test_every_entry_point_runs_isolated(self) -> None:
        names = entry_points()
        self.assertIn("delivery-wait/scripts/delivery_wait.py", names)
        for name in names:
            with self.subTest(script=name), tempfile.TemporaryDirectory() as temp:
                workdir = Path(temp)
                script = install_copy(workdir / "install") / name
                # Isolated mode must not trust the working directory or
                # PYTHONPATH, so a helper may not fall back to either.
                plant_decoys(workdir)
                env = {**helper_env(), "PYTHONPATH": str(workdir)}
                result = subprocess.run(
                    [sys.executable, "-I", str(script), "--help"],
                    cwd=workdir,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("usage:", result.stdout)


if __name__ == "__main__":
    unittest.main()
