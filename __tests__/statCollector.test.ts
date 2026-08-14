import { describe, expect, it } from '@jest/globals'
import { downsample, renderChart, report } from '../src/statCollector.js'
import { ProcessedStats } from '../src/interfaces/index.js'

/** Builds `count` samples one second apart, valued by `valueAt`. */
function series(
  count: number,
  valueAt: (i: number) => number = (i) => i
): ProcessedStats[] {
  const start = 1_700_000_000_000
  return Array.from({ length: count }, (_, i) => ({
    x: start + i * 1000,
    y: valueAt(i)
  }))
}

describe('downsample', () => {
  it('leaves a series alone when it already fits', () => {
    const points = series(10)

    expect(downsample(points, 120)).toBe(points)
  })

  it('averages a long series down to the limit', () => {
    const reduced = downsample(series(1000), 120)

    expect(reduced.length).toBeLessThanOrEqual(120)
    expect(reduced.length).toBeGreaterThan(0)
  })

  it('averages the values inside each bucket', () => {
    // 4 points, limit 2 -> buckets of 2: (0+10)/2 and (20+30)/2
    const reduced = downsample(
      series(4, (i) => i * 10),
      2
    )

    expect(reduced.map((p) => p.y)).toEqual([5, 25])
  })

  it('keeps the first timestamp of each bucket', () => {
    const points = series(4)
    const reduced = downsample(points, 2)

    expect(reduced.map((p) => p.x)).toEqual([points[0].x, points[2].x])
  })
})

describe('renderChart', () => {
  it('emits a mermaid xychart block', () => {
    const chart = renderChart('CPU Load - User (%)', 'Load (%)', series(3))

    expect(chart).toContain('```mermaid')
    expect(chart).toContain('xychart-beta')
    expect(chart).toContain('title "CPU Load - User (%)"')
    expect(chart).toContain('y-axis "Load (%)"')
    expect(chart.trimEnd().endsWith('```')).toBe(true)
  })

  it('plots every value of a short series in order', () => {
    const chart = renderChart(
      't',
      'y',
      series(3, (i) => i * 2)
    )

    expect(chart).toContain('line [0, 2, 4]')
  })

  it('scales the x axis to the elapsed seconds of the series', () => {
    // 11 samples one second apart -> 10 seconds elapsed.
    const chart = renderChart('t', 'y', series(11))

    expect(chart).toContain('x-axis "Time (s)" 0 --> 10')
  })

  it('never emits a zero-height y axis for a flat series', () => {
    // An idle disk reports 0 for every sample; "0 --> 0" is rejected by mermaid.
    const chart = renderChart(
      't',
      'y',
      series(5, () => 0)
    )

    expect(chart).toContain('y-axis "y" 0 --> 1')
    expect(chart).not.toContain('0 --> 0')
  })

  it('handles a flat non-zero series', () => {
    const chart = renderChart(
      't',
      'y',
      series(5, () => 42)
    )

    const axis = chart.split('\n').find((l) => l.includes('y-axis'))
    expect(axis).toBe('    y-axis "y" 0 --> 42')
  })

  it('rounds values to two decimals', () => {
    const chart = renderChart(
      't',
      'y',
      series(2, () => 1.23456)
    )

    expect(chart).toContain('line [1.23, 1.23]')
  })

  it('downsamples a long series so the block stays readable', () => {
    const chart = renderChart('t', 'y', series(1000))
    const values = chart
      .split('\n')
      .find((l) => l.includes('line ['))!
      .replace(/.*\[|\].*/g, '')
      .split(', ')

    expect(values.length).toBeLessThanOrEqual(120)
  })

  it('replaces double quotes so the mermaid title stays valid', () => {
    const chart = renderChart('a "quoted" title', 'y', series(2))

    expect(chart).toContain(`title "a 'quoted' title"`)
  })

  it('survives a single-sample series', () => {
    const chart = renderChart(
      't',
      'y',
      series(1, () => 5)
    )

    expect(chart).toContain('x-axis "Time (s)" 0 --> 1')
    expect(chart).toContain('line [5]')
  })
})

describe('report', () => {
  /** The stat server, answering each collector's route from a canned history. */
  function serve(histories: Record<string, object[]>): void {
    globalThis.fetch = (async (url: string) => ({
      ok: true,
      text: async () => JSON.stringify(histories[new URL(url).pathname] ?? [])
    })) as unknown as typeof fetch
  }

  it('reads every collector and names each series once', async () => {
    const time = 1_700_000_000_000
    serve({
      '/cpu': [{ time, userLoad: 10, systemLoad: 5 }],
      '/memory': [{ time, activeMemoryMb: 100, availableMemoryMb: 900 }],
      '/network': [{ time, rxMb: 1, txMb: 2 }],
      '/disk': [{ time, rxMb: 3, wxMb: 4 }],
      '/disk_size': [{ time, usedSizeMb: 7, availableSizeMb: 8 }]
    })
    process.env.INPUT_CHARTS = 'sparkline'

    const content = await report()

    // Every series is read out of the right field of the right endpoint.
    expect(content).toContain('| CPU - user | ')
    expect(content).toContain('| 10.0 % | 10.0 % |')
    expect(content).toContain('| 5.0 % | 5.0 % |')
    expect(content).toContain('| 100 MB | 100 MB |')
    expect(content).toContain('| 900 MB | 900 MB |')
    expect(content).toContain('| Disk usage - used | ')
    expect(content).toContain('| 7.0 MB | 7.0 MB |')
    expect(content!.split('\n').filter((l) => l.startsWith('| '))).toHaveLength(
      12
    )
  })

  it('drops series a short job never sampled', async () => {
    serve({})
    process.env.INPUT_CHARTS = 'sparkline'

    expect(await report()).toBe('')
  })
})
