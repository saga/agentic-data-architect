#!/usr/bin/env python3
"""Validate the Python runtime used by the project's uv environment."""

from __future__ import annotations

from importlib import import_module
from importlib.metadata import PackageNotFoundError, version
import shutil
import subprocess
import sys

REQUIRED_PACKAGES = ("sqlglot", "graphify", "mcp")
REQUIRED_COMMANDS = ("graphify-mcp",)


def main() -> int:
    missing = []

    for module in REQUIRED_PACKAGES:
        try:
            import_module(module)
        except Exception as exc:  # pragma: no cover - error reporting path
            missing.append(f"{module}: {exc}")

    for command in REQUIRED_COMMANDS:
        if shutil.which(command) is None:
            missing.append(f"{command}: executable not found")

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

    result = subprocess.run(
        ["graphify-mcp", "--help"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0:
        print("graphify-mcp --help failed.", file=sys.stderr)
        return result.returncode or 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
