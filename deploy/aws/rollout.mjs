#!/usr/bin/env node
// Shell commands the CI rollout sends to the controller through SSM
// AWS-RunShellScript. The new container reuses the running container's exact
// environment and data mount; if it is not ready within two minutes the
// previous container is restored unchanged. No credential value is printed.
//
//   node deploy/aws/rollout.mjs --tag <git sha> --image <registry/repo@sha256:...> --out params.json
import { writeFileSync } from "node:fs";

const IMAGE = /^(\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com)\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;
const KEEP_ROLLBACKS = 2;

export function rolloutCommands({ tag, image }) {
  if (!/^[a-f0-9]{7,40}$/.test(tag || "")) throw new Error("tag must be a git commit sha");
  const match = IMAGE.exec(image || "");
  if (!match) throw new Error("image must be an ECR repository@sha256 digest");
  return [
    "set -eu",
    `relay_registry=${match[1]}`,
    `relay_image=${image}`,
    // A rerun of the same commit keeps every earlier rollback container.
    `relay_backup=relay-rollback-${tag}-$(date +%s)`,
    `relay_env=/run/relay-${tag}.env`,
    'current=$(sudo docker inspect relay --format "{{.Image}}")',
    'aws ecr get-login-password --region "$(echo "$relay_registry" | cut -d. -f4)" | sudo docker login --username AWS --password-stdin "$relay_registry" >/dev/null',
    'sudo docker pull "$relay_image" >/dev/null',
    'target=$(sudo docker image inspect "$relay_image" --format "{{.Id}}")',
    'if [ "$current" = "$target" ]; then echo "Already running $relay_image"; echo READY; exit 0; fi',
    // Only the running controller can authoritatively decide whether a chat,
    // goal, browser or retained worker would be interrupted. A rejected drain
    // leaves the old container serving and aborts the rollout before Stop.
    'if ! curl --silent --show-error --fail --max-time 15 --request POST http://127.0.0.1:8787/internal/deploy/drain >/dev/null; then echo "Relay has active work; deployment deferred without stopping workers" >&2; exit 1; fi',
    // If a later pre-stop command fails, reopen the old controller. Once it
    // exits, the replacement or restored container starts undrained.
    `trap 'curl --silent --max-time 5 --request POST http://127.0.0.1:8787/internal/deploy/resume >/dev/null 2>&1 || true' EXIT`,
    "sudo docker inspect relay --format '{{range .Config.Env}}{{println .}}{{end}}' | sudo tee \"$relay_env\" >/dev/null",
    'sudo chmod 600 "$relay_env"',
    "sudo docker stop --timeout 45 relay",
    'sudo docker rename relay "$relay_backup"',
    'if ! sudo docker run -d --name relay --network host --restart unless-stopped --user 1000:1000 --security-opt no-new-privileges:true --cap-drop ALL --tmpfs /tmp:rw,nosuid,nodev,size=256m,mode=1777 --mount type=bind,src=/srv/relay/data,dst=/var/lib/relay --env-file "$relay_env" "$relay_image"; then sudo docker rename "$relay_backup" relay; sudo docker start relay; sudo rm -f "$relay_env"; echo "New container did not start; previous container restored" >&2; exit 1; fi',
    'relay_ready=0; for relay_attempt in $(seq 1 60); do if curl -fsS http://127.0.0.1:8787/readyz >/dev/null 2>&1; then relay_ready=1; break; fi; sleep 2; done',
    'if [ "$relay_ready" -ne 1 ]; then sudo docker logs --tail 80 relay >&2 || true; sudo docker rm -f relay || true; sudo docker rename "$relay_backup" relay; sudo docker start relay; sudo rm -f "$relay_env"; echo "New container was not ready; previous container restored" >&2; exit 1; fi',
    'sudo rm -f "$relay_env"',
    'sudo docker logout "$relay_registry" >/dev/null || true',
    // Keep the newest rollback containers; older ones only hold disk.
    `sudo docker ps -a --filter name=^/relay-rollback- --format "{{.CreatedAt}}\\t{{.Names}}" | sort -r | tail -n +${KEEP_ROLLBACKS + 1} | cut -f2 | xargs -r sudo docker rm >/dev/null || true`,
    "sudo docker image prune -f >/dev/null || true",
    'sudo docker ps --filter name=^/relay$ --format "{{.Names}}::{{.Image}}::{{.Status}}"',
    "echo READY",
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const option = name => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
  const commands = rolloutCommands({ tag: option("tag"), image: option("image") });
  const parameters = JSON.stringify({ commands, executionTimeout: ["900"] });
  if (option("out")) writeFileSync(option("out"), parameters); else process.stdout.write(parameters);
}
