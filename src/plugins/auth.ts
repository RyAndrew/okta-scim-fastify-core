// ---------------------------------------------------------------------------
// HTTP Basic authentication plugin factory
//
// Usage:
//   await server.register(createAuthPlugin(config.apiKey));
//
// The username field is not validated — any value is accepted.
// The password must equal the supplied apiKey.
// ---------------------------------------------------------------------------

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

// ---------------------------------------------------------------------------
// Type augmentation — makes server.authenticate available everywhere
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// ---------------------------------------------------------------------------

export function createAuthPlugin(apiKey: string) {
  return fp(
    async function authPlugin(server: FastifyInstance): Promise<void> {
      server.decorate(
        'authenticate',
        async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
          const authHeader = request.headers['authorization'] ?? '';

          if (!authHeader.startsWith('Basic ')) {
            return reply
              .status(401)
              .header('WWW-Authenticate', 'Basic realm="scim-bridge"')
              .send({
                schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
                status: 401,
                detail: 'Authorization header with Basic credentials is required.',
              });
          }

          const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
          // Split only on the first colon so passwords containing colons work
          const colonIndex = decoded.indexOf(':');
          const password = colonIndex === -1 ? decoded : decoded.slice(colonIndex + 1);

          if (password !== apiKey) {
            return reply
              .status(401)
              .header('WWW-Authenticate', 'Basic realm="scim-bridge"')
              .send({
                schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
                status: 401,
                detail: 'Invalid credentials.',
              });
          }
        },
      );
    },
    { name: 'auth' },
  );
}
