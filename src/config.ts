// ---------------------------------------------------------------------------
// Core configuration — everything that is not specific to a directory.
// ---------------------------------------------------------------------------

import type { Env } from './env';
import type { UnsupportedAttributePolicy } from './user-attributes';

export interface CoreConfig {
  host: string;
  port: number;
  logLevel: string;
  apiKey: string;
  /**
   * TLS for the listener. Disable it when TLS is terminated in front of the
   * server (a reverse proxy, load balancer or ingress), typically in Docker.
   */
  ssl: { enabled: true; certPath: string; keyPath: string } | { enabled: false };
  /**
   * Trust X-Forwarded-* headers from the proxy in front, so the client IP in
   * the audit log and the https:// in `meta.location` are the client's view.
   */
  trustProxy: boolean;
  auditDbPath: string;
  unsupportedAttributes: UnsupportedAttributePolicy;
  defaultCount: number;
  maxCount: number;
}

export function loadCoreConfig(env: Env): CoreConfig {
  const config: CoreConfig = {
    host: env.require('HOST', 'Address the server listens on, e.g. 0.0.0.0 in a container.'),
    port: env.requireInt('PORT', 'Port the server listens on.', 1, 65535),
    logLevel: env.requireEnum('LOG_LEVEL', 'Server log level.', [
      'fatal',
      'error',
      'warn',
      'info',
      'debug',
      'trace',
    ] as const),
    apiKey: env.require('API_KEY', 'Secret the SCIM client sends as the HTTP Basic password.'),
    ssl: loadSslConfig(env),
    trustProxy: env.requireBoolean(
      'TRUST_PROXY',
      'Trust X-Forwarded-* headers; set true only behind a reverse proxy.',
    ),
    auditDbPath: env.require('AUDIT_DB_PATH', 'Path of the SQLite audit database file.'),
    unsupportedAttributes: env.requireEnum(
      'SCIM_UNSUPPORTED_ATTRIBUTES',
      'What to do with attributes the backend does not store.',
      ['reject', 'ignore'] as const,
    ),
    defaultCount: env.requireInt(
      'SCIM_DEFAULT_COUNT',
      'Page size used when a list request has no count parameter.',
      1,
      10_000,
    ),
    maxCount: env.requireInt(
      'SCIM_MAX_COUNT',
      'Largest page size served; advertised as filter.maxResults.',
      1,
      10_000,
    ),
  };

  if (config.defaultCount > config.maxCount) {
    env.fail('SCIM_DEFAULT_COUNT must not be greater than SCIM_MAX_COUNT.');
  }
  return config;
}

function loadSslConfig(env: Env): CoreConfig['ssl'] {
  const enabled = env.requireBoolean(
    'SSL_ENABLED',
    'Serve HTTPS (true) or plain HTTP behind a TLS-terminating proxy (false).',
  );
  if (!enabled) return { enabled: false };
  return {
    enabled: true,
    certPath: env.require('SSL_CERT_PATH', 'Path to the PEM certificate; required when SSL_ENABLED=true.'),
    keyPath: env.require('SSL_KEY_PATH', 'Path to the PEM private key; required when SSL_ENABLED=true.'),
  };
}
