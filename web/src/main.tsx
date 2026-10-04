import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Alert } from 'antd';
import { App } from './App';
import './styles.css';

/** 页面刷新后恢复 Investigation 的运行态；这里只显示真实 active turn，不读取历史 running 标记。 */
function ExecutionRecovery() {
  const [running, setRunning] = useState(false);
  const [visible, setVisible] = useState(true);
  const runningRef = useRef(false);

  useEffect(() => {
    const match = window.location.pathname.match(/^\/investigations\/([^/]+)/);
    const session = match?.[1] ? decodeURIComponent(match[1]) : '';
    if (!session) return;

    const readStatus = async () => {
      try {
        const response = await window.fetch(`/api/sessions/${encodeURIComponent(session)}/trajectory?limit=20`);
        if (!response.ok) return;
        const payload = await response.json() as { summary?: { state?: string } | null };
        // trajectory 是历史记录，不是进程级 execution heartbeat；aborted/completed/failed
        // 都不会显示“仍在执行”。只有服务端明确保留 running 时才显示。
        const next = payload.summary?.state === 'running';
        runningRef.current = next;
        setRunning(next);
        if (!next) setVisible(true);
      } catch {
        // 刷新或服务重启瞬间读取失败时，不阻塞正常聊天。
      }
    };

    void readStatus();
    const timer = window.setInterval(() => void readStatus(), 1500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const originalFetch = window.fetch.bind(window);
    const patchedFetch: typeof window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (runningRef.current && /\/api\/sessions\/[^/]+\/messages\/stream(?:$|\?)/.test(url)) {
        while (runningRef.current) {
          await new Promise((resolve) => window.setTimeout(resolve, 1000));
        }
      }
      return originalFetch(input, init);
    };
    window.fetch = patchedFetch;
    return () => { window.fetch = originalFetch; };
  }, []);

  if (!running || !visible) return null;

  return (
    <div style={{ padding: '8px 16px 0' }}>
      <Alert
        type="warning"
        showIcon
        closable
        onClose={() => setVisible(false)}
        message="上一轮任务仍在执行"
        description="刷新后已恢复运行状态。现在发送的问题会在上一轮完成后自动继续。"
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ExecutionRecovery />
    <App />
  </React.StrictMode>,
);
