const HOME = 'https://www.dcregs.dc.gov/';
const NOTICES = ['N146539', 'N146506'].map(id => `https://dcregs.dc.gov/Common/NoticeDetail.aspx?NoticeId=${id}`);
const ISSUE_DATE = '9/18/2026';
const HOSTS = new Set(['dcregs.dc.gov', 'www.dcregs.dc.gov']);
const LIMIT = 2_000_000;
const TIMEOUT = 12_000;
const CAPS = { browse: 2, issues: 2, categories: 6, samples: 10 };
const FETCH_CLEANUP = Symbol('fetchCleanup');

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers?.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  const counts = { totalHttpRequests: 0, scrapingBeeRequests: 0, renderedScrapingBeeRequests: 0 };
  const key = process.env.SCRAPINGBEE_API_KEY;
  const probes = await Promise.all([HOME, ...NOTICES].map(url => probeFallback(url, key, counts)));
  const pages = probes.map(p => p.success).filter(Boolean);
  const knownNoticeParsing = NOTICES.map(targetUrl => {
    const page = pages.find(p => p.targetUrl === targetUrl);
    return { targetUrl, source: page?.mode || null, success: Boolean(page), metadata: page ? parseNoticeMetadata(page.body, targetUrl) : null };
  });
  const viewText = await inspectDocuments(knownNoticeParsing, pages, key, counts);
  const issueDiscovery = await discoverIssue(pages.find(p => p.targetUrl === HOME), key, counts);
  const direct = probes.map(p => expose(p.direct));
  const scrapingBee = key ? {
    configured: true,
    normal: probes.map(p => p.normal).filter(Boolean).map(expose),
    rendered: probes.map(p => p.rendered).filter(Boolean).map(expose)
  } : { configured: false, status: 'not configured', normal: [], rendered: [] };
  return res.status(200).json({
    probe: 'dcregs-read-only-feasibility', direct, scrapingBee, knownNoticeParsing, viewText, issueDiscovery,
    requestCounts: counts,
    conclusion: {
      directFetchViable: direct.every(p => p.contentValidation.realContent),
      proxyRequired: direct.some(p => !p.contentValidation.realContent) && Boolean(key),
      issueEnumerationViable: issueDiscovery.success,
      noticeDetailViable: knownNoticeParsing.every(p => p.success && p.metadata?.noticeId),
      noticeTextViable: viewText.some(p => p.fetch?.actualDocument)
    },
    safeguards: { readOnly: true, persistentWrites: false, rawHtmlReturned: false }
  });
}

async function probeFallback(url, key, counts, rendered = true) {
  const direct = await probe(url, 'direct', key, counts, false);
  if (direct.contentValidation.realContent || !key) return { direct, success: direct.contentValidation.realContent ? direct : null };
  const normal = await probe(url, 'proxy', key, counts, false);
  if (normal.contentValidation.realContent || !rendered) return { direct, normal, success: normal.contentValidation.realContent ? normal : null };
  const render = await probe(url, 'proxy', key, counts, true);
  return { direct, normal, rendered: render, success: render.contentValidation.realContent ? render : null };
}

async function probe(value, mode, key, counts, renderJs, timeout = TIMEOUT) {
  const targetUrl = allowedDcRegsUrl(value);
  if (!targetUrl) return failed('url-rejected', 'Target URL rejected');
  try {
    const result = mode === 'proxy'
      ? await proxyRequest(targetUrl, key, renderJs, counts, timeout)
      : await directRequest(targetUrl, counts, timeout);
    const data = await readBoundedResponse(result.response, LIMIT);
    const body = new TextDecoder().decode(data.bytes);
    return {
      mode: mode === 'proxy' ? (renderJs ? 'scrapingbee-rendered' : 'scrapingbee-normal') : 'direct',
      targetUrl, status: result.response.status, finalUrl: result.finalUrl,
      contentType: result.response.headers?.get?.('content-type') || null,
      characterLength: body.length, byteLength: data.byteLength,
      contentValidation: classifyDcRegsResponse(body, result.response.status, targetUrl), body
    };
  } catch (error) {
    const kind = error.code === 'SIZE' ? 'response-too-large' : error.code === 'URL' ? 'url-rejected' : error.name === 'AbortError' ? 'timeout' : 'request-error';
    return { ...failed(kind, safeError(error, key)), mode: mode === 'proxy' ? (renderJs ? 'scrapingbee-rendered' : 'scrapingbee-normal') : 'direct', targetUrl, finalUrl: targetUrl };
  }
}

