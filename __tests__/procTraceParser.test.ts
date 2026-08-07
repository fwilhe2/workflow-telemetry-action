import { describe, expect, it, beforeAll, afterAll } from '@jest/globals'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  TraceClock,
  exitCodeOf,
  parse,
  splitCommand
} from '../src/procTraceParser.js'
import { CompletedCommand } from '../src/interfaces/index.js'

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-trace-'))
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const HEADER =
  'Time     Event     PID     UID    EUID TTY    Info   Duration Process'

/** The trace always starts on this date, so timestamps are predictable. */
const STARTED_AT = new Date('2024-05-01T18:00:00')

async function parseLines(
  lines: string[],
  options: { minDuration?: number } = {}
): Promise<CompletedCommand[]> {
  const file = path.join(tmpDir, `trace-${Math.random().toString(36).slice(2)}`)
  fs.writeFileSync(file, [HEADER, ...lines].join('\n'))
  return parse(file, {
    minDuration: options.minDuration ?? -1,
    startedAt: STARTED_AT
  })
}

// Lines below are copied from real `forkstat -e fork,exec,exit -x` output.
const forkParent = (pid: number, cmd = '/usr/bin/bash'): string =>
  `18:54:23 fork     ${pid}  runner  runner      ? parent          ${cmd} `
const forkChild = (pid: number, cmd = '/usr/bin/bash'): string =>
  `18:54:23 fork     ${pid}  runner  runner      ? child           ${cmd} `
const execLine = (pid: number, cmd: string, time = '18:54:23'): string =>
  `${time} exec     ${pid}  runner  runner      ?                 ${cmd} `
const exitLine = (
  pid: number,
  status: number,
  seconds: string,
  cmd: string,
  time = '18:54:23'
): string =>
  `${time} exit     ${pid}  runner  runner      ? ${String(status).padStart(6)}   ${seconds}s ${cmd} `

describe('exitCodeOf', () => {
  it('decodes a normal exit from the raw wait status', () => {
    // `sh -c "exit 3"` is reported by forkstat as 768.
    expect(exitCodeOf(768)).toBe(3)
    expect(exitCodeOf(10752)).toBe(42)
    expect(exitCodeOf(1792)).toBe(7)
    expect(exitCodeOf(0)).toBe(0)
  })

  it('reports a signalled process as 128 + signal', () => {
    expect(exitCodeOf(9)).toBe(137) // SIGKILL
    expect(exitCodeOf(15)).toBe(143) // SIGTERM
  })
})

describe('splitCommand', () => {
  it('takes the basename of the executable as the name', () => {
    expect(splitCommand('/usr/bin/node -e x')).toEqual({
      name: 'node',
      fileName: '/usr/bin/node',
      args: ['/usr/bin/node', '-e', 'x']
    })
  })

  it('handles a bare command with no path', () => {
    expect(splitCommand('node -e x').name).toBe('node')
  })

  it('returns an empty name for a blank command line', () => {
    expect(splitCommand('   ').name).toBe('')
  })
})

describe('TraceClock', () => {
  it('anchors a time-only stamp to the start date', () => {
    const clock = new TraceClock(new Date('2024-05-01T18:00:00'))

    expect(clock.toEpochMs('18:54:23')).toBe(
      new Date('2024-05-01T18:54:23').getTime()
    )
  })

  it('rolls over to the next day when the clock wraps', () => {
    const clock = new TraceClock(new Date('2024-05-01T23:59:00'))

    const before = clock.toEpochMs('23:59:59')
    const after = clock.toEpochMs('00:00:01')

    expect(after - before).toBe(2000)
  })
})

