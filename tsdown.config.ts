/**
 * dsh-skill-switch build: the node half (host plugin) and the browser client
 * bundle speaking the dsh module-loader protocol
 * (`window.__ModuleLoader__.load`). Mirrors the community plugin layout:
 * lib/index.js + lib/invariant.js for the host, lib/client.js for the page.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const ID = 'dsh-skill-switch'
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url))

/** Modules answered by the page's module table; everything else is bundled. */
const EXTERNALS = ['react', 'react/jsx-runtime', '@deepseek-ai/cordis']

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

function cssModulesPlugin(): NonNullable<UserConfig['plugins']>[number] {
  return {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
      const stableId = relative(PROJECT_ROOT, abs).replaceAll('\\', '/')
      return CSS_VIRTUAL_PREFIX + stableId + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const stableId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const fileId = resolvePath(PROJECT_ROOT, stableId)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: stableId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      // Deterministic key order: fixed UTF-16 comparison on local names
      // (localeCompare would drift with the system locale).
      const entries = Object.entries(cssExports ?? {})
        .map(([local, exp]) => [local, exp.name] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      const classMap = Object.fromEntries(entries)
      const tagId = `${ID}/${basename(fileId)}`
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
        `  const tag = document.createElement('style');`,
        `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }
}

const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  minify: true,
  sourcemap: false,
  clean: false,
  external: [...EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  plugins: [cssModulesPlugin()],
  outputOptions: {
    entryFileNames: 'client.js',
    codeSplitting: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

const libConfig: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts', invariant: 'src/plugin/invariant.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  // Every @deepseek-ai/* import stays external: the host resolves them from
  // the profile's node_modules at load time.
  external: (id: string) => id.startsWith('@deepseek-ai/') || id === 'node:crypto' || id.startsWith('node:'),
  outputOptions: { entryFileNames: '[name].js' },
}

export default [libConfig, clientConfig]
