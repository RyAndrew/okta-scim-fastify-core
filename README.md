# scim-fastify-core

A shared SCIM 2.0 server for building Okta provisioning bridges on [Fastify](https://fastify.dev).

Core handles the SCIM protocol: HTTPS, authentication, routing, discovery, filters, PATCH, response formatting and auditing. A **backend module** maps SCIM attributes to a directory and makes the native calls (LDAP, Active Directory through PowerShell, SQL, and so on). The entry point of a backend repo is a single call:

```ts
import { startScimServer } from 'scim-fastify-core';
import { ldapModule } from './backend';

startScimServer(ldapModule);
```

## Features

- **SCIM 2.0 `/Users`** with GET, list, POST, PUT, PATCH and DELETE, following RFC 7643 and RFC 7644 the way Okta uses them.
- **Optional `/Groups`**, served only when the backend provides a group implementation. Membership changes reach the backend as a delta, so a PATCH on a large group never loads its full member list.
- **Discovery endpoints** (`/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`) built from the attributes the backend declares.
- **Strict validation.** Filters, PATCH paths and attributes the backend cannot handle fail the request with a SCIM error. Nothing is silently dropped.
- **Audit log in SQLite.** Every HTTP request and every backend operation is recorded with redacted bodies and a shared request id.
- **Docker-ready configuration.** All settings come from environment variables, every setting can be read from a `*_FILE` secret, TLS can be turned off when a proxy handles it, and the server shuts down gracefully on `SIGTERM`.
- **Startup checks.** Every missing or invalid variable is reported together in one error, and the backend's declared attributes are checked before the server starts listening.

## Requirements

- Node.js 20 or newer (Node 22 is recommended)
- A backend module that implements `BackendModule` (see [docs/backend-contract.md](docs/backend-contract.md))

## Installation

Install it as a dependency of your backend repo:

```bash
npm install github:RyAndrew/okta-scim-fastify-core
```

Or work on core directly:

```bash
git clone https://github.com/RyAndrew/okta-scim-fastify-core.git
cd okta-scim-fastify-core
npm install
npm run build   # compile to dist/
npm test        # end-to-end tests against an in-memory backend
```

## Configuration

Settings are read from the environment. A `.env` file in the working directory is loaded if one exists, but variables already set in the environment take precedence.

There are **no defaults**: every core variable must be set, and startup fails with the complete list of problems if any are missing or invalid. Backend modules add their own variables (for example `LDAP_*`) and follow the same rules.

| Variable | Values | Description |
|---|---|---|
| `HOST` | address | Address to listen on. Use `0.0.0.0` in a container. |
| `PORT` | 1–65535 | Port to listen on. |
| `LOG_LEVEL` | `fatal` `error` `warn` `info` `debug` `trace` | Log level. Logs are written to stdout as JSON. |
| `API_KEY` | string | Shared secret. The SCIM client sends it as the HTTP Basic password; the username is ignored. |
| `SSL_ENABLED` | `true` `false` | `true` serves HTTPS directly. `false` serves plain HTTP for use behind a TLS-terminating proxy. |
| `SSL_CERT_PATH` | path | PEM certificate. Required only when `SSL_ENABLED=true`. |
| `SSL_KEY_PATH` | path | PEM private key. Required only when `SSL_ENABLED=true`. |
| `TRUST_PROXY` | `true` `false` | Trust `X-Forwarded-For`, `-Proto` and `-Host`. Set `true` only behind a reverse proxy. |
| `AUDIT_DB_PATH` | path | SQLite audit database file. Created if it does not exist. |
| `SCIM_UNSUPPORTED_ATTRIBUTES` | `reject` `ignore` | What to do with attributes the backend does not store: return a 400, or drop them and note it in the audit log. |
| `SCIM_DEFAULT_COUNT` | 1–10000 | Page size when a list request has no `count`. |
| `SCIM_MAX_COUNT` | 1–10000 | Largest page size served. Must be at least `SCIM_DEFAULT_COUNT`. |

### Secrets from files (`*_FILE`)

Any variable, core or backend, can be given as `NAME_FILE` instead of `NAME`. The value is then read from that file, and one trailing newline is removed. This works with Docker secrets and Kubernetes secret volumes:

```bash
API_KEY_FILE=/run/secrets/scim_api_key
LDAP_BIND_PASSWORD_FILE=/run/secrets/ldap_bind_password
```

Setting both `NAME` and `NAME_FILE` is an error, as is a missing or empty file.

### TLS: direct or behind a proxy

Okta only provisions to HTTPS endpoints. You can provide TLS in two ways:

**Direct HTTPS.** The server terminates TLS itself:

```bash
SSL_ENABLED=true
SSL_CERT_PATH=/certs/tls.crt
SSL_KEY_PATH=/certs/tls.key
TRUST_PROXY=false
```

**Behind a proxy.** Traefik, nginx, Caddy, a cloud load balancer or a Kubernetes ingress terminates TLS and forwards plain HTTP to the container:

```bash
SSL_ENABLED=false
TRUST_PROXY=true
```

With `SSL_ENABLED=false` the server logs a warning at startup, because the API key travels in every request. Do not expose the plain-HTTP port outside the private network.

Set `TRUST_PROXY=true` whenever a proxy is in front. SCIM responses include absolute URLs (`meta.location` and the `Location` header) built from the request's protocol and host. Without proxy trust, Okta would receive `http://container:8080/...` instead of your public `https://` address, and the audit log would record the proxy's IP address instead of the client's.

## Running in Docker

Core is a library, so the image is built from a backend repo. A typical `Dockerfile`:

```dockerfile
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]
```

Notes:

- Use a Debian-based image such as `node:22-slim` rather than Alpine. `better-sqlite3` ships prebuilt binaries for glibc; on Alpine it has to be compiled, which needs Python and a C++ toolchain.
- Use the exec form of `CMD` (`["node", ...]`, not `npm start`) so that Node receives `SIGTERM` directly. The server then closes the backend connection and the audit database before it exits.
- The health check above assumes `SSL_ENABLED=false`. With direct HTTPS, use `https://` and make sure the certificate is valid for `127.0.0.1`, or check `/health` from outside the container instead.

### docker compose

Example with TLS handled by a proxy, the API key read from a Docker secret, and the audit database on a volume:

```yaml
services:
  scim:
    build: .
    restart: unless-stopped
    environment:
      HOST: 0.0.0.0
      PORT: 8080
      LOG_LEVEL: info
      SSL_ENABLED: "false"
      TRUST_PROXY: "true"
      API_KEY_FILE: /run/secrets/scim_api_key
      AUDIT_DB_PATH: /data/audit.db
      SCIM_UNSUPPORTED_ATTRIBUTES: reject
      SCIM_DEFAULT_COUNT: 100
      SCIM_MAX_COUNT: 200
      # plus your backend's variables, e.g. LDAP_URL, LDAP_BIND_PASSWORD_FILE
    secrets:
      - scim_api_key
    volumes:
      - scim-audit:/data
    expose:
      - "8080"   # reached only through the proxy, not published on the host

secrets:
  scim_api_key:
    file: ./secrets/scim_api_key.txt

volumes:
  scim-audit:
```

For direct HTTPS instead, set `SSL_ENABLED: "true"`, mount the certificate and key read-only (for example `./certs:/certs:ro`), set `SSL_CERT_PATH` and `SSL_KEY_PATH`, set `TRUST_PROXY: "false"`, and publish the port with `ports: ["443:8080"]`.

## Endpoints

All SCIM routes are under `/scim/v2`.

| Path | Auth | Description |
|---|---|---|
| `GET /health` | none | Returns `{ "status": "ok", "backend": "<name>" }`. |
| `GET /scim/v2/ServiceProviderConfig` | none | Server capabilities. |
| `GET /scim/v2/ResourceTypes` | none | `User`, plus `Group` when the backend supports groups. |
| `GET /scim/v2/Schemas` | none | Only the attributes the backend declares. |
| `/scim/v2/Users` | Basic | GET (list and by id), POST, PUT, PATCH, DELETE. |
| `/scim/v2/Groups` | Basic | Same operations. Only present when the backend provides `groups`. |

Filters support `<attribute> eq "<value>"` on the lookups the backend declares, such as `userName eq "jdoe@example.com"`.

## Connecting Okta

In the Okta app's **Provisioning → Integration** settings:

- **SCIM connector base URL:** `https://<your-host>/scim/v2`
- **Unique identifier field for users:** `userName`
- **Authentication mode:** Basic Auth. The username can be anything; the password is your `API_KEY`.

## Writing a backend

A backend module supplies its configuration, the attributes and lookups it supports, and the native read and write calls. Core does everything else. See [docs/backend-contract.md](docs/backend-contract.md) for the full contract, what core does for each request, and examples of mappings for LDAP, Active Directory and SQLite.

```ts
import type { BackendModule } from 'scim-fastify-core';

export const myModule: BackendModule<MyConfig> = {
  name: 'my-directory',
  loadConfig: (env) => ({
    url: env.require('MY_DIR_URL', 'Directory URL.'),
    password: env.require('MY_DIR_PASSWORD', 'Bind password.'), // MY_DIR_PASSWORD_FILE works too
  }),
  create: (config, { audit, log }) => new MyDirectoryBackend(config, audit, log),
};
```

## Audit log

The SQLite file at `AUDIT_DB_PATH` has two tables:

- `requests`: one row per HTTP request, with method, path, status, client IP, duration, and redacted request and response bodies.
- `backend_operations`: one row per native call the backend reports through `ctx.audit.run(...)`, linked to the request that caused it.

Passwords and other secrets are redacted before anything is written. A failed audit write is logged and never fails the request. To use a different store, implement the `AuditSink` interface and pass it to `createScimServer`.

## Development

```bash
npm run build   # tsc → dist/
npm run dev     # tsc --watch
npm test        # node:test via tsx
```

The tests start the real server in-process against an in-memory backend, so they cover the full request path without a directory.
