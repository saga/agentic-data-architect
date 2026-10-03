# 项目长期约定（agentic-data-architect）

## 前端布局

- `html/body/#root` 都是 `height:100% + overflow:hidden`，antd `<App>` 又插了一层
  `div.ant-app`。**任何全屏子页面都必须自己限定高度并负责滚动**
  （`height:100%` + `overflow-y:auto`），只写 `min-height:100vh` 会被 `#root` 裁掉、滚不动。
  新增全屏页面时同时确认 `#root > .ant-app` 的高度链是通的。
- 主界面 `.app-shell` 用 `height:100vh`，内部各自滚动，不要改成百分比。
- antd 是 v6，内部类名和语义键都跟 v5 不同。写 CSS 命中 antd 内部结构前，
  先看 `node_modules/antd/es/<组件>/` 的实际 DOM 类名，别照抄 v5 的选择器。
  v6 已知差异：Tabs 是 `-nav / -body-holder / -body / -content`（没有 `-content-holder`、
  `-tabpane`）；Modal 的 `styles.content` 已改名 `styles.container`。
- 弹窗里的列表项样式类（如 `.selected-skill`）不要直接复用到 antd Card 上，
  会和 Card 自身的布局打架；给新场景单独起类名。

## 文案

- 面向用户的中文必须是说人话的中文，不夹英文整句（历史遗留的英文提示见到就顺手改）。

## 验证

- 改 UI 用 headless Chrome + CDP 实测，脚本放 `/tmp`，不要装 puppeteer/playwright。
- 注意：沙箱里 `curl 127.0.0.1` 连不上，用 Node 的 `fetch`；后台进程不要跨工具调用依赖。
