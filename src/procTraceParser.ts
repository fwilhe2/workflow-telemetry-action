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
 * A raw event as emitted by the process tracer. An EXEC event accumulates the
 * fields of its matching EXIT event until it is complete enough to be reported
 * as a `CompletedCommand`.
 */
interface TraceEvent {
  [key: string]: unknown
  event: string
  name: string
  pid: number
  startTime: number
  duration: number
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

  const fileStream: fs.ReadStream = fs.createReadStream(filePath)
  const rl: readline.Interface = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  })
  // Note: we use the crlfDelay option to recognize all instances of CR LF
  // ('\r\n') in input file as a single line break.

  const activeCommands: Map<number, TraceEvent> = new Map<number, TraceEvent>()
  const replacedCommands: Map<number, TraceEvent> = new Map<
    number,
    TraceEvent
  >()
  const completedCommands: CompletedCommand[] = []
  let commandOrder = 0

  for await (let line of rl) {
    line = line.trim()
    if (!line || !line.length) {
      continue
    }
    try {
      if (logger.isDebugEnabled()) {
        logger.debug(`Parsing trace process event: ${line}`)
      }
      const event: TraceEvent = JSON.parse(line)
      event.order = ++commandOrder
      if (!traceSystemProcesses && SYS_PROCS_TO_BE_IGNORED.has(event.name)) {
        continue
      }
      if ('EXEC' === event.event) {
        const existingCommand = activeCommands.get(event.pid)
        activeCommands.set(event.pid, event)
        if (existingCommand) {
          replacedCommands.set(event.pid, existingCommand)
        }
      } else if ('EXIT' === event.event) {
        let activeCommandCompleted = false
        let replacedCommandCompleted = false

        // Process active command
        const activeCommand = activeCommands.get(event.pid)
        activeCommands.delete(event.pid)
        if (activeCommand) {
          for (const key of Object.keys(event)) {
            if (!Object.prototype.hasOwnProperty.call(activeCommand, key)) {
              activeCommand[key] = event[key]
            }
          }
          activeCommandCompleted = true
        }

        // Process replaced command if there is
        const replacedCommand = replacedCommands.get(event.pid)
        replacedCommands.delete(event.pid)
        if (replacedCommand && activeCommandCompleted) {
          for (const key of Object.keys(event)) {
            if (!Object.prototype.hasOwnProperty.call(replacedCommand, key)) {
              replacedCommand[key] = event[key]
            }
          }
          const finishTime: number =
            activeCommand!.startTime + activeCommand!.duration
          replacedCommand.duration = finishTime - replacedCommand.startTime
          replacedCommandCompleted = true
        }

        // Complete the replaced command first if there is
        if (
          replacedCommandCompleted &&
          replacedCommand!.duration > minDuration
        ) {
          completedCommands.push(replacedCommand as unknown as CompletedCommand)
        }

        // Then complete the actual command
        if (activeCommandCompleted && activeCommand!.duration > minDuration) {
          completedCommands.push(activeCommand as unknown as CompletedCommand)
        }
      } else {
        if (logger.isDebugEnabled()) {
          logger.debug(`Unknown trace process event: ${line}`)
        }
      }
    } catch (error) {
      logger.debug(`Unable to parse process trace event (${error}): ${line}`)
    }
  }

  completedCommands.sort((a: CompletedCommand, b: CompletedCommand) => {
    return a.startTime - b.startTime
  })

  if (logger.isDebugEnabled()) {
    logger.debug(`Completed commands: ${JSON.stringify(completedCommands)}`)
  }

  return completedCommands
}
