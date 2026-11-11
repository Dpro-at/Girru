/**
 * Centralized Error Handling Utility
 *
 * SECURITY: Prevents information disclosure via verbose error messages (H-09)
 * - Logs only safe error fields server-side (name, code, status; H-ERR-01)
 * - Returns sanitized generic messages to clients
 * - Includes error tracking IDs for support
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { getTranslator } from '../i18n/index.js';
import { safeErrorFields } from './safe-error-log.js';

/**
 * Error categories for proper HTTP status codes
 */
export type ErrorCategory =
  | 'validation'      // 400 Bad Request
  | 'authentication'  // 401 Unauthorized
  | 'authorization'   // 403 Forbidden
  | 'not_found'       // 404 Not Found
  | 'conflict'        // 409 Conflict
  | 'rate_limit'      // 429 Too Many Requests
  | 'internal';       // 500 Internal Server Error

/**
 * Standard error response structure
 */
export interface ErrorResponse {
  error: string;
  errorId?: string;
  details?: string;
}

/**
 * Translation keys for safe error messages (resolved via i18n at runtime)
 */
const SAFE_ERROR_KEYS: Record<ErrorCategory, string> = {
  validation: 'validation',
  authentication: 'authentication',
  authorization: 'authorization',
  not_found: 'notFound',
  conflict: 'conflict',
  rate_limit: 'rateLimit',
  internal: 'internal',
};

/**
 * HTTP status codes for error categories
 */
const ERROR_STATUS_CODES: Record<ErrorCategory, number> = {
  validation: 400,
  authentication: 401,
  authorization: 403,
  not_found: 404,
  conflict: 409,
  rate_limit: 429,
  internal: 500,
};

/**
 * Handle errors with proper logging and sanitized responses
 *
 * SECURITY: Never expose internal error details to clients (H-09)
 *
 * @param reply - Fastify reply object
 * @param error - The error that occurred
 * @param category - Error category for proper status code
 * @param context - Context string for logging (e.g., '[Auth] Login failed')
 * @param userMessage - Optional user-friendly message (must be safe!)
 */
export function handleError(
  reply: { request?: unknown; status(code: number): { send(body: unknown): unknown } },
  error: unknown,
  category: ErrorCategory = 'internal',
  context: string = '[API]',
  userMessage?: string
): void {
  // Token errors thrown by getUserIdFromRequest() ("Unauthorized: ...") are
  // authentication failures, not server errors (S0-A.3).
  if (category === 'internal' && error instanceof Error && error.message.startsWith('Unauthorized:')) {
    category = 'authentication';
  }

  // Generate unique error ID for tracking
  const errorId = randomUUID();

  // SECURITY (H-09, H-ERR-01): the log gets only safe fields (name, code,
  // status). The message and stack can hold SQL, paths, tokens or the
  // prompt, so they reach neither the client nor the log.
  console.error(`${context} Error [${errorId}]:`, safeErrorFields(error));

  // SECURITY: Return sanitized error to client (H-09)
  // i18n: Translate error message based on request locale
  const locale = (reply.request as any)?.locale || 'en';
  const t = getTranslator(locale);
  const statusCode = ERROR_STATUS_CODES[category];
  const safeMessage = userMessage || t(SAFE_ERROR_KEYS[category]);

  const response: ErrorResponse = {
    error: safeMessage,
    errorId: category === 'internal' ? errorId : undefined, // Include ID only for 500 errors
  };

  reply.status(statusCode).send(response);
}

/**
 * Handle validation errors with field-specific details
 * Safe to expose as they don't leak system internals
 */
export function handleValidationError(
  reply: FastifyReply,
  message: string,
  context: string = '[Validation]'
): void {
  console.warn(`${context} Validation failed: ${message}`);

  reply.status(400).send({
    error: 'Invalid input data',
    details: message, // Validation errors are safe to expose
  });
}

/**
 * Check if error is a known safe error type that can be exposed
 */
function isSafeError(error: unknown): error is { message: string; code?: string } {
  if (!(error instanceof Error)) return false;

  // JWT errors are safe to expose (already sanitized)
  if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
    return true;
  }

  // Validation errors are safe
  if (error.name === 'ValidationError') {
    return true;
  }

  return false;
}

/**
 * Smart error handler that detects safe vs unsafe errors
 */
export function handleSmartError(
  reply: FastifyReply,
  error: unknown,
  context: string = '[API]'
): void {
  // Authentication errors (JWT)
  if (error instanceof Error && (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError')) {
    return handleError(reply, error, 'authentication', context, 'Invalid or expired token');
  }

  // Safe errors can expose message
  if (isSafeError(error)) {
    const category: ErrorCategory = error.message.includes('not found') ? 'not_found' : 'validation';
    return handleError(reply, error, category, context, error.message);
  }

  // Unknown errors - hide details
  return handleError(reply, error, 'internal', context);
}

/** Fixed body for an unexpected 500 (FU-03). */
export const INTERNAL_ERROR_BODY = Object.freeze({ error: 'Internal error', code: 'internal_error' });

/**
 * Reply 500 with the fixed generic body and log only safe fields (FU-03).
 *
 * The error message, stack and any attached text (stderr, SQL, paths, the
 * prompt) never reach the client or the log; the log line names the route.
 */
export function sendInternalError(reply: FastifyReply, route: string, error: unknown): FastifyReply {
  console.error(`${route} internal error`, safeErrorFields(error));
  return reply.status(500).send({ ...INTERNAL_ERROR_BODY });
}

/** The HTTP status an error carries (statusCode, else status), or undefined. */
function errorStatusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { statusCode?: unknown; status?: unknown };
  const s = e.statusCode ?? e.status;
  return typeof s === 'number' && Number.isInteger(s) ? s : undefined;
}

/**
 * Global Fastify error handler (H-ERR-01).
 *
 * - An error that carries a 4xx status (Fastify schema validation, FST_*
 *   codes, rate-limit 429, typed route errors) goes to Fastify's default
 *   handler, so its status, body and log stay exactly as before.
 * - Anything else (5xx or no status) answers the fixed INTERNAL_ERROR_BODY.
 *   The log line names the method and the route pattern (never the URL with
 *   its query string) plus safe error fields only.
 *
 * Register it on the root instance before any route plugin: encapsulated
 * child contexts inherit the handler unless they set their own.
 */
export function registerGlobalErrorHandler(fastify: FastifyInstance): void {
  const fastifyDefault = fastify.errorHandler;
  fastify.setErrorHandler(function globalErrorHandler(error, request, reply) {
    const status = errorStatusOf(error);
    if (status !== undefined && status >= 400 && status < 500) {
      return fastifyDefault.call(this, error, request, reply);
    }
    const route = `${request.method} ${request.routeOptions?.url ?? 'unknown route'}`;
    console.error(`[API] ${route} internal error`, safeErrorFields(error));
    const code = status !== undefined && status >= 500 && status <= 599 ? status : 500;
    return reply.status(code).send({ ...INTERNAL_ERROR_BODY });
  });
}
