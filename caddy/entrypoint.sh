#!/bin/sh
set -eu

export CADDY_UPSTREAM_HOST="${CADDY_UPSTREAM_HOST:-127.0.0.1}"
export CADDY_UPSTREAM_PORT="${CADDY_UPSTREAM_PORT:-8080}"
export CADDY_RUNTIME_DIR="${CADDY_RUNTIME_DIR:-/opt/caddy/runtime}"

if mkdir -p "$CADDY_RUNTIME_DIR" 2>/dev/null; then
  runtime_env_file="$CADDY_RUNTIME_DIR/runtime.env"
  {
    printf 'CADDY_UPSTREAM_HOST=%s\n' "$CADDY_UPSTREAM_HOST"
    printf 'CADDY_UPSTREAM_PORT=%s\n' "$CADDY_UPSTREAM_PORT"
  } > "$runtime_env_file" 2>/dev/null || true

  adapted_file="$CADDY_RUNTIME_DIR/Caddyfile.adapted.json"
  adapted_err_file="$CADDY_RUNTIME_DIR/Caddyfile.adapted.stderr"
  if ! caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile > "$adapted_file" 2> "$adapted_err_file"; then
    echo "warning: cannot export adapted Caddy config to $adapted_file" >&2
  fi
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
