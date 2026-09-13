import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import './App.css'

type ThemeMode = 'light' | 'dark'

type SkinDecorationSide = 'left' | 'right'
type SkinFit = 'cover' | 'contain' | 'fill' | 'scale-down'
type SkinAnchorY = 'top' | 'center' | 'bottom'
type SkinDecorationMotion = 'none' | 'float-gentle'
type SkinDecorationLightEffect = 'none' | 'candle-flicker'
type SkinResponsiveKey = 'max860' | 'max640' | 'max430' | 'max390' | 'max360' | 'shortMobile'
type SkinResponsiveBehavior = 'dim' | 'static-only' | 'hide'
type SkinAnimationToken =
  | 'free-soft-pulse'
  | 'called-border-pulse'
  | 'stamped-pop-lock'
  | 'hover-glow'
  | 'winning-radiant'

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
  status: 'idle' | 'open' | 'running' | 'stopped' | 'ended'
  calledOptions?: string[]
  players?: number
  winners?: string[]
  maxWinners?: number
  winnerGraceSeconds?: number
  winnerGraceEndsAt?: string | null
  winnerGraceSecondsRemaining?: number | null
  theme?: ResolvedTheme
}

interface CardCell {
  value: string
  free: boolean
}

interface PlayerView {
  userId: string
  userName: string
  stamps: number[]
  hasWon: boolean
  invalidStampCount: number
  card: {
    cells: CardCell[]
  }
}

interface PlayerCardResponse {
  ok: boolean
  player: PlayerView
  session?: SessionSummary
}

interface JoinResponse {
  ok: boolean
  joined: boolean
  player: PlayerView
  session?: SessionSummary
  message: string
}

interface ViewerAuthMeResponse {
  ok: boolean
  user: {
    userId: string
    userName: string
    sessionId: string
  }
}

interface ViewerSessionBootstrapResponse extends ViewerAuthMeResponse {
  expiresAt: number
}

interface ClaimResponse {
  ok: boolean
  alreadyClaimed?: boolean
  hasWon?: boolean
  hasWonNow?: boolean
  message?: string
}

interface StampResponse {
  ok: boolean
  claimAvailable?: boolean
}

interface SkinBackgroundRuntime {
  imageUrl?: string
  videoWebmUrl?: string
  videoMp4Url?: string
  fit: SkinFit
  position: string
  loop: boolean
  muted: boolean
  playsInline: boolean
  autoplay: boolean
}

interface SkinDecorationRuntime {
  imageUrl?: string
  videoWebmUrl?: string
  videoMp4Url?: string
  widthPx: number
  opacity: number
  anchorY: SkinAnchorY
  blendMode: string
  motion: SkinDecorationMotion
  safeZoneOffsetPx: number
  offsetYPx: number
  lightEffect: SkinDecorationLightEffect
}

interface SkinAnimationsRuntime {
  free: SkinAnimationToken | null
  called: SkinAnimationToken | null
  stamped: SkinAnimationToken | null
  hover: SkinAnimationToken | null
  winning: SkinAnimationToken | null
  speedMultiplier: number
}

type SkinResponsiveRules = Partial<
  Record<SkinResponsiveKey, Partial<Record<SkinDecorationSide, SkinResponsiveBehavior>>>
>

interface SkinRuntime {
  id: string
  name: string
  description: string
  background: SkinBackgroundRuntime | null
  decorations: Partial<Record<SkinDecorationSide, SkinDecorationRuntime>>
  responsive: SkinResponsiveRules
  animations: SkinAnimationsRuntime
}

const pollIntervalMs = 4000
const tenantSlugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const skinIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const skinAssetPathPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const canonicalViewerApiBase = 'https://public-control.custom-overlays.com'
const hostedViewerFallbackHosts = new Set([
  'public-card.custom-overlays.com',
  'public-bingo-viewer.web.app',
  'public-bingo-viewer.firebaseapp.com',
  'stream-bingo-public-viewer.web.app',
  'stream-bingo-public-viewer.firebaseapp.com',
])
const supportedSkinFits = new Set<SkinFit>(['cover', 'contain', 'fill', 'scale-down'])
const supportedAnchorYValues = new Set<SkinAnchorY>(['top', 'center', 'bottom'])
const supportedDecorationMotionTokens = new Set<SkinDecorationMotion>(['none', 'float-gentle'])
const supportedDecorationLightEffectTokens = new Set<SkinDecorationLightEffect>(['none', 'candle-flicker'])
const supportedResponsiveBehaviors = new Set<SkinResponsiveBehavior>(['dim', 'static-only', 'hide'])
const supportedSkinAnimationTokens = new Set<SkinAnimationToken>([
  'free-soft-pulse',
  'called-border-pulse',
  'stamped-pop-lock',
  'hover-glow',
  'winning-radiant',
])
const skinResponsiveKeys: SkinResponsiveKey[] = ['max860', 'max640', 'max430', 'max390', 'max360', 'shortMobile']
const defaultDecorationState: Record<SkinDecorationSide, boolean> = {
  left: false,
  right: false,
}
const videoMimeSupportCache = new Map<string, boolean>()

