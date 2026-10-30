#!/usr/bin/env bash

# Restart helper for ClusterODX-Tapis running from this workspace.

set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${BASE_DIR}"

PID_FILE="clusterodx-tapis.pid"
LOG_DIR="log"
LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-7}"
LOG_FILE="${LOG_DIR}/clusterodx$(date +%Y%m%d).log"
ASR_CONFIG="tapis-config.json"
NODE_CONFIG="${NODE_CONFIG:-clusterodx-config.json}"
# Optional NodeSplat profile (mode 0600; holds grant secrets). Used only if the file exists.
SPLAT_CONFIG="${SPLAT_CONFIG:-splat-config.json}"
SPLAT_ARGS=()
if [[ -f "${SPLAT_CONFIG}" ]]; then
    chmod 600 "${SPLAT_CONFIG}"
    SPLAT_ARGS=(--splat-config "${SPLAT_CONFIG}")
fi

if [[ ! -f "${ASR_CONFIG}" ]]; then
    echo "ASR config ${ASR_CONFIG} not found. Please create it before running restart.sh."
    exit 1
fi

if [[ ! -f "${NODE_CONFIG}" ]]; then
    echo "Node config ${NODE_CONFIG} not found. Please create it before running restart.sh."
    exit 1
fi

if [[ -z "${CLUSTERODX_ADMIN_PASS:-}" ]] && ! node -e '
const fs = require("fs");
const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const hasPassword = typeof config["admin-pass"] === "string" && config["admin-pass"].length > 0;
const usesTapisJwt = config["admin-web-use-tapis-jwt"] === true;
process.exit(hasPassword || usesTapisJwt ? 0 : 1);
' "${NODE_CONFIG}"; then
    echo "ClusterODX admin authentication is not configured."
    echo "Set CLUSTERODX_ADMIN_PASS, set admin-pass in ${NODE_CONFIG}, or enable admin-web-use-tapis-jwt."
    exit 1
fi

if command -v 7z >/dev/null 2>&1; then
    echo "7zip detected: $(command -v 7z)"
else
    echo "WARNING: 7zip not found. Install 7zip to enable seed.zip repair."
fi

PORT="${PORT:-3000}"
ADMIN_CLI_PORT="${ADMIN_CLI_PORT:-8080}"
ADMIN_WEB_PORT="${ADMIN_WEB_PORT:-10000}"
TMP_DIR_ARG="${TMP_DIR:-/corral/clusterodm/tmp}"

if ! [[ "${LOG_RETENTION_DAYS}" =~ ^[0-9]+$ ]] || (( LOG_RETENTION_DAYS < 1 )); then
    echo "LOG_RETENTION_DAYS must be a positive integer."
    exit 1
fi

prune_clusterodx_logs() {
    mkdir -p "${LOG_DIR}"
    find "${LOG_DIR}" -maxdepth 1 -type f -name 'clusterodx*.log' -mtime +"$((LOG_RETENTION_DAYS - 1))" -delete
}

stop_clusterodx() {
    if [[ -f "${PID_FILE}" ]]; then
        local pid
        pid="$(cat "${PID_FILE}")"
        if kill "${pid}" >/dev/null 2>&1; then
            echo "Stopped ClusterODX process ${pid}"
        else
            echo "ClusterODX process ${pid} was not running"
        fi
        rm -f "${PID_FILE}"
    else
        echo "No PID file found, attempting to stop running instance by command match"
        pkill -f "node index.js.*--asr ${ASR_CONFIG}.*--config ${NODE_CONFIG}" >/dev/null 2>&1 || true
    fi
}

start_clusterodx() {
    prune_clusterodx_logs
    echo "Starting ClusterODX-Tapis on port ${PORT} (admin CLI ${ADMIN_CLI_PORT}, admin web ${ADMIN_WEB_PORT}), tmp dir ${TMP_DIR_ARG}"
    node index.js \
        --asr "${ASR_CONFIG}" \
        --config "${NODE_CONFIG}" \
        ${SPLAT_ARGS[@]+"${SPLAT_ARGS[@]}"} \
        --port "${PORT}" \
        --admin-cli-port "${ADMIN_CLI_PORT}" \
        --admin-web-port "${ADMIN_WEB_PORT}" \
        --allow-local-download-bypass true \
        --tmp-dir "${TMP_DIR_ARG}" \
        >> "${LOG_FILE}" 2>&1 &

    echo $! > "${PID_FILE}"
    echo "ClusterODX-Tapis started with PID: $(cat "${PID_FILE}")"
    echo "Logs: ${LOG_FILE}"
}

stop_clusterodx
sleep 3
start_clusterodx
