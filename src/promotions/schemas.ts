import { z } from 'zod';
import { moneyString } from '../shared/money.js';

const scopeFields = {
  product_id: z.uuid().optional(),
  category_id: z.uuid().optional(),
};

type Scope = { product_id?: string | undefined; category_id?: string | undefined };

/** A promotion has exactly one scope (mirrors the num_nonnulls CHECK). */
function exactlyOneScope(value: Scope, ctx: z.RefinementCtx): void {
  if ((value.product_id === undefined) === (value.category_id === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['product_id'],
      message: 'Exactly one of product_id or category_id is required',
    });
  }
}

export const createPromotionBody = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    ...scopeFields,
    discount_type: z.enum(['PERCENTAGE', 'FIXED']),
    value: moneyString.refine((v) => /[1-9]/.test(v), 'value must be greater than 0'),
    starts_at: z.iso.datetime({ offset: true }),
    ends_at: z.iso.datetime({ offset: true }),
  })
  .superRefine((value, ctx) => {
    exactlyOneScope(value, ctx);
    if (new Date(value.ends_at) <= new Date(value.starts_at)) {
      ctx.addIssue({ code: 'custom', path: ['ends_at'], message: 'ends_at must be after starts_at' });
    }
  });

export type CreatePromotionBody = z.infer<typeof createPromotionBody>;

export const assignPromotionBody = z.strictObject(scopeFields).superRefine(exactlyOneScope);

export type AssignPromotionBody = z.infer<typeof assignPromotionBody>;

export const idParams = z.object({ id: z.uuid() });

export const MAX_PROMOTIONS_PAGE = 100;

export const listPromotionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PROMOTIONS_PAGE).default(50),
});
