const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { Store, saveAgenda } = require('../src/core/store.cjs');
const { GitIndex } = require('../src/core/git.cjs');
const { collectDue } = require('../src/core/reminders.cjs');
const { dataDirectory } = require('../src/core/data-directory.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deskmate-sqlite-'));
  const stores = [];
  t.after(async () => { for (const store of stores) if (!store.closed) store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, open: () => { const store = new Store(directory); stores.push(store); return store; } };
}
const commit = (number, changes = {}) => ({ hash: number.toString(16).padStart(40, '0'), date: '2026-10-28T01:00:00+08:00', author: '作者 Ä', email: 'Ä@Example.invalid', message: '内容 100% _ hello\n多行 🐉', subject: '内容 100% _ hello', ...changes });
const legacy = () => ({ version: 1, agendaVersion: 2, settings: { agent: 'claude', language: 'ja', skins: { claude: 'custom' }, position: { x: -10, y: 50 } }, notes: [{ id: 'note', date: '2026-10-28', time: '01:02:03', content: '便签 🐉', futureField: { value: 3 } }], reminders: [{ id: 'reminder', noteId: 'note', title: '提醒', dueAt: '2026-10-28T01:02:03+08:00', repeat: 'weekly', enabled: false, completed: false, unread: true, lastFiredAt: null }], repositories: [{ id: 'repo', path: 'C:/offline repo', name: '离线仓库', count: 99, identity: { email: 'ä@example.invalid', name: '作者 Ä' } }], skins: [{ id: 'custom', name: '自定义', directory: 'C:/skins/custom', states: { idle: 'idle.webp' }, license: 'test' }], customTopLevel: { keep: true } });

