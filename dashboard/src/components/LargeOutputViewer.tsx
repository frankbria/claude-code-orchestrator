// dashboard/src/components/LargeOutputViewer.tsx
import React, { useState, useEffect, useCallback } from 'react';

interface LargeOutputViewerProps {
  sessionId: string;
  logId: string;
  tool: string;
  sizeBytes?: number;
  onClose: () => void;
}

type LoadingState = 'idle' | 'loading' | 'loaded' | 'error';

export function LargeOutputViewer({
  sessionId,
  logId,
  tool,
  sizeBytes,
  onClose,
}: LargeOutputViewerProps) {
  const [content, setContent] = useState<string>('');
  const [loadingState, setLoadingState] = useState<LoadingState>('idle');
  const [error, setError] = useState<string | null>(null);

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const fetchContent = useCallback(async () => {
    setLoadingState('loading');
    setError(null);

    try {
      const response = await fetch(
        `/api/sessions/${sessionId}/logs/${logId}/output`
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const text = await response.text();
      setContent(text);
      setLoadingState('loaded');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load output');
      setLoadingState('error');
    }
  }, [sessionId, logId]);

  useEffect(() => {
    fetchContent();
  }, [fetchContent]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${tool}-output-${logId}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [content, tool, logId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    },
    [onClose]
  );

  return (
    <div
      className="large-output-viewer-overlay"
      onClick={onClose}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="dialog"
      aria-modal="true"
      aria-labelledby="viewer-title"
    >
      <div
        className="large-output-viewer"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="viewer-header">
          <h3 id="viewer-title">
            Output: {tool}
            {sizeBytes && (
              <span className="size-badge">{formatBytes(sizeBytes)}</span>
            )}
          </h3>
          <div className="viewer-actions">
            {loadingState === 'loaded' && (
              <button
                className="download-btn"
                onClick={handleDownload}
                title="Download output"
              >
                Download
              </button>
            )}
            <button
              className="close-btn"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close viewer"
            >
              &times;
            </button>
          </div>
        </div>

        <div className="viewer-content">
          {loadingState === 'loading' && (
            <div className="loading-state">
              <div className="spinner" />
              <p>Loading output...</p>
            </div>
          )}

          {loadingState === 'error' && (
            <div className="error-state">
              <p className="error-message">Failed to load output: {error}</p>
              <button className="retry-btn" onClick={fetchContent}>
                Retry
              </button>
            </div>
          )}

          {loadingState === 'loaded' && (
            <pre className="output-content">{content}</pre>
          )}
        </div>
      </div>

      <style>{`
        .large-output-viewer-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.7);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }

        .large-output-viewer {
          background: #1e1e1e;
          border-radius: 8px;
          width: 90%;
          max-width: 1200px;
          height: 80%;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        }

        .viewer-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 20px;
          background: #2d2d2d;
          border-bottom: 1px solid #404040;
        }

        .viewer-header h3 {
          margin: 0;
          color: #e0e0e0;
          font-size: 16px;
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .size-badge {
          background: #404040;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 12px;
          color: #a0a0a0;
        }

        .viewer-actions {
          display: flex;
          gap: 8px;
        }

        .download-btn,
        .retry-btn {
          background: #0066cc;
          color: white;
          border: none;
          padding: 6px 12px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
        }

        .download-btn:hover,
        .retry-btn:hover {
          background: #0077ee;
        }

        .close-btn {
          background: transparent;
          border: none;
          color: #a0a0a0;
          font-size: 24px;
          cursor: pointer;
          padding: 0 8px;
          line-height: 1;
        }

        .close-btn:hover {
          color: #ffffff;
        }

        .viewer-content {
          flex: 1;
          overflow: auto;
          padding: 16px;
        }

        .loading-state,
        .error-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: #a0a0a0;
        }

        .spinner {
          width: 40px;
          height: 40px;
          border: 3px solid #404040;
          border-top-color: #0066cc;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }

        .error-message {
          color: #ff6b6b;
          margin-bottom: 16px;
        }

        .output-content {
          margin: 0;
          padding: 0;
          font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
          font-size: 13px;
          line-height: 1.5;
          color: #d4d4d4;
          white-space: pre-wrap;
          word-break: break-word;
        }
      `}</style>
    </div>
  );
}
