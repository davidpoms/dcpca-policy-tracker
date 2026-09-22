import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {}
  };

  res.status = (code) => {
    res.statusCode = code;
    return res;
  };

  res.json = (payload) => {
    res.body = payload;
    return payload;
  };

  res.setHeader = (name, value) => {
    res.headers[name] = value;
    return value;
  };

  res.getHeader = (name) => res.headers[name];

  return res;
}

function readRepoText(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function collectApiFiles() {
  const apiDir = path.join(projectRoot, 'api');
  return fs.readdirSync(apiDir)
    .filter((file) => file.endsWith('.js'))
    .sort();
}

async function importFresh(relativePath, envValues = {}) {
  const previousValues = {};
  for (const [key] of Object.entries(envValues)) {
    previousValues[key] = process.env[key];
    if (envValues[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = envValues[key];
    }
  }

  const filePath = path.join(projectRoot, relativePath);
  const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}-${Math.random()}`;
  const imported = await import(moduleUrl);

  for (const [key, existingValue] of Object.entries(previousValues)) {
    if (existingValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = existingValue;
    }
  }

  return imported.default;
}

async function importFreshModule(relativePath, envValues = {}) {
  const previousValues = {};
  for (const [key] of Object.entries(envValues)) {
    previousValues[key] = process.env[key];
    if (envValues[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = envValues[key];
    }
  }

  const filePath = path.join(projectRoot, relativePath);
  const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}-${Math.random()}`;
  const imported = await import(moduleUrl);

  for (const [key, existingValue] of Object.entries(previousValues)) {
    if (existingValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = existingValue;
    }
  }

  return imported;
}

async function withEnv(envValues, callback) {
  const previousValues = {};

  for (const key of Object.keys(envValues)) {
    previousValues[key] = process.env[key];
    if (envValues[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = envValues[key];
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, existingValue] of Object.entries(previousValues)) {
      if (existingValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = existingValue;
      }
    }
  }
}

test('api/check-password.js rejects a wrong password', async () => {
  const handler = await importFresh('api/check-password.js');
  const req = { method: 'POST', body: { password: 'wrong-password' } };
  const res = makeRes();

  await withEnv({ APP_PASSWORD: 'correct-password' }, async () => {
    await handler(req, res);
  });

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'Incorrect password');
  assert.ok(!('APP_PASSWORD' in res.body));
  assert.ok(!('CRON_SECRET' in res.body));
  assert.ok(!res.body.token);
});

test('api/check-password.js accepts the configured APP_PASSWORD and sets a signed session cookie', async () => {
  const handler = await importFresh('api/check-password.js');

  const req1 = { method: 'POST', body: { password: 'correct-password' } };
  const req2 = { method: 'POST', body: { password: 'correct-password' } };
  const res1 = makeRes();
  const res2 = makeRes();

  await withEnv({
    APP_PASSWORD: 'correct-password',
    SESSION_SECRET: 'test-session-secret'
  }, async () => {
    await handler(req1, res1);
    await handler(req2, res2);
  });

  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
  assert.equal(typeof res1.body.expires, 'number');
  assert.equal(typeof res2.body.expires, 'number');
  assert.ok(Math.abs(res1.body.expires - (Date.now() + 8 * 60 * 60 * 1000)) < 60 * 1000);
  assert.ok(Math.abs(res2.body.expires - (Date.now() + 8 * 60 * 60 * 1000)) < 60 * 1000);
  assert.ok(!('APP_PASSWORD' in res1.body));
  assert.ok(!('CRON_SECRET' in res1.body));
  assert.ok(!('APP_PASSWORD' in res2.body));
  assert.ok(!('CRON_SECRET' in res2.body));
  assert.ok(!('token' in res1.body));
  assert.ok(!('token' in res2.body));
  assert.ok(res1.headers['Set-Cookie']);
  assert.match(res1.headers['Set-Cookie'], /dc_tracker_session=/i);
  assert.match(res1.headers['Set-Cookie'], /HttpOnly/i);
  assert.match(res1.headers['Set-Cookie'], /SameSite=Strict/i);
  assert.notEqual(res1.headers['Set-Cookie'], res2.headers['Set-Cookie']);
});

test('api/check-password.js never returns secret values in the response body', async () => {
  const handler = await importFresh('api/check-password.js');

  const req = { method: 'POST', body: { password: 'correct-password' } };
  const res = makeRes();

  await withEnv({
    APP_PASSWORD: 'correct-password',
    SESSION_SECRET: 'super-secret-value',
    CRON_SECRET: 'cron-secret-value'
  }, async () => {
    await handler(req, res);
  });

  const responseText = JSON.stringify(res.body);
  assert.doesNotMatch(responseText, /correct-password/i);
  assert.doesNotMatch(responseText, /super-secret-value/i);
  assert.doesNotMatch(responseText, /cron-secret-value/i);
  assert.doesNotMatch(responseText, /APP_PASSWORD|CRON_SECRET|SESSION_SECRET/i);
});

test('server session helpers accept a valid signed session and reject tampered, expired, or malformed values', async () => {
  const moduleNamespace = await importFreshModule('lib/session.js');
  const { createSignedSession, validateSignedSession, getSessionCookieValue } = moduleNamespace;

  await withEnv({ SESSION_SECRET: 'session-secret-for-tests' }, async () => {
    const validValue = createSignedSession(Date.now() + 60 * 60 * 1000);
    const valid = validateSignedSession(validValue);
    assert.equal(valid.valid, true);
    assert.equal(typeof valid.expires, 'number');

    const toggleChar = validValue.slice(-1) === 'A' ? 'B' : 'A';
    const tampered = validValue.slice(0, -1) + toggleChar;
    assert.equal(validateSignedSession(tampered).valid, false);
    assert.equal(validateSignedSession('not-a-real-cookie').valid, false);

    const expired = createSignedSession(Date.now() - 1000);
    assert.equal(validateSignedSession(expired).valid, false);

    const req = {
      headers: {
        cookie: `dc_tracker_session=${encodeURIComponent(validValue)}; other=value`
      }
    };

    assert.equal(getSessionCookieValue(req), validValue);
  });
});

test('api/session.js validates real sessions and rejects missing or invalid ones', async () => {
  const sessionHandler = await importFresh('api/session.js');
  const moduleNamespace = await importFreshModule('lib/session.js');
  const { createSignedSession } = moduleNamespace;

  await withEnv({ SESSION_SECRET: 'real-session-secret' }, async () => {
    const validReq = { method: 'GET', headers: { cookie: `dc_tracker_session=${encodeURIComponent(createSignedSession(Date.now() + 60 * 1000))}` } };
    const validRes = makeRes();
    await sessionHandler(validReq, validRes);
    assert.equal(validRes.statusCode, 200);
    assert.equal(validRes.body.valid, true);
    assert.equal(typeof validRes.body.expires, 'number');
    assert.ok(!('cookie' in validRes.body));

    const invalidRes = makeRes();
    await sessionHandler({ method: 'GET', headers: { } }, invalidRes);
    assert.equal(invalidRes.statusCode, 401);

    const tamperedRes = makeRes();
    const tamperedValue = createSignedSession(Date.now() + 60 * 1000);
    const tampered = tamperedValue.slice(0, -1) + (tamperedValue.slice(-1) === 'A' ? 'B' : 'A');
    await sessionHandler({ method: 'GET', headers: { cookie: `dc_tracker_session=${encodeURIComponent(tampered)}` } }, tamperedRes);
    assert.equal(tamperedRes.statusCode, 401);
  });
});

