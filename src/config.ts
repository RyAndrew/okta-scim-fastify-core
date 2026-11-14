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
  ssl: { certPath: string; keyPath: string };
  auditDbPath: string;
  unsupportedAttributes: UnsupportedAttributePolicy;
  defaultCount: number;
  maxCount: number;
}

export function loadCoreConfig(env: Env): CoreConfig {
  const config: CoreConfig = {
    host: env.require('HOST', 'Address the HTTPS server listens on, e.g. 0.0.0.0.'),
    port: env.requireInt('PORT', 'Port the HTTPS server listens on.', 1, 65535),
    logLevel: env.requireEnum('LOG_LEVEL', 'Server log level.', [
      'fatal',
      'error',
      'warn',
      'info',
      'debug',
      'trace',
    ] as const),
    apiKey: env.require('API_KEY', 'Secret the SCIM client sends as the HTTP Basic password.'),
    ssl: {
      certPath: env.require('SSL_CERT_PATH', 'Path to the PEM certificate for the HTTPS server.'),
      keyPath: env.require('SSL_KEY_PATH', 'Path to the PEM private key for the HTTPS server.'),
    },
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
