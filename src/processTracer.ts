import { ChildProcess, spawn, exec, execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as os from 'os'
import path from 'path'
import * as core from '@actions/core'
import { parse } from './procTraceParser.js'
import { CompletedCommand, WorkflowJobType } from './interfaces/index.js'
import * as logger from './logger.js'
import {
  cell,
  chartMode,
  code,
  formatDuration,
  markdownTable,
  timelineBar
} from './charts.js'

const execFileAsync = promisify(execFile)

const PROC_TRACER_PID_KEY = 'PROC_TRACER_PID'
const PROC_TRACER_STARTED_AT_KEY = 'PROC_TRACER_STARTED_AT'
const PROC_TRACER_OUTPUT_FILE_NAME = 'proc-trace.out'
const DEFAULT_PROC_TRACE_CHART_MAX_COUNT = 100
/** A Node.js GHA's own script, with the action's name as the capture. */
const GHA_SCRIPT = /^\/home\/runner\/work\/_actions\/[^/]+\/([^/]+)\//

let finished = false

/** Where the trace is written. */
function traceFilePath(): string {
  return path.join(os.tmpdir(), PROC_TRACER_OUTPUT_FILE_NAME)
}

/** An action input as a number, falling back when it is unset or not one. */
function numberInput(name: string, fallback: number): number {
  const value: number = parseInt(core.getInput(name))
  return Number.isInteger(value) ? value : fallback
}

/**
 * Locates `forkstat`, installing it if necessary.
 *
 * forkstat watches the kernel's process-event connector, so it reports every
 * exec and exit on the machine without needing eBPF, kernel headers or a
 * matching kernel version. It is packaged for every Debian/Ubuntu release and
 * architecture, which the previous prebuilt x86-64 binaries were not.
 */
async function ensureForkstat(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', ['forkstat'])
    const found: string = stdout.trim()
    if (found) {
      logger.info(`Using forkstat at ${found}`)
      return found
    }
  } catch {
    // Not installed yet; fall through and try to install it.
  }

  if (os.platform() !== 'linux') {
    logger.info(
      `Process tracing is only supported on Linux, not on ${os.platform()}`
    )
    return null
  }

  try {
    logger.info('Installing forkstat ...')
    // `apt-get update` is the expensive half of this, and runner images ship
    // with package lists that are usually good enough, so it is only paid for
    // when installing straight away does not work.
    try {
      await execFileAsync(
        'sudo',
        ['apt-get', 'install', '-y', '-qq', 'forkstat'],
        { timeout: 120000 }
      )
    } catch {
      logger.debug('Installing forkstat needed an apt-get update first')
      await execFileAsync('sudo', ['apt-get', 'update', '-qq'], {
        timeout: 120000
      })
      await execFileAsync(
        'sudo',
        ['apt-get', 'install', '-y', '-qq', 'forkstat'],
        { timeout: 120000 }
      )
    }
    const { stdout } = await execFileAsync('which', ['forkstat'])
    return stdout.trim() || null
  } catch (error) {
    logger.info(
      `Process tracing disabled: could not install forkstat (${logger.messageOf(
        error
      )}). ` +
        `Install the "forkstat" package on the runner to enable process tracing.`
    )
    return null
  }
}

/** Columns of the detail table. A negative width right-aligns the cell. */
const DETAIL_COLUMNS: [header: string, width: number][] = [
  ['TIME', 12],
  ['NAME', 16],
  ['USER', -10],
  ['PID', -7],
  ['PPID', -7],
  ['START TIME', -15],
  ['DURATION (ms)', -15],
  ['EXIT CODE', -10],
  ['FILE NAME + ARGS', 0]
]

/** Lays out one line of the detail table. */
function formatRow(cells: (string | number)[]): string {
  return cells
    .map((value, i) => {
      const width: number = DETAIL_COLUMNS[i][1]
      const text: string = String(value)
      return width < 0 ? text.padStart(-width) : text.padEnd(width)
    })
    .join(' ')
}

/** How a process is named in either renderer. */
function processLabel(command: CompletedCommand): string {
  const extraProcessInfo: string | null = getExtraProcessInfo(command)
  return extraProcessInfo
    ? `${command.name} (${extraProcessInfo})`
    : command.name
}

/** The gantt as text: one row per process, placed along the traced span. */
export function renderProcessTable(commands: CompletedCommand[]): string {
  if (!commands.length) {
    return ''
  }

  const traceStart: number = Math.min(...commands.map((c) => c.startTime))
  const traceEnd: number = Math.max(
    ...commands.map((c) => c.startTime + c.duration)
  )
  const span: number = Math.max(1, traceEnd - traceStart)

  const rows: string[][] = commands.map((command) => {
    const label: string =
      command.exitCode !== 0
        ? `${cell(processLabel(command))} _(exit ${command.exitCode})_`
        : cell(processLabel(command))
    return [
      label,
      formatDuration(command.duration),
      code(
        timelineBar(
          (command.startTime - traceStart) / span,
          (command.startTime + command.duration - traceStart) / span
        )
      )
    ]
  })

  return markdownTable(
    ['Process', 'Duration', `Timeline (${formatDuration(span)})`],
    [':--', '--:', ':--'],
    rows
  )
}

/** Names the action a `node` process belongs to, when it belongs to one. */
function getExtraProcessInfo(command: CompletedCommand): string | null {
  if (command.name !== 'node' || command.args.length < 2) {
    return null
  }
  return command.args[1].match(GHA_SCRIPT)?.[1] ?? null
}

///////////////////////////

