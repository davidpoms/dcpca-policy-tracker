import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routePath = path.join(root, 'api/scrape-dcregs.js');
const route = await import(`${pathToFileURL(routePath).href}?test=${Date.now()}`);
const secret = 'cron-test-secret';

function noticeHtml({ id, category, subCategory = null, title }) {
  return `<html><body><div>District of Columbia Register</div><a href="/Common/NoticeDetail.aspx?NoticeId=${id}">Notice Detail</a><h1>${title}</h1><table><tr><td>Notice ID:</td><td>${id}</td></tr>
  <tr><td>Register Category:</td><td>${category}</td></tr>${subCategory ? `<tr><td>Sub Category:</td><td>${subCategory}</td></tr>` : ''}
  <tr><td>Agency:</td><td>Zoning, Office of</td></tr><tr><td>Register Issue:</td><td>9/18/2026, Vol 73/38</td></tr>
  <tr><td>Publish Date:</td><td>9/18/2026</td></tr></table><a href="/Common/ViewDocument.aspx?NoticeId=${id}">View text</a></body></html>`;
}
const n539 = noticeHtml({ id: 'N146539', category: 'Public Hearings', title: 'Public Hearing Notice' });
const n506 = noticeHtml({ id: 'N146506', category: 'Notices, Opinions, and Orders', subCategory: 'Orders', title: 'Order Notice' });
const home = `<html><body><input name="__VIEWSTATE" value="state">District of Columbia Register Search District of Columbia Register Browse through DCR Issues
<a href="/issues.aspx?IssueID=73-38">September 18, 2026</a></body></html>`;
const issue = `<html><body>District of Columbia Register<a href="/category.aspx?IssueID=73-38&CategoryID=1">Rules</a></body></html>`;
const category = `<html><body>District of Columbia Register<a href="/Common/NoticeDetail.aspx?NoticeId=N150000">Target notice</a></body></html>`;

function response(body, { status = 200, url = 'https://dcregs.dc.gov/', type = 'text/html', headers = {} } = {}) {
  const bytes = new TextEncoder().encode(body);
  const values = { 'content-type': type, ...headers };
  return { status, ok: status >= 200 && status < 300, url, headers: { get: name => values[name.toLowerCase()] ?? null },
    arrayBuffer: async () => bytes.buffer };
}
function res() { return { statusCode: 200, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } }; }
function request(headers = { authorization: `Bearer ${secret}` }) { return { method: 'GET', headers }; }
function standardFetch(extra = () => null) {
  return async (url, options = {}) => {
    const value = String(url); const supplied = extra(value, options); if (supplied) return supplied;
    if (value.includes('ViewDocument')) return response('%PDF mock', { url: value, type: 'application/pdf' });
    if (value.includes('N146539')) return response(n539, { url: value });
    if (value.includes('N146506')) return response(n506, { url: value });
    if (value.includes('category.aspx')) return response(category, { url: value });
    if (value.includes('issues.aspx')) return response(issue, { url: value });
    return response(home, { url: value });
  };
}
async function withEnvFetch(env, fetchImpl, fn) {
  const oldFetch = global.fetch; const old = { CRON_SECRET: process.env.CRON_SECRET, SCRAPINGBEE_API_KEY: process.env.SCRAPINGBEE_API_KEY };
  Object.assign(process.env, env); if (!('SCRAPINGBEE_API_KEY' in env)) delete process.env.SCRAPINGBEE_API_KEY; global.fetch = fetchImpl;
  try { return await fn(); } finally { global.fetch = oldFetch; for (const [key, value] of Object.entries(old)) value === undefined ? delete process.env[key] : process.env[key] = value; }
}

test('exact bearer authorization fails closed and ignores x-vercel-cron', async () => {
  await withEnvFetch({}, standardFetch(), async () => { delete process.env.CRON_SECRET; const out = res(); await route.default(request(), out); assert.equal(out.statusCode, 401); });
  await withEnvFetch({ CRON_SECRET: secret }, standardFetch(), async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { 'x-vercel-cron': '1' }, { authorization: 'Bearer wrong', 'x-vercel-cron': '1' }]) {
      const out = res(); await route.default(request(headers), out); assert.equal(out.statusCode, 401); assert.deepEqual(out.body, { error: 'Unauthorized' });
    }
    const out = res(); await route.default(request(), out); assert.equal(out.statusCode, 200);
  });
});

