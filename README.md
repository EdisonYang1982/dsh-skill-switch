# dsh-skill-switch

> A DeepSeek Harness plugin about **spending fewer tokens on skills you are not
> using** — by session, and by whole family.

Every session gets a collapsible strip above the composer showing which skills
it loads, with a toggle per skill and three posture presets. Large interdependent
skill families can be parked outside the host's skill hub entirely and mounted as
one unit.

---

## The problem: skills cost tokens even when unused

DSH skills are already lazily loaded — the model only reads a `SKILL.md` body when
it calls the `skill` tool. **The catalog is not lazy.** Before every step, the
official `tool-skill` injects every model-invocable skill as an
`<available_skills>` block, so a skill you never touch still bills you on every
single step. And there is no way to say "this session is just a conversation — do
not offer me any of these" before it starts.

### Three layers, and which one actually matters

The design targets three separate costs, in ascending order of size:

| Layer | Mechanism | What it saves |
|:--|:--|:--|
| 1 | Skill removed from the catalog | One description line |
| 2 | Model cannot see it, so it never loads it | **The whole `SKILL.md` body** |
| 3 | Everything off → the `skill` tool itself unmounts | Even its JSON Schema |

**Layer 2 is the point.** A catalog line is tens to ~200 tokens; a real load
injects a body that is routinely hundreds to thousands. Layer 1 exists mainly to
achieve layer 2 — hiding the line is how the model stops knowing the skill is
there. Layer 3 is the smallest but free once you are already all-off.

### Measured on a real repository

Numbers below come from an actual `~/.agents/skills` hub and a parked family. They
are **characters**, not tokens — token count depends on the tokenizer and on how
the model splits mixed CJK/Latin text, so the honest unit here is the one that can
be reproduced from the files. Treat the ratios as the finding, not the absolute
figures:

| | Skills | Catalog cost |
|:--|--:|--:|
| Hub skills, all enabled | 7 | 749 chars (avg 107/line) |
| One interdependent family, parked | 27 | **0** |
| The same family, mounted | 27 | 5,559 chars (avg 205/line) |

Two things that table says:

- **Catalog lines are not small.** 205 characters per line is typical for a
  well-written skill description — that is the price of good routing, and it is
  paid every step.
- **Parking beats hiding.** Mounting that family costs 5,559 characters whether
  or not the session uses it. Parked, it costs nothing, because the directories
  are genuinely moved out of the hub. Hiding skills in the catalog still pays for
  their lines — the registry must discover them before anything can filter them.

### Why per-session, and why per-family

Two design choices follow from how skills are actually used:

- **Per session**, because intent changes by conversation. A pure brainstorming
  session should not pay for the coding toolkit, and a "no skills at all" posture
  should be one click rather than an argument with the model.
- **Per family**, because some families cannot be split. Their members link each
  other by relative path (`lark-doc` → `../lark-shared`), so loading one alone
  breaks its references, while listing all of them bills every line. All-or-nothing
  is not a simplification — it is the only shape that matches the dependency.

---

## Install

```bash
# 1. Build (inside the plugin directory)
npm install && npm run build

# 2. Link it into a profile: add to <profile>/package.json
#    dependencies: { "dsh-skill-switch": "link:/path/to/dsh-skill-switch" }
#    dsh.profile.bundles: [..., "dsh-skill-switch"]

# 3. Let the plugin resolve @deepseek-ai/* from the profile
ln -s ~/.dsh/profiles/node_modules <plugin>/node_modules
```

Or, once published:

```bash
dsh plugin --profile web add dsh-skill-switch
```

Restart DSH afterwards.

