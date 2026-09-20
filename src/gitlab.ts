import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { GitHubError, Semaphore } from "./github.ts"
import { WINDOW_DAYS, type Analysis, type AnalyzeOptions, type Item } from "./analyze.ts"

const exec = promisify(execFile)
export type Page = { data: any; total?: number; next?: string }
export interface GitLabAPI { get(path: string): Promise<Page> }

/** Let glab handle credentials, corporate CAs and instance configuration. */
export class GitLabClient implements GitLabAPI {
  private outbound = new Semaphore(6)
  constructor(private hostname?: string) {}
  async get(path: string): Promise<Page> {
    const release = await this.outbound.acquire()
    try {
      const { stdout } = await exec("glab", ["api", path, "--method", "GET", "--include", ...(this.hostname ? ["--hostname", this.hostname] : [])], {
        encoding: "utf8", timeout: 25_000, maxBuffer: 16 * 1024 * 1024,
      })
      const split = stdout.search(/\r?\n\r?\n/)
      if (split < 0) throw new Error("Missing response headers")
      const headers = stdout.slice(0, split)
      const total = headers.match(/^x-total:\s*(\d+)/im)?.[1]
      const next = headers.match(/^x-next-page:\s*(\d+)/im)?.[1]
      return { data: JSON.parse(stdout.slice(split).trim()), total: total === undefined ? undefined : Number(total), next }
    } catch (e: any) {
      // Never forward CLI output: it can contain credential/configuration details.
      if (e.code === "ENOENT") throw new GitHubError("upstream", "glab is not installed. Install glab and run glab auth login.")
      const status = String(e.stderr ?? "").match(/(?:HTTP\s+|status(?: code)?[: ]+)(\d{3})/i)?.[1]
      if (status === "404") throw new GitHubError("not_found", "Resource not found on GitLab")
      if (status === "429") throw new GitHubError("rate_limited", "GitLab rate limit hit. Try again in a minute.", 60)
      if (e.killed) throw new GitHubError("timeout", "GitLab took too long. Try again.", 30)
      throw new GitHubError("upstream", `GitLab request failed${status ? ` (HTTP ${status})` : ""}. Check glab auth status${this.hostname ? ` --hostname ${this.hostname}` : ""} and API access.`)
    } finally { release() }
  }
}

async function list(api: GitLabAPI, path: string, maxPages: number) {
  const items: any[] = []
  let total: number | undefined
  let truncated = false
  for (let page = 1; page <= maxPages; page++) {
    const result = await api.get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`)
    if (!Array.isArray(result.data)) throw new GitHubError("upstream", "Unexpected GitLab list response")
    items.push(...result.data)
    total = result.total ?? total
    truncated = !!result.next || (result.data.length === 100 && (total === undefined || items.length < total))
    if (!truncated) break
  }
  return { items, total: total ?? items.length, truncated }
}

export async function analyzeGitLab(api: GitLabAPI, rawLogin: string, { publicOnly, maxPages, days = WINDOW_DAYS }: AnalyzeOptions): Promise<Analysis> {
  const { data: users } = await api.get(`/users?username=${encodeURIComponent(rawLogin)}`)
  const user = users.find((u: any) => u.username.toLowerCase() === rawLogin.toLowerCase())
  if (!user) throw new GitHubError("not_found", `${rawLogin} not found on GitLab`)
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const query = `scope=all&author_id=${user.id}&created_after=${since}T00:00:00Z&order_by=created_at&sort=desc`
  const [mrs, issues] = await Promise.all([
    list(api, `/merge_requests?${query}`, maxPages),
    list(api, `/issues?${query}${publicOnly ? "&confidential=false" : ""}`, maxPages),
  ])
  const groups = new Set<string>()
  const projectIds = [...new Set([...mrs.items, ...issues.items].map((i) => i.project_id))]
  const projects = new Map<number, any>()
  // Bound fan-out even for injected transports; fail rather than score missing metadata as external.
  for (let i = 0; i < projectIds.length; i += 6) {
    await Promise.all(projectIds.slice(i, i + 6).map(async (id) => {
      const { data: p } = await api.get(`/projects/${id}`)
      if (!publicOnly || p.visibility === "public") projects.set(id, p)
    }))
  }
  const repos: Analysis["repos"] = {}
  const convert = (entries: any[], kind: "pr" | "issue"): Item[] => entries.flatMap((entry) => {
    const p = projects.get(entry.project_id)
    if (!p || (publicOnly && entry.confidential)) return []
    const name = p.path_with_namespace
    // Namespace type distinguishes teams from someone else's personal account.
    // Membership roles do not indicate who benefits from the work.
    const company = p.namespace.kind === "group"
    const owned = p.namespace.kind === "user" && p.namespace.full_path.toLowerCase() === user.username.toLowerCase()
    if (company) groups.add(p.namespace.full_path)
    repos[name] = { name, url: p.web_url, stars: p.star_count ?? 0, forks: p.forks_count ?? 0,
      owned, company, dependency: false, sponsor: false }
    return [{ kind, repo: name, title: entry.title, url: entry.web_url, at: entry.created_at }]
  })
  const prItems = convert(mrs.items, "pr"), issueItems = convert(issues.items, "issue")
  const notes = ["GitLab mode counts merge requests and issues only; commits, dependency detection and sponsorships are unavailable.",
    "Group namespaces count as company/team work regardless of your role. This is a heuristic: personal groups and open-source groups also count as teams."]
  if (mrs.truncated || issues.truncated) notes.push("GitLab results reached the page limit; this analysis is a sample.")
  return { login: user.username, avatar: user.avatar_url, provider: "gitlab", notes, orgs: [...groups],
    items: [...prItems, ...issueItems], repos, publicOnly, window: { days, since },
    sampled: { prs: { total: publicOnly ? prItems.length : mrs.total, fetched: prItems.length },
      issues: { total: publicOnly ? issueItems.length : issues.total, fetched: issueItems.length },
      commits: { total: 0, fetched: 0 }, sponsoring: 0 } }
}
