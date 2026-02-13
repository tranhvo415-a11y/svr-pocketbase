#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[setup-bash-aliase] non-linux OS, skip."
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ALIAS_FILE="${SCRIPT_DIR}/.bash_aliase"
TARGET_DIR="${HOME}/.bash"
TARGET_ALIAS_FILE="${TARGET_DIR}/.bash_aliase"
TARGET_ENV_FILE="${TARGET_DIR}/runner-alias.env"
TARGET_BIN_DIR="${HOME}/.local/bin"
ENV_FILE="${1:-.env}"
if [[ "${ENV_FILE}" = /* ]]; then
  ENV_FILE_ABS="${ENV_FILE}"
else
  ENV_FILE_ABS="$(pwd)/${ENV_FILE#./}"
fi

if [[ ! -f "${SOURCE_ALIAS_FILE}" ]]; then
  echo "[setup-bash-aliase] source alias file not found: ${SOURCE_ALIAS_FILE}" >&2
  exit 1
fi

mkdir -p "${TARGET_DIR}"
mkdir -p "${TARGET_BIN_DIR}"
cp "${SOURCE_ALIAS_FILE}" "${TARGET_ALIAS_FILE}"
chmod 600 "${TARGET_ALIAS_FILE}"

{
  echo "export RUNNER_ALIAS_ENV_FILE=\"${ENV_FILE_ABS}\""
} > "${TARGET_ENV_FILE}"
chmod 600 "${TARGET_ENV_FILE}"

SOURCE_ALIAS_LINE='[ -f "$HOME/.bash/.bash_aliase" ] && source "$HOME/.bash/.bash_aliase"'
SOURCE_ENV_LINE='[ -f "$HOME/.bash/runner-alias.env" ] && source "$HOME/.bash/runner-alias.env"'
PATH_LINE='case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac'

ensure_line() {
  local file="$1"
  local line="$2"
  touch "${file}"
  if ! grep -Fqx "${line}" "${file}"; then
    echo "${line}" >> "${file}"
  fi
}

for shell_file in "${HOME}/.bashrc" "${HOME}/.bash_profile" "${HOME}/.profile"; do
  ensure_line "${shell_file}" "${PATH_LINE}"
  ensure_line "${shell_file}" "${SOURCE_ENV_LINE}"
  ensure_line "${shell_file}" "${SOURCE_ALIAS_LINE}"
done

create_wrapper() {
  local name="$1"
  local func="$2"
  local file="${TARGET_BIN_DIR}/${name}"

  cat > "${file}" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[ -f "\$HOME/.bash/runner-alias.env" ] && source "\$HOME/.bash/runner-alias.env"
if [ ! -f "\$HOME/.bash/.bash_aliase" ]; then
  echo "${name}: alias file not found: \$HOME/.bash/.bash_aliase" >&2
  exit 1
fi
source "\$HOME/.bash/.bash_aliase"
${func} "\$@"
EOF
  chmod 755 "${file}"
}

create_wrapper "r_help" "r_help"
create_wrapper "r_ssh" "r_ssh"
create_wrapper "r_cd" "r_cd"
create_wrapper "r_pwd" "r_pwd"
create_wrapper "r_ls" "r_ls"
create_wrapper "r_dc_ps" "r_dc_ps"
create_wrapper "r_dc_up" "r_dc_up"
create_wrapper "r_dc_down" "r_dc_down"
create_wrapper "r_dc_logs" "r_dc_logs"
create_wrapper "r-cd" "r_cd"
create_wrapper "r-ls" "r_ls"
create_wrapper "r-dc-ps" "r_dc_ps"
create_wrapper "r-dc-up" "r_dc_up"
create_wrapper "r-dc-down" "r_dc_down"
create_wrapper "r-dc-logs" "r_dc_logs"

echo "[setup-bash-aliase] installed: ${TARGET_ALIAS_FILE}"
echo "[setup-bash-aliase] env file: ${ENV_FILE_ABS}"
echo "[setup-bash-aliase] wrappers: ${TARGET_BIN_DIR}/r_*"
echo "[setup-bash-aliase] open a new shell or run:"
echo "  source \"${TARGET_ENV_FILE}\" && source \"${TARGET_ALIAS_FILE}\" && hash -r && r_help"
