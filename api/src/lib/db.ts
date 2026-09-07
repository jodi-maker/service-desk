import postgres from 'postgres';
import { env } from './env.js';

// Neon Postgres connection (migration to Neon — Step 1).
//
// This is the new raw-SQL data-access path. Use it via tagged templates:
//   const sql = getDb();
//   const rows = await sql`select id, name from workspaces where id = ${id}`;
// postgres.js parameterises ${...} values automatically — they are NOT string
// interpolation, so this is safe against SQL injection. Never build SQL by
// concatenating strings; always interpolate values through the tag.
//
// Lazy + memoised: importing this module never opens a connection. The
// connection is created on first use and reused after that. DATABASE_URL is
// required at boot (env.ts), but getDb() still guards it for a clear error.
let _sql: ReturnType<typeof postgres> | null = null;

export function getDb() {
  if (!env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set — the Neon connection is unavailable. ' +
        'Add it to api/.env (see api/.env.example) using your Neon connection string.',
    );
  }
  if (!_sql) {
    _sql = postgres(env.DATABASE_URL, {
      // Neon requires TLS (the prod URL carries sslmode=require). A local /
      // CI Postgres has no TLS, so honour an explicit sslmode=disable in the
      // connection string and skip it there — used by the DB-backed tests.
      ssl: env.DATABASE_URL.includes('sslmode=disable') ? false : 'require',
      // Keep the pool small — the API runs as short-lived serverless
      // functions on Vercel (target stack), so a large pool is wasteful.
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      // Disable prepared statements: Neon's pooled (PgBouncer, transaction
      // mode) connection string does not support them. Safe for the direct
      // connection too.
      prepare: false,
      types: {
        // DATE is a calendar value, not a timestamp. Preserve YYYY-MM-DD for
        // OOO comparisons, date inputs and holiday arrays. Leave timestamp
        // OIDs 1114/1184 on the driver's default Date parser.
        calendarDate: {
          to: 1082,
          from: [1082],
          serialize: (value: string) => value,
          // postgres.js passes unquoted NULL array elements to custom parsers.
          parse: (value: string) => value === 'NULL' ? null : value,
        },
      },
    });
  }
  return _sql;
}
