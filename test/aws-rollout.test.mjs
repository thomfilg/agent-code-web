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
  const indices = pattern => commands.flatMap((line, offset) => pattern.test(line) ? [offset] : []);
  assert.equal(commands[0], "set -eu");
  const fences = indices(/relay_live_workers=\$\(aws ec2 describe-instances/);
  assert.equal(fences.length, 2, "check both before image work and again after drain");
  assert.ok(fences[0] < index(/docker image prune -a -f/), "active work avoids image cleanup and download");
  assert.ok(index(/docker image prune -a -f/) < index(/docker pull/), "unused image layers are pruned before pulling");
  assert.ok(index(/relay_free_kib/) < index(/docker pull/), "free disk is checked before pulling");
  assert.ok(index(/docker pull/) < index(/docker stop --timeout 45 relay/), "pull before stopping");
  assert.ok(index(/internal\/deploy\/drain/) > index(/docker pull/) && index(/internal\/deploy\/drain/) < index(/docker stop --timeout 45 relay/), "controller drain must fence active work before Stop");
  assert.ok(fences[1] > index(/internal\/deploy\/drain/) && fences[1] < index(/docker stop --timeout 45 relay/), "EC2 must independently fence running workers before Stop");
  assert.ok(index(/systemctl is-active --quiet agent-relay-host-events.service/) > fences[1]
    && index(/systemctl is-active --quiet agent-relay-host-events.service/) < index(/docker stop --timeout 45 relay/),
  "the independent host witness must be running before Docker stops the old controller");
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
  fake("aws", `case "$*" in *'ec2 describe-instances'*) echo 0;; *) echo fixture-password;; esac`);
  fake("curl", `printf '%s\\n' "curl $*" >> "$RELAY_TEST_CALLS"; exit 22`);
  fake("df", "printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/root 20000000 10000000 10000000 50%% /\\n'");
  const command = spawnSync("/bin/sh", ["-c", rolloutCommands({ tag: "abc1234def56", image }).join("\n")], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RELAY_TEST_CALLS: calls }, encoding: "utf8",
  });
  assert.equal(command.status, 75, "a deferral is a temporary failure CI retries");
  assert.equal(command.stdout.trim(), "DEFERRED");
  assert.match(command.stderr, /deployment deferred without stopping workers/);
  const observed = readFileSync(calls, "utf8");
  assert.match(observed, /docker logout/, "a rejected drain discards the short-lived ECR login");
  assert.doesNotMatch(observed, /internal\/deploy\/resume/, "a failed drain did not suspend the controller");
  assert.doesNotMatch(observed, /docker stop|docker rename|docker run|systemctl/);
});

test("low controller disk space aborts before an image pull or worker mutation", t => {
  const directory = mkdtempSync(join(tmpdir(), "relay-rollout-space-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = join(directory, "calls");
  const fake = (name, body) => {
    const file = join(directory, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o700);
  };
  fake("sudo", `printf '%s\\n' "$*" >> "$RELAY_TEST_CALLS"\ncase "$*" in *'docker inspect relay'*) echo old-image;; esac\nexit 0`);
  fake("aws", `case "$*" in *'ec2 describe-instances'*) echo 0;; esac`);
  fake("df", "printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/root 20000000 19999000 1000 99%% /\\n'");
  const command = spawnSync("/bin/sh", ["-c", rolloutCommands({ tag: "abc1234def56", image }).join("\n")], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RELAY_TEST_CALLS: calls }, encoding: "utf8",
  });
  assert.notEqual(command.status, 0);
  assert.match(command.stderr, /at least 4 GiB free/);
  assert.doesNotMatch(readFileSync(calls, "utf8"), /docker pull|docker stop|docker rename|docker run/);
});

