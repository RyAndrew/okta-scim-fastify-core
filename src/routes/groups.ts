// ---------------------------------------------------------------------------
// SCIM 2.0 /Groups routes (RFC 7644 §3.3–§3.6)
//
// Registered only when the backend provides `groups`. Membership crosses the
// boundary as a delta (MemberChange), so PATCH never loads a full member list
// and answers 204 No Content (RFC 7644 §3.5.2) instead of reading it back.
// ---------------------------------------------------------------------------

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { auditNote, inRequestContext } from '../audit/request-audit';
import type { GroupLookup, MemberChange, ScimGroupBackend } from '../backend';
import type { CoreConfig } from '../config';
import { ScimBackendError, ScimErrors } from '../errors';
import { resolveGroupLookup } from '../filter-parser';
import { StoredGroup, groupAttributesOf, parseGroupAttributes } from '../group-attributes';
import { applyGroupPatch } from '../group-patch';
import type { AuthHook } from '../plugins/auth';
import { SCIM_CONTENT_TYPE, formatListResponse, toGroupResource } from '../responses';
import { SCIM_SCHEMA_GROUP, SCIM_SCHEMA_PATCH_OP } from '../types';
import { stripUnassigned } from '../user-attributes';
import { readInteger, requireBody } from './users';

export interface GroupsRoutesOptions {
  groups: ScimGroupBackend;
  config: Pick<CoreConfig, 'unsupportedAttributes' | 'defaultCount' | 'maxCount'>;
  authenticate: AuthHook;
  /** Path of the /Users collection, for members' `$ref`. */
  usersPath: string;
}

type Body = Record<string, unknown>;
type Query = Record<string, string | undefined>;

const READ_ONLY_MEMBERS = ['id', 'meta'];
const UNSUPPORTED_PARAMETERS = ['sortBy', 'sortOrder', 'attributes'];

// ---------------------------------------------------------------------------

