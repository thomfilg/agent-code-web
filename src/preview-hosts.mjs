import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isDeepStrictEqual } from "node:util";

const exec = promisify(execFile), KIND = "preview-host", statuses = ["pending", "ready", "revoking", "deleted", "error"];
const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9]/.test(value) && !/[^A-Za-z0-9_.:-]/.test(value);
const uuid = value => typeof value === "string" && /^pp_[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const hash = value => createHash("sha256").update(value).digest("hex");
const safeCodes = new Set(["AccessDenied", "AccessDeniedException", "Throttling", "ThrottlingException", "TooManyDistributions", "TooManyDistributionsAssociatedToVpcOrigin", "DistributionAlreadyExists", "NoSuchDistribution", "PreconditionFailed", "DistributionNotDisabled", "InvalidIfMatchVersion"]);
export class PreviewHostError extends Error {
  constructor(code = "provider-unavailable") { super("App preview hostname is unavailable."); this.code = ["disabled", "invalid-input", "not-found", "limit-reached", "ownership-mismatch", "invalid-record", "closed", "provider-unavailable", ...safeCodes].includes(code) ? code : "provider-unavailable"; }
}
const fail = code => { throw new PreviewHostError(code); };
const pair = input => {
  if (!input || !identifier(input.ownerId) || !identifier(input.chatId)) fail("invalid-input");
  return { ownerId: input.ownerId, chatId: input.chatId };
};
const operations = { sts: ["get-caller-identity"], ec2: ["describe-instances"], cloudfront: ["get-vpc-origin", "list-distributions", "create-distribution-with-tags", "get-distribution", "list-tags-for-resource", "update-distribution", "delete-distribution"] };
export async function runPreviewAws(config, service, operation, input = {}, { signal, execute = exec } = {}) {
  if (!operations[service]?.includes(operation)) fail("invalid-input");
  const args = [...(config.profile ? ["--profile", config.profile] : []), "--region", config.region, "--no-cli-pager", "--no-paginate", "--output", "json", "--cli-connect-timeout", "5", "--cli-read-timeout", "15", service, operation, "--cli-input-json", JSON.stringify(input)];
  try {
    const { stdout } = await execute(config.awsBin, args, { signal, timeout: 25000, maxBuffer: 1024 * 1024, env: { ...process.env, AWS_MAX_ATTEMPTS: "1", AWS_RETRY_MODE: "standard", AWS_CLI_AUTO_PROMPT: "off", AWS_PAGER: "" } });
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch (error) {
    const code = String(error.stderr || "").match(/An error occurred \(([A-Za-z][A-Za-z0-9]+)\) when calling/)?.[1];
    throw new PreviewHostError(safeCodes.has(code) ? code : "provider-unavailable");
  }
}
function configuration(input) {
  const c = { enabled: false, awsBin: "aws", profile: "", region: "us-east-2", maxHosts: 8, maxPerOwner: 4, maxPerChat: 2, ...input };
  if (!c.enabled) return Object.freeze(c);
  if (Object.values(c).some(value => typeof value === "string" && /[\r\n\u2028\u2029]/.test(value))) fail("invalid-input");
  if (!/^[0-9]{12}$/.test(c.expectedAccount || "") || !identifier(c.deployment) || !/^vo_[A-Za-z0-9]+$/.test(c.vpcOriginId || "") ||
      !/^i-[a-f0-9]{8,17}$/.test(c.controllerInstanceId || "") || !/^[A-Z0-9]{6,32}$/.test(c.relayDistributionId || "") ||
      !/^ip-[0-9-]+(?:\.[a-z0-9-]+)?\.(?:compute\.internal|ec2\.internal)$/.test(c.controllerOriginDns || "") || !/^[a-z]{2}-[a-z]+-[0-9]$/.test(c.region) ||
      ![c.maxHosts, c.maxPerOwner, c.maxPerChat].every(n => Number.isSafeInteger(n) && n >= 1 && n <= 40) || c.maxPerOwner > c.maxHosts || c.maxPerChat > c.maxPerOwner) fail("invalid-input");
  return Object.freeze(c);
}
function deploymentIdentity(c) { return [c.expectedAccount, c.deployment, c.vpcOriginId, c.controllerInstanceId, c.controllerOriginDns, c.relayDistributionId, c.region].join("/"); }
export function previewDistributionConfig(config, record, enabled = true) {
  return {
    CallerReference: record.callerReference, Aliases: { Quantity: 0 }, DefaultRootObject: "",
    Origins: { Quantity: 1, Items: [{ Id: "relay-preview", DomainName: config.controllerOriginDns, OriginPath: "", CustomHeaders: { Quantity: 0 },
      VpcOriginConfig: { VpcOriginId: config.vpcOriginId, OriginReadTimeout: 60, OriginKeepaliveTimeout: 60 }, ConnectionAttempts: 3, ConnectionTimeout: 10, OriginShield: { Enabled: false }, OriginAccessControlId: "" }] },
    OriginGroups: { Quantity: 0 }, DefaultCacheBehavior: { TargetOriginId: "relay-preview", TrustedSigners: { Enabled: false, Quantity: 0 }, TrustedKeyGroups: { Enabled: false, Quantity: 0 },
      ViewerProtocolPolicy: "https-only", AllowedMethods: { Quantity: 7, Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"], CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] } },
      SmoothStreaming: false, Compress: false, LambdaFunctionAssociations: { Quantity: 0 }, FunctionAssociations: { Quantity: 0 }, FieldLevelEncryptionId: "",
      CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad", OriginRequestPolicyId: "216adef6-5c7f-47e4-b989-5492eafa07d3", GrpcConfig: { Enabled: false } },
    CacheBehaviors: { Quantity: 0 }, CustomErrorResponses: { Quantity: 11, Items: [400, 403, 404, 405, 414, 416, 500, 501, 502, 503, 504].map(ErrorCode => ({ ErrorCode, ErrorCachingMinTTL: 0 })) },
    Comment: `Relay preview v1 ${record.id}`, Logging: { Enabled: false, IncludeCookies: false, Bucket: "", Prefix: "" }, PriceClass: "PriceClass_100", Enabled: enabled,
    ViewerCertificate: { CloudFrontDefaultCertificate: true, MinimumProtocolVersion: "TLSv1" }, Restrictions: { GeoRestriction: { RestrictionType: "none", Quantity: 0 } },
    WebACLId: "", HttpVersion: "http2and3", IsIPV6Enabled: true, ContinuousDeploymentPolicyId: "", Staging: false,
  };
}
export function previewTags(config, record) {
  return { ManagedBy: "agent-relay-preview", AgentRelayDeployment: config.deployment, AgentRelayPurpose: "app-preview-v1", AgentRelayPreview: record.id,
    AgentRelayOwner: hash(record.ownerId), AgentRelayChat: hash(record.chatId), AgentRelayPort: String(record.port) };
}
// Only documented response defaults are normalized. Unknown/nonempty changes
// fail closed rather than being silently carried into an update/delete.
function normalizeConfig(value) {
  const c = structuredClone(value);
  if (c.ViewerCertificate?.CertificateSource === "cloudfront") delete c.ViewerCertificate.CertificateSource;
  if (c.ViewerCertificate?.SSLSupportMethod === "vip") delete c.ViewerCertificate.SSLSupportMethod;
  if (c.ConnectionMode === "direct") delete c.ConnectionMode;
  if (c.AnycastIpListId === "") delete c.AnycastIpListId;
  for (const item of c.CustomErrorResponses?.Items || []) { if (item.ResponsePagePath === "") delete item.ResponsePagePath; if (item.ResponseCode === "") delete item.ResponseCode; }
  const visit = item => {
    if (!item || typeof item !== "object") return;
    if (item.Quantity === 0 && Array.isArray(item.Items) && !item.Items.length) delete item.Items;
    for (const child of Object.values(item)) { if (Array.isArray(child)) child.forEach(visit); else visit(child); }
  };
  visit(c);
  if (Array.isArray(c.DefaultCacheBehavior?.AllowedMethods?.Items)) c.DefaultCacheBehavior.AllowedMethods.Items.sort();
  if (Array.isArray(c.DefaultCacheBehavior?.AllowedMethods?.CachedMethods?.Items)) c.DefaultCacheBehavior.AllowedMethods.CachedMethods.Items.sort();
  return c;
}

/** Single-controller durable state machine. No timer, HTTP route or AWS work
 * in ensure()/initialize(); the caller schedules bounded reconcile() passes. */
export class PreviewHosts {
  #records; #config; #aws; #rows = new Map(); #ready = new Set(); #blocked = new Set(); #queue = Promise.resolve(); #running; #closed = false; #initialized = false; #abort = new AbortController(); #onChange; #now; #cursor = 0;
  constructor({ records, config = {}, aws, onChange = () => {}, now = Date.now }) {
    if (!records?.list || !records?.put) fail("invalid-input");
    this.#records = records; this.#config = configuration(config); this.#aws = aws || ((...args) => runPreviewAws(this.#config, ...args)); this.#onChange = onChange; this.#now = now;
  }
  #serial(fn) { const result = this.#queue.then(fn).catch(error => { throw error instanceof PreviewHostError ? error : new PreviewHostError(); }); this.#queue = result.catch(() => {}); return result; }
  #admit() { if (this.#closed) fail("closed"); if (!this.#config.enabled) fail("disabled"); if (!this.#initialized) fail("invalid-record"); }
  #view(r) {
    const status = this.#blocked.has(r.id) && r.status !== "deleted" ? "revoking" : r.status === "ready" && !this.#ready.has(r.id) ? "pending" : r.status;
    return Object.freeze({ id: r.id, ownerId: r.ownerId, chatId: r.chatId, port: r.port, hostname: r.hostname || null, distributionId: r.distributionId || null, status,
      pendingStep: r.pendingStep, error: r.error || null, retryable: r.status === "error" && !["ownership-mismatch", "invalid-record"].includes(r.error), createdAt: r.createdAt, updatedAt: r.updatedAt });
  }
  #notify(r) { try { this.#onChange(this.#view(r)); } catch { /* lookup remains fail-closed independent of notification. */ } }
  #validateRecord(r) {
    if (!r || r.schema !== 1 || !uuid(r.id) || /[\r\n\u2028\u2029]/.test(r.id) || !identifier(r.ownerId) || !identifier(r.chatId) || !Number.isInteger(r.port) || r.port < 1024 || r.port > 65535 ||
      !statuses.includes(r.status) || !["active", "deleted"].includes(r.desired) || r.identity !== deploymentIdentity(this.#config) || r.callerReference !== `relay-preview-v1-${r.id}` ||
      ![null, "create", "deploy", "disable", "delete"].includes(r.pendingStep) || !Number.isSafeInteger(r.createdAt) || !Number.isSafeInteger(r.updatedAt) ||
      (r.error != null && new PreviewHostError(r.error).code !== r.error) || (r.deleteRequested !== undefined && typeof r.deleteRequested !== "boolean") ||
      typeof r.createAttempted !== "boolean" || (r.distributionId && (!/^[A-Z0-9]{6,32}$/.test(r.distributionId) || r.distributionId === this.#config.relayDistributionId)) ||
      (r.hostname && !/^d[a-z0-9]{3,60}\.cloudfront\.net$/.test(r.hostname)) || (!!r.distributionId !== !!r.hostname)) fail("invalid-record");
  }
  async initialize() {
    return this.#serial(async () => {
      if (this.#initialized) return; if (this.#closed) fail("closed");
      if (this.#config.enabled) {
        const rows = await this.#records.list(KIND), ids = new Set(), domains = new Set(), tuples = new Set();
        for (const r of rows) {
          this.#validateRecord(r); const tuple = JSON.stringify([r.ownerId, r.chatId, r.port]);
          if (ids.has(r.id) || r.hostname && domains.has(r.hostname) || r.status !== "deleted" && tuples.has(tuple)) fail("invalid-record");
          ids.add(r.id); if (r.hostname) domains.add(r.hostname); if (r.status !== "deleted") tuples.add(tuple);
        }
        this.#rows = new Map(rows.map(r => [r.id, r]));
      }
      this.#initialized = true;
    });
  }
  async #save(r) { await this.#records.put(KIND, r.id, r); this.#rows.set(r.id, r); this.#notify(r); return this.#view(r); }
  async ensure(input) {
    this.#admit(); const scope = pair(input), port = input.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) fail("invalid-input");
    return this.#serial(async () => {
      this.#admit(); const active = [...this.#rows.values()].filter(r => r.status !== "deleted");
      const previous = active.find(r => r.ownerId === scope.ownerId && r.chatId === scope.chatId && r.port === port);
      if (previous) {
        if (previous.status === "error" && previous.desired === "active") {
          if (!this.#view(previous).retryable) fail(previous.error);
          return this.#save({ ...previous, status: "pending", error: null, updatedAt: this.#now() });
        }
        return this.#view(previous);
      }
      if (active.length >= this.#config.maxHosts || active.filter(r => r.ownerId === scope.ownerId).length >= this.#config.maxPerOwner || active.filter(r => r.ownerId === scope.ownerId && r.chatId === scope.chatId).length >= this.#config.maxPerChat) fail("limit-reached");
      const id = `pp_${randomUUID()}`, time = this.#now();
      return this.#save({ schema: 1, id, ...scope, port, callerReference: `relay-preview-v1-${id}`, identity: deploymentIdentity(this.#config), createAttempted: false,
        status: "pending", desired: "active", pendingStep: "create", hostname: null, distributionId: null, createdAt: time, updatedAt: time });
    });
  }
  get(id, scope) { this.#admit(); pair(scope); const r = this.#rows.get(id); if (!r || r.ownerId !== scope.ownerId || r.chatId !== scope.chatId) fail("not-found"); return this.#view(r); }
  list(scope) { this.#admit(); pair(scope); return [...this.#rows.values()].filter(r => r.ownerId === scope.ownerId && r.chatId === scope.chatId).map(r => this.#view(r)); }
  lookup(hostname) {
    if (this.#closed || !this.#initialized || !this.#config.enabled) return null;
    const r = [...this.#rows.values()].find(r => r.hostname === hostname && r.status === "ready" && r.desired === "active" && this.#ready.has(r.id) && !this.#blocked.has(r.id));
    return r ? this.#view(r) : null;
  }
  async revoke(id, scope) {
    this.get(id, scope); this.#blocked.add(id); this.#ready.delete(id); this.#notify(this.#rows.get(id));
    return this.#serial(async () => { const r = this.#rows.get(id); if (r.status === "deleted") return this.#view(r);
      return this.#save({ ...r, desired: "deleted", status: "revoking", pendingStep: r.distributionId ? "disable" : "create", error: null, updatedAt: this.#now() }); });
  }
  async #call(service, operation, input = {}) { if (this.#closed) fail("closed"); return this.#aws(service, operation, input, { signal: this.#abort.signal }); }
  async #guard() {
    const c = this.#config, identity = await this.#call("sts", "get-caller-identity");
    if (identity.Account !== c.expectedAccount || typeof identity.Arn !== "string" || !identity.Arn.startsWith(`arn:aws:`) || identity.Arn.split(":")[4] !== c.expectedAccount) fail("ownership-mismatch");
    const { VpcOrigin: origin } = await this.#call("cloudfront", "get-vpc-origin", { Id: c.vpcOriginId });
    const endpoint = origin?.VpcOriginEndpointConfig;
    if (origin?.Id !== c.vpcOriginId || origin.Arn !== `arn:aws:cloudfront::${c.expectedAccount}:vpcorigin/${c.vpcOriginId}` || origin.Status !== "Deployed" ||
      endpoint?.Arn !== `arn:aws:ec2:${c.region}:${c.expectedAccount}:instance/${c.controllerInstanceId}` || endpoint.Name !== `${c.deployment}-origin` || endpoint.HTTPPort !== 8787 || endpoint.OriginProtocolPolicy !== "http-only") fail("ownership-mismatch");
    const result = await this.#call("ec2", "describe-instances", { InstanceIds: [c.controllerInstanceId] });
    const all = result.Reservations?.flatMap(item => item.Instances || []), instance = all?.[0], tags = Object.fromEntries((instance?.Tags || []).map(t => [t.Key, t.Value]));
    if (all?.length !== 1 || instance.InstanceId !== c.controllerInstanceId || instance.PrivateDnsName !== c.controllerOriginDns || tags.ManagedBy !== "12-apps-ci" || tags.AgentRelayDeployment !== c.deployment || instance.PublicIpAddress) fail("ownership-mismatch");
  }
  async #readDistribution(record, id) {
    if (id === this.#config.relayDistributionId || !/^[A-Z0-9]{6,32}$/.test(id || "")) fail("ownership-mismatch");
    const result = await this.#call("cloudfront", "get-distribution", { Id: id });
    const d = result.Distribution, c = this.#config;
    if (d?.Id !== id || d.ARN !== `arn:aws:cloudfront::${c.expectedAccount}:distribution/${id}` || !/^d[a-z0-9]{3,60}\.cloudfront\.net$/.test(d.DomainName || "") ||
      !["Deployed", "InProgress"].includes(d.Status) || typeof result.ETag !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(result.ETag) || typeof d.DistributionConfig?.Enabled !== "boolean") fail("ownership-mismatch");
    if (record.hostname && record.hostname !== d.DomainName || [...this.#rows.values()].some(r => r.id !== record.id && r.hostname === d.DomainName)) fail("ownership-mismatch");
    if (!isDeepStrictEqual(normalizeConfig(d.DistributionConfig), normalizeConfig(previewDistributionConfig(c, record, d.DistributionConfig.Enabled)))) fail("ownership-mismatch");
    const resultTags = await this.#call("cloudfront", "list-tags-for-resource", { Resource: d.ARN });
    const items = resultTags.Tags?.Items;
    if (!Array.isArray(items) || new Set(items.map(t => t.Key)).size !== items.length || !isDeepStrictEqual(Object.fromEntries(items.map(t => [t.Key, t.Value])), previewTags(c, record))) fail("ownership-mismatch");
    return { distribution: d, etag: result.ETag };
  }
  async #inventory() {
    let marker; const found = [];
    for (let page = 0; page < 10; page++) {
      const result = await this.#call("cloudfront", "list-distributions", { MaxItems: "100", ...(marker ? { Marker: marker } : {}) });
      const list = result.DistributionList;
      if (!list || typeof list.IsTruncated !== "boolean" || !Number.isSafeInteger(list.Quantity) || list.Quantity < 0 || list.Quantity > 100 || (list.Items || []).length !== list.Quantity) fail("provider-unavailable");
      if ((list.Items || []).some(item => !/^[A-Z0-9]{6,32}$/.test(item.Id || ""))) fail("provider-unavailable");
      found.push(...(list.Items || []));
      if (!list.IsTruncated) return found;
      if (typeof list.NextMarker !== "string" || !list.NextMarker || marker === list.NextMarker) fail("provider-unavailable"); marker = list.NextMarker;
    }
    fail("provider-unavailable");
  }
  async #recover(record) {
    const found = (await this.#inventory()).filter(item => item.Comment === `Relay preview v1 ${record.id}`);
    if (found.length > 1) fail("ownership-mismatch"); return found[0]?.Id || null;
  }
  async #patch(id, patch) { return this.#serial(async () => { const current = this.#rows.get(id); const next = { ...current, ...patch, updatedAt: this.#now() };
    if (current.desired === "deleted" || this.#blocked.has(id)) { next.desired = "deleted"; if (next.status !== "deleted" && next.status !== "error") next.status = "revoking"; }
    await this.#save(next); return next; }); }
  async #step(record) {
    let id = record.distributionId;
    // Deleted resources no longer have resource tags for GetDistribution IAM.
    // Observe exact ID absence via the already-authorized full inventory, only
    // after the durable delete intent and previously verified disable/deploy.
    if (id && record.desired === "deleted" && record.deleteRequested && !(await this.#inventory()).some(item => item.Id === id)) {
      await this.#patch(record.id, { status: "deleted", pendingStep: null, error: null }); return;
    }
    if (!id && record.createAttempted) id = await this.#recover(record);
    if (!id) {
      const latest = this.#rows.get(record.id);
      if (latest.desired === "deleted" && !latest.createAttempted) { await this.#patch(record.id, { status: "deleted", pendingStep: null }); return; }
      // A previous ambiguous create must retain/reuse the exact reference even
      // during revocation, so a late AWS success can be discovered and removed.
      await this.#patch(record.id, { createAttempted: true, pendingStep: "create" });
      const result = await this.#call("cloudfront", "create-distribution-with-tags", { DistributionConfigWithTags: { DistributionConfig: previewDistributionConfig(this.#config, record), Tags: { Items: Object.entries(previewTags(this.#config, record)).map(([Key, Value]) => ({ Key, Value })) } } });
      id = result.Distribution?.Id;
      if (!id) fail("provider-unavailable");
    }
    const observed = await this.#readDistribution(record, id), d = observed.distribution;
    await this.#patch(record.id, { distributionId: id, hostname: d.DomainName, etag: observed.etag, pendingStep: "deploy", error: null });
    const current = this.#rows.get(record.id);
    if (current.desired === "deleted" || this.#blocked.has(record.id)) {
      this.#ready.delete(record.id);
      if (d.DistributionConfig.Enabled) {
        await this.#call("cloudfront", "update-distribution", { Id: id, IfMatch: observed.etag, DistributionConfig: { ...d.DistributionConfig, Enabled: false } });
        await this.#patch(record.id, { pendingStep: "disable", status: "revoking" });
      } else if (d.Status === "Deployed") {
        await this.#patch(record.id, { deleteRequested: true, pendingStep: "delete", status: "revoking" });
        await this.#call("cloudfront", "delete-distribution", { Id: id, IfMatch: observed.etag });
        // Keep tombstone; successful delete still requires absence observation.
        await this.#patch(record.id, { deleteRequested: true, pendingStep: "delete", status: "revoking" });
      } else await this.#patch(record.id, { pendingStep: "disable", status: "revoking" });
    } else {
      if (!d.DistributionConfig.Enabled) fail("ownership-mismatch");
      await this.#patch(record.id, { status: d.Status === "Deployed" ? "ready" : "pending", pendingStep: d.Status === "Deployed" ? null : "deploy", lastCheckedAt: this.#now() });
      if (d.Status === "Deployed" && !this.#blocked.has(record.id) && this.#rows.get(record.id).desired === "active") { this.#ready.add(record.id); this.#notify(this.#rows.get(record.id)); }
    }
  }
  async reconcile({ limit = 2 } = {}) {
    this.#admit(); if (!Number.isInteger(limit) || limit < 1 || limit > 8) fail("invalid-input"); if (this.#running) return this.#running;
    this.#running = (async () => {
      await this.#queue;
      const pending = [...this.#rows.values()].filter(r => r.status !== "deleted" && (r.status !== "ready" || !this.#ready.has(r.id) || this.#now() - (r.lastCheckedAt || 0) > 60000));
      if (!pending.length) return { checked: 0 };
      let guardError; try { await this.#guard(); } catch (error) { guardError = error; }
      if (guardError) { this.#ready.clear(); for (const row of this.#rows.values()) this.#notify(row); }
      const count = Math.min(limit, pending.length);
      for (let i = 0; i < count && !this.#closed; i++) {
        const r = pending[(this.#cursor + i) % pending.length];
        try { if (guardError) throw guardError; await this.#step(r); }
        catch (error) {
          this.#ready.delete(r.id);
          if (error instanceof PreviewHostError && error.code === "NoSuchDistribution" && this.#rows.get(r.id).desired === "deleted" && this.#rows.get(r.id).deleteRequested) await this.#patch(r.id, { status: "deleted", pendingStep: null, error: null });
          else await this.#patch(r.id, { status: "error", error: error instanceof PreviewHostError ? error.code : "provider-unavailable" });
        }
      }
      this.#cursor += count; return { checked: count };
    })().finally(() => { this.#running = undefined; }); return this.#running;
  }
  async close() { this.#closed = true; this.#ready.clear(); this.#abort.abort(); await this.#running?.catch(() => {}); await this.#queue; }
}
