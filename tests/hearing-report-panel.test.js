import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'frontend/app.jsx'), 'utf8').replace(/\r\n/g, '\n');
const componentMatch = app.match(/function HearingReportPanel\(\{([^}]+)\}\) \{([\s\S]*?)\n        \}\n\n        function ActivityLogModal/);

test('HearingReportPanel is a presentation component with exactly five props', () => {
  assert.ok(componentMatch);
  assert.deepEqual(componentMatch[1].split(',').map(prop => prop.trim()), [
    'hearingData', 'itemsWithUpcomingHearings', 'checkingHearings', 'onRecheck', 'onClose'
  ]);
  assert.doesNotMatch(componentMatch[2], /\b(useState|useEffect|fetch|supabase|appDataRequest|proxyFetch)\b/);
  assert.doesNotMatch(componentMatch[2], /setShowHearingPanel|checkHearingsForTrackedItems/);
});

test('DCPolicyTracker gates and wires the hearing panel with its original state and handlers', () => {
  assert.match(app, /const \[hearingData, setHearingData\] = useState\(\{\}\)/);
  assert.match(app, /const \[checkingHearings, setCheckingHearings\] = useState\(false\)/);
  assert.match(app, /const itemsWithUpcomingHearings = items[\s\S]*?\.sort\(\(a, b\) => a\.hearing\.date - b\.hearing\.date\)/);
  assert.match(app, /\{showHearingPanel && \(\s*<HearingReportPanel\s+hearingData=\{hearingData\}\s+itemsWithUpcomingHearings=\{itemsWithUpcomingHearings\}\s+checkingHearings=\{checkingHearings\}\s+onRecheck=\{checkHearingsForTrackedItems\}\s+onClose=\{\(\) => setShowHearingPanel\(false\)\}\s*\/>\s*\)\}/);
  assert.equal((app.match(/<HearingReportPanel\b/g) || []).length, 1);
});

test('hearing counts, cards, errors, empty state, and controls retain their expressions', () => {
  const panel = componentMatch[2];
  assert.match(panel, /Object\.keys\(hearingData\)\.length/);
  assert.match(panel, /Object\.values\(hearingData\)\.filter\(h => h\.date && !h\.isPast\)\.length/);
  assert.match(panel, /Object\.values\(hearingData\)\.filter\(h => !h\.date\)\.length/);
  assert.match(panel, /itemsWithUpcomingHearings\.map\(\(\{ item, hearing \}\) => \(/);
  assert.match(panel, /hearing\.dateStr/);
  assert.match(panel, /hearing\.timeStr && hearing\.timeStr !== '12:00 AM'/);
  assert.match(panel, /hearing\.type &&/);
  assert.match(panel, /hearing\.location &&/);
  assert.match(panel, /No upcoming hearings found for your tracked bills\./);
  assert.match(panel, /Object\.entries\(hearingData\)\.filter\(\(\[, h\]\) => h\.error\)\.length > 0/);
  assert.match(panel, /Object\.entries\(hearingData\)\.filter\(\(\[, h\]\) => h\.error\)\.map\(\(\[id, h\]\) => \(/);
  assert.match(panel, /<strong>\{id\}:<\/strong> \{h\.error\}/);
  assert.match(panel, /onClick=\{onRecheck\} disabled=\{checkingHearings\}/);
  assert.match(panel, /checkingHearings \? 'Checking…' : '🔄 Re-check All'/);
  assert.equal((panel.match(/onClick=\{onClose\}/g) || []).length, 2);
});
