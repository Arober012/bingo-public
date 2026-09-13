import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ChangeEvent, FormEvent } from 'react'
import './App.css'

type BingoMode = 'normal' | 'rows' | 'corners' | 'blackout' | 'postage'
type SessionStatus = 'idle' | 'open' | 'running' | 'stopped' | 'ended'
type ControlView = 'round' | 'options' | 'theme' | 'players' | 'testing'
type ThemeMode = 'light' | 'dark'
type UiThemeBackgroundStyle = 'full-gradient'
type ThemeScopeTarget = 'all' | 'controller' | 'cards'
type ThemeColorCategory = 'backgrounds' | 'surfaces' | 'text' | 'actions' | 'cells' | 'status'
type ThemeEditorScope = 'controller' | 'cards'

interface ThemePalette {
  backgroundStart: string
  backgroundMid: string
  backgroundEnd: string
  surface: string
  surfaceAlt: string
  border: string
  borderSoft: string
  text: string
  textMuted: string
  accent: string
  accentContrast: string
  called: string
  calledBg: string
  free: string
  freeBg: string
  error: string
  errorBg: string
  success: string
  successBg: string
  warning: string
  warningBg: string
}

interface ResolvedTheme {
  mode: ThemeMode
  palette: ThemePalette
  skinId?: string
  updatedAt: string
}

interface SessionSummary {
  id?: string
  mode?: string
  status: SessionStatus
  players?: number
  winners?: string[]
  calledOptions?: string[]
  maxWinners?: number
  winnerGraceSeconds?: number
  winnerGraceEndsAt?: string | null
  winnerGraceSecondsRemaining?: number | null
  createdAt?: string
  theme?: ResolvedTheme
}

interface OptionPoolItem {
  id: string
  label: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

interface ActivePlayerSummary {
  userId: string
  userName: string
  hasWon: boolean
}

interface ModStateResponse {
  ok: boolean
  winnerConfig?: {
    min: number
    max: number
    defaultMaxWinners: number
    gracePeriodSeconds: number
    winnerGraceSecondsMin?: number
    winnerGraceSecondsMax?: number
  }
  optionPool: {
    total: number
    enabled: number
    disabled: number
    canStart: boolean
  }
  theme?: ResolvedTheme
  controllerTheme?: ResolvedTheme
  cardsTheme?: ResolvedTheme
  themeOverrides?: Partial<ThemePalette>
  linkControllerAndCards?: boolean
  scopedOverrides?: {
    controller?: Partial<ThemePalette>
    cards?: Partial<ThemePalette>
  }
  activePlayers?: ActivePlayerSummary[]
  activeSession: SessionSummary | null
}

interface ModOptionsResponse {
  count: number
  enabledCount: number
  options: OptionPoolItem[]
}

interface OptionsResponse {
  count: number
  options: string[]
}

interface ModTestingViewerLinkResponse {
  ok: boolean
  viewerUrl: string
  sessionId: string
  userId: string
  userName: string
  joined: boolean
  expiresInSeconds?: number | null
}

interface ControlCapabilities {
  modState: boolean
  modOptions: boolean
  modSessionControl: boolean
  modTheme: boolean
}

type AuthGateState = 'checking' | 'authorized' | 'signed_out' | 'forbidden'

interface ModAuthUser {
  userId: string
  userLogin: string
  userName: string
}

interface ModAuthStatusResponse {
  ok?: boolean
  error?: string
  authenticated: boolean
  authorized: boolean
  authMode?: 'twitch-session' | 'legacy-token'
  tokenSource?: 'cookie' | 'bearer'
  role?: 'broadcaster' | 'moderator' | 'unauthorized' | 'legacy'
  allowLegacyToken?: boolean
  legacyTokenUsed?: boolean
  user?: ModAuthUser | null
  missing?: string[]
}

interface ThemeEditorField {
  key: keyof ThemePalette
  label: string
  description: string
  category: ThemeColorCategory
}

type SkinLibraryState = 'idle' | 'loading' | 'ready' | 'error'

interface ThemeSkinEntry {
  id: string
  name: string
  description: string
  season: string
  tags: string[]
  mode: ThemeMode | null
  palette: Partial<ThemePalette>
  controllerPalette: Partial<ThemePalette>
  cardsPalette: Partial<ThemePalette>
}

type ThemePreviewCellState = 'default' | 'called' | 'stamped' | 'free' | 'winner'

interface ThemePreviewCell {
  label: string
  state: ThemePreviewCellState
}

const modes: BingoMode[] = ['normal', 'rows', 'corners', 'blackout', 'postage']
const controlViews: Array<{ id: ControlView; label: string }> = [
  { id: 'round', label: 'Round + Callout' },
  { id: 'options', label: 'Pool Manager' },
  { id: 'theme', label: 'Theme + Skin' },
  { id: 'players', label: 'Active Players' },
  { id: 'testing', label: 'Testing' },
]
const pollIntervalMs = 4000
const minOptionsForFiveByFive = 24
const defaultMaxWinners = 2
const skinManifestPath = '/skins/skins-manifest.json'
const skinIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const supportedUiThemeBackgroundStyles = new Set<UiThemeBackgroundStyle>(['full-gradient'])
const hexColorRegex = /^#[0-9a-fA-F]{6}$/
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
]
const themeCategoryLabels: Record<ThemeColorCategory, string> = {
  backgrounds: 'Backgrounds',
  surfaces: 'Surfaces and Borders',
  text: 'Text',
  actions: 'Actions and Accents',
  cells: 'Bingo Cells',
  status: 'Status Colors',
}
const themeCategoryOrder: ThemeColorCategory[] = [
  'backgrounds',
  'surfaces',
  'text',
  'actions',
  'cells',
  'status',
]
const themePreviewFallbackLabels: string[] = [
  'Hydrate',
  'Shoutout',
  'Lurk',
  'Raid',
  'Emote Wave',
  'No Audio',
  'First Chat',
  'Clip It',
  'GG',
  'Mod Save',
  'Lag Spike',
  'Backseat',
  'Pog Chain',
  'Bingo Call',
  'Hat Trick',
  'BRB',
  'Boss Fight',
  'Sub Bomb',
  'Lucky Drop',
  'Combo',
  'Hype Train',
  'Final Push',
  'Jackpot Ready',
  'Redemption',
]
const themePreviewCellStatePattern: ThemePreviewCellState[] = [
  'winner',
  'default',
  'called',
  'default',
  'stamped',
  'default',
  'called',
  'default',
  'stamped',
  'default',
  'called',
  'default',
  'free',
  'called',
  'default',
  'stamped',
  'default',
  'called',
  'default',
  'stamped',
  'default',
  'called',
  'default',
  'winner',
  'default',
]

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
}

const canonicalDefaultThemeMode: ThemeMode = 'dark'

function createDefaultThemeCategoryExpansionState(): Record<ThemeEditorScope, ThemeColorCategory[]> {
  const firstCategory = themeCategoryOrder[0]
  return {
    controller: firstCategory ? [firstCategory] : [],
    cards: firstCategory ? [firstCategory] : [],
  }
}

function createDefaultThemeScopeExpansionState(): Record<ThemeEditorScope, boolean> {
  return {
    controller: true,
    cards: true,
  }
}

const themeEditorFields: ThemeEditorField[] = [
  {
    key: 'backgroundStart',
    label: 'Background Start',
    description: 'Starting color of the main page gradient backdrop.',
    category: 'backgrounds',
  },
  {
    key: 'backgroundMid',
    label: 'Background Mid',
    description: 'Blend color used through the middle of page gradients.',
    category: 'backgrounds',
  },
  {
    key: 'backgroundEnd',
    label: 'Background End',
    description: 'Top-right radial highlight tone used in page backgrounds.',
    category: 'backgrounds',
  },
  {
    key: 'surface',
    label: 'Panel Surface',
    description: 'Main container background for cards, panels, and shells.',
    category: 'surfaces',
  },
  {
    key: 'surfaceAlt',
    label: 'Panel Surface Alt',
    description: 'Secondary container tone used for chips, inputs, and nested panels.',
    category: 'surfaces',
  },
  {
    key: 'border',
    label: 'Border Strong',
    description: 'Primary border color for inputs, cells, and highlighted outlines.',
    category: 'surfaces',
  },
  {
    key: 'borderSoft',
    label: 'Border Soft',
    description: 'Subtle border color used for low-emphasis boundaries.',
    category: 'surfaces',
  },
  {
    key: 'text',
    label: 'Main Text',
    description: 'Primary readable text color used on body and card content.',
    category: 'text',
  },
  {
    key: 'textMuted',
    label: 'Muted Text',
    description: 'Secondary helper text color for captions and metadata.',
    category: 'text',
  },
  {
    key: 'accent',
    label: 'Accent',
    description: 'Primary highlight color for badges, key buttons, and callouts.',
    category: 'actions',
  },
  {
    key: 'accentContrast',
    label: 'Accent Contrast',
    description: 'Text/icon color displayed on top of Accent backgrounds.',
    category: 'actions',
  },
  {
    key: 'called',
    label: 'Called Border',
    description: 'Border color for called or stamped bingo cells.',
    category: 'cells',
  },
  {
    key: 'calledBg',
    label: 'Called Cell Fill',
    description: 'Fill color for called or stamped bingo cells.',
    category: 'cells',
  },
  {
    key: 'free',
    label: 'Free Cell Border',
    description: 'Border color for free center cells.',
    category: 'cells',
  },
  {
    key: 'freeBg',
    label: 'Free Cell Fill',
    description: 'Fill color for free center cells.',
    category: 'cells',
  },
  {
    key: 'success',
    label: 'Success Text',
    description: 'Success state text color for confirmations and progress.',
    category: 'status',
  },
  {
    key: 'successBg',
    label: 'Success Fill',
    description: 'Success state background color for positive status blocks.',
    category: 'status',
  },
  {
    key: 'warning',
    label: 'Warning Text',
    description: 'Warning state text color for cautions and limits.',
    category: 'status',
  },
  {
    key: 'warningBg',
    label: 'Warning Fill',
    description: 'Warning state background color for caution banners.',
    category: 'status',
  },
  {
    key: 'error',
    label: 'Error Text',
    description: 'Error state text color for failures and blocking issues.',
    category: 'status',
  },
  {
    key: 'errorBg',
    label: 'Error Fill',
    description: 'Error state background color for failure banners and alerts.',
    category: 'status',
  },
]
const tenantSlugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const canonicalControlApiBase = 'https://public-control.custom-overlays.com'
const deprecatedControlApiOrigins = new Set(['https://api.custom-overlays.com'])
const hostedControlFallbackHosts = new Set([
  'public-controller.custom-overlays.com',
  'control.custom-overlays.com',
  'public-bingo-control.web.app',
  'public-bingo-control.firebaseapp.com',
  'stream-bingo-control.web.app',
  'stream-bingo-control.firebaseapp.com',
])

function parseAllowedControlHosts(rawValue: string | undefined): string[] {
  const parsed = (rawValue ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)

  const defaults = ['localhost', '127.0.0.1']
  return [...new Set([...parsed, ...defaults])]
}

function parseTestingAllowlist(rawValue: string | undefined): string[] {
  return [...new Set(
    (rawValue ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  )]
}

function normalizeTestingIdentity(input: string | null | undefined): string {
  return String(input ?? '').trim().toLowerCase()
}

function isTestingIdentityAllowlisted(user: ModAuthUser | null | undefined, allowlist: string[]): boolean {
  if (!user || allowlist.length === 0) {
    return false
  }

  const allowlistSet = new Set(allowlist)
  const userId = normalizeTestingIdentity(user.userId)
  if (userId && allowlistSet.has(userId)) {
    return true
  }

  const userLogin = normalizeTestingIdentity(user.userLogin)
  if (userLogin && allowlistSet.has(userLogin)) {
    return true
  }

  return false
}

function resolveHostedControlApiFallback(hostname: string): string | null {
  const normalized = hostname.trim().toLowerCase()
  if (!normalized || normalized === 'localhost' || normalized === '127.0.0.1') {
    return null
  }

  return hostedControlFallbackHosts.has(normalized) ? canonicalControlApiBase : null
}

function normalizeTenantSlug(input: string | null | undefined): string | null {
  const normalized = String(input ?? '').trim().toLowerCase()
  if (!normalized || !tenantSlugPattern.test(normalized)) {
    return null
  }

  return normalized
}

function resolveTenantSlug(pathname: string, params: URLSearchParams): string | null {
  const fromQuery = normalizeTenantSlug(params.get('tenant'))
  if (fromQuery) {
    return fromQuery
  }

  const pathMatch = pathname.match(/(?:^|\/)t\/([^/]+)(?:\/|$)/)
  return normalizeTenantSlug(pathMatch?.[1])
}

function buildApiUrl(apiBase: string, tenantSlug: string | null, endpoint: string): string {
  const suffix = endpoint.startsWith('/') ? endpoint : `/${endpoint}`
  if (tenantSlug) {
    return `${apiBase}/api/t/${encodeURIComponent(tenantSlug)}${suffix}`
  }

  return `${apiBase}/api${suffix}`
}

function resolveControlApiBase(input: string): { apiBase: string; legacyApiBaseDetected: boolean } {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (!trimmed) {
    return { apiBase: trimmed, legacyApiBaseDetected: false }
  }

  try {
    const parsed = new URL(trimmed)
    const origin = parsed.origin.toLowerCase()
    if (deprecatedControlApiOrigins.has(origin)) {
      return { apiBase: canonicalControlApiBase, legacyApiBaseDetected: true }
    }
  } catch {
    // Keep raw input if it is not a fully-qualified URL.
  }

  return { apiBase: trimmed, legacyApiBaseDetected: false }
}

function getLegacyControlApiHintMessage(legacyApiBaseDetected: boolean): string | null {
  if (!legacyApiBaseDetected) {
    return null
  }

  return 'Detected deprecated API host api.custom-overlays.com in this URL and switched to public-control.custom-overlays.com automatically.'
}

function buildModReturnToUrl(apiBase: string): string {
  const url = new URL(window.location.href)
  url.searchParams.set('api', apiBase)
  url.searchParams.delete('modAuthError')
  url.searchParams.delete('ownerAuthError')
  url.searchParams.delete('token')
  url.searchParams.delete('state')
  url.searchParams.delete('code')
  url.searchParams.delete('error')
  return url.toString()
}

function resolveControlContext() {
  const params = new URLSearchParams(window.location.search)
  const queryApi = params.get('api')?.trim()
  const authErrorHint = params.get('modAuthError')?.trim() ?? ''
  const envApi = import.meta.env.VITE_API_BASE_URL?.trim()
  const hostedFallbackApiBase = resolveHostedControlApiFallback(window.location.hostname)
  const rawApiBase = queryApi || envApi || hostedFallbackApiBase || window.location.origin
  const { apiBase, legacyApiBaseDetected } = resolveControlApiBase(rawApiBase)
  const tenantSlug = resolveTenantSlug(window.location.pathname, params)

  const queryToken = params.get('token')?.trim()
  const envToken = import.meta.env.VITE_MOD_CONTROL_TOKEN?.trim()
  const modTestingAllowlist = parseTestingAllowlist(import.meta.env.VITE_MOD_TESTING_ALLOWLIST?.trim())
  const host = window.location.hostname.toLowerCase()
  const allowedHosts = parseAllowedControlHosts(import.meta.env.VITE_CONTROL_ALLOWED_HOSTS?.trim())
  const hostAllowed = allowedHosts.includes(host)
  const allowQueryToken = host === 'localhost' || host === '127.0.0.1'
  const modToken = (allowQueryToken ? queryToken : '') || envToken || ''

  return {
    apiBase,
    tenantSlug,
    authErrorHint,
    legacyApiBaseDetected,
    host,
    allowedHosts,
    hostAllowed,
    modToken,
    modTestingAllowlist,
    authMode: modToken ? 'legacy-bearer' : 'twitch-session',
    tokenSource: modToken ? (allowQueryToken && queryToken ? 'query(local-only)' : 'env') : 'none',
    queryTokenBlocked: Boolean(queryToken && !allowQueryToken),
  }
}

function buildModHeaders(token: string, includeContentType = false): Record<string, string> {
  const headers: Record<string, string> = {}
  if (includeContentType) {
    headers['content-type'] = 'application/json'
  }

  if (token) {
    headers.authorization = `Bearer ${token}`
  }

  return headers
}

function formatControlError(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Request failed.'
  const compact = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

  if (compact.includes('Cannot GET /api/mod/options')) {
    return 'This API is missing /api/mod/options. Deploy the updated controller to enable editable option management.'
  }

  if (compact.includes('Cannot GET /api/mod/state')) {
    return 'This API is missing /api/mod/state. Deploy the updated controller to enable full control dashboard data.'
  }

  if (compact.includes('Cannot POST /api/mod/session/new')) {
    return 'This API is missing /api/mod/session/new. Deploy the updated controller to enable fresh-session recovery.'
  }

  if (compact.includes('Cannot POST /api/mod/session/reset-board')) {
    return 'This API is missing /api/mod/session/reset-board. Deploy the updated controller to enable board reset recovery.'
  }

  if (compact.includes('Cannot POST /api/mod/session/continue-blackout')) {
    return 'This API is missing /api/mod/session/continue-blackout. Deploy the updated controller to continue live rounds into blackout.'
  }

  if (compact.includes('Cannot POST /api/mod/uncall')) {
    return 'This API is missing /api/mod/uncall. Deploy the updated controller to allow mistaken callout removal.'
  }

  if (compact.includes('Cannot POST /api/mod/session/refresh-inactive')) {
    return 'This API is missing /api/mod/session/refresh-inactive. Deploy the updated controller to enable inactive-session option refresh.'
  }

  return compact.length > 0 ? compact : 'Request failed.'
}

function describeModAuthError(errorCode: string | null, missingConfig?: string[]): string | null {
  if (!errorCode) {
    return null
  }

  if (errorCode === 'mod_auth_required') {
    return 'Sign in with Twitch to access moderator controls.'
  }

  if (errorCode === 'mod_privileges_required' || errorCode === 'not_moderator') {
    return 'This Twitch account is authenticated but is not the broadcaster or an approved moderator for this channel.'
  }

  if (errorCode === 'invalid_mod_session') {
    return 'Your moderator session is invalid or expired. Sign in again.'
  }

  if (errorCode === 'invalid_mod_auth') {
    return 'Moderator credentials were rejected. Check configured bearer fallback token or sign in again.'
  }

  if (errorCode === 'legacy_mod_token_disabled') {
    return 'Legacy bearer fallback is disabled. Use Twitch sign-in for moderator access.'
  }

  if (errorCode === 'missing_scope') {
    return 'Twitch sign-in is missing required scope user:read:moderated_channels for moderator verification.'
  }

  if (errorCode === 'invalid_oauth_callback' || errorCode === 'invalid_oauth_state' || errorCode === 'oauth_redirect_mismatch') {
    return 'Twitch callback failed or expired. Start sign-in again from control.custom-overlays.com.'
  }

  if (errorCode === 'mod_auth_not_configured') {
    if (missingConfig && missingConfig.length > 0) {
      return `Moderator auth is not fully configured on the API. Missing: ${missingConfig.join(', ')}`
    }

    return 'Moderator auth is not fully configured on the API.'
  }

  if (errorCode === 'oauth_failed' || errorCode === 'auth_failed') {
    return 'Twitch sign-in failed. Try again.'
  }

  return null
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null
  }

  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : null
}

