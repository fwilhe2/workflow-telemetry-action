import { ChildProcess, spawn, exec } from 'child_process'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as os from 'os'
import path from 'path'
import * as core from '@actions/core'
import { parse } from './procTraceParser.js'
import { CompletedCommand, WorkflowJobType } from './interfaces/index.js'
import * as logger from './logger.js'

const execFileAsync = promisify(execFile)

const PROC_TRACER_PID_KEY = 'PROC_TRACER_PID'
const PROC_TRACER_STARTED_AT_KEY = 'PROC_TRACER_STARTED_AT'
const PROC_TRACER_OUTPUT_FILE_NAME = 'proc-trace.out'
const DEFAULT_PROC_TRACE_CHART_MAX_COUNT = 100
const GHA_FILE_NAME_PREFIX = '/home/runner/work/_actions/'

let finished = false

/** Where the trace is written. */
function traceFilePath(): string {
  return path.join(os.tmpdir(), PROC_TRACER_OUTPUT_FILE_NAME)
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
    await execFileAsync('sudo', ['apt-get', 'update', '-qq'], {
      timeout: 120000
    })
    await execFileAsync(
      'sudo',
      ['apt-get', 'install', '-y', '-qq', 'forkstat'],
      { timeout: 120000 }
    )
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

/** Lays out one line of the process trace table. */
function formatRow(
  ts: string | number,
  name: string | number,
  user: string | number,
  pid: string | number,
  ppid: string | number,
  startTime: string | number,
  duration: string | number,
  exitCode: string | number,
  command: string
): string {
  return [
    String(ts).padEnd(12),
    String(name).padEnd(16),
    String(user).padStart(10),
    String(pid).padStart(7),
    String(ppid).padStart(7),
    String(startTime).padStart(15),
    String(duration).padStart(15),
    String(exitCode).padStart(10),
    command
  ].join(' ')
}

function getExtraProcessInfo(command: CompletedCommand): string | null {
  // Check whether this is node process with args
  if (command.name === 'node' && command.args.length > 1) {
    const arg1: string = command.args[1]
    // Check whether this is Node.js GHA process
    if (arg1.startsWith(GHA_FILE_NAME_PREFIX)) {
      const actionFile: string = arg1.substring(GHA_FILE_NAME_PREFIX.length)
      const idx1: number = actionFile.indexOf('/')
      const idx2: number = actionFile.indexOf('/', idx1 + 1)
      if (idx1 >= 0 && idx2 > idx1) {
        // If we could find a valid GHA name, use it as extra info
        return actionFile.substring(idx1 + 1, idx2)
      }
    }
  }
  return null
}

///////////////////////////

export async function start(): Promise<boolean> {
  logger.info(`Starting process tracer ...`)

  try {
    const forkstat: string | null = await ensureForkstat()
    if (!forkstat) {
      return false
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

    return true
  } catch (error) {
    logger.error('Unable to start process tracer')
    logger.error(error)

    return false
  }
}

export async function finish(_currentJob: WorkflowJobType): Promise<boolean> {
  logger.info(`Finishing process tracer ...`)

  const procTracePID: string = core.getState(PROC_TRACER_PID_KEY)
  if (!procTracePID) {
    logger.info(
      `Skipped finishing process tracer since process tracer didn't started`
    )
    return false
  }
  try {
    logger.debug(
      `Interrupting process tracer with pid ${procTracePID} to stop gracefully ...`
    )

    exec(`sudo kill -s INT ${procTracePID}`)
    finished = true

    logger.info(`Finished process tracer`)

    return true
  } catch (error) {
    logger.error('Unable to finish process tracer')
    logger.error(error)

    return false
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

    let procTraceMinDuration = -1
    const procTraceMinDurationInput: string = core.getInput(
      'proc_trace_min_duration'
    )
    if (procTraceMinDurationInput) {
      const minProcDurationVal: number = parseInt(procTraceMinDurationInput)
      if (Number.isInteger(minProcDurationVal)) {
        procTraceMinDuration = minProcDurationVal
      }
    }
    const procTraceSysEnable: boolean =
      core.getInput('proc_trace_sys_enable') === 'true'

    const procTraceChartShow: boolean =
      core.getInput('proc_trace_chart_show') === 'true'
    const procTraceChartMaxCountInput: number = parseInt(
      core.getInput('proc_trace_chart_max_count')
    )
    const procTraceChartMaxCount = Number.isInteger(procTraceChartMaxCountInput)
      ? procTraceChartMaxCountInput
      : DEFAULT_PROC_TRACE_CHART_MAX_COUNT
    const procTraceTableShow: boolean =
      core.getInput('proc_trace_table_show') === 'true'

    const startedAtState: string = core.getState(PROC_TRACER_STARTED_AT_KEY)
    const completedCommands: CompletedCommand[] = await parse(
      procTraceOutFilePath,
      {
        minDuration: procTraceMinDuration,
        traceSystemProcesses: procTraceSysEnable,
        startedAt: startedAtState ? new Date(startedAtState) : new Date()
      }
    )

    ///////////////////////////////////////////////////////////////////////////

    let chartContent = ''

    if (procTraceChartShow) {
      chartContent = chartContent.concat('gantt', '\n')
      chartContent = chartContent.concat('\t', `title ${currentJob.name}`, '\n')
      chartContent = chartContent.concat('\t', `dateFormat x`, '\n')
      chartContent = chartContent.concat('\t', `axisFormat %H:%M:%S`, '\n')

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

      for (const command of filteredCommands) {
        const extraProcessInfo: string | null = getExtraProcessInfo(command)
        const escapedName = command.name.replace(/:/g, '#colon;')
        if (extraProcessInfo) {
          chartContent = chartContent.concat(
            '\t',
            `${escapedName} (${extraProcessInfo}) : `
          )
        } else {
          chartContent = chartContent.concat('\t', `${escapedName} : `)
        }
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
    }

    ///////////////////////////////////////////////////////////////////////////

    let tableContent = ''

    if (procTraceTableShow) {
      const commandInfos: string[] = []
      commandInfos.push(
        formatRow(
          'TIME',
          'NAME',
          'USER',
          'PID',
          'PPID',
          'START TIME',
          'DURATION (ms)',
          'EXIT CODE',
          'FILE NAME + ARGS'
        )
      )
      for (const command of completedCommands) {
        commandInfos.push(
          formatRow(
            command.ts,
            command.name,
            command.user,
            command.pid,
            command.ppid,
            command.startTime,
            command.duration,
            command.exitCode,
            `${command.fileName} ${command.args.join(' ')}`
          )
        )
      }

      tableContent = commandInfos.join('\n')
    }

    ///////////////////////////////////////////////////////////////////////////

    const postContentItems: string[] = ['', '### Process Trace']
    if (procTraceChartShow) {
      postContentItems.push(
        '',
        `#### Top ${procTraceChartMaxCount} processes with highest duration`,
        '',
        `\`\`\`mermaid\n${chartContent}\n\`\`\``
      )
    }
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
