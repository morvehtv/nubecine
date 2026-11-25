'use strict';
// Base de datos mínima en un archivo JSON (sin dependencias externas).
const fs = require('fs');
const path = require('path');

const EMPTY = () => ({
  users: [],        // {id, username, passHash, salt, admin, createdAt}
  sessions: {},     // token -> {userId, expires}
  titles: {},       // id -> película o serie
  files: {},        // fileId -> {root, path, size, kind}
  progress: {},     // userId -> {fileId: {t, d, titleId, at}}
  mylist: {},       // userId -> [titleId]
  settings: {},     // ajustes editables desde el panel (inviteCode, siteName)
  lastScan: null,
});

class DB {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = EMPTY();
    if (fs.existsSync(file)) {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    this.timer = null;
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }
  flush() {
    clearTimeout(this.timer);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = DB;
