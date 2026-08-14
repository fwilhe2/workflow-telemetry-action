import * as statCollector from './statCollector.js'
import * as processTracer from './processTracer.js'
import * as logger from './logger.js'

async function run(): Promise<void> {
  // Telemetry must never fail the job it is measuring, so nothing escapes here.
  try {
    logger.info(`Initializing ...`)

    await statCollector.start()
    await processTracer.start()

    logger.info(`Initialization completed`)
  } catch (error) {
    logger.error(logger.messageOf(error))
  }
}

run()
