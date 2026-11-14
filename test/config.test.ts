// Tests of core configuration loading: optional TLS, proxy trust and *_FILE secrets.
// Run with: npm test

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Env, EnvError, createScimServer, loadCoreConfig } from '../src';
import type { AuditSink, BackendModule, CoreConfig, ScimUserBackend } from '../src';

const BASE: Record<string, string> = {
  HOST: '0.0.0.0',
  PORT: '8080',
  LOG_LEVEL: 'info',
  API_KEY: 'secret',
  AUDIT_DB_PATH: '/data/audit.db',
  SCIM_UNSUPPORTED_ATTRIBUTES: 'reject',
  SCIM_DEFAULT_COUNT: '100',
  SCIM_MAX_COUNT: '200',
  TRUST_PROXY: 'false',
};

function load(
  vars: Record<string, string | undefined>,
  files: Record<string, string> = {},
): CoreConfig {
  const env = new Env(vars, (path) => {
    if (!(path in files)) throw new Error('ENOENT');
    return files[path];
  });
  const config = loadCoreConfig(env);
  env.assertValid();
  return config;
}

function problems(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof EnvError) return err.problems;
    throw err;
  }
  assert.fail('expected an EnvError');
}

describe('SSL configuration', () => {
  it('serves plain HTTP without cert paths when SSL_ENABLED=false', () => {
    const config = load({ ...BASE, SSL_ENABLED: 'false' });
    assert.deepEqual(config.ssl, { enabled: false });
  });

  it('requires the cert and key paths when SSL_ENABLED=true', () => {
    const found = problems(() => load({ ...BASE, SSL_ENABLED: 'true' }));
    assert.equal(found.length, 2);
    assert.match(found[0], /^SSL_CERT_PATH is not set/);
    assert.match(found[1], /^SSL_KEY_PATH is not set/);
  });

  it('reads the cert and key paths when SSL_ENABLED=true', () => {
    const config = load({
      ...BASE,
      SSL_ENABLED: 'true',
      SSL_CERT_PATH: '/certs/tls.crt',
      SSL_KEY_PATH: '/certs/tls.key',
    });
    assert.deepEqual(config.ssl, {
      enabled: true,
      certPath: '/certs/tls.crt',
      keyPath: '/certs/tls.key',
    });
  });

  it('requires SSL_ENABLED to be set explicitly', () => {
    const found = problems(() => load(BASE));
    assert.equal(found.length, 1);
    assert.match(found[0], /^SSL_ENABLED is not set/);
  });

  it('requires TRUST_PROXY to be set explicitly', () => {
    const { TRUST_PROXY: _omit, ...rest } = BASE;
    const found = problems(() => load({ ...rest, SSL_ENABLED: 'false' }));
    assert.equal(found.length, 1);
    assert.match(found[0], /^TRUST_PROXY is not set/);
  });
});

describe('NAME_FILE secrets', () => {
  const vars = { ...BASE, SSL_ENABLED: 'false', API_KEY: undefined };

  it('reads a value from the file and strips one trailing newline', () => {
    const config = load(
      { ...vars, API_KEY_FILE: '/run/secrets/api_key' },
      { '/run/secrets/api_key': 's3cret\n' },
    );
    assert.equal(config.apiKey, 's3cret');
  });

  it('rejects setting both NAME and NAME_FILE', () => {
    const found = problems(() =>
      load({ ...vars, API_KEY: 'x', API_KEY_FILE: '/run/secrets/api_key' }, { '/run/secrets/api_key': 'y' }),
    );
    assert.equal(found.length, 1);
    assert.match(found[0], /API_KEY and API_KEY_FILE are both set/);
  });

  it('reports an unreadable file', () => {
    const found = problems(() => load({ ...vars, API_KEY_FILE: '/missing' }));
    assert.equal(found.length, 1);
    assert.match(found[0], /API_KEY_FILE='\/missing' could not be read/);
  });

  it('reports an empty file', () => {
    const found = problems(() => load({ ...vars, API_KEY_FILE: '/empty' }, { '/empty': '\n' }));
    assert.equal(found.length, 1);
    assert.match(found[0], /API_KEY_FILE='\/empty' is empty/);
  });
});

describe('TRUST_PROXY', () => {
  const sink: AuditSink = {
    init: async () => {},
    close: async () => {},
    recordRequest: async () => {},
    recordBackendOperation: async () => {},
  };
  const backend: ScimUserBackend = {
    attributes: ['userName'],
    lookups: ['id'],
    init: async () => {},
    close: async () => {},
    getUser: async () => null,
    listUsers: async () => ({ users: [], totalResults: 0 }),
    createUser: async () => 'x',
    updateUser: async () => {},
    deleteUser: async () => {},
  };
  const module: BackendModule<null> = {
    name: 'stub',
    loadConfig: () => null,
    create: () => backend,
  };

  async function serviceConfigLocation(trustProxy: boolean): Promise<string> {
    const config = load({ ...BASE, SSL_ENABLED: 'false', TRUST_PROXY: String(trustProxy), LOG_LEVEL: 'fatal' });
    const server: FastifyInstance = await createScimServer({ module, config, backendConfig: null, sink });
    const res = await server.inject({
      url: '/scim/v2/ServiceProviderConfig',
      headers: { host: 'internal:8080', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'scim.example.com' },
    });
    await server.close();
    return res.json().meta.location;
  }

  it('builds https locations from X-Forwarded-* headers when true', async () => {
    assert.equal(
      await serviceConfigLocation(true),
      'https://scim.example.com/scim/v2/ServiceProviderConfig',
    );
  });

  it('ignores X-Forwarded-* headers when false', async () => {
    assert.equal(
      await serviceConfigLocation(false),
      'http://internal:8080/scim/v2/ServiceProviderConfig',
    );
  });
});
