import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type OwnerGateState = 'checking' | 'signed_out' | 'forbidden' | 'not_configured' | 'authorized'

type OwnerTokenSource = 'cookie' | 'bearer'

interface OwnerUser {
  userId: string
  userLogin: string
  userName: string
}

interface OwnerAuthStatusResponse {
  ok?: boolean
  error?: string
  authenticated: boolean
  authorized: boolean
  tokenSource?: OwnerTokenSource
  user?: OwnerUser | null
  missing?: string[]
}

interface OwnerTenantRecord {
  tenantSlug: string
  source: 'persisted' | 'env' | 'fallback' | 'none'
  persistedBroadcasterId: string | null
  envBroadcasterId: string | null
  fallbackBroadcasterId: string | null
  effectiveBroadcasterId: string | null
  broadcasterUserId?: string | null
  broadcasterUserLogin?: string | null
  broadcasterUserName?: string | null
  redeemKeyConfigured: boolean
  redeemKeyCreatedAt: string | null
  redeemKeyRotatedAt: string | null
}

interface OwnerTenantsResponse {
  ok: boolean
  count: number
  defaultTenantSlug: string
  legacyInternalRedeemSecretEnabled: boolean
  setupEntryCount?: number
  tenants: OwnerTenantRecord[]
}

interface OwnerUpsertResponse {
  ok: boolean
  tenantSlug: string
  broadcasterId: string
  previousBroadcasterId: string | null
  updated: boolean
  source: 'persisted'
}

interface OwnerResolvedUserResponse {
  ok: boolean
  user: OwnerUser
}

interface OwnerRotateRedeemKeyResponse {
  ok: boolean
  tenantSlug: string
  redeemKey: string
  rotatedAt: string
  created: boolean
  legacyInternalRedeemSecretEnabled: boolean
}

interface OwnerSetupGenerateResponse {
  ok: boolean
  tenantSlug: string
  generatedAt: string
  broadcasterLabel: string
  overlayUrl: string
  controllerUrl: string
  joinUrl: string
  authorizationHeaderValue: string
  requestBody: {
    redemptionId: string
    twitchUserId: string
    twitchUserName: string
  }
  setupBlock: string
  saved: boolean
  savedAt: string | null
  totalEntries: number
}

interface OwnerSetupEntryUpsertResponse {
  ok: boolean
  tenantSlug: string
  created: boolean
  updated: boolean
  unchanged: boolean
  totalEntries: number
  savedAt: string
  setupBlock: string
  overlayUrl: string
  controllerUrl: string
  joinUrl: string
  authorizationHeaderValue: string
  requestBody: {
    redemptionId: string
    twitchUserId: string
    twitchUserName: string
  }
}

interface OwnerSetupExportArtifactMeta {
  exists: boolean
  size: number
  updatedAt: string | null
  downloadUrl: string
}

interface OwnerSetupRegenerateResponse {
  ok: boolean
  generatedAt: string
  count: number
  entryCount: number
  includeAllKnownTenants: boolean
  changed?: boolean
  markdownWritten?: boolean
  htmlWritten?: boolean
  pdfWritten?: boolean
  markdown: OwnerSetupExportArtifactMeta
  html: OwnerSetupExportArtifactMeta
  pdf: OwnerSetupExportArtifactMeta
}

type OwnerSetupSingleExportFormat = 'pdf' | 'html' | 'markdown'

interface OwnerTenantRemoveResponse {
  ok: boolean
  tenantSlug: string
  source: 'persisted' | 'env' | 'fallback' | 'none'
  removedBroadcasterMapping: boolean
  removedRedeemKey: boolean
  removedSetupEntry: boolean
  removeRedeemKeyRequested: boolean
  totalEntries: number
}

interface OwnerApiErrorPayload {
  error?: string
  message?: string
  missing?: string[]
  user?: OwnerUser
}

class ApiRequestError extends Error {
  readonly status: number
  readonly code: string
  readonly payload: OwnerApiErrorPayload | null

  constructor(status: number, code: string, message: string, payload: OwnerApiErrorPayload | null) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
    this.payload = payload
  }
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

const defaultHostedOwnerApiBase = 'https://public-control.custom-overlays.com'
const ownerButtonGuidePath = '/owner-panel-tenant-mapping-button-order-guide.md'
const defaultHostedOwnerButtonGuideUrl = `https://bingo-owner.custom-overlays.com${ownerButtonGuidePath}`
const deprecatedOwnerApiOrigins = new Set(['https://api.custom-overlays.com'])
const hostedOwnerFallbackHosts = new Set([
  'bingo-owner.custom-overlays.com',
  'public-bingo-owner.web.app',
  'public-bingo-owner.firebaseapp.com',
  'stream-bingo-owner.web.app',
  'stream-bingo-owner.firebaseapp.com',
])

function resolveOwnerApiBase(input: string): { apiBase: string; legacyApiBaseDetected: boolean } {
  const trimmed = trimTrailingSlashes(input.trim())
  if (!trimmed) {
    return { apiBase: trimmed, legacyApiBaseDetected: false }
  }

  try {
    const parsed = new URL(trimmed)
    const origin = parsed.origin.toLowerCase()
    if (deprecatedOwnerApiOrigins.has(origin)) {
      return { apiBase: defaultHostedOwnerApiBase, legacyApiBaseDetected: true }
    }
  } catch {
    // Keep raw input if it is not a fully-qualified URL.
  }

  return { apiBase: trimmed, legacyApiBaseDetected: false }
}

function resolveHostedOwnerApiFallback(hostname: string): string | null {
  const normalized = hostname.trim().toLowerCase()
  if (!normalized || normalized === 'localhost' || normalized === '127.0.0.1') {
    return null
  }

  return hostedOwnerFallbackHosts.has(normalized) ? defaultHostedOwnerApiBase : null
}

