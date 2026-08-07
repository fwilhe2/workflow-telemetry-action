#!/usr/bin/env bash
#
# Integration smoke test for the bundled action in dist/.
#
# The unit tests under __tests__/ cover source modules in isolation. This
# script checks the thing that actually ships: the rollup bundles. It verifies
# they import nothing but Node builtins (anything else would not resolve on a
# runner, since node_modules is not published), that each one loads, and that
# the stat collector really serves metrics over HTTP.

set -euo pipefail

cd "$(dirname "$0")/.."

PORT=${SMOKE_TEST_PORT:-7799}
BUNDLES=(dist/main/index.js dist/post/index.js dist/scw/index.js)
fail=0

note() { echo "  $*"; }
ok() { echo "PASS: $*"; }
bad() {
  echo "FAIL: $*"
  fail=1
}

echo "== Checking bundles import only Node builtins =="
for bundle in "${BUNDLES[@]}"; do
  if [[ ! -f $bundle ]]; then
    bad "$bundle is missing (run 'npm run package')"
    continue
  fi
  external=$(node -e "
    import('node:module').then(({ builtinModules }) => {
      const fs = require('node:fs')
      const src = fs.readFileSync('$bundle', 'utf8')
      const builtin = new Set(builtinModules)
      const bad = []
      for (const m of src.matchAll(/^import[^;]*?from\s*'([^']+)'/gm)) {
        // A 'node:' prefix can only ever name a builtin. Some of them
        // (node:sqlite, node:test, ...) are absent from builtinModules
        // because they are reachable *only* via the prefixed form.
        if (m[1].startsWith('node:')) continue
        if (!builtin.has(m[1])) bad.push(m[1])
      }
      console.log([...new Set(bad)].join(', '))
    })
  ")
  if [[ -n $external ]]; then
    bad "$bundle imports non-builtin modules: $external"
    note "these will not resolve on a runner - the bundle is incomplete"
  else
    ok "$(basename "$(dirname "$bundle")")/index.js is self-contained"
  fi
done

if [[ $fail -ne 0 ]]; then
  exit 1
fi

echo
echo "== Checking every bundle loads under $(node --version) =="
# `main` and `post` talk to the GitHub API, so they are only loaded, not run to
# completion. Loading is enough to surface missing or broken modules.
for bundle in dist/main/index.js dist/post/index.js; do
  name=$(basename "$(dirname "$bundle")")
  if err=$(node --input-type=module -e "await import('./$bundle')" 2>&1 >/dev/null); then
    ok "$name loaded"
  elif grep -qiE 'cannot find (module|package)|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED|is not a function|not defined' <<<"$err"; then
    bad "$name failed to load"
    note "$(head -n 3 <<<"$err")"
  else
    # Runtime errors from talking to GitHub/the network are expected here.
    ok "$name loaded (exited with a runtime error, not a module error)"
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
  count=$(node -e "
    const d = require('/tmp/smoke-body.json')
    if (!Array.isArray(d) || d.length === 0) process.exit(1)
    if (typeof d[0].time !== 'number') process.exit(1)
    console.log(d.length)
  " 2>/dev/null) || {
    bad "GET /$endpoint returned no usable samples: $(head -c 120 /tmp/smoke-body.json)"
    continue
  }
  ok "GET /$endpoint returned $count sample(s)"
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