test('DCRegs allowlist accepts only exact HTTPS hosts', () => {
  assert.equal(route.allowedDcRegsUrl('https://dcregs.dc.gov/a'), 'https://dcregs.dc.gov/a');
  assert.equal(route.allowedDcRegsUrl('https://www.dcregs.dc.gov/a'), 'https://www.dcregs.dc.gov/a');
  for (const value of ['http://dcregs.dc.gov/a', 'https://evil.test/a', '//evil.test/a', 'https://dcregs.dc.gov.evil.test/a']) assert.equal(route.allowedDcRegsUrl(value), null);
  const malicious = `<a href="https://evil.test/doc.pdf">View text</a><a onclick="open('//evil.test/x.pdf')">View text</a>`;
  assert.deepEqual(route.parseNoticeMetadata(malicious, 'https://dcregs.dc.gov/x').viewTextTargets, []);
});

test('external form action is reported as rejected and never fetched', async () => {
  const altered = n539.replace('<body>', '<body><form action="https://evil.test/submit">');
  const calls = [];
  await withEnvFetch({ CRON_SECRET: secret }, standardFetch((url) => {
    calls.push(url); if (url.includes('N146539')) return response(altered, { url }); return null;
  }), async () => {
    const out = res(); await route.default(request(), out);
    assert.equal(out.body.viewText[0].formAction, null); assert.equal(out.body.viewText[0].formActionRejected, true);
    assert.equal(calls.some(url => url.includes('evil.test')), false);
  });
});

test('classifier and both known notice shapes remain characterized', () => {
  assert.equal(route.classifyDcRegsResponse(home, 200, 'https://www.dcregs.dc.gov/').realContent, true);
  assert.equal(route.classifyDcRegsResponse('<html>Access denied verify you are human</html>', 200, 'https://www.dcregs.dc.gov/').kind, 'challenge-or-block');
  const first = route.parseNoticeMetadata(n539, 'https://dcregs.dc.gov/x');
  assert.equal(first.noticeId, 'N146539'); assert.equal(first.registerCategory, 'Public Hearings'); assert.equal(first.agency, 'Zoning, Office of');
  const second = route.parseNoticeMetadata(n506, 'https://dcregs.dc.gov/x');
  assert.equal(second.noticeId, 'N146506'); assert.equal(second.subCategory, 'Orders');
});

test('structural validation overrides incidental block phrases on valid pages', () => {
  const homepage = home.replace('</body>', '<script>const message = "request blocked";</script></body>');
  const homeResult = route.classifyDcRegsResponse(homepage, 200, 'https://www.dcregs.dc.gov/');
  assert.equal(homeResult.realContent, true); assert.deepEqual(homeResult.blockSignals, ['request blocked']);
  assert.equal(homeResult.structuralValidationType, 'dc-register-homepage');

  const notice = n539.replace('</body>', '<script>const message = "request blocked";</script></body>');
  const noticeResult = route.classifyDcRegsResponse(notice, 200, 'https://dcregs.dc.gov/Common/NoticeDetail.aspx?NoticeId=N146539');
  assert.equal(noticeResult.realContent, true); assert.equal(noticeResult.expectedNoticeIdMatched, true);
  assert.deepEqual(noticeResult.blockSignals, ['request blocked']);
  assert.equal(noticeResult.structuralValidationType, 'dc-register-notice-detail');
});

test('notice validation rejects challenge shells, wrong IDs, and weak generic HTML', () => {
  const target = 'https://dcregs.dc.gov/Common/NoticeDetail.aspx?NoticeId=N146539';
  const shell = '<html><body>District of Columbia Register NoticeDetail.aspx request blocked verify you are human</body></html>';
  const shellResult = route.classifyDcRegsResponse(shell, 200, target);
  assert.equal(shellResult.realContent, false); assert.equal(shellResult.kind, 'challenge-or-block');
  assert.equal(shellResult.expectedNoticeIdMatched, false);

  const wrong = route.classifyDcRegsResponse(n506, 200, target);
  assert.equal(wrong.realContent, false); assert.equal(wrong.expectedNoticeId, 'N146539'); assert.equal(wrong.expectedNoticeIdMatched, false);

  const weak = route.classifyDcRegsResponse('<html><body>District of Columbia Register</body></html>', 200, 'https://dcregs.dc.gov/other.aspx');
  assert.equal(weak.realContent, false); assert.equal(weak.kind, 'unexpected-content');
});

