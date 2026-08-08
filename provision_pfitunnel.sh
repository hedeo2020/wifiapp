#!/usr/bin/env bash
# SUPERSEDED: devices now provision their own tunnel automatically via
# POST /api/v1/devices/:serial/tunnel once licensed (see
# license-platform/vps-scripts/README.md). Kept here only as a manual
# fallback for troubleshooting -- new devices don't need to run this.
#
# Provisions a per-device reverse SSH tunnel (SSH + admin panel access) from
# a new Orange Pi kiosk to the VPS, following the same pattern used for the
# first device (serial 02c000816800547a -> ports 2222/8088).
#
# Each device gets its own dedicated, restricted VPS user + keypair, scoped
# via `permitlisten` to only its own two forwarded ports -- a compromised
# device can never occupy or interfere with another device's tunnel.
#
# Usage:
#   ./provision_pfitunnel.sh <pi-host> <pi-ssh-key> <device-serial> [pi-ssh-user]
#
# Example:
#   ./provision_pfitunnel.sh 192.168.1.50 ~/.ssh/some_pi_key 04a1b2c3d4e5f607
#
# Requires: SSH access to the VPS (161.118.244.168) as a sudo-capable user,
# and SSH access to the target Pi as a sudo-capable user (default: codex).

set -euo pipefail

PI_HOST="${1:?Usage: $0 <pi-host> <pi-ssh-key> <device-serial> [pi-ssh-user]}"
PI_KEY="${2:?missing pi ssh key path}"
DEVICE_SERIAL="${3:?missing device serial}"
PI_USER="${4:-codex}"

VPS_HOST="161.118.244.168"
VPS_USER="ubuntu"
VPS_KEY="${VPS_KEY:-$HOME/.ssh/orangepi_codex_ed25519}"
REGISTRY="/opt/pfitunnel/registry.tsv"

echo "==> Checking registry for existing allocation for $DEVICE_SERIAL"
existing=$(ssh -i "$VPS_KEY" "$VPS_USER@$VPS_HOST" "grep -P '^${DEVICE_SERIAL}\t' $REGISTRY || true")
if [[ -n "$existing" ]]; then
  echo "Device already provisioned:"
  echo "$existing"
  exit 1
fi

echo "==> Picking next free port pair"
last_ssh_port=$(ssh -i "$VPS_KEY" "$VPS_USER@$VPS_HOST" "tail -n +2 $REGISTRY | awk -F'\t' '{print \$3}' | sort -n | tail -1")
last_ssh_port="${last_ssh_port:-2222}"
SSH_PORT=$((last_ssh_port + 1))
HTTP_PORT=$((SSH_PORT + 5866)) # keeps the same 2222->8088 offset as device 1

TUNNEL_USER="pfitunnel-${DEVICE_SERIAL}"
echo "==> Allocated: user=$TUNNEL_USER ssh_port=$SSH_PORT http_port=$HTTP_PORT"

echo "==> Generating dedicated keypair on the Pi"
ssh -i "$PI_KEY" "$PI_USER@$PI_HOST" "
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  ssh-keygen -t ed25519 -f ~/.ssh/pfitunnel_ed25519 -N '' -C 'pfitunnel-${DEVICE_SERIAL}' -q
  chmod 600 ~/.ssh/pfitunnel_ed25519
"
PUBKEY=$(ssh -i "$PI_KEY" "$PI_USER@$PI_HOST" "cat ~/.ssh/pfitunnel_ed25519.pub")

