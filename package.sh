#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────
# ManageLM OpenClaw Plugin — Build & package script
#
# Compiles TypeScript and creates a tarball for ClawHub distribution.
#
# Usage:  ./package.sh [--patch|--minor|--major] [--skip-build]
# Output: managelm-openclaw-<version>.tar.gz
# ──────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"
git config --global --add safe.directory "$ROOT_DIR" 2>/dev/null || true

# ── Flags ─────────────────────────────────────────────────────────
SKIP_BUILD=false
BUMP=""
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --patch|--minor|--major) BUMP="${arg#--}" ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ── Version bump (optional) ──────────────────────────────────────
if [ -n "$BUMP" ]; then
  echo "▸ Bumping $BUMP version..."
  npm version "$BUMP" --no-git-tag-version
  # Sync manifest version
  NEW_VER=$(node -p "require('./package.json').version")
  node -e "
    const fs = require('fs');
    const m = JSON.parse(fs.readFileSync('openclaw.plugin.json','utf8'));
    m.version = '$NEW_VER';
    fs.writeFileSync('openclaw.plugin.json', JSON.stringify(m, null, 2) + '\n');
  "
fi

VERSION=$(node -p "require('./package.json').version")
PLUGIN_NAME="managelm-openclaw"
OUTFILE="${PLUGIN_NAME}-${VERSION}.tar.gz"
STAGING_DIR=$(mktemp -d)

trap 'rm -rf "$STAGING_DIR"' EXIT

# ── Build ─────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  echo "▸ Installing dependencies..."
  npm install

  echo "▸ Compiling TypeScript..."
  npx tsc
else
  echo "▸ Skipping build (--skip-build)"
  if [ ! -d dist ]; then
    echo "ERROR: dist/ missing. Run without --skip-build first."
    exit 1
  fi
fi

# ── Assemble ──────────────────────────────────────────────────────
echo "▸ Assembling package ${PLUGIN_NAME} ${VERSION}..."

TARGET="$STAGING_DIR/${PLUGIN_NAME}"
mkdir -p "$TARGET"

cp -r dist "$TARGET/"
cp -r skills "$TARGET/"
cp openclaw.plugin.json "$TARGET/"
cp package.json "$TARGET/"
cp README.md "$TARGET/"
cp LICENSE "$TARGET/"
[ -f CHANGELOG.md ] && cp CHANGELOG.md "$TARGET/"
[ -f icon.png ] && cp icon.png "$TARGET/"

# Production dependencies
cd "$TARGET"
npm install --omit=dev --ignore-scripts 2>/dev/null || true
cd "$ROOT_DIR"

# ── Tarball ───────────────────────────────────────────────────────
echo "▸ Creating tarball..."
tar czf "$ROOT_DIR/$OUTFILE" -C "$STAGING_DIR" "$PLUGIN_NAME"

SIZE=$(du -h "$ROOT_DIR/$OUTFILE" | cut -f1)

# Restore ownership
[[ "$ROOT_DIR" == "/" ]] && { echo "FATAL: ROOT_DIR is /"; exit 1; }
chown -R claude:claude "$ROOT_DIR"

echo ""
echo "Done: $OUTFILE ($SIZE)"
