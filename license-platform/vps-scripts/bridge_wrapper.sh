#!/bin/bash
# Forced-command entry point for the pfibridge SSH key. sshd sets
# SSH_ORIGINAL_COMMAND to whatever the client asked to run; we parse it
# ourselves via safe parameter expansion (no shell re-interpretation) and
# strictly validate both fields before ever touching a privileged command.
set -euo pipefail

cmd="${SSH_ORIGINAL_COMMAND:-}"
serial="${cmd%% *}"
pubkey="${cmd#* }"

if [[ ! "$serial" =~ ^[a-fA-F0-9]{8,32}$ ]]; then
  echo "rejected: invalid serial" >&2
  exit 1
fi

if [[ ! "$pubkey" =~ ^ssh-(ed25519|rsa|ecdsa-[a-z0-9-]+)\ [A-Za-z0-9+/=]+(\ .*)?$ ]]; then
  echo "rejected: invalid public key" >&2
  exit 1
fi

exec sudo /opt/pfitunnel/register_device.sh "$serial" "$pubkey"