test('api/hello.js returns 500 without LIMS_API_KEY and does not fetch upstream', async () => {
  const handler = await importFresh('api/hello.js');
  const originalFetch = global.fetch;
  let fetchCalled = false;

  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called when LIMS_API_KEY is missing');
  };

  try {
    await withEnv({ LIMS_API_KEY: undefined }, async () => {
      const req = { method: 'POST', body: { endpoint: '/SomeEndpoint', method: 'GET' } };
      const res = makeRes();

      await handler(req, res);

      assert.equal(res.statusCode, 500);
      assert.equal(res.body.error, 'LIMS configuration unavailable');
      const responseText = JSON.stringify(res.body);
      assert.doesNotMatch(responseText, /LIMS_API_KEY|Authorization/i);
      assert.equal(fetchCalled, false);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('api/check-password.js returns 500 when SESSION_SECRET is missing', async () => {
  const handler = await importFresh('api/check-password.js');

  const req = { method: 'POST', body: { password: 'correct-password' } };
  const res = makeRes();

  await withEnv({
    APP_PASSWORD: 'correct-password',
    SESSION_SECRET: undefined,
    CRON_SECRET: 'cron-secret-value'
  }, async () => {
    await handler(req, res);
  });

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'Session configuration unavailable');
  assert.doesNotMatch(JSON.stringify(res.body), /SESSION_SECRET|correct-password|cron-secret-value|APP_PASSWORD|CRON_SECRET/i);
});

test('api/session.js returns 500 when SESSION_SECRET is missing with no cookie or malformed cookie', async () => {
  const handler = await importFresh('api/session.js', {
    SESSION_SECRET: undefined,
    APP_PASSWORD: 'app-password',
    CRON_SECRET: 'cron-secret-value'
  });

  const noCookieRes = makeRes();
  await handler({ method: 'GET', headers: {} }, noCookieRes);
  assert.equal(noCookieRes.statusCode, 500);
  assert.equal(noCookieRes.body.error, 'Session configuration unavailable');
  assert.doesNotMatch(JSON.stringify(noCookieRes.body), /SESSION_SECRET|APP_PASSWORD|CRON_SECRET|app-password|cron-secret-value/i);

  const malformedCookieRes = makeRes();
  await handler({ method: 'GET', headers: { cookie: 'dc_tracker_session=not-valid' } }, malformedCookieRes);
  assert.equal(malformedCookieRes.statusCode, 500);
  assert.equal(malformedCookieRes.body.error, 'Session configuration unavailable');
  assert.doesNotMatch(JSON.stringify(malformedCookieRes.body), /SESSION_SECRET|APP_PASSWORD|CRON_SECRET|not-valid|app-password|cron-secret-value/i);
});

test('api/logout.js clears the session cookie', async () => {
  const handler = await importFresh('api/logout.js', { SESSION_SECRET: 'logout-secret' });
  const req = { method: 'POST' };
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.headers['Set-Cookie'], /dc_tracker_session=/i);
  assert.match(res.headers['Set-Cookie'], /Max-Age=0/i);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('api/client-config.js does not expose SESSION_SECRET', async () => {
  const handler = await importFresh('api/client-config.js');

  await withEnv({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
    SESSION_SECRET: 'super-secret-session-value'
  }, async () => {
    const req = { method: 'GET' };
    const res = makeRes();

    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ['SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_URL']);
    assert.ok(!('SESSION_SECRET' in res.body));
  });
});

test('api/client-config.js returns only the required browser config values', async () => {
  const handler = await importFresh('api/client-config.js');

  await withEnv({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
    SUPABASE_SERVICE_KEY: 'service-key',
    CRON_SECRET: 'cron-secret',
    APP_PASSWORD: 'app-password',
    AZURE_CLIENT_ID: 'azure-client',
    GMAIL_PASSWORD: 'gmail-password'
  }, async () => {
    const req = { method: 'GET' };
    const res = makeRes();

    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ['SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_URL']);
    assert.equal(res.body.SUPABASE_URL, 'https://example.supabase.co');
    assert.equal(res.body.SUPABASE_PUBLISHABLE_KEY, 'sb_publishable_example');
    assert.ok(!('SUPABASE_SERVICE_KEY' in res.body));
    assert.ok(!('CRON_SECRET' in res.body));
    assert.ok(!('APP_PASSWORD' in res.body));
    assert.ok(!('AZURE_CLIENT_ID' in res.body));
    assert.ok(!('GMAIL_PASSWORD' in res.body));
  });
});

test('api/client-config.js fails when required values are absent', async () => {
  const handler = await importFresh('api/client-config.js');

  const req = { method: 'GET' };

  await withEnv({ SUPABASE_URL: undefined, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example' }, async () => {
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Client configuration is not available');
  });

  await withEnv({ SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: undefined }, async () => {
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Client configuration is not available');
  });
});

test('api/app-data.js guards auth, request payloads, and the eight allowed actions with generic errors', async () => {
  const handler = await importFresh('api/app-data.js');
  const libSession = await importFreshModule('lib/session.js');
  const { createSignedSession } = libSession;

  const validCookie = (expiresAt = Date.now() + 60 * 1000) => `dc_tracker_session=${encodeURIComponent(createSignedSession(expiresAt))}`;

  const appEnv = {
    SESSION_SECRET: 'app-data-secret',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_KEY: 'service-key'
  };

  await withEnv(appEnv, async () => {
    const res405 = makeRes();
    await handler({ method: 'GET', headers: {} }, res405);
    assert.equal(res405.statusCode, 405);
    assert.equal(res405.body.error, 'Method not allowed');

    const goodCookieBeforeSecretRemoval = validCookie();
    const resNoSecret = makeRes();
    await withEnv({ SESSION_SECRET: undefined }, async () => {
      await handler({ method: 'POST', headers: { cookie: goodCookieBeforeSecretRemoval } }, resNoSecret);
    });
    assert.equal(resNoSecret.statusCode, 500);
    assert.equal(resNoSecret.body.error, 'Service unavailable');
    assert.doesNotMatch(JSON.stringify(resNoSecret.body), /SESSION_SECRET|SUPABASE_SERVICE_KEY|SUPABASE_URL/i);

    const resNoSession = makeRes();
    await handler({ method: 'POST', headers: {} }, resNoSession);
    assert.equal(resNoSession.statusCode, 401);
    assert.equal(resNoSession.body.error, 'Unauthorized');

    const validCookieForTamper = validCookie();
    const tamperedCookie = validCookieForTamper.slice(0, -1) + (validCookieForTamper.slice(-1) === 'A' ? 'B' : 'A');
    const resTampered = makeRes();
    await handler({ method: 'POST', headers: { cookie: tamperedCookie } }, resTampered);
    assert.equal(resTampered.statusCode, 401);

    const resExpired = makeRes();
    await handler({ method: 'POST', headers: { cookie: validCookie(Date.now() - 1000) } }, resExpired);
    assert.equal(resExpired.statusCode, 401);

    const resMissingDb = makeRes();
    await withEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_KEY: undefined }, async () => {
      await handler({ method: 'POST', headers: { cookie: validCookie() } }, resMissingDb);
    });
    assert.equal(resMissingDb.statusCode, 500);
    assert.equal(resMissingDb.body.error, 'Service unavailable');
    assert.doesNotMatch(JSON.stringify(resMissingDb.body), /SUPABASE_URL|SUPABASE_SERVICE_KEY/i);

    const resMalformed = makeRes();
    await handler({ method: 'POST', headers: { cookie: validCookie() }, body: '{bad json' }, resMalformed);
    assert.equal(resMalformed.statusCode, 400);
    assert.equal(resMalformed.body.error, 'Invalid request');

    const resUnknown = makeRes();
    await handler({ method: 'POST', headers: { cookie: validCookie() }, body: JSON.stringify({ action: 'unknown.action' }) }, resUnknown);
    assert.equal(resUnknown.statusCode, 400);
    assert.equal(resUnknown.body.error, 'Invalid action');

    const resMissingValue = makeRes();
    await handler({ method: 'POST', headers: { cookie: validCookie() }, body: JSON.stringify({ action: 'agency.add' }) }, resMissingValue);
    assert.equal(resMissingValue.statusCode, 400);
    assert.equal(resMissingValue.body.error, 'Invalid request');

    const resWhitespace = makeRes();
    await handler({ method: 'POST', headers: { cookie: validCookie() }, body: JSON.stringify({ action: 'committee.add', committeeName: '   ' }) }, resWhitespace);
    assert.equal(resWhitespace.statusCode, 400);
    assert.equal(resWhitespace.body.error, 'Invalid request');

    const resKeywordNonString = makeRes();
    await handler({ method: 'POST', headers: { cookie: validCookie() }, body: JSON.stringify({ action: 'keyword.add', keywords: ['alpha', 3] }) }, resKeywordNonString);
    assert.equal(resKeywordNonString.statusCode, 400);
    assert.equal(resKeywordNonString.body.error, 'Invalid request');

    const resKeywordRemoveNonString = makeRes();
    await handler({ method: 'POST', headers: { cookie: validCookie() }, body: JSON.stringify({ action: 'keyword.remove', keyword: 7 }) }, resKeywordRemoveNonString);
    assert.equal(resKeywordRemoveNonString.statusCode, 400);
    assert.equal(resKeywordRemoveNonString.body.error, 'Invalid request');

    const resUnexpected = makeRes();
    await handler({ method: 'POST', headers: { cookie: validCookie() }, body: JSON.stringify({ action: 'sponsor.add', sponsorName: 'Sen. Example', extra: 'x' }) }, resUnexpected);
    assert.equal(resUnexpected.statusCode, 400);
    assert.equal(resUnexpected.body.error, 'Invalid request');

    const resInjection = makeRes();
    await handler({ method: 'POST', headers: { cookie: validCookie() }, body: JSON.stringify({ action: 'keyword.add', keywords: ['alpha'], table: 'tracked_keywords' }) }, resInjection);
    assert.equal(resInjection.statusCode, 400);
    assert.equal(resInjection.body.error, 'Invalid request');
  });
});

