// ---------------------------------------------------------------------------
// SCIM 2.0 /Users routes (RFC 7644 §3.3–§3.6)
//
// These routes own the protocol. The backend is only ever asked to read,
// list, create, update, delete or set a password, always with SCIM-shaped,
// already validated data.
// ---------------------------------------------------------------------------

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { auditNote, inRequestContext } from '../audit/request-audit';
import type { ScimUserBackend, UserLookup } from '../backend';
import type { CoreConfig } from '../config';
import { ScimBackendError, ScimErrors } from '../errors';
import { resolveUserLookup } from '../filter-parser';
import { applyPatchOps } from '../patch-applier';
import type { AuthHook } from '../plugins/auth';
import { SCIM_CONTENT_TYPE, formatListResponse, toUserResource } from '../responses';
import { SCIM_SCHEMA_PATCH_OP, SCIM_SCHEMA_USER } from '../types';
import {
  StoredUser,
  UserAttributes,
  attributesOf,
  changedAttributes,
  parseUserAttributes,
  stripUnassigned,
} from '../user-attributes';

export interface UsersRoutesOptions {
  backend: ScimUserBackend;
  config: Pick<CoreConfig, 'unsupportedAttributes' | 'defaultCount' | 'maxCount'>;
  authenticate: AuthHook;
}

type Body = Record<string, unknown>;

const JSON_CONTENT_TYPE = /^application\/(scim\+)?json\s*(;|$)/i;

/** Members of a User that the client cannot set (RFC 7643 `readOnly`). */
const READ_ONLY_MEMBERS = ['id', 'meta', 'groups'];

const UNSUPPORTED_LIST_PARAMETERS = ['sortBy', 'sortOrder', 'attributes', 'excludedAttributes'];

// ---------------------------------------------------------------------------

