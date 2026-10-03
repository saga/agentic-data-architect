import { useMemo, useState } from 'react';
import { Button, Flex, Segmented, Tag, Typography } from 'antd';
import { RobotOutlined, UserOutlined } from '@ant-design/icons';
import { Bubble, Sender, type BubbleListProps } from '@ant-design/x';

import type { WorkflowChange, WorkflowDefinition } from './journey-map-types.js';

export interface JourneyMapAiChatProps {
  currentDefinition?: WorkflowDefinition;
  selectedNodeId?: string;
  pendingAiChange?: { message: string; changes: WorkflowChange[] };
  aiEditFlow: (
    mode: 'generate' | 'modify',
    prompt: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
    scope?: 'workflow' | 'selection',
  ) => Promise<{ message: string; changes: WorkflowChange[] } | undefined>;
  applyAiChanges: () => Promise<void>;
  discardAiChanges: () => void;
}

/**
 * 工作地图专用 AI 对话。
 *
 * 这里不做普通 Chat，而是一个“边看图、边改图”的设计助手：
 * - 每一轮都把当前画布作为真实状态；
 * - 同时带上最近几轮对话，让用户可以连续说“再加一个人工确认”“把这个判断点提前”；
 * - AI 只返回新的 Workflow Definition，真正保存仍由页面顶部“保存”完成。
 */
export function JourneyMapAiChat({
  currentDefinition,
  selectedNodeId,
  pendingAiChange,
  aiEditFlow,
  applyAiChanges,
  discardAiChanges,
}: JourneyMapAiChatProps) {
  const [mode, setMode] = useState<'modify' | 'generate'>('modify');
  const [scope, setScope] = useState<'workflow' | 'selection'>(
    selectedNodeId ? 'selection' : 'workflow',
  );
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
  }>>([
    {
      id: 'journey-ai-welcome',
      role: 'assistant',
      content:
        '我可以直接帮你修改当前工作地图。可以连续告诉我怎么调整，例如“再增加一个人工评审”“把这个判断移到前面”，每一轮都会基于当前画布继续修改。',
    },
  ]);

  const visibleMessages = useMemo(
    () => messages.slice(-12),
    [messages],
  );

  const role: BubbleListProps['role'] = {
    assistant: { placement: 'start' },
    user: { placement: 'end' },
  };

  const submit = async (nextValue: string) => {
    const prompt = nextValue.trim();
    if (!prompt || loading || !currentDefinition) return;

    const history = messages.slice(-12).map(({ role, content }) => ({
      role,
      content,
    }));

    setMessages((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        role: 'user',
        content: prompt,
      },
    ]);
    setValue('');
    setLoading(true);

    try {
      const result = await aiEditFlow(mode, prompt, history);
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content:
            result?.message
            ?? '我已经更新了一版工作地图，请检查画布后继续告诉我需要调整的地方。',
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="journey-map-ai-chat">
      <div className="journey-map-ai-chat-header">
        <div>
          <Flex align="center" gap={7}>
            <RobotOutlined />
            <Typography.Text strong>工作地图 AI</Typography.Text>
            <Tag bordered={false}>{mode === 'modify' ? '修改当前图' : '重新设计'}</Tag>
          </Flex>
          <Typography.Text type="secondary">
            连续对话修改，检查后点击“保存”才会成为新的 Workflow。
          </Typography.Text>
        </div>

        <Segmented
          size="small"
          value={mode}
          onChange={(next) => setMode(next as 'modify' | 'generate')}
          options={[
            { value: 'modify', label: '修改' },
            { value: 'generate', label: '重设计' },
          ]}
        />
      </div>

      <div className="journey-map-ai-chat-body">
        <Bubble.List
          role={role}
          items={visibleMessages.map((item) => ({
            key: item.id,
            role: item.role,
            content: item.content,
            avatar:
              item.role === 'user'
                ? <UserOutlined />
                : <RobotOutlined />,
          }))}
        />
      </div>

      <Sender
        value={value}
        loading={loading}
        onChange={setValue}
        onSubmit={(nextValue) => void submit(nextValue)}
        placeholder={
          mode === 'modify'
            ? '例如：在现状确认后增加一个人工评审，再进入目标设计'
            : '例如：重新设计成 6 个步骤，并在关键处加入人工确认'
        }
      />
    </section>
  );
}
