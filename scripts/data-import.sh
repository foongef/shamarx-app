#!/usr/bin/env bash
# Wrapper invoked by `pnpm data:import` — execs into the execution-service venv
# and runs the Python CLI with all forwarded args.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVC_DIR="${ROOT_DIR}/services/execution-service"
VENV_DIR="${SVC_DIR}/venv"

# Load .env (DATABASE_URL etc.)
if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/.env"
  set +a
fi

if [[ ! -d "${VENV_DIR}" ]]; then
  echo "Creating Python venv at ${VENV_DIR}..."
  python3 -m venv "${VENV_DIR}"
fi

# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

# Always ensure deps are current
pip install --quiet --upgrade pip
pip install --quiet -r "${SVC_DIR}/requirements.txt"

cd "${SVC_DIR}"
exec python import_cli.py "$@"
