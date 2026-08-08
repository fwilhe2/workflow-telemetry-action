import { ChildProcess, spawn } from 'child_process'
import path from 'path'
import * as core from '@actions/core'
import {
  CPUStats,
  DiskSizeStats,
  DiskStats,
  MemoryStats,
  NetworkStats,
  ProcessedCPUStats,
  ProcessedDiskSizeStats,
  ProcessedDiskStats,
  ProcessedMemoryStats,
  ProcessedNetworkStats,
  ProcessedStats,
  WorkflowJobType
} from './interfaces/index.js'
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
  const { userLoadX, systemLoadX } = await getCPUStats()
  const { activeMemoryX, availableMemoryX } = await getMemoryStats()
  const { networkReadX, networkWriteX } = await getNetworkStats()
  const { diskReadX, diskWriteX } = await getDiskStats()
  const { diskAvailableX, diskUsedX } = await getDiskSizeStats()

  const cpu = 'Load (%)'
  const memory = 'Memory (MB)'
  const network = 'Network (MB)'
  const disk = 'Disk (MB)'

  const metric = (
    group: string,
    series: string,
    unit: string,
    axis: string,
    points: ProcessedStats[]
  ): Metric => ({ group, series, unit, axis, points })

  // A series with no samples has nothing to draw and no peak to report: a job
  // shorter than one collection interval produces several of these.
  const metrics: Metric[] = [
    metric('CPU', 'user', '%', cpu, userLoadX),
    metric('CPU', 'system', '%', cpu, systemLoadX),
    metric('Memory', 'used', 'MB', memory, activeMemoryX),
    metric('Memory', 'free', 'MB', memory, availableMemoryX),
    metric('Network I/O', 'read', 'MB', network, networkReadX),
    metric('Network I/O', 'write', 'MB', network, networkWriteX),
    metric('Disk I/O', 'read', 'MB', disk, diskReadX),
    metric('Disk I/O', 'write', 'MB', disk, diskWriteX),
    metric('Disk usage', 'used', 'MB', disk, diskUsedX),
    metric('Disk usage', 'free', 'MB', disk, diskAvailableX)
  ].filter((m) => m.points && m.points.length)

  if (!metrics.length) {
    return ''
  }

  const mode: ChartMode = chartMode()
  if (mode === 'mermaid') {
    return renderMetricCharts(metrics)
  }
  return ['### Resource Metrics', '', renderMetricTable(metrics), ''].join('\n')
}

async function getCPUStats(): Promise<ProcessedCPUStats> {
  const userLoadX: ProcessedStats[] = []
  const systemLoadX: ProcessedStats[] = []

  logger.debug('Getting CPU stats ...')
  const stats = (await callStatServer('/cpu')) as CPUStats[]
  if (logger.isDebugEnabled()) {
    logger.debug(`Got CPU stats: ${JSON.stringify(stats)}`)
  }

  stats.forEach((element: CPUStats) => {
    userLoadX.push({
      x: element.time,
      y: element.userLoad && element.userLoad > 0 ? element.userLoad : 0
    })

    systemLoadX.push({
      x: element.time,
      y: element.systemLoad && element.systemLoad > 0 ? element.systemLoad : 0
    })
  })

  return { userLoadX, systemLoadX }
}

async function getMemoryStats(): Promise<ProcessedMemoryStats> {
  const activeMemoryX: ProcessedStats[] = []
  const availableMemoryX: ProcessedStats[] = []

  logger.debug('Getting memory stats ...')
  const stats = (await callStatServer('/memory')) as MemoryStats[]
  if (logger.isDebugEnabled()) {
    logger.debug(`Got memory stats: ${JSON.stringify(stats)}`)
  }

  stats.forEach((element: MemoryStats) => {
    activeMemoryX.push({
      x: element.time,
      y:
        element.activeMemoryMb && element.activeMemoryMb > 0
          ? element.activeMemoryMb
          : 0
    })

    availableMemoryX.push({
      x: element.time,
      y:
        element.availableMemoryMb && element.availableMemoryMb > 0
          ? element.availableMemoryMb
          : 0
    })
  })

  return { activeMemoryX, availableMemoryX }
}

