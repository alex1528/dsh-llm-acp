// lib/discover.js — find ACP CLIs already installed on this machine and turn them into provider
// configs, so the ACP console can add a provider with one click instead of hand-written YAML.
//
//   scan()   looks for every known CLI (RECIPES) in DSH's PATH, the login shell's PATH and the
//            usual install directories; it never starts an ACP session.
//   probe()  runs one real ACP handshake (initialize → session/new, no prompt, no tokens) and
//            reports models, capabilities and how the CLI selects a model.
//   addProvider() merges a provider into the plugin's raw config and validates the result with
//            the same resolver the plugin uses at load time.
//
// Recipes only say what is known about each CLI; probe() is what proves a recipe on this machine.
import { execFile } from 'node:child_process'
import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import { openSession } from './acp-session.js'
import { DEFAULTS, resolveProviders } from './config.js'

/**
 * Known ACP CLIs. `bin` is the command name an install puts on PATH (not the npm package name).
 * verified: launched over ACP by this plugin on a real machine.
 */
export const RECIPES = Object.freeze([
  { bin: 'kiro-cli', id: 'kiro', displayName: 'Kiro', args: ['acp'], modelVia: 'configOption', verified: true,
    note: 'v3 引擎在 ACP 里用 model 配置项报模型；--model 只适用于 v2 引擎' },
  { bin: 'codebuddy', id: 'codebuddy', displayName: 'CodeBuddy', args: ['--acp'], modelVia: 'args', verified: true,
    env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' }, note: '中国站（codebuddy.cn）' },
  { bin: 'codebuddy-code', id: 'codebuddy-code', displayName: 'CodeBuddy Code (Intl)', args: ['--acp'], modelVia: 'args', verified: true,
    env: { CODEBUDDY_INTERNET_ENVIRONMENT: 'external' }, note: '国际站，需要单独登录一次；与 codebuddy 是同一个程序' },
  { bin: 'qodercli', id: 'qoder', displayName: 'Qoder', args: ['--acp'], modelVia: 'configOption', verified: true,
    note: 'ACP 模型 id 是内部代号，--model 要的是显示名，所以走 ACP 切换' },
  { bin: 'deveco', id: 'deveco', displayName: 'DevEco', args: ['acp'], modelVia: 'configOption', verified: true,
    note: 'npm 包 @deveco/deveco-code 装出的命令叫 deveco' },
  { bin: 'opencode', id: 'opencode', displayName: 'OpenCode', args: ['acp'], verified: true },
  { bin: 'cursor-agent', id: 'cursor', displayName: 'Cursor', args: ['acp'], modelVia: 'args', models: ['default'], verified: true,
    note: '先运行 cursor-agent login；Free 账号只有 Auto 可用' },
  { bin: 'pi-acp', id: 'pi', displayName: 'Pi', args: [], approvals: 'none', verified: true,
    note: '从不询问权限，只能用 permission: allow' },
  // From upstream guozi058/dsh-llm-acp known-agents (0.4.12 MiniMax Code, 0.4.8 Kilo): handshake and
  // model selection were observed there, not yet through this fork, so they stay unverified here.
  { bin: 'mcode', id: 'mcode', displayName: 'MiniMax Code', args: ['acp'], modelVia: 'configOption', verified: false,
    note: 'npm 包 @minimax-ai/code；工作区内写文件、跑命令不询问（permission: reject 只拦工作区外），不回报 token 用量' },
  { bin: 'kilo', id: 'kilo', displayName: 'Kilo', args: ['acp'], modelVia: 'configOption', verified: false,
    note: '先运行 kilo auth login；默认装在 ~/.kilo/bin' },
  { bin: 'claude-agent-acp', id: 'claude', displayName: 'Claude Code', args: [], modelVia: 'configOption', verified: false },
  { bin: 'codex-acp', id: 'codex', displayName: 'Codex', args: [], modelVia: 'configOption', verified: false },
  { bin: 'gemini', id: 'gemini', displayName: 'Gemini CLI', args: ['--experimental-acp'], verified: false },
])

const COMMON_DIRS = ['~/.local/bin', '~/.npm-global/bin', '~/bin', '~/.bun/bin', '~/.cargo/bin', '~/.opencode/bin', '~/.kilo/bin', '~/.volta/bin', '/opt/homebrew/bin', '/usr/local/bin']
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
const PROVIDER_ID = /^[A-Za-z0-9][\w.-]{0,63}$/
// Every provider key lib/config.js reads; the console form may set any of them.
const SPEC_KEYS = ['displayName', 'command', 'args', 'modelArgs', 'env', 'modelVia', 'permission', 'models', 'approvals', 'approvalModes', 'mode',
  'readTools', 'usageCommand', 'startupTimeoutMs', 'promptTimeoutMs', 'idleTimeoutMs', 'cancelGraceMs', 'disposeGraceMs', 'maxRetries', 'startupRetries',
  'reuseSessions', 'sessionIdleMs', 'maxSessions', 'modelDiscoveryBackoffMs', 'modelDiscoveryMaxBackoffMs', 'promptRetries', 'retryDelayMs', 'maxPromptChars', 'resumeSessions',
  'images', 'maxImageBytes', 'contextWindow', 'modelCacheMs', 'rateInName']

/** Defaults the console form starts from (same values lib/config.js applies). */
export const FORM_DEFAULTS = Object.freeze({
  modelArgs: [...DEFAULTS.modelArgs], permission: DEFAULTS.permission, modelVia: DEFAULTS.modelVia,
  startupTimeoutMs: DEFAULTS.startupTimeoutMs, promptTimeoutMs: DEFAULTS.promptTimeoutMs, idleTimeoutMs: DEFAULTS.idleTimeoutMs,
  reuseSessions: DEFAULTS.reuseSessions, maxSessions: DEFAULTS.maxSessions, resumeSessions: DEFAULTS.resumeSessions,
  images: DEFAULTS.images, promptRetries: DEFAULTS.promptRetries, contextWindow: DEFAULTS.contextWindow,
})

const uniq = (xs) => [...new Set(xs.filter((x) => typeof x === 'string' && x !== ''))]
const expand = (p, home) => (p.startsWith('~/') ? join(home, p.slice(2)) : p)
const isDir = (d) => { try { return statSync(d).isDirectory() } catch { return false } }
export function isExec(file) {
  try { if (!statSync(file).isFile()) return false; accessSync(file, constants.X_OK); return true } catch { return false }
}

/** Interpreter named by a `#!` line (`node`, `bun`, …), or undefined for a native binary. */
export function interpreterOf(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(160)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const head = buf.subarray(0, n).toString('utf8')
    if (!head.startsWith('#!')) return undefined
    const line = head.split('\n')[0].slice(2).trim().split(/\s+/)
    const prog = basename(line[0] === '/usr/bin/env' || basename(line[0]) === 'env' ? (line.find((w, i) => i > 0 && !w.startsWith('-')) ?? '') : line[0])
    return prog || undefined
  } catch { return undefined } finally { if (fd !== undefined) try { closeSync(fd) } catch {} }
}

