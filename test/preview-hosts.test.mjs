import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRecords } from "../src/database.mjs";
import { PreviewHosts, PreviewHostError, previewDistributionConfig, previewTags, runPreviewAws } from "../src/preview-hosts.mjs";

const config = { enabled: true, expectedAccount: "123456789012", deployment: "relay-fixture", vpcOriginId: "vo_fixture", controllerInstanceId: "i-0123456789abcdef0", controllerOriginDns: "ip-10-84-1-2.us-east-2.compute.internal", relayDistributionId: "ERELAYEXCLUDED", region: "us-east-2", awsBin: "aws", profile: "" };
const scope = { ownerId: "owner-a", chatId: "chat-a" }, input = { ...scope, port: 3000 };
async function fixture(options = {}) {
  const records = options.records || new MemoryRecords(), calls = [], distributions = new Map(), notifications = [];
  let number = 0, time = 1000;
  const aws = async (service, action, args) => {
    calls.push({ service, action, args: structuredClone(args) });
    if (options.before) await options.before(action, args);
    if (action === "get-caller-identity") return { Account: config.expectedAccount, Arn: `arn:aws:sts::${config.expectedAccount}:assumed-role/controller/runtime` };
    if (action === "get-vpc-origin") return { VpcOrigin: { Id: config.vpcOriginId, Arn: `arn:aws:cloudfront::${config.expectedAccount}:vpcorigin/${config.vpcOriginId}`, Status: "Deployed", VpcOriginEndpointConfig: { Name: `${config.deployment}-origin`, Arn: `arn:aws:ec2:${config.region}:${config.expectedAccount}:instance/${config.controllerInstanceId}`, HTTPPort: 8787, OriginProtocolPolicy: "http-only" } } };
    if (action === "describe-instances") return { Reservations: [{ Instances: [{ InstanceId: config.controllerInstanceId, PrivateDnsName: config.controllerOriginDns, Tags: [{ Key: "ManagedBy", Value: "12-apps-ci" }, { Key: "AgentRelayDeployment", Value: config.deployment }] }] }] };
    if (action === "create-distribution-with-tags") {
      const payload = args.DistributionConfigWithTags;
      const quantities = value => { if (!value || typeof value !== "object") return; if (Object.hasOwn(value, "Quantity")) assert.equal(value.Quantity, value.Items?.length || 0); Object.values(value).forEach(quantities); };
      quantities(payload.DistributionConfig);
      assert.equal((await records.list("preview-host")).filter(r => r.callerReference === payload.DistributionConfig.CallerReference && r.createAttempted).length, 1, "durable intent precedes create");
      if ([...distributions.values()].some(d => d.Distribution.DistributionConfig.CallerReference === payload.DistributionConfig.CallerReference)) throw new PreviewHostError("DistributionAlreadyExists");
      const Id = `EPREVIEW${++number}`, d = { ETag: "version1", Distribution: { Id, ARN: `arn:aws:cloudfront::${config.expectedAccount}:distribution/${Id}`, DomainName: `dfixture${number}.cloudfront.net`, Status: "InProgress", DistributionConfig: structuredClone(payload.DistributionConfig) }, Tags: structuredClone(payload.Tags) };
      distributions.set(Id, d); if (options.ambiguousCreate) { options.ambiguousCreate = false; throw new Error("PRIVATE TIMEOUT STATE"); } return structuredClone(d);
    }
    if (action === "list-distributions") return { DistributionList: { IsTruncated: false, Quantity: distributions.size, Items: [...distributions.values()].map(({ Distribution: d }) => ({ Id: d.Id, Comment: d.DistributionConfig.Comment })) } };
    const id = args.Id || args.Resource?.split("/").at(-1), current = distributions.get(id);
    if (!current) throw new PreviewHostError("NoSuchDistribution");
    if (action === "get-distribution") return structuredClone(current);
    if (action === "list-tags-for-resource") return { Tags: structuredClone(current.Tags) };
    assert.equal(args.IfMatch, current.ETag);
    if (action === "update-distribution") { assert.equal(args.DistributionConfig.Enabled, false); current.Distribution.DistributionConfig = structuredClone(args.DistributionConfig); current.Distribution.Status = "InProgress"; current.ETag = "version2"; return structuredClone(current); }
    if (action === "delete-distribution") { assert.equal(current.Distribution.Status, "Deployed"); assert.equal(current.Distribution.DistributionConfig.Enabled, false); distributions.delete(id); if (options.ambiguousDelete) throw new Error("PRIVATE DELETE TIMEOUT"); return {}; }
    assert.fail(`Unexpected operation ${service}/${action}`);
  };
  const create = () => new PreviewHosts({ records, config: { ...config, ...options.config }, aws: options.aws || aws, now: () => time, onChange: r => notifications.push(r) });
  const hosts = create(); await hosts.initialize();
  return { hosts, create, records, calls, aws, distributions, notifications, advance: () => { time += 60001; }, deployed: () => { for (const d of distributions.values()) d.Distribution.Status = "Deployed"; } };
}
test("disabled/init/default have no AWS work; invalid scopes/config fail closed", async () => {
  const disabled = new PreviewHosts({ records: new MemoryRecords(), aws: () => assert.fail() }); await disabled.initialize();
  assert.equal(disabled.lookup("dfixture.cloudfront.net"), null); await assert.rejects(disabled.ensure(input), { code: "disabled" });
  const f = await fixture(); assert.equal(f.calls.length, 0);
  for (const bad of [{ ownerId: "owner\n" }, { chatId: "chat\u2028" }, { port: 80 }, { port: 65536 }, { port: "3000" }]) await assert.rejects(f.hosts.ensure({ ...input, ...bad }), { code: "invalid-input" });
  for (const bad of [{ expectedAccount: "123456789012\n" }, { controllerOriginDns: "foreign.example" }, { relayDistributionId: "ERELAYEXCLUDED\n" }, { maxHosts: 41 }]) assert.throws(() => new PreviewHosts({ records: f.records, config: { ...config, ...bad } }));
});
test("concurrent ensure persists a single intent; pending becomes ready only after verified deployed config/tags", async () => {
  const f = await fixture(), results = await Promise.all(Array.from({ length: 8 }, () => f.hosts.ensure(input)));
  assert.equal(new Set(results.map(r => r.id)).size, 1); assert.equal(f.calls.length, 0); const id = results[0].id;
  await f.hosts.reconcile(); const pending = f.hosts.get(id, scope); assert.equal(pending.status, "pending"); assert.equal(f.hosts.lookup(pending.hostname), null);
  f.deployed(); await f.hosts.reconcile(); const ready = f.hosts.get(id, scope); assert.equal(ready.status, "ready"); assert.equal(f.hosts.lookup(ready.hostname).id, id); assert.ok(Object.isFrozen(ready));
  assert.equal(f.calls.filter(c => c.action === "create-distribution-with-tags").length, 1);
  const restarted = f.create(); await restarted.initialize(); assert.equal(restarted.get(id, scope).status, "pending"); assert.equal(restarted.lookup(ready.hostname), null);
  await restarted.reconcile(); assert.equal(restarted.lookup(ready.hostname).id, id);
});
test("no cross-owner/chat access; quota reservations include pending/error/revoking and distinct fixed ports", async () => {
  const f = await fixture({ config: { maxHosts: 3, maxPerOwner: 2, maxPerChat: 2 } }), first = await f.hosts.ensure(input);
  assert.throws(() => f.hosts.get(first.id, { ...scope, ownerId: "owner-b" }), { code: "not-found" });
  await assert.rejects(f.hosts.revoke(first.id, { ...scope, chatId: "chat-b" }), { code: "not-found" });
  await f.hosts.ensure({ ...input, port: 4000 }); await assert.rejects(f.hosts.ensure({ ...input, port: 5000 }), { code: "limit-reached" });
  await f.hosts.ensure({ ...input, ownerId: "owner-b" }); await assert.rejects(f.hosts.ensure({ ...input, ownerId: "owner-c" }), { code: "limit-reached" });
  await f.hosts.revoke(first.id, scope); await assert.rejects(f.hosts.ensure({ ...input, ownerId: "owner-c" }), { code: "limit-reached" });
  assert.equal(f.calls.length, 0);
});
test("create timeout/restart reconciles exact persisted callerReference and never duplicates/adopts merely tagged resources", async () => {
  const f = await fixture({ ambiguousCreate: true }), first = await f.hosts.ensure(input); await f.hosts.reconcile();
  assert.equal(f.hosts.get(first.id, scope).status, "error"); assert.equal(f.distributions.size, 1);
  const restarted = f.create(); await restarted.initialize(); await restarted.reconcile();
  assert.equal(restarted.get(first.id, scope).status, "pending"); assert.equal(f.calls.filter(c => c.action === "create-distribution-with-tags").length, 1);
  const d = [...f.distributions.values()][0]; d.Distribution.DistributionConfig.CallerReference = "foreign"; f.deployed();
  await restarted.reconcile(); assert.equal(restarted.get(first.id, scope).error, "ownership-mismatch"); assert.equal(restarted.lookup(d.Distribution.DomainName), null);
  assert.equal(f.calls.filter(c => ["update-distribution", "delete-distribution"].includes(c.action)).length, 0);
});
test("revoke before create makes a durable tombstone with no create; same tuple receives fresh identity", async () => {
  const f = await fixture(), first = await f.hosts.ensure(input); await f.hosts.revoke(first.id, scope); await f.hosts.reconcile();
  assert.equal(f.hosts.get(first.id, scope).status, "deleted"); assert.equal(f.distributions.size, 0);
  const second = await f.hosts.ensure(input); assert.notEqual(first.id, second.id); assert.equal((await f.records.list("preview-host")).length, 2);
});
test("revoke invalidates immediately then disables, waits deployed, deletes and confirms absence; tombstones persist", async () => {
  const f = await fixture({ ambiguousDelete: true }), first = await f.hosts.ensure(input); await f.hosts.reconcile(); f.deployed(); await f.hosts.reconcile();
  const host = f.hosts.get(first.id, scope).hostname; assert.ok(f.hosts.lookup(host));
  const revoking = f.hosts.revoke(first.id, scope); assert.equal(f.hosts.lookup(host), null); await revoking; await f.hosts.reconcile();
  assert.equal(f.hosts.get(first.id, scope).status, "revoking"); assert.equal(f.calls.filter(c => c.action === "delete-distribution").length, 0);
  await f.hosts.reconcile(); assert.equal(f.calls.filter(c => c.action === "delete-distribution").length, 0);
  f.deployed(); await f.hosts.reconcile(); assert.equal(f.hosts.get(first.id, scope).status, "revoking"); assert.equal(f.distributions.size, 0);
  const before = f.calls.length; await f.hosts.reconcile(); assert.equal(f.hosts.get(first.id, scope).status, "deleted");
  assert.equal(f.calls.slice(before).some(c => c.action === "get-distribution"), false, "deleted resource has no IAM ownership tags; exact inventory absence suffices");
  const second = await f.hosts.ensure(input); await f.hosts.reconcile(); assert.notEqual(f.hosts.get(second.id, scope).hostname, host);
  assert.ok((await f.records.list("preview-host")).some(r => r.id === first.id && r.hostname === host));
});
test("an in-flight create completing after revoke cannot become ready or restore access", async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture({ before: async action => { if (action === "create-distribution-with-tags") { entered.resolve(); await release.promise; } } }), first = await f.hosts.ensure(input);
  const running = f.hosts.reconcile(); await entered.promise; await f.hosts.revoke(first.id, scope); release.resolve(); await running;
  const row = f.hosts.get(first.id, scope); assert.equal(row.status, "revoking"); assert.equal(f.hosts.lookup(row.hostname), null);
  assert.equal([...f.distributions.values()][0].Distribution.DistributionConfig.Enabled, false);
});
test("foreign account/controller/VPC origin/config/tags/Relay ID are refused before mutation", async () => {
  for (const change of [d => { d.Distribution.DistributionConfig.Origins.Items[0].VpcOriginConfig.VpcOriginId = "vo_foreign"; }, d => { d.Tags.Items[0].Value = "foreign"; }, d => { d.Distribution.DistributionConfig.DefaultCacheBehavior.CachePolicyId = "cache-enabled"; }, d => { d.Distribution.DistributionConfig.Aliases = { Quantity: 1, Items: ["foreign.invalid"] }; }, d => { d.Distribution.ARN = "arn:aws:cloudfront::999999999999:distribution/EPREVIEW1"; }]) {
    const f = await fixture(), first = await f.hosts.ensure(input); await f.hosts.reconcile(); change([...f.distributions.values()][0]); await f.hosts.revoke(first.id, scope); await f.hosts.reconcile();
    assert.equal(f.hosts.get(first.id, scope).error, "ownership-mismatch"); assert.equal(f.calls.filter(c => ["update-distribution", "delete-distribution"].includes(c.action)).length, 0);
  }
  for (const action of ["get-caller-identity", "get-vpc-origin", "describe-instances"]) {
    const f = await fixture({ before: which => { if (which === action) throw new PreviewHostError("ownership-mismatch"); } }), first = await f.hosts.ensure(input); await f.hosts.reconcile();
    assert.equal(f.hosts.get(first.id, scope).error, "ownership-mismatch"); assert.equal(f.calls.some(c => c.action === "create-distribution-with-tags"), false);
  }
});
test("AWS response defaults and method ordering normalize, but extra behaviors/functions do not", async () => {
  const f = await fixture(), first = await f.hosts.ensure(input); await f.hosts.reconcile(); const d = [...f.distributions.values()][0];
  Object.assign(d.Distribution.DistributionConfig.ViewerCertificate, { CertificateSource: "cloudfront", SSLSupportMethod: "vip" });
  d.Distribution.DistributionConfig.ConnectionMode = "direct"; d.Distribution.DistributionConfig.Aliases.Items = [];
  d.Distribution.DistributionConfig.DefaultCacheBehavior.AllowedMethods.Items.reverse(); f.deployed(); await f.hosts.reconcile(); assert.equal(f.hosts.get(first.id, scope).status, "ready");
  f.advance(); d.Distribution.DistributionConfig.DefaultCacheBehavior.FunctionAssociations = { Quantity: 1, Items: [{ EventType: "viewer-request", FunctionARN: "foreign" }] };
  await f.hosts.reconcile(); assert.equal(f.hosts.lookup(d.Distribution.DomainName), null); assert.equal(f.hosts.get(first.id, scope).error, "ownership-mismatch");
});
test("failed persistence prevents create and malformed saved records cannot be adopted", async () => {
  const records = new MemoryRecords(), f = await fixture({ records }); records.put = async () => { throw Error("PRIVATE DB"); };
  await assert.rejects(f.hosts.ensure(input), error => { assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE/); return true; }); assert.equal(f.calls.length, 0);
  const valid = await fixture(), first = await valid.hosts.ensure(input), row = await valid.records.get("preview-host", first.id);
  for (const patch of [{ identity: "other" }, { distributionId: config.relayDistributionId, hostname: "drelay.cloudfront.net" }, { callerReference: "foreign" }, { port: 80 }, { error: "PRIVATE ERROR" }, { pendingStep: { private: true } }]) {
    const bad = new MemoryRecords(); await bad.put("preview-host", row.id, { ...row, ...patch }); const hosts = new PreviewHosts({ records: bad, config, aws: () => assert.fail() }); await assert.rejects(hosts.initialize(), { code: "invalid-record" });
  }
});
test("CLI adapter is fixed-operation, bounded, no shell; errors omit stderr/config/cause", async () => {
  const calls = [], value = await runPreviewAws(config, "cloudfront", "get-distribution", { Id: "EPREVIEW1" }, { execute: async (file, args, options) => { calls.push({ file, args, options }); return { stdout: '{"ok":true}' }; } });
  assert.deepEqual(value, { ok: true }); assert.equal(calls[0].options.timeout, 25000); assert.equal(calls[0].options.env.AWS_MAX_ATTEMPTS, "1"); assert.equal(calls[0].options.shell, undefined); assert.ok(!calls[0].args.includes("--profile"));
  await assert.rejects(runPreviewAws(config, "cloudfront", "tag-resource", {}, { execute: () => assert.fail() }), { code: "invalid-input" });
  for (const code of ["AccessDenied", "PRIVATEUNKNOWN"]) await assert.rejects(runPreviewAws(config, "cloudfront", "get-distribution", {}, { execute: async () => { throw Object.assign(Error("PRIVATE MESSAGE"), { stderr: `An error occurred (${code}) when calling PRIVATE PATH` }); } }), error => { assert.equal(error.code, code === "AccessDenied" ? code : "provider-unavailable"); assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE/); return true; });
});
