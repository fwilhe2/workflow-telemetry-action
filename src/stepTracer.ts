import { WorkflowJobType } from './interfaces/index.js'
import * as logger from './logger.js'
import {
  cell,
  chartMode,
  code,
  formatDuration,
  markdownTable,
  timelineBar
} from './charts.js'

/** A step that started and finished, which is the only kind worth drawing. */
interface TimedStep {
  readonly name: string
  readonly startTime: number
  readonly finishTime: number
  readonly conclusion: string | null
}

function timedStepsOf(job: WorkflowJobType): TimedStep[] {
  const steps: TimedStep[] = []
  for (const step of job.steps || []) {
    if (!step.started_at || !step.completed_at) {
      continue
    }
    const startTime: number = new Date(step.started_at).getTime()
    const finishTime: number = new Date(step.completed_at).getTime()
    steps.push({
      name: step.name,
      // The API has been seen to report a completion before the start; the
      // gantt path has always clamped it, and the table has the same problem.
      startTime: Math.min(startTime, finishTime),
      finishTime,
      conclusion: step.conclusion
    })
  }
  return steps
}

/**
 * The step trace as text: one row per step, with a bar placed along the job's
 * own span. It is the same picture the gantt draws, at no rendering cost.
 */
export function renderStepTable(job: WorkflowJobType): string {
  const steps: TimedStep[] = timedStepsOf(job)
  if (!steps.length) {
    return ''
  }

  const jobStart: number = Math.min(...steps.map((s) => s.startTime))
  const jobEnd: number = Math.max(...steps.map((s) => s.finishTime))
  // Every step of a job that took no measurable time still gets a full bar
  // rather than a division by zero.
  const span: number = Math.max(1, jobEnd - jobStart)

  const rows: string[][] = steps.map((step) => {
    const label: string =
      step.conclusion === 'failure' || step.conclusion === 'skipped'
        ? `${cell(step.name)} _(${step.conclusion})_`
        : cell(step.name)
    return [
      label,
      formatDuration(step.finishTime - step.startTime),
      code(
        timelineBar(
          (step.startTime - jobStart) / span,
          (step.finishTime - jobStart) / span
        )
      )
    ]
  })

  return [
    '',
    '### Step Trace',
    '',
    markdownTable(
      ['Step', 'Duration', `Timeline (${formatDuration(jobEnd - jobStart)})`],
      [':--', '--:', ':--'],
      rows
    ),
    ''
  ].join('\n')
}

function generateTraceChartForSteps(job: WorkflowJobType): string {
  let chartContent = ''

  /**
     gantt
       title Build
       dateFormat x
       axisFormat %H:%M:%S
       Set up job : milestone, 1658073446000, 1658073450000
       Collect Workflow Telemetry : 1658073450000, 1658073450000
       Run actions/checkout@v2 : 1658073451000, 1658073453000
       Set up JDK 8 : 1658073453000, 1658073458000
       Build with Maven : 1658073459000, 1658073654000
       Run invalid command : crit, 1658073655000, 1658073654000
       Archive test results : done, 1658073655000, 1658073654000
       Post Set up JDK 8 : 1658073655000, 1658073654000
       Post Run actions/checkout@v2 : 1658073655000, 1658073655000
  */

  chartContent = chartContent.concat('gantt', '\n')
  chartContent = chartContent.concat('\t', `title ${job.name}`, '\n')
  chartContent = chartContent.concat('\t', `dateFormat x`, '\n')
  chartContent = chartContent.concat('\t', `axisFormat %H:%M:%S`, '\n')

  for (const step of job.steps || []) {
    if (!step.started_at || !step.completed_at) {
      continue
    }
    chartContent = chartContent.concat(
      '\t',
      `${step.name.replace(/:/g, '-')} : `
    )

    if (step.name === 'Set up job' && step.number === 1) {
      chartContent = chartContent.concat('milestone, ')
    }

    if (step.conclusion === 'failure') {
      // to show red
      chartContent = chartContent.concat('crit, ')
    } else if (step.conclusion === 'skipped') {
      // to show grey
      chartContent = chartContent.concat('done, ')
    }

    const startTime: number = new Date(step.started_at).getTime()
    const finishTime: number = new Date(step.completed_at).getTime()
    chartContent = chartContent.concat(
      `${Math.min(startTime, finishTime)}, ${finishTime}`,
      '\n'
    )
  }

  const postContentItems: string[] = [
    '',
    '### Step Trace',
    '',
    `\`\`\`mermaid\n${chartContent}\n\`\`\``
  ]
  return postContentItems.join('\n')
}

///////////////////////////

// There is nothing to start or stop: the step timings come from the job payload
// the post step already has, so this module only reports.

export async function report(
  currentJob: WorkflowJobType
): Promise<string | null> {
  logger.info(`Reporting step tracer result ...`)

  try {
    return chartMode() === 'mermaid'
      ? generateTraceChartForSteps(currentJob)
      : renderStepTable(currentJob)
  } catch (error) {
    logger.error('Unable to report step tracer result')
    logger.error(error)

    return null
  }
}
