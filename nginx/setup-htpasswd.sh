#!/bin/sh
set -eu

if command -v apk >/dev/null 2>&1; then
  apk add --no-cache apache2-utils >/dev/null
fi

auth_file="${NGINX_AUTH_FILE:-/etc/nginx/auth/.htpasswd}"
auth_dir="$(dirname "$auth_file")"

mkdir -p "$auth_dir"
rm -f "$auth_file"
: > "$auth_file"

has_user=0
for user_var in $(env | sed -n 's/^\(NGINX_AUTH_USER_[A-Za-z0-9_]*\)=.*/\1/p' | sort); do
  suffix="${user_var#NGINX_AUTH_USER_}"
  pass_var="NGINX_AUTH_PASS_${suffix}"
  user_value="$(printenv "$user_var" | tr -d '\r')"
  pass_value="$(printenv "$pass_var" | tr -d '\r')"

  if [ -z "$user_value" ] || [ -z "$pass_value" ]; then
    continue
  fi

  if [ "$has_user" -eq 0 ]; then
    printf '%s\n' "$pass_value" | htpasswd -iBc "$auth_file" "$user_value" >/dev/null
    has_user=1
  else
    printf '%s\n' "$pass_value" | htpasswd -iB "$auth_file" "$user_value" >/dev/null
  fi
done

if [ "$has_user" -eq 0 ]; then
  echo "warning: no NGINX_AUTH_USER_xx/NGINX_AUTH_PASS_xx pair found, protected file routes will reject all requests" >&2
fi

if chown nginx:nginx "$auth_file" 2>/dev/null; then
  chmod 640 "$auth_file"
else
  chmod 644 "$auth_file"
fi
