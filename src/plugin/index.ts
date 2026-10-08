/**
 * dsh-skill-switch host half.
 *
 * Takes over the model-facing `skill` tool and its session catalog so skills can
 * be switched off per session. Two constraints force the takeover rather than a
 * lighter interception:
 *
 * - `ctx.skills.registerProvider()` files into the GLOBAL layer and its `list()`
 *   receives only `{ cwd, signal }` — no agent identity — so a provider cannot
 *   branch per session.
 * - The official catalog re-publishes a replacement message whenever its digest
 *   moves, so filtering behind its back would append a catalog update per step.
 *
 * Registrations therefore happen on `agent.ctx`: `tools.register` reads the
 * CALLER's scope, so a per-agent registration both differs per session and is
 * collected when the agent is disposed. With every skill off, the tool
 * registration itself is disposed — `tools.restrict()` cannot do that job,
 * because a restriction filters only what a scope INHERITS and never what its
 * own layer registers, so it would leave the schema in the prompt.
 *
 * @module dsh-skill-switch
 */

import type { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isSkillName, isModelInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  catalogDescription,
  digestCatalogEntries,
  renderCatalogMessage,
  renderCatalogUpdate,
  catalogHistory,
  DEFAULT_DESCRIPTION_MAX_LENGTH,
  type CatalogEntry,
} from './catalog.ts'
import {
  applyMode,
  parseMode,
  toRows,
  DEFAULT_MODE,
  type SkillMode,
  type SessionSkillState,
} from './session-state.ts'

/** Cordis plugin name. */
export const name = 'skill-switch'

/** Services required before registrations can be made. */
export const inject = ['skills', 'tools', 'agents']

/** Plugin configuration. */
export interface Config {
  /** Posture a new session starts in. */
  defaultMode?: SkillMode
  /** Allowlist applied by the `work` posture. */
  workSkills?: string[]
  /** Maximum rendered description length in the catalog; minimum 3. */
  catalogDescriptionMaxLength?: number
  /** HTTP path prefix for the browser-facing routes. */
  routePrefix?: string
  /**
   * Absolute path of the script the strip's refresh control runs. It is the
   * deployment's own sync step (NAS skill repository → the hub the host reads);
   * leaving it unset hides the control.
   */
  syncScript?: string
  /** Cooperative timeout for one sync run, in milliseconds. */
  syncTimeoutMs?: number
  /**
   * Absolute path of the hub the host scans for skills (`~/.agents/skills` in
   * the stock layout). Group mounting moves members in and out of it, so this
   * must be the same directory the filesystem provider reads.
   */
  hubDir?: string
  /**
   * All-or-nothing skill bundles, mounted by moving directories between the
   * hub and a parking directory.
   *
   * Some skill families are both huge and interdependent — a member's SKILL.md
   * links its siblings by relative path — so a per-skill switch cannot express
   * them: loading one alone breaks its references, and listing all of them
   * costs their catalog lines whether or not the session uses them. Parking the
   * whole family outside the hub keeps it at zero catalog cost, and the group
   * switch moves it in or out as one unit.
   */
  skillGroups?: SkillGroupConfig[]
}

/** One all-or-nothing skill bundle. */
export interface SkillGroupConfig {
  /** Stable id used by the routes and the browser. */
  id: string
  /** Label shown on the group's chip. */
  label: string
  /**
   * Directory the members live in while unmounted. Members are addressed as
   * direct children of it, and mounting moves each one into the hub root so
   * their relative cross-references keep resolving.
   */
  parkDir: string
  /** Member directory names, relative to `parkDir` and to the hub root. */
  members?: string[]
  /**
   * Discover members by scanning `parkDir` instead of listing them. Use when
   * the family changes often; `members` is faster and explicit.
   */
  discover?: boolean
  /** Optional one-line description shown in the chip's tooltip. */
  description?: string
}

/** Validate and default the plugin configuration. */
export const Config: z<Config> = z.object({
  defaultMode: z.union([z.const('all'), z.const('none'), z.const('work')]).default(DEFAULT_MODE),
  workSkills: z.array(z.string()).default([]),
  catalogDescriptionMaxLength: z.number().default(DEFAULT_DESCRIPTION_MAX_LENGTH),
  routePrefix: z.string().default('/skill-switch'),
  syncScript: z.string().default(''),
  syncTimeoutMs: z.number().default(60_000),
  hubDir: z.string().default(''),
  skillGroups: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    parkDir: z.string().min(1),
    members: z.array(z.string()).default([]),
    discover: z.boolean().default(false),
    description: z.string().default(''),
  })).default([]),
})

