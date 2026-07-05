/**
 * A D1Database-compatible adapter backed by node:sqlite (in-memory), so the
 * storage + derivation layers can be tested against real SQL without a live
 * Cloudflare binding. Implements only the surface this codebase uses:
 * prepare().bind().run()/first()/all(), batch(), and exec().
 */
// Loaded via createRequire so Vite's static import analysis doesn't try to
// bundle node:sqlite (which it doesn't recognize and mis-resolves to "sqlite").
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

class FakeStatement {
  constructor(private db: DatabaseSync, private sql: string, private params: unknown[] = []) {}

  bind(...params: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, params);
  }

  private normalize(params: unknown[]): unknown[] {
    // node:sqlite accepts null/number/bigint/string/Uint8Array; coerce booleans
    // and undefined the way D1 does (undefined -> null, boolean -> 0/1).
    return params.map((p) => {
      if (p === undefined) return null;
      if (typeof p === "boolean") return p ? 1 : 0;
      return p;
    });
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.normalize(this.params));
    return {
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    };
  }

  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.normalize(this.params)) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (col) return (row[col] ?? null) as T;
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.normalize(this.params)) as T[];
    return { results: rows, success: true, meta: {} };
  }
}

export class FakeD1 {
  readonly db: DatabaseSync;
  constructor() {
    this.db = new DatabaseSync(":memory:");
  }
  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.db, sql);
  }
  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }
  async exec(sql: string): Promise<{ count: number }> {
    this.db.exec(sql);
    return { count: 0 };
  }
}
