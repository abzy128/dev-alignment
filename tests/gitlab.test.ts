import { test } from "node:test"
import assert from "node:assert/strict"
import { analyzeGitLab, type GitLabAPI } from "../src/gitlab.ts"
import { createHandler, MemoryStore } from "../src/handler.ts"

const contribution = (id: number, extra = {}) => ({ project_id: id, title: "work", web_url: `https://gitlab.example.com/project/${id}`, created_at: new Date().toISOString(), ...extra })
function api(): GitLabAPI {
  return { async get(path) {
    if (path.startsWith("/users?")) return { data: [{ id: 1, username: "a.b_c", avatar_url: "" }] }
    assert.ok(path !== "/user" && !path.startsWith("/groups?"), "classification must not require the viewer's memberships")
    if (path.startsWith("/merge_requests?")) {
      assert.match(path, /scope=all&author_id=1&created_after=/)
      return { data: [contribution(1), contribution(2)], total: 2 }
    }
    if (path.startsWith("/issues?")) return { data: [contribution(1, { confidential: true }), contribution(3)], total: 2 }
    const id = Number(path.split("/").at(-1))
    return { data: { path_with_namespace: id === 3 ? "other/repo" : `team/sub/repo${id}`, namespace: { kind: id === 3 ? "user" : "group", full_path: id === 3 ? "other" : "team/sub" }, web_url: `https://gitlab.example.com/repos/${id}`, visibility: id === 2 ? "private" : "public", star_count: 3, forks_count: 1 } }
  } }
}
test("GitLab maps nested groups to company work and other users to external work", async () => {
  const result = await analyzeGitLab(api(), "a.b_c", { publicOnly: false, maxPages: 10 })
  assert.equal(result.items.length, 4)
  assert.equal(result.repos["team/sub/repo1"].owned, false)
  assert.equal(result.repos["team/sub/repo1"].company, true)
  assert.equal(result.repos["other/repo"].company, false)
  assert.equal(result.repos["other/repo"].owned, false)
  assert.equal(result.repos["other/repo"].url, "https://gitlab.example.com/repos/3")
  assert.match(result.notes![0], /commits.*unavailable/)
})
test("public mode excludes private projects and confidential issues", async () => {
  const result = await analyzeGitLab(api(), "a.b_c", { publicOnly: true, maxPages: 10 })
  assert.equal(result.items.length, 2)
  assert.equal(result.repos["team/sub/repo2"], undefined)
  assert.equal(result.sampled.prs.total, 1)
})
test("pagination follows next page and reports sampling at the cap", async () => {
  const base = api()
  const paged: GitLabAPI = { async get(path) {
    if (path.startsWith("/merge_requests?")) return { data: [contribution(1)], next: "2", total: 200 }
    return base.get(path)
  } }
  const result = await analyzeGitLab(paged, "a.b_c", { publicOnly: false, maxPages: 2 })
  assert.equal(result.sampled.prs.fetched, 2)
  assert.equal(result.sampled.prs.total, 200)
  assert.match(result.notes!.at(-1)!, /page limit/)
})
test("handler accepts GitLab usernames, deduplicates, caches and rejects invalid encoding", async () => {
  let calls = 0
  const handler = createHandler({ provider: "gitlab", store: new MemoryStore(), html: "", publicOnly: false, maxPages: 1,
    analyze: async (login) => { calls++; return analyzeGitLab(api(), login, { publicOnly: false, maxPages: 1 }) } })
  const request = () => handler(new Request("http://localhost/api/a.b_c"))
  const responses = await Promise.all([request(), request()])
  assert.deepEqual(responses.map((r) => r.status), [200, 200])
  await request()
  assert.equal(calls, 1)
  assert.equal((await handler(new Request("http://localhost/api/%ZZ"))).status, 400)
  const github = createHandler({ store: new MemoryStore(), html: "", publicOnly: true, maxPages: 1 })
  assert.equal((await github(new Request("http://localhost/api/a.b_c"))).status, 400)
})

test("glab transport forwards host, parses headers, and sanitizes failures", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { GitLabClient } = await import("../src/gitlab.ts")
  const dir = await mkdtemp(join(tmpdir(), "fake-glab-"))
  const oldPath = process.env.PATH
  try {
    await writeFile(join(dir, "glab"), `#!${process.execPath}
const args = process.argv.slice(2)
if (args.includes('/fail')) { console.error('HTTP 429 secret-token'); process.exit(1) }
if (args.includes('/missing')) { console.error('HTTP 404'); process.exit(1) }
if (!args.includes('gitlab.example.com') || !args.includes('--include')) process.exit(2)
process.stdout.write('HTTP/2.0 200 OK\\r\\nX-Total: 201\\r\\nX-Next-Page: 2\\r\\n\\r\\n[{"id":1}]')
`, { mode: 0o755 })
    process.env.PATH = `${dir}:${oldPath}`
    const client = new GitLabClient("gitlab.example.com")
    assert.deepEqual(await client.get("/users"), { data: [{ id: 1 }], total: 201, next: "2" })
    await assert.rejects(client.get("/fail"), (e: any) => e.code === "rate_limited" && !e.message.includes("secret-token"))
    await assert.rejects(client.get("/missing"), (e: any) => e.code === "not_found")
  } finally {
    process.env.PATH = oldPath
    await rm(dir, { recursive: true, force: true })
  }
})

