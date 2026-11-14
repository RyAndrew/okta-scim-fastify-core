// ---------------------------------------------------------------------------
// The SCIM server. A backend repo's entry point is one call:
//
//   import { startScimServer } from 'scim-fastify-core';
//   import { ldapModule } from './backend';
//   startScimServer(ldapModule);
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto';
import fs from 'fs';
import dotenv from 'dotenv';
import Fastify, { FastifyError, FastifyInstance } from 'fastify';
import { createBackendAudit, registerRequestAudit } from './audit/request-audit';
import type { AuditSink } from './audit/sink';
import { SqliteAuditSink } from './audit/sqlite-sink';
import type { BackendModule, ScimUserBackend } from './backend';
import { CoreConfig, loadCoreConfig } from './config';
import { Env, EnvError } from './env';
import { ScimBackendError } from './errors';
import { createAuthHook } from './plugins/auth';
import { SCIM_CONTENT_TYPE, formatError } from './responses';
import { scimDiscoveryRoutes } from './routes/discovery';
import { scimUsersRoutes } from './routes/users';
import { KNOWN_USER_ATTRIBUTE_PATHS } from './user-attributes';

export const SCIM_BASE_PATH = '/scim/v2';

export interface CreateScimServerOptions<TConfig> {
  module: BackendModule<TConfig>;
  config: CoreConfig;
  backendConfig: TConfig;
  sink: AuditSink;
  /** PEM key and certificate. Omit only when the server is driven in-process (tests). */
  tls?: { key: Buffer; cert: Buffer };
}

/**
 * Build the server: audit, auth, discovery, /Users, /health. Initialises the
 * audit sink and the backend, and closes both when the server closes.
 */
export async function createScimServer<TConfig>(
  options: CreateScimServerOptions<TConfig>,
): Promise<FastifyInstance> {
  const { module, config, sink } = options;

  const server = Fastify({
    ...(options.tls ? { https: options.tls } : {}),
    logger: { level: config.logLevel },
    genReqId: () => randomUUID(),
  }) as unknown as FastifyInstance;

  await sink.init();

  const backend = module.create(options.backendConfig, {
    audit: createBackendAudit(module.name, sink, server.log),
    log: server.log,
  });
  assertBackendDeclaration(module.name, backend);
  await backend.init();

  server.addHook('onClose', async () => {
    await backend.close();
    await sink.close();
  });

  // Okta sends application/scim+json
  server.addContentTypeParser(
    SCIM_CONTENT_TYPE,
    { parseAs: 'string' },
    server.getDefaultJsonParser('error', 'error'),
  );

  registerRequestAudit(server, sink);

  server.setErrorHandler((error: FastifyError | ScimBackendError, request, reply) => {
    if (error instanceof ScimBackendError) {
      if (error.status >= 500) request.log.error({ err: error }, 'Backend failure');
      return reply
        .status(error.status)
        .type(SCIM_CONTENT_TYPE)
        .send(formatError(error.status, error.detail, error.scimType));
    }

    // Errors raised by Fastify itself: malformed JSON, body too large, …
    const status = error.statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply
        .status(status)
        .type(SCIM_CONTENT_TYPE)
        .send(formatError(status, error.message, status === 400 ? 'invalidSyntax' : undefined));
    }

    request.log.error({ err: error }, 'Unhandled error');
    return reply
      .status(500)
      .type(SCIM_CONTENT_TYPE)
      .send(formatError(500, 'Internal server error'));
  });

  server.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .type(SCIM_CONTENT_TYPE)
      .send(formatError(404, `No route for ${request.method} ${request.url.split('?')[0]}.`)),
  );

  await server.register(scimDiscoveryRoutes({ backend, config }), { prefix: SCIM_BASE_PATH });
  await server.register(
    scimUsersRoutes({ backend, config, authenticate: createAuthHook(config.apiKey) }),
    { prefix: `${SCIM_BASE_PATH}/Users` },
  );

  server.get('/health', async (_request, reply) =>
    reply.status(200).send({ status: 'ok', backend: module.name }),
  );

  return server;
}

/** A backend's declaration is checked once at startup rather than trusted. */
function assertBackendDeclaration(name: string, backend: ScimUserBackend): void {
  const unknown = backend.attributes.filter((path) => !KNOWN_USER_ATTRIBUTE_PATHS.has(path));
  if (unknown.length > 0) {
    throw new Error(`Backend '${name}' declares unknown attributes: ${unknown.join(', ')}`);
  }
  if (!backend.attributes.includes('userName')) {
    throw new Error(`Backend '${name}' must declare the 'userName' attribute.`);
  }
  if (!backend.lookups.includes('id')) {
    throw new Error(`Backend '${name}' must declare the 'id' lookup.`);
  }
}

/**
 * Load configuration from the environment (and a `.env` file in the working
 * directory, if there is one), start the HTTPS server and exit on failure.
 */
export async function startScimServer<TConfig>(module: BackendModule<TConfig>): Promise<void> {
  dotenv.config({ quiet: true });

  let server: FastifyInstance;
  let config: CoreConfig;
  try {
    const env = new Env(process.env);
    config = loadCoreConfig(env);
    const backendConfig = module.loadConfig(env);
    env.assertValid();

    server = await createScimServer({
      module,
      config,
      backendConfig,
      sink: new SqliteAuditSink(config.auditDbPath),
      tls: {
        key: fs.readFileSync(config.ssl.keyPath),
        cert: fs.readFileSync(config.ssl.certPath),
      },
    });
  } catch (err) {
    // Startup failures are printed plainly: the logger may not exist yet
    console.error(err instanceof EnvError ? err.message : err);
    process.exit(1);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      server.close().then(
        () => process.exit(0),
        (err) => {
          server.log.error({ err }, 'Error during shutdown');
          process.exit(1);
        },
      );
    });
  }

  try {
    await server.listen({ port: config.port, host: config.host });
  } catch (err) {
    server.log.error({ err }, 'Failed to start listening');
    process.exit(1);
  }
}
