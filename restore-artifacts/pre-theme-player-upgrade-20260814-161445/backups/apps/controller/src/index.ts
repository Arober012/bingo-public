import cors from 'cors';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tmi from 'tmi.js';
import { z } from 'zod';
import {
  BingoCard,
  BingoMode,
  applyStamp,
  checkWin,
  createRandomCard,
  getInitialStamps,
  normalizeMode,
} from '@bingo/game-core';

dotenv.config();

type SessionStatus = 'idle' | 'open' | 'running' | 'stopped' | 'ended';

interface PlayerState {
  userId: string;
  userName: string;
  card: BingoCard;
  stamps: Set<number>;
  invalidStampCount: number;
  hasWon: boolean;
}

interface SessionState {
  id: string;
  mode: BingoMode;
  status: SessionStatus;
  options: string[];
  maxWinners: number;
  winnerGraceSeconds: number;
  winnerGraceEndsAt: string | null;
  calledOptions: Set<string>;
  players: Map<string, PlayerState>;
  winners: Set<string>;
  createdAt: string;
}

interface OptionPoolItem {
  id: string;
  label: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

type ThemeMode = 'light' | 'dark';
type ThemeScopeTarget = 'all' | 'controller' | 'cards';

interface ThemePalette {
  backgroundStart: string;
  backgroundMid: string;
  backgroundEnd: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  borderSoft: string;
  text: string;
  textMuted: string;
  accent: string;
  accentContrast: string;
  called: string;
  calledBg: string;
  free: string;
  freeBg: string;
  error: string;
  errorBg: string;
  success: string;
  successBg: string;
  warning: string;
  warningBg: string;
}

interface ThemeScopedOverridesState {
  linkControllerAndCards: boolean;
  controllerOverrides: Partial<ThemePalette>;
  cardsOverrides: Partial<ThemePalette>;
}

interface ThemeState {
  mode: ThemeMode;
  overrides: Partial<ThemePalette>;
  scoped: ThemeScopedOverridesState;
  updatedAt: string;
}

interface ResolvedTheme {
  mode: ThemeMode;
  palette: ThemePalette;
  updatedAt: string;
}

interface ChatCommandContext {
  userId: string;
  userName: string;
  isMod: boolean;
  reply: (message: string) => void;
}

interface ChatCommandResult {
  ok: boolean;
  message: string;
}

interface AuditEvent {
  at: string;
  type: string;
  detail: string;
  userId?: string;
  userName?: string;
}

interface AuditActor {
  userId?: string;
  userName?: string;
}

interface StampIdempotencyRecord {
  key: string;
  sessionId: string;
  userId: string;
  statusCode: number;
  response: Record<string, unknown>;
  createdAt: string;
}

interface RedeemJoinRecord {
  key: string;
  sessionId: string;
  redemptionId: string;
  userId: string;
  userName: string;
  inviteToken: string;
  viewerUrl: string;
  expiresAt: number;
  createdAt: string;
}

interface ViewerInviteTokenPayload {
  v: 1;
  type: 'viewer-invite';
  tenantSlug?: string;
  sessionId: string;
  userId: string;
  userName: string;
  redemptionId: string;
  iat: number;
  exp: number;
}

interface ViewerAuthTokenPayload {
  v: 1;
  type: 'viewer-auth';
  tenantSlug?: string;
  sessionId: string;
  userId: string;
  userName: string;
  iat: number;
  exp: number;
}

type ModAuthRole = 'broadcaster' | 'moderator' | 'unauthorized';

interface ModAuthSessionTokenPayload {
  v: 1;
  type: 'mod-auth';
  tenantSlug?: string;
  broadcasterId: string;
  userId: string;
  userLogin: string;
  userName: string;
  role: ModAuthRole;
  iat: number;
  exp: number;
}

interface OwnerAuthSessionTokenPayload {
  v: 1;
  type: 'owner-auth';
  userId: string;
  userLogin: string;
  userName: string;
  iat: number;
  exp: number;
}

type ModAccessMode = 'twitch-session' | 'legacy-token';
type ModAccessSource = 'cookie' | 'bearer';

interface ModAccessContext {
  authMode: ModAccessMode;
  source: ModAccessSource;
  role: ModAuthRole | 'legacy';
  userId: string | null;
  userLogin: string | null;
  userName: string | null;
  legacyTokenUsed: boolean;
}

interface ModAccessFailure {
  ok: false;
  status: 401 | 403 | 503;
  error: string;
  authenticated: boolean;
  role?: ModAuthRole;
  userId?: string;
  userLogin?: string;
  userName?: string;
  missingConfig?: string[];
}

interface ModAccessSuccess {
  ok: true;
  context: ModAccessContext;
}

type ModAccessResult = ModAccessSuccess | ModAccessFailure;

interface OwnerAccessContext {
  source: ModAccessSource;
  userId: string;
  userLogin: string;
  userName: string;
}

interface OwnerAccessFailure {
  ok: false;
  status: 401 | 403 | 503;
  error: string;
  authenticated: boolean;
  missingConfig?: string[];
  userId?: string;
  userLogin?: string;
  userName?: string;
}

interface OwnerAccessSuccess {
  ok: true;
  context: OwnerAccessContext;
}

type OwnerAccessResult = OwnerAccessSuccess | OwnerAccessFailure;

type TenantRouteSource = 'legacy-route' | 'tenant-route' | 'non-api';

interface TenantContext {
  slug: string;
  source: TenantRouteSource;
  isDefaultTenant: boolean;
}

interface TenantRuntimeState {
  activeSession: SessionState | null;
  cardSignatureRegistry: Set<string>;
  optionPool: OptionPoolItem[];
  auditLog: AuditEvent[];
  stampIdempotencyRecords: Map<string, StampIdempotencyRecord>;
  redeemJoinRecords: Map<string, RedeemJoinRecord>;
  themeState: ThemeState;
  pendingOauthStates: Map<string, PendingOauthState>;
  pendingModOauthStates: Map<string, PendingModOauthState>;
  legacyModFallbackLogged: boolean;
}

interface PendingOauthState {
  inviteToken: string;
  createdAt: number;
}

interface PendingModOauthState {
  returnTo: string | null;
  createdAt: number;
}

interface PendingOwnerOauthState {
  returnTo: string | null;
  createdAt: number;
}

interface TenantRedeemKeyRecord {
  salt: string;
  hash: string;
  iterations: number;
  keyLength: number;
  digest: 'sha256';
  createdAt: string;
  rotatedAt: string;
}

interface StreamerSetupEntry {
  tenantSlug: string;
  broadcasterUserName: string | null;
  broadcasterUserLogin: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OwnerTenantRecord {
  tenantSlug: string;
  source: 'persisted' | 'env' | 'fallback' | 'none';
  persistedBroadcasterId: string | null;
  envBroadcasterId: string | null;
  fallbackBroadcasterId: string | null;
  effectiveBroadcasterId: string | null;
  redeemKeyConfigured: boolean;
  redeemKeyCreatedAt: string | null;
  redeemKeyRotatedAt: string | null;
  broadcasterUserId: string | null;
  broadcasterUserLogin: string | null;
  broadcasterUserName: string | null;
}

interface MixItUpSetupBlock {
  tenantSlug: string;
  broadcasterLabel: string;
  overlayUrl: string;
  controllerUrl: string;
  joinUrl: string;
  authorizationHeaderValue: string;
  requestBody: {
    redemptionId: string;
    twitchUserId: string;
    twitchUserName: string;
  };
  setupBlock: string;
}

interface TwitchTokenResponse {
  access_token: string;
}

interface TwitchValidateResponse {
  client_id: string;
  login: string;
  user_id: string;
}

interface TwitchUserResponse {
  data?: Array<{
    id: string;
    login: string;
    display_name: string;
  }>;
}

interface ResolvedTwitchUser {
  userId: string;
  userLogin: string;
  userName: string;
}

interface TwitchModeratedChannelsResponse {
  data?: Array<{
    broadcaster_id: string;
  }>;
  pagination?: {
    cursor?: string;
  };
}

const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{8,128}$/;
const hexColorPattern = /^#[0-9a-fA-F]{6}$/;
const tenantSlugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type TenantPersistenceErrorCode =
  | 'tenant_broadcaster_persist_failed'
  | 'tenant_redeem_key_persist_failed'
  | 'streamer_setup_entries_persist_failed'
  | 'streamer_setup_artifact_persist_failed';

class TenantPersistenceError extends Error {
  readonly errorCode: TenantPersistenceErrorCode;

  constructor(errorCode: TenantPersistenceErrorCode) {
    super(errorCode);
    this.name = 'TenantPersistenceError';
    this.errorCode = errorCode;
  }
}

const sessionStatusSchema = z.enum(['idle', 'open', 'running', 'stopped', 'ended']);

const persistedCardCellSchema = z.object({
  value: z.string(),
  free: z.boolean(),
});

const persistedCardSchema = z.object({
  id: z.string(),
  size: z.number().int().min(1),
  freeCenter: z.boolean(),
  cells: z.array(persistedCardCellSchema),
  signature: z.string(),
});

const persistedPlayerSchema = z.object({
  userId: z.string().min(1),
  userName: z.string().min(1),
  card: persistedCardSchema,
  stamps: z.array(z.number().int().min(0)),
  invalidStampCount: z.number().int().min(0),
  hasWon: z.boolean(),
});

const persistedSessionSchema = z.object({
  id: z.string().min(1),
  mode: z.enum(['normal', 'rows', 'corners', 'blackout', 'postage']),
  status: sessionStatusSchema,
  options: z.array(z.string().min(1)),
  maxWinners: z.number().int().min(1).max(4).optional(),
  winnerGraceSeconds: z.number().int().min(15).max(300).optional(),
  winnerGraceEndsAt: z.string().nullable().optional(),
  calledOptions: z.array(z.string().min(1)),
  players: z.array(persistedPlayerSchema),
  winners: z.array(z.string().min(1)),
  createdAt: z.string(),
});

const persistedAuditEventSchema = z.object({
  at: z.string(),
  type: z.string().min(1),
  detail: z.string().min(1),
  userId: z.string().optional(),
  userName: z.string().optional(),
});

const persistedStampIdempotencyRecordSchema = z.object({
  key: z.string().min(8).max(128),
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  statusCode: z.number().int().min(100).max(599),
  response: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

const persistedRedeemJoinRecordSchema = z.object({
  key: z.string().min(1),
  sessionId: z.string().min(1),
  redemptionId: z.string().min(1),
  userId: z.string().min(1),
  userName: z.string().min(1),
  inviteToken: z.string().min(1),
  viewerUrl: z.string().min(1),
  expiresAt: z.number().int().positive(),
  createdAt: z.string(),
});

const persistedOptionPoolItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const themeModeSchema = z.enum(['light', 'dark']);

const persistedThemePaletteOverridesSchema = z.object({
  backgroundStart: z.string().regex(hexColorPattern).optional(),
  backgroundMid: z.string().regex(hexColorPattern).optional(),
  backgroundEnd: z.string().regex(hexColorPattern).optional(),
  surface: z.string().regex(hexColorPattern).optional(),
  surfaceAlt: z.string().regex(hexColorPattern).optional(),
  border: z.string().regex(hexColorPattern).optional(),
  borderSoft: z.string().regex(hexColorPattern).optional(),
  text: z.string().regex(hexColorPattern).optional(),
  textMuted: z.string().regex(hexColorPattern).optional(),
  accent: z.string().regex(hexColorPattern).optional(),
  accentContrast: z.string().regex(hexColorPattern).optional(),
  called: z.string().regex(hexColorPattern).optional(),
  calledBg: z.string().regex(hexColorPattern).optional(),
  free: z.string().regex(hexColorPattern).optional(),
  freeBg: z.string().regex(hexColorPattern).optional(),
  error: z.string().regex(hexColorPattern).optional(),
  errorBg: z.string().regex(hexColorPattern).optional(),
  success: z.string().regex(hexColorPattern).optional(),
  successBg: z.string().regex(hexColorPattern).optional(),
  warning: z.string().regex(hexColorPattern).optional(),
  warningBg: z.string().regex(hexColorPattern).optional(),
});

const persistedThemeScopedOverridesSchema = z.object({
  linkControllerAndCards: z.boolean().optional().default(true),
  controllerOverrides: persistedThemePaletteOverridesSchema.optional().default({}),
  cardsOverrides: persistedThemePaletteOverridesSchema.optional().default({}),
});

const persistedThemeStateSchema = z.object({
  mode: themeModeSchema,
  overrides: persistedThemePaletteOverridesSchema.optional().default({}),
  scoped: persistedThemeScopedOverridesSchema.optional(),
  updatedAt: z.string(),
});

const persistedOptionPoolEntrySchema = z.union([z.string().min(1), persistedOptionPoolItemSchema]);

const persistedControllerStateSchema = z.object({
  version: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)])
    .optional()
    .default(1),
  savedAt: z.string(),
  optionPool: z.array(persistedOptionPoolEntrySchema).optional(),
  activeSession: persistedSessionSchema.nullish(),
  auditLog: z.array(persistedAuditEventSchema).optional(),
  stampIdempotency: z.array(persistedStampIdempotencyRecordSchema).optional(),
  redeemJoinRecords: z.array(persistedRedeemJoinRecordSchema).optional(),
  themeState: persistedThemeStateSchema.optional(),
});

const tenantRedeemKeyRecordSchema = z.object({
  salt: z.string().min(1),
  hash: z.string().min(1),
  iterations: z.number().int().positive(),
  keyLength: z.number().int().positive(),
  digest: z.literal('sha256'),
  createdAt: z.string(),
  rotatedAt: z.string(),
});

const tenantRedeemKeyRegistrySchema = z.record(z.string(), tenantRedeemKeyRecordSchema);

const streamerSetupEntrySchema = z.object({
  tenantSlug: z.string().min(1),
  broadcasterUserName: z.string().nullable().optional(),
  broadcasterUserLogin: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const persistedStreamerSetupEntriesSchema = z.object({
  version: z.literal(1).optional().default(1),
  savedAt: z.string(),
  entries: z.array(streamerSetupEntrySchema),
});

type PersistedControllerState = z.infer<typeof persistedControllerStateSchema>;
type PersistedSessionState = z.infer<typeof persistedSessionSchema>;
type PersistedPlayerState = z.infer<typeof persistedPlayerSchema>;
type PersistedStampIdempotencyRecord = z.infer<typeof persistedStampIdempotencyRecordSchema>;
type PersistedRedeemJoinRecord = z.infer<typeof persistedRedeemJoinRecordSchema>;
type PersistedOptionPoolEntry = z.infer<typeof persistedOptionPoolEntrySchema>;
type PersistedStreamerSetupEntries = z.infer<typeof persistedStreamerSetupEntriesSchema>;

const app = express();
const port = Number(process.env.PORT ?? 4000);
const minOptionsForFiveByFive = 24;
const minWinnerClaims = 1;
const maxWinnerClaims = 4;
const defaultMaxWinnerClaims = 2;
const defaultWinnerGracePeriodSeconds = 30;
const minWinnerGraceSeconds = 15;
const maxWinnerGraceSeconds = 300;
const maxAuditEntries = 500;
const defaultStampIdempotencyTtlMs = 6 * 60 * 60 * 1000;
const defaultStampIdempotencyMaxRecords = 2000;
const defaultViewerInviteTokenTtlMs = 8 * 60 * 60 * 1000;
const defaultViewerAuthTokenTtlMs = 24 * 60 * 60 * 1000;
const defaultOauthStateTtlMs = 10 * 60 * 1000;
const defaultModAuthSessionTtlMs = 8 * 60 * 60 * 1000;
const defaultModOauthScope = 'user:read:moderated_channels';
const defaultOwnerAuthSessionTtlMs = 8 * 60 * 60 * 1000;
const stampIdempotencyTtlMs = parsePositiveIntEnv(
  process.env.STAMP_IDEMPOTENCY_TTL_MS,
  defaultStampIdempotencyTtlMs,
);
const maxStampIdempotencyRecords = parsePositiveIntEnv(
  process.env.STAMP_IDEMPOTENCY_MAX_RECORDS,
  defaultStampIdempotencyMaxRecords,
);
const winnerGracePeriodSeconds = parsePositiveIntEnv(
  process.env.WINNER_GRACE_PERIOD_SECONDS,
  defaultWinnerGracePeriodSeconds,
);
const clampedWinnerGracePeriodSeconds = Math.max(
  minWinnerGraceSeconds,
  Math.min(maxWinnerGraceSeconds, winnerGracePeriodSeconds),
);
const strictWinnerGraceWindow = parseBooleanEnv(process.env.STRICT_WINNER_GRACE_WINDOW, true);
const modControlToken = process.env.MOD_CONTROL_TOKEN?.trim() ?? '';
const multiTenantEnabled = parseBooleanEnv(process.env.MULTI_TENANT_ENABLED, false);
const legacySingleTenantFallback = parseBooleanEnv(process.env.LEGACY_SINGLE_TENANT_FALLBACK, true);
const defaultThemeMode: ThemeMode = process.env.DEFAULT_THEME_MODE?.trim().toLowerCase() === 'light' ? 'light' : 'dark';
const twitchClientId = process.env.TWITCH_CLIENT_ID?.trim() ?? '';
const twitchClientSecret = process.env.TWITCH_CLIENT_SECRET?.trim() ?? '';
const twitchRedirectUri = process.env.TWITCH_REDIRECT_URI?.trim() ?? '';
const twitchOauthScope = process.env.TWITCH_OAUTH_SCOPE?.trim() ?? '';
const twitchBroadcasterId = process.env.TWITCH_BROADCASTER_ID?.trim() ?? '';
const tenantBroadcasterOverrides = parseTenantBroadcasterOverrides(process.env.TENANT_BROADCASTER_OVERRIDES);
const tenantBroadcasterAutoRegister = parseBooleanEnv(process.env.TENANT_BROADCASTER_AUTO_REGISTER, false);
const defaultTenantSlug = resolveDefaultTenantSlug(process.env.DEFAULT_TENANT_SLUG, twitchBroadcasterId);
const publicApiBaseUrl = process.env.PUBLIC_API_BASE_URL?.trim() ?? '';
const defaultModRedirectUri = publicApiBaseUrl
  ? `${trimTrailingSlashes(publicApiBaseUrl)}/api/mod/auth/twitch/callback`
  : '';
const defaultOwnerAuthRedirectUri = publicApiBaseUrl
  ? `${trimTrailingSlashes(publicApiBaseUrl)}/api/owner/auth/twitch/callback`
  : '';
const twitchModRedirectUri = process.env.TWITCH_MOD_REDIRECT_URI?.trim() ?? defaultModRedirectUri;
const twitchModOauthScope = process.env.TWITCH_MOD_OAUTH_SCOPE?.trim() || defaultModOauthScope;
const modAuthSessionSecret = process.env.MOD_AUTH_SESSION_SECRET?.trim() ?? '';
const rawModAuthCookieDomain = process.env.MOD_AUTH_COOKIE_DOMAIN?.trim() ?? '';
const modAuthCookieDomain = normalizeCookieDomain(rawModAuthCookieDomain);
const modAuthAllowLegacyToken = parseBooleanEnv(process.env.MOD_AUTH_ALLOW_LEGACY_TOKEN, true);
const modAuthSessionTtlMs = parsePositiveIntEnv(process.env.MOD_AUTH_SESSION_TTL_MS, defaultModAuthSessionTtlMs);
const ownerAuthSessionSecret = process.env.OWNER_AUTH_SESSION_SECRET?.trim() ?? '';
const ownerAuthRedirectUri = process.env.OWNER_AUTH_REDIRECT_URI?.trim() ?? defaultOwnerAuthRedirectUri;
const ownerAuthTwitchRedirectUri = twitchModRedirectUri || ownerAuthRedirectUri;
const ownerAuthOauthScope = process.env.OWNER_AUTH_OAUTH_SCOPE?.trim() ?? '';
const rawOwnerAuthCookieDomain = process.env.OWNER_AUTH_COOKIE_DOMAIN?.trim() ?? '';
const ownerAuthCookieDomain = normalizeCookieDomain(rawOwnerAuthCookieDomain);
const ownerAuthSessionTtlMs = parsePositiveIntEnv(process.env.OWNER_AUTH_SESSION_TTL_MS, defaultOwnerAuthSessionTtlMs);
const ownerTwitchUserIds = new Set(
  (process.env.OWNER_TWITCH_USER_IDS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
);
const ownerAuthEnabled = parseBooleanEnv(process.env.OWNER_AUTH_ENABLED, true);
const publicOverlayBaseUrl = process.env.PUBLIC_OVERLAY_BASE_URL?.trim() ?? 'https://public-overlay.custom-overlays.com';
const publicControlBaseUrl = process.env.PUBLIC_CONTROL_BASE_URL?.trim() ?? 'https://public-controller.custom-overlays.com';
const ownerPanelBaseUrl = process.env.PUBLIC_OWNER_BASE_URL?.trim() ?? 'https://bingo-owner.custom-overlays.com';
const viewerBaseUrl = process.env.VIEWER_BASE_URL?.trim() ?? '';
const viewerInviteTokenSecret = process.env.VIEWER_INVITE_TOKEN_SECRET?.trim() ?? '';
const viewerAuthTokenSecret = process.env.VIEWER_AUTH_TOKEN_SECRET?.trim() ?? '';
const internalRedeemSecret = process.env.INTERNAL_REDEEM_SECRET?.trim() ?? '';
const legacyInternalRedeemSecretEnabled = parseBooleanEnv(process.env.LEGACY_INTERNAL_REDEEM_SECRET_ENABLED, true);
const tenantRedeemKeyHashIterations = parsePositiveIntEnv(process.env.TENANT_REDEEM_KEY_HASH_ITERATIONS, 120000);
const viewerInviteTokenTtlMs = parsePositiveIntEnv(
  process.env.VIEWER_INVITE_TOKEN_TTL_MS,
  defaultViewerInviteTokenTtlMs,
);
const viewerAuthTokenTtlMs = parsePositiveIntEnv(
  process.env.VIEWER_AUTH_TOKEN_TTL_MS,
  defaultViewerAuthTokenTtlMs,
);
const oauthStateTtlMs = parsePositiveIntEnv(process.env.TWITCH_OAUTH_STATE_TTL_MS, defaultOauthStateTtlMs);
const configuredAllowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((value) => toOrigin(value.trim()))
  .filter((value): value is string => Boolean(value));
const defaultAllowedOrigins = [
  toOrigin(viewerBaseUrl),
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:4173',
].filter((value): value is string => Boolean(value));
const allowedCorsOrigins = new Set<string>([...configuredAllowedOrigins, ...defaultAllowedOrigins]);
const tenantApiPathPattern = /^\/api\/t\/([^/]+)(\/.*)?$/;

app.set('trust proxy', true);
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      callback(null, allowedCorsOrigins.has(origin));
    },
    credentials: true,
  }),
);
app.use(express.json());
app.use((req, res, next) => {
  const tenantRoute = parseTenantRoute(req.path);
  if (tenantRoute) {
    const tenantSlug = parseTenantSlugFromRoute(tenantRoute.tenantSlug);
    if (!tenantSlug) {
      res.status(400).json({
        error: 'invalid_tenant_slug',
        message: 'Tenant slugs must use lowercase letters, numbers, and hyphens.',
      });
      return;
    }

    const tenantContext: TenantContext = {
      slug: tenantSlug,
      source: 'tenant-route',
      isDefaultTenant: tenantSlug === defaultTenantSlug,
    };
    setTenantContext(req, tenantContext);

    rewriteTenantRequestUrl(req, tenantRoute.suffix);
    next();
    return;
  }

  if (isLegacyApiRoute(req.path)) {
    setTenantContext(req, {
      slug: defaultTenantSlug,
      source: 'legacy-route',
      isDefaultTenant: true,
    });

    if (
      multiTenantEnabled
      && !legacySingleTenantFallback
      && !isLegacyApiRouteExemptFromTenantFallback(req.path)
    ) {
      res.status(410).json({
        error: 'legacy_api_route_disabled',
        message: 'Use /api/t/:tenantSlug/* routes when multi-tenant mode is enabled.',
        defaultTenant: defaultTenantSlug,
      });
      return;
    }
  } else {
    setTenantContext(req, {
      slug: defaultTenantSlug,
      source: 'non-api',
      isDefaultTenant: true,
    });
  }

  next();
});
app.use((req, _res, next) => {
  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);
  finalizeWinnerGraceWindowIfNeeded(tenantContext.slug, tenantState);
  next();
});
const defaultOptionLabels: string[] = [
  'Hydration Break',
  'Keyboard Fumble',
  'Frame Drop Mentioned',
  'Unexpected Jump Scare',
  'Clip It Callout',
  'Mic Peak',
  'New Follower Alert',
  'Boss Fight Starts',
  'Side Quest Detour',
  'Backseat Gaming Moment',
  'Speedrun Reset',
  'Controller DC',
  'Inventory Panic',
  'Streamer Laugh Loop',
  'Lore Dump',
  'Accidental Emote Spam',
  'High Risk Play',
  'Victory Shout',
  'Wholesome Chat Moment',
  'Unexpected Ad Read',
  'Tech Support Arc',
  'NPC Monologue',
  'Narrow Escape',
  'GG Spam',
  'New PB Attempt',
  'Chat Poll Moment',
  'Clutch Save',
  'Audio Scuff',
  'Speed Tech Found',
  'Lore Theory',
];
const stateFilePath = resolveStateFilePath(process.env.CONTROLLER_STATE_FILE);
const stateFileDirectory = path.dirname(stateFilePath);
const stateFileName = path.basename(stateFilePath);
const tenantStateDirectory = path.join(stateFileDirectory, 'tenants');
const tenantBroadcasterMapFilePath = path.join(stateFileDirectory, 'tenant-broadcasters.json');
const tenantRedeemKeyMapFilePath = path.join(stateFileDirectory, 'tenant-redeem-keys.json');
const streamerSetupDirectory = path.join(stateFileDirectory, 'owner-setup-export');
const streamerSetupEntriesFilePath = path.join(streamerSetupDirectory, 'streamer-setup-entries.json');
const streamerSetupMarkdownFilePath = path.join(streamerSetupDirectory, 'MixItUp-Streamer-Setup-Reference-Sheet.md');
const streamerSetupHtmlFilePath = path.join(streamerSetupDirectory, 'MixItUp-Streamer-Setup-Reference-Sheet.html');
const streamerSetupPdfFilePath = path.join(streamerSetupDirectory, 'MixItUp-Streamer-Setup-Reference-Sheet.pdf');

const tenantRuntimeStates = new Map<string, TenantRuntimeState>();
const tenantBroadcasterRegistry = loadTenantBroadcasterRegistry();
const tenantRedeemKeyRegistry = loadTenantRedeemKeyRegistry();
const streamerSetupEntryRegistry = loadStreamerSetupEntryRegistry();
const pendingOwnerOauthStates = new Map<string, PendingOwnerOauthState>();

function createTenantRuntimeState(): TenantRuntimeState {
  return {
    activeSession: null,
    cardSignatureRegistry: new Set<string>(),
    optionPool: createOptionPoolFromLabels(defaultOptionLabels),
    auditLog: [],
    stampIdempotencyRecords: new Map<string, StampIdempotencyRecord>(),
    redeemJoinRecords: new Map<string, RedeemJoinRecord>(),
    themeState: createDefaultThemeState(defaultThemeMode),
    pendingOauthStates: new Map<string, PendingOauthState>(),
    pendingModOauthStates: new Map<string, PendingModOauthState>(),
    legacyModFallbackLogged: false,
  };
}

function resolveTenantStateFilePath(tenantSlug: string): string {
  if (tenantSlug === defaultTenantSlug) {
    return stateFilePath;
  }

  return path.join(tenantStateDirectory, tenantSlug, stateFileName);
}

function getTenantRuntimeState(tenantSlug: string): TenantRuntimeState {
  const existing = tenantRuntimeStates.get(tenantSlug);
  if (existing) {
    return existing;
  }

  const created = createTenantRuntimeState();
  tenantRuntimeStates.set(tenantSlug, created);
  loadPersistedControllerState(tenantSlug, created);
  return created;
}

function getTenantRuntimeStateFromRequest(req: Request): TenantRuntimeState {
  return getTenantRuntimeState(getTenantContext(req).slug);
}

function getDefaultTenantRuntimeState(): TenantRuntimeState {
  return getTenantRuntimeState(defaultTenantSlug);
}

const startSchema = z.object({
  mode: z.string().optional(),
  options: z.array(z.string().min(1)).min(minOptionsForFiveByFive).optional(),
  maxWinners: z.number().int().min(minWinnerClaims).max(maxWinnerClaims).optional(),
  winnerGraceSeconds: z.number().int().min(minWinnerGraceSeconds).max(maxWinnerGraceSeconds).optional(),
});

const newSessionSchema = z.object({
  mode: z.string().optional(),
  maxWinners: z.number().int().min(minWinnerClaims).max(maxWinnerClaims).optional(),
  winnerGraceSeconds: z.number().int().min(minWinnerGraceSeconds).max(maxWinnerGraceSeconds).optional(),
});

const continueBlackoutSchema = z.object({
  resetWinnerLedger: z.boolean().optional(),
});

const stopSchema = z.object({
  end: z.boolean().optional(),
});

const joinSchema = z.object({
  userName: z.string().min(1).optional(),
});

const redeemJoinSchema = z.object({
  redemptionId: z.string().min(1),
  twitchUserId: z.string().min(1),
  twitchUserName: z.string().min(1),
});

const tenantBroadcasterUpsertSchema = z.object({
  tenantSlug: z.string().min(1),
  broadcasterId: z.string().min(1),
});

const ownerTenantResolveUserSchema = z.object({
  login: z.string().min(1),
});

