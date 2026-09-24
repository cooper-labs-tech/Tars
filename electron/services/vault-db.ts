import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { VAULT_DB_FILE, VAULT_DIR } from '../constants';

let db: Database.Database | null = null;

export function getVaultDb(): Database.Database {
  if (!db) {
    throw new Error('Vault database not initialized. Call initVaultDb() first.');
  }
  return db;
}

export function initVaultDb(): void {
  // Ensure directories exist
  const dbDir = path.dirname(VAULT_DB_FILE);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  if (!fs.existsSync(VAULT_DIR)) {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
  }
  const attachmentsDir = path.join(VAULT_DIR, 'attachments');
  if (!fs.existsSync(attachmentsDir)) {
    fs.mkdirSync(attachmentsDir, { recursive: true });
  }

  db = new Database(VAULT_DB_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      author TEXT NOT NULL,
      agent_id TEXT,
      tags TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Create FTS table if not exists
  const ftsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='documents_fts'"
  ).get();

  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE documents_fts USING fts5(
        title, content, tags,
        content='documents', content_rowid='rowid'
      );

      -- Populate FTS from existing documents
      INSERT INTO documents_fts(rowid, title, content, tags)
        SELECT rowid, title, content, tags FROM documents;
    `);
  }

  // Create triggers for FTS sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      INSERT INTO documents_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
    END;
  `);

  console.log('Vault database initialized at', VAULT_DB_FILE);
}

// documents_fts is a bare fts5 table: MATCH reads the raw query as fts5 syntax,
// where `/ % - ' ( )` and AND/OR/NOT are operators, and real titles hold them
// ("Q1/Q2", "100%", a name with an apostrophe), which threw a 500. The query is
// tried as-is first, so intended fts5 syntax still works, and only on a parse
// failure again as one quoted literal phrase.
export function ftsSearch(db: Database.Database, query: string, limit: number): unknown[] {
  const sql = `
    SELECT d.*, snippet(documents_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
    FROM documents_fts fts
    JOIN documents d ON d.rowid = fts.rowid
    WHERE documents_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `;
  try {
    return db.prepare(sql).all(query, limit);
  } catch (err) {
    // Retried only for fts5's own syntax rejection (a SqliteError such as
    // "fts5: syntax error near ..." or "no such column: x" for "-x"): anything
    // else (a locked file, corruption) propagates, rather than reading as an
    // empty result.
    if (!(err instanceof Database.SqliteError)) {
      throw err;
    }
    const literal = '"' + query.replace(/"/g, '""') + '"';
    return db.prepare(sql).all(literal, limit);
  }
}

export function closeVaultDb(): void {
  if (db) {
    db.close();
    db = null;
    console.log('Vault database closed');
  }
}
