#!/bin/bash
# Idempotently provisions (or returns the existing allocation for) a
# per-device reverse-tunnel VPS user. Invoked only via the pfibridge
# forced-command wrapper, never directly over the network.
set -euo pipefail

SERIAL="$1"
PUBKEY="$2"
REGISTRY="/opt/pfitunnel/registry.tsv"
LOCKFILE="/opt/pfitunnel/registry.lock"
VPS_HOST="161.118.244.168"

exec 200>"$LOCKFILE"
flock 200

existing=$(awk -F'\t' -v s="$SERIAL" '$1==s {print}' "$REGISTRY" || true)
if [[ -n "$existing" ]]; then
  username=$(echo "$existing" | cut -f2)
  ssh_port=$(echo "$existing" | cut -f3)
  http_port=$(echo "$existing" | cut -f4)
  printf '{"serial":"%s","username":"%s","sshPort":%s,"httpPort":%s,"vpsHost":"%s","created":false}\n' \
    "$SERIAL" "$username" "$ssh_port" "$http_port" "$VPS_HOST"
  exit 0
fi

last_ssh_port=$(tail -n +2 "$REGISTRY" | awk -F'\t' '{print $3}' | sort -n | tail -1)
last_ssh_port="${last_ssh_port:-2221}"
SSH_PORT=$((last_ssh_port + 1))
HTTP_PORT=$((SSH_PORT + 5866))

TUNNEL_USER="pfi-$(printf '%s' "$SERIAL" | sha256sum | cut -c1-12)"

useradd -m -s /usr/sbin/nologin "$TUNNEL_USER"
mkdir -p "/home/$TUNNEL_USER/.ssh"
printf 'no-pty,no-X11-forwarding,no-agent-forwarding,no-user-rc,permitlisten="%s",permitlisten="%s" %s\n' \
  "$SSH_PORT" "$HTTP_PORT" "$PUBKEY" > "/home/$TUNNEL_USER/.ssh/authorized_keys"
chown -R "$TUNNEL_USER:$TUNNEL_USER" "/home/$TUNNEL_USER/.ssh"
chmod 700 "/home/$TUNNEL_USER/.ssh"
chmod 600 "/home/$TUNNEL_USER/.ssh/authorized_keys"

ufw allow "${SSH_PORT}/tcp" > /dev/null
ufw allow "${HTTP_PORT}/tcp" > /dev/null

printf '%s\t%s\t%s\t%s\t%s\n' "$SERIAL" "$TUNNEL_USER" "$SSH_PORT" "$HTTP_PORT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$REGISTRY"

printf '{"serial":"%s","username":"%s","sshPort":%s,"httpPort":%s,"vpsHost":"%s","created":true}\n' \
  "$SERIAL" "$TUNNEL_USER" "$SSH_PORT" "$HTTP_PORT" "$VPS_HOST"
