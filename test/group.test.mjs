/**
 * Skill-group tests: an all-or-nothing bundle mounted by moving directories
 * must move EXACTLY its own members — never the unrelated skills that share the
 * hub. That containment is the whole safety property of the feature, so it gets
 * its own suite with a real temporary filesystem.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'

let pass = 0, fail = 0
const failures = []
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log('  ok  ', label) }
  else { fail++; failures.push(label); console.log('  FAIL', label, '\n        got ', a, '\n        want', e) }
}

// ── fixture: a hub with unrelated skills + a park directory with a family ───
const ROOT = '/tmp/dss-group-test'
rmSync(ROOT, { recursive: true, force: true })
const HUB = join(ROOT, 'skills')
const PARK = join(ROOT, 'parked')
mkdirSync(HUB, { recursive: true })
mkdirSync(PARK, { recursive: true })

const writeSkill = (dir, name) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill.\n---\n# ${name}\n`)
}
// Unrelated skills already in the hub — these must never move.
for (const name of ['unrelated-a', 'unrelated-b', 'skill-park']) writeSkill(join(HUB, name), name)
// The family, parked.
const FAMILY = ['fam-one', 'fam-two', 'fam-shared']
for (const name of FAMILY) writeSkill(join(PARK, name), name)

const CATALOG = [...FAMILY, 'unrelated-a', 'unrelated-b', 'skill-park'].map((name) => ({
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

apply(ctx, Config({
  defaultMode: 'all',
  hubDir: HUB,
  skillGroups: [{ id: 'fam', label: 'Family', parkDir: PARK, discover: true }],
}))
await new Promise((r) => setTimeout(r, 30))

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
async function state() {
  const route = routes.get('/skill-switch/state')
  let payload = null
  await new Promise((resolve) => {
    void route.handler(
      { method: 'GET', url: '/skill-switch/state?sessionId=s1' },
      { writeHead() {}, end(d) { payload = JSON.parse(d); resolve() } },
    )
  })
  return payload
}
const inHub = () => readdirSync(HUB).filter((n) => !n.startsWith('.')).sort()
const inPark = () => readdirSync(PARK).filter((n) => !n.startsWith('.')).sort()

console.log('=== initial state ===')
let st = await state()
check('group starts unmounted', st.groups[0].mounted, false)
check('group reports its full roster', st.groups[0].memberCount, 3)
check('hub holds only the unrelated skills', inHub(), ['skill-park', 'unrelated-a', 'unrelated-b'])
check('park holds the family', inPark(), ['fam-one', 'fam-shared', 'fam-two'])

console.log('\n=== mount ===')
let r = await post('/skill-switch/group', { sessionId: 's1', group: 'fam', mounted: true })
check('mount returns 200', r.status, 200)
check('mount moved exactly the family', r.payload.moved.sort(), ['fam-one', 'fam-shared', 'fam-two'])
check('group now reports mounted', r.payload.groups[0].mounted, true)
check('unrelated skills did NOT move into the park', inPark(), [])
check('hub gained the family', inHub(), ['fam-one', 'fam-shared', 'fam-two', 'skill-park', 'unrelated-a', 'unrelated-b'])

console.log('\n=== mount is idempotent ===')
r = await post('/skill-switch/group', { sessionId: 's1', group: 'fam', mounted: true })
check('a second mount moves nothing', r.payload.moved, [])
check('unrelated skills still untouched', inHub().filter((n) => n.startsWith('unrelated')).sort(), ['unrelated-a', 'unrelated-b'])

console.log('\n=== unmount (the containment case) ===')
r = await post('/skill-switch/group', { sessionId: 's1', group: 'fam', mounted: false })
check('unmount moved exactly the family', r.payload.moved.sort(), ['fam-one', 'fam-shared', 'fam-two'])
check('group reports unmounted', r.payload.groups[0].mounted, false)
check('unrelated skills are STILL in the hub', inHub(), ['skill-park', 'unrelated-a', 'unrelated-b'])
check('park holds the family again', inPark(), ['fam-one', 'fam-shared', 'fam-two'])

console.log('\n=== unknown group is rejected ===')
r = await post('/skill-switch/group', { sessionId: 's1', group: 'nope', mounted: true })
check('unknown group is 404', r.status, 404)
r = await post('/skill-switch/group', { sessionId: 's1', group: 'fam' })
check('missing mounted flag is 400', r.status, 400)

console.log('\n=== mount again, then unmount after a "restart" ===')
await post('/skill-switch/group', { sessionId: 's1', group: 'fam', mounted: true })
check('roster file was written', existsSync(join(PARK, '.members')), true)
// A fresh context simulates a host restart: only the roster file persists.
const routes2 = new Map()
const ctx2 = new Context()
ctx2.provide('skills', { async snapshot() { return { skills: CATALOG, complete: true } }, async list() { return CATALOG }, async get(n) { return CATALOG.find((s) => s.name === n) } })
ctx2.provide('tools', { register() { return () => {} }, get() { return undefined } })
ctx2.provide('agents', { get() { return undefined } })
ctx2.provide('webServer', { register(rt) { routes2.set(rt.path, rt); return () => {} } })
apply(ctx2, Config({ defaultMode: 'all', hubDir: HUB, skillGroups: [{ id: 'fam', label: 'Family', parkDir: PARK, discover: true }] }))
await new Promise((rt) => setTimeout(rt, 30))
const route2 = routes2.get('/skill-switch/state')
let after = null
await new Promise((resolve) => {
  void route2.handler({ method: 'GET', url: '/skill-switch/state?sessionId=s2' }, { writeHead() {}, end(d) { after = JSON.parse(d); resolve() } })
})
check('after restart the group still reports mounted', after.groups[0].mounted, true)
check('after restart the roster survives', after.groups[0].memberCount, 3)

console.log(`\n${pass} passed, ${fail} failed`)
if (failures.length) console.log('failures:', failures.join('; '))
rmSync(ROOT, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
