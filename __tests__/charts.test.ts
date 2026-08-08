import { describe, expect, it } from '@jest/globals'
import {
  code,
  cell,
  formatDuration,
  formatNumber,
  markdownTable,
  sparkline,
  summarise,
  timelineBar
} from '../src/charts.js'

describe('sparkline', () => {
  it('is empty for an empty series', () => {
    expect(sparkline([])).toBe('')
  })

  it('draws one character per sample', () => {
    expect(sparkline([1, 2, 3, 4])).toHaveLength(4)
  })

  it('puts the minimum at the bottom and the maximum at the top', () => {
    const drawn = sparkline([0, 50, 100])

    expect(drawn.at(0)).toBe('▁')
    expect(drawn.at(-1)).toBe('█')
  })

  it('scales to the series rather than to an absolute range', () => {
    // Both series have the same shape at different magnitudes.
    expect(sparkline([0, 1, 2])).toBe(sparkline([0, 500, 1000]))
  })

  it('draws a flat series mid-height, not as idle', () => {
    // A job that sat at 100% CPU throughout has no shape, but drawing it at the
    // bottom of the range would read as an idle machine.
    const drawn = sparkline([100, 100, 100])

    expect(drawn).toBe('▄▄▄')
    expect(drawn).not.toContain('▁')
  })

  it('draws a flat zero series at the floor, because it really is idle', () => {
    expect(sparkline([0, 0, 0])).toBe('▁▁▁')
  })

  it('survives a single sample', () => {
    expect(sparkline([7])).toHaveLength(1)
  })

  it('handles a long series without blowing the stack', () => {
    const long = Array.from({ length: 200_000 }, (_, i) => i)

    expect(() => sparkline(long)).not.toThrow()
  })
})

describe('summarise', () => {
  it('reports the peak and the mean', () => {
    expect(summarise([0, 10, 20])).toEqual({ peak: 20, mean: 10 })
  })

  it('is zero for an empty series', () => {
    expect(summarise([])).toEqual({ peak: 0, mean: 0 })
  })

  it('handles a series long enough to overflow a spread argument list', () => {
    const long = Array.from({ length: 200_000 }, () => 1)

    expect(() => summarise(long)).not.toThrow()
    expect(summarise(long).peak).toBe(1)
  })
})

describe('timelineBar', () => {
  it('spans the whole width for the whole timeline', () => {
    expect(timelineBar(0, 1, 10)).toBe('██████████')
  })

  it('places a span in the middle', () => {
    expect(timelineBar(0.4, 0.6, 10)).toBe('░░░░██░░░░')
  })

  it('gives a zero-length span one cell, so it stays visible', () => {
    const bar = timelineBar(0.5, 0.5, 10)

    expect(bar).toHaveLength(10)
    expect(bar).toContain('█')
  })

  it('keeps a span at the very end inside the bar', () => {
    const bar = timelineBar(1, 1, 10)

    expect(bar).toHaveLength(10)
    expect(bar.endsWith('█')).toBe(true)
  })

  it('clamps a span running past the end of the timeline', () => {
    expect(timelineBar(-1, 2, 10)).toBe('██████████')
  })
})

describe('markdownTable', () => {
  it('emits a header, an alignment row and one row per record', () => {
    const table = markdownTable(
      ['A', 'B'],
      [':--', '--:'],
      [
        ['1', '2'],
        ['3', '4']
      ]
    )

    expect(table.split('\n')).toEqual([
      '| A | B |',
      '| :-- | --: |',
      '| 1 | 2 |',
      '| 3 | 4 |'
    ])
  })
})

describe('cell and code', () => {
  it('escapes a pipe so it does not start a new column', () => {
    expect(cell('a | b')).toBe('a \\| b')
    expect(code('a | b')).toBe('`a \\| b`')
  })

  it('flattens newlines, which a table cell cannot hold', () => {
    expect(cell('a\nb')).toBe('a b')
  })
})

describe('formatNumber', () => {
  it('drops the decimals on large numbers', () => {
    expect(formatNumber(1234.56)).toBe('1235')
  })

  it('keeps one decimal in the ordinary range', () => {
    expect(formatNumber(41.27)).toBe('41.3')
  })

  it('keeps two below one, where one would round to nothing', () => {
    expect(formatNumber(0.043)).toBe('0.04')
  })

  it('renders an exact zero plainly', () => {
    expect(formatNumber(0)).toBe('0')
  })
})

describe('formatDuration', () => {
  it('uses milliseconds below a second', () => {
    expect(formatDuration(250)).toBe('250ms')
  })

  it('uses seconds below a minute', () => {
    expect(formatDuration(4500)).toBe('4.5s')
  })

  it('uses minutes and seconds above one minute', () => {
    expect(formatDuration(125_000)).toBe('2m 5s')
  })
})
