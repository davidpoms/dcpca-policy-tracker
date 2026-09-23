import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('frontend/app.jsx');
const page = read('index.html');

function functionBody(name) {
  const match = html.match(new RegExp(`const ${name} = async \\([^)]*\\) => \\{([\\s\\S]*?)\\n            \\};`));
  assert.ok(match, name);
  return match[1];
}

test('page shell loads one external Babel entry after CDN and classic scripts', () => {
  const sources = [...page.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)].map(match => match[1]);
  assert.deepEqual(sources, [
    'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
    'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
    'https://unpkg.com/@babel/standalone@7.23.10/babel.min.js',
    'https://cdn.tailwindcss.com/3.4.1',
    'frontend/lims-normalization.js',
    'frontend/lims-activity.js',
    'frontend/lims-hearings.js',
    'frontend/api-client.js',
    'frontend/app.jsx'
  ]);
  assert.match(page, /<script type="text\/babel" src="frontend\/app\.jsx"><\/script>/);
  assert.doesNotMatch(page, /<script type="text\/babel">/);
  assert.equal((page.match(/type="text\/babel"/g) || []).length, 1);
  assert.doesNotMatch(page, /function App\(|function DCPolicyTracker\(/);
  assert.match(html, /function App\(\)/);
  assert.match(html, /function DCPolicyTracker\(\{ onLogout \}\)/);
  assert.match(html, /const root = ReactDOM\.createRoot\(document\.getElementById\('root'\)\);\s*root\.render\(<App \/>\);/);
});

test('app-data transport sends the exact JSON POST and returns the raw response', async () => {
  const payload = { action: 'trackedItem.activity.markSeen', itemId: 'B26/123', value: null };
  const response = { ok: false, status: 500, json() { throw new Error('must not parse'); } };
  const calls = [];
  const context = {
    window: { DCPCAFrontend: { existingHelper: true } },
    fetch: (url, options) => { calls.push({ url, options }); return Promise.resolve(response); },
    console: { error() { throw new Error('must not log'); } }
  };
  vm.runInNewContext(read('frontend/api-client.js'), context);
  assert.equal(context.window.DCPCAFrontend.existingHelper, true);
  assert.equal(await context.window.DCPCAFrontend.appDataRequest(payload), response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/app-data');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].options)), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin', body: JSON.stringify(payload)
  });
});

test('LIMS proxy preserves its POST envelope, defaults, and JSON response handling', async () => {
  const calls = [];
  const values = [{ rows: [1] }, { result: true }];
  const context = {
    window: {},
    fetch: (url, options) => {
      calls.push({ url, options });
      return Promise.resolve({ ok: false, json: async () => values.shift() });
    },
    console: { error() { throw new Error('unexpected log'); } }
  };
  vm.runInNewContext(read('frontend/api-client.js'), context);
  assert.deepEqual(JSON.parse(JSON.stringify(await context.window.DCPCAFrontend.proxyFetch('/CouncilPeriods'))), { rows: [1] });
  assert.deepEqual(JSON.parse(JSON.stringify(await context.window.DCPCAFrontend.proxyFetch('/SearchLegislation', 'POST', { Keyword: 'housing' }))), { result: true });
  assert.deepEqual(calls.map(({ url, options }) => ({ url, options: JSON.parse(JSON.stringify(options)) })), [
    { url: '/api/hello', options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: '/CouncilPeriods', method: 'GET', body: null }) } },
    { url: '/api/hello', options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: '/SearchLegislation', method: 'POST', body: { Keyword: 'housing' } }) } }
  ]);
  assert.equal(Object.hasOwn(calls[0].options, 'credentials'), false);
});

test('LIMS proxy logs and rethrows data.error, JSON errors, and fetch errors', async () => {
  const logs = [];
  let outcome = { json: async () => ({ error: 'LIMS failed' }) };
  const context = {
    window: {},
    fetch: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    console: { error: (...args) => logs.push(args) }
  };
  vm.runInNewContext(read('frontend/api-client.js'), context);
  await assert.rejects(context.window.DCPCAFrontend.proxyFetch('/CouncilPeriods'), /LIMS failed/);
  assert.equal(logs[0][0], 'Proxy fetch error:');
  assert.equal(logs[0][1].message, 'LIMS failed');

  const parseError = new Error('invalid JSON');
  outcome = { json: async () => { throw parseError; } };
  await assert.rejects(context.window.DCPCAFrontend.proxyFetch('/CouncilPeriods'), error => error === parseError);
  assert.equal(logs[1][1], parseError);

  const fetchError = new Error('offline');
  outcome = fetchError;
  await assert.rejects(context.window.DCPCAFrontend.proxyFetch('/CouncilPeriods'), error => error === fetchError);
  assert.equal(logs[2][1], fetchError);
});