export async function probeDcRegsForTest(value, { timeoutMs = TIMEOUT } = {}) {
  return probe(value, 'direct', null, { totalHttpRequests: 0, scrapingBeeRequests: 0, renderedScrapingBeeRequests: 0 }, false, timeoutMs);
}

async function directRequest(value, counts, timeout) {
  let url = allowedDcRegsUrl(value);
  if (!url) throw coded('URL rejected', 'URL');
  for (let hop = 0; hop <= 3; hop++) {
    const response = await timedFetch(url, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': 'DCPCA-DCRegs-Feasibility/1.0' } }, counts, timeout);
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: url };
    response[FETCH_CLEANUP]?.();
    if (hop === 3) throw coded('Redirect limit exceeded', 'URL');
    url = allowedDcRegsUrl(response.headers?.get?.('location'), url);
    if (!url) throw coded('Redirect target rejected', 'URL');
  }
}

async function proxyRequest(target, key, render, counts, timeout) {
  if (!key) throw new Error('ScrapingBee not configured');
  const params = new URLSearchParams({ api_key: key, url: target });
  if (render) { params.set('render_js', 'true'); params.set('wait', '5000'); }
  counts.scrapingBeeRequests++;
  if (render) counts.renderedScrapingBeeRequests++;
  const response = await timedFetch(`https://app.scrapingbee.com/api/v1/?${params}`, { method: 'GET', redirect: 'manual' }, counts, timeout);
  return { response, finalUrl: target };
}

async function timedFetch(url, options, counts, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  counts.totalHttpRequests++;
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    response[FETCH_CLEANUP] = () => clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

export async function readBoundedResponse(response, max = LIMIT) {
  try {
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > max) throw coded('Response exceeded size limit', 'SIZE');
    const chunks = []; let total = 0;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > max) { await reader.cancel(); throw coded('Response exceeded size limit', 'SIZE'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock?.(); }
    } else {
      const bytes = new Uint8Array(await response.arrayBuffer());
      total = bytes.byteLength;
      if (total > max) throw coded('Response exceeded size limit', 'SIZE');
      chunks.push(bytes);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { bytes, byteLength: total };
  } finally {
    response[FETCH_CLEANUP]?.();
  }
}