test('api/app-data.js executes the exact eight action contracts and activity_log side effects', async () => {
  const handler = await importFresh('api/app-data.js');
  const libSession = await importFreshModule('lib/session.js');
  const { createSignedSession } = libSession;

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method || 'GET',
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers || {}
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => ''
    };
  };

  try {
    await withEnv({
      SESSION_SECRET: 'app-data-secret',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_KEY: 'service-key'
    }, async () => {
      const sessionCookie = `dc_tracker_session=${encodeURIComponent(createSignedSession(Date.now() + 60 * 1000))}`;
      const cases = [
        {
          label: 'keyword.add',
          req: { action: 'keyword.add', keywords: ['Alpha', ' beta ', 'ALPHA', ''] },
          table: 'tracked_keywords',
          method: 'POST',
          body: [{ keyword: 'alpha' }, { keyword: 'beta' }],
          output: { ok: true, added: ['alpha', 'beta'] },
          log: { action: 'keyword_added', item_id: null, item_title: null, details: { keywords: 'alpha, beta' } }
        },
        {
          label: 'keyword.remove',
          req: { action: 'keyword.remove', keyword: ' Beta ' },
          table: 'tracked_keywords',
          method: 'DELETE',
          urlSuffix: '?keyword=eq.beta',
          output: { ok: true, keyword: 'beta' },
          log: { action: 'keyword_removed', item_id: null, item_title: null, details: { keyword: 'beta' } }
        },
        {
          label: 'committee.add',
          req: { action: 'committee.add', committeeName: '  Finance Committee  ' },
          table: 'tracked_committees',
          method: 'POST',
          body: { committee_name: '  Finance Committee  ' },
          output: { ok: true, committeeName: '  Finance Committee  ' },
          log: { action: 'committee_added', item_id: null, item_title: null, details: { committee: '  Finance Committee  ' } }
        },
        {
          label: 'committee.remove',
          req: { action: 'committee.remove', committeeName: 'Finance Committee' },
          table: 'tracked_committees',
          method: 'DELETE',
          urlSuffix: '?committee_name=eq.Finance%20Committee',
          output: { ok: true, committeeName: 'Finance Committee' },
          log: { action: 'committee_removed', item_id: null, item_title: null, details: { committee: 'Finance Committee' } }
        },
        {
          label: 'sponsor.add',
          req: { action: 'sponsor.add', sponsorName: '  Sen. Example  ' },
          table: 'tracked_sponsors',
          method: 'POST',
          body: { sponsor_name: '  Sen. Example  ' },
          output: { ok: true, sponsorName: '  Sen. Example  ' },
          log: { action: 'sponsor_added', item_id: null, item_title: null, details: { sponsor: '  Sen. Example  ' } }
        },
        {
          label: 'sponsor.remove',
          req: { action: 'sponsor.remove', sponsorName: 'Sen. Example' },
          table: 'tracked_sponsors',
          method: 'DELETE',
          urlSuffix: '?sponsor_name=eq.Sen.%20Example',
          output: { ok: true, sponsorName: 'Sen. Example' },
          log: { action: 'sponsor_removed', item_id: null, item_title: null, details: { sponsor: 'Sen. Example' } }
        },
        {
          label: 'agency.add',
          req: { action: 'agency.add', agencyName: ' Agency One ' },
          table: 'tracked_agencies',
          method: 'POST',
          body: { agency_name: 'Agency One' },
          output: { ok: true, agencyName: 'Agency One' }
        },
        {
          label: 'agency.remove',
          req: { action: 'agency.remove', agencyName: 'Agency One' },
          table: 'tracked_agencies',
          method: 'DELETE',
          urlSuffix: '?agency_name=eq.Agency%20One',
          output: { ok: true, agencyName: 'Agency One' }
        }
      ];

      for (const testCase of cases) {
        calls.length = 0;
        const res = makeRes();
        await handler({ method: 'POST', headers: { cookie: sessionCookie }, body: JSON.stringify(testCase.req) }, res);

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, testCase.output);
        assert.equal(calls[0].url, `https://example.supabase.co/rest/v1/${testCase.table}${testCase.urlSuffix || ''}`);

        const targetTableCalls = calls.filter((call) => call.url === `https://example.supabase.co/rest/v1/${testCase.table}${testCase.urlSuffix || ''}`);
        if (testCase.label.endsWith('.add')) {
          assert.equal(targetTableCalls.length, 1);
          assert.equal(targetTableCalls[0].method, 'POST');
          assert.equal(calls.some((call) => call.url === `https://example.supabase.co/rest/v1/${testCase.table}${testCase.urlSuffix || ''}` && call.method === 'DELETE'), false);
        } else {
          assert.equal(targetTableCalls.length, 1);
          assert.equal(targetTableCalls[0].method, 'DELETE');
          assert.equal(calls.some((call) => call.url === `https://example.supabase.co/rest/v1/${testCase.table}${testCase.urlSuffix || ''}` && call.method === 'POST'), false);
        }

        if (testCase.body !== undefined) {
          assert.deepEqual(targetTableCalls[0].body, testCase.body);
        }

        if (testCase.log) {
          assert.equal(calls.length, 2);
          assert.equal(calls[1].url, 'https://example.supabase.co/rest/v1/activity_log');
          assert.equal(calls[1].method, 'POST');
          assert.deepEqual(calls[1].body, testCase.log);
        } else {
          assert.equal(calls.length, 1);
        }

        if (testCase.label.startsWith('agency')) {
          assert.equal(calls.some((call) => call.url.includes('activity_log')), false);
        }
      }
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('api/app-data.js returns a generic 500 when the Supabase write fails', async () => {
  const handler = await importFresh('api/app-data.js');
  const libSession = await importFreshModule('lib/session.js');
  const { createSignedSession } = libSession;
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => 'Supabase failure: SESSION_SECRET=topsecret SUPABASE_SERVICE_KEY=super-secret'
  });

  try {
    await withEnv({
      SESSION_SECRET: 'app-data-secret',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_KEY: 'service-key'
    }, async () => {
      const res = makeRes();
      const cookie = `dc_tracker_session=${encodeURIComponent(createSignedSession(Date.now() + 60 * 1000))}`;
      await handler({ method: 'POST', headers: { cookie }, body: JSON.stringify({ action: 'keyword.add', keywords: ['alpha'] }) }, res);

      assert.equal(res.statusCode, 500);
      assert.equal(res.body.error, 'Service unavailable');
      assert.doesNotMatch(JSON.stringify(res.body), /SESSION_SECRET|SUPABASE_SERVICE_KEY|topsecret|super-secret|Supabase failure/i);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('repository guardrails block historical secret drift and keep the app-data slice within API limits', () => {
  const apiFiles = collectApiFiles().map((file) => `api/${file}`);
  const appFiles = ['index.html', ...apiFiles];
  const appText = appFiles.map((relativePath) => readRepoText(relativePath)).join('\n');

  assert.ok(apiFiles.length <= 12, `Expected /api count <= 12, got ${apiFiles.length}`);
  assert.doesNotMatch(appText, /dcpcapolicyhearingtracker/i);
  assert.doesNotMatch(readRepoText('index.html'), /https:\/\/[^\s"'<>]*\.supabase\.co/i);
  assert.doesNotMatch(readRepoText('index.html'), /sb_publishable_[A-Za-z0-9_-]+/i);
  assert.doesNotMatch(readRepoText('index.html'), /https:\/\/dcpca-policy-tracker\.vercel\.app/i);
  assert.doesNotMatch(readRepoText('api/build-bill-cache.js'), /https:\/\/dcpca-policy-tracker\.vercel\.app/i);
  assert.doesNotMatch(readRepoText('index.html'), /from\('tracked_keywords'\)\s*\.\s*(insert|delete)|from\('tracked_committees'\)\s*\.\s*(insert|delete)|from\('tracked_sponsors'\)\s*\.\s*(insert|delete)|from\('tracked_agencies'\)\s*\.\s*(insert|delete)/i);

  for (const relativePath of apiFiles) {
    const content = readRepoText(relativePath);
    assert.doesNotMatch(content, /x-vercel-cron/i);
  }
});

test('config-table RLS keeps anon reads and removes anon writes', () => {
  const tables = [
    'tracked_keywords',
    'tracked_committees',
    'tracked_sponsors',
    'tracked_agencies'
  ];
  const canonicalRls = readRepoText('rls-migration.sql');
  const versionedMigration = readRepoText('migrations/2026-09-15-tighten-config-table-rls.sql');
  const appData = readRepoText('api/app-data.js');
  const expectedActions = [
    'keyword.add',
    'keyword.remove',
    'committee.add',
    'committee.remove',
    'sponsor.add',
    'sponsor.remove',
    'agency.add',
    'agency.remove',
    'note.save',
    'note.delete',
    'teamMember.create',
    'teamMember.update',
    'teamMember.delete',
    'trackedItem.assignment.update',
    'trackedItem.priority.update',
    'trackedItem.summary.save',
    'trackedItem.summary.delete',
    'trackedItem.activity.markSeen',
    'trackedItem.track',
    'trackedItem.untrack',
    'trackedItem.manual.create',
    'trackedItem.manual.update',
    'trackedItem.manual.delete',
    'trackedItem.actionStatus.update'
  ];
  const actionBlock = appData.match(/const ALLOWED_ACTIONS = new Set\(\[([\s\S]*?)\]\);/);

  assert.ok(actionBlock);
  assert.deepEqual([...actionBlock[1].matchAll(/'([^']+)'/g)].map((match) => match[1]), expectedActions);

  for (const table of tables) {
    assert.match(canonicalRls, new RegExp(`CREATE POLICY "anon can read ${table}"\\s+ON ${table} FOR SELECT TO anon`));
    assert.doesNotMatch(canonicalRls, new RegExp(`CREATE POLICY "anon can (?:insert|update|delete) ${table}"`));
    assert.doesNotMatch(canonicalRls, new RegExp(`CREATE POLICY "Allow public (?:read access|insert|delete)"\\s+ON ${table}`));

    assert.match(versionedMigration, new RegExp(`DROP POLICY IF EXISTS "anon can insert ${table}" ON ${table}`));
    assert.match(versionedMigration, new RegExp(`DROP POLICY IF EXISTS "anon can update ${table}" ON ${table}`));
    assert.match(versionedMigration, new RegExp(`DROP POLICY IF EXISTS "anon can delete ${table}" ON ${table}`));
    assert.match(versionedMigration, new RegExp(`DROP POLICY IF EXISTS "Allow public read access" ON ${table}`));
    assert.match(versionedMigration, new RegExp(`DROP POLICY IF EXISTS "Allow public insert" ON ${table}`));
    assert.match(versionedMigration, new RegExp(`DROP POLICY IF EXISTS "Allow public delete" ON ${table}`));
    assert.match(versionedMigration, new RegExp(`CREATE POLICY "anon can read ${table}" ON ${table} FOR SELECT TO anon`));
    assert.doesNotMatch(versionedMigration, new RegExp(`CREATE POLICY "anon can (?:insert|update|delete) ${table}"`));
    assert.doesNotMatch(versionedMigration, new RegExp(`CREATE POLICY "Allow public (?:read access|insert|delete)"\\s+ON ${table}`));
  }
});

test('bill-status history RLS keeps anon SELECT and removes browser write policies', () => {
  const canonical = readRepoText('rls-migration.sql');
  const migration = readRepoText('migrations/2026-09-21-tighten-bill-status-history-rls.sql');
  const writePolicy = /CREATE POLICY\s+"[^"]*"\s+ON bill_status_history\s+FOR (?:INSERT|UPDATE|DELETE)\b/i;
  const readPolicy = /CREATE POLICY\s+"anon can read bill_status_history"\s+ON bill_status_history\s+FOR SELECT TO anon USING \(true\)/;
  for (const sql of [canonical, migration]) {
    assert.match(sql, /ALTER TABLE bill_status_history ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /DROP POLICY IF EXISTS "anon can insert bill_status_history"\s+ON bill_status_history/);
    assert.match(sql, readPolicy);
    assert.doesNotMatch(sql, writePolicy);
  }
  assert.match(migration, /DROP POLICY IF EXISTS "anon can read bill_status_history"\s+ON bill_status_history/);

  const appData = readRepoText('api/app-data.js');
  const action = appData.match(/case 'trackedItem\.actionStatus\.update': \{([\s\S]*?)\n      \}/);
  assert.ok(action);
  assert.match(action[1], /supabaseTableRequest\(supabaseUrl, serviceKey, 'bill_status_history', 'POST'/);
  assert.doesNotMatch(readRepoText('index.html'), /\.from\('bill_status_history'\)\s*\.\s*insert\s*\(/);
});

test('item_notes RLS migration keeps anon reads and removes anon/public writes', () => {
  const canonicalRls = readRepoText('rls-migration.sql');
  const versionedMigration = readRepoText('migrations/2026-09-18-tighten-item-notes-rls.sql');

  assert.match(canonicalRls, /ALTER TABLE item_notes ENABLE ROW LEVEL SECURITY;/);
  assert.match(canonicalRls, /DROP POLICY IF EXISTS "anon can read item_notes"\s+ON item_notes;/);
  assert.match(canonicalRls, /DROP POLICY IF EXISTS "anon can upsert item_notes"\s+ON item_notes;/);
  assert.match(canonicalRls, /DROP POLICY IF EXISTS "anon can update item_notes"\s+ON item_notes;/);
  assert.match(canonicalRls, /DROP POLICY IF EXISTS "anon can delete item_notes"\s+ON item_notes;/);
  assert.match(canonicalRls, /DROP POLICY IF EXISTS "Allow public read access"\s+ON item_notes;/);
  assert.match(canonicalRls, /DROP POLICY IF EXISTS "Allow public insert"\s+ON item_notes;/);
  assert.match(canonicalRls, /DROP POLICY IF EXISTS "Allow public update"\s+ON item_notes;/);
  assert.match(canonicalRls, /DROP POLICY IF EXISTS "Allow public delete"\s+ON item_notes;/);
  assert.match(canonicalRls, /CREATE POLICY "anon can read item_notes"\s+ON item_notes FOR SELECT TO anon USING \(true\);/);
  assert.doesNotMatch(canonicalRls, /CREATE POLICY "anon can (?:upsert|insert|update|delete) item_notes"/);
  assert.doesNotMatch(canonicalRls, /CREATE POLICY "Allow public (?:read access|insert|update|delete)"\s+ON item_notes/);

  assert.match(versionedMigration, /DROP POLICY IF EXISTS "anon can upsert item_notes" ON item_notes;/);
  assert.match(versionedMigration, /DROP POLICY IF EXISTS "anon can update item_notes" ON item_notes;/);
  assert.match(versionedMigration, /DROP POLICY IF EXISTS "anon can delete item_notes" ON item_notes;/);
  assert.match(versionedMigration, /DROP POLICY IF EXISTS "anon can read item_notes" ON item_notes;/);
  assert.match(versionedMigration, /DROP POLICY IF EXISTS "Allow public read access" ON item_notes;/);
  assert.match(versionedMigration, /DROP POLICY IF EXISTS "Allow public insert" ON item_notes;/);
  assert.match(versionedMigration, /DROP POLICY IF EXISTS "Allow public update" ON item_notes;/);
  assert.match(versionedMigration, /DROP POLICY IF EXISTS "Allow public delete" ON item_notes;/);
  assert.match(versionedMigration, /CREATE POLICY "anon can read item_notes"\s+ON item_notes\s+FOR SELECT\s+TO anon\s+USING \(true\);/);
  assert.doesNotMatch(versionedMigration, /CREATE POLICY "anon can (?:upsert|insert|update|delete) item_notes"/);
  assert.doesNotMatch(versionedMigration, /CREATE POLICY "Allow public (?:read access|insert|update|delete)"\s+ON item_notes/);
});

test('team_members email reconciliation is additive and leaves IDs, RLS, and added_at unchanged', () => {
  const canonicalMigration = readRepoText('migration.sql');
  const versionedMigration = readRepoText('migrations/2026-09-21-add-team-members-email.sql');
  const teamMembersBlock = canonicalMigration.match(/CREATE TABLE IF NOT EXISTS team_members \(([\s\S]*?)\n\);/);

  assert.ok(teamMembersBlock);
  assert.match(teamMembersBlock[1], /id\s+uuid\s+DEFAULT\s+gen_random_uuid\(\)\s+PRIMARY KEY/);
  assert.match(teamMembersBlock[1], /email\s+text\s*(?:,|$)/);
  assert.doesNotMatch(teamMembersBlock[1], /email\s+text\s+NOT NULL/);
  assert.doesNotMatch(teamMembersBlock[1], /added_at/);

  assert.match(versionedMigration, /ALTER TABLE team_members\s+ADD COLUMN IF NOT EXISTS email text;/);
  assert.doesNotMatch(versionedMigration, /team_members[\s\S]*\bid\b\s+(?:integer|bigint|text)/i);
  assert.doesNotMatch(versionedMigration, /PRIMARY KEY|DROP\s+CONSTRAINT|ALTER\s+COLUMN\s+id/i);
  assert.doesNotMatch(versionedMigration, /CREATE POLICY|DROP POLICY|ENABLE ROW LEVEL SECURITY|DISABLE ROW LEVEL SECURITY/i);
  assert.doesNotMatch(versionedMigration, /added_at/i);
});

test('team_members RLS migrations keep only anon SELECT access', () => {
  const canonicalRls = readRepoText('rls-migration.sql');
  const versionedMigration = readRepoText('migrations/2026-09-21-tighten-team-members-rls.sql');

  for (const source of [canonicalRls, versionedMigration]) {
    assert.match(source, /ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;/);
    assert.match(source, /DROP POLICY IF EXISTS "anon can update team_members" ON team_members;/);
    assert.match(source, /DROP POLICY IF EXISTS "Allow public delete" ON team_members;/);
    assert.match(source, /DROP POLICY IF EXISTS "Allow public insert" ON team_members;/);
    assert.match(source, /DROP POLICY IF EXISTS "Allow public read access" ON team_members;/);
    assert.match(source, /DROP POLICY IF EXISTS "Allow public update" ON team_members;/);
    assert.match(source, /CREATE POLICY "anon can read team_members"\s+ON team_members\s+FOR SELECT\s+TO anon\s+USING \(true\);/);
    assert.doesNotMatch(source, /CREATE POLICY "anon can (?:insert|update|delete) team_members"/);
    assert.doesNotMatch(source, /CREATE POLICY "Allow public (?:read access|insert|update|delete)"\s+ON team_members/);
  }
});

test('api/app-data.js implements opaque-ID team member mutation contracts', async () => {
  const handler = await importFresh('api/app-data.js');
  const libSession = await importFreshModule('lib/session.js');
  const { createSignedSession } = libSession;
  const originalFetch = global.fetch;
  const calls = [];
  let existingMember = { id: 'member-1', name: 'Old Name', email: 'old@example.com', active: true };
  let failureMode = null;

  global.fetch = async (url, init = {}) => {
    const call = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    if (failureMode === 'member-fetch' && url.includes('/team_members?id=')) return { ok: false, status: 500 };
    if (failureMode === 'member-write' && url.includes('/team_members?id=') && call.method === 'PATCH') return { ok: false, status: 500 };
    if (failureMode === 'create' && url.endsWith('/team_members')) return { ok: false, status: 500 };
    if (url.includes('/team_members?id=')) return { ok: true, status: 200, json: async () => [existingMember] };
    if (url.endsWith('/team_members')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url.includes('/tracked_items?')) {
      if (failureMode === 'assignment') return { ok: false, status: 500 };
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (url.endsWith('/activity_log')) {
      if (failureMode === 'activity') return { ok: false, status: 500 };
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  let cookie;
  const invoke = async (body, headers = { cookie }) => {
    const response = makeRes();
    await handler({ method: 'POST', headers, body: JSON.stringify(body) }, response);
    return response;
  };

  try {
    await withEnv({
      SESSION_SECRET: 'app-data-secret',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_KEY: 'service-key'
    }, async () => {
      cookie = `dc_tracker_session=${encodeURIComponent(createSignedSession(Date.now() + 60 * 1000))}`;
      let res = await invoke({ action: 'teamMember.create', name: '  New Name  ', email: '   ' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(calls[0].body, { name: '  New Name  ', email: '   ', active: true });
      assert.deepEqual(calls[1].body, { action: 'team_member_added', item_id: null, item_title: null, details: { name: '  New Name  ' } });

      calls.length = 0;
      failureMode = 'activity';
      res = await invoke({ action: 'teamMember.create', name: 'Name', email: null });
      assert.equal(res.statusCode, 200);
      failureMode = null;

      for (const body of [
        { action: 'teamMember.create', name: '   ', email: null },
        { action: 'teamMember.create', name: 42, email: null },
        { action: 'teamMember.create', name: 'Name', email: 42 },
        { action: 'teamMember.create', name: 'Name', email: null, extra: true }
      ]) {
        res = await invoke(body);
        assert.equal(res.statusCode, 400);
      }

      failureMode = 'create';
      res = await invoke({ action: 'teamMember.create', name: 'Name', email: null });
      assert.equal(res.statusCode, 500);
      assert.equal(res.body.error, 'Service unavailable');
      assert.doesNotMatch(JSON.stringify(res.body), /service-key|SUPABASE_SERVICE_KEY|Supabase/i);
      failureMode = null;

      calls.length = 0;
      existingMember = { id: 'member-1', name: 'Old Name', email: 'old@example.com', active: true };
      res = await invoke({ action: 'teamMember.update', teamMemberId: '550e8400-e29b-41d4-a716-446655440000', name: 'New Name', email: null });
      assert.equal(res.statusCode, 200);
      assert.equal(calls[0].method, 'GET');
      assert.equal(calls[1].method, 'PATCH');
      assert.deepEqual(calls[1].body, { name: 'New Name', email: null });
      assert.match(calls[2].url, /tracked_items\?assigned_to=eq\.Old%20Name$/);
      assert.deepEqual(calls[2].body, { assigned_to: 'New Name' });
      assert.deepEqual(calls[3].body, { action: 'team_member_updated', item_id: null, item_title: null, details: { from: 'Old Name', to: 'New Name' } });

      calls.length = 0;
      res = await invoke({ action: 'teamMember.update', teamMemberId: '42', name: 'Newer Name', email: 'new@example.com' });
      assert.equal(res.statusCode, 200);
      assert.equal(calls[0].url, 'https://example.supabase.co/rest/v1/team_members?id=eq.42&select=id,name,email,active');

      calls.length = 0;
      existingMember = { id: 'member-1', name: 'Newer Name', email: 'new@example.com', active: true };
      res = await invoke({ action: 'teamMember.update', teamMemberId: '42', name: 'Newer Name', email: '   ' });
      assert.equal(res.statusCode, 200);
      assert.equal(calls.some((call) => call.url.includes('/tracked_items?')), false);

      for (const body of [
        { action: 'teamMember.update', teamMemberId: 42, name: 'Name', email: null },
        { action: 'teamMember.update', teamMemberId: '   ', name: 'Name', email: null },
        { action: 'teamMember.update', teamMemberId: '42', name: '   ', email: null },
        { action: 'teamMember.update', teamMemberId: '42', name: 'Name', email: 42 }
      ]) {
        res = await invoke(body);
        assert.equal(res.statusCode, 400);
      }

      failureMode = 'assignment';
      existingMember = { id: 'member-1', name: 'Old Name', email: null, active: true };
      res = await invoke({ action: 'teamMember.update', teamMemberId: '42', name: 'New Name', email: null });
      assert.equal(res.statusCode, 200);
      failureMode = null;

      failureMode = 'member-fetch';
      res = await invoke({ action: 'teamMember.update', teamMemberId: '42', name: 'New Name', email: null });
      assert.equal(res.statusCode, 500);
      assert.equal(res.body.error, 'Service unavailable');
      failureMode = null;

      existingMember = { id: 'member-1', name: 'Delete Me', email: null, active: true };
      calls.length = 0;
      res = await invoke({ action: 'teamMember.delete', teamMemberId: '550e8400-e29b-41d4-a716-446655440000' });
      assert.equal(res.statusCode, 200);
      assert.equal(calls[1].method, 'PATCH');
      assert.deepEqual(calls[1].body, { active: false });
      assert.equal(calls.some((call) => call.method === 'DELETE'), false);
      assert.equal(calls.some((call) => call.url.includes('/tracked_items?')), false);
      assert.deepEqual(calls[2].body, { action: 'team_member_deleted', item_id: null, item_title: null, details: { name: 'Delete Me' } });

      calls.length = 0;
      failureMode = 'activity';
      res = await invoke({ action: 'teamMember.delete', teamMemberId: '42' });
      assert.equal(res.statusCode, 200);
      failureMode = null;

      for (const body of [
        { action: 'teamMember.delete', teamMemberId: 42 },
        { action: 'teamMember.delete', teamMemberId: '   ' },
        { action: 'teamMember.delete', teamMemberId: '42', extra: true }
      ]) {
        res = await invoke(body);
        assert.equal(res.statusCode, 400);
      }

      const unauthenticated = await invoke({ action: 'teamMember.delete', teamMemberId: '42' }, {});
      assert.equal(unauthenticated.statusCode, 401);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('team member frontend mutations use app-data while reads and unrelated item writes remain direct', () => {
  const appText = readRepoText('index.html');

  assert.match(appText, /\.from\('team_members'\)\.select\('\*'\)/);
  assert.doesNotMatch(appText, /from\('team_members'\)\s*\.insert\(/i);
  assert.doesNotMatch(appText, /from\('team_members'\)\s*\.update\(/i);
  assert.match(appText, /action:\s*'teamMember\.create'/);
  assert.match(appText, /action:\s*'teamMember\.update'/);
  assert.match(appText, /action:\s*'teamMember\.delete'/);
  assert.match(appText, /teamMemberId:\s*String\(editingTeamMember\)/);
  assert.match(appText, /teamMemberId:\s*String\(memberId\)/);
  assert.doesNotMatch(appText, /supabase\.from\('tracked_items'\)\.update\(\{ assigned_to: teamMemberForm\.name \}\)/);
  assert.match(appText, /const checkHearingsForTrackedItems = async[\s\S]*?supabase\.from\('tracked_items'\)\.update\(\{\s*hearing_checked_at: now/);
});

test('api/app-data.js implements the five tracked-item metadata action contracts', async () => {
  const handler = await importFresh('api/app-data.js');
  const libSession = await importFreshModule('lib/session.js');
  const { createSignedSession } = libSession;
  const originalFetch = global.fetch;
  const calls = [];
  let failureMode = null;

  global.fetch = async (url, init = {}) => {
    const call = {
      url,
      method: init.method || 'GET',
      body: init.body ? JSON.parse(init.body) : undefined
    };
    calls.push(call);
    if (failureMode === 'tracked-items') return { ok: false, status: 500 };
    if (url.endsWith('/activity_log') && failureMode === 'activity') return { ok: false, status: 500 };
    if (url.endsWith('/activity_log')) return { ok: true, status: 200 };
    return { ok: true, status: 200 };
  };

  let cookie;
  const invoke = async (body, headers = { cookie }) => {
    const response = makeRes();
    await handler({ method: 'POST', headers, body: JSON.stringify(body) }, response);
    return response;
  };

  try {
    await withEnv({
      SESSION_SECRET: 'app-data-secret',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_KEY: 'service-key'
    }, async () => {
      cookie = `dc_tracker_session=${encodeURIComponent(createSignedSession(Date.now() + 60 * 1000))}`;

      let response = await invoke({
        action: 'trackedItem.assignment.update',
        itemId: ' item/7 ',
        newAssignee: '  New Assignee  ',
        oldAssignee: 'Old Assignee',
        itemTitle: 'Title'
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(calls[0], {
        url: 'https://example.supabase.co/rest/v1/tracked_items?id=eq.%20item%2F7%20',
        method: 'PATCH',
        body: { assigned_to: '  New Assignee  ' }
      });
      assert.deepEqual(calls[1].body, {
        action: 'assigned',
        item_id: ' item/7 ',
        item_title: 'Title',
        details: { from: 'Old Assignee', to: '  New Assignee  ' }
      });

      calls.length = 0;
      failureMode = 'activity';
      response = await invoke({
        action: 'trackedItem.priority.update',
        itemId: 'item-7',
        newPriority: 'custom',
        oldPriority: 'medium',
        itemTitle: 'Title'
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(calls[0].body, { priority: 'custom' });
      failureMode = null;

      calls.length = 0;
      response = await invoke({ action: 'trackedItem.summary.save', itemId: 'item-7', summary: null });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(calls, [{
        url: 'https://example.supabase.co/rest/v1/tracked_items?id=eq.item-7',
        method: 'PATCH',
        body: { manual_summary: null }
      }]);

      calls.length = 0;
      response = await invoke({ action: 'trackedItem.summary.save', itemId: 'item-7', summary: '   ' });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(calls[0].body, { manual_summary: '   ' });

      calls.length = 0;
      response = await invoke({ action: 'trackedItem.summary.delete', itemId: 'item-7' });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(calls, [{
        url: 'https://example.supabase.co/rest/v1/tracked_items?id=eq.item-7',
        method: 'PATCH',
        body: { manual_summary: null }
      }]);

      calls.length = 0;
      response = await invoke({ action: 'trackedItem.activity.markSeen', itemId: 'item-7' });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(calls, [{
        url: 'https://example.supabase.co/rest/v1/tracked_items?id=eq.item-7',
        method: 'PATCH',
        body: { has_new_activity: false, activity_summary: null }
      }]);

      for (const body of [
        { action: 'trackedItem.assignment.update', itemId: '', newAssignee: 'x', oldAssignee: 'y', itemTitle: 't' },
        { action: 'trackedItem.assignment.update', itemId: 7, newAssignee: 'x', oldAssignee: 'y', itemTitle: 't' },
        { action: 'trackedItem.priority.update', itemId: 'item-7', newPriority: 3, oldPriority: 'medium', itemTitle: 't' },
        { action: 'trackedItem.summary.save', itemId: 'item-7', summary: 3 },
        { action: 'trackedItem.summary.delete', itemId: '   ' },
        { action: 'trackedItem.activity.markSeen', itemId: 7 }
      ]) {
        response = await invoke(body);
        assert.equal(response.statusCode, 400);
      }

      failureMode = 'tracked-items';
      response = await invoke({
        action: 'trackedItem.priority.update',
        itemId: 'item-7',
        newPriority: 'high',
        oldPriority: 'medium',
        itemTitle: 'Title'
      });
      assert.equal(response.statusCode, 500);
      assert.equal(response.body.error, 'Service unavailable');
      assert.doesNotMatch(JSON.stringify(response.body), /service-key|SUPABASE_SERVICE_KEY|Supabase/i);

      const unauthenticated = await invoke({ action: 'trackedItem.summary.delete', itemId: 'item-7' }, {});
      assert.equal(unauthenticated.statusCode, 401);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('only the five metadata functions moved behind app-data', () => {
  const appText = readRepoText('index.html');
  const functionBlocks = [
    appText.match(/const updateAssignment = async \(itemId, newAssignee\) => \{([\s\S]*?)\n            \};/),
    appText.match(/const updatePriority = async \(itemId, newPriority\) => \{([\s\S]*?)\n            \};/),
    appText.match(/const markActivityAsSeen = async \(itemId\) => \{([\s\S]*?)\n            \};/),
    appText.match(/const saveSummary = async \(\) => \{([\s\S]*?)\n            \};/),
    appText.match(/const deleteManualSummary = async \(itemId\) => \{([\s\S]*?)\n            \};/)
  ];

  for (const block of functionBlocks) {
    assert.ok(block);
    assert.doesNotMatch(block[1], /supabase\.from\('tracked_items'\)\s*\.update/);
  }
  assert.match(appText, /action:\s*'trackedItem\.assignment\.update'/);
  assert.match(appText, /action:\s*'trackedItem\.priority\.update'/);
  assert.match(appText, /action:\s*'trackedItem\.summary\.save'/);
  assert.match(appText, /action:\s*'trackedItem\.summary\.delete'/);
  assert.match(appText, /action:\s*'trackedItem\.activity\.markSeen'/);
  assert.match(appText, /summary:\s*summaryText\s*\|\|\s*null/);

  assert.match(appText, /const toggleSelection = async/);
  assert.match(appText, /const updateActionStatus = async/);
  assert.match(appText, /const checkHearingsForTrackedItems = async/);
  assert.match(appText, /const addManualEntry = async/);
  assert.match(appText, /supabase\.from\('tracked_items'\)\.update/);
});

test('api/app-data.js implements the tracked-item track/untrack contracts', async () => {
  const handler = await importFresh('api/app-data.js');
  const libSession = await importFreshModule('lib/session.js');
  const { createSignedSession } = libSession;
  const originalFetch = global.fetch;
  const calls = [];
  let failureMode = null;

  global.fetch = async (url, init = {}) => {
    const call = {
      url,
      method: init.method || 'GET',
      body: init.body ? JSON.parse(init.body) : undefined
    };
    calls.push(call);
    if (failureMode === 'tracked' && url.includes('/tracked_items')) return { ok: false, status: 500 };
    if (url.endsWith('/activity_log') && failureMode === 'activity') return { ok: false, status: 500 };
    if (url.endsWith('/activity_log')) return { ok: true, status: 200 };
    return { ok: true, status: 200 };
  };

  let cookie;
  const invoke = async (body, headers = { cookie }) => {
    const response = makeRes();
    await handler({ method: 'POST', headers, body: JSON.stringify(body) }, response);
    return response;
  };

  try {
    await withEnv({
      SESSION_SECRET: 'app-data-secret',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_KEY: 'service-key'
    }, async () => {
      cookie = `dc_tracker_session=${encodeURIComponent(createSignedSession(Date.now() + 60 * 1000))}`;

      const legislation = {
        action: 'trackedItem.track',
        itemId: 'B26-0001',
        title: '  A bill  ',
        billNumber: 'B26-0001',
        category: 'Bill',
        status: 'Introduced',
        committees: ['Committee A'],
        date: '2026-01-01',
        description: 'Description',
        link: 'https://example.test/bill',
        source: 'DC Council',
        agency: null,
        isManualEntry: false,
        isNew: true,
        introducedBy: null
      };
      let response = await invoke(legislation);
      assert.equal(response.statusCode, 200);
      assert.equal(calls[0].url, 'https://example.supabase.co/rest/v1/tracked_items');
      assert.equal(calls[0].method, 'POST');
      assert.deepEqual({ ...calls[0].body, last_checked_at: undefined }, {
        id: 'B26-0001', title: '  A bill  ', bill_number: 'B26-0001', category: 'Bill',
        status: 'Introduced', committees: ['Committee A'], date: '2026-01-01',
        description: 'Description', link: 'https://example.test/bill', source: 'DC Council',
        agency: null, is_manual_entry: false, is_new: true, assigned_to: 'Unassigned',
        priority: 'medium', action_status: 'action_needed', introduced_by: null,
        last_status: 'Introduced', last_checked_at: undefined, has_new_activity: false
      });
      assert.match(calls[0].body.last_checked_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.deepEqual(calls[1].body, {
        action: 'item_tracked', item_id: 'B26-0001', item_title: '  A bill  ',
        details: { source: 'DC Council', category: 'Bill' }
      });
      assert.equal(calls.some((call) => call.url.includes('/bill_status_history')), false);

      calls.length = 0;
      failureMode = 'activity';
      response = await invoke({
        ...legislation,
        itemId: 'MANUAL-1',
        title: 'Manual item',
        billNumber: null,
        category: 'Municipal Regulation',
        status: 'Published',
        committees: [],
        date: '2026-02-01',
        description: 'Manual item',
        link: '',
        source: 'Municipal Register',
        agency: 'DC Government',
        isManualEntry: true,
        isNew: false,
        introducedBy: null
      });
      assert.equal(response.statusCode, 200);
      assert.equal(calls.length, 2);
      failureMode = null;

      calls.length = 0;
      response = await invoke({ action: 'trackedItem.untrack', itemId: 'B26/0001', itemTitle: 'A bill' });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(calls[0], {
        url: 'https://example.supabase.co/rest/v1/tracked_items?id=eq.B26%2F0001',
        method: 'DELETE', body: undefined
      });
      assert.deepEqual(calls[1].body, {
        action: 'item_untracked', item_id: 'B26/0001', item_title: 'A bill', details: {}
      });
      assert.equal(calls.some((call) => call.url.includes('/bill_status_history')), false);

      calls.length = 0;
      failureMode = 'activity';
      response = await invoke({ action: 'trackedItem.untrack', itemId: 'B26-0001', itemTitle: 'A bill' });
      assert.equal(response.statusCode, 200);
      failureMode = null;

      for (const body of [
        { ...legislation, extra: true },
        { ...legislation, itemId: '' },
        { ...legislation, itemId: 42 },
        { ...legislation, title: 42 },
        { ...legislation, source: 42 },
        { action: 'trackedItem.untrack', itemId: '', itemTitle: 'A bill' },
        { action: 'trackedItem.untrack', itemId: 42, itemTitle: 'A bill' },
        { action: 'trackedItem.untrack', itemId: 'B26-0001', itemTitle: 42 },
        { action: 'trackedItem.untrack', itemId: 'B26-0001', itemTitle: 'A bill', extra: true }
      ]) {
        response = await invoke(body);
        assert.equal(response.statusCode, 400);
      }

      failureMode = 'tracked';
      response = await invoke(legislation);
      assert.equal(response.statusCode, 500);
      assert.equal(response.body.error, 'Service unavailable');
      assert.doesNotMatch(JSON.stringify(response.body), /service-key|SUPABASE_SERVICE_KEY|Supabase/i);
      response = await invoke({ action: 'trackedItem.untrack', itemId: 'B26-0001', itemTitle: 'A bill' });
      assert.equal(response.statusCode, 500);
      assert.equal(response.body.error, 'Service unavailable');

      const unauthenticated = await invoke({ action: 'trackedItem.untrack', itemId: 'B26-0001', itemTitle: 'A bill' }, {});
      assert.equal(unauthenticated.statusCode, 401);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('toggleSelection uses app-data while remaining tracked-item writers stay direct', () => {
  const appText = readRepoText('index.html');
  const toggleBlock = appText.match(/const toggleSelection = async \(itemId\) => \{([\s\S]*?)\n            \};/);

  assert.ok(toggleBlock);
  assert.doesNotMatch(toggleBlock[1], /supabase\.from\('tracked_items'\)\s*\.\s*(?:insert|delete)/);
  assert.match(toggleBlock[1], /action:\s*'trackedItem\.track'/);
  assert.match(toggleBlock[1], /action:\s*'trackedItem\.untrack'/);
  assert.match(toggleBlock[1], /setSelectedItems\(newSelected\)/);
  assert.match(toggleBlock[1], /setItems\(items\.map/);

  assert.match(appText, /const addManualEntry = async/);
  assert.match(appText, /const updateActionStatus = async/);
  assert.match(appText, /const checkHearingsForTrackedItems = async/);
  assert.match(appText, /supabase\.from\('tracked_items'\)\.update/);
});

test('manual-entry functions use app-data while action-status and hearing writers remain direct', () => {
  const appText = readRepoText('index.html');
  for (const [name, action] of [
    ['addManualEntry', 'create'], ['updateManualEntry', 'update'], ['deleteManualEntry', 'delete']
  ]) {
    const block = appText.match(new RegExp(`const ${name} = async \\([^)]*\\) => \\{([\\s\\S]*?)\\n            \\};`));
    assert.ok(block, name);
    assert.doesNotMatch(block[1], /supabase\.from\('tracked_items'\)/);
    assert.match(block[1], new RegExp(`action: 'trackedItem\\.manual\\.${action}'`));
    if (name === 'deleteManualEntry') assert.match(block[1], /confirm\('Are you sure you want to delete this entry\? This cannot be undone\.'\)/);
  }
  const actionStatusBlock = appText.match(/const updateActionStatus = async \([^)]*\) => \{([\s\S]*?)\n            \};/);
  assert.ok(actionStatusBlock);
  assert.match(actionStatusBlock[1], /action: 'trackedItem\.actionStatus\.update'/);
  assert.doesNotMatch(actionStatusBlock[1], /supabase\.from\('(tracked_items|bill_status_history)'\)|logActivity\(/);
  assert.match(actionStatusBlock[1], /response\.ok \|\| data\?\.trackedItemUpdated === true/);
  assert.match(actionStatusBlock[1], /setItems\(items\.map/);
  assert.match(appText, /const checkHearingsForTrackedItems = async[\s\S]*?supabase\.from\('tracked_items'\)\.update/);
});

test('manual-entry API preserves payloads, audit behavior, auth and generic failures', async () => {
  const handler = await importFresh('api/app-data.js');
  const { createSignedSession } = await importFreshModule('lib/session.js');
  const originalFetch = global.fetch;
  const calls = [];
  let failure = null;
  global.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: !(failure === 'primary' && url.includes('/tracked_items') || failure === 'audit' && url.includes('/activity_log')), status: 500 };
  };
  let cookie;
  const invoke = async (body, headers = { cookie }) => {
    const res = makeRes();
    await handler({ method: 'POST', headers, body: JSON.stringify(body) }, res);
    return res;
  };
  const create = {
    action: 'trackedItem.manual.create', itemId: 'MANUAL-123', title: '  Manual title  ',
    agency: 'DC Government', status: 'Published', date: '2026-09-21', link: '',
    assignedTo: 'Unassigned', priority: 'medium', actionStatus: 'action_needed',
    noticeId: '', registerIssue: '', registerNotes: '', deadline: null,
    isNew: true, latestActivityDate: '2026-09-21'
  };
  const update = {
    action: 'trackedItem.manual.update', itemId: 'MANUAL/123', title: 'Changed',
    agency: '', status: 'Open', date: '2026-09-22', link: '', assignedTo: 'A',
    priority: 'high', actionStatus: 'in_progress', noticeId: '', registerIssue: '',
    registerNotes: '', deadline: null
  };
  const del = { action: 'trackedItem.manual.delete', itemId: 'MANUAL/123' };
  try {
    await withEnv({ SESSION_SECRET: 'manual-secret', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'service-key' }, async () => {
      cookie = `dc_tracker_session=${encodeURIComponent(createSignedSession(Date.now() + 60000))}`;
      for (const [body, method, row, audit] of [
        [create, 'POST', {
          id: 'MANUAL-123', title: '  Manual title  ', bill_number: null,
          category: 'Municipal Regulation', status: 'Published', committees: [],
          date: '2026-09-21', description: '  Manual title  ', link: '',
          source: 'Municipal Register', agency: 'DC Government', is_manual_entry: true,
          is_new: true, assigned_to: 'Unassigned', priority: 'medium',
          action_status: 'action_needed', introduced_by: null, notice_id: '',
          register_issue: '', register_notes: '', deadline: null,
          latest_activity_date: '2026-09-21'
        }, { action: 'manual_entry_added', item_id: 'MANUAL-123', item_title: '  Manual title  ', details: { source: 'Municipal Register' } }],
        [update, 'PATCH', {
          title: 'Changed', agency: '', status: 'Open', date: '2026-09-22', link: '',
          assigned_to: 'A', priority: 'high', action_status: 'in_progress',
          notice_id: '', register_issue: '', register_notes: '', description: 'Changed',
          deadline: null, latest_activity_date: '2026-09-22'
        }, { action: 'manual_entry_updated', item_id: 'MANUAL/123', item_title: 'Changed', details: {} }],
        [del, 'DELETE', undefined, { action: 'manual_entry_deleted', item_id: 'MANUAL/123', item_title: null, details: {} }]
      ]) {
        calls.length = 0;
        assert.equal((await invoke(body)).statusCode, 200);
        assert.equal(calls[0].method, method);
        assert.equal(calls[0].url, `https://example.supabase.co/rest/v1/tracked_items${method === 'POST' ? '' : '?id=eq.MANUAL%2F123'}`);
        assert.deepEqual(calls[0].body, row);
        assert.equal(calls[0].headers.Authorization, 'Bearer service-key');
        assert.deepEqual(calls[1].body, audit);
        assert.equal(calls.some(c => c.url.includes('bill_status_history')), false);
        failure = 'audit';
        assert.equal((await invoke(body)).statusCode, 200);
        failure = null;
      }
      for (const body of [
        { ...create, extra: true }, { ...create, itemId: '' }, { ...create, isNew: 'true' },
        { ...create, deadline: 4 }, { ...create, latestActivityDate: 4 },
        Object.fromEntries(Object.entries(create).filter(([key]) => key !== 'noticeId')),
        { ...update, itemId: 3 }, { ...update, title: 3 }, { ...update, extra: true },
        Object.fromEntries(Object.entries(update).filter(([key]) => key !== 'deadline')),
        { ...del, itemId: '' }, { ...del, extra: true }
      ]) assert.equal((await invoke(body)).statusCode, 400);
      for (const body of [create, update, del]) {
        assert.equal((await invoke(body, {})).statusCode, 401);
        failure = 'primary';
        const res = await invoke(body);
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { error: 'Service unavailable' });
        failure = null;
      }
    });
  } finally { global.fetch = originalFetch; }
});

test('action-status API preserves ordered writes and partial-success failures', async () => {
  const handler = await importFresh('api/app-data.js');
  const { createSignedSession } = await importFreshModule('lib/session.js');
  const originalFetch = global.fetch;
  const calls = [];
  let failTable = null;
  global.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: !url.includes(`/${failTable}`), status: 500 };
  };
  const request = { action: 'trackedItem.actionStatus.update', itemId: 'B26/123',
    itemTitle: 'A bill', oldStatus: 'action_needed', newStatus: 'monitor_and_assess' };
  const invoke = async (body, headers) => {
    const res = makeRes();
    await handler({ method: 'POST', headers, body: JSON.stringify(body) }, res);
    return res;
  };
  try {
    await withEnv({ SESSION_SECRET: 'status-secret', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_KEY: 'service-key' }, async () => {
      const headers = { cookie: `dc_tracker_session=${encodeURIComponent(createSignedSession(Date.now() + 60000))}` };
      assert.equal((await invoke(request, {})).statusCode, 401);
      for (const invalid of [
        { ...request, extra: true }, { ...request, itemId: '' }, { ...request, itemTitle: 1 },
        { ...request, oldStatus: null }, { ...request, newStatus: 1 },
        Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'newStatus'))
      ]) assert.equal((await invoke(invalid, headers)).statusCode, 400);

      calls.length = 0;
      assert.equal((await invoke(request, headers)).statusCode, 200);
      assert.equal(calls.length, 3);
      assert.deepEqual(calls[0], {
        url: 'https://example.supabase.co/rest/v1/tracked_items?id=eq.B26%2F123',
        method: 'PATCH', headers: calls[0].headers, body: { action_status: 'monitor_and_assess' }
      });
      assert.equal(calls[0].headers.Authorization, 'Bearer service-key');
      assert.equal(calls[1].url, 'https://example.supabase.co/rest/v1/bill_status_history');
      assert.equal(calls[1].method, 'POST');
      assert.deepEqual({ ...calls[1].body, changed_at: undefined }, {
        item_id: 'B26/123', old_status: 'Action Needed', new_status: 'Monitor & Assess',
        change_label: 'Tracker status changed: Action Needed → Monitor & Assess', changed_at: undefined
      });
      assert.match(calls[1].body.changed_at, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(calls[2].body, { action: 'action_status_changed', item_id: 'B26/123',
        item_title: 'A bill', details: { from: 'action_needed', to: 'monitor_and_assess' } });

      calls.length = 0;
      assert.equal((await invoke({ ...request, oldStatus: 'custom', newStatus: 'other' }, headers)).statusCode, 200);
      assert.equal(calls[1].body.change_label, 'Tracker status changed: custom → other');
      calls.length = 0;
      assert.equal((await invoke({ ...request, newStatus: 'action_completed' }, headers)).statusCode, 200);
      assert.equal(calls[1].body.new_status, 'Action Completed');

      for (const [table, status, count, partial] of [
        ['tracked_items', 500, 1, undefined],
        ['bill_status_history', 500, 2, true],
        ['activity_log', 200, 3, undefined]
      ]) {
        calls.length = 0;
        failTable = table;
        const res = await invoke(request, headers);
        assert.equal(res.statusCode, status);
        assert.equal(calls.length, count);
        if (status === 500) assert.deepEqual(res.body, { error: 'Service unavailable', ...(partial ? { trackedItemUpdated: true } : {}) });
      }
    });
  } finally { global.fetch = originalFetch; }
});

test('api/app-data.js accepts and validates note.save and note.delete payloads', async () => {
  const handler = await importFresh('api/app-data.js');
  const libSession = await importFreshModule('lib/session.js');
  const { createSignedSession } = libSession;
  const calls = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined
    });

    if (url.startsWith('https://example.supabase.co/rest/v1/item_notes')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
    }

    if (url === 'https://example.supabase.co/rest/v1/activity_log') {
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await withEnv({
      SESSION_SECRET: 'app-data-secret',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_KEY: 'service-key'
    }, async () => {
      const cookie = `dc_tracker_session=${encodeURIComponent(createSignedSession(Date.now() + 60 * 1000))}`;

      const missingKeysRes = makeRes();
      await handler({ method: 'POST', headers: { cookie }, body: JSON.stringify({ action: 'note.save', itemId: 'item-1', noteText: 'hello' }) }, missingKeysRes);
      assert.equal(missingKeysRes.statusCode, 400);
      assert.equal(missingKeysRes.body.error, 'Invalid request');

      const badItemIdRes = makeRes();
      await handler({ method: 'POST', headers: { cookie }, body: JSON.stringify({ action: 'note.save', itemId: 3, noteText: 'hello', activityAction: 'note_added', itemTitle: 'Title' }) }, badItemIdRes);
      assert.equal(badItemIdRes.statusCode, 400);
      assert.equal(badItemIdRes.body.error, 'Invalid request');

      const whitespaceItemIdRes = makeRes();
      await handler({ method: 'POST', headers: { cookie }, body: JSON.stringify({ action: 'note.save', itemId: '   ', noteText: 'hello', activityAction: 'note_added', itemTitle: 'Title' }) }, whitespaceItemIdRes);
      assert.equal(whitespaceItemIdRes.statusCode, 400);
      assert.equal(whitespaceItemIdRes.body.error, 'Invalid request');

      const badTextRes = makeRes();
      await handler({ method: 'POST', headers: { cookie }, body: JSON.stringify({ action: 'note.save', itemId: 'item-1', noteText: 5, activityAction: 'note_added', itemTitle: 'Title' }) }, badTextRes);
      assert.equal(badTextRes.statusCode, 400);
      assert.equal(badTextRes.body.error, 'Invalid request');

      const validSaveRes = makeRes();
      const noteText = '  hello world  ';
      await handler({ method: 'POST', headers: { cookie }, body: JSON.stringify({ action: 'note.save', itemId: 'item-1', noteText, activityAction: 'note_added', itemTitle: 'Alpha Item' }) }, validSaveRes);
      assert.equal(validSaveRes.statusCode, 200);
      assert.deepEqual(validSaveRes.body, { ok: true, itemId: 'item-1', noteText });
      assert.equal(calls.length, 2);
      assert.equal(calls[0].method, 'POST');
      assert.equal(calls[0].url, 'https://example.supabase.co/rest/v1/item_notes?on_conflict=item_id');
      assert.deepEqual(calls[0].body, { item_id: 'item-1', note_text: noteText });
      assert.equal(calls[0].headers.Prefer, 'resolution=merge-duplicates');
      assert.deepEqual(calls[1].body, { action: 'note_added', item_id: 'item-1', item_title: 'Alpha Item', details: {} });

      const badActionRes = makeRes();
      await handler({ method: 'POST', headers: { cookie }, body: JSON.stringify({ action: 'note.save', itemId: 'item-1', noteText: 'hello', activityAction: 'note_missing', itemTitle: 'Title' }) }, badActionRes);
      assert.equal(badActionRes.statusCode, 400);
      assert.equal(badActionRes.body.error, 'Invalid request');

      const badTitleRes = makeRes();
      await handler({ method: 'POST', headers: { cookie }, body: JSON.stringify({ action: 'note.save', itemId: 'item-1', noteText: 'hello', activityAction: 'note_updated', itemTitle: 42 }) }, badTitleRes);
      assert.equal(badTitleRes.statusCode, 400);
      assert.equal(badTitleRes.body.error, 'Invalid request');

      calls.length = 0;
      const updatedSaveRes = makeRes();
      await handler({ method: 'POST', headers: { cookie }, body: JSON.stringify({ action: 'note.save', itemId: 'item-2', noteText: 'updated value', activityAction: 'note_updated', itemTitle: 'Beta Item' }) }, updatedSaveRes);
      assert.equal(updatedSaveRes.statusCode, 200);
      assert.deepEqual(calls[0].body, { item_id: 'item-2', note_text: 'updated value' });
      assert.deepEqual(calls[1].body, { action: 'note_updated', item_id: 'item-2', item_title: 'Beta Item', details: {} });

      const deleteRes = makeRes();
      calls.length = 0;
      await handler({ method: 'POST', headers: { cookie }, body: JSON.stringify({ action: 'note.delete', itemId: 'item-3', itemTitle: 'Gamma Item' }) }, deleteRes);
      assert.equal(deleteRes.statusCode, 200);
      assert.deepEqual(deleteRes.body, { ok: true, itemId: 'item-3' });
      assert.equal(calls[0].method, 'DELETE');
      assert.equal(calls[0].url, 'https://example.supabase.co/rest/v1/item_notes?item_id=eq.item-3');
      assert.equal(calls[0].body, undefined);
      assert.deepEqual(calls[1].body, { action: 'note_deleted', item_id: 'item-3', item_title: 'Gamma Item', details: {} });
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('api/app-data.js treats note activity logging as nonfatal and note DB failures as fatal', async () => {
  const handler = await importFresh('api/app-data.js');
  const libSession = await importFreshModule('lib/session.js');
  const { createSignedSession } = libSession;
  const originalFetch = global.fetch;

  try {
    await withEnv({
      SESSION_SECRET: 'app-data-secret',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_KEY: 'service-key'
    }, async () => {
      const cookie = `dc_tracker_session=${encodeURIComponent(createSignedSession(Date.now() + 60 * 1000))}`;

      global.fetch = async (url, init = {}) => {
        if (url.startsWith('https://example.supabase.co/rest/v1/item_notes')) {
          return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
        }
        if (url === 'https://example.supabase.co/rest/v1/activity_log') {
          throw new Error('activity log failure');
        }
        throw new Error(`Unexpected fetch: ${url}`);
      };

      const saveRes = makeRes();
      await handler({ method: 'POST', headers: { cookie }, body: JSON.stringify({ action: 'note.save', itemId: 'item-9', noteText: '', activityAction: 'note_added', itemTitle: 'Title' }) }, saveRes);
      assert.equal(saveRes.statusCode, 200);
      assert.deepEqual(saveRes.body, { ok: true, itemId: 'item-9', noteText: '' });

      global.fetch = async (url, init = {}) => {
        if (url.startsWith('https://example.supabase.co/rest/v1/item_notes')) {
          return { ok: false, status: 500, text: async () => 'Supabase item_notes failure SESSION_SECRET=topsecret service-key=super-secret' };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      };

      const saveFailureRes = makeRes();
      await handler({ method: 'POST', headers: { cookie }, body: JSON.stringify({ action: 'note.save', itemId: 'item-10', noteText: 'boom', activityAction: 'note_updated', itemTitle: 'Title' }) }, saveFailureRes);
      assert.equal(saveFailureRes.statusCode, 500);
      assert.equal(saveFailureRes.body.error, 'Service unavailable');
      assert.doesNotMatch(JSON.stringify(saveFailureRes.body), /SESSION_SECRET|SUPABASE_SERVICE_KEY|topsecret|super-secret|Supabase item_notes failure/i);

      global.fetch = async (url, init = {}) => {
        if (url.startsWith('https://example.supabase.co/rest/v1/item_notes')) {
          return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
        }
        if (url === 'https://example.supabase.co/rest/v1/activity_log') {
          throw new Error('activity log failure');
        }
        throw new Error(`Unexpected fetch: ${url}`);
      };

      const deleteRes = makeRes();
      await handler({ method: 'POST', headers: { cookie }, body: JSON.stringify({ action: 'note.delete', itemId: 'item-11', itemTitle: 'Title' }) }, deleteRes);
      assert.equal(deleteRes.statusCode, 200);
      assert.deepEqual(deleteRes.body, { ok: true, itemId: 'item-11' });

      global.fetch = async (url, init = {}) => {
        if (url.startsWith('https://example.supabase.co/rest/v1/item_notes')) {
          return { ok: false, status: 500, text: async () => 'Supabase note delete failure service-key=super-secret' };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      };

      const deleteFailureRes = makeRes();
      await handler({ method: 'POST', headers: { cookie }, body: JSON.stringify({ action: 'note.delete', itemId: 'item-12', itemTitle: 'Title' }) }, deleteFailureRes);
      assert.equal(deleteFailureRes.statusCode, 500);
      assert.equal(deleteFailureRes.body.error, 'Service unavailable');
      assert.doesNotMatch(JSON.stringify(deleteFailureRes.body), /SESSION_SECRET|SUPABASE_SERVICE_KEY|super-secret|Supabase note delete failure/i);
    });
  } finally {
    global.fetch = originalFetch;
  }
});


test('repository guardrails keep note mutations behind the authenticated API and preserve direct item_notes reads', () => {
  const appText = readRepoText('index.html');

  assert.match(appText, /from\('item_notes'\)\.select\('\*'\)/);
  assert.match(appText, /action:\s*'note\.save'/);
  assert.match(appText, /action:\s*'note\.delete'/);
  assert.doesNotMatch(appText, /from\('item_notes'\)\s*\.upsert/i);
  assert.doesNotMatch(appText, /from\('item_notes'\)\s*\.delete\s*\(\)\s*\.eq\s*\('item_id'/i);
  assert.doesNotMatch(appText, /from\('item_notes'\)\s*\.delete\s*\(\)/i);

  const apiFiles = collectApiFiles();
  assert.ok(apiFiles.length <= 12, `Expected /api count <= 12, got ${apiFiles.length}`);
});

test('frontend committee normalization keeps array data safe at the render boundary', () => {
  const appText = readRepoText('index.html');

  assert.match(appText, /const normalizeCommittees = \(value\) => \{/);
  assert.match(appText, /if \(!text \|\| text === 'null'\) return \[\];/);
  assert.match(appText, /JSON\.parse\(text\)/);
  assert.match(appText, /split\(';'/);
  assert.match(appText, /filter\(Boolean\)/);
  assert.doesNotMatch(appText, /committees:\s*item\.committees\s*\|\|\s*\[\]/);
  assert.match(appText, /committees:\s*normalizeCommittees\(item\.committees\)/);
  assert.match(appText, /const committees = normalizeCommittees\(leg\.referredToCommittees\);/);
});

test('server-side JavaScript files in /api and /lib pass node syntax checks', async () => {
  const apiFiles = collectApiFiles();
  const libFiles = fs.readdirSync(path.join(projectRoot, 'lib'))
    .filter((file) => file.endsWith('.js'))
    .sort();

  for (const file of apiFiles) {
    const filePath = path.join(projectRoot, 'api', file);
    let status = 0;
    let stderr = '';

    try {
      execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
    } catch (error) {
      status = error.status ?? 1;
      stderr = error.stderr?.toString() || error.message;
    }

    assert.equal(status, 0, `Syntax check failed for ${file}: ${stderr}`);
  }

  for (const file of libFiles) {
    const filePath = path.join(projectRoot, 'lib', file);
    let status = 0;
    let stderr = '';

    try {
      execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
    } catch (error) {
      status = error.status ?? 1;
      stderr = error.stderr?.toString() || error.message;
    }

    assert.equal(status, 0, `Syntax check failed for ${file}: ${stderr}`);
  }
});
