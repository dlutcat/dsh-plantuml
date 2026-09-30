/**
 * dsh-plantuml — node half.
 *
 * The rendering itself happens entirely in the browser (the official
 * TeaVM-compiled PlantUML engine, vendored under `vendor/`), so this half has
 * exactly one job: serve those immutable engine assets to the page over the
 * composition's `webServer`.
 *
 * Why a route at all: the client bundle may only `require()` platform seed
 * words or boot-graph rows, and the engine is a 4 MB ESM module plus a lazily
 * loaded standard-library directory. Serving it from the plugin's own
 * directory keeps the bundle small, keeps the engine out of the boot graph,
 * and lets the browser cache it independently.
 *
 * The route is deliberately unfenced, matching the existing `/plugins` asset
 * route (`@deepseek-ai/dsh-client-modules`) that serves every client bundle:
 * a fence that demands an `Origin` header would reject plain same-origin
 * script/ESM GETs. What is exposed here is only the PlantUML engine this
 * package ships — no workspace file is ever reachable, and path containment
 * below is enforced before any read.
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis function-plugin name. */
export const name = 'plantuml'

/** The only service this half needs: the HTTP carrier that serves the page. */
export const inject = ['webServer']

/** Public mount point. The client half hardcodes the same prefix. */
const ASSET_PREFIX = '/dsh-plantuml'

/** Absolute directory the route is confined to. */
const ASSET_ROOT = resolve(fileURLToPath(new URL('../vendor/', import.meta.url)))

/** Extensions the engine ships; anything else is refused rather than guessed. */
const CONTENT_TYPES = new Map([
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png']
])

/**
 * Map a request URL onto a file inside {@link ASSET_ROOT}.
 *
 * Containment is decided on the resolved absolute path, not on the raw string,
 * so `..`, encoded separators, and absolute fragments cannot escape the
 * vendored directory.
 *
 * @param url - The raw request URL.
 * @returns The absolute file path, or undefined when the request is outside the
 * mount point, resolves outside the asset root, or has no servable extension.
 */
function resolveAsset(url) {
  let pathname
  try {
    pathname = new URL(String(url), 'http://127.0.0.1').pathname
  } catch {
    return undefined
  }
  if (pathname !== ASSET_PREFIX && !pathname.startsWith(`${ASSET_PREFIX}/`)) return undefined

  let relative
  try {
    relative = decodeURIComponent(pathname.slice(ASSET_PREFIX.length))
  } catch {
    return undefined
  }
  relative = relative.replace(/^\/+/, '')
  if (relative === '' || relative.includes('\0')) return undefined

  const target = resolve(ASSET_ROOT, relative)
  if (target !== ASSET_ROOT && !target.startsWith(ASSET_ROOT + sep)) return undefined
  if (!CONTENT_TYPES.has(extname(target).toLowerCase())) return undefined
  return target
}

/**
 * Serve one engine asset.
 * @param req - The incoming request.
 * @param res - The response this handler owns.
 */
async function handleAssetRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('allow', 'GET, HEAD')
    res.end()
    return
  }

  const target = resolveAsset(req.url)
  if (target === undefined) {
    res.statusCode = 404
    res.end()
    return
  }

  let info
  try {
    info = await stat(target)
  } catch {
    res.statusCode = 404
    res.end()
    return
  }
  if (!info.isFile()) {
    res.statusCode = 404
    res.end()
    return
  }

  // The engine is large and effectively immutable per install, so the ETag is
  // derived from its identity rather than its bytes; `no-cache` still forces a
  // revalidation so a plugin update is picked up on the next page load.
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
  res.setHeader('content-type', CONTENT_TYPES.get(extname(target).toLowerCase()))
  res.setHeader('cache-control', 'no-cache')
  res.setHeader('etag', etag)
  res.setHeader('x-content-type-options', 'nosniff')

  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304
    res.end()
    return
  }

  res.setHeader('content-length', String(info.size))
  if (req.method === 'HEAD') {
    res.statusCode = 200
    res.end()
    return
  }

  res.statusCode = 200
  const stream = createReadStream(target)
  stream.on('error', () => {
    // Headers are already committed; the only correct move is to end the body
    // so the browser does not wait on a request that can no longer succeed.
    res.destroy()
  })
  stream.pipe(res)
}

/**
 * Register the engine asset route.
 * @param ctx - Host root context carrying `webServer`.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ASSET_PREFIX,
        handler: handleAssetRequest
      }),
    `dsh-plantuml: GET ${ASSET_PREFIX}/**`
  )
}
