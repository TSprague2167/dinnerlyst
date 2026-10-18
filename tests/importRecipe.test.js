import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'rolldown/experimental'
import { createClient } from '@supabase/supabase-js'

// Run the actual Edge handler with the real Supabase SDK and mocked HTTP/env/timers.
// No requests leave this process and no real secrets are read.
const source = readFileSync(new URL('../supabase/functions/import-recipe/index.ts', import.meta.url), 'utf8')
  .replace(/^import .*\n/, '')
const code = transformSync('index.ts', source).code
const validToken = 'signed.user.token'
const testSecret = 'TEST_SCRAPER_SECRET_DO_NOT_EXPOSE'
const html = value => `<script type="application/ld+json">${JSON.stringify(value)}</script>`
const recipeData = { '@type': 'Recipe', name: 'Rice supper', recipeIngredient: ['Rice', 'Salt'],
  recipeInstructions: [{ '@type': 'HowToSection', itemListElement: [{ text: 'Cook rice.' }] }],
  image: [{ url: 'https://example.com/rice.jpg' }], recipeCategory: ['Dinner'] }

function edgeHarness({ provider = () => new Response(html(recipeData)), auth, env = {}, envGet } = {}) {
  const calls = [], logs = [], timers = new Map(), cleared = []
  let handler, nextTimer = 0
  const values = { SUPABASE_URL: 'https://project.example', SUPABASE_ANON_KEY: 'test-public-key', SCRAPINGBEE_API_KEY: testSecret, ...env }
  const fetchMock = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url || String(input))
    calls.push({ url, init })
    if (url.pathname === '/auth/v1/user') {
      if (auth) return auth(input, init)
      const valid = new Headers(init.headers).get('authorization') === `Bearer ${validToken}`
      return new Response(JSON.stringify(valid ? { id: 'user-a', role: 'authenticated', is_anonymous: false } :
        { message: `Rejected token ${testSecret}`, error_code: 'bad_jwt' }), { status: valid ? 200 : 401, headers: { 'Content-Type': 'application/json' } })
    }
    assert.equal(url.origin, 'https://app.scrapingbee.com')
    return provider(input, init)
  }
  new Function('createClient', 'Deno', 'fetch', 'console', 'setTimeout', 'clearTimeout', code)(
    createClient, { env: { get: envGet || (key => values[key]) }, serve: value => { handler = value } }, fetchMock,
    { error: (...args) => logs.push(args) },
    (callback, ms) => { const id = ++nextTimer; timers.set(id, { callback, ms }); return id },
    id => { cleared.push(id); timers.delete(id) },
  )
  return { calls, logs, timers, cleared, handler,
    paid: () => calls.filter(call => call.url.hostname === 'app.scrapingbee.com'),
    request: (body = { url: 'https://example.com/recipe' }, token = validToken, method = 'POST') => handler(new Request('https://edge.example/import-recipe', {
      method, headers: token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    })),
  }
}
async function waitFor(condition) {
  for (let i = 0; i < 20 && !condition(); i++) await new Promise(resolve => setImmediate(resolve))
  assert.ok(condition(), 'expected async request stage')
}
async function safeFailure(edge, response, status) {
  assert.equal(response.status, status)
  const body = await response.text()
  assert.equal(body.includes(testSecret), false)
  assert.equal(JSON.stringify(edge.logs).includes(testSecret), false)
  assert.equal(edge.timers.size, 0, 'deadline must be cleaned up')
  assert.ok(body.includes('error'))
}

test('missing/malformed/public-key/invalid/expired credentials cannot reach the paid request', async () => {
  for (const token of [null, '', 'not-a-jwt', 'sb_publishable_test', 'legacy.anon.key', 'expired.user.token', 'invalid.user.token']) {
    const edge = edgeHarness()
    await safeFailure(edge, await edge.request(undefined, token), 401)
    assert.equal(edge.paid().length, 0)
  }
  for (const user of [{ id: 'anon', role: 'anon' }, { id: 'anonymous', role: 'authenticated', is_anonymous: true }, {}]) {
    const edge = edgeHarness({ auth: () => new Response(JSON.stringify(user), { status: 200 }) })
    await safeFailure(edge, await edge.request(), 401)
    assert.equal(edge.paid().length, 0)
  }
})

