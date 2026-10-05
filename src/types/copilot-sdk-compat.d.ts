/**
 * Copilot SDK 1.0.x 的 Node 类型在部分版本中把 onPreToolUse 的返回值
 * 收窄成不允许 null，但 SDK 文档和运行时都允许 hook 返回 null/undefined 表示放行。
 *
 * 这里仅放宽 createSession 的配置输入类型，不改变运行时行为；等项目升级到
 * 与实现一致的 SDK 类型后可以删除本兼容层。
 */
import type { CopilotSession } from '@github/copilot-sdk';

declare module '@github/copilot-sdk' {
  interface CopilotClient {
    createSession(config: any): Promise<CopilotSession>;
  }
}
