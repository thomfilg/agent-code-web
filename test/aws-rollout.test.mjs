import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rolloutCommands } from "../deploy/aws/rollout.mjs";

const image = `456808212788.dkr.ecr.us-east-2.amazonaws.com/agent-relay-mvp-applicationrepository-sujdgarjwejp@sha256:${"a".repeat(64)}`;

test("rollout commands only accept a commit tag and an immutable ECR digest", () => {
  assert.throws(() => rolloutCommands({ tag: "main", image }), /git commit sha/);
  assert.throws(() => rolloutCommands({ tag: "abc1234", image: image.replace(/@sha256:.*/, ":latest") }), /sha256 digest/);
  assert.throws(() => rolloutCommands({ tag: "abc1234", image: `evil.example/x@sha256:${"a".repeat(64)}` }), /sha256 digest/);
  assert.throws(() => rolloutCommands({ tag: "abc1234; rm -rf /", image }), /git commit sha/);
});

test("the new container is started only after the old one is kept, and failures restore it", () => {
  const commands = rolloutCommands({ tag: "abc1234def56", image });
  const script = commands.join("\n");
  const index = pattern => commands.findIndex(line => pattern.test(line));
  assert.equal(commands[0], "set -eu");
  assert.ok(index(/docker pull/) < index(/docker stop --timeout 45 relay/), "pull before stopping");
  assert.ok(index(/internal\/deploy\/drain/) > index(/docker pull/) && index(/internal\/deploy\/drain/) < index(/docker stop --timeout 45 relay/), "controller drain must fence active work before Stop");
  assert.match(script, /internal\/deploy\/resume/, "a failed pre-stop rollout reopens the controller");
  assert.ok(index(/docker rename relay "\$relay_backup"/) < index(/docker run -d --name relay/), "keep the old container before starting");
  assert.match(script, /--mount type=bind,src=\/srv\/relay\/data,dst=\/var\/lib\/relay/);
  assert.match(script, /--env-file "\$relay_env"/);
  assert.match(script, /readyz/);
  // Both failure paths restore the previous container and exit non-zero.
  assert.equal(commands.filter(line => /docker rename "\$relay_backup" relay; sudo docker start relay/.test(line) && /exit 1/.test(line)).length, 2);
  assert.ok(index(/--filter name=\^\/relay-rollback-/) > index(/relay_ready=0/), "old rollbacks are pruned only after a ready rollout");
  assert.equal(commands.at(-1), "echo READY");
  assert.doesNotMatch(script, /printenv|cat "\$relay_env"|echo "\$relay_env"/, "no environment value is printed");
  assert.ok(commands.every(line => !line.includes("\n")));
});

test("the command-line form writes SSM AWS-RunShellScript parameters", () => {
  const output = execFileSync(process.execPath, ["deploy/aws/rollout.mjs", "--tag", "abc1234", "--image", image], { encoding: "utf8" });
  const parameters = JSON.parse(output);
  assert.deepEqual(parameters.executionTimeout, ["900"]);
  assert.ok(parameters.commands.includes(`relay_image=${image}`));
});

test("a rejected live-controller drain aborts the rollout before Docker Stop", t => {
  const directory = mkdtempSync(join(tmpdir(), "relay-rollout-drain-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = join(directory, "calls");
  const fake = (name, body) => {
    const file = join(directory, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o700);
  };
  fake("sudo", `printf '%s\\n' "$*" >> "$RELAY_TEST_CALLS"\ncase "$*" in *'docker inspect relay'*) echo old-image;; *'docker image inspect'*) echo new-image;; esac\nexit 0`);
  fake("aws", "echo fixture-password");
  fake("curl", "exit 22");
  const command = spawnSync("/bin/sh", ["-c", rolloutCommands({ tag: "abc1234def56", image }).join("\n")], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RELAY_TEST_CALLS: calls }, encoding: "utf8",
  });
  assert.notEqual(command.status, 0);
  assert.match(command.stderr, /deployment deferred without stopping workers/);
  assert.doesNotMatch(readFileSync(calls, "utf8"), /docker stop|docker rename|docker run/);
});

test("the workflow deploys main with OIDC, one rollout at a time, and pins every action", () => {
  const workflow = readFileSync(".github/workflows/deploy-main.yml", "utf8");
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.match(workflow, /group: production-deploy\n\s+cancel-in-progress: false/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /environment: production/);
  assert.doesNotMatch(workflow, /AWS_SECRET_ACCESS_KEY|aws-access-key-id/);
  for (const [, ref] of workflow.matchAll(/uses: [\w./-]+@(\S+)/g)) assert.match(ref, /^[a-f0-9]{40}$/, "actions are pinned to commits");
});
