import { DatabaseSync } from 'node:sqlite';

/** Execute one or more SQL statements against a SQLite database using Node 22 built-in `node:sqlite`. */
export function execSqlite(dbPath, sql) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/** Query rows from a SQLite database and return plain JS objects (equivalent to `sqlite3 -json`). */
export function querySqliteJson(dbPath, sql) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(sql).all().map(row => ({ ...row }));
  } finally {
    db.close();
  }
}

/** Execute a SQL statement or SELECT query and return trimmed CLI-like output (`|` separated columns per row). */
export function sqliteSync(dbPath, sql) {
  const db = new DatabaseSync(dbPath);
  try {
    const trimmed = sql.trim();
    if (/^(?:SELECT|PRAGMA|WITH)\b/i.test(trimmed) && !trimmed.includes(';')) {
      const rows = db.prepare(trimmed).all();
      return rows.map(row => Object.values(row).map(v => (v === null || v === undefined ? '' : String(v))).join('|')).join('\n').trim();
    }
    if (/^(?:SELECT|PRAGMA|WITH)\b/i.test(trimmed)) {
      const stmtText = trimmed.replace(/;+\s*$/, '');
      if (!stmtText.includes(';')) {
        const rows = db.prepare(stmtText).all();
        return rows.map(row => Object.values(row).map(v => (v === null || v === undefined ? '' : String(v))).join('|')).join('\n').trim();
      }
    }
    db.exec(sql);
    return '';
  } finally {
    db.close();
  }
}
