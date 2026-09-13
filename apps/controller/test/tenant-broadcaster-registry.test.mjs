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
const modAuthSessionSecret = 'controller-test-tenant-broadcaster-session-secret';
const internalRedeemSecret = 'controller-test-tenant-broadcaster-internal-secret';

function createModAuthToken({
  role = 'moderator',
  tenantSlug,
  broadcasterId,
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
      TWITCH_BROADCASTER_ID: '',
      TENANT_BROADCASTER_OVERRIDES: '',
      MOD_AUTH_SESSION_SECRET: modAuthSessionSecret,
      MOD_AUTH_ALLOW_LEGACY_TOKEN: 'false',
      MOD_CONTROL_TOKEN: '',
      INTERNAL_REDEEM_SECRET: internalRedeemSecret,
      MULTI_TENANT_ENABLED: 'true',
      LEGACY_SINGLE_TENANT_FALLBACK: 'true',
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

test('internal tenant broadcaster upsert enables tenant-scoped mod auth checks', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-tenant-broadcaster-upsert-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath);
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const tenantSlug = 'livebingo-001';
    const broadcasterId = '123456789';
    const modToken = createModAuthToken({
      role: 'moderator',
      tenantSlug,
      broadcasterId,
    });

    const beforeMapping = await requestJson(runtime.baseUrl, 'GET', `/api/t/${tenantSlug}/mod/auth/me`, undefined, {
      authorization: `Bearer ${modToken}`,
    });
    assert.equal(beforeMapping.status, 503, JSON.stringify(beforeMapping.json));
    assert.equal(beforeMapping.json?.error, 'mod_auth_not_configured');

    const unauthorizedList = await requestJson(runtime.baseUrl, 'GET', '/api/internal/tenant-broadcasters');
    assert.equal(unauthorizedList.status, 401, JSON.stringify(unauthorizedList.json));

    const upsert = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/internal/tenant-broadcasters/upsert',
      { tenantSlug, broadcasterId },
      {
        authorization: `Bearer ${internalRedeemSecret}`,
      },
    );
    assert.equal(upsert.status, 200, JSON.stringify(upsert.json));
    assert.equal(upsert.json?.ok, true);
    assert.equal(upsert.json?.tenantSlug, tenantSlug);
    assert.equal(upsert.json?.broadcasterId, broadcasterId);
    assert.equal(upsert.json?.updated, true);

    const mappingList = await requestJson(runtime.baseUrl, 'GET', '/api/internal/tenant-broadcasters', undefined, {
      authorization: `Bearer ${internalRedeemSecret}`,
    });
    assert.equal(mappingList.status, 200, JSON.stringify(mappingList.json));
    assert.equal(mappingList.json?.mappings?.[tenantSlug], broadcasterId);

    const afterMapping = await requestJson(runtime.baseUrl, 'GET', `/api/t/${tenantSlug}/mod/auth/me`, undefined, {
      authorization: `Bearer ${modToken}`,
    });
    assert.equal(afterMapping.status, 200, JSON.stringify(afterMapping.json));
    assert.equal(afterMapping.json?.authorized, true);
    assert.equal(afterMapping.json?.role, 'moderator');
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('tenant broadcaster registry persists across controller restart', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-tenant-broadcaster-persist-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  const tenantSlug = 'livebingo-002';
  const broadcasterId = '987654321';
  const modToken = createModAuthToken({
    role: 'moderator',
    tenantSlug,
    broadcasterId,
  });

  let firstRuntime = null;
  let secondRuntime = null;

  try {
    const firstPort = await getFreePort();
    firstRuntime = startController(firstPort, stateFilePath);
    await waitForHealth(firstRuntime.baseUrl, firstRuntime.child, firstRuntime.logs);

    const upsert = await requestJson(
      firstRuntime.baseUrl,
      'POST',
      '/api/internal/tenant-broadcasters/upsert',
      { tenantSlug, broadcasterId },
      {
        authorization: `Bearer ${internalRedeemSecret}`,
      },
    );
    assert.equal(upsert.status, 200, JSON.stringify(upsert.json));
    assert.equal(upsert.json?.updated, true);

    await stopController(firstRuntime.child);
    firstRuntime = null;

    const secondPort = await getFreePort();
    secondRuntime = startController(secondPort, stateFilePath);
    await waitForHealth(secondRuntime.baseUrl, secondRuntime.child, secondRuntime.logs);

    const mappingList = await requestJson(secondRuntime.baseUrl, 'GET', '/api/internal/tenant-broadcasters', undefined, {
      authorization: `Bearer ${internalRedeemSecret}`,
    });
    assert.equal(mappingList.status, 200, JSON.stringify(mappingList.json));
    assert.equal(mappingList.json?.mappings?.[tenantSlug], broadcasterId);

    const modAuth = await requestJson(secondRuntime.baseUrl, 'GET', `/api/t/${tenantSlug}/mod/auth/me`, undefined, {
      authorization: `Bearer ${modToken}`,
    });
    assert.equal(modAuth.status, 200, JSON.stringify(modAuth.json));
    assert.equal(modAuth.json?.authorized, true);
  } finally {
    await stopController(firstRuntime?.child);
    await stopController(secondRuntime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});
