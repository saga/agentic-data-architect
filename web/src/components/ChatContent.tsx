import React from 'react';
import { Typography } from 'antd';
import { Mermaid } from '@ant-design/x';
import { XMarkdown } from '@ant-design/x-markdown';

const { Text } = Typography;
export const markdownComponents = { mermaid: Mermaid as React.ComponentType<any> };

export function displayAssistantContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';

  // Agent 的结构化输出可能是裸 JSON，也可能被 Markdown 的 json code fence 包住。
  // 这些字段是内部协议，不应该原样出现在聊天气泡里。
  const candidates = [
    trimmed,
    trimmed.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim(),
  ];

  // 某些运行时会在 JSON 前后带少量说明文字；只取最外层 JSON 对象再解析。
  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (
        parsed
        && typeof parsed === 'object'
        && 'answer' in parsed
        && typeof parsed.answer === 'string'
      ) {
        return parsed.answer.trim();
      }
    } catch {
      // 尝试下一个可能的 JSON 包装形式。
    }
  }

  // 流式阶段 JSON 尚未收完整时，不把内部协议刷到屏幕上。
  if (/"answer"\s*:/.test(trimmed) && /[{}]/.test(trimmed)) return '';

  return content;
}

export function ChatMarkdown({ content }: { content: string }) {
  return (
    <XMarkdown
      content={displayAssistantContent(content)}
      components={markdownComponents}
      className="message-markdown x-markdown-light"
    />
  );
}

export function ChatMessageMeta(props: { speaker: string; capturedAt: string }) {
  return (
    <div className="chat-message-meta">
      <Text strong>{props.speaker}</Text>
      <Text type="secondary">{formatTime(props.capturedAt)}</Text>
    </div>
  );
}
