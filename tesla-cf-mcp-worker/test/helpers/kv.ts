/**
 * A KVNamespace-compatible in-memory adapter for tests. Implements get (text +
 * "json" mode), put (with expirationTtl honored against a mockable clock),
 * delete, and list. Enough for auth/rules/tracking test coverage.
 */
interface Entry {
  value: string;
  expiresAt: number | null; // unix ms
}

export class FakeKV {
  private store = new Map<string, Entry>();
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  private live(key: string): Entry | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }

  async get(key: string, type?: "text" | "json"): Promise<unknown> {
    const e = this.live(key);
    if (!e) return null;
    return type === "json" ? JSON.parse(e.value) : e.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = opts?.expirationTtl ? this.now() + opts.expirationTtl * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(opts?: { prefix?: string }): Promise<{ keys: { name: string }[] }> {
    const prefix = opts?.prefix ?? "";
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix) && this.live(k))
      .map((name) => ({ name }));
    return { keys };
  }

  /** Test-only: raw current size (excludes lazy-expired entries). */
  size(): number {
    return [...this.store.keys()].filter((k) => this.live(k)).length;
  }
}
