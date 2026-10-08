/**
 * Behavior integration: drive the plugin through a real cordis Context with
 * mock services, and assert the observable contract:
 *  - the session-scoped `skill` tool mounts on agent/created
 *  - the catalog injection reflects the session's enabled set
 *  - HTTP routes read and mutate that state
 *  - switching everything off unmounts the tool registration
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
function ok(label, cond) { check(label, !!cond, true) }

const CATALOG = [
  { name: 'skill-a', description: 'Skill A', invocation: { modelInvocable: true, userInvocable: true }, source: 'fs', provider: 'filesystem' },
  { name: 'skill-b', description: 'Skill B', invocation: { modelInvocable: true, userInvocable: true }, source: 'fs', provider: 'filesystem' },
  { name: 'skill-c', description: 'Skill C', invocation: { modelInvocable: true, userInvocable: true }, source: 'fs', provider: 'filesystem' },
  { name: 'not-model', description: 'user only', invocation: { modelInvocable: false, userInvocable: true }, source: 'fs', provider: 'filesystem' },
]

/** A mock host: services, scoped tool tables, and route capture. */
function makeHost() {
  const globalTools = new Map()
  const scopedTools = new Map()
  const agents = new Map()
  const routes = new Map()

  const tools = {
    register(def) {
      const scope = tools.__currentScope
      const table = scope === undefined ? globalTools : (scopedTools.get(scope) ?? new Map())
      if (scope !== undefined) scopedTools.set(scope, table)
      table.set(def.name, def)
      return () => { table.delete(def.name) }
    },
    get(name, scope) {
      const id = typeof scope === 'string' ? scope : scope?.id
      const table = id === undefined ? globalTools : (scopedTools.get(id) ?? new Map())
      return table.get(name)
    },
    __currentScope: undefined,
  }

  const skills = {
    async snapshot() { return { skills: CATALOG, complete: true } },
    async list() { return CATALOG },
    async get(name) { return CATALOG.find((s) => s.name === name) },
  }

  const agentsSvc = { get(id) { return agents.get(id) } }

  const webServer = {
    register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
  }

  return { tools, skills, agentsSvc, agents, webServer, routes, globalTools, scopedTools }
}

/** Build a scoped agent whose ctx routes tool registrations to its own table. */
function makeAgent(host, id) {
  const agentCtx = new Context()
  agentCtx.provide('tools', {
    register(def) {
      const table = host.scopedTools.get(id) ?? new Map()
      host.scopedTools.set(id, table)
      table.set(def.name, def)
      return () => { table.delete(def.name) }
    },
    get(name) { return (host.scopedTools.get(id) ?? new Map()).get(name) },
  })
  const listeners = []
  agentCtx.on = ((orig) => function (event, handler) {
    listeners.push([event, handler])
    return orig.call(this, event, handler)
  })(agentCtx.on.bind(agentCtx))

  const agent = {
    id,
    ctx: agentCtx,
    session: { header: { cwd: '/tmp' }, surface: { nodes: [] }, events: [] },
  }
  host.agents.set(id, agent)
  return agent
}

/** Fire agent/pre-step and return the decision. */
async function preStep(agent, decision = { kind: 'enter', messages: [] }) {
  const handlers = []
  const origOn = agent.ctx.on.bind(agent.ctx)
  // Collect the plugin's pre-step handler by re-emitting through the real emitter.
  let result = decision
  await new Promise((resolve) => {
    const dispose = agent.ctx.on('agent/pre-step', async (payload, next) => {
      result = await payload.__handler(payload, next)
      resolve()
      return result
    })
    setTimeout(resolve, 50)
    dispose()
  })
  return result
}

console.log('=== setting up host ===')
const host = makeHost()
const ctx = new Context()
ctx.provide('skills', host.skills)
ctx.provide('tools', host.tools)
ctx.provide('agents', host.agentsSvc)
ctx.provide('webServer', host.webServer)

console.log('\n--- plugin apply ---')
apply(ctx, Config({ defaultMode: 'all' }))
// ctx.inject() activates through a fiber, so route registration settles on a
// later microtask rather than synchronously inside apply().
await new Promise((r) => setTimeout(r, 30))
ok('registers the state route', host.routes.has('/skill-switch/state'))
ok('registers the toggle route', host.routes.has('/skill-switch/toggle'))
ok('registers the mode route', host.routes.has('/skill-switch/mode'))
ok('registers the SSE events route', host.routes.has('/skill-switch/events'))
ok('registers the sync route', host.routes.has('/skill-switch/sync'))
ok('registers the group route', host.routes.has('/skill-switch/group'))
check('exactly six routes', host.routes.size, 6)

console.log('\n--- agent/created mounts the session tool ---')
const agent = makeAgent(host, 'sess-1')
ctx.emit('agent/created', { agent, source: 'startup' })
await new Promise((r) => setTimeout(r, 20))
ok('session-scoped skill tool is registered', host.scopedTools.get('sess-1')?.has('skill'))
check('no global skill tool leaked', host.globalTools.has('skill'), false)

