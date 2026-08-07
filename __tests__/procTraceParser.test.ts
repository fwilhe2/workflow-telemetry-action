import { describe, expect, it, beforeAll, afterAll } from '@jest/globals'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { parse } from '../src/procTraceParser.js'
import { CompletedCommand } from '../src/interfaces/index.js'

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-trace-'))
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Writes `lines` to a trace file and parses it back. */
async function parseLines(
  lines: object[],
  options = { minDuration: -1, traceSystemProcesses: true }
): Promise<CompletedCommand[]> {
  const file = path.join(tmpDir, `trace-${Math.random().toString(36).slice(2)}`)
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'))
  return parse(file, options)
}

const exec = (pid: number, name: string, startTime: number): object => ({
  ts: '2024-01-01T00:00:00Z',
  event: 'EXEC',
  name,
  uid: 0,
  pid,
  ppid: '1',
  startTime,
  fileName: `/usr/bin/${name}`,
  args: [name]
})

const exit = (pid: number, duration: number, exitCode = 0): object => ({
  event: 'EXIT',
  pid,
  duration,
  exitCode
})

describe('procTraceParser.parse', () => {
  it('pairs an EXEC with its EXIT into one completed command', async () => {
    const commands = await parseLines([
      exec(100, 'tsc', 1000),
      exit(100, 250, 0)
    ])

    expect(commands).toHaveLength(1)
    expect(commands[0].name).toBe('tsc')
    expect(commands[0].pid).toBe(100)
    expect(commands[0].startTime).toBe(1000)
    // The EXIT event's fields are merged into the EXEC event.
    expect(commands[0].duration).toBe(250)
    expect(commands[0].exitCode).toBe(0)
  })

  it('drops an EXEC that never exited', async () => {
    const commands = await parseLines([exec(100, 'tsc', 1000)])

    expect(commands).toEqual([])
  })

  it('sorts completed commands by start time', async () => {
    const commands = await parseLines([
      exec(1, 'later', 5000),
      exec(2, 'earlier', 1000),
      exit(1, 10),
      exit(2, 10)
    ])

    expect(commands.map((c) => c.name)).toEqual(['earlier', 'later'])
  })

  it('filters out commands at or below minDuration', async () => {
    const commands = await parseLines(
      [exec(1, 'quick', 1000), exit(1, 5), exec(2, 'slow', 2000), exit(2, 500)],
      { minDuration: 100, traceSystemProcesses: true }
    )

    expect(commands.map((c) => c.name)).toEqual(['slow'])
  })

  it('ignores common system processes unless asked to trace them', async () => {
    const lines = [
      exec(1, 'cat', 1000),
      exit(1, 50),
      exec(2, 'node', 2000),
      exit(2, 50)
    ]

    const withoutSysProcs = await parseLines(lines, {
      minDuration: -1,
      traceSystemProcesses: false
    })
    expect(withoutSysProcs.map((c) => c.name)).toEqual(['node'])

    const withSysProcs = await parseLines(lines, {
      minDuration: -1,
      traceSystemProcesses: true
    })
    expect(withSysProcs.map((c) => c.name).sort()).toEqual(['cat', 'node'])
  })

  it('skips blank and malformed lines instead of throwing', async () => {
    const file = path.join(tmpDir, 'malformed')
    fs.writeFileSync(
      file,
      [
        '',
        'not json at all',
        JSON.stringify(exec(1, 'node', 1000)),
        '   ',
        '{"broken": ',
        JSON.stringify(exit(1, 42))
      ].join('\n')
    )

    const commands = await parse(file, {
      minDuration: -1,
      traceSystemProcesses: true
    })

    expect(commands).toHaveLength(1)
    expect(commands[0].name).toBe('node')
    expect(commands[0].duration).toBe(42)
  })

  it('reports a process that was replaced by an exec on the same pid', async () => {
    // A pid execs twice before exiting: the first command is "replaced", and
    // its duration is extended to when the replacing command finished.
    const commands = await parseLines([
      exec(7, 'sh', 1000),
      exec(7, 'node', 1200),
      exit(7, 300)
    ])

    expect(commands.map((c) => c.name)).toEqual(['sh', 'node'])
    const [replaced, actual] = commands
    expect(actual.startTime).toBe(1200)
    expect(actual.duration).toBe(300)
    // sh ran from 1000 until node finished at 1200 + 300.
    expect(replaced.duration).toBe(1200 + 300 - 1000)
  })
})
