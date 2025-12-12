// dashboard/src/components/SessionPanel.tsx
import React from 'react';
import { useSessionPolling } from '../hooks/usePolling';

export function SessionPanel({ sessionId }: { sessionId: string }) {
  const { logs, messages } = useSessionPolling(sessionId);

  return (
    <div className="session-panel">
      <h3>Session: {sessionId.slice(0, 8)}...</h3>
      
      <div className="messages">
        <h4>Conversation</h4>
        {messages.map((msg, i) => (
          <div key={i} className={`message ${msg.direction}`}>
            <span className="source">{msg.source}</span>
            <pre>{msg.content}</pre>
          </div>
        ))}
      </div>

      <div className="command-logs">
        <h4>Tool Executions</h4>
        {logs.map((log, i) => (
          <div key={i} className="log-entry">
            <span className="tool">{log.tool}</span>
            <span className="status">{log.status}</span>
            <code>{log.result?.slice(0, 100)}...</code>
          </div>
        ))}
      </div>
    </div>
  );
}
