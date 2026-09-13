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
const modAuthSessionSecret = 'controller-test-mod-session-secret';
const testBroadcasterId = 'controller-test-broadcaster-id';

function createModAuthToken({
  role = 'moderator',
  broadcasterId = testBroadcasterId,
  tenantSlug,
  userId = 'controller-test-user-id',
  userLogin = 'controller_test_user',
  userName = 'Controller Test User',
} = {}) {
  const now = Date.now();
  const payload = {
    v: 1,
    type: 'mod-auth',
    ...(tenantSlug ? { tenantSlug } : {}),
    broadcasterId,
    userId,
    userLogin,
    userName,
    role,
    iat: now,
    exp: now + 60 * 60 * 1000,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', modAuthSessionSecret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
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
      TWITCH_CLIENT_ID: 'controller-test-client-id',
      TWITCH_CLIENT_SECRET: 'controller-test-client-secret',
      TWITCH_BROADCASTER_ID: testBroadcasterId,
      MOD_AUTH_SESSION_SECRET: modAuthSessionSecret,
      MOD_AUTH_ALLOW_LEGACY_TOKEN: 'false',
      MOD_CONTROL_TOKEN: '',
      PUBLIC_API_BASE_URL: 'https://api.custom-overlays.com',
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
    // Best-effort process cleanup for test runtimes.
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
    setCookie: response.headers.get('set-cookie'),
  };
}

