import { ChildProcess, spawn } from 'child_process'
import path from 'path'
import * as core from '@actions/core'
import { ProcessedStats, StatSample } from './interfaces/index.js'
import * as logger from './logger.js'
import {
  ChartMode,
  SPARKLINE_WIDTH,
  chartMode,
  code,
  formatNumber,
  markdownTable,
  sparkline,
  summarise
} from './charts.js'

// The worker reads the same variable, and inherits this process's environment,
// so the two cannot disagree about where the stat server lives.
const STAT_SERVER_PORT: number =
  parseInt(process.env.WORKFLOW_TELEMETRY_SERVER_PORT || '') || 7777

// Mermaid renders every sample as a tick, so a long job would produce an
// unreadable chart (and a very large summary). Longer runs are downsampled.
const MAX_CHART_POINTS = 120

/**
 * One series, named once for both renderers. `axis` is the mermaid y-axis
 * label, which is shared by the two series of a pair; the sparkline table has
 * no axis and puts the unit on the numbers instead.
 */
interface Metric {
  readonly group: string
  readonly series: string
  readonly unit: string
  readonly axis: string
  readonly points: ProcessedStats[]
}

/** A collector's endpoint and the series to read out of its samples. */
interface MetricGroup {
  readonly group: string
  readonly path: string
  readonly unit: string
  readonly axis: string
  /** Series name to the field it is read from, in the order they are drawn. */
  readonly series: Record<string, string>
}

const METRIC_GROUPS: MetricGroup[] = [
  {
    group: 'CPU',
    path: '/cpu',
    unit: '%',
    axis: 'Load (%)',
    series: { user: 'userLoad', system: 'systemLoad' }
  },
  {
    group: 'Memory',
    path: '/memory',
    unit: 'MB',
    axis: 'Memory (MB)',
    series: { used: 'activeMemoryMb', free: 'availableMemoryMb' }
  },
  {
    group: 'Network I/O',
    path: '/network',
    unit: 'MB',
    axis: 'Network (MB)',
    series: { read: 'rxMb', write: 'txMb' }
  },
  {
    group: 'Disk I/O',
    path: '/disk',
    unit: 'MB',
    axis: 'Disk (MB)',
    series: { read: 'rxMb', write: 'wxMb' }
  },
  {
    group: 'Disk usage',
    path: '/disk_size',
    unit: 'MB',
    axis: 'Disk (MB)',
    series: { used: 'usedSizeMb', free: 'availableSizeMb' }
  }
]

/** Calls the stat collector worker, which listens on localhost. */
async function callStatServer(
  pathname: string,
  method = 'GET'
): Promise<unknown> {
  const response: Response = await fetch(
    `http://localhost:${STAT_SERVER_PORT}${pathname}`,
    { method }
  )
  if (!response.ok) {
    throw new Error(
      `Stat server responded ${response.status} for ${method} ${pathname}`
    )
  }
  const body: string = await response.text()
  return body ? JSON.parse(body) : null
}

async function triggerStatCollect(): Promise<void> {
  logger.debug('Triggering stat collect ...')
  const result: unknown = await callStatServer('/collect', 'POST')
  if (logger.isDebugEnabled()) {
    logger.debug(`Triggered stat collect: ${JSON.stringify(result)}`)
  }
}

/** Reads one collector's history and splits it into its series. */
async function metricsOf(group: MetricGroup): Promise<Metric[]> {
  logger.debug(`Getting ${group.group} stats ...`)
  const samples = (await callStatServer(group.path)) as StatSample[]
  if (logger.isDebugEnabled()) {
    logger.debug(`Got ${group.group} stats: ${JSON.stringify(samples)}`)
  }

  return Object.entries(group.series).map(([series, field]) => ({
    group: group.group,
    series,
    unit: group.unit,
    axis: group.axis,
    // A missing or negative reading is drawn as zero rather than dropped, so
    // the series stays aligned with the timeline.
    points: samples.map((sample) => ({
      x: sample.time,
      y: sample[field] > 0 ? sample[field] : 0
    }))
  }))
}

/**
 * Renders a series as a Mermaid `xychart-beta` block, which GitHub renders
 * natively in job summaries and pull request comments. This replaces the
 * chart-image service the action used to call, which no longer exists.
 *
 * `xychart-beta` has no legend, so each series gets its own titled chart.
 */