test('notice metadata diagnostics report only bounded public fields', () => {
  const result = route.classifyDcRegsResponse(n539, 200, 'https://dcregs.dc.gov/Common/NoticeDetail.aspx?NoticeId=N146539');
  assert.deepEqual(result.noticeMetadataDiagnostics.parsedMetadataFieldsPresent, {
    noticeId: true, title: true, registerCategory: true, subCategory: false, agency: true,
    registerIssue: true, issueDate: true, volume: true, issueNumber: true, publishDate: true
  });
  assert.equal(result.noticeMetadataDiagnostics.parsedCoreFieldCount, 4);
  assert.equal(result.noticeMetadataDiagnostics.parsedMetadata.registerCategory, 'Public Hearings');
  assert.equal(result.noticeMetadataDiagnostics.parsedMetadata.noticeId, 'N146539');
  const diagnosticJson = JSON.stringify(result.noticeMetadataDiagnostics);
  assert.doesNotMatch(diagnosticJson, /<html|<table|<script|response body/i);
  assert.deepEqual(Object.keys(result.noticeMetadataDiagnostics.parsedMetadata), [
    'noticeId', 'title', 'registerCategory', 'subCategory', 'agency', 'registerIssue', 'issueDate', 'volume', 'issueNumber', 'publishDate'
  ]);
});

test('browse controls expose safe structured navigation diagnostics only', () => {
  const controls = `<html><body><form action="/Common/DCR/Issues/IssueList.aspx">
    <input name="__VIEWSTATE" value="large-secret-state"><input name="__EVENTVALIDATION" value="large-validation"><input name="__EVENTTARGET">
    <input id="browseInput" name="ctl00$browse" type="button" value="Browse through DCR Issues" onclick="__doPostBack('ctl00$browse','open')">
    <button id="browseButton" onclick="window.open('https://evil.test/issues')">Browse through DCR Issues</button>
    <a href="javascript:alert(1)">Browse through DCR Issues</a>
  </form>${Array.from({ length: 6 }, (_, i) => `<button id="extra${i}">Browse through DCR Issues</button>`).join('')}</body></html>`;
  const result = route.inspectBrowseControls(controls, 'https://www.dcregs.dc.gov/');
  assert.equal(result.candidates.length, 5);
  assert.deepEqual(result.pageSignals, { hasViewState: true, hasEventValidation: true, hasEventTarget: true });
  assert.equal(result.candidates[0].tag, 'input');
  assert.equal(result.candidates[0].formAction, 'https://www.dcregs.dc.gov/Common/DCR/Issues/IssueList.aspx');
  assert.deepEqual(result.candidates[0].onclick, {
    hasDoPostBack: true, eventTarget: 'ctl00$browse', eventArgument: 'open', hasWindowOpen: false, allowedWindowOpenUrl: null
  });
  assert.equal(result.candidates[1].onclick.hasWindowOpen, true);
  assert.equal(result.candidates[1].onclick.allowedWindowOpenUrl, null);
  assert.equal(result.candidates[2].href, null);
  assert.doesNotMatch(JSON.stringify(result), /large-secret-state|large-validation|alert\(1\)|evil\.test/);
});

test('external redirect is rejected without following it', async () => {
  const calls = [];
  await withEnvFetch({ CRON_SECRET: secret }, async (url, options) => {
    calls.push(String(url));
    if (String(url).includes('www.dcregs.dc.gov')) return response('', { status: 302, headers: { location: 'https://evil.test/stolen' } });
    return standardFetch()(url, options);
  }, async () => { const out = res(); await route.default(request(), out); assert.equal(calls.some(url => url.includes('evil.test')), false); assert.equal(out.body.direct[0].contentValidation.kind, 'url-rejected'); });
});

test('strict target issue chain drives viability and generic browse notices do not', async () => {
  await withEnvFetch({ CRON_SECRET: secret }, standardFetch(), async () => {
    const out = res(); await route.default(request(), out);
    assert.equal(out.body.issueDiscovery.success, true); assert.equal(out.body.conclusion.issueEnumerationViable, true);
    assert.equal(out.body.issueDiscovery.noticesFromTargetIssue, 1); assert.equal(out.body.issueDiscovery.issueId, '73-38');
  });
  const generic = `<html><body>District of Columbia Register Browse through DCR Issues<a href="/Common/NoticeDetail.aspx?NoticeId=N999">Unrelated</a></body></html>`;
  await withEnvFetch({ CRON_SECRET: secret }, async url => String(url).includes('N146539') ? response(n539) : String(url).includes('N146506') ? response(n506) : response(generic), async () => {
    const out = res(); await route.default(request(), out); assert.equal(out.body.issueDiscovery.success, false); assert.equal(out.body.conclusion.issueEnumerationViable, false);
  });
});