const ownerTenantRedeemKeyRotateSchema = z.object({
  tenantSlug: z.string().min(1),
});

const ownerSetupGenerateSchema = z.object({
  tenantSlug: z.string().min(1),
});

const ownerSetupEntryUpsertSchema = z.object({
  tenantSlug: z.string().min(1),
});

const ownerSetupRegenerateSchema = z.object({
  includeAllKnownTenants: z.boolean().optional(),
});

const ownerSetupSingleExportSchema = z.object({
  tenantSlug: z.string().min(1),
  format: z.enum(['markdown', 'html', 'pdf']),
});

const ownerTenantRemoveSchema = z.object({
  tenantSlug: z.string().min(1),
  removeRedeemKey: z.boolean().optional(),
});

const callOptionSchema = z.object({
  option: z.string().min(1),
});

const uncallOptionSchema = z.object({
  option: z.string().min(1),
});

const stampSchema = z.object({
  index: z.number().int().min(0),
  idempotencyKey: z.string().regex(idempotencyKeyPattern).optional(),
});

const claimSchema = z.object({
  idempotencyKey: z.string().regex(idempotencyKeyPattern).optional(),
});

const chatCommandSchema = z.object({
  command: z.string().min(1),
  userId: z.string().min(1),
  userName: z.string().min(1),
  isMod: z.boolean().optional(),
});

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(maxAuditEntries).optional(),
});

const modOptionCreateSchema = z.object({
  label: z.string().min(1),
  enabled: z.boolean().optional(),
});

const modOptionUpdateSchema = z
  .object({
    label: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => value.label !== undefined || value.enabled !== undefined, {
    message: 'Provide at least one field to update.',
  });

const modOptionBulkEnabledSchema = z.object({
  optionIds: z.array(z.string().min(1)).min(1).max(500),
  enabled: z.boolean(),
});

const modOptionBulkDeleteSchema = z.object({
  optionIds: z.array(z.string().min(1)).min(1).max(500),
});

const modThemePalettePatchSchema = z.object({
  backgroundStart: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  backgroundMid: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  backgroundEnd: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  surface: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  surfaceAlt: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  border: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  borderSoft: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  text: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  textMuted: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  accent: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  accentContrast: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  called: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  calledBg: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  free: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  freeBg: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  error: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  errorBg: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  success: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  successBg: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  warning: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
  warningBg: z.union([z.string().regex(hexColorPattern), z.null()]).optional(),
});

const themeScopeTargetSchema = z.enum(['all', 'controller', 'cards']);

const modThemeUpdateSchema = z
  .object({
    mode: themeModeSchema.optional(),
    palette: modThemePalettePatchSchema.optional(),
    resetOverrides: z.boolean().optional(),
    scopeTarget: themeScopeTargetSchema.optional(),
    linkControllerAndCards: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.mode !== undefined
      || value.palette !== undefined
      || value.resetOverrides === true
      || value.linkControllerAndCards !== undefined,
    { message: 'Provide mode, palette, resetOverrides, or linkControllerAndCards.' },
  );

const themePaletteKeys: (keyof ThemePalette)[] = [
  'backgroundStart',
  'backgroundMid',
  'backgroundEnd',
  'surface',
  'surfaceAlt',
  'border',
  'borderSoft',
  'text',
  'textMuted',
  'accent',
  'accentContrast',
  'called',
  'calledBg',
  'free',
  'freeBg',
  'error',
  'errorBg',
  'success',
  'successBg',
  'warning',
  'warningBg',
];

const themePresets: Record<ThemeMode, ThemePalette> = {
  dark: {
    backgroundStart: '#081124',
    backgroundMid: '#121f38',
    backgroundEnd: '#1c2f4f',
    surface: '#132746',
    surfaceAlt: '#1d3a62',
    border: '#4f7bb2',
    borderSoft: '#365a8b',
    text: '#f4f8ff',
    textMuted: '#bed2f0',
    accent: '#6ad9ff',
    accentContrast: '#0f2340',
    called: '#5dcf9b',
    calledBg: '#133f31',
    free: '#ffd17d',
    freeBg: '#4f3820',
    error: '#ff8d8d',
    errorBg: '#4f2323',
    success: '#9ef8c7',
    successBg: '#1d4a39',
    warning: '#ffd27e',
    warningBg: '#4c3b1a',
  },
  light: {
    backgroundStart: '#f4f8ff',
    backgroundMid: '#dbeafe',
    backgroundEnd: '#bfdbfe',
    surface: '#ffffff',
    surfaceAlt: '#eff6ff',
    border: '#7aa2d8',
    borderSoft: '#bfd6f4',
    text: '#0f1f38',
    textMuted: '#44577a',
    accent: '#1e66d6',
    accentContrast: '#ffffff',
    called: '#0e7c5a',
    calledBg: '#d9f5e9',
    free: '#8a5b00',
    freeBg: '#fff0c4',
    error: '#9f1d1d',
    errorBg: '#ffe2e2',
    success: '#16643c',
    successBg: '#dcfaea',
    warning: '#7a4b00',
    warningBg: '#ffefcb',
  },
};

function createDefaultThemeState(mode: ThemeMode): ThemeState {
  return {
    mode,
    overrides: {},
    scoped: createDefaultThemeScopedOverridesState(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeThemePaletteOverrides(
  input: Partial<ThemePalette> | null | undefined,
): Partial<ThemePalette> {
  const normalized: Partial<ThemePalette> = {};
  if (!input) {
    return normalized;
  }

  for (const key of themePaletteKeys) {
    const value = input[key];
    if (typeof value === 'string' && hexColorPattern.test(value)) {
      normalized[key] = value;
    }
  }

  return normalized;
}

function createDefaultThemeScopedOverridesState(): ThemeScopedOverridesState {
  return {
    linkControllerAndCards: true,
    controllerOverrides: {},
    cardsOverrides: {},
  };
}

function resolveThemeScopedOverridesState(state: ThemeState): ThemeScopedOverridesState {
  const scoped = state.scoped;
  return {
    linkControllerAndCards: scoped?.linkControllerAndCards !== false,
    controllerOverrides: normalizeThemePaletteOverrides(scoped?.controllerOverrides),
    cardsOverrides: normalizeThemePaletteOverrides(scoped?.cardsOverrides),
  };
}

function resolveThemeState(state: ThemeState, surface: 'controller' | 'cards' = 'cards'): ResolvedTheme {
  const scoped = resolveThemeScopedOverridesState(state);
  const scopedOverrides = scoped.linkControllerAndCards
    ? {}
    : surface === 'controller'
      ? scoped.controllerOverrides
      : scoped.cardsOverrides;

  return {
    mode: state.mode,
    palette: {
      ...themePresets[state.mode],
      ...normalizeThemePaletteOverrides(state.overrides),
      ...scopedOverrides,
    },
    updatedAt: state.updatedAt,
  };
}

function applyThemePalettePatch(
  currentOverrides: Partial<ThemePalette>,
  patch: z.infer<typeof modThemePalettePatchSchema>,
): { overrides: Partial<ThemePalette>; changed: boolean } {
  const nextOverrides: Partial<ThemePalette> = { ...normalizeThemePaletteOverrides(currentOverrides) };
  let changed = false;

  for (const key of themePaletteKeys) {
    if (!(key in patch)) {
      continue;
    }

    const nextValue = patch[key];
    if (nextValue === null) {
      if (nextOverrides[key] !== undefined) {
        delete nextOverrides[key];
        changed = true;
      }
      continue;
    }

    if (nextValue !== undefined && nextOverrides[key] !== nextValue) {
      nextOverrides[key] = nextValue;
      changed = true;
    }
  }

  return {
    overrides: nextOverrides,
    changed,
  };
}

function applyThemePatch(state: ThemeState, patch: z.infer<typeof modThemeUpdateSchema>): ThemeState | null {
  let changed = false;
  let nextMode = state.mode;
  let nextOverrides: Partial<ThemePalette> = normalizeThemePaletteOverrides(state.overrides);
  let nextScoped: ThemeScopedOverridesState = resolveThemeScopedOverridesState(state);

  if (patch.mode && patch.mode !== state.mode) {
    nextMode = patch.mode;
    changed = true;
  }

  if (
    patch.linkControllerAndCards !== undefined
    && patch.linkControllerAndCards !== nextScoped.linkControllerAndCards
  ) {
    nextScoped = {
      ...nextScoped,
      linkControllerAndCards: patch.linkControllerAndCards,
    };
    changed = true;
  }

  const hasScopeTarget = patch.scopeTarget !== undefined;
  const scopeTarget: ThemeScopeTarget = patch.scopeTarget ?? 'all';

  if (patch.resetOverrides) {
    if (!hasScopeTarget || scopeTarget === 'all') {
      if (Object.keys(nextOverrides).length > 0) {
        nextOverrides = {};
        changed = true;
      }
    }

    if (hasScopeTarget && (scopeTarget === 'controller' || scopeTarget === 'all')) {
      if (Object.keys(nextScoped.controllerOverrides).length > 0) {
        nextScoped = {
          ...nextScoped,
          controllerOverrides: {},
        };
        changed = true;
      }
    }

    if (hasScopeTarget && (scopeTarget === 'cards' || scopeTarget === 'all')) {
      if (Object.keys(nextScoped.cardsOverrides).length > 0) {
        nextScoped = {
          ...nextScoped,
          cardsOverrides: {},
        };
        changed = true;
      }
    }
  }

  if (patch.palette) {
    if (hasScopeTarget && scopeTarget === 'controller') {
      const applied = applyThemePalettePatch(nextScoped.controllerOverrides, patch.palette);
      if (applied.changed) {
        nextScoped = {
          ...nextScoped,
          controllerOverrides: applied.overrides,
        };
        changed = true;
      }
    } else if (hasScopeTarget && scopeTarget === 'cards') {
      const applied = applyThemePalettePatch(nextScoped.cardsOverrides, patch.palette);
      if (applied.changed) {
        nextScoped = {
          ...nextScoped,
          cardsOverrides: applied.overrides,
        };
        changed = true;
      }
    } else {
      const applied = applyThemePalettePatch(nextOverrides, patch.palette);
      if (applied.changed) {
        nextOverrides = applied.overrides;
        changed = true;
      }
    }
  }

  if (!changed) {
    return null;
  }

  return {
    mode: nextMode,
    overrides: nextOverrides,
    scoped: nextScoped,
    updatedAt: new Date().toISOString(),
  };
}

function isOwnerUserId(userId: string | null | undefined): boolean {
  const normalized = String(userId ?? '').trim();
  if (!normalized) {
    return false;
  }

  return ownerTwitchUserIds.has(normalized);
}

function getOwnerAuthConfigErrors(): string[] {
  const missing: string[] = [];
  if (!ownerAuthEnabled) {
    missing.push('OWNER_AUTH_ENABLED');
  }

  if (!twitchClientId) {
    missing.push('TWITCH_CLIENT_ID');
  }

  if (!twitchClientSecret) {
    missing.push('TWITCH_CLIENT_SECRET');
  }

  if (!ownerAuthSessionSecret) {
    missing.push('OWNER_AUTH_SESSION_SECRET');
  }

  if (!ownerAuthTwitchRedirectUri) {
    missing.push('OWNER_AUTH_REDIRECT_URI or TWITCH_MOD_REDIRECT_URI or PUBLIC_API_BASE_URL');
  }

  if (ownerTwitchUserIds.size === 0) {
    missing.push('OWNER_TWITCH_USER_IDS');
  }

  return missing;
}

function isOwnerAuthConfigured(): boolean {
  return getOwnerAuthConfigErrors().length === 0;
}

function createOwnerAuthSessionToken(
  payload: Omit<OwnerAuthSessionTokenPayload, 'v' | 'type' | 'iat' | 'exp'>,
  ttlMs: number = ownerAuthSessionTtlMs,
): string {
  const now = Date.now();
  const tokenPayload: OwnerAuthSessionTokenPayload = {
    v: 1,
    type: 'owner-auth',
    ...payload,
    iat: now,
    exp: now + ttlMs,
  };

  return encodeSignedToken(tokenPayload, ownerAuthSessionSecret);
}

function verifyOwnerAuthSessionToken(token: string): OwnerAuthSessionTokenPayload | null {
  if (!ownerAuthSessionSecret) {
    return null;
  }

  const payload = decodeSignedToken<OwnerAuthSessionTokenPayload>(token, ownerAuthSessionSecret);
  if (!payload) {
    return null;
  }

  if (payload.v !== 1 || payload.type !== 'owner-auth') {
    return null;
  }

  if (!payload.userId || !payload.userLogin || !payload.userName) {
    return null;
  }

  if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) {
    return null;
  }

  return payload;
}

function resolveOwnerAccess(req: Request): OwnerAccessResult {
  const bearerToken = readBearerToken(req);
  if (bearerToken) {
    const sessionPayload = verifyOwnerAuthSessionToken(bearerToken);
    if (!sessionPayload) {
      return {
        ok: false,
        status: 401,
        error: 'invalid_owner_auth',
        authenticated: false,
      };
    }

    if (!isOwnerUserId(sessionPayload.userId)) {
      return {
        ok: false,
        status: 403,
        error: 'owner_not_allowed',
        authenticated: true,
        userId: sessionPayload.userId,
        userLogin: sessionPayload.userLogin,
        userName: sessionPayload.userName,
      };
    }

    return {
      ok: true,
      context: {
        source: 'bearer',
        userId: sessionPayload.userId,
        userLogin: sessionPayload.userLogin,
        userName: sessionPayload.userName,
      },
    };
  }

  const cookies = parseCookieHeader(req.header('cookie'));
  const cookieToken = String(cookies.get('owner_auth') ?? '').trim();
  if (cookieToken) {
    const sessionPayload = verifyOwnerAuthSessionToken(cookieToken);
    if (!sessionPayload) {
      return {
        ok: false,
        status: 401,
        error: 'invalid_owner_session',
        authenticated: false,
      };
    }

    if (!isOwnerUserId(sessionPayload.userId)) {
      return {
        ok: false,
        status: 403,
        error: 'owner_not_allowed',
        authenticated: true,
        userId: sessionPayload.userId,
        userLogin: sessionPayload.userLogin,
        userName: sessionPayload.userName,
      };
    }

    return {
      ok: true,
      context: {
        source: 'cookie',
        userId: sessionPayload.userId,
        userLogin: sessionPayload.userLogin,
        userName: sessionPayload.userName,
      },
    };
  }

  if (!isOwnerAuthConfigured()) {
    return {
      ok: false,
      status: 503,
      error: 'owner_auth_not_configured',
      authenticated: false,
      missingConfig: getOwnerAuthConfigErrors(),
    };
  }

  return {
    ok: false,
    status: 401,
    error: 'owner_auth_required',
    authenticated: false,
  };
}

function ensureOwnerAccess(req: Request, res: Response): boolean {
  const result = resolveOwnerAccess(req);
  if (result.ok) {
    return true;
  }

  if (result.status === 503) {
    res.status(503).json({
      error: result.error,
      missing: result.missingConfig ?? [],
      authenticated: false,
    });
    return false;
  }

  if (result.status === 403) {
    res.status(403).json({
      error: result.error,
      authenticated: true,
      user: {
        userId: result.userId,
        userLogin: result.userLogin,
        userName: result.userName,
      },
    });
    return false;
  }

  res.status(401).json({
    error: result.error,
    authenticated: false,
  });
  return false;
}

function getModAuthConfigErrors(
  tenantSlug: string = defaultTenantSlug,
  options: { allowMissingBroadcaster?: boolean } = {},
): string[] {
  const missing: string[] = [];
  if (!twitchClientId) {
    missing.push('TWITCH_CLIENT_ID');
  }

  if (!twitchClientSecret) {
    missing.push('TWITCH_CLIENT_SECRET');
  }

  if (!resolveExpectedBroadcasterIdForTenant(tenantSlug) && !options.allowMissingBroadcaster) {
    missing.push('TWITCH_BROADCASTER_ID or TENANT_BROADCASTER_OVERRIDES');
  }

  if (!modAuthSessionSecret) {
    missing.push('MOD_AUTH_SESSION_SECRET');
  }

  if (!twitchModRedirectUri) {
    missing.push('TWITCH_MOD_REDIRECT_URI or PUBLIC_API_BASE_URL');
  }

  return missing;
}

function isModAuthConfigured(
  tenantSlug: string = defaultTenantSlug,
  options: { allowMissingBroadcaster?: boolean } = {},
): boolean {
  return getModAuthConfigErrors(tenantSlug, options).length === 0;
}

function createModAuthSessionToken(
  payload: Omit<ModAuthSessionTokenPayload, 'v' | 'type' | 'iat' | 'exp'>,
  ttlMs: number = modAuthSessionTtlMs,
): string {
  const now = Date.now();
  const tokenPayload: ModAuthSessionTokenPayload = {
    v: 1,
    type: 'mod-auth',
    ...payload,
    iat: now,
    exp: now + ttlMs,
  };

  return encodeSignedToken(tokenPayload, modAuthSessionSecret);
}

function verifyModAuthSessionToken(token: string): ModAuthSessionTokenPayload | null {
  if (!modAuthSessionSecret) {
    return null;
  }

  const payload = decodeSignedToken<ModAuthSessionTokenPayload>(token, modAuthSessionSecret);
  if (!payload) {
    return null;
  }

  if (payload.v !== 1 || payload.type !== 'mod-auth') {
    return null;
  }

  if (!payload.userId || !payload.userLogin || !payload.userName || !payload.broadcasterId) {
    return null;
  }

  if (payload.tenantSlug !== undefined && !parseTenantSlugFromRoute(payload.tenantSlug)) {
    return null;
  }

  if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) {
    return null;
  }

  if (payload.role !== 'broadcaster' && payload.role !== 'moderator' && payload.role !== 'unauthorized') {
    return null;
  }

  return payload;
}

function resolveModAccessFromSession(
  payload: ModAuthSessionTokenPayload,
  source: ModAccessSource,
  tenantContext: TenantContext,
): ModAccessResult {
  const payloadTenantSlug = resolveTokenTenantSlug(payload.tenantSlug);
  if (payloadTenantSlug !== tenantContext.slug) {
    return {
      ok: false,
      status: 403,
      error: 'mod_session_tenant_mismatch',
      authenticated: true,
      role: payload.role,
      userId: payload.userId,
      userLogin: payload.userLogin,
      userName: payload.userName,
    };
  }

  const expectedBroadcasterId = resolveExpectedBroadcasterIdForTenant(tenantContext.slug);
  if (!expectedBroadcasterId) {
    return {
      ok: false,
      status: 503,
      error: 'mod_auth_not_configured',
      authenticated: false,
      missingConfig: getModAuthConfigErrors(tenantContext.slug),
    };
  }

  if (payload.broadcasterId !== expectedBroadcasterId) {
    return {
      ok: false,
      status: 403,
      error: 'mod_session_broadcaster_mismatch',
      authenticated: true,
      role: payload.role,
      userId: payload.userId,
      userLogin: payload.userLogin,
      userName: payload.userName,
    };
  }

  if (payload.role === 'unauthorized') {
    return {
      ok: false,
      status: 403,
      error: 'mod_privileges_required',
      authenticated: true,
      role: payload.role,
      userId: payload.userId,
      userLogin: payload.userLogin,
      userName: payload.userName,
    };
  }

  return {
    ok: true,
    context: {
      authMode: 'twitch-session',
      source,
      role: payload.role,
      userId: payload.userId,
      userLogin: payload.userLogin,
      userName: payload.userName,
      legacyTokenUsed: false,
    },
  };
}

function resolveModAccess(req: Request): ModAccessResult {
  const tenantContext = getTenantContext(req);
  const bearerToken = readBearerToken(req);
  if (bearerToken) {
    const sessionPayload = verifyModAuthSessionToken(bearerToken);
    if (sessionPayload) {
      return resolveModAccessFromSession(sessionPayload, 'bearer', tenantContext);
    }

    if (modControlToken && bearerToken === modControlToken) {
      if (modAuthAllowLegacyToken) {
        return {
          ok: true,
          context: {
            authMode: 'legacy-token',
            source: 'bearer',
            role: 'legacy',
            userId: null,
            userLogin: null,
            userName: null,
            legacyTokenUsed: true,
          },
        };
      }

      return {
        ok: false,
        status: 401,
        error: 'legacy_mod_token_disabled',
        authenticated: false,
      };
    }

    return {
      ok: false,
      status: 401,
      error: 'invalid_mod_auth',
      authenticated: false,
    };
  }

  const cookies = parseCookieHeader(req.header('cookie'));
  const cookieToken = String(cookies.get('mod_auth') ?? '').trim();
  if (cookieToken) {
    const sessionPayload = verifyModAuthSessionToken(cookieToken);
    if (sessionPayload) {
      return resolveModAccessFromSession(sessionPayload, 'cookie', tenantContext);
    }

    return {
      ok: false,
      status: 401,
      error: 'invalid_mod_session',
      authenticated: false,
    };
  }

  if (
    !isModAuthConfigured(tenantContext.slug, { allowMissingBroadcaster: tenantBroadcasterAutoRegister })
    && !(modControlToken && modAuthAllowLegacyToken)
  ) {
    return {
      ok: false,
      status: 503,
      error: 'mod_auth_not_configured',
      authenticated: false,
      missingConfig: getModAuthConfigErrors(tenantContext.slug, {
        allowMissingBroadcaster: tenantBroadcasterAutoRegister,
      }),
    };
  }

  return {
    ok: false,
    status: 401,
    error: 'mod_auth_required',
    authenticated: false,
  };
}

function ensureModAccess(req: Request, res: Response): boolean {
  const result = resolveModAccess(req);
  if (result.ok) {
    return true;
  }

  if (result.status === 503) {
    res.status(503).json({
      error: result.error,
      missing: result.missingConfig ?? [],
      allowLegacyToken: modAuthAllowLegacyToken,
    });
    return false;
  }

  if (result.status === 403) {
    res.status(403).json({
      error: result.error,
      authenticated: true,
      role: result.role,
      user: {
        userId: result.userId,
        userLogin: result.userLogin,
        userName: result.userName,
      },
    });
    return false;
  }

  res.status(401).json({
    error: result.error,
    authenticated: false,
  });
  return false;
}

function auditLegacyFallbackUsage(
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): void {
  if (tenantState.legacyModFallbackLogged) {
    return;
  }

  tenantState.legacyModFallbackLogged = true;
  commitControllerState(
    'mod_auth_legacy_fallback',
    'Legacy MOD_CONTROL_TOKEN fallback was used for moderator access.',
    undefined,
    tenantSlug,
    tenantState,
  );
}

function toSessionSummary(
  session: SessionState,
  tenantState: TenantRuntimeState = getDefaultTenantRuntimeState(),
) {
  const graceSecondsRemaining = getWinnerGraceSecondsRemaining(session);
  const theme = resolveThemeState(tenantState.themeState);

  return {
    id: session.id,
    mode: session.mode,
    status: session.status,
    createdAt: session.createdAt,
    maxWinners: session.maxWinners,
    winnerGraceSeconds: session.winnerGraceSeconds,
    winnerGraceEndsAt: session.winnerGraceEndsAt,
    winnerGraceSecondsRemaining: graceSecondsRemaining,
    players: session.players.size,
    winners: [...session.winners],
    calledOptions: [...session.calledOptions],
    theme,
  };
}

function toPlayerView(player: PlayerState) {
  return {
    userId: player.userId,
    userName: player.userName,
    hasWon: player.hasWon,
    invalidStampCount: player.invalidStampCount,
    stamps: [...player.stamps].sort((a, b) => a - b),
    card: player.card,
  };
}

function normalizeOption(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

type RequestWithTenantContext = Request & {
  tenantContext?: TenantContext;
};

function normalizeTenantSlugInput(input: string | undefined): string {
  return String(input ?? '')
    .trim()
    .toLowerCase();
}

function sanitizeTenantSlugCandidate(input: string | undefined): string | null {
  const normalized = normalizeTenantSlugInput(input);
  if (!normalized) {
    return null;
  }

  const compact = normalized
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!compact) {
    return null;
  }

  const truncated = compact.slice(0, 63).replace(/-+$/g, '');
  if (!truncated || !tenantSlugPattern.test(truncated)) {
    return null;
  }

  return truncated;
}

function parseTenantSlugFromRoute(input: string | undefined): string | null {
  const normalized = normalizeTenantSlugInput(input);
  if (!normalized || !tenantSlugPattern.test(normalized)) {
    return null;
  }

  return normalized;
}

function resolveDefaultTenantSlug(rawDefaultTenantSlug: string | undefined, broadcasterId: string): string {
  return sanitizeTenantSlugCandidate(rawDefaultTenantSlug) ?? sanitizeTenantSlugCandidate(broadcasterId) ?? 'default';
}

function parseTenantBroadcasterOverrides(rawInput: string | undefined): ReadonlyMap<string, string> {
  const rawValue = String(rawInput ?? '').trim();
  if (!rawValue) {
    return new Map<string, string>();
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(
        '[mod-auth] TENANT_BROADCASTER_OVERRIDES must be a JSON object of tenant slug to broadcaster id.',
      );
      return new Map<string, string>();
    }

    const entries = new Map<string, string>();
    for (const [rawTenantSlug, rawBroadcasterId] of Object.entries(parsed)) {
      const tenantSlug = parseTenantSlugFromRoute(rawTenantSlug);
      const broadcasterId = String(rawBroadcasterId ?? '').trim();
      if (!tenantSlug || !broadcasterId) {
        console.warn(
          `[mod-auth] Ignoring TENANT_BROADCASTER_OVERRIDES entry "${rawTenantSlug}" because it is invalid.`,
        );
        continue;
      }

      entries.set(tenantSlug, broadcasterId);
    }

    return entries;
  } catch (error) {
    console.warn('[mod-auth] Failed to parse TENANT_BROADCASTER_OVERRIDES as JSON.', error);
    return new Map<string, string>();
  }
}

function writeTextFileAtomic(filePath: string, content: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  const tempFilePath = path.join(
    directory,
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
  );

  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = fs.openSync(tempFilePath, 'w');
    fs.writeFileSync(fileDescriptor, content, { encoding: 'utf8' });
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = null;

    fs.renameSync(tempFilePath, filePath);
  } catch (error) {
    if (fileDescriptor !== null) {
      try {
        fs.closeSync(fileDescriptor);
      } catch {
        // Best-effort cleanup for file descriptor.
      }
    }

    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    } catch {
      // Best-effort cleanup for temp file.
    }

    throw error;
  }
}

function writeBufferFileAtomic(filePath: string, content: Buffer): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });

  const tempFilePath = path.join(
    directory,
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
  );

  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = fs.openSync(tempFilePath, 'w');
    fs.writeFileSync(fileDescriptor, content);
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = null;

    fs.renameSync(tempFilePath, filePath);
  } catch (error) {
    if (fileDescriptor !== null) {
      try {
        fs.closeSync(fileDescriptor);
      } catch {
        // Best-effort cleanup for file descriptor.
      }
    }

    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    } catch {
      // Best-effort cleanup for temp file.
    }

    throw error;
  }
}

function resolveTenantMutationErrorStatus(error: unknown): 400 | 500 {
  return error instanceof TenantPersistenceError ? 500 : 400;
}

function resolveTenantMutationErrorCode(error: unknown, fallbackCode: string): string {
  if (error instanceof TenantPersistenceError) {
    return error.errorCode;
  }

  return error instanceof Error ? error.message : fallbackCode;
}

function loadTenantBroadcasterRegistry(): Map<string, string> {
  if (!fs.existsSync(tenantBroadcasterMapFilePath)) {
    return new Map<string, string>();
  }

  try {
    const rawText = fs.readFileSync(tenantBroadcasterMapFilePath, 'utf8').trim();
    if (!rawText) {
      return new Map<string, string>();
    }

    const parsed = JSON.parse(rawText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[mod-auth] tenant broadcaster registry file must be a JSON object.');
      return new Map<string, string>();
    }

    const loaded = new Map<string, string>();
    for (const [rawTenantSlug, rawBroadcasterId] of Object.entries(parsed)) {
      const tenantSlug = parseTenantSlugFromRoute(rawTenantSlug);
      const broadcasterId = String(rawBroadcasterId ?? '').trim();
      if (!tenantSlug || !broadcasterId) {
        console.warn(
          `[mod-auth] Ignoring persisted tenant broadcaster entry "${rawTenantSlug}" because it is invalid.`,
        );
        continue;
      }

      loaded.set(tenantSlug, broadcasterId);
    }

    return loaded;
  } catch (error) {
    console.warn('[mod-auth] Failed to load tenant broadcaster registry file.', error);
    return new Map<string, string>();
  }
}

