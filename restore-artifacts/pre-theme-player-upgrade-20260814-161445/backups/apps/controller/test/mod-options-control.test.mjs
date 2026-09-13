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
const modControlToken = 'controller-test-mod-token';

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
  };
}

test('mod auth me reports legacy fallback mode and disabled fallback errors', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-mod-auth-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath, {
      MOD_AUTH_ALLOW_LEGACY_TOKEN: 'true',
    });
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const legacyAllowed = await requestJson(runtime.baseUrl, 'GET', '/api/mod/auth/me', undefined, modHeaders());
    assert.equal(legacyAllowed.status, 200, JSON.stringify(legacyAllowed.json));
    assert.equal(legacyAllowed.json?.authorized, true);
    assert.equal(legacyAllowed.json?.authMode, 'legacy-token');
    assert.equal(legacyAllowed.json?.legacyTokenUsed, true);
  } finally {
    await stopController(runtime?.child);
  }

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath, {
      MOD_AUTH_ALLOW_LEGACY_TOKEN: 'false',
    });
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const legacyDisabled = await requestJson(runtime.baseUrl, 'GET', '/api/mod/auth/me', undefined, modHeaders());
    assert.equal(legacyDisabled.status, 401, JSON.stringify(legacyDisabled.json));
    assert.equal(legacyDisabled.json?.error, 'legacy_mod_token_disabled');
    assert.equal(legacyDisabled.json?.authenticated, false);
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('mod option endpoints preserve active-session option snapshots', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-options-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath);
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const optionsBefore = await requestJson(runtime.baseUrl, 'GET', '/api/mod/options', undefined, modHeaders());
    assert.equal(optionsBefore.status, 200, JSON.stringify(optionsBefore.json));
    assert.ok(Array.isArray(optionsBefore.json?.options));

    const addOptionResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/options',
      { label: 'Temporary Control Option' },
      modHeaders(),
    );
    assert.equal(addOptionResponse.status, 201, JSON.stringify(addOptionResponse.json));

    const startSessionResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/start',
      { mode: 'normal' },
      modHeaders(),
    );
    assert.equal(startSessionResponse.status, 200, JSON.stringify(startSessionResponse.json));

    const activeOptions = await requestJson(runtime.baseUrl, 'GET', '/api/options');
    assert.equal(activeOptions.status, 200, JSON.stringify(activeOptions.json));
    const activeSnapshot = activeOptions.json?.options;
    assert.ok(Array.isArray(activeSnapshot), 'Expected active session option snapshot array.');

    const targetLabel = activeSnapshot[0];
    assert.equal(typeof targetLabel, 'string');

    const latestOptions = await requestJson(runtime.baseUrl, 'GET', '/api/mod/options', undefined, modHeaders());
    assert.equal(latestOptions.status, 200, JSON.stringify(latestOptions.json));

    const targetOption = latestOptions.json.options.find((entry) => entry.label === targetLabel);
    assert.ok(targetOption, 'Expected to find target option in mod option pool.');
    const secondaryOption = latestOptions.json.options.find(
      (entry) => entry.enabled && entry.id !== targetOption.id,
    );
    assert.ok(secondaryOption, 'Expected to find a secondary enabled option in mod option pool.');

    const disableResponse = await requestJson(
      runtime.baseUrl,
      'PATCH',
      `/api/mod/options/${encodeURIComponent(targetOption.id)}`,
      { enabled: false },
      modHeaders(),
    );
    assert.equal(disableResponse.status, 200, JSON.stringify(disableResponse.json));

    const secondaryDisableResponse = await requestJson(
      runtime.baseUrl,
      'PATCH',
      `/api/mod/options/${encodeURIComponent(secondaryOption.id)}`,
      { enabled: false },
      modHeaders(),
    );
    assert.equal(secondaryDisableResponse.status, 200, JSON.stringify(secondaryDisableResponse.json));

    const secondaryEnableResponse = await requestJson(
      runtime.baseUrl,
      'PATCH',
      `/api/mod/options/${encodeURIComponent(secondaryOption.id)}`,
      { enabled: true },
      modHeaders(),
    );
    assert.equal(secondaryEnableResponse.status, 200, JSON.stringify(secondaryEnableResponse.json));

    const optionsWhileRunning = await requestJson(runtime.baseUrl, 'GET', '/api/options');
    assert.equal(optionsWhileRunning.status, 200, JSON.stringify(optionsWhileRunning.json));
    assert.deepEqual(optionsWhileRunning.json.options, activeSnapshot);

    const newEnabledOptionLabel = 'Controller Session New Option';
    const addEnabledOptionResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/options',
      { label: newEnabledOptionLabel, enabled: true },
      modHeaders(),
    );
    assert.equal(addEnabledOptionResponse.status, 201, JSON.stringify(addEnabledOptionResponse.json));

    const newSessionResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/session/new',
      { mode: 'rows' },
      modHeaders(),
    );
    assert.equal(newSessionResponse.status, 200, JSON.stringify(newSessionResponse.json));

    const optionsAfterRestart = await requestJson(runtime.baseUrl, 'GET', '/api/options');
    assert.equal(optionsAfterRestart.status, 200, JSON.stringify(optionsAfterRestart.json));
    assert.ok(
      !optionsAfterRestart.json.options.includes(targetLabel),
      'Expected disabled option to be excluded from future sessions.',
    );
    assert.ok(
      optionsAfterRestart.json.options.includes(secondaryOption.label),
      'Expected re-enabled option to remain available in future sessions.',
    );
    assert.ok(
      optionsAfterRestart.json.options.includes(newEnabledOptionLabel),
      'Expected newly enabled option to be included in new sessions.',
    );
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('mod options bulk-delete validates auth, payloads, min-enabled guard, and atomic behavior', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-options-bulk-delete-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  const minEnabledOptions = 24;
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath);
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const unauthBulkDelete = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/options/bulk-delete',
      { optionIds: ['opt_missing_auth_case'] },
    );
    assert.equal(unauthBulkDelete.status, 401, JSON.stringify(unauthBulkDelete.json));

    const poolBefore = await requestJson(runtime.baseUrl, 'GET', '/api/mod/options', undefined, modHeaders());
    assert.equal(poolBefore.status, 200, JSON.stringify(poolBefore.json));
    assert.ok(Array.isArray(poolBefore.json?.options), 'Expected options array before bulk delete checks.');

    const optionIdsBefore = poolBefore.json.options.map((entry) => entry.id);
    const enabledBefore = poolBefore.json.options.filter((entry) => entry.enabled);
    assert.ok(
      enabledBefore.length > minEnabledOptions,
      `Expected more than ${minEnabledOptions} enabled options for min-enabled guard test.`,
    );

    const invalidPayload = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/options/bulk-delete',
      {},
      modHeaders(),
    );
    assert.equal(invalidPayload.status, 400, JSON.stringify(invalidPayload.json));
    assert.equal(invalidPayload.json?.error, 'invalid_option_bulk_delete_payload');

    const afterInvalidPayload = await requestJson(runtime.baseUrl, 'GET', '/api/mod/options', undefined, modHeaders());
    assert.equal(afterInvalidPayload.status, 200, JSON.stringify(afterInvalidPayload.json));
    assert.deepEqual(afterInvalidPayload.json.options.map((entry) => entry.id), optionIdsBefore);

    const emptyPayload = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/options/bulk-delete',
      { optionIds: ['   '] },
      modHeaders(),
    );
    assert.equal(emptyPayload.status, 400, JSON.stringify(emptyPayload.json));
    assert.equal(emptyPayload.json?.error, 'invalid_option_bulk_delete_payload');

    const afterEmptyPayload = await requestJson(runtime.baseUrl, 'GET', '/api/mod/options', undefined, modHeaders());
    assert.equal(afterEmptyPayload.status, 200, JSON.stringify(afterEmptyPayload.json));
    assert.deepEqual(afterEmptyPayload.json.options.map((entry) => entry.id), optionIdsBefore);

    const missingId = 'opt_missing_bulk_delete_case';
    const missingOptionResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/options/bulk-delete',
      { optionIds: [optionIdsBefore[0], missingId] },
      modHeaders(),
    );
    assert.equal(missingOptionResponse.status, 404, JSON.stringify(missingOptionResponse.json));
    assert.equal(missingOptionResponse.json?.error, 'option_not_found');
    assert.ok(Array.isArray(missingOptionResponse.json?.missing));
    assert.ok(missingOptionResponse.json.missing.includes(missingId));

    const afterMissingOption = await requestJson(runtime.baseUrl, 'GET', '/api/mod/options', undefined, modHeaders());
    assert.equal(afterMissingOption.status, 200, JSON.stringify(afterMissingOption.json));
    assert.deepEqual(afterMissingOption.json.options.map((entry) => entry.id), optionIdsBefore);

    const tooManyEnabledIds = enabledBefore
      .slice(0, enabledBefore.length - minEnabledOptions + 1)
      .map((entry) => entry.id);
    assert.ok(tooManyEnabledIds.length > 0, 'Expected at least one option id for min-enabled rejection case.');

    const minEnabledRejection = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/options/bulk-delete',
      { optionIds: tooManyEnabledIds },
      modHeaders(),
    );
    assert.equal(minEnabledRejection.status, 400, JSON.stringify(minEnabledRejection.json));
    assert.equal(minEnabledRejection.json?.error, 'min_enabled_options_required');

    const afterMinEnabledRejection = await requestJson(runtime.baseUrl, 'GET', '/api/mod/options', undefined, modHeaders());
    assert.equal(afterMinEnabledRejection.status, 200, JSON.stringify(afterMinEnabledRejection.json));
    assert.deepEqual(afterMinEnabledRejection.json.options.map((entry) => entry.id), optionIdsBefore);

    const beforeSuccess = await requestJson(runtime.baseUrl, 'GET', '/api/mod/options', undefined, modHeaders());
    assert.equal(beforeSuccess.status, 200, JSON.stringify(beforeSuccess.json));
    const enabledCountBeforeSuccess = beforeSuccess.json.options.filter((entry) => entry.enabled).length;
    const removableEnabledCount = Math.min(2, enabledCountBeforeSuccess - minEnabledOptions);
    assert.ok(removableEnabledCount >= 1, 'Expected at least one safely removable enabled option.');

    const removableIds = beforeSuccess.json.options
      .filter((entry) => entry.enabled)
      .slice(0, removableEnabledCount)
      .map((entry) => entry.id);

    const successResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/options/bulk-delete',
      { optionIds: removableIds },
      modHeaders(),
    );
    assert.equal(successResponse.status, 200, JSON.stringify(successResponse.json));
    assert.equal(successResponse.json?.ok, true);
    assert.equal(successResponse.json?.changed, true);
    assert.equal(successResponse.json?.changedCount, removableIds.length);
    assert.ok(Array.isArray(successResponse.json?.removedIds));
    for (const removedId of removableIds) {
      assert.ok(successResponse.json.removedIds.includes(removedId));
    }
    assert.equal(successResponse.json?.count, beforeSuccess.json.options.length - removableIds.length);
    assert.equal(successResponse.json?.enabledCount, enabledCountBeforeSuccess - removableIds.length);

    const afterSuccess = await requestJson(runtime.baseUrl, 'GET', '/api/mod/options', undefined, modHeaders());
    assert.equal(afterSuccess.status, 200, JSON.stringify(afterSuccess.json));
    assert.equal(afterSuccess.json.options.length, beforeSuccess.json.options.length - removableIds.length);

    const remainingIds = new Set(afterSuccess.json.options.map((entry) => entry.id));
    for (const removedId of removableIds) {
      assert.equal(remainingIds.has(removedId), false, `Expected option ${removedId} to be removed.`);
    }
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('refresh-inactive endpoint rejects live rounds and restores idle option-pool visibility', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-refresh-inactive-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath);
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const poolBefore = await requestJson(runtime.baseUrl, 'GET', '/api/mod/options', undefined, modHeaders());
    assert.equal(poolBefore.status, 200, JSON.stringify(poolBefore.json));
    const optionToDisable = poolBefore.json?.options?.find((entry) => entry?.enabled);
    assert.ok(optionToDisable, 'Expected an enabled pool option for refresh-inactive test.');

    const startResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/start',
      { mode: 'normal' },
      modHeaders(),
    );
    assert.equal(startResponse.status, 200, JSON.stringify(startResponse.json));
    assert.equal(startResponse.json?.session?.status, 'open');

    const refreshWhileOpen = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/session/refresh-inactive',
      {},
      modHeaders(),
    );
    assert.equal(refreshWhileOpen.status, 409, JSON.stringify(refreshWhileOpen.json));
    assert.equal(refreshWhileOpen.json?.error, 'refresh_inactive_rejected');

    const endRound = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/stop',
      { end: true },
      modHeaders(),
    );
    assert.equal(endRound.status, 200, JSON.stringify(endRound.json));
    assert.equal(endRound.json?.session?.status, 'ended');

    const disableOption = await requestJson(
      runtime.baseUrl,
      'PATCH',
      `/api/mod/options/${encodeURIComponent(optionToDisable.id)}`,
      { enabled: false },
      modHeaders(),
    );
    assert.equal(disableOption.status, 200, JSON.stringify(disableOption.json));

    const refreshInactive = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/session/refresh-inactive',
      {},
      modHeaders(),
    );
    assert.equal(refreshInactive.status, 200, JSON.stringify(refreshInactive.json));
    assert.equal(refreshInactive.json?.status, 'idle');
    assert.equal(refreshInactive.json?.session, null);

    const sessionAfterRefresh = await requestJson(runtime.baseUrl, 'GET', '/api/session');
    assert.equal(sessionAfterRefresh.status, 200, JSON.stringify(sessionAfterRefresh.json));
    assert.equal(sessionAfterRefresh.json?.status, 'idle');

    const optionsAfterRefresh = await requestJson(runtime.baseUrl, 'GET', '/api/options');
    assert.equal(optionsAfterRefresh.status, 200, JSON.stringify(optionsAfterRefresh.json));
    assert.ok(
      !optionsAfterRefresh.json?.options?.includes(optionToDisable.label),
      'Expected disabled option to be hidden immediately after inactive refresh.',
    );

    const restartRound = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/start',
      { mode: 'rows' },
      modHeaders(),
    );
    assert.equal(restartRound.status, 200, JSON.stringify(restartRound.json));
    assert.equal(restartRound.json?.session?.status, 'open');

    const optionsAfterRestartRound = await requestJson(runtime.baseUrl, 'GET', '/api/options');
    assert.equal(optionsAfterRestartRound.status, 200, JSON.stringify(optionsAfterRestartRound.json));
    assert.ok(
      !optionsAfterRestartRound.json?.options?.includes(optionToDisable.label),
      'Expected Start Round behavior to remain unchanged after inactive refresh.',
    );
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('mod theme endpoints require auth and apply palette updates', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-theme-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath);
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const unauthTheme = await requestJson(runtime.baseUrl, 'GET', '/api/mod/theme');
    assert.equal(unauthTheme.status, 401, JSON.stringify(unauthTheme.json));

    const idleSession = await requestJson(runtime.baseUrl, 'GET', '/api/session');
    assert.equal(idleSession.status, 200, JSON.stringify(idleSession.json));
    assert.equal(typeof idleSession.json?.theme?.mode, 'string');
    assert.equal(typeof idleSession.json?.theme?.palette?.accent, 'string');

    const themeBefore = await requestJson(runtime.baseUrl, 'GET', '/api/mod/theme', undefined, modHeaders());
    assert.equal(themeBefore.status, 200, JSON.stringify(themeBefore.json));
    assert.equal(themeBefore.json?.ok, true);
    assert.equal(themeBefore.json?.linkControllerAndCards, true);
    assert.equal(
      themeBefore.json?.controllerTheme?.palette?.accent,
      themeBefore.json?.cardsTheme?.palette?.accent,
      JSON.stringify(themeBefore.json),
    );

    const invalidTheme = await requestJson(
      runtime.baseUrl,
      'PATCH',
      '/api/mod/theme',
      { palette: { accent: 'blue' } },
      modHeaders(),
    );
    assert.equal(invalidTheme.status, 400, JSON.stringify(invalidTheme.json));

    const updateTheme = await requestJson(
      runtime.baseUrl,
      'PATCH',
      '/api/mod/theme',
      {
        mode: 'light',
        palette: {
          accent: '#123456',
          calledBg: '#234567',
          freeBg: '#345678',
        },
      },
      modHeaders(),
    );
    assert.equal(updateTheme.status, 200, JSON.stringify(updateTheme.json));
    assert.equal(updateTheme.json?.changed, true);
    assert.equal(updateTheme.json?.theme?.mode, 'light');
    assert.equal(updateTheme.json?.theme?.palette?.accent, '#123456');
    assert.equal(updateTheme.json?.controllerTheme?.palette?.accent, '#123456');
    assert.equal(updateTheme.json?.cardsTheme?.palette?.accent, '#123456');

    const themeAfterUpdate = await requestJson(runtime.baseUrl, 'GET', '/api/mod/theme', undefined, modHeaders());
    assert.equal(themeAfterUpdate.status, 200, JSON.stringify(themeAfterUpdate.json));
    assert.equal(themeAfterUpdate.json?.theme?.palette?.calledBg, '#234567');
    assert.equal(themeAfterUpdate.json?.overrides?.freeBg, '#345678');

    const unlinkTheme = await requestJson(
      runtime.baseUrl,
      'PATCH',
      '/api/mod/theme',
      { linkControllerAndCards: false },
      modHeaders(),
    );
    assert.equal(unlinkTheme.status, 200, JSON.stringify(unlinkTheme.json));
    assert.equal(unlinkTheme.json?.changed, true);
    assert.equal(unlinkTheme.json?.linkControllerAndCards, false);

    const setControllerScope = await requestJson(
      runtime.baseUrl,
      'PATCH',
      '/api/mod/theme',
      {
        scopeTarget: 'controller',
        palette: {
          accent: '#111111',
          surface: '#222222',
        },
      },
      modHeaders(),
    );
    assert.equal(setControllerScope.status, 200, JSON.stringify(setControllerScope.json));
    assert.equal(setControllerScope.json?.controllerTheme?.palette?.accent, '#111111');
    assert.equal(setControllerScope.json?.cardsTheme?.palette?.accent, '#123456');

    const setCardsScope = await requestJson(
      runtime.baseUrl,
      'PATCH',
      '/api/mod/theme',
      {
        scopeTarget: 'cards',
        palette: {
          accent: '#abcdef',
          calledBg: '#fedcba',
        },
      },
      modHeaders(),
    );
    assert.equal(setCardsScope.status, 200, JSON.stringify(setCardsScope.json));
    assert.equal(setCardsScope.json?.controllerTheme?.palette?.accent, '#111111');
    assert.equal(setCardsScope.json?.cardsTheme?.palette?.accent, '#abcdef');

    const sessionThemeAfterScopes = await requestJson(runtime.baseUrl, 'GET', '/api/session');
    assert.equal(sessionThemeAfterScopes.status, 200, JSON.stringify(sessionThemeAfterScopes.json));
    assert.equal(sessionThemeAfterScopes.json?.theme?.palette?.accent, '#abcdef');

    const modStateAfterScopes = await requestJson(runtime.baseUrl, 'GET', '/api/mod/state', undefined, modHeaders());
    assert.equal(modStateAfterScopes.status, 200, JSON.stringify(modStateAfterScopes.json));
    assert.equal(modStateAfterScopes.json?.linkControllerAndCards, false);
    assert.equal(modStateAfterScopes.json?.controllerTheme?.palette?.accent, '#111111');
    assert.equal(modStateAfterScopes.json?.cardsTheme?.palette?.accent, '#abcdef');
    assert.equal(modStateAfterScopes.json?.scopedOverrides?.controller?.accent, '#111111');
    assert.equal(modStateAfterScopes.json?.scopedOverrides?.cards?.accent, '#abcdef');

    const resetTheme = await requestJson(
      runtime.baseUrl,
      'PATCH',
      '/api/mod/theme',
      { mode: 'light', resetOverrides: true, scopeTarget: 'all' },
      modHeaders(),
    );
    assert.equal(resetTheme.status, 200, JSON.stringify(resetTheme.json));
    assert.equal(resetTheme.json?.theme?.mode, 'light');
    assert.notEqual(resetTheme.json?.theme?.palette?.accent, '#123456');
    assert.equal(resetTheme.json?.overrides?.accent, undefined);
    assert.equal(resetTheme.json?.scopedOverrides?.controller?.accent, undefined);
    assert.equal(resetTheme.json?.scopedOverrides?.cards?.accent, undefined);
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});
