import React, { lazy, Suspense } from 'react';
import { Typography } from 'antd';
import type { InvestigationController } from '../app/useInvestigationController';
import { InvestigationWorkspace } from './InvestigationWorkspace';

const JourneyMap = lazy(() => import('./JourneyMap').then((module) => ({ default: module.JourneyMap })));
const InvestigationConfigPage = lazy(() => import('./InvestigationConfigPage').then((module) => ({ default: module.InvestigationConfigPage })));
const AgentTrajectoryPage = lazy(() => import('./AgentTrajectoryPage').then((module) => ({ default: module.AgentTrajectoryPage })));
const InvestigationResultsPage = lazy(() => import('./InvestigationResultsPage').then((module) => ({ default: module.InvestigationResultsPage })));

const pageLoadingFallback = (
  <div className="subpage-app" style={{ display: 'grid', placeItems: 'center' }}>
    <Typography.Text type="secondary">正在打开页面…</Typography.Text>
  </div>
);

export function InvestigationPageRouter({ controller }: { controller: InvestigationController }) {
  const { page, active, current, navigatePage, changeWorkflow, loadSession } = controller;

  if (page === 'config' && active && current) {
    return (
      <Suspense fallback={pageLoadingFallback}>
        <div className="subpage-app">
          <InvestigationConfigPage
            sessionName={active}
            control={current.control}
            workflow={current.context.workflow ?? ''}
            onBack={() => navigatePage('chat')}
            onWorkflowChange={async (workflow) => {
              await changeWorkflow(workflow === '' ? null : workflow);
            }}
            onSaved={async () => {
              await loadSession(active);
            }}
          />
        </div>
      </Suspense>
    );
  }

  if (page === 'results' && active) {
    return (
      <Suspense fallback={pageLoadingFallback}>
        <InvestigationResultsPage
          sessionName={active}
          onBack={() => navigatePage('chat')}
          onOpenJourney={() => navigatePage('journey')}
          onOpenConfig={() => navigatePage('config')}
          onOpenTrajectory={() => navigatePage('trajectory')}
        />
      </Suspense>
    );
  }

  if (page === 'trajectory' && active) {
    return (
      <Suspense fallback={pageLoadingFallback}>
        <div className="subpage-app">
          <AgentTrajectoryPage sessionName={active} onBack={() => navigatePage('chat')} />
        </div>
      </Suspense>
    );
  }

  if (page === 'journey' && active) {
    return (
      <Suspense fallback={pageLoadingFallback}>
        <div className="subpage-app journey-map-subpage">
          <JourneyMap onBack={() => navigatePage('chat')} />
        </div>
      </Suspense>
    );
  }

  return <InvestigationWorkspace controller={controller} />;
}
