// dashboard/src/hooks/usePolling.ts
import { useState, useEffect } from 'react';

export function useSessionPolling(sessionId: string | null, intervalMs = 3000) {
  const [logs, setLogs] = useState<any[]>([]);
  const [messages, setMessages] = useState<any[]>([]);

  useEffect(() => {
    if (!sessionId) return;

    const fetchData = async () => {
      const [logsRes, msgsRes] = await Promise.all([
        fetch(`/api/sessions/${sessionId}/logs`),
        fetch(`/api/sessions/${sessionId}/messages`)
      ]);
      setLogs(await logsRes.json());
      setMessages(await msgsRes.json());
    };

    fetchData();
    const interval = setInterval(fetchData, intervalMs);
    
    return () => clearInterval(interval);
  }, [sessionId, intervalMs]);

  return { logs, messages };
}
