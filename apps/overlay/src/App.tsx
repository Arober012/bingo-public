import { useEffect, useMemo, useState } from 'react'
import './App.css'

type ThemeMode = 'light' | 'dark'
type UiThemeBackgroundStyle = 'full-gradient'

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
  players?: number
  winners?: string[]
  calledOptions?: string[]
  theme?: ResolvedTheme
}

interface OptionsResponse {
  count: number
  options: string[]
}

interface CardCell {
  value: string
  free: boolean
}

interface PlayerCard {
  userId: string
  userName: string
  stamps: number[]
  card: {
    cells: CardCell[]
  }
}

interface OverlayWinnerCardResponse {
  ok: boolean
  player: PlayerCard | null
  players?: PlayerCard[]
}

interface MasterBoardCell {
  label: string
  called: boolean
}

const pollIntervalMs = 4000
const winnerRotationIntervalMs = 10000
const tenantSlugPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const skinIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const supportedUiThemeBackgroundStyles = new Set<UiThemeBackgroundStyle>(['full-gradient'])
const canonicalOverlayApiBase = 'https://public-control.custom-overlays.com'
const hostedOverlayFallbackHosts = new Set([
  'public-overlay.custom-overlays.com',
  'bingo.custom-overlays.com',
  'public-bingo-overlay.web.app',
  'public-bingo-overlay.firebaseapp.com',
  'stream-bingo-public-overlay.web.app',
  'stream-bingo-public-overlay.firebaseapp.com',
])

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
      cache: 'no-store',
      credentials: 'same-origin',
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

function resolveHostedOverlayApiFallback(hostname: string): string | null {
  const normalized = hostname.trim().toLowerCase()
  if (!normalized || normalized === 'localhost' || normalized === '127.0.0.1') {
    return null
  }

  return hostedOverlayFallbackHosts.has(normalized) ? canonicalOverlayApiBase : null
}