console.log('\n--- HTTP: state route ---')
async function callRoute(path, { method = 'GET', url, body } = {}) {
  const route = host.routes.get(path)
  let status = 0, payload = null
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const res = {
    writeHead(s) { status = s },
    end(data) {
      if (typeof data === 'string') payload = JSON.parse(data)
      settle()
    },
  }
  // The handler is fire-and-forget (`void (async () => …)()`), so await the
  // response rather than the handler's own (immediately resolved) promise.
  await route.handler(
    { method, url: url ?? path, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) } },
    res,
  )
  await done
  return { status, payload }
}

const s1 = await callRoute('/skill-switch/state', { url: '/skill-switch/state?sessionId=sess-1' })
check('state returns 200', s1.status, 200)
check('state lists only model-invocable skills', s1.payload.skills.map((r) => r.name), ['skill-a', 'skill-b', 'skill-c'])
check('default posture enables all', s1.payload.skills.map((r) => r.enabled), [true, true, true])
check('state echoes the mode', s1.payload.mode, 'all')

const missing = await callRoute('/skill-switch/state', { url: '/skill-switch/state' })
check('state without sessionId is 400', missing.status, 400)

console.log('\n--- HTTP: toggle one skill off ---')
const t1 = await callRoute('/skill-switch/toggle', {
  method: 'POST', url: '/skill-switch/toggle',
  body: { sessionId: 'sess-1', skill: 'skill-b' },
})
check('toggle returns 200', t1.status, 200)
check('skill-b is now off', t1.payload.skills.find((r) => r.name === 'skill-b').enabled, false)
check('skill-a stays on', t1.payload.skills.find((r) => r.name === 'skill-a').enabled, true)
check('mode stays all after a partial toggle', t1.payload.mode, 'all')

const t1b = await callRoute('/skill-switch/toggle', {
  method: 'POST', url: '/skill-switch/toggle',
  body: { sessionId: 'sess-1', skill: 'skill-b' },
})
check('toggling again turns it back on', t1b.payload.skills.find((r) => r.name === 'skill-b').enabled, true)

console.log('\n--- HTTP: chat mode (none) ---')
const m1 = await callRoute('/skill-switch/mode', {
  method: 'POST', url: '/skill-switch/mode',
  body: { sessionId: 'sess-1', mode: 'none' },
})
check('none disables every skill', m1.payload.skills.map((r) => r.enabled), [false, false, false])
check('mode is none', m1.payload.mode, 'none')
check('skill tool is unmounted in chat mode', host.scopedTools.get('sess-1')?.has('skill'), false)

console.log('\n--- HTTP: work mode ---')
const host2 = makeHost()
const ctx2 = new Context()
ctx2.provide('skills', host2.skills)
ctx2.provide('tools', host2.tools)
ctx2.provide('agents', host2.agentsSvc)
ctx2.provide('webServer', host2.webServer)
apply(ctx2, Config({ defaultMode: 'all', workSkills: ['skill-b'] }))
await new Promise((r) => setTimeout(r, 30))
const agent2 = makeAgent(host2, 'sess-2')
ctx2.emit('agent/created', { agent: agent2, source: 'startup' })
await new Promise((r) => setTimeout(r, 20))
const route2 = host2.routes.get('/skill-switch/mode')
let m2payload = null
await new Promise((resolve) => {
  void route2.handler(
    { method: 'POST', url: '/skill-switch/mode', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: 'sess-2', mode: 'work' })) } },
    { writeHead() {}, end(d) { m2payload = JSON.parse(d); resolve() } },
  )
})
check('work keeps only the allowlist', m2payload.skills.filter((r) => r.enabled).map((r) => r.name), ['skill-b'])
check('work mode recorded', m2payload.mode, 'work')

console.log('\n--- HTTP: rejects bad input ---')
const badMode = await callRoute('/skill-switch/mode', {
  method: 'POST', url: '/skill-switch/mode', body: { sessionId: 'sess-1', mode: 'bogus' },
})
check('invalid mode is 400', badMode.status, 400)
const badToggle = await callRoute('/skill-switch/toggle', {
  method: 'POST', url: '/skill-switch/toggle', body: { sessionId: 'sess-1' },
})
check('toggle without skill is 400', badToggle.status, 400)
const getToggle = await callRoute('/skill-switch/toggle', { method: 'GET', url: '/skill-switch/toggle' })
check('GET on toggle is 405', getToggle.status, 405)

console.log('\n--- agent/disposed cleans up ---')
ctx.emit('agent/disposed', { agent })
await new Promise((r) => setTimeout(r, 20))
const afterDispose = await callRoute('/skill-switch/state', { url: '/skill-switch/state?sessionId=sess-1' })
check('disposed session falls back to defaults', afterDispose.payload.mode, 'all')
check('disposed session re-enables all', afterDispose.payload.skills.map((r) => r.enabled), [true, true, true])

console.log(`\n${pass} passed, ${fail} failed`)
if (failures.length) console.log('failures:', failures.join('; '))
process.exit(fail === 0 ? 0 : 1)
