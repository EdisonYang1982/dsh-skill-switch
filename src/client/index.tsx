/**
 * dsh-skill-switch browser half: a chip strip above the composer showing every
 * discoverable skill and whether this session loads it.
 *
 * Registered into `conversation.input.dock`, a session-scoped slot. The
 * framework's standard kit supplies `sessionId` as a plain prop for session
 * slots, so the component needs no `inject` face of its own. State lives in
 * host memory only: a page reload falls back to the configured default
 * posture, which is the requested "each new session picks again" semantics.
 *
 * The strip is collapsible and remembers that choice in localStorage: a dock
 * row sits directly above the composer, so a wide chip list would push the
 * conversation up on every turn. Collapsed it is one short line; the refresh
 * control runs the deployment's sync script on demand rather than a timer.
 *
 * Sync feedback follows the macOS idiom rather than a persistent log pane: the
 * button itself reports the outcome (spinner → "已同步 ✓") and reverts after a
 * couple of seconds, so success costs no layout at all. Only a failure keeps
 * something on screen, and only then does the script's own output unfold —
 * because a failure is the one case where the text tells the user what to do.
 *
 * @module dsh-skill-switch/client
 */

import * as React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { styles } from './styles.ts'

/** One catalog row as served by the host. */
export interface SkillRow {
  name: string
  description: string
  enabled: boolean
}

/** Shared shape of every host route response. */
interface StateResponse {
  mode: 'all' | 'none' | 'work'
  skills: SkillRow[]
  defaultMode?: 'all' | 'none' | 'work'
  /** Whether the host exposes the refresh control (a sync script is configured). */
  syncAvailable?: boolean
  /** All-or-nothing bundles, mounted by moving directories. */
  groups?: GroupRow[]
}

/** One all-or-nothing skill bundle as served by the host. */
export interface GroupRow {
  id: string
  label: string
  description?: string
  mounted: boolean
  memberCount: number
  error?: string
}

/** Result of one manual sync run. */
interface SyncResponse {
  ok: boolean
  output: string
}

/** localStorage key for the collapsed/expanded choice. */
const OPEN_KEY = 'dsh-skill-switch.open'

/** Full props of the dock entry: the framework runtime kit (sessionId included). */
export type SkillDockProps = PropsRuntime<'conversation.input.dock'>

const ROUTE = '/skill-switch'

/** POST one JSON body to a host route and decode the response. */
async function post(path: string, body: Record<string, unknown>): Promise<StateResponse> {
  const res = await fetch(`${ROUTE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`)
  return (await res.json()) as StateResponse
}

/** Read the remembered open/closed choice; the strip starts collapsed. */
function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * The composer dock: mode buttons plus one chip per skill.
 * @param props - framework runtime kit (provides `sessionId`).
 */
