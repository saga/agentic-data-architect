import React from 'react';
import { App as AntApp, ConfigProvider } from 'antd';
import { XProvider } from '@ant-design/x';
import zhCN from 'antd/locale/zh_CN';
import '@ant-design/x-markdown/themes/light.css';
import { InvestigationPageRouter } from './components/InvestigationPageRouter';
import { useInvestigationController } from './app/useInvestigationController';

function AppInner() {
  const controller = useInvestigationController();
  return <InvestigationPageRouter controller={controller} />;
}

export function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          fontSizeSM: 12,
          fontSize: 14,
          fontSizeLG: 16,
          fontSizeXL: 16,
          fontSizeHeading1: 16,
          fontSizeHeading2: 16,
          fontSizeHeading3: 16,
          fontSizeHeading4: 16,
          fontSizeHeading5: 16,
        },
      }}
    >
      <XProvider>
        <AntApp>
          <AppInner />
        </AntApp>
      </XProvider>
    </ConfigProvider>
  );
}
