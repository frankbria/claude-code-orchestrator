// dashboard/src/components/SessionPanel.tsx
import React, { useState, useCallback } from 'react';
import { useSessionPolling } from '../hooks/usePolling';
import { LargeOutputViewer } from './LargeOutputViewer';

interface CommandLog {
  id: string;
  tool: string;
  status: string;
  result?: string;
  blob_uri?: string;
  result_size_bytes?: number;
}

export function SessionPanel({ sessionId }: { sessionId: string }) {
  const { logs, messages } = useSessionPolling(sessionId);
  const [selectedLog, setSelectedLog] = useState<CommandLog | null>(null);
  const [showViewer, setShowViewer] = useState(false);

  const handleViewOutput = useCallback((log: CommandLog) => {
    setSelectedLog(log);
    setShowViewer(true);
  }, []);

  const handleCloseViewer = useCallback(() => {
    setShowViewer(false);
    setSelectedLog(null);
  }, []);

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

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
        {logs.map((log: CommandLog, i: number) => (
          <div key={log.id || i} className="log-entry">
            <span className="tool">{log.tool}</span>
            <span className="status">{log.status}</span>
            {log.blob_uri ? (
              <div className="large-output-indicator">
                <span className="output-size">
                  Large output ({formatBytes(log.result_size_bytes || 0)})
                </span>
                <button
                  className="view-output-btn"
                  onClick={() => handleViewOutput(log)}
                >
                  View Full Output
                </button>
              </div>
            ) : (
              <code>{log.result?.slice(0, 100)}{log.result && log.result.length > 100 ? '...' : ''}</code>
            )}
          </div>
        ))}
      </div>

      {showViewer && selectedLog && (
        <LargeOutputViewer
          sessionId={sessionId}
          logId={selectedLog.id}
          tool={selectedLog.tool}
          sizeBytes={selectedLog.result_size_bytes}
          onClose={handleCloseViewer}
        />
      )}
    </div>
  );
}