test('discovery and returned samples obey reduced caps', async () => {
  const manyHome = `<html><body>District of Columbia Register Browse through DCR Issues${Array.from({ length: 5 }, (_, i) => `<a href="/browse${i}.aspx">DCR Issues</a>`).join('')}<a href="/issue0.aspx?IssueID=73-38">September 18, 2026</a><a href="/issue1.aspx?IssueID=73-38">9/18/2026</a><a href="/issue2.aspx?IssueID=73-38">9/18/2026</a></body></html>`;
  const manyCategories = `<html><body>District of Columbia Register${Array.from({ length: 9 }, (_, i) => `<a href="/cat${i}.aspx?CategoryID=${i}">C${i}</a>`).join('')}</body></html>`;
  const manyNotices = `<html><body>District of Columbia Register${Array.from({ length: 15 }, (_, i) => `<a href="/Common/NoticeDetail.aspx?NoticeId=N${2000 + i}">N${i}</a>`).join('')}</body></html>`;
  const calls = [];
  await withEnvFetch({ CRON_SECRET: secret }, standardFetch((url) => {
    calls.push(url); if (url === 'https://www.dcregs.dc.gov/') return response(manyHome); if (/issue\d/.test(url)) return response(manyCategories); if (/cat\d/.test(url)) return response(manyNotices); return null;
  }), async () => {
    const out = res(); await route.default(request(), out);
    assert.ok(out.body.issueDiscovery.browseUrls.length <= 2); assert.ok(out.body.issueDiscovery.targetIssueUrls.length <= 2);
    assert.ok(out.body.issueDiscovery.categoryUrls.length <= 6); assert.ok(out.body.issueDiscovery.sampleNotices.length <= 10);
    assert.ok(calls.filter(url => /cat\d/.test(url)).length <= 6);
  });
});

test('oversized streams and ignored document Range are stopped locally', async () => {
  const chunks = [new Uint8Array(6), new Uint8Array(6)]; let cancelled = false;
  const streamResponse = { headers: { get: () => null }, body: { getReader: () => ({ read: async () => chunks.length ? { done: false, value: chunks.shift() } : { done: true }, cancel: async () => { cancelled = true; }, releaseLock() {} }) } };
  await assert.rejects(route.readBoundedResponse(streamResponse, 10), /size limit/); assert.equal(cancelled, true);
  await assert.rejects(route.readBoundedResponse(response('x'.repeat(20)), 10), /size limit/);
  await assert.rejects(route.readBoundedResponse(response('', { headers: { 'content-length': '20' } }), 10), /size limit/);
});

test('stalled fetch is abortable and proxy URLs and secrets never enter JSON', async () => {
  const timeoutResult = await withEnvFetch({ CRON_SECRET: secret }, (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }), () => route.probeDcRegsForTest('https://dcregs.dc.gov/slow', { timeoutMs: 5 }));
  assert.equal(timeoutResult.contentValidation.kind, 'timeout');
  await withEnvFetch({ CRON_SECRET: secret, SCRAPINGBEE_API_KEY: 'bee-super-secret' }, async (url, options) => {
    const value = String(url);
    if (value.includes('app.scrapingbee.com')) throw new Error(`upstream failed ${value}`);
    return response('<html>Access denied verify you are human</html>', { url: value });
  }, async () => {
    const out = res(); await route.default(request(), out); const json = JSON.stringify(out.body);
    assert.doesNotMatch(json, /bee-super-secret|api_key=|app\.scrapingbee\.com/);
  });
  await withEnvFetch({ CRON_SECRET: secret, SCRAPINGBEE_API_KEY: 'bee-super-secret' }, async url => {
    const value = String(url);
    if (value.includes('app.scrapingbee.com')) return response(home, { url: value });
    return response('<html>Access denied verify you are human</html>', { url: value });
  }, async () => {
    const out = res(); await route.default(request(), out); const json = JSON.stringify(out.body);
    assert.doesNotMatch(json, /bee-super-secret|api_key=|app\.scrapingbee\.com/);
    assert.ok(out.body.scrapingBee.normal.every(item => !item.finalUrl.includes('scrapingbee')));
  });
  const source = fs.readFileSync(routePath, 'utf8');
  assert.match(source, /AbortController/); assert.match(source, /controller\.abort\(\)/);
});

test('route is read-only and API function count remains bounded', () => {
  const source = fs.readFileSync(routePath, 'utf8');
  assert.doesNotMatch(source, /SUPABASE|tracked_items|\.from\(|rest\/v1|method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i);
  assert.doesNotMatch(source, /console\.(?:log|error|warn)/);
  assert.ok(fs.readdirSync(path.join(root, 'api')).filter(name => name.endsWith('.js')).length <= 12);
});
