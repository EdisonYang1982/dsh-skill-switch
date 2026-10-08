/**
 * Per-session skill enablement state.
 *
 * The whole table is process memory by design: a fresh session starts from the
 * configured default posture and a restart forgets every toggle. That is the
 * requested semantics ("each new session picks again"), and it keeps the plugin
 * free of any storage dependency.
 *
 * Two layers of state per session:
 * - `mode`: the coarse posture (`all` | `none` | `work`), which reseeds `enabled`.
 * - `enabled`: the resolved on/off set actually consulted by the catalog.
 *
 * @module dsh-skill-switch/plugin/session-state
 */

/** Coarse posture a session starts in, or that a mode button applies. */
export type SkillMode = 'all' | 'none' | 'work'

/** One session's switch state. */
export interface SessionSkillState {
  /** Posture last applied to this session. */
  mode: SkillMode
  /** Skill names currently loadable by the model. */
  enabled: Set<string>
}

/** Catalog row sent to the browser. */
export interface SkillRow {
  name: string
  description: string
  enabled: boolean
}

const DEFAULT_MODE: SkillMode = 'all'

/**
 * Reseed `enabled` from a posture. `all` takes every catalog name, `none`
 * empties the set, and `work` keeps the configured allowlist intersected with
 * the live catalog (so a stale configured name cannot resurrect a skill that
 * no longer exists).
 * @param state - state to reseed.
 * @param mode - posture to apply.
 * @param workSkills - allowlist for `work`.
 * @param catalog - every discoverable skill name.
 */
export function applyMode(
  state: SessionSkillState,
  mode: SkillMode,
  workSkills: readonly string[],
  catalog: readonly string[],
): void {
  state.mode = mode
  if (mode === 'none') {
    state.enabled.clear()
    return
  }
  if (mode === 'work') {
    const allowed = new Set(workSkills)
    state.enabled = new Set(catalog.filter((name) => allowed.has(name)))
    return
  }
  state.enabled = new Set(catalog)
}

/**
 * Project the live catalog onto browser rows, preserving catalog order so the
 * chip strip is stable between refreshes.
 * @param catalog - discoverable skills (name + description).
 * @param state - the session's enablement set.
 * @returns one row per skill.
 */
export function toRows(
  catalog: readonly { readonly name: string; readonly description: string }[],
  state: SessionSkillState,
): SkillRow[] {
  return catalog.map((skill) => ({
    name: skill.name,
    description: skill.description,
    enabled: state.enabled.has(skill.name),
  }))
}

/** Parse an untrusted mode string from an HTTP body. */
export function parseMode(value: unknown): SkillMode | undefined {
  return value === 'all' || value === 'none' || value === 'work' ? value : undefined
}

export { DEFAULT_MODE }
