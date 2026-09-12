import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ProductsService } from './service.js';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

const idParams = z.object({ id: z.uuid() });

const listQuery = z.object({
  category_id: z.uuid().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).optional(),
});

/** Thin handlers: parse → service → JSON. Errors go to the middleware. */
export function productsRouter(products: ProductsService): Router {
  const router = Router();

  router.get('/products', async (req: Request, res: Response) => {
    const params = listQuery.parse(req.query);
    res.json(await products.listProducts(params));
  });

  router.get('/products/:id', async (req: Request, res: Response) => {
    const { id } = idParams.parse(req.params);
    res.json(await products.getProduct(id));
  });

  return router;
}
