// ---------------------------------------------------------------------------
// SCIM discovery endpoints (RFC 7644 §4)
//
// Generated from what the backend declares, so they always describe what the
// service actually does. Intentionally unauthenticated — clients probe these
// during setup.
// ---------------------------------------------------------------------------

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ScimUserBackend } from '../backend';
import type { CoreConfig } from '../config';
import { ScimBackendError } from '../errors';
import { SCIM_CONTENT_TYPE, formatListResponse } from '../responses';
import { SCIM_SCHEMA_ENTERPRISE_USER, SCIM_SCHEMA_GROUP, SCIM_SCHEMA_USER } from '../types';
import { schemaAttributesFor } from '../user-attributes';

function attribute(name: string, type: string, description: string, extra: object = {}) {
  return {
    name,
    type,
    multiValued: false,
    description,
    required: false,
    caseExact: false,
    mutability: 'readWrite',
    returned: 'default',
    uniqueness: 'none',
    ...extra,
  };
}

/** SCIM schema attributes of the Group resource, for the declared paths. */
function groupSchemaAttributes(declared: ReadonlySet<string>): object[] {
  const out: object[] = [
    attribute('displayName', 'string', 'A human-readable name for the group.', { required: true }),
  ];
  if (declared.has('externalId')) {
    out.push(attribute('externalId', 'string', 'Identifier issued by the provisioning client.', { caseExact: true }));
  }
  if (declared.has('members')) {
    out.push(
      attribute('members', 'complex', 'The users that belong to the group.', {
        multiValued: true,
        subAttributes: [
          attribute('value', 'string', 'The id of the member user.', { mutability: 'immutable' }),
          attribute('$ref', 'reference', 'The URI of the member user.', {
            mutability: 'immutable',
            referenceTypes: ['User'],
          }),
          attribute('display', 'string', 'A human-readable name for the member.', { mutability: 'readOnly' }),
          attribute('type', 'string', "The member's type. Only 'User' is supported.", {
            mutability: 'immutable',
            canonicalValues: ['User'],
          }),
        ],
      }),
    );
  }
  return out;
}

const SCHEMA_SPC = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';
const SCHEMA_RESOURCE_TYPE = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType';
const SCHEMA_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema';

export interface DiscoveryRoutesOptions {
  backend: ScimUserBackend;
  config: Pick<CoreConfig, 'maxCount'>;
}

