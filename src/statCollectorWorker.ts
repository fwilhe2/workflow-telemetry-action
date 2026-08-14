import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import si from 'systeminformation'
import * as logger from './logger.js'
import { StatSample } from './interfaces/index.js'

const STATS_FREQ: number =
  parseInt(process.env.WORKFLOW_TELEMETRY_STAT_FREQ || '') || 5000
// Must agree with `statCollector`, which reads the same variable and passes its
// environment on when spawning this process. Overriding it is only really
// useful to the smoke test, which runs the worker off the default port.
const SERVER_PORT: number =
  parseInt(process.env.WORKFLOW_TELEMETRY_SERVER_PORT || '') || 7777

const MB = 1024 * 1024

let expectedScheduleTime = 0
let statCollectTime = 0

///////////////////////////

interface Collector {
  /** The path this collector's history is served from. */
  readonly route: string
  readonly history: StatSample[]
  /** `interval` is milliseconds since the previous sample, 0 for the first. */
  read(interval: number): Promise<Record<string, number>>
}

/** A per-second rate, as whole megabytes moved over the sample interval. */
function movedMb(perSecond: number, interval: number): number {
  return Math.floor((perSecond * (interval / 1000)) / MB)
}

const collectors: Collector[] = [
  {
    route: '/cpu',
    history: [],
    read: async () => {
      const data = await si.currentLoad()
      return {
        userLoad: data.currentLoadUser,
        systemLoad: data.currentLoadSystem
      }
    }
  },
  {
    route: '/memory',
    history: [],
    read: async () => {
      const data = await si.mem()
      return {
        activeMemoryMb: data.active / MB,
        availableMemoryMb: data.available / MB
      }
    }
  },
  {
    route: '/network',
    history: [],
    read: async (interval) => {
      const data = await si.networkStats()
      return {
        rxMb: movedMb(
          data.reduce((total, nsd) => total + nsd.rx_sec, 0),
          interval
        ),
        txMb: movedMb(
          data.reduce((total, nsd) => total + nsd.tx_sec, 0),
          interval
        )
      }
    }
  },
  {
    route: '/disk',
    history: [],
    read: async (interval) => {
      const data = await si.fsStats()
      return {
        rxMb: movedMb(data.rx_sec || 0, interval),
        wxMb: movedMb(data.wx_sec || 0, interval)
      }
    }
  },
  {
    route: '/disk_size',
    history: [],
    read: async () => {
      const data = await si.fsSize()
      const totalSize: number = data.reduce((total, fsd) => total + fsd.size, 0)
      const usedSize: number = data.reduce((total, fsd) => total + fsd.used, 0)
      return {
        availableSizeMb: Math.floor((totalSize - usedSize) / MB),
        usedSizeMb: Math.floor(usedSize / MB)
      }
    }
  }
]

///////////////////////////

/**
 * Resolves once every sample has actually been recorded. `/collect` is what the
 * post step calls to capture the tail of the job, and it must not answer before
 * that sample is in the histories, or the collector reads the response and
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
    await Promise.all(
      collectors.map(async (collector) => {
        try {
          collector.history.push({
            time: statCollectTime,
            ...(await collector.read(timeInterval))
          })
        } catch (error) {
          logger.error(error)
        }
      })
    )
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
      const fail = (statusCode: number): void => {
        response.statusCode = statusCode
        response.end()
      }
      try {
        if (request.url === '/collect') {
          if (request.method !== 'POST') {
            return fail(405)
          }
          await collectStats(false)
          return response.end()
        }
        const collector: Collector | undefined = collectors.find(
          (it) => it.route === request.url
        )
        if (!collector) {
          return fail(404)
        }
        if (request.method !== 'GET') {
          return fail(405)
        }
        response.end(JSON.stringify(collector.history))
      } catch (error) {
        // The detail goes to the job log and not into the response. Serialising
        // an exception's name and message over HTTP is what CodeQL flags as
        // stack-trace exposure, and it buys nothing here: the only client is
        // `callStatServer` in statCollector.ts, which raises its own error from
        // the status code and never reads this body. The log is where the cause
        // is actually wanted, and `logger.error` already puts it there.
        logger.error(error)
        fail(500)
      }
    }
  )

  server.listen(SERVER_PORT, 'localhost', () => {
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
