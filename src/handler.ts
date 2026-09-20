import { analyze, PERIOD_DAYS, WINDOW_DAYS, type Analysis, type PeriodDays } from "./analyze.ts"
import { Client, GitHubError, Semaphore, upstream } from "./github.ts"

export const FRESH_FOR = 60 * 60
export const STALE_OK_FOR = 24 * 60 * 60
const ANALYSIS_TIMEOUT = 90_000
const QUEUE_WAIT = 20_000

export type Cached = { at: number; value: Analysis }

/** Where finished analyses live: Cache API on Workers, a Map locally. */
export interface Store {
  get(login: string): Promise<Cached | undefined>
  set(login: string, cached: Cached): Promise<void>
}

export type Options = {
  gh?: Client
  provider?: "github" | "gitlab"
  analyze?: (login: string, days: PeriodDays) => Promise<Analysis>
  store: Store
  html: string
  publicOnly: boolean
  maxPages: number
  maxAnalyses?: number
  /** Local analyses stay in MemoryStore, never in browser/shared HTTP caches. */
  browserCache?: boolean
  /** Return false to refuse a fresh (uncached) analysis for this request. */
  allowFresh?: (req: Request) => Promise<boolean>
}

export class MemoryStore implements Store {
  private map = new Map<string, Cached>()
  constructor(private max = 20_000) {}
  async get(login: string) {
    const hit = this.map.get(login)
    if (hit && Date.now() / 1000 - hit.at > STALE_OK_FOR) this.map.delete(login)
    return this.map.get(login)
  }
  async set(login: string, cached: Cached) {
    if (this.map.size >= this.max) {
      for (const [k, v] of this.map) if (Date.now() / 1000 - v.at > FRESH_FOR) this.map.delete(k)
      if (this.map.size >= this.max) this.map.clear()
    }
    this.map.set(login, cached)
  }
  get size() {
    return this.map.size
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } })

function errorResponse(e: unknown) {
  const err = e instanceof GitHubError ? e : upstream(e instanceof Error ? e.message : String(e))
  const status = { rate_limited: 429, not_found: 404, busy: 503, timeout: 504, upstream: 502 }[err.code]
  return json(
    { error: err.message, code: err.code, retryAfter: err.retryAfter ?? null },
    status,
    { "cache-control": "no-store", ...(err.retryAfter ? { "retry-after": String(err.retryAfter) } : {}) },
  )
}

function okResponse(cached: Cached, stale: boolean, browserCache: boolean) {
  // Fresh answers are safe for a CDN to hold: a viral username should cost GitHub quota once.
  return json({ ...cached.value, cachedAt: cached.at, stale }, 200, {
    "cache-control": !browserCache ? "no-store" : stale ? "public, max-age=60" : "public, max-age=600, stale-while-revalidate=3600",
  })
}

export function createHandler(opts: Options) {
  const browserCache = opts.publicOnly && (opts.browserCache ?? true)
  const analyses = new Semaphore(opts.maxAnalyses ?? 8)
  const inflight = new Map<string, Promise<Cached>>()

  // A username/period pair shares work and cached results, never a different period.
  const run = (login: string, days: PeriodDays, key: string) => {
    const existing = inflight.get(key)
    if (existing) return existing
    const p = (async () => {
      const release = await analyses.acquire(QUEUE_WAIT)
      try {
        let timer: ReturnType<typeof setTimeout> | undefined
        const work = opts.analyze ? opts.analyze(login, days) : analyze(opts.gh!.session(), login, { publicOnly: opts.publicOnly, maxPages: opts.maxPages, days })
        const value = await Promise.race([
          work,
          new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new GitHubError("timeout", "Analysis took too long. Try again.", 30)), ANALYSIS_TIMEOUT))),
        ]).finally(() => clearTimeout(timer))
        const cached = { at: Math.floor(Date.now() / 1000), value }
        await opts.store.set(key, cached)
        return cached
      } finally {
        release()
        inflight.delete(key)
      }
    })()
    inflight.set(key, p)
    return p
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 })

    if (url.pathname === "/") {
      return new Response(opts.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": browserCache ? "public, max-age=300" : "no-store" } })
    }
    if (url.pathname === "/healthz") {
      return json({ ok: true, tokens: opts.gh?.tokenCount ?? 1, provider: opts.provider ?? "github", publicOnly: opts.publicOnly, inflight: inflight.size, freeSlots: analyses.free }, 200, { "cache-control": "no-store" })
    }
    const m = url.pathname.match(/^\/api\/([^/]+)$/)
    if (!m) return new Response("not found", { status: 404 })

    let login: string
    try { login = decodeURIComponent(m[1]).trim().replace(/^@/, "").toLowerCase() }
    catch { return json({ error: "Invalid username encoding", code: "bad_login" }, 400) }
    const valid = opts.provider === "gitlab" ? /^[a-z0-9_][a-z0-9_.-]{0,254}$/ : /^[a-z0-9-]{1,39}$/
    if (!valid.test(login)) return json({ error: `that's not a ${opts.provider === "gitlab" ? "GitLab" : "GitHub"} username`, code: "bad_login" }, 400)

    const rawDays = url.searchParams.get("days") ?? String(WINDOW_DAYS)
    if (url.searchParams.getAll("days").length > 1 || !PERIOD_DAYS.some((d) => String(d) === rawDays)) {
      return json({ error: "Choose a period of 7, 30, 90 or 365 days", code: "bad_period" }, 400, { "cache-control": "no-store" })
    }
    const days = Number(rawDays) as PeriodDays
    const key = `periods/${days}/${login}`
    const hit = await opts.store.get(key)
    const age = hit ? Date.now() / 1000 - hit.at : Infinity
    if (hit && age <= FRESH_FOR) return okResponse(hit, false, browserCache)

    // Joining an analysis someone else already started is free; only new work counts against the caller.
    if (!inflight.has(key) && opts.allowFresh && !(await opts.allowFresh(req))) {
      return errorResponse(new GitHubError("rate_limited", "Slow down a little. Try again in a minute, or run it locally.", 60))
    }

    try {
      return okResponse(await run(login, days, key), false, browserCache)
    } catch (e) {
      // GitHub is unhappy but we remember an older answer: better than an error page.
      if (hit && age <= STALE_OK_FOR && !(e instanceof GitHubError && e.code === "not_found")) return okResponse(hit, true, browserCache)
      if (!(e instanceof GitHubError)) console.error(e)
      return errorResponse(e)
    }
  }
}
