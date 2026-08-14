import * as core from '@actions/core'
import * as logger from './logger.js'

/**
 * How the traces and metrics are drawn.
 *
 * `mermaid` is the default and what this action has always emitted: real axes,
 * real values, and a gantt that places spans on a wall clock. For the handful
 * of jobs a typical workflow runs it is the better answer, and it is what the
 * charts were brought back for.
 *
 * `sparkline` draws the same series as text — Unicode block characters in a
 * markdown table — and exists for one specific failure. GitHub renders every
 * mermaid block in its own sandboxed iframe served from
 * `viewscreen.githubusercontent.com`, which loads mermaid.js and lays the
 * diagram out client-side. This action emits about a dozen blocks per job,
 * which is nothing on a job page; the run summary page concatenates *every*
 * job's summary, so a large matrix multiplies that by the job count. Past a few
 * dozen jobs the page stops being usable while the data behind it is still
 * perfectly good, and text is what makes it readable again.
 *
 * The trade is resolution for cost: eight levels and no axis, against no
 * iframes at all. Reach for it when the run page is the problem.
 */
const CHART_MODES = ['sparkline', 'mermaid'] as const

export type ChartMode = (typeof CHART_MODES)[number]

/** Lowest to highest. `▁` is not blank — an absent sample draws nothing. */
const BLOCKS = '▁▂▃▄▅▆▇█'

/** Filled and empty cells of a timeline bar. */
const BAR_FILLED = '█'
const BAR_EMPTY = '░'

/** Columns a sparkline is downsampled to, so table rows stay aligned. */
export const SPARKLINE_WIDTH = 60

/** Columns a timeline bar spans. */
export const TIMELINE_WIDTH = 30

const DEFAULT_CHART_MODE: ChartMode = 'mermaid'

export function chartMode(): ChartMode {
  const input: string = core.getInput('charts').trim().toLowerCase()
  if (!input) {
    return DEFAULT_CHART_MODE
  }
  if (!(CHART_MODES as readonly string[]).includes(input)) {
    // Falling back silently would render the opposite of what was asked for,
    // and the only symptom would be a summary that looks fine.
    logger.error(
      `Unknown 'charts' value '${input}'. ` +
        `Expected one of ${CHART_MODES.join(', ')}. ` +
        `Using '${DEFAULT_CHART_MODE}'.`
    )
    return DEFAULT_CHART_MODE
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

/**
 * Escapes what would otherwise end a table cell early.
 *
 * The backslash pass has to come first and is not decoration: escaping only the
 * pipe turns an input backslash immediately before one into `\\|`, which the
 * row scanner reads as an escaped backslash followed by a live delimiter, so
 * the cell splits anyway and the row breaks. Escaping the backslashes first
 * makes that `\\\|` — a literal backslash, then an escaped pipe.
 */
function escapeCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

/**
 * Wraps text so a table cell keeps monospace alignment, and stays one cell.
 * GFM resolves table delimiters before inline spans, so an escaped pipe is
 * still needed inside the backticks.
 */
export function code(text: string): string {
  return `\`${escapeCell(text)}\``
}

/** Table cells cannot contain a newline, and `|` would start a new column. */
export function cell(text: string): string {
  return escapeCell(text).replace(/\r?\n/g, ' ')
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
