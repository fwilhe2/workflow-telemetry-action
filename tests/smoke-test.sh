#!/usr/bin/env bash
#
# Smoke test for the bundled action in dist/.
#
# `ncc` happily emits a bundle containing `webpackMissingModule` stubs when it
# cannot resolve a dependency (this happens for ESM-only packages, which cannot
# be bundled into a CommonJS output). The build still exits 0, so the breakage
# only shows up at runtime inside a real workflow. These checks catch it here.

set -euo pipefail

cd "$(dirname "$0")/.."

PORT=${SMOKE_TEST_PORT:-7799}
fail=0

note() { echo "  $*"; }
ok() { echo "PASS: $*"; }
bad() {
  echo "FAIL: $*"
  fail=1
}

echo "== Checking bundles exist and are free of unresolved modules =="
for bundle in dist/main/index.js dist/post/index.js dist/sc/index.js dist/scw/index.js; do
  if [[ ! -f $bundle ]]; then
    bad "$bundle is missing (run 'npm run package')"
    continue
  fi
  if grep -q 'webpackMissingModule' "$bundle"; then
    bad "$bundle contains unresolved modules (webpackMissingModule)"
    note "a dependency could not be bundled - most likely it is ESM-only"
  else
    ok "$bundle bundled cleanly"
  fi
done

if [[ $fail -ne 0 ]]; then
  exit 1
fi

echo
echo "== Checking every bundle loads under $(node --version) =="
# `main` and `post` talk to the GitHub API, so they are only loaded, not run to
# completion. Loading is enough to surface missing/broken modules.
for bundle in dist/main/index.js dist/post/index.js dist/sc/index.js; do
  if err=$(node -e "require('./$bundle')" 2>&1 >/dev/null); then
    ok "$bundle loaded"
  elif grep -qi 'cannot find module\|is not a function\|not defined\|ERR_REQUIRE_ESM' <<<"$err"; then
    bad "$bundle failed to load"
    note "$(head -n 3 <<<"$err")"
  else
    # Runtime errors from talking to GitHub/the network are expected here.
    ok "$bundle loaded (exited with a runtime error, not a module error)"
  fi
done

echo
echo "== Exercising the stat collector worker over HTTP =="
WORKFLOW_TELEMETRY_SERVER_PORT=$PORT WORKFLOW_TELEMETRY_STAT_FREQ=1000 \
  node dist/scw/index.js >/tmp/smoke-scw.log 2>&1 &
worker_pid=$!
trap 'kill $worker_pid 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  curl -fsS -o /dev/null "http://localhost:$PORT/cpu" 2>/dev/null && break
  sleep 0.25
done

if ! kill -0 $worker_pid 2>/dev/null; then
  bad "stat collector worker died on startup"
  cat /tmp/smoke-scw.log
  exit 1
fi

# Give the collector time to record at least one sample.
sleep 2
curl -fsS -X POST -o /dev/null "http://localhost:$PORT/collect"
sleep 1

for endpoint in cpu memory network disk disk_size; do
  code=$(curl -s -o /tmp/smoke-body.json -w '%{http_code}' "http://localhost:$PORT/$endpoint")
  if [[ $code != 200 ]]; then
    bad "GET /$endpoint returned HTTP $code"
    continue
  fi
  if node -e "
    const d = require('/tmp/smoke-body.json')
    if (!Array.isArray(d) || d.length === 0) process.exit(1)
    if (typeof d[0].time !== 'number') process.exit(1)
  " 2>/dev/null; then
    ok "GET /$endpoint returned $(node -p "require('/tmp/smoke-body.json').length") sample(s)"
  else
    bad "GET /$endpoint returned no usable samples: $(head -c 120 /tmp/smoke-body.json)"
  fi
done

# /disk_size used to fall through into /collect for lack of a `break`, which
# ended the response twice.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:$PORT/disk_size")
[[ $code == 405 ]] && ok "POST /disk_size returned 405" || bad "POST /disk_size returned $code, expected 405"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:$PORT/cpu")
[[ $code == 405 ]] && ok "POST /cpu returned 405" || bad "POST /cpu returned $code, expected 405"

code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/nope")
[[ $code == 404 ]] && ok "GET /nope returned 404" || bad "GET /nope returned $code, expected 404"

echo
if [[ $fail -ne 0 ]]; then
  echo "Smoke test FAILED"
  echo "--- worker output ---"
  cat /tmp/smoke-scw.log
  exit 1
fi

echo "Smoke test passed"