> **⚠️ This plugin replaces the official `skill` tool.**
> Its `cordis.patch.yml` disables `@deepseek-ai/dsh-tool-skill` and registers its
> own `skill` tool plus session catalog. The replacement is a port of the official
> implementation with per-session filtering added — not a wrapper around it. If you
> depend on the official plugin's exact behaviour, read
> [Why it takes over `tool-skill`](#why-it-takes-over-tool-skill) before installing.

---

## Configuration

Defaults are neutral and live in the bundled `cordis.patch.yml`. Everything
deployment-specific belongs in **your profile patch** (`<profile>/cordis.patch.yml`),
keyed by the row id:

```yaml
- id: skill-switch
  name: dsh-skill-switch
  config:
    defaultMode: all          # posture a new session starts in: all | none | work
    workSkills: []            # skills the `work` posture enables
    syncScript: ''            # absolute path of a sync script; empty hides the control
    hubDir: ''                # absolute path of the hub the host scans (needed for skillGroups)
    skillGroups: []           # all-or-nothing bundles, see below
```

`defaultMode: all` keeps the stock behaviour — you turn things off when you want
to. Set `none` if you would rather opt in per session.

### Sync (`syncScript`)

The host reads skills from a **hub directory**, not from wherever you author them.
If your skill repository lives elsewhere (a network mount, a synced folder), a
script bridges the two:

| Stage | Who | Automatic? |
|:--|:--|:--|
| Repository → hub (copy) | `syncScript` | ❌ a button in the strip |
| Hub → strip (display) | file watcher + SSE | ✅ automatic |

Point `syncScript` at your script and a **Sync skills** button appears. Clicking it
runs the script, invalidates the catalog cache, and pushes a refresh to every open
strip.

**Manual on purpose.** If the repository is on a network mount, every scan costs
something; you decide when to pay it, and nothing runs while you are not looking.
Both halves are required — without the sync the host does not know the new skill
exists, so there is nothing for the strip to refresh.

Feedback follows the macOS idiom rather than a persistent log pane:

| Phase | Button shows | Then |
|:--|:--|:--|
| Running | `◌ Syncing` | — |
| Success | `✓ Synced` | **reverts after 2s** — no layout cost |
| Failure | `⚠ Sync failed` (red) | stays, and unfolds the script's output |

Success needs no acknowledgement, so it withdraws. Failure stays because it asks
something of you, and its text is what tells you what went wrong.

### Skill groups (`skillGroups`)

Some skill families are both **huge** and **interdependent**: a member's
`SKILL.md` links its siblings by relative path (`lark-doc` → `../lark-shared`). A
per-skill switch cannot express them — loading one alone breaks its references,
and listing all of them costs their catalog lines whether or not the session uses
them.

A skill group parks the family outside the hub and moves it in or out as one unit:

| State | Catalog cost | Members live in |
|:--|:--|:--|
| Parked | **0** | `parkDir` |
| Mounted | one line each | `hubDir` |

```yaml
hubDir: '/home/you/.agents/skills'
skillGroups:
  - id: lark
    label: 'Feishu CLI'
    description: '27 Feishu skills, mounted and parked as one unit'
    parkDir: '/home/you/.agents-parked/lark'
    discover: true          # read members from parkDir; no hand-maintained list
```

The strip shows a dashed chip per group: `⬡ Feishu CLI 27` when parked, solid when
mounted. Clicking moves the whole family.

**Why whole groups, and why moving directories rather than hiding lines.** Three
design decisions, each buying tokens:

1. **Parked costs 0, hidden costs its lines.** The cheapest token is one never
   sent. Hiding a skill in the catalog still requires the registry to discover it
   first, and discovery is what renders the line — so per-skill filtering can
   only ever remove the line it already paid to compute. Moving the directory out
   of the hub means the registry never sees it at all. On the measured family
   above that is the difference between 0 and 5,559 characters.
2. **All-or-nothing, because the family is genuinely atomic.** Members reference
   each other by relative path; a per-member switch would let you build a broken
   state (one member mounted, its `lark-shared` dependency parked). A group switch
   cannot express that state, which is the point.
3. **A roster file, so the count survives a restart.** After mounting, the park
   directory is empty — membership has to be recorded somewhere, and an in-memory
   list would report 0 members on the next host start, which is exactly the state
   the user just switched into.

**Member roster.** Mounting writes the member names to `<parkDir>/.members`.
After a mount the park directory is empty, so that file is the only record of
membership — an in-memory list would not survive a host restart. Unmounting reads
it to decide what moves back.

**Safety boundary.** Group membership is read from `parkDir` only, **never by
scanning the hub root** — the hub holds unrelated skills, and scanning it would
adopt them into the group and sweep them into the park directory on the next
unmount. `test/group.test.mjs` locks this down.

---

## Interface

A collapsible strip above the composer.

**Collapsed** (the default — one line):

```
▶ Skills  3/9  jxh, video-diag, insight-mining        Sync skills
```

**Expanded**:

```
▼ Skills  3/9                                          Sync skills
[Chat] [Work] [All]  ⬡ Feishu CLI 27  ● jxh  ○ video-diag
```

- Click `▶ Skills` to collapse or expand; the choice is remembered in `localStorage`
- Collapsed, it lists the enabled skill names, so you can confirm at a glance
- Solid dot = loaded, hollow = not; click to toggle
- `Chat` = none, `Work` = only `workSkills`, `All` = everything
- Groups render as dashed chips with their member count

**Collapsed by default** because this seat sits directly above the composer: an
expanded chip list pushes the conversation up.

---

## State semantics

**In-memory, per session.** A new session starts from `defaultMode`, and a restart
forgets every toggle. That is deliberate — each session picks again, with no
storage dependency.

Skill **groups** are the exception: they move directories on disk, so their state
is a property of the machine, not the session, and it persists.

---

## Architecture

```
┌─ Browser ────────────────────────────────┐
│ conversation.input.dock: the strip        │
│         │ fetch /skill-switch/*           │
└─────────┼─────────────────────────────────┘
┌─ Host ───────────────────────────────────┐
│ webServer routes + Map<sessionId, state>  │
│ agent/created → register tool + catalog   │
│ renders the catalog itself (filtered)     │
└───────────────────────────────────────────┘
```

### Why it takes over `tool-skill`

Two constraints rule out a lighter interception:

1. **`ctx.skills.registerProvider()` always files into the GLOBAL layer**, and its
   `list()` receives only `{ cwd, signal }` — no agent identity — so a provider
   cannot branch per session.
2. **The official catalog compares digests.** Filtering behind its back makes it
   see a changed catalog and publish a replacement message on *every step*,
   polluting the session log.

So this plugin owns the catalog injection and the `skill` tool, registering them on
`agent.ctx`. `tools.register` reads the **caller's** scope, so the registration is
per-session and is collected when the agent is disposed.

**Why disabling everything unmounts the tool instead of using `tools.restrict()`**:
a restriction filters only what a scope *inherits* and never what its own layer
registers. The `skill` tool is registered in the agent's own layer, so a
restriction cannot remove it and its schema would stay in the prompt — layer 3 of
the token model above would be unreachable. Unmounting the registration is what
actually takes the schema out of the prompt.

**Why the takeover is worth its maintenance cost.** The alternative — leaving the
official plugin in place and filtering behind it — cannot work, for the digest
reason above: every step would append a catalog-update message, so the "saving"
would cost more context than it recovered. Owning the injection is the price of
the per-session switch existing at all.

**Cost**: upstream changes to `dsh-tool-skill` are not picked up automatically. The
logic here is a port of the official implementation and behaves identically.

---

## Version compatibility

DSH validates a third-party bundle's peer ranges and **silently skips the whole
bundle** when they do not match — the plugin does not load, but its patch still
applies. Two things bite:

1. **The runtime version is not the version in the profile.** The desktop app
   redirects `@deepseek-ai/*` to the packages inside its own asar
   (`0.2.0-rc.2` today) via the loader's
   `internal.import(specifier, bareModuleBaseUrl)`, not to
   `<profile>/node_modules`. Writing a peer range from the profile's copies can
   therefore fail validation.
2. **The version on npm is not the version the runtime provides either.** The
   check compares each range against the *runtime* version, so a package that
   stopped publishing to npm at `0.1.x` while the runtime ships `0.2.x` still has
   to be ranged against `0.2.x`. Ranging it against what npm happens to offer
   rejects the bundle. This is the mistake that shipped in `5b85d5d`:
   `dsh-client-runtime` publishes only up to `0.1.1-rc.2` on npm, but the desktop
   runtime provides `0.2.0-rc.2`, so a `^0.1.x` range skipped the whole plugin.
3. **A peer range without an explicit prerelease branch silently excludes every
   prerelease build.** Use a union that names the prerelease tuple:

```json
"@deepseek-ai/dsh-skill": "^0.1.0-rc.2 || ^0.1.0-rc.6 || ^0.1.5-rc.1 || ^0.2.0-rc.1 || ^0.2.0-rc.2"
```

**Diagnosing**: `plugin_manager list_bundles` — look for
`error.code: "incompatible-version"` on the bundle. The failure is silent from
the plugin's side: it does not load, yet its `cordis.patch.yml` still applies, so
`tool-skill` stays disabled while nothing takes over the `skill` tool.

**Verifying a range before shipping**: check it against the runtime version with
the same library DSH uses, rather than by reading version lists.

```js
const semver = require('semver')
semver.satisfies('0.2.0-rc.2', range, { includePrerelease: true })
```

### Cross-version API differences

`0.2.0-rc.2` changed `Session` from a whole-log array to `seq` + `eventAt()` (the
old reads are deprecated), and `agent/pre-step` decisions are best spread rather
than rebuilt. `catalog.ts`'s `readEventsBackwards()` accepts both shapes, so one
build runs on either runtime.

---

## Tests

```bash
bash test/run-all.sh
```

| File | Covers |
|:--|:--|
| `verify-scope-routing.mjs` | `agent.ctx.tools.register()` lands in the agent scope, not global (**the design's foundation**) |
| `session-state.test.mjs` | Posture application, work-list ∩ live catalog, row projection, input validation |
| `integration-routes.mjs` | Real cordis context driving the HTTP routes: mount, toggle, mode, status codes, disposal cleanup |
| `integration-catalog.mjs` | Driving `agent/pre-step`: first publication, no re-publish when unchanged, replacement on change, a disabled skill cannot load, no injection once unmounted |
| `group.test.mjs` | Skill groups: mounting moves only its own members, **unrelated skills are never swept**, idempotence, unknown group 404, roster survives a restart |

---

## Known limitations

- **Takes over the official `skill` tool.** Upstream changes to `dsh-tool-skill`
  need manual follow-up.
- **Skill discovery is not this plugin's job.** The web composition disables the
  host `skill-filesystem` row ("presets own local discovery"); a deployment that
  wants a local repository re-enables that provider against its own hub. This
  plugin only filters what the registry already knows about.
- **Group membership by discovery reads `parkDir` only.** A family mounted and then
  deleted from the hub by hand loses its roster on the next restart.
- Session state is in-memory; only group state is durable.

---

## License

MIT
