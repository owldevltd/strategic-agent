#!/bin/bash
# First provisioning of the VM, passed to Vultr as user_data; runs once at first boot (cloud-init).
# Log on the VM: /var/log/cloud-init-output.log
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -y -q -o DPkg::Lock::Timeout=600"
NODE_VERSION=24.22.2

# 1) Swap: small VMs run out of memory on image pulls otherwise.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 2) Packages: Docker for the sandbox, Caddy for HTTPS, tools.
$APT update
$APT install docker.io caddy ufw jq curl gnupg rsync xz-utils

# 3) Node from nodejs.org (the distribution's Node is too old for node:sqlite).
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
node --version

# 4) Firewall: only SSH and the web.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# 5) Two service users. The core starts sandbox containers, so it may use Docker (root-equivalent on the host; the
#    core is trusted, the code it runs is isolated in the containers). The gate runs as a user of its own, so the
#    core can neither read the gate's database nor its operator pin.
id agency >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/agency/core --shell /usr/sbin/nologin agency
id agency-gate >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/agency/gate --shell /usr/sbin/nologin agency-gate
usermod -aG docker agency
chmod 700 /var/lib/agency/core /var/lib/agency/gate

# 6) gVisor as the stronger sandbox runtime ("runsc"); not fatal if it fails.
(
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg &&
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    > /etc/apt/sources.list.d/gvisor.list &&
  $APT update && $APT install runsc && runsc install && systemctl restart docker
) || echo "WARNING: gVisor could not be installed; the sandbox runs with runc"

# 7) The sandbox image, pulled now so the first run does not wait for it.
docker pull python:3.12-slim

touch /var/lib/agency-provisioned
