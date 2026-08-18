import { describe, expect, it } from 'vitest';
import { openDatabase } from './client';
import { readDonkiApiKey, saveDonkiApiKey } from './app-state';

describe('DONKI API key storage', () => {
  it('reads null before anything has been saved', () => {
    const db = openDatabase(':memory:');
    expect(readDonkiApiKey(db)).toBeNull();
  });

  it('round-trips a saved key', () => {
    const db = openDatabase(':memory:');
    saveDonkiApiKey(db, 'personal-key-123');
    expect(readDonkiApiKey(db)).toBe('personal-key-123');
  });

  it('trims surrounding whitespace before storing', () => {
    const db = openDatabase(':memory:');
    saveDonkiApiKey(db, '  personal-key-123  ');
    expect(readDonkiApiKey(db)).toBe('personal-key-123');
  });

  it('rejects an empty key rather than saving a blank string', () => {
    const db = openDatabase(':memory:');
    expect(() => saveDonkiApiKey(db, '')).toThrow();
    expect(() => saveDonkiApiKey(db, '   ')).toThrow();
    expect(readDonkiApiKey(db)).toBeNull();
  });

  it('a later save overwrites an earlier one', () => {
    const db = openDatabase(':memory:');
    saveDonkiApiKey(db, 'first-key');
    saveDonkiApiKey(db, 'second-key');
    expect(readDonkiApiKey(db)).toBe('second-key');
  });
});
