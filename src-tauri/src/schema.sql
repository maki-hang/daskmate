CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE git_archives (repo_id TEXT PRIMARY KEY);
CREATE TABLE commits (
  repo_id TEXT NOT NULL REFERENCES git_archives(repo_id), hash TEXT NOT NULL,
  date TEXT NOT NULL, timestamp INTEGER NOT NULL, author TEXT NOT NULL,
  email TEXT NOT NULL, email_key TEXT NOT NULL, message TEXT NOT NULL,
  subject TEXT NOT NULL, extra TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(repo_id,hash)
);
CREATE INDEX commits_date ON commits(timestamp DESC,repo_id,hash);
CREATE INDEX commits_repo_date ON commits(repo_id,timestamp DESC,hash);
CREATE INDEX commits_author_email ON commits(repo_id,email_key,timestamp DESC);
CREATE INDEX commits_author_name ON commits(repo_id,author,timestamp DESC);
CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL,position INTEGER NOT NULL,date TEXT,time TEXT,content TEXT,createdAt TEXT,updatedAt TEXT,extra TEXT NOT NULL);
CREATE TABLE reminders (id TEXT PRIMARY KEY NOT NULL,position INTEGER NOT NULL,noteId TEXT,title TEXT,dueAt TEXT,repeat TEXT,enabled INTEGER,completed INTEGER,unread INTEGER,lastFiredAt TEXT,createdAt TEXT,extra TEXT NOT NULL,FOREIGN KEY(noteId) REFERENCES notes(id) DEFERRABLE INITIALLY DEFERRED);
CREATE INDEX notes_date ON notes(date);
CREATE INDEX reminders_due ON reminders(enabled,completed,dueAt);
CREATE INDEX reminders_note ON reminders(noteId);
CREATE TABLE repositories (id TEXT PRIMARY KEY NOT NULL,position INTEGER NOT NULL,path TEXT,name TEXT,count INTEGER,syncedAt TEXT,error TEXT,identity TEXT,extra TEXT NOT NULL);
CREATE TABLE skins (id TEXT PRIMARY KEY NOT NULL,position INTEGER NOT NULL,name TEXT,author TEXT,source TEXT,license TEXT,directory TEXT,states TEXT,extra TEXT NOT NULL);
PRAGMA user_version=1;
