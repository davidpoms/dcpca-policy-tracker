import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'frontend/app.jsx'), 'utf8');
const projection = 'bill_number,title,category,status,introduced_by,co_introducers,committees,introduction_date';

function signedCookie(secret = 'cache-secret') {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 60000, n: 'cache-test' })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `dc_tracker_session=${encodeURIComponent(`${payload}.${signature}`)}`;
}

function makeRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return body; };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  return res;
}

async function handler() {
  return (await import(`${pathToFileURL(path.join(root, 'api/app-data.js')).href}?cache=${Math.random()}`)).default;
}

async function invoke(fn, body, cookie = signedCookie()) {
  const res = makeRes();
  await fn({ method: 'POST', headers: cookie ? { cookie } : {}, body }, res);
  return res;
}

async function withEnv(callback) {
  const old = {
    SESSION_SECRET: process.env.SESSION_SECRET,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY
  };
  Object.assign(process.env, {
    SESSION_SECRET: 'cache-secret', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'service-key'
  });
  try { return await callback(); } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

const row = (bill, title = bill) => ({
  bill_number: bill, title, category: 'Bill', status: 'Introduced', introduced_by: 'Member',
  co_introducers: 'Other', committees: 'Health', introduction_date: '2026-01-01T00:00:00Z'
});

test('cache read actions require authentication and exact valid requests', async () => {
  const fn = await handler();
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => [] });
  try {
    await withEnv(async () => {
      for (const valid of [
        { action: 'limsCache.committee.search', councilPeriodId: 27, committee: 'Health' },
        { action: 'limsCache.sponsor.search', councilPeriodId: 27, sponsor: 'Member' }
      ]) {
        assert.equal((await invoke(fn, valid, null)).statusCode, 401);
        assert.equal((await invoke(fn, { ...valid, field: 'raw_details' })).statusCode, 400);
        assert.equal((await invoke(fn, { ...valid, councilPeriodId: 0 })).statusCode, 400);
        assert.equal((await invoke(fn, { ...valid, councilPeriodId: '27' })).statusCode, 400);
        assert.equal((await invoke(fn, { ...valid, councilPeriodId: 27.5 })).statusCode, 400);
        const termKey = Object.hasOwn(valid, 'committee') ? 'committee' : 'sponsor';
        assert.equal((await invoke(fn, { ...valid, [termKey]: '   ' })).statusCode, 400);
        assert.equal((await invoke(fn, { ...valid, [termKey]: 27 })).statusCode, 400);
        const missing = { ...valid }; delete missing[termKey];
        assert.equal((await invoke(fn, missing)).statusCode, 400);
      }
    });
  } finally { global.fetch = originalFetch; }
});

test('committee action uses the fixed projection, selected period, and unescaped ILIKE wildcards', async () => {
  const fn = await handler();
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => [row('B27-0001')] }; };
  try {
    await withEnv(async () => {
      const res = await invoke(fn, { action: 'limsCache.committee.search', councilPeriodId: 27, committee: 'Health_100%' });
      assert.deepEqual(res.body, { ok: true, rows: [row('B27-0001')] });
      assert.equal(calls.length, 1);
      const url = new URL(calls[0].url);
      assert.equal(url.pathname, '/rest/v1/lims_bill_cache');
      assert.equal(url.searchParams.get('select'), projection);
      assert.equal(url.searchParams.get('council_period_id'), 'eq.27');
      assert.equal(url.searchParams.get('committees'), 'ilike.%Health_100%%');
      assert.equal(calls[0].options.method, 'GET');
      assert.equal(url.searchParams.has('order'), false);
      assert.equal(url.searchParams.has('limit'), false);
    });
  } finally { global.fetch = originalFetch; }
});

test('committee ordinary database failure is generic', async () => {
  const fn = await handler();
  const originalFetch = global.fetch;
  const originalError = console.error;
  global.fetch = async () => ({ ok: false, status: 500 });
  console.error = () => {};
  try {
    await withEnv(async () => {
      const res = await invoke(fn, { action: 'limsCache.committee.search', councilPeriodId: 27, committee: 'Health' });
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.body, { error: 'Service unavailable' });
    });
  } finally { global.fetch = originalFetch; console.error = originalError; }
});

