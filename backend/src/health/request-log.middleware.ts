import type { NextFunction, Request, Response } from 'express';
import { HealthService } from './health.service';

/**
 * Express middleware feeding the "last 5 requests" list on `GET /health`.
 *
 * It is installed from `configureApp()` with `app.use(...)` rather than through
 * Nest's `MiddlewareConsumer.forRoutes('*')`. Reason: Express 5 changed wildcard
 * syntax (a bare `'*'` is no longer a valid path pattern), so a consumer rule
 * would have to be version-specific, while `app.use(handler)` with no path
 * matches every route on every Express version. It also means the automated API
 * tests exercise the exact same logging path as `main.ts`.
 *
 * Privacy: it never reads the body, never reads headers (so no `Authorization`
 * value can be captured) and strips the query string. `GET /health` and `GET /`
 * are excluded, otherwise a 10-second defense monitor would fill the buffer and
 * hide the real user traffic it is meant to show.
 */
export function createRequestLogMiddleware(
  health: HealthService,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const started = Date.now();
    const path = req.originalUrl.split('?')[0];

    if (path === '/health' || path === '/') {
      next();
      return;
    }

    // `finish` fires once the response is flushed, so `statusCode` is final:
    // a request rejected by a guard (401) or by validation (400) is counted as
    // an error, which is exactly what an operator wants to see.
    res.on('finish', () => {
      health.record({
        method: req.method,
        path,
        status: res.statusCode,
        ms: Date.now() - started,
        at: new Date().toISOString(),
      });
    });

    next();
  };
}