export function SkillDock({ sessionId }: SkillDockProps) {
  const [state, setState] = React.useState<StateResponse | null>(null)
  const [failed, setFailed] = React.useState(false)
  const [open, setOpen] = React.useState(readOpen)
  /**
   * Sync feedback is a short-lived button state, not a log pane: `ok` reverts
   * to idle on a timer, while `failed` stays until dismissed because it carries
   * an action the user may need to take. `log` unfolds only on failure.
   */
  const [sync, setSync] = React.useState<{ phase: 'idle' | 'running' | 'ok' | 'failed'; log: string }>(
    { phase: 'idle', log: '' },
  )
  const [logOpen, setLogOpen] = React.useState(false)
  const revertTimer = React.useRef<number | null>(null)
  /** Group id currently being moved; the chip shows a spinner meanwhile. */
  const [groupBusy, setGroupBusy] = React.useState<string | null>(null)

  const refresh = React.useCallback((): void => {
    fetch(`${ROUTE}/state?sessionId=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        return (await res.json()) as StateResponse
      })
      .then((body) => {
        setState(body)
        setFailed(false)
      })
      .catch(() => setFailed(true))
  }, [sessionId])

  React.useEffect(refresh, [refresh])

  // Live updates over server-sent events: the host pushes a `changed` frame on
  // every toggle, mode switch, sync run, and `skills/change`, so the strip
  // reflects a newly added skill immediately instead of waiting for a poll
  // tick. The stream is per session and reconnects on its own.
  React.useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const source = new EventSource(`${ROUTE}/events?sessionId=${encodeURIComponent(sessionId)}`)
    const onChanged = (): void => refresh()
    source.addEventListener('changed', onChanged)
    return () => {
      source.removeEventListener('changed', onChanged)
      source.close()
    }
  }, [sessionId, refresh])

  const apply = React.useCallback((run: () => Promise<StateResponse>) => {
    run()
      .then((next) => {
        setState(next)
        setFailed(false)
      })
      .catch(() => setFailed(true))
  }, [])

  /** Flip the collapsed/expanded choice and remember it across reloads. */
  const toggleOpen = React.useCallback((): void => {
    setOpen((current) => {
      const next = !current
      try {
        window.localStorage.setItem(OPEN_KEY, next ? '1' : '0')
      } catch {
        // A storage-denied page simply forgets the choice.
      }
      return next
    })
  }, [])

  /**
   * Mount or unmount one skill group. This moves directories on the host, so it
   * is slower than a per-session toggle and gets its own busy state.
   */
  const toggleGroup = React.useCallback((group: GroupRow): void => {
    setGroupBusy(group.id)
    fetch(`${ROUTE}/group`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, group: group.id, mounted: !group.mounted }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        return (await res.json()) as { groups: GroupRow[]; error?: string }
      })
      .then((body) => {
        setState((current) => (current === null ? current : { ...current, groups: body.groups }))
        // A partial move is a real failure: the family is split, so its
        // relative cross-references may not resolve. Surface the text.
        if (body.error !== undefined) {
          setSync({ phase: 'failed', log: `部分成员未能移动：${body.error}` })
          setLogOpen(true)
        }
      })
      .catch((error: unknown) => {
        setSync({ phase: 'failed', log: error instanceof Error ? error.message : String(error) })
        setLogOpen(true)
      })
      .finally(() => {
        setGroupBusy(null)
        refresh()
      })
  }, [sessionId, refresh])

  /**
   * Run the deployment's sync script. The button reports the outcome inline and
   * a success clears itself; only a failure leaves anything behind.
   */
  const runSync = React.useCallback((): void => {
    if (revertTimer.current !== null) {
      window.clearTimeout(revertTimer.current)
      revertTimer.current = null
    }
    setSync({ phase: 'running', log: '' })
    setLogOpen(false)
    fetch(`${ROUTE}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        return (await res.json()) as SyncResponse
      })
      .then((body) => {
        if (body.ok) {
          setSync({ phase: 'ok', log: '' })
          // Success needs no acknowledgement: it withdraws on its own.
          revertTimer.current = window.setTimeout(() => {
            setSync({ phase: 'idle', log: '' })
            revertTimer.current = null
          }, 2000)
          return
        }
        // Failure keeps its output, because that text is what tells the user
        // what went wrong; unfold it rather than making them hunt for it.
        setSync({ phase: 'failed', log: body.output.trim() })
        setLogOpen(true)
      })
      .catch((error: unknown) => {
        setSync({
          phase: 'failed',
          log: error instanceof Error ? error.message : String(error),
        })
        setLogOpen(true)
      })
      .finally(() => {
        refresh()
      })
  }, [sessionId, refresh])

  // A pending revert must not outlive the component.
  React.useEffect(() => () => {
    if (revertTimer.current !== null) window.clearTimeout(revertTimer.current)
  }, [])

  // Never block the composer on a switch failure.
  if (failed || state === null) return null

  const enabledSkills = state.skills.filter((skill) => skill.enabled)
  const summary = `${enabledSkills.length}/${state.skills.length}`

  return (
    <div className={styles.dock} data-skill-switch="">
      <div className={styles.header}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          onClick={toggleOpen}
          title={open ? '折叠技能条' : '展开技能条'}
        >
          <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} aria-hidden="true">▶</span>
          <span>技能</span>
        </button>
        <span className={styles.summary} aria-live="polite">{summary}</span>

        {!open && (
          <span className={styles.preview} title={enabledSkills.map((skill) => skill.name).join('、')}>
            {(() => {
              const mounted = (state.groups ?? []).filter((group) => group.mounted)
              const names = enabledSkills.map((skill) => skill.name).join('、')
              if (mounted.length === 0) return names === '' ? '未加载任何技能' : names
              const groupText = mounted.map((group) => group.label).join('、')
              return names === '' ? groupText : `${groupText} · ${names}`
            })()}
          </span>
        )}

        <span className={styles.actions}>
          {state.syncAvailable === true && (
            <button
              type="button"
              className={`${styles.action} ${sync.phase === 'failed' ? styles.actionFailed : ''}`}
              onClick={runSync}
              disabled={sync.phase === 'running'}
              aria-live="polite"
              title={
                sync.phase === 'failed'
                  ? '同步失败，点此重试（下方可查看输出）'
                  : '把 NAS 里的新技能同步到本机枢纽，然后刷新列表'
              }
            >
              {sync.phase === 'running' && (
                <>
                  <span className={styles.spinner} aria-hidden="true" />
                  <span>同步中</span>
                </>
              )}
              {sync.phase === 'idle' && <span>同步技能</span>}
              {sync.phase === 'ok' && (
                <>
                  <span className={styles.check} aria-hidden="true">✓</span>
                  <span>已同步</span>
                </>
              )}
              {sync.phase === 'failed' && (
                <>
                  <span aria-hidden="true">⚠</span>
                  <span>同步失败</span>
                </>
              )}
            </button>
          )}
        </span>
      </div>

      {open && (
        <div className={styles.body}>
          <div className={styles.modeGroup} role="group" aria-label="技能加载模式">
            <button
              type="button"
              className={`${styles.modeButton} ${state.mode === 'none' ? styles.modeButtonActive : ''}`}
              onClick={() => apply(() => post('/mode', { sessionId, mode: 'none' }))}
              title="全部不加载：纯聊天，零技能负担"
            >
              聊天模式
            </button>
            <button
              type="button"
              className={`${styles.modeButton} ${state.mode === 'work' ? styles.modeButtonActive : ''}`}
              onClick={() => apply(() => post('/mode', { sessionId, mode: 'work' }))}
              title="只加载插件配置 workSkills 清单里的技能"
            >
              干活模式
            </button>
            <button
              type="button"
              className={`${styles.modeButton} ${state.mode === 'all' ? styles.modeButtonActive : ''}`}
              onClick={() => apply(() => post('/mode', { sessionId, mode: 'all' }))}
              title="加载全部可发现的技能"
            >
              全部
            </button>
          </div>

          {(state.groups ?? []).map((group) => (
            <button
              key={group.id}
              type="button"
              className={`${styles.groupChip} ${group.mounted ? styles.groupChipOn : ''}`}
              aria-pressed={group.mounted}
              disabled={groupBusy === group.id}
              title={
                group.description
                ?? (group.mounted
                  ? `已挂载 ${group.memberCount} 个技能，点击整组卸下`
                  : `未挂载，点击把 ${group.memberCount} 个技能整组挂上`)
              }
              onClick={() => toggleGroup(group)}
            >
              {groupBusy === group.id
                ? <span className={styles.spinner} aria-hidden="true" />
                : <span className={`${styles.dot} ${group.mounted ? styles.dotOn : ''}`} aria-hidden="true" />}
              <span className={styles.label}>{group.label}</span>
              <span className={styles.groupCount}>{group.memberCount}</span>
            </button>
          ))}

          {state.skills.length === 0
            ? <span className={styles.empty}>本会话没有可发现的技能</span>
            : state.skills.map((skill) => (
              <button
                key={skill.name}
                type="button"
                className={`${styles.chip} ${skill.enabled ? styles.chipOn : ''}`}
                aria-pressed={skill.enabled}
                title={`${skill.enabled ? '已加载' : '未加载'}：${skill.description}`}
                onClick={() => apply(() => post('/toggle', { sessionId, skill: skill.name }))}
              >
                <span className={`${styles.dot} ${skill.enabled ? styles.dotOn : ''}`} aria-hidden="true" />
                <span className={styles.label}>{skill.name}</span>
              </button>
            ))}
        </div>
      )}

      {/* Only a failure keeps anything on screen, and its output is what tells
          the user what to do — so it unfolds by default but stays collapsible. */}
      {sync.phase === 'failed' && (
        <div className={styles.logWrap}>
          <button
            type="button"
            className={styles.logToggle}
            aria-expanded={logOpen}
            onClick={() => setLogOpen((current) => !current)}
          >
            <span className={`${styles.chevron} ${logOpen ? styles.chevronOpen : ''}`} aria-hidden="true">▶</span>
            <span>查看输出</span>
          </button>
          {logOpen && <pre className={styles.log}>{sync.log}</pre>}
        </div>
      )}
    </div>
  )
}

/**
 * Cordis client entry: register the dock into the composer's ambient seat.
 * @param ctx - client context.
 */
export function apply(ctx: Context): () => void {
  return ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register({
      name: 'conversation.input.dock',
      id: 'skill-switch',
      order: 40,
    }, SkillDock))
}

export const inject = ['slots']
