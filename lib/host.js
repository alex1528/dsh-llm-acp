// lib/host.js — optional bridge to the host's `@deepseek-ai/dsh-llm`.
//
// Resolution differs by deployment: on-disk plugins may sit in a profile whose node_modules
// carries the host packages (dsh-workbuddy-connect imports dsh-llm that way), while a plugin
// loaded from a "shared package" anchor may not. So we try the bare specifier first, then the
// declarations the installation itself publishes (`desktop-runtime.json` lists shared packages
// with their paths), then fall back to a plain base class: the host registry validates adapters
// structurally (providerInfo/stream…), it never checks `instanceof LlmAdapter`.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SPECIFIER = '@deepseek-ai/dsh-llm'
const candidates = [SPECIFIER]
/** A package directory is imported through its manifest, like a resolver would. */
const entryUrl = (dir) => {
  try {
    const real = realpathSync(dir)
    const manifest = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'))
    const main = typeof manifest.main === 'string' ? manifest.main : 'index.js'
    return pathToFileURL(join(real, main)).href
  } catch { return undefined }
}
const hasCore = (dir) => existsSync(join(dir, 'package.json'))

/** Path from a desktop-runtime.json shared-package entry (relative to the manifest, or absolute). */
function fromRuntimeManifest(file) {
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    const found = (manifest.sharedPackages ?? []).find((p) => p?.name === SPECIFIER)
    if (typeof found?.path !== 'string') return undefined
    return isAbsolute(found.path) ? found.path : join(dirname(file), found.path)
  } catch { return undefined }
}

/** Installation anchors that may carry the host packages, nearest first. */
function anchors() {
  const dirs = [process.cwd(), ...(process.env.DSH_HOME ? [process.env.DSH_HOME] : [])]
  return dirs.flatMap((dir) => [join(dir, 'node_modules', SPECIFIER), join(dir, 'desktop-runtime.json')])
}

for (const anchor of anchors()) {
  const dir = anchor.endsWith('.json') ? fromRuntimeManifest(anchor) : anchor
  if (dir === undefined || !hasCore(dir)) continue
  const url = entryUrl(dir)
  if (url !== undefined && !candidates.includes(url)) candidates.push(url)
}

let LlmAdapter
for (const spec of candidates) {
  try { ({ LlmAdapter } = await import(spec)); break } catch { /* try the next anchor */ }
}

/** Host LlmAdapter class, or undefined when it cannot be resolved here. */
export const AcpAdapterBase = LlmAdapter

/** A minimal stand-in with the same default image hooks as the host base class. */
export class FallbackAdapterBase {
  providerInfo(provider) { return { id: provider, name: provider } }
  providerRetryPolicy() { return undefined }
  imageRequestPricing() { return undefined }
  imageRequestTarget(_p, _m, image) { return { width: image.width, height: image.height, maxBytes: image.bytes } }
  listModels() { return Promise.resolve([]) }
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: (options) => this.stream(options) }
  }
}