test('authenticated import verifies user before ScrapingBee and preserves JSON-LD extraction', async () => {
  const edge = edgeHarness({ provider: () => new Response('<script type="application/ld+json">broken</script>' +
    html({ '@graph': [{ '@type': 'WebPage' }, { ...recipeData, '@type': ['Recipe'] }] })) })
  const result = await edge.request()
  assert.equal(result.status, 200)
  assert.equal(edge.calls[0].url.pathname, '/auth/v1/user')
  assert.equal(new Headers(edge.calls[0].init.headers).get('authorization'), `Bearer ${validToken}`)
  assert.equal(edge.paid().length, 1)
  assert.equal(edge.paid()[0].url.searchParams.get('timeout'), '25000')
  assert.equal(edge.paid()[0].url.searchParams.get('render_js'), 'false')
  assert.ok(edge.paid()[0].init.signal instanceof AbortSignal)
  assert.deepEqual(await result.json(), { name: 'Rice supper', ingredients: ['Rice', 'Salt'], instructions: ['Cook rice.'],
    image: 'https://example.com/rice.jpg', category: 'Dinner', sourceUrl: 'https://example.com/recipe' })
  assert.equal(edge.timers.size, 0)
})

test('OPTIONS is free and unsupported methods are rejected without authentication or scraping', async () => {
  const edge = edgeHarness()
  const preflight = await edge.request(undefined, null, 'OPTIONS')
  assert.equal(preflight.status, 200)
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS')
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const response = await edge.request(undefined, validToken, method)
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'POST, OPTIONS')
  }
  assert.equal(edge.calls.length, 0)
})

test('invalid input and obvious local targets are rejected before paid requests', async () => {
  const invalid = [null, {}, { url: 3 }, { url: [] }, { url: '' }, { url: 'x'.repeat(4097) }, 'not json',
    ...['not a URL', 'file:///etc/passwd', 'ftp://example.com', 'https://u:p@example.com',
      'http://localhost', 'http://x.localhost', 'http://localhost.', 'http://printer', 'http://x.local', 'http://x.internal',
      'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://10.0.0.1', 'http://172.16.0.1',
      'http://192.168.1.1', 'http://169.254.169.254', 'http://100.64.1.1', 'http://0.0.0.0',
      'http://[::1]', 'http://[::ffff:127.0.0.1]'].map(url => ({ url }))]
  for (const body of invalid) {
    const edge = edgeHarness()
    await safeFailure(edge, await edge.request(body), 400)
    assert.equal(edge.paid().length, 0)
  }
  const edge = edgeHarness()
  await safeFailure(edge, await edge.request(JSON.stringify({ url: 'https://example.com', junk: 'x'.repeat(17000) })), 413)
  assert.equal(edge.paid().length, 0)
})

test('provider/network/configuration/unexpected errors never expose raw messages or secret URLs', async () => {
  for (const provider of [() => new Response('provider detail', { status: 503 }),
    () => { throw Error(`fetch https://app.scrapingbee.com/?api_key=${testSecret}`) },
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(testSecret)) } }))]) {
    const edge = edgeHarness({ provider })
    await safeFailure(edge, await edge.request(), 502)
  }
  const unexpected = edgeHarness({ envGet: () => { throw Error(testSecret) } })
  await safeFailure(unexpected, await unexpected.request(), 500)
  assert.equal(unexpected.paid().length, 0)
  for (const missing of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SCRAPINGBEE_API_KEY']) {
    const edge = edgeHarness({ env: { [missing]: '' } })
    await safeFailure(edge, await edge.request(), 500)
    assert.equal(edge.paid().length, 0)
  }
})

test('no structured recipe and malformed-only JSON-LD return controlled no-recipe errors', async () => {
  for (const content of ['<html>No recipe</html>', '<script type="application/ld+json">broken</script>']) {
    const edge = edgeHarness({ provider: () => new Response(content) })
    await safeFailure(edge, await edge.request(), 422)
  }
})

test('HTML limits reject declared and chunked oversized responses before parsing', async () => {
  let cancelled = false
  for (const provider of [() => new Response('small', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)) }, cancel() { cancelled = true } }))]) {
    const edge = edgeHarness({ provider })
    await safeFailure(edge, await edge.request(), 413)
  }
  assert.equal(cancelled, true)
})

test('deadline aborts stalled provider requests, response bodies, and authentication without leaking secrets', async () => {
  for (const stage of ['provider', 'body', 'auth']) {
    let cancelled = false
    const stalled = (_input, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error(testSecret)), { once: true }))
    const edge = edgeHarness(stage === 'auth' ? { auth: stalled } : { provider: stage === 'provider' ? stalled :
      () => new Response(new ReadableStream({ cancel() { cancelled = true } })) })
    const result = edge.request()
    await waitFor(() => stage === 'auth' ? edge.calls.length === 1 : edge.paid().length === 1)
    const deadline = [...edge.timers.values()][0]
    assert.equal(deadline.ms, 30000)
    deadline.callback()
    await safeFailure(edge, await result, 504)
    assert.equal(edge.calls.at(-1).init.signal.aborted, true)
    if (stage === 'body') assert.equal(cancelled, true)
    if (stage === 'auth') assert.equal(edge.paid().length, 0)
  }
})