function toThemeVariableName(key: keyof ThemePalette): string {
  return `--theme-${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`
}

function applyResolvedTheme(theme: ResolvedTheme | null | undefined): void {
  if (!theme) {
    return
  }

  const root = document.documentElement
  root.dataset.themeMode = theme.mode

  ;(Object.keys(theme.palette) as (keyof ThemePalette)[]).forEach((key) => {
    root.style.setProperty(toThemeVariableName(key), theme.palette[key])
  })
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

function resolveHostedViewerApiFallback(hostname: string): string | null {
  const normalized = hostname.trim().toLowerCase()
  if (!normalized || normalized === 'localhost' || normalized === '127.0.0.1') {
    return null
  }

  return hostedViewerFallbackHosts.has(normalized) ? canonicalViewerApiBase : null
}

function resolveContext() {
  const params = new URLSearchParams(window.location.search)
  const queryApi = params.get('api')?.trim()
  const envApi = import.meta.env.VITE_API_BASE_URL?.trim()
  const hostedFallbackApiBase = resolveHostedViewerApiFallback(window.location.hostname)
  const rawApiBase = queryApi || envApi || hostedFallbackApiBase || window.location.origin
  const tenantSlug = resolveTenantSlug(window.location.pathname, params)
  const invite = params.get('invite')?.trim() ?? ''
  const legacyUserId = params.get('userId')?.trim() ?? ''
  const legacyUserName = params.get('userName')?.trim() ?? ''
  const authError = params.get('authError')?.trim() ?? ''

  const hash = window.location.hash.replace(/^#/, '')
  const hashParams = new URLSearchParams(hash)
  const authToken = hashParams.get('auth')?.trim() ?? ''

  return {
    apiBase: rawApiBase.replace(/\/+$/, ''),
    tenantSlug,
    invite,
    legacyUserId,
    legacyUserName,
    authError,
    authToken,
  }
}

async function requestJson<T>(url: string, init?: RequestInit, viewerAuthToken?: string): Promise<T> {
  const authHeaders: HeadersInit = viewerAuthToken
    ? {
        authorization: `Bearer ${viewerAuthToken}`,
      }
    : {}

  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      ...authHeaders,
      ...(init?.headers ?? {}),
    },
  })
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  const text = await response.text()

  let payload: unknown = null
  if (text.length > 0) {
    if (contentType.includes('application/json')) {
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error('API returned malformed JSON. Confirm VITE_API_BASE_URL or ?api points to the controller API.')
      }
    } else if (response.ok) {
      throw new Error(
        `API did not return JSON (${contentType || 'unknown content type'}). Confirm VITE_API_BASE_URL or ?api is configured correctly.`,
      )
    } else {
      payload = { message: text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() }
    }
  }

  if (!response.ok) {
    const payloadRecord = payload as Record<string, unknown> | null
    const message =
      (payloadRecord?.error as string | undefined) ??
      (payloadRecord?.message as string | undefined) ??
      `${response.status} ${response.statusText}`
    throw new Error(message)
  }

  return payload as T
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function clampNumber(value: number, min: number, max: number): number {
  if (value < min) {
    return min
  }

  if (value > max) {
    return max
  }

  return value
}

function normalizeThemeSkinId(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized || normalized === 'default') {
    return null
  }

  return skinIdPattern.test(normalized) ? normalized : null
}

function normalizeSkinAssetPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  if (!normalized) {
    return null
  }

  if (normalized.startsWith('/') || normalized.includes('..') || /^https?:\/\//i.test(normalized)) {
    return null
  }

  return skinAssetPathPattern.test(normalized) ? normalized : null
}

function buildSkinAssetUrl(skinId: string, assetPath: string): string {
  const encodedPath = assetPath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')

  return `/skins/${encodeURIComponent(skinId)}/${encodedPath}`
}

function normalizeSkinFit(value: unknown): SkinFit {
  return typeof value === 'string' && supportedSkinFits.has(value as SkinFit) ? (value as SkinFit) : 'cover'
}

function normalizeSkinAnchorY(value: unknown): SkinAnchorY {
  return typeof value === 'string' && supportedAnchorYValues.has(value as SkinAnchorY) ? (value as SkinAnchorY) : 'center'
}

function normalizeSkinMotion(value: unknown): SkinDecorationMotion {
  return typeof value === 'string' && supportedDecorationMotionTokens.has(value as SkinDecorationMotion)
    ? (value as SkinDecorationMotion)
    : 'none'
}

function normalizeSkinLightEffect(value: unknown): SkinDecorationLightEffect {
  return typeof value === 'string' && supportedDecorationLightEffectTokens.has(value as SkinDecorationLightEffect)
    ? (value as SkinDecorationLightEffect)
    : 'none'
}

function normalizeSkinAnimationToken(value: unknown): SkinAnimationToken | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  return supportedSkinAnimationTokens.has(normalized as SkinAnimationToken)
    ? (normalized as SkinAnimationToken)
    : null
}

function normalizeResponsiveBehavior(value: unknown): SkinResponsiveBehavior | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  return supportedResponsiveBehaviors.has(normalized as SkinResponsiveBehavior)
    ? (normalized as SkinResponsiveBehavior)
    : null
}

