# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## What this is

A GitHub Action that collects CPU/memory/disk/network metrics, a step trace and
a process trace during a workflow job, and reports them to the job summary (and
optionally as a PR comment).

It is a **hard fork** of `catchpoint/workflow-telemetry-action`, which is
unmaintained. Upstream is dead; do not expect to pull fixes from it. Licence is
**Apache-2.0** (`LICENSE.md`, Copyright 2022 Thundra, Inc.) — upstream's
`package.json` wrongly said MIT and that was corrected here. A fork cannot
relicence inherited code, so leave `LICENSE.md` alone.

## Pull requests always target this repository

GitHub still records this repo as a fork, so `gh pr create` defaults its base to
`catchpoint/workflow-telemetry-action` — a repository we do not own. **Always
pass `--repo fwilhe2/workflow-telemetry-action` and base `main`:**

```bash
gh pr create --repo fwilhe2/workflow-telemetry-action --base main ...
```

Never open, comment on, or push to anything under `catchpoint/`. Opening a pull
request against someone else's repository is public and notifies them, so check
the base before creating one, not after.

## Commands

Requires Node 24 (see `.node-version`).

```bash
npm ci
npm run all          # format, lint, node-version check, unit tests, build, smoke test
```

| Command                                 | Purpose                                               |
| --------------------------------------- | ----------------------------------------------------- |
| `npm test`                              | Jest unit tests (`__tests__/`)                        |
| `npm run package`                       | Rebuild the bundles in `dist/`                        |
| `npm run smoke-test`                    | Load the built bundles, drive the collector over HTTP |
| `npm run lint` / `npm run format:write` | ESLint / Prettier over the repo                       |
| `npm run check:node-version`            | Assert the Node version is declared consistently      |

