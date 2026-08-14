import { components } from '@octokit/openapi-types'

export type WorkflowJobType = components['schemas']['job']

/**
 * One sample as the stat server serves it: a timestamp plus whatever numbers
 * the collector that produced it reports. The names are agreed between the
 * collector in `statCollectorWorker` and the metric table in `statCollector`.
 */
export type StatSample = { time: number } & Record<string, number>

export interface ProcessedStats {
  readonly x: number
  readonly y: number
}

export interface CompletedCommand {
  /** Wall clock time of the exec, as `HH:MM:SS`. */
  readonly ts: string
  readonly name: string
  /** Owning user's name. forkstat reports names rather than numeric uids. */
  readonly user: string
  readonly pid: number
  /** 0 when the fork that created this process was not observed. */
  readonly ppid: number
  readonly startTime: number
  readonly fileName: string
  readonly args: string[]
  readonly duration: number
  readonly exitCode: number
  readonly order: number
}

export interface ProcEventParseOptions {
  readonly minDuration: number
  /** Anchors forkstat's time-only stamps to a date. Defaults to now. */
  readonly startedAt?: Date
}
