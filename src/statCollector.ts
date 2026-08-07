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

const STAT_SERVER_PORT = 7777

// Mermaid renders every sample as a tick, so a long job would produce an
// unreadable chart (and a very large summary). Longer runs are downsampled.
const MAX_CHART_POINTS = 120

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

/** Renders a chart only when there is data to plot. */
function chartFor(
  title: string,
  yAxisLabel: string,
  points: ProcessedStats[]
): string | null {
  return points && points.length ? renderChart(title, yAxisLabel, points) : null
}

async function reportWorkflowMetrics(): Promise<string> {
  const { userLoadX, systemLoadX } = await getCPUStats()
  const { activeMemoryX, availableMemoryX } = await getMemoryStats()
  const { networkReadX, networkWriteX } = await getNetworkStats()
  const { diskReadX, diskWriteX } = await getDiskStats()
  const { diskAvailableX, diskUsedX } = await getDiskSizeStats()

  const sections: Array<{ heading: string; charts: Array<string | null> }> = [
    {
      heading: '### CPU Metrics',
      charts: [
        chartFor('CPU Load - User (%)', 'Load (%)', userLoadX),
        chartFor('CPU Load - System (%)', 'Load (%)', systemLoadX)
      ]
    },
    {
      heading: '### Memory Metrics',
      charts: [
        chartFor('Memory Usage - Used (MB)', 'Memory (MB)', activeMemoryX),
        chartFor('Memory Usage - Free (MB)', 'Memory (MB)', availableMemoryX)
      ]
    },
    {
      heading: '### IO Metrics',
      charts: [
        chartFor('Network I/O - Read (MB)', 'Network (MB)', networkReadX),
        chartFor('Network I/O - Write (MB)', 'Network (MB)', networkWriteX),
        chartFor('Disk I/O - Read (MB)', 'Disk (MB)', diskReadX),
        chartFor('Disk I/O - Write (MB)', 'Disk (MB)', diskWriteX)
      ]
    },
    {
      heading: '### Disk Size Metrics',
      charts: [
        chartFor('Disk Usage - Used (MB)', 'Disk (MB)', diskUsedX),
        chartFor('Disk Usage - Free (MB)', 'Disk (MB)', diskAvailableX)
      ]
    }
  ]

  const postContentItems: string[] = []
  for (const section of sections) {
    const rendered: string[] = section.charts.filter(
      (c): c is string => c !== null
    )
    if (rendered.length) {
      postContentItems.push(section.heading, ...rendered)
    }
  }

  return postContentItems.join('\n')
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
