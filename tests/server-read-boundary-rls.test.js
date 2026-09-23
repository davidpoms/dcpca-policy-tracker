import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const internalTables = [
  'tracked_items',
  'item_notes',
  'bill_status_history',
  'activity_log',
  'team_members',
  'tracked_keywords',
  'tracked_committees',
  'tracked_sponsors',
  'tracked_agencies'
];

const legacyPublicReadTables = internalTables.filter(table => table !== 'bill_status_history');
const canonical = read('rls-migration.sql');
const migration = read('migrations/2026-09-23-tighten-server-read-boundary-rls.sql');

test('canonical RLS keeps internal tracker tables enabled without anon or public read policies', () => {
  for (const table of internalTables) {
    assert.match(canonical, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`), table);
    assert.match(canonical, new RegExp(`DROP POLICY IF EXISTS "anon can read ${table}"\\s+ON ${table};`), table);
    assert.doesNotMatch(canonical, new RegExp(`CREATE POLICY\\s+"[^"]+"\\s+ON ${table}\\s+FOR SELECT\\s+TO (?:anon|public)`, 'i'), table);
  }

  for (const table of legacyPublicReadTables) {
    assert.match(canonical, new RegExp(`DROP POLICY IF EXISTS "Allow public read access" ON ${table};`), table);
  }
});

test('versioned migration removes every evidenced read policy and creates no replacement', () => {
  assert.match(migration, /BEGIN;[\s\S]*COMMIT;/);
  for (const table of internalTables) {
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`), table);
    assert.match(migration, new RegExp(`DROP POLICY IF EXISTS "anon can read ${table}" ON ${table};`), table);
  }
  for (const table of legacyPublicReadTables) {
    assert.match(migration, new RegExp(`DROP POLICY IF EXISTS "Allow public read access" ON ${table};`), table);
  }
  assert.doesNotMatch(migration, /CREATE POLICY/i);
  assert.doesNotMatch(migration, /\b(?:GRANT|REVOKE)\b/i);
  assert.doesNotMatch(migration, /FOR\s+(?:INSERT|UPDATE|DELETE)|DISABLE ROW LEVEL SECURITY/i);
});

test('lims cache remains the sole canonical anonymous browser read policy', () => {
  assert.match(canonical, /ALTER TABLE lims_bill_cache ENABLE ROW LEVEL SECURITY;/);
  assert.match(canonical, /CREATE POLICY "anon can read lims_bill_cache" ON lims_bill_cache FOR SELECT TO anon USING \(true\);/);
  assert.doesNotMatch(migration, /lims_bill_cache/);

  const anonSelects = [...canonical.matchAll(/CREATE POLICY\s+"([^"]+)"\s+ON\s+(\w+)\s+FOR SELECT\s+TO\s+(anon|public)/gi)]
    .map(([, name, table, role]) => ({ name, table, role: role.toLowerCase() }));
  assert.deepEqual(anonSelects, [{
    name: 'anon can read lims_bill_cache',
    table: 'lims_bill_cache',
    role: 'anon'
  }]);
});

test('write restrictions and server-only table access remain closed', () => {
  for (const table of internalTables) {
    assert.doesNotMatch(canonical, new RegExp(`CREATE POLICY\\s+"[^"]+"\\s+ON ${table}\\s+FOR (?:INSERT|UPDATE|DELETE)`, 'i'), table);
  }

  for (const table of ['keyword_alert_log', 'lims_cache_cursor']) {
    assert.match(canonical, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`));
    assert.doesNotMatch(canonical, new RegExp(`CREATE POLICY\\s+"[^"]+"\\s+ON ${table}`, 'i'));
    assert.doesNotMatch(migration, new RegExp(`\\b${table}\\b`));
  }

  const allSql = [canonical, migration, ...fs.readdirSync(path.join(root, 'migrations'))
    .filter(file => file.endsWith('.sql') && file !== '2026-09-23-tighten-server-read-boundary-rls.sql')
    .map(file => read(path.join('migrations', file)))].join('\n');
  assert.doesNotMatch(allSql, /\b(?:GRANT|REVOKE)\b[\s\S]*?\b(?:anon|public)\b/i);
});

test('server read actions remain in app-data and browser reads remain limited to lims cache', () => {
  const appData = read('api/app-data.js');
  const frontend = read('frontend/app.jsx');
  for (const action of ['app.bootstrap.read', 'activityLog.list', 'teamMembers.list']) {
    assert.ok(appData.includes(`'${action}'`), action);
  }
  assert.match(appData, /SUPABASE_SERVICE_KEY/);
  assert.match(appData, /validateSignedSession/);

  const directTables = [...frontend.matchAll(/supabase\s*\.from\('([^']+)'\)/g)].map(match => match[1]);
  assert.deepEqual(directTables, ['lims_bill_cache', 'lims_bill_cache', 'lims_bill_cache']);
  assert.equal(fs.readdirSync(path.join(root, 'api')).filter(file => file.endsWith('.js')).length, 12);
});