export function renderChart(
  title: string,
  yAxisLabel: string,
  points: ProcessedStats[]
): string {
  const samples: ProcessedStats[] = downsample(points, MAX_CHART_POINTS)
  const values: number[] = samples.map((p) => round(p.y))

  // Samples are taken on a fixed interval, so they are evenly spaced and the
  // x axis can simply run from 0 to the elapsed time of the last sample.
  const elapsedSeconds: number = Math.max(
    1,
    Math.round((points[points.length - 1].x - points[0].x) / 1000)
  )

  // Mermaid rejects a zero-height y axis, which happens whenever a metric
  // stayed flat (idle network or disk, for example).
  let min: number = Math.min(...values)
  let max: number = Math.max(...values)
  if (min === max) {
    min = Math.min(0, min)
    max = max === min ? 1 : max
  }

  return [
    '```mermaid',
    'xychart-beta',
    `    title "${escapeTitle(title)}"`,
    `    x-axis "Time (s)" 0 --> ${elapsedSeconds}`,
    `    y-axis "${escapeTitle(yAxisLabel)}" ${round(min)} --> ${round(max)}`,
    `    line [${values.join(', ')}]`,
    '```',
    ''
  ].join('\n')
}

/** Mermaid titles are quoted strings, so quotes have to go. */
function escapeTitle(text: string): string {
  return text.replace(/"/g, "'")
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** Averages `points` down to at most `limit` evenly spaced buckets. */
export function downsample(
  points: ProcessedStats[],
  limit: number
): ProcessedStats[] {
  if (points.length <= limit) {
    return points
  }
  const bucketSize: number = Math.ceil(points.length / limit)
  const result: ProcessedStats[] = []
  for (let i = 0; i < points.length; i += bucketSize) {
    const bucket: ProcessedStats[] = points.slice(i, i + bucketSize)
    const sum: number = bucket.reduce((acc, p) => acc + p.y, 0)
    result.push({ x: bucket[0].x, y: sum / bucket.length })
  }
  return result
}

/**
 * Every metric as one table: sparkline for the shape, peak and mean for the
 * numbers the sparkline deliberately does not carry. Ten rows of text, and not
 * one element the browser has to render.
 */
export function renderMetricTable(metrics: Metric[]): string {
  const rows: string[][] = metrics.map((metric) => {
    const values: number[] = metric.points.map((p) => p.y)
    const { peak, mean } = summarise(values)
    const shape: number[] = downsample(metric.points, SPARKLINE_WIDTH).map(
      (p) => p.y
    )
    return [
      `${metric.group} - ${metric.series}`,
      code(sparkline(shape)),
      `${formatNumber(peak)} ${metric.unit}`,
      `${formatNumber(mean)} ${metric.unit}`
    ]
  })

  return markdownTable(
    ['Metric', 'Trace', 'Peak', 'Mean'],
    [':--', ':--', '--:', '--:'],
    rows
  )
}

/** One titled chart per series, grouped under the headings mermaid needs. */
function renderMetricCharts(metrics: Metric[]): string {
  const items: string[] = []
  let group = ''
  for (const metric of metrics) {
    if (metric.group !== group) {
      group = metric.group
      items.push(`### ${group}`)
    }
    items.push(
      renderChart(
        `${metric.group} - ${metric.series} (${metric.unit})`,
        metric.axis,
        metric.points
      )
    )
  }
  return items.join('\n')
}

async function reportWorkflowMetrics(): Promise<string> {
  // A series with no samples has nothing to draw and no peak to report: a job
  // shorter than one collection interval produces several of these.
  const metrics: Metric[] = (await Promise.all(METRIC_GROUPS.map(metricsOf)))
    .flat()
    .filter((metric) => metric.points.length)

  if (!metrics.length) {
    return ''
  }

  const mode: ChartMode = chartMode()
  if (mode === 'mermaid') {
    return renderMetricCharts(metrics)
  }
  return ['### Resource Metrics', '', renderMetricTable(metrics), ''].join('\n')
}

///////////////////////////

// Each subsystem swallows its own failures: one of them going wrong must not
// stop the others from being started, finished or reported.

export async function start(): Promise<void> {
  logger.info(`Starting stat collector ...`)

  try {
    const metricFrequency: number =
      parseInt(core.getInput('metric_frequency')) * 1000

    const child: ChildProcess = spawn(
      process.argv[0],
      [path.join(import.meta.dirname, '../scw/index.js')],
      {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          WORKFLOW_TELEMETRY_STAT_FREQ: metricFrequency
            ? `${metricFrequency}`
            : undefined
        }
      }
    )
    child.unref()

    logger.info(`Started stat collector`)
  } catch (error) {
    logger.error('Unable to start stat collector')
    logger.error(error)
  }
}

export async function finish(): Promise<void> {
  try {
    // Trigger a final collect, so the stats since the latest schedule are kept.
    await triggerStatCollect()
    logger.info(`Finished stat collector`)
  } catch (error) {
    logger.error('Unable to finish stat collector')
    logger.error(error)
  }
}

export async function report(): Promise<string | null> {
  logger.info(`Reporting stat collector result ...`)

  try {
    return await reportWorkflowMetrics()
  } catch (error) {
    logger.error('Unable to report stat collector result')
    logger.error(error)

    return null
  }
}
