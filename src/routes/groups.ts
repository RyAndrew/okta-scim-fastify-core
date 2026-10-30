// ---------------------------------------------------------------------------
// SCIM 2.0 /Groups route factory (RFC 7644 §3.3–§3.6, RFC 7643 §4.2)
//
// Usage:
//   await server.register(createScimGroupsPlugin(backend), {
//     prefix: '/scim/v2/Groups',
//   });
// ---------------------------------------------------------------------------

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ScimBackendError } from '../errors';
import { parseScimFilter } from '../filter-parser';
import { withGroupMeta, formatListResponse, formatError } from '../formatter';
import { registerScimJsonParser, scimBodyRouteOptions } from '../request-body';
import { ScimGroup, ScimPatchOp, ScimGroupBackend } from '../types';

// Import for FastifyInstance.authenticate type augmentation
import '../plugins/auth';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ScimGroupsPluginOptions {
  /**
   * The mounted path of the /Groups collection, used to build meta.location.
   * Defaults to '/scim/v2/Groups'. Must match the `prefix` passed to register().
   */
  groupsPath?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createScimGroupsPlugin(
  backend: ScimGroupBackend,
  pluginOptions: ScimGroupsPluginOptions = {},
) {
  const groupsPath = pluginOptions.groupsPath ?? '/scim/v2/Groups';

  return fp(
    async function scimGroupsPlugin(server: FastifyInstance): Promise<void> {
      server.addHook('onRequest', server.authenticate);
      registerScimJsonParser(server);

      function groupsBaseUrl(request: FastifyRequest): string {
        return `${request.protocol}://${request.hostname}${groupsPath}`;
      }

      function handleError(err: unknown, reply: FastifyReply, context: string): FastifyReply {
        if (err instanceof ScimBackendError) {
          return reply.status(err.status).send(formatError(err.status, err.detail, err.scimType));
        }
        server.log.error({ err }, context);
        return reply.status(500).send(formatError(500, 'Internal server error'));
      }

      // ────────────────────────────────────────────────────────────────────
      // GET /Groups  — list / search
      // ────────────────────────────────────────────────────────────────────

      server.get<{
        Querystring: { filter?: string; startIndex?: string; count?: string };
      }>('/', async (request, reply) => {
        const { filter, startIndex: startIndexStr, count: countStr } = request.query;
        const startIndex = Math.max(1, parseInt(startIndexStr ?? '1', 10));
        const count = Math.min(200, Math.max(1, parseInt(countStr ?? '100', 10)));
        const parsedFilter = filter ? parseScimFilter(filter) ?? undefined : undefined;

        try {
          const { groups, totalResults } = await backend.listGroups({
            filter: parsedFilter,
            startIndex,
            count,
          });

          const base = groupsBaseUrl(request);
          const resources = groups.map((g) => withGroupMeta(g, base));

          return reply
            .status(200)
            .header('Content-Type', 'application/scim+json')
            .send(formatListResponse(resources, totalResults, startIndex));
        } catch (err) {
          return handleError(err, reply, 'GET /Groups failed');
        }
      });

      // ────────────────────────────────────────────────────────────────────
      // GET /Groups/:id
      // ────────────────────────────────────────────────────────────────────

      server.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
        const { id } = request.params;

        try {
          const group = await backend.getGroup(id);
          return reply
            .status(200)
            .header('Content-Type', 'application/scim+json')
            .send(withGroupMeta(group, groupsBaseUrl(request)));
        } catch (err) {
          return handleError(err, reply, 'GET /Groups/:id failed');
        }
      });

      // ────────────────────────────────────────────────────────────────────
      // POST /Groups  — create
      // ────────────────────────────────────────────────────────────────────

      server.post<{ Body: ScimGroup }>('/', scimBodyRouteOptions, async (request, reply) => {
        const group = request.body;

        if (!group.displayName) {
          return reply
            .status(400)
            .send(formatError(400, 'displayName is required.', 'invalidValue'));
        }

        try {
          const created = await backend.createGroup(group);
          const resource = withGroupMeta(created, groupsBaseUrl(request));

          return reply
            .status(201)
            .header('Location', resource.meta!.location!)
            .header('Content-Type', 'application/scim+json')
            .send(resource);
        } catch (err) {
          return handleError(err, reply, 'POST /Groups failed');
        }
      });

      // ────────────────────────────────────────────────────────────────────
      // PUT /Groups/:id  — full replace
      // ────────────────────────────────────────────────────────────────────

      server.put<{ Params: { id: string }; Body: ScimGroup }>(
        '/:id',
        scimBodyRouteOptions,
        async (request, reply) => {
          const { id } = request.params;

          try {
            const updated = await backend.replaceGroup(id, request.body);
            return reply
              .status(200)
              .header('Content-Type', 'application/scim+json')
              .send(withGroupMeta(updated, groupsBaseUrl(request)));
          } catch (err) {
            return handleError(err, reply, 'PUT /Groups/:id failed');
          }
        },
      );

      // ────────────────────────────────────────────────────────────────────
      // PATCH /Groups/:id  — partial update (members add/remove, displayName)
      // ────────────────────────────────────────────────────────────────────

      server.patch<{ Params: { id: string }; Body: ScimPatchOp }>(
        '/:id',
        scimBodyRouteOptions,
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
            const updated = await backend.patchGroup(id, patch);
            return reply
              .status(200)
              .header('Content-Type', 'application/scim+json')
              .send(withGroupMeta(updated, groupsBaseUrl(request)));
          } catch (err) {
            return handleError(err, reply, 'PATCH /Groups/:id failed');
          }
        },
      );

      // ────────────────────────────────────────────────────────────────────
      // DELETE /Groups/:id
      // ────────────────────────────────────────────────────────────────────

      server.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
        const { id } = request.params;

        try {
          await backend.deleteGroup(id);
          return reply.status(204).send();
        } catch (err) {
          return handleError(err, reply, 'DELETE /Groups/:id failed');
        }
      });
    },
    { name: 'scim-groups' },
  );
}
