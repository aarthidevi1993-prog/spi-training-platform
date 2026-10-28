/**
 * Repository layer — the only layer allowed to know where data comes
 * from (mock arrays today, Supabase/PostgreSQL later). Services call
 * repositories; UI components never import a repository directly.
 *
 * Each concrete repository should implement this shape. Methods are
 * async from day one so swapping a mock implementation for a real
 * Supabase query later is a body-only change — callers don't change.
 */
export interface Repository<TEntity, TId = string> {
  findAll(): Promise<TEntity[]>;
  findById(id: TId): Promise<TEntity | null>;
  create(input: Omit<TEntity, "id">): Promise<TEntity>;
  update(id: TId, patch: Partial<TEntity>): Promise<TEntity>;
  remove(id: TId): Promise<void>;
}

/** Simulates network latency so loading states can be built/tested honestly against mock data. */
export function simulateLatency<T>(value: T, ms = 250): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}
