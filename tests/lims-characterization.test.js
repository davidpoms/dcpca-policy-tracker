import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const fixtures = JSON.parse(read('tests/fixtures/lims-characterization.json'));
const fixedNow = fixtures.fixedNow;
const plain = value => JSON.parse(JSON.stringify(value));
process.env.TZ = 'UTC'; // Node runs test files in separate workers; pin locale date decisions here.

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [fixedNow])); }
  static now() { return new Date(fixedNow).getTime(); }
}

function browser() {
  const html = read('frontend/app.jsx');
  const isNewStart = html.indexOf('const isNewItem = (dateString) =>');
  const isNewEnd = html.indexOf('const quickSearchByCategory =', isNewStart);
  assert.ok(isNewStart >= 0 && isNewEnd > isNewStart);
  const context = { Date: FixedDate, window: {} };
  vm.runInNewContext(read('frontend/lims-normalization.js'), context);
  vm.runInNewContext(read('frontend/lims-activity.js'), context);
  vm.runInNewContext(read('frontend/lims-hearings.js'), context);
  vm.runInNewContext(`${html.slice(isNewStart, isNewEnd)}\n` +
    'globalThis.parsers = { isNewItem, frontend: window.DCPCAFrontend };', context);
  context.parsers.extractNextHearing = context.window.DCPCAFrontend.extractNextHearing;
  context.parsers.extractLatestActivityDate = context.window.DCPCAFrontend.extractLatestActivityDate;
  context.parsers.extractActivityTimeline = context.window.DCPCAFrontend.extractActivityTimeline;
  return { parsers: context.parsers, html };
}

function browserSearchItem(leg) {
  const { parsers, html } = browser();
  const start = html.indexOf('const transformedItems = allLegislation.map(leg => {');
  const end = html.indexOf('const existingTrackedItems =', start);
  assert.ok(start >= 0 && end > start);
  const context = { Date: FixedDate, allLegislation: [leg],
    window: { DCPCAFrontend: parsers.frontend }, isNewItem: parsers.isNewItem };
  vm.runInNewContext(`${html.slice(start, end)}\nglobalThis.result = transformedItems[0];`, context);
  return plain(context.result);
}

function cronParsers() {
  const source = read('api/check-hearings.js')
    .replace("import nodemailer from 'nodemailer';", '')
    .replace('export default async function handler', 'async function handler');
  const context = { Date: FixedDate, process: { env: {} }, console: { log() {}, warn() {}, error() {} } };
  vm.runInNewContext(`${source}\nglobalThis.parsers = { extractNextHearing, extractLatestActivityDate };`, context);
  return context.parsers;
}

function hearingDate(value) { return value?.date?.toISOString() || null; }

test('browser LIMS helpers load before Babel and hearing checks use the extracted namespace', () => {
  const html = read('frontend/app.jsx');
  const page = read('index.html');
  const activity = read('frontend/lims-activity.js');
  const hearings = read('frontend/lims-hearings.js');
  assert.match(page, /<script src="frontend\/lims-normalization\.js"><\/script>\s*<script src="frontend\/lims-activity\.js"><\/script>\s*<script src="frontend\/lims-hearings\.js"><\/script>\s*<script src="frontend\/api-client\.js"><\/script>\s*<script type="text\/babel" src="frontend\/app\.jsx"><\/script>/);
  for (const name of ['extractLatestActivityDate', 'extractActivityTimeline']) {
    assert.match(activity, new RegExp(`function ${name}\\(details\\)`));
    assert.match(activity, new RegExp(`window\\.DCPCAFrontend\\.${name} = ${name};`));
    assert.doesNotMatch(html, new RegExp(`function ${name}\\(details\\)`));
  }
  assert.match(hearings, /function extractNextHearing\(details\)/);
  assert.match(hearings, /window\.DCPCAFrontend\.extractNextHearing = extractNextHearing;/);
  assert.doesNotMatch(html, /function extractNextHearing\(details\)/);
  for (const name of ['checkHearingsForTrackedItems', 'checkHearingForItem']) {
    const block = html.match(new RegExp(`const ${name} = async \\([^)]*\\) => \\{([\\s\\S]*?)\\n            \\};`));
    assert.ok(block, name);
    assert.match(block[1], /window\.DCPCAFrontend\.extractNextHearing\(details\)/);
    assert.match(block[1], /window\.DCPCAFrontend\.extractLatestActivityDate\(details\)/);
    assert.match(block[1], /window\.DCPCAFrontend\.extractActivityTimeline\(details\)/);
  }
});

