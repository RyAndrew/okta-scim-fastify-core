// ---------------------------------------------------------------------------
// Request body handling for SCIM write routes (POST / PUT / PATCH)
//
// Ensures the body was sent as JSON and parsed into an object before any
// route handler inspects individual attributes, and reports content-type and
// parse failures as SCIM errors (RFC 7644 §3.12) instead of Fastify's default
// error format.
// ---------------------------------------------------------------------------

import { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { formatError } from './formatter';

const SCIM_JSON = 'application/scim+json';
const JSON_CONTENT_TYPE = /^application\/(scim\+)?json\s*(;|$)/i;

/**
 * Registers a parser for `application/scim+json` (which Okta sends) using
 * Fastify's default JSON parser. Safe to call from more than one plugin.
 */
export function registerScimJsonParser(server: FastifyInstance): void {
  if (!server.hasContentTypeParser(SCIM_JSON)) {
    server.addContentTypeParser(
      SCIM_JSON,
      { parseAs: 'string' },
      server.getDefaultJsonParser('error', 'ignore'),
    );
  }
}

/** preValidation hook: rejects bodies that are not a parsed JSON object. */
async function requireJsonObjectBody(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const contentType = request.headers['content-type'] ?? '';

  if (!JSON_CONTENT_TYPE.test(contentType)) {
    return reply
      .status(415)
      .send(
        formatError(
          415,
          `Unsupported Content-Type "${contentType || '(none)'}"; ` +
            `use ${SCIM_JSON} or application/json.`,
        ),
      );
  }

  const body = request.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return reply
      .status(400)
      .send(formatError(400, 'Request body must be a JSON object.', 'invalidSyntax'));
  }
}

/** Route error handler: converts Fastify body-parsing errors into SCIM errors. */
function scimBodyErrorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const status = error.statusCode ?? 500;

  if (status === 415) {
    return reply.status(415).send(formatError(415, error.message));
  }
  if (status === 400) {
    // Malformed JSON, empty JSON body, etc.
    return reply.status(400).send(formatError(400, error.message, 'invalidSyntax'));
  }
  if (status === 413) {
    return reply.status(413).send(formatError(413, error.message));
  }

  request.log.error({ err: error }, 'Unhandled SCIM request error');
  return reply.status(500).send(formatError(500, 'Internal server error'));
}

/** Route options to spread into every SCIM route that accepts a body. */
export const scimBodyRouteOptions = {
  preValidation: requireJsonObjectBody,
  errorHandler: scimBodyErrorHandler,
};