let loginCache
/** PATH of the user's login shell: a Dock-launched DSH usually lacks what ~/.zprofile adds. */
export function loginShellPath({ env = process.env, timeoutMs = 5000 } = {}) {
  if (process.platform === 'win32') return Promise.resolve([])
  if (loginCache && Date.now() - loginCache.at < 600_000) return loginCache.promise
  const shell = typeof env.SHELL === 'string' && isAbsolute(env.SHELL) ? env.SHELL : '/bin/zsh'
  const promise = new Promise((resolve) => {
    try {
      execFile(shell, ['-lic', 'printf "\\n__DSH_PATH__%s\\n" "$PATH"'], {
        timeout: timeoutMs, maxBuffer: 256 * 1024,
        env: { HOME: env.HOME ?? homedir(), USER: env.USER ?? '', SHELL: shell, TERM: 'dumb' },
      }, (_err, stdout) => {
        const m = String(stdout ?? '').match(/__DSH_PATH__(.*)/)
        resolve(m ? m[1].split(':').filter(Boolean) : [])
      })
    } catch { resolve([]) }
  })
  loginCache = { at: Date.now(), promise }
  return promise
}

/** `bin --version`, best effort. */
export function versionOf(command, env, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(command, ['--version'], { timeout: timeoutMs, maxBuffer: 256 * 1024, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
        const text = `${stdout ?? ''}\n${stderr ?? ''}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        const m = text.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?\b/)
        resolve(m ? { version: m[0] } : { error: err ? String(err.message ?? err).split('\n')[0].slice(0, 160) : 'no version in output' })
      })
    } catch (e) { resolve({ error: String(e?.message ?? e).slice(0, 160) }) }
  })
}

function resolveCommand(command, dirs) {
  if (isAbsolute(command)) return command
  const dir = dirs.find((d) => isExec(join(d, command)))
  return dir ? join(dir, command) : undefined
}
const real = (p) => { try { return realpathSync(p) } catch { return p } }

/** A provider id not yet taken by `taken`. */
export function freeId(base, taken) {
  if (!taken.has(base)) return base
  for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
  return `${base}-${Date.now()}`
}

/**
 * The provider config a recipe suggests for a CLI found at `path`.
 * A `#!/usr/bin/env node` script gets an explicit PATH, or a Dock-launched DSH fails with
 * "env: node: No such file or directory".
 */
export function suggestSpec(recipe, { path, dir, interpreter, interpreterDir }) {
  const env = { ...(recipe.env ?? {}) }
  if (interpreter) env.PATH = uniq([interpreterDir, dir, ...SYSTEM_PATH]).join(':')
  return {
    displayName: recipe.displayName,
    command: path,
    args: [...recipe.args],
    ...(recipe.modelVia === 'configOption' ? { modelVia: 'configOption' } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(recipe.models ? { models: [...recipe.models] } : {}),
    ...(recipe.approvals ? { approvals: recipe.approvals } : {}),
    // allow is the plugin default, so a CLI added from the scan can work as a coder right away.
    permission: 'allow',
  }
}

/**
 * Find installed ACP CLIs. Never spawns an ACP session; runs `--version` only.
 * @param {{ providers?: Map<string, {id:string, command:string}>, env?: object, home?: string, loginPath?: string[], extraDirs?: string[], versions?: boolean }} [o]
 */
export async function scan({ providers = new Map(), env = process.env, home = homedir(), loginPath, commonDirs = COMMON_DIRS, extraDirs = [], versions = true } = {}) {
  const dshPath = String(env.PATH ?? '').split(delimiter)
  const login = loginPath ?? await loginShellPath({ env })
  const dirs = uniq([...dshPath, ...login, ...commonDirs.map((d) => expand(d, home)), ...extraDirs]).filter(isDir)
  const configured = [...providers.values()].map((p) => {
    const resolved = resolveCommand(p.command, dirs)
    return { id: p.id, base: basename(p.command), path: resolved, real: resolved ? real(resolved) : undefined }
  })
  const taken = new Set(providers.keys())
  const candidates = []
  for (const r of RECIPES) {
    const dir = dirs.find((d) => isExec(join(d, r.bin)))
    if (!dir) continue
    const path = join(dir, r.bin)
    const interpreter = interpreterOf(real(path))
    const interpreterDir = interpreter ? dirs.find((d) => isExec(join(d, interpreter))) : undefined
    const match = configured.find((c) => c.base === r.bin || c.path === path)
    const id = match ? match.id : freeId(r.id, taken)
    if (!match) taken.add(id)
    candidates.push({
      bin: r.bin, id, displayName: r.displayName, note: r.note ?? '', verified: r.verified === true,
      recipeModelVia: r.modelVia, path, real: real(path), dir,
      inDshPath: dshPath.includes(dir),
      interpreter, interpreterDir,
      warning: interpreter && !interpreterDir ? `这是 ${interpreter} 脚本，但没找到 ${interpreter}` : undefined,
      configuredAs: match?.id,
      spec: suggestSpec(r, { path, dir, interpreter, interpreterDir }),
    })
  }
  if (versions) {
    await Promise.all(candidates.map(async (c) => { Object.assign(c, await versionOf(c.path, c.spec.env)) }))
  }
  return { dirs, candidates }
}

const AUTH_HINT = '看起来没有登录：先在终端里运行一次这个 CLI 完成登录，再回来检测'
function hintFor(code, message) {
  if (code === 'AUTH' || /auth|login|unauthor|401|403/i.test(message)) return AUTH_HINT
  if (code === 'ACP_SPAWN') return '启动失败：检查路径是否正确、文件是否可执行'
  if (/node: No such file|env: node/i.test(message)) return '找不到 node：在配置的 env.PATH 里加上 node 所在目录'
  if (code === 'TIMEOUT') return 'ACP 握手超时：这个参数可能不是它的 ACP 模式，或 CLI 在等交互输入'
  if (code === 'TRANSPORT') return 'CLI 提前退出：参数可能不对（不是 ACP 模式），看下面的错误输出'
  return undefined
}

/**
 * One ACP handshake against a provider spec; no prompt is sent, so no tokens are spent.
 * Always resolves.
 */
export async function probe(spec, { cwd = tmpdir(), timeoutMs = 45_000 } = {}) {
  const t0 = Date.now()
  let s
  try {
    s = await openSession({
      // model 'default' ⇒ no modelArgs: the probe lets the CLI pick, and never switches models.
      command: spec.command, args: [...(spec.args ?? [])], env: spec.env ?? {}, cwd,
      // allow: a probe never prompts, and alignment must not refuse an agent that never asks.
      permission: 'allow', readTools: [], approvals: spec.approvals ?? 'modes',
      model: 'default', modelVia: spec.modelVia ?? 'args', startupTimeoutMs: timeoutMs, disposeGraceMs: 2000,
    })
  } catch (e) {
    const code = e?.code ?? 'ERROR'
    const message = String(e?.message ?? e).slice(0, 500)
    return { ok: false, ms: Date.now() - t0, code, message, hint: hintFor(code, message) }
  }
  try {
    const info = s.info ?? {}
    const opts = Array.isArray(info.configOptions) ? info.configOptions : []
    const modelOpt = opts.find((o) => o?.category === 'model' || o?.id === 'model')
    const list = Array.isArray(info.models?.availableModels) ? info.models.availableModels : undefined
    let models = []
    let modelSource = 'none'
    if (list && list.length) {
      modelSource = 'models'
      models = list.filter((m) => typeof m?.modelId === 'string' && m.modelId !== '')
        .map((m) => ({ id: m.modelId, name: typeof m.name === 'string' ? m.name : m.modelId, description: typeof m.description === 'string' ? m.description : undefined }))
    } else if (Array.isArray(modelOpt?.options)) {
      modelSource = 'configOption'
      models = modelOpt.options.filter((o) => typeof o?.value === 'string' && o.value !== '')
        .map((o) => ({ id: o.value, name: typeof o.name === 'string' ? o.name : o.value, description: typeof o.description === 'string' ? o.description : undefined }))
    }
    const modeOpt = opts.find((o) => o?.category === 'mode' || o?.id === 'mode')
    const modes = Array.isArray(modeOpt?.options) ? modeOpt.options.map((o) => o?.value).filter((v) => typeof v === 'string')
      : Array.isArray(info.modes?.availableModes) ? info.modes.availableModes.map((m) => m?.id).filter((v) => typeof v === 'string') : []
    return {
      ok: true, ms: Date.now() - t0,
      loadSession: s.capabilities?.loadSession === true,
      image: s.capabilities?.promptCapabilities?.image === true,
      modelSource, hasModelOption: Array.isArray(modelOpt?.options),
      currentModel: info.models?.currentModelId ?? modelOpt?.currentValue,
      models: models.slice(0, 200), modes,
    }
  } finally { await s.dispose().catch(() => {}) }
}

/** How a provider should select models, given its recipe (if any) and a probe result. */
export function recommendModelVia(recipeModelVia, result) {
  if (recipeModelVia === 'args' || recipeModelVia === 'configOption') return recipeModelVia
  if (result?.ok && result.modelSource === 'configOption') return 'configOption'
  return 'args'
}

/**
 * Validate a provider spec coming from the console. Only known keys survive; the command must be
 * an absolute path to an executable file (the console never runs a bare name or a shell string).
 */
export function sanitizeSpec(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('spec must be an object')
  const spec = {}
  for (const k of SPEC_KEYS) if (input[k] !== undefined && input[k] !== null && input[k] !== '') spec[k] = structuredClone(input[k])
  if (typeof spec.command !== 'string' || !isAbsolute(spec.command)) throw new Error('command 必须是绝对路径')
  if (!isExec(spec.command)) throw new Error(`不是可执行文件：${spec.command}`)
  if (spec.args === undefined) spec.args = []
  if (typeof spec.displayName === 'string') spec.displayName = spec.displayName.trim().slice(0, 64)
  if (spec.env !== undefined && (spec.env === null || typeof spec.env !== 'object' || Array.isArray(spec.env))) throw new Error('env 必须是对象')
  if (spec.env && Object.keys(spec.env).length === 0) delete spec.env
  // Same rules as plugin load: throws with the plugin's own message on any bad field.
  resolveProviders({ providers: { probe: spec } })
  return spec
}

/** Next raw plugin config with provider `id` set to `spec`; validated like a load. */
export function addProvider(current, id, spec, { overwrite = false } = {}) {
  if (typeof id !== 'string' || !PROVIDER_ID.test(id)) throw new Error(`provider 名不合法：${JSON.stringify(id)}（字母、数字、. _ -）`)
  const next = structuredClone(current ?? {})
  const providers = next.providers && typeof next.providers === 'object' && !Array.isArray(next.providers) ? { ...next.providers } : {}
  if (providers[id] !== undefined && !overwrite) throw new Error(`provider "${id}" 已经存在`)
  providers[id] = spec
  next.providers = providers
  resolveProviders(next)
  return next
}

/** Next raw plugin config without provider `id`. */
export function removeProvider(current, id) {
  const next = structuredClone(current ?? {})
  const providers = next.providers && typeof next.providers === 'object' && !Array.isArray(next.providers) ? { ...next.providers } : {}
  if (providers[id] === undefined) throw new Error(`provider "${id}" 不在配置里`)
  delete providers[id]
  next.providers = providers
  resolveProviders(next)
  return next
}
