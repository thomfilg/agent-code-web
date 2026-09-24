#!/usr/bin/env node
// Explicit one-shot operator action, not an automatic deployment migration.
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { aws, verifyTarget, resolveDeploymentEngine } from "../aws-deploy.mjs";
const repository = "456808212788.dkr.ecr.us-east-2.amazonaws.com/agent-relay-mvp-applicationrepository-sujdgarjwejp";
const image = `${repository}@sha256:05d3178a0e32d15f2c0384297c260c9dd9028d79dbbf802f00258952be2f2be5`;
const previousImage = `${repository}@sha256:4cb53a408f0e96cbf9d7aae9f92349f7528a1f3b94dd3edb03342f9ba5c43487`;
const controller = "i-08c991c22089589a5";
const worker = "i-0a0ed507dd35f0af3";
const encode = value => Buffer.from(value).toString("base64");
try {
  if (!isAllowedArgs(process.argv.slice(2))) throw new Error("Use only --run; target is fixed");
  if (!process.argv.includes("--run")) { console.log(JSON.stringify({ dryRun: true, controller, image, worker, deletesChat: "chat_d50034e32eef41d2a9de0f63288a9d7a" })); }
  else {
    await verifyTarget();
    await resolveDeploymentEngine({});
    const stack = (await aws(["cloudformation", "describe-stacks"], ["--stack-name", "agent-relay-mvp"])).Stacks[0];
    const outputs = Object.fromEntries(stack.Outputs.map(row => [row.OutputKey, row.OutputValue]));
    if (outputs.ControllerInstanceId !== controller || outputs.DataVolumeId !== "vol-0be8793d52d34ed1c" || outputs.ApplicationRepositoryUri !== repository ||
        stack.StackId !== "arn:aws:cloudformation:us-east-2:456808212788:stack/agent-relay-mvp/f8be3890-b31f-11f1-aeb8-067e5a66eb2f") throw new Error("Stack target changed");
    const ecr = await aws(["ecr", "batch-get-image"], ["--repository-name", repository.split("/")[1], "--image-ids", `imageDigest=${image.split("@")[1]}`]);
    if (!ecr.images?.some(row => row.imageId.imageDigest === image.split("@")[1])) throw new Error("Release image missing");
    const planner = await readFile(new URL("./company-migration-20260918.mjs", import.meta.url), "utf8");
    const program = (await readFile(new URL("./run-company-migration-20260918.mjs", import.meta.url), "utf8"))
      .replace('"./company-migration-20260918.mjs"', JSON.stringify(`data:text/javascript;base64,${encode(planner)}`));
    const rollout = await readFile(new URL("../deploy/aws-rollout.py", import.meta.url), "utf8");
    const config = { action: "deploy", region: "us-east-2", stack: stack.StackId, image, container: "relay", mount: "/srv/relay/data", destination: "/var/lib/relay",
      port: 8787, health: "/readyz", timeout: 120, secret: outputs.SecretArn, registry: repository.split("/")[0], volume: outputs.DataVolumeId, readyFile: "/var/lib/relay-controller-ready" };
    const python = `import base64,fcntl,json,os,sys
namespace={'__name__':'reviewed_rollout'}
exec(base64.b64decode('${encode(rollout)}'),namespace)
Rollout=namespace['Rollout']; RolloutError=namespace['RolloutError']
config=json.loads(base64.b64decode('${encode(JSON.stringify(config))}'))
class CompanyMigrationRollout(Rollout):
    def deploy(self):
        current=self.inspect(self.name)
        if not current or not current.get('State',{}).get('Running') or current['Config']['Image'] != '${previousImage}':
            raise RolloutError('Expected original running release was not found. No migration performed.')
        if not any(m.get('Source')==self.config['mount'] and m.get('Destination')==self.config['destination'] and m.get('RW') for m in current.get('Mounts',[])):
            raise RolloutError('Original controller data mount changed.')
        return super().deploy()
    def start(self,envfile):
        # The reviewed deploy transition already drained/stopped/retained the original.
        for name in [self.name,self.previous]:
            state=self.inspect(name)
            if state and state.get('State',{}).get('Running'):
                raise RolloutError('A controller is still running. Offline migration refused.')
        result=json.loads(self.command(['aws','--region','us-east-2','--output','json','--no-cli-pager','ec2','describe-instances','--instance-ids','${worker}']))
        instances=[i for r in result.get('Reservations',[]) for i in r.get('Instances',[])]
        if len(instances)!=1: raise RolloutError('Exact worker inventory changed.')
        w=instances[0]; tags={t['Key']:t['Value'] for t in w.get('Tags',[])}
        if w.get('InstanceId')!='${worker}' or w.get('State',{}).get('Name')!='stopped' or tags.get('AgentWebChat')!='chat_d50034e32eef41d2a9de0f63288a9d7a' or tags.get('ManagedBy')!='agent-relay' or tags.get('AgentRelayDeployment')!='agent-relay-mvp':
            raise RolloutError('Worker ownership or stopped state changed.')
        args=['docker','run','--rm','--interactive','--name','relay-company-maintenance','--network','none','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:rw,nosuid,nodev,size=256m,mode=1777','--mount','type=bind,src='+self.config['mount']+',dst='+self.config['destination'],'--env-file',envfile,'--entrypoint','node',self.config['image'],'--input-type=module']
        output=self.command(args,data=base64.b64decode('${encode(program)}').decode(),timeout=180)
        receipt=json.loads(output.strip())
        if receipt.get('ok') is not True or receipt.get('deletedChat')!='chat_d50034e32eef41d2a9de0f63288a9d7a' or receipt.get('unrelatedRecordsPreserved') is not True:
            raise RolloutError('Offline migration did not produce its verified receipt.')
        print(json.dumps(receipt),flush=True)
        super().start(envfile)
os.umask(0o077)
try:
    with open('/run/12-apps-controller-rollout.lock','w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        print(json.dumps(CompanyMigrationRollout(config).run()),flush=True)
except Exception:
    print(json.dumps({'ok':False,'error':'Maintenance rollout failed; private diagnostics suppressed. Inspect before retrying.'}),flush=True)
    sys.exit(1)
`;
    // Keep delivery bounded even though the reviewed engine and the offline
    // planner are bundled for a single locked maintenance operation.
    const compressed = gzipSync(Buffer.from(python)).toString("base64");
    const digest = createHash("sha256").update(python).digest("hex");
    const staging = `/run/relay-company-migration-${digest}`;
    // Stage non-secret source in individually small, exclusive files; execution
    // is separate and checks the complete source hash first. This is not a fix
    // for disk exhaustion: image pulls also require sufficient host disk space.
    const chunks = compressed.match(/.{1,3500}/g);
    const staged = await Promise.all(chunks.map(async (chunk, index) => {
      const prepare = `import os,pathlib\np=pathlib.Path('${staging}')\ntry: p.mkdir(mode=0o700)\nexcept FileExistsError: pass\ns=p.lstat()\nif p.is_symlink() or not p.is_dir() or s.st_uid!=0 or s.st_mode&0o077: raise SystemExit(1)\nf=p/'part-${index}'\nwith f.open('x',encoding='ascii') as stream: stream.write('${chunk}')\nos.chmod(f,0o600)\nprint('source part staged; not executed')`;
      const sent = await aws(["ssm", "send-command"], ["--document-name", "AWS-RunShellScript", "--instance-ids", controller, "--parameters",
        JSON.stringify({ commands: [`python3 - <<'STAGE_SOURCE'\n${prepare}\nSTAGE_SOURCE`], executionTimeout: ["60"] }), "--comment", `Stage public maintenance source ${index + 1}/${chunks.length}; no execution`]);
      return sent.Command.CommandId;
    }));
    console.log(JSON.stringify({ sourceHash: digest, stagedCommands: staged, state: "staging-only" }));
    for (const id of staged) {
      let complete = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const invocation = await aws(["ssm", "get-command-invocation"], ["--command-id", id, "--instance-id", controller]);
        if (invocation.Status === "Success" && invocation.ResponseCode === 0) { complete = true; break; }
        if (!["Pending", "InProgress", "Delayed"].includes(invocation.Status)) throw new Error("Source staging failed; not executed");
      }
      if (!complete) throw new Error("Source staging incomplete; not executed");
    }
    const command = `python3 - <<'RELAY_COMPANY_MAINTENANCE'\nimport base64,gzip,hashlib,pathlib\np=pathlib.Path('${staging}')\nsource=gzip.decompress(base64.b64decode(''.join((p/('part-'+str(i))).read_text() for i in range(${chunks.length}))))\nif hashlib.sha256(source).hexdigest()!='${digest}': raise SystemExit(1)\nexec(compile(source,'verified-company-maintenance','exec'))\nRELAY_COMPANY_MAINTENANCE`;
    const sent = await aws(["ssm", "send-command"], ["--document-name", "AWS-RunShellScript", "--instance-ids", controller, "--timeout-seconds", "600", "--parameters",
      JSON.stringify({ commands: [command], executionTimeout: ["1800"] }), "--cloud-watch-output-config", "CloudWatchOutputEnabled=false", "--comment", "Authorized company migration, mixed-chat deletion and immutable rollout"]);
    console.log(JSON.stringify({ commandId: sent.Command.CommandId, controller, image, state: "submitted" }));
  }
} catch {
  console.error("Company migration deployment failed; private diagnostics suppressed. Inspect before retrying."); process.exitCode = 1;
}
function isAllowedArgs(args) { return args.length === 0 || args.length === 1 && args[0] === "--run"; }
