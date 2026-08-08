import { describe, expect, it } from '@jest/globals'
import { renderMetricTable } from '../src/statCollector.js'
import { renderStepTable } from '../src/stepTracer.js'
import { renderProcessTable } from '../src/processTracer.js'
import {
  CompletedCommand,
  ProcessedStats,
  WorkflowJobType
} from '../src/interfaces/index.js'

const T0 = 1_700_000_000_000

function points(values: number[]): ProcessedStats[] {
  return values.map((y, i) => ({ x: T0 + i * 1000, y }))
}

function job(
  steps: Array<{
    name: string
    from: number
    to: number
    conclusion?: string
  }>
): WorkflowJobType {
  return {
    name: 'build',
    steps: steps.map((s, i) => ({
      name: s.name,
      number: i + 1,
      status: 'completed',
      conclusion: s.conclusion ?? 'success',
      started_at: new Date(T0 + s.from).toISOString(),
      completed_at: new Date(T0 + s.to).toISOString()
    }))
  } as unknown as WorkflowJobType
}

function command(
  name: string,
  startTime: number,
  duration: number,
  exitCode = 0
): CompletedCommand {
  return {
    ts: '00:00:00',
    name,
    user: 'runner',
    pid: 1,
    ppid: 0,
    startTime: T0 + startTime,
    fileName: `/usr/bin/${name}`,
    args: [],
    duration,
    exitCode,
    order: 0
  }
}

describe('renderMetricTable', () => {
  const metric = {
    group: 'CPU',
    series: 'user',
    unit: '%',
    axis: 'Load (%)',
    points: points([0, 50, 100])
  }

  it('emits no mermaid at all', () => {
    expect(renderMetricTable([metric])).not.toContain('mermaid')
  })

  it('gives each metric one row, named group and series', () => {
    const table = renderMetricTable([metric])

    expect(table.split('\n')).toHaveLength(3)
    expect(table).toContain('| CPU - user |')
  })

  it('reports peak and mean with the unit', () => {
    expect(renderMetricTable([metric])).toContain('| 100 % | 50.0 % |')
  })

  it('takes the peak from the full series, not the drawn one', () => {
    // 600 samples is well past SPARKLINE_WIDTH, so the spike only survives if
    // the peak is computed before downsampling averages it away.
    const spiky = Array.from({ length: 600 }, (_, i) => (i === 300 ? 100 : 0))

    const table = renderMetricTable([{ ...metric, points: points(spiky) }])

    expect(table).toContain('| 100 % |')
  })

  it('draws the sparkline inside a code span so it stays monospaced', () => {
    expect(renderMetricTable([metric])).toMatch(/\|\s`[▁-█]+`\s\|/u)
  })
})

describe('renderStepTable', () => {
  it('is empty when no step has both timestamps', () => {
    expect(renderStepTable(job([]))).toBe('')
  })

  it('gives each step a row and a bar spanning the job', () => {
    const table = renderStepTable(
      job([
        { name: 'Set up job', from: 0, to: 1000 },
        { name: 'Build', from: 1000, to: 5000 }
      ])
    )

    expect(table).toContain('| Set up job |')
    expect(table).toContain('| Build |')
    expect(table).toContain('### Step Trace')
    expect(table).not.toContain('mermaid')
  })

  it('places the bars in order along the timeline', () => {
    const table = renderStepTable(
      job([
        { name: 'first', from: 0, to: 1000 },
        { name: 'last', from: 9000, to: 10_000 }
      ])
    )
    const bars = table
      .split('\n')
      .filter((l) => l.includes('█'))
      .map((l) => l.slice(l.indexOf('`') + 1, l.lastIndexOf('`')))

    expect(bars[0].startsWith('█')).toBe(true)
    expect(bars[1].endsWith('█')).toBe(true)
  })

  it('marks a failed step without dropping it', () => {
    const table = renderStepTable(
      job([{ name: 'Build', from: 0, to: 1000, conclusion: 'failure' }])
    )

    expect(table).toContain('Build _(failure)_')
  })

  it('survives a job whose steps all took no measurable time', () => {
    const table = renderStepTable(
      job([
        { name: 'a', from: 0, to: 0 },
        { name: 'b', from: 0, to: 0 }
      ])
    )

    expect(table).toContain('| a |')
    expect(table).toContain('█')
  })

  it('clamps a step the API reports as finishing before it started', () => {
    const table = renderStepTable(job([{ name: 'odd', from: 5000, to: 1000 }]))
    const row = table.split('\n').find((l) => l.startsWith('| odd '))!

    expect(row).toContain('0ms')
    expect(row).not.toMatch(/-\d/)
  })
})

describe('renderProcessTable', () => {
  it('is empty with nothing traced', () => {
    expect(renderProcessTable([])).toBe('')
  })

  it('gives each process a row', () => {
    const table = renderProcessTable([
      command('gcc', 0, 5000),
      command('ld', 5000, 1000)
    ])

    expect(table).toContain('| gcc |')
    expect(table).toContain('| ld |')
    expect(table).not.toContain('mermaid')
  })

  it('marks a non-zero exit', () => {
    expect(renderProcessTable([command('false', 0, 10, 1)])).toContain(
      'false _(exit 1)_'
    )
  })
})
