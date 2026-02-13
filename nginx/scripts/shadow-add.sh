#!/bin/sh
set -eu

IP="${1:?missing ip}"
PORT="${2:-3000}"
DIR="/etc/nginx/shadow-servers"
FILE="${DIR}/${IP}.conf"
TMP="${FILE}.tmp"

mkdir -p "$DIR"
printf 'server %s:%s max_fails=2 fail_timeout=10s;\n' "$IP" "$PORT" > "$TMP"
mv -f "$TMP" "$FILE"

nginx -t
nginx -s reload