export function allowedDcRegsUrl(value, base = HOME) {
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' && HOSTS.has(url.hostname.toLowerCase()) && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

export function classifyDcRegsResponse(html, status, targetUrl = '') {
  const text = String(html || ''); const lower = text.toLowerCase();
  const markers = {
    dcRegsTitle: /district of columbia municipal regulations|district of columbia register/i.test(text),
    noticeId: /notice\s*id|noticeid/i.test(text), noticeDetail: /noticedetail\.aspx/i.test(text),
    issueBrowse: /browse through dcr issues/i.test(text),
    registerSearch: /search\s+(?:the\s+)?district of columbia register|search\s+by\s+(?:agency|council|notice id|section number)/i.test(text),
    aspNet: /__viewstate|__eventtarget|\.aspx/i.test(text)
  };
  const blockSignals = ['access denied', 'captcha', 'cloudflare', 'attention required', 'verify you are human', 'request blocked', 'incapsula'].filter(token => lower.includes(token));
  const generic = /internal server error|runtime error|server error in '\/' application|service unavailable/i.test(lower);
  const empty = text.trim().length < 40;
  const ok = status >= 200 && status < 300;
  const parsedTarget = allowedDcRegsUrl(targetUrl);
  const isNoticeDetail = Boolean(parsedTarget && /\/NoticeDetail\.aspx$/i.test(new URL(parsedTarget).pathname));
  const isHomepage = parsedTarget === HOME;
  const expectedNoticeId = isNoticeDetail ? new URL(parsedTarget).searchParams.get('NoticeId')?.toUpperCase() || null : null;
  const metadata = isNoticeDetail ? parseNoticeMetadata(text, parsedTarget) : null;
  const expectedNoticeIdMatched = expectedNoticeId ? metadata?.noticeId?.toUpperCase() === expectedNoticeId && new RegExp(escapeRegex(expectedNoticeId), 'i').test(text) : null;
  const coreNoticeFields = metadata ? [metadata.registerCategory, metadata.agency, metadata.registerIssue, metadata.publishDate].filter(Boolean).length : 0;
  let structuralValidationType = 'dc-register-discovery';
  let structuralValid = markers.dcRegsTitle && markers.aspNet && (markers.issueBrowse || /(?:IssueID|CategoryID|NoticeId)=/i.test(text));
  if (isHomepage) {
    structuralValidationType = 'dc-register-homepage';
    structuralValid = markers.dcRegsTitle && (markers.issueBrowse || markers.registerSearch) && markers.aspNet;
  } else if (isNoticeDetail) {
    structuralValidationType = 'dc-register-notice-detail';
    structuralValid = markers.dcRegsTitle && (markers.noticeDetail || markers.noticeId) && expectedNoticeIdMatched && coreNoticeFields >= 3;
  }
  const realContent = ok && !empty && structuralValid;
  const kind = realContent ? 'real-content' : !ok ? 'http-error' : empty ? 'empty' : blockSignals.length ? 'challenge-or-block' : generic ? 'generic-error' : 'unexpected-content';
  return { realContent, kind, structuralValidationType, structuralValid, blockSignals, expectedNoticeId, expectedNoticeIdMatched, markers };
}

export function parseNoticeMetadata(html, source = '') {
  const fields = fieldsFrom(html);
  const noticeId = first(fields, ['notice id', 'noticeid']) || match(html, /NoticeId=([Nn]\d+)/i)?.toUpperCase() || null;
  const registerIssue = first(fields, ['register issue', 'd.c. register issue', 'dc register issue']);
  const issue = registerIssue?.match(/(\d{1,2}\/\d{1,2}\/\d{4}).*?Vol\s*\.?\s*(\d+)\s*\/\s*(\d+)/i);
  return {
    noticeId, title: first(fields, ['subject', 'title', 'notice title']) || clean(match(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) || match(html, /<title[^>]*>([\s\S]*?)<\/title>/i)) || null,
    registerCategory: first(fields, ['register category', 'category']), subCategory: first(fields, ['sub category', 'subcategory']),
    agency: first(fields, ['agency', 'agency or council']), registerIssue: registerIssue || null,
    issueDate: issue?.[1] || match(registerIssue, /(\d{1,2}\/\d{1,2}\/\d{4})/), volume: issue?.[2] || null, issueNumber: issue?.[3] || null,
    publishDate: first(fields, ['publish date', 'publication date']),
    canonicalUrl: noticeId ? `https://dcregs.dc.gov/Common/NoticeDetail.aspx?NoticeId=${noticeId}` : allowedDcRegsUrl(source),
    viewTextTargets: extractViewTargets(html, source).accepted
  };
}

function fieldsFrom(html) {
  const map = new Map();
  const cells = /<(?:td|th|span|label)[^>]*>([\s\S]*?)<\/(?:td|th|span|label)>\s*<(?:td|span)[^>]*>([\s\S]*?)<\/(?:td|span)>/gi;
  for (const m of String(html || '').matchAll(cells)) { const k = clean(m[1]).replace(/:$/, '').toLowerCase(); const v = clean(m[2]); if (k && v) map.set(k, v); }
  return map;
}
function first(map, names) { for (const name of names) if (map.get(name)) return map.get(name); return null; }
function clean(value) { return String(value || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim(); }
function match(value, regex) { return String(value || '').match(regex)?.[1] || null; }

function extractViewTargets(html, base) {
  const raw = [];
  for (const m of String(html || '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (!/view\s*text|view\s*(?:document|pdf)|download/i.test(clean(m[2]) + ' ' + m[1])) continue;
    const href = match(m[1], /href\s*=\s*["']([^"']+)["']/i); if (href && !/^javascript:/i.test(href)) raw.push(href);
    const popup = match(m[1], /(?:window\.open|open)\s*\(\s*["']([^"']+)["']/i); if (popup) raw.push(popup);
  }
  return validate(raw, base, 5);
}

async function inspectDocuments(parsed, pages, key, counts) {
  const output = [];
  for (const item of parsed) {
    const page = pages.find(p => p.targetUrl === item.targetUrl);
    const targets = extractViewTargets(page?.body, item.targetUrl);
    const rawAction = match(page?.body, /<form\b[^>]*action\s*=\s*["']([^"']+)["']/i);
    const formAction = rawAction ? allowedDcRegsUrl(rawAction, item.targetUrl) : null;
    const result = { noticeId: item.metadata?.noticeId || null, identified: targets.accepted.length > 0,
      targets: targets.accepted, rejectedTargets: targets.rejected, formAction, formActionRejected: Boolean(rawAction && !formAction), fetch: null };
    if (targets.accepted[0]) result.fetch = await documentProbe(targets.accepted[0], key, counts);
    output.push(result);
  }
  return output;
}

async function documentProbe(url, key, counts) {
  try {
    const result = await directRequest(url, counts, TIMEOUT);
    const data = await readBoundedResponse(result.response, LIMIT);
    const type = result.response.headers?.get?.('content-type') || null;
    const prefix = new TextDecoder().decode(data.bytes.slice(0, 200));
    return { status: result.response.status, finalUrl: result.finalUrl, contentType: type, bytesRead: data.byteLength,
      actualDocument: result.response.ok && (/pdf|msword|officedocument|text\/plain/i.test(type || '') || prefix.startsWith('%PDF')) };
  } catch (error) { return { status: null, finalUrl: url, contentType: null, bytesRead: 0, actualDocument: false, error: safeError(error, key) }; }
}

async function discoverIssue(home, key, counts) {
  const base = { success: false, issueDate: ISSUE_DATE, issueIdentified: false, issueId: null, targetIssueUrl: null,
    identification: [], browseUrls: [], targetIssueUrls: [], categoryUrls: [], categoryUrlsAccepted: 0, categoryUrlsRejected: 0,
    targetPagesFetched: 0, noticesFromTargetIssue: 0, categories: [], noticeCount: 0, sampleNotices: [] };
  if (!home) return { ...base, reason: 'No validated homepage response' };
  const initial = issueLinks(home.body, home.targetUrl);
  const browse = browseLinks(home.body, home.targetUrl);
  const browsePages = [];
  for (const url of browse.accepted.slice(0, CAPS.browse)) { const p = await validatedPage(url, key, counts); if (p) browsePages.push(p); }
  const discoveries = [{ ...initial, source: 'homepage' }, ...browsePages.map(p => ({ ...issueLinks(p.body, p.targetUrl), source: p.targetUrl }))];
  const targetUrls = [...new Set(discoveries.flatMap(d => d.accepted))].slice(0, CAPS.issues);
  const issueId = discoveries.map(d => d.issueId).find(Boolean) || null;
  const identified = Boolean(issueId || targetUrls.length === 1);
  const identification = discoveries.filter(d => d.issueId || d.accepted.length).map(d => ({ source: d.source, mechanisms: d.mechanisms }));
  if (!identified) return { ...base, browseUrls: browse.accepted.slice(0, CAPS.browse), identification, reason: 'September 18, 2026 issue was not positively identified' };
  const targetPages = [];
  for (const url of targetUrls) { const p = await validatedPage(url, key, counts); if (p) targetPages.push(p); }
  const categoryResults = targetPages.map(p => categoryLinks(p.body, p.targetUrl));
  const categoryAccepted = unique(categoryResults.flatMap(r => r.items), item => item.url);
  const selectedCategories = categoryAccepted.slice(0, CAPS.categories);
  const categoryPages = [];
  for (const category of selectedCategories) { const p = await validatedPage(category.url, key, counts); if (p) categoryPages.push({ ...p, category: category.label }); }
  const notices = unique([...targetPages, ...categoryPages].flatMap(p => noticeLinks(p.body, p.targetUrl).map(n => ({ ...n, category: n.category || p.category || null }))), n => n.noticeId);
  const success = identified && targetPages.length + categoryPages.length > 0 && notices.length > 0;
  return { ...base, success, issueIdentified: identified, issueId, targetIssueUrl: targetUrls[0] || null, identification,
    browseUrls: browse.accepted.slice(0, CAPS.browse), targetIssueUrls: targetUrls, categoryUrls: selectedCategories.map(c => c.url),
    categoryUrlsAccepted: categoryAccepted.length, categoryUrlsRejected: categoryResults.reduce((n, r) => n + r.rejected, 0),
    targetPagesFetched: targetPages.length + categoryPages.length, noticesFromTargetIssue: notices.length,
    categories: [...new Set([...selectedCategories.map(c => c.label), ...notices.map(n => n.category)].filter(Boolean))],
    noticeCount: notices.length, sampleNotices: notices.slice(0, CAPS.samples),
    reason: success ? null : targetPages.length + categoryPages.length === 0 ? 'No target issue or category page was successfully fetched' : 'No notices were enumerated from the target issue chain' };
}

async function validatedPage(url, key, counts) { return (await probeFallback(url, key, counts)).success; }
function browseLinks(html, base) {
  const raw = [];
  for (const a of anchors(html)) if (/browse through dcr issues|dcr issues/i.test(a.text) || /Issue(?:Category)?List\.aspx/i.test(a.href)) raw.push(a.href);
  const action = match(html, /<form\b[^>]*action\s*=\s*["']([^"']+)["']/i); if (action && /Issue(?:Category)?List\.aspx/i.test(action)) raw.push(action);
  return validate(raw, base);
}
function issueLinks(html, base) {
  const raw = []; const mechanisms = []; const date = /9\/18\/2026|September\s+18,?\s+2026/i;
  for (const a of anchors(html)) if (date.test(a.text + ' ' + a.attrs)) { if (a.href && !/^javascript:/i.test(a.href)) { raw.push(a.href); mechanisms.push('link'); } const popup = match(a.attrs, /(?:window\.open|open)\s*\(\s*["']([^"']+)/i); if (popup) { raw.push(popup); mechanisms.push('onclick'); } }
  const accepted = validate(raw, base);
  const issueId = match(accepted.accepted.join(' '), /[?&]IssueI[Dd]=([^&]+)/i);
  return { ...accepted, issueId, mechanisms };
}
function categoryLinks(html, base) {
  const items = []; let rejected = 0;
  for (const a of anchors(html)) if (/(?:CategoryID|CategoryId)=|CategoryNoticeList\.aspx/i.test(a.href)) { const url = allowedDcRegsUrl(a.href, base); if (url) items.push({ url, label: a.text || null }); else rejected++; }
  return { items: unique(items, i => i.url), rejected };
}
function noticeLinks(html, base) {
  const out = [];
  for (const a of anchors(html)) { const url = allowedDcRegsUrl(a.href, base); const id = url && match(url, /NoticeId=([Nn]\d+)/i)?.toUpperCase(); if (id) out.push({ noticeId: id, title: a.text, category: null, agency: null, detailUrl: url }); }
  return out;
}
function anchors(html) { return [...String(html || '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(m => ({ attrs: m[1], href: match(m[1], /href\s*=\s*["']([^"']+)/i) || '', text: clean(m[2]) })); }
function validate(values, base, cap = Infinity) { const accepted = []; let rejected = 0; for (const value of values) { const url = allowedDcRegsUrl(value, base); if (!url) rejected++; else if (!accepted.includes(url) && accepted.length < cap) accepted.push(url); } return { accepted, rejected }; }
function unique(items, key) { const seen = new Set(); return items.filter(item => { const k = key(item); return k && !seen.has(k) && seen.add(k); }); }
function expose({ body, ...safe }) { return safe; }
function failed(kind, error) { return { mode: null, targetUrl: null, status: null, finalUrl: null, contentType: null, characterLength: 0, byteLength: 0, contentValidation: { realContent: false, kind, markers: {} }, error, body: '' }; }
function coded(message, code) { const error = new Error(message); error.code = code; return error; }
function safeError(error, key) { let text = error instanceof Error ? error.message : 'Request failed'; text = text.replace(/https:\/\/app\.scrapingbee\.com\/[^\s"']*/gi, '[scrapingbee-url-redacted]').replace(/api_key=[^&\s]+/gi, 'api_key=[redacted]'); if (key) text = text.split(key).join('[redacted]'); return text.slice(0, 300); }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