test('sponsor action uses fixed fields, ordering, deduplication, period, and wildcard semantics', async () => {
  const fn = await handler();
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    const field = new URL(url).searchParams.has('introduced_by') ? 'introduced' : 'co';
    return { ok: true, json: async () => field === 'introduced'
      ? [row('B27-0001', 'Introducer wins'), row('B27-0002')]
      : [row('B27-0001', 'Co loses'), row('B27-0003')] };
  };
  try {
    await withEnv(async () => {
      const res = await invoke(fn, { action: 'limsCache.sponsor.search', councilPeriodId: 27, sponsor: 'Doe_100%' });
      assert.deepEqual(res.body.rows.map(value => [value.bill_number, value.title]), [
        ['B27-0001', 'Introducer wins'], ['B27-0002', 'B27-0002'], ['B27-0003', 'B27-0003']
      ]);
      assert.equal(calls.length, 2);
      for (const call of calls) {
        const url = new URL(call.url);
        assert.equal(url.pathname, '/rest/v1/lims_bill_cache');
        assert.equal(url.searchParams.get('select'), projection);
        assert.equal(url.searchParams.get('council_period_id'), 'eq.27');
      }
      assert.equal(new URL(calls[0].url).searchParams.get('introduced_by'), 'ilike.%Doe_100%%');
      assert.equal(new URL(calls[1].url).searchParams.get('co_introducers'), 'ilike.%Doe_100%%');
    });
  } finally { global.fetch = originalFetch; }
});

test('sponsor ordinary failures preserve either successful side and tolerate both failures', async () => {
  const fn = await handler();
  const originalFetch = global.fetch;
  const originalError = console.error;
  console.error = () => {};
  try {
    await withEnv(async () => {
      for (const failedField of ['introduced_by', 'co_introducers', 'both']) {
        global.fetch = async url => {
          const parsed = new URL(url);
          const field = parsed.searchParams.has('introduced_by') ? 'introduced_by' : 'co_introducers';
          if (failedField === 'both' || failedField === field) return { ok: false, status: 503 };
          return { ok: true, json: async () => [row(field === 'introduced_by' ? 'B27-0001' : 'B27-0002')] };
        };
        const res = await invoke(fn, { action: 'limsCache.sponsor.search', councilPeriodId: 27, sponsor: 'Doe' });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.rows.map(value => value.bill_number), failedField === 'both' ? [] :
          [failedField === 'introduced_by' ? 'B27-0002' : 'B27-0001']);
      }
    });
  } finally { global.fetch = originalFetch; console.error = originalError; }
});

test('sponsor rejected infrastructure request uses generic app-data failure', async () => {
  const fn = await handler();
  const originalFetch = global.fetch;
  const originalError = console.error;
  global.fetch = async () => { throw new Error('private infrastructure detail'); };
  console.error = () => {};
  try {
    await withEnv(async () => {
      const res = await invoke(fn, { action: 'limsCache.sponsor.search', councilPeriodId: 27, sponsor: 'Doe' });
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.body, { error: 'Service unavailable' });
    });
  } finally { global.fetch = originalFetch; console.error = originalError; }
});

test('frontend uses app-data while preserving cache mappings and local continuation', () => {
  const refresh = appSource.match(/const refreshData = async \(\) => \{([\s\S]*?)\n            \};/)[1];
  assert.match(refresh, /action: 'limsCache\.committee\.search'[\s\S]*?councilPeriodId: selectedPeriod\.councilPeriodId,[\s\S]*?committee/);
  assert.match(refresh, /action: 'limsCache\.sponsor\.search'[\s\S]*?councilPeriodId: selectedPeriod\.councilPeriodId,[\s\S]*?sponsor/);
  assert.match(refresh, /catch \(err\) \{ console\.error\(`Error searching committee[\s\S]*?allResults\.push\(\[\]\); \}/);
  assert.match(refresh, /Error searching sponsor[\s\S]*?allResults\.push\(\[\]\)/);
  for (const field of ['bill_number', 'title', 'category', 'status', 'introduced_by', 'co_introducers', 'committees', 'introduction_date']) {
    assert.match(refresh, new RegExp(`row\\.${field}`));
  }
  const browserSources = ['frontend/app.jsx', 'frontend/api-client.js', 'frontend/lims-normalization.js',
    'frontend/lims-activity.js', 'frontend/lims-hearings.js', 'index.html']
    .map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  assert.doesNotMatch(browserSources, /supabase\s*\.from\s*\(/);
  assert.doesNotMatch(refresh, /\.from\('lims_bill_cache'\)|\.select\('\*'\)/);
  const appData = fs.readFileSync(path.join(root, 'api/app-data.js'), 'utf8');
  assert.doesNotMatch(appData, /body\.(?:table|field|operator|query|columns|order|limit)/);
  assert.match(appData, /validateSignedSession/);
  assert.equal(fs.readdirSync(path.join(root, 'api')).filter(file => file.endsWith('.js')).length, 11);
});
