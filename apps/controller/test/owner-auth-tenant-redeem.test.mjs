import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsPromises from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const controllerRoot = path.resolve(process.cwd());
const requestTimeoutMs = 5000;
const modControlToken = 'controller-test-owner-mod-token';
const ownerAuthSessionSecret = 'controller-test-owner-session-secret';
const ownerAllowedUserId = 'controller-owner-allowed';
const internalRedeemSecret = 'controller-test-owner-internal-redeem-secret';

function modHeaders() {
  return {
    authorization: `Bearer ${modControlToken}`,
  };
}

function createOwnerAuthToken({
  userId = ownerAllowedUserId,
  userLogin = 'owner_login',
  userName = 'Owner User',
} = {}) {
  const now = Date.now();
  const payload = {
    v: 1,
    type: 'owner-auth',
    userId,
    userLogin,
    userName,
    iat: now,
    exp: now + 60 * 60 * 1000,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', ownerAuthSessionSecret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function ownerHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
  };
}

function legacyRedeemHeaders() {
  return {
    authorization: `Bearer ${internalRedeemSecret}`,
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to acquire free port.'));
          return;
        }

        resolve(address.port);
      });
    });
  });
}

function startController(port, stateFilePath, envOverrides = {}) {
  const logs = [];

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: controllerRoot,
    env: {
      ...process.env,
      PORT: String(port),
      CONTROLLER_STATE_FILE: stateFilePath,
      TWITCH_BOT_USERNAME: '',
      TWITCH_BOT_OAUTH: '',
      TWITCH_CHANNEL: '',
      TWITCH_CHANNELS: '',
      TWITCH_CLIENT_ID: 'test-client-id',
      TWITCH_CLIENT_SECRET: 'test-client-secret',
      TWITCH_REDIRECT_URI: 'http://localhost/callback',
      VIEWER_BASE_URL: 'https://stream-bingo-viewer.web.app',
      VIEWER_INVITE_TOKEN_SECRET: 'controller-test-owner-viewer-invite-secret',
      VIEWER_AUTH_TOKEN_SECRET: 'controller-test-owner-viewer-auth-secret',
      PUBLIC_API_BASE_URL: 'https://api.custom-overlays.com',
      MOD_CONTROL_TOKEN: modControlToken,
      INTERNAL_REDEEM_SECRET: internalRedeemSecret,
      OWNER_AUTH_ENABLED: 'true',
      OWNER_AUTH_SESSION_SECRET: ownerAuthSessionSecret,
      OWNER_TWITCH_USER_IDS: ownerAllowedUserId,
      OWNER_AUTH_REDIRECT_URI: 'https://api.custom-overlays.com/api/owner/auth/twitch/callback',
      MULTI_TENANT_ENABLED: 'true',
      LEGACY_SINGLE_TENANT_FALLBACK: 'false',
      DEFAULT_TENANT_SLUG: 'alpha-streamer',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    logs.push(String(chunk));
  });

  child.stderr.on('data', (chunk) => {
    logs.push(String(chunk));
  });

  return {
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    logs,
  };
}

async function stopController(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  try {
    child.kill();
    await delay(250);

    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await delay(250);
    }
  } catch {
    // Best-effort process cleanup.
  }
}

async function waitForHealth(baseUrl, child, logs) {
  const start = Date.now();

  while (Date.now() - start < 20000) {
    if (child.exitCode !== null) {
      throw new Error(`Controller exited before health check. Logs:\n${logs.join('')}`);
    }

    try {
      const response = await fetchWithTimeout(`${baseUrl}/health`, {}, 1500);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until timeout.
    }

    await delay(250);
  }

  throw new Error(`Controller did not become healthy in time. Logs:\n${logs.join('')}`);
}

