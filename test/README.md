# 测试

```bash
bash test/run-all.sh
```

| 文件 | 覆盖 |
|:--|:--|
| `verify-scope-routing.mjs` | `agent.ctx.tools.register()` 落在 agent scope 而非 global（**设计地基**） |
| `session-state.test.mjs` | 模式应用、work 清单与实时目录求交、行投影、输入校验 |
| `integration-routes.mjs` | 真实 cordis Context 下驱动 HTTP 路由：挂载、切换、模式、错误码、销毁清理 |
| `integration-catalog.mjs` | 驱动 `agent/pre-step`：首次发布、无变化不重发、切换后发 replacement、关闭的 skill 无法加载、全关后不再注入 |
| `provider.test.mjs` | 目录发现：嵌套与扁平、跳过 README/隐藏目录、缺 description 拒绝、正文加载 |

`provider.test.mjs` 依赖 `lib-probe/`（单独编译的 provider 模块）：

```bash
npx tsc -p tsconfig.provider.json
```

`extract-state-region.mjs` 是 `session-state.test.mjs` 的辅助脚本，从 `lib/index.js` 提取编译后的纯逻辑区域。
