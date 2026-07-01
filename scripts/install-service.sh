#!/usr/bin/env bash
set -euo pipefail

NAME="${1:-excubitor}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT"
npm install
npm run build
npm --prefix frontend install
npm --prefix frontend run build
mkdir -p "$ROOT/logs"

if [[ "$(uname -s)" == "Darwin" ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.ludiars.${NAME}.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ludiars.${NAME}</string>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>npm</string><string>run</string><string>service</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EXCUBITOR_SERVICE_MODE</key><string>1</string>
    <key>EXCUBITOR_SAFE_MODE</key><string>0</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${ROOT}/logs/service.out.log</string>
  <key>StandardErrorPath</key><string>${ROOT}/logs/service.err.log</string>
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
WorkingDirectory=${ROOT}
Environment=EXCUBITOR_SERVICE_MODE=1
Environment=EXCUBITOR_SAFE_MODE=0
ExecStart=$(command -v npm) run service
Restart=always
RestartSec=5
StandardOutput=append:${ROOT}/logs/service.out.log
StandardError=append:${ROOT}/logs/service.err.log

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "${NAME}.service"
echo "Installed systemd user service: ${NAME}.service"
