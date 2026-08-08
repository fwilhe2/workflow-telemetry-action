# Changelog

## Unreleased

### Added

- **A `charts` input, and a text renderer behind it.** `charts: sparkline`
  renders the traces and metrics as sparklines and bars in markdown tables. The
  default is unchanged: `mermaid`, exactly as before.

  It is there because mermaid costs the _page_, not the runner. GitHub renders
  every mermaid block in its own sandboxed iframe from
  `viewscreen.githubusercontent.com`, which loads mermaid.js and lays the
  diagram out client-side. This action emits about a dozen blocks per job — one
  gantt for the step trace, one per metric series because `xychart-beta` has no
  legend, one gantt for the process trace — which is nothing on a job page. The
  run summary page concatenates every job's summary, so a build matrix
  multiplies that by the job count: a 77-job workflow asks the browser for
  roughly 850 iframes, and the page becomes unusable long before the telemetry
  stops being worth reading.

  The text form has no such cost and carries the same information at lower
  resolution: a sparkline scaled to its own series for the shape, peak and mean
  columns for the numbers, and a bar placed along the job's span for each step
  and process — the same picture a gantt draws. Worth setting on a workflow with
  dozens of jobs; not worth it on a workflow with five, which is why it is not
  the default.

### Fixed

- A process whose extra info contained a colon could break the mermaid gantt:
  the `#colon;` escape was applied to the process name but not to the action
  name appended after it.

### Security

- The stat collector worker no longer serialises an exception's name and message
  into its HTTP 500 body (`js/stack-trace-exposure`). The cause still goes to the
  job log, which is where it is wanted; the only client raises its own error from
  the status code and never read that body.

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
- `WORKFLOW_TELEMETRY_SERVER_PORT` moved the stat server but not the collector
  reading from it, which had the port hardcoded, so setting it broke metrics
  entirely. Both sides read it now.
- `POST /collect` answered before the sample it triggered had been recorded: it
  awaited a function that returned an array of promises without awaiting them.
  The post step calls it to capture the tail of the job and then reads the
  histograms straight away, so that last sample could be missing from the
  charts.

### Changed

- **Runs on Node 24** (`runs.using: node24`); requires a runner with the Node 24
  action runtime.
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

### Added

- A `proc_trace_enable` input (default `true`). Process tracing is the only part
  of the action that installs anything or needs `sudo`; turning it off leaves
  resource metrics untouched and costs nothing to set up. Useful on workflows
  with many short jobs.
- forkstat is now installed without a preceding `apt-get update`, which is only
  run if installing straight away fails. Measured on runners, this saves 3.2s of
  8.6s on x64 and 3.4s of 12.5s on arm64.
- Unit tests (Jest) for the process trace parser and the chart rendering.
- `tests/smoke-test.sh`, which checks the built bundles import only Node
  builtins, load, and that the stat collector serves metrics over HTTP.
- CI runs the action against itself on x64 **and** arm64, and asserts the
  process tracer actually captured events.
- A `releases/vN` branch per major version, created and fast-forwarded by the
  `Release` workflow, so an old major can still be fixed after `main` has moved
  on. The workflow refuses to release if that branch holds commits the released
  ref does not, and marks a release _Latest_ only when it really is the newest
  version in the repository.

### Removed

- **The `theme` input.** It selected a light or dark palette for the chart
  images that were rendered by the external service; Mermaid follows the
  reader's own GitHub theme, so there is nothing left for it to choose. A
  workflow that still passes it gets an "Unexpected input" warning annotation
  and otherwise runs normally.
- **The `proc_trace_chart_show` input.** The chart is why the process trace
  exists, and turning it off still paid for the `forkstat` install and the
  `sudo`, usually to produce an empty _Process Trace_ heading. Use
  `proc_trace_enable: false` to skip tracing altogether.
- **The `proc_trace_sys_enable` input**, and the hardcoded list of 28 process
  names behind it. It filtered on name alone, so it could not tell a build's own
  `sh` from a wrapper's, and the list had not been touched since it was written.
  `proc_trace_min_duration` filters on something real. Traces now include short
  system processes by default; the chart is unaffected, since it already shows
  only the longest-running processes.
- Two collected-but-never-plotted metric fields, `CPUStats.totalLoad` and
  `MemoryStats.totalMemoryMb`.
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