echo "==> Creating restricted VPS user and installing the locked-down key"
ssh -i "$VPS_KEY" "$VPS_USER@$VPS_HOST" "
  sudo useradd -m -s /usr/sbin/nologin '$TUNNEL_USER' 2>/dev/null || true
  sudo mkdir -p /home/$TUNNEL_USER/.ssh
  echo 'no-pty,no-X11-forwarding,no-agent-forwarding,no-user-rc,permitlisten=\"$SSH_PORT\",permitlisten=\"$HTTP_PORT\" $PUBKEY' | sudo tee /home/$TUNNEL_USER/.ssh/authorized_keys > /dev/null
  sudo chown -R '$TUNNEL_USER:$TUNNEL_USER' /home/$TUNNEL_USER/.ssh
  sudo chmod 700 /home/$TUNNEL_USER/.ssh
  sudo chmod 600 /home/$TUNNEL_USER/.ssh/authorized_keys
  sudo ufw allow ${SSH_PORT}/tcp
  sudo ufw allow ${HTTP_PORT}/tcp
"

echo "==> Recording allocation in the registry"
ssh -i "$VPS_KEY" "$VPS_USER@$VPS_HOST" "printf '%s\t%s\t%s\t%s\t%s\n' '$DEVICE_SERIAL' '$TUNNEL_USER' '$SSH_PORT' '$HTTP_PORT' \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\" | sudo tee -a $REGISTRY > /dev/null"

echo "==> Installing the persistent tunnel service on the Pi"
ssh -i "$PI_KEY" "$PI_USER@$PI_HOST" "ssh-keyscan -p 22 $VPS_HOST >> ~/.ssh/known_hosts 2>/dev/null || true"
ssh -i "$PI_KEY" "$PI_USER@$PI_HOST" "cat <<EOF | sudo tee /etc/systemd/system/pfitunnel.service > /dev/null
[Unit]
Description=Reverse tunnel to VPS (SSH + admin panel remote access)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$PI_USER
ExecStart=/usr/bin/ssh -N \\
  -o ServerAliveInterval=15 \\
  -o ServerAliveCountMax=3 \\
  -o ExitOnForwardFailure=yes \\
  -R 0.0.0.0:${SSH_PORT}:localhost:22 \\
  -R 0.0.0.0:${HTTP_PORT}:localhost:88 \\
  -i /home/$PI_USER/.ssh/pfitunnel_ed25519 \\
  ${TUNNEL_USER}@${VPS_HOST}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable pfitunnel.service
sudo systemctl restart pfitunnel.service
"

echo "==> Reporting the tunnel address to the license API (device must already have an active license)"
ssh -i "$PI_KEY" "$PI_USER@$PI_HOST" "
  cat <<'PHP' | sudo tee /tmp/report_tunnel_ip.php > /dev/null
<?php
\$data = parse_ini_file('/etc/environment');
\$pdo = new PDO(\"mysql:host={\$data['KCFGDBH']};dbname={\$data['KCFGDBN']};charset=utf8\", \$data['KCFGDBU'], \$data['KCFGDBP']);
\$token = trim(\$pdo->query(\"SELECT setting_value FROM settings WHERE setting_key = 'access_token'\")->fetchColumn(), \"\\\" \t\n\r\");
if (!\$token) { echo \"NO_ACCESS_TOKEN_FOUND\n\"; exit(1); }
require '/var/www/html/3dbpoint/3dp-local/bootstrap/app.php';
\$serial = (new App\Helpers\Rpi())->serial();
\$ch = curl_init(\"https://api.3dbpoint.com/api/v1/devices/{\$serial}/public-ip\");
curl_setopt_array(\$ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode(['publicIp' => '${VPS_HOST}', 'port' => '${HTTP_PORT}', 'protocol' => 'http']),
    CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . \$token],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 15,
]);
echo curl_exec(\$ch) . \"\n\";
curl_close(\$ch);
PHP
  sudo php /tmp/report_tunnel_ip.php
  sudo rm -f /tmp/report_tunnel_ip.php
"

echo ""
echo "==> Done."
echo "    SSH:   ssh -p $SSH_PORT $PI_USER@$VPS_HOST"
echo "    Admin: http://$VPS_HOST:$HTTP_PORT/"
echo "    (If the device has no API access_token yet, the public-ip report above"
echo "     will say NO_ACCESS_TOKEN_FOUND -- issue one via the license admin panel"
echo "     and re-run just that step, or set it manually in the settings table.)"
