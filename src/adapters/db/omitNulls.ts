/**
 * Drops every key whose value is `null`, turning a nullable Postgres column into an absent
 * property rather than a `null` one.
 *
 * A `Pg*` store builds its row-shaped object with `null` standing in for "no value" (matching what
 * `pg`/PGlite hand back for a nullable column), then passes the whole thing through this once
 * instead of an `if (x !== null) obj.x = row.x` per optional field. This matters because the
 * `Json*` stores this migration replaces never wrote `null` for an absent optional field — a
 * property was simply missing from the object before `JSON.stringify` — and `db:export` (Task 16)
 * must reproduce those files byte for byte. Required (`not null`) columns are never affected: they
 * never hold `null` to begin with.
 *
 * The return type only strips `null` from each property's type, it does not make properties
 * optional — callers cast the result to the target domain type, which is where the optional-ness
 * actually lives.
 */
export function omitNulls<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]: Exclude<T[K], null> } {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null) result[key] = value;
  }
  return result as { [K in keyof T]: Exclude<T[K], null> };
}
