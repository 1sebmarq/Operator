#!/usr/bin/env bash
# Validation gate: generate a synthetic session and verify it loads in pyxdf.
# Exits non-zero on ANY failure (treat as a build failure).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== 1/3 ensure pyxdf =="
# Prefer an installed pyxdf; otherwise validate_xdf.py auto-uses test/vendor/pyxdf.py.
if python3 -c "import pyxdf" 2>/dev/null; then
  echo "using installed pyxdf"
else
  echo "using vendored pyxdf (test/vendor)"
fi

echo "== 2/3 generate synthetic .xdf via shared writer =="
