import * as core from '@actions/core'
import * as logger from './logger.js'

/**
 * How the traces and metrics are drawn.
 *
 * `mermaid` is what this action has always emitted, and it is expensive on the
 * page rather than on the runner: GitHub renders every mermaid block in its own
 * sandboxed iframe served from `viewscreen.githubusercontent.com`, which loads
 * mermaid.js and lays the diagram out client-side. One job costs a dozen of
 * those, which is fine. A workflow whose matrix runs to dozens of jobs is not:
 * the run summary page concatenates every job's summary, so the iframes
 * multiply by the job count and the page stops being usable long before the
 * data stops being interesting.
 *
 * `sparkline` draws the same series as text — Unicode block characters in a
 * markdown table — which costs no iframes, no JavaScript and no layout. It
 * answers the question these charts are usually asked ("did this job peg the
 * CPU, or sit on I/O?") and it is the default for that reason. Reach for
 * `mermaid` on the one job being investigated, not across a matrix.
 */
export type ChartMode = 'sparkline' | 'mermaid'

const CHART_MODES: readonly string[] = ['sparkline', 'mermaid']

/** Lowest to highest. `▁` is not blank — an absent sample draws nothing. */
const BLOCKS = '▁▂▃▄▅▆▇█'

/** Filled and empty cells of a timeline bar. */
const BAR_FILLED = '█'
const BAR_EMPTY = '░'

/** Columns a sparkline is downsampled to, so table rows stay aligned. */
export const SPARKLINE_WIDTH = 60

/** Columns a timeline bar spans. */
export const TIMELINE_WIDTH = 30

export function chartMode(): ChartMode {
  const input: string = core.getInput('charts').trim().toLowerCase()
  if (!input) {
    return 'sparkline'
  }
  if (!CHART_MODES.includes(input)) {
    // Falling back silently would render the opposite of what was asked for,
    // and the only symptom would be a summary that looks fine.
    logger.error(
      `Unknown 'charts' value '${input}'. ` +
        `Expected one of ${CHART_MODES.join(', ')}. Using 'sparkline'.`
    )
    return 'sparkline'
  }
  return input as ChartMode
}

/**
 * Draws `values` as block characters scaled between the series' own minimum and
 * maximum, so the shape is visible whatever the absolute numbers are. The
 * caller reports those numbers separately — a sparkline is a shape, not a
 * measurement.
 */
export function sparkline(values: number[]): string {
  if (!values.length) {
    return ''
  }
  const { min, max } = extremesOf(values)
  if (min === max) {
    // A flat series has no shape, and where it is drawn is a choice. At the
    // bottom it reads as idle, which is right for the flat zero an untouched
    // disk or NIC reports and wrong for a job that sat at 100% CPU throughout.
    // So zero goes to the floor and anything else mid-height, with the peak
    // column carrying the value either way.
    const level: number = max === 0 ? 0 : Math.floor((BLOCKS.length - 1) / 2)
    return BLOCKS[level].repeat(values.length)
  }
  const scale: number = (BLOCKS.length - 1) / (max - min)
  return values.map((v) => BLOCKS[Math.round((v - min) * scale)]).join('')
}

/**
 * Draws one span of a timeline as a bar of `width` cells: the text form of a
 * gantt row. `start` and `end` are fractions of the whole timeline.
 *
 * A span shorter than one cell still gets one, because a step that ran is worth
 * distinguishing from one that did not.
 */
export function timelineBar(
  start: number,
  end: number,
  width: number = TIMELINE_WIDTH
): string {
  const clamp = (v: number): number => Math.min(1, Math.max(0, v))
  // A span starting at the very end floors to `width`, which would leave no
  // room for the cell the next line guarantees and overrun the bar.
  const from: number = Math.min(width - 1, Math.floor(clamp(start) * width))
  const to: number = Math.ceil(clamp(end) * width)
  const filled: number = Math.max(1, Math.min(width - from, to - from))
  return (
    BAR_EMPTY.repeat(from) +
    BAR_FILLED.repeat(filled) +
    BAR_EMPTY.repeat(Math.max(0, width - from - filled))
  )
}

/** Peak and mean of the *full* series — downsampling would flatten a spike. */
export function summarise(values: number[]): { peak: number; mean: number } {
  if (!values.length) {
    return { peak: 0, mean: 0 }
  }
  let sum = 0
  for (const v of values) {
    sum += v
  }
  return { peak: extremesOf(values).max, mean: sum / values.length }
}

/**
 * `Math.min(...values)` blows the stack on a long enough series, and these are
 * undownsampled samples of a job that may have run for an hour.
 */
function extremesOf(values: number[]): { min: number; max: number } {
  let min: number = values[0]
  let max: number = values[0]
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max }
}

/** Renders a markdown table. `align` is one of `:--`, `--:` or `:-:` per column. */
export function markdownTable(
  headers: string[],
  align: string[],
  rows: string[][]
): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${align.join(' | ')} |`,
    ...rows.map((cells) => `| ${cells.join(' | ')} |`)
  ].join('\n')
}

/** Wraps text so a table cell keeps monospace alignment, and stays one cell. */
export function code(text: string): string {
  return `\`${text.replace(/\|/g, '\\|')}\``
}

/** Table cells cannot contain a newline, and `|` would start a new column. */
export function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function formatNumber(value: number): string {
  if (value === 0) {
    return '0'
  }
  if (Math.abs(value) >= 100) {
    return value.toFixed(0)
  }
  if (Math.abs(value) >= 1) {
    return value.toFixed(1)
  }
  return value.toFixed(2)
}

/** Milliseconds as the shortest form that stays readable. */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`
  }
  const seconds: number = ms / 1000
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes: number = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}