test("UI script parses and escapes provider project labels", async () => {
  const { readFile } = await import("node:fs/promises")
  const { Script, createContext } = await import("node:vm")
  const html = await readFile("src/ui/index.html", "utf8")
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]
  new Script(script)
  const escaping = script.slice(script.indexOf("const esc ="), script.indexOf("const KNOBS"))
  const context = createContext({ URL })
  new Script(`${escaping}; result = esc('<img src=x onerror="x">'); unsafe = safeURL('javascript:alert(1)')`).runInContext(context)
  assert.equal(context.result, '&lt;img src=x onerror=&quot;x&quot;&gt;')
  assert.equal(context.unsafe, '#')
})

test("personal namespace matching ignores case; group type wins over matching names and roles", async () => {
  for (const role of [10, 40, 50]) {
    const base = api()
    const transport: GitLabAPI = { async get(path) {
      const result = await base.get(path)
      if (path === "/projects/1") {
        result.data.namespace = { kind: "user", full_path: "A.B_C" }
        result.data.path_with_namespace = "A.B_C/personal"
      }
      if (path === "/projects/2") {
        result.data.namespace = { kind: "group", full_path: "a.b_c", name: "a.b_c" }
        result.data.permissions = { group_access: { access_level: role } }
      }
      return result
    } }
    const result = await analyzeGitLab(transport, "a.b_c", { publicOnly: false, maxPages: 1 })
    assert.equal(result.repos["A.B_C/personal"].owned, true)
    assert.equal(result.repos["A.B_C/personal"].company, false)
    assert.equal(result.repos["team/sub/repo2"].owned, false)
    assert.equal(result.repos["team/sub/repo2"].company, true)
  }
})

test("company scoring renders a selfless result without stars, and its slider changes the score", async () => {
  const { readFile } = await import("node:fs/promises")
  const { Script, createContext } = await import("node:vm")
  const html = await readFile("src/ui/index.html", "utf8")
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]
  const elements = new Map<string, any>()
  const context = createContext({ URL, document: { getElementById(id: string) {
    if (!elements.has(id)) elements.set(id, { style: {} })
    return elements.get(id)
  } } })
  // Execute the actual UI scoring and rendering functions without browser initialization.
  const declarations = script.slice(0, script.indexOf('const knobs ='))
  const scoring = script.slice(script.indexOf('const audience ='), script.indexOf('// Alignment over'))
  const rendering = script.slice(script.indexOf('function render()'), script.indexOf('let retryTimer'))
  new Script(`${declarations}\n${scoring}\nfunction sparkline() {}\n${rendering}`).runInContext(context)
  const result = await analyzeGitLab(api(), "a.b_c", { publicOnly: false, maxPages: 1 })
  const repo = result.repos["team/sub/repo1"]
  repo.stars = repo.forks = 0
  result.repos = { [repo.name]: repo }
  result.items = result.items.filter((i) => i.repo === repo.name)
  context.fixture = result
  new Script('provider = "gitlab"; data = fixture; render()').runInContext(context)
  assert.equal(elements.get("pct").textContent, "60% selfless")
  assert.equal(elements.get("sub").textContent, "0 personal · 1 company/team · 0 external")
  assert.match(elements.get("repos").innerHTML, /class="tag company">company\/team/)
  new Script('k.companyBase = 1; render()').runInContext(context)
  assert.equal(elements.get("pct").textContent, "100% selfless")
  new Script('data.repos["team/sub/repo1"].company = false; data.repos["team/sub/repo1"].owned = true; render()').runInContext(context)
  assert.equal(elements.get("pct").textContent, "100% selfish")
})

test("local responses bypass HTTP caches while the public site keeps caching", async () => {
  for (const publicOnly of [false, true]) {
    const handler = createHandler({ provider: "gitlab", store: new MemoryStore(), html: "page", publicOnly,
      browserCache: false, maxPages: 1, analyze: (login) => analyzeGitLab(api(), login, { publicOnly, maxPages: 1 }) })
    for (const path of ["/", "/healthz", "/api/a.b_c", "/api/a.b_c"]) {
      const response = await handler(new Request(`http://localhost${path}`))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get("cache-control"), "no-store")
    }
  }
  const handler = createHandler({ store: new MemoryStore(), html: "page", publicOnly: true,
    maxPages: 1, analyze: () => analyzeGitLab(api(), "a.b_c", { publicOnly: true, maxPages: 1 }) })
  assert.match((await handler(new Request("https://example.com/"))).headers.get("cache-control")!, /public/)
  assert.match((await handler(new Request("https://example.com/api/abzy"))).headers.get("cache-control")!, /public, max-age=600/)
})