test('mod auth me enforces signed-out, authorized, unauthorized, and invalid-cookie states', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-mod-auth-session-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath);
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const signedOut = await requestJson(runtime.baseUrl, 'GET', '/api/mod/auth/me');
    assert.equal(signedOut.status, 401, JSON.stringify(signedOut.json));
    assert.equal(signedOut.json?.error, 'mod_auth_required');
    assert.equal(signedOut.json?.authenticated, false);
    assert.equal(signedOut.json?.authorized, false);

    const authorized = await requestJson(runtime.baseUrl, 'GET', '/api/mod/auth/me', undefined, {
      authorization: `Bearer ${createModAuthToken({ role: 'moderator' })}`,
    });
    assert.equal(authorized.status, 200, JSON.stringify(authorized.json));
    assert.equal(authorized.json?.authenticated, true);
    assert.equal(authorized.json?.authorized, true);
    assert.equal(authorized.json?.authMode, 'twitch-session');
    assert.equal(authorized.json?.tokenSource, 'bearer');
    assert.equal(authorized.json?.role, 'moderator');

    const unauthorized = await requestJson(runtime.baseUrl, 'GET', '/api/mod/auth/me', undefined, {
      authorization: `Bearer ${createModAuthToken({ role: 'unauthorized' })}`,
    });
    assert.equal(unauthorized.status, 403, JSON.stringify(unauthorized.json));
    assert.equal(unauthorized.json?.error, 'mod_privileges_required');
    assert.equal(unauthorized.json?.authenticated, true);
    assert.equal(unauthorized.json?.authorized, false);
    assert.equal(unauthorized.json?.role, 'unauthorized');

    const invalidCookie = await requestJson(runtime.baseUrl, 'GET', '/api/mod/auth/me', undefined, {
      cookie: 'mod_auth=invalid.token',
    });
    assert.equal(invalidCookie.status, 401, JSON.stringify(invalidCookie.json));
    assert.equal(invalidCookie.json?.error, 'invalid_mod_session');
    assert.match(invalidCookie.setCookie ?? '', /mod_auth=/);
    assert.match(invalidCookie.setCookie ?? '', /Max-Age=0/);
    assert.match(invalidCookie.setCookie ?? '', /HttpOnly/);
    assert.match(invalidCookie.setCookie ?? '', /SameSite=None/);
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('mod auth session tokens enforce tenant broadcaster mapping with global fallback', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-mod-auth-tenant-map-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath, {
      TWITCH_BROADCASTER_ID: testBroadcasterId,
      TENANT_BROADCASTER_OVERRIDES: JSON.stringify({
        'tenant-a': 'tenant-a-broadcaster-id',
        'tenant-b': 'tenant-b-broadcaster-id',
      }),
    });
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const tenantSuccess = await requestJson(runtime.baseUrl, 'GET', '/api/t/tenant-a/mod/auth/me', undefined, {
      authorization: `Bearer ${createModAuthToken({
        role: 'moderator',
        tenantSlug: 'tenant-a',
        broadcasterId: 'tenant-a-broadcaster-id',
      })}`,
    });
    assert.equal(tenantSuccess.status, 200, JSON.stringify(tenantSuccess.json));
    assert.equal(tenantSuccess.json?.authenticated, true);
    assert.equal(tenantSuccess.json?.authorized, true);
    assert.equal(tenantSuccess.json?.role, 'moderator');

    const tenantBroadcasterMismatch = await requestJson(runtime.baseUrl, 'GET', '/api/t/tenant-b/mod/auth/me', undefined, {
      authorization: `Bearer ${createModAuthToken({
        role: 'moderator',
        tenantSlug: 'tenant-b',
        broadcasterId: 'tenant-a-broadcaster-id',
      })}`,
    });
    assert.equal(tenantBroadcasterMismatch.status, 403, JSON.stringify(tenantBroadcasterMismatch.json));
    assert.equal(tenantBroadcasterMismatch.json?.error, 'mod_session_broadcaster_mismatch');
    assert.equal(tenantBroadcasterMismatch.json?.authenticated, true);

    const tenantClaimMismatch = await requestJson(runtime.baseUrl, 'GET', '/api/t/tenant-b/mod/auth/me', undefined, {
      authorization: `Bearer ${createModAuthToken({
        role: 'moderator',
        tenantSlug: 'tenant-a',
        broadcasterId: 'tenant-a-broadcaster-id',
      })}`,
    });
    assert.equal(tenantClaimMismatch.status, 403, JSON.stringify(tenantClaimMismatch.json));
    assert.equal(tenantClaimMismatch.json?.error, 'mod_session_tenant_mismatch');
    assert.equal(tenantClaimMismatch.json?.authenticated, true);

    const globalFallback = await requestJson(runtime.baseUrl, 'GET', '/api/t/unmapped-tenant/mod/auth/me', undefined, {
      authorization: `Bearer ${createModAuthToken({
        role: 'moderator',
        tenantSlug: 'unmapped-tenant',
        broadcasterId: testBroadcasterId,
      })}`,
    });
    assert.equal(globalFallback.status, 200, JSON.stringify(globalFallback.json));
    assert.equal(globalFallback.json?.authenticated, true);
    assert.equal(globalFallback.json?.authorized, true);
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('mod auth cookie domain is applied for non-local domains and ignored for localhost', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-mod-cookie-domain-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath, {
      MOD_AUTH_COOKIE_DOMAIN: '.custom-overlays.com',
    });
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const withDomain = await requestJson(runtime.baseUrl, 'GET', '/api/mod/auth/me', undefined, {
      cookie: 'mod_auth=invalid.token',
    });
    assert.equal(withDomain.status, 401, JSON.stringify(withDomain.json));
    assert.match(withDomain.setCookie ?? '', /Domain=custom-overlays\.com/);
  } finally {
    await stopController(runtime?.child);
  }

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath, {
      MOD_AUTH_COOKIE_DOMAIN: 'localhost',
    });
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const localDomainIgnored = await requestJson(runtime.baseUrl, 'GET', '/api/mod/auth/me', undefined, {
      cookie: 'mod_auth=invalid.token',
    });
    assert.equal(localDomainIgnored.status, 401, JSON.stringify(localDomainIgnored.json));
    assert.ok(!(localDomainIgnored.setCookie ?? '').includes('Domain='));
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('mod testing viewer link endpoint enforces allowlist and returns usable viewer auth', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-mod-testing-link-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  const allowlistedUserId = 'owner-testing-user-id';
  const allowlistedUserLogin = 'owner_testing_login';
  const allowlistedUserName = 'Owner Testing User';
  const legacyToken = 'legacy-testing-token';
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath, {
      MOD_TESTING_ALLOWLIST: `${allowlistedUserId},${allowlistedUserLogin}`,
      VIEWER_BASE_URL: 'https://public-card.custom-overlays.com',
      VIEWER_AUTH_TOKEN_SECRET: 'controller-test-viewer-auth-secret',
      MOD_CONTROL_TOKEN: legacyToken,
      MOD_AUTH_ALLOW_LEGACY_TOKEN: 'true',
    });
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const startRound = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/start',
      { mode: 'normal' },
      {
        authorization: `Bearer ${createModAuthToken({
          role: 'moderator',
          userId: allowlistedUserId,
          userLogin: allowlistedUserLogin,
          userName: allowlistedUserName,
        })}`,
      },
    );
    assert.equal(startRound.status, 200, JSON.stringify(startRound.json));
    assert.equal(typeof startRound.json?.session?.id, 'string');

    const noAuth = await requestJson(runtime.baseUrl, 'POST', '/api/mod/testing/viewer-link', {});
    assert.equal(noAuth.status, 401, JSON.stringify(noAuth.json));
    assert.equal(noAuth.json?.error, 'mod_auth_required');

    const legacyAuth = await requestJson(runtime.baseUrl, 'POST', '/api/mod/testing/viewer-link', {}, {
      authorization: `Bearer ${legacyToken}`,
    });
    assert.equal(legacyAuth.status, 403, JSON.stringify(legacyAuth.json));
    assert.equal(legacyAuth.json?.error, 'testing_identity_required');
    assert.equal(legacyAuth.json?.legacyTokenUsed, true);

    const denied = await requestJson(runtime.baseUrl, 'POST', '/api/mod/testing/viewer-link', {}, {
      authorization: `Bearer ${createModAuthToken({
        role: 'moderator',
        userId: 'non-allowlisted-mod-id',
        userLogin: 'other_mod_login',
        userName: 'Other Mod',
      })}`,
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.json));
    assert.equal(denied.json?.error, 'testing_access_denied');

    const allowlisted = await requestJson(runtime.baseUrl, 'POST', '/api/mod/testing/viewer-link', {}, {
      authorization: `Bearer ${createModAuthToken({
        role: 'moderator',
        userId: allowlistedUserId,
        userLogin: allowlistedUserLogin,
        userName: allowlistedUserName,
      })}`,
    });
    assert.equal(allowlisted.status, 200, JSON.stringify(allowlisted.json));
    assert.equal(allowlisted.json?.ok, true);
    assert.equal(allowlisted.json?.userId, allowlistedUserId);
    assert.equal(allowlisted.json?.userName, allowlistedUserName);
    assert.equal(typeof allowlisted.json?.sessionId, 'string');
    assert.equal(allowlisted.json?.sessionId, startRound.json?.session?.id);
    assert.equal(allowlisted.json?.joined, true);
    assert.equal(typeof allowlisted.json?.viewerUrl, 'string');
    assert.equal(typeof allowlisted.json?.expiresInSeconds, 'number');
    assert.ok(allowlisted.json?.expiresInSeconds > 0);

    const secondAllowlisted = await requestJson(runtime.baseUrl, 'POST', '/api/mod/testing/viewer-link', {}, {
      authorization: `Bearer ${createModAuthToken({
        role: 'moderator',
        userId: allowlistedUserId,
        userLogin: allowlistedUserLogin,
        userName: allowlistedUserName,
      })}`,
    });
    assert.equal(secondAllowlisted.status, 200, JSON.stringify(secondAllowlisted.json));
    assert.equal(secondAllowlisted.json?.joined, false);

    const viewerUrl = new URL(String(allowlisted.json?.viewerUrl ?? ''));
    const hashParams = new URLSearchParams(viewerUrl.hash.replace(/^#/, ''));
    const viewerAuthToken = hashParams.get('auth');
    assert.equal(typeof viewerAuthToken, 'string');
    assert.ok((viewerAuthToken ?? '').length > 0);

    const cardResponse = await requestJson(runtime.baseUrl, 'GET', '/api/player/card', undefined, {
      authorization: `Bearer ${viewerAuthToken}`,
    });
    assert.equal(cardResponse.status, 200, JSON.stringify(cardResponse.json));
    assert.equal(cardResponse.json?.ok, true);
    assert.equal(cardResponse.json?.player?.userId, allowlistedUserId);
    assert.equal(cardResponse.json?.session?.id, startRound.json?.session?.id);
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});
