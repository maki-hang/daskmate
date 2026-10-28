const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Database } = require('./database.cjs');

const defaults = () => ({ version: 1, settings: { agent: 'codex', skins: {}, alwaysOnTop: true, launchAtLogin: false, petQuotaDisplay: 'always' }, notes: [], reminders: [], repositories: [], skins: [] });
class Store {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'assistant.sqlite');
    this.recovered = false;
    if (!fs.existsSync(this.file) && fs.existsSync(this.file + '.bak')) this.restoreDatabase();
    try { this.database = new Database(directory); }
    catch (error) {
      // Only recover actual corruption. Locks, permissions and future schemas
      // must never cause a valid database to be replaced with an older copy.
      if (![11, 26].includes(error.errcode) && error.message !== 'SQLite integrity check failed') throw error;
      this.restoreDatabase(error);
      this.database = new Database(directory);
    }
    try {
      this.database.transaction(() => {
        if (this.database.initialized()) return;
        let legacy = defaults();
        const file = path.join(directory, 'assistant.json');
        if (fs.existsSync(file) || fs.existsSync(file + '.bak')) {
          try { legacy = this.read(file); }
          catch (error) {
            if (!fs.existsSync(file + '.bak')) throw new Error('旧版数据无法读取，迁移已取消；原文件保持不变。', { cause: error });
            legacy = this.read(file + '.bak'); this.recovered = true;
          }
        }
        this.upgradeAgenda(legacy);
        this.database.write({}, legacy);
        // Import every archive, including repositories removed from the panel.
        // Any invalid archive aborts the entire import, making retries safe.
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (!entry.isFile() || !/^git-.+\.json$/.test(entry.name)) continue;
          const records = JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8'));
          const id = entry.name.slice(4, -5), count = this.database.putCommits(id, records);
          if (count !== new Set(records.map(record => record.hash)).size) throw new Error('Git 提交迁移校验失败');
          const repo = legacy.repositories.find(row => row.id === id);
          if (repo) {
            repo.count = count;
            this.database.db.prepare('UPDATE repositories SET count = ? WHERE id = ?').run(count, id);
          }
        }
        const imported = this.database.load();
        for (const key of ['notes', 'reminders', 'repositories', 'skins']) if (imported[key].length !== legacy[key].length) throw new Error('数据库迁移校验失败');
        this.database.markInitialized();
      });
      this.state = this.database.load();
      this.database.backup();
    } catch (error) { this.database.close(); throw error; }
  }
  restoreDatabase(error) {
    const backup = this.file + '.bak';
    if (!fs.existsSync(backup)) throw new Error('本地数据库损坏，请保留数据目录并从备份恢复。', { cause: error });
    const candidate = new DatabaseSync(backup, { readOnly: true });
    try {
      if (candidate.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || candidate.prepare('PRAGMA user_version').get().user_version !== 1 || !candidate.prepare("SELECT 1 FROM metadata WHERE key='initialized'").get()) throw new Error('数据库备份无效，请保留数据目录。');
    } finally { candidate.close(); }
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.damaged-' + Date.now());
    fs.copyFileSync(backup, this.file);
    this.recovered = true;
  }
  upgradeAgenda(state) {
    if (state.agendaVersion !== 2) {
      const s = state;
      for (const note of s.notes) note.time ||= '00:00:00';
      for (const reminder of s.reminders) {
        if (reminder.noteId && s.notes.some(n => n.id === reminder.noteId)) continue;
        const d = new Date(reminder.dueAt), id = randomUUID();
        s.notes.push({ id, date: localDate(d), time: localTime(d), content: reminder.title, createdAt: reminder.createdAt, updatedAt: reminder.createdAt || d.toISOString() });
        reminder.noteId = id;
      }
      s.agendaVersion = 2;
    }
  }
  read(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1 || !['notes', 'reminders', 'repositories', 'skins'].every(k => Array.isArray(data[k]))) throw new Error('数据格式无效');
    return { ...defaults(), ...data, settings: { ...defaults().settings, ...data.settings } };
  }
  update(fn) {
    let next;
    const result = this.database.transaction(() => {
      const previous = this.database.load();
      next = structuredClone(previous);
      const value = fn(next);
      if (value && typeof value.then === 'function') throw new Error('Store.update requires a synchronous callback');
      this.database.write(previous, next);
      return value;
    });
    this.state = next;
    return result;
  }
  saveCommits(repoId, records, identity) {
    let next;
    const updated = this.database.transaction(() => {
      const previous = this.database.load(); next = structuredClone(previous);
      const repo = next.repositories.find(row => row.id === repoId);
      if (!repo) return false; // Repository may have been removed during Git I/O.
      const count = this.database.putCommits(repoId, records);
      Object.assign(repo, { count, identity, syncedAt: new Date().toISOString(), error: null });
      this.database.write(previous, next);
      return true;
    });
    this.state = next;
    return updated;
  }
  close() {
    if (this.closed) return;
    try { this.database.backup(); }
    finally { this.database.close(); this.closed = true; }
  }
}
function text(value, max = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('请输入有效内容（最多 ' + max + ' 字符）');
  return value.trim();
}
function dateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('日期无效');
  return value;
}
function saveNote(store, input) {
  const date = dateKey(input.date), content = text(input.content);
  return store.update(s => {
    let note = input.id && s.notes.find(x => x.id === input.id);
    if (input.id && !note) throw new Error('便签已不存在');
    if (!note) { note = { id: randomUUID(), createdAt: new Date().toISOString() }; s.notes.push(note); }
    Object.assign(note, { date, content, updatedAt: new Date().toISOString() });
    return note;
  });
}
const localDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const localTime = d => [d.getHours(),d.getMinutes(),d.getSeconds()].map(v=>String(v).padStart(2,'0')).join(':');
function saveAgenda(store, input) {
  const date = dateKey(input.date), content = text(input.content), time = input.time;
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) throw new Error('invalidTime');
  const due = new Date(date + 'T' + time);
  if (!Number.isFinite(due.getTime()) || localDate(due) !== date || localTime(due) !== time) throw new Error('invalidTime');
  if (!['none','daily','weekly'].includes(input.repeat || 'none')) throw new Error('invalidRepeat');
  return store.update(s => {
    let note = input.id && s.notes.find(n => n.id === input.id);
    if (input.id && !note) throw new Error('missingNote');
    if (!note) { note = { id: randomUUID(), createdAt: new Date().toISOString() }; s.notes.push(note); }
    let reminder = s.reminders.find(r => r.noteId === note.id);
    const rescheduled = note.date !== date || note.time !== time || reminder?.repeat !== (input.repeat || 'none');
    Object.assign(note, { date, time, content, updatedAt: new Date().toISOString() });
    if (!input.remind) s.reminders = s.reminders.filter(r => r.noteId !== note.id);
    else {
      if (!reminder) { reminder = { id: randomUUID(), noteId: note.id, createdAt: note.createdAt }; s.reminders.push(reminder); }
      reminder.title = content.slice(0,200);
      if (rescheduled || !reminder.dueAt) Object.assign(reminder, { dueAt: due.toISOString(), repeat: input.repeat || 'none', enabled: true, completed: false, unread: false, lastFiredAt: null });
    }
    return note;
  });
}
function saveReminder(store, input) {
  const title = text(input.title, 200);
  const due = new Date(input.dueAt);
  if (!Number.isFinite(due.getTime())) throw new Error('提醒时间无效');
  if (!['none', 'daily', 'weekly'].includes(input.repeat)) throw new Error('重复方式无效');
  return store.update(s => {
    let reminder = input.id && s.reminders.find(x => x.id === input.id);
    if (input.id && !reminder) throw new Error('提醒已不存在');
    if (!reminder) { reminder = { id: randomUUID(), createdAt: new Date().toISOString() }; s.reminders.push(reminder); }
    Object.assign(reminder, { title, dueAt: due.toISOString(), repeat: input.repeat, enabled: true, completed: false, unread: false, lastFiredAt: null });
    return reminder;
  });
}
module.exports = { Store, text, dateKey, saveNote, saveReminder, saveAgenda };
