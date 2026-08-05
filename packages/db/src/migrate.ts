import type { DatabaseSync } from 'node:sqlite';
import { migrations as allMigrations, type Migration } from './migrations';

function ensureMigrationTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

/**
 * Which migrations this database has not yet had applied, in order.
 *
 * Split out from `runMigrations` so a caller can find out whether the schema is
 * about to change *before* it changes — `openDatabase` uses this to decide
 * whether a backup is warranted.
 */
export function pendingMigrations(
  db: DatabaseSync,
  candidates: Migration[] = allMigrations,
): Migration[] {
  ensureMigrationTable(db);

  const appliedIds = new Set(
    db
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((row) => row['id'] as number),
  );

  return candidates.filter((migration) => !appliedIds.has(migration.id));
}

/**
 * Applies every pending migration. Returns the ones that ran.
 *
 * **Each migration and its bookkeeping row commit together or not at all.**
 * These used to be two unprotected statements: the SQL ran, and then the
 * `schema_migrations` insert ran. A crash or a throw in between left a schema
 * that had been partly changed with no record of it, so the next launch would
 * re-run the same migration against a database already halfway through it.
 * That was survivable only because migration 2 opens with `DROP TABLE IF
 * EXISTS` and is therefore accidentally re-runnable. A migration that preserves
 * data cannot be written that way, so the guarantee has to come from the runner.
 *
 * SQLite does DDL inside transactions — including creating and dropping R-Tree
 * virtual tables, which is worth stating because it is not true of every
 * database and the whole rebuild pattern in `migrations.ts` depends on it.
 * `migrate.test.ts` proves it rather than trusting it.
 *
 * `candidates` is injectable so tests can drive the runner with fixtures
 * instead of the real migration list.
 */
export function runMigrations(
  db: DatabaseSync,
  candidates: Migration[] = allMigrations,
): Migration[] {
  const pending = pendingMigrations(db, candidates);

  for (const migration of pending) {
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(
        migration.id,
        migration.name,
      );
      db.exec('COMMIT');
    } catch (error: unknown) {
      db.exec('ROLLBACK');
      throw new Error(
        `Migration ${String(migration.id)} (${migration.name}) failed and was rolled back; ` +
          `the database is still at migration ${String(migration.id - 1)}.`,
        { cause: error },
      );
    }
  }

  return pending;
}
