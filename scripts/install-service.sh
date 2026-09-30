#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   scripts/install-service.sh [name]
#       Linux: systemd user service. macOS: per-user LaunchAgent (starts at login).
#   sudo scripts/install-service.sh --boot [--user <account>] [name]
#       macOS only: LaunchDaemon that starts at boot without a login, running as <account>
#       (default: the account that invoked sudo). Replaces that account's LaunchAgent.

BOOT=0
TARGET_USER=""
NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --boot) BOOT=1; shift ;;
    --user) TARGET_USER="${2:-}"; shift 2 ;;
    --user=*) TARGET_USER="${1#--user=}"; shift ;;
    -*) echo "Unknown option '$1'" >&2; exit 2 ;;
    *) NAME="$1"; shift ;;
  esac
done
NAME="${NAME:-excubitor}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! "$NAME" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "Invalid service name '$NAME' (allowed: A-Z a-z 0-9 _ . -)" >&2
  exit 2
fi

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

systemd_escape_value() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

if [[ "$BOOT" == "1" ]]; then
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "--boot is supported on macOS only (Linux: enable lingering for the systemd user service)" >&2
    exit 2
  fi
  if [[ "$(id -u)" != "0" ]]; then
    echo "--boot installs /Library/LaunchDaemons and must run with sudo" >&2
    exit 2
  fi
  TARGET_USER="${TARGET_USER:-${SUDO_USER:-}}"
  if [[ -z "$TARGET_USER" || "$TARGET_USER" == "root" ]]; then
    echo "Specify the account that owns the supervisor with --user <account> (root is not supported)" >&2
    exit 2
  fi
  if ! id -u "$TARGET_USER" >/dev/null 2>&1; then
    echo "Unknown account '$TARGET_USER'" >&2
    exit 2
  fi
fi

# Build and resolve Node as the account that will own the supervisor, through its login
# shell so the same PATH (Homebrew, nvm, ...) as an interactive terminal is used.
as_owner() {
  if [[ "$BOOT" == "1" ]]; then
    sudo -H -u "$TARGET_USER" -i "$@"
  else
    "$@"
  fi
}
as_owner_in_root() {
  local command
  command="cd $(printf '%q' "$ROOT") && $*"
  if [[ "$BOOT" == "1" ]]; then
    sudo -H -u "$TARGET_USER" -i bash -c "$command"
  else
    bash -c "$command"
  fi
}

as_owner_in_root "npm install"
as_owner_in_root "npm run build"
as_owner_in_root "npm --prefix frontend install"
as_owner_in_root "npm --prefix frontend run build"
as_owner_in_root "mkdir -p logs"
NODE="$(as_owner node -p 'process.execPath')"
RUNNER="$ROOT/dist/service-runner.js"
SERVICE_NAME_ARG="--service-name=$NAME"
ROOT_XML="$(xml_escape "$ROOT")"
NODE_XML="$(xml_escape "$NODE")"
RUNNER_XML="$(xml_escape "$RUNNER")"
SERVICE_NAME_ARG_XML="$(xml_escape "$SERVICE_NAME_ARG")"
ROOT_SYSTEMD="$(systemd_escape_value "$ROOT")"
NODE_SYSTEMD="$(systemd_escape_value "$NODE")"
RUNNER_SYSTEMD="$(systemd_escape_value "$RUNNER")"
LABEL="com.ludiars.${NAME}"