describe('parse', () => {
  it('pairs an exec with its exit', async () => {
    const commands = await parseLines([
      execLine(2622, '/bin/echo hi'),
      exitLine(2622, 0, '0.001', '/bin/echo hi')
    ])

    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({
      name: 'echo',
      fileName: '/bin/echo',
      args: ['/bin/echo', 'hi'],
      pid: 2622,
      user: 'runner',
      duration: 1,
      exitCode: 0,
      ts: '18:54:23'
    })
  })

  it('converts the duration from seconds to milliseconds', async () => {
    const commands = await parseLines([
      execLine(1, '/bin/foo'),
      exitLine(1, 0, '2.474', '/bin/foo')
    ])

    expect(commands[0].duration).toBe(2474)
  })

  it('decodes a non-zero exit code', async () => {
    const commands = await parseLines([
      execLine(2623, '/bin/sh -c exit 3'),
      exitLine(2623, 768, '0.001', '/bin/sh -c exit 3')
    ])

    expect(commands[0].exitCode).toBe(3)
  })

  it('takes ppid from the preceding fork parent/child pair', async () => {
    const commands = await parseLines([
      forkParent(2617),
      forkChild(2622),
      execLine(2622, '/bin/echo hi'),
      exitLine(2622, 0, '0.001', '/bin/echo hi')
    ])

    expect(commands[0].ppid).toBe(2617)
  })

  it('reports ppid 0 when the fork was not observed', async () => {
    const commands = await parseLines([
      execLine(2622, '/bin/echo hi'),
      exitLine(2622, 0, '0.001', '/bin/echo hi')
    ])

    expect(commands[0].ppid).toBe(0)
  })

  it('ignores thread exits, which never exec', async () => {
    // node exits report each of its threads with the same command line; only
    // the pid that exec'd should be reported.
    const commands = await parseLines([
      execLine(2625, 'node -e process.exit(7)'),
      exitLine(2629, 0, '0.062', 'node -e process.exit(7)'),
      exitLine(2628, 0, '0.062', 'node -e process.exit(7)'),
      exitLine(2625, 1792, '0.116', 'node -e process.exit(7)')
    ])

    expect(commands).toHaveLength(1)
    expect(commands[0].pid).toBe(2625)
    expect(commands[0].exitCode).toBe(7)
  })

  it('drops an exec that never exited', async () => {
    const commands = await parseLines([execLine(1, '/bin/sleep 100')])

    expect(commands).toEqual([])
  })

  it('drops an exit with no matching exec', async () => {
    const commands = await parseLines([exitLine(1, 0, '1.0', '/bin/sleep')])

    expect(commands).toEqual([])
  })

  it('filters out commands at or below minDuration', async () => {
    const commands = await parseLines(
      [
        execLine(1, '/bin/quick'),
        exitLine(1, 0, '0.005', '/bin/quick'),
        execLine(2, '/bin/slow'),
        exitLine(2, 0, '0.500', '/bin/slow')
      ],
      { minDuration: 100 }
    )

    expect(commands.map((c) => c.name)).toEqual(['slow'])
  })

  it('traces system processes like any other', async () => {
    // These used to be dropped against a hardcoded list of names, which could
    // not tell a build's own `sh` from some wrapper's. Duration is the only
    // filter now.
    const commands = await parseLines([
      execLine(1, '/bin/cat file'),
      exitLine(1, 0, '0.010', '/bin/cat file'),
      execLine(2, '/usr/bin/node x'),
      exitLine(2, 0, '0.010', '/usr/bin/node x')
    ])

    expect(commands.map((c) => c.name).sort()).toEqual(['cat', 'node'])
  })

  it('sorts completed commands by start time', async () => {
    const commands = await parseLines([
      execLine(1, '/bin/later', '18:54:30'),
      exitLine(1, 0, '0.010', '/bin/later', '18:54:31'),
      execLine(2, '/bin/earlier', '18:54:24'),
      exitLine(2, 0, '0.010', '/bin/earlier', '18:54:25')
    ])

    expect(commands.map((c) => c.name)).toEqual(['earlier', 'later'])
  })

  it('resolves start time against the trace start date', async () => {
    const commands = await parseLines([
      execLine(1, '/bin/foo', '18:54:23'),
      exitLine(1, 0, '0.010', '/bin/foo')
    ])

    expect(commands[0].startTime).toBe(
      new Date('2024-05-01T18:54:23').getTime()
    )
  })

  it('keeps the last exec when a pid execs more than once', async () => {
    const commands = await parseLines([
      execLine(7, '/bin/sh -c foo'),
      execLine(7, '/usr/bin/node script.js'),
      exitLine(7, 0, '0.300', '/usr/bin/node script.js')
    ])

    expect(commands).toHaveLength(1)
    expect(commands[0].name).toBe('node')
  })

  it('skips the header and any unparseable lines', async () => {
    const commands = await parseLines([
      'forkstat: cannot read /proc/1/cmdline',
      '',
      execLine(1, '/bin/foo'),
      'garbage that is not a trace line',
      exitLine(1, 0, '0.010', '/bin/foo')
    ])

    expect(commands).toHaveLength(1)
    expect(commands[0].name).toBe('foo')
  })

  it('keeps a long command line intact', async () => {
    const long = `/bin/echo ${'a'.repeat(30)} ${'b'.repeat(30)} ${'c'.repeat(30)}`
    const commands = await parseLines([
      execLine(1, long),
      exitLine(1, 0, '0.001', long)
    ])

    expect(commands[0].args).toHaveLength(4)
    expect(commands[0].args[3]).toBe('c'.repeat(30))
  })
})
