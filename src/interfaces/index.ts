import { components } from '@octokit/openapi-types'

export type WorkflowJobType = components['schemas']['job']

export interface CPUStats {
  readonly time: number
  readonly userLoad: number
  readonly systemLoad: number
}

export interface MemoryStats {
  readonly time: number
  readonly activeMemoryMb: number
  readonly availableMemoryMb: number
}

export interface NetworkStats {
  readonly time: number
  readonly rxMb: number
  readonly txMb: number
}

export interface DiskStats {
  readonly time: number
  readonly rxMb: number
  readonly wxMb: number
}

export interface DiskSizeStats {
  readonly time: number
  readonly availableSizeMb: number
  readonly usedSizeMb: number
}

export interface ProcessedStats {
  readonly x: number
  readonly y: number
}

export interface ProcessedCPUStats {
  readonly userLoadX: ProcessedStats[]
  readonly systemLoadX: ProcessedStats[]
}

export interface ProcessedMemoryStats {
  readonly activeMemoryX: ProcessedStats[]
  readonly availableMemoryX: ProcessedStats[]
}

export interface ProcessedNetworkStats {
  readonly networkReadX: ProcessedStats[]
  readonly networkWriteX: ProcessedStats[]
}

export interface ProcessedDiskStats {
  readonly diskReadX: ProcessedStats[]
  readonly diskWriteX: ProcessedStats[]
}

export interface ProcessedDiskSizeStats {
  readonly diskAvailableX: ProcessedStats[]
  readonly diskUsedX: ProcessedStats[]
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
