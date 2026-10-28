#!/usr/bin/env bash
# Recreates the disposable EdgeEver instance with a brand-new data directory.
# The data dir must stay under <project>/.work; anything else is refused.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORK_DIR="$PROJECT_ROOT/.work"

if [[ -f "$WORK_DIR/secrets.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$WORK_DIR/secrets.env"
  set +a
fi

: "${EDGEEVER_E2E_PASSWORD:?EDGEEVER_E2E_PASSWORD is required (source .work/secrets.env)}"

CONTAINER_NAME="${EDGEEVER_E2E_CONTAINER:-edgeever-e2e}"
IMAGE="${EDGEEVER_E2E_IMAGE:-ghcr.io/tianma-if/edgeever:v2.12.0}"
HOST_PORT="${EDGEEVER_E2E_PORT:-18787}"
USERNAME="${EDGEEVER_E2E_USERNAME:-admin}"
REUSE="${EDGEEVER_E2E_KEEP_DATA:-0}"

DATA_DIR="${EDGEEVER_E2E_DATA_DIR:-$WORK_DIR/e2e-data}"
RESOLVED_WORK="$(readlink -m "$WORK_DIR")"
RESOLVED_DATA="$(readlink -m "$DATA_DIR")"
case "$RESOLVED_DATA" in
  "$RESOLVED_WORK"/*) ;;
  *) echo "Refusing to delete data dir outside $RESOLVED_WORK: $RESOLVED_DATA" >&2; exit 2 ;;
esac
if [[ "$RESOLVED_DATA" == "$RESOLVED_WORK" ]]; then
  echo "Refusing to use the .work directory itself as data dir" >&2
  exit 2
fi

echo "[reset] removing container $CONTAINER_NAME"
podman rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

if [[ "$REUSE" != "1" ]]; then
  echo "[reset] recreating data dir $RESOLVED_DATA"
  # Rootless podman maps container uid 1000 to a subuid, so the host user cannot
  # delete its files directly; remove them inside the user namespace instead.
  podman unshare rm -rf -- "$RESOLVED_DATA"
fi
mkdir -p "$RESOLVED_DATA"
# The container runs as uid 1000; bind mounts must be owned accordingly.
podman unshare chown 1000:1000 "$RESOLVED_DATA"

echo "[reset] starting $IMAGE on 127.0.0.1:$HOST_PORT"
podman run -d --name "$CONTAINER_NAME" --init \
  -p "127.0.0.1:${HOST_PORT}:8787" \
  -e EDGE_EVER_AUTH_USERNAME="$USERNAME" \
  -e EDGE_EVER_AUTH_PASSWORD="$EDGEEVER_E2E_PASSWORD" \
  -v "${RESOLVED_DATA}:/data:Z" \
  "$IMAGE" >/dev/null

echo "[reset] waiting for http://127.0.0.1:${HOST_PORT}/api/health"
for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/api/health" >/dev/null 2>&1; then
    echo "[reset] instance ready"
    exit 0
  fi
  sleep 0.5
done

echo "[reset] instance did not become healthy; recent logs:" >&2
podman logs --tail 40 "$CONTAINER_NAME" >&2 || true
exit 1
