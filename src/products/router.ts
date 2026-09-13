import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { moneyString } from '../shared/money.js';
import type { ProductsService } from './service.js';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_SEARCH_RESULTS = 20;

const idParams = z.object({ id: z.uuid() });

const createBody = z.strictObject({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  category_id: z.uuid(),
  base_price: moneyString,
  stock_quantity: z.number().int().min(0).default(0),
});

/** At least two characters: every search without a text index is a scan, so single keystrokes are not worth one. */
const searchQuery = z.object({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_RESULTS).default(8),
});

const listQuery = z.object({
  category_id: z.uuid().optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).optional(),
});

/** Thin handlers: parse → service → JSON. Errors go to the middleware. */
export function productsRouter(products: ProductsService): Router {
  const router = Router();

  router.get('/categories', async (_req: Request, res: Response) => {
    res.json({ items: await products.listCategories() });
  });

  router.get('/products', async (req: Request, res: Response) => {
    const params = listQuery.parse(req.query);
    res.json(await products.listProducts(params));
  });

  router.post('/products', async (req: Request, res: Response) => {
    const body = createBody.parse(req.body);
    res.status(201).json(await products.createProduct(body));
  });

  // Registered before /products/:id, which would otherwise reject "search" as a malformed uuid.
  router.get('/products/search', async (req: Request, res: Response) => {
    const { q, limit } = searchQuery.parse(req.query);
    res.json({ items: await products.searchProducts(q, limit) });
  });

  router.get('/products/:id', async (req: Request, res: Response) => {
    const { id } = idParams.parse(req.params);
    res.json(await products.getProduct(id));
  });

  return router;
}
