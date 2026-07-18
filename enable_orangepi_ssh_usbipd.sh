#!/usr/bin/env bash
set -euo pipefail

ROOT=/mnt/orangepi
DEV=/dev/sde1
USER_NAME=codex
PASSWORD=pisofi123

mkdir -p "$ROOT"
mountpoint -q "$ROOT" || mount -o rw "$DEV" "$ROOT"

if [[ ! -f "$ROOT/etc/passwd" || ! -f "$ROOT/etc/shadow" || ! -f "$ROOT/etc/group" ]]; then
  echo "Mounted filesystem is not a Linux root filesystem: $ROOT" >&2
  exit 1
fi

stamp="$(date +%Y%m%d%H%M%S)"
cp -a "$ROOT/etc/passwd" "$ROOT/etc/passwd.codexbak.$stamp"
cp -a "$ROOT/etc/shadow" "$ROOT/etc/shadow.codexbak.$stamp"
cp -a "$ROOT/etc/group" "$ROOT/etc/group.codexbak.$stamp"
[[ -f "$ROOT/etc/gshadow" ]] && cp -a "$ROOT/etc/gshadow" "$ROOT/etc/gshadow.codexbak.$stamp"
[[ -f "$ROOT/etc/ssh/sshd_config" ]] && cp -a "$ROOT/etc/ssh/sshd_config" "$ROOT/etc/ssh/sshd_config.codexbak.$stamp"

hash="$(openssl passwd -6 "$PASSWORD")"
today_days="$(( $(date +%s) / 86400 ))"

if grep -q "^${USER_NAME}:" "$ROOT/etc/passwd"; then
  uid="$(awk -F: -v u="$USER_NAME" '$1 == u { print $3; exit }' "$ROOT/etc/passwd")"
  gid="$(awk -F: -v u="$USER_NAME" '$1 == u { print $4; exit }' "$ROOT/etc/passwd")"
  awk -F: -v OFS=: -v u="$USER_NAME" -v h="$hash" -v d="$today_days" \
    '$1 == u { $2=h; $3=d; $4=0; $5=99999; $6=7 } { print }' \
    "$ROOT/etc/shadow" > /tmp/orangepi-shadow
  mv /tmp/orangepi-shadow "$ROOT/etc/shadow"
else
  uid="$(awk -F: '($3>=1000 && $3<60000){if($3>m)m=$3} END{print (m?m+1:1000)}' "$ROOT/etc/passwd")"
  gid="$uid"
  echo "${USER_NAME}:x:${gid}:" >> "$ROOT/etc/group"
  [[ -f "$ROOT/etc/gshadow" ]] && echo "${USER_NAME}:!::" >> "$ROOT/etc/gshadow"
  echo "${USER_NAME}:x:${uid}:${gid}:Codex SSH User:/home/${USER_NAME}:/bin/bash" >> "$ROOT/etc/passwd"
  echo "${USER_NAME}:${hash}:${today_days}:0:99999:7:::" >> "$ROOT/etc/shadow"
fi

mkdir -p "$ROOT/home/$USER_NAME"
chown "$uid:$gid" "$ROOT/home/$USER_NAME"
chmod 755 "$ROOT/home/$USER_NAME"

add_group_member() {
  local file="$1"
  local group="$2"
  [[ -f "$file" ]] || return 0
  grep -q "^${group}:" "$file" || return 0
  awk -F: -v OFS=: -v group="$group" -v user="$USER_NAME" '
    $1 == group {
      n = split($4, members, ",")
      found = 0
      for (i = 1; i <= n; i++) if (members[i] == user) found = 1
      if (!found) {
        if ($4 == "") $4 = user
        else $4 = $4 "," user
      }
    }
    { print }
  ' "$file" > "/tmp/orangepi-${group}-$(basename "$file")"
  mv "/tmp/orangepi-${group}-$(basename "$file")" "$file"
}

add_group_member "$ROOT/etc/group" sudo
add_group_member "$ROOT/etc/group" admin
add_group_member "$ROOT/etc/group" wheel
add_group_member "$ROOT/etc/gshadow" sudo
add_group_member "$ROOT/etc/gshadow" admin
add_group_member "$ROOT/etc/gshadow" wheel

mkdir -p "$ROOT/etc/ssh"
touch "$ROOT/etc/ssh/sshd_config"

set_sshd_option() {
  local key="$1"
  local value="$2"
  if grep -Eiq "^[#[:space:]]*${key}[[:space:]]+" "$ROOT/etc/ssh/sshd_config"; then
    sed -i -E "s|^[#[:space:]]*${key}[[:space:]]+.*|${key} ${value}|I" "$ROOT/etc/ssh/sshd_config"
  else
    printf '\n%s %s\n' "$key" "$value" >> "$ROOT/etc/ssh/sshd_config"
  fi
}

set_sshd_option PasswordAuthentication yes
set_sshd_option PermitRootLogin prohibit-password
set_sshd_option UsePAM yes

touch "$ROOT/ssh" 2>/dev/null || true
touch "$ROOT/boot/ssh" 2>/dev/null || true

mkdir -p "$ROOT/etc/systemd/system/multi-user.target.wants"
if [[ -f "$ROOT/lib/systemd/system/ssh.service" ]]; then
  ln -sf /lib/systemd/system/ssh.service "$ROOT/etc/systemd/system/multi-user.target.wants/ssh.service"
fi
if [[ -f "$ROOT/lib/systemd/system/sshd.service" ]]; then
  ln -sf /lib/systemd/system/sshd.service "$ROOT/etc/systemd/system/multi-user.target.wants/sshd.service"
fi

for level in 2 3 4 5; do
  dir="$ROOT/etc/rc${level}.d"
  if [[ -d "$dir" && -f "$ROOT/etc/init.d/ssh" ]]; then
    ln -sf ../init.d/ssh "$dir/S02ssh"
  fi
done

sync

echo "Created/updated SSH login:"
echo "  username: $USER_NAME"
echo "  password: $PASSWORD"
echo "  sudo group: $(grep '^sudo:' "$ROOT/etc/group" || true)"
echo "  sshd PasswordAuthentication: $(grep -Ei '^[[:space:]]*PasswordAuthentication[[:space:]]+' "$ROOT/etc/ssh/sshd_config" | tail -1)"
echo "  OS: $(grep '^PRETTY_NAME=' "$ROOT/etc/os-release" | cut -d= -f2- | tr -d '\"')"

umount "$ROOT"
