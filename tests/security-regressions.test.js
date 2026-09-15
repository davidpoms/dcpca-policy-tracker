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
    body: undefined
  };

  res.status = (code) => {
    res.statusCode = code;
    return res;
  };

  res.json = (payload) => {
    res.body = payload;
    return payload;
  };

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
  const handler = await importFresh('api/check-password.js', { APP_PASSWORD: 'correct-password' });
  const req = { method: 'POST', body: { password: 'wrong-password' } };
  const res = makeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'Incorrect password');
  assert.ok(!('APP_PASSWORD' in res.body));
  assert.ok(!('CRON_SECRET' in res.body));
  assert.ok(!res.body.token);
});

test('api/check-password.js accepts the configured APP_PASSWORD and returns an opaque token', async () => {
  const handler = await importFresh('api/check-password.js', { APP_PASSWORD: 'correct-password' });

  const req1 = { method: 'POST', body: { password: 'correct-password' } };
  const req2 = { method: 'POST', body: { password: 'correct-password' } };
  const res1 = makeRes();
  const res2 = makeRes();

  await handler(req1, res1);
  await handler(req2, res2);

  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
  assert.match(res1.body.token, /^[a-f0-9]{64}$/i);
  assert.match(res2.body.token, /^[a-f0-9]{64}$/i);
  assert.notEqual(res1.body.token, res2.body.token);
  assert.equal(typeof res1.body.expires, 'number');
  assert.equal(typeof res2.body.expires, 'number');
  assert.ok(Math.abs(res1.body.expires - (Date.now() + 8 * 60 * 60 * 1000)) < 60 * 1000);
  assert.ok(Math.abs(res2.body.expires - (Date.now() + 8 * 60 * 60 * 1000)) < 60 * 1000);
  assert.ok(!('APP_PASSWORD' in res1.body));
  assert.ok(!('CRON_SECRET' in res1.body));
  assert.ok(!('APP_PASSWORD' in res2.body));
  assert.ok(!('CRON_SECRET' in res2.body));
  assert.notEqual(res1.body.token, 'correct-password');
  assert.notEqual(res2.body.token, 'correct-password');
});

test('api/check-password.js never returns secret values in the response body', async () => {
  const handler = await importFresh('api/check-password.js', {
    APP_PASSWORD: 'correct-password',
    CRON_SECRET: 'super-secret-value'
  });

  const req = { method: 'POST', body: { password: 'correct-password' } };
  const res = makeRes();

  await handler(req, res);

  const responseText = JSON.stringify(res.body);
  assert.doesNotMatch(responseText, /correct-password/i);
  assert.doesNotMatch(responseText, /super-secret-value/i);
  assert.doesNotMatch(responseText, /APP_PASSWORD|CRON_SECRET/i);
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
  const apiFiles = collectApiFiles();
  const appFiles = ['index.html', ...apiFiles];

  const appText = appFiles.map((relativePath) => readRepoText(relativePath)).join('\n');

  assert.doesNotMatch(appText, /dcpcapolicyhearingtracker/i);
  assert.doesNotMatch(readRepoText('index.html'), /https:\/\/[^\s"'<>]*\.supabase\.co/i);
  assert.doesNotMatch(readRepoText('index.html'), /sb_publishable_[A-Za-z0-9_-]+/i);
  assert.doesNotMatch(readRepoText('index.html'), /https:\/\/dcpca-policy-tracker\.vercel\.app/i);
  assert.doesNotMatch(readRepoText('api/build-bill-cache.js'), /https:\/\/dcpca-policy-tracker\.vercel\.app/i);

  for (const relativePath of apiFiles) {
    const content = readRepoText(`api/${relativePath}`);
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