function normalizeSkinBackground(value: unknown, skinId: string): SkinBackgroundRuntime | null {
  const input = asRecord(value)
  if (!input) {
    return null
  }

  const imageAsset = normalizeSkinAssetPath(input.image)
  const videoWebmAsset = normalizeSkinAssetPath(input.videoWebm)
  const videoMp4Asset = normalizeSkinAssetPath(input.videoMp4)
  if (!imageAsset && !videoWebmAsset && !videoMp4Asset) {
    return null
  }

  return {
    imageUrl: imageAsset ? buildSkinAssetUrl(skinId, imageAsset) : undefined,
    videoWebmUrl: videoWebmAsset ? buildSkinAssetUrl(skinId, videoWebmAsset) : undefined,
    videoMp4Url: videoMp4Asset ? buildSkinAssetUrl(skinId, videoMp4Asset) : undefined,
    fit: normalizeSkinFit(input.fit),
    position: typeof input.position === 'string' && input.position.trim().length > 0 ? input.position.trim() : 'center center',
    loop: typeof input.loop === 'boolean' ? input.loop : true,
    muted: typeof input.muted === 'boolean' ? input.muted : true,
    playsInline: typeof input.playsInline === 'boolean' ? input.playsInline : true,
    autoplay: typeof input.autoplay === 'boolean' ? input.autoplay : true,
  }
}

function normalizeSkinDecoration(
  side: SkinDecorationSide,
  value: unknown,
  skinId: string,
): SkinDecorationRuntime | null {
  const input = asRecord(value)
  if (!input) {
    return null
  }

  const imageAsset = normalizeSkinAssetPath(input.imageFallback)
  const videoWebmAsset = normalizeSkinAssetPath(input.videoWebm)
  const videoMp4Asset = normalizeSkinAssetPath(input.videoMp4)
  if (!imageAsset && !videoWebmAsset && !videoMp4Asset) {
    return null
  }

  const widthPx =
    typeof input.widthPx === 'number' && Number.isFinite(input.widthPx)
      ? clampNumber(input.widthPx, 120, 960)
      : side === 'left'
        ? 420
        : 390

  const opacity =
    typeof input.opacity === 'number' && Number.isFinite(input.opacity)
      ? clampNumber(input.opacity, 0, 1)
      : 1

  const blendMode =
    typeof input.blendMode === 'string' && input.blendMode.trim().length > 0
      ? input.blendMode.trim().toLowerCase()
      : 'normal'

  const safeZoneOffsetPx =
    typeof input.safeZoneOffsetPx === 'number' && Number.isFinite(input.safeZoneOffsetPx)
      ? clampNumber(input.safeZoneOffsetPx, -120, 240)
      : 12

  const offsetYPx = typeof input.offsetYPx === 'number' && Number.isFinite(input.offsetYPx) ? input.offsetYPx : 0

  return {
    imageUrl: imageAsset ? buildSkinAssetUrl(skinId, imageAsset) : undefined,
    videoWebmUrl: videoWebmAsset ? buildSkinAssetUrl(skinId, videoWebmAsset) : undefined,
    videoMp4Url: videoMp4Asset ? buildSkinAssetUrl(skinId, videoMp4Asset) : undefined,
    widthPx,
    opacity,
    anchorY: normalizeSkinAnchorY(input.anchorY),
    blendMode,
    motion: normalizeSkinMotion(input.motion),
    safeZoneOffsetPx,
    offsetYPx,
    lightEffect: normalizeSkinLightEffect(input.lightEffect),
  }
}

function normalizeSkinAnimations(value: unknown): SkinAnimationsRuntime {
  const defaults: SkinAnimationsRuntime = {
    free: null,
    called: null,
    stamped: null,
    hover: null,
    winning: null,
    speedMultiplier: 1,
  }

  const input = asRecord(value)
  if (!input) {
    return defaults
  }

  const speedValue = input.speedMultiplier
  if (typeof speedValue === 'number' && Number.isFinite(speedValue) && speedValue > 0) {
    defaults.speedMultiplier = clampNumber(speedValue, 0.5, 2.5)
  }

  defaults.free = normalizeSkinAnimationToken(input.free)
  defaults.called = normalizeSkinAnimationToken(input.called)
  defaults.stamped = normalizeSkinAnimationToken(input.stamped)
  defaults.hover = normalizeSkinAnimationToken(input.hover)
  defaults.winning = normalizeSkinAnimationToken(input.winning)

  return defaults
}

function normalizeSkinResponsiveRules(value: unknown): SkinResponsiveRules {
  const normalized: SkinResponsiveRules = {}
  const input = asRecord(value)
  if (!input) {
    return normalized
  }

  for (const key of skinResponsiveKeys) {
    const bucket = asRecord(input[key])
    if (!bucket) {
      continue
    }

    const nextBucket: Partial<Record<SkinDecorationSide, SkinResponsiveBehavior>> = {}
    const left = normalizeResponsiveBehavior(bucket.left)
    const right = normalizeResponsiveBehavior(bucket.right)

    if (left) {
      nextBucket.left = left
    }

    if (right) {
      nextBucket.right = right
    }

    if (Object.keys(nextBucket).length > 0) {
      normalized[key] = nextBucket
    }
  }

  return normalized
}