test('HN26-0162 future introduction is activity, not a hearing', () => {
  const details = fixtures.details.hn26_0162;
  const b = browser().parsers;
  const c = cronParsers();
  assert.deepEqual([b.extractLatestActivityDate(details).dateIso, b.extractLatestActivityDate(details).label],
    ['2027-01-15T12:00:00.000Z', 'Introduced']);
  assert.deepEqual(plain(b.extractActivityTimeline(details)).map(e => [e.label, e.isFuture]), [['Introduced', true]]);
  assert.equal(hearingDate(b.extractNextHearing(details)), null);
  assert.deepEqual(plain(b.extractNextHearing(details)).allFuture, []);
  assert.deepEqual(plain(c.extractLatestActivityDate(details)),
    { dateIso: '2027-01-15T12:00:00.000Z', label: 'Introduced' });
  assert.equal(c.extractNextHearing(details), null);
  const item = browserSearchItem({ ...details, title: 'Notice', legislationNumber: 'HN26-0162' });
  assert.equal(item.category, 'Oversight Hearing/Roundtable Notice');
  assert.equal(item.date, '2027-01-15');
  assert.equal(item.isNew, true);
});

test('browser and cron hearing selection preserve future, past, markup and fallback differences', () => {
  const b = browser().parsers;
  const c = cronParsers();
  for (const [name, browserDate, cronDate] of [
    ['future_and_past', '2027-03-20T12:00:00.000Z', '2027-03-20T12:00:00.000Z'],
    ['past_only', '2025-06-01T12:00:00.000Z', null],
    ['markup_divergence', '2027-04-10T12:00:00.000Z', '2027-06-20T12:00:00.000Z'],
    ['flat_fallback', '2027-05-11T12:00:00.000Z', null],
    ['history_fallback', '2027-05-12T12:00:00.000Z', null]
  ]) {
    const details = fixtures.details[name];
    assert.equal(hearingDate(b.extractNextHearing(details)), browserDate, `browser ${name}`);
    assert.equal(hearingDate(c.extractNextHearing(details)), cronDate, `cron ${name}`);
  }
  assert.equal(b.extractNextHearing(fixtures.details.past_only).isPast, true);
  assert.equal(b.extractNextHearing(fixtures.details.future_and_past).isPast, false);
  assert.equal(b.extractNextHearing(fixtures.details.markup_divergence).type, 'Markup Type');
  assert.equal(c.extractNextHearing(fixtures.details.markup_divergence).type, 'Committee Markup');
  assert.equal(b.extractNextHearing(fixtures.details.flat_fallback).location, 'Room C');
  assert.equal(b.extractNextHearing(fixtures.details.history_fallback).location, 'Room D');
});

test('latest activity ties, future timeline, null, invalid and malformed inputs stay distinct', () => {
  const b = browser().parsers;
  const c = cronParsers();
  const tied = fixtures.details.competing_ties;
  assert.deepEqual(plain(c.extractLatestActivityDate(tied)),
    { dateIso: '2028-01-01T12:00:00.000Z', label: 'Effective Date (Law)' });
  assert.equal(b.extractLatestActivityDate(tied).label, 'Effective Date (Law)');
  const timeline = plain(b.extractActivityTimeline(tied));
  assert.equal(timeline[0].label, 'Introduced');
  assert.ok(timeline.filter(e => e.isFuture).length >= 5);
  assert.equal(timeline.find(e => e.label === 'Committee Re-Referral').extra, 'A, B');
  const empty = fixtures.details.empty_invalid;
  assert.equal(b.extractLatestActivityDate(empty), null);
  assert.equal(c.extractLatestActivityDate(empty), null);
  assert.equal(b.extractNextHearing(empty).date, null);
  assert.equal(c.extractNextHearing(empty), null);
  assert.deepEqual(plain(b.extractActivityTimeline(empty)), []);
  assert.throws(() => b.extractLatestActivityDate(fixtures.details.malformed_actions), /forEach/);
  assert.throws(() => c.extractLatestActivityDate(fixtures.details.malformed_actions), /forEach/);
});

test('browser search committee and member shapes retain current formatting', () => {
  const base = { legislationNumber: 'B26-1', title: 'Bill', introductionDate: null };
  const array = browserSearchItem({ ...base, referredToCommittees: ['A', 'B'],
    introducers: [{ memberName: 'One' }, { memberName: 'Two' }], coIntroducers: ['Three'] });
  assert.deepEqual(array.committees, ['A', 'B']);
  assert.equal(array.introducedBy, 'One, Two');
  assert.equal(array.coIntroducers, 'Three');
  const strings = browserSearchItem({ ...base, referredToCommittees: 'A; B',
    introducers: 'One', coIntroducers: 'Two' });
  assert.deepEqual(strings.committees, ['A', 'B']);
  assert.equal(strings.introducedBy, 'One');
  assert.equal(strings.coIntroducers, 'Two');
  const nulls = browserSearchItem({ ...base, referredToCommittees: null,
    introducers: null, coIntroducers: null });
  assert.deepEqual(nulls.committees, []);
  assert.equal(nulls.introducedBy, null);
  assert.equal(nulls.coIntroducers, null);
  assert.deepEqual(browserSearchItem({ ...base, referredToCommittees: '["A","B"]' }).committees, ['A', 'B']);
});