/** One session's live registrations and switch state. */
interface SessionRegistration {
  state: SessionSkillState
  /** Whether `state.enabled` was seeded from a discovered catalog yet. */
  seeded: boolean
  /** Disposer of the session-scoped `skill` tool registration, when mounted. */
  toolDisposer?: () => void
}

/**
 * Register the per-session skill tool, catalog injection, and HTTP routes.
 * @param ctx - host context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const defaultMode = config.defaultMode ?? DEFAULT_MODE
  const workSkills = config.workSkills ?? []
  const descriptionMaxLength = config.catalogDescriptionMaxLength ?? DEFAULT_DESCRIPTION_MAX_LENGTH
  const routePrefix = config.routePrefix ?? '/skill-switch'
  const syncScript = config.syncScript ?? ''
  const syncTimeoutMs = config.syncTimeoutMs ?? 60_000
  /** One sync at a time: a second click joins the run already in flight. */
  let syncInFlight: Promise<{ ok: boolean; output: string }> | undefined
  const skillGroups = config.skillGroups ?? []
  /**
   * Hub root: the directory the host scans for skills. Group mounting moves
   * members between their park directory and here, and both must be on the
   * same filesystem for a rename to be atomic.
   */
  const hubRoot = config.hubDir ?? ''

  const sessions = new Map<string, SessionRegistration>()
  /**
   * Live SSE subscribers. One set for the whole host, not one per session: a
   * browser caps same-origin connections at six, and a stream per session meant
   * every session switch opened a new one while the old drained — enough quick
   * switches and the pool is full, after which the `state` fetch never resolves
   * and the strip stays blank. A frame carries no session identity, so a single
   * stream can serve every view; each client re-reads with its own session id.
   */
  const subscribers = new Set<(event: string) => void>()
  /** Last discovered catalog per session, so the HTTP routes can answer fast. */
  const catalogCache = new Map<string, { name: string; description: string }[]>()

  const skillToolDefinition = defineTool({
    name: 'skill',
    description: 'Load the full instructions for an available skill. Call this with the exact skill name from the session skill catalog before acting on a task that names or clearly matches that skill.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'The exact skill name from the available skills list.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          resourceBase: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'directory' },
                  path: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'url' },
                  url: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'opaque' },
                  description: { type: 'string', required: true },
                },
              },
            ],
          },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSkillContent(value) }],
    },
    async execute(args, exec) {
      if (!isSkillName(args.name)) throw new Error(`invalid skill name "${args.name}"`)
      const registration = exec.agent === undefined ? undefined : sessions.get(exec.agent.id)
      if (registration !== undefined && registration.seeded && !registration.state.enabled.has(args.name)) {
        throw new Error(`skill "${args.name}" is switched off in this session`)
      }
      const lookup = {
        cwd: exec.agent?.session.header.cwd,
        signal: exec.signal,
        scope: exec.agent,
      }
      const summary = (await ctx.skills.list(lookup)).find((skill) => skill.name === args.name)
      if (summary === undefined) throw new Error(`skill "${args.name}" is unknown or no longer available`)
      if (!isModelInvocable(summary)) throw new Error(`skill "${args.name}" is not available for model invocation`)
      const skill = await ctx.skills.get(args.name, lookup)
      if (skill === undefined) throw new Error(`skill "${args.name}" is unknown or no longer available`)
      if (!isModelInvocable(skill)) throw new Error(`skill "${args.name}" is not available for model invocation`)
      return {
        name: skill.name,
        provider: skill.provider,
        ...(skill.resourceBase !== undefined ? { resourceBase: { ...skill.resourceBase } } : {}),
        content: skill.content,
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Load skill ${args.name}`,
        kind: 'read',
        rawInput: args.name,
      }
    },
  })

  /** Discover the model-invocable catalog for one agent. */
  async function discoverForAgent(agent: Agent, signal: AbortSignal) {
    const snapshot = await ctx.skills.snapshot({ cwd: agent.session.header.cwd, signal, scope: agent })
    return snapshot.skills
      .filter(isModelInvocable)
      .map((skill) => ({ name: skill.name, description: skill.description }))
  }

  /** Discover the global catalog (HTTP callers hold no agent). */
  async function discoverGlobal() {
    const snapshot = await ctx.skills.snapshot({})
    return snapshot.skills
      .filter(isModelInvocable)
      .map((skill) => ({ name: skill.name, description: skill.description }))
  }

  /**
   * Notify every live subscriber that some session's state moved. The frame is
   * deliberately session-agnostic: clients re-read with the id they hold, so a
   * change caused by one session still refreshes a view that has since switched
   * to another.
   * @param event - frame name the client reacts to (`changed` re-reads state).
   */
  function publish(event: string): void {
    for (const listener of [...subscribers]) {
      try {
        listener(event)
      } catch {
        // A broken stream must not stop the others from being notified.
      }
    }
  }

  /**
   * Roster file for one group: the member names captured the last time it was
   * mounted.
   *
   * A group's membership cannot be read from disk while it is mounted — the
   * park directory is empty and the hub holds unrelated skills — so the list is
   * recorded beside the park directory at mount time. That keeps the count and
   * the unmount set correct across a host restart, which an in-memory map
   * cannot do.
   */
  function rosterPath(group: SkillGroupConfig): string {
    return join(group.parkDir, '.members')
  }

  /** Read a group's recorded roster, or an empty list when none was written. */
  function readRoster(group: SkillGroupConfig): string[] {
    try {
      return readFileSync(rosterPath(group), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
    } catch {
      return []
    }
  }

  /**
   * Member directory names one group owns.
   *
   * `members` is the explicit list. With `discover`, membership is read from
   * the park directory, falling back to the recorded roster while the family is
   * mounted (see {@link rosterPath}).
   */
  function membersOf(group: SkillGroupConfig): string[] {
    if (group.members !== undefined && group.members.length > 0) return group.members
    if (group.discover !== true) return []
    try {
      const found = readdirSync(group.parkDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort()
      if (found.length > 0) return found
    } catch {
      // Fall through to the roster.
    }
    return readRoster(group)
  }

  /** Where one member currently sits. */
  function memberPath(group: SkillGroupConfig, member: string): { mounted: string; parked: string } {
    return { mounted: join(hubRoot, member), parked: join(group.parkDir, member) }
  }

  /**
   * Whether a group is mounted, judged by its members' locations: any member in
   * the hub means the family is (at least partly) in play.
   */
  function groupMounted(group: SkillGroupConfig): boolean {
    if (hubRoot === '') return false
    return membersOf(group).some((member) => existsSync(memberPath(group, member).mounted))
  }

  /** One group's state as the browser sees it. */
  interface GroupView {
    id: string
    label: string
    description?: string
    mounted: boolean
    memberCount: number
    /** Members that could not be moved, when a partial operation occurred. */
    error?: string
  }

  /**
   * Move every member between the hub and the park directory. A rename within
   * one filesystem is atomic per member; a failure is reported per group rather
   * than thrown, so one stuck directory cannot strand the rest.
   * @param group - the group to act on.
   * @param mount - true moves members into the hub, false moves them out.
   * @returns the members moved plus any failure text.
   */
  async function setGroupMounted(group: SkillGroupConfig, mount: boolean): Promise<{ moved: string[]; error?: string }> {
    if (hubRoot === '') return { moved: [], error: 'hubDir is not configured' }
    // Resolve the membership BEFORE moving anything: unmounting reads the
    // roster captured at mount time, because parkDir is empty by then.
    const members = membersOf(group)
    const moved: string[] = []
    const failures: string[] = []
    for (const member of members) {
      const { mounted, parked } = memberPath(group, member)
      const from = mount ? parked : mounted
      const to = mount ? mounted : parked
      if (existsSync(to)) {
        // Already in place: a re-click or a partly-applied earlier run.
        if (!existsSync(from)) continue
        failures.push(`${member}: 目标已存在`)
        continue
      }
      if (!existsSync(from)) continue
      try {
        await rename(from, to)
        moved.push(member)
      } catch (error) {
        failures.push(`${member}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (mount) {
      try {
        await writeFile(rosterPath(group), `${members.join('\n')}\n`, 'utf8')
      } catch {
        // A roster that cannot be written costs the count after a restart, not
        // the mount itself: the family is already in the hub.
      }
    } else {
      try {
        await rm(rosterPath(group), { force: true })
      } catch {
        // A stale roster is corrected on the next mount.
      }
    }
    return failures.length > 0 ? { moved, error: failures.join('；') } : { moved }
  }

  /** Read every group's current state. */
  function groupViews(): GroupView[] {
    return skillGroups.map((group) => ({
      id: group.id,
      label: group.label,
      ...(group.description !== undefined && group.description !== '' ? { description: group.description } : {}),
      mounted: groupMounted(group),
      memberCount: membersOf(group).length,
    }))
  }

  /** Read one session's registration, claiming it with the default posture. */
  function registrationFor(sessionId: string): SessionRegistration {
    const existing = sessions.get(sessionId)
    if (existing !== undefined) return existing
    const created: SessionRegistration = {
      state: { mode: defaultMode, enabled: new Set() },
      seeded: false,
    }
    sessions.set(sessionId, created)
    return created
  }

  /** Seed an unseeded registration from a discovered catalog. */
  function seed(registration: SessionRegistration, catalog: readonly { name: string }[]): void {
    if (registration.seeded) return
    applyMode(registration.state, registration.state.mode, workSkills, catalog.map((s) => s.name))
    registration.seeded = true
  }

  /**
   * Align the session-scoped tool registration with the enabled set: with
   * nothing enabled the tool is unmounted, so its schema leaves the prompt.
   * @param agent - the owning agent.
   * @param registration - that agent's registration.
   */
  function syncTool(agent: Agent, registration: SessionRegistration): void {
    const wanted = !registration.seeded || registration.state.enabled.size > 0
    if (wanted && registration.toolDisposer === undefined) {
      registration.toolDisposer = agent.ctx.tools.register(skillToolDefinition)
      return
    }
    if (!wanted && registration.toolDisposer !== undefined) {
      registration.toolDisposer()
      registration.toolDisposer = undefined
    }
  }

  /** Mount the session-scoped tool plus the catalog injection for one agent. */
  function mountSession(agent: Agent): void {
    const sessionId = agent.id
    if (sessions.has(sessionId)) return
    const registration = registrationFor(sessionId)

    agent.ctx.effect(() => {
      syncTool(agent, registration)

      // Publish or replace this session's catalog from its enabled set, so a
      // toggled-off skill disappears from the model's view entirely.
      agent.ctx.on('agent/pre-step', async ({ agent: owner, signal }, next) => {
        const decision = await next()
        if (decision.kind === 'reject') return decision
        signal.throwIfAborted()
        const current = sessions.get(owner.id)
        if (current === undefined) return decision
        // The catalog is only meaningful while this session's tool is mounted.
        if (owner.ctx.tools.get(skillToolDefinition.name, owner) !== skillToolDefinition) return decision

        const catalog = await discoverForAgent(owner, signal)
        signal.throwIfAborted()
        catalogCache.set(owner.id, catalog)
        seed(current, catalog)
        syncTool(owner, current)

        const entries: CatalogEntry[] = catalog
          .filter((skill) => current.state.enabled.has(skill.name))
          .map((skill) => ({
            name: skill.name,
            description: catalogDescription(skill.description, descriptionMaxLength),
          }))

        const digest = digestCatalogEntries(entries)
        const history = catalogHistory(owner)
        if (history.visibleDigest === digest) return decision
        if (history.published !== true && entries.length === 0) return decision

        const message = history.published ? renderCatalogUpdate(entries) : renderCatalogMessage(entries)
        // Spread the incoming decision rather than rebuilding it: 0.2.0's
        // decision may carry fields beyond kind/messages that a fresh literal
        // would silently drop.
        return { ...decision, messages: [...decision.messages, message] }
      })

      return () => {
        registration.toolDisposer?.()
        registration.toolDisposer = undefined
        sessions.delete(sessionId)
        catalogCache.delete(sessionId)
      }
    }, 'skill-switch: session mount')
  }

  ctx.on('agent/created', ({ agent }) => {
    mountSession(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    sessions.delete(agent.id)
    catalogCache.delete(agent.id)
  })

  // ---- Browser-facing HTTP routes -----------------------------------------

  ctx.inject(['webServer'], (host) => {
    const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
      res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }

    const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > 8192) throw new Error('body too large')
        chunks.push(buffer)
      }
      if (chunks.length === 0) return {}
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    }

    /** Catalog for one session, falling back to the global view. */
    const catalogFor = async (sessionId: string): Promise<{ name: string; description: string }[]> => {
      const cached = catalogCache.get(sessionId)
      if (cached !== undefined) return cached
      const global = await discoverGlobal()
      catalogCache.set(sessionId, global)
      return global
    }

    /** The agent behind a live session, when one exists. */
    const agentFor = (sessionId: string): Agent | undefined =>
      ctx.agents.get(sessionId as SessionId)

    /**
     * Run the configured sync script and report its output.
     *
     * The strip's refresh control is deliberately manual: a deployment whose
     * skill repository lives on a network mount pays for every scan, so the
     * user decides when to pull new skills in rather than a timer doing it
     * unattended. Concurrent clicks join the in-flight run.
     */
    const runSync = (): Promise<{ ok: boolean; output: string }> => {
      if (syncInFlight !== undefined) return syncInFlight
      const run = new Promise<{ ok: boolean; output: string }>((resolve) => {
        const child = spawn('/bin/bash', [syncScript], { cwd: undefined, env: process.env })
        let output = ''
        const append = (chunk: Buffer): void => {
          // Keep the tail: a long rsync listing is noise, the last lines are
          // the summary and any warning.
          output = (output + chunk.toString('utf8')).slice(-8000)
        }
        child.stdout.on('data', append)
        child.stderr.on('data', append)
        const timer = setTimeout(() => {
          child.kill('SIGTERM')
          output += `\n✗ 同步超时（${syncTimeoutMs}ms）`
        }, syncTimeoutMs)
        child.on('error', (error) => {
          clearTimeout(timer)
          resolve({ ok: false, output: `${output}\n✗ 无法启动同步脚本：${error.message}` })
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({ ok: code === 0, output })
        })
      }).finally(() => {
        syncInFlight = undefined
      })
      syncInFlight = run
      return run
    }

    host.webServer.register({
      kind: 'exact',
      path: `${routePrefix}/sync`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          try {
            if (req.method !== 'POST') {
              res.writeHead(405, { allow: 'POST' })
              res.end()
              return
            }
            if (syncScript === '') {
              sendJson(res, 400, { error: 'syncScript is not configured' })
              return
            }
            const result = await runSync()
            // The script rewrites the hub on disk; the registry's own watcher
            // may or may not have noticed by now, so drop the memo explicitly
            // and tell every open strip to re-read.
            catalogCache.clear()
            publish('changed')
            sendJson(res, 200, result)
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
      },
    })

    // Server-sent events: ONE stream per browser, carrying no session identity.
    //
    // A stream per session looked natural but is a trap: the composer dock is a
    // session-scoped slot, so switching sessions remounts the strip, which closes
    // the old stream and opens a new one. Browsers cap same-origin connections at
    // six, and a stream that has not finished draining still holds its slot — a
    // few quick switches fill the pool, after which the strip's own `state` fetch
    // queues forever and the strip never appears. One long-lived stream avoids
    // the churn entirely; the client re-reads with whatever session id it holds.
    //
    // `skills/change` is not on the Host event forward allowlist, so a browser
    // cannot subscribe to it directly; pushing our own frame keeps the strip live
    // without polling and without depending on that list growing.
    host.webServer.register({
      kind: 'exact',
      path: `${routePrefix}/events`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          // Proxies must not buffer a stream that never ends.
          'x-accel-buffering': 'no',
        })
        res.write(': connected\n\n')
        // A response can close between the check and the write, and writing then
        // throws. Track closure and swallow it, so one dead stream cannot surface
        // as an error in an unrelated request.
        let closed = false
        const write = (chunk: string): void => {
          if (closed) return
          try {
            res.write(chunk)
          } catch {
            closed = true
          }
        }
        const listener = (event: string): void => {
          write(`event: ${event}\ndata: {}\n\n`)
        }
        subscribers.add(listener)
        // Comment frames keep intermediaries from closing an idle stream.
        const keepAlive = setInterval(() => write(': ping\n\n'), 25_000)
        const cleanup = (): void => {
          if (closed) return
          closed = true
          clearInterval(keepAlive)
          subscribers.delete(listener)
        }
        req.on('close', cleanup)
        res.on('close', cleanup)
        res.on('error', cleanup)
      },
    })

    host.webServer.register({
      kind: 'exact',
      path: `${routePrefix}/state`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const sessionId = url.searchParams.get('sessionId')
            if (sessionId === null || sessionId === '') {
              sendJson(res, 400, { error: 'sessionId is required' })
              return
            }
            const catalog = await catalogFor(sessionId)
            const registration = registrationFor(sessionId)
            seed(registration, catalog)
            const agent = agentFor(sessionId)
            if (agent !== undefined) syncTool(agent, registration)
            sendJson(res, 200, {
              mode: registration.state.mode,
              skills: toRows(catalog, registration.state),
              defaultMode,
              // Drives the strip's refresh control: without a configured
              // script there is nothing for it to run.
              syncAvailable: syncScript !== '',
              groups: groupViews(),
            })
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
      },
    })

    host.webServer.register({
      kind: 'exact',
      path: `${routePrefix}/toggle`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          try {
            if (req.method !== 'POST') {
              res.writeHead(405, { allow: 'POST' })
              res.end()
              return
            }
            const body = await readBody(req)
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
            const skill = typeof body.skill === 'string' ? body.skill : undefined
            if (sessionId === undefined || skill === undefined) {
              sendJson(res, 400, { error: 'sessionId and skill are required' })
              return
            }
            const catalog = await catalogFor(sessionId)
            const registration = registrationFor(sessionId)
            seed(registration, catalog)
            if (registration.state.enabled.has(skill)) registration.state.enabled.delete(skill)
            else registration.state.enabled.add(skill)
            registration.state.mode = registration.state.enabled.size === 0 ? 'none' : registration.state.mode
            const agent = agentFor(sessionId)
            if (agent !== undefined) syncTool(agent, registration)
            publish('changed')
            sendJson(res, 200, { mode: registration.state.mode, skills: toRows(catalog, registration.state) })
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
      },
    })

    host.webServer.register({
      kind: 'exact',
      path: `${routePrefix}/mode`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          try {
            if (req.method !== 'POST') {
              res.writeHead(405, { allow: 'POST' })
              res.end()
              return
            }
            const body = await readBody(req)
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
            const mode = parseMode(body.mode)
            if (sessionId === undefined || mode === undefined) {
              sendJson(res, 400, { error: 'sessionId and a valid mode are required' })
              return
            }
            const catalog = await catalogFor(sessionId)
            const registration = registrationFor(sessionId)
            registration.seeded = true
            applyMode(registration.state, mode, workSkills, catalog.map((s) => s.name))
            const agent = agentFor(sessionId)
            if (agent !== undefined) syncTool(agent, registration)
            publish('changed')
            sendJson(res, 200, { mode: registration.state.mode, skills: toRows(catalog, registration.state) })
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
      },
    })

    // Group mounting moves whole families in and out of the hub. It is a host
    // filesystem operation, not a session preference, so the response carries
    // the new group state and every open strip refreshes.
    host.webServer.register({
      kind: 'exact',
      path: `${routePrefix}/group`,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          try {
            if (req.method !== 'POST') {
              res.writeHead(405, { allow: 'POST' })
              res.end()
              return
            }
            const body = await readBody(req)
            const groupId = typeof body.group === 'string' ? body.group : undefined
            const mounted = typeof body.mounted === 'boolean' ? body.mounted : undefined
            if (groupId === undefined || mounted === undefined) {
              sendJson(res, 400, { error: 'group and mounted are required' })
              return
            }
            const group = skillGroups.find((candidate) => candidate.id === groupId)
            if (group === undefined) {
              sendJson(res, 404, { error: `unknown group "${groupId}"` })
              return
            }
            const result = await setGroupMounted(group, mounted)
            // The catalog changed on disk; drop the memo and wake every strip.
            catalogCache.clear()
            publish('changed')
            sendJson(res, 200, {
              groups: groupViews(),
              moved: result.moved,
              ...(result.error !== undefined ? { error: result.error } : {}),
            })
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
      },
    })
  })

  // A provider edit (a skill added, removed, or re-ranked) invalidates the
  // catalog every live session renders, so each open strip re-reads.
  ctx.on('skills/change', () => {
    // Drop the per-session catalog memo BEFORE notifying: the strip re-reads
    // state on the frame, so a cached catalog would hand it the stale list it
    // is being told to refresh away from.
    catalogCache.clear()
    publish('changed')
  })
}