function getErrorPayload(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== 'object') {
    return null
  }

  const payload = (error as { payload?: unknown }).payload
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
}

function isAuthFailureStatus(status: number | null): boolean {
  return status === 401 || status === 403 || status === 503
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min
  }

  return Math.max(min, Math.min(max, Math.floor(value)))
}

function fallbackOptionsFromLabels(labels: string[]): ModOptionsResponse {
  const now = new Date().toISOString()
  return {
    count: labels.length,
    enabledCount: labels.length,
    options: labels.map((label, index) => ({
      id: `legacy_${index}_${slugify(label) || 'option'}`,
      label,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })),
  }
}

function fallbackStateFromSession(session: SessionSummary, optionCount: number): ModStateResponse {
  return {
    ok: true,
    optionPool: {
      total: optionCount,
      enabled: optionCount,
      disabled: 0,
      canStart: optionCount >= minOptionsForFiveByFive,
    },
    activePlayers: [],
    activeSession: session.status === 'idle' ? null : session,
  }
}

function toThemeVariableName(key: keyof ThemePalette): string {
  return `--theme-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`
}

function applyResolvedThemeToDocument(theme: ResolvedTheme | null): void {
  if (!theme) {
    return
  }

  const root = document.documentElement
  root.dataset.themeMode = theme.mode

  const palette = theme.palette
  for (const key of Object.keys(palette) as (keyof ThemePalette)[]) {
    root.style.setProperty(toThemeVariableName(key), palette[key])
  }
}

function normalizeThemeOverrides(overrides: Partial<ThemePalette> | undefined | null): Partial<ThemePalette> {
  const normalized: Partial<ThemePalette> = {}
  if (!overrides) {
    return normalized
  }

  for (const key of themePaletteKeys) {
    const value = overrides[key]
    if (typeof value === 'string' && hexColorRegex.test(value)) {
      normalized[key] = value
    }
  }

  return normalized
}

function normalizeThemeMode(value: unknown): ThemeMode | null {
  if (value === 'dark' || value === 'light') {
    return value
  }

  return null
}

function normalizeThemeSkinId(value: unknown): string {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!skinIdPattern.test(normalized)) {
    return ''
  }

  return normalized
}

function normalizeUiThemeBackgroundStyle(value: unknown): UiThemeBackgroundStyle | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  return supportedUiThemeBackgroundStyles.has(normalized as UiThemeBackgroundStyle)
    ? (normalized as UiThemeBackgroundStyle)
    : null
}

function parseUiThemeBackgroundStyleFromSkinPayload(payload: unknown): UiThemeBackgroundStyle | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const root = payload as { uiTheme?: unknown }
  if (!root.uiTheme || typeof root.uiTheme !== 'object') {
    return null
  }

  const uiTheme = root.uiTheme as { backgroundStyle?: unknown }
  return normalizeUiThemeBackgroundStyle(uiTheme.backgroundStyle)
}

async function fetchSkinUiThemeBackgroundStyle(skinId: string): Promise<UiThemeBackgroundStyle | null> {
  if (!skinIdPattern.test(skinId)) {
    return null
  }

  try {
    const response = await fetch(`/skins/${encodeURIComponent(skinId)}/skin.json`, {
      credentials: 'same-origin',
      cache: 'no-store',
    })

    if (!response.ok) {
      return null
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.includes('application/json')) {
      return null
    }

    const payload = (await response.json()) as unknown
    return parseUiThemeBackgroundStyleFromSkinPayload(payload)
  } catch {
    return null
  }
}

function normalizeThemeSkinEntry(entry: unknown): ThemeSkinEntry | null {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const candidate = entry as {
    id?: unknown
    name?: unknown
    description?: unknown
    season?: unknown
    tags?: unknown
    mode?: unknown
    palette?: unknown
    controllerPalette?: unknown
    cardsPalette?: unknown
  }

  const id = String(candidate.id ?? '').trim().toLowerCase()
  const name = String(candidate.name ?? '').trim()
  if (!skinIdPattern.test(id) || name.length === 0) {
    return null
  }

  const tags = Array.isArray(candidate.tags)
    ? candidate.tags
      .filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
      .map((tag) => tag.trim().toLowerCase())
    : []

  return {
    id,
    name,
    description: String(candidate.description ?? '').trim(),
    season: String(candidate.season ?? '').trim().toLowerCase(),
    tags,
    mode: normalizeThemeMode(candidate.mode),
    palette: normalizeThemeOverrides(candidate.palette as Partial<ThemePalette>),
    controllerPalette: normalizeThemeOverrides(candidate.controllerPalette as Partial<ThemePalette>),
    cardsPalette: normalizeThemeOverrides(candidate.cardsPalette as Partial<ThemePalette>),
  }
}

function normalizeThemeSkinManifest(payload: unknown): ThemeSkinEntry[] {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Skin library manifest is not valid JSON.')
  }

  const candidate = payload as { schemaVersion?: unknown; skins?: unknown }
  if (candidate.schemaVersion !== 1) {
    throw new Error('Skin library manifest must use schemaVersion 1.')
  }

  if (!Array.isArray(candidate.skins)) {
    throw new Error('Skin library manifest is missing a valid skins array.')
  }

  const normalized: ThemeSkinEntry[] = []
  for (const entry of candidate.skins) {
    const next = normalizeThemeSkinEntry(entry)
    if (!next) {
      continue
    }

    if (normalized.some((skin) => skin.id === next.id)) {
      continue
    }

    normalized.push(next)
  }

  return normalized
}

function toThemePreviewStyle(theme: ResolvedTheme | null): CSSProperties {
  if (!theme) {
    return {}
  }

  const style: Record<string, string> = {}
  for (const key of themePaletteKeys) {
    style[toThemeVariableName(key)] = theme.palette[key]
  }

  return style as CSSProperties
}

function serializeThemeOverrides(overrides: Partial<ThemePalette>): string {
  const entries = (Object.entries(overrides) as Array<[keyof ThemePalette, string]>)
    .filter(([, value]) => typeof value === 'string' && hexColorRegex.test(value))
    .sort(([left], [right]) => left.localeCompare(right))

  return JSON.stringify(entries)
}

function toCompleteThemePalettePatch(overrides: Partial<ThemePalette>): Record<keyof ThemePalette, string | null> {
  const normalized = normalizeThemeOverrides(overrides)
  const patch = {} as Record<keyof ThemePalette, string | null>

  for (const key of themePaletteKeys) {
    patch[key] = normalized[key] ?? null
  }

  return patch
}

function normalizeActivePlayers(input: ActivePlayerSummary[] | undefined): ActivePlayerSummary[] {
  if (!Array.isArray(input)) {
    return []
  }

  const playersById = new Map<string, ActivePlayerSummary>()
  for (const entry of input) {
    const userId = entry.userId.trim()
    const userName = entry.userName.trim()
    if (!userId || !userName || playersById.has(userId)) {
      continue
    }

    playersById.set(userId, {
      userId,
      userName,
      hasWon: Boolean(entry.hasWon),
    })
  }

  return [...playersById.values()]
}

function shuffleItems<T>(items: T[]): T[] {
  const next = [...items]
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    const temp = next[index]
    next[index] = next[swapIndex]
    next[swapIndex] = temp
  }

  return next
}

function pickNextRandomPlayerId(
  players: ActivePlayerSummary[],
  currentQueue: string[],
  currentSelectedPlayerId: string | null,
): { nextSelectedPlayerId: string | null; nextQueue: string[] } {
  if (players.length === 0) {
    return {
      nextSelectedPlayerId: null,
      nextQueue: [],
    }
  }

  const allPlayerIds = players.map((player) => player.userId)
  const validPlayerIds = new Set(allPlayerIds)
  let queue = currentQueue.filter((playerId) => validPlayerIds.has(playerId))

  if (queue.length === 0) {
    const initialCandidates =
      allPlayerIds.length > 1 && currentSelectedPlayerId
        ? allPlayerIds.filter((playerId) => playerId !== currentSelectedPlayerId)
        : allPlayerIds

    queue = shuffleItems(initialCandidates.length > 0 ? initialCandidates : allPlayerIds)
  }

  const [nextSelectedPlayerId, ...nextQueue] = queue
  return {
    nextSelectedPlayerId: nextSelectedPlayerId ?? null,
    nextQueue,
  }
}

function normalizeOptionsResponse(payload: unknown): OptionsResponse {
  if (Array.isArray(payload)) {
    const options = payload.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    return {
      count: options.length,
      options,
    }
  }

  if (payload && typeof payload === 'object') {
    const candidate = payload as { count?: unknown; options?: unknown }
    const options = Array.isArray(candidate.options)
      ? candidate.options.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : []

    const parsedCount =
      typeof candidate.count === 'number' && Number.isFinite(candidate.count)
        ? Math.max(Math.floor(candidate.count), options.length)
        : options.length

    return {
      count: parsedCount,
      options,
    }
  }

  return {
    count: 0,
    options: [],
  }
}

function createDefaultCapabilities(): ControlCapabilities {
  return {
    modState: false,
    modOptions: false,
    modSessionControl: false,
    modTheme: false,
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
  })
  const text = await response.text()

  let payload: unknown = null
  if (text.length > 0) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { message: text }
    }
  }

  if (!response.ok) {
    const payloadRecord = payload as Record<string, unknown> | null
    const message =
      (payloadRecord?.message as string | undefined) ??
      (payloadRecord?.error as string | undefined) ??
      `${response.status} ${response.statusText}`
    const requestError = new Error(message) as Error & {
      status: number
      payload: unknown
    }
    requestError.status = response.status
    requestError.payload = payload
    throw requestError
  }

  return payload as T
}