async function requestJson(baseUrl, method, route, body, headers = {}) {
  const response = await fetchWithTimeout(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const json = text.length > 0 ? JSON.parse(text) : null;

  return {
    status: response.status,
    json,
  };
}

test('owner tenant endpoints enforce allowlist and stay reachable with legacy fallback disabled', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-owner-auth-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath);
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const noAuth = await requestJson(runtime.baseUrl, 'GET', '/api/owner/tenants');
    assert.equal(noAuth.status, 401, JSON.stringify(noAuth.json));
    assert.equal(noAuth.json?.error, 'owner_auth_required');

    const disallowedToken = createOwnerAuthToken({
      userId: 'controller-owner-not-allowed',
      userLogin: 'not_allowed_owner',
      userName: 'Not Allowed Owner',
    });
    const denied = await requestJson(runtime.baseUrl, 'GET', '/api/owner/tenants', undefined, ownerHeaders(disallowedToken));
    assert.equal(denied.status, 403, JSON.stringify(denied.json));
    assert.equal(denied.json?.error, 'owner_not_allowed');

    const allowedToken = createOwnerAuthToken();
    const allowed = await requestJson(runtime.baseUrl, 'GET', '/api/owner/tenants', undefined, ownerHeaders(allowedToken));
    assert.equal(allowed.status, 200, JSON.stringify(allowed.json));
    assert.equal(allowed.json?.ok, true);
    assert.ok(Array.isArray(allowed.json?.tenants), JSON.stringify(allowed.json));

    const authMe = await requestJson(runtime.baseUrl, 'GET', '/api/owner/auth/me', undefined, ownerHeaders(allowedToken));
    assert.equal(authMe.status, 200, JSON.stringify(authMe.json));
    assert.equal(authMe.json?.authenticated, true);
    assert.equal(authMe.json?.authorized, true);
    assert.equal(authMe.json?.tokenSource, 'bearer');
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('tenant redeem key auth is tenant-scoped and rejects invalid keys', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-tenant-redeem-key-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath, {
      LEGACY_INTERNAL_REDEEM_SECRET_ENABLED: 'false',
    });
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const ownerToken = createOwnerAuthToken();
    const rotateAlpha = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/owner/tenants/redeem-key/rotate',
      { tenantSlug: 'alpha-streamer' },
      ownerHeaders(ownerToken),
    );
    assert.equal(rotateAlpha.status, 200, JSON.stringify(rotateAlpha.json));
    const alphaRedeemKey = rotateAlpha.json?.redeemKey;
    assert.equal(typeof alphaRedeemKey, 'string');
    assert.ok(alphaRedeemKey.length > 0);

    const startAlpha = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/t/alpha-streamer/mod/start',
      { mode: 'rows' },
      modHeaders(),
    );
    assert.equal(startAlpha.status, 200, JSON.stringify(startAlpha.json));

    const successJoin = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/t/alpha-streamer/internal/redeem/join',
      {
        redemptionId: 'tenant-key-alpha-001',
        twitchUserId: 'viewer-alpha',
        twitchUserName: 'ViewerAlpha',
      },
      ownerHeaders(alphaRedeemKey),
    );
    assert.equal(successJoin.status, 200, JSON.stringify(successJoin.json));
    assert.equal(successJoin.json?.ok, true);

    const wrongTenant = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/t/beta-streamer/internal/redeem/join',
      {
        redemptionId: 'tenant-key-beta-001',
        twitchUserId: 'viewer-beta',
        twitchUserName: 'ViewerBeta',
      },
      ownerHeaders(alphaRedeemKey),
    );
    assert.equal(wrongTenant.status, 401, JSON.stringify(wrongTenant.json));
    assert.equal(wrongTenant.json?.error, 'invalid_tenant_redeem_auth');
    assert.equal(typeof wrongTenant.json?.message, 'string', JSON.stringify(wrongTenant.json));
    assert.equal(typeof wrongTenant.json?.viewerUrl, 'string', JSON.stringify(wrongTenant.json));

    const invalidKey = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/t/alpha-streamer/internal/redeem/join',
      {
        redemptionId: 'tenant-key-alpha-002',
        twitchUserId: 'viewer-alpha-two',
        twitchUserName: 'ViewerAlphaTwo',
      },
      ownerHeaders('invalid-tenant-redeem-key'),
    );
    assert.equal(invalidKey.status, 401, JSON.stringify(invalidKey.json));
    assert.equal(invalidKey.json?.error, 'invalid_tenant_redeem_auth');
    assert.equal(typeof invalidKey.json?.message, 'string', JSON.stringify(invalidKey.json));
    assert.equal(typeof invalidKey.json?.viewerUrl, 'string', JSON.stringify(invalidKey.json));
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('tenant redeem key remains valid after restart and slug upsert does not invalidate existing keys', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-tenant-redeem-persist-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let firstRuntime = null;
  let secondRuntime = null;

  try {
    const firstPort = await getFreePort();
    firstRuntime = startController(firstPort, stateFilePath, {
      LEGACY_INTERNAL_REDEEM_SECRET_ENABLED: 'false',
    });
    await waitForHealth(firstRuntime.baseUrl, firstRuntime.child, firstRuntime.logs);

    const ownerToken = createOwnerAuthToken();
    const rotateAlpha = await requestJson(
      firstRuntime.baseUrl,
      'POST',
      '/api/owner/tenants/redeem-key/rotate',
      { tenantSlug: 'alpha-streamer' },
      ownerHeaders(ownerToken),
    );
    assert.equal(rotateAlpha.status, 200, JSON.stringify(rotateAlpha.json));
    const alphaRedeemKey = rotateAlpha.json?.redeemKey;
    assert.equal(typeof alphaRedeemKey, 'string');
    assert.ok(alphaRedeemKey.length > 0);

    const startAlpha = await requestJson(
      firstRuntime.baseUrl,
      'POST',
      '/api/t/alpha-streamer/mod/start',
      { mode: 'rows' },
      modHeaders(),
    );
    assert.equal(startAlpha.status, 200, JSON.stringify(startAlpha.json));

    const joinBeforeUpsert = await requestJson(
      firstRuntime.baseUrl,
      'POST',
      '/api/t/alpha-streamer/internal/redeem/join',
      {
        redemptionId: 'tenant-key-persist-alpha-001',
        twitchUserId: 'viewer-alpha-persist-1',
        twitchUserName: 'ViewerAlphaPersistOne',
      },
      ownerHeaders(alphaRedeemKey),
    );
    assert.equal(joinBeforeUpsert.status, 200, JSON.stringify(joinBeforeUpsert.json));

    const upsertNewSlug = await requestJson(
      firstRuntime.baseUrl,
      'POST',
      '/api/owner/tenants/upsert',
      {
        tenantSlug: 'gamma-streamer',
        broadcasterId: '333333333',
      },
      ownerHeaders(ownerToken),
    );
    assert.equal(upsertNewSlug.status, 200, JSON.stringify(upsertNewSlug.json));

    const joinAfterUpsert = await requestJson(
      firstRuntime.baseUrl,
      'POST',
      '/api/t/alpha-streamer/internal/redeem/join',
      {
        redemptionId: 'tenant-key-persist-alpha-002',
        twitchUserId: 'viewer-alpha-persist-2',
        twitchUserName: 'ViewerAlphaPersistTwo',
      },
      ownerHeaders(alphaRedeemKey),
    );
    assert.equal(joinAfterUpsert.status, 200, JSON.stringify(joinAfterUpsert.json));

    await stopController(firstRuntime.child);
    firstRuntime = null;

    const secondPort = await getFreePort();
    secondRuntime = startController(secondPort, stateFilePath, {
      LEGACY_INTERNAL_REDEEM_SECRET_ENABLED: 'false',
    });
    await waitForHealth(secondRuntime.baseUrl, secondRuntime.child, secondRuntime.logs);

    const startAlphaAfterRestart = await requestJson(
      secondRuntime.baseUrl,
      'POST',
      '/api/t/alpha-streamer/mod/start',
      { mode: 'rows' },
      modHeaders(),
    );
    assert.equal(startAlphaAfterRestart.status, 200, JSON.stringify(startAlphaAfterRestart.json));

    const joinAfterRestart = await requestJson(
      secondRuntime.baseUrl,
      'POST',
      '/api/t/alpha-streamer/internal/redeem/join',
      {
        redemptionId: 'tenant-key-persist-alpha-003',
        twitchUserId: 'viewer-alpha-persist-3',
        twitchUserName: 'ViewerAlphaPersistThree',
      },
      ownerHeaders(alphaRedeemKey),
    );
    assert.equal(joinAfterRestart.status, 200, JSON.stringify(joinAfterRestart.json));

    const wrongTenantAfterRestart = await requestJson(
      secondRuntime.baseUrl,
      'POST',
      '/api/t/beta-streamer/internal/redeem/join',
      {
        redemptionId: 'tenant-key-persist-beta-001',
        twitchUserId: 'viewer-beta-persist',
        twitchUserName: 'ViewerBetaPersist',
      },
      ownerHeaders(alphaRedeemKey),
    );
    assert.equal(wrongTenantAfterRestart.status, 401, JSON.stringify(wrongTenantAfterRestart.json));
    assert.equal(wrongTenantAfterRestart.json?.error, 'invalid_tenant_redeem_auth');
  } finally {
    await stopController(firstRuntime?.child);
    await stopController(secondRuntime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('legacy internal redeem secret fallback can be enabled or disabled', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-redeem-legacy-fallback-it-'));
  const enabledStateFilePath = path.join(tempDir, 'enabled-state.json');
  const disabledStateFilePath = path.join(tempDir, 'disabled-state.json');
  let enabledRuntime = null;
  let disabledRuntime = null;

  try {
    const enabledPort = await getFreePort();
    enabledRuntime = startController(enabledPort, enabledStateFilePath, {
      LEGACY_INTERNAL_REDEEM_SECRET_ENABLED: 'true',
    });
    await waitForHealth(enabledRuntime.baseUrl, enabledRuntime.child, enabledRuntime.logs);

    const enabledStart = await requestJson(
      enabledRuntime.baseUrl,
      'POST',
      '/api/t/alpha-streamer/mod/start',
      { mode: 'rows' },
      modHeaders(),
    );
    assert.equal(enabledStart.status, 200, JSON.stringify(enabledStart.json));

    const fallbackAllowed = await requestJson(
      enabledRuntime.baseUrl,
      'POST',
      '/api/t/alpha-streamer/internal/redeem/join',
      {
        redemptionId: 'legacy-fallback-enabled-001',
        twitchUserId: 'viewer-fallback-enabled',
        twitchUserName: 'ViewerFallbackEnabled',
      },
      legacyRedeemHeaders(),
    );
    assert.equal(fallbackAllowed.status, 200, JSON.stringify(fallbackAllowed.json));
    assert.equal(fallbackAllowed.json?.ok, true);

    const disabledPort = await getFreePort();
    disabledRuntime = startController(disabledPort, disabledStateFilePath, {
      LEGACY_INTERNAL_REDEEM_SECRET_ENABLED: 'false',
    });
    await waitForHealth(disabledRuntime.baseUrl, disabledRuntime.child, disabledRuntime.logs);

    const disabledStart = await requestJson(
      disabledRuntime.baseUrl,
      'POST',
      '/api/t/alpha-streamer/mod/start',
      { mode: 'rows' },
      modHeaders(),
    );
    assert.equal(disabledStart.status, 200, JSON.stringify(disabledStart.json));

    const fallbackDenied = await requestJson(
      disabledRuntime.baseUrl,
      'POST',
      '/api/t/alpha-streamer/internal/redeem/join',
      {
        redemptionId: 'legacy-fallback-disabled-001',
        twitchUserId: 'viewer-fallback-disabled',
        twitchUserName: 'ViewerFallbackDisabled',
      },
      legacyRedeemHeaders(),
    );
    assert.equal(fallbackDenied.status, 401, JSON.stringify(fallbackDenied.json));
    assert.equal(fallbackDenied.json?.error, 'invalid_tenant_redeem_auth');
    assert.equal(fallbackDenied.json?.legacyFallbackEnabled, false);
  } finally {
    await stopController(enabledRuntime?.child);
    await stopController(disabledRuntime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('owner setup export lifecycle supports generate, save, regenerate, download, and safe remove', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-owner-setup-export-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath, {
      LEGACY_INTERNAL_REDEEM_SECRET_ENABLED: 'false',
      TENANT_BROADCASTER_OVERRIDES: JSON.stringify({ 'env-tenant': '44556677' }),
    });
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const ownerToken = createOwnerAuthToken();

    const upsert = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/owner/tenants/upsert',
      {
        tenantSlug: 'remove-me',
        broadcasterId: '99887766',
      },
      ownerHeaders(ownerToken),
    );
    assert.equal(upsert.status, 200, JSON.stringify(upsert.json));

    const upsertSingleOnly = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/owner/tenants/upsert',
      {
        tenantSlug: 'single-only',
        broadcasterId: '11223344',
      },
      ownerHeaders(ownerToken),
    );
    assert.equal(upsertSingleOnly.status, 200, JSON.stringify(upsertSingleOnly.json));

    const rotate = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/owner/tenants/redeem-key/rotate',
      { tenantSlug: 'remove-me' },
      ownerHeaders(ownerToken),
    );
    assert.equal(rotate.status, 200, JSON.stringify(rotate.json));

    const generate = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/owner/setup/generate',
      { tenantSlug: 'remove-me' },
      ownerHeaders(ownerToken),
    );
    assert.equal(generate.status, 200, JSON.stringify(generate.json));
    assert.equal(generate.json?.ok, true);
    assert.match(String(generate.json?.setupBlock ?? ''), /api\/t\/remove-me\/internal\/redeem\/join/);

    const singleMarkdownResponse = await fetchWithTimeout(`${runtime.baseUrl}/api/owner/setup/export/single`, {
      method: 'POST',
      headers: {
        ...ownerHeaders(ownerToken),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        tenantSlug: 'remove-me',
        format: 'markdown',
      }),
    });
    assert.equal(singleMarkdownResponse.status, 200);
    assert.match(String(singleMarkdownResponse.headers.get('content-type') ?? ''), /text\/markdown/i);
    const singleMarkdownBody = await singleMarkdownResponse.text();
    assert.match(singleMarkdownBody, /^BLOCK: remove-me$/m);
    assert.doesNotMatch(singleMarkdownBody, /^BLOCK: single-only$/m);
    assert.equal((singleMarkdownBody.match(/^BLOCK:/gm) ?? []).length, 1);

    const singleHtmlResponse = await fetchWithTimeout(`${runtime.baseUrl}/api/owner/setup/export/single`, {
      method: 'POST',
      headers: {
        ...ownerHeaders(ownerToken),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        tenantSlug: 'single-only',
        format: 'html',
      }),
    });
    assert.equal(singleHtmlResponse.status, 200);
    assert.match(String(singleHtmlResponse.headers.get('content-type') ?? ''), /text\/html/i);
    const singleHtmlBody = await singleHtmlResponse.text();
    assert.match(singleHtmlBody, /BLOCK: single-only/);
    assert.doesNotMatch(singleHtmlBody, /BLOCK: remove-me/);
    assert.equal((singleHtmlBody.match(/BLOCK:/g) ?? []).length, 1);

    const singlePdfResponse = await fetchWithTimeout(`${runtime.baseUrl}/api/owner/setup/export/single`, {
      method: 'POST',
      headers: {
        ...ownerHeaders(ownerToken),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        tenantSlug: 'remove-me',
        format: 'pdf',
      }),
    });
    assert.equal(singlePdfResponse.status, 200);
    assert.match(String(singlePdfResponse.headers.get('content-type') ?? ''), /application\/pdf/i);
    const singlePdfBody = Buffer.from(await singlePdfResponse.arrayBuffer());
    assert.ok(singlePdfBody.length > 100);

    const saveFirst = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/owner/setup/entries/upsert',
      { tenantSlug: 'remove-me' },
      ownerHeaders(ownerToken),
    );
    assert.equal(saveFirst.status, 200, JSON.stringify(saveFirst.json));
    assert.equal(saveFirst.json?.created, true);
    assert.equal(saveFirst.json?.updated, false);
    assert.equal(saveFirst.json?.unchanged, false);

    const saveSecond = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/owner/setup/entries/upsert',
      { tenantSlug: 'remove-me' },
      ownerHeaders(ownerToken),
    );
    assert.equal(saveSecond.status, 200, JSON.stringify(saveSecond.json));
    assert.equal(saveSecond.json?.created, false);
    assert.equal(saveSecond.json?.updated, false);
    assert.equal(saveSecond.json?.unchanged, true);
    assert.equal(saveSecond.json?.savedAt, saveFirst.json?.savedAt);

    const regenerate = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/owner/setup/export/regenerate',
      { includeAllKnownTenants: false },
      ownerHeaders(ownerToken),
    );
    assert.equal(regenerate.status, 200, JSON.stringify(regenerate.json));
    assert.equal(regenerate.json?.ok, true);
    assert.equal(regenerate.json?.count, 1);
    assert.equal(regenerate.json?.changed, true);
    assert.equal(regenerate.json?.markdownWritten, true);
    assert.equal(regenerate.json?.htmlWritten, true);
    assert.equal(regenerate.json?.pdfWritten, true);
    assert.equal(regenerate.json?.pdf?.exists, true);
    assert.ok(Number(regenerate.json?.pdf?.size ?? 0) > 100);

    const regenerateUnchanged = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/owner/setup/export/regenerate',
      { includeAllKnownTenants: false },
      ownerHeaders(ownerToken),
    );
    assert.equal(regenerateUnchanged.status, 200, JSON.stringify(regenerateUnchanged.json));
    assert.equal(regenerateUnchanged.json?.ok, true);
    assert.equal(regenerateUnchanged.json?.changed, false);
    assert.equal(regenerateUnchanged.json?.markdownWritten, false);
    assert.equal(regenerateUnchanged.json?.htmlWritten, false);
    assert.equal(regenerateUnchanged.json?.pdfWritten, false);
    assert.equal(regenerateUnchanged.json?.pdf?.updatedAt, regenerate.json?.pdf?.updatedAt);

    const pdfResponse = await fetchWithTimeout(`${runtime.baseUrl}/api/owner/setup/export/pdf`, {
      method: 'GET',
      headers: ownerHeaders(ownerToken),
    });
    assert.equal(pdfResponse.status, 200);
    assert.match(String(pdfResponse.headers.get('content-type') ?? ''), /application\/pdf/i);
    const pdfBody = Buffer.from(await pdfResponse.arrayBuffer());
    assert.ok(pdfBody.length > 100);

    const removeEnvManaged = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/owner/tenants/remove',
      { tenantSlug: 'env-tenant', removeRedeemKey: true },
      ownerHeaders(ownerToken),
    );
    assert.equal(removeEnvManaged.status, 409, JSON.stringify(removeEnvManaged.json));
    assert.equal(removeEnvManaged.json?.error, 'tenant_source_env_managed');

    const removePersisted = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/owner/tenants/remove',
      { tenantSlug: 'remove-me', removeRedeemKey: true },
      ownerHeaders(ownerToken),
    );
    assert.equal(removePersisted.status, 200, JSON.stringify(removePersisted.json));
    assert.equal(removePersisted.json?.removedBroadcasterMapping, true);
    assert.equal(removePersisted.json?.removedRedeemKey, true);
    assert.equal(removePersisted.json?.removedSetupEntry, true);

    const generateAfterRemove = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/owner/setup/generate',
      { tenantSlug: 'remove-me' },
      ownerHeaders(ownerToken),
    );
    assert.equal(generateAfterRemove.status, 404, JSON.stringify(generateAfterRemove.json));
    assert.equal(generateAfterRemove.json?.error, 'tenant_not_found');

    const singleAfterRemove = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/owner/setup/export/single',
      { tenantSlug: 'remove-me', format: 'markdown' },
      ownerHeaders(ownerToken),
    );
    assert.equal(singleAfterRemove.status, 404, JSON.stringify(singleAfterRemove.json));
    assert.equal(singleAfterRemove.json?.error, 'tenant_not_found');
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('owner single export keeps livebingo-01 slug naming stable across formats', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-owner-single-export-slug-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath, {
      LEGACY_INTERNAL_REDEEM_SECRET_ENABLED: 'false',
    });
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const ownerToken = createOwnerAuthToken();

    const upsert = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/owner/tenants/upsert',
      {
        tenantSlug: 'livebingo-01',
        broadcasterId: '77665544',
      },
      ownerHeaders(ownerToken),
    );
    assert.equal(upsert.status, 200, JSON.stringify(upsert.json));

    const markdownResponse = await fetchWithTimeout(`${runtime.baseUrl}/api/owner/setup/export/single`, {
      method: 'POST',
      headers: {
        ...ownerHeaders(ownerToken),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        tenantSlug: 'livebingo-01',
        format: 'markdown',
      }),
    });
    assert.equal(markdownResponse.status, 200);
    assert.match(String(markdownResponse.headers.get('content-type') ?? ''), /text\/markdown/i);
    assert.match(
      String(markdownResponse.headers.get('content-disposition') ?? ''),
      /MixItUp-Streamer-Setup-Reference-livebingo-01\.md/i,
    );
    const markdownBody = await markdownResponse.text();
    assert.match(markdownBody, /^BLOCK: livebingo-01$/m);
    assert.equal((markdownBody.match(/^BLOCK:/gm) ?? []).length, 1);
    assert.match(markdownBody, /REPLACE_WITH_TENANT_REDEEM_KEY_LIVEBINGO_01/);
    assert.match(markdownBody, /\/api\/t\/livebingo-01\/internal\/redeem\/join/);

    const htmlResponse = await fetchWithTimeout(`${runtime.baseUrl}/api/owner/setup/export/single`, {
      method: 'POST',
      headers: {
        ...ownerHeaders(ownerToken),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        tenantSlug: 'livebingo-01',
        format: 'html',
      }),
    });
    assert.equal(htmlResponse.status, 200);
    assert.match(String(htmlResponse.headers.get('content-type') ?? ''), /text\/html/i);
    assert.match(
      String(htmlResponse.headers.get('content-disposition') ?? ''),
      /MixItUp-Streamer-Setup-Reference-livebingo-01\.html/i,
    );
    const htmlBody = await htmlResponse.text();
    assert.match(htmlBody, /BLOCK: livebingo-01/);
    assert.equal((htmlBody.match(/BLOCK:/g) ?? []).length, 1);
    assert.match(htmlBody, /REPLACE_WITH_TENANT_REDEEM_KEY_LIVEBINGO_01/);

    const pdfResponse = await fetchWithTimeout(`${runtime.baseUrl}/api/owner/setup/export/single`, {
      method: 'POST',
      headers: {
        ...ownerHeaders(ownerToken),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        tenantSlug: 'livebingo-01',
        format: 'pdf',
      }),
    });
    assert.equal(pdfResponse.status, 200);
    assert.match(String(pdfResponse.headers.get('content-type') ?? ''), /application\/pdf/i);
    assert.match(
      String(pdfResponse.headers.get('content-disposition') ?? ''),
      /MixItUp-Streamer-Setup-Reference-livebingo-01\.pdf/i,
    );
    const pdfBody = Buffer.from(await pdfResponse.arrayBuffer());
    assert.ok(pdfBody.length > 100);
    assert.match(pdfBody.toString('utf8'), /livebingo-01/);
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});