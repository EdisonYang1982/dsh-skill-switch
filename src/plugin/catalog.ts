/**
 * Model-facing skill catalog rendering, filtered by one session's switch state.
 *
 * This is the piece that replaces `@deepseek-ai/dsh-tool-skill`'s catalog
 * injection. The official plugin is disabled in the profile patch because its
 * catalog is unconditional: it always advertises every model-invocable skill,
 * and it re-publishes a replacement message whenever the catalog digest moves.
 * Owning the injection lets a closed skill disappear from the catalog outright
 * instead of merely failing at load time — which is what actually saves tokens,
 * because the catalog line is small but a loaded SKILL.md body is not.
 *
 * The rendering text mirrors the official shape (`<available_skills>` inside a
 * `<system-reminder>`) so a model trained on the stock harness still routes
 * correctly.
 *
 * @module dsh-skill-switch/plugin/catalog
 */

import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { escapeText } from '@deepseek-ai/dsh-skill'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Rendering cap for one catalog description, mirroring the official default. */
const DEFAULT_DESCRIPTION_MAX_LENGTH = 500

/** One catalog entry as published durably beside the model-facing prose. */
export interface CatalogEntry {
  readonly name: string
  readonly description: string
}

/** Catalog message source, durable so consumers need not re-parse prose. */
export interface SkillCatalogSource {
  readonly kind: 'skill-catalog'
  readonly form: 'catalog'
  readonly update?: true
  readonly entries: readonly CatalogEntry[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'skill-catalog': SkillCatalogSource
  }
}

/** Trim and normalize one description for catalog rendering. */
export function catalogDescription(description: string, maxLength: number): string {
  const normalized = description.replace(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`
}

/**
 * Digest the published entries so an unchanged catalog is not re-sent.
 * @param entries - catalog entries in publication order.
 * @returns a short stable digest.
 */
export function digestCatalogEntries(entries: readonly CatalogEntry[]): string {
  return createHash('sha1').update(JSON.stringify(entries)).digest('hex').slice(0, 16)
}

/** Render the `- \`name\`: description` lines inside `<available_skills>`. */
function renderCatalogEntries(entries: readonly CatalogEntry[]): string[] {
  return entries.map((entry) => `- \`${entry.name}\`: ${escapeText(entry.description)}`)
}

/** Build the first catalog message of a session. */
export function renderCatalogMessage(entries: readonly CatalogEntry[]) {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
        '',
        '<available_skills>',
        ...renderCatalogEntries(entries),
        '</available_skills>',
        '',
        'If the user names a skill, or the task clearly matches a skill\'s description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill\'s instructions until it has been loaded.',
        'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
        '</system-reminder>',
      ].join('\n'),
    }],
    source: { kind: 'skill-catalog', form: 'catalog', entries } satisfies SkillCatalogSource,
  })
}

/** Build a replacement catalog after the enabled set changed. */
export function renderCatalogUpdate(entries: readonly CatalogEntry[]) {
  const availability = entries.length === 0
    ? [
      'No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.',
      'A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool for it.',
    ]
    : [
      'Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.',
      'A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the `skill` tool again for that skill.',
    ]
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:',
        '',
        '<available_skills>',
        ...renderCatalogEntries(entries),
        '</available_skills>',
        '',
        ...availability,
        '</system-reminder>',
      ].join('\n'),
    }],
    source: { kind: 'skill-catalog', form: 'catalog', update: true, entries } satisfies SkillCatalogSource,
  })
}

/**
 * Locate the visible catalog message already in play for one agent, so a
 * re-render replaces it in place instead of appending a duplicate.
 * @param agent - the owning agent.
 * @returns the visible digest when a catalog is on the surface, plus whether
 *   any catalog has ever been published.
 */
export function catalogHistory(agent: Agent): { published: boolean; visibleDigest?: string } {
  const visible = new Set(agent.session.surface.nodes)
  const events = readEventsBackwards(agent.session)
  let published = false
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const source = event.data.source as { kind?: string; entries?: unknown } | undefined
    if (source?.kind !== 'skill-catalog') continue
    const entries = readEntries(source)
    if (entries === undefined) continue
    published = true
    if (visible.has(event.seq)) {
      return { published, visibleDigest: digestCatalogEntries(entries) }
    }
  }
  return { published }
}

/**
 * Yield this session's events newest-first, tolerating both log access shapes:
 * 0.2.0 exposes `seq` + `eventAt()` and deprecates whole-log reads, while
 * 0.1.0 exposes the `events` array directly. Reading through whichever exists
 * keeps one plugin build working on both runtimes.
 */
function* readEventsBackwards(session: Agent['session']): Generator<SessionEvent> {
  const withAccessors = session as unknown as {
    seq?: number
    eventAt?: (seq: number) => SessionEvent | undefined
  }
  if (typeof withAccessors.seq === 'number' && typeof withAccessors.eventAt === 'function') {
    for (let index = withAccessors.seq - 1; index >= 0; index -= 1) {
      const event = withAccessors.eventAt(index)
      if (event !== undefined) yield event
    }
    return
  }
  const legacy = (session as unknown as { events?: readonly SessionEvent[] }).events
  if (legacy === undefined) return
  for (let index = legacy.length - 1; index >= 0; index -= 1) {
    const event = legacy[index]
    if (event !== undefined) yield event
  }
}

/**
 * Read durable catalog entries, or undefined when the record is not a usable
 * catalog. A resumed, forked, or externally written seed only guarantees a
 * source object with a non-empty `kind`, so an unreadable record is treated as
 * "not this plugin's catalog" rather than throwing inside the step listener —
 * a throw there would fail every later turn of that session.
 */
function readEntries(source: { entries?: unknown }): CatalogEntry[] | undefined {
  const entries = source.entries
  if (!Array.isArray(entries)) return undefined
  const out: CatalogEntry[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const name = (entry as { name?: unknown }).name
    const description = (entry as { description?: unknown }).description
    if (typeof name !== 'string' || name === '' || typeof description !== 'string') return undefined
    out.push({ name, description })
  }
  return out
}

export { DEFAULT_DESCRIPTION_MAX_LENGTH }