async function runCron(scenario) {
  const writes = [];
  const emails = [];
  const source = read('api/check-hearings.js')
    .replace("import nodemailer from 'nodemailer';", '')
    .replace('export default async function handler', 'async function handler')
    .replace('const delay = ms => new Promise(r => setTimeout(r, ms));', 'const delay = async () => {};');
  const item = { id: 'B26-0001', bill_number: 'B26-0001', is_manual_entry: false,
    action_status: 'action_needed', latest_activity_date: null, latest_activity_label: null,
    ...scenario.stored };
  const context = {
    Date: FixedDate,
    process: { env: { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_KEY: 'service',
      CRON_SECRET: 'cron', GMAIL_USER: 'sender@test', GMAIL_APP_PASSWORD: 'password', DAILY_REPORT_TO: 'recipient@test' } },
    console: { log() {}, warn() {}, error() {} },
    nodemailer: { createTransport: () => ({ sendMail: async mail => { emails.push(mail); } }) },
    fetch: async (url, init = {}) => {
      if (init.method === 'PATCH' || init.method === 'POST') {
        writes.push({ url, method: init.method, body: JSON.parse(init.body) });
        return { ok: true };
      }
      const data = url.includes('/tracked_items?') ? [item]
        : url.includes('/tracked_keywords?') ? []
          : url.includes('/LegislationDetails/') ? scenario.details : null;
      assert.notEqual(data, null, url);
      return { ok: true, json: async () => data };
    }
  };
  vm.runInNewContext(`${source}\nglobalThis.handler = handler;`, context);
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; } };
  await context.handler({ headers: { authorization: 'Bearer cron' } }, response);
  assert.equal(response.statusCode, 200);
  return { writes, emails, result: response.body };
}

test('cron status, title, hearing, fallback, history and email decisions are characterized', async () => {
  for (const scenario of fixtures.cronScenarios) {
    const { writes, emails, result } = await runCron(scenario);
    const history = writes.filter(w => w.url.endsWith('/bill_status_history'));
    const patch = writes.find(w => w.method === 'PATCH' && w.url.includes('/tracked_items?'));
    assert.equal(history.length, scenario.historyCount, scenario.name);
    assert.equal(emails.length, scenario.emailCount, scenario.name);
    assert.ok(patch, scenario.name);
    assert.equal(writes[writes.length - 1], patch, `history precedes PATCH: ${scenario.name}`);
    assert.equal(result.checked, 1);
    assert.equal(patch.body.additional_information, 'Saved');
    assert.deepEqual(patch.body.committee_re_referral, [{ committeeName: 'Old' }]);
    assert.equal(patch.body.hearing_checked_at, fixedNow);
    if (scenario.name === 'unchanged') {
      assert.equal(patch.body.status, 'Introduced');
      assert.equal(Object.hasOwn(patch.body, 'title'), false);
    }
    if (scenario.name === 'status_title_new_hearing') {
      assert.deepEqual(history.map(w => [w.body.old_status, w.body.new_status]),
        [['Introduced', 'Passed'], ['Bill', 'Bill (CANCELLED)'], ['Passed', 'Passed']]);
      assert.equal(history[0].body.change_label, null);
      assert.match(history[1].body.change_label, /^Title updated:/);
      assert.equal(history[2].body.change_label, 'Hearing Scheduled: Public Hearing on Mar 20, 2027');
      assert.equal(patch.body.title, 'Bill (CANCELLED)');
      assert.equal(patch.body.status, 'Passed');
      assert.equal(patch.body.next_hearing_date, '2027-03-20T12:00:00.000Z');
      assert.equal(result.statusChanges.length, 1);
      assert.match(emails[0].subject, /Status Change/);
      assert.match(emails[1].subject, /New Hearing/);
    }
    if (scenario.name === 'same_calendar_day') {
      assert.equal(patch.body.next_hearing_date, '2027-03-20T12:00:00.000Z');
      assert.equal(result.statusChanges.length, 0);
    }
  }
});

test('cron records a malformed per-item response and skips its writes', async () => {
  const { writes, emails, result } = await runCron({
    stored: { status: 'Introduced', title: 'Bill' },
    details: { status: 'Introduced', title: 'Bill', ...fixtures.details.malformed_actions }
  });
  assert.equal(result.checked, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /forEach/);
  assert.deepEqual(writes, []);
  assert.deepEqual(emails, []);
});
