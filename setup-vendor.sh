#!/usr/bin/env sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
vendor="$root/chrome-extension/vendor"

mkdir -p "$vendor"

download_file() {
  url="$1"
  output="$2"
  out="$vendor/$output"

  printf 'Downloading %s\n' "$url"
  curl -fL "$url" -o "$out"

  if [ ! -s "$out" ]; then
    printf 'Downloaded file is empty: %s\n' "$out" >&2
    exit 1
  fi

  size=$(wc -c < "$out" | tr -d ' ')
  printf 'Saved %s (%s bytes)\n' "$out" "$size"
}

download_file "https://www.meshy.ai/pt-BR/resource/decrypt/mesh_loader.js" "mesh_loader.js"
download_file "https://www.meshy.ai/pt-BR/resource/decrypt/mesh_loader.wasm" "mesh_loader.wasm"

printf 'Vendor files are ready.\n'
