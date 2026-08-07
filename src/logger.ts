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

/**
 * Best-effort message for a value caught by a `catch` block, which TypeScript
 * types as `unknown` because anything at all can be thrown.
 */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function error(msg: unknown): void {
  if (msg instanceof String || typeof msg === 'string') {
    core.error(`${LOG_HEADER} ${msg}`)
  } else if (msg instanceof Error) {
    core.error(`${LOG_HEADER} ${msg.name}`)
    core.error(msg)
  } else {
    core.error(`${LOG_HEADER} ${String(msg)}`)
  }
}
