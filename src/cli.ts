import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import html from "./ui/index.html"
import { GitLabClient, analyzeGitLab } from "./gitlab.ts"
import { Client } from "./github.ts"
import { createHandler, MemoryStore } from "./handler.ts"

const args = process.argv.slice(2)
if (args.includes("-h") || args.includes("--help")) {
  console.log(`dev-alignment [username] [--gitlab] [--hostname gitlab.example.com] [--port 3000] [--public] [--no-open]

Runs the dev-alignment UI on your machine using your GitHub or GitLab login.
GitHub: GITHUB_TOKEN, or whatever \`gh auth login\` set up. Private repos count.

  --gitlab    use GitLab through your glab login (glab auth login)
  --hostname  GitLab instance; otherwise use glab host resolution
  --public    behave like the public site: public data only
  --no-open   don't open the browser
`)
  process.exit(0)
}
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args.splice(i, 1), true) : false
}
const opt = (name: string) => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  if (!args[i + 1] || args[i + 1].startsWith("--")) { console.error(`${name} requires a value`); process.exit(1) }
  return args.splice(i, 2)[1]
}
const gitlab = flag("--gitlab")
const hostname = opt("--hostname")
if (hostname && !gitlab) { console.error("--hostname requires --gitlab"); process.exit(1) }
const port = Number(opt("--port") ?? process.env.PORT ?? 3000)
const publicOnly = flag("--public")
const noOpen = flag("--no-open")
if (args.length > 1 || args.some((a: string) => a.startsWith("-"))) { console.error("Unexpected arguments. Run with --help for usage."); process.exit(1) }
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error("Port must be between 1 and 65535"); process.exit(1) }
const username = args[0]

const token = gitlab ? "" :
  process.env.GITHUB_TOKEN?.trim() ||
  (() => {
    try {
      return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    } catch {
      return ""
    }
  })()
if (!gitlab && !token) {
  console.error("No GitHub login found. Run `gh auth login` (https://cli.github.com) or set GITHUB_TOKEN.")
  process.exit(1)
}

const gh = gitlab ? undefined : new Client([token])
const gl = gitlab ? new GitLabClient(hostname) : undefined
let login = username
if (gl) {
  try { const { data } = await gl.get("/user"); login ??= data.username }
  catch (e) { console.error((e as Error).message); process.exit(1) }
} else {
  login ??= await gh!.session().get("/user").then((u) => u.login as string).catch(() => undefined)
}
const handler = createHandler({ gh, provider: gitlab ? "gitlab" : "github",
  analyze: gl ? (login) => analyzeGitLab(gl, login, { publicOnly, maxPages: 10 }) : undefined,
  store: new MemoryStore(), html, publicOnly, browserCache: false, maxPages: 10 })

const server = createServer(async (req, res) => {
  const request = new Request(`http://${req.headers.host ?? `localhost:${port}`}${req.url ?? "/"}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])) as [string, string][],
  })
  const response = await handler(request)
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
})

server.listen(port, "127.0.0.1", () => {
  const url = `http://localhost:${port}/${login ? `?u=${encodeURIComponent(login)}` : ""}`
  // OSC 8 makes it clickable in terminals that support hyperlinks; the rest just show the URL.
  const link = `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`
  console.log(`\n  dev-alignment · ${gitlab ? "GitLab" : "GitHub"}${login ? ` · ${login}` : ""}  ${publicOnly ? "public data only" : "incl. private repos"} · your own rate limit\n\n  \x1b[1m${link}\x1b[0m\n`)
  if (noOpen) return
  const [cmd, ...pre] = process.platform === "win32" ? ["cmd", "/c", "start", ""] : process.platform === "darwin" ? ["open"] : ["xdg-open"]
  spawn(cmd, [...pre, url], { stdio: "ignore", detached: true }).on("error", () => {}).unref()
})
