/**
 * `T` with every property whose type includes `null` turned optional (and `null` excluded from
 * its type), and every other property left exactly as it was. This is `omitNulls`'s return type,
 * chosen so its output is structurally assignable to a domain type like `Translation` with no
 * cast at the call site: a mapper that builds `{ approvedAt: row.approved_at }`, where
 * `row.approved_at` is typed `string | null`, types as `{ approvedAt?: string }` here — matching
 * an optional field on the domain model — while a mapper that drops or misspells a required field
 * fails to typecheck against that model, because the missing/misspelled key is still required
 * here too.
 */
type OmitNulls<T> = { [K in keyof T as null extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as null extends T[K] ? K : never]?: Exclude<T[K], null>;
};

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
 * The internal cast below is unavoidable — TypeScript cannot verify that a runtime loop over
 * `Object.entries` produces the shape `OmitNulls<T>` describes — but that cast is the only one
 * that should exist anywhere near this helper. A call site should never need `as SomeDomainType`:
 * if it does, `OmitNulls<T>` and the target type have drifted apart, which is exactly the mistake
 * this type exists to catch at compile time instead of silently at runtime.
 */
export function omitNulls<T extends Record<string, unknown>>(obj: T): OmitNulls<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null) result[key] = value;
  }
  return result as OmitNulls<T>;
}
