import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Alert } from 'antd';
import { App } from './App';
import './styles.css';

/** 页面刷新后恢复 Investigation 的运行态；避免前端误以为可以立即发起第二个 turn。 */
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
        const next = payload.summary?.state === 'running' || payload.summary?.state === 'waiting';
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
        // 用户刷新后可以继续输入；如果上一轮还没结束，这个请求在浏览器端排队，
        // 避免后端收到第二个 turn 后只能返回“正在处理上一轮问题”。
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
