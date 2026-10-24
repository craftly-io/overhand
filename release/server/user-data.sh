#!/bin/sh
# Overhand on a new Debian or Ubuntu server, set up at its first boot: paste this file as the server's user data when you
# create it (DigitalOcean, Hetzner, Lightsail's launch script, EC2, or any host that runs cloud-init). It runs once, as root.
# It adds the user overhand with the SSH keys the host put on the server, installs git, gh and ps, then runs Overhand's own
# installer as that user: a systemd user service that linger keeps running and starts at boot. It opens no port, since
# Overhand listens on 127.0.0.1 only. How to reach it: site/pages/docs/server.html#oneclick
# Progress goes to /var/log/cloud-init-output.log. OVERHAND_USER picks another user name.
set -eu
U="${OVERHAND_USER:-overhand}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends ca-certificates curl git gh procps
id "$U" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$U"
H="$(getent passwd "$U" | cut -d: -f6)"

# the keys the host gave root or its default user (ubuntu, admin), so the same key signs in as overhand
install -d -m 700 -o "$U" -g "$U" "$H/.ssh"
cat /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys 2>/dev/null | sort -u >"$H/.ssh/keys.new"
mv "$H/.ssh/keys.new" "$H/.ssh/authorized_keys"
chown "$U:$U" "$H/.ssh/authorized_keys"
chmod 600 "$H/.ssh/authorized_keys"

# no keyring on a server: API keys go to a file only this user can read, for the service and for your SSH sessions
# shellcheck disable=SC2016 # $HOME is the user's, expanded in their own shell
SECRETS='export OVERHAND_SECRETS_FILE="$HOME/.overhand/secrets.json"'
grep -qxF "$SECRETS" "$H/.profile" 2>/dev/null || printf '%s\n' "$SECRETS" >>"$H/.profile"
chown "$U:$U" "$H/.profile"

# linger starts the user's own systemd now and at every boot; without logind (a container) Overhand runs in the background
uid="$(id -u "$U")"
if loginctl enable-linger "$U" 2>/dev/null; then
  i=0
  while [ ! -S "/run/user/$uid/systemd/private" ] && [ "$i" -lt 30 ]; do i=$((i + 1)); sleep 1; done
fi
runuser -l "$U" -c "export XDG_RUNTIME_DIR=/run/user/$uid PATH=\"\$HOME/.local/bin:\$PATH\"; $SECRETS; curl -fsSL https://get.overhand.dev | sh"