async function getNetworkStats(): Promise<ProcessedNetworkStats> {
  const networkReadX: ProcessedStats[] = []
  const networkWriteX: ProcessedStats[] = []

  logger.debug('Getting network stats ...')
  const stats = (await callStatServer('/network')) as NetworkStats[]
  if (logger.isDebugEnabled()) {
    logger.debug(`Got network stats: ${JSON.stringify(stats)}`)
  }

  stats.forEach((element: NetworkStats) => {
    networkReadX.push({
      x: element.time,
      y: element.rxMb && element.rxMb > 0 ? element.rxMb : 0
    })

    networkWriteX.push({
      x: element.time,
      y: element.txMb && element.txMb > 0 ? element.txMb : 0
    })
  })

  return { networkReadX, networkWriteX }
}

async function getDiskStats(): Promise<ProcessedDiskStats> {
  const diskReadX: ProcessedStats[] = []
  const diskWriteX: ProcessedStats[] = []

  logger.debug('Getting disk stats ...')
  const stats = (await callStatServer('/disk')) as DiskStats[]
  if (logger.isDebugEnabled()) {
    logger.debug(`Got disk stats: ${JSON.stringify(stats)}`)
  }

  stats.forEach((element: DiskStats) => {
    diskReadX.push({
      x: element.time,
      y: element.rxMb && element.rxMb > 0 ? element.rxMb : 0
    })

    diskWriteX.push({
      x: element.time,
      y: element.wxMb && element.wxMb > 0 ? element.wxMb : 0
    })
  })

  return { diskReadX, diskWriteX }
}

async function getDiskSizeStats(): Promise<ProcessedDiskSizeStats> {
  const diskAvailableX: ProcessedStats[] = []
  const diskUsedX: ProcessedStats[] = []

  logger.debug('Getting disk size stats ...')
  const stats = (await callStatServer('/disk_size')) as DiskSizeStats[]
  if (logger.isDebugEnabled()) {
    logger.debug(`Got disk size stats: ${JSON.stringify(stats)}`)
  }

  stats.forEach((element: DiskSizeStats) => {
    diskAvailableX.push({
      x: element.time,
      y:
        element.availableSizeMb && element.availableSizeMb > 0
          ? element.availableSizeMb
          : 0
    })

    diskUsedX.push({
      x: element.time,
      y: element.usedSizeMb && element.usedSizeMb > 0 ? element.usedSizeMb : 0
    })
  })

  return { diskAvailableX, diskUsedX }
}

///////////////////////////

export async function start(): Promise<boolean> {
  logger.info(`Starting stat collector ...`)

  try {
    let metricFrequency = 0
    const metricFrequencyInput: string = core.getInput('metric_frequency')
    if (metricFrequencyInput) {
      const metricFrequencyVal: number = parseInt(metricFrequencyInput)
      if (Number.isInteger(metricFrequencyVal)) {
        metricFrequency = metricFrequencyVal * 1000
      }
    }

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

    return true
  } catch (error) {
    logger.error('Unable to start stat collector')
    logger.error(error)

    return false
  }
}

export async function finish(_currentJob: WorkflowJobType): Promise<boolean> {
  logger.info(`Finishing stat collector ...`)

  try {
    // Trigger stat collect, so we will have remaining stats since the latest schedule
    await triggerStatCollect()

    logger.info(`Finished stat collector`)

    return true
  } catch (error) {
    logger.error('Unable to finish stat collector')
    logger.error(error)

    return false
  }
}

export async function report(
  _currentJob: WorkflowJobType
): Promise<string | null> {
  logger.info(`Reporting stat collector result ...`)

  try {
    const postContent: string = await reportWorkflowMetrics()

    logger.info(`Reported stat collector result`)

    return postContent
  } catch (error) {
    logger.error('Unable to report stat collector result')
    logger.error(error)

    return null
  }
}