export function scimUsersRoutes(options: UsersRoutesOptions): FastifyPluginAsync {
  const { backend, config } = options;
  const declared: ReadonlySet<string> = new Set(backend.attributes);

  return async function usersRoutes(server: FastifyInstance): Promise<void> {
    server.addHook('onRequest', options.authenticate);

    const usersUrl = (request: FastifyRequest): string =>
      `${request.protocol}://${request.host}${server.prefix}`;

    /** Read a user or throw 404. */
    async function requireUser(id: string): Promise<StoredUser> {
      const user = await backend.getUser(id);
      if (!user) throw ScimErrors.notFound(id);
      return user;
    }

    /** Validate a client-supplied profile and separate the password from it. */
    function readProfile(raw: Body): { user: UserAttributes; password: string | undefined } {
      const cleaned = (stripUnassigned(raw) ?? {}) as Body;
      const { password, ...profile } = cleaned;

      if (password !== undefined && (typeof password !== 'string' || password.length === 0)) {
        throw ScimErrors.invalidValue("'password' must be a non-empty string.");
      }
      if (password !== undefined && !backend.setPassword) {
        throw ScimErrors.invalidValue('This service provider does not support setting passwords.');
      }

      const { attributes, ignored } = parseUserAttributes(
        profile,
        declared,
        config.unsupportedAttributes,
      );
      if (ignored.length > 0) auditNote('ignoredAttributes', ignored);
      if (password !== undefined) auditNote('passwordChange', true);

      return { user: attributes, password: password as string | undefined };
    }

    /** Shared tail of PUT and PATCH: hand the target state to the backend. */
    async function applyUpdate(
      request: FastifyRequest,
      stored: StoredUser,
      target: Body,
    ): Promise<object> {
      const previous = attributesOf(stored);
      const { user, password } = readProfile(target);
      auditNote('changedAttributes', changedAttributes(previous, user));

      // Password first, so enabling an account never races a missing password
      if (password !== undefined) await backend.setPassword!(stored.id, password);
      await backend.updateUser(stored.id, { previous, user });

      return toUserResource(await requireUser(stored.id), usersUrl(request));
    }

    // ── GET /Users ─────────────────────────────────────────────────────────

    server.get<{ Querystring: Record<string, string | undefined> }>('/', (request, reply) =>
      inRequestContext(request, async () => {
        const query = request.query;

        for (const name of UNSUPPORTED_LIST_PARAMETERS) {
          if (query[name] !== undefined) {
            throw ScimErrors.invalidValue(`Query parameter '${name}' is not supported.`);
          }
        }

        // RFC 7644 §3.4.2.4: startIndex below 1 means 1; a negative count means 0
        const startIndex = Math.max(1, readInteger(query.startIndex, 'startIndex') ?? 1);
        const requested = readInteger(query.count, 'count') ?? config.defaultCount;
        const count = Math.min(config.maxCount, Math.max(0, requested));

        let lookup: UserLookup | undefined;
        if (query.filter !== undefined) {
          lookup = resolveUserLookup(query.filter, backend.lookups);
        }

        const page = await backend.listUsers({
          lookup,
          startIndex,
          count,
          sort: { by: 'created', order: 'descending' },
        });

        const base = usersUrl(request);
        return reply
          .status(200)
          .type(SCIM_CONTENT_TYPE)
          .send(
            formatListResponse(
              page.users.map((u) => toUserResource(u, base)),
              page.totalResults,
              startIndex,
            ),
          );
      }),
    );

    // ── GET /Users/:id ─────────────────────────────────────────────────────

    server.get<{ Params: { id: string } }>('/:id', (request, reply) =>
      inRequestContext(request, async () => {
        const user = await requireUser(request.params.id);
        return reply
          .status(200)
          .type(SCIM_CONTENT_TYPE)
          .send(toUserResource(user, usersUrl(request)));
      }),
    );

    // ── POST /Users ────────────────────────────────────────────────────────

    server.post('/', (request, reply) =>
      inRequestContext(request, async () => {
        const body = requireBody(request, SCIM_SCHEMA_USER);
        const { user, password } = readProfile(withoutProtocolMembers(body));

        const id = await backend.createUser(user, password);
        const created = await backend.getUser(id);
        if (!created) {
          throw ScimErrors.backend(`User ${id} was created but could not be read back.`);
        }

        const resource = toUserResource(created, usersUrl(request));
        return reply
          .status(201)
          .header('Location', resource.meta.location!)
          .type(SCIM_CONTENT_TYPE)
          .send(resource);
      }),
    );

    // ── PUT /Users/:id ─────────────────────────────────────────────────────

    server.put<{ Params: { id: string } }>('/:id', (request, reply) =>
      inRequestContext(request, async () => {
        const body = requireBody(request, SCIM_SCHEMA_USER);
        const stored = await requireUser(request.params.id);

        // The body is the complete target state (RFC 7644 §3.5.1): an attribute
        // the backend stores but the body omits is cleared.
        const resource = await applyUpdate(request, stored, withoutProtocolMembers(body));
        return reply.status(200).type(SCIM_CONTENT_TYPE).send(resource);
      }),
    );

    // ── PATCH /Users/:id ───────────────────────────────────────────────────

    server.patch<{ Params: { id: string } }>('/:id', (request, reply) =>
      inRequestContext(request, async () => {
        const body = requireBody(request, SCIM_SCHEMA_PATCH_OP);
        const operations = body.Operations;
        if (!Array.isArray(operations) || operations.length === 0) {
          throw ScimErrors.invalidSyntax('Operations array is required and must not be empty.');
        }

        const stored = await requireUser(request.params.id);
        const target = applyPatchOps<Body>({ ...attributesOf(stored) }, operations);

        for (const member of [...READ_ONLY_MEMBERS, 'schemas']) {
          if (member in target) {
            throw ScimErrors.mutability(`Attribute '${member}' is read-only.`);
          }
        }

        const resource = await applyUpdate(request, stored, target);
        return reply.status(200).type(SCIM_CONTENT_TYPE).send(resource);
      }),
    );

    // ── DELETE /Users/:id ──────────────────────────────────────────────────

    server.delete<{ Params: { id: string } }>('/:id', (request, reply) =>
      inRequestContext(request, async () => {
        const stored = await requireUser(request.params.id);
        await backend.deleteUser(stored.id);
        return reply.status(204).send();
      }),
    );
  };
}

// ---------------------------------------------------------------------------

/** The request body as a JSON object carrying the expected schema URN. */
function requireBody(request: FastifyRequest, schema: string): Body {
  const contentType = request.headers['content-type'] ?? '';
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    throw new ScimBackendError(
      415,
      `Unsupported Content-Type '${contentType || '(none)'}'; ` +
        `use ${SCIM_CONTENT_TYPE} or application/json.`,
    );
  }

  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ScimErrors.invalidSyntax('Request body must be a JSON object.');
  }

  const schemas = (body as Body).schemas;
  if (!Array.isArray(schemas) || !schemas.includes(schema)) {
    throw ScimErrors.invalidSyntax(`Request body 'schemas' must include '${schema}'.`);
  }
  return body as Body;
}

/** RFC 7644 §3.3/§3.5.1: read-only members in a request body are ignored. */
function withoutProtocolMembers(body: Body): Body {
  const profile = { ...body };
  delete profile.schemas;
  for (const member of READ_ONLY_MEMBERS) delete profile[member];
  return profile;
}

function readInteger(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^-?\d+$/.test(raw)) {
    throw ScimErrors.invalidValue(`Query parameter '${name}' must be an integer.`);
  }
  return Number(raw);
}
