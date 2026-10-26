#!/usr/bin/env bash
# Build a static musl landlock-run helper and record its hash in manifest.json.
#
# Usage (Linux or WSL):
#   ./build.sh                          # linux-x64
#   ./build.sh aarch64-unknown-linux-musl
#
# Requires rustup, a musl target, and the usual build toolchain. The output
# binary is written next to this script as landlock-run-<platform>.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v rustup >/dev/null 2>&1; then
  # Non-login shells do not source the rustup environment.
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

TARGET="${1:-x86_64-unknown-linux-musl}"
case "$TARGET" in
  x86_64-unknown-linux-musl) PLATFORM="linux-x64" ;;
  aarch64-unknown-linux-musl) PLATFORM="linux-arm64" ;;
  *)
    echo "unsupported target: $TARGET" >&2
    exit 2
    ;;
esac

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/pluton-cargo-target}"
rustup target add "$TARGET" >/dev/null

LOCKED=""
if [ -f Cargo.lock ]; then
  LOCKED="--locked"
fi

# shellcheck disable=SC2086
cargo build --release $LOCKED --target "$TARGET" --manifest-path Cargo.toml

BIN="$CARGO_TARGET_DIR/$TARGET/release/landlock-run"
OUT="landlock-run-$PLATFORM"
cp "$BIN" "$OUT"
chmod 0755 "$OUT"

SIZE="$(stat -c %s "$OUT")"
SHA="$(sha256sum "$OUT" | cut -d' ' -f1)"

python3 - "$PLATFORM" "$OUT" "$SHA" "$SIZE" <<'PY'
import json
import sys

platform, path, sha, size = sys.argv[1:5]
with open("manifest.json", "r", encoding="utf-8") as fh:
    manifest = json.load(fh)
manifest["targets"][platform] = {
    "file": path.rsplit("/", 1)[-1],
    "sha256": sha,
    "size": int(size),
}
with open("manifest.json", "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, indent=2)
    fh.write("\n")
PY

echo "built $OUT"
echo "  sha256 $SHA"
echo "  size   $SIZE"