function resolveOwnerContext() {
  const params = new URLSearchParams(window.location.search)
  const queryApi = params.get('api')?.trim()
  const authErrorHint = params.get('ownerAuthError')?.trim() ?? ''
  const envApi = import.meta.env.VITE_API_BASE_URL?.trim()
  const explicitApiBase = queryApi || envApi || ''
  const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  const hostedFallbackApiBase = resolveHostedOwnerApiFallback(window.location.hostname)
  const rawApiBase = explicitApiBase || hostedFallbackApiBase || (isLocalHost ? defaultHostedOwnerApiBase : window.location.origin)
  const { apiBase, legacyApiBaseDetected } = resolveOwnerApiBase(rawApiBase)
  const likelyMissingApiBase = !explicitApiBase && !isLocalHost && !hostedFallbackApiBase

  return {
    apiBase,
    authErrorHint,
    likelyMissingApiBase,
    legacyApiBaseDetected,
  }
}

function buildApiUrl(apiBase: string, endpoint: string): string {
  const suffix = endpoint.startsWith('/') ? endpoint : `/${endpoint}`
  return `${apiBase}/api${suffix}`
}

function parseApiErrorPayload(value: unknown): OwnerApiErrorPayload | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Record<string, unknown>
  const payload: OwnerApiErrorPayload = {}

  if (typeof candidate.error === 'string') {
    payload.error = candidate.error
  }

  if (typeof candidate.message === 'string') {
    payload.message = candidate.message
  }

  if (Array.isArray(candidate.missing)) {
    payload.missing = candidate.missing.filter((entry): entry is string => typeof entry === 'string')
  }

  if (candidate.user && typeof candidate.user === 'object') {
    const user = candidate.user as Record<string, unknown>
    if (typeof user.userId === 'string' && typeof user.userLogin === 'string' && typeof user.userName === 'string') {
      payload.user = {
        userId: user.userId,
        userLogin: user.userLogin,
        userName: user.userName,
      }
    }
  }

  return payload
}

function parseErrorInfo(status: number, payload: unknown, fallbackText: string): { code: string; message: string } {
  const normalizedPayload = parseApiErrorPayload(payload)
  const code = normalizedPayload?.error ?? `http_${status}`
  const message = normalizedPayload?.message ?? normalizedPayload?.error ?? fallbackText
  return { code, message }
}

function buildOwnerApiHintMessage(): string {
  return 'Open this panel with ?api=https://public-control.custom-overlays.com (or set VITE_API_BASE_URL) so requests reach the controller API.'
}

function buildLegacyOwnerApiHintMessage(): string {
  return 'Detected deprecated API host api.custom-overlays.com in this URL and switched to public-control.custom-overlays.com automatically.'
}

function buildOwnerReturnToUrl(apiBase: string): string {
  const url = new URL(window.location.href)
  url.searchParams.set('api', apiBase)
  url.searchParams.delete('ownerAuthError')
  url.searchParams.delete('modAuthError')
  url.searchParams.delete('token')
  url.searchParams.delete('state')
  url.searchParams.delete('code')
  url.searchParams.delete('error')
  return url.toString()
}

function parseAttachmentFilename(contentDisposition: string | null): string | null {
  const raw = String(contentDisposition ?? '').trim()
  if (!raw) {
    return null
  }

  const utf8Match = raw.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim())
    } catch {
      return utf8Match[1].trim()
    }
  }

  const fileNameMatch = raw.match(/filename="?([^";]+)"?/i)
  if (!fileNameMatch?.[1]) {
    return null
  }

  return fileNameMatch[1].trim()
}

function downloadBlobFile(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(objectUrl)
}

function toSingleExportFileName(tenantSlug: string, format: OwnerSetupSingleExportFormat): string {
  const extension = format === 'markdown' ? 'md' : format
  return `MixItUp-Streamer-Setup-Reference-${tenantSlug}.${extension}`
}

async function requestJson<T>(url: string, options?: { method?: string; body?: unknown }): Promise<T> {
  const method = options?.method ?? 'GET'
  const body = options?.body === undefined ? undefined : JSON.stringify(options.body)

  const response = await fetch(url, {
    method,
    credentials: 'include',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body,
  })

  const text = await response.text()
  let payload: unknown = null

  if (text.trim().length > 0) {
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      payload = { message: text }
    }
  }

  if (!response.ok) {
    const fallbackText = text.trim().length > 0 ? text : `Request failed with status ${response.status}.`
    const { code, message } = parseErrorInfo(response.status, payload, fallbackText)
    throw new ApiRequestError(response.status, code, message, parseApiErrorPayload(payload))
  }

  if (payload === null) {
    throw new ApiRequestError(response.status, 'empty_response', `Owner API returned an empty response. ${buildOwnerApiHintMessage()}`, null)
  }

  return payload as T
}

async function requestBlob(url: string, options?: { method?: string; body?: unknown }): Promise<{ blob: Blob; fileName: string | null }> {
  const method = options?.method ?? 'GET'
  const body = options?.body === undefined ? undefined : JSON.stringify(options.body)

  const response = await fetch(url, {
    method,
    credentials: 'include',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body,
  })

  if (!response.ok) {
    const text = await response.text()
    let payload: unknown = null
    if (text.trim().length > 0) {
      try {
        payload = JSON.parse(text) as unknown
      } catch {
        payload = { message: text }
      }
    }

    const fallbackText = text.trim().length > 0 ? text : `Request failed with status ${response.status}.`
    const { code, message } = parseErrorInfo(response.status, payload, fallbackText)
    throw new ApiRequestError(response.status, code, message, parseApiErrorPayload(payload))
  }

  const blob = await response.blob()
  const fileName = parseAttachmentFilename(response.headers.get('content-disposition'))
  return { blob, fileName }
}

