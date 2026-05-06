# GitHub Actions

## Required repo configuration

Once `shamarx-terraform/envs/prod` has been applied, copy these values into the trading-bot repo's GitHub settings.

### Repository **variables** (Settings → Secrets and variables → Actions → Variables tab)

| Name | Source | Example |
|---|---|---|
| `SHAMARX_PROD_DEPLOY_ROLE_ARN` | `terraform output github_deploy_role_arn` | `arn:aws:iam::904596398959:role/shamarx-prod-github-deploy` |
| `EC2_INSTANCE_ID` | `terraform output ec2_instance_id` | `i-0abc...` |

### Repository **secrets**

None required — auth uses OIDC (no static AWS keys).

## Workflows

### `ci.yml`
Runs on every PR + push to main. Typecheck + lint + build. Does not deploy.

### `deploy-backend.yml`
Runs on push to `main` when files under `src/`, `libs/`, `services/`, `docker/`, `package.json`, or `pnpm-lock.yaml` change. Triggers `aws ssm send-command` to:

1. `git pull origin main` on the EC2 instance
2. `docker compose up -d --build`
3. `prisma migrate deploy`
4. `curl https://api.shamarx.com/api/strategy/health` to verify

## Frontend (Amplify) — no workflow

`apps/web/**` changes are picked up by AWS Amplify's GitHub webhook directly. Amplify rebuilds and redeploys without going through GitHub Actions. To check status:

```bash
AWS_PROFILE=shamarx-prod aws amplify list-jobs \
  --app-id $(AWS_PROFILE=shepyrd terraform -chdir=../shamarx-terraform/envs/prod output -raw amplify_app_id) \
  --branch-name main
```