if [[ "$(uname -s)" == "Darwin" && "$BOOT" == "1" ]]; then
  # A daemon gets no login-shell environment; carry over what the owner's shell provides.
  OWNER_HOME="$(as_owner printenv HOME)"
  OWNER_PATH="$(as_owner printenv PATH)"
  OWNER_SHELL="$(as_owner printenv SHELL || true)"
  OWNER_LANG="$(as_owner printenv LANG || true)"
  OWNER_GROUP="$(id -gn "$TARGET_USER")"
  PLIST="/Library/LaunchDaemons/${LABEL}.plist"
  TMP_PLIST="$(mktemp)"
  cat > "$TMP_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>UserName</key><string>$(xml_escape "$TARGET_USER")</string>
  <key>GroupName</key><string>$(xml_escape "$OWNER_GROUP")</string>
  <key>WorkingDirectory</key><string>${ROOT_XML}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_XML}</string>
    <string>${RUNNER_XML}</string>
    <string>${SERVICE_NAME_ARG_XML}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EXCUBITOR_SERVICE_MODE</key><string>1</string>
    <key>EXCUBITOR_SAFE_MODE</key><string>0</string>
    <key>EXCUBITOR_SERVICE_NAME</key><string>${NAME}</string>
    <key>HOME</key><string>$(xml_escape "$OWNER_HOME")</string>
    <key>USER</key><string>$(xml_escape "$TARGET_USER")</string>
    <key>LOGNAME</key><string>$(xml_escape "$TARGET_USER")</string>
    <key>PATH</key><string>$(xml_escape "$OWNER_PATH")</string>
    <key>SHELL</key><string>$(xml_escape "${OWNER_SHELL:-/bin/zsh}")</string>
    <key>LANG</key><string>$(xml_escape "${OWNER_LANG:-en_US.UTF-8}")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Restart is SIGTERM to the supervisor pid; kickstart in the system domain needs root. -->
  <key>KeepAlive</key><true/>
  <!-- Preserve backend/services if launchd restarts only the supervisor job. -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${ROOT_XML}/logs/service.out.log</string>
  <key>StandardErrorPath</key><string>${ROOT_XML}/logs/service.err.log</string>
</dict>
</plist>
EOF
  plutil -lint "$TMP_PLIST" >/dev/null
  # Only one supervisor may own the local-control endpoint: retire the login-time agent.
  OWNER_UID="$(id -u "$TARGET_USER")"
  AGENT_PLIST="$OWNER_HOME/Library/LaunchAgents/${LABEL}.plist"
  launchctl bootout "gui/${OWNER_UID}/${LABEL}" >/dev/null 2>&1 || true
  if [[ -f "$AGENT_PLIST" ]]; then
    mv "$AGENT_PLIST" "${AGENT_PLIST}.disabled"
    echo "Moved the LaunchAgent aside: ${AGENT_PLIST}.disabled"
  fi
  launchctl bootout "system/${LABEL}" >/dev/null 2>&1 || true
  install -m 644 -o root -g wheel "$TMP_PLIST" "$PLIST"
  rm -f "$TMP_PLIST"
  launchctl bootstrap system "$PLIST"
  echo "Installed launchd daemon (starts at boot as ${TARGET_USER}): $PLIST"
  echo "Uninstall: sudo launchctl bootout system/${LABEL} && sudo rm $PLIST"
  exit 0
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  if [[ -f "/Library/LaunchDaemons/${LABEL}.plist" ]]; then
    echo "A boot-time LaunchDaemon is installed (/Library/LaunchDaemons/${LABEL}.plist)." >&2
    echo "Reinstall it with 'sudo $0 --boot $NAME', or remove it before installing a LaunchAgent." >&2
    exit 2
  fi
  PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>WorkingDirectory</key><string>${ROOT_XML}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_XML}</string>
    <string>${RUNNER_XML}</string>
    <string>${SERVICE_NAME_ARG_XML}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EXCUBITOR_SERVICE_MODE</key><string>1</string>
    <key>EXCUBITOR_SAFE_MODE</key><string>0</string>
    <key>EXCUBITOR_SERVICE_NAME</key><string>${NAME}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Preserve backend/services if launchd restarts only the supervisor job. -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${ROOT_XML}/logs/service.out.log</string>
  <key>StandardErrorPath</key><string>${ROOT_XML}/logs/service.err.log</string>
</dict>
</plist>
EOF
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  launchctl load "$PLIST"
  echo "Installed launchd service: $PLIST"
  exit 0
fi

UNIT="$HOME/.config/systemd/user/${NAME}.service"
mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<EOF
[Unit]
Description=Excubitor service monitor
After=network.target

[Service]
Type=simple
WorkingDirectory="${ROOT_SYSTEMD}"
Environment=EXCUBITOR_SERVICE_MODE=1
Environment=EXCUBITOR_SAFE_MODE=0
ExecStart="${NODE_SYSTEMD}" "${RUNNER_SYSTEMD}" --service-name=${NAME}
Restart=always
RestartSec=5
# The supervisor is a control plane. Preserve its backend and managed service
# processes when systemd restarts only the supervisor main process after a crash.
KillMode=process
StandardOutput="append:${ROOT_SYSTEMD}/logs/service.out.log"
StandardError="append:${ROOT_SYSTEMD}/logs/service.err.log"

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "${NAME}.service"
echo "Installed systemd user service: ${NAME}.service"
