import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-notion-test-'))
process.env.HOME = home
const { makeRoutes } = await import('../src/routes.ts')
after(() => rmSync(home, { recursive: true, force: true }))

async function call(ctx, path, { method, address = '10.0.0.2', host = 'gateway.example', headers = {}, body = '{}' } = {}) {
  const req = Readable.from([Buffer.from(body)])
  req.method = method ?? (path === 'status' ? 'GET' : 'POST')
  req.socket = { remoteAddress: address }
  req.headers = { host, ...headers }
  let status, response
  const res = { writeHead(code) { status = code }, end(data) { response = JSON.parse(data) } }
  await makeRoutes(ctx).find(route => route.path.endsWith('/' + path)).handler(req, res)
  return { status, response }
}

test('all routes reject unpaired remote requests and accept paired requests', async () => {
  for (const path of ['status', 'token', 'clear']) {
    assert.equal((await call({}, path)).status, 403)
    assert.equal((await call({ get: name => name === 'remoteWebUiPairing' ? ({ isPairedDevice: () => false }) : undefined }, path)).status, 403)
    // An empty token returns 400 after authentication, without an external API call.
    assert.equal((await call({ get: name => name === 'remoteWebUiPairing' ? ({ isPairedDevice: () => true }) : undefined }, path)).status, path === 'token' ? 400 : 200)
  }
})

test('paired service is optional, resolved per request, and supports the context property fallback', async () => {
  const ctx = { remoteWebUiPairing: { isPairedDevice: req => req.headers.cookie === 'paired' } }
  assert.equal((await call(ctx, 'status')).status, 403)
  assert.equal((await call(ctx, 'status', { headers: { cookie: 'paired' } })).status, 200)
  assert.equal((await call({ get: () => ({}) }, 'status')).status, 403)
})

test('loopback and method checks remain enforced', async () => {
  const local = { address: '127.0.0.1', host: 'localhost:3080' }
  assert.equal((await call({}, 'status', local)).status, 200)
  assert.equal((await call({}, 'status', { ...local, host: 'gateway.example' })).status, 403)
  assert.equal((await call({}, 'status', { ...local, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await call({}, 'status', { ...local, headers: { origin: 'http://evil.example' } })).status, 403)
  assert.equal((await call({ get: name => name === 'remoteWebUiPairing' ? ({ isPairedDevice: () => true }) : undefined }, 'clear', { method: 'GET' })).status, 403)
})

test('paired device can save, inspect and clear a token', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.notion.com/v1/users/me')
    assert.equal(options.headers.Authorization, 'Bearer secret_test')
    return new Response(JSON.stringify({ bot: { workspace_name: 'Test workspace' } }), { status: 200 })
  }
  try {
    const ctx = { get: name => name === 'remoteWebUiPairing' ? ({ isPairedDevice: () => true }) : undefined }
    const saved = await call(ctx, 'token', { body: JSON.stringify({ token: 'secret_test' }) })
    assert.equal(saved.response.ok, true)
    const status = await call(ctx, 'status')
    assert.equal(status.response.configured, true)
    assert.equal(status.response.workspaceName, 'Test workspace')
    assert.equal((await call(ctx, 'clear')).response.ok, true)
    assert.equal((await call(ctx, 'status')).response.configured, false)
  } finally { globalThis.fetch = originalFetch }
})


test('missing optional service does not access an injected-only context property', async () => {
  const ctx = {
    get: () => undefined,
    get remoteWebUiPairing() { throw new Error('cannot access without inject') },
  }
  for (const path of ['status', 'token', 'clear']) {
    assert.equal((await call(ctx, path)).status, 403)
  }
  const propertyOnly = { get remoteWebUiPairing() { throw new Error('unavailable') } }
  assert.equal((await call(propertyOnly, 'status')).status, 403)
})


test('host connection admission controls all remote routes', async () => {
  for (const path of ['status', 'token', 'clear']) {
    for (const denial of [401, 403, null]) {
      const ctx = { get: name => name === 'connection' ? { requestRejection: () => denial } : undefined }
      assert.equal((await call(ctx, path)).status, 403)
    }
    let received
    const ctx = { get: name => name === 'connection' ? { requestRejection(req) { received = req; return undefined } } : undefined }
    assert.equal((await call(ctx, path)).status, path === 'token' ? 400 : 200)
    assert.equal(received.headers.host, 'gateway.example')
  }
})