function snapshotTenantBroadcasterRegistry(): Record<string, string> {
  return Object.fromEntries(
    [...tenantBroadcasterRegistry.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function persistTenantBroadcasterRegistry(): void {
  try {
    const serialized = JSON.stringify(snapshotTenantBroadcasterRegistry(), null, 2);
    writeTextFileAtomic(tenantBroadcasterMapFilePath, `${serialized}\n`);
  } catch (error) {
    console.error('[mod-auth] Failed to persist tenant broadcaster registry.', error);
    throw new TenantPersistenceError('tenant_broadcaster_persist_failed');
  }
}

function loadTenantRedeemKeyRegistry(): Map<string, TenantRedeemKeyRecord> {
  if (!fs.existsSync(tenantRedeemKeyMapFilePath)) {
    return new Map<string, TenantRedeemKeyRecord>();
  }

  try {
    const rawText = fs.readFileSync(tenantRedeemKeyMapFilePath, 'utf8').trim();
    if (!rawText) {
      return new Map<string, TenantRedeemKeyRecord>();
    }

    const parsed = JSON.parse(rawText) as unknown;
    const validated = tenantRedeemKeyRegistrySchema.safeParse(parsed);
    if (!validated.success) {
      console.warn('[redeem-auth] tenant redeem key registry file failed validation; ignoring file.');
      return new Map<string, TenantRedeemKeyRecord>();
    }

    const loaded = new Map<string, TenantRedeemKeyRecord>();
    for (const [rawTenantSlug, record] of Object.entries(validated.data)) {
      const tenantSlug = parseTenantSlugFromRoute(rawTenantSlug);
      if (!tenantSlug) {
        console.warn(
          `[redeem-auth] Ignoring tenant redeem key entry "${rawTenantSlug}" because tenant slug is invalid.`,
        );
        continue;
      }

      loaded.set(tenantSlug, {
        salt: record.salt,
        hash: record.hash,
        iterations: record.iterations,
        keyLength: record.keyLength,
        digest: record.digest,
        createdAt: record.createdAt,
        rotatedAt: record.rotatedAt,
      });
    }

    return loaded;
  } catch (error) {
    console.warn('[redeem-auth] Failed to load tenant redeem key registry file.', error);
    return new Map<string, TenantRedeemKeyRecord>();
  }
}

function snapshotTenantRedeemKeyRegistry(): Record<string, TenantRedeemKeyRecord> {
  return Object.fromEntries(
    [...tenantRedeemKeyRegistry.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([tenantSlug, record]) => [
        tenantSlug,
        {
          salt: record.salt,
          hash: record.hash,
          iterations: record.iterations,
          keyLength: record.keyLength,
          digest: record.digest,
          createdAt: record.createdAt,
          rotatedAt: record.rotatedAt,
        },
      ]),
  );
}

function persistTenantRedeemKeyRegistry(): void {
  try {
    const serialized = JSON.stringify(snapshotTenantRedeemKeyRegistry(), null, 2);
    writeTextFileAtomic(tenantRedeemKeyMapFilePath, `${serialized}\n`);
  } catch (error) {
    console.error('[redeem-auth] Failed to persist tenant redeem key registry.', error);
    throw new TenantPersistenceError('tenant_redeem_key_persist_failed');
  }
}

function loadStreamerSetupEntryRegistry(): Map<string, StreamerSetupEntry> {
  if (!fs.existsSync(streamerSetupEntriesFilePath)) {
    return new Map<string, StreamerSetupEntry>();
  }

  try {
    const rawText = fs.readFileSync(streamerSetupEntriesFilePath, 'utf8').trim();
    if (!rawText) {
      return new Map<string, StreamerSetupEntry>();
    }

    const parsed = JSON.parse(rawText) as unknown;
    const validated = persistedStreamerSetupEntriesSchema.safeParse(parsed);
    if (!validated.success) {
      console.warn('[owner-setup] streamer setup entries file failed validation; ignoring file.');
      return new Map<string, StreamerSetupEntry>();
    }

    const loaded = new Map<string, StreamerSetupEntry>();
    for (const entry of validated.data.entries) {
      const tenantSlug = parseTenantSlugFromRoute(entry.tenantSlug);
      if (!tenantSlug) {
        console.warn(`[owner-setup] Ignoring streamer setup entry "${entry.tenantSlug}" because tenant slug is invalid.`);
        continue;
      }

      loaded.set(tenantSlug, {
        tenantSlug,
        broadcasterUserName: entry.broadcasterUserName ?? null,
        broadcasterUserLogin: entry.broadcasterUserLogin ?? null,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }

    return loaded;
  } catch (error) {
    console.warn('[owner-setup] Failed to load streamer setup entries file.', error);
    return new Map<string, StreamerSetupEntry>();
  }
}

function snapshotStreamerSetupEntryRegistry(): StreamerSetupEntry[] {
  return [...streamerSetupEntryRegistry.values()]
    .sort((left, right) => left.tenantSlug.localeCompare(right.tenantSlug))
    .map((entry) => ({
      tenantSlug: entry.tenantSlug,
      broadcasterUserName: entry.broadcasterUserName,
      broadcasterUserLogin: entry.broadcasterUserLogin,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }));
}

function persistStreamerSetupEntryRegistry(): void {
  const payload: PersistedStreamerSetupEntries = {
    version: 1,
    savedAt: new Date().toISOString(),
    entries: snapshotStreamerSetupEntryRegistry(),
  };

  try {
    const serialized = JSON.stringify(payload, null, 2);
    writeTextFileAtomic(streamerSetupEntriesFilePath, `${serialized}\n`);
  } catch (error) {
    console.error('[owner-setup] Failed to persist streamer setup entry registry.', error);
    throw new TenantPersistenceError('streamer_setup_entries_persist_failed');
  }
}

function upsertStreamerSetupEntry(input: {
  tenantSlug: string;
  broadcasterUserName?: string | null;
  broadcasterUserLogin?: string | null;
}): {
  entry: StreamerSetupEntry;
  created: boolean;
  updated: boolean;
  unchanged: boolean;
  totalEntries: number;
} {
  const tenantSlug = parseTenantSlugFromRoute(input.tenantSlug);
  if (!tenantSlug) {
    throw new Error('invalid_tenant_slug');
  }

  const existing = streamerSetupEntryRegistry.get(tenantSlug);
  const normalizedBroadcasterUserName = input.broadcasterUserName ?? null;
  const normalizedBroadcasterUserLogin = input.broadcasterUserLogin ?? null;
  if (
    existing
    && existing.broadcasterUserName === normalizedBroadcasterUserName
    && existing.broadcasterUserLogin === normalizedBroadcasterUserLogin
  ) {
    return {
      entry: existing,
      created: false,
      updated: false,
      unchanged: true,
      totalEntries: streamerSetupEntryRegistry.size,
    };
  }

  const nowIso = new Date().toISOString();
  const next: StreamerSetupEntry = {
    tenantSlug,
    broadcasterUserName: normalizedBroadcasterUserName,
    broadcasterUserLogin: normalizedBroadcasterUserLogin,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };

  if (existing) {
    streamerSetupEntryRegistry.set(tenantSlug, next);
  } else {
    streamerSetupEntryRegistry.set(tenantSlug, next);
  }

  try {
    persistStreamerSetupEntryRegistry();
  } catch (error) {
    if (existing) {
      streamerSetupEntryRegistry.set(tenantSlug, existing);
    } else {
      streamerSetupEntryRegistry.delete(tenantSlug);
    }

    throw error;
  }

  return {
    entry: next,
    created: !existing,
    updated: Boolean(existing),
    unchanged: false,
    totalEntries: streamerSetupEntryRegistry.size,
  };
}

function resolveSetupSurfaceBaseUrl(rawValue: string, fallback: string): string {
  const trimmed = trimTrailingSlashes(String(rawValue ?? '').trim());
  if (!trimmed) {
    return fallback;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return fallback;
    }

    return trimTrailingSlashes(parsed.toString());
  } catch {
    return fallback;
  }
}

function resolveApiBaseUrlForOwnerSetup(req: Request): string {
  const configured = trimTrailingSlashes(publicApiBaseUrl);
  if (configured) {
    return configured;
  }

  const forwardedProtocol = String(req.header('x-forwarded-proto') ?? '')
    .split(',')[0]
    .trim();
  const protocol = forwardedProtocol || req.protocol || 'http';
  const forwardedHost = String(req.header('x-forwarded-host') ?? '')
    .split(',')[0]
    .trim();
  const host = forwardedHost || String(req.header('host') ?? '').trim() || `localhost:${port}`;
  return trimTrailingSlashes(`${protocol}://${host}`);
}

function resolveSetupBases(req: Request): {
  apiBase: string;
  overlayBase: string;
  controlBase: string;
  ownerBase: string;
} {
  const apiBase = resolveApiBaseUrlForOwnerSetup(req);
  return {
    apiBase,
    overlayBase: resolveSetupSurfaceBaseUrl(publicOverlayBaseUrl, 'https://public-overlay.custom-overlays.com'),
    controlBase: resolveSetupSurfaceBaseUrl(publicControlBaseUrl, 'https://public-controller.custom-overlays.com'),
    ownerBase: resolveSetupSurfaceBaseUrl(ownerPanelBaseUrl, 'https://bingo-owner.custom-overlays.com'),
  };
}

function toSetupRedeemKeyPlaceholder(tenantSlug: string): string {
  return `REPLACE_WITH_TENANT_REDEEM_KEY_${tenantSlug.toUpperCase().replace(/-/g, '_')}`;
}

function toSetupBroadcasterLabel(userName: string | null | undefined, userLogin: string | null | undefined): string {
  const safeName = String(userName ?? '').trim();
  const safeLogin = String(userLogin ?? '').trim();
  if (safeName && safeLogin) {
    return `${safeName} (${safeLogin})`;
  }

  if (safeName) {
    return safeName;
  }

  if (safeLogin) {
    return safeLogin;
  }

  return 'not mapped';
}

function buildMixItUpSetupBlock(tenantSlug: string, broadcasterLabel: string, req: Request): MixItUpSetupBlock {
  const bases = resolveSetupBases(req);
  const overlayUrl = `${bases.overlayBase}/?tenant=${tenantSlug}&api=${bases.apiBase}`;
  const controllerUrl = `${bases.controlBase}/?tenant=${tenantSlug}&api=${bases.apiBase}`;
  const joinUrl = `${bases.apiBase}/api/t/${tenantSlug}/internal/redeem/join`;
  const authorizationHeaderValue = `Bearer ${toSetupRedeemKeyPlaceholder(tenantSlug)}`;
  const requestBody = {
    redemptionId: '$usertwitchid-$dateyear$datemonth$dateday-$timedigits-$randomnumber999999999',
    twitchUserId: '$usertwitchid',
    twitchUserName: '$userdisplayname',
  };

  const setupBlock = [
    '--------------------------------------------------',
    `BLOCK: ${tenantSlug}`,
    '--------------------------------------------------',
    '',
    'Broadcaster',
    broadcasterLabel,
    '',
    'Overlay URL',
    overlayUrl,
    '',
    'Bingo Controller URL',
    controllerUrl,
    '',
    'Reward Name',
    'Bingo Card',
    '',
    'Web Request',
    'Method',
    'POST',
    '',
    'Web Request URL',
    joinUrl,
    '',
    'Header Name',
    'Authorization',
    '',
    'Header Value',
    authorizationHeaderValue,
    'Contact Bingo Owner For Secret Key',
    'Paste only the private tenant redeem key after Bearer. Do not share this key publicly.',
    '',
    'Header Name',
    'Content-Type',
    '',
    'Header Value',
    'application/json',
    '',
    'Request Body (JSON)',
    JSON.stringify(requestBody, null, 2),
    '',
    'Response Processing Type',
    'JSON to Special Identifiers',
    '',
    'JSON Value Name (Use \\ for nested parameters)',
    'viewerUrl',
    '',
    'Special Identifier Name',
    'bingoviewurl',
    '',
    'JSON Value Name (Use \\ for nested parameters)',
    'error',
    '',
    'Special Identifier Name',
    'bingoerror',
    '',
    'JSON Value Name (Use \\ for nested parameters)',
    'message',
    '',
    'Special Identifier Name',
    'bingomessage',
    '',
    'Chat Message',
    'Send as Streamer',
    'On',
    '',
    'Whisper',
    'On',
    '',
    'Whisper User (Optional)',
    'Leave blank',
    '',
    'Chat Message',
    '@$userdisplayname Your Bingo card: $bingoviewurl',
  ].join('\n');

  return {
    tenantSlug,
    broadcasterLabel,
    overlayUrl,
    controllerUrl,
    joinUrl,
    authorizationHeaderValue,
    requestBody,
    setupBlock,
  };
}

function renderStreamerSetupMarkdown(blocks: MixItUpSetupBlock[], generatedAtIso: string): string {
  const content: string[] = [
    '# MixItUp Streamer Setup Reference',
    '',
    `Generated: ${generatedAtIso}`,
    '',
    'Use this sheet as your copy-and-paste source for Channel Points -> Bingo Card web request commands.',
    'Contact Bingo Owner For Secret Key. Paste only the private tenant redeem key after Bearer in the Authorization header value.',
    '',
  ];

  for (const block of blocks) {
    content.push(block.setupBlock, '');
  }

  content.push(
    '--------------------------------------------------',
    'Quick Troubleshooting',
    '--------------------------------------------------',
    '',
    '- Error join_not_available: No active round is open/running for that tenant.',
    '- Error invalid_tenant_redeem_auth: Tenant redeem key is missing, wrong, or belongs to a different tenant.',
    '- Error redeem_id_conflict: The redemption id was reused with a different twitchUserId.',
    '- Viewer link opens but card is unavailable: verify tenant slug mapping and active round state.',
    '',
    'Need a fresh key / secret?',
    '- Ask Bingo Owner to generate a new key',
    '',
  );

  return `${content.join('\n')}\n`;
}

function normalizeStreamerSetupMarkdownForDiff(markdown: string): string {
  return markdown.replace(/^Generated:\s+.*$/m, 'Generated: __UNCHANGED__');
}

function extractGeneratedAtFromStreamerSetupMarkdown(markdown: string): string | null {
  const match = markdown.match(/^Generated:\s+(.+)$/m);
  const value = String(match?.[1] ?? '').trim();
  return value || null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderStreamerSetupHtml(markdown: string, generatedAtIso: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MixItUp Streamer Setup Reference</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      padding: 24px;
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      color: #10243a;
      background: linear-gradient(165deg, #f7fbff 0%, #e6effa 100%);
    }
    .sheet {
      max-width: 980px;
      margin: 0 auto;
      background: #ffffff;
      border: 1px solid #c8d7eb;
      border-radius: 12px;
      box-shadow: 0 16px 30px -24px rgba(16, 36, 58, 0.4);
      padding: 18px;
    }
    h1 {
      margin: 0 0 4px;
      font-size: 1.6rem;
    }
    .meta {
      margin: 0 0 14px;
      color: #35506f;
      font-size: 0.92rem;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: Consolas, "Courier New", monospace;
      font-size: 12px;
      line-height: 1.45;
      color: #0f2238;
      background: #f7fbff;
      border: 1px solid #d8e5f6;
      border-radius: 10px;
      padding: 12px;
    }
    @media print {
      body {
        background: #ffffff;
        padding: 0;
      }
      .sheet {
        border: 0;
        box-shadow: none;
      }
    }
  </style>
</head>
<body>
  <main class="sheet">
    <h1>MixItUp Streamer Setup Reference</h1>
    <p class="meta">Generated: ${escapeHtml(generatedAtIso)}</p>
    <pre>${escapeHtml(markdown)}</pre>
  </main>
</body>
</html>
`;
}

function wrapLineForPdf(line: string, maxChars: number): string[] {
  if (!line) {
    return [''];
  }

  if (line.length <= maxChars) {
    return [line];
  }

  const wrapped: string[] = [];
  let remaining = line;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf(' ', maxChars);
    if (splitAt <= 0) {
      splitAt = maxChars;
    }

    wrapped.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  wrapped.push(remaining);
  return wrapped;
}

function escapePdfString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function createSimplePdfBuffer(title: string, lines: string[]): Buffer {
  const maxCharsPerLine = 96;
  const linesPerPage = 48;
  const normalizedLines: string[] = [title, '', ...lines];
  const wrappedLines: string[] = [];

  for (const rawLine of normalizedLines) {
    const line = rawLine.replace(/\r/g, '');
    wrappedLines.push(...wrapLineForPdf(line, maxCharsPerLine));
  }

  const pageLineGroups: string[][] = [];
  for (let index = 0; index < wrappedLines.length; index += linesPerPage) {
    pageLineGroups.push(wrappedLines.slice(index, index + linesPerPage));
  }

  if (pageLineGroups.length === 0) {
    pageLineGroups.push(['']);
  }

  const objects = new Map<number, string>();
  const pageObjectIds: number[] = [];
  const fontObjectId = 3;
  let nextObjectId = 4;

  for (const pageLines of pageLineGroups) {
    const pageObjectId = nextObjectId;
    const contentObjectId = nextObjectId + 1;
    nextObjectId += 2;

    pageObjectIds.push(pageObjectId);

    const textOps: string[] = ['BT', '/F1 10 Tf', '48 760 Td'];
    for (let lineIndex = 0; lineIndex < pageLines.length; lineIndex += 1) {
      if (lineIndex > 0) {
        textOps.push('0 -14 Td');
      }

      textOps.push(`(${escapePdfString(pageLines[lineIndex])}) Tj`);
    }
    textOps.push('ET');

    const streamContent = `${textOps.join('\n')}\n`;
    objects.set(
      contentObjectId,
      `<< /Length ${Buffer.byteLength(streamContent, 'utf8')} >>\nstream\n${streamContent}endstream`,
    );
    objects.set(
      pageObjectId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`,
    );
  }

  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objects.set(2, `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>`);
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const maxObjectId = nextObjectId - 1;
  let output = '%PDF-1.4\n';
  const offsets: number[] = [0];

  for (let objectId = 1; objectId <= maxObjectId; objectId += 1) {
    offsets[objectId] = Buffer.byteLength(output, 'utf8');
    const objectBody = objects.get(objectId);
    if (!objectBody) {
      throw new Error(`pdf_object_missing_${objectId}`);
    }

    output += `${objectId} 0 obj\n${objectBody}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(output, 'utf8');
  output += `xref\n0 ${maxObjectId + 1}\n`;
  output += '0000000000 65535 f \n';
  for (let objectId = 1; objectId <= maxObjectId; objectId += 1) {
    output += `${String(offsets[objectId]).padStart(10, '0')} 00000 n \n`;
  }

  output += `trailer\n<< /Size ${maxObjectId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, 'utf8');
}

function readOptionalFileMetadata(filePath: string): { exists: boolean; size: number; updatedAt: string | null } {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return {
        exists: false,
        size: 0,
        updatedAt: null,
      };
    }

    return {
      exists: true,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return {
      exists: false,
      size: 0,
      updatedAt: null,
    };
  }
}

async function resolveOwnerTenantRecords(): Promise<OwnerTenantRecord[]> {
  const tenantSlugs = new Set<string>([
    defaultTenantSlug,
    ...tenantBroadcasterRegistry.keys(),
    ...tenantBroadcasterOverrides.keys(),
    ...tenantRedeemKeyRegistry.keys(),
  ]);

  const tenants = [...tenantSlugs]
    .filter((tenantSlug) => Boolean(parseTenantSlugFromRoute(tenantSlug)))
    .sort((left, right) => left.localeCompare(right))
    .map((tenantSlug) => {
      const persistedBroadcasterId = tenantBroadcasterRegistry.get(tenantSlug) ?? null;
      const envBroadcasterId = tenantBroadcasterOverrides.get(tenantSlug) ?? null;
      const fallbackBroadcasterId = twitchBroadcasterId || null;
      const effectiveBroadcasterId = resolveExpectedBroadcasterIdForTenant(tenantSlug);
      const redeemKey = tenantRedeemKeyRegistry.get(tenantSlug) ?? null;

      let source: 'persisted' | 'env' | 'fallback' | 'none' = 'none';
      if (persistedBroadcasterId) {
        source = 'persisted';
      } else if (envBroadcasterId) {
        source = 'env';
      } else if (fallbackBroadcasterId) {
        source = 'fallback';
      }

      return {
        tenantSlug,
        source,
        persistedBroadcasterId,
        envBroadcasterId,
        fallbackBroadcasterId,
        effectiveBroadcasterId,
        redeemKeyConfigured: Boolean(redeemKey),
        redeemKeyCreatedAt: redeemKey?.createdAt ?? null,
        redeemKeyRotatedAt: redeemKey?.rotatedAt ?? null,
      };
    });

  const effectiveBroadcasterIds = [...new Set(
    tenants
      .map((tenant) => String(tenant.effectiveBroadcasterId ?? '').trim())
      .filter((id) => id.length > 0),
  )];

  let usersByBroadcasterId = new Map<string, ResolvedTwitchUser>();
  if (effectiveBroadcasterIds.length > 0) {
    try {
      usersByBroadcasterId = await resolveTwitchUsersById(effectiveBroadcasterIds);
    } catch {
      usersByBroadcasterId = new Map<string, ResolvedTwitchUser>();
    }
  }

  return tenants.map((tenant) => {
    const effectiveBroadcasterId = String(tenant.effectiveBroadcasterId ?? '').trim();
    const broadcasterIdentity = effectiveBroadcasterId
      ? usersByBroadcasterId.get(effectiveBroadcasterId) ?? null
      : null;

    return {
      ...tenant,
      broadcasterUserId: broadcasterIdentity?.userId ?? (effectiveBroadcasterId || null),
      broadcasterUserLogin: broadcasterIdentity?.userLogin ?? null,
      broadcasterUserName: broadcasterIdentity?.userName ?? null,
    };
  });
}

async function buildSetupBlocksFromEntries(
  req: Request,
  includeAllKnownTenants: boolean,
): Promise<{ entries: StreamerSetupEntry[]; blocks: MixItUpSetupBlock[] }> {
  const entriesBySlug = new Map<string, StreamerSetupEntry>();
  for (const entry of streamerSetupEntryRegistry.values()) {
    entriesBySlug.set(entry.tenantSlug, {
      tenantSlug: entry.tenantSlug,
      broadcasterUserName: entry.broadcasterUserName,
      broadcasterUserLogin: entry.broadcasterUserLogin,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    });
  }

  if (includeAllKnownTenants) {
    const tenants = await resolveOwnerTenantRecords();
    const nowIso = new Date().toISOString();
    for (const tenant of tenants) {
      const existing = entriesBySlug.get(tenant.tenantSlug);
      entriesBySlug.set(tenant.tenantSlug, {
        tenantSlug: tenant.tenantSlug,
        broadcasterUserName: tenant.broadcasterUserName,
        broadcasterUserLogin: tenant.broadcasterUserLogin,
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: existing?.updatedAt ?? nowIso,
      });
    }
  }

  const entries = [...entriesBySlug.values()].sort((left, right) => left.tenantSlug.localeCompare(right.tenantSlug));
  const blocks = entries.map((entry) => buildMixItUpSetupBlock(
    entry.tenantSlug,
    toSetupBroadcasterLabel(entry.broadcasterUserName, entry.broadcasterUserLogin),
    req,
  ));

  return {
    entries,
    blocks,
  };
}

function regenerateStreamerSetupArtifacts(markdown: string, html: string, pdf: Buffer): {
  changed: boolean;
  markdownWritten: boolean;
  htmlWritten: boolean;
  pdfWritten: boolean;
} {
  try {
    const existingMarkdown = fs.existsSync(streamerSetupMarkdownFilePath)
      ? fs.readFileSync(streamerSetupMarkdownFilePath, 'utf8')
      : null;
    const existingHtml = fs.existsSync(streamerSetupHtmlFilePath)
      ? fs.readFileSync(streamerSetupHtmlFilePath, 'utf8')
      : null;
    const existingPdf = fs.existsSync(streamerSetupPdfFilePath)
      ? fs.readFileSync(streamerSetupPdfFilePath)
      : null;

    const markdownWritten = existingMarkdown !== markdown;
    const htmlWritten = existingHtml !== html;
    const pdfWritten = !existingPdf || !existingPdf.equals(pdf);

    if (markdownWritten) {
      writeTextFileAtomic(streamerSetupMarkdownFilePath, markdown);
    }

    if (htmlWritten) {
      writeTextFileAtomic(streamerSetupHtmlFilePath, html);
    }

    if (pdfWritten) {
      writeBufferFileAtomic(streamerSetupPdfFilePath, pdf);
    }

    return {
      changed: markdownWritten || htmlWritten || pdfWritten,
      markdownWritten,
      htmlWritten,
      pdfWritten,
    };
  } catch (error) {
    console.error('[owner-setup] Failed to persist setup export artifacts.', error);
    throw new TenantPersistenceError('streamer_setup_artifact_persist_failed');
  }
}

function removeTenantArtifactsForSlug(tenantSlugInput: string, options: { removeRedeemKey: boolean }): {
  tenantSlug: string;
  source: 'persisted' | 'env' | 'fallback' | 'none';
  removedBroadcasterMapping: boolean;
  removedRedeemKey: boolean;
  removedSetupEntry: boolean;
} {
  const tenantSlug = parseTenantSlugFromRoute(tenantSlugInput);
  if (!tenantSlug) {
    throw new Error('invalid_tenant_slug');
  }

  const source = tenantBroadcasterRegistry.has(tenantSlug)
    ? 'persisted'
    : tenantBroadcasterOverrides.has(tenantSlug)
      ? 'env'
      : twitchBroadcasterId
        ? 'fallback'
        : 'none';

  if (source === 'env') {
    throw new Error('tenant_source_env_managed');
  }

  const previousBroadcasterId = tenantBroadcasterRegistry.get(tenantSlug) ?? null;
  const previousRedeem = tenantRedeemKeyRegistry.get(tenantSlug)
    ? {
        ...tenantRedeemKeyRegistry.get(tenantSlug)!,
      }
    : null;
  const previousSetup = streamerSetupEntryRegistry.get(tenantSlug)
    ? {
        ...streamerSetupEntryRegistry.get(tenantSlug)!,
      }
    : null;

  let removedBroadcasterMapping = false;
  let removedRedeemKey = false;
  let removedSetupEntry = false;

  if (previousBroadcasterId !== null) {
    tenantBroadcasterRegistry.delete(tenantSlug);
    removedBroadcasterMapping = true;
  }

  if (options.removeRedeemKey && previousRedeem) {
    tenantRedeemKeyRegistry.delete(tenantSlug);
    removedRedeemKey = true;
  }

  if (previousSetup) {
    streamerSetupEntryRegistry.delete(tenantSlug);
    removedSetupEntry = true;
  }

  try {
    if (removedBroadcasterMapping) {
      persistTenantBroadcasterRegistry();
    }

    if (removedRedeemKey) {
      persistTenantRedeemKeyRegistry();
    }

    if (removedSetupEntry) {
      persistStreamerSetupEntryRegistry();
    }
  } catch (error) {
    if (removedBroadcasterMapping && previousBroadcasterId !== null) {
      tenantBroadcasterRegistry.set(tenantSlug, previousBroadcasterId);
    }

    if (removedRedeemKey && previousRedeem) {
      tenantRedeemKeyRegistry.set(tenantSlug, previousRedeem);
    }

    if (removedSetupEntry && previousSetup) {
      streamerSetupEntryRegistry.set(tenantSlug, previousSetup);
    }

    throw error;
  }

  return {
    tenantSlug,
    source,
    removedBroadcasterMapping,
    removedRedeemKey,
    removedSetupEntry,
  };
}

function hashTenantRedeemKeyValue(input: string, salt: string, iterations: number, keyLength: number): string {
  return crypto.pbkdf2Sync(input, salt, iterations, keyLength, 'sha256').toString('hex');
}

function generateTenantRedeemKeyValue(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function rotateTenantRedeemKey(tenantSlugInput: string): {
  tenantSlug: string;
  redeemKey: string;
  rotatedAt: string;
  created: boolean;
} {
  const tenantSlug = parseTenantSlugFromRoute(tenantSlugInput);
  if (!tenantSlug) {
    throw new Error('invalid_tenant_slug');
  }

  const nowIso = new Date().toISOString();
  const existing = tenantRedeemKeyRegistry.get(tenantSlug);
  const redeemKey = generateTenantRedeemKeyValue();
  const salt = crypto.randomBytes(16).toString('hex');
  const keyLength = 32;
  const iterations = tenantRedeemKeyHashIterations;
  const hash = hashTenantRedeemKeyValue(redeemKey, salt, iterations, keyLength);
  const previousRecord = existing
    ? {
      salt: existing.salt,
      hash: existing.hash,
      iterations: existing.iterations,
      keyLength: existing.keyLength,
      digest: existing.digest,
      createdAt: existing.createdAt,
      rotatedAt: existing.rotatedAt,
    }
    : null;

  tenantRedeemKeyRegistry.set(tenantSlug, {
    salt,
    hash,
    iterations,
    keyLength,
    digest: 'sha256',
    createdAt: existing?.createdAt ?? nowIso,
    rotatedAt: nowIso,
  });

  try {
    persistTenantRedeemKeyRegistry();
  } catch (error) {
    if (previousRecord) {
      tenantRedeemKeyRegistry.set(tenantSlug, previousRecord);
    } else {
      tenantRedeemKeyRegistry.delete(tenantSlug);
    }

    throw error;
  }

  return {
    tenantSlug,
    redeemKey,
    rotatedAt: nowIso,
    created: !existing,
  };
}

function verifyTenantRedeemKeyForTenant(redeemKeyInput: string, tenantSlugInput: string): boolean {
  const tenantSlug = parseTenantSlugFromRoute(tenantSlugInput);
  if (!tenantSlug) {
    return false;
  }

  const redeemKey = String(redeemKeyInput ?? '').trim();
  if (!redeemKey) {
    return false;
  }

  const record = tenantRedeemKeyRegistry.get(tenantSlug);
  if (!record) {
    return false;
  }

  const expectedHash = hashTenantRedeemKeyValue(redeemKey, record.salt, record.iterations, record.keyLength);
  return timingSafeEqual(expectedHash, record.hash);
}

function setTenantBroadcasterRegistration(tenantSlugInput: string, broadcasterIdInput: string): {
  tenantSlug: string;
  broadcasterId: string;
  previousBroadcasterId: string | null;
  updated: boolean;
} {
  const tenantSlug = parseTenantSlugFromRoute(tenantSlugInput);
  if (!tenantSlug) {
    throw new Error('invalid_tenant_slug');
  }

  const broadcasterId = String(broadcasterIdInput).trim();
  if (!broadcasterId) {
    throw new Error('invalid_broadcaster_id');
  }

  const previousBroadcasterId = tenantBroadcasterRegistry.get(tenantSlug) ?? null;
  const updated = previousBroadcasterId !== broadcasterId;
  if (updated) {
    tenantBroadcasterRegistry.set(tenantSlug, broadcasterId);

    try {
      persistTenantBroadcasterRegistry();
    } catch (error) {
      if (previousBroadcasterId) {
        tenantBroadcasterRegistry.set(tenantSlug, previousBroadcasterId);
      } else {
        tenantBroadcasterRegistry.delete(tenantSlug);
      }

      throw error;
    }
  }

  return {
    tenantSlug,
    broadcasterId,
    previousBroadcasterId,
    updated,
  };
}

function resolveExpectedBroadcasterIdForTenant(tenantSlug: string): string | null {
  const normalizedTenantSlug = parseTenantSlugFromRoute(tenantSlug) ?? defaultTenantSlug;
  const persistedBroadcasterId = tenantBroadcasterRegistry.get(normalizedTenantSlug)?.trim() ?? '';
  if (persistedBroadcasterId) {
    return persistedBroadcasterId;
  }

  const tenantBroadcasterId = tenantBroadcasterOverrides.get(normalizedTenantSlug)?.trim() ?? '';
  if (tenantBroadcasterId) {
    return tenantBroadcasterId;
  }

  return twitchBroadcasterId || null;
}

function parseTenantRoute(pathname: string): { tenantSlug: string; suffix: string } | null {
  const match = pathname.match(tenantApiPathPattern);
  if (!match) {
    return null;
  }

  const tenantSlug = match[1] ?? '';
  const suffix = match[2] ?? '';
  return {
    tenantSlug,
    suffix,
  };
}

function isLegacyApiRoute(pathname: string): boolean {
  return pathname.startsWith('/api/') && !pathname.startsWith('/api/t/');
}

function isLegacyApiRouteExemptFromTenantFallback(pathname: string): boolean {
  return pathname === '/api/owner' || pathname.startsWith('/api/owner/');
}

function rewriteTenantRequestUrl(req: Request, suffix: string): void {
  const queryIndex = req.url.indexOf('?');
  const query = queryIndex >= 0 ? req.url.slice(queryIndex) : '';
  const rewrittenPath = `/api${suffix}`;
  req.url = `${rewrittenPath}${query}`;
}

function setTenantContext(req: Request, tenantContext: TenantContext): void {
  (req as RequestWithTenantContext).tenantContext = tenantContext;
}

function getTenantContext(req: Request): TenantContext {
  const maybeContext = (req as RequestWithTenantContext).tenantContext;
  if (maybeContext) {
    return maybeContext;
  }

  return {
    slug: defaultTenantSlug,
    source: 'non-api',
    isDefaultTenant: true,
  };
}

function resolveTokenTenantSlug(rawTenantSlug: string | undefined): string {
  return parseTenantSlugFromRoute(rawTenantSlug) ?? defaultTenantSlug;
}

function toOrigin(input: string | undefined): string | null {
  const trimmed = input?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

function normalizeCookieDomain(input: string | undefined): string | null {
  const trimmed = String(input ?? '')
    .trim()
    .toLowerCase();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.startsWith('.') ? trimmed.slice(1) : trimmed;
  if (!normalized || normalized === '::1' || normalized === '[::1]' || isLocalHostname(normalized)) {
    return null;
  }

  if (normalized.includes(':') || !normalized.includes('.')) {
    return null;
  }

  if (!/^[a-z0-9.-]+$/.test(normalized) || normalized.startsWith('.') || normalized.endsWith('.')) {
    return null;
  }

  const labels = normalized.split('.');
  if (labels.some((label) => !label || label.startsWith('-') || label.endsWith('-'))) {
    return null;
  }

  return normalized;
}

function toBase64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function fromBase64Url(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function signPayload(payloadBase64: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payloadBase64).digest('base64url');
}

function encodeSignedToken<T extends object>(payload: T, secret: string): string {
  const payloadBase64 = toBase64Url(JSON.stringify(payload));
  const signature = signPayload(payloadBase64, secret);
  return `${payloadBase64}.${signature}`;
}

function decodeSignedToken<T>(token: string, secret: string): T | null {
  const [payloadBase64, signature] = token.split('.');
  if (!payloadBase64 || !signature) {
    return null;
  }

  const expectedSignature = signPayload(payloadBase64, secret);
  if (signature.length !== expectedSignature.length) {
    return null;
  }

  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (!crypto.timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(payloadBase64)) as T;
    return parsed;
  } catch {
    return null;
  }
}

function createViewerInviteToken(payload: Omit<ViewerInviteTokenPayload, 'v' | 'type' | 'iat' | 'exp'>): string {
  const now = Date.now();
  const tenantSlug = resolveTokenTenantSlug(payload.tenantSlug);
  const tokenPayload: ViewerInviteTokenPayload = {
    v: 1,
    type: 'viewer-invite',
    ...payload,
    tenantSlug,
    iat: now,
    exp: now + viewerInviteTokenTtlMs,
  };

  return encodeSignedToken(tokenPayload, viewerInviteTokenSecret);
}

function createViewerAuthToken(payload: Omit<ViewerAuthTokenPayload, 'v' | 'type' | 'iat' | 'exp'>): string {
  const now = Date.now();
  const tenantSlug = resolveTokenTenantSlug(payload.tenantSlug);
  const tokenPayload: ViewerAuthTokenPayload = {
    v: 1,
    type: 'viewer-auth',
    ...payload,
    tenantSlug,
    iat: now,
    exp: now + viewerAuthTokenTtlMs,
  };

  return encodeSignedToken(tokenPayload, viewerAuthTokenSecret);
}

function verifyViewerAuthToken(token: string): ViewerAuthTokenPayload | null {
  if (!viewerAuthTokenSecret) {
    return null;
  }

  const payload = decodeSignedToken<ViewerAuthTokenPayload>(token, viewerAuthTokenSecret);
  if (!payload) {
    return null;
  }

  if (payload.v !== 1 || payload.type !== 'viewer-auth') {
    return null;
  }

  if (!payload.userId || !payload.userName || !payload.sessionId) {
    return null;
  }

  if (payload.tenantSlug !== undefined && !parseTenantSlugFromRoute(payload.tenantSlug)) {
    return null;
  }

  if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) {
    return null;
  }

  return payload;
}

function parseCookieHeader(cookieHeader: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!cookieHeader) {
    return result;
  }

  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rest] = part.split('=');
    const name = rawName?.trim();
    if (!name) {
      continue;
    }

    const value = rest.join('=').trim();
    result.set(name, decodeURIComponent(value));
  }

  return result;
}

