// End-to-end tests of the SCIM server against an in-memory backend.
// Run with: npm test

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import {
  AuditSink,
  BackendModule,
  BackendOperationRecord,
  CoreConfig,
  RequestRecord,
  SCIM_SCHEMA_ENTERPRISE_USER,
  SCIM_SCHEMA_PATCH_OP,
  SCIM_SCHEMA_USER,
  ScimErrors,
  ScimUserBackend,
  StoredUser,
  UserAttributes,
  UserUpdate,
  createScimServer,
  paginate,
} from '../src';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class MemorySink implements AuditSink {
  requests: RequestRecord[] = [];
  operations: BackendOperationRecord[] = [];
  async init(): Promise<void> {}
  async close(): Promise<void> {}
  async recordRequest(record: RequestRecord): Promise<void> {
    this.requests.push(record);
  }
  async recordBackendOperation(record: BackendOperationRecord): Promise<void> {
    this.operations.push(record);
  }
}

interface MemoryState {
  users: Map<string, StoredUser>;
  passwords: Map<string, string>;
  updates: UserUpdate[];
  nextId: number;
  clock: number;
}

const state: MemoryState = {
  users: new Map(),
  passwords: new Map(),
  updates: [],
  nextId: 1,
  clock: 0,
};

function tick(): string {
  state.clock += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, state.clock)).toISOString();
}

function memoryModule(withPassword: boolean): BackendModule<null> {
  return {
    name: 'memory',
    loadConfig: () => null,
    create: (_config, context): ScimUserBackend => {
      const backend: ScimUserBackend = {
        attributes: [
          'userName',
          'name.givenName',
          'name.familyName',
          'displayName',
          'emails',
          'addresses',
          'active',
          `${SCIM_SCHEMA_ENTERPRISE_USER}:department`,
        ],
        lookups: ['id', 'userName', 'email'],
        async init() {},
        async close() {},
        async getUser(id) {
          return context.audit.run({ operation: 'get', target: id }, async () => {
            const user = state.users.get(id);
            return user ? structuredClone(user) : null;
          });
        },
        async listUsers(query) {
          let users = [...state.users.values()];
          const { lookup } = query;
          if (lookup) {
            users = users.filter((u) =>
              lookup.by === 'id'
                ? u.id === lookup.value
                : lookup.by === 'userName'
                  ? u.userName === lookup.value
                  : (u.emails ?? []).some((e) => e.value === lookup.value),
            );
          }
          return paginate(structuredClone(users), query);
        },
        async createUser(user: UserAttributes, password) {
          return context.audit.run(
            { operation: 'create', params: { user, password } },
            async () => {
              if ([...state.users.values()].some((u) => u.userName === user.userName)) {
                throw ScimErrors.uniqueness(`userName '${user.userName}' already exists.`);
              }
              const id = `u${state.nextId++}`;
              const now = tick();
              state.users.set(id, { ...structuredClone(user), id, created: now, lastModified: now });
              if (password !== undefined) state.passwords.set(id, password);
              return id;
            },
          );
        },
        async updateUser(id, update) {
          state.updates.push(structuredClone(update));
          const existing = state.users.get(id)!;
          state.users.set(id, {
            ...structuredClone(update.user),
            id,
            created: existing.created,
            lastModified: tick(),
          });
        },
        async deleteUser(id) {
          state.users.delete(id);
        },
      };
      if (withPassword) {
        backend.setPassword = async (id, password) => {
          await context.audit.run(
            { operation: 'setPassword', target: id, params: { password } },
            async () => {
              state.passwords.set(id, password);
            },
          );
        };
      }
      return backend;
    },
  };
}

const API_KEY = 'test-key';
const AUTH = { authorization: `Basic ${Buffer.from(`anyone:${API_KEY}`).toString('base64')}` };
const SCIM_JSON = { ...AUTH, 'content-type': 'application/scim+json' };

function config(overrides: Partial<CoreConfig> = {}): CoreConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'fatal',
    apiKey: API_KEY,
    ssl: { certPath: '', keyPath: '' },
    auditDbPath: '',
    unsupportedAttributes: 'reject',
    defaultCount: 100,
    maxCount: 200,
    ...overrides,
  };
}