export async function start(): Promise<void> {
  if (core.getInput('proc_trace_enable') === 'false') {
    logger.info(
      `Process tracing disabled by the "proc_trace_enable" input. ` +
        `Resource metrics are still collected.`
    )
    return
  }

  logger.info(`Starting process tracer ...`)

  try {
    const forkstat: string | null = await ensureForkstat()
    if (!forkstat) {
      return
    }

    const procTraceOutFilePath: string = traceFilePath()
    // forkstat writes to stdout, so the trace is captured by redirection.
    const out: number = fs.openSync(procTraceOutFilePath, 'w')
    const child: ChildProcess = spawn(
      'sudo',
      [
        forkstat,
        '-e',
        'fork,exec,exit',
        // Extra columns: user, exit status and duration.
        '-x',
        // Line buffered, so nothing is lost when the tracer is interrupted.
        '-l'
      ],
      {
        detached: true,
        stdio: ['ignore', out, 'ignore'],
        env: {
          ...process.env
        }
      }
    )
    child.unref()
    fs.closeSync(out)

    core.saveState(PROC_TRACER_PID_KEY, child.pid?.toString())
    core.saveState(PROC_TRACER_STARTED_AT_KEY, new Date().toISOString())

    logger.info(`Started process tracer`)
  } catch (error) {
    logger.error('Unable to start process tracer')
    logger.error(error)
  }
}

export async function finish(): Promise<void> {
  const procTracePID: string = core.getState(PROC_TRACER_PID_KEY)
  if (!procTracePID) {
    logger.info(
      `Skipped finishing process tracer since process tracer didn't started`
    )
    return
  }
  try {
    logger.debug(
      `Interrupting process tracer with pid ${procTracePID} to stop gracefully ...`
    )

    exec(`sudo kill -s INT ${procTracePID}`)
    finished = true

    logger.info(`Finished process tracer`)
  } catch (error) {
    logger.error('Unable to finish process tracer')
    logger.error(error)
  }
}

export async function report(
  currentJob: WorkflowJobType
): Promise<string | null> {
  logger.info(`Reporting process tracer result ...`)

  if (!finished) {
    logger.info(
      `Skipped reporting process tracer since process tracer didn't finished`
    )
    return null
  }
  try {
    const procTraceOutFilePath: string = traceFilePath()

    logger.info(
      `Getting process tracer result from file ${procTraceOutFilePath} ...`
    )

    const procTraceMinDuration: number = numberInput(
      'proc_trace_min_duration',
      -1
    )
    const procTraceChartMaxCount: number = numberInput(
      'proc_trace_chart_max_count',
      DEFAULT_PROC_TRACE_CHART_MAX_COUNT
    )
    const procTraceTableShow: boolean =
      core.getInput('proc_trace_table_show') === 'true'

    const startedAtState: string = core.getState(PROC_TRACER_STARTED_AT_KEY)
    const completedCommands: CompletedCommand[] = await parse(
      procTraceOutFilePath,
      {
        minDuration: procTraceMinDuration,
        startedAt: startedAtState ? new Date(startedAtState) : new Date()
      }
    )

    ///////////////////////////////////////////////////////////////////////////

    const filteredCommands: CompletedCommand[] = [...completedCommands]
      .sort((a: CompletedCommand, b: CompletedCommand) => {
        return -(a.duration - b.duration)
      })
      .slice(0, procTraceChartMaxCount)
      .sort((a: CompletedCommand, b: CompletedCommand) => {
        let result = a.startTime - b.startTime
        if (result === 0 && a.order && b.order) {
          result = a.order - b.order
        }
        return result
      })

    let traceContent: string

    if (chartMode() === 'mermaid') {
      let chartContent = ''

      chartContent = chartContent.concat('gantt', '\n')
      chartContent = chartContent.concat('\t', `title ${currentJob.name}`, '\n')
      chartContent = chartContent.concat('\t', `dateFormat x`, '\n')
      chartContent = chartContent.concat('\t', `axisFormat %H:%M:%S`, '\n')

      for (const command of filteredCommands) {
        const escapedName = processLabel(command).replace(/:/g, '#colon;')
        chartContent = chartContent.concat('\t', `${escapedName} : `)
        if (command.exitCode !== 0) {
          // to show red
          chartContent = chartContent.concat('crit, ')
        }

        const startTime: number = command.startTime
        const finishTime: number = command.startTime + command.duration
        chartContent = chartContent.concat(
          `${Math.min(startTime, finishTime)}, ${finishTime}`,
          '\n'
        )
      }

      traceContent = `\`\`\`mermaid\n${chartContent}\n\`\`\``
    } else {
      traceContent = renderProcessTable(filteredCommands)
    }

    ///////////////////////////////////////////////////////////////////////////

    let tableContent = ''

    if (procTraceTableShow) {
      tableContent = [
        formatRow(DETAIL_COLUMNS.map(([header]) => header)),
        ...completedCommands.map((command) =>
          formatRow([
            command.ts,
            command.name,
            command.user,
            command.pid,
            command.ppid,
            command.startTime,
            command.duration,
            command.exitCode,
            `${command.fileName} ${command.args.join(' ')}`
          ])
        )
      ].join('\n')
    }

    ///////////////////////////////////////////////////////////////////////////

    const postContentItems: string[] = [
      '',
      '### Process Trace',
      '',
      `#### Top ${procTraceChartMaxCount} processes with highest duration`,
      '',
      traceContent
    ]
    if (procTraceTableShow) {
      postContentItems.push(
        '',
        `#### All processes with detail`,
        '',
        `\`\`\`\n${tableContent}\n\`\`\``
      )
    }

    const postContent: string = postContentItems.join('\n')

    logger.info(`Reported process tracer result`)

    return postContent
  } catch (error) {
    logger.error('Unable to report process tracer result')
    logger.error(error)

    return null
  }
}