function setViewerAuthCookie(res: Response, token: string): void {
  const secure = publicApiBaseUrl.startsWith('https://');
  const cookieParts = [
    `viewer_auth=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    secure ? 'Secure' : '',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    `Max-Age=${Math.floor(viewerAuthTokenTtlMs / 1000)}`,
  ].filter(Boolean);

  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function clearViewerAuthCookie(res: Response): void {
  const secure = publicApiBaseUrl.startsWith('https://');
  const cookieParts = [
    'viewer_auth=',
    'Path=/',
    'HttpOnly',
    secure ? 'Secure' : '',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    'Max-Age=0',
  ].filter(Boolean);

  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function setModAuthCookie(res: Response, token: string): void {
  const secure = publicApiBaseUrl.startsWith('https://');
  const cookieParts = [
    `mod_auth=${encodeURIComponent(token)}`,
    'Path=/',
    modAuthCookieDomain ? `Domain=${modAuthCookieDomain}` : '',
    'HttpOnly',
    secure ? 'Secure' : '',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    `Max-Age=${Math.floor(modAuthSessionTtlMs / 1000)}`,
  ].filter(Boolean);

  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function clearModAuthCookie(res: Response): void {
  const secure = publicApiBaseUrl.startsWith('https://');
  const cookieParts = [
    'mod_auth=',
    'Path=/',
    modAuthCookieDomain ? `Domain=${modAuthCookieDomain}` : '',
    'HttpOnly',
    secure ? 'Secure' : '',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    'Max-Age=0',
  ].filter(Boolean);

  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function setOwnerAuthCookie(res: Response, token: string): void {
  const secure = publicApiBaseUrl.startsWith('https://');
  const cookieParts = [
    `owner_auth=${encodeURIComponent(token)}`,
    'Path=/',
    ownerAuthCookieDomain ? `Domain=${ownerAuthCookieDomain}` : '',
    'HttpOnly',
    secure ? 'Secure' : '',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    `Max-Age=${Math.floor(ownerAuthSessionTtlMs / 1000)}`,
  ].filter(Boolean);

  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function clearOwnerAuthCookie(res: Response): void {
  const secure = publicApiBaseUrl.startsWith('https://');
  const cookieParts = [
    'owner_auth=',
    'Path=/',
    ownerAuthCookieDomain ? `Domain=${ownerAuthCookieDomain}` : '',
    'HttpOnly',
    secure ? 'Secure' : '',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    'Max-Age=0',
  ].filter(Boolean);

  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function readBearerToken(req: Request): string | null {
  const authHeader = String(req.header('authorization') ?? '').trim();
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return null;
  }

  const token = authHeader.slice('bearer '.length).trim();
  return token || null;
}

function getViewerAuthFromRequest(req: Request): ViewerAuthTokenPayload | null {
  const cookies = parseCookieHeader(req.header('cookie'));
  const token = cookies.get('viewer_auth') ?? readBearerToken(req);
  if (!token) {
    return null;
  }

  return verifyViewerAuthToken(token);
}

function prunePendingOauthStates(tenantState: TenantRuntimeState = getDefaultTenantRuntimeState()): void {
  const now = Date.now();
  for (const [state, pending] of tenantState.pendingOauthStates.entries()) {
    if (pending.createdAt + oauthStateTtlMs < now) {
      tenantState.pendingOauthStates.delete(state);
    }
  }
}

function createOauthState(
  inviteToken: string,
  tenantState: TenantRuntimeState = getDefaultTenantRuntimeState(),
): string {
  prunePendingOauthStates(tenantState);
  const state = crypto.randomBytes(18).toString('base64url');
  tenantState.pendingOauthStates.set(state, {
    inviteToken,
    createdAt: Date.now(),
  });
  return state;
}

function consumeOauthState(
  state: string,
  tenantState: TenantRuntimeState = getDefaultTenantRuntimeState(),
): PendingOauthState | null {
  prunePendingOauthStates(tenantState);
  const pending = tenantState.pendingOauthStates.get(state);
  if (!pending) {
    return null;
  }

  tenantState.pendingOauthStates.delete(state);
  return pending;
}

function consumeOauthStateAcrossTenants(state: string): { pending: PendingOauthState; tenantSlug: string } | null {
  for (const [tenantSlug, tenantState] of tenantRuntimeStates.entries()) {
    const pending = consumeOauthState(state, tenantState);
    if (pending) {
      return {
        pending,
        tenantSlug,
      };
    }
  }

  return null;
}

function prunePendingModOauthStates(tenantState: TenantRuntimeState = getDefaultTenantRuntimeState()): void {
  const now = Date.now();
  for (const [state, pending] of tenantState.pendingModOauthStates.entries()) {
    if (pending.createdAt + oauthStateTtlMs < now) {
      tenantState.pendingModOauthStates.delete(state);
    }
  }
}

function createModOauthState(
  returnTo: string | null,
  tenantState: TenantRuntimeState = getDefaultTenantRuntimeState(),
): string {
  prunePendingModOauthStates(tenantState);
  const state = crypto.randomBytes(18).toString('base64url');
  tenantState.pendingModOauthStates.set(state, {
    returnTo,
    createdAt: Date.now(),
  });
  return state;
}

function consumeModOauthState(
  state: string,
  tenantState: TenantRuntimeState = getDefaultTenantRuntimeState(),
): PendingModOauthState | null {
  prunePendingModOauthStates(tenantState);
  const pending = tenantState.pendingModOauthStates.get(state);
  if (!pending) {
    return null;
  }

  tenantState.pendingModOauthStates.delete(state);
  return pending;
}

function consumeModOauthStateAcrossTenants(
  state: string,
): { pending: PendingModOauthState; tenantSlug: string } | null {
  for (const [tenantSlug, tenantState] of tenantRuntimeStates.entries()) {
    const pending = consumeModOauthState(state, tenantState);
    if (pending) {
      return {
        pending,
        tenantSlug,
      };
    }
  }

  return null;
}

function prunePendingOwnerOauthStates(): void {
  const now = Date.now();
  for (const [state, pending] of pendingOwnerOauthStates.entries()) {
    if (pending.createdAt + oauthStateTtlMs < now) {
      pendingOwnerOauthStates.delete(state);
    }
  }
}

function createOwnerOauthState(returnTo: string | null): string {
  prunePendingOwnerOauthStates();
  const state = crypto.randomBytes(18).toString('base64url');
  pendingOwnerOauthStates.set(state, {
    returnTo,
    createdAt: Date.now(),
  });
  return state;
}

function consumeOwnerOauthState(state: string): PendingOwnerOauthState | null {
  prunePendingOwnerOauthStates();
  const pending = pendingOwnerOauthStates.get(state);
  if (!pending) {
    return null;
  }

  pendingOwnerOauthStates.delete(state);
  return pending;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function sanitizeModReturnTo(rawValue: string | null | undefined): string | null {
  const value = String(rawValue ?? '').trim();
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    if (!allowedCorsOrigins.has(parsed.origin) && !isLocalHostname(parsed.hostname.toLowerCase())) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

function resolveRequestedModReturnTo(req: Request): string | null {
  const queryReturnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '';
  const headerReturnTo = String(req.header('referer') ?? '');
  return sanitizeModReturnTo(queryReturnTo || headerReturnTo);
}

function resolveRequestedOwnerReturnTo(req: Request): string | null {
  const queryReturnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '';
  const headerReturnTo = String(req.header('referer') ?? '');
  return sanitizeModReturnTo(queryReturnTo || headerReturnTo);
}

function buildModAuthReturnUrl(returnTo: string, authError?: string): string {
  const url = new URL(returnTo);
  if (authError) {
    url.searchParams.set('modAuthError', authError);
  } else {
    url.searchParams.delete('modAuthError');
  }

  return url.toString();
}

function buildOwnerAuthReturnUrl(returnTo: string, authError?: string): string {
  const url = new URL(returnTo);
  if (authError) {
    url.searchParams.set('ownerAuthError', authError);
  } else {
    url.searchParams.delete('ownerAuthError');
  }

  return url.toString();
}

function classifyModAuthFailure(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('scope')) {
    return 'missing_scope';
  }

  if (message.includes('oauth') || message.includes('token')) {
    return 'oauth_failed';
  }

  return 'auth_failed';
}

function classifyOwnerAuthFailure(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('scope')) {
    return 'missing_scope';
  }

  if (message.includes('oauth') || message.includes('token')) {
    return 'oauth_failed';
  }

  return 'auth_failed';
}

function resolveOauthCallbackError(oauthError: string): string {
  if (oauthError === 'redirect_mismatch') {
    return 'oauth_redirect_mismatch';
  }

  if (oauthError) {
    return 'oauth_failed';
  }

  return 'invalid_oauth_callback';
}

function respondOwnerAuthCallbackError(
  res: Response,
  pending: PendingOwnerOauthState,
  callbackError: string,
  statusCode: number = 400,
): void {
  if (pending.returnTo) {
    res.redirect(302, buildOwnerAuthReturnUrl(pending.returnTo, callbackError));
    return;
  }

  res.status(statusCode).json({ error: callbackError });
}

async function completeOwnerAuthFromOauthCode(
  code: string,
  pending: PendingOwnerOauthState,
  res: Response,
): Promise<void> {
  try {
    const accessToken = await requestTwitchAccessToken(code, ownerAuthTwitchRedirectUri);
    const identity = await resolveTwitchIdentity(accessToken);
    const userName = sanitizeUserName(identity.userName, identity.userLogin || identity.userId);

    if (!isOwnerUserId(identity.userId)) {
      clearOwnerAuthCookie(res);
      appendAuditEvent('owner_auth_denied', `Twitch user ${userName} is not in OWNER_TWITCH_USER_IDS.`, {
        userId: identity.userId,
        userName,
      });

      if (pending.returnTo) {
        res.redirect(302, buildOwnerAuthReturnUrl(pending.returnTo, 'owner_not_allowed'));
        return;
      }

      res.status(403).json({
        error: 'owner_not_allowed',
        authenticated: true,
        user: {
          userId: identity.userId,
          userLogin: identity.userLogin,
          userName,
        },
      });
      return;
    }

    const ownerSessionToken = createOwnerAuthSessionToken({
      userId: identity.userId,
      userLogin: identity.userLogin,
      userName,
    });
    setOwnerAuthCookie(res, ownerSessionToken);

    appendAuditEvent('owner_auth_success', `Owner auth succeeded for ${userName}.`, {
      userId: identity.userId,
      userName,
    });

    if (pending.returnTo) {
      res.redirect(302, buildOwnerAuthReturnUrl(pending.returnTo));
      return;
    }

    res.json({
      ok: true,
      user: {
        userId: identity.userId,
        userLogin: identity.userLogin,
        userName,
      },
    });
    return;
  } catch (error) {
    clearOwnerAuthCookie(res);
    const authError = classifyOwnerAuthFailure(error);
    appendAuditEvent('owner_auth_failed', `Owner auth callback failed (${authError}).`);

    if (pending.returnTo) {
      res.redirect(302, buildOwnerAuthReturnUrl(pending.returnTo, authError));
      return;
    }

    res.status(502).json({ error: authError });
  }
}

async function requestTwitchAppAccessToken(): Promise<string> {
  const params = new URLSearchParams({
    client_id: twitchClientId,
    client_secret: twitchClientSecret,
    grant_type: 'client_credentials',
  });

  const response = await fetchJsonOrThrow<TwitchTokenResponse>(`https://id.twitch.tv/oauth2/token?${params.toString()}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
  });

  if (!response.access_token) {
    throw new Error('missing_access_token');
  }

  return response.access_token;
}

async function resolveTwitchUserByLogin(loginInput: string): Promise<ResolvedTwitchUser | null> {
  const login = String(loginInput ?? '').trim().toLowerCase();
  if (!login || !/^[a-z0-9_]{2,32}$/.test(login)) {
    throw new Error('invalid_twitch_login');
  }

  const accessToken = await requestTwitchAppAccessToken();
  const endpoint = new URL('https://api.twitch.tv/helix/users');
  endpoint.searchParams.set('login', login);

  const payload = await fetchJsonOrThrow<TwitchUserResponse>(endpoint.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': twitchClientId,
    },
  });

  const user = payload.data?.[0];
  if (!user) {
    return null;
  }

  return {
    userId: user.id,
    userLogin: user.login,
    userName: user.display_name,
  };
}

async function resolveTwitchUsersById(userIdInput: string[]): Promise<Map<string, ResolvedTwitchUser>> {
  const uniqueUserIds = [...new Set(userIdInput.map((rawId) => String(rawId ?? '').trim()).filter((id) => id.length > 0))];
  const usersById = new Map<string, ResolvedTwitchUser>();
  if (uniqueUserIds.length === 0) {
    return usersById;
  }

  const accessToken = await requestTwitchAppAccessToken();
  const batchSize = 100;

  for (let index = 0; index < uniqueUserIds.length; index += batchSize) {
    const batchIds = uniqueUserIds.slice(index, index + batchSize);
    const endpoint = new URL('https://api.twitch.tv/helix/users');
    for (const userId of batchIds) {
      endpoint.searchParams.append('id', userId);
    }

    try {
      const payload = await fetchJsonOrThrow<TwitchUserResponse>(endpoint.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Client-Id': twitchClientId,
        },
      });

      for (const user of payload.data ?? []) {
        const userId = String(user.id ?? '').trim();
        if (!userId) {
          continue;
        }

        usersById.set(userId, {
          userId,
          userLogin: String(user.login ?? '').trim() || userId,
          userName: String(user.display_name ?? '').trim() || String(user.login ?? '').trim() || userId,
        });
      }
    } catch {
      // Keep owner tenants response resilient if one Twitch lookup batch fails.
      continue;
    }
  }

  return usersById;
}

function requireViewerAuth(req: Request, res: Response): ViewerAuthTokenPayload | null {
  const auth = getViewerAuthFromRequest(req);
  if (!auth) {
    res.status(401).json({ error: 'viewer_auth_required' });
    return null;
  }

  const tenantContext = getTenantContext(req);
  const tokenTenantSlug = resolveTokenTenantSlug(auth.tenantSlug);
  if (tokenTenantSlug !== tenantContext.slug) {
    res.status(401).json({ error: 'viewer_tenant_mismatch' });
    return null;
  }

  const tenantState = getTenantRuntimeState(tenantContext.slug);
  const activeSession = tenantState.activeSession;
  if (activeSession && auth.sessionId !== activeSession.id) {
    res.status(401).json({ error: 'viewer_session_expired' });
    return null;
  }

  return auth;
}

function assertViewerAuthConfig(): string | null {
  if (!viewerInviteTokenSecret || !viewerAuthTokenSecret) {
    return 'viewer_token_secret_missing';
  }

  if (!viewerBaseUrl || !publicApiBaseUrl) {
    return 'viewer_or_api_base_url_missing';
  }

  if (!twitchClientId || !twitchClientSecret || !twitchRedirectUri) {
    return 'twitch_oauth_not_configured';
  }

  return null;
}

function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return fallback;
}

function trimTrailingSlashes(input: string): string {
  return input.replace(/\/+$/, '');
}

function resolvePublicApiBase(req: Request): string {
  const configured = trimTrailingSlashes(publicApiBaseUrl);
  if (configured) {
    return configured;
  }

  const forwardedProto = String(req.header('x-forwarded-proto') ?? '')
    .split(',')[0]
    ?.trim();
  const forwardedHost = String(req.header('x-forwarded-host') ?? '')
    .split(',')[0]
    ?.trim();
  const host = forwardedHost || String(req.header('host') ?? '').trim();
  const protocol = forwardedProto || req.protocol || 'https';

  return host ? `${protocol}://${host}` : '';
}

function decodeTokenPayload<T>(encoded: string): T | null {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

function signTokenPayload(encodedPayload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifySignedToken<T>(token: string, secret: string): T | null {
  const segments = token.split('.');
  if (segments.length !== 2) {
    return null;
  }

  const [encodedPayload, signature] = segments;
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signTokenPayload(encodedPayload, secret);
  if (!timingSafeEqual(signature, expectedSignature)) {
    return null;
  }

  return decodeTokenPayload<T>(encodedPayload);
}

function parseViewerInviteToken(token: string): ViewerInviteTokenPayload | null {
  if (!viewerInviteTokenSecret) {
    return null;
  }

  const payload = verifySignedToken<ViewerInviteTokenPayload>(token, viewerInviteTokenSecret);
  if (!payload || payload.v !== 1 || payload.type !== 'viewer-invite') {
    return null;
  }

  if (!payload.sessionId || !payload.userId || !payload.redemptionId || !payload.userName) {
    return null;
  }

  if (payload.tenantSlug !== undefined && !parseTenantSlugFromRoute(payload.tenantSlug)) {
    return null;
  }

  if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) {
    return null;
  }

  return payload;
}

function parseViewerAuthToken(token: string): ViewerAuthTokenPayload | null {
  if (!viewerAuthTokenSecret) {
    return null;
  }

  const payload = verifySignedToken<ViewerAuthTokenPayload>(token, viewerAuthTokenSecret);
  if (!payload || payload.v !== 1 || payload.type !== 'viewer-auth') {
    return null;
  }

  if (!payload.sessionId || !payload.userId || !payload.userName) {
    return null;
  }

  if (payload.tenantSlug !== undefined && !parseTenantSlugFromRoute(payload.tenantSlug)) {
    return null;
  }

  if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) {
    return null;
  }

  return payload;
}

function isInternalRedeemSecretMatch(req: Request): boolean {
  if (!internalRedeemSecret) {
    return false;
  }

  const authHeader = String(req.header('authorization') ?? '').trim();
  const secretHeader = String(req.header('x-internal-secret') ?? '').trim();
  return authHeader === `Bearer ${internalRedeemSecret}` || secretHeader === internalRedeemSecret;
}

function requireInternalRedeemAuth(req: Request, res: Response): boolean {
  if (!internalRedeemSecret) {
    res.status(503).json({ error: 'internal_redeem_not_configured', message: 'Set INTERNAL_REDEEM_SECRET.' });
    return false;
  }

  if (isInternalRedeemSecretMatch(req)) {
    return true;
  }

  res.status(401).json({ error: 'invalid_internal_secret' });
  return false;
}

function requireTenantRedeemAuth(req: Request, res: Response): boolean {
  const tenantContext = getTenantContext(req);
  const bearerToken = readBearerToken(req);
  const headerToken = String(req.header('x-tenant-redeem-key') ?? '').trim();
  const redeemKeyToken = bearerToken || headerToken;

  if (redeemKeyToken && verifyTenantRedeemKeyForTenant(redeemKeyToken, tenantContext.slug)) {
    return true;
  }

  if (legacyInternalRedeemSecretEnabled && isInternalRedeemSecretMatch(req)) {
    return true;
  }

  const message = 'Tenant redeem key is missing, invalid, or belongs to a different tenant.';

  res.status(401).json({
    ok: false,
    error: 'invalid_tenant_redeem_auth',
    message,
    viewerUrl: message,
    legacyFallbackEnabled: legacyInternalRedeemSecretEnabled,
  });
  return false;
}

function sanitizeUserName(raw: string, fallback: string): string {
  const normalized = raw.trim();
  if (!normalized) {
    return fallback;
  }

  if (normalized.length <= 64) {
    return normalized;
  }

  return normalized.slice(0, 64);
}

function buildViewerUrl(
  req: Request,
  args: { invite?: string; authToken?: string; authError?: string; tenantSlug?: string },
): string {
  const base = new URL(viewerBaseUrl);
  const apiBase = resolvePublicApiBase(req);
  if (apiBase) {
    base.searchParams.set('api', apiBase);
  }

  const normalizedTenantSlug = parseTenantSlugFromRoute(args.tenantSlug);
  if (normalizedTenantSlug) {
    base.searchParams.set('tenant', normalizedTenantSlug);
  }

  if (args.invite) {
    base.searchParams.set('invite', args.invite);
  }

  if (args.authError) {
    base.searchParams.set('authError', args.authError);
  }

  if (args.authToken) {
    base.hash = `auth=${encodeURIComponent(args.authToken)}`;
  }

  return base.toString();
}

async function fetchJsonOrThrow<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();

  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const message =
      typeof payload === 'string'
        ? payload
        : ((payload as Record<string, unknown> | null)?.message as string | undefined) ??
          ((payload as Record<string, unknown> | null)?.error as string | undefined) ??
          `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return payload as T;
}

async function requestTwitchAccessToken(code: string, redirectUri: string = twitchRedirectUri): Promise<string> {
  const body = new URLSearchParams({
    client_id: twitchClientId,
    client_secret: twitchClientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const response = await fetchJsonOrThrow<TwitchTokenResponse>('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.access_token) {
    throw new Error('missing_access_token');
  }

  return response.access_token;
}

async function resolveTwitchIdentity(
  accessToken: string,
): Promise<{ userId: string; userName: string; userLogin: string }> {
  const validate = await fetchJsonOrThrow<TwitchValidateResponse>('https://id.twitch.tv/oauth2/validate', {
    headers: {
      Authorization: `OAuth ${accessToken}`,
    },
  });

  if (!validate.user_id) {
    throw new Error('twitch_validate_missing_user');
  }

  if (validate.client_id !== twitchClientId) {
    throw new Error('twitch_validate_client_mismatch');
  }

  let userLogin = validate.login || validate.user_id;
  let userName = userLogin;

  try {
    const users = await fetchJsonOrThrow<TwitchUserResponse>(
      `https://api.twitch.tv/helix/users?id=${encodeURIComponent(validate.user_id)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Client-Id': twitchClientId,
        },
      },
    );

    const displayName = users.data?.[0]?.display_name?.trim();
    const loginName = users.data?.[0]?.login?.trim();
    if (displayName) {
      userName = displayName;
    }

    if (loginName) {
      userLogin = loginName;
    }
  } catch {
    // Fallback to login when Helix user lookup is unavailable.
  }

  return {
    userId: validate.user_id,
    userLogin,
    userName,
  };
}

async function resolveTwitchModRoleForBroadcaster(
  accessToken: string,
  userId: string,
  broadcasterId: string,
): Promise<ModAuthRole> {
  if (!broadcasterId) {
    return 'unauthorized';
  }

  if (userId === broadcasterId) {
    return 'broadcaster';
  }

  let cursor: string | null = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const endpoint = new URL('https://api.twitch.tv/helix/moderation/channels');
    endpoint.searchParams.set('user_id', userId);
    endpoint.searchParams.set('first', '100');
    if (cursor) {
      endpoint.searchParams.set('after', cursor);
    }

    const payload = await fetchJsonOrThrow<TwitchModeratedChannelsResponse>(endpoint.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': twitchClientId,
      },
    });

    if (payload.data?.some((entry) => entry.broadcaster_id === broadcasterId)) {
      return 'moderator';
    }

    const nextCursor = payload.pagination?.cursor?.trim() ?? '';
    if (!nextCursor) {
      break;
    }

    cursor = nextCursor;
  }

  return 'unauthorized';
}

function clampWinnerClaimCount(input: number | undefined): number {
  if (!Number.isFinite(input)) {
    return defaultMaxWinnerClaims;
  }

  const rounded = Math.floor(input as number);
  if (rounded < minWinnerClaims) {
    return minWinnerClaims;
  }

  if (rounded > maxWinnerClaims) {
    return maxWinnerClaims;
  }

  return rounded;
}

