# dsh-skill-switch

> DeepSeek Harness 插件，主题是**别为没在用的 skill 付 token** —— 按会话省，
> 也按整族省。

每个会话在输入框上方得到一条可折叠的技能条：哪些 skill 已加载、点一下就切换、
三个姿态预设。又大又互相依赖的技能族可以整体停在枢纽之外，需要时一次挂上。

---

## 问题：skill 不用也占 token

DSH 的 skill 本来就是懒加载的 —— 模型要用了才调 `skill` 工具读正文。
**目录不懒**：每个 step 前，官方 `tool-skill` 会把所有 model-invocable skill
以 `<available_skills>` 注入会话。所以一个你从不碰的 skill，也在**每一步**收你的费。
而且没法在会话开始前说「这次只是聊天，别给我挂这些」。

### 三层，以及哪一层才是关键

设计针对三种不同的开销，按大小递增：

| 层 | 手段 | 省掉什么 |
|:--|:--|:--|
| ① | 从 catalog 移除该 skill | 一行描述 |
| ② | 模型看不见 → 不会去加载它 | **整篇 `SKILL.md` 正文** |
| ③ | 全关 → `skill` 工具本身卸载 | 连它的 JSON Schema |

**② 才是重点。** 一行目录几十到两百字符；一次真实加载注入的正文通常几百到几千。
① 的主要作用其实是促成 ② —— 把那一行藏起来，模型才不知道有这个 skill。
③ 收益最小，但既然已经全关了，它是白捡的。

### 在真实仓库上实测

下面的数字来自真实的 `~/.agents/skills` 枢纽和一个停车的技能族。单位是**字符**，
不是 token —— token 数取决于分词器以及模型如何切分中英混排，所以这里用能从文件
直接复算的单位。**看比例，不要看绝对值**：

| | 技能数 | catalog 开销 |
|:--|--:|--:|
| 枢纽技能，全部启用 | 7 | 749 字符（平均 107/行） |
| 一个互相依赖的族，已停车 | 27 | **0** |
| 同一个族，已挂载 | 27 | 5,559 字符（平均 205/行） |

这张表说明两件事：

- **目录行不小。** 一行 205 字符对写得好的 skill 描述很典型 —— 那是好路由的代价，
  而且每一步都在付。
- **停车优于隐藏。** 挂载那个族要付 5,559 字符，无论会话用不用；停车则是 0，
  因为目录真的被移出了枢纽。把 skill 藏在 catalog 里仍要付它们的行 —— 注册表必须
  先发现它们，才谈得上过滤。

### 为什么按会话、又为什么按整族

这两个设计选择来自 skill 的实际用法：

- **按会话**，因为意图随对话变化。纯头脑风暴的会话不该为编码工具箱付费，
  而「一个 skill 都不挂」应该是一次点击，而不是跟模型商量。
- **按整族**，因为有些族拆不开。成员之间用相对路径互引
  （`lark-doc` → `../lark-shared`），单独挂一个会断链，全列进目录又要付每一行。
  「整组进出」不是简化 —— 它是唯一匹配这种依赖关系的形状。

---

## 安装

```bash
# 1. 构建（插件目录内）
npm install && npm run build

# 2. 挂进 profile：在 <profile>/package.json 里加
#    dependencies: { "dsh-skill-switch": "link:/path/to/dsh-skill-switch" }
#    dsh.profile.bundles: [..., "dsh-skill-switch"]

# 3. 让插件能解析 @deepseek-ai/*
ln -s ~/.dsh/profiles/node_modules <插件目录>/node_modules
```

发布之后也可以：

```bash
dsh plugin --profile web add dsh-skill-switch
```

然后重启 DSH。