function resetState(): void {
  state.users.clear();
  state.passwords.clear();
  state.updates = [];
  state.nextId = 1;
  state.clock = 0;
}

const newUser = (userName: string, extra: object = {}) => ({
  schemas: [SCIM_SCHEMA_USER],
  userName,
  name: { givenName: 'Test', familyName: 'User' },
  displayName: 'Test User',
  emails: [{ value: userName, type: 'work', primary: true }],
  active: true,
  ...extra,
});

async function create(server: FastifyInstance, userName: string, extra: object = {}) {
  const res = await server.inject({
    method: 'POST',
    url: '/scim/v2/Users',
    headers: SCIM_JSON,
    payload: newUser(userName, extra),
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

const patch = (operations: object[]) => ({ schemas: [SCIM_SCHEMA_PATCH_OP], Operations: operations });

// ---------------------------------------------------------------------------

describe('SCIM server', () => {
  let server: FastifyInstance;
  let sink: MemorySink;

  before(async () => {
    sink = new MemorySink();
    server = await createScimServer({
      module: memoryModule(true),
      config: config(),
      backendConfig: null,
      sink,
    });
  });
  after(() => server.close());
  beforeEach(() => {
    resetState();
    sink.requests = [];
    sink.operations = [];
  });

  // ── Auth and discovery ────────────────────────────────────────────────────

  it('requires the API key on /Users only', async () => {
    const anonymous = await server.inject({ url: '/scim/v2/Users' });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.json().status, '401');

    const wrong = await server.inject({
      url: '/scim/v2/Users',
      headers: { authorization: `Basic ${Buffer.from('x:nope').toString('base64')}` },
    });
    assert.equal(wrong.statusCode, 401);

    assert.equal((await server.inject({ url: '/health' })).statusCode, 200);
    assert.equal((await server.inject({ url: '/scim/v2/ServiceProviderConfig' })).statusCode, 200);
    assert.equal((await server.inject({ url: '/scim/v2/Schemas' })).statusCode, 200);
    assert.equal((await server.inject({ url: '/scim/v2/ResourceTypes' })).statusCode, 200);
  });

  it('describes the backend in discovery', async () => {
    const spc = (await server.inject({ url: '/scim/v2/ServiceProviderConfig' })).json();
    assert.equal(spc.changePassword.supported, true);
    assert.equal(spc.filter.maxResults, 200);
    assert.equal(spc.sort.supported, false);

    const schemas = (await server.inject({ url: '/scim/v2/Schemas' })).json();
    assert.equal(schemas.totalResults, 2);
    const core = schemas.Resources[0].attributes.map((a: { name: string }) => a.name);
    assert.deepEqual(core, ['userName', 'name', 'displayName', 'active', 'emails', 'addresses', 'password']);
    assert.deepEqual(
      schemas.Resources[1].attributes.map((a: { name: string }) => a.name),
      ['department'],
    );
  });

  it('answers unknown routes with a SCIM 404', async () => {
    const res = await server.inject({ url: '/scim/v2/Nope', headers: AUTH });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().schemas[0], 'urn:ietf:params:scim:api:messages:2.0:Error');
  });

  // ── Create and read ───────────────────────────────────────────────────────

  it('creates a user, returns it without the password, and redacts the audit row', async () => {
    const created = await create(server, 'a@example.com', { password: 'S3cret!' });

    assert.equal(created.id, 'u1');
    assert.equal(created.userName, 'a@example.com');
    assert.equal(created.password, undefined);
    assert.equal(created.meta.resourceType, 'User');
    assert.match(created.meta.location, /\/scim\/v2\/Users\/u1$/);
    assert.ok(created.meta.created && created.meta.lastModified);
    assert.equal(state.passwords.get('u1'), 'S3cret!');

    await new Promise((r) => setImmediate(r));
    const row = sink.requests.at(-1)!;
    assert.ok(!row.requestBody!.includes('S3cret!'));
    assert.ok(row.requestBody!.includes('***REDACTED***'));
    assert.equal(row.notes!.passwordChange, true);

    const op = sink.operations.find((o) => o.operation === 'create')!;
    assert.ok(!JSON.stringify(op.params).includes('S3cret!'));
    assert.equal(op.requestId, row.requestId);
    assert.equal(op.backend, 'memory');
  });

  it('treats null and empty arrays as unassigned', async () => {
    const created = await create(server, 'a@example.com', { groups: [], displayName: null });
    assert.equal(created.displayName, undefined);
  });

  it('rejects unsupported attributes, wrong types and duplicates', async () => {
    const post = (payload: object) =>
      server.inject({ method: 'POST', url: '/scim/v2/Users', headers: SCIM_JSON, payload });

    const unsupported = await post(newUser('a@example.com', { locale: 'en-US', name: { middleName: 'X' } }));
    assert.equal(unsupported.statusCode, 400);
    assert.match(unsupported.json().detail, /locale/);
    assert.match(unsupported.json().detail, /name\.middleName/);
    assert.equal(state.users.size, 0);

    assert.equal((await post(newUser('a@example.com', { active: 'true' }))).statusCode, 400);
    assert.equal((await post({ schemas: [SCIM_SCHEMA_USER] })).statusCode, 400);
    assert.equal((await post({ userName: 'a@example.com' })).statusCode, 400);

    await create(server, 'a@example.com');
    const duplicate = await post(newUser('a@example.com'));
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().scimType, 'uniqueness');
  });

  it('rejects a non-JSON content type and malformed JSON', async () => {
    const text = await server.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: { ...AUTH, 'content-type': 'text/plain' },
      payload: 'hello',
    });
    assert.equal(text.statusCode, 415);

    const broken = await server.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: SCIM_JSON,
      payload: '{"userName": ',
    });
    assert.equal(broken.statusCode, 400);
    assert.equal(broken.json().scimType, 'invalidSyntax');
  });

  it('returns 404 for an unknown id on every verb', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await server.inject({ method, url: '/scim/v2/Users/nope', headers: AUTH });
      assert.equal(res.statusCode, 404, method);
    }
    const put = await server.inject({
      method: 'PUT',
      url: '/scim/v2/Users/nope',
      headers: SCIM_JSON,
      payload: newUser('a@example.com'),
    });
    assert.equal(put.statusCode, 404);
  });

  // ── List ──────────────────────────────────────────────────────────────────

  it('lists newest first and pages', async () => {
    for (const name of ['a', 'b', 'c']) await create(server, `${name}@example.com`);

    const all = (await server.inject({ url: '/scim/v2/Users', headers: AUTH })).json();
    assert.equal(all.totalResults, 3);
    assert.deepEqual(
      all.Resources.map((u: { userName: string }) => u.userName),
      ['c@example.com', 'b@example.com', 'a@example.com'],
    );

    const page = (
      await server.inject({ url: '/scim/v2/Users?startIndex=2&count=1', headers: AUTH })
    ).json();
    assert.equal(page.totalResults, 3);
    assert.equal(page.startIndex, 2);
    assert.equal(page.itemsPerPage, 1);
    assert.equal(page.Resources[0].userName, 'b@example.com');

    const none = (await server.inject({ url: '/scim/v2/Users?count=0', headers: AUTH })).json();
    assert.equal(none.totalResults, 3);
    assert.equal(none.Resources.length, 0);
  });

  it('filters with eq on declared lookups and rejects everything else', async () => {
    await create(server, 'a@example.com');
    const get = (filter: string) =>
      server.inject({ url: `/scim/v2/Users?filter=${encodeURIComponent(filter)}`, headers: AUTH });

    const hit = (await get('userName eq "a@example.com"')).json();
    assert.equal(hit.totalResults, 1);
    assert.equal((await get('emails.value eq "a@example.com"')).json().totalResults, 1);
    assert.equal((await get('userName eq "zzz"')).json().totalResults, 0);

    for (const filter of [
      'userName co "a"',
      'externalId eq "x"',
      'userName eq "a" and active eq true',
      'garbage',
    ]) {
      const res = await get(filter);
      assert.equal(res.statusCode, 400, filter);
      assert.equal(res.json().scimType, 'invalidFilter', filter);
    }
  });

  it('rejects bad paging and unsupported list parameters', async () => {
    const get = (qs: string) => server.inject({ url: `/scim/v2/Users?${qs}`, headers: AUTH });
    assert.equal((await get('count=abc')).statusCode, 400);
    assert.equal((await get('startIndex=1.5')).statusCode, 400);
    assert.equal((await get('sortBy=userName')).statusCode, 400);
    assert.equal((await get('startIndex=-4&count=-1')).statusCode, 200);
  });

  // ── Update ────────────────────────────────────────────────────────────────

  it('PUT replaces the profile and clears omitted attributes', async () => {
    await create(server, 'a@example.com', { [SCIM_SCHEMA_ENTERPRISE_USER]: { department: 'Ops' } });

    const res = await server.inject({
      method: 'PUT',
      url: '/scim/v2/Users/u1',
      headers: SCIM_JSON,
      payload: {
        schemas: [SCIM_SCHEMA_USER],
        id: 'ignored',
        userName: 'a@example.com',
        name: { givenName: 'New', familyName: 'User' },
        active: true,
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.id, 'u1');
    assert.equal(body.name.givenName, 'New');
    assert.equal(body.displayName, undefined);
    assert.equal(body[SCIM_SCHEMA_ENTERPRISE_USER], undefined);
    assert.deepEqual(body.schemas, [SCIM_SCHEMA_USER]);

    const update = state.updates[0];
    assert.equal(update.previous.displayName, 'Test User');
    assert.equal(update.user.displayName, undefined);

    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sink.requests.at(-1)!.notes!.changedAttributes, [
      'name.givenName',
      'displayName',
      'emails',
      `${SCIM_SCHEMA_ENTERPRISE_USER}:department`,
    ]);
  });

  it('validates, stores and patches addresses', async () => {
    const address = {
      type: 'work',
      primary: true,
      streetAddress: '100 Main St',
      locality: 'San Francisco',
      region: 'CA',
      postalCode: '94105',
      country: 'US',
    };
    const created = await create(server, 'a@example.com', { addresses: [address] });
    assert.deepEqual(created.addresses, [address]);

    const res = await server.inject({
      method: 'PATCH',
      url: '/scim/v2/Users/u1',
      headers: SCIM_JSON,
      payload: patch([{ op: 'replace', path: 'addresses[type eq "work"].locality', value: 'Oakland' }]),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().addresses[0].locality, 'Oakland');
    assert.equal(res.json().addresses[0].postalCode, '94105');

    for (const bad of [{ locality: 5 }, 'x', { primary: 'yes' }]) {
      const r = await server.inject({
        method: 'POST',
        url: '/scim/v2/Users',
        headers: SCIM_JSON,
        payload: newUser('b@example.com', { addresses: [bad] }),
      });
      assert.equal(r.statusCode, 400, r.body);
    }
    const unknown = await server.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: SCIM_JSON,
      payload: newUser('b@example.com', { addresses: [{ ...address, planet: 'Earth' }] }),
    });
    assert.equal(unknown.statusCode, 400);
    assert.match(unknown.json().detail, /addresses\.planet/);

    const schemas = (await server.inject({ url: '/scim/v2/Schemas' })).json();
    const def = schemas.Resources[0].attributes.find((a: { name: string }) => a.name === 'addresses');
    assert.equal(def.multiValued, true);
    assert.ok(def.subAttributes.some((a: { name: string }) => a.name === 'postalCode'));
  });

  it('PATCH handles the forms Okta and Entra send', async () => {
    await create(server, 'a@example.com');
    const send = (operations: object[]) =>
      server.inject({
        method: 'PATCH',
        url: '/scim/v2/Users/u1',
        headers: SCIM_JSON,
        payload: patch(operations),
      });

    // Okta deactivation
    let res = await send([{ op: 'replace', value: { active: false } }]);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().active, false);
    assert.equal(state.updates.at(-1)!.previous.active, true);

    // Path forms, mixed-case verb
    res = await send([
      { op: 'Replace', path: 'name.givenName', value: 'Ada' },
      { op: 'replace', path: 'emails[type eq "work"].value', value: 'ada@example.com' },
      { op: 'add', path: `${SCIM_SCHEMA_ENTERPRISE_USER}:department`, value: 'R&D' },
      { op: 'remove', path: 'displayName' },
    ]);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.name.givenName, 'Ada');
    assert.equal(body.name.familyName, 'User');
    assert.equal(body.emails[0].value, 'ada@example.com');
    assert.equal(body.emails[0].primary, true);
    assert.equal(body[SCIM_SCHEMA_ENTERPRISE_USER].department, 'R&D');
    assert.equal(body.displayName, undefined);
    assert.ok(body.schemas.includes(SCIM_SCHEMA_ENTERPRISE_USER));

    // Password through PATCH: set, never echoed, redacted in the audit row
    res = await send([{ op: 'replace', path: 'password', value: 'N3w-pass' }]);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(state.passwords.get('u1'), 'N3w-pass');
    await new Promise((r) => setImmediate(r));
    assert.ok(!sink.requests.at(-1)!.requestBody!.includes('N3w-pass'));
    assert.ok(!JSON.stringify(sink.operations).includes('N3w-pass'));
  });

  it('PATCH rejects what it cannot apply', async () => {
    await create(server, 'a@example.com');
    const send = (payload: object) =>
      server.inject({ method: 'PATCH', url: '/scim/v2/Users/u1', headers: SCIM_JSON, payload });

    const cases: Array<[object, string]> = [
      [patch([]), 'invalidSyntax'],
      [patch([{ op: 'move', path: 'active', value: true }]), 'invalidSyntax'],
      [patch([{ op: 'replace', path: 'emails[type eq "home"].value', value: 'x' }]), 'noTarget'],
      [patch([{ op: 'replace', path: 'a..b', value: 'x' }]), 'invalidPath'],
      [patch([{ op: 'remove' }]), 'noTarget'],
      [patch([{ op: 'replace', path: 'id', value: 'x' }]), 'mutability'],
      [patch([{ op: 'replace', path: 'locale', value: 'en' }]), 'invalidValue'],
      [patch([{ op: 'remove', path: 'userName' }]), 'invalidValue'],
      [{ Operations: [{ op: 'replace', value: { active: false } }] }, 'invalidSyntax'],
    ];
    for (const [payload, scimType] of cases) {
      const res = await send(payload);
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(res.json().scimType, scimType, JSON.stringify(payload));
    }
    assert.equal(state.updates.length, 0);
  });

  it('deletes a user', async () => {
    await create(server, 'a@example.com');
    const res = await server.inject({ method: 'DELETE', url: '/scim/v2/Users/u1', headers: AUTH });
    assert.equal(res.statusCode, 204);
    assert.equal(state.users.size, 0);
  });
});

// ---------------------------------------------------------------------------

describe('SCIM server options', () => {
  it('drops unsupported attributes under the ignore policy and notes them', async () => {
    resetState();
    const sink = new MemorySink();
    const server = await createScimServer({
      module: memoryModule(true),
      config: config({ unsupportedAttributes: 'ignore' }),
      backendConfig: null,
      sink,
    });
    const created = await create(server, 'a@example.com', { locale: 'en-US' });
    assert.equal(created.locale, undefined);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sink.requests.at(-1)!.notes!.ignoredAttributes, ['locale']);
    await server.close();
  });

  it('refuses passwords when the backend cannot set them', async () => {
    resetState();
    const server = await createScimServer({
      module: memoryModule(false),
      config: config(),
      backendConfig: null,
      sink: new MemorySink(),
    });
    const res = await server.inject({
      method: 'POST',
      url: '/scim/v2/Users',
      headers: SCIM_JSON,
      payload: newUser('a@example.com', { password: 'x' }),
    });
    assert.equal(res.statusCode, 400);
    const spc = (await server.inject({ url: '/scim/v2/ServiceProviderConfig' })).json();
    assert.equal(spc.changePassword.supported, false);
    await server.close();
  });
});
