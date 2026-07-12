#!/usr/bin/env bash
set -euo pipefail

NAME="${1:-excubitor}"
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

cd "$ROOT"
npm install
npm run build
npm --prefix frontend install
npm --prefix frontend run build
mkdir -p "$ROOT/logs"
NODE="$(node -p 'process.execPath')"
RUNNER="$ROOT/dist/service-runner.js"
SERVICE_NAME_ARG="--service-name=$NAME"
ROOT_XML="$(xml_escape "$ROOT")"
NODE_XML="$(xml_escape "$NODE")"
RUNNER_XML="$(xml_escape "$RUNNER")"
SERVICE_NAME_ARG_XML="$(xml_escape "$SERVICE_NAME_ARG")"
ROOT_SYSTEMD="$(systemd_escape_value "$ROOT")"
NODE_SYSTEMD="$(systemd_escape_value "$NODE")"
RUNNER_SYSTEMD="$(systemd_escape_value "$RUNNER")"

if [[ "$(uname -s)" == "Darwin" ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.ludiars.${NAME}.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ludiars.${NAME}</string>
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
