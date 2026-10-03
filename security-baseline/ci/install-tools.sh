#!/usr/bin/env bash
set -euo pipefail
destination="${1:?Pass a private tool directory}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$destination"
python3.12 -m venv "$destination/venv"
"$destination/venv/bin/python" -m pip --isolated install --no-user --disable-pip-version-check --only-binary=:all: --require-hashes --index-url https://pypi.org/simple -r "$script_dir/tools-linux-py312.lock"
curl --fail --silent --show-error --location --max-time 120 --retry 2 https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz --output "$destination/gitleaks.tar.gz"
printf '%s  %s\n' '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' "$destination/gitleaks.tar.gz" | sha256sum --check --strict
tar --no-same-owner -xzf "$destination/gitleaks.tar.gz" -C "$destination" gitleaks
"$destination/gitleaks" version
"$destination/venv/bin/semgrep" --version
"$destination/venv/bin/pip-audit" --version
