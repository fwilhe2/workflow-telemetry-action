import * as stepTracer from './stepTracer.js'
import * as statCollector from './statCollector.js'
import * as processTracer from './processTracer.js'
import * as logger from './logger.js'

async function run(): Promise<void> {
  try {
    logger.info(`Initializing ...`)

    // Start step tracer
    await stepTracer.start()
    // Start stat collector
    await statCollector.start()
    // Start process tracer
    await processTracer.start()

    logger.info(`Initialization completed`)
  } catch (error) {
    logger.error(logger.messageOf(error))
  }
}

run()