export function scimGroupsRoutes(options: GroupsRoutesOptions): FastifyPluginAsync {
  const { groups, config } = options;
  const declared: ReadonlySet<string> = new Set(groups.attributes);

  return async function groupsRoutes(server: FastifyInstance): Promise<void> {
    server.addHook('onRequest', options.authenticate);

    const origin = (request: FastifyRequest): string => `${request.protocol}://${request.host}`;
    const resource = (request: FastifyRequest, group: StoredGroup) =>
      toGroupResource(
        group,
        `${origin(request)}${server.prefix}`,
        `${origin(request)}${options.usersPath}`,
      );

    async function requireGroup(id: string, includeMembers: boolean): Promise<StoredGroup> {
      const group = await groups.getGroup(id, { includeMembers });
      if (!group) throw new ScimBackendError(404, `Group ${id} not found.`);
      return group;
    }

    // ── GET /Groups ────────────────────────────────────────────────────────

    server.get<{ Querystring: Query }>('/', (request, reply) =>
      inRequestContext(request, async () => {
        const query = request.query;
        const includeMembers = readIncludeMembers(query);

        const startIndex = Math.max(1, readInteger(query.startIndex, 'startIndex') ?? 1);
        const requested = readInteger(query.count, 'count') ?? config.defaultCount;
        const count = Math.min(config.maxCount, Math.max(0, requested));

        let lookup: GroupLookup | undefined;
        if (query.filter !== undefined) lookup = resolveGroupLookup(query.filter, groups.lookups);

        const page = await groups.listGroups({
          lookup,
          startIndex,
          count,
          sort: { by: 'created', order: 'descending' },
          includeMembers,
        });

        return reply
          .status(200)
          .type(SCIM_CONTENT_TYPE)
          .send(
            formatListResponse(
              page.groups.map((g) => resource(request, g)),
              page.totalResults,
              startIndex,
            ),
          );
      }),
    );

    // ── GET /Groups/:id ────────────────────────────────────────────────────

    server.get<{ Params: { id: string }; Querystring: Query }>('/:id', (request, reply) =>
      inRequestContext(request, async () => {
        const includeMembers = readIncludeMembers(request.query);
        const group = await requireGroup(request.params.id, includeMembers);
        return reply.status(200).type(SCIM_CONTENT_TYPE).send(resource(request, group));
      }),
    );

    // ── POST /Groups ───────────────────────────────────────────────────────

    server.post('/', (request, reply) =>
      inRequestContext(request, async () => {
        const body = requireBody(request, SCIM_SCHEMA_GROUP);
        const { group, memberIds, ignored } = parseGroupAttributes(
          withoutProtocolMembers(body),
          declared,
          config.unsupportedAttributes,
        );
        if (ignored.length > 0) auditNote('ignoredAttributes', ignored);

        const id = await groups.createGroup(group, memberIds ?? []);
        const created = await groups.getGroup(id, { includeMembers: true });
        if (!created) {
          throw ScimErrors.backend(`Group ${id} was created but could not be read back.`);
        }

        const body201 = resource(request, created);
        return reply
          .status(201)
          .header('Location', body201.meta!.location!)
          .type(SCIM_CONTENT_TYPE)
          .send(body201);
      }),
    );

    // ── PUT /Groups/:id ────────────────────────────────────────────────────

    server.put<{ Params: { id: string } }>('/:id', (request, reply) =>
      inRequestContext(request, async () => {
        const body = requireBody(request, SCIM_SCHEMA_GROUP);
        const stored = await requireGroup(request.params.id, false);

        // The body is the complete target state (RFC 7644 §3.5.1): omitted
        // attributes are cleared and the member list is replaced.
        const { group, memberIds, ignored } = parseGroupAttributes(
          withoutProtocolMembers(body),
          declared,
          config.unsupportedAttributes,
        );
        if (ignored.length > 0) auditNote('ignoredAttributes', ignored);

        const members: MemberChange | undefined =
          memberIds !== undefined ? { replace: memberIds } : undefined;
        noteMembers(members);
        await groups.updateGroup(stored.id, { previous: groupAttributesOf(stored), group, members });

        const updated = await requireGroup(stored.id, true);
        return reply.status(200).type(SCIM_CONTENT_TYPE).send(resource(request, updated));
      }),
    );

    // ── PATCH /Groups/:id ──────────────────────────────────────────────────

    server.patch<{ Params: { id: string } }>('/:id', (request, reply) =>
      inRequestContext(request, async () => {
        const body = requireBody(request, SCIM_SCHEMA_PATCH_OP);
        const operations = body.Operations;
        if (!Array.isArray(operations) || operations.length === 0) {
          throw ScimErrors.invalidSyntax('Operations array is required and must not be empty.');
        }

        const stored = await requireGroup(request.params.id, false);
        const previous = groupAttributesOf(stored);
        const { group, members, ignored } = applyGroupPatch(
          stored.id,
          previous,
          operations,
          declared,
          config.unsupportedAttributes,
        );
        if (ignored.length > 0) auditNote('ignoredAttributes', ignored);
        noteMembers(members);

        await groups.updateGroup(stored.id, { previous, group, members });
        return reply.status(204).send();
      }),
    );

    // ── DELETE /Groups/:id ─────────────────────────────────────────────────

    server.delete<{ Params: { id: string } }>('/:id', (request, reply) =>
      inRequestContext(request, async () => {
        const stored = await requireGroup(request.params.id, false);
        await groups.deleteGroup(stored.id);
        return reply.status(204).send();
      }),
    );
  };
}

// ---------------------------------------------------------------------------

/** Only `excludedAttributes=members` is supported (Okta sends it); everything else is a 400. */
function readIncludeMembers(query: Query): boolean {
  for (const name of UNSUPPORTED_PARAMETERS) {
    if (query[name] !== undefined) {
      throw ScimErrors.invalidValue(`Query parameter '${name}' is not supported.`);
    }
  }
  const excluded = query.excludedAttributes;
  if (excluded === undefined) return true;
  if (excluded.trim().toLowerCase() === 'members') return false;
  throw ScimErrors.invalidValue(
    `excludedAttributes='${excluded}' is not supported; only 'members' can be excluded.`,
  );
}

function withoutProtocolMembers(body: Body): Body {
  const profile = { ...(stripUnassigned(body) as Body | undefined) };
  delete profile.schemas;
  for (const member of READ_ONLY_MEMBERS) delete profile[member];
  return profile;
}

function noteMembers(members: MemberChange | undefined): void {
  if (!members) return;
  auditNote(
    'memberChange',
    'replace' in members
      ? { replace: members.replace.length }
      : { add: members.add.length, remove: members.remove.length },
  );
}