function clampWinnerGraceSeconds(input: number | undefined, fallback: number): number {
  if (!Number.isFinite(input)) {
    return clampWinnerGraceSeconds(fallback, defaultWinnerGracePeriodSeconds);
  }

  const rounded = Math.floor(input as number);
  if (rounded < minWinnerGraceSeconds) {
    return minWinnerGraceSeconds;
  }

  if (rounded > maxWinnerGraceSeconds) {
    return maxWinnerGraceSeconds;
  }

  return rounded;
}

function sanitizeOptionList(options: string[]): string[] {
  return [...new Set(options.map(normalizeOption).filter(Boolean))];
}

function shuffleOptionOrder(options: string[]): string[] {
  const shuffled = [...options];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    const current = shuffled[index];
    shuffled[index] = shuffled[swapIndex];
    shuffled[swapIndex] = current;
  }

  // Ensure New Session visibly reshuffles even if randomization returns the same order.
  if (shuffled.length > 1 && shuffled.every((value, index) => value === options[index])) {
    const [first, ...rest] = shuffled;
    return [...rest, first];
  }

  return shuffled;
}

function toOptionKey(input: string): string {
  return normalizeOption(input).toLowerCase();
}

function createOptionId(label: string, existingIds: Set<string>): string {
  const base = toOptionKey(label)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'option';

  let suffix = 1;
  let candidate = `opt_${base}`;
  while (existingIds.has(candidate)) {
    suffix += 1;
    candidate = `opt_${base}_${suffix}`;
  }

  return candidate;
}

function createOptionItem(label: string, existingIds: Set<string>): OptionPoolItem {
  const now = new Date().toISOString();
  const normalizedLabel = normalizeOption(label);
  const id = createOptionId(normalizedLabel, existingIds);
  existingIds.add(id);

  return {
    id,
    label: normalizedLabel,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function createOptionPoolFromLabels(labels: string[], existingPool: OptionPoolItem[] = []): OptionPoolItem[] {
  const normalized = sanitizeOptionList(labels);
  const existingByKey = new Map(existingPool.map((item) => [toOptionKey(item.label), item]));
  const usedIds = new Set(existingPool.map((item) => item.id));
  const now = new Date().toISOString();

  return normalized.map((label) => {
    const existing = existingByKey.get(toOptionKey(label));
    if (existing) {
      return {
        ...existing,
        label,
        enabled: true,
        updatedAt: now,
      };
    }

    return createOptionItem(label, usedIds);
  });
}

function hydrateOptionPool(entries: PersistedOptionPoolEntry[]): OptionPoolItem[] {
  if (entries.length === 0) {
    return [];
  }

  const dedupedByLabel = new Map<string, OptionPoolItem>();
  const usedIds = new Set<string>();
  const now = new Date().toISOString();

  for (const entry of entries) {
    const normalizedLabel = typeof entry === 'string' ? normalizeOption(entry) : normalizeOption(entry.label);
    if (!normalizedLabel) {
      continue;
    }

    const key = toOptionKey(normalizedLabel);
    if (dedupedByLabel.has(key)) {
      continue;
    }

    const desiredId = typeof entry === 'string' ? '' : entry.id.trim();
    let id = desiredId;
    if (!id || usedIds.has(id)) {
      id = createOptionId(normalizedLabel, usedIds);
    }
    usedIds.add(id);

    const enabled = typeof entry === 'string' ? true : entry.enabled;
    const createdAt = typeof entry === 'string' ? now : entry.createdAt;
    const updatedAt = typeof entry === 'string' ? now : entry.updatedAt;

    dedupedByLabel.set(key, {
      id,
      label: normalizedLabel,
      enabled,
      createdAt,
      updatedAt,
    });
  }

  return [...dedupedByLabel.values()];
}

function getEnabledOptionItems(
  pool: OptionPoolItem[] = getDefaultTenantRuntimeState().optionPool,
): OptionPoolItem[] {
  return pool.filter((item) => item.enabled);
}

function getEnabledOptionLabels(
  pool: OptionPoolItem[] = getDefaultTenantRuntimeState().optionPool,
): string[] {
  return getEnabledOptionItems(pool).map((item) => item.label);
}

function findOptionByLabel(
  label: string,
  tenantState: TenantRuntimeState = getDefaultTenantRuntimeState(),
): OptionPoolItem | null {
  const key = toOptionKey(label);
  return tenantState.optionPool.find((item) => toOptionKey(item.label) === key) ?? null;
}

function resolveStateFilePath(configuredPath: string | undefined): string {
  const raw = configuredPath?.trim();
  if (raw) {
    return path.resolve(raw);
  }

  return path.resolve(process.cwd(), 'data', 'controller-state.json');
}

function toStampIdempotencyMapKey(sessionId: string, userId: string, key: string): string {
  return `${sessionId}:${userId}:${key}`;
}

function toRedeemJoinMapKey(sessionId: string, redemptionId: string): string {
  return `${sessionId}:${redemptionId}`;
}

function normalizeIdempotencyKey(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }

  const normalized = raw.trim();
  if (!idempotencyKeyPattern.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeRedemptionId(raw: string | undefined): string | null {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return normalized;
}

function parseIsoTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return 0;
  }

  return timestamp;
}

function getWinnerGraceSecondsRemaining(session: SessionState): number | null {
  if (!session.winnerGraceEndsAt) {
    return null;
  }

  const endsAtMs = parseIsoTimestamp(session.winnerGraceEndsAt);
  if (endsAtMs === 0) {
    return null;
  }

  const remainingMs = endsAtMs - Date.now();
  if (remainingMs <= 0) {
    return 0;
  }

  return Math.ceil(remainingMs / 1000);
}

function finalizeWinnerGraceWindowIfNeeded(
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): boolean {
  const activeSession = tenantState.activeSession;
  if (!activeSession || !activeSession.winnerGraceEndsAt || activeSession.status === 'ended') {
    return false;
  }

  const endsAtMs = parseIsoTimestamp(activeSession.winnerGraceEndsAt);
  if (endsAtMs === 0 || Date.now() < endsAtMs) {
    return false;
  }

  activeSession.status = 'ended';
  activeSession.winnerGraceEndsAt = null;
  commitControllerState('session_ended', 'Winner grace period elapsed. Round ended.', undefined, tenantSlug, tenantState);
  return true;
}

function pruneStampIdempotencyRecords(
  tenantState: TenantRuntimeState = getDefaultTenantRuntimeState(),
  nowMs = Date.now(),
): boolean {
  let changed = false;

  for (const [mapKey, record] of tenantState.stampIdempotencyRecords.entries()) {
    const createdAtMs = parseIsoTimestamp(record.createdAt);
    if (createdAtMs === 0 || nowMs - createdAtMs > stampIdempotencyTtlMs) {
      tenantState.stampIdempotencyRecords.delete(mapKey);
      changed = true;
    }
  }

  if (tenantState.stampIdempotencyRecords.size <= maxStampIdempotencyRecords) {
    return changed;
  }

  const oldestFirst = [...tenantState.stampIdempotencyRecords.entries()].sort(
    (a, b) => parseIsoTimestamp(a[1].createdAt) - parseIsoTimestamp(b[1].createdAt),
  );

  const overflow = oldestFirst.length - maxStampIdempotencyRecords;
  for (let index = 0; index < overflow; index += 1) {
    tenantState.stampIdempotencyRecords.delete(oldestFirst[index][0]);
    changed = true;
  }

  return changed;
}

function setStampIdempotencyRecord(
  sessionId: string,
  userId: string,
  key: string | null,
  statusCode: number,
  response: Record<string, unknown>,
  persistNow = true,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): void {
  if (!key) {
    return;
  }

  pruneStampIdempotencyRecords(tenantState);

  const mapKey = toStampIdempotencyMapKey(sessionId, userId, key);
  const record: StampIdempotencyRecord = {
    key,
    sessionId,
    userId,
    statusCode,
    response: { ...response },
    createdAt: new Date().toISOString(),
  };

  tenantState.stampIdempotencyRecords.set(mapKey, record);
  pruneStampIdempotencyRecords(tenantState);

  if (persistNow) {
    persistControllerState(tenantSlug, tenantState);
  }
}

function getStampIdempotencyRecord(
  sessionId: string,
  userId: string,
  key: string,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): StampIdempotencyRecord | null {
  const changed = pruneStampIdempotencyRecords(tenantState);
  const mapKey = toStampIdempotencyMapKey(sessionId, userId, key);
  const record = tenantState.stampIdempotencyRecords.get(mapKey) ?? null;

  if (changed) {
    persistControllerState(tenantSlug, tenantState);
  }

  return record;
}

function toPersistedStampIdempotencyRecords(
  tenantState: TenantRuntimeState = getDefaultTenantRuntimeState(),
): PersistedStampIdempotencyRecord[] {
  return [...tenantState.stampIdempotencyRecords.values()];
}

function pruneRedeemJoinRecords(
  tenantState: TenantRuntimeState = getDefaultTenantRuntimeState(),
  nowMs = Date.now(),
): boolean {
  let changed = false;
  const activeSession = tenantState.activeSession;

  for (const [mapKey, record] of tenantState.redeemJoinRecords.entries()) {
    if (record.expiresAt <= nowMs) {
      tenantState.redeemJoinRecords.delete(mapKey);
      changed = true;
      continue;
    }

    if (!activeSession || record.sessionId !== activeSession.id) {
      tenantState.redeemJoinRecords.delete(mapKey);
      changed = true;
    }
  }

  return changed;
}

function setRedeemJoinRecord(
  record: Omit<RedeemJoinRecord, 'key' | 'createdAt'>,
  persistNow = true,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): void {
  const normalizedRedemptionId = normalizeRedemptionId(record.redemptionId);
  if (!normalizedRedemptionId) {
    return;
  }

  pruneRedeemJoinRecords(tenantState);

  const mapKey = toRedeemJoinMapKey(record.sessionId, normalizedRedemptionId);
  tenantState.redeemJoinRecords.set(mapKey, {
    ...record,
    redemptionId: normalizedRedemptionId,
    key: mapKey,
    createdAt: new Date().toISOString(),
  });

  if (persistNow) {
    persistControllerState(tenantSlug, tenantState);
  }
}

function getRedeemJoinRecord(
  sessionId: string,
  redemptionId: string,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): RedeemJoinRecord | null {
  const normalizedRedemptionId = normalizeRedemptionId(redemptionId);
  if (!normalizedRedemptionId) {
    return null;
  }

  const changed = pruneRedeemJoinRecords(tenantState);
  const mapKey = toRedeemJoinMapKey(sessionId, normalizedRedemptionId);
  const record = tenantState.redeemJoinRecords.get(mapKey) ?? null;

  if (changed) {
    persistControllerState(tenantSlug, tenantState);
  }

  return record;
}

function findLatestRedeemJoinRecordForUser(
  sessionId: string,
  userId: string,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): RedeemJoinRecord | null {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    return null;
  }

  const changed = pruneRedeemJoinRecords(tenantState);
  let latest: RedeemJoinRecord | null = null;
  let latestTimestamp = 0;

  for (const record of tenantState.redeemJoinRecords.values()) {
    if (record.sessionId !== sessionId || record.userId !== normalizedUserId) {
      continue;
    }

    const createdAt = parseIsoTimestamp(record.createdAt);
    if (!latest || createdAt >= latestTimestamp) {
      latest = record;
      latestTimestamp = createdAt;
    }
  }

  if (changed) {
    persistControllerState(tenantSlug, tenantState);
  }

  return latest;
}

function toPersistedRedeemJoinRecords(
  tenantState: TenantRuntimeState = getDefaultTenantRuntimeState(),
): PersistedRedeemJoinRecord[] {
  return [...tenantState.redeemJoinRecords.values()].map((record) => ({
    key: record.key,
    sessionId: record.sessionId,
    redemptionId: record.redemptionId,
    userId: record.userId,
    userName: record.userName,
    inviteToken: record.inviteToken,
    viewerUrl: record.viewerUrl,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  }));
}

function restoreStampIdempotencyRecords(
  records: PersistedStampIdempotencyRecord[],
  tenantState: TenantRuntimeState = getDefaultTenantRuntimeState(),
): void {
  tenantState.stampIdempotencyRecords = new Map<string, StampIdempotencyRecord>();

  for (const record of records) {
    const key = normalizeIdempotencyKey(record.key);
    if (!key) {
      continue;
    }

    const mapKey = toStampIdempotencyMapKey(record.sessionId, record.userId, key);
    tenantState.stampIdempotencyRecords.set(mapKey, {
      key,
      sessionId: record.sessionId,
      userId: record.userId,
      statusCode: record.statusCode,
      response: record.response,
      createdAt: record.createdAt,
    });
  }

  pruneStampIdempotencyRecords(tenantState);
}

function restoreRedeemJoinRecords(
  records: PersistedRedeemJoinRecord[],
  tenantState: TenantRuntimeState = getDefaultTenantRuntimeState(),
): void {
  tenantState.redeemJoinRecords = new Map<string, RedeemJoinRecord>();

  for (const record of records) {
    const normalizedRedemptionId = normalizeRedemptionId(record.redemptionId);
    if (!normalizedRedemptionId) {
      continue;
    }

    const mapKey = toRedeemJoinMapKey(record.sessionId, normalizedRedemptionId);
    tenantState.redeemJoinRecords.set(mapKey, {
      key: mapKey,
      sessionId: record.sessionId,
      redemptionId: normalizedRedemptionId,
      userId: record.userId,
      userName: record.userName,
      inviteToken: record.inviteToken,
      viewerUrl: record.viewerUrl,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    });
  }

  pruneRedeemJoinRecords(tenantState);
}

function toPersistedPlayer(player: PlayerState): PersistedPlayerState {
  return {
    userId: player.userId,
    userName: player.userName,
    card: player.card,
    stamps: [...player.stamps].sort((a, b) => a - b),
    invalidStampCount: player.invalidStampCount,
    hasWon: player.hasWon,
  };
}

function toPersistedSession(session: SessionState): PersistedSessionState {
  return {
    id: session.id,
    mode: session.mode,
    status: session.status,
    options: [...session.options],
    maxWinners: session.maxWinners,
    winnerGraceSeconds: session.winnerGraceSeconds,
    winnerGraceEndsAt: session.winnerGraceEndsAt,
    calledOptions: [...session.calledOptions],
    players: [...session.players.values()].map(toPersistedPlayer),
    winners: [...session.winners],
    createdAt: session.createdAt,
  };
}

function fromPersistedPlayer(input: PersistedPlayerState): PlayerState {
  const stamps = getInitialStamps(input.card);
  const maxIndex = input.card.cells.length - 1;

  for (const index of input.stamps) {
    if (index >= 0 && index <= maxIndex) {
      stamps.add(index);
    }
  }

  return {
    userId: input.userId,
    userName: input.userName,
    card: input.card,
    stamps,
    invalidStampCount: input.invalidStampCount,
    hasWon: input.hasWon,
  };
}

function fromPersistedSession(input: PersistedSessionState): SessionState {
  const options = sanitizeOptionList(input.options);
  const optionLookup = new Set(options.map((option) => option.toLowerCase()));
  const calledOptions = new Set(
    input.calledOptions
      .map(normalizeOption)
      .filter((option) => optionLookup.has(option.toLowerCase())),
  );

  const players = new Map<string, PlayerState>();
  for (const persistedPlayer of input.players) {
    const player = fromPersistedPlayer(persistedPlayer);
    players.set(player.userId, player);
  }

  const winners = new Set<string>(input.winners);
  for (const player of players.values()) {
    if (player.hasWon) {
      winners.add(player.userId);
    }
  }

  const maxWinners = clampWinnerClaimCount(input.maxWinners);
  const winnerGraceSeconds = clampWinnerGraceSeconds(input.winnerGraceSeconds, clampedWinnerGracePeriodSeconds);
  const winnerGraceEndsAt = input.winnerGraceEndsAt && parseIsoTimestamp(input.winnerGraceEndsAt) > 0
    ? input.winnerGraceEndsAt
    : null;

  return {
    id: input.id,
    mode: normalizeMode(input.mode),
    status: input.status,
    options,
    maxWinners,
    winnerGraceSeconds,
    winnerGraceEndsAt,
    calledOptions,
    players,
    winners,
    createdAt: input.createdAt,
  };
}

function rebuildCardSignatureRegistry(
  session: SessionState | null,
  tenantState: TenantRuntimeState = getDefaultTenantRuntimeState(),
): void {
  tenantState.cardSignatureRegistry.clear();
  if (!session) {
    return;
  }

  for (const player of session.players.values()) {
    tenantState.cardSignatureRegistry.add(player.card.signature);
  }
}

function appendAuditEvent(
  type: string,
  detail: string,
  actor?: AuditActor,
  tenantState: TenantRuntimeState = getDefaultTenantRuntimeState(),
): void {
  const nextEntry: AuditEvent = {
    at: new Date().toISOString(),
    type,
    detail,
  };

  if (actor?.userId) {
    nextEntry.userId = actor.userId;
  }

  if (actor?.userName) {
    nextEntry.userName = actor.userName;
  }

  tenantState.auditLog = [...tenantState.auditLog, nextEntry].slice(-maxAuditEntries);
}

