#!/bin/sh
# Build the add-on image and exercise it end to end with the fake WhatsApp client.
# Needs Docker. Local only: trusted_sources 0.0.0.0/0 is used for the test and is never a default.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
API_KEY="test-api-key-0123456789abcdef"
PORT=18099
BASE="http://127.0.0.1:$PORT"
NAME="whatsapp-gateway-smoke-$$"
IMAGE="whatsapp-gateway-smoke:local"

case "$(uname -m)" in
  arm64 | aarch64)
    PLATFORM=linux/arm64
    BASE_IMAGE=ghcr.io/home-assistant/aarch64-base:3.24
    ;;
  *)
    PLATFORM=linux/amd64
    BASE_IMAGE=ghcr.io/home-assistant/amd64-base:3.24
    ;;
esac

TMP=$(mktemp -d)
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

fail() {
  echo "FAIL: $1" >&2
  docker logs "$NAME" >&2 2>&1 || true
  exit 1
}

# expect_status DESCRIPTION EXPECTED_CODE curl-args...
expect_status() {
  desc=$1 want=$2
  shift 2
  got=$(curl -s -o /dev/null -w '%{http_code}' "$@") || got=000
  [ "$got" = "$want" ] || fail "$desc: expected HTTP $want, got $got"
  echo "ok   $desc ($got)"
}

# expect_body DESCRIPTION PATTERN curl-args...
expect_body() {
  desc=$1 pattern=$2
  shift 2
  body=$(curl -s "$@") || body=""
  printf '%s' "$body" | grep -Eq "$pattern" || fail "$desc: response did not match $pattern"
  echo "ok   $desc"
}

cat >"$TMP/options.json" <<JSON
{
  "api_key": "$API_KEY",
  "pairing_phone_number": "",
  "allowed_targets": [],
  "rate_limit_per_minute": 60,
  "trusted_sources": ["0.0.0.0/0"],
  "log_level": "info"
}
JSON

echo "Building image for $PLATFORM"
docker build --platform "$PLATFORM" --build-arg "BUILD_FROM=$BASE_IMAGE" -t "$IMAGE" "$ROOT/whatsapp_gateway"

docker run -d --name "$NAME" --platform "$PLATFORM" \
  -e GATEWAY_FAKE=1 \
  -v "$TMP/options.json:/data/options.json:ro" \
  -p "127.0.0.1:$PORT:8099" \
  "$IMAGE" >/dev/null

tries=0
until curl -s -f -o /dev/null "$BASE/health"; do
  tries=$((tries + 1))
  [ "$tries" -le 60 ] || fail "gateway did not become healthy"
  sleep 1
done

AUTH="Authorization: Bearer $API_KEY"
expect_status "/health" 200 "$BASE/health"
expect_status "/status without key" 401 "$BASE/status"
expect_status "/status with key" 200 -H "$AUTH" "$BASE/status"
expect_body "/groups lists placeholder groups" 'Family.*Garden Club|Garden Club.*Family' -H "$AUTH" "$BASE/groups"
expect_body "/send to phone and group:Family" '"id":"[A-Za-z0-9]+".*"id":"[A-Za-z0-9]+"' \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"to":["+15555550123","group:Family"],"message":"smoke test"}' "$BASE/send"

# SIGTERM must lead to a clean exit within the 5 second stop timeout.
docker stop -t 5 "$NAME" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
[ "$code" = "0" ] || fail "container exited with $code after SIGTERM"
echo "ok   clean shutdown (exit 0)"
echo "Smoke test passed"
