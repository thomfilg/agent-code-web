import { workerHibernationCandidate } from "../../src/worker-suspension.mjs";

// Opt-in candidate recipe. This is not admission or evidence of successful
// process resume: the ordinary image verifier must never promote it.
export const hibernationCandidate = workerHibernationCandidate;

export function hibernationRecipe(recipe) {
  const replace = (before, after) => {
    if (recipe.split(before).length !== 2) throw new Error("Unexpected worker recipe; hibernation candidate was not generated");
    recipe = recipe.replace(before, after);
  };
  replace("packages:\n", "packages:\n  - ec2-hibinit-agent\n  - acpid\n");
  replace("write_files:\n", `write_files:
  - path: /etc/systemd/system/hibinit-agent.service.d/relay.conf
    owner: root:root
    permissions: "0644"
    content: |
      [Service]
      Type=oneshot
      RemainAfterExit=yes
  - path: /etc/default/grub.d/99-agent-relay-hibernation.cfg
    owner: root:root
    permissions: "0644"
    content: |
      GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT nokaslr"
  - path: /usr/lib/systemd/system-sleep/agent-relay-heartbeat
    owner: root:root
    permissions: "0755"
    content: |
      #!/bin/sh
      # Wall clock advances during hibernation. Do not let the orphan watchdog
      # interpret the suspended time as fresh inactivity immediately on resume.
      if [ "$1" = post ]; then
        touch /opt/agent-web/.heartbeat
      fi
  - path: /etc/ssh/sshd_config.d/89-agent-relay-hibernation.conf
    owner: root:root
    permissions: "0644"
    content: |
      TCPKeepAlive no
      ClientAliveInterval 0
`);
  // Orphan recovery must not silently turn requested hibernation into a stop.
  // The packaged Ubuntu ACPI handler enables the dedicated swap at the highest
  // priority and uses systemd's hibernate/resume hooks. Failure stays visible.
  replace('[ $((now - modified)) -lt 420 ] || /usr/sbin/shutdown -h now',
    '[ $((now - modified)) -lt 420 ] || /etc/acpi/actions/sleep.sh button/sleep SBTN');
  replace("Description=Stop an abandoned Agent Relay worker", "Description=Hibernate an abandoned Agent Relay worker");
  replace("runcmd:\n", `runcmd:
  - systemctl daemon-reload
  - systemctl enable acpid hibinit-agent
  - systemctl restart hibinit-agent
  - update-grub
  - sh -c 'test -f /var/lib/hibinit-agent/hibernation-enabled && test -s /swap-hibinit'
`);
  return recipe;
}