function persistControllerState(
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): void {
  try {
    const scopedTheme = resolveThemeScopedOverridesState(tenantState.themeState);
    const payload: PersistedControllerState = {
      version: 6,
      savedAt: new Date().toISOString(),
      optionPool: tenantState.optionPool.map((item) => ({
        id: item.id,
        label: item.label,
        enabled: item.enabled,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
      activeSession: tenantState.activeSession ? toPersistedSession(tenantState.activeSession) : null,
      auditLog: tenantState.auditLog,
      stampIdempotency: toPersistedStampIdempotencyRecords(tenantState),
      redeemJoinRecords: toPersistedRedeemJoinRecords(tenantState),
      themeState: {
        mode: tenantState.themeState.mode,
        overrides: normalizeThemePaletteOverrides(tenantState.themeState.overrides),
        scoped: {
          linkControllerAndCards: scopedTheme.linkControllerAndCards,
          controllerOverrides: normalizeThemePaletteOverrides(scopedTheme.controllerOverrides),
          cardsOverrides: normalizeThemePaletteOverrides(scopedTheme.cardsOverrides),
        },
        updatedAt: tenantState.themeState.updatedAt,
      },
    };

    const targetStateFilePath = resolveTenantStateFilePath(tenantSlug);
    const directory = path.dirname(targetStateFilePath);
    fs.mkdirSync(directory, { recursive: true });

    const tempPath = `${targetStateFilePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tempPath, targetStateFilePath);
  } catch (error) {
    console.error(`[controller] failed to persist state for tenant ${tenantSlug}:`, error);
  }
}

function commitControllerState(
  type: string,
  detail: string,
  actor?: AuditActor,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): void {
  appendAuditEvent(type, detail, actor, tenantState);
  persistControllerState(tenantSlug, tenantState);
}

function loadPersistedControllerState(
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): void {
  const targetStateFilePath = resolveTenantStateFilePath(tenantSlug);
  if (!fs.existsSync(targetStateFilePath)) {
    return;
  }

  try {
    const raw = fs.readFileSync(targetStateFilePath, 'utf-8');
    const parsedJson: unknown = JSON.parse(raw);
    const parsedState = persistedControllerStateSchema.safeParse(parsedJson);

    if (!parsedState.success) {
      console.warn('[controller] persisted state validation failed; starting with in-memory defaults.');
      return;
    }

    const persistedState = parsedState.data;
    const hydratedOptionPool = hydrateOptionPool(persistedState.optionPool ?? []);
    if (getEnabledOptionLabels(hydratedOptionPool).length >= minOptionsForFiveByFive) {
      tenantState.optionPool = hydratedOptionPool;
    }

    tenantState.auditLog = [...(persistedState.auditLog ?? [])].slice(-maxAuditEntries);

    if (persistedState.activeSession) {
      tenantState.activeSession = fromPersistedSession(persistedState.activeSession);
      rebuildCardSignatureRegistry(tenantState.activeSession, tenantState);
    } else {
      tenantState.activeSession = null;
      tenantState.cardSignatureRegistry.clear();
    }

    restoreStampIdempotencyRecords(persistedState.stampIdempotency ?? [], tenantState);
    restoreRedeemJoinRecords(persistedState.redeemJoinRecords ?? [], tenantState);
    tenantState.themeState = persistedState.themeState
      ? {
          mode: persistedState.themeState.mode,
          overrides: normalizeThemePaletteOverrides(persistedState.themeState.overrides),
          scoped: {
            linkControllerAndCards: persistedState.themeState.scoped?.linkControllerAndCards !== false,
            controllerOverrides: normalizeThemePaletteOverrides(
              persistedState.themeState.scoped?.controllerOverrides,
            ),
            cardsOverrides: normalizeThemePaletteOverrides(persistedState.themeState.scoped?.cardsOverrides),
          },
          updatedAt: persistedState.themeState.updatedAt,
        }
      : createDefaultThemeState(defaultThemeMode);

    console.log(`[controller] restored persisted state for tenant ${tenantSlug} from ${targetStateFilePath}`);
  } catch (error) {
    console.error(`[controller] failed to load persisted state for tenant ${tenantSlug}:`, error);
  }
}

function assertMod(ctx: ChatCommandContext): ChatCommandResult | null {
  if (ctx.isMod) {
    return null;
  }

  return { ok: false, message: 'This command is moderator-only.' };
}

function resetSession(mode: BingoMode, options: string[], maxWinners: number): SessionState {
  return {
    id: `session_${Date.now().toString(36)}`,
    mode,
    status: 'open',
    options,
    maxWinners,
    winnerGraceSeconds: clampedWinnerGracePeriodSeconds,
    winnerGraceEndsAt: null,
    calledOptions: new Set<string>(),
    players: new Map<string, PlayerState>(),
    winners: new Set<string>(),
    createdAt: new Date().toISOString(),
  };
}

function startSession(
  modeInput: string | undefined,
  optionsInput: string[],
  maxWinnersInput?: number,
  winnerGraceSecondsInput?: number,
  actor?: AuditActor,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): ChatCommandResult {
  const mode = normalizeMode(modeInput);
  const options = sanitizeOptionList(optionsInput);
  const maxWinners = clampWinnerClaimCount(maxWinnersInput);
  const winnerGraceSeconds = clampWinnerGraceSeconds(winnerGraceSecondsInput, clampedWinnerGracePeriodSeconds);

  if (options.length < minOptionsForFiveByFive) {
    return {
      ok: false,
      message: `Need at least ${minOptionsForFiveByFive} unique options before starting bingo.`,
    };
  }

  tenantState.activeSession = resetSession(mode, options, maxWinners);
  tenantState.activeSession.winnerGraceSeconds = winnerGraceSeconds;
  tenantState.cardSignatureRegistry.clear();
  tenantState.redeemJoinRecords.clear();
  commitControllerState(
    'session_started',
    `Bingo started in ${mode} mode with ${options.length} options. Max winners: ${maxWinners}. Grace: ${winnerGraceSeconds}s.`,
    actor,
    tenantSlug,
    tenantState,
  );

  return {
    ok: true,
    message: `Bingo started in ${mode} mode. Max winners: ${maxWinners}. Grace: ${winnerGraceSeconds}s. Use !join to get a randomized card.`,
  };
}

function stopSession(
  endSession: boolean,
  actor?: AuditActor,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): ChatCommandResult {
  const activeSession = tenantState.activeSession;
  if (!activeSession) {
    return { ok: false, message: 'No active bingo session.' };
  }

  activeSession.status = endSession ? 'ended' : 'stopped';
  activeSession.winnerGraceEndsAt = null;
  commitControllerState(
    endSession ? 'session_ended' : 'session_stopped',
    endSession ? 'Bingo ended and winner claims are sealed.' : 'Bingo stopped.',
    actor,
    tenantSlug,
    tenantState,
  );

  return {
    ok: true,
    message: endSession ? 'Bingo ended and winner claims are sealed.' : 'Bingo stopped.',
  };
}

function resetCurrentSessionBoard(
  actor?: AuditActor,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): ChatCommandResult {
  const activeSession = tenantState.activeSession;
  if (!activeSession) {
    return { ok: false, message: 'No active session to reset.' };
  }

  activeSession.calledOptions.clear();
  activeSession.winners.clear();
  activeSession.winnerGraceEndsAt = null;
  activeSession.status = 'open';

  for (const player of activeSession.players.values()) {
    player.stamps = getInitialStamps(player.card);
    player.invalidStampCount = 0;
    player.hasWon = false;
  }

  commitControllerState(
    'session_board_reset',
    `Session ${activeSession.id} board reset; called options, winner flags, and non-free stamps cleared.`,
    actor,
    tenantSlug,
    tenantState,
  );

  return {
    ok: true,
    message: 'Board reset complete. Existing cards remain, calls and winner states are cleared.',
  };
}

function refreshInactiveSessionState(
  actor?: AuditActor,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): ChatCommandResult {
  const activeSession = tenantState.activeSession;
  if (!activeSession) {
    return {
      ok: true,
      message: 'Controller is already idle. Enabled option pool is current.',
    };
  }

  if (activeSession.status === 'open' || activeSession.status === 'running') {
    return {
      ok: false,
      message: 'Cannot refresh inactive options while a round is open or running.',
    };
  }

  const previousSessionId = activeSession.id;
  tenantState.activeSession = null;
  tenantState.cardSignatureRegistry.clear();
  tenantState.redeemJoinRecords.clear();
  commitControllerState(
    'session_inactive_refreshed',
    `Session ${previousSessionId} cleared to idle to refresh option pool visibility.`,
    actor,
    tenantSlug,
    tenantState,
  );

  return {
    ok: true,
    message: 'Inactive session cleared. Option pool now reflects enabled items without opening a round.',
  };
}

function continueSessionToBlackout(
  resetWinnerLedger: boolean,
  actor?: AuditActor,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): {
  ok: boolean;
  message: string;
  previousMode?: BingoMode;
  resetWinnerLedgerApplied?: boolean;
} {
  const activeSession = tenantState.activeSession;
  if (!activeSession) {
    return { ok: false, message: 'No active session to continue.' };
  }

  if (activeSession.status === 'idle') {
    return { ok: false, message: 'Only non-idle sessions can continue into blackout.' };
  }

  if (activeSession.mode === 'blackout') {
    return {
      ok: true,
      message: 'Session is already in blackout mode.',
      previousMode: 'blackout',
      resetWinnerLedgerApplied: false,
    };
  }

  const previousMode = activeSession.mode;
  activeSession.mode = 'blackout';
  activeSession.winnerGraceEndsAt = null;
  activeSession.status = activeSession.calledOptions.size > 0 ? 'running' : 'open';

  let resetApplied = false;
  if (resetWinnerLedger) {
    activeSession.winners.clear();
    for (const player of activeSession.players.values()) {
      player.hasWon = false;
    }
    resetApplied = true;
  }

  commitControllerState(
    'session_continued_blackout',
    `Session ${activeSession.id} continued from ${previousMode} to blackout.${resetApplied ? ' Winner ledger reset.' : ''}`,
    actor,
    tenantSlug,
    tenantState,
  );

  return {
    ok: true,
    message: 'Session continued into blackout mode while preserving cards, stamps, and called options.',
    previousMode,
    resetWinnerLedgerApplied: resetApplied,
  };
}

function registerWinnerAndApplySessionRules(
  player: PlayerState,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): {
  winnerCount: number;
  winnerGraceEndsAt: string | null;
  sessionEnded: boolean;
  graceWindowStarted: boolean;
} {
  const activeSession = tenantState.activeSession;
  if (!activeSession) {
    return {
      winnerCount: 0,
      winnerGraceEndsAt: null,
      sessionEnded: false,
      graceWindowStarted: false,
    };
  }

  player.hasWon = true;
  activeSession.winners.add(player.userId);

  const winnerCount = activeSession.winners.size;
  let graceWindowStarted = false;

  if (activeSession.maxWinners <= 1) {
    activeSession.status = 'ended';
    activeSession.winnerGraceEndsAt = null;
    return {
      winnerCount,
      winnerGraceEndsAt: null,
      sessionEnded: true,
      graceWindowStarted,
    };
  }

  if (!activeSession.winnerGraceEndsAt) {
    activeSession.winnerGraceEndsAt = new Date(Date.now() + activeSession.winnerGraceSeconds * 1000).toISOString();
    graceWindowStarted = true;
  }

  if (!strictWinnerGraceWindow && winnerCount >= activeSession.maxWinners) {
    activeSession.status = 'ended';
    activeSession.winnerGraceEndsAt = null;
    return {
      winnerCount,
      winnerGraceEndsAt: null,
      sessionEnded: true,
      graceWindowStarted,
    };
  }

  activeSession.status = 'running';
  return {
    winnerCount,
    winnerGraceEndsAt: activeSession.winnerGraceEndsAt,
    sessionEnded: !strictWinnerGraceWindow && winnerCount >= activeSession.maxWinners,
    graceWindowStarted,
  };
}

function joinSession(
  userId: string,
  userName: string,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): ChatCommandResult {
  finalizeWinnerGraceWindowIfNeeded(tenantSlug, tenantState);

  const activeSession = tenantState.activeSession;

  if (!activeSession || (activeSession.status !== 'open' && activeSession.status !== 'running')) {
    return { ok: false, message: 'Bingo join is not available right now.' };
  }

  const existing = activeSession.players.get(userId);
  if (existing) {
    return {
      ok: true,
      message: `${userName}, you are already in this round. Open your viewer card to continue.`,
    };
  }

  try {
    const card = createRandomCard(activeSession.options, {
      size: 5,
      freeCenter: true,
      sessionId: activeSession.id,
      userId,
      uniquenessSet: tenantState.cardSignatureRegistry,
    });

    const player: PlayerState = {
      userId,
      userName,
      card,
      stamps: getInitialStamps(card),
      invalidStampCount: 0,
      hasWon: false,
    };

    activeSession.players.set(userId, player);
    commitControllerState('player_joined', `${userName} joined active session ${activeSession.id}.`, {
      userId,
      userName,
    }, tenantSlug, tenantState);

    return {
      ok: true,
      message: `${userName} joined bingo. Cards are randomized per player.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Card generation failed.',
    };
  }
}

function callOption(
  optionInput: string,
  actor?: AuditActor,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): ChatCommandResult {
  finalizeWinnerGraceWindowIfNeeded(tenantSlug, tenantState);

  const activeSession = tenantState.activeSession;

  if (!activeSession || (activeSession.status !== 'open' && activeSession.status !== 'running')) {
    return { ok: false, message: 'No active bingo session to call options for.' };
  }

  const option = normalizeOption(optionInput);
  if (!option) {
    return { ok: false, message: 'Usage: !call <option text>' };
  }

  const resolvedOption = activeSession.options.find((entry) => entry.toLowerCase() === option.toLowerCase());
  if (!resolvedOption) {
    return { ok: false, message: 'That option is not in the current bingo pool.' };
  }

  activeSession.calledOptions.add(resolvedOption);
  activeSession.status = 'running';
  commitControllerState('option_called', `Option called: ${resolvedOption}`, actor, tenantSlug, tenantState);

  return {
    ok: true,
    message: `Stamped option unlocked: ${resolvedOption}`,
  };
}

function uncallOption(
  optionInput: string,
  actor?: AuditActor,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): ChatCommandResult {
  finalizeWinnerGraceWindowIfNeeded(tenantSlug, tenantState);

  const activeSession = tenantState.activeSession;

  if (!activeSession || (activeSession.status !== 'open' && activeSession.status !== 'running')) {
    return { ok: false, message: 'No active bingo session to remove called options from.' };
  }

  const option = normalizeOption(optionInput);
  if (!option) {
    return { ok: false, message: 'Usage: !uncall <option text>' };
  }

  const resolvedOption = activeSession.options.find((entry) => entry.toLowerCase() === option.toLowerCase());
  if (!resolvedOption) {
    return { ok: false, message: 'That option is not in the current bingo pool.' };
  }

  if (!activeSession.calledOptions.has(resolvedOption)) {
    return { ok: false, message: 'That option is not currently called.' };
  }

  if (activeSession.winners.size > 0) {
    return { ok: false, message: 'Cannot uncall options after a winner has been recorded for this round.' };
  }

  activeSession.calledOptions.delete(resolvedOption);
  if (activeSession.calledOptions.size === 0) {
    activeSession.status = 'open';
  }

  const resolvedOptionLower = resolvedOption.toLowerCase();
  let revokedStamps = 0;
  let affectedPlayers = 0;

  for (const player of activeSession.players.values()) {
    let revokedForPlayer = 0;

    for (let index = 0; index < player.card.cells.length; index += 1) {
      const cell = player.card.cells[index];
      if (cell.free || cell.value.toLowerCase() !== resolvedOptionLower) {
        continue;
      }

      if (player.stamps.delete(index)) {
        revokedStamps += 1;
        revokedForPlayer += 1;
      }
    }

    if (revokedForPlayer > 0) {
      affectedPlayers += 1;
    }
  }

  commitControllerState(
    'option_uncalled',
    `Option uncalled: ${resolvedOption}. Revoked ${revokedStamps} stamp${revokedStamps === 1 ? '' : 's'} across ${affectedPlayers} player${affectedPlayers === 1 ? '' : 's'}.`,
    actor,
    tenantSlug,
    tenantState,
  );

  return {
    ok: true,
    message: `Removed called option: ${resolvedOption}. Revoked ${revokedStamps} stamp${revokedStamps === 1 ? '' : 's'} across ${affectedPlayers} player${affectedPlayers === 1 ? '' : 's'}.`,
  };
}

function stampByOption(
  userId: string,
  optionInput: string,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): ChatCommandResult {
  finalizeWinnerGraceWindowIfNeeded(tenantSlug, tenantState);

  const activeSession = tenantState.activeSession;

  if (!activeSession || (activeSession.status !== 'open' && activeSession.status !== 'running')) {
    return { ok: false, message: 'Stamping is not available right now.' };
  }

  const player = activeSession.players.get(userId);
  if (!player) {
    return { ok: false, message: 'Join first with !join before stamping.' };
  }

  if (player.hasWon) {
    return { ok: false, message: 'You already have a validated win for this round.' };
  }

  const option = normalizeOption(optionInput);
  if (!option) {
    return { ok: false, message: 'Usage: !stamp <card option text>' };
  }

  const index = player.card.cells.findIndex((cell) => !cell.free && cell.value.toLowerCase() === option.toLowerCase());
  if (index < 0) {
    return { ok: false, message: 'That option is not on your card.' };
  }

  const result = applyStamp(player.card, player.stamps, index, activeSession.calledOptions);
  if (!result.ok) {
    player.invalidStampCount += 1;
    commitControllerState('stamp_rejected', `Stamp rejected for ${player.userName}: ${result.reason ?? 'unknown'}`, {
      userId: player.userId,
      userName: player.userName,
    }, tenantSlug, tenantState);

    if (result.reason === 'already_stamped') {
      return { ok: false, message: 'That square is already stamped.' };
    }

    if (result.reason === 'option_not_called') {
      return { ok: false, message: 'That option has not been called yet.' };
    }

    return { ok: false, message: 'Stamp rejected due to validation rules.' };
  }

  const claimAvailable = checkWin(activeSession.mode, player.card, player.stamps);

  commitControllerState('stamp_accepted', `Stamp accepted for ${player.userName}: ${result.value ?? 'unknown cell'}`, {
    userId: player.userId,
    userName: player.userName,
  }, tenantSlug, tenantState);

  return {
    ok: true,
    message: claimAvailable
      ? `Stamped: ${result.value}. Bingo pattern ready. Use !bingo to claim.`
      : `Stamped: ${result.value}`,
  };
}

function claimBingoByUser(
  userId: string,
  actor?: AuditActor,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): ChatCommandResult {
  finalizeWinnerGraceWindowIfNeeded(tenantSlug, tenantState);

  const activeSession = tenantState.activeSession;

  if (!activeSession || (activeSession.status !== 'open' && activeSession.status !== 'running')) {
    return { ok: false, message: 'Bingo claim is not available right now.' };
  }

  const player = activeSession.players.get(userId);
  if (!player) {
    return { ok: false, message: 'Join first with !join before claiming bingo.' };
  }

  if (player.hasWon) {
    return { ok: true, message: 'Bingo already claimed for this round.' };
  }

  if (activeSession.winners.size >= activeSession.maxWinners) {
    return { ok: false, message: 'Winner cap has been reached for this round.' };
  }

  const validWin = checkWin(activeSession.mode, player.card, player.stamps);
  if (!validWin) {
    return { ok: false, message: 'Current stamped pattern does not satisfy a bingo win yet.' };
  }

  const winnerState = registerWinnerAndApplySessionRules(player, tenantSlug, tenantState);
  commitControllerState(
    'player_won',
    `${player.userName} achieved bingo in ${activeSession.mode} mode via explicit claim.`,
    actor,
    tenantSlug,
    tenantState,
  );

  if (winnerState.sessionEnded) {
    commitControllerState(
      'session_ended',
      `Winner cap reached (${winnerState.winnerCount}/${activeSession.maxWinners}). Round ended.`,
      actor,
      tenantSlug,
      tenantState,
    );
  }

  return {
    ok: true,
    message: winnerState.sessionEnded
      ? `${player.userName} claimed bingo. Winner cap reached, round ended.`
      : winnerState.graceWindowStarted
        ? `${player.userName} claimed bingo. Grace window started for additional winners.`
        : `${player.userName} claimed bingo in ${activeSession.mode} mode!`,
  };
}

function setOptionPool(
  raw: string,
  actor?: AuditActor,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): ChatCommandResult {
  const split = raw
    .split('|')
    .map(normalizeOption)
    .filter(Boolean);

  const unique = [...new Set(split)];
  if (unique.length < minOptionsForFiveByFive) {
    return {
      ok: false,
      message: `Need at least ${minOptionsForFiveByFive} unique options in pool.`,
    };
  }

  tenantState.optionPool = createOptionPoolFromLabels(unique, tenantState.optionPool);
  commitControllerState(
    'option_pool_replaced',
    `Option pool replaced with ${tenantState.optionPool.length} entries.`,
    actor,
    tenantSlug,
    tenantState,
  );
  return {
    ok: true,
    message: `Option pool replaced. Current size: ${tenantState.optionPool.length} (${getEnabledOptionLabels(tenantState.optionPool).length} enabled).`,
  };
}

function addOption(
  option: string,
  actor?: AuditActor,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): ChatCommandResult {
  const normalized = normalizeOption(option);
  if (!normalized) {
    return { ok: false, message: 'Usage: !options add <option text>' };
  }

  const existing = findOptionByLabel(normalized, tenantState);
  if (existing) {
    if (existing.enabled) {
      return { ok: false, message: 'Option already exists in pool.' };
    }

    const now = new Date().toISOString();
    tenantState.optionPool = tenantState.optionPool.map((item) =>
      item.id === existing.id
        ? {
            ...item,
            enabled: true,
            updatedAt: now,
          }
        : item,
    );

    commitControllerState('option_pool_enabled', `Option enabled in pool: ${existing.label}`, actor, tenantSlug, tenantState);
    return {
      ok: true,
      message: `Enabled option. Current size: ${tenantState.optionPool.length} (${getEnabledOptionLabels(tenantState.optionPool).length} enabled).`,
    };
  }

  const usedIds = new Set(tenantState.optionPool.map((item) => item.id));
  tenantState.optionPool = [...tenantState.optionPool, createOptionItem(normalized, usedIds)];
  commitControllerState('option_pool_added', `Option added to pool: ${normalized}`, actor, tenantSlug, tenantState);
  return {
    ok: true,
    message: `Added option. Current size: ${tenantState.optionPool.length} (${getEnabledOptionLabels(tenantState.optionPool).length} enabled).`,
  };
}

function removeOption(
  option: string,
  actor?: AuditActor,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): ChatCommandResult {
  const normalized = normalizeOption(option);
  if (!normalized) {
    return { ok: false, message: 'Usage: !options remove <option text>' };
  }

  const existing = findOptionByLabel(normalized, tenantState);
  if (!existing) {
    return { ok: false, message: 'Option not found in pool.' };
  }

  const enabledCount = getEnabledOptionLabels(tenantState.optionPool).length;
  if (existing.enabled && enabledCount - 1 < minOptionsForFiveByFive) {
    return {
      ok: false,
      message: `Cannot remove. Pool must keep at least ${minOptionsForFiveByFive} enabled options.`,
    };
  }

  tenantState.optionPool = tenantState.optionPool.filter((item) => item.id !== existing.id);
  commitControllerState('option_pool_removed', `Option removed from pool: ${normalized}`, actor, tenantSlug, tenantState);
  return {
    ok: true,
    message: `Removed option. Current size: ${tenantState.optionPool.length} (${getEnabledOptionLabels(tenantState.optionPool).length} enabled).`,
  };
}

function handleOptionsCommand(
  ctx: ChatCommandContext,
  args: string[],
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): ChatCommandResult {
  const modError = assertMod(ctx);
  if (modError) {
    return modError;
  }

  const action = (args[0] ?? '').toLowerCase();
  const payload = args.slice(1).join(' ').trim();

  if (action === 'list') {
    const labels = tenantState.optionPool.map((item) => `${item.label}${item.enabled ? '' : ' (disabled)'}`);
    return {
      ok: true,
      message: `Option pool (${tenantState.optionPool.length} total, ${getEnabledOptionLabels(tenantState.optionPool).length} enabled): ${labels.join(' | ')}`,
    };
  }

  if (action === 'set') {
    return setOptionPool(payload, ctx, tenantSlug, tenantState);
  }

  if (action === 'add') {
    return addOption(payload, ctx, tenantSlug, tenantState);
  }

  if (action === 'remove') {
    return removeOption(payload, ctx, tenantSlug, tenantState);
  }

  return {
    ok: false,
    message: 'Usage: !options list | !options set a|b|c | !options add <text> | !options remove <text>',
  };
}

function executeChatCommand(
  commandText: string,
  ctx: ChatCommandContext,
  tenantSlug: string = defaultTenantSlug,
  tenantState: TenantRuntimeState = getTenantRuntimeState(tenantSlug),
): ChatCommandResult {
  finalizeWinnerGraceWindowIfNeeded(tenantSlug, tenantState);

  const trimmed = commandText.trim();
  if (!trimmed.startsWith('!')) {
    return { ok: false, message: 'Not a command.' };
  }

  const [rawCommand, ...args] = trimmed.slice(1).split(/\s+/g);
  const command = rawCommand?.toLowerCase() ?? '';

  if (command === 'join') {
    return joinSession(ctx.userId, ctx.userName, tenantSlug, tenantState);
  }

  if (command === 'stamp') {
    return stampByOption(ctx.userId, args.join(' '), tenantSlug, tenantState);
  }

  if (command === 'card') {
    return {
      ok: true,
      message: `${ctx.userName}, use your secure viewer redeem link to open your card.`,
    };
  }

  if (command === 'bingo') {
    return claimBingoByUser(ctx.userId, {
      userId: ctx.userId,
      userName: ctx.userName,
    }, tenantSlug, tenantState);
  }

  if (command === 'options') {
    return handleOptionsCommand(ctx, args, tenantSlug, tenantState);
  }

  const modError = assertMod(ctx);
  if (modError) {
    return modError;
  }

  if (command === 'start' && args[0]?.toLowerCase() === 'bingo') {
    const rawMode = args[1];
    const rawModeNormalized = rawMode?.toLowerCase();
    const hasModeArg = rawModeNormalized
      ? ['normal', 'rows', 'corners', 'blackout', 'postage'].includes(rawModeNormalized)
      : false;

    const mode = hasModeArg ? rawMode : undefined;
    const rawMaxWinners = hasModeArg ? args[2] : args[1];
    const parsedMaxWinners = Number(rawMaxWinners);
    const maxWinners = Number.isFinite(parsedMaxWinners) ? parsedMaxWinners : undefined;
    const rawWinnerGrace = hasModeArg ? args[3] : args[2];
    const parsedWinnerGrace = Number(rawWinnerGrace);
    const winnerGraceSeconds = Number.isFinite(parsedWinnerGrace) ? parsedWinnerGrace : undefined;

    return startSession(mode, getEnabledOptionLabels(tenantState.optionPool), maxWinners, winnerGraceSeconds, ctx, tenantSlug, tenantState);
  }

  if (command === 'reset' && args[0]?.toLowerCase() === 'board') {
    return resetCurrentSessionBoard(ctx, tenantSlug, tenantState);
  }

  if (command === 'stop' && args[0]?.toLowerCase() === 'bingo') {
    return stopSession(true, ctx, tenantSlug, tenantState);
  }

  if (command === 'call') {
    return callOption(args.join(' '), ctx, tenantSlug, tenantState);
  }

  if (command === 'uncall') {
    return uncallOption(args.join(' '), ctx, tenantSlug, tenantState);
  }

  return { ok: false, message: 'Unknown command.' };
}

function createTwitchClient() {
  const username = process.env.TWITCH_BOT_USERNAME?.trim();
  const oauth = process.env.TWITCH_BOT_OAUTH?.trim();

  if (!username || !oauth) {
    console.log('[twitch] chat bridge disabled (missing TWITCH_BOT_USERNAME or TWITCH_BOT_OAUTH)');
    return;
  }

  const channelsFromEnv = process.env.TWITCH_CHANNELS?.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean) ?? [];
  const fallbackChannel = process.env.TWITCH_CHANNEL?.trim().toLowerCase();
  const channels = channelsFromEnv.length > 0 ? channelsFromEnv : fallbackChannel ? [fallbackChannel] : [];

  if (channels.length === 0) {
    console.log('[twitch] chat bridge disabled (no TWITCH_CHANNEL or TWITCH_CHANNELS configured)');
    return;
  }

  const identityPassword = oauth.startsWith('oauth:') ? oauth : `oauth:${oauth}`;

  const client = new tmi.Client({
    identity: {
      username,
      password: identityPassword,
    },
    channels,
    options: {
      skipMembership: true,
      messagesLogLevel: 'warn',
    },
    connection: {
      reconnect: true,
      secure: true,
    },
  });

  client.on('message', async (channel, tags, message, self) => {
    if (self || !message.startsWith('!')) {
      return;
    }

    const userId = tags['user-id'];
    const userName = tags['display-name'] ?? tags.username;

    if (!userId || !userName) {
      return;
    }

    const isMod = Boolean(tags.mod) || tags.badges?.broadcaster === '1';

    const result = executeChatCommand(message, {
      userId,
      userName,
      isMod,
      reply: (text) => {
        void client.say(channel, text);
      },
    });

    if (result.message && result.ok) {
      await client.say(channel, result.message);
    }

    if (result.message && !result.ok && isMod) {
      await client.say(channel, `Command rejected: ${result.message}`);
    }
  });

  client.on('connected', (address, chatPort) => {
    console.log(`[twitch] connected to ${address}:${chatPort} (${channels.join(', ')})`);
  });

  client
    .connect()
    .then(() => {
      console.log('[twitch] chat bridge ready');
    })
    .catch((error) => {
      console.error('[twitch] failed to connect:', error);
    });
}

getDefaultTenantRuntimeState();

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'controller', timestamp: new Date().toISOString() });
});

app.get('/api/tenancy', (req, res) => {
  const tenant = getTenantContext(req);
  res.json({
    ok: true,
    multiTenantEnabled,
    legacySingleTenantFallback,
    defaultTenantSlug,
    tenant,
  });
});

app.get('/api/session', (req, res) => {
  const tenantState = getTenantRuntimeStateFromRequest(req);
  const activeSession = tenantState.activeSession;
  if (!activeSession) {
    res.json({
      status: 'idle' as SessionStatus,
      theme: resolveThemeState(tenantState.themeState),
    });
    return;
  }

  res.json(toSessionSummary(activeSession, tenantState));
});

app.get('/api/options', (req, res) => {
  const tenantState = getTenantRuntimeStateFromRequest(req);
  const activeSession = tenantState.activeSession;
  const options = activeSession ? [...activeSession.options] : getEnabledOptionLabels(tenantState.optionPool);
  res.json({
    count: options.length,
    options,
  });
});

app.get('/api/overlay/winner-card', (req, res) => {
  const tenantState = getTenantRuntimeStateFromRequest(req);
  const activeSession = tenantState.activeSession;
  if (!activeSession) {
    res.json({ ok: true, player: null, players: [], session: { status: 'idle' as SessionStatus } });
    return;
  }

  const session = activeSession;

  const players = [...session.winners]
    .map((winnerUserId) => session.players.get(winnerUserId) ?? null)
    .filter((player): player is PlayerState => player !== null)
    .map((player) => toPlayerView(player));

  const player = players[0] ?? null;
  res.json({
    ok: true,
    player,
    players,
    session: toSessionSummary(session, tenantState),
  });
});

app.get('/api/owner/auth/twitch/start', (req, res) => {
  const missing = getOwnerAuthConfigErrors();
  if (missing.length > 0) {
    res.status(503).json({
      error: 'owner_auth_not_configured',
      missing,
    });
    return;
  }

  const returnTo = resolveRequestedOwnerReturnTo(req);
  const state = createOwnerOauthState(returnTo);

  const authUrl = new URL('https://id.twitch.tv/oauth2/authorize');
  authUrl.searchParams.set('client_id', twitchClientId);
  authUrl.searchParams.set('redirect_uri', ownerAuthTwitchRedirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', state);
  if (ownerAuthOauthScope) {
    authUrl.searchParams.set('scope', ownerAuthOauthScope);
  }

  appendAuditEvent('owner_auth_start', 'Owner initiated Twitch sign-in flow.');
  res.redirect(302, authUrl.toString());
});

app.get('/api/owner/auth/twitch/callback', async (req, res) => {
  const code = String(req.query.code ?? '').trim();
  const state = String(req.query.state ?? '').trim();
  const oauthError = String(req.query.error ?? '').trim().toLowerCase();
  if (!state) {
    res.status(400).json({ error: 'invalid_oauth_callback' });
    return;
  }

  const pending = consumeOwnerOauthState(state);
  if (!pending) {
    res.status(400).json({ error: 'invalid_oauth_state' });
    return;
  }

  if (!code) {
    const callbackError = resolveOauthCallbackError(oauthError);
    appendAuditEvent('owner_auth_failed', `Owner auth callback failed (${callbackError}).`);

    respondOwnerAuthCallbackError(res, pending, callbackError);
    return;
  }

  const missing = getOwnerAuthConfigErrors();
  if (missing.length > 0) {
    res.status(503).json({
      error: 'owner_auth_not_configured',
      missing,
    });
    return;
  }

  await completeOwnerAuthFromOauthCode(code, pending, res);
  return;
});

app.get('/api/owner/auth/me', (req, res) => {
  const result = resolveOwnerAccess(req);
  if (result.ok) {
    res.json({
      ok: true,
      authenticated: true,
      authorized: true,
      tokenSource: result.context.source,
      user: {
        userId: result.context.userId,
        userLogin: result.context.userLogin,
        userName: result.context.userName,
      },
    });
    return;
  }

  if (result.error === 'invalid_owner_session') {
    clearOwnerAuthCookie(res);
  }

  if (result.status === 503) {
    res.status(503).json({
      error: result.error,
      authenticated: false,
      authorized: false,
      missing: result.missingConfig ?? [],
    });
    return;
  }

  if (result.status === 403) {
    res.status(403).json({
      error: result.error,
      authenticated: true,
      authorized: false,
      user: {
        userId: result.userId,
        userLogin: result.userLogin,
        userName: result.userName,
      },
    });
    return;
  }

  res.status(401).json({
    error: result.error,
    authenticated: false,
    authorized: false,
  });
});

app.post('/api/owner/auth/logout', (req, res) => {
  const current = resolveOwnerAccess(req);
  clearOwnerAuthCookie(res);

  if (current.ok) {
    appendAuditEvent('owner_auth_logout', `Owner signed out: ${current.context.userName}.`, {
      userId: current.context.userId,
      userName: current.context.userName,
    });
  } else {
    appendAuditEvent('owner_auth_logout', 'Owner sign-out endpoint invoked.');
  }

  res.json({ ok: true });
});

app.get('/api/owner/tenants', async (req, res) => {
  if (!ensureOwnerAccess(req, res)) {
    return;
  }
  const enrichedTenants = await resolveOwnerTenantRecords();

  res.json({
    ok: true,
    count: enrichedTenants.length,
    defaultTenantSlug,
    legacyInternalRedeemSecretEnabled,
    setupEntryCount: streamerSetupEntryRegistry.size,
    tenants: enrichedTenants,
  });
});

app.post('/api/owner/tenants/upsert', (req, res) => {
  if (!ensureOwnerAccess(req, res)) {
    return;
  }

  const parsed = tenantBroadcasterUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_tenant_broadcaster_payload', details: parsed.error.flatten() });
    return;
  }

  const normalizedTenantSlug = parseTenantSlugFromRoute(parsed.data.tenantSlug);
  if (!normalizedTenantSlug) {
    res.status(400).json({
      error: 'invalid_tenant_slug',
      message: 'Tenant slugs must use lowercase letters, numbers, and hyphens.',
    });
    return;
  }

  const broadcasterId = parsed.data.broadcasterId.trim();
  if (!broadcasterId) {
    res.status(400).json({
      error: 'invalid_broadcaster_id',
      message: 'Broadcaster id is required.',
    });
    return;
  }

  const owner = resolveOwnerAccess(req);
  const actor = owner.ok ? { userId: owner.context.userId, userName: owner.context.userName } : undefined;

  try {
    const registration = setTenantBroadcasterRegistration(normalizedTenantSlug, broadcasterId);
    const tenantState = getTenantRuntimeState(registration.tenantSlug);
    appendAuditEvent(
      'tenant_broadcaster_updated',
      `Owner mapped tenant ${registration.tenantSlug} to broadcaster ${registration.broadcasterId}.`,
      actor,
      tenantState,
    );

    res.json({
      ok: true,
      tenantSlug: registration.tenantSlug,
      broadcasterId: registration.broadcasterId,
      previousBroadcasterId: registration.previousBroadcasterId,
      updated: registration.updated,
      source: 'persisted',
    });
  } catch (error) {
    const message = resolveTenantMutationErrorCode(error, 'tenant_broadcaster_update_failed');
    const status = resolveTenantMutationErrorStatus(error);
    res.status(status).json({ error: message });
  }
});

app.post('/api/owner/tenants/resolve-user', async (req, res) => {
  if (!ensureOwnerAccess(req, res)) {
    return;
  }

  const parsed = ownerTenantResolveUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_owner_resolve_user_payload', details: parsed.error.flatten() });
    return;
  }

  try {
    const resolved = await resolveTwitchUserByLogin(parsed.data.login);
    if (!resolved) {
      res.status(404).json({ error: 'twitch_user_not_found' });
      return;
    }

    res.json({
      ok: true,
      user: {
        userId: resolved.userId,
        userLogin: resolved.userLogin,
        userName: resolved.userName,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'twitch_user_lookup_failed';
    res.status(400).json({ error: message });
  }
});

app.post('/api/owner/tenants/redeem-key/rotate', (req, res) => {
  if (!ensureOwnerAccess(req, res)) {
    return;
  }

  const parsed = ownerTenantRedeemKeyRotateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_owner_rotate_key_payload', details: parsed.error.flatten() });
    return;
  }

  const owner = resolveOwnerAccess(req);
  const actor = owner.ok ? { userId: owner.context.userId, userName: owner.context.userName } : undefined;

  try {
    const rotated = rotateTenantRedeemKey(parsed.data.tenantSlug);
    const tenantState = getTenantRuntimeState(rotated.tenantSlug);
    appendAuditEvent(
      'tenant_redeem_key_rotated',
      `Owner rotated tenant redeem key for ${rotated.tenantSlug}.`,
      actor,
      tenantState,
    );

    res.json({
      ok: true,
      tenantSlug: rotated.tenantSlug,
      redeemKey: rotated.redeemKey,
      rotatedAt: rotated.rotatedAt,
      created: rotated.created,
      legacyInternalRedeemSecretEnabled,
    });
  } catch (error) {
    const message = resolveTenantMutationErrorCode(error, 'tenant_redeem_key_rotate_failed');
    const status = resolveTenantMutationErrorStatus(error);
    res.status(status).json({ error: message });
  }
});

app.post('/api/owner/setup/generate', async (req, res) => {
  if (!ensureOwnerAccess(req, res)) {
    return;
  }

  const parsed = ownerSetupGenerateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_owner_setup_generate_payload', details: parsed.error.flatten() });
    return;
  }

  const tenantSlug = parseTenantSlugFromRoute(parsed.data.tenantSlug);
  if (!tenantSlug) {
    res.status(400).json({
      error: 'invalid_tenant_slug',
      message: 'Tenant slugs must use lowercase letters, numbers, and hyphens.',
    });
    return;
  }

  const tenants = await resolveOwnerTenantRecords();
  const tenant = tenants.find((candidate) => candidate.tenantSlug === tenantSlug);
  if (!tenant) {
    res.status(404).json({ error: 'tenant_not_found' });
    return;
  }

  const generatedAt = new Date().toISOString();
  const block = buildMixItUpSetupBlock(
    tenantSlug,
    toSetupBroadcasterLabel(tenant.broadcasterUserName, tenant.broadcasterUserLogin),
    req,
  );
  const savedEntry = streamerSetupEntryRegistry.get(tenantSlug) ?? null;

  res.json({
    ok: true,
    tenantSlug,
    generatedAt,
    broadcasterLabel: block.broadcasterLabel,
    overlayUrl: block.overlayUrl,
    controllerUrl: block.controllerUrl,
    joinUrl: block.joinUrl,
    authorizationHeaderValue: block.authorizationHeaderValue,
    requestBody: block.requestBody,
    setupBlock: block.setupBlock,
    saved: Boolean(savedEntry),
    savedAt: savedEntry?.updatedAt ?? null,
    totalEntries: streamerSetupEntryRegistry.size,
  });
});

app.post('/api/owner/setup/entries/upsert', async (req, res) => {
  if (!ensureOwnerAccess(req, res)) {
    return;
  }

  const parsed = ownerSetupEntryUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_owner_setup_entry_payload', details: parsed.error.flatten() });
    return;
  }

  const tenantSlug = parseTenantSlugFromRoute(parsed.data.tenantSlug);
  if (!tenantSlug) {
    res.status(400).json({
      error: 'invalid_tenant_slug',
      message: 'Tenant slugs must use lowercase letters, numbers, and hyphens.',
    });
    return;
  }

  const tenants = await resolveOwnerTenantRecords();
  const tenant = tenants.find((candidate) => candidate.tenantSlug === tenantSlug) ?? null;
  if (!tenant) {
    res.status(404).json({ error: 'tenant_not_found' });
    return;
  }

  const owner = resolveOwnerAccess(req);
  const actor = owner.ok ? { userId: owner.context.userId, userName: owner.context.userName } : undefined;

  try {
    const upserted = upsertStreamerSetupEntry({
      tenantSlug,
      broadcasterUserName: tenant.broadcasterUserName,
      broadcasterUserLogin: tenant.broadcasterUserLogin,
    });
    const block = buildMixItUpSetupBlock(
      tenantSlug,
      toSetupBroadcasterLabel(tenant.broadcasterUserName, tenant.broadcasterUserLogin),
      req,
    );

    if (!upserted.unchanged) {
      const tenantState = getTenantRuntimeState(tenantSlug);
      appendAuditEvent(
        'tenant_setup_export_saved',
        `Owner saved setup export block for ${tenantSlug} (${upserted.created ? 'created' : 'updated'}).`,
        actor,
        tenantState,
      );
    }

    res.json({
      ok: true,
      tenantSlug,
      created: upserted.created,
      updated: upserted.updated,
      unchanged: upserted.unchanged,
      totalEntries: upserted.totalEntries,
      savedAt: upserted.entry.updatedAt,
      setupBlock: block.setupBlock,
      overlayUrl: block.overlayUrl,
      controllerUrl: block.controllerUrl,
      joinUrl: block.joinUrl,
      authorizationHeaderValue: block.authorizationHeaderValue,
      requestBody: block.requestBody,
    });
  } catch (error) {
    const message = resolveTenantMutationErrorCode(error, 'streamer_setup_entry_upsert_failed');
    const status = resolveTenantMutationErrorStatus(error);
    res.status(status).json({ error: message });
  }
});

