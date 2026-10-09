#!/usr/bin/env python3
"""Validate the Python runtime dependencies required by the current project."""

from __future__ import annotations

from importlib import import_module
from importlib.metadata import PackageNotFoundError, version
import sys


# Keep this list aligned with pyproject.toml. Graphify was removed from the
# architecture and is no longer a runtime dependency; the SQLGlot bridge is
# the only Python runtime component required by the current implementation.
REQUIRED_PACKAGES = ("sqlglot",)


def main() -> int:
    missing = []

    for module in REQUIRED_PACKAGES:
        try:
            import_module(module)
        except Exception as exc:  # pragma: no cover - error reporting path
            missing.append(f"{module}: {exc}")

    if missing:
        print("Python environment is missing required dependencies:", file=sys.stderr)
        for item in missing:
            print(f"  - {item}", file=sys.stderr)
        print("Run `uv sync` from the repository root.", file=sys.stderr)
        return 1

    versions = []
    for package in REQUIRED_PACKAGES:
        try:
            versions.append(f"{package}=={version(package)}")
        except PackageNotFoundError:
            versions.append(f"{package}==unknown")

    print(f"Python runtime OK: {', '.join(versions)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
