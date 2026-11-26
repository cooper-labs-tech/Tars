# A remote Linux host for the e2e of agents that run elsewhere (2.0.7): sshd with key auth only, tmux, git, bash,
# curl, jq and node (the stand-in CLIs are node scripts). Never a real remote machine: the spec starts it on this
# computer's loopback and removes it after. About 30 MB over node:22.14.0-alpine3.21, which the e2e machine has.
FROM node:22.14.0-alpine3.21
RUN apk add --no-cache openssh-server tmux git bash curl jq \
 && ssh-keygen -A \
 && adduser -D -s /bin/bash agent \
 && passwd -u agent 2>/dev/null || true \
 && mkdir -p /home/agent/.ssh && chmod 700 /home/agent/.ssh && chown -R agent:agent /home/agent \
 && printf '%s\n' \
    'PasswordAuthentication no' \
    'KbdInteractiveAuthentication no' \
    'PubkeyAuthentication yes' \
    'PermitRootLogin no' \
    'AllowTcpForwarding remote' \
    'GatewayPorts no' \
    'AllowAgentForwarding no' \
    'X11Forwarding no' \
    'ClientAliveInterval 5' \
    'ClientAliveCountMax 2' \
    > /etc/ssh/sshd_config.d/tars-test.conf \
 && grep -q '^Include /etc/ssh/sshd_config.d' /etc/ssh/sshd_config || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
