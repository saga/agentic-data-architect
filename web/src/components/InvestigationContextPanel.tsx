import React from 'react';
import { Button, Flex, Space, Tag, Tooltip, Typography } from 'antd';
import { FullscreenOutlined, SettingOutlined } from '@ant-design/icons';
import { MissionContractPanel } from './MissionContractPanel';
import type { JourneyState, MissionDraft, SessionData } from '../app/types';

const { Text } = Typography;

export function InvestigationContextPanel(props: {
  current: SessionData;
  journey?: JourneyState;
  rightWidth: number;
  loading: boolean;
  onOpenConfig: () => void;
  onOpenJourney: () => void;
  onOpenUnknowns: () => void;
  onResizeStart: () => void;
  missionDraft: MissionDraft;
  missionOpen: boolean;
  missionSaving: boolean;
  missionError?: string;
  onOpenMission: () => void;
  onCloseMission: () => void;
  onChangeMission: (draft: MissionDraft) => void;
  onConfirmMission: () => void;
}) {
  return (
    <div
      className="right-panel-shell"
      style={{ width: props.rightWidth, flex: `0 0 ${props.rightWidth}px` }}
    >
      <div
        className="resize-handle resize-handle-right"
        role="separator"
        aria-label="调整工作区栏宽度"
        onMouseDown={(event) => {
          event.preventDefault();
          props.onResizeStart();
        }}
      />
      <aside className="context-panel">
        <div className="panel-header">
          <div>
            <Text className="eyebrow">调查进展</Text>
            <Text strong>当前阶段</Text>
          </div>
          <Tooltip title="调查设置">
            <Button type="text" icon={<SettingOutlined />} aria-label="调查设置" onClick={props.onOpenConfig} />
          </Tooltip>
        </div>

        <MissionContractPanel
          mission={props.current.context.mission}
          progress={props.current.missionProgress}
          draft={props.missionDraft}
          open={props.missionOpen}
          saving={props.missionSaving}
          loading={props.loading}
          error={props.missionError}
          onOpen={props.onOpenMission}
          onClose={props.onCloseMission}
          onChange={props.onChangeMission}
          onConfirm={props.onConfirmMission}
        />

        {props.journey?.stages.length ? (
          <section className="right-section right-journey">
            <Flex className="right-section-heading" justify="space-between" align="center">
              <Space size={6}>
                <Text strong>地图导引</Text>
                <Tag variant="filled">{props.current.context.workflow ? '当前 Workflow' : '自主调查'}</Tag>
              </Space>
              <Button
                type="link"
                size="small"
                icon={<FullscreenOutlined />}
                disabled={props.loading}
                onClick={props.onOpenJourney}
              >
                展开地图
              </Button>
            </Flex>
            <div className="journey-map">
              {props.journey.stages.map((stage, index) => (
                <div key={stage.id} className={"journey-map-item journey-map-item-" + stage.status}>
                  <div className="journey-map-rail" aria-hidden="true">
                    <span className="journey-map-dot" />
                    {index < props.journey!.stages.length - 1 ? <span className="journey-map-line" /> : null}
                  </div>
                  <div className="journey-map-copy">
                    <Text strong={stage.status === 'current'} type={stage.status === 'locked' ? 'secondary' : undefined}>
                      {stage.title}
                    </Text>
                    {stage.status === 'current' ? <Text type="secondary">{stage.objective}</Text> : null}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="right-section right-current-state">
          <Flex className="right-section-heading" justify="space-between" align="center">
            <Text strong>当前事实</Text>
            {props.current.context.unknowns.length ? (
              <Button type="link" size="small" onClick={props.onOpenUnknowns}>
                查看未查清事项
              </Button>
            ) : null}
          </Flex>
          {!props.current.currentState ? (
            <Text type="secondary">还没有形成完整的事实地图。主区会直接展示你和 Agent 的调查过程。</Text>
          ) : (
            <div className="right-facts">
              <div className="right-fact">
                <span className="right-fact-label">数据集</span>
                <strong className="right-fact-value">{props.current.currentState.coverage.datasets}</strong>
              </div>
              <div className="right-fact">
                <span className="right-fact-label">已连上线</span>
                <strong className="right-fact-value">
                  {props.current.currentState.coverage.connectedDatasets}/{props.current.currentState.coverage.datasets}
                </strong>
              </div>
              <div className="right-fact">
                <span className="right-fact-label">业务定义</span>
                <strong className="right-fact-value">
                  {props.current.currentState.coverage.semanticAssets ?? props.current.semanticAssets?.length ?? 0}
                </strong>
              </div>
              <div className="right-fact">
                <span className="right-fact-label">未查清</span>
                <strong className="right-fact-value">{props.current.context.unknowns.length}</strong>
              </div>
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}
