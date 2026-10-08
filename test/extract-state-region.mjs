import { readFileSync, writeFileSync } from 'node:fs'
const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const start = src.indexOf('//#region src/plugin/session-state.ts')
const end = src.indexOf('//#endregion', start)
const body = src.slice(start, end)
writeFileSync(new URL('./state-region.mjs', import.meta.url), body + '\nexport { applyMode, toRows, parseMode }\n')
console.log('state region extracted:', body.length, 'bytes')
