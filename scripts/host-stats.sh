#!/usr/bin/env bash
# host-stats.sh — one-command capacity & health check for Shamarx hosts.
#
#   pnpm host:stats                 # app server (default)
#   pnpm host:stats -- mt5-host-01  # future MT5 Direct host (Spec 4)
#
# Runs over AWS SSM — no inbound ports, no SSH keys. Prints CPU / RAM /
# disk / per-container memory / candle freshness and a scale verdict, so
# the "can this box take more accounts?" decision is one command.
#
# Requirements on the laptop: aws cli + SSO session (aws sso login
# --profile shamarx-prod), python3, jq optional.
set -euo pipefail

PROFILE="${AWS_PROFILE_OVERRIDE:-shamarx-prod}"
REGION="${AWS_REGION_OVERRIDE:-ap-southeast-5}"
TARGET="${1:-app}"

# ── Host registry ────────────────────────────────────────────────────────────
# mt5-host entries get added here (or resolved from the Mt5Host table) when
# Spec 4 W1 lands. Until then only the app server is known.
case "$TARGET" in
  app)         INSTANCE_ID="i-0da17ad488fa32c8a"; KIND="linux-app" ;;
  mt5-host-01) echo "mt5-host-01 is not provisioned yet (Spec 4 W1)."; exit 1 ;;
  *)           echo "Unknown host '$TARGET'. Known: app, mt5-host-01"; exit 1 ;;
esac

# ── Remote collection script (runs on the instance via SSM) ─────────────────
read -r -d '' REMOTE_LINUX <<'EOF' || true
#!/bin/bash
echo "=== HOST ==="
echo "uptime: $(uptime -p) | $(uptime | awk -F'load average:' '{print "load:" $2}')"
echo "cpus: $(nproc)"
echo "=== MEMORY (MB) ==="
free -m | awk 'NR==2{printf "total:%s used:%s free:%s available:%s\n",$2,$3,$4,$7} NR==3{printf "swap_total:%s swap_used:%s\n",$2,$3}'
echo "=== DISK ==="
df -h / | awk 'NR==2{printf "total:%s used:%s free:%s pct:%s\n",$2,$3,$4,$5}'
echo "=== CONTAINERS (mem) ==="
sudo docker stats --no-stream --format "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}" 2>/dev/null | head -10
echo "=== CANDLE FRESHNESS ==="
cd /opt/trading-bot/repo 2>/dev/null && sudo docker compose --env-file .env -f docker/docker-compose.yml exec -T postgres \
  psql -U trading -d shamarx -t -A -c \
  "SELECT symbol || ' ' || to_char(now() - MAX(\"openTime\"), 'HH24:MI') FROM \"Candle\" WHERE timeframe='M15' GROUP BY symbol ORDER BY symbol;" 2>/dev/null || echo "n/a"
EOF

# ── Send + collect via SSM ───────────────────────────────────────────────────
PARAMS_FILE="$(mktemp)"
REMOTE_FILE="$(mktemp)"
printf '%s' "$REMOTE_LINUX" > "$REMOTE_FILE"
python3 - "$REMOTE_FILE" "$PARAMS_FILE" <<'PYEOF'
import json, sys
remote = open(sys.argv[1]).read()
json.dump({"commands": remote.splitlines()}, open(sys.argv[2], "w"))
PYEOF
rm -f "$REMOTE_FILE"

CMD_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters "file://$PARAMS_FILE" \
  --region "$REGION" --profile "$PROFILE" \
  --query 'Command.CommandId' --output text)

for _ in $(seq 1 30); do
  STATUS=$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --region "$REGION" --profile "$PROFILE" --query 'Status' --output text 2>/dev/null || echo Pending)
  [[ "$STATUS" == "Success" || "$STATUS" == "Failed" ]] && break
  sleep 2
done

OUTPUT=$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --region "$REGION" --profile "$PROFILE" --query 'StandardOutputContent' --output text)
rm -f "$PARAMS_FILE"

# ── Pretty-print + verdict ───────────────────────────────────────────────────
RAW_OUTPUT="$OUTPUT" python3 - "$TARGET" "$KIND" <<'PYEOF'
import os, re, sys

target, kind = sys.argv[1], sys.argv[2]
raw = os.environ["RAW_OUTPUT"]

