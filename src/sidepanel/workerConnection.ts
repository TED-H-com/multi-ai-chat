interface WorkerPort {
  onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: unknown): void;
  disconnect(): void;
}

interface WorkerRuntime {
  connect(options: { name: string }): WorkerPort;
  readonly lastError?: unknown;
}

interface ConnectionTimers {
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(id: number): void;
  setInterval(callback: () => void, delay: number): number;
  clearInterval(id: number): void;
}

export function startWorkerConnection(runtime: WorkerRuntime, timers: ConnectionTimers = window): () => void {
  let stopped = false;
  let port: WorkerPort | undefined;
  let retry: number | undefined;
  const scheduleReconnect = () => {
    if (stopped || retry !== undefined) return;
    retry = timers.setTimeout(() => { retry = undefined; connect(); }, 1000);
  };
  const connect = () => {
    if (stopped || port) return;
    try {
      const candidate = runtime.connect({ name: 'multi-ai-sidepanel' });
      port = candidate;
      candidate.onDisconnect.addListener(() => {
        // Reading lastError inside the callback consumes Chrome's port error.
        void runtime.lastError;
        if (port !== candidate) return;
        port = undefined;
        scheduleReconnect();
      });
    } catch {
      scheduleReconnect();
    }
  };
  connect();
  const heartbeat = timers.setInterval(() => {
    if (!port) { scheduleReconnect(); return; }
    try {
      port.postMessage({ type: 'heartbeat' });
    } catch {
      const failed = port;
      port = undefined;
      try { failed.disconnect(); } catch {}
      scheduleReconnect();
    }
  }, 20_000);
  return () => {
    stopped = true;
    timers.clearInterval(heartbeat);
    if (retry !== undefined) timers.clearTimeout(retry);
    const previous = port;
    port = undefined;
    try { previous?.disconnect(); } catch {}
  };
}