function isOwnerTenantsResponse(value: unknown): value is OwnerTenantsResponse {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Record<string, unknown>
  return Array.isArray(candidate.tenants)
}

function formatOwnerAuthHint(code: string): string {
  if (!code) {
    return ''
  }

  if (code === 'owner_not_allowed') {
    return 'This Twitch account is authenticated but not allowlisted for owner management.'
  }

  if (code === 'invalid_oauth_callback' || code === 'invalid_oauth_state') {
    return 'Owner sign-in could not be completed. Try signing in again.'
  }

  if (code === 'oauth_redirect_mismatch') {
    return 'Owner sign-in used a deprecated callback host. Start again from the owner panel URL.'
  }

  if (code === 'owner_auth_not_configured') {
    return 'Owner auth is not fully configured on the API.'
  }

  return `Owner sign-in returned ${code}.`
}

function formatApiError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401 && error.code === 'owner_auth_required') {
      return 'Sign in with Twitch to access owner management.'
    }

    if (error.status === 403 && error.code === 'owner_not_allowed') {
      return 'This Twitch account is not allowlisted for owner management.'
    }

    if (error.status === 503 && error.code === 'owner_auth_not_configured') {
      const missing = error.payload?.missing ?? []
      if (missing.length > 0) {
        return `Owner auth is not fully configured. Missing: ${missing.join(', ')}`
      }
      return 'Owner auth is not fully configured.'
    }

    if (error.status === 404 && error.code === 'twitch_user_not_found') {
      return 'No Twitch user was found for that login.'
    }

    if (error.status === 404 && error.code === 'tenant_not_found') {
      return 'That tenant slug is not currently registered.'
    }

    if (error.status === 404 && error.code === 'streamer_setup_pdf_missing') {
      return 'No streamer PDF has been generated yet. Regenerate first.'
    }

    if (error.status === 400 && error.code === 'streamer_setup_entries_empty') {
      return 'Save at least one tenant setup block before regenerating streamer exports.'
    }

    if (error.status === 409 && error.code === 'tenant_source_env_managed') {
      return 'That tenant is env-managed and cannot be removed from persisted mappings in this panel.'
    }

    return error.message
  }

  return error instanceof Error ? error.message : 'Request failed.'
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return 'n/a'
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return parsed.toLocaleString()
}

function formatBroadcasterDisplay(tenant: OwnerTenantRecord): { nameLabel: string; idLabel: string } {
  const broadcasterId = (tenant.broadcasterUserId ?? tenant.effectiveBroadcasterId ?? '').trim()
  const broadcasterName = (tenant.broadcasterUserName ?? '').trim()
  const broadcasterLogin = (tenant.broadcasterUserLogin ?? '').trim()

  if (broadcasterName && broadcasterLogin) {
    return {
      nameLabel: `${broadcasterName} (${broadcasterLogin})`,
      idLabel: broadcasterId || 'n/a',
    }
  }

  if (broadcasterName) {
    return {
      nameLabel: broadcasterName,
      idLabel: broadcasterId || 'n/a',
    }
  }

  if (broadcasterLogin) {
    return {
      nameLabel: broadcasterLogin,
      idLabel: broadcasterId || 'n/a',
    }
  }

  if (broadcasterId) {
    return {
      nameLabel: 'Lookup unavailable',
      idLabel: broadcasterId,
    }
  }

  return {
    nameLabel: 'No broadcaster mapped',
    idLabel: 'n/a',
  }
}

