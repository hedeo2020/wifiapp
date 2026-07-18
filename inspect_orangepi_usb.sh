#!/usr/bin/env bash
set -euo pipefail

mkdir -p /mnt/orangepi
mountpoint -q /mnt/orangepi || mount -o rw /dev/sde1 /mnt/orangepi

echo "OS"
cat /mnt/orangepi/etc/os-release 2>/dev/null || true

echo "USERS"
cut -d: -f1,3,4,6,7 /mnt/orangepi/etc/passwd | tail -40

echo "GROUPS"
grep -E '^(sudo|admin|wheel|root):' /mnt/orangepi/etc/group || true

echo "SSH"
find /mnt/orangepi/etc -maxdepth 3 \( -path '*/ssh*' -o -name 'sshd_config*' \) -print | head -80
