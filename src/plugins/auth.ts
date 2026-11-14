// ---------------------------------------------------------------------------
// HTTP Basic authentication.
//
// The username is not checked; the password must equal the configured API key.
// ---------------------------------------------------------------------------

import { createHash, timingSafeEqual } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SCIM_CONTENT_TYPE, formatError } from '../responses';

export type AuthHook = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<FastifyReply | void>;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Build an `onRequest` hook that rejects requests without the API key. */
export function createAuthHook(apiKey: string): AuthHook {
  const expected = digest(apiKey);

  const reject = (reply: FastifyReply, detail: string): FastifyReply =>
    reply
      .status(401)
      .header('WWW-Authenticate', 'Basic realm="scim-bridge"')
      .type(SCIM_CONTENT_TYPE)
      .send(formatError(401, detail));

  // An async hook that sends a reply must return it, so Fastify stops the request
  return async function authenticate(request, reply): Promise<FastifyReply | void> {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Basic ')) {
      return reject(reply, 'Authorization header with Basic credentials is required.');
    }

    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    // Split on the first colon only, so passwords containing colons work
    const colon = decoded.indexOf(':');
    if (colon === -1) {
      return reject(reply, 'Malformed Basic credentials.');
    }

    // Compare fixed-length digests in constant time
    if (!timingSafeEqual(digest(decoded.slice(colon + 1)), expected)) {
      return reject(reply, 'Invalid credentials.');
    }
  };
}
