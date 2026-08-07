# workflow-telemetry-action

A GitHub Action to track and monitor the

- workflow runs, jobs and steps
- resource metrics
- and process activities

of your GitHub Action workflow runs. If the run is triggered via a Pull Request,
it will create a comment on the connected PR with the results and/or publishes
the results to the job summary.

The action traces the jobs' step executions and shows them in trace chart,

And collects the following metrics:

- CPU Load (user and system) in percentage
- Memory usage (used and free) in MB
- Network I/O (read and write) in MB
- Disk I/O (read and write) in MB

And traces the process executions (Linux runners, x64 and arm64)

as trace chart with the following information:

- Name
- Start time
- Duration (in ms)
- Finish time
- Exit status as success or fail (highlighted as red)

and as trace table with the following information:

- Name
- Id
- Parent id
- User id
- Start time
- Duration (in ms)
- Exit code
- File name
- Arguments

> **Note on process tracing** Process tracing uses
> [forkstat](https://github.com/ColinIanKing/forkstat), installed from the
> distribution's package manager on first use. It reads the kernel's
> process-event connector, so it needs `sudo` but no eBPF, kernel headers or a
> matching kernel version, and works on x64 and arm64 alike. Earlier versions
> shipped prebuilt closed-source x86-64 eBPF binaries in `dist/`, which only ran
> on Ubuntu 20.04 and 22.04 and therefore stopped working entirely once the
> runners moved on. If `forkstat` cannot be installed, tracing is skipped and
> the rest of the telemetry still works.

> **Note on charts** Resource metrics are rendered as
> [Mermaid](https://mermaid.js.org/) charts, which GitHub renders natively in
> job summaries and pull request comments. Earlier versions posted the data to a
> third-party chart-image service that no longer exists, so those charts came
> out broken. Nothing is sent anywhere now.

### Example Output

An example output of a simple workflow run will look like this.

![Step Trace Example](/images/step-trace-example.png)

![Metrics Example](/images/metrics-example.png)

![Process Trace Example](/images/proc-trace-example.png)

## Usage

To use the action, add the following step before the steps you want to track.

```yaml
permissions:
  pull-requests: write
jobs:
  workflow-telemetry-action:
    runs-on: ubuntu-latest
    steps:
      - name: Collect Workflow Telemetry
        uses: catchpoint/workflow-telemetry-action@v2
```

## Configuration

| Option                       | Requirement | Description                                                                                                                                                                                      |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `github_token`               | Optional    | An alternative GitHub token, other than the default provided by GitHub Actions runner.                                                                                                           |
| `metric_frequency`           | Optional    | Metric collection frequency in seconds. Must be a number. Defaults to `5`.                                                                                                                       |
| `proc_trace_min_duration`    | Optional    | Puts minimum limit for process execution duration to be traced. Must be a number. Defaults to `-1` which means process duration filtering is not applied.                                        |
| `proc_trace_sys_enable`      | Optional    | Enables tracing default system processes (`aws`, `cat`, `sed`, ...). Defaults to `false`.                                                                                                        |
| `proc_trace_chart_show`      | Optional    | Enables showing traced processes in trace chart. Defaults to `true`.                                                                                                                             |
| `proc_trace_chart_max_count` | Optional    | Maximum number of processes to be shown in trace chart (applicable if `proc_trace_chart_show` input is `true`). Must be a number. Defaults to `100`.                                             |
| `proc_trace_table_show`      | Optional    | Enables showing traced processes in trace table. Defaults to `true`.                                                                                                                             |
| `comment_on_pr`              | Optional    | Set to `true` to publish the results as comment to the PR (applicable if workflow run is triggered by PR). Defaults to `true`. <br/> Requires `pull-requests: write` permission                  |
| `job_summary`                | Optional    | Set to `true` to publish the results as part of the [job summary page](https://github.blog/2022-05-09-supercharging-github-actions-with-job-summaries/) of the workflow run. Defaults to `true`. |
| `theme`                      | Optional    | **Deprecated and ignored.** Charts are rendered with Mermaid, which follows the reader's GitHub theme automatically.                                                                             |

## Development

This action follows the layout of
[actions/typescript-action](https://github.com/actions/typescript-action): the
sources in `src/` are TypeScript ES modules, bundled by
[rollup](https://rollupjs.org/) into the self-contained bundles under `dist/`
that the runner actually executes.

Requires Node.js 24 (see `.node-version`).

```bash
npm ci
npm run all
```

`npm run all` formats, lints, runs the unit tests, rebuilds `dist/` and then
smoke tests the bundles. The individual steps are:

| Script                 | What it does                                                       |
| ---------------------- | ------------------------------------------------------------------ |
| `npm run lint`         | ESLint over the whole repo                                         |
| `npm test`             | Jest unit tests in `__tests__/`                                    |
| `npm run package`      | Rebuilds the four bundles in `dist/`                               |
| `npm run smoke-test`   | Loads the built bundles and exercises the stat collector over HTTP |
| `npm run format:write` | Formats with Prettier                                              |

`dist/` is committed, so **rebuild and commit it with every source change** —
the `Check Transpiled JavaScript` workflow fails when it drifts from `src/`.
Note that `dist/proc-tracer/` holds prebuilt binaries that are not generated
from source, so only the four bundle directories are ever rebuilt.

### Why the bundles are split

| Bundle      | Entry point                  | Purpose                                    |
| ----------- | ---------------------------- | ------------------------------------------ |
| `dist/main` | `src/main.ts`                | The action's `main` step                   |
| `dist/post` | `src/post.ts`                | The action's `post` step, reports results  |
| `dist/sc`   | `src/statCollector.ts`       | Stat collector                             |
| `dist/scw`  | `src/statCollectorWorker.ts` | Spawned as its own process, serves metrics |
