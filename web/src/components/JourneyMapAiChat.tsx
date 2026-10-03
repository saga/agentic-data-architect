import { useMemo, useState } from 'react';
import { Button, Flex, Tag, Typography } from 'antd';
import { RobotOutlined, UserOutlined } from '@ant-design/icons';
import { Bubble, Sender, type BubbleListProps } from '@ant-design/x';

import type { WorkflowChange, WorkflowDefinition } from './journey-map-types.js';

export interface JourneyMapAiChatProps {
  currentDefinition?: WorkflowDefinition;
  selectedNodeId?: string;
  pendingAiChange?: { message: string; changes: WorkflowChange[] };
  aiEditFlow: (
    prompt: string,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
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
 * - AI 只返回 typed Workflow Patch，先预览、确认后才进入当前画布。
 */
function changeLabel(change: WorkflowChange): string {
  switch (change.type) {
    case 'replace-definition': return '重新设计整张工作地图';
    case 'add-node': return '新增步骤：' + change.node.title;
    case 'update-node': return '修改步骤：' + change.nodeId;
    case 'remove-node': return '删除步骤：' + change.nodeId;
    case 'add-route': return '新增分支：' + change.nodeId + ' → ' + change.route.target;
    case 'update-route': return '修改分支：' + change.nodeId + ' / ' + change.outcome;
    case 'remove-route': return '删除分支：' + change.nodeId + ' / ' + change.outcome;
  }
}

export function JourneyMapAiChat({
  currentDefinition,
  selectedNodeId,
  pendingAiChange,
  aiEditFlow,
  applyAiChanges,
  discardAiChanges,
}: JourneyMapAiChatProps) {
  // 不再把“修改 / 重设计 / 选中步骤 / 整张图”做成模式按钮。
  // 用户直接用自然语言描述意图；当前选中节点仅作为默认上下文。
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
        '告诉我你要怎么调整即可，例如“增加一个人工评审”“把这个判断移到前面”。后续每一轮都会基于刚刚修改后的画布继续。',
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
      // 选中节点只是上下文，AI 仍可按用户的自然语言调整整张图。
      const result = await aiEditFlow(prompt, history);
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content:
            result?.message
            ?? 'AI 已提出修改，请先检查修改预览，再决定是否应用。',
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const selectedNode = selectedNodeId
    ? currentDefinition?.nodes.find((node) => node.id === selectedNodeId)
    : undefined;

  return (
    <section className="journey-map-ai-chat">
      <div className="journey-map-ai-chat-header">
        <Flex
          justify="space-between"
          align="center"
          gap={8}
          className="journey-map-ai-chat-title-row"
        >
          <Flex align="center" gap={7} style={{ minWidth: 0 }}>
            <RobotOutlined />
            <Typography.Text strong>AI 调整</Typography.Text>
          </Flex>
          <Tag bordered={false} color={selectedNode ? 'blue' : undefined}>
            {selectedNode ? selectedNode.title : '整张图'}
          </Tag>
        </Flex>
        <Typography.Text type="secondary" className="journey-map-inspector-desc">
          直接告诉 AI 怎么调整，修改会先预览，不会自动保存。
        </Typography.Text>
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

      {pendingAiChange ? (
        <div className="journey-map-ai-preview">
          <Flex align="center" justify="space-between" gap={8}>
            <Typography.Text strong>AI 修改预览</Typography.Text>
            <Tag color="blue">{pendingAiChange.changes.length} 项修改</Tag>
          </Flex>
          <Typography.Text type="secondary">
            {pendingAiChange.message}
          </Typography.Text>
          <div className="journey-map-ai-preview-list">
            {pendingAiChange.changes.slice(0, 8).map((change, index) => (
              <Typography.Text key={index} className="journey-map-ai-preview-item">
                {changeLabel(change)}
              </Typography.Text>
            ))}
            {pendingAiChange.changes.length > 8 ? (
              <Typography.Text type="secondary">
                还有 {pendingAiChange.changes.length - 8} 项修改。
              </Typography.Text>
            ) : null}
          </div>
          <Flex gap={8}>
            <Button type="primary" size="small" onClick={() => void applyAiChanges()}>
              应用修改
            </Button>
            <Button size="small" onClick={discardAiChanges}>
              取消
            </Button>
          </Flex>
        </div>
      ) : null}

      <Sender
        value={value}
        loading={loading}
        onChange={setValue}
        onSubmit={(nextValue) => void submit(nextValue)}
        placeholder="例如：在现状确认后增加一个人工评审，再进入目标设计"
      />
    </section>
  );
}
