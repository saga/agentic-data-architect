import React from 'react';
import { Divider, Layout } from 'antd';
import type { InvestigationController } from '../app/useInvestigationController';
import { InvestigationSidebar } from './InvestigationSidebar';
import { InvestigationTopbar } from './InvestigationTopbar';
import { InvestigationChatPanel } from './InvestigationChatPanel';
import { InvestigationContextPanel } from './InvestigationContextPanel';
import { InvestigationDialogs } from './InvestigationDialogs';

const { Content, Header } = Layout;

export function InvestigationWorkspace({ controller }: { controller: InvestigationController }) {
  const {
    active,
    current,
    sessions,
    loading,
    resizing,
    leftWidth,
    rightWidth,
    showLeftTip,
    journey,
    executionStatus,
    turnStatus,
    error,
    nextGuidance,
    streamingAnswer,
    streamingReasoning,
    reasoningByMessage,
    assistantAvatarByMessage,
    pendingPermissions,
    pendingUserInputs,
    userInputDrafts,
    attachments,
    attachmentsOpen,
    uploadingFiles,
    availableModels,
    modelOptions,
    modelSaving,
    value,
    newSessionOpen,
    newSessionName,
    newSessionGoal,
    newSessionWorkflow,
    unknownsOpen,
    missionOpen,
    missionDraft,
    missionSaving,
    missionError,
    setValue,
    setAttachmentsOpen,
    setUserInputDrafts,
    setNewSessionName,
    setNewSessionGoal,
    setNewSessionWorkflow,
    setNewSessionOpen,
    setUnknownsOpen,
    setResizing,
    setShowLeftTip,
    reloadSessions,
    navigateToSession,
    navigatePage,
    executionStatusText,
    copyConversation,
    send,
    cancelActiveTurn,
    respondToPermission,
    respondToUserInput,
    updateModelSettings,
    onAttachmentChange,
    createSession,
    continueUnknown,
    editMission,
    confirmMission,
    setMissionOpen,
    setMissionDraft,
  } = controller;

  if (!active || !current) {
    return (
      <Layout className="app-shell">
        <Content className="empty-app-page">
          <div className="empty-chat">
            <div className="empty-chat-inner">
              <span className="empty-chat-title">还没有选择调查</span>
              <span className="empty-chat-description">
                请先从左侧创建或选择一个 Investigation。
              </span>
              <button type="button" className="starter-prompt" onClick={() => setNewSessionOpen(true)}>
                新建调查
              </button>
            </div>
          </div>
        </Content>
        <InvestigationDialogs
          current={undefined}
          active={active}
          loading={loading}
          newSessionOpen={newSessionOpen}
          newSessionName={newSessionName}
          newSessionGoal={newSessionGoal}
          newSessionWorkflow={newSessionWorkflow}
          unknownsOpen={unknownsOpen}
          userInputDrafts={userInputDrafts}
          setNewSessionName={setNewSessionName}
          setNewSessionGoal={setNewSessionGoal}
          setNewSessionWorkflow={setNewSessionWorkflow}
          setNewSessionOpen={setNewSessionOpen}
          setUnknownsOpen={setUnknownsOpen}
          setUserInputDrafts={setUserInputDrafts}
          onCreateSession={() => void createSession()}
          onContinueUnknown={continueUnknown}
        />
      </Layout>
    );
  }

  return (
    <Layout className={`app-shell${resizing ? ' is-resizing' : ''}`}>
      <InvestigationSidebar
        sessions={sessions}
        active={active}
        width={leftWidth}
        showTip={showLeftTip}
        onNewSession={() => setNewSessionOpen(true)}
        onRefresh={() => reloadSessions(false).catch((e) => controller.setError(e instanceof Error ? e.message : String(e)))}
        onDismissTip={() => {
          setShowLeftTip(false);
          try { localStorage.setItem('ada.tip.left', 'dismissed'); } catch {}
        }}
        onSelectSession={(key) => navigateToSession(key)}
        onResizeStart={() => setResizing('left')}
      />

      <Layout>
        <Header className="topbar">
          <InvestigationTopbar
            current={current}
            loading={loading}
            turnStatus={turnStatus}
            executionStatus={executionStatus}
            executionStatusText={executionStatusText}
            onCopyConversation={() => void copyConversation()}
            onOpenResults={() => navigatePage('results')}
            onOpenTrajectory={() => navigatePage('trajectory')}
            onOpenConfig={() => navigatePage('config')}
            onOpenUnknowns={() => setUnknownsOpen(true)}
          />
        </Header>

        <Content className="chat-layout">
          <InvestigationChatPanel
            current={current}
            active={active}
            loading={loading}
            value={value}
            streamingReasoning={streamingReasoning}
            reasoningByMessage={reasoningByMessage}
            assistantAvatarByMessage={assistantAvatarByMessage}
            streamingAnswer={streamingAnswer}
            nextGuidance={nextGuidance}
            pendingPermissions={pendingPermissions}
            pendingUserInputs={pendingUserInputs}
            userInputDrafts={userInputDrafts}
            attachments={attachments}
            attachmentsOpen={attachmentsOpen}
            uploadingFiles={uploadingFiles}
            availableModels={availableModels}
            modelOptions={modelOptions}
            modelSaving={modelSaving}
            executionStatus={executionStatus}
            error={error}
            missionOpen={missionOpen}
            missionDraft={missionDraft}
            missionSaving={missionSaving}
            missionError={missionError}
            onOpenMission={editMission}
            onCloseMission={() => setMissionOpen(false)}
            onChangeMission={setMissionDraft}
            onConfirmMission={confirmMission}
            setValue={setValue}
            setAttachmentsOpen={setAttachmentsOpen}
            setUserInputDrafts={setUserInputDrafts}
            send={send}
            cancelActiveTurn={cancelActiveTurn}
            respondToPermission={respondToPermission}
            respondToUserInput={respondToUserInput}
            updateModelSettings={updateModelSettings}
            onAttachmentChange={onAttachmentChange}
            onStartPrompt={(prompt) => void send(prompt)}
          />

          <Divider orientation="vertical" className="content-divider" />

          <InvestigationContextPanel
            current={current}
            journey={journey}
            rightWidth={rightWidth}
            loading={loading}
            onOpenConfig={() => navigatePage('config')}
            onOpenJourney={() => navigatePage('journey')}
            onOpenUnknowns={() => setUnknownsOpen(true)}
            onResizeStart={() => setResizing('right')}
          />
        </Content>
      </Layout>

      <InvestigationDialogs
        current={current}
        active={active}
        loading={loading}
        newSessionOpen={newSessionOpen}
        newSessionName={newSessionName}
        newSessionGoal={newSessionGoal}
        newSessionWorkflow={newSessionWorkflow}
        unknownsOpen={unknownsOpen}
        userInputDrafts={userInputDrafts}
        setNewSessionName={setNewSessionName}
        setNewSessionGoal={setNewSessionGoal}
        setNewSessionWorkflow={setNewSessionWorkflow}
        setNewSessionOpen={setNewSessionOpen}
        setUnknownsOpen={setUnknownsOpen}
        setUserInputDrafts={setUserInputDrafts}
        onCreateSession={() => void createSession()}
        onContinueUnknown={continueUnknown}
      />
    </Layout>
  );
}