app.post('/api/owner/setup/export/regenerate', async (req, res) => {
  if (!ensureOwnerAccess(req, res)) {
    return;
  }

  const parsed = ownerSetupRegenerateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_owner_setup_regenerate_payload', details: parsed.error.flatten() });
    return;
  }

  const includeAllKnownTenants = Boolean(parsed.data.includeAllKnownTenants);
  const { entries, blocks } = await buildSetupBlocksFromEntries(req, includeAllKnownTenants);
  if (blocks.length === 0) {
    res.status(400).json({
      error: 'streamer_setup_entries_empty',
      message: 'Save at least one tenant block before regenerating the streamer reference sheet.',
    });
    return;
  }

  const generatedAtNow = new Date().toISOString();
  let generatedAt = generatedAtNow;
  let markdown = renderStreamerSetupMarkdown(blocks, generatedAtNow);
  if (fs.existsSync(streamerSetupMarkdownFilePath)) {
    try {
      const existingMarkdown = fs.readFileSync(streamerSetupMarkdownFilePath, 'utf8');
      const existingNormalized = normalizeStreamerSetupMarkdownForDiff(existingMarkdown);
      const nextNormalized = normalizeStreamerSetupMarkdownForDiff(markdown);

      if (existingNormalized === nextNormalized) {
        const previousGeneratedAt = extractGeneratedAtFromStreamerSetupMarkdown(existingMarkdown);
        if (previousGeneratedAt) {
          generatedAt = previousGeneratedAt;
          markdown = renderStreamerSetupMarkdown(blocks, generatedAt);
        }
      }
    } catch {
      // Ignore existing-file parse errors and continue with current timestamp.
    }
  }
  const html = renderStreamerSetupHtml(markdown, generatedAt);
  const pdf = createSimplePdfBuffer('MixItUp Streamer Setup Reference', markdown.split(/\r?\n/));

  let regenerateResult: {
    changed: boolean;
    markdownWritten: boolean;
    htmlWritten: boolean;
    pdfWritten: boolean;
  };
  try {
    regenerateResult = regenerateStreamerSetupArtifacts(markdown, html, pdf);
  } catch (error) {
    const message = resolveTenantMutationErrorCode(error, 'streamer_setup_export_regenerate_failed');
    const status = resolveTenantMutationErrorStatus(error);
    res.status(status).json({ error: message });
    return;
  }

  const markdownMeta = readOptionalFileMetadata(streamerSetupMarkdownFilePath);
  const htmlMeta = readOptionalFileMetadata(streamerSetupHtmlFilePath);
  const pdfMeta = readOptionalFileMetadata(streamerSetupPdfFilePath);

  res.json({
    ok: true,
    generatedAt,
    count: blocks.length,
    entryCount: entries.length,
    includeAllKnownTenants,
    changed: regenerateResult.changed,
    markdownWritten: regenerateResult.markdownWritten,
    htmlWritten: regenerateResult.htmlWritten,
    pdfWritten: regenerateResult.pdfWritten,
    markdown: {
      exists: markdownMeta.exists,
      size: markdownMeta.size,
      updatedAt: markdownMeta.updatedAt,
      downloadUrl: '/api/owner/setup/export/markdown',
    },
    html: {
      exists: htmlMeta.exists,
      size: htmlMeta.size,
      updatedAt: htmlMeta.updatedAt,
      downloadUrl: '/api/owner/setup/export/html',
    },
    pdf: {
      exists: pdfMeta.exists,
      size: pdfMeta.size,
      updatedAt: pdfMeta.updatedAt,
      downloadUrl: '/api/owner/setup/export/pdf',
    },
  });
});

app.post('/api/owner/setup/export/single', async (req, res) => {
  if (!ensureOwnerAccess(req, res)) {
    return;
  }

  const parsed = ownerSetupSingleExportSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_owner_setup_single_export_payload', details: parsed.error.flatten() });
    return;
  }

  const tenantSlug = parseTenantSlugFromRoute(parsed.data.tenantSlug);
  if (!tenantSlug) {
    res.status(400).json({
      error: 'invalid_tenant_slug',
      message: 'Tenant slugs must use lowercase letters, numbers, and hyphens.',
    });
    return;
  }

  const tenants = await resolveOwnerTenantRecords();
  const tenant = tenants.find((candidate) => candidate.tenantSlug === tenantSlug) ?? null;
  if (!tenant) {
    res.status(404).json({ error: 'tenant_not_found' });
    return;
  }

  const generatedAt = new Date().toISOString();
  const block = buildMixItUpSetupBlock(
    tenantSlug,
    toSetupBroadcasterLabel(tenant.broadcasterUserName, tenant.broadcasterUserLogin),
    req,
  );
  const markdown = renderStreamerSetupMarkdown([block], generatedAt);
  const attachmentBaseName = `MixItUp-Streamer-Setup-Reference-${tenantSlug}`;

  if (parsed.data.format === 'markdown') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${attachmentBaseName}.md"`);
    res.send(markdown);
    return;
  }

  if (parsed.data.format === 'html') {
    const html = renderStreamerSetupHtml(markdown, generatedAt);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${attachmentBaseName}.html"`);
    res.send(html);
    return;
  }

  const pdf = createSimplePdfBuffer('MixItUp Streamer Setup Reference', markdown.split(/\r?\n/));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${attachmentBaseName}.pdf"`);
  res.send(pdf);
});

app.get('/api/owner/setup/export/markdown', (req, res) => {
  if (!ensureOwnerAccess(req, res)) {
    return;
  }

  if (!fs.existsSync(streamerSetupMarkdownFilePath)) {
    res.status(404).json({ error: 'streamer_setup_markdown_missing' });
    return;
  }

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="MixItUp-Streamer-Setup-Reference-Sheet.md"');
  res.send(fs.readFileSync(streamerSetupMarkdownFilePath, 'utf8'));
});

app.get('/api/owner/setup/export/html', (req, res) => {
  if (!ensureOwnerAccess(req, res)) {
    return;
  }

  if (!fs.existsSync(streamerSetupHtmlFilePath)) {
    res.status(404).json({ error: 'streamer_setup_html_missing' });
    return;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="MixItUp-Streamer-Setup-Reference-Sheet.html"');
  res.send(fs.readFileSync(streamerSetupHtmlFilePath, 'utf8'));
});

app.get('/api/owner/setup/export/pdf', (req, res) => {
  if (!ensureOwnerAccess(req, res)) {
    return;
  }

  if (!fs.existsSync(streamerSetupPdfFilePath)) {
    res.status(404).json({ error: 'streamer_setup_pdf_missing' });
    return;
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="MixItUp-Streamer-Setup-Reference-Sheet.pdf"');
  res.send(fs.readFileSync(streamerSetupPdfFilePath));
});

app.post('/api/owner/tenants/remove', (req, res) => {
  if (!ensureOwnerAccess(req, res)) {
    return;
  }

  const parsed = ownerTenantRemoveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_owner_remove_tenant_payload', details: parsed.error.flatten() });
    return;
  }

  const owner = resolveOwnerAccess(req);
  const actor = owner.ok ? { userId: owner.context.userId, userName: owner.context.userName } : undefined;
  const removeRedeemKey = Boolean(parsed.data.removeRedeemKey);

  try {
    const removed = removeTenantArtifactsForSlug(parsed.data.tenantSlug, { removeRedeemKey });
    const tenantState = tenantRuntimeStates.get(removed.tenantSlug);
    if (tenantState) {
      appendAuditEvent(
        'tenant_removed',
        `Owner removed tenant mapping for ${removed.tenantSlug} (mapping=${removed.removedBroadcasterMapping ? 'yes' : 'no'}, key=${removed.removedRedeemKey ? 'yes' : 'no'}, setup=${removed.removedSetupEntry ? 'yes' : 'no'}).`,
        actor,
        tenantState,
      );
    }

    res.json({
      ok: true,
      tenantSlug: removed.tenantSlug,
      source: removed.source,
      removedBroadcasterMapping: removed.removedBroadcasterMapping,
      removedRedeemKey: removed.removedRedeemKey,
      removedSetupEntry: removed.removedSetupEntry,
      removeRedeemKeyRequested: removeRedeemKey,
      totalEntries: streamerSetupEntryRegistry.size,
    });
  } catch (error) {
    const message = resolveTenantMutationErrorCode(error, 'tenant_remove_failed');
    if (message === 'tenant_source_env_managed') {
      res.status(409).json({
        error: message,
        message: 'This tenant is managed by TENANT_BROADCASTER_OVERRIDES and cannot be removed from runtime persistence.',
      });
      return;
    }

    const status = resolveTenantMutationErrorStatus(error);
    res.status(status).json({ error: message });
  }
});

app.get('/api/mod/auth/twitch/start', (req, res) => {
  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeStateFromRequest(req);
  const missing = getModAuthConfigErrors(tenantContext.slug, {
    allowMissingBroadcaster: tenantBroadcasterAutoRegister,
  });
  if (missing.length > 0) {
    res.status(503).json({
      error: 'mod_auth_not_configured',
      missing,
      allowLegacyToken: modAuthAllowLegacyToken,
    });
    return;
  }

  const returnTo = resolveRequestedModReturnTo(req);
  const state = createModOauthState(returnTo, tenantState);

  const authUrl = new URL('https://id.twitch.tv/oauth2/authorize');
  authUrl.searchParams.set('client_id', twitchClientId);
  authUrl.searchParams.set('redirect_uri', twitchModRedirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('scope', twitchModOauthScope);

  appendAuditEvent('mod_auth_start', 'Moderator initiated Twitch sign-in flow.', undefined, tenantState);
  res.redirect(302, authUrl.toString());
});

app.get('/api/mod/auth/twitch/callback', async (req, res) => {
  let tenantContext = getTenantContext(req);
  let tenantState = getTenantRuntimeState(tenantContext.slug);

  const code = String(req.query.code ?? '').trim();
  const state = String(req.query.state ?? '').trim();
  const oauthError = String(req.query.error ?? '').trim().toLowerCase();
  if (!state) {
    res.status(400).json({ error: 'invalid_oauth_callback' });
    return;
  }

  let pending = consumeModOauthState(state, tenantState);
  if (!pending) {
    const resolved = consumeModOauthStateAcrossTenants(state);
    if (resolved) {
      tenantContext = {
        slug: resolved.tenantSlug,
        source: 'tenant-route',
        isDefaultTenant: resolved.tenantSlug === defaultTenantSlug,
      };
      tenantState = getTenantRuntimeState(resolved.tenantSlug);
      pending = resolved.pending;
    }
  }

  if (!pending) {
    const ownerPending = consumeOwnerOauthState(state);
    if (ownerPending) {
      if (!code) {
        const callbackError = resolveOauthCallbackError(oauthError);
        appendAuditEvent('owner_auth_failed', `Owner auth callback failed (${callbackError}).`);
        respondOwnerAuthCallbackError(res, ownerPending, callbackError);
        return;
      }

      const ownerMissing = getOwnerAuthConfigErrors();
      if (ownerMissing.length > 0) {
        res.status(503).json({
          error: 'owner_auth_not_configured',
          missing: ownerMissing,
        });
        return;
      }

      await completeOwnerAuthFromOauthCode(code, ownerPending, res);
      return;
    }

    res.status(400).json({ error: 'invalid_oauth_state' });
    return;
  }

  if (!code) {
    const callbackError = resolveOauthCallbackError(oauthError);
    appendAuditEvent('mod_auth_failed', `Moderator auth callback failed (${callbackError}).`, undefined, tenantState);

    if (pending.returnTo) {
      res.redirect(302, buildModAuthReturnUrl(pending.returnTo, callbackError));
      return;
    }

    res.status(400).json({ error: callbackError });
    return;
  }

  const missing = getModAuthConfigErrors(tenantContext.slug, {
    allowMissingBroadcaster: tenantBroadcasterAutoRegister,
  });
  if (missing.length > 0) {
    res.status(503).json({
      error: 'mod_auth_not_configured',
      missing,
      allowLegacyToken: modAuthAllowLegacyToken,
    });
    return;
  }

  try {
    const accessToken = await requestTwitchAccessToken(code, twitchModRedirectUri);
    const identity = await resolveTwitchIdentity(accessToken);
    let expectedBroadcasterId = resolveExpectedBroadcasterIdForTenant(tenantContext.slug);
    if (!expectedBroadcasterId && tenantBroadcasterAutoRegister) {
      const registration = setTenantBroadcasterRegistration(tenantContext.slug, identity.userId);
      expectedBroadcasterId = registration.broadcasterId;
      if (registration.updated) {
        appendAuditEvent(
          'tenant_broadcaster_registered',
          `Registered broadcaster ${registration.broadcasterId} for tenant ${registration.tenantSlug}.`,
          { userId: identity.userId, userName: identity.userName },
          tenantState,
        );
      }
    }

    if (!expectedBroadcasterId) {
      res.status(503).json({
        error: 'mod_auth_not_configured',
        missing: getModAuthConfigErrors(tenantContext.slug),
        allowLegacyToken: modAuthAllowLegacyToken,
      });
      return;
    }

    const role = await resolveTwitchModRoleForBroadcaster(accessToken, identity.userId, expectedBroadcasterId);
    const userName = sanitizeUserName(identity.userName, identity.userLogin || identity.userId);

    const modSessionToken = createModAuthSessionToken({
      tenantSlug: tenantContext.slug,
      broadcasterId: expectedBroadcasterId,
      userId: identity.userId,
      userLogin: identity.userLogin,
      userName,
      role,
    });

    setModAuthCookie(res, modSessionToken);

    if (role === 'unauthorized') {
      commitControllerState(
        'mod_auth_denied',
        `Twitch user ${userName} authenticated but is not broadcaster/moderator for ${expectedBroadcasterId}.`,
        { userId: identity.userId, userName },
        tenantContext.slug,
        tenantState,
      );

      if (pending.returnTo) {
        res.redirect(302, buildModAuthReturnUrl(pending.returnTo, 'not_moderator'));
        return;
      }

      res.status(403).json({
        error: 'mod_privileges_required',
        authenticated: true,
        role,
        user: {
          userId: identity.userId,
          userLogin: identity.userLogin,
          userName,
        },
      });
      return;
    }

    commitControllerState('mod_auth_success', `Moderator auth succeeded for ${userName}.`, {
      userId: identity.userId,
      userName,
    }, tenantContext.slug, tenantState);

    if (pending.returnTo) {
      res.redirect(302, buildModAuthReturnUrl(pending.returnTo));
      return;
    }

    res.json({
      ok: true,
      role,
      user: {
        userId: identity.userId,
        userLogin: identity.userLogin,
        userName,
      },
    });
    return;
  } catch (error) {
    clearModAuthCookie(res);
    const authError = classifyModAuthFailure(error);
    console.error('[mod-auth] twitch callback failed:', error);
    appendAuditEvent('mod_auth_failed', `Moderator auth callback failed (${authError}).`, undefined, tenantState);

    if (pending.returnTo) {
      res.redirect(302, buildModAuthReturnUrl(pending.returnTo, authError));
      return;
    }

    res.status(502).json({ error: authError });
    return;
  }
});

app.get('/api/mod/auth/me', (req, res) => {
  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);
  const result = resolveModAccess(req);
  if (result.ok) {
    if (result.context.legacyTokenUsed) {
      auditLegacyFallbackUsage(tenantContext.slug, tenantState);
    }

    res.json({
      ok: true,
      authenticated: true,
      authorized: true,
      authMode: result.context.authMode,
      tokenSource: result.context.source,
      role: result.context.role,
      allowLegacyToken: modAuthAllowLegacyToken,
      legacyTokenUsed: result.context.legacyTokenUsed,
      user: result.context.userId
        ? {
            userId: result.context.userId,
            userLogin: result.context.userLogin,
            userName: result.context.userName,
          }
        : null,
    });
    return;
  }

  if (result.error === 'invalid_mod_session') {
    clearModAuthCookie(res);
  }

  if (result.status === 503) {
    res.status(503).json({
      error: result.error,
      authenticated: false,
      authorized: false,
      missing: result.missingConfig ?? [],
      allowLegacyToken: modAuthAllowLegacyToken,
    });
    return;
  }

  if (result.status === 403) {
    res.status(403).json({
      error: result.error,
      authenticated: true,
      authorized: false,
      role: result.role,
      allowLegacyToken: modAuthAllowLegacyToken,
      user: {
        userId: result.userId,
        userLogin: result.userLogin,
        userName: result.userName,
      },
    });
    return;
  }

  res.status(401).json({
    error: result.error,
    authenticated: false,
    authorized: false,
    allowLegacyToken: modAuthAllowLegacyToken,
  });
});

app.post('/api/mod/auth/logout', (req, res) => {
  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);
  const current = resolveModAccess(req);
  clearModAuthCookie(res);

  if (current.ok && !current.context.legacyTokenUsed && current.context.userId && current.context.userName) {
    commitControllerState('mod_auth_logout', `Moderator signed out: ${current.context.userName}.`, {
      userId: current.context.userId,
      userName: current.context.userName,
    }, tenantContext.slug, tenantState);
  } else {
    appendAuditEvent('mod_auth_logout', 'Moderator sign-out endpoint invoked.', undefined, tenantState);
  }

  res.json({ ok: true });
});

app.get('/api/mod/state', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantState = getTenantRuntimeStateFromRequest(req);
  const activeSession = tenantState.activeSession;
  const enabledCount = getEnabledOptionLabels(tenantState.optionPool).length;
  const disabledCount = tenantState.optionPool.length - enabledCount;
  const scopedTheme = resolveThemeScopedOverridesState(tenantState.themeState);
  const cardsTheme = resolveThemeState(tenantState.themeState, 'cards');
  const controllerTheme = resolveThemeState(tenantState.themeState, 'controller');

  res.json({
    ok: true,
    winnerConfig: {
      min: minWinnerClaims,
      max: maxWinnerClaims,
      defaultMaxWinners: defaultMaxWinnerClaims,
      gracePeriodSeconds: clampedWinnerGracePeriodSeconds,
      winnerGraceSecondsMin: minWinnerGraceSeconds,
      winnerGraceSecondsMax: maxWinnerGraceSeconds,
      strictWinnerGraceWindow,
    },
    optionPool: {
      total: tenantState.optionPool.length,
      enabled: enabledCount,
      disabled: disabledCount,
      canStart: enabledCount >= minOptionsForFiveByFive,
    },
    theme: cardsTheme,
    controllerTheme,
    cardsTheme,
    themeOverrides: normalizeThemePaletteOverrides(tenantState.themeState.overrides),
    linkControllerAndCards: scopedTheme.linkControllerAndCards,
    scopedOverrides: {
      controller: normalizeThemePaletteOverrides(scopedTheme.controllerOverrides),
      cards: normalizeThemePaletteOverrides(scopedTheme.cardsOverrides),
    },
    activeSession: activeSession ? toSessionSummary(activeSession, tenantState) : null,
  });
});

app.get('/api/mod/theme', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantState = getTenantRuntimeStateFromRequest(req);
  const scopedTheme = resolveThemeScopedOverridesState(tenantState.themeState);
  const cardsTheme = resolveThemeState(tenantState.themeState, 'cards');
  const controllerTheme = resolveThemeState(tenantState.themeState, 'controller');

  res.json({
    ok: true,
    theme: cardsTheme,
    controllerTheme,
    cardsTheme,
    overrides: normalizeThemePaletteOverrides(tenantState.themeState.overrides),
    linkControllerAndCards: scopedTheme.linkControllerAndCards,
    scopedOverrides: {
      controller: normalizeThemePaletteOverrides(scopedTheme.controllerOverrides),
      cards: normalizeThemePaletteOverrides(scopedTheme.cardsOverrides),
    },
  });
});

app.patch('/api/mod/theme', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);

  const parsed = modThemeUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_theme_payload', details: parsed.error.flatten() });
    return;
  }

  const nextThemeState = applyThemePatch(tenantState.themeState, parsed.data);
  if (!nextThemeState) {
    const scopedTheme = resolveThemeScopedOverridesState(tenantState.themeState);
    const cardsTheme = resolveThemeState(tenantState.themeState, 'cards');
    const controllerTheme = resolveThemeState(tenantState.themeState, 'controller');
    res.json({
      ok: true,
      changed: false,
      theme: cardsTheme,
      controllerTheme,
      cardsTheme,
      overrides: normalizeThemePaletteOverrides(tenantState.themeState.overrides),
      linkControllerAndCards: scopedTheme.linkControllerAndCards,
      scopedOverrides: {
        controller: normalizeThemePaletteOverrides(scopedTheme.controllerOverrides),
        cards: normalizeThemePaletteOverrides(scopedTheme.cardsOverrides),
      },
    });
    return;
  }

  tenantState.themeState = nextThemeState;
  commitControllerState('theme_updated', 'Moderator updated visual theme settings.', undefined, tenantContext.slug, tenantState);

  const scopedTheme = resolveThemeScopedOverridesState(tenantState.themeState);
  const cardsTheme = resolveThemeState(tenantState.themeState, 'cards');
  const controllerTheme = resolveThemeState(tenantState.themeState, 'controller');

  res.json({
    ok: true,
    changed: true,
    theme: cardsTheme,
    controllerTheme,
    cardsTheme,
    overrides: normalizeThemePaletteOverrides(tenantState.themeState.overrides),
    linkControllerAndCards: scopedTheme.linkControllerAndCards,
    scopedOverrides: {
      controller: normalizeThemePaletteOverrides(scopedTheme.controllerOverrides),
      cards: normalizeThemePaletteOverrides(scopedTheme.cardsOverrides),
    },
  });
});

app.get('/api/mod/options', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantState = getTenantRuntimeStateFromRequest(req);
  const enabledCount = getEnabledOptionLabels(tenantState.optionPool).length;
  res.json({
    count: tenantState.optionPool.length,
    enabledCount,
    options: tenantState.optionPool,
  });
});

app.post('/api/mod/options', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);

  const parsed = modOptionCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_option_payload', details: parsed.error.flatten() });
    return;
  }

  const normalizedLabel = normalizeOption(parsed.data.label);
  if (!normalizedLabel) {
    res.status(400).json({ error: 'invalid_option_label' });
    return;
  }

  const existing = findOptionByLabel(normalizedLabel, tenantState);
  if (existing) {
    res.status(409).json({ error: 'option_already_exists', option: existing });
    return;
  }

  const usedIds = new Set(tenantState.optionPool.map((item) => item.id));
  const nextOption = createOptionItem(normalizedLabel, usedIds);
  if (parsed.data.enabled === false) {
    nextOption.enabled = false;
  }

  tenantState.optionPool = [...tenantState.optionPool, nextOption];
  commitControllerState('option_pool_added', `Option added to pool: ${nextOption.label}`, undefined, tenantContext.slug, tenantState);

  res.status(201).json({
    ok: true,
    option: nextOption,
    enabledCount: getEnabledOptionLabels(tenantState.optionPool).length,
    count: tenantState.optionPool.length,
  });
});

app.post('/api/mod/options/bulk', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);

  const parsed = modOptionBulkEnabledSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_option_bulk_payload', details: parsed.error.flatten() });
    return;
  }

  const uniqueOptionIds = [...new Set(parsed.data.optionIds.map((entry) => entry.trim()).filter(Boolean))];
  if (uniqueOptionIds.length === 0) {
    res.status(400).json({ error: 'invalid_option_bulk_payload' });
    return;
  }

  const requestedIdSet = new Set(uniqueOptionIds);
  const targets = tenantState.optionPool.filter((item) => requestedIdSet.has(item.id));
  if (targets.length !== uniqueOptionIds.length) {
    const found = new Set(targets.map((item) => item.id));
    const missing = uniqueOptionIds.filter((id) => !found.has(id));
    res.status(404).json({ error: 'option_not_found', missing });
    return;
  }

  const nextEnabled = parsed.data.enabled;
  const changeTargets = targets.filter((item) => item.enabled !== nextEnabled);

  if (!nextEnabled) {
    const enabledCount = getEnabledOptionLabels(tenantState.optionPool).length;
    const disableCount = changeTargets.filter((item) => item.enabled).length;
    if (enabledCount - disableCount < minOptionsForFiveByFive) {
      res.status(400).json({
        error: 'min_enabled_options_required',
        message: `Pool must keep at least ${minOptionsForFiveByFive} enabled options.`,
      });
      return;
    }
  }

  if (changeTargets.length === 0) {
    res.json({
      ok: true,
      changed: false,
      changedCount: 0,
      enabledCount: getEnabledOptionLabels(tenantState.optionPool).length,
      count: tenantState.optionPool.length,
    });
    return;
  }

  const changedIdSet = new Set(changeTargets.map((item) => item.id));
  const now = new Date().toISOString();
  tenantState.optionPool = tenantState.optionPool.map((item) =>
    changedIdSet.has(item.id)
      ? {
          ...item,
          enabled: nextEnabled,
          updatedAt: now,
        }
      : item,
  );

  commitControllerState(
    'option_pool_bulk_updated',
    `Bulk option state updated (${nextEnabled ? 'enabled' : 'disabled'} ${changeTargets.length} option(s)).`,
    undefined,
    tenantContext.slug,
    tenantState,
  );

  res.json({
    ok: true,
    changed: true,
    changedCount: changeTargets.length,
    enabledCount: getEnabledOptionLabels(tenantState.optionPool).length,
    count: tenantState.optionPool.length,
  });
});

app.post('/api/mod/options/bulk-delete', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);

  const parsed = modOptionBulkDeleteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_option_bulk_delete_payload', details: parsed.error.flatten() });
    return;
  }

  const uniqueOptionIds = [...new Set(parsed.data.optionIds.map((entry) => entry.trim()).filter(Boolean))];
  if (uniqueOptionIds.length === 0) {
    res.status(400).json({ error: 'invalid_option_bulk_delete_payload' });
    return;
  }

  const requestedIdSet = new Set(uniqueOptionIds);
  const targets = tenantState.optionPool.filter((item) => requestedIdSet.has(item.id));
  if (targets.length !== uniqueOptionIds.length) {
    const found = new Set(targets.map((item) => item.id));
    const missing = uniqueOptionIds.filter((id) => !found.has(id));
    res.status(404).json({ error: 'option_not_found', missing });
    return;
  }

  const enabledCount = getEnabledOptionLabels(tenantState.optionPool).length;
  const enabledDeleteCount = targets.filter((item) => item.enabled).length;
  if (enabledCount - enabledDeleteCount < minOptionsForFiveByFive) {
    res.status(400).json({
      error: 'min_enabled_options_required',
      message: `Pool must keep at least ${minOptionsForFiveByFive} enabled options.`,
    });
    return;
  }

  if (targets.length === 0) {
    res.json({
      ok: true,
      changed: false,
      changedCount: 0,
      removedIds: [],
      count: tenantState.optionPool.length,
      enabledCount,
    });
    return;
  }

  const removedIds = targets.map((item) => item.id);
  const removedIdSet = new Set(removedIds);
  tenantState.optionPool = tenantState.optionPool.filter((item) => !removedIdSet.has(item.id));

  commitControllerState(
    'option_pool_bulk_removed',
    `Bulk options removed from pool (${targets.length} option(s)).`,
    undefined,
    tenantContext.slug,
    tenantState,
  );

  res.json({
    ok: true,
    changed: true,
    changedCount: targets.length,
    removedIds,
    count: tenantState.optionPool.length,
    enabledCount: getEnabledOptionLabels(tenantState.optionPool).length,
  });
});

app.patch('/api/mod/options/:optionId', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);

  const parsed = modOptionUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_option_update_payload', details: parsed.error.flatten() });
    return;
  }

  const optionId = String(req.params.optionId ?? '').trim();
  const target = tenantState.optionPool.find((item) => item.id === optionId);
  if (!target) {
    res.status(404).json({ error: 'option_not_found' });
    return;
  }

  const nextLabel = parsed.data.label !== undefined ? normalizeOption(parsed.data.label) : target.label;
  if (!nextLabel) {
    res.status(400).json({ error: 'invalid_option_label' });
    return;
  }

  const duplicate = tenantState.optionPool.find(
    (item) => item.id !== target.id && toOptionKey(item.label) === toOptionKey(nextLabel),
  );
  if (duplicate) {
    res.status(409).json({ error: 'option_already_exists', option: duplicate });
    return;
  }

  const nextEnabled = parsed.data.enabled ?? target.enabled;
  const enabledCount = getEnabledOptionLabels(tenantState.optionPool).length;
  if (!nextEnabled && target.enabled && enabledCount - 1 < minOptionsForFiveByFive) {
    res.status(400).json({
      error: 'min_enabled_options_required',
      message: `Pool must keep at least ${minOptionsForFiveByFive} enabled options.`,
    });
    return;
  }

  const now = new Date().toISOString();
  tenantState.optionPool = tenantState.optionPool.map((item) =>
    item.id === target.id
      ? {
          ...item,
          label: nextLabel,
          enabled: nextEnabled,
          updatedAt: now,
        }
      : item,
  );

  const updated = tenantState.optionPool.find((item) => item.id === target.id)!;
  commitControllerState('option_pool_updated', `Option updated: ${updated.label}`, undefined, tenantContext.slug, tenantState);

  res.json({
    ok: true,
    option: updated,
    enabledCount: getEnabledOptionLabels(tenantState.optionPool).length,
    count: tenantState.optionPool.length,
  });
});