test('legacy JSON imports once with exact values, archives and bindings; original bytes stay untouched', async t => {
  const { directory, open } = await fixture(t), data = legacy();
  const originals = { 'assistant.json': JSON.stringify(data, null, 2), 'assistant.json.bak': 'original backup bytes', 'git-repo.json': JSON.stringify([commit(1), commit(1), commit(2)]), 'git-removed.json': JSON.stringify([commit(3)]) };
  for (const [file, bytes] of Object.entries(originals)) await fs.writeFile(path.join(directory, file), bytes);
  const store = open();
  for (const key of ['notes', 'reminders', 'skins', 'customTopLevel']) assert.deepEqual(store.state[key], data[key]);
  assert.deepEqual(store.state.settings.skins, data.settings.skins);
  assert.deepEqual(store.state.settings.position, data.settings.position);
  assert.equal(store.state.repositories[0].count, 2);
  const index = new GitIndex(store);
  assert.equal((await index.query()).total, 2);
  assert.equal(store.database.records('removed').length, 1, 'removed repository archives survive');
  for (const [file, bytes] of Object.entries(originals)) assert.equal(await fs.readFile(path.join(directory, file), 'utf8'), bytes);
  assert.equal((await fs.readFile(store.file)).subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.equal(store.database.db.prepare('SELECT content FROM notes').get().content, data.notes[0].content);
  assert.equal(store.database.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  store.update(s => { s.notes[0].content = '数据库新内容'; }); store.close();
  await fs.writeFile(path.join(directory, 'assistant.json'), '{broken legacy');
  await fs.writeFile(path.join(directory, 'git-repo.json'), '{broken archive');
  const restarted = open();
  assert.equal(restarted.state.notes[0].content, '数据库新内容');
  assert.equal((await new GitIndex(restarted).query()).total, 2);
});

test('a damaged legacy file uses its backup without overwriting either original', async t => {
  const { directory, open } = await fixture(t), backup = JSON.stringify(legacy());
  await fs.writeFile(path.join(directory, 'assistant.json'), '{bad');
  await fs.writeFile(path.join(directory, 'assistant.json.bak'), backup);
  const store = open(); assert.equal(store.recovered, true); assert.equal(store.state.notes.length, 1);
  assert.equal(await fs.readFile(path.join(directory, 'assistant.json'), 'utf8'), '{bad');
  assert.equal(await fs.readFile(path.join(directory, 'assistant.json.bak'), 'utf8'), backup);
});

test('an invalid Git archive rolls back the entire import and can be retried after repair', async t => {
  const { directory, open } = await fixture(t);
  await fs.writeFile(path.join(directory, 'assistant.json'), JSON.stringify(legacy()));
  await fs.writeFile(path.join(directory, 'git-a.json'), JSON.stringify([commit(1)]));
  await fs.writeFile(path.join(directory, 'git-z.json'), JSON.stringify([commit(2), { hash: 'bad' }]));
  assert.throws(open, /Invalid Git commit/);
  const database = new DatabaseSync(path.join(directory, 'assistant.sqlite'));
  assert.equal(database.prepare('SELECT count(*) AS n FROM notes').get().n, 0);
  assert.equal(database.prepare('SELECT count(*) AS n FROM commits').get().n, 0);
  assert.equal(database.prepare("SELECT count(*) AS n FROM metadata WHERE key='initialized'").get().n, 0); database.close();
  await fs.writeFile(path.join(directory, 'git-z.json'), JSON.stringify([commit(2)]));
  const store = open(); assert.equal(store.state.notes.length, 1);
  assert.equal(store.database.db.prepare('SELECT count(*) AS n FROM commits').get().n, 2);
});

test('state and Git updates are atomic, and separate connections do not overwrite newer state', async t => {
  const { open } = await fixture(t), first = open(), second = open();
  first.update(s => { s.settings.language = 'en'; });
  second.update(s => { s.settings.agent = 'claude'; });
  assert.equal(second.state.settings.language, 'en');
  const note = saveAgenda(first, { date: '2026-10-28', time: '01:02:03', content: 'atomic', remind: true, repeat: 'none' });
  assert.equal(first.state.settings.agent, 'claude');
  const before = structuredClone(first.state);
  assert.throws(() => first.update(s => { s.notes = []; s.settings.language = 'ja'; s.reminders.push({ id: null }); }), /Invalid reminders id/);
  assert.deepEqual(first.state, before);
  assert.deepEqual(open().state, before, 'failed SQL changes are rolled back along with in-memory state');
  assert.throws(() => first.update(s => { s.notes = []; throw new Error('abort'); }), /abort/);
  assert.throws(() => first.update(s => { s.notes = []; }), /FOREIGN KEY constraint failed/);
  assert.deepEqual(first.state, before, 'linked reminders cannot be orphaned');
  first.update(s => { s.repositories.push({ id: 'repo', name: 'test', path: 'offline', count: 0 }); });
  assert.throws(() => first.saveCommits('repo', [commit(1), { hash: 'bad' }], {}), /Invalid Git commit/);
  assert.equal(first.database.records('repo').length, 0);
  assert.equal(first.state.repositories[0].count, 0);
  assert.equal(first.state.notes[0].id, note.id);
});

test('SQL Git queries preserve Unicode, literal search, local dates, author filters and stable pagination', async t => {
  const { open } = await fixture(t), store = open();
  store.update(s => { s.repositories.push({ id: 'repo', name: '仓库 Ä', path: 'offline' }, { id: 'other', name: 'name fallback', path: 'offline' }); });
  store.saveCommits('repo', Array.from({ length: 45 }, (_, i) => commit(i + 1)), { email: 'ä@EXAMPLE.invalid', name: 'other' });
  store.saveCommits('other', [commit(99)], { email: '', name: '作者 Ä' });
  const index = new GitIndex(store), first = await index.query(), second = await index.query({ page: 1 });
  assert.equal(first.total, 46); assert.equal(first.rows.length, 40); assert.equal(second.rows.length, 6);
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row.repoId + row.hash)).size, 46);
  for (const query of ['ä', '内容', '100%', '_', "hello\n多行"]) assert.equal((await index.query({ query })).total, 46);
  assert.equal((await index.query({ query: "' OR 1=1 --" })).total, 0);
  assert.equal((await index.query({ query: '仓库', repoId: 'repo' })).total, 45);
  const local = new Date(commit(1).date), date = `${local.getFullYear()}-${String(local.getMonth()+1).padStart(2,'0')}-${String(local.getDate()).padStart(2,'0')}`;
  assert.equal((await index.query({ date })).total, 46);
  assert.equal((await index.query({ date: '2026-02-30' })).total, 0);
  store.saveCommits('repo', [], {});
  assert.equal((await index.query()).total, 1); assert.equal((await index.query({ mineOnly: false })).total, 46);
  store.update(s => { s.repositories = s.repositories.filter(row => row.id !== 'repo'); });
  assert.equal((await index.query({ mineOnly: false })).total, 1);
  assert.equal(store.database.records('repo').length, 45, 'removal hides history without destroying the archive');
  store.update(s => { s.repositories.push({ id: 'repo', name: 'restored', path: 'offline' }); });
  assert.equal((await index.query({ mineOnly: false })).total, 46);
});

