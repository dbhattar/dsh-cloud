// Runs inside a throwaway container (node:24 has node:sqlite). Two commands:
//   backup <db>   consistent online copy (SQLite backup API, safe while the service writes) to stdout
//   check <db>    integrity_check plus the row count of every table, as one JSON line
import { DatabaseSync, backup } from 'node:sqlite';
import { readFileSync, rmSync } from 'node:fs';

const [cmd, file] = process.argv.slice(1);
if (cmd === 'backup') {
  const tmp = '/tmp/backup.db';
  const src = new DatabaseSync(file);
  await backup(src, tmp);
  src.close();
  process.stdout.write(readFileSync(tmp));
  rmSync(tmp);
} else if (cmd === 'check') {
  const db = new DatabaseSync(file, { readOnly: true });
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  const tables = Object.fromEntries(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(({ name }) => [name, Number(db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n)]),
  );
  console.log(JSON.stringify({ integrity, tables }));
} else {
  console.error('usage: backup <db> | check <db>');
  process.exit(2);
}
