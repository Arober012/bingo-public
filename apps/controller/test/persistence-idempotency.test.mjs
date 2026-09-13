import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const controllerRoot = path.resolve(process.cwd());
const requestTimeoutMs = 5000;
const viewerAuthTokenSecret = 'controller-test-viewer-auth-secret';
const modControlToken = 'controller-test-mod-token';
const internalRedeemSecret = 'controller-test-redeem-secret';

function modHeaders() {
  return {
    authorization: `Bearer ${modControlToken}`,
  };
}

function redeemHeaders() {
  return {
    authorization: `Bearer ${internalRedeemSecret}`,
  };
}

function createViewerAuthToken({ sessionId, userId, userName }) {
  const now = Date.now();
  const payload = {
    v: 1,
    type: 'viewer-auth',
    sessionId,
    userId,
    userName,
    iat: now,
    exp: now + 12 * 60 * 60 * 1000,
  };

  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', viewerAuthTokenSecret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function viewerHeaders(sessionId, userId, userName) {
  return {
    authorization: `Bearer ${createViewerAuthToken({ sessionId, userId, userName })}`,
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

function createOptionsPool() {
  return Array.from({ length: 30 }, (_value, index) => `Option ${index + 1}`);
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
      VIEWER_AUTH_TOKEN_SECRET: viewerAuthTokenSecret,
      VIEWER_INVITE_TOKEN_SECRET: 'controller-test-viewer-invite-secret',
      VIEWER_AUTH_TOKEN_SECRET: viewerAuthTokenSecret,
      TWITCH_CLIENT_ID: 'test-client-id',
      TWITCH_CLIENT_SECRET: 'test-client-secret',
      TWITCH_REDIRECT_URI: 'http://localhost/callback',
      VIEWER_BASE_URL: 'https://stream-bingo-viewer.web.app',
      PUBLIC_API_BASE_URL: 'https://api.custom-overlays.com',
      INTERNAL_REDEEM_SECRET: internalRedeemSecret,
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

test('controller persists state and replays idempotent stamp responses after restart', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  const persistedNewOptionLabel = 'Persistent Restart Option';
  let disabledPoolOptionLabel = '';

  let firstRuntime = null;
  let secondRuntime = null;

  try {
    const firstPort = await getFreePort();
    firstRuntime = startController(firstPort, stateFilePath);
    await waitForHealth(firstRuntime.baseUrl, firstRuntime.child, firstRuntime.logs);

    const startResponse = await requestJson(firstRuntime.baseUrl, 'POST', '/api/mod/start', {
      mode: 'rows',
      options: createOptionsPool(),
      winnerGraceSeconds: 95,
    }, modHeaders());

    assert.equal(startResponse.status, 200, JSON.stringify(startResponse.json));
    const sessionId = startResponse.json?.session?.id;
    assert.equal(typeof sessionId, 'string');
    assert.equal(startResponse.json?.session?.winnerGraceSeconds, 95);

    const optionsBeforeEdits = await requestJson(firstRuntime.baseUrl, 'GET', '/api/mod/options', undefined, modHeaders());
    assert.equal(optionsBeforeEdits.status, 200, JSON.stringify(optionsBeforeEdits.json));
    const optionToDisable = optionsBeforeEdits.json?.options?.find((entry) => entry?.enabled);
    assert.ok(optionToDisable, 'Expected at least one enabled option before restart edits.');
    disabledPoolOptionLabel = optionToDisable.label;

    const disableOptionResponse = await requestJson(
      firstRuntime.baseUrl,
      'PATCH',
      `/api/mod/options/${encodeURIComponent(optionToDisable.id)}`,
      { enabled: false },
      modHeaders(),
    );
    assert.equal(disableOptionResponse.status, 200, JSON.stringify(disableOptionResponse.json));

    const addPersistentOptionResponse = await requestJson(
      firstRuntime.baseUrl,
      'POST',
      '/api/mod/options',
      { label: persistedNewOptionLabel, enabled: true },
      modHeaders(),
    );
    assert.equal(addPersistentOptionResponse.status, 201, JSON.stringify(addPersistentOptionResponse.json));

    const themeUpdate = await requestJson(
      firstRuntime.baseUrl,
      'PATCH',
      '/api/mod/theme',
      {
        mode: 'light',
        skinId: 'candlelit-pumpkins',
        palette: {
          accent: '#3366aa',
          calledBg: '#cce8ee',
        },
      },
      modHeaders(),
    );
    assert.equal(themeUpdate.status, 200, JSON.stringify(themeUpdate.json));
    assert.equal(themeUpdate.json?.theme?.mode, 'light');
    assert.equal(themeUpdate.json?.theme?.palette?.accent, '#3366aa');
    assert.equal(themeUpdate.json?.theme?.skinId, 'candlelit-pumpkins');

    const unlinkTheme = await requestJson(
      firstRuntime.baseUrl,
      'PATCH',
      '/api/mod/theme',
      {
        linkControllerAndCards: false,
      },
      modHeaders(),
    );
    assert.equal(unlinkTheme.status, 200, JSON.stringify(unlinkTheme.json));
    assert.equal(unlinkTheme.json?.linkControllerAndCards, false);

    const scopedControllerTheme = await requestJson(
      firstRuntime.baseUrl,
      'PATCH',
      '/api/mod/theme',
      {
        scopeTarget: 'controller',
        palette: {
          accent: '#114477',
        },
      },
      modHeaders(),
    );
    assert.equal(scopedControllerTheme.status, 200, JSON.stringify(scopedControllerTheme.json));
    assert.equal(scopedControllerTheme.json?.controllerTheme?.palette?.accent, '#114477');

    const scopedCardsTheme = await requestJson(
      firstRuntime.baseUrl,
      'PATCH',
      '/api/mod/theme',
      {
        scopeTarget: 'cards',
        palette: {
          accent: '#5588cc',
        },
      },
      modHeaders(),
    );
    assert.equal(scopedCardsTheme.status, 200, JSON.stringify(scopedCardsTheme.json));
    assert.equal(scopedCardsTheme.json?.cardsTheme?.palette?.accent, '#5588cc');

    const joinResponse = await requestJson(
      firstRuntime.baseUrl,
      'POST',
      '/api/player/join',
      { userName: 'ViewerOne' },
      viewerHeaders(sessionId, 'viewer-1', 'ViewerOne'),
    );

    assert.equal(joinResponse.status, 200, JSON.stringify(joinResponse.json));

    const cardResponse = await requestJson(
      firstRuntime.baseUrl,
      'GET',
      '/api/player/card',
      undefined,
      viewerHeaders(sessionId, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(cardResponse.status, 200, JSON.stringify(cardResponse.json));

    const cells = cardResponse.json?.player?.card?.cells;
    assert.ok(Array.isArray(cells), 'Expected player card cells in response.');

    const targetIndex = cells.findIndex((cell) => !cell.free);
    assert.ok(targetIndex >= 0, 'Expected at least one non-free cell on player card.');

    const targetOption = cells[targetIndex].value;
    assert.equal(typeof targetOption, 'string');

    const callResponse = await requestJson(firstRuntime.baseUrl, 'POST', '/api/mod/call', {
      option: targetOption,
    }, modHeaders());

    assert.equal(callResponse.status, 200, JSON.stringify(callResponse.json));

    const idempotencyKey = 'stamp-e2e-0001';
    const firstStamp = await requestJson(
      firstRuntime.baseUrl,
      'POST',
      '/api/player/stamp',
      {
        index: targetIndex,
        idempotencyKey,
      },
      viewerHeaders(sessionId, 'viewer-1', 'ViewerOne'),
    );

    assert.equal(firstStamp.status, 200, JSON.stringify(firstStamp.json));
    assert.equal(firstStamp.json?.ok, true);

    const immediateReplay = await requestJson(
      firstRuntime.baseUrl,
      'POST',
      '/api/player/stamp',
      {
        index: targetIndex,
        idempotencyKey,
      },
      viewerHeaders(sessionId, 'viewer-1', 'ViewerOne'),
    );

    assert.equal(immediateReplay.status, 200, JSON.stringify(immediateReplay.json));
    assert.equal(immediateReplay.json?.idempotentReplay, true);

    await stopController(firstRuntime.child);

    const secondPort = await getFreePort();
    secondRuntime = startController(secondPort, stateFilePath);
    await waitForHealth(secondRuntime.baseUrl, secondRuntime.child, secondRuntime.logs);

    const restoredSession = await requestJson(secondRuntime.baseUrl, 'GET', '/api/session');
    assert.equal(restoredSession.status, 200);
    assert.equal(restoredSession.json?.status, 'running');
    assert.equal(restoredSession.json?.players, 1);
    assert.ok(Array.isArray(restoredSession.json?.calledOptions));
    assert.ok(restoredSession.json.calledOptions.includes(targetOption));
    assert.equal(restoredSession.json?.theme?.mode, 'light');
    assert.equal(restoredSession.json?.theme?.palette?.accent, '#5588cc');
    assert.equal(restoredSession.json?.theme?.skinId, 'candlelit-pumpkins');
    assert.equal(restoredSession.json?.winnerGraceSeconds, 95);
    const restoredSessionId = restoredSession.json?.id;
    assert.equal(typeof restoredSessionId, 'string');

    const restoredModState = await requestJson(secondRuntime.baseUrl, 'GET', '/api/mod/state', undefined, modHeaders());
    assert.equal(restoredModState.status, 200, JSON.stringify(restoredModState.json));
    assert.equal(restoredModState.json?.linkControllerAndCards, false);
    assert.equal(restoredModState.json?.controllerTheme?.palette?.accent, '#114477');
    assert.equal(restoredModState.json?.cardsTheme?.palette?.accent, '#5588cc');
    assert.equal(restoredModState.json?.scopedOverrides?.controller?.accent, '#114477');
    assert.equal(restoredModState.json?.scopedOverrides?.cards?.accent, '#5588cc');
    assert.equal(restoredModState.json?.theme?.skinId, 'candlelit-pumpkins');
    assert.equal(restoredModState.json?.controllerTheme?.skinId, 'candlelit-pumpkins');
    assert.equal(restoredModState.json?.cardsTheme?.skinId, 'candlelit-pumpkins');

    const restoredReplay = await requestJson(
      secondRuntime.baseUrl,
      'POST',
      '/api/player/stamp',
      {
        index: targetIndex,
        idempotencyKey,
      },
      viewerHeaders(restoredSessionId, 'viewer-1', 'ViewerOne'),
    );

    assert.equal(restoredReplay.status, 200, JSON.stringify(restoredReplay.json));
    assert.equal(restoredReplay.json?.idempotentReplay, true);

    const optionsAfterRestart = await requestJson(secondRuntime.baseUrl, 'GET', '/api/mod/options', undefined, modHeaders());
    assert.equal(optionsAfterRestart.status, 200, JSON.stringify(optionsAfterRestart.json));
    const restoredDisabledOption = optionsAfterRestart.json?.options?.find((entry) => entry?.label === disabledPoolOptionLabel);
    assert.ok(restoredDisabledOption, 'Expected disabled option to remain in the persisted pool after restart.');
    assert.equal(restoredDisabledOption.enabled, false);
    const restoredAddedOption = optionsAfterRestart.json?.options?.find((entry) => entry?.label === persistedNewOptionLabel);
    assert.ok(restoredAddedOption, 'Expected added option to persist after restart.');
    assert.equal(restoredAddedOption.enabled, true);

    const newSessionAfterRestart = await requestJson(
      secondRuntime.baseUrl,
      'POST',
      '/api/mod/session/new',
      { mode: 'rows', winnerGraceSeconds: 110 },
      modHeaders(),
    );
    assert.equal(newSessionAfterRestart.status, 200, JSON.stringify(newSessionAfterRestart.json));
    assert.equal(newSessionAfterRestart.json?.session?.winnerGraceSeconds, 110);

    const optionsForNewSession = await requestJson(secondRuntime.baseUrl, 'GET', '/api/options');
    assert.equal(optionsForNewSession.status, 200, JSON.stringify(optionsForNewSession.json));
    assert.ok(
      !optionsForNewSession.json?.options?.includes(disabledPoolOptionLabel),
      'Expected disabled option to be excluded from new sessions after restart.',
    );
    assert.ok(
      optionsForNewSession.json?.options?.includes(persistedNewOptionLabel),
      'Expected added enabled option to be included in new sessions after restart.',
    );

    const roleOnlyModRequest = await requestJson(secondRuntime.baseUrl, 'GET', '/api/mod/state', undefined, {
      'x-user-role': 'mod',
    });
    assert.equal(roleOnlyModRequest.status, 401, JSON.stringify(roleOnlyModRequest.json));

    const redeemPayload = {
      redemptionId: 'redeem-001',
      twitchUserId: 'viewer-1',
      twitchUserName: 'ViewerOne',
    };

    const firstRedeem = await requestJson(
      secondRuntime.baseUrl,
      'POST',
      '/api/internal/redeem/join',
      redeemPayload,
      redeemHeaders(),
    );
    assert.equal(firstRedeem.status, 200, JSON.stringify(firstRedeem.json));
    assert.equal(firstRedeem.json?.ok, true);
    assert.equal(firstRedeem.json?.expiresInSeconds, 28800);

    const legacyStartResponse = await fetchWithTimeout(
      `${secondRuntime.baseUrl}/api/auth/twitch/start?userId=${encodeURIComponent(redeemPayload.twitchUserId)}&userName=${encodeURIComponent(redeemPayload.twitchUserName)}`,
      {
        redirect: 'manual',
      },
    );
    assert.equal(legacyStartResponse.status, 302);
    const legacyStartLocation = legacyStartResponse.headers.get('location') ?? '';
    assert.ok(legacyStartLocation.startsWith('https://id.twitch.tv/oauth2/authorize'));
    assert.ok(legacyStartLocation.includes('state='));

    const unknownLegacyStart = await requestJson(
      secondRuntime.baseUrl,
      'GET',
      '/api/auth/twitch/start?userId=viewer-unknown',
    );
    assert.equal(unknownLegacyStart.status, 400, JSON.stringify(unknownLegacyStart.json));
    assert.equal(unknownLegacyStart.json?.error, 'invalid_invite_token');

    const secondRedeem = await requestJson(
      secondRuntime.baseUrl,
      'POST',
      '/api/internal/redeem/join',
      redeemPayload,
      redeemHeaders(),
    );
    assert.equal(secondRedeem.status, 200, JSON.stringify(secondRedeem.json));
    assert.equal(secondRedeem.json?.idempotentReplay, true);
    assert.equal(secondRedeem.json?.viewerUrl, firstRedeem.json?.viewerUrl);

    const conflictRedeem = await requestJson(
      secondRuntime.baseUrl,
      'POST',
      '/api/internal/redeem/join',
      {
        ...redeemPayload,
        twitchUserId: 'viewer-2',
        twitchUserName: 'ViewerTwo',
      },
      redeemHeaders(),
    );
    assert.equal(conflictRedeem.status, 409, JSON.stringify(conflictRedeem.json));
    assert.equal(conflictRedeem.json?.error, 'redeem_id_conflict');

    const auditResponse = await requestJson(secondRuntime.baseUrl, 'GET', '/api/mod/audit?limit=200', undefined, modHeaders());
    assert.equal(auditResponse.status, 200, JSON.stringify(auditResponse.json));
    assert.ok(Array.isArray(auditResponse.json?.entries));

    const auditTypes = auditResponse.json.entries.map((entry) => entry.type);
    assert.ok(auditTypes.includes('session_started'));
    assert.ok(auditTypes.includes('stamp_accepted') || auditTypes.includes('player_won'));
  } finally {
    await stopController(firstRuntime?.child);
    await stopController(secondRuntime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('refresh-inactive transition persists idle state across restart', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-refresh-idle-persist-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');

  let firstRuntime = null;
  let secondRuntime = null;

  try {
    const firstPort = await getFreePort();
    firstRuntime = startController(firstPort, stateFilePath);
    await waitForHealth(firstRuntime.baseUrl, firstRuntime.child, firstRuntime.logs);

    const startRound = await requestJson(
      firstRuntime.baseUrl,
      'POST',
      '/api/mod/start',
      { mode: 'rows', options: createOptionsPool() },
      modHeaders(),
    );
    assert.equal(startRound.status, 200, JSON.stringify(startRound.json));
    assert.equal(startRound.json?.session?.status, 'open');

    const endRound = await requestJson(
      firstRuntime.baseUrl,
      'POST',
      '/api/mod/stop',
      { end: true },
      modHeaders(),
    );
    assert.equal(endRound.status, 200, JSON.stringify(endRound.json));
    assert.equal(endRound.json?.session?.status, 'ended');

    const refreshInactive = await requestJson(
      firstRuntime.baseUrl,
      'POST',
      '/api/mod/session/refresh-inactive',
      {},
      modHeaders(),
    );
    assert.equal(refreshInactive.status, 200, JSON.stringify(refreshInactive.json));
    assert.equal(refreshInactive.json?.status, 'idle');

    const idleSession = await requestJson(firstRuntime.baseUrl, 'GET', '/api/session');
    assert.equal(idleSession.status, 200, JSON.stringify(idleSession.json));
    assert.equal(idleSession.json?.status, 'idle');

    await stopController(firstRuntime.child);

    const secondPort = await getFreePort();
    secondRuntime = startController(secondPort, stateFilePath);
    await waitForHealth(secondRuntime.baseUrl, secondRuntime.child, secondRuntime.logs);

    const restoredSession = await requestJson(secondRuntime.baseUrl, 'GET', '/api/session');
    assert.equal(restoredSession.status, 200, JSON.stringify(restoredSession.json));
    assert.equal(restoredSession.json?.status, 'idle');

    const restoredOptions = await requestJson(secondRuntime.baseUrl, 'GET', '/api/options');
    assert.equal(restoredOptions.status, 200, JSON.stringify(restoredOptions.json));
    const restoredEnabledPool = await requestJson(secondRuntime.baseUrl, 'GET', '/api/mod/options', undefined, modHeaders());
    assert.equal(restoredEnabledPool.status, 200, JSON.stringify(restoredEnabledPool.json));

    const enabledPoolLabels = restoredEnabledPool.json?.options
      ?.filter((entry) => entry?.enabled)
      .map((entry) => entry?.label)
      .filter((label) => typeof label === 'string') ?? [];

    assert.deepEqual([...restoredOptions.json.options].sort(), [...enabledPoolLabels].sort());

    const restartRound = await requestJson(
      secondRuntime.baseUrl,
      'POST',
      '/api/mod/start',
      { mode: 'normal' },
      modHeaders(),
    );
    assert.equal(restartRound.status, 200, JSON.stringify(restartRound.json));
    assert.equal(restartRound.json?.session?.status, 'open');
  } finally {
    await stopController(firstRuntime?.child);
    await stopController(secondRuntime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('viewer callback mismatch redirect preserves invite token for recovery', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-viewer-callback-recovery-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath);
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const startRound = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/start',
      { mode: 'rows', options: createOptionsPool() },
      modHeaders(),
    );
    assert.equal(startRound.status, 200, JSON.stringify(startRound.json));

    const redeemPayload = {
      redemptionId: 'redeem-callback-001',
      twitchUserId: 'viewer-callback',
      twitchUserName: 'ViewerCallback',
    };
    const firstRedeem = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/internal/redeem/join',
      redeemPayload,
      redeemHeaders(),
    );
    assert.equal(firstRedeem.status, 200, JSON.stringify(firstRedeem.json));

    const viewerUrl = new URL(String(firstRedeem.json?.viewerUrl ?? ''));
    const inviteToken = viewerUrl.searchParams.get('invite');
    assert.equal(typeof inviteToken, 'string');
    assert.ok(inviteToken && inviteToken.length > 0, 'Expected invite token in viewer URL.');

    const authStart = await fetchWithTimeout(
      `${runtime.baseUrl}/api/auth/twitch/start?invite=${encodeURIComponent(inviteToken)}`,
      { redirect: 'manual' },
    );
    assert.equal(authStart.status, 302);
    const authStartLocation = authStart.headers.get('location') ?? '';
    assert.ok(authStartLocation.startsWith('https://id.twitch.tv/oauth2/authorize'));

    const authStartUrl = new URL(authStartLocation);
    const oauthState = authStartUrl.searchParams.get('state');
    assert.equal(typeof oauthState, 'string');
    assert.ok(oauthState && oauthState.length > 0, 'Expected OAuth state parameter.');

    const rotateSession = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/session/new',
      { mode: 'rows' },
      modHeaders(),
    );
    assert.equal(rotateSession.status, 200, JSON.stringify(rotateSession.json));

    const callbackResponse = await fetchWithTimeout(
      `${runtime.baseUrl}/api/auth/twitch/callback?code=test-code&state=${encodeURIComponent(oauthState)}`,
      { redirect: 'manual' },
    );
    assert.equal(callbackResponse.status, 302);

    const callbackLocation = callbackResponse.headers.get('location') ?? '';
    assert.ok(callbackLocation.length > 0, 'Expected viewer redirect location for callback mismatch.');
    const callbackUrl = new URL(callbackLocation);
    assert.equal(callbackUrl.searchParams.get('authError'), 'session_mismatch');
    assert.equal(callbackUrl.searchParams.get('invite'), inviteToken);
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('viewer invite/auth TTL defaults and overrides are observable in diagnostics and redeem responses', { timeout: 90000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-viewer-ttl-it-'));
  const stateFileDefault = path.join(tempDir, 'default-state.json');
  const stateFileOverride = path.join(tempDir, 'override-state.json');
  let defaultRuntime = null;
  let overrideRuntime = null;

  try {
    const defaultPort = await getFreePort();
    defaultRuntime = startController(defaultPort, stateFileDefault);
    await waitForHealth(defaultRuntime.baseUrl, defaultRuntime.child, defaultRuntime.logs);

    const defaultLogs = defaultRuntime.logs.join('');
    assert.match(defaultLogs, /viewer-auth ttl inviteMs=28800000 authMs=86400000 oauthStateMs=600000/);

    const defaultStartRound = await requestJson(
      defaultRuntime.baseUrl,
      'POST',
      '/api/mod/start',
      { mode: 'rows', options: createOptionsPool() },
      modHeaders(),
    );
    assert.equal(defaultStartRound.status, 200, JSON.stringify(defaultStartRound.json));

    const defaultRedeem = await requestJson(
      defaultRuntime.baseUrl,
      'POST',
      '/api/internal/redeem/join',
      {
        redemptionId: 'redeem-default-ttl-001',
        twitchUserId: 'viewer-default-ttl',
        twitchUserName: 'ViewerDefaultTTL',
      },
      redeemHeaders(),
    );
    assert.equal(defaultRedeem.status, 200, JSON.stringify(defaultRedeem.json));
    assert.equal(defaultRedeem.json?.expiresInSeconds, 28800);

    await stopController(defaultRuntime.child);
    defaultRuntime = null;

    const overridePort = await getFreePort();
    overrideRuntime = startController(overridePort, stateFileOverride, {
      VIEWER_INVITE_TOKEN_TTL_MS: '120000',
      VIEWER_AUTH_TOKEN_TTL_MS: '180000',
      TWITCH_OAUTH_STATE_TTL_MS: '90000',
    });
    await waitForHealth(overrideRuntime.baseUrl, overrideRuntime.child, overrideRuntime.logs);

    const overrideLogs = overrideRuntime.logs.join('');
    assert.match(overrideLogs, /viewer-auth ttl inviteMs=120000 authMs=180000 oauthStateMs=90000/);

    const overrideStartRound = await requestJson(
      overrideRuntime.baseUrl,
      'POST',
      '/api/mod/start',
      { mode: 'rows', options: createOptionsPool() },
      modHeaders(),
    );
    assert.equal(overrideStartRound.status, 200, JSON.stringify(overrideStartRound.json));

    const overrideRedeem = await requestJson(
      overrideRuntime.baseUrl,
      'POST',
      '/api/internal/redeem/join',
      {
        redemptionId: 'redeem-override-ttl-001',
        twitchUserId: 'viewer-override-ttl',
        twitchUserName: 'ViewerOverrideTTL',
      },
      redeemHeaders(),
    );
    assert.equal(overrideRedeem.status, 200, JSON.stringify(overrideRedeem.json));
    assert.equal(overrideRedeem.json?.expiresInSeconds, 120);
  } finally {
    await stopController(defaultRuntime?.child);
    await stopController(overrideRuntime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});
