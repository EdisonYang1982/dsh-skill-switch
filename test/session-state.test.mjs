/** Unit tests for the session-state module's pure posture logic. */
import { applyMode, toRows, parseMode } from './state-region.mjs'

let pass = 0, fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass++; console.log('  ok  ', label) }
  else { fail++; console.log('  FAIL', label, '\n        got', a, '\n        want', e) }
}

const catalog = [
  { name: 'skill-a', description: 'A' },
  { name: 'skill-b', description: 'B' },
  { name: 'skill-c', description: 'C' },
]
const names = catalog.map((s) => s.name)

console.log('applyMode:')
const st = { mode: 'all', enabled: new Set() }
applyMode(st, 'all', [], names)
check('all enables every name', [...st.enabled].sort(), ['skill-a', 'skill-b', 'skill-c'])
applyMode(st, 'none', [], names)
check('none enables nothing', [...st.enabled], [])
check('none records the mode', st.mode, 'none')
applyMode(st, 'work', ['skill-b'], names)
check('work keeps only the allowlist', [...st.enabled], ['skill-b'])
applyMode(st, 'work', ['skill-b', 'ghost-skill'], names)
check('work drops a name absent from the catalog', [...st.enabled], ['skill-b'])
applyMode(st, 'work', [], names)
check('an empty work list enables nothing', [...st.enabled], [])

console.log('toRows:')
applyMode(st, 'work', ['skill-a', 'skill-c'], names)
check('rows preserve catalog order', toRows(catalog, st).map((r) => r.name), ['skill-a', 'skill-b', 'skill-c'])
check('rows flag the enabled state', toRows(catalog, st).map((r) => r.enabled), [true, false, true])
check('rows carry the description', toRows(catalog, st)[0].description, 'A')

console.log('isolation:')
const a = { mode: 'work', enabled: new Set() }
applyMode(a, 'work', ['skill-b'], names)
const b = { mode: 'all', enabled: new Set() }
applyMode(b, 'all', [], names)
check('separate states do not share sets', a.enabled === b.enabled, false)
check('state a keeps its posture', [...a.enabled], ['skill-b'])
check('state b keeps its posture', [...b.enabled].length, 3)

console.log('parseMode:')
check('accepts all', parseMode('all'), 'all')
check('accepts none', parseMode('none'), 'none')
check('accepts work', parseMode('work'), 'work')
check('rejects wrong case', parseMode('ALL'), undefined)
check('rejects a number', parseMode(42), undefined)
check('rejects undefined', parseMode(undefined), undefined)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
