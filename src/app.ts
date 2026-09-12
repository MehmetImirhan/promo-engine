import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { pinoHttp } from 'pino-http';
import type { Redis } from './cache/redis.js';
import type { Db, Pool } from './db/index.js';
import { productsRouter } from './products/router.js';
import { createProductsService } from './products/service.js';
import { errorHandler, notFoundHandler } from './shared/error-middleware.js';
import type { Logger } from './shared/logger.js';

export interface AppDeps {
  pool: Pool;
  db: Db;
  redis: Redis;
  logger: Logger;
}

type CheckStatus = 'ok' | 'down';

async function check(probe: () => Promise<unknown>): Promise<CheckStatus> {
  try {
    await probe();
    return 'ok';
  } catch {
    return 'down';
  }
}

export function createApp({ pool, db, redis, logger }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
    }),
  );

  app.use(express.json({ limit: '1mb' }));

  /** Liveness: the process is up. Touches no dependencies. */
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  /** Readiness: Postgres and Redis both answer. 503 with per-dependency detail otherwise. */
  app.get('/ready', async (_req: Request, res: Response) => {
    const [postgres, redisStatus] = await Promise.all([
      check(() => pool.query('SELECT 1')),
      check(() => redis.ping()),
    ]);
    const ready = postgres === 'ok' && redisStatus === 'ok';
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ok' : 'degraded',
      checks: { postgres, redis: redisStatus },
    });
  });

  app.use(productsRouter(createProductsService(db)));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
