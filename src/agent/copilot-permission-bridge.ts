/**
 * Copilot Permission bridge。
 *
 * 默认 permission 模式需要把 SDK 的 permission request 留在 pending，
 * 交给工作台现有的 permission.requested UI + pending RPC 处理。
 *
 * 当前 copilot.ts 体量较大，这里用一个很小的 runtime adapter 避免重复实现
 * Session 创建逻辑；allow_all 已经提供 handler 时保持原行为不变。
 */
import { CopilotClient } from '@github/copilot-sdk';

const clientPrototype = CopilotClient.prototype as unknown as {
  createSession: (...args: any[]) => Promise<any>;
  resumeSession: (...args: any[]) => Promise<any>;
};

const originalCreateSession = clientPrototype.createSession;
const originalResumeSession = clientPrototype.resumeSession;

function withPendingPermissionHandler(config: any): any {
  if (config && typeof config === 'object' && typeof config.onPermissionRequest !== 'function') {
    return {
      ...config,
      onPermissionRequest: async () => ({ kind: 'no-result' as const }),
    };
  }
  return config;
}

clientPrototype.createSession = function patchedCreateSession(config: any, ...rest: any[]) {
  return originalCreateSession.call(this, withPendingPermissionHandler(config), ...rest);
};

clientPrototype.resumeSession = function patchedResumeSession(sessionId: string, config: any, ...rest: any[]) {
  return originalResumeSession.call(this, sessionId, withPendingPermissionHandler(config), ...rest);
};