function resolveOverlayContext(): { apiBase: string; tenantSlug: string | null } {
  const params = new URLSearchParams(window.location.search)
  const queryApi = params.get('api')?.trim()
  const envApi = import.meta.env.VITE_API_BASE_URL?.trim()
  const hostedFallbackApiBase = resolveHostedOverlayApiFallback(window.location.hostname)
  const rawBase = queryApi || envApi || hostedFallbackApiBase || window.location.origin
  const tenantSlug = resolveTenantSlug(window.location.pathname, params)

  return {
    apiBase: rawBase.replace(/\/+$/, ''),
    tenantSlug,
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  const text = await response.text()

  let payload: Record<string, unknown> | null = null
  if (text) {
    if (contentType.includes('application/json')) {
      try {
        payload = JSON.parse(text) as Record<string, unknown>
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
    const message =
      (payload?.error as string | undefined) ??
      (payload?.message as string | undefined) ??
      `${response.status} ${response.statusText}`
    throw new Error(message)
  }

  return payload as T
}

function App() {
  const { apiBase, tenantSlug } = useMemo(() => resolveOverlayContext(), [])
  const [session, setSession] = useState<SessionSummary | null>(null)
  const [options, setOptions] = useState<string[]>([])
  const [winnerCards, setWinnerCards] = useState<PlayerCard[]>([])
  const [activeWinnerIndex, setActiveWinnerIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uiBackgroundStyle, setUiBackgroundStyle] = useState<UiThemeBackgroundStyle | null>(null)

  useEffect(() => {
    let active = true

    async function refresh() {
      try {
        const [sessionData, optionsData, winnerData] = await Promise.all([
          fetchJson<SessionSummary>(buildApiUrl(apiBase, tenantSlug, '/session')),
          fetchJson<OptionsResponse>(buildApiUrl(apiBase, tenantSlug, '/options')),
          fetchJson<OverlayWinnerCardResponse>(buildApiUrl(apiBase, tenantSlug, '/overlay/winner-card')),
        ])

        if (!active) {
          return
        }

        setSession(sessionData)
        setOptions(optionsData.options)
        const orderedWinners = Array.isArray(winnerData.players)
          ? winnerData.players
          : winnerData.player
            ? [winnerData.player]
            : []
        setWinnerCards(orderedWinners)

        setError(null)
      } catch (nextError) {
        if (!active) {
          return
        }

        setError(nextError instanceof Error ? nextError.message : 'Failed to fetch overlay data.')
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, pollIntervalMs)

    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [apiBase, tenantSlug])

  useEffect(() => {
    applyResolvedTheme(session?.theme)
  }, [session?.theme])

  const activeSkinId = useMemo(() => normalizeThemeSkinId(session?.theme?.skinId ?? ''), [session?.theme?.skinId])

  useEffect(() => {
    let active = true

    if (!activeSkinId) {
      setUiBackgroundStyle(null)
      return () => {
        active = false
      }
    }

    void (async () => {
      const nextBackgroundStyle = await fetchSkinUiThemeBackgroundStyle(activeSkinId)
      if (!active) {
        return
      }

      setUiBackgroundStyle(nextBackgroundStyle)
    })()

    return () => {
      active = false
    }
  }, [activeSkinId])

  useEffect(() => {
    setActiveWinnerIndex(0)
  }, [session?.id])

  const winnerOrderKey = useMemo(() => winnerCards.map((entry) => entry.userId).join('|'), [winnerCards])

  useEffect(() => {
    setActiveWinnerIndex((current) => {
      if (winnerCards.length === 0) {
        return 0
      }

      if (current >= winnerCards.length) {
        return 0
      }

      return current
    })
  }, [winnerCards.length, winnerOrderKey])

  useEffect(() => {
    if (session?.status === 'ended' || winnerCards.length <= 1) {
      return
    }

    const timer = window.setInterval(() => {
      setActiveWinnerIndex((current) => (current + 1) % winnerCards.length)
    }, winnerRotationIntervalMs)

    return () => {
      window.clearInterval(timer)
    }
  }, [session?.status, winnerCards.length, winnerOrderKey])

  const activeWinnerCard = useMemo(() => {
    if (winnerCards.length === 0) {
      return null
    }

    return winnerCards[activeWinnerIndex] ?? winnerCards[0]
  }, [activeWinnerIndex, winnerCards])

  const calledSet = useMemo(() => new Set(session?.calledOptions ?? []), [session?.calledOptions])
  const overlayOptions = useMemo(() => {
    if (options.length > 0) {
      return options
    }

    return session?.calledOptions ?? []
  }, [options, session?.calledOptions])

  const masterBoardCells = useMemo<MasterBoardCell[]>(() => {
    const uniqueOptions = [...new Set(overlayOptions.map((value) => value.trim()).filter(Boolean))]
    return uniqueOptions.map((label) => ({
      label,
      called: calledSet.has(label),
    }))
  }, [calledSet, overlayOptions])

  const winnerStampSet = useMemo(() => new Set<number>(activeWinnerCard?.stamps ?? []), [activeWinnerCard?.stamps])
  const overlayClassName = uiBackgroundStyle === 'full-gradient' ? 'overlay ui-background-full-gradient' : 'overlay'

  return (
    <main className={overlayClassName}>
      <header className="overlay-header">
        <p className="overlay-badge">Bingo Overlay Live</p>
        <h1>Live Stream Bingo</h1>
        <p className="overlay-subtitle">
          Master board shows every option in the active round. Winning cards take priority when winners are detected.
        </p>
      </header>

      {loading && <section className="overlay-note">Loading session state...</section>}

      {error && (
        <section className="overlay-error" role="alert">
          Overlay error: {error}
        </section>
      )}

      {activeWinnerCard ? (
        <section className="card-shell" aria-label="Winning bingo card">
          <p className="overlay-note">
            Winner: {activeWinnerCard.userName}
            {winnerCards.length > 1 ? ` (${activeWinnerIndex + 1}/${winnerCards.length})` : ''}
          </p>
          <div className="card-grid">
            {activeWinnerCard.card.cells.map((cell, index) => {
              const stamped = cell.free || winnerStampSet.has(index)

              return (
                <article
                  key={`${activeWinnerCard.userId}-${index}`}
                  className={`card-cell${stamped ? ' stamped' : ''}${cell.free ? ' free' : ''}`}
                >
                  <span className="cell-label">{cell.value}</span>
                  <span className="cell-status">{stamped ? 'Stamped' : 'Pending'}</span>
                </article>
              )
            })}
          </div>
        </section>
      ) : (
        <section className="card-shell" aria-label="Master called options board">
          <p className="overlay-note">Master options: {masterBoardCells.length}</p>
          <div className="card-grid">
            {masterBoardCells.map((cell, index) => {
              const statusLabel = cell.called ? 'Called' : 'Waiting'

              return (
                <article key={`master-cell-${index}`} className={`card-cell${cell.called ? ' stamped' : ''}`}>
                  <span className="cell-label">{cell.label}</span>
                  <span className="cell-status">{statusLabel}</span>
                </article>
              )
            })}
          </div>
        </section>
      )}

      <footer className="overlay-footer">
        Mode: {session?.mode ?? 'n/a'} | Status: {session?.status ?? 'idle'} | Players: {session?.players ?? 0} |
        Called: {session?.calledOptions?.length ?? 0} | Winners: {session?.winners?.length ?? 0}
      </footer>
    </main>
  )
}

export default App
