// Local preview server for the README screenshots (docs/shot-*.png).
//
// Serves client.js with a React 18 UMD build and answers /api/llm-acp.* with the plugin's OWN route
// handlers (lib/dashboard-host.js) over the CURRENT profile config, so the shots show exactly what
// DSH shows. No prompt is ever sent: model discovery is an ACP handshake (initialize → session/new),
// and the quota probe runs each CLI's own read-only usage command. Nothing is written: sessions /
// prefs / usage files are copied to a temp dir first, and saving config is refused.
//
//   node scripts/screenshots/server.mjs      → prints "listening http://127.0.0.1:<port>"
//   /?view=page | sidebar | modal&session=<id>   (page: add &full=0 to keep the pane height)
//
// Env: DSH_HOME, DSH_PROFILE_DIR, REACT_UMD_DIR (node_modules with react/ and react-dom/ umd builds),
// YAML_FROM (a dir whose node_modules has js-yaml or yaml), SHOTS_MASK_HOME (0 = show the real home
// directory instead of /Users/you), PORT.
import http from 'node:http'
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveProviders } from '../../lib/config.js'
import { createAcpAdapter } from '../../lib/adapter.js'
import { FallbackAdapterBase } from '../../lib/host.js'
import { fromHostLogger } from '../../lib/log.js'
import { createPrefs } from '../../lib/prefs.js'
import { createUsageLog } from '../../lib/usage.js'
import { registerDashboardRoutes } from '../../lib/dashboard-host.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILE = process.env.DSH_PROFILE_DIR || join(HOME, 'profiles', 'desktop')
const DATA = join(HOME, 'llm-acp')
// A node_modules dir holding react/umd and react-dom/umd (React 18; React 19 ships no UMD build).
const REACT_DIR = process.env.REACT_UMD_DIR || join(ROOT, 'node_modules')
for (const f of ['react/umd/react.production.min.js', 'react-dom/umd/react-dom.production.min.js']) {
  if (!existsSync(join(REACT_DIR, f))) throw new Error(`missing ${join(REACT_DIR, f)}: set REACT_UMD_DIR to a node_modules dir with React 18 UMD builds`)
}
// The shots show this instead of the real home directory (SHOTS_MASK_HOME=0 keeps the real one).
// Incoming request bodies are mapped back, so 检测连接 still finds the real executable.
const HOME_DIR = homedir()
const MASK = process.env.SHOTS_MASK_HOME === '0' ? '' : '/Users/you'
const mask = (s) => (MASK ? s.split(HOME_DIR).join(MASK) : s)
const unmask = (s) => (MASK ? s.split(MASK).join(HOME_DIR) : s)

function yamlLoader() {
  const dirs = [ROOT, ...(process.env.YAML_FROM ? [process.env.YAML_FROM] : [])]
  for (const from of dirs) {
    const req = createRequire(join(from, 'x.js'))
    try { return req('js-yaml').load } catch {}
    try { return req('yaml').parse } catch {}
  }
  throw new Error('need js-yaml or yaml: set YAML_FROM to a directory whose node_modules has one')
}

const rows = yamlLoader()(readFileSync(join(PROFILE, 'cordis.patch.yml'), 'utf8'))
const raw = (Array.isArray(rows) ? rows : []).find((r) => r?.id === 'llm-acp')?.config ?? {}
const providers = resolveProviders(raw)

const tmp = mkdtempSync(join(tmpdir(), 'llm-acp-shots-'))
const copy = (name) => {
  const f = join(DATA, name)
  if (!existsSync(f)) return undefined
  const t = join(tmp, name)
  copyFileSync(f, t)
  return t
}
const stateFile = copy('sessions.json') ?? join(tmp, 'sessions.json')
const quiet = { info() {}, warn: (m) => console.error(m), error: (m) => console.error(m) }
const prefs = createPrefs({ file: copy('prefs.json') })
const usage = createUsageLog({ file: copy('usage.jsonl') })
const adapter = createAcpAdapter({
  Base: FallbackAdapterBase, providers: () => providers, resolveCwd: () => process.cwd(),
  stateFile, logger: fromHostLogger(quiet), prefs, onTurn: () => {},
})
const ctx = { logger: quiet, effect() {}, get() { throw new Error('preview: no host services') } }
const saveConfig = async () => { throw new Error('预览模式：不写配置') }
const { routes } = registerDashboardRoutes(ctx, { adapter, providers, prefs, usage, stateFile, saveConfig, rawProviders: raw.providers ?? {} })

/** The session with the most recorded turns, for the /acp modal shot. */
const topSession = () => {
  const n = new Map()
  for (const r of usage.read()) if (r.session) n.set(r.session, (n.get(r.session) ?? 0) + 1)
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>llm-acp preview</title>
<style>
html,body{margin:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif}
#root{height:100vh}
body.full #root{height:auto}
body.full .acp{height:auto!important;overflow:visible!important}
body.side{background:#fff}
</style>
<script src="/react.js"></script><script src="/react-dom.js"></script>
<script>window.__ModuleLoader__ = { load(d) { window.__acp = d.factory((n) => (n === 'react' ? React : undefined)) } }</script>
<script src="/client.js"></script>
</head><body><div id="root"></div>
<script>
const q = new URLSearchParams(location.search)
const view = q.get('view') || 'page'
const A = window.__acp
const h = React.createElement
let el
if (view === 'sidebar') { document.body.classList.add('side'); el = h(A.Console, {}) }
else if (view === 'modal') el = h(A.AcpModal, { sessionId: q.get('session') || '' })
else { if (q.get('full') !== '0') document.body.classList.add('full'); el = h(A.InsightsPage) }
ReactDOM.createRoot(document.getElementById('root')).render(el)
</script></body></html>`

const FILES = {
  '/client.js': [join(ROOT, 'client.js'), 'text/javascript; charset=utf-8'],
  '/react.js': [join(REACT_DIR, 'react/umd/react.production.min.js'), 'text/javascript'],
  '/react-dom.js': [join(REACT_DIR, 'react-dom/umd/react-dom.production.min.js'), 'text/javascript'],
}
const send = (res, status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body) }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  try {
    if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', HTML)
    if (FILES[url.pathname]) { const [f, type] = FILES[url.pathname]; return send(res, 200, type, readFileSync(f)) }
    if (url.pathname === '/preview/session') return send(res, 200, 'application/json', JSON.stringify({ session: topSession() }))
    const route = routes.find((r) => r.path === url.pathname)
    if (!route) return send(res, 404, 'text/plain', 'not found')
    const chunks = []
    for await (const c of req) chunks.push(c)
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method, headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
      body: hasBody ? unmask(Buffer.concat(chunks).toString('utf8')) : undefined,
    })
    const r = await route.fetch(request)
    const type = r.headers.get('content-type') ?? ''
    const out = /json|csv|text/.test(type) ? Buffer.from(mask(await r.text())) : Buffer.from(await r.arrayBuffer())
    res.writeHead(r.status, { ...Object.fromEntries(r.headers), 'content-length': String(out.length) })
    res.end(out)
  } catch (e) { send(res, 500, 'text/plain', String(e?.stack ?? e)) }
})
server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => console.log(`listening http://127.0.0.1:${server.address().port}`))
const stop = async () => { server.close(); try { await adapter.dispose() } catch {} process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
