import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const normalization = fs.readFileSync(path.join(root, 'frontend/lims-normalization.js'), 'utf8');
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/lims-characterization.json'), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [fixtures.fixedNow])); }
  static now() { return new Date(fixtures.fixedNow).getTime(); }
}

function browserHelpers() {
  const isNewStart = html.indexOf('const isNewItem = (dateString) =>');
  const isNewEnd = html.indexOf('const quickSearchByCategory =', isNewStart);
  assert.ok(isNewStart >= 0 && isNewEnd > isNewStart);
  const context = { Date: FixedDate, window: {} };
  vm.runInNewContext(`${normalization}\n${html.slice(isNewStart, isNewEnd)}\n` +
    'globalThis.helpers = { ...window.DCPCAFrontend, isNewItem };', context);
  return context.helpers;
}

test('browser member normalization retains arrays, strings, nulls and empty-array fallback', () => {
  const { parseMembers, transformLimsSearchItem, isNewItem } = browserHelpers();
  assert.equal(parseMembers([{ memberName: 'One' }, { memberName: 'Two' }]), 'One, Two');
  assert.equal(parseMembers(['One', 'Two']), 'One, Two');
  assert.equal(parseMembers('One; Two'), 'One; Two');
  assert.equal(parseMembers(null), null);
  assert.equal(parseMembers(undefined), null);
  assert.equal(parseMembers([]), '');
  const item = transformLimsSearchItem({ legislationNumber: 'B26-1', title: 'Bill',
    introducers: [], primarySponsor: 'Fallback', coIntroducers: null }, isNewItem);
  assert.equal(item.introducedBy, 'Fallback');
  assert.equal(item.coIntroducers, null);
});

test('one search transformer preserves exact display shape, committees and future HN date', () => {
  const { transformLimsSearchItem, normalizeCommittees, isNewItem } = browserHelpers();
  const hn = { ...fixtures.details.hn26_0162, title: 'Notice',
    referredToCommittees: '["Committee A","Committee B"]',
    introducers: [{ memberName: 'Member One' }], coIntroducers: 'Member Two' };
  assert.deepEqual(plain(transformLimsSearchItem(hn, isNewItem)), {
    id: 'HN26-0162', title: 'Notice', billNumber: 'HN26-0162',
    category: 'Oversight Hearing/Roundtable Notice', status: 'Unknown',
    committees: ['Committee A', 'Committee B'], date: '2027-01-15',
    description: 'Notice', link: 'https://lims.dccouncil.gov/Legislation/HN26-0162',
    source: 'DC Council', isNew: true, assignedTo: null, priority: null,
    actionStatus: 'action_needed', introducedBy: 'Member One', coIntroducers: 'Member Two'
  });
  assert.deepEqual(plain(normalizeCommittees(['A', 'B'])), ['A', 'B']);
  assert.deepEqual(plain(normalizeCommittees('A; B')), ['A', 'B']);
  assert.deepEqual(plain(normalizeCommittees(null)), []);
});

test('both browser searches and hearing checks use shared local helpers without changing flows', () => {
  const refresh = html.match(/const refreshData = async \(\) => \{([\s\S]*?)\n            \};/);
  const quick = html.match(/const quickSearchByCategory = async \([^)]*\) => \{([\s\S]*?)\n            \};/);
  assert.ok(refresh);
  assert.ok(quick);
  for (const block of [refresh[1], quick[1]]) {
    assert.match(block, /window\.DCPCAFrontend\.transformLimsSearchItem\(leg, isNewItem\)/);
    assert.doesNotMatch(block, /const parseMembers =/);
  }
  assert.match(refresh[1], /setItems\(\[\.\.\.existingTrackedItems, \.\.\.mergedItems\]\)/);
  assert.match(refresh[1], /setHasMoreResults\(false\)/);
  assert.match(quick[1], /filteredByCategory = categoryName !== 'all'/);
  assert.match(quick[1], /if \(append\)/);
  for (const name of ['checkHearingsForTrackedItems', 'checkHearingForItem']) {
    const block = html.match(new RegExp(`const ${name} = async \\([^)]*\\) => \\{([\\s\\S]*?)\\n            \\};`));
    assert.ok(block, name);
    assert.match(block[1], /window\.DCPCAFrontend\.parseMembers\(details\.introducers\)/);
    assert.match(block[1], /window\.DCPCAFrontend\.parseMembers\(details\.coIntroducers\)/);
    assert.doesNotMatch(block[1], /const parseMembers =/);
  }
  assert.match(html, /<script src="frontend\/lims-normalization\.js"><\/script>\s*<script src="frontend\/lims-activity\.js"><\/script>\s*<script src="frontend\/lims-hearings\.js"><\/script>\s*<script type="text\/babel">/);
  for (const name of ['normalizeCommittees', 'parseMembers', 'transformLimsSearchItem']) {
    assert.doesNotMatch(html, new RegExp(`const ${name} =`));
    assert.equal((normalization.match(new RegExp(`const ${name} =`, 'g')) || []).length, 1);
  }
  assert.doesNotMatch(html, /normalizeCommittees\.transformLimsSearchItem/);
});