export function scimDiscoveryRoutes(options: DiscoveryRoutesOptions): FastifyPluginAsync {
  const { backend, config } = options;
  const { groups } = backend;
  const declared: ReadonlySet<string> = new Set(backend.attributes);
  const enterpriseAttributes = schemaAttributesFor(declared, SCIM_SCHEMA_ENTERPRISE_USER);
  const hasEnterprise = enterpriseAttributes.length > 0;

  return async function discoveryRoutes(server: FastifyInstance): Promise<void> {
    const baseUrl = (request: FastifyRequest): string =>
      `${request.protocol}://${request.host}${server.prefix}`;

    // ── ServiceProviderConfig ──────────────────────────────────────────────

    const serviceProviderConfig = (request: FastifyRequest) => ({
      schemas: [SCHEMA_SPC],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: config.maxCount },
      changePassword: { supported: backend.setPassword !== undefined },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'httpbasic',
          name: 'HTTP Basic',
          description:
            'HTTP Basic authentication. The username is not checked; the password must equal the configured API key.',
          primary: true,
        },
      ],
      meta: {
        resourceType: 'ServiceProviderConfig',
        location: `${baseUrl(request)}/ServiceProviderConfig`,
      },
    });

    for (const path of ['/ServiceProviderConfig', '/ServiceProviderConfigs']) {
      server.get(path, async (request, reply) =>
        reply.status(200).type(SCIM_CONTENT_TYPE).send(serviceProviderConfig(request)),
      );
    }

    // ── ResourceTypes ──────────────────────────────────────────────────────

    const userResourceType = (request: FastifyRequest) => ({
      schemas: [SCHEMA_RESOURCE_TYPE],
      id: 'User',
      name: 'User',
      endpoint: '/Users',
      description: 'User Account',
      schema: SCIM_SCHEMA_USER,
      schemaExtensions: hasEnterprise
        ? [{ schema: SCIM_SCHEMA_ENTERPRISE_USER, required: false }]
        : [],
      meta: {
        resourceType: 'ResourceType',
        location: `${baseUrl(request)}/ResourceTypes/User`,
      },
    });

    const groupResourceType = (request: FastifyRequest) => ({
      schemas: [SCHEMA_RESOURCE_TYPE],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      description: 'Group',
      schema: SCIM_SCHEMA_GROUP,
      schemaExtensions: [],
      meta: {
        resourceType: 'ResourceType',
        location: `${baseUrl(request)}/ResourceTypes/Group`,
      },
    });

    const resourceTypes = (request: FastifyRequest) =>
      groups ? [userResourceType(request), groupResourceType(request)] : [userResourceType(request)];

    server.get('/ResourceTypes', async (request, reply) => {
      const list = resourceTypes(request);
      return reply
        .status(200)
        .type(SCIM_CONTENT_TYPE)
        .send(formatListResponse(list, list.length, 1));
    });

    server.get<{ Params: { id: string } }>('/ResourceTypes/:id', async (request, reply) => {
      const type = resourceTypes(request).find((t) => t.id === request.params.id);
      if (!type) {
        throw new ScimBackendError(404, `ResourceType ${request.params.id} not found.`);
      }
      return reply.status(200).type(SCIM_CONTENT_TYPE).send(type);
    });

    // ── Schemas ────────────────────────────────────────────────────────────

    const schemas = (request: FastifyRequest) => {
      const list = [
        {
          schemas: [SCHEMA_SCHEMA],
          id: SCIM_SCHEMA_USER,
          name: 'User',
          description: 'User Account',
          attributes: [
            ...schemaAttributesFor(declared, 'core'),
            ...(backend.setPassword
              ? [
                  {
                    name: 'password',
                    type: 'string',
                    multiValued: false,
                    description: "The user's cleartext password. Never returned.",
                    required: false,
                    caseExact: true,
                    mutability: 'writeOnly',
                    returned: 'never',
                    uniqueness: 'none',
                  },
                ]
              : []),
          ],
          meta: {
            resourceType: 'Schema',
            location: `${baseUrl(request)}/Schemas/${SCIM_SCHEMA_USER}`,
          },
        },
      ];
      if (groups) {
        list.push({
          schemas: [SCHEMA_SCHEMA],
          id: SCIM_SCHEMA_GROUP,
          name: 'Group',
          description: 'Group',
          attributes: groupSchemaAttributes(new Set(groups.attributes)),
          meta: {
            resourceType: 'Schema',
            location: `${baseUrl(request)}/Schemas/${SCIM_SCHEMA_GROUP}`,
          },
        });
      }
      if (hasEnterprise) {
        list.push({
          schemas: [SCHEMA_SCHEMA],
          id: SCIM_SCHEMA_ENTERPRISE_USER,
          name: 'EnterpriseUser',
          description: 'Enterprise User',
          attributes: enterpriseAttributes,
          meta: {
            resourceType: 'Schema',
            location: `${baseUrl(request)}/Schemas/${SCIM_SCHEMA_ENTERPRISE_USER}`,
          },
        });
      }
      return list;
    };

    server.get('/Schemas', async (request, reply) => {
      const list = schemas(request);
      return reply
        .status(200)
        .type(SCIM_CONTENT_TYPE)
        .send(formatListResponse(list, list.length, 1));
    });

    server.get<{ Params: { id: string } }>('/Schemas/:id', async (request, reply) => {
      const schema = schemas(request).find((s) => s.id === request.params.id);
      if (!schema) {
        throw new ScimBackendError(404, `Schema ${request.params.id} not found.`);
      }
      return reply.status(200).type(SCIM_CONTENT_TYPE).send(schema);
    });
  };
}
