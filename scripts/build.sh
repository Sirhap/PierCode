#!/usr/bin/env bash
# Cross-platform local release builder (no CI required).
#
# Produces, under dist/, one archive per OS/arch containing the `piercode`
# binary, a versioned extension zip, and checksums.txt — mirroring what the
# GitHub Actions / GoReleaser pipeline emits.
#
# Usage:
#   scripts/build.sh                 # version derived from `git describe`
#   VERSION=v1.2.3 scripts/build.sh  # explicit version
#   scripts/build.sh --skip-tests    # faster, skips go test
#   scripts/build.sh --skip-extension
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

SKIP_TESTS=0
SKIP_EXTENSION=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --skip-extension) SKIP_EXTENSION=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

VERSION="${VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
LDFLAGS="-s -w -X github.com/sirhap/piercode/internal/version.Version=${VERSION}"
DIST="$repo_root/dist"

# OS/arch matrix — keep in sync with .goreleaser.yml.
PLATFORMS=(
  "linux/amd64" "linux/arm64"
  "darwin/amd64" "darwin/arm64"
  "windows/amd64" "windows/arm64"
)

echo "==> Building PierCode ${VERSION}"
rm -rf "$DIST"
mkdir -p "$DIST"

if [[ "$SKIP_TESTS" -eq 0 ]]; then
  echo "==> go test ./..."
  go test ./...
fi

build_one() {
  local goos="$1" goarch="$2"
  local ext="" ; [[ "$goos" == "windows" ]] && ext=".exe"
  local stage; stage="$(mktemp -d)"

  echo "    - ${goos}/${goarch}"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "$LDFLAGS" -o "$stage/piercode${ext}" ./cmd/server
  cp README.md "$stage/" 2>/dev/null || true

  local name="piercode_${goos}_${goarch}"
  if [[ "$goos" == "windows" ]]; then
    ( cd "$stage" && zip -q -r - . ) > "$DIST/${name}.zip"
  else
    tar -czf "$DIST/${name}.tar.gz" -C "$stage" .
  fi
  rm -rf "$stage"
}

echo "==> Cross-compiling binaries"
for p in "${PLATFORMS[@]}"; do
  build_one "${p%/*}" "${p#*/}"
done

if [[ "$SKIP_EXTENSION" -eq 0 ]]; then
  echo "==> Building extension"
  ( cd extension && npm install --silent && npm run build )
  ( cd extension/dist && zip -q -r - . ) > "$DIST/piercode-extension_${VERSION}.zip"
fi

echo "==> Generating checksums"
( cd "$DIST" && shasum -a 256 ./* > checksums.txt 2>/dev/null \
    || sha256sum ./* > checksums.txt )

echo ""
echo "==> Done. Artifacts in dist/:"
ls -1 "$DIST"
