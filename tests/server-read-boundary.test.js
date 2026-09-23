import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function makeRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return body; };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  return res;
}

function signedCookie(secret = 'read-secret') {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 60000, n: 'read-test' }))
    .toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `dc_tracker_session=${encodeURIComponent(`${payload}.${signature}`)}`;
}

async function importHandler() {
  const url = `${pathToFileURL(path.join(root, 'api/app-data.js')).href}?read=${Date.now()}-${Math.random()}`;
  return (await import(url)).default;
}

async function withEnv(callback) {
  const previous = {
    SESSION_SECRET: process.env.SESSION_SECRET,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY
  };
  Object.assign(process.env, {
    SESSION_SECRET: 'read-secret',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_KEY: 'service-key'
  });
  try { return await callback(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function invoke(handler, action, cookie = signedCookie()) {
  const res = makeRes();
  await handler({ method: 'POST', headers: cookie ? { cookie } : {}, body: action }, res);
  return res;
}

const tableRows = Object.freeze({
  tracked_items: [{ id: 'B26-1', title: 'Bill' }],
  item_notes: [{ item_id: 'B26-1', note_text: 'Note' }],
  tracked_keywords: [{ keyword: 'health' }],
  tracked_committees: [{ committee_name: 'Health' }],
  tracked_sponsors: [{ sponsor_name: 'Member' }],
  tracked_agencies: [{ agency_name: 'Agency' }],
  team_members: [{ id: 'member-1', name: 'Alex', email: 'a@example.org' }],
  bill_status_history: [{ item_id: 'B26-1', old_status: 'a', new_status: 'b', change_label: 'Changed', changed_at: '2026-01-01T00:00:00Z' }],
  activity_log: [{ id: 1, action: 'test', item_title: 'Bill', details: {}, created_at: '2026-01-01T00:00:00Z' }]
});

function tableFromUrl(url) {
  return new URL(url).pathname.split('/').pop();
}

test('authenticated read actions require a signed session and reject extra keys', async () => {
  const handler = await importHandler();
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
  try {
    await withEnv(async () => {
      for (const action of ['app.bootstrap.read', 'activityLog.list', 'teamMembers.list']) {
        assert.equal((await invoke(handler, { action }, null)).statusCode, 401);
        assert.equal((await invoke(handler, { action }, 'dc_tracker_session=invalid')).statusCode, 401);
        const extra = await invoke(handler, { action, table: 'tracked_items' });
        assert.equal(extra.statusCode, 400);
        assert.equal(extra.body.error, 'Invalid request');
      }
    });
  } finally { global.fetch = originalFetch; }
});

test('bootstrap uses fixed minimized selects in the approved sequential order', async () => {
  const handler = await importHandler();
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => tableRows[tableFromUrl(url)] };
  };
  try {
    await withEnv(async () => {
      const res = await invoke(handler, { action: 'app.bootstrap.read' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(Object.keys(res.body), ['ok', 'trackedItems', 'itemNotes', 'trackedKeywords', 'trackedCommittees', 'trackedSponsors', 'trackedAgencies', 'teamMembers', 'billStatusHistory']);
      assert.deepEqual(calls.map(call => tableFromUrl(call.url)), [
        'tracked_items', 'item_notes', 'tracked_keywords', 'tracked_committees',
        'tracked_sponsors', 'tracked_agencies', 'team_members', 'bill_status_history'
      ]);
      assert.ok(calls.every(call => call.options.method === 'GET'));
      assert.ok(calls.every(call => !new URL(call.url).searchParams.get('select')?.includes('*')));
      assert.equal(new URL(calls[0].url).searchParams.get('select'), 'id,title,bill_number,category,status,last_status,committees,date,description,link,source,agency,introduced_by,co_introducers,assigned_to,priority,action_status,is_new,is_manual_entry,has_new_activity,activity_summary,last_checked_at,hearing_checked_at,tracked_at,notice_id,register_issue,register_notes,next_hearing_date,hearing_type,hearing_location,additional_information,manual_summary,committee_re_referral,latest_activity_date,latest_activity_label,activity_count,deadline,activity_timeline');
      assert.equal(new URL(calls[0].url).searchParams.get('order'), 'tracked_at.desc');
      assert.equal(new URL(calls[1].url).searchParams.get('select'), 'item_id,note_text');
      assert.equal(new URL(calls[2].url).searchParams.get('select'), 'keyword');
      assert.equal(new URL(calls[3].url).searchParams.get('select'), 'committee_name');
      assert.equal(new URL(calls[4].url).searchParams.get('select'), 'sponsor_name');
      assert.equal(new URL(calls[5].url).searchParams.get('select'), 'agency_name');
      assert.equal(new URL(calls[6].url).searchParams.get('active'), 'eq.true');
      assert.equal(new URL(calls[6].url).searchParams.get('order'), 'name.asc');
      assert.equal(new URL(calls[7].url).searchParams.get('order'), 'changed_at.desc');
      assert.doesNotMatch(new URL(calls[6].url).searchParams.get('select'), /active/);
      assert.doesNotMatch(new URL(calls[7].url).searchParams.get('select'), /\bid\b/);
    });
  } finally { global.fetch = originalFetch; }
});

test('bootstrap preserves empty arrays', async () => {
  const handler = await importHandler();
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
  try {
    await withEnv(async () => {
      const res = await invoke(handler, { action: 'app.bootstrap.read' });
      assert.equal(res.statusCode, 200);
      for (const [key, value] of Object.entries(res.body)) {
        if (key !== 'ok') assert.deepEqual(value, []);
      }
    });
  } finally { global.fetch = originalFetch; }
});

test('each fatal bootstrap failure stops later queries and returns only earlier datasets', async () => {
  const handler = await importHandler();
  const stages = [
    ['tracked_items', 'trackedItems'], ['item_notes', 'itemNotes'],
    ['tracked_keywords', 'trackedKeywords'], ['tracked_committees', 'trackedCommittees'],
    ['tracked_sponsors', 'trackedSponsors'], ['team_members', 'teamMembers']
  ];
  const fullOrder = ['tracked_items', 'item_notes', 'tracked_keywords', 'tracked_committees', 'tracked_sponsors', 'tracked_agencies', 'team_members'];
  const originalFetch = global.fetch;
  const originalError = console.error;
  console.error = () => {};
  try {
    await withEnv(async () => {
      for (const [failedTable, failedDataset] of stages) {
        const calls = [];
        global.fetch = async url => {
          const table = tableFromUrl(url);
          calls.push(table);
          if (table === failedTable) return { ok: false, status: 503 };
          return { ok: true, status: 200, json: async () => [] };
        };
        const res = await invoke(handler, { action: 'app.bootstrap.read' });
        const failedIndex = fullOrder.indexOf(failedTable);
        assert.equal(res.statusCode, 500);
        assert.equal(res.body.error, 'Service unavailable');
        assert.equal(res.body.failedDataset, failedDataset);
        assert.deepEqual(calls, fullOrder.slice(0, failedIndex + 1));
        const successfulDatasets = stages.map(([, dataset]) => dataset).slice(0, stages.findIndex(([, dataset]) => dataset === failedDataset));
        if (failedDataset === 'teamMembers') successfulDatasets.push('trackedAgencies');
        assert.deepEqual(Object.keys(res.body.partial), successfulDatasets);
        assert.doesNotMatch(JSON.stringify(res.body), /raw database secret/i);
      }
    });
  } finally { global.fetch = originalFetch; console.error = originalError; }
});

test('agency and history failures are tolerated with null datasets', async () => {
  const handler = await importHandler();
  const originalFetch = global.fetch;
  const originalError = console.error;
  console.error = () => {};
  global.fetch = async url => {
    const table = tableFromUrl(url);
    if (table === 'tracked_agencies' || table === 'bill_status_history') return { ok: false, status: 500 };
    return { ok: true, status: 200, json: async () => [] };
  };
  try {
    await withEnv(async () => {
      const res = await invoke(handler, { action: 'app.bootstrap.read' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.trackedAgencies, null);
      assert.deepEqual(res.body.teamMembers, []);
      assert.equal(res.body.billStatusHistory, null);
    });
  } finally { global.fetch = originalFetch; console.error = originalError; }
});

test('activity and team list actions use exact fixed read contracts and generic failures', async () => {
  const handler = await importHandler();
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => [] };
  };
  try {
    await withEnv(async () => {
      assert.equal((await invoke(handler, { action: 'activityLog.list' })).statusCode, 200);
      assert.equal((await invoke(handler, { action: 'teamMembers.list' })).statusCode, 200);
      const activity = new URL(calls[0].url);
      assert.equal(tableFromUrl(calls[0].url), 'activity_log');
      assert.equal(activity.searchParams.get('select'), 'id,action,item_title,details,created_at');
      assert.equal(activity.searchParams.get('order'), 'created_at.desc');
      assert.equal(activity.searchParams.get('limit'), '100');
      const members = new URL(calls[1].url);
      assert.equal(members.searchParams.get('select'), 'id,name,email');
      assert.equal(members.searchParams.get('active'), 'eq.true');
      assert.equal(members.searchParams.get('order'), 'name.asc');

      global.fetch = async () => ({ ok: false, status: 500, text: async () => 'raw database secret' });
      const originalError = console.error;
      console.error = () => {};
      try {
        for (const action of ['activityLog.list', 'teamMembers.list']) {
          const failed = await invoke(handler, { action });
          assert.equal(failed.statusCode, 500);
          assert.deepEqual(failed.body, { error: 'Service unavailable' });
          assert.doesNotMatch(JSON.stringify(failed.body), /raw database secret/);
        }
      } finally { console.error = originalError; }
    });
  } finally { global.fetch = originalFetch; }
});

test('frontend read boundary preserves mappings and leaves only lims_bill_cache direct reads', () => {
  const app = read('frontend/app.jsx');
  const bootstrap = app.match(/const loadFromSupabase = async \(\) => \{([\s\S]*?)\n            \};/)[1];
  const activity = app.match(/const loadActivityLog = async \(\) => \{([\s\S]*?)\n            \};/)[1];
  assert.match(bootstrap, /appDataRequest\(\{ action: 'app\.bootstrap\.read' \}\)/);
  assert.match(bootstrap, /payload\?\.partial \|\| \{\}/);
  assert.match(bootstrap, /setSelectedItems\(itemsSet\)/);
  assert.match(bootstrap, /setItems\(displayItems\)/);
  assert.match(bootstrap, /setHearingData\(hearingMap\)/);
  assert.match(bootstrap, /setItemNotes\(notesMap\)/);
  assert.match(bootstrap, /setStatusHistory\(histMap\)/);
  assert.match(bootstrap, /if \(!response\.ok\) throw new Error/);
  assert.match(bootstrap, /finally \{\s*setBootstrapLoading\(false\);\s*\}/);
  assert.ok(bootstrap.indexOf('setStatusHistory(histMap)') < bootstrap.indexOf('if (!response.ok) throw new Error'));
  assert.match(bootstrap, /hasDataset\('trackedAgencies'\) && bootstrap\.trackedAgencies/);
  assert.match(bootstrap, /hasDataset\('billStatusHistory'\) && bootstrap\.billStatusHistory/);
  assert.doesNotMatch(bootstrap, /supabase\s*\.from/);
  assert.match(activity, /action: 'activityLog\.list'/);
  assert.doesNotMatch(activity, /supabase\s*\.from/);
  assert.match(app, /const refreshTeamMembers = async[\s\S]*?action: 'teamMembers\.list'[\s\S]*?if \(!response\.ok\) return;[\s\S]*?setTeamMembers/);
  for (const name of ['addTeamMember', 'updateTeamMember', 'deleteTeamMember']) {
    const block = app.match(new RegExp(`const ${name} = async \\([^)]*\\) => \\{([\\s\\S]*?)\\n            \\};`))[1];
    assert.match(block, /await refreshTeamMembers\(\)/);
    assert.doesNotMatch(block, /supabase\s*\.from/);
    assert.ok(block.indexOf('if (!response.ok)') < block.indexOf('await refreshTeamMembers()'));
  }
  const addBlock = app.match(/const addTeamMember = async \(\) => \{([\s\S]*?)\n            \};/)[1];
  const updateBlock = app.match(/const updateTeamMember = async \(\) => \{([\s\S]*?)\n            \};/)[1];
  assert.ok(addBlock.indexOf('await refreshTeamMembers()') < addBlock.indexOf("setTeamMemberForm({ name: '', email: '' })"));
  assert.ok(updateBlock.indexOf('setItems(items.map') < updateBlock.indexOf('await refreshTeamMembers()'));
  assert.ok(updateBlock.indexOf('await refreshTeamMembers()') < updateBlock.indexOf('setEditingTeamMember(null)'));
  const directTables = [...app.matchAll(/supabase\s*\.from\('([^']+)'\)/g)].map(match => match[1]);
  assert.deepEqual([...new Set(directTables)], ['lims_bill_cache']);
  assert.equal(directTables.length, 3);
  assert.match(app, /initializeSupabase[\s\S]*?fetch\('\/api\/client-config'\)/);
  assert.match(app, /\.ilike\('committees', `%\$\{committee\}%`\)/);
  assert.match(app, /\.ilike\('introduced_by', `%\$\{sponsor\}%`\)/);
  assert.match(app, /\.ilike\('co_introducers', `%\$\{sponsor\}%`\)/);
  const apiCount = fs.readdirSync(path.join(root, 'api')).filter(file => file.endsWith('.js')).length;
  assert.equal(apiCount, 12);
});