test('committed reminders survive abrupt process termination and are never fired twice', async t => {
  const { directory, open } = await fixture(t), store = open();
  saveAgenda(store, { date: '2026-10-01', time: '00:00:00', content: 'crash-safe', remind: true, repeat: 'none' }); store.close();
  const modulePath = path.resolve(__dirname, '../src/core/store.cjs'), remindersPath = path.resolve(__dirname, '../src/core/reminders.cjs');
  execFileSync(process.execPath, ['-e', `const {Store}=require(${JSON.stringify(modulePath)}); const {collectDue}=require(${JSON.stringify(remindersPath)}); const store=new Store(${JSON.stringify(directory)}); if(collectDue(store,new Date('2026-10-28')).length!==1)process.exit(2);process.exit(0);`], { windowsHide: true });
  const restarted = open(); assert.equal(collectDue(restarted, new Date('2026-10-28')).length, 0);
  assert.equal(restarted.state.reminders[0].unread, true); assert.equal(restarted.state.reminders[0].completed, true);
});

test('future database schemas are rejected without restoring an older backup', async t => {
  const { open } = await fixture(t), store = open(); store.close();
  const database = new DatabaseSync(store.file); database.exec('PRAGMA user_version=999'); database.close();
  assert.throws(open, /数据库版本较新/);
  const check = new DatabaseSync(store.file); assert.equal(check.prepare('PRAGMA user_version').get().user_version, 999); check.close();
});

test('a missing primary database recovers its snapshot instead of overwriting it with an empty store', async t => {
  const { directory, open } = await fixture(t), store = open();
  saveAgenda(store, { date: '2026-10-28', time: '01:02:03', content: 'only in SQLite', remind: true, repeat: 'daily' }); store.close();
  await fs.unlink(store.file);
  await fs.writeFile(path.join(directory, 'assistant.json'), JSON.stringify(legacy()));
  const restored = open(); assert.equal(restored.recovered, true);
  assert.equal(restored.state.notes.length, 1); assert.equal(restored.state.notes[0].content, 'only in SQLite');
  assert.equal(restored.state.reminders[0].repeat, 'daily');
});

test('a damaged database without a valid snapshot never falls back to stale legacy JSON', async t => {
  const { directory, open } = await fixture(t), store = open(); store.close();
  await fs.unlink(store.file + '.bak');
  await fs.writeFile(store.file, 'damaged database');
  await fs.writeFile(path.join(directory, 'assistant.json'), JSON.stringify(legacy()));
  assert.throws(open, /本地数据库损坏/);
  assert.equal(await fs.readFile(store.file, 'utf8'), 'damaged database');
});

test('directory selection recognizes SQLite data after the rename and in the statusline bridge', async t => {
  const { directory } = await fixture(t), current = path.join(directory, 'DeskMate'), old = path.join(directory, 'Longling PC Assistant');
  await fs.mkdir(old); await fs.writeFile(path.join(old, 'assistant.sqlite'), 'exists');
  assert.equal(dataDirectory(directory, {}), old);
  await fs.rename(path.join(old, 'assistant.sqlite'), path.join(old, 'assistant.sqlite.bak'));
  assert.equal(dataDirectory(directory, {}), old);
  await fs.mkdir(current); await fs.writeFile(path.join(current, 'assistant.sqlite'), 'exists');
  assert.equal(dataDirectory(directory, {}), current);
});
