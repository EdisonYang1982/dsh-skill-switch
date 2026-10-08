/**
 * Shared-stream tests.
 *
 * The event stream is one per page, not one per session, and carries no session
 * identity. These assertions lock the two properties that make that safe:
 * a frame reaches every subscriber, and a change made in one session never
 * leaks into another's state.
 */
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '../lib/index.js'

let pass = 0, fail = 0
const failures = []
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log('  ok  ', label) }
  else { fail++; failures.push(label); console.log('  FAIL', label, '\n        got ', a, '\n        want', e) }
}

const CATALOG = ['jxh', 'video-diag'].map((name) => ({
  name, description: `${name} skill.`,
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'custom', provider: 'p', content: `# ${name}`,
}))

const routes = new Map()
const ctx = new Context()
ctx.provide('skills', {
  async snapshot() { return { skills: CATALOG, complete: true } },
  async list() { return CATALOG },
  async get(n) { return CATALOG.find((s) => s.name === n) },
})
ctx.provide('tools', { register() { return () => {} }, get() { return undefined } })
ctx.provide('agents', { get() { return undefined } })
ctx.provide('webServer', { register(r) { routes.set(r.path, r); return () => {} } })

apply(ctx, Config({ defaultMode: 'all' }))
await new Promise((r) => setTimeout(r, 30))

/** Open one SSE stream and collect the frames it receives. */
function openStream() {
  const frames = []
  const route = routes.get('/skill-switch/events')
  let onClose = null
  const res = {
    writeHead() {},
    write(chunk) { frames.push(chunk) },
    on(event, fn) { if (event === 'close') onClose = fn },
  }
  route.handler({ method: 'GET', url: '/skill-switch/events', on() {} }, res)
  return { frames, close: () => onClose?.() }
}

async function post(path, body) {
  const route = routes.get(path)
  let status = 0, payload = null
  await new Promise((resolve) => {
    void route.handler(
      { method: 'POST', url: path, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } },
      { writeHead(s) { status = s }, end(d) { if (typeof d === 'string') payload = JSON.parse(d); resolve() } },
    )
  })
  return { status, payload }
}

async function state(sessionId) {
  const route = routes.get('/skill-switch/state')
  let payload = null
  await new Promise((resolve) => {
    void route.handler(
      { method: 'GET', url: `/skill-switch/state?sessionId=${sessionId}` },
      { writeHead() {}, end(d) { payload = JSON.parse(d); resolve() } },
    )
  })
  return payload
}

console.log('=== the stream opens without a session id ===')
const stream = openStream()
check('connected frame arrives', stream.frames[0], ': connected\n\n')

console.log('\n=== a change in one session reaches the stream ===')
await post('/skill-switch/toggle', { sessionId: 's1', skill: 'jxh' })
check('a changed frame was pushed', stream.frames.some((f) => f.includes('event: changed')), true)

console.log('\n=== session isolation survives a shared stream ===')
const s1 = await state('s1')
const s2 = await state('s2')
check('s1 turned jxh off', s1.skills.find((s) => s.name === 'jxh').enabled, false)
check('s2 is untouched', s2.skills.find((s) => s.name === 'jxh').enabled, true)

console.log('\n=== every subscriber receives the frame ===')
const second = openStream()
await post('/skill-switch/mode', { sessionId: 's2', mode: 'none' })
check('first stream got it', stream.frames.filter((f) => f.includes('changed')).length >= 2, true)
check('second stream got it too', second.frames.some((f) => f.includes('changed')), true)

console.log('\n=== a closed stream stops receiving ===')
second.close()
const before = stream.frames.length
await post('/skill-switch/mode', { sessionId: 's2', mode: 'all' })
check('closed stream is silent', second.frames.filter((f) => f.includes('changed')).length, 1)
check('open stream still receives', stream.frames.length > before, true)

console.log(`\n${pass} passed, ${fail} failed`)
if (failures.length) console.log('failures:', failures.join('; '))
process.exit(fail === 0 ? 0 : 1)
