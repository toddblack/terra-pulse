import type { DatabaseSync } from 'node:sqlite';
import { migrations } from './migrations';

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const appliedIds = new Set(
    db
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((row) => row['id'] as number),
  );

  for (const migration of migrations) {
    if (appliedIds.has(migration.id)) continue;
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(
      migration.id,
      migration.name,
    );
  }
}