function App() {
  const {
    apiBase,
    tenantSlug,
    authErrorHint,
    host,
    allowedHosts,
    hostAllowed,
    modToken,
    modTestingAllowlist,
    authMode,
    legacyApiBaseDetected,
  } = useMemo(() => resolveControlContext(), [])

  const legacyApiHint = getLegacyControlApiHintMessage(legacyApiBaseDetected)

  const [mode, setMode] = useState<BingoMode>('normal')
  const [maxWinners, setMaxWinners] = useState<number>(defaultMaxWinners)
  const [winnerGraceSeconds, setWinnerGraceSeconds] = useState<number>(30)
  const [callInput, setCallInput] = useState('')
  const [newOptionLabel, setNewOptionLabel] = useState('')
  const [editOptionId, setEditOptionId] = useState<string | null>(null)
  const [editOptionLabel, setEditOptionLabel] = useState('')
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([])
  const [selectionAnchorOptionId, setSelectionAnchorOptionId] = useState<string | null>(null)

  const [sessionData, setSessionData] = useState<SessionSummary | null>(null)
  const [stateData, setStateData] = useState<ModStateResponse | null>(null)
  const [optionsData, setOptionsData] = useState<ModOptionsResponse | null>(null)
  const [sessionOptions, setSessionOptions] = useState<string[]>([])
  const [capabilities, setCapabilities] = useState<ControlCapabilities>(() => createDefaultCapabilities())
  const [authGateState, setAuthGateState] = useState<AuthGateState>('checking')
  const [authStatus, setAuthStatus] = useState<ModAuthStatusResponse | null>(null)
  const [authNotice, setAuthNotice] = useState<string | null>(() => describeModAuthError(authErrorHint || null) ?? legacyApiHint)
  const [authHintMessage, setAuthHintMessage] = useState<string | null>(
    () => describeModAuthError(authErrorHint || null) ?? legacyApiHint,
  )

  const [themeModeDraft, setThemeModeDraft] = useState<ThemeMode>('dark')
  const [themeLinkDraft, setThemeLinkDraft] = useState(true)
  const [themeOverridesDraft, setThemeOverridesDraft] = useState<Partial<ThemePalette>>({})
  const [themeControllerOverridesDraft, setThemeControllerOverridesDraft] = useState<Partial<ThemePalette>>({})
  const [themeCardsOverridesDraft, setThemeCardsOverridesDraft] = useState<Partial<ThemePalette>>({})
  const [themeInitialized, setThemeInitialized] = useState(false)
  const [themeCompactView, setThemeCompactView] = useState(false)
  const [skinLibraryState, setSkinLibraryState] = useState<SkinLibraryState>('idle')
  const [skinLibrary, setSkinLibrary] = useState<ThemeSkinEntry[]>([])
  const [skinLibraryNotice, setSkinLibraryNotice] = useState<string | null>(null)
  const [selectedSkinId, setSelectedSkinId] = useState('')
  const [uiBackgroundStyle, setUiBackgroundStyle] = useState<UiThemeBackgroundStyle | null>(null)
  const [skinDraftNotice, setSkinDraftNotice] = useState<string | null>(null)
  const [themePreviewScope, setThemePreviewScope] = useState<ThemeEditorScope>('cards')
  const [themePreviewActionVariant, setThemePreviewActionVariant] = useState<'primary' | 'secondary'>('primary')
  const [randomSelectionQueue, setRandomSelectionQueue] = useState<string[]>([])
  const [selectedRandomPlayerId, setSelectedRandomPlayerId] = useState<string | null>(null)
  const [randomSelectionNotice, setRandomSelectionNotice] = useState<string | null>(null)
  const [themeScopeExpanded, setThemeScopeExpanded] = useState<Record<ThemeEditorScope, boolean>>(
    () => createDefaultThemeScopeExpansionState(),
  )
  const [themeExpandedCategories, setThemeExpandedCategories] = useState<Record<ThemeEditorScope, ThemeColorCategory[]>>(
    () => createDefaultThemeCategoryExpansionState(),
  )
  const [existingRoundOptionsExpanded, setExistingRoundOptionsExpanded] = useState(false)
  const [activeView, setActiveView] = useState<ControlView>('round')

  const [winnerConfig, setWinnerConfig] = useState<{
    min: number
    max: number
    defaultMaxWinners: number
    gracePeriodSeconds: number
    winnerGraceSecondsMin: number
    winnerGraceSecondsMax: number
  }>({
    min: 1,
    max: 4,
    defaultMaxWinners,
    gracePeriodSeconds: 30,
    winnerGraceSecondsMin: 15,
    winnerGraceSecondsMax: 300,
  })

  const [loading, setLoading] = useState(true)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [compatNotice, setCompatNotice] = useState<string | null>(null)
  const [testingLinkResult, setTestingLinkResult] = useState<ModTestingViewerLinkResponse | null>(null)
  const [testingNotice, setTestingNotice] = useState<string | null>(null)
  const [testingError, setTestingError] = useState<string | null>(null)

  const modHeaders = useMemo(() => buildModHeaders(modToken), [modToken])
  const modJsonHeaders = useMemo(() => buildModHeaders(modToken, true), [modToken])
  const selectedOptionSet = useMemo(() => new Set(selectedOptionIds), [selectedOptionIds])
  const testingAllowlistConfigured = modTestingAllowlist.length > 0
  const activePlayerSessionStatus: SessionStatus = stateData?.activeSession?.status ?? sessionData?.status ?? 'idle'
  const activePlayerRoundLive = activePlayerSessionStatus === 'open' || activePlayerSessionStatus === 'running'
  const selectedOptions = useMemo(() => {
    const options = optionsData?.options ?? []
    return options.filter((option) => selectedOptionSet.has(option.id))
  }, [optionsData?.options, selectedOptionSet])
  const selectedEnabledCount = useMemo(() => selectedOptions.filter((option) => option.enabled).length, [selectedOptions])
  const selectedDisabledCount = useMemo(() => selectedOptions.filter((option) => !option.enabled).length, [selectedOptions])
  const activePlayers = useMemo(() => {
    const normalizedPlayers = normalizeActivePlayers(stateData?.activePlayers)
    return activePlayerRoundLive ? normalizedPlayers : []
  }, [activePlayerRoundLive, stateData?.activePlayers])
  const activePlayerWinnerCount = useMemo(() => activePlayers.filter((player) => player.hasWon).length, [activePlayers])
  const selectedRandomPlayer = useMemo(
    () => activePlayers.find((player) => player.userId === selectedRandomPlayerId) ?? null,
    [activePlayers, selectedRandomPlayerId],
  )
  const hasRandomSelectionState = selectedRandomPlayerId !== null || randomSelectionQueue.length > 0 || randomSelectionNotice !== null
  const canAccessTesting = useMemo(() => {
    return isTestingIdentityAllowlisted(authStatus?.user ?? null, modTestingAllowlist)
  }, [authStatus?.user, modTestingAllowlist])
  const visibleControlViews = controlViews
  const selectedSkin = useMemo(
    () => skinLibrary.find((skin) => skin.id === selectedSkinId) ?? null,
    [selectedSkinId, skinLibrary],
  )
  const themePreviewCells = useMemo<ThemePreviewCell[]>(() => {
    const enabledOptionLabels = (optionsData?.options ?? [])
      .filter((option) => option.enabled)
      .map((option) => option.label.trim())
      .filter((label) => label.length > 0)

    const cells: ThemePreviewCell[] = []
    let optionLabelIndex = 0
    let fallbackLabelIndex = 0

    for (const state of themePreviewCellStatePattern) {
      if (state === 'free') {
        cells.push({ label: 'FREE', state: 'free' })
        continue
      }

      const optionLabel = enabledOptionLabels[optionLabelIndex]
      if (optionLabel) {
        cells.push({ label: optionLabel, state })
        optionLabelIndex += 1
        continue
      }

      const fallbackLabel = themePreviewFallbackLabels[fallbackLabelIndex] ?? `Sample Option ${fallbackLabelIndex + 1}`
      cells.push({ label: fallbackLabel, state })
      fallbackLabelIndex += 1
    }

    return cells
  }, [optionsData?.options])

  function applyAuthFailure(nextError: unknown): false {
    const status = getErrorStatus(nextError)
    const payload = getErrorPayload(nextError)
    const errorCode = typeof payload?.error === 'string' ? payload.error : null
    const missing = Array.isArray(payload?.missing)
      ? payload.missing.filter((entry): entry is string => typeof entry === 'string')
      : []
    const allowLegacyToken = typeof payload?.allowLegacyToken === 'boolean' ? payload.allowLegacyToken : undefined
    const legacyTokenUsed = typeof payload?.legacyTokenUsed === 'boolean' ? payload.legacyTokenUsed : undefined
    const roleCandidate = typeof payload?.role === 'string' ? payload.role : undefined
    const role =
      roleCandidate === 'broadcaster' ||
      roleCandidate === 'moderator' ||
      roleCandidate === 'unauthorized' ||
      roleCandidate === 'legacy'
        ? roleCandidate
        : undefined

    let user: ModAuthUser | null = null
    const userPayload = payload?.user
    if (userPayload && typeof userPayload === 'object') {
      const candidate = userPayload as Record<string, unknown>
      if (
        typeof candidate.userId === 'string' &&
        typeof candidate.userLogin === 'string' &&
        typeof candidate.userName === 'string'
      ) {
        user = {
          userId: candidate.userId,
          userLogin: candidate.userLogin,
          userName: candidate.userName,
        }
      }
    }

    const authenticated = typeof payload?.authenticated === 'boolean' ? payload.authenticated : status === 403
    const authorized = typeof payload?.authorized === 'boolean' ? payload.authorized : false

    setAuthStatus({
      authenticated,
      authorized,
      error: errorCode ?? undefined,
      role,
      allowLegacyToken,
      legacyTokenUsed,
      user,
      missing,
    })
    setAuthGateState(status === 403 ? 'forbidden' : 'signed_out')

    const hintMessage = authHintMessage
    const reasonMessage = describeModAuthError(errorCode, missing)
    setAuthNotice(hintMessage ?? reasonMessage ?? formatControlError(nextError))
    if (hintMessage) {
      setAuthHintMessage(null)
    }

    setError(null)
    setCompatNotice(null)
    return false
  }

  async function refreshAuthState(): Promise<boolean> {
    try {
      const nextStatus = await requestJson<ModAuthStatusResponse>(
        buildApiUrl(apiBase, tenantSlug, '/mod/auth/me'),
        { headers: modHeaders },
      )

      setAuthStatus(nextStatus)
      if (nextStatus.authorized) {
        setAuthGateState('authorized')
        setAuthNotice(null)
        if (authHintMessage) {
          setAuthHintMessage(null)
        }
        return true
      }

      const resolvedGate = nextStatus.authenticated ? 'forbidden' : 'signed_out'
      setAuthGateState(resolvedGate)
      const reasonMessage = describeModAuthError(nextStatus.error ?? null, nextStatus.missing)
      const hintMessage = authHintMessage
      setAuthNotice(hintMessage ?? reasonMessage)
      if (hintMessage) {
        setAuthHintMessage(null)
      }
      return false
    } catch (nextError) {
      return applyAuthFailure(nextError)
    }
  }

  async function refreshData() {
    if (!hostAllowed) {
      return
    }

    const [nextSession, rawSessionOptions] = await Promise.all([
      requestJson<SessionSummary>(buildApiUrl(apiBase, tenantSlug, '/session')),
      requestJson<unknown>(buildApiUrl(apiBase, tenantSlug, '/options')),
    ])

    const nextSessionOptions = normalizeOptionsResponse(rawSessionOptions)

    setSessionData(nextSession)
    setSessionOptions(nextSessionOptions.options)

    const nextCapabilities: ControlCapabilities = {
      modState: false,
      modOptions: false,
      modSessionControl: false,
      modTheme: false,
    }

    const notices: string[] = []
    let nextState: ModStateResponse | null = null

    try {
      nextState = await requestJson<ModStateResponse>(buildApiUrl(apiBase, tenantSlug, '/mod/state'), {
        headers: modHeaders,
      })
      nextCapabilities.modState = true

      if (nextState.winnerConfig) {
        const min = clampInteger(nextState.winnerConfig.min, 1, 16)
        const max = clampInteger(nextState.winnerConfig.max, min, 16)
        const defaultWinnerLimit = clampInteger(nextState.winnerConfig.defaultMaxWinners, min, max)
        const winnerGraceSecondsMin = clampInteger(nextState.winnerConfig.winnerGraceSecondsMin ?? 15, 1, 600)
        const winnerGraceSecondsMax = clampInteger(
          nextState.winnerConfig.winnerGraceSecondsMax ?? 300,
          winnerGraceSecondsMin,
          600,
        )
        const graceSeconds = clampInteger(
          nextState.winnerConfig.gracePeriodSeconds,
          winnerGraceSecondsMin,
          winnerGraceSecondsMax,
        )

        setWinnerConfig({
          min,
          max,
          defaultMaxWinners: defaultWinnerLimit,
          gracePeriodSeconds: graceSeconds,
          winnerGraceSecondsMin,
          winnerGraceSecondsMax,
        })

        setMaxWinners((current) => clampInteger(current, min, max))
        setWinnerGraceSeconds((current) => {
          if (current === winnerConfig.gracePeriodSeconds) {
            return graceSeconds
          }

          return clampInteger(current, winnerGraceSecondsMin, winnerGraceSecondsMax)
        })
        nextCapabilities.modSessionControl = true
      }

      if (nextState.theme) {
        nextCapabilities.modTheme = true
      }
    } catch (nextError) {
      if (isAuthFailureStatus(getErrorStatus(nextError))) {
        throw nextError
      }

      notices.push(formatControlError(nextError))
    }

    let nextPool: ModOptionsResponse | null = null
    try {
      nextPool = await requestJson<ModOptionsResponse>(buildApiUrl(apiBase, tenantSlug, '/mod/options'), {
        headers: modHeaders,
      })
      nextCapabilities.modOptions = true
    } catch (nextError) {
      if (isAuthFailureStatus(getErrorStatus(nextError))) {
        throw nextError
      }

      notices.push(formatControlError(nextError))
    }

    const missingFeatures: string[] = []
    if (!nextCapabilities.modState) {
      missingFeatures.push('/api/mod/state')
    }
    if (!nextCapabilities.modOptions) {
      missingFeatures.push('/api/mod/options')
    }
    if (nextCapabilities.modState && !nextCapabilities.modSessionControl) {
      missingFeatures.push('winner policy + session recovery endpoints')
    }
    if (nextCapabilities.modState && !nextCapabilities.modTheme) {
      missingFeatures.push('/api/mod/theme')
    }

    setCapabilities(nextCapabilities)
    setStateData(nextState ?? fallbackStateFromSession(nextSession, nextSessionOptions.count))
    setOptionsData(nextPool ?? fallbackOptionsFromLabels(nextSessionOptions.options))

    if (missingFeatures.length > 0 || notices.length > 0) {
      setCompatNotice(
        `Compatibility mode active. Missing features: ${missingFeatures.join(', ') || 'unknown'}. Deploy latest controller for full controls.`,
      )
    } else {
      setCompatNotice(null)
    }
  }

  async function refreshAuthorizedData() {
    const authorized = await refreshAuthState()
    if (!authorized) {
      setSessionData(null)
      setStateData(null)
      setOptionsData(null)
      setSessionOptions([])
      setCapabilities(createDefaultCapabilities())
      return
    }

    await refreshData()
    setError(null)
  }

  function beginModSignIn() {
    const signInUrl = new URL(buildApiUrl(apiBase, tenantSlug, '/mod/auth/twitch/start'))
    signInUrl.searchParams.set('returnTo', buildModReturnToUrl(apiBase))
    window.location.assign(signInUrl.toString())
  }

  async function refreshAuthAndData() {
    setLoading(true)
    setError(null)

    try {
      await refreshAuthorizedData()
    } catch (nextError) {
      if (isAuthFailureStatus(getErrorStatus(nextError))) {
        applyAuthFailure(nextError)
      } else {
        setError(formatControlError(nextError))
      }
    } finally {
      setLoading(false)
    }
  }

  async function submitModSignOut() {
    setPendingAction('Sign out')
    setError(null)
    setMessage(null)

    try {
      await requestJson(buildApiUrl(apiBase, tenantSlug, '/mod/auth/logout'), {
        method: 'POST',
        headers: modJsonHeaders,
      })

      setAuthGateState('signed_out')
      setAuthStatus({
        authenticated: false,
        authorized: false,
        error: 'mod_auth_required',
        allowLegacyToken: authStatus?.allowLegacyToken,
      })
      setAuthNotice(
        modToken
          ? 'Twitch session was cleared. This client still sends configured bearer fallback credentials.'
          : 'You are signed out. Sign in with Twitch to access moderator controls.',
      )
      setSessionData(null)
      setStateData(null)
      setOptionsData(null)
      setSessionOptions([])
      setCapabilities(createDefaultCapabilities())
      setCompatNotice(null)
      setMessage('Sign out completed.')
    } catch (nextError) {
      setError(formatControlError(nextError))
    } finally {
      setPendingAction(null)
    }
  }

  useEffect(() => {
    const url = new URL(window.location.href)
    const queryApi = url.searchParams.get('api')?.trim()
    if (!queryApi) {
      return
    }

    const normalized = resolveControlApiBase(queryApi)
    if (!normalized.legacyApiBaseDetected) {
      return
    }

    url.searchParams.set('api', normalized.apiBase)
    window.history.replaceState({}, document.title, url.toString())
  }, [])

  useEffect(() => {
    if (!authErrorHint) {
      return
    }

    const url = new URL(window.location.href)
    url.searchParams.delete('modAuthError')
    window.history.replaceState({}, document.title, url.toString())
  }, [authErrorHint])

  useEffect(() => {
    const validOptionIds = new Set((optionsData?.options ?? []).map((option) => option.id))
    setSelectedOptionIds((current) => {
      const next = current.filter((optionId) => validOptionIds.has(optionId))
      const unchanged = next.length === current.length && next.every((optionId, index) => optionId === current[index])
      return unchanged ? current : next
    })

    setSelectionAnchorOptionId((current) => {
      if (!current) {
        return null
      }

      return validOptionIds.has(current) ? current : null
    })
  }, [optionsData?.options])

  useEffect(() => {
    const validPlayerIds = new Set(activePlayers.map((player) => player.userId))
    setRandomSelectionQueue((current) => current.filter((playerId) => validPlayerIds.has(playerId)))

    setSelectedRandomPlayerId((current) => {
      if (!current) {
        return null
      }

      return validPlayerIds.has(current) ? current : null
    })

    if (activePlayers.length === 0) {
      setRandomSelectionNotice(null)
    }
  }, [activePlayers])

  useEffect(() => {
    if (!hostAllowed) {
      setLoading(false)
      return
    }

    let active = true

    async function loadInitial() {
      try {
        await refreshAuthorizedData()
        if (!active) {
          return
        }
        setError(null)
      } catch (nextError) {
        if (!active) {
          return
        }

        if (isAuthFailureStatus(getErrorStatus(nextError))) {
          applyAuthFailure(nextError)
        } else {
          setError(formatControlError(nextError))
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    void loadInitial()

    return () => {
      active = false
    }
  }, [apiBase, tenantSlug, hostAllowed, modHeaders])

  useEffect(() => {
    if (!hostAllowed || authGateState !== 'authorized') {
      return
    }

    let active = true
    const timer = window.setInterval(() => {
      void refreshData().catch((nextError) => {
        if (!active) {
          return
        }

        if (isAuthFailureStatus(getErrorStatus(nextError))) {
          applyAuthFailure(nextError)
          return
        }

        setError(formatControlError(nextError))
      })
    }, pollIntervalMs)

    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [apiBase, tenantSlug, authGateState, hostAllowed, modHeaders])

  useEffect(() => {
    if (!hostAllowed || authGateState !== 'authorized' || activeView !== 'theme') {
      return
    }

    if (skinLibraryState !== 'idle') {
      return
    }

    void loadThemeSkinLibrary()
  }, [activeView, authGateState, hostAllowed, skinLibraryState])

  useEffect(() => {
    setSelectedSkinId((current) => {
      if (!current) {
        return current
      }

      return skinLibrary.some((skin) => skin.id === current) ? current : ''
    })
  }, [skinLibrary])

  useEffect(() => {
    if (activeView === 'testing') {
      return
    }

    setTestingLinkResult(null)
    setTestingNotice(null)
    setTestingError(null)
  }, [activeView])

  const activeSession = useMemo(() => {
    if (stateData?.activeSession) {
      return stateData.activeSession
    }

    if (sessionData && sessionData.status !== 'idle') {
      return sessionData
    }

    return null
  }, [sessionData, stateData?.activeSession])

  const serverControllerTheme = useMemo<ResolvedTheme | null>(() => {
    return stateData?.controllerTheme ?? stateData?.theme ?? sessionData?.theme ?? null
  }, [sessionData?.theme, stateData?.controllerTheme, stateData?.theme])

  const serverCardsTheme = useMemo<ResolvedTheme | null>(() => {
    return stateData?.cardsTheme ?? stateData?.theme ?? sessionData?.theme ?? null
  }, [sessionData?.theme, stateData?.cardsTheme, stateData?.theme])

  const serverThemeMode = useMemo<ThemeMode>(() => {
    return serverControllerTheme?.mode ?? serverCardsTheme?.mode ?? 'dark'
  }, [serverCardsTheme?.mode, serverControllerTheme?.mode])

  const serverThemeLink = useMemo(() => {
    return stateData?.linkControllerAndCards ?? true
  }, [stateData?.linkControllerAndCards])

  const serverThemeSkinId = useMemo(() => {
    const normalized = normalizeThemeSkinId(serverCardsTheme?.skinId ?? serverControllerTheme?.skinId ?? '')
    if (!normalized) {
      return ''
    }

    if (skinLibraryState === 'ready' && !skinLibrary.some((skin) => skin.id === normalized)) {
      return ''
    }

    return normalized
  }, [serverCardsTheme?.skinId, serverControllerTheme?.skinId, skinLibrary, skinLibraryState])

  const activeUiThemeSkinId = useMemo(() => {
    return normalizeThemeSkinId(serverCardsTheme?.skinId ?? serverControllerTheme?.skinId ?? '')
  }, [serverCardsTheme?.skinId, serverControllerTheme?.skinId])

  const serverThemeOverrides = useMemo<Partial<ThemePalette>>(() => {
    return normalizeThemeOverrides(stateData?.themeOverrides)
  }, [stateData?.themeOverrides])

  const serverControllerThemeOverrides = useMemo<Partial<ThemePalette>>(() => {
    return normalizeThemeOverrides(stateData?.scopedOverrides?.controller)
  }, [stateData?.scopedOverrides?.controller])

  const serverCardsThemeOverrides = useMemo<Partial<ThemePalette>>(() => {
    return normalizeThemeOverrides(stateData?.scopedOverrides?.cards)
  }, [stateData?.scopedOverrides?.cards])

  const themeDirty = useMemo(() => {
    if (!themeInitialized || !serverControllerTheme || !serverCardsTheme) {
      return false
    }

    if (themeModeDraft !== serverThemeMode) {
      return true
    }

    if (themeLinkDraft !== serverThemeLink) {
      return true
    }

    if (normalizeThemeSkinId(selectedSkinId) !== serverThemeSkinId) {
      return true
    }

    if (themeLinkDraft) {
      return serializeThemeOverrides(themeOverridesDraft) !== serializeThemeOverrides(serverThemeOverrides)
    }

    return (
      serializeThemeOverrides(themeControllerOverridesDraft) !== serializeThemeOverrides(serverControllerThemeOverrides) ||
      serializeThemeOverrides(themeCardsOverridesDraft) !== serializeThemeOverrides(serverCardsThemeOverrides)
    )
  }, [
    serverCardsTheme,
    serverCardsThemeOverrides,
    serverControllerTheme,
    serverControllerThemeOverrides,
    serverThemeSkinId,
    serverThemeLink,
    serverThemeMode,
    serverThemeOverrides,
    selectedSkinId,
    themeCardsOverridesDraft,
    themeControllerOverridesDraft,
    themeInitialized,
    themeLinkDraft,
    themeModeDraft,
    themeOverridesDraft,
  ])

  const livePreviewControllerTheme = useMemo<ResolvedTheme | null>(() => {
    if (!serverControllerTheme) {
      return null
    }

    if (!themeInitialized || !capabilities.modTheme) {
      return serverControllerTheme
    }

    const globalOverrides = normalizeThemeOverrides(themeLinkDraft ? themeOverridesDraft : serverThemeOverrides)
    const controllerScopedOverrides = themeLinkDraft
      ? {}
      : normalizeThemeOverrides(themeControllerOverridesDraft)

    return {
      mode: themeModeDraft,
      palette: {
        ...themePresets[themeModeDraft],
        ...globalOverrides,
        ...controllerScopedOverrides,
      },
      updatedAt: serverControllerTheme.updatedAt,
    }
  }, [
    capabilities.modTheme,
    serverControllerTheme,
    serverThemeOverrides,
    themeControllerOverridesDraft,
    themeInitialized,
    themeLinkDraft,
    themeModeDraft,
    themeOverridesDraft,
  ])

  const livePreviewCardsTheme = useMemo<ResolvedTheme | null>(() => {
    if (!serverCardsTheme) {
      return null
    }

    if (!themeInitialized || !capabilities.modTheme) {
      return serverCardsTheme
    }

    const globalOverrides = normalizeThemeOverrides(themeLinkDraft ? themeOverridesDraft : serverThemeOverrides)
    const cardsScopedOverrides = themeLinkDraft
      ? {}
      : normalizeThemeOverrides(themeCardsOverridesDraft)

    return {
      mode: themeModeDraft,
      palette: {
        ...themePresets[themeModeDraft],
        ...globalOverrides,
        ...cardsScopedOverrides,
      },
      updatedAt: serverCardsTheme.updatedAt,
    }
  }, [
    capabilities.modTheme,
    serverCardsTheme,
    serverThemeOverrides,
    themeCardsOverridesDraft,
    themeInitialized,
    themeLinkDraft,
    themeModeDraft,
    themeOverridesDraft,
  ])

  const activePreviewTheme = useMemo<ResolvedTheme | null>(() => {
    if (themeLinkDraft) {
      return livePreviewCardsTheme ?? livePreviewControllerTheme
    }

    return themePreviewScope === 'controller'
      ? (livePreviewControllerTheme ?? livePreviewCardsTheme)
      : (livePreviewCardsTheme ?? livePreviewControllerTheme)
  }, [livePreviewCardsTheme, livePreviewControllerTheme, themeLinkDraft, themePreviewScope])

  const activePreviewModeLabel = useMemo(() => {
    if (themeLinkDraft) {
      return 'Linked controller + cards preview'
    }

    return themePreviewScope === 'controller' ? 'Controller preview' : 'Cards preview'
  }, [themeLinkDraft, themePreviewScope])

  const activePreviewSourceLabel = useMemo(() => {
    if (themeLinkDraft) {
      return 'Preview source: linked controller and cards colors'
    }

    return themePreviewScope === 'controller'
      ? 'Preview source: controller scoped colors'
      : 'Preview source: cards scoped colors'
  }, [themeLinkDraft, themePreviewScope])

  const previewActionBehaviorLabel = useMemo(() => {
    return themePreviewActionVariant === 'primary'
      ? 'Selected: Primary Action (main confirm or commit style).'
      : 'Selected: Secondary Action (non-destructive alternate style).'
  }, [themePreviewActionVariant])

  const previewScopesMatch = useMemo(() => {
    if (themeLinkDraft || !livePreviewControllerTheme || !livePreviewCardsTheme) {
      return false
    }

    if (livePreviewControllerTheme.mode !== livePreviewCardsTheme.mode) {
      return false
    }

    for (const key of themePaletteKeys) {
      if (livePreviewControllerTheme.palette[key] !== livePreviewCardsTheme.palette[key]) {
        return false
      }
    }

    return true
  }, [livePreviewCardsTheme, livePreviewControllerTheme, themeLinkDraft])

  const showControllerPreview = themeLinkDraft || themePreviewScope === 'controller'
  const showCardsPreview = themeLinkDraft || themePreviewScope === 'cards'

  const activePreviewStyle = useMemo(() => toThemePreviewStyle(activePreviewTheme), [activePreviewTheme])

  useEffect(() => {
    if (!livePreviewControllerTheme) {
      return
    }

    applyResolvedThemeToDocument(livePreviewControllerTheme)
  }, [livePreviewControllerTheme])

  useEffect(() => {
    let active = true

    if (!activeUiThemeSkinId) {
      setUiBackgroundStyle(null)
      return () => {
        active = false
      }
    }

    void (async () => {
      const nextBackgroundStyle = await fetchSkinUiThemeBackgroundStyle(activeUiThemeSkinId)
      if (!active) {
        return
      }

      setUiBackgroundStyle(nextBackgroundStyle)
    })()

    return () => {
      active = false
    }
  }, [activeUiThemeSkinId])

  useEffect(() => {
    // Wait for the consolidated mod-state payload before hydrating drafts.
    // This avoids initializing from session-only fallback data with missing overrides.
    if (!stateData || !serverControllerTheme || !serverCardsTheme) {
      return
    }

    if (!themeInitialized || !themeDirty) {
      setThemeModeDraft(serverThemeMode)
      setThemeLinkDraft(serverThemeLink)
      setThemeOverridesDraft(serverThemeOverrides)
      setThemeControllerOverridesDraft(serverControllerThemeOverrides)
      setThemeCardsOverridesDraft(serverCardsThemeOverrides)
      setSelectedSkinId(serverThemeSkinId)
      setThemeInitialized(true)
    }
  }, [
    stateData,
    serverCardsTheme,
    serverCardsThemeOverrides,
    serverControllerTheme,
    serverControllerThemeOverrides,
    serverThemeSkinId,
    serverThemeLink,
    serverThemeMode,
    serverThemeOverrides,
    themeDirty,
    themeInitialized,
  ])

  const calledSet = useMemo(() => new Set(activeSession?.calledOptions ?? []), [activeSession?.calledOptions])
  const calledOptions = useMemo(() => {
    const options = activeSession?.calledOptions ?? []
    return [...options].sort((left, right) => left.localeCompare(right))
  }, [activeSession?.calledOptions])

  const callableOptions = useMemo(() => {
    const options = Array.isArray(sessionOptions) ? sessionOptions : []
    return options.filter((option) => !calledSet.has(option))
  }, [calledSet, sessionOptions])

  const quickCallOptions = useMemo(() => callableOptions.slice(0, 8), [callableOptions])

  const winnerRange = useMemo(() => {
    const values: number[] = []
    for (let value = winnerConfig.min; value <= winnerConfig.max; value += 1) {
      values.push(value)
    }

    return values.length > 0 ? values : [defaultMaxWinners]
  }, [winnerConfig.max, winnerConfig.min])

  async function runAction(actionName: string, callback: () => Promise<void>) {
    setPendingAction(actionName)
    setError(null)
    setMessage(null)

    try {
      await callback()
      await refreshData()
      setMessage(`${actionName} completed.`)
    } catch (nextError) {
      if (isAuthFailureStatus(getErrorStatus(nextError))) {
        applyAuthFailure(nextError)
      } else {
        setError(formatControlError(nextError))
      }
    } finally {
      setPendingAction(null)
    }
  }

  function requireOptionManagement(actionName: string): boolean {
    if (capabilities.modOptions) {
      return true
    }

    setError(`${actionName} is disabled until /api/mod/options is available on the deployed controller.`)
    return false
  }

  function requireSessionControl(actionName: string): boolean {
    if (capabilities.modSessionControl) {
      return true
    }

    setError(`${actionName} is disabled until winner policy and session recovery endpoints are available on the deployed controller.`)
    return false
  }

  function requireThemeControl(actionName: string): boolean {
    if (capabilities.modTheme) {
      return true
    }

    setError(`${actionName} is disabled until /api/mod/theme is available on the deployed controller.`)
    return false
  }

  function submitStart(event: FormEvent) {
    event.preventDefault()

    void runAction('Start round', async () => {
      const payload: Record<string, unknown> = {
        mode,
      }

      const enabledPoolOptions = (optionsData?.options ?? [])
        .filter((option) => option.enabled)
        .map((option) => option.label.trim())
        .filter((label) => label.length > 0)

      const dedupedEnabledPoolOptions = [...new Set(enabledPoolOptions)]
      if (dedupedEnabledPoolOptions.length >= minOptionsForFiveByFive) {
        payload.options = dedupedEnabledPoolOptions
      } else if (sessionOptions.length >= minOptionsForFiveByFive) {
        payload.options = sessionOptions
      }

      if (capabilities.modState) {
        payload.maxWinners = maxWinners
        payload.winnerGraceSeconds = winnerGraceSeconds
      }

      await requestJson(buildApiUrl(apiBase, tenantSlug, '/mod/start'), {
        method: 'POST',
        headers: modJsonHeaders,
        body: JSON.stringify(payload),
      })
    })
  }

  function submitNewSession() {
    if (!requireSessionControl('Start new session')) {
      return
    }

    void runAction('Start new session', async () => {
      await requestJson(buildApiUrl(apiBase, tenantSlug, '/mod/session/new'), {
        method: 'POST',
        headers: modJsonHeaders,
        body: JSON.stringify({ mode, maxWinners, winnerGraceSeconds }),
      })
    })
  }

  function submitRefreshInactiveOptions() {
    if (!requireSessionControl('Refresh inactive options')) {
      return
    }

    void runAction('Refresh inactive options', async () => {
      await requestJson(buildApiUrl(apiBase, tenantSlug, '/mod/session/refresh-inactive'), {
        method: 'POST',
        headers: modJsonHeaders,
        body: JSON.stringify({}),
      })
    })
  }

  function submitResetBoard() {
    if (!requireSessionControl('Reset board')) {
      return
    }

    void runAction('Reset board', async () => {
      await requestJson(buildApiUrl(apiBase, tenantSlug, '/mod/session/reset-board'), {
        method: 'POST',
        headers: modJsonHeaders,
        body: JSON.stringify({}),
      })
    })
  }

  function submitContinueBlackout(resetWinnerLedger: boolean) {
    if (!requireSessionControl('Continue to blackout')) {
      return
    }

    if (resetWinnerLedger) {
      const confirmed = window.confirm(
        'Continue to blackout and reset winner ledger? This keeps cards/stamps/calls but clears winner claims.',
      )
      if (!confirmed) {
        return
      }
    }

    const actionName = resetWinnerLedger ? 'Continue blackout and reset winners' : 'Continue to blackout'

    void runAction(actionName, async () => {
      await requestJson(buildApiUrl(apiBase, tenantSlug, '/mod/session/continue-blackout'), {
        method: 'POST',
        headers: modJsonHeaders,
        body: JSON.stringify({ resetWinnerLedger }),
      })
    })
  }

  function submitStop() {
    void runAction('Stop round', async () => {
      await requestJson(buildApiUrl(apiBase, tenantSlug, '/mod/stop'), {
        method: 'POST',
        headers: modJsonHeaders,
        body: JSON.stringify({ end: true }),
      })
    })
  }

  function submitCall(event: FormEvent) {
    event.preventDefault()
    const option = callInput.trim()
    if (!option) {
      setError('Enter an option to call.')
      return
    }

    void runAction('Call option', async () => {
      await requestJson(buildApiUrl(apiBase, tenantSlug, '/mod/call'), {
        method: 'POST',
        headers: modJsonHeaders,
        body: JSON.stringify({ option }),
      })

      setCallInput('')
    })
  }

  function submitUncall(optionInput: string) {
    const option = optionInput.trim()
    if (!option) {
      setError('Choose a called option to remove.')
      return
    }

    void runAction('Uncall option', async () => {
      await requestJson(buildApiUrl(apiBase, tenantSlug, '/mod/uncall'), {
        method: 'POST',
        headers: modJsonHeaders,
        body: JSON.stringify({ option }),
      })

      if (callInput.trim().toLowerCase() === option.toLowerCase()) {
        setCallInput('')
      }
    })
  }

  function submitAddOption(event: FormEvent) {
    event.preventDefault()
    if (!requireOptionManagement('Add option')) {
      return
    }

    const label = newOptionLabel.trim()
    if (!label) {
      setError('Enter an option label to add.')
      return
    }

    void runAction('Add option', async () => {
      await requestJson(buildApiUrl(apiBase, tenantSlug, '/mod/options'), {
        method: 'POST',
        headers: modJsonHeaders,
        body: JSON.stringify({ label }),
      })

      setNewOptionLabel('')
    })
  }

  function handleOptionSelectionChange(optionId: string, event: ChangeEvent<HTMLInputElement>) {
    const visibleOptions = optionsData?.options ?? []
    const targetIndex = visibleOptions.findIndex((option) => option.id === optionId)
    const anchorIndex = selectionAnchorOptionId
      ? visibleOptions.findIndex((option) => option.id === selectionAnchorOptionId)
      : -1
    const shiftPressed = (event.nativeEvent as MouseEvent).shiftKey === true

    if (shiftPressed && targetIndex >= 0 && anchorIndex >= 0) {
      const start = Math.min(anchorIndex, targetIndex)
      const end = Math.max(anchorIndex, targetIndex)
      const rangeIds = visibleOptions.slice(start, end + 1).map((option) => option.id)
      const shouldSelectRange = event.target.checked

      setSelectedOptionIds((current) => {
        const nextSelection = new Set(current)
        for (const rangeId of rangeIds) {
          if (shouldSelectRange) {
            nextSelection.add(rangeId)
            continue
          }

          nextSelection.delete(rangeId)
        }

        return visibleOptions.filter((option) => nextSelection.has(option.id)).map((option) => option.id)
      })
      setSelectionAnchorOptionId(optionId)
      return
    }

    setSelectedOptionIds((current) => {
      if (event.target.checked) {
        if (current.includes(optionId)) {
          return current
        }

        return [...current, optionId]
      }

      if (!current.includes(optionId)) {
        return current
      }

      return current.filter((entry) => entry !== optionId)
    })
    setSelectionAnchorOptionId(optionId)
  }

  function selectAllVisibleOptions() {
    const visibleOptions = optionsData?.options ?? []
    setSelectedOptionIds(visibleOptions.map((option) => option.id))
    setSelectionAnchorOptionId(visibleOptions.length > 0 ? visibleOptions[0].id : null)
  }

  function clearSelectedOptions() {
    setSelectedOptionIds([])
    setSelectionAnchorOptionId(null)
  }

  async function updateOptionEnabledState(optionIds: string[], nextEnabled: boolean) {
    const uniqueOptionIds = [...new Set(optionIds.map((entry) => entry.trim()).filter((entry) => entry.length > 0))]
    if (uniqueOptionIds.length === 0) {
      return
    }

    try {
      await requestJson(buildApiUrl(apiBase, tenantSlug, '/mod/options/bulk'), {
        method: 'POST',
        headers: modJsonHeaders,
        body: JSON.stringify({
          optionIds: uniqueOptionIds,
          enabled: nextEnabled,
        }),
      })
      return
    } catch (nextError) {
      if (getErrorStatus(nextError) !== 404) {
        throw nextError
      }
    }

    for (const optionId of uniqueOptionIds) {
      await requestJson(buildApiUrl(apiBase, tenantSlug, `/mod/options/${encodeURIComponent(optionId)}`), {
        method: 'PATCH',
        headers: modJsonHeaders,
        body: JSON.stringify({ enabled: nextEnabled }),
      })
    }
  }

  async function removeOptionIds(optionIds: string[]) {
    const uniqueOptionIds = [...new Set(optionIds.map((entry) => entry.trim()).filter((entry) => entry.length > 0))]
    if (uniqueOptionIds.length === 0) {
      return
    }

    try {
      await requestJson(buildApiUrl(apiBase, tenantSlug, '/mod/options/bulk-delete'), {
        method: 'POST',
        headers: modJsonHeaders,
        body: JSON.stringify({
          optionIds: uniqueOptionIds,
        }),
      })
      return
    } catch (nextError) {
      if (getErrorStatus(nextError) !== 404) {
        throw nextError
      }

      const payload = getErrorPayload(nextError)
      if (payload?.error === 'option_not_found') {
        throw nextError
      }
    }

    for (const optionId of uniqueOptionIds) {
      await requestJson(buildApiUrl(apiBase, tenantSlug, `/mod/options/${encodeURIComponent(optionId)}`), {
        method: 'DELETE',
        headers: modHeaders,
      })
    }
  }

  function submitEnableSelectedOptions() {
    if (!requireOptionManagement('Enable selected options')) {
      return
    }

    const selectedSet = new Set(selectedOptionIds)
    const disabledTargets = (optionsData?.options ?? []).filter((option) => selectedSet.has(option.id) && !option.enabled)
    if (disabledTargets.length === 0) {
      setError('Select one or more disabled options to enable.')
      return
    }

    void runAction('Enable selected options', async () => {
      await updateOptionEnabledState(
        disabledTargets.map((option) => option.id),
        true,
      )

      setSelectedOptionIds([])
      setSelectionAnchorOptionId(null)
    })
  }

  function submitDisableSelectedOptions() {
    if (!requireOptionManagement('Disable selected options')) {
      return
    }

    const selectedSet = new Set(selectedOptionIds)
    const enabledTargets = (optionsData?.options ?? []).filter((option) => selectedSet.has(option.id) && option.enabled)
    if (enabledTargets.length === 0) {
      setError('Select one or more enabled options to disable.')
      return
    }

    const enabledCount = optionsData?.enabledCount ?? (optionsData?.options ?? []).filter((option) => option.enabled).length
    if (enabledCount - enabledTargets.length < minOptionsForFiveByFive) {
      setError(
        `Cannot disable ${enabledTargets.length} option(s). Pool must keep at least ${minOptionsForFiveByFive} enabled options.`,
      )
      return
    }

    void runAction('Disable selected options', async () => {
      await updateOptionEnabledState(
        enabledTargets.map((option) => option.id),
        false,
      )

      setSelectedOptionIds([])
      setSelectionAnchorOptionId(null)
    })
  }

  function submitRemoveSelectedOptions() {
    if (!requireOptionManagement('Remove selected options')) {
      return
    }

    const selectedSet = new Set(selectedOptionIds)
    const selectedTargets = (optionsData?.options ?? []).filter((option) => selectedSet.has(option.id))
    if (selectedTargets.length === 0) {
      setError('Select one or more options to remove.')
      return
    }

    const enabledCount = optionsData?.enabledCount ?? (optionsData?.options ?? []).filter((option) => option.enabled).length
    const selectedEnabledTargetsCount = selectedTargets.filter((option) => option.enabled).length
    if (enabledCount - selectedEnabledTargetsCount < minOptionsForFiveByFive) {
      setError(
        `Cannot remove ${selectedTargets.length} option(s). Pool must keep at least ${minOptionsForFiveByFive} enabled options.`,
      )
      return
    }

    const confirmed = window.confirm(`Remove ${selectedTargets.length} selected option(s)? This cannot be undone.`)
    if (!confirmed) {
      return
    }

    void runAction('Remove selected options', async () => {
      await removeOptionIds(selectedTargets.map((option) => option.id))
      setSelectedOptionIds([])
      setSelectionAnchorOptionId(null)
    })
  }

  function toggleOption(option: OptionPoolItem) {
    if (!requireOptionManagement(option.enabled ? 'Disable option' : 'Enable option')) {
      return
    }

    const nextEnabled = !option.enabled
    void runAction(nextEnabled ? 'Enable option' : 'Disable option', async () => {
      await updateOptionEnabledState([option.id], nextEnabled)
    })
  }

  function beginEdit(option: OptionPoolItem) {
    if (!requireOptionManagement('Edit option')) {
      return
    }

    setEditOptionId(option.id)
    setEditOptionLabel(option.label)
  }

  function cancelEdit() {
    setEditOptionId(null)
    setEditOptionLabel('')
  }

  function saveEdit(optionId: string) {
    if (!requireOptionManagement('Save option edit')) {
      return
    }

    const label = editOptionLabel.trim()
    if (!label) {
      setError('Option label cannot be blank.')
      return
    }

    void runAction('Save option edit', async () => {
      await requestJson(buildApiUrl(apiBase, tenantSlug, `/mod/options/${encodeURIComponent(optionId)}`), {
        method: 'PATCH',
        headers: modJsonHeaders,
        body: JSON.stringify({ label }),
      })

      setEditOptionId(null)
      setEditOptionLabel('')
    })
  }

  function deleteOption(option: OptionPoolItem) {
    if (!requireOptionManagement('Remove option')) {
      return
    }

    void runAction('Remove option', async () => {
      await requestJson(buildApiUrl(apiBase, tenantSlug, `/mod/options/${encodeURIComponent(option.id)}`), {
        method: 'DELETE',
        headers: modHeaders,
      })
    })
  }

  function clearRandomPlayerSelection() {
    setSelectedRandomPlayerId(null)
    setRandomSelectionQueue([])
    setRandomSelectionNotice(null)
  }

  function runRandomPlayerSelection(action: 'select' | 'respin') {
    if (activePlayers.length === 0) {
      setRandomSelectionNotice('No active players are available for random selection yet.')
      setSelectedRandomPlayerId(null)
      setRandomSelectionQueue([])
      return
    }

    if (action === 'respin' && activePlayers.length < 2) {
      setRandomSelectionNotice('At least two active players are required to respin.')
      return
    }

    const { nextSelectedPlayerId, nextQueue } = pickNextRandomPlayerId(
      activePlayers,
      randomSelectionQueue,
      selectedRandomPlayerId,
    )

    if (!nextSelectedPlayerId) {
      setRandomSelectionNotice('Unable to select a player. Refresh and try again.')
      return
    }

    setSelectedRandomPlayerId(nextSelectedPlayerId)
    setRandomSelectionQueue(nextQueue)

    const selectedPlayer = activePlayers.find((player) => player.userId === nextSelectedPlayerId)
    if (!selectedPlayer) {
      setRandomSelectionNotice(null)
      return
    }

    setRandomSelectionNotice(
      action === 'respin'
        ? `Respin landed on ${selectedPlayer.userName}.`
        : `Random select chose ${selectedPlayer.userName}.`,
    )
  }

  function submitRandomSelect() {
    runRandomPlayerSelection('select')
  }

  function submitRespin() {
    runRandomPlayerSelection('respin')
  }

  function submitRefreshActivePlayers() {
    void runAction('Refresh active players', async () => {
      // No-op action callback; runAction handles the state refresh and auth errors.
    })
  }

  function submitClearRandomSelection() {
    clearRandomPlayerSelection()
    setMessage('Active player selection cleared.')
  }

  async function submitGenerateTestingViewerLink() {
    setPendingAction('Generate testing viewer link')
    setTestingError(null)
    setTestingNotice(null)

    try {
      const response = await requestJson<ModTestingViewerLinkResponse>(buildApiUrl(apiBase, tenantSlug, '/mod/testing/viewer-link'), {
        method: 'POST',
        headers: modJsonHeaders,
        body: JSON.stringify({}),
      })

      setTestingLinkResult(response)
      setTestingNotice(
        response.joined
          ? 'Generated a viewer link and joined your account to the active round.'
          : 'Generated a viewer link for your existing active player card.',
      )
      await refreshData()
    } catch (nextError) {
      const status = getErrorStatus(nextError)
      const payload = getErrorPayload(nextError)
      const errorCode = typeof payload?.error === 'string' ? payload.error : null
      const deniedUser = payload?.user && typeof payload.user === 'object'
        ? (payload.user as Record<string, unknown>)
        : null
      const deniedUserId = typeof deniedUser?.userId === 'string' ? deniedUser.userId.trim() : ''
      const deniedUserLogin = typeof deniedUser?.userLogin === 'string' ? deniedUser.userLogin.trim() : ''

      if (
        status === 401
        || status === 503
        || (status === 403 && errorCode !== 'testing_access_denied' && errorCode !== 'testing_identity_required')
      ) {
        applyAuthFailure(nextError)
      } else {
        if (status === 403 && errorCode === 'testing_access_denied' && (deniedUserId || deniedUserLogin)) {
          const identityParts = [
            deniedUserId ? `userId=${deniedUserId}` : null,
            deniedUserLogin ? `userLogin=${deniedUserLogin}` : null,
          ].filter((entry): entry is string => Boolean(entry))
          const identityDetail = identityParts.join(', ')
          setTestingError(
            `This Twitch account is not allowlisted for testing viewer-link access. Add ${identityDetail} to MOD_TESTING_ALLOWLIST on the controller.`,
          )
        } else {
          setTestingError(formatControlError(nextError))
        }
      }

      setTestingLinkResult(null)
    } finally {
      setPendingAction(null)
    }
  }

  async function loadThemeSkinLibrary() {
    setSkinLibraryState('loading')
    setSkinLibraryNotice(null)

    try {
      const response = await fetch(skinManifestPath, {
        credentials: 'include',
        cache: 'no-store',
      })

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Skin library not found at /skins/skins-manifest.json. Manual color editing is still available.')
        }

        throw new Error(`Skin library failed to load (${response.status} ${response.statusText}).`) 
      }

      const payload = (await response.json()) as unknown
      const normalizedSkins = normalizeThemeSkinManifest(payload)

      setSkinLibrary(normalizedSkins)
      setSkinLibraryState('ready')
      setSelectedSkinId((current) => (normalizedSkins.some((skin) => skin.id === current) ? current : ''))

      if (normalizedSkins.length === 0) {
        setSkinLibraryNotice('Skin library is empty. Add entries to /skins/skins-manifest.json to load seasonal presets.')
      }
    } catch (nextError) {
      const notice = nextError instanceof Error
        ? nextError.message
        : 'Skin library could not be loaded. Manual color editing is still available.'

      setSkinLibrary([])
      setSkinLibraryState('error')
      setSelectedSkinId('')
      setSkinLibraryNotice(notice)
    }
  }

  function submitApplySelectedSkinLive() {
    if (!selectedSkin) {
      setSkinDraftNotice('Choose a skin before applying live.')
      return
    }

    if (!requireThemeControl('Apply skin live')) {
      return
    }

    const sharedOverrides = normalizeThemeOverrides(selectedSkin.palette)
    const controllerOverrides = normalizeThemeOverrides({
      ...sharedOverrides,
      ...selectedSkin.controllerPalette,
    })
    const cardsOverrides = normalizeThemeOverrides({
      ...sharedOverrides,
      ...selectedSkin.cardsPalette,
    })

    const nextThemeMode = selectedSkin.mode ?? themeModeDraft
    const nextThemeLink = themeLinkDraft
    const nextSkinId = normalizeThemeSkinId(selectedSkin.id)
    const nextLinkedOverrides = normalizeThemeOverrides({
      ...themeOverridesDraft,
      ...sharedOverrides,
      ...selectedSkin.controllerPalette,
      ...selectedSkin.cardsPalette,
    })
    const nextControllerOverrides = normalizeThemeOverrides({
      ...themeControllerOverridesDraft,
      ...controllerOverrides,
    })
    const nextCardsOverrides = normalizeThemeOverrides({
      ...themeCardsOverridesDraft,
      ...cardsOverrides,
    })

    void runAction('Apply skin live', async () => {
      await requestJson(buildApiUrl(apiBase, tenantSlug, '/mod/theme'), {
        method: 'PATCH',
        headers: modJsonHeaders,
        body: JSON.stringify({
          mode: nextThemeMode,
          linkControllerAndCards: nextThemeLink,
          skinId: nextSkinId || null,
        }),
      })

      if (nextThemeLink) {
        await submitScopedThemePatch('all', nextLinkedOverrides)
      } else {
        await submitScopedThemePatch('controller', nextControllerOverrides)
        await submitScopedThemePatch('cards', nextCardsOverrides)
      }

      setThemeModeDraft(nextThemeMode)
      setThemeLinkDraft(nextThemeLink)
      if (nextThemeLink) {
        setThemeOverridesDraft(nextLinkedOverrides)
      } else {
        setThemeControllerOverridesDraft(nextControllerOverrides)
        setThemeCardsOverridesDraft(nextCardsOverrides)
      }
      setSelectedSkinId(nextSkinId)
      setSkinDraftNotice(`Applied ${selectedSkin.name} live for Control, Viewer/Card, and Overlay.`)
    })
  }

  function clearSelectedSkin() {
    setSelectedSkinId('')
    setSkinDraftNotice('Selection cleared. Saved theme and colors are unchanged until you save.')
  }

  function submitRemoveSkinAndRestoreDefaults() {
    if (!requireThemeControl('Remove skin + restore defaults')) {
      return
    }

    const confirmed = window.confirm(
      'Remove the active skin and restore canonical default visuals for Control, Viewer/Card, and Overlay? This clears linked and scoped custom colors.',
    )
    if (!confirmed) {
      return
    }

    void runAction('Remove skin + restore defaults', async () => {
      await requestJson(buildApiUrl(apiBase, tenantSlug, '/mod/theme'), {
        method: 'PATCH',
        headers: modJsonHeaders,
        body: JSON.stringify({
          mode: canonicalDefaultThemeMode,
          linkControllerAndCards: true,
          scopeTarget: 'all',
          resetOverrides: true,
          skinId: null,
        }),
      })

      setThemeModeDraft(canonicalDefaultThemeMode)
      setThemeLinkDraft(true)
      setThemeOverridesDraft({})
      setThemeControllerOverridesDraft({})
      setThemeCardsOverridesDraft({})
      setSelectedSkinId('')
      setUiBackgroundStyle(null)
      setSkinDraftNotice('Skin removed and canonical defaults restored.')
    })
  }

  const themeFieldsByCategory = useMemo(() => {
    const grouped = new Map<ThemeColorCategory, ThemeEditorField[]>()
    for (const category of themeCategoryOrder) {
      grouped.set(category, [])
    }

    for (const field of themeEditorFields) {
      const current = grouped.get(field.category)
      if (current) {
        current.push(field)
      }
    }

    return grouped
  }, [])

  function isThemeCategoryExpanded(scope: ThemeEditorScope, category: ThemeColorCategory): boolean {
    return themeExpandedCategories[scope].includes(category)
  }

  function toggleThemeCategory(scope: ThemeEditorScope, category: ThemeColorCategory) {
    setThemeExpandedCategories((current) => {
      const existing = current[scope]
      const isExpanded = existing.includes(category)
      const nextForScope = isExpanded
        ? existing.filter((item) => item !== category)
        : [...existing, category]

      return {
        ...current,
        [scope]: nextForScope,
      }
    })
  }

  function toggleThemeScope(scope: ThemeEditorScope) {
    setThemeScopeExpanded((current) => ({
      ...current,
      [scope]: !current[scope],
    }))
  }

  function updateThemeDraft(key: keyof ThemePalette, value: string, scopeTarget: ThemeScopeTarget) {
    if (scopeTarget === 'controller') {
      setThemeControllerOverridesDraft((current) => ({
        ...current,
        [key]: value,
      }))
      return
    }

    if (scopeTarget === 'cards') {
      setThemeCardsOverridesDraft((current) => ({
        ...current,
        [key]: value,
      }))
      return
    }

    setThemeOverridesDraft((current) => ({
      ...current,
      [key]: value,
    }))
  }

  function resolveThemeDraftValue(scopeTarget: ThemeScopeTarget, key: keyof ThemePalette, fallbackValue: string): string {
    if (scopeTarget === 'controller') {
      return themeControllerOverridesDraft[key] ?? fallbackValue
    }

    if (scopeTarget === 'cards') {
      return themeCardsOverridesDraft[key] ?? fallbackValue
    }

    return themeOverridesDraft[key] ?? fallbackValue
  }

  function restoreThemeDraft() {
    if (!serverControllerTheme || !serverCardsTheme) {
      return
    }

    setThemeModeDraft(serverThemeMode)
    setThemeLinkDraft(serverThemeLink)
    setThemeOverridesDraft(serverThemeOverrides)
    setThemeControllerOverridesDraft(serverControllerThemeOverrides)
    setThemeCardsOverridesDraft(serverCardsThemeOverrides)
    setSelectedSkinId(serverThemeSkinId)
    setSkinDraftNotice(null)
  }

  async function submitScopedThemePatch(scopeTarget: ThemeScopeTarget, overrides: Partial<ThemePalette>) {
    await requestJson(buildApiUrl(apiBase, tenantSlug, '/mod/theme'), {
      method: 'PATCH',
      headers: modJsonHeaders,
      body: JSON.stringify({
        scopeTarget,
        resetOverrides: true,
        palette: toCompleteThemePalettePatch(overrides),
      }),
    })
  }

  function submitTheme(event: FormEvent) {
    event.preventDefault()
    if (!requireThemeControl('Save theme')) {
      return
    }

    void runAction('Save theme', async () => {
      await requestJson(buildApiUrl(apiBase, tenantSlug, '/mod/theme'), {
        method: 'PATCH',
        headers: modJsonHeaders,
        body: JSON.stringify({
          mode: themeModeDraft,
          linkControllerAndCards: themeLinkDraft,
          skinId: normalizeThemeSkinId(selectedSkinId) || null,
        }),
      })

      if (themeLinkDraft) {
        await submitScopedThemePatch('all', themeOverridesDraft)
        return
      }

      await submitScopedThemePatch('controller', themeControllerOverridesDraft)
      await submitScopedThemePatch('cards', themeCardsOverridesDraft)
    })
  }

  function resetThemeOverrides() {
    if (!requireThemeControl('Reset custom colors')) {
      return
    }

    void runAction('Reset custom colors', async () => {
      await requestJson(buildApiUrl(apiBase, tenantSlug, '/mod/theme'), {
        method: 'PATCH',
        headers: modJsonHeaders,
        body: JSON.stringify({
          mode: themeModeDraft,
          scopeTarget: 'all',
          resetOverrides: true,
        }),
      })

      setThemeOverridesDraft({})
      setThemeControllerOverridesDraft({})
      setThemeCardsOverridesDraft({})
      setSkinDraftNotice('Custom colors reset. Skin assignment unchanged.')
    })
  }

  const canStartRound = Boolean(stateData?.optionPool?.canStart)
  const winnerCount = activeSession?.winners?.length ?? 0
  const isLiveRound = activeSession?.status === 'open' || activeSession?.status === 'running'
  const canContinueToBlackout = Boolean(activeSession && activeSession.status !== 'idle' && activeSession.mode !== 'blackout')
  const selectedCount = selectedOptionIds.length
  const graceRemaining = activeSession?.winnerGraceSecondsRemaining ?? null
  const sessionGraceSeconds = activeSession?.winnerGraceSeconds ?? winnerGraceSeconds
  const winnerGraceSecondsMin = winnerConfig.winnerGraceSecondsMin
  const winnerGraceSecondsMax = winnerConfig.winnerGraceSecondsMax
  const hasThemeOverrides =
    Object.keys(themeOverridesDraft).length > 0
    || Object.keys(themeControllerOverridesDraft).length > 0
    || Object.keys(themeCardsOverridesDraft).length > 0
  const hasSavedThemeOverrides =
    Object.keys(serverThemeOverrides).length > 0
    || Object.keys(serverControllerThemeOverrides).length > 0
    || Object.keys(serverCardsThemeOverrides).length > 0
  const canResetCustomColors =
    capabilities.modTheme && pendingAction === null && (themeDirty || hasThemeOverrides || hasSavedThemeOverrides)
  const isSavingTheme = pendingAction === 'Save theme'
  const isResettingTheme = pendingAction === 'Reset custom colors'
  const showNoThemeChangesHint = capabilities.modTheme && pendingAction === null && !themeDirty
  const skinLibraryLoading = skinLibraryState === 'loading'
  const skinLibraryReady = skinLibraryState === 'ready'
  const canReloadSkinLibrary = pendingAction === null
  const canApplySelectedSkinLive =
    capabilities.modTheme && pendingAction === null && skinLibraryReady && selectedSkin !== null
  const canClearSelectedSkin = pendingAction === null && selectedSkinId.length > 0
  const canRemoveSkinAndRestoreDefaults = capabilities.modTheme && pendingAction === null
  const allowedHostList = allowedHosts.join(', ')
  const controlClassName = uiBackgroundStyle === 'full-gradient' ? 'control ui-background-full-gradient' : 'control'

  if (!hostAllowed) {
    return (
      <main className={controlClassName}>
        <header className="control-header">
          <p className="control-badge">Bingo Control</p>
          <h1>Access Blocked</h1>
          <p className="control-subtitle">
            This hostname is not allowed to run moderator controls. Use your approved control domain.
          </p>
        </header>

        <section className="control-panel control-panel-wide control-access-blocked" role="alert">
          <h2>Control Host Policy</h2>
          <p>
            Hostname <strong>{host}</strong> is blocked by VITE_CONTROL_ALLOWED_HOSTS.
          </p>
          <p className="control-helper-text">
            Allowed hosts: <strong>{allowedHostList}</strong>
          </p>
          <p className="control-helper-text">
            No polling or mod API requests are started while this host is blocked.
          </p>
        </section>
      </main>
    )
  }

  if (authGateState !== 'authorized') {
    const accountLabel = authStatus?.user ? `${authStatus.user.userName} (${authStatus.user.userLogin})` : null
    const gateTitle =
      authGateState === 'checking'
        ? 'Checking Moderator Session'
        : authGateState === 'forbidden'
          ? 'Moderator Privileges Required'
          : 'Sign In Required'
    const gateDescription =
      authGateState === 'checking'
        ? 'Verifying moderator access with the API before loading control actions.'
        : authGateState === 'forbidden'
          ? 'Your Twitch account is authenticated but does not have broadcaster or moderator access for this channel.'
          : 'Sign in with Twitch to unlock moderator round controls.'
    const authActionDisabled = loading || pendingAction !== null

    return (
      <main className={controlClassName}>
        <header className="control-header">
          <p className="control-badge">Bingo Control</p>
          <h1>{gateTitle}</h1>
          <p className="control-subtitle">{gateDescription}</p>
        </header>

        {loading && <section className="control-note">Checking moderator access...</section>}

        {authNotice && <section className="control-warning-banner">{authNotice}</section>}

        {error && (
          <section className="control-error" role="alert">
            {error}
          </section>
        )}

        <section className="control-panel control-panel-wide control-auth-gate" role="status">
          <h2>Access Status</h2>
          <p>
            Gate state: <strong>{authGateState}</strong>
          </p>
          {accountLabel && (
            <p>
              Signed in as <strong>{accountLabel}</strong>
            </p>
          )}
          <p className="control-helper-text">
            Legacy bearer fallback is <strong>{authStatus?.allowLegacyToken ? 'enabled' : 'disabled'}</strong>.
          </p>

          <div className="control-actions">
            <button type="button" onClick={beginModSignIn} disabled={authActionDisabled}>
              Sign In With Twitch
            </button>
            <button
              type="button"
              className="secondary"
              disabled={authActionDisabled}
              onClick={() => {
                void refreshAuthAndData()
              }}
            >
              Recheck Access
            </button>
            {authMode !== 'legacy-bearer' && (
              <button
                type="button"
                className="secondary"
                disabled={authActionDisabled}
                onClick={() => {
                  void submitModSignOut()
                }}
              >
                {authStatus?.authenticated ? 'Sign Out' : 'Clear Session'}
              </button>
            )}
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className={controlClassName}>
      <header className="control-header">
        <p className="control-badge">Bingo Control</p>
        <h1>Moderator Round Controls</h1>
        <p className="control-subtitle">
          Manage rounds, callouts, and option rotation without mutating active cards unless you choose recovery actions.
        </p>

        <div className="control-header-actions">
          <button
            type="button"
            className="secondary"
            disabled={loading || pendingAction !== null}
            onClick={() => {
              void refreshAuthAndData()
            }}
          >
            Recheck Access
          </button>
          {authStatus?.authMode !== 'legacy-token' && (
            <button
              type="button"
              className="secondary"
              disabled={loading || pendingAction !== null}
              onClick={() => {
                void submitModSignOut()
              }}
            >
              Sign Out
            </button>
          )}
        </div>

        <nav className="control-view-tabs" aria-label="Control panel sections">
          {visibleControlViews.map((view) => (
            <button
              key={view.id}
              type="button"
              className={`control-view-tab${activeView === view.id ? ' active' : ''}`}
              aria-pressed={activeView === view.id}
              onClick={() => setActiveView(view.id)}
            >
              {view.label}
            </button>
          ))}
        </nav>
      </header>

      {loading && <section className="control-note">Loading control state...</section>}

      {compatNotice && <section className="control-warning-banner">{compatNotice}</section>}

      {error && (
        <section className="control-error" role="alert">
          {error}
        </section>
      )}

      {message && <section className="control-success">{message}</section>}

      {activeView !== 'options' && (
        <section className={`control-grid${activeView === 'round' ? '' : ' control-grid-single'}`}>
          {activeView === 'round' && (
            <article className="control-panel">
          <h2>Round Lifecycle</h2>
          <p>
            Status: <strong>{activeSession?.status ?? 'idle'}</strong> | Mode: <strong>{activeSession?.mode ?? 'n/a'}</strong>
          </p>
          <p>
            Players: {activeSession?.players ?? 0} | Called: {activeSession?.calledOptions?.length ?? 0} | Winners: {winnerCount} /{' '}
            {activeSession?.maxWinners ?? maxWinners}
          </p>

          {graceRemaining !== null && (
            <p className="grace-window">
              {graceRemaining > 0
                ? `Winner grace window: ${graceRemaining}s remaining.`
                : 'Winner grace window elapsed. The round will end on next server cycle.'}
            </p>
          )}

          <form className="control-form-row" onSubmit={submitStart}>
            <label>
              Mode
              <select value={mode} onChange={(event) => setMode(event.target.value as BingoMode)}>
                {modes.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Max winners
              <select value={maxWinners} onChange={(event) => setMaxWinners(Number(event.target.value))}>
                {winnerRange.map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Winner grace (seconds)
              <input
                type="number"
                min={winnerGraceSecondsMin}
                max={winnerGraceSecondsMax}
                value={winnerGraceSeconds}
                onChange={(event) => {
                  const nextValue = Number(event.target.value)
                  setWinnerGraceSeconds(clampInteger(nextValue, winnerGraceSecondsMin, winnerGraceSecondsMax))
                }}
              />
            </label>

            <button type="submit" disabled={pendingAction !== null || !canStartRound}>
              Start Round
            </button>
          </form>

          <p className="control-helper-text">
            Grace window after first win: {sessionGraceSeconds}s when max winners is above 1. Allowed range:{' '}
            {winnerGraceSecondsMin}-{winnerGraceSecondsMax}s.
          </p>

          <div className="control-actions">
            <button type="button" className="secondary" disabled={pendingAction !== null || !canStartRound} onClick={submitNewSession}>
              New Session
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!capabilities.modSessionControl || pendingAction !== null || isLiveRound}
              onClick={submitRefreshInactiveOptions}
            >
              Refresh Inactive Options
            </button>
            <button
              type="button"
              className="secondary"
              disabled={pendingAction !== null || !activeSession}
              onClick={submitResetBoard}
            >
              Reset Board
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!capabilities.modSessionControl || pendingAction !== null || !canContinueToBlackout}
              onClick={() => submitContinueBlackout(false)}
            >
              Continue to Blackout
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!capabilities.modSessionControl || pendingAction !== null || !canContinueToBlackout}
              onClick={() => submitContinueBlackout(true)}
            >
              Continue + Reset Winners
            </button>
            <button type="button" className="danger" disabled={pendingAction !== null || !activeSession} onClick={submitStop}>
              End Round
            </button>
          </div>

          {activeSession?.mode === 'blackout' && (
            <p className="control-helper-text">Session is already in blackout mode.</p>
          )}

          {!canStartRound && (
            <p className="control-warning">At least {minOptionsForFiveByFive} enabled options are required to start a 5x5 round.</p>
          )}

          {!capabilities.modSessionControl && (
            <p className="control-helper-text">Session recovery controls require the latest controller deployment.</p>
          )}
            </article>
          )}

          {activeView === 'round' && (
            <article className="control-panel">
          <h2>Live Callout</h2>
          <form className="control-form-column" onSubmit={submitCall}>
            <label>
              Option text
              <input
                list="callable-options"
                value={callInput}
                onChange={(event) => setCallInput(event.target.value)}
                placeholder="Type or choose an option"
              />
            </label>
            <datalist id="callable-options">
              {callableOptions.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
            <div className="control-actions">
              <button type="submit" disabled={pendingAction !== null || callInput.trim().length === 0}>
                Call Option
              </button>
              <button
                type="button"
                className="secondary"
                disabled={pendingAction !== null || callInput.trim().length === 0}
                onClick={() => submitUncall(callInput)}
              >
                Uncall Typed Option
              </button>
            </div>
          </form>

          <p>Callable remaining: {callableOptions.length}</p>
          <p>Called options: {calledOptions.length}</p>

          {quickCallOptions.length > 0 && (
            <div className="quick-call-grid">
              {quickCallOptions.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="quick-call-button"
                  disabled={pendingAction !== null}
                  onClick={() => setCallInput(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          )}

          {calledOptions.length === 0 ? (
            <p className="control-helper-text">No called options yet.</p>
          ) : (
            <ul className="called-option-list" aria-label="Called options">
              {calledOptions.map((option) => (
                <li key={option} className="called-option-item">
                  <span>{option}</span>
                  <button
                    type="button"
                    className="secondary"
                    disabled={pendingAction !== null}
                    onClick={() => submitUncall(option)}
                  >
                    Uncall
                  </button>
                </li>
              ))}
            </ul>
          )}
            </article>
          )}

          {activeView === 'theme' && (
            <article className="control-panel">
              <h2>Theme and Skin Management</h2>
              <p className="control-helper-text">
                Organize theme drafts, apply seasonal skins, and verify mock card visuals before saving changes live.
              </p>
              <p className="control-helper-text">Draft updates are local until Save Theme is clicked.</p>

              {!capabilities.modTheme && (
                <p className="control-helper-text">Theme controls require a controller build that includes /api/mod/theme.</p>
              )}

              <form className={`control-form-column theme-form${themeCompactView ? ' compact' : ''}`} onSubmit={submitTheme}>
                <section className="theme-config-section" aria-label="Theme mode and scope">
                  <header className="theme-config-header">
                    <h3>Theme Mode and Scope</h3>
                    <p>Set baseline mode and decide whether controller and cards should share one palette.</p>
                  </header>

                  <label>
                    Theme mode
                    <select
                      value={themeModeDraft}
                      onChange={(event) => setThemeModeDraft(event.target.value as ThemeMode)}
                      disabled={!capabilities.modTheme || pendingAction !== null}
                    >
                      <option value="dark">Dark</option>
                      <option value="light">Light</option>
                    </select>
                  </label>

                  <div className="theme-toggle-row">
                    <label className="theme-link-toggle">
                      <input
                        type="checkbox"
                        checked={themeLinkDraft}
                        disabled={!capabilities.modTheme || pendingAction !== null}
                        onChange={(event) => setThemeLinkDraft(event.target.checked)}
                      />
                      <span>Link Controller + Cards Themes</span>
                    </label>

                    <label className="theme-link-toggle theme-compact-toggle">
                      <input
                        type="checkbox"
                        checked={themeCompactView}
                        disabled={pendingAction !== null}
                        onChange={(event) => setThemeCompactView(event.target.checked)}
                      />
                      <span>Compact View</span>
                    </label>
                  </div>

                  <p className="control-helper-text theme-link-hint">
                    Keep linked mode on for one shared look. Turn it off when you want separate control-page and card styling.
                  </p>
                </section>

                <section className="theme-config-section theme-skin-library" aria-label="Skin library">
                  <header className="theme-config-header">
                    <h3>Skin Library</h3>
                    <p>Load seasonal presets from /skins/skins-manifest.json and apply them live.</p>
                  </header>

                  <p className="control-helper-text">
                    Use Remove Skin + Restore Defaults for a full persisted reset to the canonical default theme.
                  </p>

                  <p className="control-helper-text">
                    Library status: <strong>{skinLibraryState}</strong> | Available skins: {skinLibrary.length}
                  </p>

                  {skinLibraryNotice && (
                    <p className="control-helper-text theme-skin-library-notice" role="status">
                      {skinLibraryNotice}
                    </p>
                  )}

                  {skinDraftNotice && (
                    <p className="control-helper-text theme-skin-draft-notice" role="status">
                      {skinDraftNotice}
                    </p>
                  )}

                  <label>
                    Seasonal skin
                    <select
                      value={selectedSkinId}
                      onChange={(event) => {
                        setSelectedSkinId(event.target.value)
                        setSkinDraftNotice(null)
                      }}
                      disabled={!capabilities.modTheme || pendingAction !== null || !skinLibraryReady || skinLibrary.length === 0}
                      aria-label="Seasonal skin selector"
                    >
                      <option value="">Choose a skin preset</option>
                      {skinLibrary.map((skin) => (
                        <option key={skin.id} value={skin.id}>
                          {skin.season ? `${skin.name} (${skin.season})` : skin.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="control-actions theme-skin-library-actions">
                    <button type="button" disabled={!canApplySelectedSkinLive} onClick={submitApplySelectedSkinLive}>
                      Apply Skin Live
                    </button>
                    <button type="button" className="secondary" disabled={!canClearSelectedSkin} onClick={clearSelectedSkin}>
                      Clear Selection
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={!canRemoveSkinAndRestoreDefaults}
                      onClick={submitRemoveSkinAndRestoreDefaults}
                    >
                      Remove Skin + Restore Defaults
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={!canReloadSkinLibrary || skinLibraryLoading}
                      onClick={() => {
                        void loadThemeSkinLibrary()
                      }}
                    >
                      {skinLibraryLoading ? 'Loading Library...' : 'Reload Library'}
                    </button>
                  </div>

                  {selectedSkin && (
                    <div className="theme-selected-skin" role="status">
                      <h4>{selectedSkin.name}</h4>
                      {selectedSkin.description && <p className="control-helper-text">{selectedSkin.description}</p>}
                      <p className="control-helper-text">
                        Season: <strong>{selectedSkin.season || 'custom'}</strong> | Tags:{' '}
                        {selectedSkin.tags.length > 0 ? selectedSkin.tags.join(', ') : 'none'}
                      </p>
                    </div>
                  )}
                </section>

                <section className="theme-scope" aria-label="Controller page colors">
                  <header className="theme-scope-header">
                    <div className="theme-scope-header-copy">
                      <h3>Controller Colors</h3>
                      <p>Styles this moderator control dashboard only.</p>
                    </div>
                    <button
                      type="button"
                      className="secondary section-collapse-toggle theme-scope-collapse-toggle"
                      aria-expanded={themeScopeExpanded.controller}
                      aria-controls="theme-controller-colors-content"
                      onClick={() => toggleThemeScope('controller')}
                    >
                      {themeScopeExpanded.controller ? 'Hide Colors' : 'Show Colors'}
                    </button>
                  </header>

                  <div id="theme-controller-colors-content" className="theme-scope-content" hidden={!themeScopeExpanded.controller}>
                    {themeCategoryOrder.map((category) => {
                      const fields = themeFieldsByCategory.get(category) ?? []
                      if (fields.length === 0) {
                        return null
                      }

                      const expanded = isThemeCategoryExpanded('controller', category)
                      const categoryContentId = `theme-controller-${category}-content`

                      return (
                        <section key={`controller-${category}`} className="theme-category-block">
                          <button
                            type="button"
                            className="theme-category-toggle"
                            aria-expanded={expanded}
                            aria-controls={categoryContentId}
                            onClick={() => toggleThemeCategory('controller', category)}
                          >
                            <span className="theme-category-toggle-label">{themeCategoryLabels[category]}</span>
                            <span className="theme-category-toggle-meta">{fields.length} colors</span>
                          </button>

                          {expanded && (
                            <div id={categoryContentId} className="theme-category-content">
                              <div className="theme-color-grid">
                                {fields.map((field) => {
                                  const fallbackValue =
                                    serverControllerTheme?.palette[field.key] ?? serverCardsTheme?.palette[field.key] ?? '#000000'
                                  const value = resolveThemeDraftValue(themeLinkDraft ? 'all' : 'controller', field.key, fallbackValue)

                                  return (
                                    <label key={`controller-${field.key}`} className="theme-color-field">
                                      <span className="theme-color-field-copy">
                                        <strong>{field.label}</strong>
                                        <small>{field.description}</small>
                                      </span>
                                      <span className="theme-color-field-controls">
                                        <input
                                          type="color"
                                          value={value}
                                          disabled={!capabilities.modTheme || pendingAction !== null}
                                          onChange={(event) =>
                                            updateThemeDraft(field.key, event.target.value, themeLinkDraft ? 'all' : 'controller')
                                          }
                                        />
                                        <code>{value.toUpperCase()}</code>
                                      </span>
                                    </label>
                                  )
                                })}
                              </div>
                            </div>
                          )}
                        </section>
                      )
                    })}
                  </div>
                </section>

                <section className="theme-scope" aria-label="Bingo cards and cells colors">
                  <header className="theme-scope-header">
                    <div className="theme-scope-header-copy">
                      <h3>Card and Cell Colors</h3>
                      <p>Styles viewer cards and OBS overlay card visuals.</p>
                    </div>
                    <button
                      type="button"
                      className="secondary section-collapse-toggle theme-scope-collapse-toggle"
                      aria-expanded={themeScopeExpanded.cards}
                      aria-controls="theme-card-cell-colors-content"
                      onClick={() => toggleThemeScope('cards')}
                    >
                      {themeScopeExpanded.cards ? 'Hide Colors' : 'Show Colors'}
                    </button>
                  </header>

                  <div id="theme-card-cell-colors-content" className="theme-scope-content" hidden={!themeScopeExpanded.cards}>
                    {themeLinkDraft && (
                      <div className="theme-linked-summary">
                        <p className="control-helper-text theme-scope-locked-note">
                          Linked mode is on, so cards and cells mirror controller colors.
                        </p>
                        <p className="control-helper-text">
                          Switch to separate editing if you want different card and cell colors for overlay/viewer.
                        </p>
                        <button
                          type="button"
                          className="secondary"
                          disabled={!capabilities.modTheme || pendingAction !== null}
                          onClick={() => setThemeLinkDraft(false)}
                        >
                          Edit Cards Separately
                        </button>
                      </div>
                    )}

                    {!themeLinkDraft &&
                      themeCategoryOrder.map((category) => {
                        const fields = themeFieldsByCategory.get(category) ?? []
                        if (fields.length === 0) {
                          return null
                        }

                        const expanded = isThemeCategoryExpanded('cards', category)
                        const categoryContentId = `theme-cards-${category}-content`

                        return (
                          <section key={`cards-${category}`} className="theme-category-block">
                            <button
                              type="button"
                              className="theme-category-toggle"
                              aria-expanded={expanded}
                              aria-controls={categoryContentId}
                              onClick={() => toggleThemeCategory('cards', category)}
                            >
                              <span className="theme-category-toggle-label">{themeCategoryLabels[category]}</span>
                              <span className="theme-category-toggle-meta">{fields.length} colors</span>
                            </button>

                            {expanded && (
                              <div id={categoryContentId} className="theme-category-content">
                                <div className="theme-color-grid">
                                  {fields.map((field) => {
                                    const fallbackValue =
                                      serverCardsTheme?.palette[field.key] ?? serverControllerTheme?.palette[field.key] ?? '#000000'
                                    const value = resolveThemeDraftValue(themeLinkDraft ? 'all' : 'cards', field.key, fallbackValue)

                                    return (
                                      <label key={`cards-${field.key}`} className="theme-color-field">
                                        <span className="theme-color-field-copy">
                                          <strong>{field.label}</strong>
                                          <small>{field.description}</small>
                                        </span>
                                        <span className="theme-color-field-controls">
                                          <input
                                            type="color"
                                            value={value}
                                            disabled={!capabilities.modTheme || pendingAction !== null}
                                            onChange={(event) =>
                                              updateThemeDraft(field.key, event.target.value, themeLinkDraft ? 'all' : 'cards')
                                            }
                                          />
                                          <code>{value.toUpperCase()}</code>
                                        </span>
                                      </label>
                                    )
                                  })}
                                </div>
                              </div>
                            )}
                          </section>
                        )
                      })}
                  </div>
                </section>

                <section className="theme-preview-section" aria-label="Live preview">
                  <header className="theme-config-header">
                    <h3>Live Preview</h3>
                    <p>Review card states and action contrast with current unsaved draft values.</p>
                  </header>

                  {!themeLinkDraft && (
                    <div className="theme-preview-scope-toggle" role="group" aria-label="Preview target scope">
                      <button
                        type="button"
                        className={`theme-preview-scope-button${themePreviewScope === 'controller' ? ' active' : ''}`}
                        onClick={() => setThemePreviewScope('controller')}
                      >
                        Controller Preview
                      </button>
                      <button
                        type="button"
                        className={`theme-preview-scope-button${themePreviewScope === 'cards' ? ' active' : ''}`}
                        onClick={() => setThemePreviewScope('cards')}
                      >
                        Cards Preview
                      </button>
                    </div>
                  )}

                  <p className="control-helper-text theme-preview-mode-label">{activePreviewModeLabel}</p>
                  <p className="theme-preview-source-badge" role="status">{activePreviewSourceLabel}</p>

                  {!themeLinkDraft && previewScopesMatch && (
                    <p className="control-helper-text theme-preview-identical-note">
                      No visual difference yet. Edit scoped colors to diverge.
                    </p>
                  )}

                  <div className="theme-preview-surface" style={activePreviewStyle}>
                    {showControllerPreview && (
                      <section className="theme-preview-controller" aria-label="Controller preview elements">
                        <header className="theme-preview-card-header">
                          <strong>Controller Surface</strong>
                          <span>{themeLinkDraft ? 'LINKED' : 'CONTROLLER'}</span>
                        </header>

                        <div className="theme-preview-chip-row" aria-label="Status color preview">
                          <span className="theme-preview-chip success">Success</span>
                          <span className="theme-preview-chip warning">Warning</span>
                          <span className="theme-preview-chip error">Error</span>
                        </div>

                        <div className="theme-preview-action-row" aria-label="Action button contrast preview">
                          <button
                            type="button"
                            className="theme-preview-action primary"
                            aria-pressed={themePreviewActionVariant === 'primary'}
                            onClick={() => setThemePreviewActionVariant('primary')}
                          >
                            Primary Action
                          </button>
                          <button
                            type="button"
                            className="theme-preview-action secondary"
                            aria-pressed={themePreviewActionVariant === 'secondary'}
                            onClick={() => setThemePreviewActionVariant('secondary')}
                          >
                            Secondary Action
                          </button>
                        </div>

                        <p className="control-helper-text theme-preview-action-help">
                          Primary Action previews the main confirm or commit action style. Secondary Action previews non-destructive
                          alternate actions.
                        </p>
                        <p className="control-helper-text theme-preview-action-current" role="status">{previewActionBehaviorLabel}</p>

                        <div className="theme-preview-controller-metrics" aria-label="Controller metrics preview">
                          <span className="theme-preview-metric">
                            <strong>14</strong>
                            <small>Players</small>
                          </span>
                          <span className="theme-preview-metric">
                            <strong>7</strong>
                            <small>Called</small>
                          </span>
                          <span className="theme-preview-metric">
                            <strong>2</strong>
                            <small>Winners</small>
                          </span>
                        </div>
                      </section>
                    )}

                    {showCardsPreview && (
                      <section className="theme-preview-card" aria-label="Mock bingo card">
                        <header className="theme-preview-card-header">
                          <strong>Mock Bingo Card</strong>
                          <span>{themeLinkDraft ? themeModeDraft.toUpperCase() : 'CARDS'}</span>
                        </header>

                        <div className="theme-preview-grid" role="list">
                          {themePreviewCells.map((cell, index) => (
                            <div key={`${cell.label}-${index}`} className={`theme-preview-cell ${cell.state}`} role="listitem">
                              <span>{cell.label}</span>
                            </div>
                          ))}
                        </div>
                      </section>
                    )}
                  </div>
                </section>

                <section className="theme-save-section" aria-label="Save and reset actions">
                  <header className="theme-config-header">
                    <h3>Save and Reset Actions</h3>
                    <p>Draft edits stay local until Save Theme is clicked.</p>
                  </header>

                  {showNoThemeChangesHint && (
                    <p className="control-helper-text">
                      No unsaved theme changes. Change a color, mode, or skin draft to enable Save Theme and Revert Unsaved.
                    </p>
                  )}

                  <div className="theme-action-bar">
                    <div className="control-actions theme-action-buttons">
                      <button
                        type="submit"
                        aria-busy={isSavingTheme}
                        data-loading={isSavingTheme ? 'true' : undefined}
                        disabled={!capabilities.modTheme || pendingAction !== null || !themeDirty}
                      >
                        Save Theme
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={!capabilities.modTheme || pendingAction !== null || !themeDirty}
                        onClick={restoreThemeDraft}
                      >
                        Revert Unsaved
                      </button>
                      <button
                        type="button"
                        className="danger"
                        aria-busy={isResettingTheme}
                        data-loading={isResettingTheme ? 'true' : undefined}
                        disabled={!canResetCustomColors}
                        onClick={resetThemeOverrides}
                      >
                        Reset Custom Colors
                      </button>
                    </div>
                  </div>
                </section>
              </form>
            </article>
          )}

          {activeView === 'players' && (
            <article className="control-panel active-player-panel" aria-live="polite">
          <h2>Active Player List</h2>
          <p className="control-helper-text">Live round players from the controller. Winners are marked.</p>
          <p className="control-helper-text">
            Round status: <strong>{activePlayerSessionStatus}</strong>
            {!activePlayerRoundLive ? ' (active players are cleared while the round is not live).' : ''}
          </p>
          <p className="control-summary-line">
            Active: {activePlayers.length} | Winners: {activePlayerWinnerCount}
          </p>

          <div className="active-player-actions">
            <button type="button" disabled={pendingAction !== null || activePlayers.length === 0} onClick={submitRandomSelect}>
              Random Select
            </button>
            <button
              type="button"
              className="secondary"
              disabled={pendingAction !== null || activePlayers.length < 2}
              onClick={submitRespin}
            >
              Respin
            </button>
            <button
              type="button"
              className="secondary"
              disabled={pendingAction !== null}
              onClick={submitRefreshActivePlayers}
            >
              Refresh List
            </button>
            <button
              type="button"
              className="secondary"
              disabled={pendingAction !== null || !hasRandomSelectionState}
              onClick={submitClearRandomSelection}
            >
              Clear Selection
            </button>
          </div>

          {selectedRandomPlayer ? (
            <div className="active-player-random-result" role="status">
              <strong>Current Pick:</strong> {selectedRandomPlayer.userName}
            </div>
          ) : (
            <p className="control-helper-text">No random player selected yet.</p>
          )}

          {randomSelectionNotice && <p className="control-helper-text">{randomSelectionNotice}</p>}

          {activePlayers.length === 0 ? (
            <p className="control-helper-text">No active players in this round yet.</p>
          ) : (
            <ul className="active-player-list" aria-label="Active players">
              {activePlayers.map((player) => {
                const selected = player.userId === selectedRandomPlayerId
                return (
                  <li key={player.userId} className={`active-player-item${selected ? ' selected' : ''}`}>
                    <span className="active-player-name">{player.userName}</span>
                    <span className={`active-player-badge${player.hasWon ? ' winner' : ''}`}>
                      {player.hasWon ? 'Winner' : 'Active'}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
            </article>
          )}

          {activeView === 'testing' && (
            <article className="control-panel testing-panel" aria-live="polite">
              <h2>Testing Utilities (Owner Only)</h2>
              <p className="control-helper-text">
                Generate a self card link for testing when Twitch whisper flow is unavailable.
              </p>

              {!testingAllowlistConfigured && (
                <p className="control-helper-text">
                  This control build has no VITE_MOD_TESTING_ALLOWLIST configured. Backend MOD_TESTING_ALLOWLIST still enforces access.
                </p>
              )}

              {testingAllowlistConfigured && !canAccessTesting && (
                <p className="control-helper-text">
                  This signed-in account is not listed in VITE_MOD_TESTING_ALLOWLIST for this build. Backend allowlist still decides final access.
                </p>
              )}

              {testingError && (
                <section className="control-error testing-inline-notice" role="alert">
                  {testingError}
                </section>
              )}

              {testingNotice && (
                <section className="control-success testing-inline-notice" role="status">
                  {testingNotice}
                </section>
              )}

              <div className="control-actions">
                <button
                  type="button"
                  disabled={pendingAction !== null}
                  onClick={() => {
                    void submitGenerateTestingViewerLink()
                  }}
                >
                  Generate My Card Link
                </button>
              </div>

              {testingLinkResult?.viewerUrl && (
                <div className="testing-viewer-link-block" role="status">
                  <a
                    className="testing-viewer-link"
                    href={testingLinkResult.viewerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Card
                  </a>
                  <p className="control-helper-text testing-viewer-link-url">{testingLinkResult.viewerUrl}</p>
                  <p className="control-helper-text">
                    Session: <strong>{testingLinkResult.sessionId}</strong> | User: <strong>{testingLinkResult.userName}</strong> ({testingLinkResult.userId})
                  </p>
                  {typeof testingLinkResult.expiresInSeconds === 'number' && (
                    <p className="control-helper-text">
                      Token expires in about {Math.max(testingLinkResult.expiresInSeconds, 0)} seconds.
                    </p>
                  )}
                </div>
              )}
            </article>
          )}
        </section>
      )}

      {activeView === 'round' && (
        <section className="control-panel control-panel-wide">
        <div className="control-section-header">
          <h2>Existing Round Options</h2>
          <button
            type="button"
            className="secondary section-collapse-toggle"
            aria-expanded={existingRoundOptionsExpanded}
            aria-controls="existing-round-options-content"
            onClick={() => setExistingRoundOptionsExpanded((current) => !current)}
          >
            {existingRoundOptionsExpanded ? 'Hide Options' : 'Show Options'}
          </button>
        </div>
        <p className="control-helper-text">
          These options already exist in the current session/pool. You do not need to add them manually before starting.
        </p>
        <p className="control-summary-line">
          Existing: {sessionOptions.length} | Called: {calledSet.size} | Waiting: {Math.max(sessionOptions.length - calledSet.size, 0)}
        </p>

        <div id="existing-round-options-content" hidden={!existingRoundOptionsExpanded}>
          {sessionOptions.length === 0 ? (
            <p className="control-helper-text">No options are currently loaded from the API.</p>
          ) : (
            <div className="option-chip-list" role="list">
              {sessionOptions.map((label) => {
                const called = calledSet.has(label)
                return (
                  <span key={label} className={`option-chip${called ? ' called' : ''}`} role="listitem">
                    {label}
                    <em>{called ? 'Called' : 'Waiting'}</em>
                  </span>
                )
              })}
            </div>
          )}
        </div>
        </section>
      )}

      {activeView === 'options' && (
        <section className="control-panel control-panel-wide">
        <h2>Option Pool Manager</h2>
        <p>
          Total: {optionsData?.count ?? 0} | Enabled: {optionsData?.enabledCount ?? 0} | Disabled:{' '}
          {(optionsData?.count ?? 0) - (optionsData?.enabledCount ?? 0)}
        </p>

        {!capabilities.modOptions && (
          <p className="control-helper-text">
            Read-only mode: option editing endpoints are not available on the deployed API yet.
          </p>
        )}

        <div className="option-bulk-toolbar">
          <p className="control-helper-text">
            Selected: {selectedCount} | Enabled selected: {selectedEnabledCount} | Disabled selected: {selectedDisabledCount}
          </p>
          <p className="control-helper-text">Tip: click one checkbox, then Shift+click another to select or unselect a full range.</p>
          <div className="option-bulk-actions">
            <button
              type="button"
              className="secondary"
              disabled={!capabilities.modOptions || pendingAction !== null || (optionsData?.options?.length ?? 0) === 0}
              onClick={selectAllVisibleOptions}
            >
              Select All Visible
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!capabilities.modOptions || pendingAction !== null || selectedCount === 0}
              onClick={clearSelectedOptions}
            >
              Clear Selection
            </button>
            <button
              type="button"
              disabled={!capabilities.modOptions || pendingAction !== null || selectedDisabledCount === 0}
              onClick={submitEnableSelectedOptions}
            >
              Enable Selected
            </button>
            <button
              type="button"
              disabled={!capabilities.modOptions || pendingAction !== null || selectedEnabledCount === 0}
              onClick={submitDisableSelectedOptions}
            >
              Disable Selected
            </button>
            <button
              type="button"
              className="danger"
              disabled={!capabilities.modOptions || pendingAction !== null || selectedCount === 0}
              onClick={submitRemoveSelectedOptions}
            >
              Remove Selected
            </button>
          </div>
        </div>

        <form className="control-form-row" onSubmit={submitAddOption}>
          <label className="grow">
            Add option
            <input
              value={newOptionLabel}
              onChange={(event) => setNewOptionLabel(event.target.value)}
              placeholder="Example: Controller DC"
              disabled={!capabilities.modOptions}
            />
          </label>
          <button
            type="submit"
            disabled={!capabilities.modOptions || pendingAction !== null || newOptionLabel.trim().length === 0}
          >
            Add
          </button>
        </form>

        <div className="option-list" role="list">
          {(optionsData?.options ?? []).map((option) => {
            const editing = option.id === editOptionId
            const stateClass = option.enabled ? 'enabled' : 'disabled'
            return (
              <article key={option.id} className={`option-item ${stateClass}`} role="listitem">
                <label className="option-select">
                  <input
                    type="checkbox"
                    checked={selectedOptionSet.has(option.id)}
                    onChange={(event) => handleOptionSelectionChange(option.id, event)}
                    disabled={!capabilities.modOptions || pendingAction !== null}
                    aria-label={`Select ${option.label}`}
                  />
                </label>

                <div className="option-main">
                  {editing ? (
                    <input
                      value={editOptionLabel}
                      onChange={(event) => setEditOptionLabel(event.target.value)}
                      aria-label="Edit option label"
                      disabled={!capabilities.modOptions}
                    />
                  ) : (
                    <strong>{option.label}</strong>
                  )}
                  <span className={`option-state ${stateClass}`}>{option.enabled ? 'Enabled' : 'Disabled'}</span>
                </div>

                <div className="option-actions">
                  {editing ? (
                    <>
                      <button
                        type="button"
                        disabled={pendingAction !== null || !capabilities.modOptions}
                        onClick={() => saveEdit(option.id)}
                      >
                        Save
                      </button>
                      <button type="button" disabled={pendingAction !== null || !capabilities.modOptions} onClick={cancelEdit}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        disabled={pendingAction !== null || !capabilities.modOptions}
                        onClick={() => beginEdit(option)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        disabled={pendingAction !== null || !capabilities.modOptions}
                        onClick={() => toggleOption(option)}
                      >
                        {option.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        type="button"
                        disabled={pendingAction !== null || !capabilities.modOptions}
                        onClick={() => deleteOption(option)}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
              </article>
            )
          })}
        </div>
        </section>
      )}
    </main>
  )
}

export default App