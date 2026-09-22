import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('index.html');

function functionBody(name) {
  const match = html.match(new RegExp(`const ${name} = async \\([^)]*\\) => \\{([\\s\\S]*?)\\n            \\};`));
  assert.ok(match, name);
  return match[1];
}

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

test('all app-data callers use the transport and the classic script loads before Babel', () => {
  assert.match(html, /<script src="frontend\/lims-hearings\.js"><\/script>\s*<script src="frontend\/api-client\.js"><\/script>\s*<script type="text\/babel">/);
  assert.doesNotMatch(html, /fetch\(['"]\/api\/app-data['"]/);
  assert.equal((html.match(/window\.DCPCAFrontend\.appDataRequest\(/g) || []).length, 28);
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
