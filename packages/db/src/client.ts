import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pendingMigrations, runMigrations } from './migrate';

/** Where the safety copy lands, given the live database path. */
export function backupPathFor(databasePath: string): string {
  return `${databasePath}.backup`;
}

/**
 * Snapshots the database to `backupPathFor(path)` before the schema changes.
 *
 * `VACUUM INTO` rather than copying the file: it is SQLite's own mechanism, it
 * takes a read lock so the snapshot is internally consistent even with this
 * connection open, and it writes a compacted database rather than a byte copy
 * that could catch a journal mid-write.
 *
 * One rolling backup, overwritten on each migration run, deliberately. The
 * useful thing to hold is the most recent state that a *completed* set of
 * migrations produced; keeping one file per migration id would mean carrying
 * several copies of a 62 MB archive for no added safety.
 *
 * VACUUM INTO refuses to overwrite, so any previous snapshot goes first. That
 * is the one moment where no backup exists, and it is unavoidable — but it
 * spans a file delete, not the migration itself.
 */
function backupBeforeMigrating(db: DatabaseSync, path: string): void {
  const target = backupPathFor(path);

  try {
    rmSync(target, { force: true });
    // Bound parameter, not interpolation — a userData path can contain quotes.
    db.prepare('VACUUM INTO ?').run(target);
  } catch (error: unknown) {
    throw new Error(
      `Could not back up the database to ${target} before migrating, so the ` +
        `migration was not attempted. Free some disk space or move ` +
        `${path} somewhere writable.`,
      { cause: error },
    );
  }
}

/**
 * Opens the catalogue and brings its schema up to date.
 *
 * If the schema is about to change and there is an existing file to lose, it is
 * snapshotted first. This matters more than it used to: the earthquake table
 * was a self-healing 30-day cache, so an unrecoverable migration cost nothing
 * but a refetch. The Tier 1 archive (M4.5+, 1970–present) is not refetchable in
 * any reasonable time, and a backup is the only thing that makes a bad
 * migration recoverable rather than merely detectable.
 *
 * A failed backup aborts the migration rather than proceeding without one —
 * for data this expensive to rebuild, refusing to start is the safer failure.
 */
export function openDatabase(path: string): DatabaseSync {
  // Must be asked *before* opening: the DatabaseSync constructor creates the
  // file, so checked afterwards this is true even for a brand-new database and
  // every first launch would snapshot an empty schema.
  const hasSomethingToLose = path !== ':memory:' && existsSync(path);

  const db = new DatabaseSync(path);

  if (hasSomethingToLose && pendingMigrations(db).length > 0) {
    backupBeforeMigrating(db, path);
  }

  runMigrations(db);
  return db;
}
