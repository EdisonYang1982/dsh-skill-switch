/**
 * Verify the load-bearing assumption: calling tools.register() through an
 * agent's ctx files the tool into that agent's SCOPE layer, not globally.
 *
 * The real ToolRuntime extends cordis's Service, whose `ctx` property carries
 * a tracker that rebinds `this.ctx` to the CALLING context on every method
 * invocation. A plain mock object cannot reproduce that, so this test uses the
 * real Service base class.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'

class FakeTools extends Service {
  registrations = []
  constructor(ctx) { super(ctx, 'tools') }
  register(name) {
    // Mirrors ToolRuntime.register: the scope is read off the CALLING ctx.
    const scope = scopeOf(this.ctx)
    this.registrations.push({ name, scope: scope === undefined ? 'global' : 'scoped' })
    return () => {}
  }
}

const root = new Context()
new FakeTools(root)
const tools = root.get('tools')

// Host-level registration: unscoped caller -> global layer.
tools.register('host-tool')

// Agent-scoped registration: createScope mints a scoped context whose
// registrations belong to that agent's layer.
const agentKey = {}
const scope = createScope(root, agentKey)
scope.ctx.get('tools').register('agent-tool')

console.log('registrations:', JSON.stringify(tools.registrations))
const globalCount = tools.registrations.filter((r) => r.scope === 'global').length
const scopedCount = tools.registrations.filter((r) => r.scope === 'scoped').length
console.log(`global=${globalCount} scoped=${scopedCount}`)
if (globalCount === 1 && scopedCount === 1) {
  console.log('PASS: agent.ctx registration lands in the agent scope, not the global one')
  process.exit(0)
}
console.log('FAIL: scope routing did not behave as expected')
process.exit(1)