> **⚠️ 本插件会替换官方的 `skill` 工具。**
> 它的 `cordis.patch.yml` 会禁用 `@deepseek-ai/dsh-tool-skill`，并注册自己的
> `skill` 工具与目录注入。这个替代品是从官方实现移植的（叠加了会话级过滤），
> **不是**官方的包装。如果你依赖官方插件的具体行为，装之前先看
> [为什么接管 `tool-skill`](#为什么接管-tool-skill)。

---

## 配置

默认值是中性的，写在插件自带的 `cordis.patch.yml` 里。**所有跟部署相关的设置**
都放你自己的 profile patch（`<profile>/cordis.patch.yml`），按行 id 覆盖：

```yaml
- id: skill-switch
  name: dsh-skill-switch
  config:
    defaultMode: all          # 新会话默认姿态：all | none | work
    workSkills: []            # 「干活模式」启用的 skill
    syncScript: ''            # 同步脚本绝对路径；留空则不显示按钮
    hubDir: ''                # host 扫描的枢纽绝对路径（技能组需要）
    skillGroups: []           # 整组进出的技能族，见下
```

`defaultMode: all` 保持原行为 —— 你想关的时候再关。想让每个会话默认从零开始，
改成 `none`。

### 同步（`syncScript`）

host 从**枢纽目录**读 skill，不是从你写 skill 的地方读。如果你的技能仓库在别处
（网络盘、同步目录），就需要一个脚本把两者连起来：

| 环节 | 谁 | 自动？ |
|:--|:--|:--|
| 仓库 → 枢纽（搬运） | `syncScript` | ❌ 技能条上的按钮 |
| 枢纽 → 技能条（显示） | 文件 watcher + SSE | ✅ 自动 |

把 `syncScript` 指向你的脚本，技能条上会出现「同步技能」按钮。点它 = 跑脚本 +
清 catalog 缓存 + 推送刷新到所有打开的技能条。

**手动是刻意的**：如果仓库在网络盘上，每次扫描都有开销；你决定何时付这个成本，
不看的时候什么都不跑。**两者缺一不可** —— 没同步的话 host 根本不知道新 skill
存在，技能条上没有东西可刷新。

反馈按 macOS 惯例，不做常驻日志面板：

| 阶段 | 按钮显示 | 之后 |
|:--|:--|:--|
| 运行中 | `◌ 同步中` | — |
| 成功 | `✓ 已同步` | **2 秒后自动恢复**，零布局成本 |
| 失败 | `⚠ 同步失败`（红） | 停留，并展开脚本输出 |

成功不需要确认，所以自己撤走；失败要你处理，所以留着，而且它的文字正是告诉你
哪里出问题的东西。

### 技能组（`skillGroups`）

有些技能族**又大又互相依赖**：成员的 `SKILL.md` 用相对路径互引
（`lark-doc` → `../lark-shared`）。逐个开关表达不了它们 —— 单独开一个会断链，
全列进目录又要付全部 catalog 行，无论会话用不用。

技能组把整族停在枢纽之外，一次移进或移出：

| 状态 | catalog 开销 | 成员位置 |
|:--|:--|:--|
| 已停车 | **0** | `parkDir` |
| 已挂载 | 每个一行 | `hubDir` |

```yaml
hubDir: '/home/you/.agents/skills'
skillGroups:
  - id: lark
    label: '飞书 CLI'
    description: '27 个飞书技能，整组挂载/卸下'
    parkDir: '/home/you/.agents-parked/lark'
    discover: true          # 从 parkDir 读成员，无需手工维护清单
```

技能条上每个组一个虚线 chip：停车时 `⬡ 飞书 CLI 27`，挂载后变实线。点一下整组移动。

**为什么整组，以及为什么是移目录而不是藏行。** 三个设计决策，每个都在换 token：

1. **停车是 0，隐藏要付行。** 最便宜的 token 是从没发出去的。把 skill 藏在 catalog
   里，注册表仍必须先发现它 —— 而发现正是渲染那一行的动作，所以逐个过滤最多只能
   去掉它已经付过成本的那一行。把目录移出枢纽，注册表就根本看不到它。在上表那个族
   上，这就是 0 与 5,559 字符的差别。
2. **整组进出，因为这一族确实是原子的。** 成员互相用相对路径引用；逐个开关会允许
   你造出坏状态（挂了成员，它的 `lark-shared` 依赖却还停着）。组开关无法表达这种
   状态 —— 这正是它的价值。
3. **roster 文件，让计数扛得住重启。** 挂载后 park 目录是空的，成员关系必须记在
   某处；内存里的列表会在下次 host 启动时报 0 个成员，而那恰好是用户刚刚切进去
   的状态。

**成员名单**：挂载时会把名单写进 `<parkDir>/.members`。挂载后 park 目录是空的，
那份文件是成员关系的唯一记录 —— 内存里的列表扛不住 host 重启。卸载时读它决定
搬回哪些。

**安全边界**：组的成员只能从 `parkDir` 读，**绝不扫枢纽根** —— 枢纽里有大量无关
技能，按枢纽扫描会把它们也当成成员，下次卸载一起搬走。
`test/group.test.mjs` 把这个约束锁住了。

---

## 界面

输入框上方一条可折叠的技能条。

**折叠态**（默认，一行）：

```
▶ 技能  3/9  jxh、video-diag、insight-mining          同步技能
```

**展开态**：

```
▼ 技能  3/9                                           同步技能
[聊天模式] [干活模式] [全部]  ⬡ 飞书 CLI 27  ● jxh  ○ video-diag
```

- 点 `▶ 技能` 折叠/展开，选择记在 `localStorage`
- 折叠时列出已加载的技能名，一眼能确认
- 实心圆点 = 已加载，空心 = 未加载，点击切换
- `聊天模式` = 全关，`干活模式` = 只开 `workSkills`，`全部` = 全开
- 技能组显示为虚线 chip，带成员数量

**默认折叠**：这个位置在输入框正上方，展开的 chip 列表会把对话区顶上去。

---

## 状态语义

**纯内存、按会话。** 新会话从 `defaultMode` 开始，重启后所有开关归零。这是刻意的
—— 每个会话重新挑一次，不引入存储依赖。

**技能组是例外**：它移动磁盘目录，所以状态属于机器而非会话，会持久保留。

---

## 架构

```
┌─ 浏览器 ─────────────────────────────────┐
│ conversation.input.dock：技能条           │
│         │ fetch /skill-switch/*           │
└─────────┼─────────────────────────────────┘
┌─ Host ───────────────────────────────────┐
│ webServer 路由 + Map<sessionId, 状态>     │
│ agent/created → 注册工具与目录            │
│ 自己渲染 catalog（按开关过滤）             │
└───────────────────────────────────────────┘
```

### 为什么接管 `tool-skill`

两个硬约束排除了「轻量拦截」：

1. **`ctx.skills.registerProvider()` 永远落在全局层**，且它的 `list()` 只拿到
   `{ cwd, signal }` —— 没有 agent 身份 —— 所以 provider 无法按会话分流。
2. **官方 catalog 有 digest 比对。** 在它背后过滤会让它认为目录变了，于是
   *每个 step* 都发一条 replacement 消息，污染会话日志。

所以本插件自己拥有 catalog 注入与 `skill` 工具，注册在 `agent.ctx` 上。
`tools.register` 读**调用者**的 scope，因此注册天然按会话，并在 agent 销毁时回收。

**为什么全关时是卸载工具而不是 `tools.restrict()`**：restriction 只过滤一个 scope
*继承*的工具，从不影响它自己层里注册的。`skill` 工具注册在 agent 自己的层，所以
restriction 摘不掉它，schema 会留在 prompt 里 —— 上面 token 模型的第 ③ 层就够不着。
卸载注册才是真正把 schema 拿出 prompt 的动作。

**为什么这个接管值得付维护成本。** 另一条路 —— 留着官方插件、在它背后过滤 ——
因为前面说的 digest 原因行不通：每个 step 都会追加一条 catalog 更新消息，省下的
比多花的还少。拥有注入权，是「会话级开关」能够存在的前提。

**代价**：官方 `dsh-tool-skill` 的后续变更不会自动跟进。这里的逻辑是官方实现的移植，
行为一致。

---

## 版本兼容

DSH 会校验第三方 bundle 的 peer 范围，**不匹配时静默跳过整个 bundle** —— 插件不
加载，但它的 patch 仍然生效。两个坑：

1. **运行时版本不是 profile 里的版本。** 桌面 App 通过 loader 的
   `internal.import(specifier, bareModuleBaseUrl)` 把 `@deepseek-ai/*` 重定向到它
   自己 asar 内的包（当前 `0.2.0-rc.2`），而不是 `<profile>/node_modules`。照抄
   profile 里的版本写 peer 范围，可能过不了校验。
2. **不含显式预发布分支的 peer 范围会静默排除所有预发布构建。** 用能点出预发布
   元组的并集：

```json
"@deepseek-ai/dsh-skill": "^0.1.0-rc.6 || ^0.2.0-rc.2"
```

**排查方法**：`plugin_manager list_bundles`，看该 bundle 有没有
`error.code: "incompatible-version"`。

### 跨版本 API 差异

`0.2.0-rc.2` 把 `Session` 从整日志数组改成 `seq` + `eventAt()`（旧读法已废弃），
并且 `agent/pre-step` 的 decision 建议展开而非重建。`catalog.ts` 的
`readEventsBackwards()` 同时接受两种形状，一次构建在两个运行时上都能跑。

---

## 测试

```bash
bash test/run-all.sh
```

| 文件 | 覆盖 |
|:--|:--|
| `verify-scope-routing.mjs` | `agent.ctx.tools.register()` 落在 agent scope 而非 global（**设计地基**） |
| `session-state.test.mjs` | 姿态应用、work 清单与实时目录求交、行投影、输入校验 |
| `integration-routes.mjs` | 真实 cordis context 驱动 HTTP 路由：挂载、切换、模式、错误码、销毁清理 |
| `integration-catalog.mjs` | 驱动 `agent/pre-step`：首次发布、无变化不重发、切换后发 replacement、关闭的 skill 无法加载、全关后不再注入 |
| `sse-stream.test.mjs` | 共享事件流：无需 sessionId 即可打开、每个订阅者都收到帧、关闭的流静默、**共享流下会话隔离仍成立** |
| `group.test.mjs` | 技能组：挂载只动自己成员、**无关技能绝不被误移**、幂等、未知组 404、roster 跨重启存活 |

---

## 已知限制

- **接管了官方 `skill` 工具**，官方 `dsh-tool-skill` 的变更需要手动跟进。
- **skill 发现不是本插件的职责。** web 组合有意禁用了 host 的 `skill-filesystem`
  行（"presets own local discovery"）；需要本地仓库的部署应自行按自己的枢纽重新
  启用那个 provider。本插件只过滤注册表已经知道的内容。
- **`discover` 模式的成员只从 `parkDir` 读。** 挂载后手工从枢纽删掉成员的族，重启
  后会丢失名单。
- 会话状态是内存态；只有技能组状态是持久的。

---

## 许可

MIT
