#!/bin/sh
set -eu

SRC="${1:-/dev/stdin}"
PORT="${2:-3000}"
DIR="/etc/nginx/shadow-servers"

mkdir -p "$DIR"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT INT TERM

if [ "$SRC" = "-" ]; then
  cat /dev/stdin > "${TMPDIR}/ips.raw"
else
  cat "$SRC" > "${TMPDIR}/ips.raw"
fi

grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' "${TMPDIR}/ips.raw" | sort -u > "${TMPDIR}/ips" || true

changed=0
while IFS= read -r ip; do
  [ -n "$ip" ] || continue
  file="${DIR}/${ip}.conf"
  content="server ${ip}:${PORT} max_fails=2 fail_timeout=10s;"
  if [ ! -f "$file" ] || ! grep -qxF "$content" "$file"; then
    printf '%s\n' "$content" > "${file}.tmp"
    mv -f "${file}.tmp" "$file"
    changed=1
  fi
done < "${TMPDIR}/ips"

for file in "${DIR}"/*.conf; do
  [ -e "$file" ] || continue
  ip="$(basename "$file" .conf)"
  if ! grep -qxF "$ip" "${TMPDIR}/ips"; then
    rm -f "$file"
    changed=1
  fi
done

if [ "$changed" -eq 1 ]; then
  nginx -t
  nginx -s reload
fi