test("an idle-looking active goal cannot be stopped when an old controller accepts drain", t => {
  const directory = mkdtempSync(join(tmpdir(), "relay-rollout-worker-fence-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = join(directory, "calls");
  const fake = (name, body) => {
    const file = join(directory, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o700);
  };
  fake("sudo", `printf '%s\\n' "$*" >> "$RELAY_TEST_CALLS"; case "$*" in *'docker inspect relay'*) echo old-image;; *'docker image inspect'*) echo new-image;; esac; exit 0`);
  fake("aws", `printf '%s\\n' "aws $*" >> "$RELAY_TEST_CALLS"; case "$*" in *'ec2 describe-instances'*) relay_count=$(awk '/aws ec2 describe-instances/ {n++} END {print n+0}' "$RELAY_TEST_CALLS"); if [ "$relay_count" -eq 1 ]; then echo 0; else echo 1; fi;; *) echo fixture-password;; esac`);
  fake("curl", `printf '%s\\n' "curl $*" >> "$RELAY_TEST_CALLS"; exit 0`);
  fake("df", "printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/root 20000000 10000000 10000000 50%% /\\n'");
  const command = spawnSync("/bin/sh", ["-c", rolloutCommands({ tag: "abc1234def56", image }).join("\n")], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RELAY_TEST_CALLS: calls }, encoding: "utf8",
  });
  assert.equal(command.status, 75, "a live worker defers CI rather than failing the rollout permanently");
  assert.equal(command.stdout.trim(), "DEFERRED");
  assert.match(command.stderr, /running EC2 workers; deployment deferred/);
  const observed = readFileSync(calls, "utf8");
  assert.match(observed, /ec2 describe-instances/);
  assert.equal((observed.match(/ec2 describe-instances/g) || []).length, 2, "a worker appeared after the early preflight");
  assert.match(observed, /internal\/deploy\/resume/, "an accepted drain must be released on refusal");
  assert.match(observed, /docker logout/);
  assert.doesNotMatch(observed, /docker stop|docker rename|docker run/);
});

test("active workers defer before any Docker prune, registry login or image pull", t => {
  const directory = mkdtempSync(join(tmpdir(), "relay-rollout-early-fence-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = join(directory, "calls");
  const fake = (name, body) => { const file = join(directory, name); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o700); };
  fake("aws", `printf '%s\\n' "aws $*" >> "$RELAY_TEST_CALLS"; echo 1`);
  fake("sudo", `printf '%s\\n' "sudo $*" >> "$RELAY_TEST_CALLS"; exit 0`);
  const command = spawnSync("/bin/sh", ["-c", rolloutCommands({ tag: "abc1234def56", image }).join("\n")], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RELAY_TEST_CALLS: calls }, encoding: "utf8",
  });
  assert.equal(command.status, 75);
  assert.equal(command.stdout.trim(), "DEFERRED");
  assert.match(command.stderr, /running EC2 workers/);
  assert.match(readFileSync(calls, "utf8"), /aws ec2 describe-instances/);
  assert.doesNotMatch(readFileSync(calls, "utf8"), /sudo|docker|ecr/);
});

test("the workflow deploys main with OIDC, one rollout at a time, and pins every action", () => {
  const workflow = readFileSync(".github/workflows/deploy-main.yml", "utf8");
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.match(workflow, /group: production-deploy\n\s+cancel-in-progress: false/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /environment: production/);
  assert.doesNotMatch(workflow, /AWS_SECRET_ACCESS_KEY|aws-access-key-id/);
  // Active work defers the rollout; CI retries until a deadline, unless a newer main supersedes it.
  assert.match(workflow, /grep -qx DEFERRED/);
  assert.match(workflow, /RETRY_MINUTES: \d+/);
  // The OIDC session must outlive the job, or the retry loop dies with ExpiredToken.
  const session = Number(/role-duration-seconds: (\d+)/.exec(workflow)?.[1]), job = Number(/deploy:[\s\S]*?timeout-minutes: (\d+)/.exec(workflow)?.[1]);
  assert.ok(session >= job * 60, "credentials last as long as the deploy job");
  assert.ok(session <= Number(/MaxSessionDuration: (\d+)/.exec(readFileSync("deploy/aws/cd-role.yml", "utf8"))?.[1]), "the role allows the requested session");
  assert.match(workflow, /commits\/main/);
  assert.match(workflow, /id: rollout/);
  assert.match(workflow, /deployed=true.*GITHUB_OUTPUT/);
  assert.match(workflow, /deployed=false.*GITHUB_OUTPUT/);
  assert.match(workflow, /name: Public readiness\n\s+if: steps\.rollout\.outputs\.deployed == 'true'/,
    "a superseded successful workflow must not validate the old controller as if the new image was deployed");
  for (const [, ref] of workflow.matchAll(/uses: [\w./-]+@(\S+)/g)) assert.match(ref, /^[a-f0-9]{40}$/, "actions are pinned to commits");
});
