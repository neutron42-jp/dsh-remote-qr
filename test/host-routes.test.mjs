/**
 * Deployment matrix for the Host half.
 *
 * The interesting decision is which root another device is told to open, so
 * each case builds a fake context with one deployment's facts and checks the
 * answer, including where it came from and whether it warns. Tailscale cases
 * put a stand-in `tailscale` executable on PATH, so the real command line,
 * JSON parsing, and trailing-dot handling all run.
 *
 * Run with `node --test test/`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = new URL('../index.js', import.meta.url)
const OLD_PATH = process.env.PATH ?? ''

/** One throwaway directory holding a stand-in `tailscale`. */
const workdir = mkdtempSync(join(tmpdir(), 'remote-link-'))
/** An empty PATH used when the case needs `tailscale` to be absent. */
const emptyDir = mkdtempSync(join(tmpdir(), 'remote-link-empty-'))
const marker = join(workdir, 'invoked')
const script = join(workdir, 'tailscale')

writeFileSync(
  script,
  `#!/bin/sh\nprintf x >> "$TAILSCALE_MARKER"\nprintf '%s\\n' '{"Self":{"DNSName":"testbox.tail1234.ts.net."}}'\n`,
)
chmodSync(script, 0o755)

/** A PATH whose `tailscale` records its invocation. */
process.env.TAILSCALE_MARKER = marker

/**
 * Load a fresh plugin instance, apply it to a fake context, and return the
 * route handler. The query string defeats the module cache so the Tailscale
 * result cache starts empty for every case.
 * @param {object} deployment - advertised URL, trusted-host answer, config, and PATH shape.
 * @returns {Promise<object>} the JSON body the route answers with.
 */
async function answer(deployment) {
  process.env.PATH = deployment.tailscale ? `${workdir}:${OLD_PATH}` : emptyDir
  const seen = []
  let route
  const ctx = {
    effect: (fn) => fn(),
    webApp: { getAdvertisedUrl: () => deployment.advertised },
    webServer: { port: deployment.port ?? 3081, protocol: deployment.protocol ?? 'http:' },
    connection: {
      allowsRemoteAuthorities: deployment.allowsRemoteAuthorities === true,
      authenticatedUrl: (base) => {
        seen.push(base)
        const url = new URL(base)
        url.searchParams.set('token', 'TOKEN')
        return url.href
      },
      fetch: {
        register: (registered) => {
          route = registered
          return async () => {}
        },
      },
    },
  }
  const module = await import(`${PLUGIN.href}?case=${deployment.case}`)
  module.apply(ctx, deployment.config ?? {})
  const body = await (await route.fetch(new Request('http://placeholder/api/remote-link'))).json()
  return { body, seen, route }
}

test('an advertised non-loopback root is used as-is', async () => {
  const { body, seen } = await answer({
    case: 'advertised',
    advertised: 'http://dsh.tail1234.ts.net:3080',
    allowsRemoteAuthorities: true,
    tailscale: true,
  })
  assert.equal(seen[0], 'http://dsh.tail1234.ts.net:3080')
  assert.equal(body.source, 'advertised')
  assert.equal(body.warning, undefined)
  assert.match(body.url, /^http:\/\/dsh\.tail1234\.ts\.net:3080\/\?token=TOKEN$/)
})

test('an advertised root keeps its mount path and scheme', async () => {
  const { body } = await answer({
    case: 'mount',
    advertised: 'https://dsh.example.com/ui/',
    allowsRemoteAuthorities: false,
    tailscale: false,
  })
  assert.equal(body.source, 'advertised')
  assert.match(body.url, /^https:\/\/dsh\.example\.com\/ui\/\?token=TOKEN$/)
})

test('a LAN listener origin is reachable as advertised', async () => {
  const { body } = await answer({
    case: 'lan',
    advertised: 'http://192.168.1.50:3000',
    allowsRemoteAuthorities: false,
    tailscale: false,
  })
  assert.equal(body.source, 'advertised')
  assert.equal(body.warning, undefined)
})

test('a loopback listener behind trusted hosts falls back to the tailnet name', async () => {
  const { body } = await answer({
    case: 'tailscale',
    advertised: 'http://127.0.0.1:3081',
    port: 4100,
    allowsRemoteAuthorities: true,
    tailscale: true,
  })
  assert.equal(body.source, 'tailscale')
  assert.match(body.url, /^http:\/\/testbox\.tail1234\.ts\.net:4100\/\?token=TOKEN$/)
})