function resolveResponsiveBehaviorForDecoration(
  rules: SkinResponsiveRules,
  side: SkinDecorationSide,
  viewportWidth: number,
  viewportHeight: number,
): SkinResponsiveBehavior | null {
  let behavior: SkinResponsiveBehavior | null = null

  if (viewportWidth <= 860) {
    behavior = rules.max860?.[side] ?? behavior
  }

  if (viewportWidth <= 640) {
    behavior = rules.max640?.[side] ?? behavior
  }

  if (viewportWidth <= 430) {
    behavior = rules.max430?.[side] ?? behavior
  }

  if (viewportWidth <= 390) {
    behavior = rules.max390?.[side] ?? behavior
  }

  if (viewportWidth <= 360) {
    behavior = rules.max360?.[side] ?? behavior
  }

  if (viewportWidth <= 540 && viewportHeight <= 740) {
    behavior = rules.shortMobile?.[side] ?? behavior
  }

  return behavior
}

function buildSkinRuntime(payload: unknown, requestedSkinId: string): SkinRuntime {
  const root = asRecord(payload)
  if (!root) {
    throw new Error('skin.json must be an object.')
  }

  if (root.schemaVersion !== 1) {
    throw new Error('Unsupported skin schemaVersion. Expected 1.')
  }

  const parsedSkinId = normalizeThemeSkinId(root.id)
  if (!parsedSkinId) {
    throw new Error('Skin id is missing or invalid.')
  }

  if (parsedSkinId !== requestedSkinId) {
    throw new Error(`Skin id mismatch. Requested ${requestedSkinId}, received ${parsedSkinId}.`)
  }

  const decorationsRoot = asRecord(root.decorations)
  const leftDecoration = normalizeSkinDecoration('left', decorationsRoot?.left, requestedSkinId)
  const rightDecoration = normalizeSkinDecoration('right', decorationsRoot?.right, requestedSkinId)

  return {
    id: requestedSkinId,
    name: typeof root.name === 'string' && root.name.trim().length > 0 ? root.name.trim() : requestedSkinId,
    description: typeof root.description === 'string' ? root.description.trim() : '',
    background: normalizeSkinBackground(root.background, requestedSkinId),
    decorations: {
      left: leftDecoration ?? undefined,
      right: rightDecoration ?? undefined,
    },
    responsive: normalizeSkinResponsiveRules(root.responsive),
    animations: normalizeSkinAnimations(root.animations),
  }
}

async function fetchSkinRuntime(skinId: string): Promise<SkinRuntime> {
  const response = await fetch(`/skins/${encodeURIComponent(skinId)}/skin.json`, {
    cache: 'no-store',
    credentials: 'same-origin',
  })

  if (!response.ok) {
    throw new Error(`skin.json could not be loaded (${response.status} ${response.statusText}).`)
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    throw new Error('skin.json returned invalid JSON.')
  }

  return buildSkinRuntime(payload, skinId)
}

function isVideoMimeSupported(mimeType: string): boolean {
  if (typeof document === 'undefined') {
    return true
  }

  if (videoMimeSupportCache.has(mimeType)) {
    return videoMimeSupportCache.get(mimeType) === true
  }

  const probe = document.createElement('video')
  const supportValue = probe.canPlayType(mimeType)
  const supported = supportValue === 'probably' || supportValue === 'maybe'
  videoMimeSupportCache.set(mimeType, supported)
  return supported
}

function canUseVideoSource(videoWebmUrl: string | undefined, videoMp4Url: string | undefined): boolean {
  const supportsWebm = Boolean(videoWebmUrl) && isVideoMimeSupported('video/webm')
  const supportsMp4 = Boolean(videoMp4Url) && isVideoMimeSupported('video/mp4')
  return supportsWebm || supportsMp4
}

function buildSkinAnimationStyle(animations: SkinAnimationsRuntime | null): CSSProperties {
  return {
    '--skin-animation-speed-multiplier': String(animations?.speedMultiplier ?? 1),
    '--skin-anim-free-name': animations?.free ?? 'none',
    '--skin-anim-called-name': animations?.called ?? 'none',
    '--skin-anim-stamped-name': animations?.stamped ?? 'none',
    '--skin-anim-hover-name': animations?.hover ?? 'none',
    '--skin-anim-winning-name': animations?.winning ?? 'none',
  } as CSSProperties
}

