// ---------------------------------------------------------------------------
// SCIM 2.0 /Users route factory (RFC 7644 §3.3–§3.6)
//
// Usage:
//   await server.register(createScimUsersPlugin(backend), {
//     prefix: '/scim/v2/Users',
//   });
// ---------------------------------------------------------------------------

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ScimBackendError } from '../errors';
import { parseScimFilter } from '../filter-parser';
import { withScimMeta, formatListResponse, formatError } from '../formatter';
import { ScimUser, ScimPatchOp, ScimBackend } from '../types';

// Import for FastifyInstance.authenticate type augmentation
import '../plugins/auth';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ScimUsersPluginOptions {
  /**
   * The mounted path of the /Users collection, used to build meta.location.
   * Defaults to '/scim/v2/Users'. Must match the `prefix` passed to register().
   */
  usersPath?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScimUsersPlugin(
  backend: ScimBackend,
  pluginOptions: ScimUsersPluginOptions = {},
) {
  const usersPath = pluginOptions.usersPath ?? '/scim/v2/Users';

  return fp(
    async function scimUsersPlugin(server: FastifyInstance): Promise<void> {
      server.addHook('onRequest', server.authenticate);

      function usersBaseUrl(request: FastifyRequest): string {
        return `${request.protocol}://${request.hostname}${usersPath}`;
      }

      function handleError(err: unknown, reply: FastifyReply, context: string): FastifyReply {
        if (err instanceof ScimBackendError) {
          return reply.status(err.status).send(formatError(err.status, err.detail, err.scimType));
        }
        server.log.error({ err }, context);
        return reply.status(500).send(formatError(500, 'Internal server error'));
      }

      // ────────────────────────────────────────────────────────────────────
      // GET /Users  — list / search
      // ────────────────────────────────────────────────────────────────────

      server.get<{
        Querystring: { filter?: string; startIndex?: string; count?: string };
      }>('/', async (request, reply) => {
        const { filter, startIndex: startIndexStr, count: countStr } = request.query;
        const startIndex = Math.max(1, parseInt(startIndexStr ?? '1', 10));
        const count = Math.min(200, Math.max(1, parseInt(countStr ?? '100', 10)));
        const parsedFilter = filter ? parseScimFilter(filter) ?? undefined : undefined;

        try {
          const { users, totalResults } = await backend.listUsers({
            filter: parsedFilter,
            startIndex,
            count,
          });

          const base = usersBaseUrl(request);
          const resources = users.map((u) => withScimMeta(u, base));

          return reply
            .status(200)
            .header('Content-Type', 'application/scim+json')
            .send(formatListResponse(resources, totalResults, startIndex));
        } catch (err) {
          return handleError(err, reply, 'GET /Users failed');
        }
      });

      // ────────────────────────────────────────────────────────────────────
      // GET /Users/:id
      // ────────────────────────────────────────────────────────────────────

      server.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
        const { id } = request.params;

        try {
          const user = await backend.getUser(id);
          return reply
            .status(200)
            .header('Content-Type', 'application/scim+json')
            .send(withScimMeta(user, usersBaseUrl(request)));
        } catch (err) {
          return handleError(err, reply, 'GET /Users/:id failed');
        }
      });

      // ────────────────────────────────────────────────────────────────────
      // POST /Users  — provision
      // ────────────────────────────────────────────────────────────────────

      server.post<{ Body: ScimUser }>('/', async (request, reply) => {
        const scimUser = request.body;

        if (!scimUser.userName) {
          return reply
            .status(400)
            .send(formatError(400, 'userName is required.', 'invalidValue'));
        }

        try {
          const created = await backend.createUser(scimUser);
          const resource = withScimMeta(created, usersBaseUrl(request));

          return reply
            .status(201)
            .header('Location', resource.meta!.location!)
            .header('Content-Type', 'application/scim+json')
            .send(resource);
        } catch (err) {
          return handleError(err, reply, 'POST /Users failed');
        }
      });

      // ────────────────────────────────────────────────────────────────────
      // PUT /Users/:id  — full replace
      // ────────────────────────────────────────────────────────────────────

      server.put<{ Params: { id: string }; Body: ScimUser }>(
        '/:id',
        async (request, reply) => {
          const { id } = request.params;

          try {
            const updated = await backend.replaceUser(id, request.body);
            return reply
              .status(200)
              .header('Content-Type', 'application/scim+json')
              .send(withScimMeta(updated, usersBaseUrl(request)));
          } catch (err) {
            return handleError(err, reply, 'PUT /Users/:id failed');
          }
        },
      );

      // ────────────────────────────────────────────────────────────────────
      // PATCH /Users/:id  — partial update
      // ────────────────────────────────────────────────────────────────────

      server.patch<{ Params: { id: string }; Body: ScimPatchOp }>(
        '/:id',
        async (request, reply) => {
          const { id } = request.params;
          const patch = request.body;

          if (!Array.isArray(patch.Operations) || patch.Operations.length === 0) {
            return reply
              .status(400)
              .send(
                formatError(
                  400,
                  'Operations array is required and must not be empty.',
                  'invalidValue',
                ),
              );
          }

          try {
            const updated = await backend.patchUser(id, patch);
            return reply
              .status(200)
              .header('Content-Type', 'application/scim+json')
              .send(withScimMeta(updated, usersBaseUrl(request)));
          } catch (err) {
            return handleError(err, reply, 'PATCH /Users/:id failed');
          }
        },
      );

      // ────────────────────────────────────────────────────────────────────
      // DELETE /Users/:id  — deprovision
      // ────────────────────────────────────────────────────────────────────

      server.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
        const { id } = request.params;

        try {
          await backend.deleteUser(id);
          return reply.status(204).send();
        } catch (err) {
          return handleError(err, reply, 'DELETE /Users/:id failed');
        }
      });
    },
    { name: 'scim-users' },
  );
}
