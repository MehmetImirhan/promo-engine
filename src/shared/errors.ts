/**
 * Typed application errors. Services throw these; the single error middleware
 * in `src/shared/error-middleware.ts` maps them to HTTP. Nothing else should
 * decide status codes.
 */
export abstract class AppError extends Error {
  abstract readonly status: number;
  abstract readonly code: string;
  readonly details: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

export class NotFound extends AppError {
  readonly status = 404;
  readonly code = 'NOT_FOUND';
}

export class Conflict extends AppError {
  readonly status = 409;
  readonly code = 'CONFLICT';
}

export class Validation extends AppError {
  readonly status = 400;
  readonly code = 'VALIDATION_ERROR';
}
