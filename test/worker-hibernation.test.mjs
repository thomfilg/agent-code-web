import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { hibernationRecipe } from "../deploy/aws/worker-hibernation.mjs";
import { gzipWorkerUserData } from "../deploy/aws/bake-worker-ami.mjs";

test("candidate recipe prepares hibernation without permitting metadata or automatic full stop", async () => {
  const original = await readFile(new URL("../deploy/aws/worker-cloud-init.yaml", import.meta.url), "utf8");
  const recipe = hibernationRecipe(original);
  assert.match(recipe, /ec2-hibinit-agent/);
  assert.match(recipe, /test -f \/var\/lib\/hibinit-agent\/hibernation-enabled/);
  assert.match(recipe, /test -s \/swap-hibinit/);
  assert.match(recipe, /TCPKeepAlive no/);
  assert.match(recipe, /ClientAliveInterval 0/);
  assert.match(recipe, /\[ "\$1" = post \]/);
  assert.match(recipe, /sleep\.sh button\/sleep SBTN/);
  assert.doesNotMatch(recipe, /420.*shutdown/);
  assert.ok(gzipWorkerUserData(recipe).length < 16384);
  assert.throws(() => hibernationRecipe(recipe), /Unexpected worker recipe/);
  assert.throws(() => hibernationRecipe("not a worker recipe"), /Unexpected worker recipe/);
});
