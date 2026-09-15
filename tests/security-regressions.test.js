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
