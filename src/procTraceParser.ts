import * as fs from 'fs'
import * as readline from 'readline'
import * as logger from './logger.js'
import { CompletedCommand, ProcEventParseOptions } from './interfaces/index.js'

const SYS_PROCS_TO_BE_IGNORED: Set<string> = new Set([
  'awk',
  'basename',
  'cat',
  'cut',
  'date',
  'echo',
  'envsubst',
  'expr',
  'dirname',
  'grep',
  'head',
  'id',
  'ip',
  'ln',
  'ls',
  'lsblk',
  'mkdir',
  'mktemp',
  'mv',
  'ps',
  'readlink',
  'rm',
  'sed',
  'seq',
  'sh',
  'uname',
  'whoami'
])

/**
 * Matches a line of `forkstat -e fork,exec,exit -x` output:
 *
 * ```
 * Time     Event     PID     UID    EUID TTY    Info   Duration Process
 * 18:54:23 fork     2617  runner  runner      ? parent          /usr/bin/bash
 * 18:54:23 fork     2622  runner  runner      ? child           /usr/bin/bash
 * 18:54:23 exec     2622  runner  runner      ?                 /bin/echo hi
 * 18:54:23 exit     2622  runner  runner      ?      0   0.001s /bin/echo hi
 * ```
 *
 * Everything up to the TTY column is common; what follows depends on the
 * event, so it is matched separately.
 */
const LINE = /^(\d{2}:\d{2}:\d{2})\s+(\w+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)(.*)$/
/** `<wait status> <seconds>s <command line>` */
const EXIT_REST = /^\s*(-?\d+)\s+([\d.]+)s\s*(.*)$/
/** `parent|child <command line>` */
const FORK_REST = /^\s*(parent|child)\s+(.*)$/

interface PendingCommand {
  ts: string
  name: string
  user: string
  pid: number
  ppid: number
  startTime: number
  fileName: string
  args: string[]
  order: number
}

/**
 * Turns forkstat's `HH:MM:SS` stamps into epoch milliseconds. forkstat prints
 * no date, so the clock is anchored to when tracing started and rolled forward
 * whenever it wraps past midnight.
 */
export class TraceClock {
  private readonly startOfDayMs: number
  private dayOffsetMs = 0
  private previousSecondOfDay = -1

  constructor(startedAt: Date) {
    const base = new Date(startedAt)
    base.setHours(0, 0, 0, 0)
    this.startOfDayMs = base.getTime()
  }

  toEpochMs(time: string): number {
    const [h, m, s] = time.split(':').map(Number)
    const secondOfDay: number = h * 3600 + m * 60 + s
    // Only a large jump backwards means midnight was crossed. Events are
    // otherwise chronological, and a small wobble must not add a whole day.
    if (
      this.previousSecondOfDay >= 0 &&
      this.previousSecondOfDay - secondOfDay > 12 * 3600
    ) {
      this.dayOffsetMs += 24 * 60 * 60 * 1000
    }
    this.previousSecondOfDay = secondOfDay
    return this.startOfDayMs + secondOfDay * 1000 + this.dayOffsetMs
  }
}

/** Splits a command line into its executable and arguments. */
export function splitCommand(commandLine: string): {
  name: string
  fileName: string
  args: string[]
} {
  const args: string[] = commandLine.trim().split(/\s+/).filter(Boolean)
  const fileName: string = args.length ? args[0] : ''
  // "/usr/bin/node" and "node" both report as "node".
  const name: string = fileName.split('/').pop() || fileName
  return { name, fileName, args }
}

/**
 * Decodes the `Info` column of an exit event, which is the raw wait status:
 * `exit 3` is reported as 768, and a process killed by a signal carries the
 * signal number in the low bits.
 */
export function exitCodeOf(waitStatus: number): number {
  const signal: number = waitStatus & 0x7f
  return signal ? 128 + signal : (waitStatus >> 8) & 0xff
}

export async function parse(
  filePath: string,
  procEventParseOptions: ProcEventParseOptions
): Promise<CompletedCommand[]> {
  const minDuration: number =
    (procEventParseOptions && procEventParseOptions.minDuration) || -1
  const traceSystemProcesses: boolean =
    (procEventParseOptions && procEventParseOptions.traceSystemProcesses) ||
    false
  const clock: TraceClock = new TraceClock(
    procEventParseOptions.startedAt ?? new Date()
  )

  const fileStream: fs.ReadStream = fs.createReadStream(filePath)
  const rl: readline.Interface = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  })

  // Commands that have exec'd but not yet exited, keyed by pid.
  const activeCommands: Map<number, PendingCommand> = new Map()
  // Parent pids learned from fork events, keyed by the child pid.
  const parentOf: Map<number, number> = new Map()
  // forkstat prints the parent line immediately before the matching child.
  let lastForkParentPid = 0
  const completedCommands: CompletedCommand[] = []
  let commandOrder = 0

  for await (const rawLine of rl) {
    const line: string = rawLine.trimEnd()
    if (!line) {
      continue
    }
    const match: RegExpMatchArray | null = line.match(LINE)
    if (!match) {
      // The header line, and anything forkstat writes to stderr.
      continue
    }

    const time: string = match[1]
    const event: string = match[2]
    const pid: number = parseInt(match[3], 10)
    const user: string = match[4]
    const rest: string = match[7]

    if (event === 'fork') {
      const forkMatch: RegExpMatchArray | null = rest.match(FORK_REST)
      if (forkMatch) {
        if (forkMatch[1] === 'parent') {
          lastForkParentPid = pid
        } else if (lastForkParentPid) {
          parentOf.set(pid, lastForkParentPid)
        }
      }
      continue
    }

    if (event === 'exec') {
      const { name, fileName, args } = splitCommand(rest)
      if (!name) {
        continue
      }
      if (!traceSystemProcesses && SYS_PROCS_TO_BE_IGNORED.has(name)) {
        continue
      }
      activeCommands.set(pid, {
        ts: time,
        name,
        user,
        pid,
        ppid: parentOf.get(pid) ?? 0,
        startTime: clock.toEpochMs(time),
        fileName,
        args,
        order: ++commandOrder
      })
      continue
    }

    if (event === 'exit') {
      const exitMatch: RegExpMatchArray | null = rest.match(EXIT_REST)
      if (!exitMatch) {
        continue
      }
      const command: PendingCommand | undefined = activeCommands.get(pid)
      // Threads exit without ever exec'ing, and anything already running when
      // the trace started has no exec event either. Both are skipped.
      if (!command) {
        continue
      }
      activeCommands.delete(pid)

      const duration: number = Math.round(parseFloat(exitMatch[2]) * 1000)
      if (duration <= minDuration) {
        continue
      }
      completedCommands.push({
        ...command,
        duration,
        exitCode: exitCodeOf(parseInt(exitMatch[1], 10))
      })
    }
  }

  completedCommands.sort((a: CompletedCommand, b: CompletedCommand) => {
    const byStart: number = a.startTime - b.startTime
    return byStart !== 0 ? byStart : a.order - b.order
  })

  if (logger.isDebugEnabled()) {
    logger.debug(`Completed commands: ${JSON.stringify(completedCommands)}`)
  }

  return completedCommands
}