function App() {
  const { apiBase, authErrorHint, likelyMissingApiBase, legacyApiBaseDetected } = useMemo(resolveOwnerContext, [])
  const [authGateState, setAuthGateState] = useState<OwnerGateState>('checking')
  const [authStatus, setAuthStatus] = useState<OwnerAuthStatusResponse | null>(null)
  const [tenants, setTenants] = useState<OwnerTenantRecord[]>([])
  const [defaultTenantSlug, setDefaultTenantSlug] = useState('')
  const [legacyFallbackEnabled, setLegacyFallbackEnabled] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(false)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(() => {
    const authHint = formatOwnerAuthHint(authErrorHint)
    if (authHint) {
      return authHint
    }

    if (legacyApiBaseDetected) {
      return buildLegacyOwnerApiHintMessage()
    }

    return likelyMissingApiBase ? buildOwnerApiHintMessage() : ''
  })
  const [upsertTenantSlug, setUpsertTenantSlug] = useState('')
  const [upsertBroadcasterId, setUpsertBroadcasterId] = useState('')
  const [resolveLogin, setResolveLogin] = useState('')
  const [resolvedUser, setResolvedUser] = useState<OwnerUser | null>(null)
  const [lastRotatedKey, setLastRotatedKey] = useState<OwnerRotateRedeemKeyResponse | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [selectedSetupTenantSlug, setSelectedSetupTenantSlug] = useState('')
  const [selectedSetupExportFormat, setSelectedSetupExportFormat] = useState<OwnerSetupSingleExportFormat>('pdf')
  const [setupBlockPreview, setSetupBlockPreview] = useState('')
  const [setupBlockGeneratedAt, setSetupBlockGeneratedAt] = useState<string | null>(null)
  const [setupBlockSavedAt, setSetupBlockSavedAt] = useState<string | null>(null)
  const [setupEntryCount, setSetupEntryCount] = useState<number | null>(null)
  const [setupExportStatus, setSetupExportStatus] = useState<OwnerSetupRegenerateResponse | null>(null)

  const authUserLabel = authStatus?.user ? `${authStatus.user.userName} (${authStatus.user.userLogin})` : null
  const sortedTenants = useMemo(
    () => [...tenants].sort((left, right) => left.tenantSlug.localeCompare(right.tenantSlug)),
    [tenants],
  )
  const ownerButtonGuideUrl = useMemo(() => {
    const host = window.location.hostname.trim().toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1') {
      return defaultHostedOwnerButtonGuideUrl
    }

    return `${window.location.origin}${ownerButtonGuidePath}`
  }, [])

  const beginOwnerSignIn = () => {
    const startUrl = new URL(buildApiUrl(apiBase, '/owner/auth/twitch/start'))
    startUrl.searchParams.set('returnTo', buildOwnerReturnToUrl(apiBase))
    window.location.assign(startUrl.toString())
  }

  const openOwnerButtonGuide = () => {
    window.open(ownerButtonGuideUrl, '_blank', 'noopener')
  }

  const applyAuthFailure = (caught: unknown) => {
    if (!(caught instanceof ApiRequestError)) {
      setAuthStatus(null)
      setAuthGateState('signed_out')
      setError(formatApiError(caught))
      return
    }

    const nextStatus: OwnerAuthStatusResponse = {
      error: caught.code,
      authenticated: caught.status === 403,
      authorized: false,
      user: caught.payload?.user ?? null,
      missing: caught.payload?.missing ?? [],
    }
    setAuthStatus(nextStatus)

    if (caught.status === 401) {
      setAuthGateState('signed_out')
      return
    }

    if (caught.status === 403) {
      setAuthGateState('forbidden')
      setNotice('This Twitch account is signed in but not allowlisted for owner management.')
      return
    }

    if (caught.status === 503) {
      setAuthGateState('not_configured')
      return
    }

    setAuthGateState('signed_out')
    setError(formatApiError(caught))
  }

  const loadTenants = async () => {
    const response = await requestJson<unknown>(buildApiUrl(apiBase, '/owner/tenants'))
    if (!isOwnerTenantsResponse(response)) {
      throw new Error(`Owner tenants response was invalid. ${buildOwnerApiHintMessage()}`)
    }

    setTenants(response.tenants)
    setDefaultTenantSlug(typeof response.defaultTenantSlug === 'string' ? response.defaultTenantSlug : '')
    setLegacyFallbackEnabled(
      typeof response.legacyInternalRedeemSecretEnabled === 'boolean' ? response.legacyInternalRedeemSecretEnabled : null,
    )
    setSetupEntryCount(typeof response.setupEntryCount === 'number' ? response.setupEntryCount : null)

    const sortedTenantSlugs = [...response.tenants]
      .map((tenant) => tenant.tenantSlug)
      .sort((left, right) => left.localeCompare(right))
    const defaultCandidate = typeof response.defaultTenantSlug === 'string' ? response.defaultTenantSlug : ''

    setSelectedSetupTenantSlug((current) => {
      const currentSlug = current.trim().toLowerCase()
      if (currentSlug && sortedTenantSlugs.includes(currentSlug)) {
        return currentSlug
      }

      if (defaultCandidate && sortedTenantSlugs.includes(defaultCandidate)) {
        return defaultCandidate
      }

      return sortedTenantSlugs[0] ?? ''
    })
  }

  const refreshAuthAndTenants = async () => {
    setLoading(true)
    setError('')

    try {
      const status = await requestJson<OwnerAuthStatusResponse>(buildApiUrl(apiBase, '/owner/auth/me'))
      setAuthStatus(status)
      setAuthGateState('authorized')
      await loadTenants()
    } catch (caught) {
      setTenants([])
      applyAuthFailure(caught)
    } finally {
      setLoading(false)
    }
  }

  const submitOwnerSignOut = async () => {
    setPendingAction('sign-out')
    setError('')
    setMessage('')
    setResolvedUser(null)
    setLastRotatedKey(null)
    setSetupBlockPreview('')
    setSetupBlockGeneratedAt(null)
    setSetupBlockSavedAt(null)
    setSelectedSetupTenantSlug('')
    setSetupEntryCount(null)
    setSetupExportStatus(null)

    try {
      await requestJson<{ ok: boolean }>(buildApiUrl(apiBase, '/owner/auth/logout'), { method: 'POST' })
      setNotice('Owner session was cleared.')
      await refreshAuthAndTenants()
    } catch (caught) {
      setError(formatApiError(caught))
    } finally {
      setPendingAction(null)
    }
  }

  const submitTenantUpsert = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const tenantSlug = upsertTenantSlug.trim().toLowerCase()
    const broadcasterId = upsertBroadcasterId.trim()

    if (!tenantSlug || !broadcasterId) {
      setError('Tenant slug and broadcaster id are required.')
      return
    }

    setPendingAction('upsert')
    setError('')
    setMessage('')

    try {
      const response = await requestJson<OwnerUpsertResponse>(buildApiUrl(apiBase, '/owner/tenants/upsert'), {
        method: 'POST',
        body: {
          tenantSlug,
          broadcasterId,
        },
      })

      setMessage(
        response.updated
          ? `Tenant ${response.tenantSlug} mapped to broadcaster ${response.broadcasterId}.`
          : `Tenant ${response.tenantSlug} mapping is unchanged.`,
      )
      await loadTenants()
    } catch (caught) {
      setError(formatApiError(caught))
    } finally {
      setPendingAction(null)
    }
  }

  const submitResolveUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const login = resolveLogin.trim().replace(/^@/, '')
    if (!login) {
      setError('Twitch login is required.')
      return
    }

    setPendingAction('resolve')
    setError('')
    setMessage('')
    setResolvedUser(null)

    try {
      const response = await requestJson<OwnerResolvedUserResponse>(buildApiUrl(apiBase, '/owner/tenants/resolve-user'), {
        method: 'POST',
        body: { login },
      })

      setResolvedUser(response.user)
      setMessage(`Resolved ${response.user.userName} to Twitch id ${response.user.userId}.`)
    } catch (caught) {
      setError(formatApiError(caught))
    } finally {
      setPendingAction(null)
    }
  }

  const rotateTenantKey = async (tenantSlug: string) => {
    const shouldRotate = window.confirm(
      `Rotate the redeem key for ${tenantSlug}? Existing MixItUp commands using the old key will stop working until updated.`,
    )
    if (!shouldRotate) {
      return
    }

    setPendingAction(`rotate:${tenantSlug}`)
    setError('')
    setMessage('')
    setCopyState('idle')

    try {
      const response = await requestJson<OwnerRotateRedeemKeyResponse>(buildApiUrl(apiBase, '/owner/tenants/redeem-key/rotate'), {
        method: 'POST',
        body: { tenantSlug },
      })

      setLastRotatedKey(response)
      setMessage(`Rotated tenant key for ${response.tenantSlug}. Copy it now and update MixItUp immediately.`)
      await loadTenants()
    } catch (caught) {
      setError(formatApiError(caught))
    } finally {
      setPendingAction(null)
    }
  }

  const resolveSetupTenantSlug = (requestedTenantSlug?: string): string => {
    return (requestedTenantSlug ?? selectedSetupTenantSlug).trim().toLowerCase()
  }

  const generateSetupBlock = async (requestedTenantSlug?: string) => {
    const tenantSlug = resolveSetupTenantSlug(requestedTenantSlug)
    if (!tenantSlug) {
      setError('Select a tenant slug before generating setup blocks.')
      return
    }

    setPendingAction(`setup-generate:${tenantSlug}`)
    setError('')
    setMessage('')
    setNotice('')

    try {
      const response = await requestJson<OwnerSetupGenerateResponse>(buildApiUrl(apiBase, '/owner/setup/generate'), {
        method: 'POST',
        body: { tenantSlug },
      })

      setSelectedSetupTenantSlug(response.tenantSlug)
      setSetupBlockPreview(response.setupBlock)
      setSetupBlockGeneratedAt(response.generatedAt)
      setSetupBlockSavedAt(response.savedAt)
      setSetupEntryCount(response.totalEntries)
      setMessage(`Generated setup block preview for ${response.tenantSlug}.`)
    } catch (caught) {
      setError(formatApiError(caught))
    } finally {
      setPendingAction(null)
    }
  }

  const saveSetupEntry = async (requestedTenantSlug?: string) => {
    const tenantSlug = resolveSetupTenantSlug(requestedTenantSlug)
    if (!tenantSlug) {
      setError('Select a tenant slug before saving setup instructions.')
      return
    }

    setPendingAction(`setup-save:${tenantSlug}`)
    setError('')
    setMessage('')
    setNotice('')

    try {
      const response = await requestJson<OwnerSetupEntryUpsertResponse>(buildApiUrl(apiBase, '/owner/setup/entries/upsert'), {
        method: 'POST',
        body: { tenantSlug },
      })

      setSelectedSetupTenantSlug(response.tenantSlug)
      setSetupBlockPreview(response.setupBlock)
      setSetupBlockSavedAt(response.savedAt)
      setSetupEntryCount(response.totalEntries)
      if (response.created) {
        setMessage(`Saved ${response.tenantSlug} into the streamer setup export list.`)
      } else if (response.updated) {
        setMessage(`Updated ${response.tenantSlug} in the streamer setup export list.`)
      } else {
        setMessage(`No changes saved for ${response.tenantSlug}; existing setup entry already matches.`)
      }
      await loadTenants()
    } catch (caught) {
      setError(formatApiError(caught))
    } finally {
      setPendingAction(null)
    }
  }

  const regenerateSetupExports = async () => {
    setPendingAction('setup-regenerate')
    setError('')
    setMessage('')
    setNotice('')

    try {
      const response = await requestJson<OwnerSetupRegenerateResponse>(buildApiUrl(apiBase, '/owner/setup/export/regenerate'), {
        method: 'POST',
        body: { includeAllKnownTenants: false },
      })

      setSetupExportStatus(response)
      setSetupEntryCount(response.entryCount)
      if (response.changed === false) {
        setMessage('No export changes detected. Existing Markdown/HTML/PDF files are already up to date.')
      } else {
        setMessage(`Regenerated streamer setup exports for ${response.count} tenant ${response.count === 1 ? 'block' : 'blocks'}.`)
      }
    } catch (caught) {
      setError(formatApiError(caught))
    } finally {
      setPendingAction(null)
    }
  }

  const downloadSingleSetupExport = async () => {
    const tenantSlug = resolveSetupTenantSlug()
    if (!tenantSlug) {
      setError('Select a tenant slug before downloading tenant setup instructions.')
      return
    }

    const format = selectedSetupExportFormat
    setPendingAction(`setup-single-export:${tenantSlug}:${format}`)
    setError('')
    setMessage('')
    setNotice('')

    try {
      const { blob, fileName } = await requestBlob(buildApiUrl(apiBase, '/owner/setup/export/single'), {
        method: 'POST',
        body: {
          tenantSlug,
          format,
        },
      })

      downloadBlobFile(blob, fileName || toSingleExportFileName(tenantSlug, format))
      setMessage(`Downloaded ${format.toUpperCase()} setup instructions for ${tenantSlug}.`)
    } catch (caught) {
      setError(formatApiError(caught))
    } finally {
      setPendingAction(null)
    }
  }

  const openSetupExportDownload = (downloadUrl: string) => {
    const trimmed = downloadUrl.trim()
    if (!trimmed) {
      return
    }

    const absoluteUrl = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `${apiBase}${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}`
    window.open(absoluteUrl, '_blank', 'noopener')
  }

  const removeTenant = async (tenantSlugInput: string) => {
    const tenantSlug = tenantSlugInput.trim().toLowerCase()
    if (!tenantSlug) {
      return
    }

    const typedSlug = window.prompt(`Type ${tenantSlug} to confirm tenant removal.`, '')
    if ((typedSlug ?? '').trim().toLowerCase() !== tenantSlug) {
      setNotice(`Removal canceled because the confirmation text did not match ${tenantSlug}.`)
      return
    }

    const removeRedeemKey = window.confirm(
      `Also remove the redeem key for ${tenantSlug}?\n\nSelect OK to remove key + mapping, or Cancel to remove mapping only.`,
    )

    setPendingAction(`remove:${tenantSlug}`)
    setError('')
    setMessage('')
    setNotice('')

    try {
      const response = await requestJson<OwnerTenantRemoveResponse>(buildApiUrl(apiBase, '/owner/tenants/remove'), {
        method: 'POST',
        body: {
          tenantSlug,
          removeRedeemKey,
        },
      })

      setSetupEntryCount(response.totalEntries)
      if (selectedSetupTenantSlug === tenantSlug) {
        setSetupBlockPreview('')
        setSetupBlockGeneratedAt(null)
        setSetupBlockSavedAt(null)
      }
      setSetupExportStatus(null)

      setMessage(
        `Removed tenant ${response.tenantSlug}. Mapping removed: ${response.removedBroadcasterMapping ? 'yes' : 'no'}; redeem key removed: ${response.removedRedeemKey ? 'yes' : 'no'}; setup entry removed: ${response.removedSetupEntry ? 'yes' : 'no'}.`,
      )
      await loadTenants()
    } catch (caught) {
      setError(formatApiError(caught))
    } finally {
      setPendingAction(null)
    }
  }

  const copyLatestKey = async () => {
    if (!lastRotatedKey) {
      return
    }

    try {
      await navigator.clipboard.writeText(lastRotatedKey.redeemKey)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  useEffect(() => {
    const url = new URL(window.location.href)
    const queryApi = url.searchParams.get('api')?.trim()
    if (!queryApi) {
      return
    }

    const normalized = resolveOwnerApiBase(queryApi)
    if (!normalized.legacyApiBaseDetected) {
      return
    }

    url.searchParams.set('api', normalized.apiBase)
    window.history.replaceState({}, document.title, url.toString())
  }, [])

  useEffect(() => {
    void refreshAuthAndTenants()
    // Intentionally run once per resolved apiBase.
  }, [apiBase])

  const busy = loading || pendingAction !== null

  if (authGateState !== 'authorized') {
    const gateTitle =
      authGateState === 'checking'
        ? 'Checking Owner Session'
        : authGateState === 'forbidden'
          ? 'Owner Access Denied'
          : authGateState === 'not_configured'
            ? 'Owner API Not Configured'
            : 'Sign In Required'

    const gateDescription =
      authGateState === 'checking'
        ? 'Verifying owner access before loading tenant management actions.'
        : authGateState === 'forbidden'
          ? 'Your Twitch account is signed in but not allowlisted for owner management.'
          : authGateState === 'not_configured'
            ? 'Owner auth is missing required server configuration.'
            : 'Sign in with Twitch to access tenant mappings and key management.'

    return (
      <main className="owner">
        <header className="owner-header">
          <p className="owner-badge">Bingo Owner</p>
          <h1>Tenant Management Panel</h1>
          <p className="owner-subtitle">Private owner controls for tenant mappings and redeem key lifecycle.</p>
        </header>

        {notice && (
          <section className="owner-warning" role="status" aria-live="polite">
            {notice}
          </section>
        )}
        {error && (
          <section className="owner-error" role="alert">
            {error}
          </section>
        )}

        <section className="owner-panel wide">
          <h2>{gateTitle}</h2>
          <p>{gateDescription}</p>
          {authUserLabel && (
            <p className="owner-muted">
              Signed in as <strong>{authUserLabel}</strong>
            </p>
          )}
          {authStatus?.missing && authStatus.missing.length > 0 && (
            <p className="owner-muted">Missing config: {authStatus.missing.join(', ')}</p>
          )}

          <div className="owner-actions">
            <button type="button" onClick={beginOwnerSignIn} disabled={busy}>
              Sign In With Twitch
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                void refreshAuthAndTenants()
              }}
            >
              Recheck Access
            </button>
            <button type="button" className="secondary" onClick={openOwnerButtonGuide}>
              Open Button Guide
            </button>
            {authStatus?.authenticated && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  void submitOwnerSignOut()
                }}
              >
                Sign Out
              </button>
            )}
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="owner">
      <header className="owner-header">
        <p className="owner-badge">Bingo Owner</p>
        <h1>Tenant Management Panel</h1>
        <p className="owner-subtitle">Keep tenant mappings and redeem keys owner-controlled without exposing internal secrets.</p>

        <div className="owner-header-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              void refreshAuthAndTenants()
            }}
          >
            Refresh
          </button>
          <button type="button" className="secondary" onClick={openOwnerButtonGuide}>
            Open Button Guide
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              void submitOwnerSignOut()
            }}
          >
            Sign Out
          </button>
        </div>

        {authUserLabel && (
          <p className="owner-muted">
            Signed in as <strong>{authUserLabel}</strong>
            {authStatus?.tokenSource ? ` via ${authStatus.tokenSource} session.` : ''}
          </p>
        )}
      </header>

      {notice && (
        <section className="owner-warning" role="status" aria-live="polite">
          {notice}
        </section>
      )}
      {error && (
        <section className="owner-error" role="alert">
          {error}
        </section>
      )}
      {message && (
        <section className="owner-message" role="status" aria-live="polite">
          {message}
        </section>
      )}

      <section className="owner-grid">
        <article className="owner-panel">
          <div className="owner-overview-header">
            <h2>Tenant Overview</h2>
            <p className="owner-muted owner-overview-count">
              {sortedTenants.length} {sortedTenants.length === 1 ? 'tenant' : 'tenants'}
            </p>
          </div>
          <div className="owner-overview-meta">
            <p>
              Default tenant: <strong>{defaultTenantSlug || 'n/a'}</strong>
            </p>
            <p>
              Legacy fallback:{' '}
              <strong>{legacyFallbackEnabled === null ? 'unknown' : legacyFallbackEnabled ? 'enabled' : 'disabled'}</strong>
            </p>
          </div>

          <div className="owner-table-wrap">
            <table className="owner-table">
              <thead>
                <tr>
                  <th scope="col">Tenant</th>
                  <th scope="col">Source</th>
                  <th scope="col">Broadcaster</th>
                  <th scope="col">Effective Broadcaster</th>
                  <th scope="col">Redeem Key</th>
                  <th scope="col">Rotated</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedTenants.map((tenant) => {
                  const rotatingThisTenant = pendingAction === `rotate:${tenant.tenantSlug}`
                  const generatingThisTenant = pendingAction === `setup-generate:${tenant.tenantSlug}`
                  const removingThisTenant = pendingAction === `remove:${tenant.tenantSlug}`
                  const broadcaster = formatBroadcasterDisplay(tenant)
                  return (
                    <tr key={tenant.tenantSlug}>
                      <td>
                        <strong>{tenant.tenantSlug}</strong>
                      </td>
                      <td>{tenant.source}</td>
                      <td>
                        <div className="owner-broadcaster">
                          <div className="owner-broadcaster-name">{broadcaster.nameLabel}</div>
                          <div className="owner-broadcaster-id">ID: {broadcaster.idLabel}</div>
                        </div>
                      </td>
                      <td>{tenant.effectiveBroadcasterId ?? 'n/a'}</td>
                      <td>
                        <span className={`owner-chip${tenant.redeemKeyConfigured ? ' ok' : ''}`}>
                          {tenant.redeemKeyConfigured ? 'configured' : 'missing'}
                        </span>
                      </td>
                      <td>{formatTimestamp(tenant.redeemKeyRotatedAt)}</td>
                      <td>
                        <div className="owner-row-actions">
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() => {
                              void generateSetupBlock(tenant.tenantSlug)
                            }}
                          >
                            {generatingThisTenant ? 'Generating...' : 'Generate Setup'}
                          </button>
                          <button
                            type="button"
                            className="warning"
                            disabled={busy}
                            onClick={() => {
                              void rotateTenantKey(tenant.tenantSlug)
                            }}
                          >
                            {rotatingThisTenant ? 'Rotating...' : 'Rotate Key'}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() => {
                              void removeTenant(tenant.tenantSlug)
                            }}
                          >
                            {removingThisTenant ? 'Removing...' : 'Remove Tenant'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </article>

        <div className="owner-lower-grid">
          <article className="owner-panel">
            <h3>Management Tools</h3>
            <p className="owner-muted">Update tenant mappings and resolve Twitch IDs from one place.</p>

            <div className="owner-tool-sections">
              <section className="owner-tool-card">
                <h4>Upsert Tenant Mapping</h4>
                <form className="owner-form-grid" onSubmit={submitTenantUpsert}>
                  <label>
                    Tenant Slug
                    <input
                      value={upsertTenantSlug}
                      onChange={(event) => setUpsertTenantSlug(event.target.value)}
                      placeholder="livebingo-01"
                      required
                    />
                  </label>

                  <label>
                    Broadcaster ID
                    <input
                      value={upsertBroadcasterId}
                      onChange={(event) => setUpsertBroadcasterId(event.target.value)}
                      placeholder="123456789"
                      required
                    />
                  </label>

                  <div className="owner-actions">
                    <button type="submit" disabled={busy}>
                      Save Mapping
                    </button>
                  </div>
                </form>
              </section>

              <section className="owner-tool-card">
                <h4>Resolve Twitch Login</h4>
                <form className="owner-form-grid" onSubmit={submitResolveUser}>
                  <label>
                    Twitch Login
                    <input
                      value={resolveLogin}
                      onChange={(event) => setResolveLogin(event.target.value)}
                      placeholder="killingmist"
                      required
                    />
                  </label>

                  <div className="owner-actions">
                    <button type="submit" disabled={busy}>
                      Resolve User
                    </button>
                  </div>
                </form>

                {resolvedUser && (
                  <div className="owner-info-card">
                    <strong>{resolvedUser.userName}</strong>
                    <div>login: {resolvedUser.userLogin}</div>
                    <div>id: {resolvedUser.userId}</div>
                  </div>
                )}
              </section>
            </div>
          </article>

          <article className="owner-panel owner-key-panel">
            <h3>Latest Rotated Redeem Key</h3>
            <p className="owner-muted">
              Keys are shown once per rotation. Store them immediately in secure notes and update MixItUp for the matching tenant.
            </p>

            {!lastRotatedKey && <p className="owner-muted">No key has been rotated in this session.</p>}

            {lastRotatedKey && (
              <>
                <p>
                  Tenant: <strong>{lastRotatedKey.tenantSlug}</strong> | Rotated: <strong>{formatTimestamp(lastRotatedKey.rotatedAt)}</strong>
                </p>
                <div className="owner-key">{lastRotatedKey.redeemKey}</div>
                <div className="owner-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      void copyLatestKey()
                    }}
                  >
                    Copy Key
                  </button>
                </div>
                {copyState === 'copied' && <p className="owner-muted">Key copied to clipboard.</p>}
                {copyState === 'failed' && (
                  <p className="owner-inline-error">Clipboard copy failed. Copy manually and store securely.</p>
                )}
              </>
            )}
          </article>
        </div>

        <article className="owner-panel">
          <h3>Setup Export</h3>
          <p className="owner-muted">
            Download one tenant setup at a time, then use master list actions only when maintaining shared exports.
          </p>

          <div className="owner-tool-sections owner-setup-sections">
            <section className="owner-tool-card owner-setup-primary">
              <h4>Single-Tenant Download</h4>
              <div className="owner-form-grid">
                <label>
                  Tenant Slug
                  <select
                    value={selectedSetupTenantSlug}
                    onChange={(event) => {
                      setSelectedSetupTenantSlug(event.target.value)
                    }}
                    disabled={busy || sortedTenants.length === 0}
                  >
                    {sortedTenants.length === 0 && <option value="">No tenants available</option>}
                    {sortedTenants.map((tenant) => (
                      <option key={tenant.tenantSlug} value={tenant.tenantSlug}>
                        {tenant.tenantSlug}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Format
                  <select
                    value={selectedSetupExportFormat}
                    onChange={(event) => {
                      setSelectedSetupExportFormat(event.target.value as OwnerSetupSingleExportFormat)
                    }}
                    disabled={busy}
                  >
                    <option value="pdf">PDF</option>
                    <option value="html">HTML</option>
                    <option value="markdown">Markdown</option>
                  </select>
                </label>

                <div className="owner-actions">
                  <button
                    type="button"
                    disabled={busy || !selectedSetupTenantSlug}
                    onClick={() => {
                      void downloadSingleSetupExport()
                    }}
                  >
                    {pendingAction?.startsWith('setup-single-export:') ? 'Downloading...' : 'Download Tenant Setup'}
                  </button>
                </div>
              </div>

              <p className="owner-muted">Single-tenant downloads are generated on demand and do not rewrite master export files.</p>
            </section>

            <section className="owner-tool-card owner-setup-maintenance">
              <h4>Master List Maintenance</h4>
              <p className="owner-muted">
                Save newly mapped slugs to the streamer list, then regenerate all master artifacts from that saved list.
              </p>

              <div className="owner-form-grid">
                <div className="owner-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || !selectedSetupTenantSlug}
                    onClick={() => {
                      void generateSetupBlock()
                    }}
                  >
                    {pendingAction?.startsWith('setup-generate:') ? 'Generating...' : 'Generate Preview Block'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || !selectedSetupTenantSlug}
                    onClick={() => {
                      void saveSetupEntry()
                    }}
                  >
                    {pendingAction?.startsWith('setup-save:') ? 'Saving...' : 'Save To Streamer List'}
                  </button>
                </div>

                <div className="owner-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      void regenerateSetupExports()
                    }}
                  >
                    {pendingAction === 'setup-regenerate' ? 'Regenerating...' : 'Regenerate Master Exports'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={!setupExportStatus?.pdf.downloadUrl}
                    onClick={() => {
                      if (setupExportStatus?.pdf.downloadUrl) {
                        openSetupExportDownload(setupExportStatus.pdf.downloadUrl)
                      }
                    }}
                  >
                    Download Master PDF
                  </button>
                </div>

                <div className="owner-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={!setupExportStatus?.markdown.downloadUrl}
                    onClick={() => {
                      if (setupExportStatus?.markdown.downloadUrl) {
                        openSetupExportDownload(setupExportStatus.markdown.downloadUrl)
                      }
                    }}
                  >
                    Download Master Markdown
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={!setupExportStatus?.html.downloadUrl}
                    onClick={() => {
                      if (setupExportStatus?.html.downloadUrl) {
                        openSetupExportDownload(setupExportStatus.html.downloadUrl)
                      }
                    }}
                  >
                    Download Master HTML
                  </button>
                </div>
              </div>

              <p className="owner-muted">
                Saved setup entries: <strong>{setupEntryCount ?? 'unknown'}</strong>
              </p>
              <p className="owner-muted">
                Last generated: <strong>{formatTimestamp(setupBlockGeneratedAt)}</strong> | Last saved:{' '}
                <strong>{formatTimestamp(setupBlockSavedAt)}</strong>
              </p>

              {setupExportStatus && (
                <div className="owner-info-card">
                  <p>
                    Export generated: <strong>{formatTimestamp(setupExportStatus.generatedAt)}</strong>
                  </p>
                  <p>
                    Blocks: <strong>{setupExportStatus.count}</strong> | Entries: <strong>{setupExportStatus.entryCount}</strong>
                  </p>
                  <p>
                    PDF size: <strong>{setupExportStatus.pdf.size} bytes</strong>
                  </p>
                </div>
              )}
            </section>

            <section className="owner-tool-card owner-setup-preview">
              <h4>Generated Block Preview</h4>
              {setupBlockPreview ? (
                <pre className="owner-code-block">{setupBlockPreview}</pre>
              ) : (
                <p className="owner-muted">Generate a block to preview copy-and-paste values for MixItUp.</p>
              )}
            </section>
          </div>
        </article>
      </section>
    </main>
  )
}

export default App