app.delete('/api/mod/options/:optionId', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);

  const optionId = String(req.params.optionId ?? '').trim();
  const target = tenantState.optionPool.find((item) => item.id === optionId);
  if (!target) {
    res.status(404).json({ error: 'option_not_found' });
    return;
  }

  const enabledCount = getEnabledOptionLabels(tenantState.optionPool).length;
  if (target.enabled && enabledCount - 1 < minOptionsForFiveByFive) {
    res.status(400).json({
      error: 'min_enabled_options_required',
      message: `Pool must keep at least ${minOptionsForFiveByFive} enabled options.`,
    });
    return;
  }

  tenantState.optionPool = tenantState.optionPool.filter((item) => item.id !== target.id);
  commitControllerState('option_pool_removed', `Option removed from pool: ${target.label}`, undefined, tenantContext.slug, tenantState);

  res.json({
    ok: true,
    removedId: target.id,
    count: tenantState.optionPool.length,
    enabledCount: getEnabledOptionLabels(tenantState.optionPool).length,
  });
});

app.get('/api/mod/audit', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantState = getTenantRuntimeStateFromRequest(req);

  const parsedQuery = auditQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: 'invalid_audit_query', details: parsedQuery.error.flatten() });
    return;
  }

  const limit = parsedQuery.data.limit ?? 100;
  res.json({
    count: tenantState.auditLog.length,
    entries: tenantState.auditLog.slice(-limit),
  });
});

app.post('/api/mod/start', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);

  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_start_payload', details: parsed.error.flatten() });
    return;
  }

  const options = parsed.data.options ?? getEnabledOptionLabels(tenantState.optionPool);
  const result = startSession(
    parsed.data.mode,
    options,
    parsed.data.maxWinners,
    parsed.data.winnerGraceSeconds,
    undefined,
    tenantContext.slug,
    tenantState,
  );
  const activeSession = tenantState.activeSession;
  if (!result.ok || !activeSession) {
    res.status(400).json({ error: 'start_rejected', message: result.message });
    return;
  }

  res.json({ ok: true, session: toSessionSummary(activeSession, tenantState), message: result.message });
});

app.post('/api/mod/session/new', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);

  const parsed = newSessionSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_new_session_payload', details: parsed.error.flatten() });
    return;
  }

  const enabledOptions = getEnabledOptionLabels(tenantState.optionPool);
  const shuffledOptions = shuffleOptionOrder(enabledOptions);
  const result = startSession(
    parsed.data.mode,
    shuffledOptions,
    parsed.data.maxWinners,
    parsed.data.winnerGraceSeconds,
    undefined,
    tenantContext.slug,
    tenantState,
  );
  const activeSession = tenantState.activeSession;
  if (!result.ok || !activeSession) {
    res.status(400).json({ error: 'new_session_rejected', message: result.message });
    return;
  }

  res.json({ ok: true, session: toSessionSummary(activeSession, tenantState), message: result.message });
});

app.post('/api/mod/session/refresh-inactive', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);

  const result = refreshInactiveSessionState(undefined, tenantContext.slug, tenantState);
  if (!result.ok) {
    const activeSession = tenantState.activeSession;
    res.status(409).json({
      error: 'refresh_inactive_rejected',
      message: result.message,
      session: activeSession ? toSessionSummary(activeSession, tenantState) : null,
    });
    return;
  }

  res.json({
    ok: true,
    status: 'idle' as SessionStatus,
    session: null,
    message: result.message,
  });
});

app.post('/api/mod/session/reset-board', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);

  const result = resetCurrentSessionBoard(undefined, tenantContext.slug, tenantState);
  const activeSession = tenantState.activeSession;
  if (!result.ok || !activeSession) {
    res.status(400).json({ error: 'reset_board_rejected', message: result.message });
    return;
  }

  res.json({ ok: true, session: toSessionSummary(activeSession, tenantState), message: result.message });
});

app.post('/api/mod/session/continue-blackout', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);

  const parsed = continueBlackoutSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_continue_blackout_payload', details: parsed.error.flatten() });
    return;
  }

  const result = continueSessionToBlackout(Boolean(parsed.data.resetWinnerLedger), undefined, tenantContext.slug, tenantState);
  const activeSession = tenantState.activeSession;
  if (!result.ok || !activeSession) {
    res.status(400).json({ error: 'continue_blackout_rejected', message: result.message });
    return;
  }

  res.json({
    ok: true,
    message: result.message,
    previousMode: result.previousMode,
    nextMode: activeSession.mode,
    resetWinnerLedgerApplied: result.resetWinnerLedgerApplied,
    session: toSessionSummary(activeSession, tenantState),
  });
});

app.post('/api/mod/stop', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);
  const activeSession = tenantState.activeSession;

  if (!activeSession) {
    res.status(400).json({ error: 'no_active_session' });
    return;
  }

  const parsed = stopSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_stop_payload', details: parsed.error.flatten() });
    return;
  }

  const result = stopSession(Boolean(parsed.data.end), undefined, tenantContext.slug, tenantState);
  if (!result.ok || !activeSession) {
    res.status(400).json({ error: 'stop_rejected', message: result.message });
    return;
  }

  res.json({ ok: true, session: toSessionSummary(activeSession, tenantState), message: result.message });
});

app.post('/api/mod/call', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);

  const parsed = callOptionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_call_payload', details: parsed.error.flatten() });
    return;
  }

  const result = callOption(parsed.data.option, undefined, tenantContext.slug, tenantState);
  const activeSession = tenantState.activeSession;
  if (!result.ok || !activeSession) {
    res.status(400).json({ error: 'call_rejected', message: result.message });
    return;
  }

  res.json({
    ok: true,
    option: normalizeOption(parsed.data.option),
    calledCount: activeSession.calledOptions.size,
    session: toSessionSummary(activeSession, tenantState),
    message: result.message,
  });
});

app.post('/api/mod/uncall', (req, res) => {
  if (!ensureModAccess(req, res)) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);

  const parsed = uncallOptionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_uncall_payload', details: parsed.error.flatten() });
    return;
  }

  const result = uncallOption(parsed.data.option, undefined, tenantContext.slug, tenantState);
  const activeSession = tenantState.activeSession;
  if (!result.ok || !activeSession) {
    res.status(400).json({ error: 'uncall_rejected', message: result.message });
    return;
  }

  res.json({
    ok: true,
    option: normalizeOption(parsed.data.option),
    calledCount: activeSession.calledOptions.size,
    session: toSessionSummary(activeSession, tenantState),
    message: result.message,
  });
});

app.post('/api/player/join', (req, res) => {
  const auth = requireViewerAuth(req, res);
  if (!auth) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);

  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_join_payload', details: parsed.error.flatten() });
    return;
  }

  const userId = auth.userId;
  const fallbackName = auth.userName;
  const userName = sanitizeUserName(parsed.data.userName ?? fallbackName, fallbackName);
  const activeSession = tenantState.activeSession;
  const existedBeforeJoin = Boolean(activeSession?.players.has(userId));
  const result = joinSession(userId, userName, tenantContext.slug, tenantState);
  const nextSession = tenantState.activeSession;
  if (!nextSession) {
    res.status(400).json({ error: 'join_not_available', message: result.message });
    return;
  }

  const player = nextSession.players.get(userId);
  if (!player) {
    res.status(400).json({
      error: 'join_failed',
      message: result.message,
    });
    return;
  }

  res.json({
    ok: true,
    joined: result.ok && !existedBeforeJoin,
    player: toPlayerView(player),
    session: toSessionSummary(nextSession, tenantState),
    message: result.message,
  });
});

app.get('/api/player/card', (req, res) => {
  const auth = requireViewerAuth(req, res);
  if (!auth) {
    return;
  }

  const tenantState = getTenantRuntimeStateFromRequest(req);
  const activeSession = tenantState.activeSession;

  if (!activeSession) {
    res.status(404).json({ error: 'no_active_session' });
    return;
  }

  if (auth.sessionId !== activeSession.id) {
    res.status(401).json({ error: 'viewer_session_expired' });
    return;
  }

  const player = activeSession.players.get(auth.userId);
  if (!player) {
    res.status(404).json({ error: 'player_not_found' });
    return;
  }

  res.json({ ok: true, player: toPlayerView(player), session: toSessionSummary(activeSession, tenantState) });
});

app.post('/api/player/stamp', (req, res) => {
  const auth = requireViewerAuth(req, res);
  if (!auth) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);
  const activeSession = tenantState.activeSession;

  if (!activeSession || (activeSession.status !== 'open' && activeSession.status !== 'running')) {
    res.status(400).json({ error: 'stamp_not_available' });
    return;
  }

  if (auth.sessionId !== activeSession.id) {
    res.status(401).json({ error: 'viewer_session_expired' });
    return;
  }

  const parsed = stampSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_stamp_payload', details: parsed.error.flatten() });
    return;
  }

  const userId = auth.userId;
  const { index } = parsed.data;
  const headerIdempotencyKey = req.header('idempotency-key') ?? req.header('x-idempotency-key') ?? undefined;
  const providedIdempotencyKey = parsed.data.idempotencyKey ?? headerIdempotencyKey;
  const idempotencyKey = normalizeIdempotencyKey(providedIdempotencyKey);

  if (providedIdempotencyKey && !idempotencyKey) {
    res.status(400).json({
      error: 'invalid_idempotency_key',
      message: 'Idempotency key must be 8-128 chars and may include letters, numbers, ., :, _, -',
    });
    return;
  }

  if (idempotencyKey) {
    const replayRecord = getStampIdempotencyRecord(activeSession.id, userId, idempotencyKey, tenantContext.slug, tenantState);
    if (replayRecord) {
      res.status(replayRecord.statusCode).json({ ...replayRecord.response, idempotentReplay: true });
      return;
    }
  }

  const player = activeSession.players.get(userId);

  if (!player) {
    const payload = { error: 'player_not_found' };
    setStampIdempotencyRecord(activeSession.id, userId, idempotencyKey, 404, payload, true, tenantContext.slug, tenantState);
    res.status(404).json(payload);
    return;
  }

  if (player.hasWon) {
    const payload = { error: 'winner_locked', message: 'Winner cards are locked for this round.' };
    setStampIdempotencyRecord(activeSession.id, userId, idempotencyKey, 400, payload, true, tenantContext.slug, tenantState);
    res.status(400).json(payload);
    return;
  }

  const result = applyStamp(player.card, player.stamps, index, activeSession.calledOptions);
  if (!result.ok) {
    player.invalidStampCount += 1;
    const payload = { ok: false, reason: result.reason, invalidStampCount: player.invalidStampCount };
    setStampIdempotencyRecord(activeSession.id, userId, idempotencyKey, 400, payload, false, tenantContext.slug, tenantState);
    commitControllerState('stamp_rejected', `Stamp rejected for ${player.userName}: ${result.reason ?? 'unknown'}`, {
      userId: player.userId,
      userName: player.userName,
    }, tenantContext.slug, tenantState);
    res.status(400).json(payload);
    return;
  }

  const claimAvailable = checkWin(activeSession.mode, player.card, player.stamps);
  const payload = {
    ok: true,
    result,
    hasWon: player.hasWon,
    hasWonNow: false,
    claimAvailable,
    winnerCount: activeSession.winners.size,
    maxWinners: activeSession.maxWinners,
    winnerGraceSeconds: activeSession.winnerGraceSeconds,
    sessionEnded: false,
    winnerGraceEndsAt: activeSession.winnerGraceEndsAt,
    winnerGraceSecondsRemaining: getWinnerGraceSecondsRemaining(activeSession),
  };
  setStampIdempotencyRecord(activeSession.id, userId, idempotencyKey, 200, payload, false, tenantContext.slug, tenantState);
  commitControllerState(
    'stamp_accepted',
    `Stamp accepted for ${player.userName}: ${result.value ?? 'unknown cell'}${claimAvailable ? ' (claim available)' : ''}`,
    { userId: player.userId, userName: player.userName },
    tenantContext.slug,
    tenantState,
  );

  res.json(payload);
  return;
});

app.post('/api/player/claim', (req, res) => {
  const auth = requireViewerAuth(req, res);
  if (!auth) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);
  const activeSession = tenantState.activeSession;

  if (!activeSession || (activeSession.status !== 'open' && activeSession.status !== 'running')) {
    res.status(400).json({ error: 'claim_not_available' });
    return;
  }

  if (auth.sessionId !== activeSession.id) {
    res.status(401).json({ error: 'viewer_session_expired' });
    return;
  }

  const parsed = claimSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_claim_payload', details: parsed.error.flatten() });
    return;
  }

  const player = activeSession.players.get(auth.userId);
  if (!player) {
    res.status(404).json({ error: 'player_not_found' });
    return;
  }

  if (player.hasWon) {
    res.json({
      ok: true,
      alreadyClaimed: true,
      hasWon: true,
      hasWonNow: false,
      winnerCount: activeSession.winners.size,
      maxWinners: activeSession.maxWinners,
      winnerGraceSeconds: activeSession.winnerGraceSeconds,
      sessionEnded: false,
      winnerGraceEndsAt: activeSession.winnerGraceEndsAt,
      winnerGraceSecondsRemaining: getWinnerGraceSecondsRemaining(activeSession),
    });
    return;
  }

  if (activeSession.winners.size >= activeSession.maxWinners) {
    res.status(400).json({
      ok: false,
      error: 'winner_cap_reached',
      message: 'Winner cap has been reached for this round.',
      winnerCount: activeSession.winners.size,
      maxWinners: activeSession.maxWinners,
      winnerGraceSeconds: activeSession.winnerGraceSeconds,
      sessionEnded: false,
      winnerGraceEndsAt: activeSession.winnerGraceEndsAt,
      winnerGraceSecondsRemaining: getWinnerGraceSecondsRemaining(activeSession),
    });
    return;
  }

  const validWin = checkWin(activeSession.mode, player.card, player.stamps);
  if (!validWin) {
    res.status(400).json({
      ok: false,
      error: 'claim_not_validated',
      message: 'Current stamped pattern does not satisfy a bingo win yet.',
    });
    return;
  }

  const winnerState = registerWinnerAndApplySessionRules(player, tenantContext.slug, tenantState);
  commitControllerState(
    'player_won',
    `${player.userName} achieved bingo in ${activeSession.mode} mode via explicit claim.`,
    { userId: player.userId, userName: player.userName },
    tenantContext.slug,
    tenantState,
  );

  if (winnerState.sessionEnded) {
    commitControllerState(
      'session_ended',
      `Winner cap reached (${winnerState.winnerCount}/${activeSession.maxWinners}). Round ended.`,
      undefined,
      tenantContext.slug,
      tenantState,
    );
  }

  res.json({
    ok: true,
    alreadyClaimed: false,
    hasWon: true,
    hasWonNow: true,
    winnerCount: winnerState.winnerCount,
    maxWinners: activeSession.maxWinners,
    winnerGraceSeconds: activeSession.winnerGraceSeconds,
    sessionEnded: winnerState.sessionEnded,
    winnerGraceEndsAt: winnerState.winnerGraceEndsAt,
    winnerGraceSecondsRemaining: getWinnerGraceSecondsRemaining(activeSession),
  });
});

app.get('/api/internal/tenant-broadcasters', (req, res) => {
  if (!requireInternalRedeemAuth(req, res)) {
    return;
  }

  res.json({
    ok: true,
    count: tenantBroadcasterRegistry.size,
    mappings: snapshotTenantBroadcasterRegistry(),
  });
});

app.post('/api/internal/tenant-broadcasters/upsert', (req, res) => {
  if (!requireInternalRedeemAuth(req, res)) {
    return;
  }

  const parsed = tenantBroadcasterUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_tenant_broadcaster_payload', details: parsed.error.flatten() });
    return;
  }

  const normalizedTenantSlug = parseTenantSlugFromRoute(parsed.data.tenantSlug);
  if (!normalizedTenantSlug) {
    res.status(400).json({
      error: 'invalid_tenant_slug',
      message: 'Tenant slugs must use lowercase letters, numbers, and hyphens.',
    });
    return;
  }

  const broadcasterId = parsed.data.broadcasterId.trim();
  if (!broadcasterId) {
    res.status(400).json({
      error: 'invalid_broadcaster_id',
      message: 'Broadcaster id is required.',
    });
    return;
  }

  try {
    const registration = setTenantBroadcasterRegistration(normalizedTenantSlug, broadcasterId);
    const existingTenantState = tenantRuntimeStates.get(registration.tenantSlug);
    if (existingTenantState) {
      appendAuditEvent(
        'tenant_broadcaster_updated',
        `Tenant broadcaster mapping set to ${registration.broadcasterId}.`,
        undefined,
        existingTenantState,
      );
    }

    res.json({
      ok: true,
      tenantSlug: registration.tenantSlug,
      broadcasterId: registration.broadcasterId,
      previousBroadcasterId: registration.previousBroadcasterId,
      updated: registration.updated,
      count: tenantBroadcasterRegistry.size,
    });
  } catch (error) {
    const message = resolveTenantMutationErrorCode(error, 'tenant_broadcaster_update_failed');
    const status = resolveTenantMutationErrorStatus(error);
    res.status(status).json({ error: message });
  }
});

app.post('/api/internal/redeem/join', (req, res) => {
  const configError = assertViewerAuthConfig();
  if (configError) {
    const message = `Bingo card redeem is unavailable: ${configError}.`;
    res.status(503).json({
      ok: false,
      error: configError,
      message,
      viewerUrl: message,
    });
    return;
  }

  if (!requireTenantRedeemAuth(req, res)) {
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);
  const activeSession = tenantState.activeSession;

  const parsed = redeemJoinSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = 'Redeem payload is invalid. Confirm redemptionId, twitchUserId, and twitchUserName are set.';
    res.status(400).json({
      ok: false,
      error: 'invalid_redeem_payload',
      message,
      viewerUrl: message,
      details: parsed.error.flatten(),
    });
    return;
  }

  if (!activeSession || (activeSession.status !== 'open' && activeSession.status !== 'running')) {
    const message = 'Bingo join is not available right now.';
    res.status(400).json({
      ok: false,
      error: 'join_not_available',
      message,
      viewerUrl: message,
    });
    return;
  }

  const payload = parsed.data;
  const normalizedRedemptionId = normalizeRedemptionId(payload.redemptionId);
  if (!normalizedRedemptionId) {
    const message = 'Redemption id is required.';
    res.status(400).json({
      ok: false,
      error: 'invalid_redeem_id',
      message,
      viewerUrl: message,
    });
    return;
  }

  const existing = getRedeemJoinRecord(activeSession.id, normalizedRedemptionId, tenantContext.slug, tenantState);
  if (existing) {
    if (existing.userId !== payload.twitchUserId) {
      const message = 'Redemption id is already bound to a different Twitch user for this session.';
      res.status(409).json({
        ok: false,
        error: 'redeem_id_conflict',
        message,
        viewerUrl: message,
      });
      return;
    }

    res.json({
      ok: true,
      idempotentReplay: true,
      sessionId: existing.sessionId,
      userId: existing.userId,
      userName: existing.userName,
      viewerUrl: existing.viewerUrl,
      message: existing.viewerUrl,
      expiresInSeconds: Math.max(0, Math.floor((existing.expiresAt - Date.now()) / 1000)),
    });
    return;
  }

  const safeName = sanitizeUserName(payload.twitchUserName, payload.twitchUserId);
  const inviteToken = createViewerInviteToken({
    tenantSlug: tenantContext.slug,
    sessionId: activeSession.id,
    userId: payload.twitchUserId,
    userName: safeName,
    redemptionId: normalizedRedemptionId,
  });

  const viewerUrl = buildViewerUrl(req, {
    invite: inviteToken,
    tenantSlug: tenantContext.slug,
  });
  const invitePayload = parseViewerInviteToken(inviteToken);
  if (!invitePayload) {
    const message = 'Bingo card link generation failed. Try redeeming again.';
    res.status(500).json({
      ok: false,
      error: 'invite_token_generation_failed',
      message,
      viewerUrl: message,
    });
    return;
  }

  setRedeemJoinRecord({
    sessionId: activeSession.id,
    redemptionId: normalizedRedemptionId,
    userId: payload.twitchUserId,
    userName: safeName,
    inviteToken,
    viewerUrl,
    expiresAt: invitePayload.exp,
  }, false, tenantContext.slug, tenantState);
  commitControllerState(
    'redeem_join_issued',
    `Viewer link issued for redemption ${normalizedRedemptionId}.`,
    { userId: payload.twitchUserId, userName: safeName },
    tenantContext.slug,
    tenantState,
  );

  res.json({
    ok: true,
    sessionId: activeSession.id,
    userId: payload.twitchUserId,
    userName: safeName,
    viewerUrl,
    message: viewerUrl,
    expiresInSeconds: Math.floor(viewerInviteTokenTtlMs / 1000),
  });
});

app.get('/api/auth/twitch/start', (req, res) => {
  const configError = assertViewerAuthConfig();
  if (configError) {
    res.status(503).json({ error: configError });
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);
  const activeSession = tenantState.activeSession;

  const requestedInviteToken = String(req.query.invite ?? '').trim();
  let inviteToken = requestedInviteToken;
  let invite = parseViewerInviteToken(inviteToken);

  // Compatibility path for older viewer links that only include userId/userName.
  if (!invite) {
    const legacyUserId = String(req.query.userId ?? '').trim();
    if (legacyUserId && activeSession) {
      const existingRecord = findLatestRedeemJoinRecordForUser(activeSession.id, legacyUserId, tenantContext.slug, tenantState);
      if (existingRecord) {
        inviteToken = existingRecord.inviteToken;
        invite = parseViewerInviteToken(inviteToken);
      }
    }
  }

  if (!invite) {
    res.status(400).json({
      error: 'invalid_invite_token',
      message: 'Redeem channel points again to generate a fresh secure viewer invite link.',
    });
    return;
  }

  const inviteTenantSlug = resolveTokenTenantSlug(invite.tenantSlug);
  if (inviteTenantSlug !== tenantContext.slug) {
    res.status(400).json({ error: 'invite_tenant_mismatch' });
    return;
  }

  if (!activeSession || invite.sessionId !== activeSession.id) {
    res.status(400).json({ error: 'invite_session_mismatch' });
    return;
  }

  const state = createOauthState(inviteToken, tenantState);
  const authUrl = new URL('https://id.twitch.tv/oauth2/authorize');
  authUrl.searchParams.set('client_id', twitchClientId);
  authUrl.searchParams.set('redirect_uri', twitchRedirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', state);
  if (twitchOauthScope) {
    authUrl.searchParams.set('scope', twitchOauthScope);
  }

  res.redirect(302, authUrl.toString());
});

app.get('/api/auth/twitch/callback', async (req, res) => {
  const configError = assertViewerAuthConfig();
  if (configError) {
    res.status(503).json({ error: configError });
    return;
  }

  let tenantContext = getTenantContext(req);
  let tenantState = getTenantRuntimeState(tenantContext.slug);

  const code = String(req.query.code ?? '').trim();
  const state = String(req.query.state ?? '').trim();

  if (!code || !state) {
    res.status(400).json({ error: 'invalid_oauth_callback' });
    return;
  }

  let pending = consumeOauthState(state, tenantState);
  if (!pending) {
    const resolved = consumeOauthStateAcrossTenants(state);
    if (resolved) {
      tenantContext = {
        slug: resolved.tenantSlug,
        source: 'tenant-route',
        isDefaultTenant: resolved.tenantSlug === defaultTenantSlug,
      };
      tenantState = getTenantRuntimeState(resolved.tenantSlug);
      pending = resolved.pending;
    }
  }

  if (!pending) {
    res.status(400).json({ error: 'invalid_oauth_state' });
    return;
  }

  const activeSession = tenantState.activeSession;

  const invite = parseViewerInviteToken(pending.inviteToken);
  if (!invite) {
    res.redirect(302, buildViewerUrl(req, {
      invite: pending.inviteToken,
      authError: 'invalid_invite',
      tenantSlug: tenantContext.slug,
    }));
    return;
  }

  const inviteTenantSlug = resolveTokenTenantSlug(invite.tenantSlug);
  if (inviteTenantSlug !== tenantContext.slug) {
    res.redirect(302, buildViewerUrl(req, {
      invite: pending.inviteToken,
      authError: 'tenant_mismatch',
      tenantSlug: inviteTenantSlug,
    }));
    return;
  }

  if (!activeSession || invite.sessionId !== activeSession.id) {
    res.redirect(302, buildViewerUrl(req, {
      invite: pending.inviteToken,
      authError: 'session_mismatch',
      tenantSlug: tenantContext.slug,
    }));
    return;
  }

  try {
    const accessToken = await requestTwitchAccessToken(code);
    const identity = await resolveTwitchIdentity(accessToken);

    if (identity.userId !== invite.userId) {
      res.redirect(302, buildViewerUrl(req, {
        invite: pending.inviteToken,
        authError: 'invite_owner_mismatch',
        tenantSlug: tenantContext.slug,
      }));
      return;
    }

    const authToken = createViewerAuthToken({
      tenantSlug: tenantContext.slug,
      sessionId: invite.sessionId,
      userId: invite.userId,
      userName: sanitizeUserName(identity.userName, invite.userName),
    });

    res.redirect(302, buildViewerUrl(req, {
      invite: pending.inviteToken,
      authToken,
      tenantSlug: tenantContext.slug,
    }));
    return;
  } catch (error) {
    console.error('[auth] twitch callback failed:', error);
    res.redirect(302, buildViewerUrl(req, {
      invite: pending.inviteToken,
      authError: 'oauth_failed',
      tenantSlug: tenantContext.slug,
    }));
    return;
  }
});

app.post('/api/auth/viewer/session', (req, res) => {
  const configError = assertViewerAuthConfig();
  if (configError) {
    res.status(503).json({ error: configError });
    return;
  }

  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);
  const activeSession = tenantState.activeSession;

  const authToken = String(req.body?.authToken ?? '').trim();
  const payload = parseViewerAuthToken(authToken);
  if (!payload) {
    res.status(400).json({ error: 'invalid_auth_token' });
    return;
  }

  const authTenantSlug = resolveTokenTenantSlug(payload.tenantSlug);
  if (authTenantSlug !== tenantContext.slug) {
    res.status(400).json({ error: 'tenant_mismatch' });
    return;
  }

  if (!activeSession || payload.sessionId !== activeSession.id) {
    res.status(400).json({ error: 'session_mismatch' });
    return;
  }

  setViewerAuthCookie(res, authToken);
  res.json({
    ok: true,
    user: {
      userId: payload.userId,
      userName: payload.userName,
      sessionId: payload.sessionId,
    },
    expiresAt: payload.exp,
  });
});

app.get('/api/auth/me', (req, res) => {
  const tenantState = getTenantRuntimeStateFromRequest(req);
  const activeSession = tenantState.activeSession;
  const auth = getViewerAuthFromRequest(req);
  if (!auth) {
    res.status(401).json({ error: 'viewer_auth_required' });
    return;
  }

  const tenantContext = getTenantContext(req);
  const authTenantSlug = resolveTokenTenantSlug(auth.tenantSlug);
  if (authTenantSlug !== tenantContext.slug) {
    res.status(401).json({ error: 'viewer_tenant_mismatch' });
    return;
  }

  if (activeSession && auth.sessionId !== activeSession.id) {
    res.status(401).json({ error: 'viewer_session_expired' });
    return;
  }

  res.json({
    ok: true,
    user: {
      userId: auth.userId,
      userName: auth.userName,
      sessionId: auth.sessionId,
    },
    expiresAt: auth.exp,
  });
});

app.post('/api/auth/logout', (_req, res) => {
  clearViewerAuthCookie(res);
  res.json({ ok: true });
});

app.post('/api/chat/command', (req, res) => {
  const tenantContext = getTenantContext(req);
  const tenantState = getTenantRuntimeState(tenantContext.slug);

  const parsed = chatCommandSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_chat_command_payload', details: parsed.error.flatten() });
    return;
  }

  const result = executeChatCommand(parsed.data.command, {
    userId: parsed.data.userId,
    userName: parsed.data.userName,
    isMod: Boolean(parsed.data.isMod),
    reply: () => {
      // HTTP command bridge has no direct chat reply channel.
    },
  }, tenantContext.slug, tenantState);

  res.json(result);
});

app.listen(port, () => {
  createTwitchClient();
  // Keep startup logs concise for local operator terminals.
  console.log(`[controller] listening on http://localhost:${port}`);
  console.log(
    `[controller] tenancy enabled=${multiTenantEnabled ? 'yes' : 'no'} defaultTenant=${defaultTenantSlug} legacyApiFallback=${legacySingleTenantFallback ? 'enabled' : 'disabled'}`,
  );

  if (rawModAuthCookieDomain && !modAuthCookieDomain) {
    console.warn('[controller] ignoring MOD_AUTH_COOKIE_DOMAIN because it is not a valid non-local domain');
  }

  const corsOrigins = [...allowedCorsOrigins].sort();
  console.log(
    `[controller] mod-auth redirect=${twitchModRedirectUri || '(unset)'} cookieDomain=${modAuthCookieDomain || '(host-only)'} legacyFallback=${modAuthAllowLegacyToken ? 'enabled' : 'disabled'} corsOrigins=${corsOrigins.length > 0 ? corsOrigins.join(',') : '(none)'}`,
  );
  console.log(
    `[controller] viewer-auth ttl inviteMs=${viewerInviteTokenTtlMs} authMs=${viewerAuthTokenTtlMs} oauthStateMs=${oauthStateTtlMs}`,
  );
});

