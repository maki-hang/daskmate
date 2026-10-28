const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Business records have their own columns. JSON is only used for settings,
// nested artwork metadata, and unknown fields retained during legacy imports.
const collections = {
  notes: { date: 'TEXT', time: 'TEXT', content: 'TEXT', createdAt: 'TEXT', updatedAt: 'TEXT' },
  reminders: { noteId: 'TEXT', title: 'TEXT', dueAt: 'TEXT', repeat: 'TEXT', enabled: 'BOOLEAN', completed: 'BOOLEAN', unread: 'BOOLEAN', lastFiredAt: 'TEXT', createdAt: 'TEXT' },
  repositories: { path: 'TEXT', name: 'TEXT', count: 'INTEGER', syncedAt: 'TEXT', error: 'TEXT', identity: 'JSON' },
  skins: { name: 'TEXT', author: 'TEXT', source: 'TEXT', license: 'TEXT', directory: 'TEXT', states: 'JSON' }
};
const quote = name => '"' + name + '"';
function encodeRecord(record, columns) {
  const extra = Object.fromEntries(Object.entries(record).filter(([key, value]) => key !== 'id' && (!(key in columns) || value === null)));
  return Object.entries(columns).map(([key, type]) => {
    const value = record[key];
    return value == null ? null : type === 'JSON' ? JSON.stringify(value) : type === 'BOOLEAN' ? Number(Boolean(value)) : value;
  }).concat(JSON.stringify(extra));
}
function decodeRecord(row, columns) {
  const record = { ...JSON.parse(row.extra), id: row.id };
  for (const [key, type] of Object.entries(columns)) {
    if (row[key] !== null) record[key] = type === 'JSON' ? JSON.parse(row[key]) : type === 'BOOLEAN' ? Boolean(row[key]) : row[key];
  }
  return record;
}
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