function App() {
  const { apiBase, tenantSlug, invite, legacyUserId, legacyUserName, authError, authToken } = useMemo(
    () => resolveContext(),
    [],
  )

  const [session, setSession] = useState<SessionSummary | null>(null)
  const [player, setPlayer] = useState<PlayerView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string>('')
  const [stampingIndex, setStampingIndex] = useState<number | null>(null)
  const [claimPending, setClaimPending] = useState(false)
  const [joinPending, setJoinPending] = useState(false)
  const [authReady, setAuthReady] = useState(false)
  const [viewerAuthToken, setViewerAuthToken] = useState<string>(() => {
    const stored = window.sessionStorage.getItem('viewer_auth_token')?.trim() ?? ''
    return authToken || stored
  })
  const [skinRuntime, setSkinRuntime] = useState<SkinRuntime | null>(null)
  const [backgroundVideoFailed, setBackgroundVideoFailed] = useState(false)
  const [decorationVideoFailed, setDecorationVideoFailed] = useState<Record<SkinDecorationSide, boolean>>(
    defaultDecorationState,
  )
  const [decorationImageFailed, setDecorationImageFailed] = useState<Record<SkinDecorationSide, boolean>>(
    defaultDecorationState,
  )
  const [viewport, setViewport] = useState(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 720,
  }))

  useEffect(() => {
    let cancelled = false

    async function bootstrapAuth() {
      if (authError) {
        window.sessionStorage.removeItem('viewer_auth_token')
        setViewerAuthToken('')
        setError(
          invite
            ? `Login failed (${authError}). Retry sign-in from this same link; redeem again only if it keeps failing.`
            : `Login failed (${authError}). Please redeem again to get a fresh viewer link tied to your Twitch account.`,
        )
        setLoading(false)
        return
      }

      try {
        let tokenForRequest = viewerAuthToken

        if (authToken) {
          tokenForRequest = authToken
          window.sessionStorage.setItem('viewer_auth_token', authToken)
          setViewerAuthToken(authToken)

          try {
            await requestJson<ViewerSessionBootstrapResponse>(
              buildApiUrl(apiBase, tenantSlug, '/auth/viewer/session'),
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ authToken }),
              },
              authToken,
            )
          } catch {
            // Cookie bootstrap can fail in strict browser privacy modes; bearer auth still works.
          }

          if (!cancelled) {
            const cleanUrl = new URL(window.location.href)
            cleanUrl.hash = ''
            window.history.replaceState({}, '', cleanUrl.toString())
          }
        }

        await requestJson<ViewerAuthMeResponse>(
          buildApiUrl(apiBase, tenantSlug, '/auth/me'),
          undefined,
          tokenForRequest,
        )

        if (!cancelled) {
          setAuthReady(true)
          setError(null)
        }
      } catch {
        if (cancelled) {
          return
        }

        if (!invite) {
          if (legacyUserId) {
            const startUrl = new URL(buildApiUrl(apiBase, tenantSlug, '/auth/twitch/start'))
            startUrl.searchParams.set('userId', legacyUserId)
            if (legacyUserName) {
              startUrl.searchParams.set('userName', legacyUserName)
            }

            window.location.href = startUrl.toString()
            return
          }

          setError('This viewer link is missing an invite token. Redeem channel points again for a fresh secure link.')
          setLoading(false)
          return
        }

        const startUrl = new URL(buildApiUrl(apiBase, tenantSlug, '/auth/twitch/start'))
        startUrl.searchParams.set('invite', invite)
        window.location.href = startUrl.toString()
      }
    }

    void bootstrapAuth()

    return () => {
      cancelled = true
    }
  }, [apiBase, tenantSlug, authError, authToken, invite, legacyUserId, legacyUserName, viewerAuthToken])

  const calledSet = useMemo(() => new Set(session?.calledOptions ?? []), [session?.calledOptions])

  const progress = useMemo(() => {
    if (!player) {
      return 0
    }

    const markableCells = player.card.cells.filter((cell) => !cell.free).length
    const stampedCount = player.stamps.filter((index) => !player.card.cells[index]?.free).length

    if (markableCells === 0) {
      return 0
    }

    return Math.round((stampedCount / markableCells) * 100)
  }, [player])

  useEffect(() => {
    if (!authReady) {
      return
    }

    let active = true

    async function refresh(joinIfMissing: boolean) {
      try {
        const sessionData = await requestJson<SessionSummary>(
          buildApiUrl(apiBase, tenantSlug, '/session'),
          undefined,
          viewerAuthToken,
        )
        if (!active) {
          return
        }

        setSession(sessionData)

        if (sessionData.status === 'idle') {
          setPlayer(null)
          setError('No active bingo session right now.')
          return
        }

        try {
          const cardResponse = await requestJson<PlayerCardResponse>(
            buildApiUrl(apiBase, tenantSlug, '/player/card'),
            undefined,
            viewerAuthToken,
          )
          if (!active) {
            return
          }

          setPlayer(cardResponse.player)
          if (cardResponse.session) {
            setSession(cardResponse.session)
          }
          setError(null)
        } catch (cardError) {
          const cardMessage = cardError instanceof Error ? cardError.message : 'Failed to load card.'

          if (!joinIfMissing || !cardMessage.includes('player_not_found')) {
            setPlayer(null)
            setError(cardMessage)
            return
          }

          const joinResponse = await requestJson<JoinResponse>(
            buildApiUrl(apiBase, tenantSlug, '/player/join'),
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({}),
            },
            viewerAuthToken,
          )

          if (!active) {
            return
          }

          setPlayer(joinResponse.player)
          if (joinResponse.session) {
            setSession(joinResponse.session)
          }
          setMessage(joinResponse.message)
          setError(null)
        }
      } catch (nextError) {
        if (!active) {
          return
        }

        setError(nextError instanceof Error ? nextError.message : 'Failed to refresh viewer state.')
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    void refresh(true)
    const timer = window.setInterval(() => {
      void refresh(false)
    }, pollIntervalMs)

    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [apiBase, tenantSlug, authReady, viewerAuthToken])

  useEffect(() => {
    applyResolvedTheme(session?.theme)
  }, [session?.theme])

  const requestedSkinId = useMemo(() => normalizeThemeSkinId(session?.theme?.skinId), [session?.theme?.skinId])

  useEffect(() => {
    let active = true

    setBackgroundVideoFailed(false)
    setDecorationVideoFailed({ ...defaultDecorationState })
    setDecorationImageFailed({ ...defaultDecorationState })

    if (!requestedSkinId) {
      setSkinRuntime(null)
      return () => {
        active = false
      }
    }

    setSkinRuntime(null)

    void (async () => {
      try {
        const loadedSkin = await fetchSkinRuntime(requestedSkinId)
        if (!active) {
          return
        }

        setSkinRuntime(loadedSkin)
      } catch (nextError) {
        if (!active) {
          return
        }

        console.warn(`[viewer] skin load failed for ${requestedSkinId}; using default viewer visuals.`, nextError)
        setSkinRuntime(null)
      }
    })()

    return () => {
      active = false
    }
  }, [requestedSkinId])

  useEffect(() => {
    const handleResize = () => {
      setViewport({
        width: window.innerWidth,
        height: window.innerHeight,
      })
    }

    handleResize()
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  const calledPreview = useMemo(() => (session?.calledOptions ?? []).slice(0, 5), [session?.calledOptions])
  const calledOverflow = Math.max((session?.calledOptions?.length ?? 0) - calledPreview.length, 0)
  const winnerCount = session?.winners?.length ?? 0
  const winnerLimit = session?.maxWinners ?? 0
  const graceRemaining = session?.winnerGraceSecondsRemaining ?? null

  const viewerSkinStyle = useMemo(() => buildSkinAnimationStyle(skinRuntime?.animations ?? null), [skinRuntime?.animations])

  const background = skinRuntime?.background ?? null
  const showBackgroundVideo =
    background !== null
    && !backgroundVideoFailed
    && canUseVideoSource(background.videoWebmUrl, background.videoMp4Url)

  const backgroundImageStyle = useMemo<CSSProperties | undefined>(() => {
    if (!background?.imageUrl) {
      return undefined
    }

    return {
      backgroundImage: `url("${background.imageUrl}")`,
      backgroundSize: background.fit,
      backgroundPosition: background.position,
    }
  }, [background?.fit, background?.imageUrl, background?.position])

  const backgroundVideoStyle = useMemo<CSSProperties | undefined>(() => {
    if (!background) {
      return undefined
    }

    return {
      objectFit: background.fit,
      objectPosition: background.position,
    }
  }, [background])

  const viewerClassName = useMemo(() => {
    const classes = ['viewer']
    if (player?.hasWon) {
      classes.push('viewer-winning')
    }
    if (skinRuntime) {
      classes.push('viewer-skin-active')
    }

    return classes.join(' ')
  }, [player?.hasWon, skinRuntime])

  function markDecorationVideoFailed(side: SkinDecorationSide) {
    setDecorationVideoFailed((current) => {
      if (current[side]) {
        return current
      }

      return {
        ...current,
        [side]: true,
      }
    })
  }

  function markDecorationImageFailed(side: SkinDecorationSide) {
    setDecorationImageFailed((current) => {
      if (current[side]) {
        return current
      }

      return {
        ...current,
        [side]: true,
      }
    })
  }

  function renderSkinDecoration(side: SkinDecorationSide) {
    const decoration = skinRuntime?.decorations[side]
    if (!decoration) {
      return null
    }

    const responsiveBehavior = resolveResponsiveBehaviorForDecoration(
      skinRuntime.responsive,
      side,
      viewport.width,
      viewport.height,
    )

    if (responsiveBehavior === 'hide') {
      return null
    }

    const staticOnly = responsiveBehavior === 'static-only'
    const dimmed = responsiveBehavior === 'dim'
    const effectiveOpacity = clampNumber(decoration.opacity * (dimmed ? 0.58 : 1), 0, 1)
    const motionToken = staticOnly ? 'none' : decoration.motion
    const lightEffectToken = staticOnly ? 'none' : decoration.lightEffect
    const showVideo =
      !staticOnly
      && !decorationVideoFailed[side]
      && canUseVideoSource(decoration.videoWebmUrl, decoration.videoMp4Url)
    const showImageFallback = Boolean(decoration.imageUrl) && !decorationImageFailed[side]

    if (!showVideo && !showImageFallback) {
      return null
    }

    const style = {
      '--skin-decoration-width': `${Math.round(decoration.widthPx)}px`,
      '--skin-decoration-opacity': String(effectiveOpacity),
      '--skin-decoration-safe-zone-offset': `${Math.round(decoration.safeZoneOffsetPx)}px`,
      '--skin-decoration-offset-y': `${Math.round(decoration.offsetYPx)}px`,
      mixBlendMode: decoration.blendMode,
    } as CSSProperties

    return (
      <div key={side} className={`viewer-skin-decoration side-${side}`} style={style}>
        <div className={`viewer-skin-decoration-anchor anchor-${decoration.anchorY}`}>
          <div className="viewer-skin-decoration-shell">
            <div className={`viewer-skin-decoration-light light-${lightEffectToken}`}>
              <div className={`viewer-skin-decoration-motion motion-${motionToken}`}>
                {showVideo ? (
                  <video
                    className="viewer-skin-decoration-video"
                    autoPlay
                    loop
                    muted
                    playsInline
                    onError={() => {
                      markDecorationVideoFailed(side)
                    }}
                    onLoadedData={(event) => {
                      const playPromise = event.currentTarget.play()
                      if (!playPromise) {
                        return
                      }

                      void playPromise.catch(() => {
                        markDecorationVideoFailed(side)
                      })
                    }}
                  >
                    {decoration.videoWebmUrl && <source src={decoration.videoWebmUrl} type="video/webm" />}
                    {decoration.videoMp4Url && <source src={decoration.videoMp4Url} type="video/mp4" />}
                  </video>
                ) : (
                  showImageFallback && (
                    <img
                      src={decoration.imageUrl}
                      alt=""
                      className="viewer-skin-decoration-image"
                      loading="lazy"
                      onError={() => {
                        markDecorationImageFailed(side)
                      }}
                    />
                  )
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  async function joinCurrentSession() {
    if (!authReady) {
      setError('Twitch login is required before joining.')
      return
    }

    setJoinPending(true)
    setError(null)

    try {
      const response = await requestJson<JoinResponse>(
        buildApiUrl(apiBase, tenantSlug, '/player/join'),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
        viewerAuthToken,
      )

      setPlayer(response.player)
      if (response.session) {
        setSession(response.session)
      }
      setMessage(response.message)
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : 'Join failed.')
    } finally {
      setJoinPending(false)
    }
  }

  async function stampCell(index: number) {
    if (!player || stampingIndex !== null) {
      return
    }

    const cell = player.card.cells[index]
    if (!cell || cell.free || player.stamps.includes(index)) {
      return
    }

    if (!calledSet.has(cell.value)) {
      return
    }

    setStampingIndex(index)
    setError(null)

    try {
      const response = await requestJson<StampResponse>(
        buildApiUrl(apiBase, tenantSlug, '/player/stamp'),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ index }),
        },
        viewerAuthToken,
      )

      if (response.ok === true) {
        setMessage(
          response.claimAvailable
            ? `Stamped: ${cell.value}. Pattern ready. Press Call Bingo to claim.`
            : `Stamped: ${cell.value}`,
        )
      }

      const refreshedCard = await requestJson<PlayerCardResponse>(
        buildApiUrl(apiBase, tenantSlug, '/player/card'),
        undefined,
        viewerAuthToken,
      )
      setPlayer(refreshedCard.player)
      if (refreshedCard.session) {
        setSession(refreshedCard.session)
      }
    } catch (stampError) {
      setError(stampError instanceof Error ? stampError.message : 'Stamp failed.')
    } finally {
      setStampingIndex(null)
    }
  }

  async function claimBingo() {
    if (!player || claimPending) {
      return
    }

    setClaimPending(true)
    setError(null)

    try {
      const response = await requestJson<ClaimResponse>(
        buildApiUrl(apiBase, tenantSlug, '/player/claim'),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
        viewerAuthToken,
      )

      if (response.alreadyClaimed) {
        setMessage('Bingo already claimed for this round.')
      } else if (response.hasWonNow) {
        setMessage('Bingo claim accepted. You are now marked as a winner.')
      } else {
        setMessage(response.message ?? 'Bingo claim submitted.')
      }

      const refreshedCard = await requestJson<PlayerCardResponse>(
        buildApiUrl(apiBase, tenantSlug, '/player/card'),
        undefined,
        viewerAuthToken,
      )
      setPlayer(refreshedCard.player)
      if (refreshedCard.session) {
        setSession(refreshedCard.session)
      }
    } catch (claimError) {
      setError(claimError instanceof Error ? claimError.message : 'Bingo claim failed.')
    } finally {
      setClaimPending(false)
    }
  }

  const leftDecoration = renderSkinDecoration('left')
  const rightDecoration = renderSkinDecoration('right')

  return (
    <main className={viewerClassName} style={viewerSkinStyle}>
      {background && (
        <div className="viewer-skin-layer viewer-skin-background" aria-hidden="true">
          {background.imageUrl && <div className="viewer-skin-background-image" style={backgroundImageStyle} />}
          {showBackgroundVideo && (
            <video
              className="viewer-skin-background-video"
              autoPlay={background.autoplay}
              loop={background.loop}
              muted={background.muted}
              playsInline={background.playsInline}
              style={backgroundVideoStyle}
              onError={() => {
                setBackgroundVideoFailed(true)
              }}
              onLoadedData={(event) => {
                const playPromise = event.currentTarget.play()
                if (!playPromise) {
                  return
                }

                void playPromise.catch(() => {
                  setBackgroundVideoFailed(true)
                })
              }}
            >
              {background.videoWebmUrl && <source src={background.videoWebmUrl} type="video/webm" />}
              {background.videoMp4Url && <source src={background.videoMp4Url} type="video/mp4" />}
            </video>
          )}
        </div>
      )}

      {(leftDecoration || rightDecoration) && (
        <div className="viewer-skin-layer viewer-skin-decorations" aria-hidden="true">
          {leftDecoration}
          {rightDecoration}
        </div>
      )}

      <div className="viewer-content">
        <header className="viewer-header">
          <p className="viewer-badge">Viewer Card Live</p>
          <h1>Your Bingo Board</h1>
          <p className="viewer-subtitle">
            Tap called cells to stamp them. Stamping does not auto-win; press Call Bingo when your pattern is ready.
          </p>
          <p className="viewer-progress">Progress: {progress}%</p>
        </header>

        {loading && <section className="viewer-banner">Loading your bingo state...</section>}

        {!authReady && !error && (
          <section className="viewer-banner">Verifying your Twitch login for this invite...</section>
        )}

        {error && (
          <section className="viewer-banner viewer-banner-error" role="alert">
            {error}
          </section>
        )}

        {message && <section className="viewer-banner">{message}</section>}

        {session && session.status !== 'idle' && (
          <section className="viewer-session-panel" aria-label="Session context">
            <div className="viewer-session-grid">
              <div className="viewer-session-item">
                <span className="viewer-session-label">Mode</span>
                <span className="viewer-session-value">{session.mode ?? 'n/a'}</span>
              </div>
              <div className="viewer-session-item">
                <span className="viewer-session-label">Status</span>
                <span className="viewer-session-value">{session.status}</span>
              </div>
              <div className="viewer-session-item">
                <span className="viewer-session-label">Players</span>
                <span className="viewer-session-value">{session.players ?? 0}</span>
              </div>
              <div className="viewer-session-item">
                <span className="viewer-session-label">Called</span>
                <span className="viewer-session-value">{session.calledOptions?.length ?? 0}</span>
              </div>
              <div className="viewer-session-item">
                <span className="viewer-session-label">Winners</span>
                <span className="viewer-session-value">{winnerLimit > 0 ? `${winnerCount}/${winnerLimit}` : winnerCount}</span>
              </div>
            </div>

            {graceRemaining !== null && (
              <p className="viewer-session-grace">
                {graceRemaining > 0
                  ? `Winner grace window: ${graceRemaining}s remaining.`
                  : 'Winner grace window elapsed. Session will close on the next server cycle.'}
              </p>
            )}

            {calledPreview.length > 0 && (
              <div className="viewer-called-list" aria-label="Recent called options">
                {calledPreview.map((option) => (
                  <span key={option} className="viewer-called-chip">
                    {option}
                  </span>
                ))}
                {calledOverflow > 0 && <span className="viewer-called-chip viewer-called-chip-more">+{calledOverflow} more</span>}
              </div>
            )}
          </section>
        )}

        {!player && !loading && (
          <section className="viewer-card" aria-label="Join prompt">
            <p className="viewer-subtitle">
              Card not found for this session. Use your redeem flow or join now with the button below.
            </p>
            <button
              type="button"
              className="viewer-join-button"
              onClick={() => {
                void joinCurrentSession()
              }}
              disabled={joinPending}
            >
              {joinPending ? 'Joining...' : 'Join Current Session'}
            </button>
          </section>
        )}

        {player && (
          <section className="viewer-card" aria-label="Your bingo card">
            <div className="viewer-grid">
              {player.card.cells.map((cell, index) => {
                const called = cell.free || calledSet.has(cell.value)
                const stamped = cell.free || player.stamps.includes(index)
                const disabled = stamped || !called || stampingIndex !== null

                return (
                  <button
                    type="button"
                    key={`${cell.value}-${index}`}
                    disabled={disabled}
                    aria-pressed={stamped}
                    className={`viewer-cell${called ? ' called' : ''}${stamped ? ' stamped' : ''}${cell.free ? ' free' : ''}`}
                    onClick={() => {
                      void stampCell(index)
                    }}
                  >
                    <span className="viewer-cell-label">{cell.value}</span>
                    <span className="viewer-cell-status">
                      {cell.free ? 'Free' : stamped ? 'Stamped' : called ? 'Tap to stamp' : 'Locked'}
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="viewer-card-actions">
              <button
                type="button"
                className="viewer-join-button"
                disabled={claimPending || stampingIndex !== null || player.hasWon}
                onClick={() => {
                  void claimBingo()
                }}
              >
                {player.hasWon ? 'Bingo Claimed' : claimPending ? 'Claiming Bingo...' : 'Call Bingo'}
              </button>
            </div>
          </section>
        )}

        <footer className="viewer-footer">
          Mode: {session?.mode ?? 'n/a'} | Status: {session?.status ?? 'idle'} | Called: {session?.calledOptions?.length ?? 0} |
          Winners: {winnerCount}
        </footer>
      </div>
    </main>
  )
}

export default App
