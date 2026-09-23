import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'frontend/app.jsx'), 'utf8').replace(/\r\n/g, '\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function sourceFunction(name) {
  const match = app.match(new RegExp(`const ${name} = async \\([^)]*\\) => \\{([\\s\\S]*?)\\n            \\};`));
  assert.ok(match, name);
  return match[1];
}

const loadFromSupabase = sourceFunction('loadFromSupabase');
const loadCouncilPeriods = sourceFunction('loadCouncilPeriods');
const refreshData = sourceFunction('refreshData');

const disabledMatch = app.match(/<button onClick=\{refreshData\} disabled=\{([^}]+)\}/);
assert.ok(disabledMatch);
const refreshDisabled = new Function('loading', 'bootstrapLoading', `return ${disabledMatch[1]};`);

const keywordBlockMatch = refreshData.match(/(if \(\(searchMode === 'all' \|\| searchMode === 'keywords'\)[\s\S]*?\n                    \})\n                    if \(\(searchMode === 'all' \|\| searchMode === 'committees'\)/);
assert.ok(keywordBlockMatch);
const runKeywordBlock = new AsyncFunction(
  'searchMode', 'trackedKeywords', 'window', 'selectedPeriod', 'allResults', 'delay',
  keywordBlockMatch[1]
);

test('Refresh stays disabled until bootstrap configuration resolves, then searches the configured keyword', async () => {
  assert.match(app, /const \[bootstrapLoading, setBootstrapLoading\] = useState\(true\)/);
  assert.match(app, /useEffect\(\(\) => \{\s*loadFromSupabase\(\);\s*loadCouncilPeriods\(\);\s*\}, \[\]\)/);
  assert.doesNotMatch(app, /await (?:loadFromSupabase|loadCouncilPeriods)\(\)/);
  assert.match(loadCouncilPeriods, /setLoading\(true\)[\s\S]*?setSelectedPeriod\(data\[0\]\)[\s\S]*?setLoading\(false\)/);
  assert.match(loadFromSupabase, /finally \{\s*setBootstrapLoading\(false\);\s*\}/);
  assert.match(loadFromSupabase, /setTrackedKeywords\(bootstrap\.trackedKeywords\.map\(k => k\.keyword\)\)/);

  const bootstrap = deferred();
  let loading = false;
  let bootstrapLoading = true;
  let selectedPeriod = null;
  let trackedKeywords = [];

  const bootstrapTask = (async () => {
    try {
      const payload = await bootstrap.promise;
      trackedKeywords = payload.trackedKeywords.map(k => k.keyword);
    } finally {
      bootstrapLoading = false;
    }
  })();

  const councilTask = (async () => {
    loading = true;
    const periods = await Promise.resolve([{ councilPeriodId: 26, councilPeriod: '26' }]);
    selectedPeriod = periods[0];
    loading = false;
  })();

  await councilTask;
  assert.equal(selectedPeriod.councilPeriodId, 26);
  assert.equal(loading, false);
  assert.equal(bootstrapLoading, true);
  assert.equal(refreshDisabled(loading, bootstrapLoading), true);

  bootstrap.resolve({ trackedKeywords: [{ keyword: 'housing' }] });
  await bootstrapTask;
  assert.deepEqual(trackedKeywords, ['housing']);
  assert.equal(bootstrapLoading, false);
  assert.equal(refreshDisabled(loading, bootstrapLoading), false);

  const calls = [];
  const allResults = [];
  await runKeywordBlock(
    'all',
    trackedKeywords,
    { DCPCAFrontend: { proxyFetch: async (...args) => { calls.push(args); return []; } } },
    selectedPeriod,
    allResults,
    async () => {}
  );

  assert.deepEqual(calls, [[
    '/SearchLegislation',
    'POST',
    { Keyword: 'housing', CategoryId: 0, CouncilPeriodId: 26, RowLimit: 20, OffSet: 0 }
  ]]);
});

test('bootstrap failure releases readiness instead of permanently disabling Refresh', async () => {
  const bootstrap = deferred();
  let loading = false;
  let bootstrapLoading = true;

  const task = (async () => {
    try {
      await bootstrap.promise;
    } catch {
      // Mirrors the existing load error path before its finally block.
    } finally {
      bootstrapLoading = false;
    }
  })();

  assert.equal(refreshDisabled(loading, bootstrapLoading), true);
  bootstrap.reject(new Error('bootstrap failed'));
  await task;
  assert.equal(bootstrapLoading, false);
  assert.equal(refreshDisabled(loading, bootstrapLoading), false);
});

test('the fix leaves Refresh search logic and button presentation unchanged', () => {
  assert.match(refreshData, /if \(!selectedPeriod\) return;/);
  assert.match(refreshData, /for \(const keyword of trackedKeywords\)/);
  assert.match(refreshData, /Keyword: keyword, CategoryId: 0,/);
  assert.match(refreshData, /CouncilPeriodId: selectedPeriod\.councilPeriodId, RowLimit: 20, OffSet: 0/);
  assert.match(app, /disabled=\{loading \|\| bootstrapLoading\} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:bg-gray-400">\{loading \? 'Loading\.\.\.' : 'Refresh'\}<\/button>/);
});
