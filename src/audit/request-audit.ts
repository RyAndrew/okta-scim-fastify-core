// ---------------------------------------------------------------------------
// Request auditing and request ⇄ backend-operation correlation.
//
// - `registerRequestAudit` writes one `requests` row per HTTP round trip.
// - `inRequestContext` makes the current request visible to backend code, so
//   backends never pass request ids around.
// - `createBackendAudit` is what a backend receives as `context.audit`.
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from 'async_hooks';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import type { BackendAudit, BackendOperation } from '../backend';
import { redact } from '../redact';
import type { AuditSink } from './sink';

interface RequestAuditContext {
  requestId: string;
  startedAt: number;
  notes: Record<string, unknown>;
  responseBody: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auditContext: RequestAuditContext | null;
  }
}

const storage = new AsyncLocalStorage<RequestAuditContext>();

/** Run a route handler so that backend operations are linked to `request`. */
export function inRequestContext<T>(request: FastifyRequest, fn: () => Promise<T>): Promise<T> {
  if (!request.auditContext) {
    throw new Error('Request audit is not registered on this server.');
  }
  return storage.run(request.auditContext, fn);
}

/** Attach a fact to the current request's audit row. */
export function auditNote(key: string, value: unknown): void {
  const context = storage.getStore();
  if (!context) throw new Error('auditNote called outside a request context.');
  context.notes[key] = value;
}

function redactedJson(text: string): string {
  try {
    return JSON.stringify(redact(JSON.parse(text)));
  } catch {
    // Not JSON (e.g. a malformed request body): store a marker, never the raw text,
    // because an unparseable body could still contain a secret.
    return JSON.stringify({ unparseable: true, length: text.length });
  }
}

/** Register the hooks that write one audit row per request. */
export function registerRequestAudit(server: FastifyInstance, sink: AuditSink): void {
  server.decorateRequest('auditContext', null);

  server.addHook('onRequest', async (request) => {
    request.auditContext = {
      requestId: request.id,
      startedAt: Date.now(),
      notes: {},
      responseBody: null,
    };
  });

  server.addHook('onSend', async (request, _reply, payload) => {
    if (request.auditContext) {
      if (typeof payload === 'string') request.auditContext.responseBody = payload;
      else if (Buffer.isBuffer(payload)) request.auditContext.responseBody = payload.toString('utf8');
    }
    return payload;
  });

  server.addHook('onResponse', async (request, reply) => {
    const context = request.auditContext;
    if (!context) return;

    const body = request.body;
    const requestBody =
      body === undefined || body === null
        ? null
        : typeof body === 'string'
          ? redactedJson(body)
          : JSON.stringify(redact(body));

    sink
      .recordRequest({
        requestId: context.requestId,
        method: request.method,
        url: request.url,
        ip: request.ip,
        requestBody,
        responseStatus: reply.statusCode,
        responseBody: context.responseBody ? redactedJson(context.responseBody) : null,
        durationMs: Date.now() - context.startedAt,
        notes: Object.keys(context.notes).length > 0 ? context.notes : null,
        createdAt: new Date(context.startedAt).toISOString(),
      })
      .catch((err: unknown) => server.log.error({ err }, 'Failed to write request audit row'));
  });
}

/** Build the `audit` object handed to a backend module. */
export function createBackendAudit(
  backendName: string,
  sink: AuditSink,
  log: FastifyBaseLogger,
): BackendAudit {
  return {
    async run<T>(operation: BackendOperation, fn: () => Promise<T>): Promise<T> {
      const startedAt = Date.now();
      const requestId = storage.getStore()?.requestId ?? null;

      const record = (error: unknown): void => {
        sink
          .recordBackendOperation({
            requestId,
            backend: backendName,
            operation: operation.operation,
            target: operation.target ?? null,
            params: redact(operation.params),
            success: error === undefined,
            error: error === undefined ? null : describeError(error),
            durationMs: Date.now() - startedAt,
            createdAt: new Date(startedAt).toISOString(),
          })
          .catch((err: unknown) => log.error({ err }, 'Failed to write backend audit row'));
      };

      try {
        const result = await fn();
        record(undefined);
        return result;
      } catch (err) {
        record(err);
        throw err;
      }
    },
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${error.name}${code !== undefined ? ` (${String(code)})` : ''}: ${error.message}`;
  }
  return String(error);
}
