# Continuous deployment from main

Every push to `main` runs [`deploy-main.yml`](../../.github/workflows/deploy-main.yml):

1. **check** — `npm ci`, syntax check of every script, deployment and browser tests.
2. **deploy** (GitHub environment `production`, main only) — short-lived OIDC
   credentials for `agent-relay-github-deploy`, then:
   - reuse the ECR image tagged with the commit (12-char sha) or build it with the
     existing CodeBuild project from a `git archive` of the commit;
   - send [`rollout.mjs`](rollout.mjs) through SSM `AWS-RunShellScript`: pull the
     digest, keep the running container as `relay-rollback-<sha>-<time>`, start the
     new one with the same environment and data mount, and restore the previous
     container if it does not start or is not ready within two minutes;
   - check the public `/readyz`.

Rollouts queue (`concurrency: production-deploy`); a newer push waits for the
running one.

If a chat, goal or sign-in is active, the controller refuses the drain and the
rollout prints `DEFERRED` (exit 75) before stopping anything; the old container
keeps serving. CI retries every 60 s for up to 60 min (`RETRY_MINUTES`), and stops
early with success when `main` has moved on, since the newer run deploys it. After
the deadline the run fails; re-run it when chats are idle. Manual rollouts should stop once this is enabled, so nothing races
the controller.

## One-time setup

```bash
# 1. GitHub OIDC provider (reuse it if it already exists)
aws iam get-open-id-connect-provider --open-id-connect-provider-arn \
  arn:aws:iam::456808212788:oidc-provider/token.actions.githubusercontent.com \
  || aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
       --client-id-list sts.amazonaws.com

# 2. Deploy role (only the production environment of this repository can assume it)
aws cloudformation deploy --region us-east-2 --stack-name agent-relay-github-deploy \
  --template-file deploy/aws/cd-role.yml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides OidcProviderArn=arn:aws:iam::456808212788:oidc-provider/token.actions.githubusercontent.com

# 3. GitHub environment restricted to main, and the role ARN
gh api -X PUT repos/thomfilg/agent-code-web/environments/production \
  -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/thomfilg/agent-code-web/environments/production/deployment-branch-policies -f name=main -f type=branch
gh variable set AWS_DEPLOY_ROLE_ARN --repo thomfilg/agent-code-web \
  --body "$(aws cloudformation describe-stacks --region us-east-2 --stack-name agent-relay-github-deploy \
            --query 'Stacks[0].Outputs[0].OutputValue' --output text)"
```

## Rollback

Re-run the workflow for an earlier `main` commit (**Run workflow** or re-run a
previous run): its image is reused and rolled out the same way. The previous
container is also kept on the controller as `relay-rollback-*`.
