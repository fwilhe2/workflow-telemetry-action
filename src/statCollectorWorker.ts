import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import si from 'systeminformation'
import * as logger from './logger.js'
import {
  CPUStats,
  MemoryStats,
  DiskStats,
  NetworkStats,
  DiskSizeStats
} from './interfaces/index.js'

const STATS_FREQ: number =
  parseInt(process.env.WORKFLOW_TELEMETRY_STAT_FREQ || '') || 5000
const SERVER_HOST = 'localhost'
// Must agree with `statCollector`, which reads the same variable and passes its
// environment on when spawning this process. Overriding it is only really
// useful to the smoke test, which runs the worker off the default port.
const SERVER_PORT: number =
  parseInt(process.env.WORKFLOW_TELEMETRY_SERVER_PORT || '') || 7777

let expectedScheduleTime = 0
let statCollectTime = 0

///////////////////////////

// CPU Stats             //
///////////////////////////

const cpuStatsHistogram: CPUStats[] = []

async function collectCPUStats(
  statTime: number,
  _timeInterval: number
): Promise<void> {
  return si
    .currentLoad()
    .then((data: si.Systeminformation.CurrentLoadData) => {
      const cpuStats: CPUStats = {
        time: statTime,
        userLoad: data.currentLoadUser,
        systemLoad: data.currentLoadSystem
      }
      cpuStatsHistogram.push(cpuStats)
    })
    .catch((error: unknown) => {
      logger.error(error)
    })
}

///////////////////////////

// Memory Stats          //
///////////////////////////

const memoryStatsHistogram: MemoryStats[] = []

async function collectMemoryStats(
  statTime: number,
  _timeInterval: number
): Promise<void> {
  return si
    .mem()
    .then((data: si.Systeminformation.MemData) => {
      const memoryStats: MemoryStats = {
        time: statTime,
        activeMemoryMb: data.active / 1024 / 1024,
        availableMemoryMb: data.available / 1024 / 1024
      }
      memoryStatsHistogram.push(memoryStats)
    })
    .catch((error: unknown) => {
      logger.error(error)
    })
}

///////////////////////////

// Network Stats         //
///////////////////////////

const networkStatsHistogram: NetworkStats[] = []

async function collectNetworkStats(
  statTime: number,
  timeInterval: number
): Promise<void> {
  return si
    .networkStats()
    .then((data: si.Systeminformation.NetworkStatsData[]) => {
      let totalRxSec = 0
      let totalTxSec = 0
      for (const nsd of data) {
        totalRxSec += nsd.rx_sec
        totalTxSec += nsd.tx_sec
      }
      const networkStats: NetworkStats = {
        time: statTime,
        rxMb: Math.floor((totalRxSec * (timeInterval / 1000)) / 1024 / 1024),
        txMb: Math.floor((totalTxSec * (timeInterval / 1000)) / 1024 / 1024)
      }
      networkStatsHistogram.push(networkStats)
    })
    .catch((error: unknown) => {
      logger.error(error)
    })
}

///////////////////////////

// Disk Stats            //
///////////////////////////

const diskStatsHistogram: DiskStats[] = []

async function collectDiskStats(
  statTime: number,
  timeInterval: number
): Promise<void> {
  return si
    .fsStats()
    .then((data: si.Systeminformation.FsStatsData) => {
      const rxSec = data.rx_sec ? data.rx_sec : 0
      const wxSec = data.wx_sec ? data.wx_sec : 0
      const diskStats: DiskStats = {
        time: statTime,
        rxMb: Math.floor((rxSec * (timeInterval / 1000)) / 1024 / 1024),
        wxMb: Math.floor((wxSec * (timeInterval / 1000)) / 1024 / 1024)
      }
      diskStatsHistogram.push(diskStats)
    })
    .catch((error: unknown) => {
      logger.error(error)
    })
}

const diskSizeStatsHistogram: DiskSizeStats[] = []

