import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'frontend/app.jsx'), 'utf8').replace(/\r\n/g, '\n');
const componentMatch = app.match(/function ActivityLogModal\(\{([^}]+)\}\) \{([\s\S]*?)\n        \}\n\n        function DCPolicyTracker/);

test('ActivityLogModal is presentational and accepts only activityLog and onClose', () => {
  assert.ok(componentMatch);
  assert.deepEqual(componentMatch[1].split(',').map(prop => prop.trim()), ['activityLog', 'onClose']);
  assert.doesNotMatch(componentMatch[2], /\b(useState|useEffect|fetch|supabase|appDataRequest|proxyFetch|loadActivityLog)\b/);
  assert.doesNotMatch(componentMatch[2], /setShowActivityLog/);
});

test('DCPolicyTracker keeps activity state, load timing, and the modal condition', () => {
  assert.match(app, /const \[activityLog, setActivityLog\] = useState\(\[\]\)/);
  assert.match(app, /const loadActivityLog = async \(\) => \{[\s\S]*?appDataRequest\(\{ action: 'activityLog\.list' \}\)[\s\S]*?setActivityLog\(data\.activityLog \|\| \[\]\)/);
  assert.doesNotMatch(app, /\.from\('activity_log'\)\.select/);
  assert.match(app, /onClick=\{\(\) => \{ setShowActivityLog\(true\); loadActivityLog\(\); \}\}/);
  assert.match(app, /\{showActivityLog && \(\s*<ActivityLogModal\s+activityLog=\{activityLog\}\s+onClose=\{\(\) => setShowActivityLog\(false\)\}\s*\/>\s*\)\}/);
  assert.equal((app.match(/<ActivityLogModal\b/g) || []).length, 1);
});

test('ActivityLogModal retains ordered display fields, details, timestamp, empty text, and close', () => {
  const modal = componentMatch[2];
  assert.match(modal, /activityLog\.map\(log => \(/);
  assert.doesNotMatch(modal, /activityLog\.(?:sort|reverse)\(/);
  assert.match(modal, /key=\{log\.id\}/);
  assert.match(modal, /log\.action\.replace\(\/_\/g, ' '\)\.toUpperCase\(\)/);
  assert.match(modal, /log\.item_title &&[\s\S]*?\{log\.item_title\}/);
  assert.match(modal, /log\.details && Object\.keys\(log\.details\)\.length > 0[\s\S]*?JSON\.stringify\(log\.details\)/);
  assert.match(modal, /formatActivityLogTimestamp\(log\.created_at\)/);
  assert.match(modal, /activityLog\.length === 0 &&[\s\S]*?No activity recorded yet/);
  assert.match(modal, /className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50"/);
  assert.match(modal, /onClick=\{onClose\}/);
});
