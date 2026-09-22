import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const app = read('frontend/app.jsx');
const start = app.indexOf('function formatActivityLogTimestamp(value)');
const end = app.indexOf('function ActivityLogModal(', start);
assert.ok(start >= 0 && end > start);
const context = { Date, isNaN };
vm.runInNewContext(`${app.slice(start, end)}\nglobalThis.formatTimestamp = formatActivityLogTimestamp;`, context);
const format = context.formatTimestamp;
const eastern = iso => new Date(iso).toLocaleString(undefined, { timeZone: 'America/New_York' });

test('legacy UTC wall-clock and offset-bearing instants display in New York time', () => {
  const expected = eastern('2026-09-22T03:47:51.051Z');
  assert.equal(format('2026-09-22 03:47:51.051775'), expected);
  assert.equal(format('2026-09-22T03:47:51.051Z'), expected);
  assert.equal(format('2026-09-22T05:47:51.051+02:00'), expected);
  assert.equal(format('2026-09-21T23:47:51.051-04:00'), expected);
});

test('New York daylight-saving transitions use the correct offset for each instant', () => {
  assert.equal(format('2026-03-08 06:30:00'), eastern('2026-03-08T06:30:00Z'));
  assert.equal(format('2026-03-08 07:30:00'), eastern('2026-03-08T07:30:00Z'));
  assert.equal(format('2026-11-01 05:30:00'), eastern('2026-11-01T05:30:00Z'));
  assert.equal(format('2026-11-01 06:30:00'), eastern('2026-11-01T06:30:00Z'));
});

test('missing and invalid activity timestamps render empty text', () => {
  for (const value of [null, undefined, '', '  ', 'not-a-date', '2026-99-99 03:47:51']) {
    assert.equal(format(value), '');
  }
});

test('canonical activity_log schema changes only created_at type and retains its default', () => {
  const schema = read('migration.sql');
  const table = schema.match(/create table if not exists public\.activity_log \(([\s\S]*?)\n\);/i);
  assert.ok(table);
  assert.deepEqual(table[1].trim().split(/,\s*\n/).map(column => column.trim()), [
    'id serial primary key', 'action text not null', 'item_id text',
    'item_title text', 'details jsonb', 'created_at timestamptz default now()'
  ]);
});

test('server activity inserts continue to rely on the database timestamp default', () => {
  const api = read('api/app-data.js');
  const insert = api.match(/async function logActivityEvent\([^)]*\) \{([\s\S]*?)\n\}/);
  assert.ok(insert);
  assert.match(insert[1], /supabaseTableRequest\(url, serviceKey, 'activity_log', 'POST', \{[\s\S]*?action,[\s\S]*?item_id: itemId,[\s\S]*?item_title: itemTitle,[\s\S]*?details/);
  assert.doesNotMatch(insert[1], /created_at/);
  assert.doesNotMatch(read('api/check-hearings.js'), /(?:sbInsert|supabaseTableRequest)\('activity_log'/);
});

test('versioned migration converts UTC wall-clock values once without touching RLS', () => {
  const sql = read('migrations/2026-09-22-activity-log-created-at-timestamptz.sql');
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/);
  assert.match(sql, /IF current_type = 'timestamp without time zone' THEN[\s\S]*ALTER TABLE public\.activity_log\s+ALTER COLUMN created_at TYPE timestamptz\s+USING created_at AT TIME ZONE 'UTC';/);
  assert.match(sql, /ELSIF current_type IS DISTINCT FROM 'timestamp with time zone' THEN/);
  assert.match(sql, /ALTER COLUMN created_at DROP DEFAULT/);
  assert.match(sql, /ALTER COLUMN created_at SET DEFAULT now\(\)/);
  assert.doesNotMatch(sql, /\b(?:POLICY|ROW LEVEL SECURITY|GRANT|REVOKE)\b/i);
  assert.doesNotMatch(sql, /ALTER COLUMN (?!created_at\b)/i);
});