test('all LIMS proxy callers retain their own failure and continuation behavior', () => {
  assert.doesNotMatch(html, /fetch\(['"]\/api\/hello['"]|fetch\(PROXY_URL|const proxyFetch\s*=|const PROXY_URL\s*=/);
  assert.equal((html.match(/window\.DCPCAFrontend\.proxyFetch\(/g) || []).length, 4);

  const councilPeriods = functionBody('loadCouncilPeriods');
  assert.match(councilPeriods, /window\.DCPCAFrontend\.proxyFetch\('\/CouncilPeriods'\)/);
  assert.match(councilPeriods, /setCouncilPeriods\(data\)/);
  assert.match(councilPeriods, /setError\('Failed to load council periods: ' \+ err\.message\)/);

  const details = functionBody('fetchLegislationDetails');
  assert.match(details, /return await window\.DCPCAFrontend\.proxyFetch\(`\/LegislationDetails\/\$\{legislationNumber\}`, 'GET'\)/);
  assert.doesNotMatch(details, /catch\s*\(/);
  assert.match(functionBody('checkHearingsForTrackedItems'), /const details = await fetchLegislationDetails\(id\)/);
  assert.match(functionBody('checkHearingForItem'), /const details = await fetchLegislationDetails\(itemId\)/);

  const refresh = functionBody('refreshData');
  assert.match(refresh, /for \(const keyword of trackedKeywords\)/);
  assert.match(refresh, /window\.DCPCAFrontend\.proxyFetch\('\/SearchLegislation', 'POST'/);
  assert.match(refresh, /catch \(err\) \{ console\.error\(`Error searching for "\$\{keyword\}":`, err\); allResults\.push\(\[\]\); \}/);
  assert.match(refresh, /await delay\(1000\)/);

  const quick = functionBody('quickSearchByCategory');
  assert.match(quick, /window\.DCPCAFrontend\.proxyFetch\('\/SearchLegislation', 'POST'/);
  assert.match(quick, /setError\('Failed to search: ' \+ err\.message\)/);
  assert.match(page, /<script src="frontend\/api-client\.js"><\/script>\s*<script type="text\/babel" src="frontend\/app\.jsx"><\/script>/);
});

test('all app-data callers use the transport and the classic script loads before Babel', () => {
  assert.match(page, /<script src="frontend\/lims-hearings\.js"><\/script>\s*<script src="frontend\/api-client\.js"><\/script>\s*<script type="text\/babel" src="frontend\/app\.jsx"><\/script>/);
  assert.doesNotMatch(html, /fetch\(['"]\/api\/app-data['"]/);
  assert.equal((html.match(/window\.DCPCAFrontend\.appDataRequest\(/g) || []).length, 33);
  for (const name of [
    'checkHearingsForTrackedItems', 'checkHearingForItem', 'toggleSelection',
    'updateAssignment', 'updatePriority', 'updateActionStatus', 'updateItemActivity',
    'markActivityAsSeen', 'saveNote', 'deleteNote', 'saveSummary', 'deleteManualSummary',
    'addKeyword', 'removeKeyword', 'addCommittee', 'removeCommittee',
    'addSponsor', 'removeSponsor', 'addAgency', 'removeAgency',
    'addManualEntry', 'updateManualEntry', 'deleteManualEntry',
    'addTeamMember', 'updateTeamMember', 'deleteTeamMember'
  ]) {
    assert.match(functionBody(name), /window\.DCPCAFrontend\.appDataRequest\(/, name);
  }
});

test('special response and state handling remains with each caller', () => {
  const batch = functionBody('checkHearingsForTrackedItems');
  assert.match(batch, /newHearingData\[id\] = \{ \.\.\.hearing, checkedAt: now \};[\s\S]*?appDataRequest/);
  assert.match(batch, /if \(!response\.ok\) throw new Error\('Failed to persist hearing'\);[\s\S]*?setItems/);
  assert.match(batch, /setHearingCheckProgress\(/);
  assert.match(batch, /setTimeout\(r, 1500\)/);
  assert.match(batch, /if \(!response\.ok\) console\.error\('Error logging activity:', response\.status\)/);
  assert.doesNotMatch(batch, /response\.json\(\)/);

  const single = functionBody('checkHearingForItem');
  assert.match(single, /setHearingData\([\s\S]*?setItems\([\s\S]*?appDataRequest/);
  assert.match(single, /if \(!response\.ok\) throw new Error\('Failed to persist hearing'\)/);
  assert.doesNotMatch(single, /response\.json\(\)/);

  const detected = functionBody('updateItemActivity');
  assert.match(detected, /if \(!response\.ok\) throw new Error\('Failed to update item activity'\)/);
  assert.match(detected, /catch \(err\) \{ console\.error\('Error updating item activity:', err\); \}/);
  assert.doesNotMatch(detected, /response\.json\(\)/);

  const actionStatus = functionBody('updateActionStatus');
  assert.match(actionStatus, /const data = await response\.json\(\);[\s\S]*?response\.ok \|\| data\?\.trackedItemUpdated === true/);
  assert.match(actionStatus, /setItems\([\s\S]*?if \(!response\.ok\) throw new Error\(data\?\.error \|\| 'Failed to update action status'\)/);

  for (const name of ['updateAssignment', 'saveNote', 'addManualEntry', 'addTeamMember']) {
    const body = functionBody(name);
    assert.match(body, /const data = await response\.json\(\)/, name);
    assert.match(body, /if \(!response\.ok\)/, name);
    assert.match(body, /setError\('Failed to /, name);
  }
});