class Database {
  constructor(directory) {
    this.file = path.join(directory, 'assistant.sqlite');
    this.db = new DatabaseSync(this.file);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
      if (this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite integrity check failed');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw new Error('数据库版本较新，请使用更新版本的 DeskMate。');
      if (version === 0) transaction(this.db, () => {
        this.db.exec(`
          CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE git_archives (repo_id TEXT PRIMARY KEY);
          CREATE TABLE commits (
            repo_id TEXT NOT NULL REFERENCES git_archives(repo_id), hash TEXT NOT NULL,
            date TEXT NOT NULL, timestamp INTEGER NOT NULL, author TEXT NOT NULL,
            email TEXT NOT NULL, email_key TEXT NOT NULL, message TEXT NOT NULL,
            subject TEXT NOT NULL, extra TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (repo_id, hash)
          );
          CREATE INDEX commits_date ON commits(timestamp DESC, repo_id, hash);
          CREATE INDEX commits_repo_date ON commits(repo_id, timestamp DESC, hash);
          CREATE INDEX commits_author_email ON commits(repo_id, email_key, timestamp DESC);
          CREATE INDEX commits_author_name ON commits(repo_id, author, timestamp DESC);
        `);
        for (const [table, columns] of Object.entries(collections)) {
          const fields = Object.entries(columns).map(([key, type]) => `${quote(key)} ${type === 'JSON' ? 'TEXT' : type === 'BOOLEAN' ? 'INTEGER' : type}`).join(', ');
          const foreignKey = table === 'reminders' ? ', FOREIGN KEY(noteId) REFERENCES notes(id) DEFERRABLE INITIALLY DEFERRED' : '';
          this.db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY NOT NULL, position INTEGER NOT NULL, ${fields}, extra TEXT NOT NULL${foreignKey})`);
        }
        this.db.exec('CREATE INDEX notes_date ON notes(date); CREATE INDEX reminders_due ON reminders(enabled, completed, dueAt); CREATE INDEX reminders_note ON reminders(noteId); PRAGMA user_version = 1;');
      });
      this.db.function('js_lower', { deterministic: true }, value => String(value || '').toLowerCase());
      this.upserts = {};
      for (const [table, columns] of Object.entries(collections)) {
        const fields = ['id', 'position', ...Object.keys(columns), 'extra'];
        this.upserts[table] = this.db.prepare(`INSERT INTO ${table} (${fields.map(quote)}) VALUES (${fields.map(() => '?')}) ON CONFLICT(id) DO UPDATE SET ${fields.slice(1).map(key => `${quote(key)}=excluded.${quote(key)}`).join(',')}`);
      }
    } catch (error) { this.db.close(); throw error; }
  }
  initialized() { return Boolean(this.db.prepare("SELECT 1 FROM metadata WHERE key = 'initialized'").get()); }
  transaction(fn) { return transaction(this.db, fn); }
  load() {
    const state = Object.fromEntries(this.db.prepare("SELECT key, value FROM metadata WHERE key <> 'initialized'").all().map(row => [row.key, JSON.parse(row.value)]));
    state.settings = Object.fromEntries(this.db.prepare('SELECT key, value FROM settings').all().map(row => [row.key, JSON.parse(row.value)]));
    for (const [table, columns] of Object.entries(collections)) state[table] = this.db.prepare(`SELECT * FROM ${table} ORDER BY position`).all().map(row => decodeRecord(row, columns));
    return state;
  }
  write(previous, next) {
    for (const table of ['settings', 'metadata']) {
      const select = state => table === 'settings' ? state.settings || {} : Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'settings' && !(key in collections)));
      const before = select(previous), after = select(next);
      const remove = this.db.prepare(`DELETE FROM ${table} WHERE key = ?`);
      const put = this.db.prepare(`INSERT INTO ${table} (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
      for (const key of Object.keys(before)) if (!(key in after)) remove.run(key);
      for (const [key, value] of Object.entries(after)) if (JSON.stringify(value) !== JSON.stringify(before[key])) put.run(key, JSON.stringify(value));
    }
    for (const [table, columns] of Object.entries(collections)) {
      const before = new Map((previous[table] || []).map((row, index) => [row.id, { row, index }]));
      const after = next[table];
      if (!Array.isArray(after) || new Set(after.map(row => row.id)).size !== after.length) throw new Error(`Invalid ${table} records`);
      const ids = new Set(after.map(row => row.id)), remove = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`);
      for (const id of before.keys()) if (!ids.has(id)) remove.run(id);
      after.forEach((row, index) => {
        if (typeof row.id !== 'string' || !row.id) throw new Error(`Invalid ${table} id`);
        const old = before.get(row.id);
        if (!old || old.index !== index || JSON.stringify(old.row) !== JSON.stringify(row)) this.upserts[table].run(row.id, index, ...encodeRecord(row, columns));
      });
    }
  }
  markInitialized() { this.db.prepare("INSERT INTO metadata VALUES ('initialized', 'true')").run(); }
  putCommits(repoId, records) {
    if (!Array.isArray(records)) throw new Error('Invalid Git archive');
    this.db.prepare('INSERT OR IGNORE INTO git_archives VALUES (?)').run(repoId);
    const put = this.db.prepare(`INSERT INTO commits (repo_id,hash,date,timestamp,author,email,email_key,message,subject,extra)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repo_id,hash) DO UPDATE SET date=excluded.date,timestamp=excluded.timestamp,
      author=excluded.author,email=excluded.email,email_key=excluded.email_key,message=excluded.message,subject=excluded.subject,extra=excluded.extra
      WHERE commits.date <> excluded.date OR commits.author <> excluded.author OR commits.email <> excluded.email
        OR commits.message <> excluded.message OR commits.subject <> excluded.subject OR commits.extra <> excluded.extra`);
    for (const row of records) {
      if (!row || typeof row.hash !== 'string' || !/^[a-f0-9]{40,64}$/.test(row.hash) || !Number.isFinite(Date.parse(row.date)) || !['date','author','email','message','subject'].every(key => typeof row[key] === 'string')) throw new Error('Invalid Git commit record');
      const extra = Object.fromEntries(Object.entries(row).filter(([key]) => !['hash','date','author','email','message','subject'].includes(key)));
      put.run(repoId, row.hash, row.date, Date.parse(row.date), row.author, row.email, row.email.toLowerCase(), row.message, row.subject, JSON.stringify(extra));
    }
    return this.db.prepare('SELECT count(*) AS count FROM commits WHERE repo_id = ?').get(repoId).count;
  }
  records(repoId) {
    return this.db.prepare('SELECT * FROM commits WHERE repo_id = ? ORDER BY timestamp DESC, hash').all(repoId).map(row => this.commit(row));
  }
  commit(row) {
    return { ...JSON.parse(row.extra), hash: row.hash, date: row.date, author: row.author, email: row.email, message: row.message, subject: row.subject };
  }
  queryCommits({ repoId = '', query = '', date = '', page = 0, mineOnly = true } = {}) {
    const where = [], params = [], term = String(query).toLowerCase().slice(0, 300);
    if (repoId) { where.push('c.repo_id = ?'); params.push(repoId); }
    if (mineOnly) where.push(`((coalesce(json_extract(r.identity,'$.email'),'') <> '' AND c.email_key = js_lower(json_extract(r.identity,'$.email')))
      OR (coalesce(json_extract(r.identity,'$.email'),'') = '' AND coalesce(json_extract(r.identity,'$.name'),'') <> '' AND c.author = json_extract(r.identity,'$.name')))`);
    if (date) {
      const start = new Date(`${date}T00:00:00`), end = new Date(start); end.setDate(end.getDate() + 1);
      if (!Number.isFinite(+start) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}` !== date) return { total: 0, rows: [] };
      where.push('c.timestamp >= ? AND c.timestamp < ?'); params.push(+start, +end);
    }
    if (term) {
      where.push(`(${['c.message','c.author','c.email','c.hash','r.name'].map(field => `instr(js_lower(${field}), ?) > 0`).join(' OR ')})`);
      params.push(...Array(5).fill(term));
    }
    const from = `FROM commits c JOIN repositories r ON r.id = c.repo_id${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
    const total = this.db.prepare(`SELECT count(*) AS total ${from}`).get(...params).total;
    const number = Number(page), offset = Math.min(Number.MAX_SAFE_INTEGER - 40, Math.max(0, Math.floor(Number.isFinite(number) ? number : 0)) * 40);
    const rows = this.db.prepare(`SELECT c.*, r.name AS repository ${from} ORDER BY c.timestamp DESC, c.repo_id, c.hash LIMIT 40 OFFSET ?`).all(...params, offset);
    return { total, rows: rows.map(row => ({ ...this.commit(row), repoId: row.repo_id, repository: row.repository })) };
  }
  backup() {
    const temporary = this.file + '.bak.tmp';
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    this.db.prepare('VACUUM INTO ?').run(temporary);
    fs.renameSync(temporary, this.file + '.bak');
  }
  close() { this.db.close(); }
}
module.exports = { Database };
