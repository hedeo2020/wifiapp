# Reverse-tunnel auto-provisioning: VPS host setup

These two scripts live on the VPS host (`161.118.244.168`), **outside** the
license-platform container, at `/opt/pfitunnel/`. They let the containerized
Node app provision per-device reverse-tunnel VPS users on demand, without
giving the container general host access.

## How it fits together

```
Orange Pi  --(POST /api/v1/devices/:serial/tunnel, own SSH pubkey)-->  license-platform container
                                                                              |
                                                                  ssh -i pfibridge_ed25519
                                                                  pfibridge@161.118.244.168 "<serial> <pubkey>"
                                                                              |
                                                                              v
                                                        sshd on the VPS host, matches pfibridge's
                                                        authorized_keys forced command:
                                                              /opt/pfitunnel/bridge_wrapper.sh
                                                                              |
                                                              validates serial + pubkey format,
                                                              then: sudo register_device.sh <serial> <pubkey>
                                                                              |
                                                              creates (or looks up) a dedicated,
                                                              restricted per-device tunnel user,
                                                              scoped via permitlisten to only that
                                                              device's 2 ports. Returns JSON.
```

The `pfibridge` SSH key can **only** ever run `bridge_wrapper.sh` (enforced by
`command=` in its authorized_keys entry) — it cannot open a shell, forward
ports itself, or do anything else, even if the container were fully
compromised.

## One-time host setup (already done on 161.118.244.168; recorded here for
## reproducibility / disaster recovery)

```bash
sudo mkdir -p /opt/pfitunnel
sudo install -o root -g root -m 755 register_device.sh /opt/pfitunnel/register_device.sh
sudo install -o root -g root -m 755 bridge_wrapper.sh /opt/pfitunnel/bridge_wrapper.sh
printf 'serial\tusername\tssh_port\thttp_port\tcreated_at\n' | sudo tee /opt/pfitunnel/registry.tsv

sudo useradd -m -s /bin/bash pfibridge   # NOTE: must be a real shell, not nologin --
                                          # sshd needs it to run the forced command.
echo 'pfibridge ALL=(root) NOPASSWD: /opt/pfitunnel/register_device.sh' \
  | sudo tee /etc/sudoers.d/pfibridge
sudo chmod 440 /etc/sudoers.d/pfibridge

ssh-keygen -t ed25519 -f /tmp/pfibridge_ed25519 -N '' -C 'pfibridge-license-platform'
sudo mkdir -p /home/pfibridge/.ssh
echo "command=\"/opt/pfitunnel/bridge_wrapper.sh\",no-pty,no-X11-forwarding,no-agent-forwarding,no-port-forwarding,no-user-rc $(cat /tmp/pfibridge_ed25519.pub)" \
  | sudo tee /home/pfibridge/.ssh/authorized_keys
sudo chown -R pfibridge:pfibridge /home/pfibridge/.ssh
sudo chmod 700 /home/pfibridge/.ssh
sudo chmod 600 /home/pfibridge/.ssh/authorized_keys

# The private key lives on the container's persistent /data volume (same
# place db.json lives), NOT baked into the image and NOT a Coolify env var:
docker cp /tmp/pfibridge_ed25519 <container>:/data/pfibridge_ed25519
docker exec -u root <container> chown appuser:appgroup /data/pfibridge_ed25519
docker exec -u root <container> chmod 600 /data/pfibridge_ed25519
shred -u /tmp/pfibridge_ed25519 /tmp/pfibridge_ed25519.pub
```

The container also needs `openssh-client` installed (see the `Dockerfile`'s
`RUN apk add --no-cache openssh-client` line) so `server.js` can shell out to
`ssh` via `child_process.execFile`.

## Port allocation

`register_device.sh` looks at the highest `ssh_port` already in
`/opt/pfitunnel/registry.tsv` and allocates `+1`; the HTTP port is always
`ssh_port + 5866` (matching the first device's `2222` -> `8088` offset).
Device 1 (serial `02c000816800547a`) occupies `2222`/`8088`.

## Superseded manual tool

`provision_pfitunnel.sh` (repo root) automated the same steps by hand, before
this self-service API existed. It's kept as a fallback for manual
troubleshooting, but new devices no longer need it — they provision
themselves automatically via `POST /api/v1/devices/:serial/tunnel` once
licensed.
