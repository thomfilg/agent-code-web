// Actual AWS CLI serialization, against a loopback-only fake EC2 endpoint.
// No AWS account/profile/credentials/network access is needed or used.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { gzipWorkerUserData, EC2_USER_DATA_MAX_BYTES } from "../deploy/aws/bake-worker-ami.mjs";

const execute = promisify(execFile);

test("AWS CLI sends gzip user-data through fileb with exactly one base64 layer", { timeout: 30000 }, async t => {
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", AWS_EC2_METADATA_DISABLED: "true", AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null", AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off", AWS_MAX_ATTEMPTS: "1" };
  try { await execute("aws", ["--version"], { env, timeout: 5000 }); }
  catch (error) {
    if (error.code === "ENOENT") { t.skip("AWS CLI is not installed; pure gzip/baker fixtures still run"); return; }
    throw Error("Installed AWS CLI could not start; private diagnostics suppressed");
  }
  const recipe = (await readFile(new URL("../deploy/aws/worker-cloud-init.yaml", import.meta.url), "utf8")).replaceAll("__RELAY_WORKER_PUBLIC_KEY_BASE64__", Buffer.from("ssh-ed25519 AAAAFixturePublicKey\n").toString("base64"));
  const compressed = gzipWorkerUserData(recipe);
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    let length = 0;
    request.on("data", chunk => { length += chunk.length; if (length > 100000) request.destroy(); else chunks.push(chunk); });
    request.on("end", () => {
      requests.push({ method: request.method, authorization: request.headers.authorization, body: new URLSearchParams(Buffer.concat(chunks).toString("utf8")) });
      response.writeHead(200, { "Content-Type": "text/xml" });
      response.end('<RunInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>fixture</requestId><reservationId>r-fixture</reservationId><instancesSet><item><instanceId>i-aaaaaaaaaaaaaaaaa</instanceId></item></instancesSet></RunInstancesResponse>');
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(path.join(tmpdir(), "relay-user-data-cli-"));
  try {
    const filename = path.join(directory, "cloud-init.yaml.gz");
    await writeFile(filename, compressed, { mode: 0o600, flag: "wx" });
    for (const format of ["base64", "raw-in-base64-out"]) {
      try {
        const result = await execute("aws", ["--region", "us-east-1", "--endpoint-url", `http://127.0.0.1:${server.address().port}`, "--no-sign-request", "--no-cli-pager", "--cli-binary-format", format,
          "ec2", "run-instances", "--image-id", "ami-aaaaaaaaaaaaaaaaa", "--instance-type", "t3.medium", "--user-data", `fileb://${filename}`, "--query", "Instances[0].InstanceId", "--output", "json"], { env, timeout: 10000, maxBuffer: 100000 });
        assert.equal(JSON.parse(result.stdout), "i-aaaaaaaaaaaaaaaaa");
      } catch { throw Error("Loopback-only AWS CLI serialization failed; private diagnostics suppressed"); }
    }
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.method, "POST");
      assert.equal(request.authorization, undefined);
      assert.equal(request.body.get("Action"), "RunInstances");
      const wire = request.body.get("UserData");
      assert.equal(wire, compressed.toString("base64"));
      const decoded = Buffer.from(wire, "base64");
      assert.ok(decoded.length <= EC2_USER_DATA_MAX_BYTES);
      assert.equal(gunzipSync(decoded).toString("utf8"), recipe);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
