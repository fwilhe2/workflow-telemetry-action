import * as core from '@actions/core'

const LOG_HEADER = '[Workflow Telemetry]'

export function isDebugEnabled(): boolean {
  return core.isDebug()
}

export function debug(msg: string): void {
  core.debug(`${LOG_HEADER} ${msg}`)
}

export function info(msg: string): void {
  core.info(`${LOG_HEADER} ${msg}`)
}

export function error(msg: string | Error): void {
  if (msg instanceof String || typeof msg === 'string') {
    core.error(`${LOG_HEADER} ${msg}`)
  } else {
    core.error(`${LOG_HEADER} ${msg.name}`)
    core.error(msg)
  }
}
