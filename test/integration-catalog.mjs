/**
 * Catalog injection test: drive agent/pre-step through the plugin's listener
 * and assert the injected catalog reflects the session's enabled set.
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

const CATALOG = [
  { name: 'skill-a', description: 'Skill A', invocation: { modelInvocable: true, userInvocable: true }, source: 'fs', provider: 'p', content: '# Skill A body' },
  { name: 'skill-b', description: 'Skill B', invocation: { modelInvocable: true, userInvocable: true }, source: 'fs', provider: 'p', content: '# Skill B body' },
  { name: 'skill-c', description: 'Skill C', invocation: { modelInvocable: true, userInvocable: true }, source: 'fs', provider: 'p', content: '# Skill C body' },
]

const host = {
  scopedTools: new Map(),
  routes: new Map(),
  agents: new Map(),
}
const ctx = new Context()
ctx.provide('skills', {
  async snapshot() { return { skills: CATALOG, complete: true } },
  async list() { return CATALOG },
  async get(n) { return CATALOG.find((s) => s.name === n) },
})
ctx.provide('tools', { register() { return () => {} }, get() { return undefined } })
ctx.provide('agents', { get: (id) => host.agents.get(id) })
ctx.provide('webServer', { register(r) { host.routes.set(r.path, r); return () => {} } })

apply(ctx, Config({ defaultMode: 'all' }))
await new Promise((r) => setTimeout(r, 30))

// A scoped agent context whose tool table the plugin can register into.
const agentCtx = new Context()
const table = new Map()
agentCtx.provide('tools', {
  register(def) { table.set(def.name, def); return () => table.delete(def.name) },
  get(name) { return table.get(name) },
})
const agent = {
  id: 'sess-cat',
  ctx: agentCtx,
  session: { header: { cwd: '/tmp' }, surface: { nodes: [] }, events: [] },
}
host.agents.set('sess-cat', agent)
ctx.emit('agent/created', { agent, source: 'startup' })
await new Promise((r) => setTimeout(r, 20))

/** Fire the plugin's agent/pre-step listener and capture the decision. */
async function runPreStep() {
  const payload = { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }
  // cordis waterfall: (name, payload, next) drives the listener chain and
  // returns the final decision.
  return await agentCtx.waterfall('agent/pre-step', payload, async () => ({ kind: 'enter', messages: [] }))
}

console.log('--- first pre-step publishes the full catalog ---')
let decision = await runPreStep()
check('decision enters', decision?.kind, 'enter')
check('one message injected', decision.messages.length, 1)
const text1 = decision.messages[0].content[0].text
check('source kind is skill-catalog', decision.messages[0].source.kind, 'skill-catalog')
check('catalog lists all three', decision.messages[0].source.entries.map((e) => e.name), ['skill-a', 'skill-b', 'skill-c'])
if (!text1.includes('<available_skills>')) { fail++; failures.push('catalog framing'); console.log('  FAIL catalog framing') }
else { pass++; console.log('  ok   catalog carries <available_skills> framing') }

// Simulate the published catalog being visible on the session surface.
agent.session.events.push({
  type: 'user/message',
  seq: 1,
  data: { source: decision.messages[0].source },
})
agent.session.surface.nodes.push(1)

console.log('\n--- unchanged catalog does not re-publish ---')
decision = await runPreStep()
check('no duplicate catalog appended', decision.messages.length, 0)

console.log('\n--- switching a skill off changes the catalog ---')
// Turn skill-b off via the host route.
const route = host.routes.get('/skill-switch/toggle')
let payload = null
await new Promise((resolve) => {
  void route.handler(
    { method: 'POST', url: '/skill-switch/toggle', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: 'sess-cat', skill: 'skill-b' })) } },
    { writeHead() {}, end(d) { payload = JSON.parse(d); resolve() } },
  )
})
check('route reports skill-b off', payload.skills.find((r) => r.name === 'skill-b').enabled, false)

decision = await runPreStep()
check('a replacement catalog is published', decision?.kind, 'enter')
check('replacement carries update flag', decision.messages[0]?.source?.update, true)
check('skill-b is gone from the catalog', decision.messages[0]?.source?.entries.map((e) => e.name), ['skill-a', 'skill-c'])
const text2 = decision.messages[0].content[0].text
if (text2.includes('skill-b')) { fail++; failures.push('skill-b still rendered'); console.log('  FAIL skill-b still rendered') }
else { pass++; console.log('  ok   skill-b absent from the rendered prose') }
if (!text2.includes('replaces every earlier available-skills list')) { fail++; failures.push('replacement wording'); console.log('  FAIL replacement wording') }
else { pass++; console.log('  ok   replacement message announces itself') }

// The model must not be able to load the switched-off skill.
console.log('\n--- the switched-off skill cannot be loaded ---')
const skillTool = table.get('skill')
let threw = null
try {
  await skillTool.execute({ name: 'skill-b' }, { agent, signal: new AbortController().signal, callId: 'c1', name: 'skill' })
} catch (e) { threw = e.message }
check('loading a switched-off skill throws', threw, 'skill "skill-b" is switched off in this session')

// A still-enabled skill loads normally.
const loaded = await skillTool.execute({ name: 'skill-a' }, { agent, signal: new AbortController().signal, callId: 'c2', name: 'skill' })
check('an enabled skill still loads', loaded.name, 'skill-a')
check('loaded content is the skill body', typeof loaded.content, 'string')

console.log('\n--- chat mode empties the catalog and unmounts the tool ---')
const modeRoute = host.routes.get('/skill-switch/mode')
await new Promise((resolve) => {
  void modeRoute.handler(
    { method: 'POST', url: '/skill-switch/mode', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId: 'sess-cat', mode: 'none' })) } },
    { writeHead() {}, end() { resolve() } },
  )
})
check('skill tool unmounted in chat mode', table.has('skill'), false)
decision = await runPreStep()
check('no catalog injected once the tool is unmounted', decision.messages.length, 0)

console.log(`\n${pass} passed, ${fail} failed`)
if (failures.length) console.log('failures:', failures.join('; '))
process.exit(fail === 0 ? 0 : 1)
