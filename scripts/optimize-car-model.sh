#!/usr/bin/env bash
# Optimize a Tripo-generated car GLB for the game: decimate the (huge) mesh and
# shrink textures, WITHOUT geometry compression (so car.js's GLTFLoader needs no
# Draco/Meshopt decoder). Usage: scripts/optimize-car-model.sh in.glb out.glb
# Tune TRI_RATIO for more/less detail (0.1 ≈ keep 10% of triangles).
set -euo pipefail
IN="${1:?usage: optimize-car-model.sh <in.glb> <out.glb>}"
OUT="${2:?usage: optimize-car-model.sh <in.glb> <out.glb>}"
TRI_RATIO="${TRI_RATIO:-0.1}"     # fraction of triangles to KEEP
TRI_ERROR="${TRI_ERROR:-0.001}"   # max simplification error (relative)
TEX="${TEX:-1024}"                # texture max edge (px)
GT="npx --yes @gltf-transform/cli@latest"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "1/4 weld (merge duplicate vertices)"
$GT weld "$IN" "$TMP/a.glb" >/dev/null
echo "2/4 simplify (keep ${TRI_RATIO} of triangles, error ${TRI_ERROR})"
$GT simplify "$TMP/a.glb" "$TMP/b.glb" --ratio "$TRI_RATIO" --error "$TRI_ERROR" >/dev/null
echo "3/4 resize textures to ${TEX}px"
$GT resize "$TMP/b.glb" "$TMP/c.glb" --width "$TEX" --height "$TEX" >/dev/null
echo "4/4 prune + dedup (drop unused data)"
$GT prune "$TMP/c.glb" "$TMP/d.glb" >/dev/null
$GT dedup "$TMP/d.glb" "$OUT" >/dev/null

echo "done -> $OUT"
ls -la "$IN" "$OUT" | awk '{print $5, $9}'
