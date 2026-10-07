# ADR-025：Global / Task 配置与缓存边界，以及远程媒体解析

- Status: Accepted
- Date: 2026-10-07
- Decision scope: Global configuration, Investigation configuration, cache boundaries, remote avatar/media resolution

## Context

项目已经有 Global Agent Configuration 与 Investigation-level sparse override，但之前只有后端继承逻辑，没有清晰的 UI 作用域，也没有统一的 Global Cache / Task Cache 边界。

远程头像还存在一个实际问题：用户可能提供的是网页 URL，而不是实际媒体 URL，例如 X 的：

`https://x.com/<user>/status/<id>/video/1`

浏览器不能把这类帖子 URL 直接当成 `<video src>`。同时，第三方真实媒体 URL 可能临时失效，因此仅依赖远程 URL 不够可靠。

## Decision

### 1. 四层运行时边界

采用明确的四层：

| 层 | 生命周期 | 典型内容 | 默认位置 |
|---|---|---|---|
| Global Config | 工作台级、跨 Investigation | Agent 默认行为、长期人格、模型、MCP 等 | `.data/global-config.json` |
| Global Cache | 工作台级、跨 Investigation、可复用 | 远程图片/视频解析后的本地副本 | `.data/cache/` |
| Task Config | Investigation 级、随任务保存 | Research、Workflow、以及显式 Agent override | `.workspace/<session>/control.json` |
| Task Cache | Investigation 级、可删除、不可作为 Global 数据 | 当前任务临时中间文件 | `.workspace/<session>/.cache/` |

实际目录分别由 `DATA_DIR` 与 `WORKSPACE_DIR` 控制。

### 2. Global / Task Config 仍采用 sparse override

Effective Agent Config：

`Effective = Global defaults + Task explicit overrides + runtime-owned capabilities`

Task 未覆盖的字段继续继承 Global。

配置页面必须明确显示当前编辑的是 Task，并展示 Global version / Task version 及两者的存储边界。把当前 Task Agent 设置提升为 Global 是明确的、需要用户确认的跨任务动作。

### 3. Remote Media 采用“解析 -> 预热 Global Cache -> Remote first -> Cache fallback”

远程头像/媒体 URL 通过统一 resolver 处理。

对于支持的网站页面 URL，优先使用本机 `yt-dlp` 获取实际媒体 URL；对于直接媒体 URL，则直接使用。

解析得到的实际媒体会尝试写入 Global Cache，不能写入 Investigation 的 Task Cache。

UI 使用顺序：

1. 实际 remote media URL；
2. remote 加载失败时，切换到 Global Cache；
3. 两者都不可用时显示普通头像 fallback。

视频的 Global Cache endpoint 必须支持 HTTP Range。

### 4. X / Twitter URL

X/Twitter status URL 不视为 direct video URL。

例如 `/status/<id>/video/1` 由 yt-dlp 解析实际媒体地址，再按照 Remote first / Cache fallback 策略播放。

### 5. Cache 不进入 Task State

Global Cache 是共享运行时资源，不写入 Investigation 的 `context.json` 或 `control.json`。

Task Cache 只用于 Investigation 临时工作，不参与 Global media reuse。

## Consequences

- Global 与 Task 的生命周期和责任边界可从 UI 和文件结构直接看懂；
- 一个远程视频只需要解析/缓存一次即可被多个 Investigation 复用；
- X 等网页型媒体链接可以继续作为用户输入，不要求用户自己寻找真实 mp4 URL；
- 远程 URL 过期或 CORS/网络失败时，头像仍有本地副本可用；
- Global 修改不会自动覆盖已有 Task override。

代价是增加一个本机 `yt-dlp` 依赖，并需要维护 Global Cache 的磁盘生命周期。

## Rejected Alternatives

### A. 所有缓存都放在 Investigation workspace

Rejected。跨 Investigation 的远程媒体会重复下载，且违反 Global resource 的生命周期边界。

### B. 只保存远程 URL

Rejected。X 等网站返回的真实媒体 URL 可能临时失效，无法保证长期可用。

### C. 直接让浏览器播放 X status URL

Rejected。status URL 是网页/帖子资源，不是可直接作为 HTML5 media `src` 使用的媒体资源。

### D. 让 Task 配置直接修改 Global

Rejected。会破坏 ADR-013 的 Isolation，导致一个 Investigation 的配置修改产生不可预期的跨任务副作用。

## Related

- ADR-003：本机单用户 Agent runtime
- ADR-004：本地数据存储边界
- ADR-013：Global Config 与 Task Override 分层
- ADR-016：API Contract ownership 与 View Model
