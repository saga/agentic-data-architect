# OpenCode 本机运行手册

工作台正式的 Investigation execution 走本机 `opencode run` headless CLI。`opencode serve` 只用于本机模型发现等辅助能力，不属于正式模型执行链。这里记录已经踩过的坑，
按这个清单配就不会再犯。

## 启动方式（唯一入口）

正式 Investigation 不要手动用 `opencode serve` 驱动模型，直接：

```bash
npm run dev     # 或 npm run start
```

`predev` / `prestart` 钩子会跑 `scripts/ensure-opencode.mjs`：

```bash
node scripts/ensure-opencode.mjs            # 检查并复用/拉起
node scripts/ensure-opencode.mjs --reset    # 先杀掉占端口的进程，再按 .env 重起
```

每次输出一张检查清单（✓ 通过 / ! 有问题）：地址合法、认证状态、
代理可达、opencode CLI 存在、端口复用或拉起。任何一项不满足都只告警，
不阻塞主服务（Copilot 通道照常能用）。日志在
`.workspace/opencode-serve.log`（gitignored）。

- 端口通但密码不对 → 不复用，提示手动停掉占位进程或用 `--reset`。
- 终端残留的 `export` 和 `.env` 不一致 → 用 `.env` 的值并告警。
- 代理连不上 → serve 照起，但出站模型会超时，提前告警。

## 环境变量对照（两边必须一致）

| 变量 | 作用 | 说明 |
|---|---|---|
| `OPENCODE_ENABLED` | 总开关 | `false` 则跳过 serve 检查，只走 Copilot 通道 |
| `OPENCODE_BASE_URL` | serve 地址 | 默认 `http://127.0.0.1:4096`，改端口两边一起认 |
| `OPENCODE_SERVER_PASSWORD` | serve 的 Basic 认证密码（用户名固定 `opencode`） | **必填**，serve 和 app 用同一个值 |
| `OPENCODE_MODEL_ALLOWLIST` | 下拉框模型白名单（逗号分隔，子串匹配 id 或显示名） | 为空 = 全部列出 |
| `OPENCODE_HTTP_PROXY` / `OPENCODE_HTTPS_PROXY` / `OPENCODE_ALL_PROXY` | serve 出站代理 | 默认本机 10809；Muse Spark 这类模型必须走代理 |

`.env` 示例（本文件不进 git，只活在本机）：

```bash
OPENCODE_SERVER_PASSWORD=dev-local-only
OPENCODE_MODEL_ALLOWLIST=opencode:opencode/muse-spark-1.3-contributor-free
```

## 出过问题的清单

### 1. `POST /session` 报 HTTP 400：`directory` 参数发了两遍

调用处手拼 `'/session?directory=' + x`，而 `openCodeFetch` 经 `withDirectory()`
又追加一次，最终 URL 是 `?directory=X&directory=X`。OpenCode 服务端把重复
参数解析成数组，zod 校验直接 400：`Expected string | undefined, got [...]`。

**规矩**：query 参数只允许 `openCodeFetch` / `withDirectory` 拼，调用方一律传
裸路径（如 `'/session'`）。改完用 `POST /session?directory=X` 和双参数各打一次，
确认前者 200、后者 400，才能算修对了地方。

### 2. HTTP 401：serve 和 app 用的密码不是同一个

当前脚本同时支持不启用和启用 Basic Auth 的本机 `opencode serve`。未启用认证时不需要配置密码；如果 serve 启用了 Basic Auth，app 与 serve 必须使用同一个 `OPENCODE_SERVER_PASSWORD`，否则工作台访问会得到 401。

- 如果 serve 启用了 Basic Auth，必须带显式密码，且和 `.env` 里是同一个值；未启用认证时无需配置。
- 终端里残留的 `export OPENCODE_SERVER_PASSWORD=...` 会覆盖 `.env`
  （dotenv 是环境变量优先），造成两边 mismatch。`ensure-opencode.mjs`
  以 `.env` 文件为准，检测到不一致会告警。看到告警就 `unset` 掉残留值。
- 端口通不代表能用：脚本会拿文件密码实际调一次 `/provider`，
  401 就说明端口被一个密码不明的 serve 占了，先停掉它再跑。

### 3. 模型调不通：serve 启动时没带代理

Muse Spark 等模型要出站代理。serve 进程的环境变量必须含三个代理，
`ensure-opencode.mjs` 会自动带上；**手动**起 serve 时自己 export（见上表），
否则现象是 session 能建、发 prompt 一直转圈或超时。

### 4. 浏览器自动化验证走不通时，用最小实验程序代替

本机没有浏览器、chromium 下载超时时，不要硬装 Playwright。
写一个原生 fetch 的小脚本（参考 `/tmp/oc-experiment.mjs` 的思路，
不要提交到仓库），按 `src/agent/opencode.ts` 里 `askOpenCode` 的确切顺序打：
`POST /session` → `POST /session/:id/message`，打印状态码和 body。
它和 UI 触发的是同一条代码路径，证据效力等同，失败时 body 里有真实原因
（`askOpenCode` 的 session 报错只拼了状态码，定位时看 body）。
