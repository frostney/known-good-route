#!/usr/bin/env python3
"""Running a bundled helper leaves no bytecode cache in the installed skills."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
# Helpers that import sibling modules; each one wrote __pycache__ before the fix.
SIBLING_IMPORTERS = {
    "address-feedback/scripts/coderabbit_adapter.py",
    "address-feedback/scripts/review_wait.py",
    "address-feedback/scripts/stack_state.py",
    "delivery-wait/scripts/delivery_wait.py",
}


def skill_dirs() -> list[Path]:
    return sorted(path.parent for path in ROOT.glob("*/SKILL.md"))


def entry_points() -> list[str]:
    """Every bundled script a consuming project runs directly."""
    return sorted(
        script.relative_to(ROOT).as_posix()
        for skill in skill_dirs()
        for script in skill.glob("scripts/*.py")
        if 'if __name__ == "__main__":' in script.read_text(encoding="utf-8")
    )


def install_copy(destination: Path) -> Path:
    """Copy every skill that bundles scripts, laid out like an installed tree."""
    skills_root = destination / ".agents" / "skills"
    for skill in skill_dirs():
        if (skill / "scripts").is_dir():
            shutil.copytree(
                skill,
                skills_root / skill.name,
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
            )
    return skills_root


def helper_env() -> dict[str, str]:
    env = dict(os.environ)
    # These would hide the defect by suppressing or relocating the cache.
    env.pop("PYTHONDONTWRITEBYTECODE", None)
    env.pop("PYTHONPYCACHEPREFIX", None)
    return env


class HelperBytecodeTests(unittest.TestCase):
    def test_every_entry_point_leaves_no_pycache(self) -> None:
        names = entry_points()
        self.assertTrue(
            SIBLING_IMPORTERS <= set(names),
            f"expected entry points missing: {sorted(SIBLING_IMPORTERS - set(names))}",
        )
        for name in names:
            with self.subTest(script=name), tempfile.TemporaryDirectory() as temp:
                workdir = Path(temp)
                script = install_copy(workdir) / name
                result = subprocess.run(
                    [sys.executable, str(script), "--help"],
                    cwd=workdir,
                    env=helper_env(),
                    capture_output=True,
                    text=True,
                    timeout=60,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                caches = sorted(
                    path.relative_to(workdir).as_posix()
                    for path in workdir.rglob("__pycache__")
                )
                self.assertEqual(caches, [], f"{name} left bytecode caches")


if __name__ == "__main__":
    unittest.main()
