// ---------------------------------------------------------------------------
// SQLite audit sink (Knex + better-sqlite3).
//
// Two tables, shared by every backend:
//   requests            one row per HTTP request/response round trip
//   backend_operations  one row per native operation a backend performed,
//                       linked to the request that caused it
// ---------------------------------------------------------------------------

import Knex, { Knex as KnexInstance } from 'knex';
import { AuditSink, BackendOperationRecord, RequestRecord } from './sink';

const MAX_TEXT = 65_535;

function clip(text: string | null): string | null {
  return text === null ? null : text.slice(0, MAX_TEXT);
}

export class SqliteAuditSink implements AuditSink {
  private readonly db: KnexInstance;

  constructor(filename: string) {
    this.db = Knex({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
    });
  }

  async init(): Promise<void> {
    if (!(await this.db.schema.hasTable('requests'))) {
      await this.db.schema.createTable('requests', (t) => {
        t.string('request_id').primary();
        t.string('method').notNullable();
        t.text('url').notNullable();
        t.string('ip').notNullable();
        t.text('request_body').nullable();
        t.integer('response_status').notNullable();
        t.text('response_body').nullable();
        t.integer('duration_ms').notNullable();
        t.text('notes_json').nullable();
        t.string('created_at').notNullable();
      });
    }

    if (!(await this.db.schema.hasTable('backend_operations'))) {
      await this.db.schema.createTable('backend_operations', (t) => {
        t.increments('id').primary();
        t.string('request_id').nullable().index();
        t.string('backend').notNullable();
        t.string('operation').notNullable();
        t.text('target').nullable();
        t.text('params_json').nullable();
        t.boolean('success').notNullable();
        t.text('error').nullable();
        t.integer('duration_ms').notNullable();
        t.string('created_at').notNullable();
      });
    }
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }

  async recordRequest(record: RequestRecord): Promise<void> {
    await this.db('requests').insert({
      request_id: record.requestId,
      method: record.method,
      url: record.url,
      ip: record.ip,
      request_body: clip(record.requestBody),
      response_status: record.responseStatus,
      response_body: clip(record.responseBody),
      duration_ms: record.durationMs,
      notes_json: record.notes === null ? null : clip(JSON.stringify(record.notes)),
      created_at: record.createdAt,
    });
  }

  async recordBackendOperation(record: BackendOperationRecord): Promise<void> {
    await this.db('backend_operations').insert({
      request_id: record.requestId,
      backend: record.backend,
      operation: record.operation,
      target: record.target,
      params_json: record.params === undefined ? null : clip(JSON.stringify(record.params)),
      success: record.success,
      error: clip(record.error),
      duration_ms: record.durationMs,
      created_at: record.createdAt,
    });
  }
}
