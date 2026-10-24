#!/bin/sh
# Checks the Docker image the way a server runs it (--network host, a volume for the home): the version, a non-root user,
# doctor naming what's missing, the link overhand open prints, the healthcheck, sign-ins answering with the command to
# run instead of running an agent, setup refusing Claude without a sign-in, a project added from a local git repo, the
# Host check and pairing, and a restart keeping it all. Nothing signs in and no agent runs.
#   sh release/docker-check.sh            build the image from the Dockerfile, check it, remove it
#   sh release/docker-check.sh <image>    check an image you built
# CHECK_PORT picks the port (default 4497), never 4317. On a Linux host it also checks the host's own 127.0.0.1 reaches it.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${CHECK_PORT:-4497}"
NAME="overhand-check-$$"
IMAGE="${1:-}"
BUILT=""
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$NAME" >/dev/null 2>&1 || true
  if [ -n "$BUILT" ]; then docker image rm "$IMAGE" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

fail() {
  echo "✗ $*" >&2
  docker logs --tail 40 "$NAME" >&2 2>&1 || true
  exit 1
}

if [ -z "$IMAGE" ]; then
  IMAGE="overhand-check:$$"
  BUILT=1
  docker build -q -t "$IMAGE" "$ROOT" >/dev/null
fi
docker run -d --name "$NAME" --network host -e OVERHAND_PORT="$PORT" -v "$NAME:/home/overhand" "$IMAGE" >/dev/null

B="http://127.0.0.1:${PORT}"
# every request from inside the container: on Docker Desktop the host network is its VM's, not this machine's
# every local call needs the install's key, made on first use in its control folder, as the CLI sends it
get() { docker exec "$NAME" sh -c 'curl -s -H "x-overhand-key: $(cat "$OVERHAND_HOME/control/local-key" 2>/dev/null)" "$@"' sh "$@"; }
raw() { docker exec "$NAME" curl -s "$@"; }
post() { get -X POST -H "Origin: $B" -H "Content-Type: application/json" -d "$2" "$B$1"; }
code() { get -o /dev/null -w '%{http_code}' "$@"; }
up() {
  i=0
  until [ "$(code "$B/api/state")" = 200 ]; do
    i=$((i + 1))
    [ "$i" -lt 60 ] || fail "no /api/state on port $PORT after 30 s"
    sleep 0.5
  done
}

up
echo "✓ answers /api/state on 127.0.0.1:$PORT"
[ "$(raw -o /dev/null -w '%{http_code}' "$B/api/state")" = 401 ] || fail "a call without the local key got in"
echo "✓ a call without the local key gets 401"
want="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/package.json")"
got="$(docker exec "$NAME" overhand version)"
[ "$got" = "$want" ] || fail "version says $got, package.json says $want"
echo "✓ version $got"
[ "$(docker exec "$NAME" id -u)" != 0 ] || fail "runs as root"
echo "✓ runs as $(docker exec "$NAME" id -un), not root"
if [ "$(uname -s)" = Linux ]; then
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "x-overhand-key: $(docker exec "$NAME" sh -c 'cat "$OVERHAND_HOME/control/local-key"')" "$B/api/state")" = 200 ] || fail "the host's 127.0.0.1:$PORT doesn't reach it"
  echo "✓ the host's own 127.0.0.1:$PORT reaches it"
fi

doctor="$(docker exec "$NAME" overhand doctor || true)"
echo "$doctor" | grep -q "✗ a coding agent on PATH" || fail "doctor doesn't name the missing agent: $doctor"
echo "$doctor" | grep -q "✓ gh on PATH" || fail "no gh in the image: $doctor"
echo "✓ doctor names what's missing"
# the server docs send you to the link `overhand open` prints, through the tunnel
docker exec "$NAME" overhand open | grep -q "http://127.0.0.1:${PORT}/?open=" || fail "overhand open prints no link"
echo "✓ overhand open prints the sign-in link"

r="$(post /api/agent/connect '{"agent":"claude-code"}')"
echo "$r" | grep -q 'claude auth login' || fail "connect answered $r"
echo "✓ sign-in answers with the command to run: no terminal opens, nothing runs"
docker exec "$NAME" sh -c 'mkdir -p ~/Code/demo && cd ~/Code/demo && git init -q -b main &&
  git -c user.email=check@example.com -c user.name=check commit -q --allow-empty -m init &&
  git remote add origin https://github.com/example-org/demo.git'
r="$(post /api/setup '{"setup":{"owner":"check","codeRoot":"~/Code","credential":{"kind":"login","value":""}}}')"
echo "$r" | grep -q 'sign in to Claude Code' || fail "setup without a sign-in answered $r"
echo "✓ setup refuses Claude without a sign-in, and says how"

project='[{"name":"Demo","dir":"demo","prefix":"DEMO","trackerRepo":"example-org/demo"}]'
# a local model's account: nothing to sign in to and nothing billed; no gateway answers, so no agent runs
r="$(post /api/setup "{\"setup\":{\"owner\":\"check\",\"codeRoot\":\"~/Code\",\"projects\":$project,\"credential\":{\"kind\":\"login\",\"value\":\"\"},\"backend\":{\"kind\":\"ollama\",\"model\":\"none\"}}}")"
echo "$r" | grep -q '"ok":true' || fail "setup with a local repo answered $r"
get "$B/api/state" | grep -q '"Demo"' || fail "the project isn't in /api/state"
echo "✓ a project added from a local git repo"

[ "$(code -H 'Host: evil.example' "$B/api/state")" = 403 ] || fail "a foreign Host header wasn't refused"
[ "$(raw -o /dev/null -w '%{http_code}' -H "Host: 127.0.0.1:$PORT" -H 'X-Forwarded-For: 100.64.0.2' "$B/api/state")" = 401 ] || fail "a proxied request got in unpaired"
echo "✓ a foreign Host gets 403, a proxied request 401 until it pairs"

docker restart "$NAME" >/dev/null
up
get "$B/api/state" | grep -q '"Demo"' || fail "the project is gone after a restart"
i=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ]; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || fail "not healthy 60 s after the restart"
  sleep 1
done
echo "✓ after a restart it's back, healthy, with the project kept"
echo "Docker check passed."
