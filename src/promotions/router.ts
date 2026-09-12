import { Router, type Request, type Response } from 'express';
import { assignPromotionBody, createPromotionBody, idParams } from './schemas.js';
import type { PromotionsService } from './service.js';

/** Thin handlers: parse → service → JSON. Errors go to the middleware. */
export function promotionsRouter(promotions: PromotionsService): Router {
  const router = Router();

  router.post('/promotions', async (req: Request, res: Response) => {
    const body = createPromotionBody.parse(req.body);
    res.status(201).json(await promotions.create(body));
  });

  router.post('/promotions/:id/cancel', async (req: Request, res: Response) => {
    const { id } = idParams.parse(req.params);
    res.json(await promotions.cancel(id));
  });

  router.post('/promotions/:id/assign', async (req: Request, res: Response) => {
    const { id } = idParams.parse(req.params);
    const body = assignPromotionBody.parse(req.body);
    res.json(await promotions.assign(id, body));
  });

  return router;
}
