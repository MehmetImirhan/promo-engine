import { env } from './config/index.js';
import { createLogger } from './shared/logger.js';

/**
 * Ingest worker entry point. The splitter/processor pipeline (ADR §7) is
 * implemented in a later session; this stub keeps `npm run worker` honest.
 */
const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' });
logger.warn('ingest worker is not implemented yet; exiting');
