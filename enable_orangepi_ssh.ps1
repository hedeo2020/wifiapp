$ErrorActionPreference = "Stop"

$LogPath = "C:\Users\PC\Documents\pisowifi\enable_orangepi_ssh.log"
$DiskPath = "\\.\PHYSICALDRIVE2"
$Distro = "Ubuntu-22.04"

function Log {
    param([string]$Message)
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -LiteralPath $LogPath -Value $line
}

Set-Content -LiteralPath $LogPath -Value "Starting Orange Pi SSH enablement"

try {
    Log "Taking Windows disk 2 offline for WSL attach"
    Set-Disk -Number 2 -IsOffline $true

    Log "Detaching any previous WSL mount for $DiskPath"
    & wsl.exe --unmount $DiskPath 2>&1 | ForEach-Object { Log $_ }

    Log "Mounting $DiskPath as a bare disk for WSL"
    & wsl.exe --mount $DiskPath --bare 2>&1 | ForEach-Object { Log $_ }
    if ($LASTEXITCODE -ne 0) {
        throw "wsl --mount failed with exit code $LASTEXITCODE"
    }

    $bash = @'
set -euo pipefail
LOG="/mnt/c/Users/PC/Documents/pisowifi/enable_orangepi_ssh.log"
echo "$(date '+%F %T') Inside WSL as $(id)" >> "$LOG"
mkdir -p /mnt/orangepi

ROOTDEV="$(lsblk -b -lnpo NAME,FSTYPE,SIZE,MOUNTPOINTS | awk '$2 ~ /^ext/ && $3 > 10000000000 && $3 < 70000000000 && $4 == "" {print $1; exit}')"
if [ -z "$ROOTDEV" ]; then
  echo "$(date '+%F %T') No ext root device found after mount" >> "$LOG"
  lsblk -f >> "$LOG"
  exit 20
fi

echo "$(date '+%F %T') Mounting candidate root device $ROOTDEV" >> "$LOG"
mountpoint -q /mnt/orangepi || mount -o rw "$ROOTDEV" /mnt/orangepi

if [ ! -f /mnt/orangepi/etc/passwd ] || [ ! -f /mnt/orangepi/etc/shadow ]; then
  echo "$(date '+%F %T') Mounted filesystem does not look like a Linux rootfs" >> "$LOG"
  find /mnt/orangepi -maxdepth 2 -type f | head -80 >> "$LOG"
  exit 21
fi

cp -a /mnt/orangepi/etc/passwd "/mnt/orangepi/etc/passwd.codexbak.$(date +%Y%m%d%H%M%S)"
cp -a /mnt/orangepi/etc/shadow "/mnt/orangepi/etc/shadow.codexbak.$(date +%Y%m%d%H%M%S)"
cp -a /mnt/orangepi/etc/group "/mnt/orangepi/etc/group.codexbak.$(date +%Y%m%d%H%M%S)"

HASH="$(openssl passwd -6 'pisofi123')"

if grep -q '^codex:' /mnt/orangepi/etc/passwd; then
  echo "$(date '+%F %T') Updating existing codex user password" >> "$LOG"
  awk -F: -v OFS=: -v h="$HASH" 'BEGIN{found=0} /^codex:/{found=1} {print}' /mnt/orangepi/etc/passwd > /tmp/passwd.new
  mv /tmp/passwd.new /mnt/orangepi/etc/passwd
  awk -F: -v OFS=: -v h="$HASH" '/^codex:/{ $2=h; $3=19000; $4=0; $5=99999; $6=7 } {print}' /mnt/orangepi/etc/shadow > /tmp/shadow.new
  mv /tmp/shadow.new /mnt/orangepi/etc/shadow
else
  NEXTUID="$(awk -F: '($3>=1000 && $3<60000){if($3>m)m=$3} END{print (m?m+1:1000)}' /mnt/orangepi/etc/passwd)"
  if grep -q '^codex:' /mnt/orangepi/etc/group; then
    GID="$(awk -F: '/^codex:/{print $3; exit}' /mnt/orangepi/etc/group)"
  else
    GID="$NEXTUID"
    echo "codex:x:$GID:" >> /mnt/orangepi/etc/group
  fi
  echo "codex:x:$NEXTUID:$GID:Codex SSH User:/home/codex:/bin/bash" >> /mnt/orangepi/etc/passwd
  echo "codex:$HASH:19000:0:99999:7:::" >> /mnt/orangepi/etc/shadow
  mkdir -p /mnt/orangepi/home/codex
  chown "$NEXTUID:$GID" /mnt/orangepi/home/codex
  chmod 755 /mnt/orangepi/home/codex
fi

if grep -q '^sudo:' /mnt/orangepi/etc/group; then
  sed -i 's/^sudo:\([^:]*\):\([^:]*\):\(.*\)$/sudo:\1:\2:\3,codex/' /mnt/orangepi/etc/group
fi

mkdir -p /mnt/orangepi/etc/ssh/sshd_config.d
cat > /mnt/orangepi/etc/ssh/sshd_config.d/99-codex-temp.conf <<'CONF'
PasswordAuthentication yes
PermitRootLogin prohibit-password
CONF

touch /mnt/orangepi/boot/ssh 2>/dev/null || true
touch /mnt/orangepi/ssh 2>/dev/null || true

if [ -d /mnt/orangepi/etc/systemd/system/multi-user.target.wants ] && [ -f /mnt/orangepi/lib/systemd/system/ssh.service ]; then
  ln -sf /lib/systemd/system/ssh.service /mnt/orangepi/etc/systemd/system/multi-user.target.wants/ssh.service
fi
if [ -d /mnt/orangepi/etc/systemd/system/multi-user.target.wants ] && [ -f /mnt/orangepi/lib/systemd/system/sshd.service ]; then
  ln -sf /lib/systemd/system/sshd.service /mnt/orangepi/etc/systemd/system/multi-user.target.wants/sshd.service
fi

sync
echo "$(date '+%F %T') Finished. Added SSH login codex / pisofi123" >> "$LOG"
cat /mnt/orangepi/etc/os-release >> "$LOG" 2>/dev/null || true
umount /mnt/orangepi
'@

    Log "Running WSL offline rootfs modification"
    $bash | & wsl.exe -d $Distro -u root -- bash -s 2>&1 | ForEach-Object { Log $_ }
    if ($LASTEXITCODE -ne 0) {
        throw "WSL modification failed with exit code $LASTEXITCODE"
    }
}
catch {
    Log "ERROR: $($_.Exception.Message)"
    throw
}
finally {
    Log "Unmounting $DiskPath"
    & wsl.exe --unmount $DiskPath 2>&1 | ForEach-Object { Log $_ }
    Log "Bringing Windows disk 2 back online"
    Set-Disk -Number 2 -IsOffline $false
    Log "Done"
}
