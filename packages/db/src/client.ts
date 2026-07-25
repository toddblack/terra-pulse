import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './migrate';

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  runMigrations(db);
  return db;
}