def section(name):
    m = re.search(rf"=== {re.escape(name)} ===\n(.*?)(?=\n=== |\Z)", raw, re.S)
    return m.group(1).strip() if m else ""

GOLD, GREEN, RED, DIM, RESET, BOLD = "\033[33m", "\033[32m", "\033[31m", "\033[2m", "\033[0m", "\033[1m"

mem = dict(kv.split(":") for kv in section("MEMORY (MB)").split("\n")[0].split())
swap_line = section("MEMORY (MB)").split("\n")[1] if "\n" in section("MEMORY (MB)") else "swap_total:0 swap_used:0"
swap = dict(kv.split(":") for kv in swap_line.split())
disk = dict(kv.split(":") for kv in section("DISK").split())
host = section("HOST")
cpus = int(re.search(r"cpus: (\d+)", host).group(1))
load1 = float(re.search(r"load:\s*([\d.]+)", host).group(1))

total, avail = int(mem["total"]), int(mem["available"])
used_pct = round(100 * (total - avail) / total)
disk_pct = int(disk["pct"].rstrip("%"))
load_pct = round(100 * load1 / cpus)

print(f"\n{BOLD}◆ SHAMARX HOST STATS · {target}{RESET}  {DIM}({kind}){RESET}")
print(f"{DIM}{'─'*62}{RESET}")
print(f"  {host.splitlines()[0]}")
print(f"  cpu     load {load1:.2f} / {cpus} vCPU  ({load_pct}%)")
print(f"  memory  {total-avail}/{total} MB used ({used_pct}%) · {avail} MB available")
if int(swap.get('swap_used', 0)) > 0:
    print(f"  swap    {RED}{swap['swap_used']}/{swap['swap_total']} MB in use{RESET}")
print(f"  disk    {disk['used']}/{disk['total']} used ({disk_pct}%) · {disk['free']} free")

cont = section("CONTAINERS (mem)")
if cont:
    print(f"\n  {DIM}containers{RESET}")
    for line in cont.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            print(f"    {parts[0]:<24} {parts[1]:<22} {parts[2] if len(parts)>2 else ''}")

fresh = section("CANDLE FRESHNESS")
if fresh and fresh != "n/a":
    print(f"\n  {DIM}candle age (h:mm since last M15){RESET}")
    stale = False
    for line in fresh.splitlines():
        line = line.strip()
        if not line: continue
        age = line.split()[-1]
        h, m = map(int, age.split(":"))
        mark = GREEN + "●" + RESET if h == 0 and m <= 20 else RED + "●" + RESET
        if not (h == 0 and m <= 20): stale = True
        print(f"    {mark} {line}")

# ── Verdict ──────────────────────────────────────────────────────────────────
# Per-account budget on the APP host: each enabled BrokerAccount adds roughly
# 60-120 MB across backend evaluation buffers + execution-service client state.
# (MT5 Direct hosts use 450 MB/terminal — handled by manager /capacity later.)
PER_ACCOUNT_MB = 120
slots = max(0, (avail - 512) // PER_ACCOUNT_MB)  # keep 512 MB OS headroom

issues = []
if used_pct >= 85: issues.append("memory ≥85%")
if load_pct >= 80: issues.append("cpu load ≥80%")
if disk_pct >= 85: issues.append("disk ≥85%")
if int(swap.get('swap_used', 0)) > 100: issues.append("swapping")

print(f"\n{DIM}{'─'*62}{RESET}")
if issues:
    print(f"  {RED}{BOLD}VERDICT: SCALE UP{RESET}  {RED}{', '.join(issues)}{RESET}")
    print(f"  {DIM}resize instance (stop → change type → start, ~10 min) or move{RESET}")
    print(f"  {DIM}services to a second host before adding accounts.{RESET}")
elif used_pct >= 70 or load_pct >= 60:
    print(f"  {GOLD}{BOLD}VERDICT: NEAR CAPACITY{RESET}  ~{slots} more account(s) safely")
    print(f"  {DIM}fine for now — plan the resize before onboarding beyond that.{RESET}")
else:
    print(f"  {GREEN}{BOLD}VERDICT: OK{RESET}  ~{slots} more account(s) safely at current usage")
print()
PYEOF
