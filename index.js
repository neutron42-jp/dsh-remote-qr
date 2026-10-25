/**
 * Host half of `rdsh-remote-link`.
 *
 * Answers one authenticated `GET /api/remote-link` with the URL another device
 * opens to take over this Web GUI, plus a QR code of that URL.
 *
 * The URL is the advertised root (`--public-url`, else the listener origin)
 * carrying the process launch token. `ctx.connection.authenticatedUrl` is the
 * same call `dsh web` uses to print and open its own URL, so this plugin never
 * stores the token: it asks for a fresh authenticated form on every request.
 * The route lives inside Connection's browser-authentication fence and exact
 * routes refuse non-owner peers, so a shared or liveshare page cannot read it.
 *
 * @module rdsh-remote-link
 */
import { execFile } from 'node:child_process'
import QRCode from './vendor/qrcode.js'

/** Exact Fetch route under the `/api` mux. */
const ROUTE_PATH = '/api/remote-link'
/** Tailscale answers in milliseconds, and the answer is cached this long. */
const TAILSCALE_TIMEOUT_MS = 1500
const TAILSCALE_TTL_MS = 60_000
/** Rendered QR edge in CSS-independent units. */
const QR_SIZE = 512

export const inject = ['connection', 'webApp', 'webServer']

/** Last Tailscale answer, or `undefined` when none was found. */
const tailscale = { at: 0, hostname: undefined }

/**
 * Whether a URL points at this machine only.
 * @param {string} raw - absolute URL.
 * @returns {boolean}
 */
function isLoopbackUrl(raw) {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '::1' || host.startsWith('127.')
  } catch {
    return true
  }
}

/**
 * Read this machine's MagicDNS name from the Tailscale CLI.
 * @returns {Promise<string | undefined>} the bare hostname, without the root dot.
 */
function readTailscaleHostname() {
  return new Promise((resolve) => {
    execFile(
      'tailscale',
      ['status', '--json'],
      { timeout: TAILSCALE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error !== null) return resolve(undefined)
        try {
          const name = JSON.parse(stdout)?.Self?.DNSName
          resolve(typeof name === 'string' && name.length > 0 ? name.replace(/\.$/, '') : undefined)
        } catch {
          resolve(undefined)
        }
      },
    )
  })
}

/**
 * Cached {@link readTailscaleHostname}; a missing answer is cached too.
 * @returns {Promise<string | undefined>}
 */
async function tailscaleHostname() {
  if (Date.now() - tailscale.at < TAILSCALE_TTL_MS) return tailscale.hostname
  const hostname = await readTailscaleHostname()
  tailscale.at = Date.now()
  tailscale.hostname = hostname
  return hostname
}

/**
 * Read `config.publicUrl` as a canonical root.
 *
 * The Host's own `--public-url` parser normalizes the path to end in `/` so
 * that `GET <root>?token=` and its `location: ./` redirect stay inside a mount
 * prefix. The row config has no schema, so the same rule lives here; an
 * unusable value is reported and skipped instead of producing a dead link.
 * @param config - the row config.
 * @returns {string | undefined} the normalized root.
 */
function configuredRoot(config) {
  const raw = typeof config?.publicUrl === 'string' ? config.publicUrl.trim() : ''
  if (raw === '') return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      console.warn('[rdsh-remote-link] config.publicUrl must be http or https; ignoring it')
      return undefined
    }
    url.search = ''
    url.hash = ''
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    return url.href
  } catch {
    console.warn('[rdsh-remote-link] config.publicUrl is not an absolute URL; ignoring it')
    return undefined
  }
}

/**
 * Pick the root another device reaches this GUI through, and say where it came
 * from so the panel can explain an unreachable result.
 * @param ctx - the plugin context.
 * @param config - the row config.
 * @returns {Promise<{ root: string, source: string, warning?: string }>}
 */
async function chooseRoot(ctx, config) {
  const configured = configuredRoot(config)
  if (configured !== undefined) return { root: configured, source: 'config' }

  const advertised = ctx.webApp.getAdvertisedUrl()
  if (!isLoopbackUrl(advertised)) return { root: advertised, source: 'advertised' }

  // A loopback listener only becomes reachable through something this process
  // cannot see: a port forward, a proxy, or Tailscale itself. The Host refuses
  // non-loopback authorities unless the deployment declared trusted hosts, so
  // guessing a tailnet name is only meaningful when it did.
  if (ctx.connection.allowsRemoteAuthorities) {
    const hostname = await tailscaleHostname()
    if (hostname !== undefined) {
      // The listener's own scheme is the only one this process can vouch for;
      // a deployment that terminates TLS elsewhere passes --public-url instead.
      const protocol = ctx.webServer.protocol === 'https:' ? 'https:' : 'http:'
      return { root: `${protocol}//${hostname}:${ctx.webServer.port}`, source: 'tailscale' }
    }
    return { root: advertised, source: 'listener', warning: 'tailscaleUnavailable' }
  }

  return { root: advertised, source: 'listener', warning: 'loopbackOnly' }
}

/**
 * Render one QR code as a standalone SVG document body.
 * @param {string} text - content to encode.
 * @returns {string} SVG markup.
 */
function renderQrSvg(text) {
  return new QRCode({
    content: text,
    width: QR_SIZE,
    height: QR_SIZE,
    padding: 2,
    color: '#000000',
    background: '#ffffff',
    ecl: 'M',
    join: true,
    xmlDeclaration: false,
  }).svg()
}

/**
 * Register the route for the lifetime of the plugin.
 * @param ctx - the plugin context.
 * @param config - the row config.
 */
export function apply(ctx, config) {
  ctx.effect(() =>
    ctx.connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        const chosen = await chooseRoot(ctx, config)
        const url = ctx.connection.authenticatedUrl(chosen.root)
        /** @type {Record<string, string>} */
        const body = { url, source: chosen.source }
        if (chosen.warning !== undefined) body.warning = chosen.warning
        try {
          body.svg = renderQrSvg(url)
        } catch (error) {
          console.warn('[rdsh-remote-link] QR rendering failed', error)
          body.warning = 'qrFailed'
        }
        return Response.json(body, { headers: { 'cache-control': 'no-store' } })
      },
    }),
  )
}
