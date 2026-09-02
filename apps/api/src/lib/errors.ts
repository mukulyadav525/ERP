/** Errors that carry an HTTP status, so routes can `throw` instead of threading
 *  reply objects through helper functions. The error handler in index.ts turns
 *  these into clean JSON and lets anything else become a generic 500 (never
 *  leaking a stack trace or SQL text to the client). */
export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public details?: unknown) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest   = (m: string, d?: unknown) => new HttpError(400, m, d);
export const unauthorized = (m = 'Not authenticated')  => new HttpError(401, m);
export const forbidden    = (m = 'Access denied')      => new HttpError(403, m);
export const notFound     = (m = 'Not found')          => new HttpError(404, m);
export const conflict     = (m: string)                => new HttpError(409, m);
export const tooMany      = (m = 'Too many attempts')  => new HttpError(429, m);