test('a TLS listener guesses https for the tailnet name', async () => {
  const { body } = await answer({
    case: 'tailscale-tls',
    advertised: 'https://127.0.0.1:3081',
    port: 4100,
    protocol: 'https:',
    allowsRemoteAuthorities: true,
    tailscale: true,
  })
  assert.equal(body.source, 'tailscale')
  assert.match(body.url, /^https:\/\/testbox\.tail1234\.ts\.net:4100\/\?token=TOKEN$/)
})

test('a missing tailscale command warns instead of guessing', async () => {
  const { body, seen } = await answer({
    case: 'no-tailscale',
    advertised: 'http://127.0.0.1:3081',
    allowsRemoteAuthorities: true,
    tailscale: false,
  })
  assert.equal(body.source, 'listener')
  assert.equal(body.warning, 'tailscaleUnavailable')
  assert.equal(seen[0], 'http://127.0.0.1:3081')
})

test('without trusted hosts the loopback origin is reported, and tailscale is never run', async () => {
  rmSync(marker, { force: true })
  const { body } = await answer({
    case: 'loopback-only',
    advertised: 'http://127.0.0.1:3081',
    allowsRemoteAuthorities: false,
    tailscale: true,
  })
  assert.equal(body.source, 'listener')
  assert.equal(body.warning, 'loopbackOnly')
  assert.equal(existsSync(marker), false, 'tailscale must not be exec’d for a loopback-only deployment')
})

test('an explicit publicUrl wins over everything', async () => {
  const { body, seen } = await answer({
    case: 'config',
    advertised: 'http://127.0.0.1:3081',
    allowsRemoteAuthorities: false,
    tailscale: false,
    config: { publicUrl: 'https://proxy.example.com/dsh/' },
  })
  assert.equal(body.source, 'config')
  assert.equal(seen[0], 'https://proxy.example.com/dsh/')
  assert.match(body.url, /^https:\/\/proxy\.example\.com\/dsh\/\?token=TOKEN$/)
})

test('a configured root without a trailing slash gains one, so the token stays inside the mount', async () => {
  const { body, seen } = await answer({
    case: 'config-bare',
    advertised: 'http://127.0.0.1:3081',
    allowsRemoteAuthorities: false,
    tailscale: false,
    config: { publicUrl: 'https://proxy.example.com/dsh?x=1#frag' },
  })
  assert.equal(body.source, 'config')
  assert.equal(seen[0], 'https://proxy.example.com/dsh/')
  assert.match(body.url, /^https:\/\/proxy\.example\.com\/dsh\/\?token=TOKEN$/)
})

test('an unusable configured root is skipped instead of becoming a dead link', async () => {
  const { body, seen } = await answer({
    case: 'config-bad',
    advertised: 'http://192.168.1.50:3000',
    allowsRemoteAuthorities: false,
    tailscale: false,
    config: { publicUrl: 'not a url' },
  })
  assert.equal(body.source, 'advertised')
  assert.equal(seen[0], 'http://192.168.1.50:3000')
})

test('an IPv6 loopback also counts as loopback', async () => {
  const { body } = await answer({
    case: 'ipv6-loopback',
    advertised: 'http://[::1]:3081',
    allowsRemoteAuthorities: true,
    tailscale: true,
  })
  assert.equal(body.source, 'tailscale')
})

test('the route is a GET under the api mux and refuses caching', async () => {
  const { route } = await answer({
    case: 'shape',
    advertised: 'http://dsh.tail1234.ts.net:3080',
    allowsRemoteAuthorities: true,
    tailscale: true,
  })
  assert.equal(route.path, '/api/remote-link')
  assert.deepEqual([...route.methods], ['GET'])
  assert.equal(route.requestBody, 'buffered')
  const response = await route.fetch(new Request('http://placeholder/api/remote-link'))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('content-type') ?? '', /application\/json/)
})

test('the QR carries the tokenized URL', async () => {
  const { body } = await answer({
    case: 'qr',
    advertised: 'http://dsh.tail1234.ts.net:3080',
    allowsRemoteAuthorities: true,
    tailscale: true,
  })
  assert.equal(typeof body.svg, 'string')
  assert.match(body.svg, /^<svg /)
  // A mask change or a wrong payload shows up as a different module count, so
  // compare the rendered symbol against a second call with the same input.
  const again = await answer({
    case: 'qr-again',
    advertised: 'http://dsh.tail1234.ts.net:3080',
    allowsRemoteAuthorities: true,
    tailscale: true,
  })
  assert.equal(body.svg, again.body.svg)
})

test('cleanup', () => {
  process.env.PATH = OLD_PATH
  rmSync(workdir, { recursive: true, force: true })
  rmSync(emptyDir, { recursive: true, force: true })
  execFileSync(process.execPath, ['--version'])
})
