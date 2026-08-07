# Changelog

## 3.0.0

First release of this fork. It diverges from
[catchpoint/workflow-telemetry-action](https://github.com/catchpoint/workflow-telemetry-action)
at `f974e0c`, and is a major version because the runtime, the chart output and
the process tracer all changed.

### Fixed

- **Resource metric charts worked again.** The action posted its samples to
  `api.globadge.com`, which no longer exists and answers every request with
  `403`. Every chart failed, the job summary was left full of broken images and
  the log full of `AxiosError`. Charts are now rendered as
  [Mermaid](https://mermaid.js.org/) `xychart` blocks, which GitHub renders
  natively. No request leaves the runner.
- **Process tracing worked again, including on arm64.** Tracing was done by
  prebuilt closed-source x86-64 eBPF binaries committed under
  `dist/proc-tracer/`, gated on Ubuntu 20 or 22 exactly. Since the runners moved
  to 24.04 it had silently been doing nothing, and it could never work on arm64.
  It now uses [forkstat](https://github.com/ColinIanKing/forkstat), installed on
  demand from the distribution's packages, which reads the kernel's
  process-event connector and needs no eBPF, kernel headers or matching kernel
  version. The binaries are gone.
- `/disk_size` in the stat collector was missing a `break` and fell through into
  `/collect`, ending the response twice.
- `npm run lint` only ever linted `src/interfaces/`, because under `sh` the
  `src/**/*.ts` glob matches a single directory level.
- The post step now reports the underlying cause when looking up the workflow
  job fails, instead of swallowing it.
- The `github_token` input was documented but never read: the client took its
  token from the `GITHUB_TOKEN` environment variable instead, so setting the
  input had no effect. It is now used.

### Changed

- **Runs on Node 24** (`runs.using: node24`); requires a runner with the Node 24
  action runtime.
- **`theme` is deprecated and ignored.** Mermaid follows the reader's GitHub
  theme by itself. The input is still accepted so existing workflows keep
  working.
- CPU and memory are drawn as one chart per series rather than a stacked area,
  because `xychart` has no legend.
- The process trace table reports `USER` (a name) instead of a numeric `UID`,
  which is what forkstat provides.
- Process trace start times are second-resolution and durations are
  millisecond-resolution, so bar lengths are exact but absolute placement can be
  off by up to a second.
- Rebuilt on the
  [actions/typescript-action](https://github.com/actions/typescript-action)
  template: ES modules bundled with rollup instead of ncc, flat ESLint config,
  Jest, and `.node-version`.

### Removed

- `dist/sc`, a bundle nothing ever executed. Only `dist/scw` is spawned, and the
  stat collector is bundled into `main`/`post` already.
- Four runtime dependencies: `axios` (replaced by the built-in `fetch`),
  `sprintf-js` (replaced by `padStart`/`padEnd`), `@octokit/action` (replaced by
  `@actions/github`, which is already a dependency) and `@actions/exec`, which
  was never imported. Together with `dist/sc` this roughly halves the size of
  `dist/`; the `post` bundle alone goes from 2.9 MB to 1.2 MB.
- The stale `metrics-example.png` screenshot, which still showed the old
  image-based charts. The README now embeds a live Mermaid example instead,
  which cannot go out of date the same way.

### Security

- Removed the two committed closed-source binaries that ran as root under
  `sudo`. They were built from a `foresight-process-tracer` repository that is
  not public, so they could not be audited or rebuilt. `dist/**` is marked
  `linguist-generated`, so they never appeared in diffs.
- All dependencies updated; `npm audit` reports no vulnerabilities, down
  from 29.
- Added a CodeQL analysis workflow, run on pushes, pull requests and weekly.

### Added

- Unit tests (Jest) for the process trace parser and the chart rendering.
- `tests/smoke-test.sh`, which checks the built bundles import only Node
  builtins, load, and that the stat collector serves metrics over HTTP.
- CI runs the action against itself on x64 **and** arm64, and asserts the
  process tracer actually captured events.
