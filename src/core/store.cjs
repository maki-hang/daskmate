const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const defaults = () => ({ version: 1, settings: { agent: 'codex', skins: {}, alwaysOnTop: true, launchAtLogin: false, petQuotaDisplay: 'always' }, notes: [], reminders: [], repositories: [], skins: [] });
class Store {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'assistant.json');
    this.recovered = false;
    this.state = defaults();
    if (fs.existsSync(this.file)) {
      try { this.state = this.read(this.file); }
      catch (error) {
        if (!fs.existsSync(this.file + '.bak')) throw new Error('本地数据无法读取，请保留数据目录并从备份恢复。');
        this.state = this.read(this.file + '.bak'); this.recovered = true;
        fs.copyFileSync(this.file, this.file + '.damaged-' + Date.now());
        fs.copyFileSync(this.file + '.bak', this.file);
      }
    }
    if (this.state.agendaVersion !== 2) this.update(s => {
      for (const note of s.notes) note.time ||= '00:00:00';
      for (const reminder of s.reminders) {
        if (reminder.noteId && s.notes.some(n => n.id === reminder.noteId)) continue;
        const d = new Date(reminder.dueAt), id = randomUUID();
        s.notes.push({ id, date: localDate(d), time: localTime(d), content: reminder.title, createdAt: reminder.createdAt, updatedAt: reminder.createdAt || d.toISOString() });
        reminder.noteId = id;
      }
      s.agendaVersion = 2;
    });
  }
  read(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version !== 1 || !['notes', 'reminders', 'repositories', 'skins'].every(k => Array.isArray(data[k]))) throw new Error('数据格式无效');
    return { ...defaults(), ...data, settings: { ...defaults().settings, ...data.settings } };
  }
  update(fn) {
    const next = structuredClone(this.state);
    const result = fn(next);
    const temp = this.file + '.tmp';
    const fd = fs.openSync(temp, 'w');
    try { fs.writeFileSync(fd, JSON.stringify(next, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
    fs.renameSync(temp, this.file);
    this.state = next;
    return result;
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
