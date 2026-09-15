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
  const moduleNamespace = await importFreshModule('api/_session.js');
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
  const moduleNamespace = await importFreshModule('api/_session.js');
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
  const handler = await importFresh('api/check-password.js', {
    APP_PASSWORD: 'correct-password',
    SESSION_SECRET: undefined,
    CRON_SECRET: 'cron-secret-value'
  });

  const req = { method: 'POST', body: { password: 'correct-password' } };
  const res = makeRes();

  await handler(req, res);

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

test('repository guardrails block historical secret and production URL drift', () => {
  const apiFiles = collectApiFiles().map((file) => `api/${file}`);
  const appFiles = ['index.html', ...apiFiles];

  const appText = appFiles.map((relativePath) => readRepoText(relativePath)).join('\n');

  assert.doesNotMatch(appText, /dcpcapolicyhearingtracker/i);
  assert.doesNotMatch(readRepoText('index.html'), /https:\/\/[^\s"'<>]*\.supabase\.co/i);
  assert.doesNotMatch(readRepoText('index.html'), /sb_publishable_[A-Za-z0-9_-]+/i);
  assert.doesNotMatch(readRepoText('index.html'), /https:\/\/dcpca-policy-tracker\.vercel\.app/i);
  assert.doesNotMatch(readRepoText('api/build-bill-cache.js'), /https:\/\/dcpca-policy-tracker\.vercel\.app/i);

  for (const relativePath of apiFiles) {
    const content = readRepoText(relativePath);
    assert.doesNotMatch(content, /x-vercel-cron/i);
  }
});

test('server-side JavaScript files in /api pass node syntax checks', async () => {
  const apiFiles = collectApiFiles();

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
});
