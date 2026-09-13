import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const controllerRoot = path.resolve(process.cwd());
const requestTimeoutMs = 5000;
const modControlToken = 'tenant-routing-test-mod-token';

function modHeaders() {
  return {
    authorization: `Bearer ${modControlToken}`,
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
      MOD_CONTROL_TOKEN: modControlToken,
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
    // Best-effort cleanup.
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

async function requestJson(baseUrl, route, options = {}) {
  const method = options.method ?? 'GET';
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await fetchWithTimeout(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
    body,
  });
  const text = await response.text();
  const json = text.length > 0 ? JSON.parse(text) : null;

  return {
    status: response.status,
    json,
  };
}

test('tenant route aliases are available while preserving legacy defaults', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-tenant-route-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath, {
      TWITCH_BROADCASTER_ID: 'streamer-one',
      MULTI_TENANT_ENABLED: 'false',
      LEGACY_SINGLE_TENANT_FALLBACK: 'true',
    });
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const legacyTenancy = await requestJson(runtime.baseUrl, '/api/tenancy');
    assert.equal(legacyTenancy.status, 200, JSON.stringify(legacyTenancy.json));
    assert.equal(legacyTenancy.json?.defaultTenantSlug, 'streamer-one');
    assert.equal(legacyTenancy.json?.tenant?.slug, 'streamer-one');
    assert.equal(legacyTenancy.json?.tenant?.source, 'legacy-route');

    const tenantTenancy = await requestJson(runtime.baseUrl, '/api/t/streamer-one/tenancy');
    assert.equal(tenantTenancy.status, 200, JSON.stringify(tenantTenancy.json));
    assert.equal(tenantTenancy.json?.tenant?.slug, 'streamer-one');
    assert.equal(tenantTenancy.json?.tenant?.source, 'tenant-route');

    const additionalTenant = await requestJson(runtime.baseUrl, '/api/t/streamer-two/session');
    assert.equal(additionalTenant.status, 200, JSON.stringify(additionalTenant.json));
    assert.equal(additionalTenant.json?.status, 'idle');

    const additionalTenantTenancy = await requestJson(runtime.baseUrl, '/api/t/streamer-two/tenancy');
    assert.equal(additionalTenantTenancy.status, 200, JSON.stringify(additionalTenantTenancy.json));
    assert.equal(additionalTenantTenancy.json?.tenant?.slug, 'streamer-two');
    assert.equal(additionalTenantTenancy.json?.tenant?.source, 'tenant-route');

    const invalidTenant = await requestJson(runtime.baseUrl, '/api/t/INVALID!/session');
    assert.equal(invalidTenant.status, 400, JSON.stringify(invalidTenant.json));
    assert.equal(invalidTenant.json?.error, 'invalid_tenant_slug');
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('multi-tenant mode can enforce tenant-prefixed API routes', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-legacy-disabled-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath, {
      MULTI_TENANT_ENABLED: 'true',
      LEGACY_SINGLE_TENANT_FALLBACK: 'false',
      DEFAULT_TENANT_SLUG: 'alpha-streamer',
      TWITCH_BROADCASTER_ID: 'streamer-one',
    });
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const legacySession = await requestJson(runtime.baseUrl, '/api/session');
    assert.equal(legacySession.status, 410, JSON.stringify(legacySession.json));
    assert.equal(legacySession.json?.error, 'legacy_api_route_disabled');

    const tenantSession = await requestJson(runtime.baseUrl, '/api/t/alpha-streamer/session');
    assert.equal(tenantSession.status, 200, JSON.stringify(tenantSession.json));
    assert.equal(tenantSession.json?.status, 'idle');

    const wrongTenant = await requestJson(runtime.baseUrl, '/api/t/other-streamer/session');
    assert.equal(wrongTenant.status, 200, JSON.stringify(wrongTenant.json));
    assert.equal(wrongTenant.json?.status, 'idle');
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('tenant runtime state stays isolated across concurrent sessions and restart', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-tenant-isolation-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  const runtimeEnv = {
    MULTI_TENANT_ENABLED: 'true',
    LEGACY_SINGLE_TENANT_FALLBACK: 'false',
    DEFAULT_TENANT_SLUG: 'alpha-streamer',
    TWITCH_BROADCASTER_ID: 'streamer-one',
  };
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath, runtimeEnv);
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const alphaStart = await requestJson(runtime.baseUrl, '/api/t/alpha-streamer/chat/command', {
      method: 'POST',
      body: {
        command: '!start bingo',
        userId: 'alpha-mod',
        userName: 'Alpha Mod',
        isMod: true,
      },
    });
    assert.equal(alphaStart.status, 200, JSON.stringify(alphaStart.json));
    assert.equal(alphaStart.json?.ok, true, JSON.stringify(alphaStart.json));

    const betaStart = await requestJson(runtime.baseUrl, '/api/t/beta-streamer/chat/command', {
      method: 'POST',
      body: {
        command: '!start bingo',
        userId: 'beta-mod',
        userName: 'Beta Mod',
        isMod: true,
      },
    });
    assert.equal(betaStart.status, 200, JSON.stringify(betaStart.json));
    assert.equal(betaStart.json?.ok, true, JSON.stringify(betaStart.json));

    const alphaOptions = await requestJson(runtime.baseUrl, '/api/t/alpha-streamer/options');
    assert.equal(alphaOptions.status, 200, JSON.stringify(alphaOptions.json));
    assert.ok(alphaOptions.json?.count > 0, JSON.stringify(alphaOptions.json));
    const calledOption = alphaOptions.json.options[0];

    const alphaCall = await requestJson(runtime.baseUrl, '/api/t/alpha-streamer/chat/command', {
      method: 'POST',
      body: {
        command: `!call ${calledOption}`,
        userId: 'alpha-mod',
        userName: 'Alpha Mod',
        isMod: true,
      },
    });
    assert.equal(alphaCall.status, 200, JSON.stringify(alphaCall.json));
    assert.equal(alphaCall.json?.ok, true, JSON.stringify(alphaCall.json));

    const alphaSession = await requestJson(runtime.baseUrl, '/api/t/alpha-streamer/session');
    assert.equal(alphaSession.status, 200, JSON.stringify(alphaSession.json));
    assert.equal(alphaSession.json?.status, 'running', JSON.stringify(alphaSession.json));
    assert.ok(alphaSession.json?.calledOptions?.includes(calledOption), JSON.stringify(alphaSession.json));

    const betaSession = await requestJson(runtime.baseUrl, '/api/t/beta-streamer/session');
    assert.equal(betaSession.status, 200, JSON.stringify(betaSession.json));
    assert.equal(betaSession.json?.status, 'open', JSON.stringify(betaSession.json));
    assert.equal(betaSession.json?.calledOptions?.length, 0, JSON.stringify(betaSession.json));
    assert.notEqual(alphaSession.json?.id, betaSession.json?.id);

    const alphaUnlinkTheme = await requestJson(runtime.baseUrl, '/api/t/alpha-streamer/mod/theme', {
      method: 'PATCH',
      headers: modHeaders(),
      body: {
        linkControllerAndCards: false,
      },
    });
    assert.equal(alphaUnlinkTheme.status, 200, JSON.stringify(alphaUnlinkTheme.json));
    assert.equal(alphaUnlinkTheme.json?.linkControllerAndCards, false, JSON.stringify(alphaUnlinkTheme.json));

    const alphaControllerThemeUpdate = await requestJson(runtime.baseUrl, '/api/t/alpha-streamer/mod/theme', {
      method: 'PATCH',
      headers: modHeaders(),
      body: {
        scopeTarget: 'controller',
        skinId: 'candlelit-pumpkins',
        palette: {
          accent: '#1188aa',
        },
      },
    });
    assert.equal(alphaControllerThemeUpdate.status, 200, JSON.stringify(alphaControllerThemeUpdate.json));

    const alphaCardsThemeUpdate = await requestJson(runtime.baseUrl, '/api/t/alpha-streamer/mod/theme', {
      method: 'PATCH',
      headers: modHeaders(),
      body: {
        scopeTarget: 'cards',
        palette: {
          accent: '#aa3344',
        },
      },
    });
    assert.equal(alphaCardsThemeUpdate.status, 200, JSON.stringify(alphaCardsThemeUpdate.json));

    const alphaThemeState = await requestJson(runtime.baseUrl, '/api/t/alpha-streamer/mod/state', {
      headers: modHeaders(),
    });
    assert.equal(alphaThemeState.status, 200, JSON.stringify(alphaThemeState.json));
    assert.equal(alphaThemeState.json?.linkControllerAndCards, false);
    assert.equal(alphaThemeState.json?.controllerTheme?.palette?.accent, '#1188aa');
    assert.equal(alphaThemeState.json?.cardsTheme?.palette?.accent, '#aa3344');
    assert.equal(alphaThemeState.json?.scopedOverrides?.controller?.accent, '#1188aa');
    assert.equal(alphaThemeState.json?.scopedOverrides?.cards?.accent, '#aa3344');
    assert.equal(alphaThemeState.json?.theme?.skinId, 'candlelit-pumpkins');
    assert.equal(alphaThemeState.json?.controllerTheme?.skinId, 'candlelit-pumpkins');
    assert.equal(alphaThemeState.json?.cardsTheme?.skinId, 'candlelit-pumpkins');

    const betaThemeState = await requestJson(runtime.baseUrl, '/api/t/beta-streamer/mod/state', {
      headers: modHeaders(),
    });
    assert.equal(betaThemeState.status, 200, JSON.stringify(betaThemeState.json));
    assert.equal(betaThemeState.json?.linkControllerAndCards, true);
    assert.equal(
      betaThemeState.json?.controllerTheme?.palette?.accent,
      betaThemeState.json?.cardsTheme?.palette?.accent,
      JSON.stringify(betaThemeState.json),
    );
    assert.notEqual(betaThemeState.json?.cardsTheme?.palette?.accent, '#aa3344');
    assert.equal(betaThemeState.json?.theme?.skinId, undefined);

    await stopController(runtime.child);
    runtime = null;

    const restartPort = await getFreePort();
    runtime = startController(restartPort, stateFilePath, runtimeEnv);
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const alphaAfterRestart = await requestJson(runtime.baseUrl, '/api/t/alpha-streamer/session');
    assert.equal(alphaAfterRestart.status, 200, JSON.stringify(alphaAfterRestart.json));
    assert.equal(alphaAfterRestart.json?.status, 'running', JSON.stringify(alphaAfterRestart.json));
    assert.ok(alphaAfterRestart.json?.calledOptions?.includes(calledOption), JSON.stringify(alphaAfterRestart.json));

    const betaAfterRestart = await requestJson(runtime.baseUrl, '/api/t/beta-streamer/session');
    assert.equal(betaAfterRestart.status, 200, JSON.stringify(betaAfterRestart.json));
    assert.equal(betaAfterRestart.json?.status, 'open', JSON.stringify(betaAfterRestart.json));
    assert.equal(betaAfterRestart.json?.calledOptions?.length, 0, JSON.stringify(betaAfterRestart.json));

    const alphaThemeAfterRestart = await requestJson(runtime.baseUrl, '/api/t/alpha-streamer/mod/state', {
      headers: modHeaders(),
    });
    assert.equal(alphaThemeAfterRestart.status, 200, JSON.stringify(alphaThemeAfterRestart.json));
    assert.equal(alphaThemeAfterRestart.json?.linkControllerAndCards, false);
    assert.equal(alphaThemeAfterRestart.json?.controllerTheme?.palette?.accent, '#1188aa');
    assert.equal(alphaThemeAfterRestart.json?.cardsTheme?.palette?.accent, '#aa3344');
    assert.equal(alphaThemeAfterRestart.json?.theme?.skinId, 'candlelit-pumpkins');
    assert.equal(alphaThemeAfterRestart.json?.controllerTheme?.skinId, 'candlelit-pumpkins');
    assert.equal(alphaThemeAfterRestart.json?.cardsTheme?.skinId, 'candlelit-pumpkins');

    const betaThemeAfterRestart = await requestJson(runtime.baseUrl, '/api/t/beta-streamer/mod/state', {
      headers: modHeaders(),
    });
    assert.equal(betaThemeAfterRestart.status, 200, JSON.stringify(betaThemeAfterRestart.json));
    assert.equal(betaThemeAfterRestart.json?.linkControllerAndCards, true);
    assert.equal(
      betaThemeAfterRestart.json?.controllerTheme?.palette?.accent,
      betaThemeAfterRestart.json?.cardsTheme?.palette?.accent,
      JSON.stringify(betaThemeAfterRestart.json),
    );
    assert.notEqual(betaThemeAfterRestart.json?.cardsTheme?.palette?.accent, '#aa3344');
    assert.equal(betaThemeAfterRestart.json?.theme?.skinId, undefined);
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});
