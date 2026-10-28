/**
 * Reading more rows than one PostgREST response returns (Supabase caps
 * each response, 1000 rows by default).
 *
 * Keyset paging on the primary key: each page asks for rows with
 * id > the last id already read, ordered by id. Unlike offset paging on
 * a sort key that can change (e.g. updated_at), a row edited or added
 * between two page requests can never make an existing row be skipped
 * or read twice. Reading stops only on an EMPTY page, so a server cap
 * smaller than the requested page size can never truncate the result.
 *
 * Pure module (no server-only import) so it can be tested in isolation.
 */

export const KEYSET_PAGE_SIZE = 1000;

export async function readAllByKeyset<T extends { id: string }>(
  page: (afterId: string | null, limit: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize: number = KEYSET_PAGE_SIZE
): Promise<T[]> {
  const rows: T[] = [];
  let afterId: string | null = null;
  for (;;) {
    const { data, error } = await page(afterId, pageSize);
    if (error) throw error;
    const batch = data ?? [];
    if (batch.length === 0) return rows;
    for (const row of batch) {
      // ids must strictly increase (lowercase UUID text sorts like the
      // database's uuid order); anything else would risk an endless loop.
      if (afterId !== null && !(row.id > afterId)) {
        throw new Error("Keyset page returned rows out of order.");
      }
      rows.push(row);
      afterId = row.id;
    }
  }
}

/**
 * Microseconds since the epoch for a PostgREST timestamptz string
 * ("2026-09-28T14:42:59.07212+00:00"). Postgres trims trailing zeros of
 * the fraction, so plain string comparison is not reliable.
 */
function timestampMicros(value: string): number {
  const ms = Date.parse(value);
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? "";
  return ms * 1000 + Number((fraction + "000000").slice(3, 6));
}

/** Most recently changed first; id breaks ties so the order is always the same. */
export function newestFirst<T extends { id: string; updated_at: string }>(a: T, b: T): number {
  const diff = timestampMicros(b.updated_at) - timestampMicros(a.updated_at);
  if (diff !== 0) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