async function collectDiskSizeStats(
  statTime: number,
  _timeInterval: number
): Promise<void> {
  return si
    .fsSize()
    .then((data: si.Systeminformation.FsSizeData[]) => {
      let totalSize = 0
      let usedSize = 0
      for (const fsd of data) {
        totalSize += fsd.size
        usedSize += fsd.used
      }
      const diskSizeStats: DiskSizeStats = {
        time: statTime,
        availableSizeMb: Math.floor((totalSize - usedSize) / 1024 / 1024),
        usedSizeMb: Math.floor(usedSize / 1024 / 1024)
      }
      diskSizeStatsHistogram.push(diskSizeStats)
    })
    .catch((error: unknown) => {
      logger.error(error)
    })
}

///////////////////////////

/**
 * Resolves once every sample has actually been recorded. `/collect` is what the
 * post step calls to capture the tail of the job, and it must not answer before
 * that sample is in the histograms, or the collector reads the response and
 * misses it.
 */
async function collectStats(triggeredFromScheduler = true): Promise<void> {
  try {
    const currentTime: number = Date.now()
    const timeInterval: number = statCollectTime
      ? currentTime - statCollectTime
      : 0

    statCollectTime = currentTime

    // Each collector handles its own errors, so this never rejects.
    await Promise.all([
      collectCPUStats(statCollectTime, timeInterval),
      collectMemoryStats(statCollectTime, timeInterval),
      collectNetworkStats(statCollectTime, timeInterval),
      collectDiskStats(statCollectTime, timeInterval),
      collectDiskSizeStats(statCollectTime, timeInterval)
    ])
  } finally {
    if (triggeredFromScheduler) {
      // Scheduled against an absolute time, so a slow collection shortens the
      // next wait rather than pushing every later sample back.
      expectedScheduleTime += STATS_FREQ
      setTimeout(collectStats, expectedScheduleTime - Date.now())
    }
  }
}

function startHttpServer(): void {
  const server: Server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      try {
        switch (request.url) {
          case '/cpu': {
            if (request.method === 'GET') {
              response.end(JSON.stringify(cpuStatsHistogram))
            } else {
              response.statusCode = 405
              response.end()
            }
            break
          }
          case '/memory': {
            if (request.method === 'GET') {
              response.end(JSON.stringify(memoryStatsHistogram))
            } else {
              response.statusCode = 405
              response.end()
            }
            break
          }
          case '/network': {
            if (request.method === 'GET') {
              response.end(JSON.stringify(networkStatsHistogram))
            } else {
              response.statusCode = 405
              response.end()
            }
            break
          }
          case '/disk': {
            if (request.method === 'GET') {
              response.end(JSON.stringify(diskStatsHistogram))
            } else {
              response.statusCode = 405
              response.end()
            }
            break
          }
          case '/disk_size': {
            if (request.method === 'GET') {
              response.end(JSON.stringify(diskSizeStatsHistogram))
            } else {
              response.statusCode = 405
              response.end()
            }
            break
          }
          case '/collect': {
            if (request.method === 'POST') {
              await collectStats(false)
              response.end()
            } else {
              response.statusCode = 405
              response.end()
            }
            break
          }
          default: {
            response.statusCode = 404
            response.end()
          }
        }
      } catch (error) {
        // The detail goes to the job log and not into the response. Serialising
        // an exception's name and message over HTTP is what CodeQL flags as
        // stack-trace exposure, and it buys nothing here: the only client is
        // `callStatServer` in statCollector.ts, which raises its own error from
        // the status code and never reads this body. The log is where the cause
        // is actually wanted, and `logger.error` already puts it there.
        logger.error(error)
        response.statusCode = 500
        response.end()
      }
    }
  )

  server.listen(SERVER_PORT, SERVER_HOST, () => {
    logger.info(`Stat server listening on port ${SERVER_PORT}`)
  })
}

// Init                  //
///////////////////////////

function init(): void {
  expectedScheduleTime = Date.now()

  logger.info('Starting stat collector ...')
  process.nextTick(collectStats)

  logger.info('Starting HTTP server ...')
  startHttpServer()
}

init()

///////////////////////////
