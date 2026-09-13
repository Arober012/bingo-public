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
const viewerAuthTokenSecret = 'controller-test-viewer-auth-secret';
const modControlToken = 'controller-test-mod-token';

function modHeaders() {
  return {
    authorization: `Bearer ${modControlToken}`,
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

function startController(port, stateFilePath) {
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
      MOD_CONTROL_TOKEN: modControlToken,
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

async function joinPlayer(baseUrl, sessionId, userId, userName) {
  const joinResponse = await requestJson(
    baseUrl,
    'POST',
    '/api/player/join',
    { userName },
    viewerHeaders(sessionId, userId, userName),
  );

  assert.equal(joinResponse.status, 200, JSON.stringify(joinResponse.json));
}

async function completeTopRowWin(baseUrl, sessionId, userId, userName) {
  const cardResponse = await requestJson(
    baseUrl,
    'GET',
    '/api/player/card',
    undefined,
    viewerHeaders(sessionId, userId, userName),
  );
  assert.equal(cardResponse.status, 200, JSON.stringify(cardResponse.json));

  const card = cardResponse.json?.player?.card;
  assert.ok(card, 'Expected player card payload.');
  assert.ok(Array.isArray(card.cells), 'Expected card cells array.');

  const rowIndexes = [0, 1, 2, 3, 4];
  let finalStamp = null;

  for (const index of rowIndexes) {
    const cell = card.cells[index];
    assert.ok(cell && !cell.free, `Expected top-row index ${index} to be non-free.`);

    const callResponse = await requestJson(baseUrl, 'POST', '/api/mod/call', { option: cell.value }, modHeaders());
    assert.equal(callResponse.status, 200, JSON.stringify(callResponse.json));

    const stampResponse = await requestJson(
      baseUrl,
      'POST',
      '/api/player/stamp',
      { index },
      viewerHeaders(sessionId, userId, userName),
    );
    assert.equal(stampResponse.status, 200, JSON.stringify(stampResponse.json));
    finalStamp = stampResponse;
  }

  return {
    cardId: card.id,
    firstRowIndex: rowIndexes[0],
    finalStamp,
  };
}

test('winner cap and recovery endpoints enforce expected round flow', { timeout: 120000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-winner-policy-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath);
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const startResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/start',
      { mode: 'rows', options: createOptionsPool(), maxWinners: 2, winnerGraceSeconds: 75 },
      modHeaders(),
    );

    assert.equal(startResponse.status, 200, JSON.stringify(startResponse.json));
    assert.equal(startResponse.json?.session?.maxWinners, 2);
    assert.equal(startResponse.json?.session?.winnerGraceSeconds, 75);
    const firstSessionId = startResponse.json?.session?.id;
    assert.equal(typeof firstSessionId, 'string');

    await joinPlayer(runtime.baseUrl, firstSessionId, 'viewer-1', 'ViewerOne');
    await joinPlayer(runtime.baseUrl, firstSessionId, 'viewer-2', 'ViewerTwo');

    const firstWin = await completeTopRowWin(runtime.baseUrl, firstSessionId, 'viewer-1', 'ViewerOne');
    assert.equal(firstWin.finalStamp?.json?.hasWonNow, false);
    assert.equal(firstWin.finalStamp?.json?.claimAvailable, true);
    assert.equal(firstWin.finalStamp?.json?.sessionEnded, false);
    assert.equal(firstWin.finalStamp?.json?.winnerCount, 0);

    const firstClaim = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/player/claim',
      {},
      viewerHeaders(firstSessionId, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(firstClaim.status, 200, JSON.stringify(firstClaim.json));
    assert.equal(firstClaim.json?.alreadyClaimed, false);
    assert.equal(firstClaim.json?.hasWonNow, true);
    assert.equal(firstClaim.json?.winnerCount, 1);
    assert.equal(firstClaim.json?.winnerGraceSeconds, 75);
    assert.equal(firstClaim.json?.sessionEnded, false);
    assert.equal(typeof firstClaim.json?.winnerGraceEndsAt, 'string');
    assert.ok((firstClaim.json?.winnerGraceSecondsRemaining ?? 0) > 0);

    const repeatedFirstClaim = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/player/claim',
      {},
      viewerHeaders(firstSessionId, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(repeatedFirstClaim.status, 200, JSON.stringify(repeatedFirstClaim.json));
    assert.equal(repeatedFirstClaim.json?.alreadyClaimed, true);

    const secondWin = await completeTopRowWin(runtime.baseUrl, firstSessionId, 'viewer-2', 'ViewerTwo');
    assert.equal(secondWin.finalStamp?.json?.hasWonNow, false);
    assert.equal(secondWin.finalStamp?.json?.claimAvailable, true);
    assert.equal(secondWin.finalStamp?.json?.sessionEnded, false);
    assert.equal(secondWin.finalStamp?.json?.winnerCount, 1);

    const secondClaim = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/player/claim',
      {},
      viewerHeaders(firstSessionId, 'viewer-2', 'ViewerTwo'),
    );
    assert.equal(secondClaim.status, 200, JSON.stringify(secondClaim.json));
    assert.equal(secondClaim.json?.alreadyClaimed, false);
    assert.equal(secondClaim.json?.hasWonNow, true);
    assert.equal(secondClaim.json?.winnerGraceSeconds, 75);
    assert.equal(secondClaim.json?.sessionEnded, false);
    assert.equal(secondClaim.json?.winnerCount, 2);

    const thirdJoin = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/player/join',
      { userName: 'ViewerThree' },
      viewerHeaders(firstSessionId, 'viewer-3', 'ViewerThree'),
    );
    assert.equal(thirdJoin.status, 200, JSON.stringify(thirdJoin.json));
    assert.equal(Boolean(thirdJoin.json?.joined), true);

    const thirdClaimBlockedByCap = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/player/claim',
      {},
      viewerHeaders(firstSessionId, 'viewer-3', 'ViewerThree'),
    );
    assert.equal(thirdClaimBlockedByCap.status, 400, JSON.stringify(thirdClaimBlockedByCap.json));
    assert.equal(thirdClaimBlockedByCap.json?.error, 'winner_cap_reached');
    assert.equal(thirdClaimBlockedByCap.json?.sessionEnded, false);

    const resetBoardResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/session/reset-board',
      {},
      modHeaders(),
    );
    assert.equal(resetBoardResponse.status, 200, JSON.stringify(resetBoardResponse.json));
    assert.equal(resetBoardResponse.json?.session?.status, 'open');
    assert.deepEqual(resetBoardResponse.json?.session?.calledOptions, []);
    assert.deepEqual(resetBoardResponse.json?.session?.winners, []);

    const cardAfterReset = await requestJson(
      runtime.baseUrl,
      'GET',
      '/api/player/card',
      undefined,
      viewerHeaders(firstSessionId, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(cardAfterReset.status, 200, JSON.stringify(cardAfterReset.json));
    assert.equal(cardAfterReset.json?.player?.card?.id, firstWin.cardId);

    const stampAfterReset = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/player/stamp',
      { index: firstWin.firstRowIndex },
      viewerHeaders(firstSessionId, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(stampAfterReset.status, 400, JSON.stringify(stampAfterReset.json));
    assert.equal(stampAfterReset.json?.reason, 'option_not_called');

    const invalidClaimAfterReset = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/player/claim',
      {},
      viewerHeaders(firstSessionId, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(invalidClaimAfterReset.status, 400, JSON.stringify(invalidClaimAfterReset.json));
    assert.equal(invalidClaimAfterReset.json?.error, 'claim_not_validated');

    const optionsBeforeNewSessionResponse = await requestJson(
      runtime.baseUrl,
      'GET',
      '/api/options',
    );
    assert.equal(optionsBeforeNewSessionResponse.status, 200, JSON.stringify(optionsBeforeNewSessionResponse.json));
    const optionsBeforeNewSession = Array.isArray(optionsBeforeNewSessionResponse.json?.options)
      ? [...optionsBeforeNewSessionResponse.json.options]
      : [];

    const modOptionsBeforeNewSession = await requestJson(
      runtime.baseUrl,
      'GET',
      '/api/mod/options',
      undefined,
      modHeaders(),
    );
    assert.equal(modOptionsBeforeNewSession.status, 200, JSON.stringify(modOptionsBeforeNewSession.json));
    const enabledPoolLabels = Array.isArray(modOptionsBeforeNewSession.json?.options)
      ? modOptionsBeforeNewSession.json.options
          .filter((entry) => entry?.enabled)
          .map((entry) => entry?.label)
          .filter((label) => typeof label === 'string')
      : [];

    const newSessionResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/session/new',
      { mode: 'postage', maxWinners: 3 },
      modHeaders(),
    );
    assert.equal(newSessionResponse.status, 200, JSON.stringify(newSessionResponse.json));
    assert.equal(newSessionResponse.json?.session?.mode, 'postage');
    assert.equal(newSessionResponse.json?.session?.maxWinners, 3);
    assert.notEqual(newSessionResponse.json?.session?.id, firstSessionId);
    const secondSessionId = newSessionResponse.json?.session?.id;
    assert.equal(typeof secondSessionId, 'string');

    const optionsAfterNewSessionResponse = await requestJson(
      runtime.baseUrl,
      'GET',
      '/api/options',
    );
    assert.equal(optionsAfterNewSessionResponse.status, 200, JSON.stringify(optionsAfterNewSessionResponse.json));
    const optionsAfterNewSession = Array.isArray(optionsAfterNewSessionResponse.json?.options)
      ? [...optionsAfterNewSessionResponse.json.options]
      : [];
    assert.deepEqual([...optionsAfterNewSession].sort(), [...enabledPoolLabels].sort());
    assert.notDeepEqual([...optionsAfterNewSession].sort(), [...optionsBeforeNewSession].sort());
    assert.notDeepEqual(optionsAfterNewSession, optionsBeforeNewSession);

    const oldPlayerInNewSession = await requestJson(
      runtime.baseUrl,
      'GET',
      '/api/player/card',
      undefined,
      viewerHeaders(secondSessionId, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(oldPlayerInNewSession.status, 404, JSON.stringify(oldPlayerInNewSession.json));
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('continue-blackout preserves session state while optionally resetting winner ledger', { timeout: 120000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-continue-blackout-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath);
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const startResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/start',
      { mode: 'rows', options: createOptionsPool(), maxWinners: 2, winnerGraceSeconds: 120 },
      modHeaders(),
    );
    assert.equal(startResponse.status, 200, JSON.stringify(startResponse.json));

    const sessionId = startResponse.json?.session?.id;
    assert.equal(typeof sessionId, 'string');

    await joinPlayer(runtime.baseUrl, sessionId, 'viewer-1', 'ViewerOne');

    const winProgress = await completeTopRowWin(runtime.baseUrl, sessionId, 'viewer-1', 'ViewerOne');
    assert.equal(winProgress.finalStamp?.json?.claimAvailable, true);

    const claimResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/player/claim',
      {},
      viewerHeaders(sessionId, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(claimResponse.status, 200, JSON.stringify(claimResponse.json));
    assert.equal(claimResponse.json?.hasWonNow, true);

    const sessionBeforeTransition = await requestJson(runtime.baseUrl, 'GET', '/api/session');
    assert.equal(sessionBeforeTransition.status, 200, JSON.stringify(sessionBeforeTransition.json));
    assert.equal(sessionBeforeTransition.json?.mode, 'rows');
    assert.ok(Array.isArray(sessionBeforeTransition.json?.calledOptions));
    assert.ok(sessionBeforeTransition.json.calledOptions.length > 0);
    assert.deepEqual(sessionBeforeTransition.json?.winners, ['viewer-1']);

    const cardBeforeTransition = await requestJson(
      runtime.baseUrl,
      'GET',
      '/api/player/card',
      undefined,
      viewerHeaders(sessionId, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(cardBeforeTransition.status, 200, JSON.stringify(cardBeforeTransition.json));
    const cardIdBefore = cardBeforeTransition.json?.player?.card?.id;
    const stampsBefore = Array.isArray(cardBeforeTransition.json?.player?.stamps)
      ? [...cardBeforeTransition.json.player.stamps].sort((left, right) => left - right)
      : [];
    assert.equal(typeof cardIdBefore, 'string');
    assert.ok(stampsBefore.length > 0);

    const transitionResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/session/continue-blackout',
      { resetWinnerLedger: true },
      modHeaders(),
    );
    assert.equal(transitionResponse.status, 200, JSON.stringify(transitionResponse.json));
    assert.equal(transitionResponse.json?.previousMode, 'rows');
    assert.equal(transitionResponse.json?.nextMode, 'blackout');
    assert.equal(transitionResponse.json?.resetWinnerLedgerApplied, true);
    assert.equal(transitionResponse.json?.session?.id, sessionId);
    assert.equal(transitionResponse.json?.session?.mode, 'blackout');
    assert.deepEqual(transitionResponse.json?.session?.winners, []);

    const calledBefore = Array.isArray(sessionBeforeTransition.json?.calledOptions)
      ? [...sessionBeforeTransition.json.calledOptions].sort((left, right) => left.localeCompare(right))
      : [];
    const calledAfterTransition = Array.isArray(transitionResponse.json?.session?.calledOptions)
      ? [...transitionResponse.json.session.calledOptions].sort((left, right) => left.localeCompare(right))
      : [];
    assert.deepEqual(calledAfterTransition, calledBefore);

    const cardAfterTransition = await requestJson(
      runtime.baseUrl,
      'GET',
      '/api/player/card',
      undefined,
      viewerHeaders(sessionId, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(cardAfterTransition.status, 200, JSON.stringify(cardAfterTransition.json));
    assert.equal(cardAfterTransition.json?.player?.card?.id, cardIdBefore);
    assert.equal(cardAfterTransition.json?.player?.hasWon, false);
    const stampsAfter = Array.isArray(cardAfterTransition.json?.player?.stamps)
      ? [...cardAfterTransition.json.player.stamps].sort((left, right) => left - right)
      : [];
    assert.deepEqual(stampsAfter, stampsBefore);

    const claimAfterTransition = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/player/claim',
      {},
      viewerHeaders(sessionId, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(claimAfterTransition.status, 400, JSON.stringify(claimAfterTransition.json));
    assert.equal(claimAfterTransition.json?.error, 'claim_not_validated');
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('continue-blackout reopens ended rounds and reset winners clears winner ledger', { timeout: 120000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-continue-from-ended-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath);
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const startA = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/start',
      { mode: 'rows', options: createOptionsPool(), maxWinners: 1, winnerGraceSeconds: 120 },
      modHeaders(),
    );
    assert.equal(startA.status, 200, JSON.stringify(startA.json));
    const sessionA = startA.json?.session?.id;
    assert.equal(typeof sessionA, 'string');

    await joinPlayer(runtime.baseUrl, sessionA, 'viewer-1', 'ViewerOne');
    const winA = await completeTopRowWin(runtime.baseUrl, sessionA, 'viewer-1', 'ViewerOne');
    assert.equal(winA.finalStamp?.json?.claimAvailable, true);

    const claimA = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/player/claim',
      {},
      viewerHeaders(sessionA, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(claimA.status, 200, JSON.stringify(claimA.json));
    assert.equal(claimA.json?.sessionEnded, true);

    const continueA = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/session/continue-blackout',
      { resetWinnerLedger: false },
      modHeaders(),
    );
    assert.equal(continueA.status, 200, JSON.stringify(continueA.json));
    assert.equal(continueA.json?.previousMode, 'rows');
    assert.equal(continueA.json?.nextMode, 'blackout');
    assert.equal(continueA.json?.resetWinnerLedgerApplied, false);
    assert.equal(continueA.json?.session?.status, 'running');
    assert.deepEqual(continueA.json?.session?.winners, ['viewer-1']);

    const joinAfterContinue = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/player/join',
      { userName: 'ViewerTwo' },
      viewerHeaders(sessionA, 'viewer-2', 'ViewerTwo'),
    );
    assert.equal(joinAfterContinue.status, 200, JSON.stringify(joinAfterContinue.json));

    const blockedByCap = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/player/claim',
      {},
      viewerHeaders(sessionA, 'viewer-2', 'ViewerTwo'),
    );
    assert.equal(blockedByCap.status, 400, JSON.stringify(blockedByCap.json));
    assert.equal(blockedByCap.json?.error, 'winner_cap_reached');

    const startB = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/session/new',
      { mode: 'rows', maxWinners: 1, winnerGraceSeconds: 120 },
      modHeaders(),
    );
    assert.equal(startB.status, 200, JSON.stringify(startB.json));
    const sessionB = startB.json?.session?.id;
    assert.equal(typeof sessionB, 'string');

    await joinPlayer(runtime.baseUrl, sessionB, 'viewer-1', 'ViewerOne');
    const winB = await completeTopRowWin(runtime.baseUrl, sessionB, 'viewer-1', 'ViewerOne');
    assert.equal(winB.finalStamp?.json?.claimAvailable, true);

    const claimB = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/player/claim',
      {},
      viewerHeaders(sessionB, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(claimB.status, 200, JSON.stringify(claimB.json));
    assert.equal(claimB.json?.sessionEnded, true);

    const continueB = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/session/continue-blackout',
      { resetWinnerLedger: true },
      modHeaders(),
    );
    assert.equal(continueB.status, 200, JSON.stringify(continueB.json));
    assert.equal(continueB.json?.previousMode, 'rows');
    assert.equal(continueB.json?.nextMode, 'blackout');
    assert.equal(continueB.json?.resetWinnerLedgerApplied, true);
    assert.equal(continueB.json?.session?.status, 'running');
    assert.deepEqual(continueB.json?.session?.winners, []);

    const cardAfterResetContinue = await requestJson(
      runtime.baseUrl,
      'GET',
      '/api/player/card',
      undefined,
      viewerHeaders(sessionB, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(cardAfterResetContinue.status, 200, JSON.stringify(cardAfterResetContinue.json));
    assert.equal(cardAfterResetContinue.json?.player?.hasWon, false);
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('overlay winner-card endpoint preserves claim order for rotating single-card overlays', { timeout: 120000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-overlay-winners-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath);
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const startResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/start',
      { mode: 'rows', options: createOptionsPool(), maxWinners: 4 },
      modHeaders(),
    );
    assert.equal(startResponse.status, 200, JSON.stringify(startResponse.json));

    const sessionId = startResponse.json?.session?.id;
    assert.equal(typeof sessionId, 'string');

    const participants = [
      { userId: 'viewer-1', userName: 'ViewerOne' },
      { userId: 'viewer-2', userName: 'ViewerTwo' },
      { userId: 'viewer-3', userName: 'ViewerThree' },
      { userId: 'viewer-4', userName: 'ViewerFour' },
    ];

    for (const participant of participants) {
      await joinPlayer(runtime.baseUrl, sessionId, participant.userId, participant.userName);
    }

    const expectedWinnerIds = [];
    for (let index = 0; index < participants.length; index += 1) {
      const participant = participants[index];
      const winAttempt = await completeTopRowWin(runtime.baseUrl, sessionId, participant.userId, participant.userName);
      assert.equal(winAttempt.finalStamp?.json?.claimAvailable, true);

      const claimResponse = await requestJson(
        runtime.baseUrl,
        'POST',
        '/api/player/claim',
        {},
        viewerHeaders(sessionId, participant.userId, participant.userName),
      );
      assert.equal(claimResponse.status, 200, JSON.stringify(claimResponse.json));
      assert.equal(claimResponse.json?.hasWonNow, true);
      assert.equal(Boolean(claimResponse.json?.sessionEnded), false);

      expectedWinnerIds.push(participant.userId);

      const overlayWinnerResponse = await requestJson(runtime.baseUrl, 'GET', '/api/overlay/winner-card');
      assert.equal(overlayWinnerResponse.status, 200, JSON.stringify(overlayWinnerResponse.json));

      const orderedWinnerIds = Array.isArray(overlayWinnerResponse.json?.players)
        ? overlayWinnerResponse.json.players.map((entry) => entry.userId)
        : [];
      assert.deepEqual(orderedWinnerIds, expectedWinnerIds);
      assert.equal(overlayWinnerResponse.json?.player?.userId ?? null, expectedWinnerIds[0] ?? null);
    }

    const activeSession = await requestJson(runtime.baseUrl, 'GET', '/api/session');
    assert.equal(activeSession.status, 200, JSON.stringify(activeSession.json));
    assert.equal(activeSession.json?.status, 'running');
    assert.deepEqual(activeSession.json?.winners, expectedWinnerIds);
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('uncall endpoint revokes mistaken call stamps and blocks uncall after winners exist', { timeout: 120000 }, async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bingo-controller-uncall-it-'));
  const stateFilePath = path.join(tempDir, 'controller-state.json');
  let runtime = null;

  try {
    const port = await getFreePort();
    runtime = startController(port, stateFilePath);
    await waitForHealth(runtime.baseUrl, runtime.child, runtime.logs);

    const startResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/start',
      { mode: 'rows', options: createOptionsPool(), maxWinners: 2 },
      modHeaders(),
    );
    assert.equal(startResponse.status, 200, JSON.stringify(startResponse.json));
    const sessionId = startResponse.json?.session?.id;
    assert.equal(typeof sessionId, 'string');

    await joinPlayer(runtime.baseUrl, sessionId, 'viewer-1', 'ViewerOne');

    const cardResponse = await requestJson(
      runtime.baseUrl,
      'GET',
      '/api/player/card',
      undefined,
      viewerHeaders(sessionId, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(cardResponse.status, 200, JSON.stringify(cardResponse.json));

    const cells = cardResponse.json?.player?.card?.cells;
    assert.ok(Array.isArray(cells), 'Expected player card cells in response.');
    const targetIndex = cells.findIndex((cell) => !cell.free);
    assert.ok(targetIndex >= 0, 'Expected at least one non-free cell.');
    const targetOption = cells[targetIndex]?.value;
    assert.equal(typeof targetOption, 'string');

    const callResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/call',
      { option: targetOption },
      modHeaders(),
    );
    assert.equal(callResponse.status, 200, JSON.stringify(callResponse.json));

    const stampResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/player/stamp',
      { index: targetIndex },
      viewerHeaders(sessionId, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(stampResponse.status, 200, JSON.stringify(stampResponse.json));

    const uncallResponse = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/uncall',
      { option: targetOption },
      modHeaders(),
    );
    assert.equal(uncallResponse.status, 200, JSON.stringify(uncallResponse.json));
    assert.equal(uncallResponse.json?.calledCount, 0);

    const cardAfterUncall = await requestJson(
      runtime.baseUrl,
      'GET',
      '/api/player/card',
      undefined,
      viewerHeaders(sessionId, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(cardAfterUncall.status, 200, JSON.stringify(cardAfterUncall.json));
    assert.equal(Boolean(cardAfterUncall.json?.player?.stamps?.includes(targetIndex)), false);

    const stampAfterUncall = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/player/stamp',
      { index: targetIndex },
      viewerHeaders(sessionId, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(stampAfterUncall.status, 400, JSON.stringify(stampAfterUncall.json));
    assert.equal(stampAfterUncall.json?.reason, 'option_not_called');

    const repeatedUncall = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/uncall',
      { option: targetOption },
      modHeaders(),
    );
    assert.equal(repeatedUncall.status, 400, JSON.stringify(repeatedUncall.json));
    assert.equal(repeatedUncall.json?.error, 'uncall_rejected');
    assert.match(String(repeatedUncall.json?.message ?? ''), /not currently called/i);

    const freshSession = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/session/new',
      { mode: 'rows', maxWinners: 2 },
      modHeaders(),
    );
    assert.equal(freshSession.status, 200, JSON.stringify(freshSession.json));
    const secondSessionId = freshSession.json?.session?.id;
    assert.equal(typeof secondSessionId, 'string');

    await joinPlayer(runtime.baseUrl, secondSessionId, 'viewer-1', 'ViewerOne');
    const winProgress = await completeTopRowWin(runtime.baseUrl, secondSessionId, 'viewer-1', 'ViewerOne');
    assert.equal(winProgress.finalStamp?.json?.claimAvailable, true);

    const claimWinner = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/player/claim',
      {},
      viewerHeaders(secondSessionId, 'viewer-1', 'ViewerOne'),
    );
    assert.equal(claimWinner.status, 200, JSON.stringify(claimWinner.json));
    assert.equal(claimWinner.json?.hasWonNow, true);

    const sessionAfterWin = await requestJson(runtime.baseUrl, 'GET', '/api/session');
    assert.equal(sessionAfterWin.status, 200, JSON.stringify(sessionAfterWin.json));
    const calledAfterWin = Array.isArray(sessionAfterWin.json?.calledOptions) ? sessionAfterWin.json.calledOptions : [];
    assert.ok(calledAfterWin.length > 0, 'Expected called options after win path.');

    const blockedUncall = await requestJson(
      runtime.baseUrl,
      'POST',
      '/api/mod/uncall',
      { option: calledAfterWin[0] },
      modHeaders(),
    );
    assert.equal(blockedUncall.status, 400, JSON.stringify(blockedUncall.json));
    assert.equal(blockedUncall.json?.error, 'uncall_rejected');
    assert.match(String(blockedUncall.json?.message ?? ''), /winner/i);
  } finally {
    await stopController(runtime?.child);
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});
