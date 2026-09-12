import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from './errors.js';

/** Every error response has this shape. */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
}

/** body-parser / http-errors shape: a client-side HTTP error with an explicit status. */
interface HttpErrorLike {
  status: number;
  message: string;
  expose?: boolean;
}

function isHttpErrorLike(err: unknown): err is HttpErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as HttpErrorLike).status === 'number' &&
    (err as HttpErrorLike).status >= 400 &&
    (err as HttpErrorLike).status < 500
  );
}

function send(res: Response, status: number, body: ErrorBody): void {
  res.status(status).json(body);
}

export function notFoundHandler(req: Request, res: Response): void {
  send(res, 404, {
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
    requestId: String(req.id),
  });
}

/**
 * The one place errors become HTTP responses.
 * Express 5 forwards rejected async handlers here automatically.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = String(req.id);

  if (err instanceof AppError) {
    send(res, err.status, {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
      requestId,
    });
    return;
  }

  if (err instanceof ZodError) {
    send(res, 400, {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
      },
      requestId,
    });
    return;
  }

  if (isHttpErrorLike(err)) {
    // e.g. malformed JSON body from express.json()
    send(res, err.status, {
      error: { code: 'BAD_REQUEST', message: err.expose === false ? 'Bad request' : err.message },
      requestId,
    });
    return;
  }

  req.log.error({ err }, 'unhandled error');
  send(res, 500, {
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    requestId,
  });
}