Run a single test file or test:

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest __tests__/procTraceParser.test.ts
NODE_OPTIONS=--experimental-vm-modules npx jest -t 'decodes a non-zero exit code'
```

## Architecture

Three entry points, each bundled by rollup into its own self-contained ESM file
under `dist/`. They are separate bundles because **`scw` is spawned as its own
OS process** and cannot share a chunk with the entry points:

| Bundle      | Source                       | Role                                     |
| ----------- | ---------------------------- | ---------------------------------------- |
| `dist/main` | `src/main.ts`                | action `main` step: starts the tracers   |
| `dist/post` | `src/post.ts`                | action `post` step: collects and reports |
| `dist/scw`  | `src/statCollectorWorker.ts` | background metrics process               |

The flow:

1. `main` starts three subsystems: `stepTracer` (records step timings from the
   job payload), `statCollector`, `processTracer`.
2. `statCollector.start()` spawns `dist/scw` as a **detached process**, located
   via `import.meta.dirname` + `../scw/index.js`. That path coupling is why the
   `dist/<name>/index.js` layout must not change casually.
3. `scw` samples `systeminformation` on a timer and serves the history over
   **HTTP on localhost:7777** (`/cpu`, `/memory`, `/network`, `/disk`,
   `/disk_size`, `/collect`). `statCollector` reads it back with `fetch`.
4. `processTracer` runs `forkstat` under `sudo`, redirecting its stdout to a
   trace file; `procTraceParser` turns that into `CompletedCommand[]`.
5. `post` finds the current job via the GitHub API, asks each subsystem to
   `finish()` then `report()`, and concatenates the markdown.

State is handed from `main` to `post` through `core.saveState`/`getState`
(process tracer pid, trace start time) — they are separate processes.

### Rendering

There are two renderers, chosen by the `charts` input, and `src/charts.ts` holds
what they share. There is no chart _service_ in either — a previous one was
called over HTTP and disappeared, breaking every chart. Do not reintroduce an
external renderer.

**`sparkline` is the default, and the reason is the page rather than the
runner.** GitHub renders every mermaid block in its own sandboxed iframe from
`viewscreen.githubusercontent.com`, which loads mermaid.js and lays the diagram
out client-side. A dozen of those per job is fine; the run summary page
concatenates _every_ job's summary, so a matrix multiplies the iframe count by
the job count and the page dies while the data is still perfectly good. Text
costs nothing and answers the question these charts are actually asked. So:
**anything added to the summary must have a text form, and it must be the
default.** A new mermaid-only section reintroduces the problem for everyone
running a matrix.

**`mermaid` is what the action has always emitted**, kept for the single job
being investigated: gantt for the step and process traces, `xychart-beta` for
resource metrics. `xychart-beta` has no legend, so multi-series metrics are
drawn as one chart per series — which is where three of every four blocks come
from.

Both renderers consume the same data, so a series is named once: `Metric` in
`statCollector.ts` carries the group, series and unit for the table and the axis
label mermaid additionally needs. `renderMetricTable`, `renderStepTable` and
`renderProcessTable` are exported for the tests, which is the only place the two
forms are compared.

### Process tracing

`forkstat` reads the kernel process-event connector — no eBPF, no kernel
headers, no kernel-version coupling, and it works on x64 and arm64. It is
installed on demand and tracing degrades gracefully to "off" if that fails.
There is deliberately **no distro allowlist**; the previous implementation gated
on Ubuntu 20/22 with committed closed-source x86-64 binaries and had silently
done nothing for a long time.

Parser details that are easy to get wrong (all covered by tests):

- forkstat's exit `Info` column is a **raw wait status**, not an exit code
  (`exit 3` → 768). Decode with `exitCodeOf`.
- `fork` events arrive as a `parent` line immediately followed by a `child`
  line; that pairing is the only source of `ppid`.
- Threads exit without ever exec'ing, so an exit with no matching exec is
  dropped — this is what keeps node's worker threads out of the trace.
- Timestamps are second-resolution with no date, anchored by `TraceClock`;
  durations are millisecond-resolution.

## Constraints that will bite you

**`dist/` is committed and must match `src/`.** Rebuild and commit it with every
source change or the `Check Transpiled JavaScript` workflow fails.
`npm run package` only rebuilds the three generated directories.

**ESM, `module: NodeNext`.** Relative imports need explicit `.js` extensions
(`./logger.js`, `./interfaces/index.js`). There is no `__dirname`; use
`import.meta.dirname`.

**Bundles may import only Node builtins.** `node_modules` is not shipped, so
anything rollup fails to inline breaks at runtime on a runner.
`npm run smoke-test` asserts this. Note `node:`-prefixed builtins such as
`node:sqlite` are absent from `module.builtinModules`.

**Node version is declared in four places** — `action.yml` `runs.using`,
`.node-version`, `engines.node`, `@types/node` — and
`npm run check:node-version` fails if they disagree or if the Dependabot guard
holding `@types/node` at the runtime's major is removed. `@types/node` must
never lead the runtime.

**TypeScript is capped below 6.1** by typescript-eslint's peer range; Dependabot
ignores its majors.

## Verifying changes

Unit tests and the smoke test run locally, but the action's real behaviour
(sudo, forkstat, the GitHub API, job summaries) only shows up on a runner. CI
runs the action **against itself on x64 and arm64**, asserts the process tracer
actually captured fork/exec/exit events, and separately asserts that
`proc_trace_enable: false` installs nothing. Prefer extending those jobs over
reasoning about runner behaviour — and when runner behaviour is unknown, push a
throwaway probe workflow to measure it rather than guessing.

## Releasing

`npm version`-style bumps are not used. Edit `version` in `package.json`, then
run the `Release` workflow **from the ref being released** (it has a `dry_run`
input). It refuses to release when `dist/` is stale, the tag exists, or
`releases/vN` holds commits the released ref does not.

Three refs move: the immutable `vX.Y.Z` tag, the `vN` major tag users reference
in `uses:`, and the `releases/vN` branch, which is fast-forwarded (never forced)
so an old major stays maintainable after `main` moves on. The GitHub release is
marked _Latest_ only when the version really is the highest in the repo, so
back-porting to an older major does not steal the label from a newer one.
