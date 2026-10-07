import React, { useMemo } from 'react';
import { Alert, Button, Card, Flex, Input, Select, Space, Tag, Tooltip, Typography } from 'antd';
import type { UploadFile } from 'antd';
import { Attachments, Bubble, Sender, Think } from '@ant-design/x';
import { FolderOpenOutlined, PaperClipOutlined } from '@ant-design/icons';
import { XMarkdown } from '@ant-design/x-markdown';
import { AssistantActionBar } from './AssistantActionBar';
import { AssistantAvatar } from './AssistantAvatar';
import { ChatMarkdown, ChatMessageMeta, displayAssistantContent } from './ChatContent';
import type {
  AutoTier,
  ExecutionStatus,
  PendingPermission,
  PendingUserInput,
  SessionData,
  CopilotModelOption,
} from '../app/types';

const { Text } = Typography;

export function InvestigationChatPanel(props: {
  current: SessionData;
  active?: string;
  loading: boolean;
  value: string;
  streamingReasoning: string;
  assistantCompanionNote: string;
  reasoningByMessage: Record<string, string>;
  assistantAvatarByMessage: Record<string, string>;
  streamingAnswer?: { key: string; content: string };
  nextGuidance: string[];
  pendingPermissions: PendingPermission[];
  pendingUserInputs: PendingUserInput[];
  userInputDrafts: Record<string, string>;
  attachments: UploadFile[];
  attachmentsOpen: boolean;
  uploadingFiles: Set<string>;
  availableModels: CopilotModelOption[];
  modelOptions: CopilotModelOption[];
  modelSaving: boolean;
  executionStatus: ExecutionStatus;
  turnStatus: string;
  error?: string;
  setValue: (value: string) => void;
  setAttachmentsOpen: (open: boolean) => void;
  setUserInputDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  send: (text?: string, routeId?: string, guided?: boolean) => Promise<void>;
  cancelActiveTurn: () => void;
  respondToPermission: (
    permission: PendingPermission,
    allowed: boolean,
    scope?: 'once' | 'session',
  ) => Promise<void>;
  respondToUserInput: (
    request: PendingUserInput,
    answer: string,
    wasFreeform: boolean,
  ) => Promise<void>;
  updateModelSettings: (model: string, autoTier: AutoTier | null) => Promise<void>;
  onAttachmentChange: ({ fileList }: { fileList: UploadFile[] }) => void;
  onStartPrompt: (prompt: string) => void;
}) {
  const bubbleItems = useMemo(() => {
    const messages = props.current.messages;
    const lastAssistantIndex = messages.reduce(
      (lastIndex, message, index) => message.role === 'assistant' ? index : lastIndex,
      -1,
    );
    const items = messages.map((message, index) => {
      const guidance = message.role === 'assistant' && index === lastAssistantIndex
        ? props.nextGuidance
        : undefined;
      const showActions = !props.current.context.workflow
        && message.role === 'assistant'
        && index === lastAssistantIndex
        && Boolean(guidance?.length || props.current.context.journeyPlan?.routes.length);

      return {
        key: message.id,
        role: message.role,
        ...(message.role === 'assistant'
          ? {
              avatar: (
                <AssistantAvatar
                  sessionName={props.current.context.name}
                  control={props.current.control}
                  avatarPath={props.assistantAvatarByMessage[message.id]}
                />
              ),
              styles: {
                avatar: {
                  width: Math.max(40, props.current.control.agent.avatarWidth || 180),
                  height: Math.max(40, props.current.control.agent.avatarHeight || 240),
                  flex: '0 0 auto',
                  alignSelf: 'flex-start',
                },
              },
            }
          : {}),
        content: message.role === 'assistant' ? (
          <div className="assistant-message-content">
            <ChatMessageMeta
              speaker={props.current.control.agent.displayName?.trim() || '秘书'}
              capturedAt={message.capturedAt}
            />
            {props.reasoningByMessage[message.id] ? (
              <Think
                title="思考过程"
                defaultExpanded={false}
                loading={false}
                classNames={{ root: 'assistant-think' }}
              >
                <XMarkdown
                  content={props.reasoningByMessage[message.id]}
                  className="message-markdown x-markdown-light"
                />
              </Think>
            ) : null}
            <ChatMarkdown content={message.content} />
            {showActions ? (
              <AssistantActionBar
                routeOptions={props.current.context.journeyPlan?.routes ?? []}
                followUpQuestions={guidance ?? []}
                loading={props.loading}
                onSelectRoute={(routeId) => void props.send(undefined, routeId)}
                onAsk={(question) => void props.send(question, undefined, true)}
              />
            ) : null}
          </div>
        ) : (
          <div className="user-message-content">
            <ChatMessageMeta speaker="我" capturedAt={message.capturedAt} />
            <Typography.Text>{message.content}</Typography.Text>
          </div>
        ),
      };
    });

    const currentStreamingAnswer = props.streamingAnswer;
    if (currentStreamingAnswer && currentStreamingAnswer.key === props.active) {
      items.push({
        key: 'streaming-assistant',
        role: 'assistant',
        avatar: <AssistantAvatar sessionName={props.current.context.name} control={props.current.control} />,
        styles: {
          avatar: {
            width: Math.max(40, props.current.control.agent.avatarWidth || 180),
            height: Math.max(40, props.current.control.agent.avatarHeight || 240),
            flex: '0 0 auto',
            alignSelf: 'flex-start',
          },
        },
        content: (
          <div className="assistant-message-content">
            <ChatMessageMeta
              speaker={props.current.control.agent.displayName?.trim() || '秘书'}
              capturedAt={new Date().toISOString()}
            />
            {props.assistantCompanionNote ? (
              <div className="assistant-companion-note">{props.assistantCompanionNote}</div>
            ) : null}
            {props.streamingReasoning ? (
              <Think
                title="助手正在分析问题"
                loading
                defaultExpanded={false}
                blink
                classNames={{ root: 'assistant-think' }}
              >
                <XMarkdown
                  content={props.streamingReasoning}
                  className="message-markdown x-markdown-light"
                />
              </Think>
            ) : null}
            {displayAssistantContent(currentStreamingAnswer.content)
              ? <ChatMarkdown content={currentStreamingAnswer.content} />
              : !props.streamingReasoning && !props.assistantCompanionNote
                ? <Text type="secondary" className="assistant-typing-indicator">…</Text>
                : null}
          </div>
        ),
      });
    }

    return items;
  }, [
    props.active,
    props.assistantAvatarByMessage,
    props.assistantCompanionNote,
    props.current,
    props.loading,
    props.nextGuidance,
    props.reasoningByMessage,
    props.send,
    props.streamingAnswer,
    props.streamingReasoning,
    props.turnStatus,
  ]);

  return (
    <div className="chat-main">
      {bubbleItems.length ? (
        <Bubble.List
          role={{
            assistant: { placement: 'start' },
            user: { placement: 'end' },
          }}
          items={bubbleItems}
          className="bubble-list"
        />
      ) : (
        <div className="empty-chat">
          <div className="empty-chat-inner">
            <Text className="empty-chat-title">开始调查</Text>
            <Text className="empty-chat-description">
              {props.current.context.mission
                ? '直接写下你想查清楚的问题。后续调查都会围绕本次任务目标展开。'
                : '先确认“为什么做”和“最后希望拿到什么”，确认后再开始调查。'}
            </Text>
            <div className="starter-prompts">
              {[
                'Position 最终来自哪里？',
                '梳理 Portfolio Market Value 的数据来源和转换过程。',
                '这个系统现在有哪些地方还没查清楚？',
              ].map((prompt) => (
                <Button
                  key={prompt}
                  className="starter-prompt"
                  size="small"
                  onClick={() => props.onStartPrompt(prompt)}
                >
                  {prompt}
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}

      {props.error ? (
        <Card size="small" className="error-card">
          <Text type="danger">{props.error}</Text>
        </Card>
      ) : null}

      {props.pendingPermissions.length ? (
        <div className="pending-permission-list">
          {props.pendingPermissions.map((permission) => {
            const target =
              permission.fullCommandText
              ?? permission.fileName
              ?? permission.path
              ?? (permission.serverName && permission.toolName
                ? `${permission.serverName} / ${permission.toolName}`
                : permission.toolName
                  ?? permission.toolTitle);
            return (
              <Alert
                key={permission.requestId}
                type="warning"
                showIcon
                title={
                  <Flex align="center" justify="space-between" gap={8} wrap>
                    <span>Agent 需要执行操作</span>
                    <Tag color="orange">{permission.kind}</Tag>
                  </Flex>
                }
                description={
                  <Flex vertical gap={6}>
                    {permission.intention ? <Text>{permission.intention}</Text> : null}
                    {target ? <Text type="secondary"><code>{target}</code></Text> : null}
                    {permission.readOnly !== undefined ? (
                      <Text type="secondary">{permission.readOnly ? '只读操作' : '可能修改文件或数据'}</Text>
                    ) : null}
                    <Space>
                      <Button
                        type="primary"
                        size="small"
                        onClick={() => void props.respondToPermission(permission, true)}
                      >
                        允许这次
                      </Button>
                      <Button
                        size="small"
                        danger
                        onClick={() => void props.respondToPermission(permission, false)}
                      >
                        拒绝
                      </Button>
                    </Space>
                  </Flex>
                }
              />
            );
          })}
        </div>
      ) : null}

      {props.pendingUserInputs.length ? (
        <div className="pending-user-input-list">
          {props.pendingUserInputs.map((request) => {
            const draft = props.userInputDrafts[request.requestId] ?? '';
            return (
              <Alert
                key={request.requestId}
                type="info"
                showIcon
                title="Agent 需要你的回答"
                description={
                  <Flex vertical gap={8}>
                    <Text>{request.question}</Text>
                    {request.choices.length ? (
                      <Flex wrap gap={6}>
                        {request.choices.map((choice) => (
                          <Button
                            key={choice}
                            size="small"
                            onClick={() => void props.respondToUserInput(request, choice, false)}
                          >
                            {choice}
                          </Button>
                        ))}
                      </Flex>
                    ) : null}
                    {request.allowFreeform ? (
                      <Space.Compact style={{ width: '100%' }}>
                        <Input
                          value={draft}
                          onChange={(event) => props.setUserInputDrafts((values) => ({
                            ...values,
                            [request.requestId]: event.target.value,
                          }))}
                          onPressEnter={(event) => {
                            event.preventDefault();
                            void props.respondToUserInput(request, draft, true);
                          }}
                          placeholder="输入你的回答"
                        />
                        <Button
                          type="primary"
                          disabled={!draft.trim()}
                          onClick={() => void props.respondToUserInput(request, draft, true)}
                        >
                          提交
                        </Button>
                      </Space.Compact>
                    ) : null}
                  </Flex>
                }
              />
            );
          })}
        </div>
      ) : null}

      <div className="composer">
        {props.current.context.inputs.some((input) => input.kind === 'document') ? (
          <div className="composer-files">
            <Text type="secondary">本次调查中的文件</Text>
            <Flex wrap gap={6}>
              {props.current.context.inputs
                .filter((input) => input.kind === 'document')
                .map((input) => <Tag key={input.id}>{input.title}</Tag>)}
            </Flex>
          </div>
        ) : null}

        <Sender
          key={props.active ?? 'new-investigation'}
          value={props.value}
          onChange={props.setValue}
          loading={props.loading}
          submitType="enter"
          onSubmit={(message) => { void props.send(message); }}
          onCancel={props.cancelActiveTurn}
          placeholder="可以询问数据资产、血缘、来源、转换、发现的问题或下一步分析"
          prefix={
            <Tooltip title="上传文件">
              <Button
                type="text"
                icon={<PaperClipOutlined />}
                onClick={() => props.setAttachmentsOpen(!props.attachmentsOpen)}
              />
            </Tooltip>
          }
          footer={() => (
            <Flex align="center" justify="space-between" gap={8} wrap className="sender-model-controls">
              <Space size={4} wrap>
                <Text type="secondary" className="sender-model-label">模型</Text>
                <Select
                  size="small"
                  variant="borderless"
                  value={props.current.control.agent.model}
                  loading={!props.availableModels.length}
                  disabled={props.modelSaving || props.loading}
                  showSearch
                  optionFilterProp="label"
                  popupMatchSelectWidth={false}
                  styles={{ popup: { root: { maxWidth: 320 } } }}
                  options={props.modelOptions.map((model) => ({
                    value: model.id,
                    label: model.id === 'auto'
                      ? 'Auto（自动选择模型）'
                      : model.runtime === 'codebuddy' || model.id.startsWith('codebuddy:')
                        ? (model.name || model.id) + '（CodeBuddy）'
                        : model.runtime === 'opencode' || model.id.startsWith('opencode:')
                          ? (model.name || model.id) + '（OpenCode）'
                          : model.name || model.id,
                  }))}
                  onChange={(model) =>
                    void props.updateModelSettings(
                      model,
                      model === 'auto' ? (props.current.control.agent.autoTier ?? null) : null,
                    )
                  }
                  style={{ minWidth: 175 }}
                />
                {props.current.control.agent.model === 'auto' ? (
                  <>
                    <Text type="secondary" className="sender-model-label">自动选择</Text>
                    <Select
                      size="small"
                      variant="borderless"
                      value={props.current.control.agent.autoTier ?? ''}
                      disabled={props.modelSaving || props.loading}
                      popupMatchSelectWidth={false}
                      styles={{ popup: { root: { maxWidth: 320 } } }}
                      options={[
                        { value: '', label: '默认' },
                        { value: 'efficiency', label: '省资源' },
                        { value: 'balance', label: '均衡' },
                        { value: 'intelligence', label: '能力优先' },
                        { value: 'fast', label: '最快' },
                      ]}
                      onChange={(tier: AutoTier | '') =>
                        void props.updateModelSettings('auto', tier || null)
                      }
                      style={{ minWidth: 92 }}
                    />
                  </>
                ) : null}
              </Space>
            </Flex>
          )}
          header={
            <Sender.Header
              title="文件"
              open={props.attachmentsOpen}
              onOpenChange={props.setAttachmentsOpen}
              forceRender
            >
              <Attachments
                beforeUpload={() => false}
                items={props.attachments}
                multiple
                onChange={props.onAttachmentChange}
                placeholder={(type) =>
                  type === 'drop'
                    ? { title: '把文件拖到这里' }
                    : {
                        icon: <FolderOpenOutlined />,
                        title: '上传调查文件',
                        description: '文件会保存在当前调查里，后面可以继续使用。',
                      }
                }
              />
            </Sender.Header>
          }
          suffix={(_, { components }) => (
            <components.SendButton
              type="primary"
              disabled={!props.value.trim() || props.loading || !props.current.context.mission}
            />
          )}
        />
      </div>
    </div>
  );
}
