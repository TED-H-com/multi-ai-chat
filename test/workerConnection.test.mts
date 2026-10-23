import assert from 'node:assert/strict';
import test from 'node:test';
import { startWorkerConnection } from '../src/sidepanel/workerConnection.ts';

function fixture(failFirst = false) {
  let id = 0, attempts = 0, reads = 0;
  const timeouts = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  const ports: { listeners: (() => void)[]; fail: boolean; disconnects: number }[] = [];
  const runtime = {
    get lastError() { reads++; return { message: 'No SW' }; },
    connect() {
      attempts++;
      if (failFirst && attempts === 1) throw new Error('No SW');
      const record = { listeners: [] as (() => void)[], fail: false, disconnects: 0 };
      ports.push(record);
      return {
        onDisconnect: { addListener(fn: () => void) { record.listeners.push(fn); } },
        postMessage() { if (record.fail) throw new Error('Attempting to use a disconnected port object'); },
        disconnect() { record.disconnects++; for (const fn of record.listeners) fn(); },
      };
    },
  };
  const timers = {
    setTimeout(fn: () => void) { timeouts.set(++id, fn); return id; },
    clearTimeout(key: number) { timeouts.delete(key); },
    setInterval(fn: () => void) { intervals.set(++id, fn); return id; },
    clearInterval(key: number) { intervals.delete(key); },
  };
  const stop = startWorkerConnection(runtime, timers);
  return { stop, ports, timeouts, intervals, attempts: () => attempts, reads: () => reads,
    retry() { const [key, fn] = [...timeouts][0]; timeouts.delete(key); fn(); },
    heartbeat() { for (const fn of intervals.values()) fn(); },
  };
}

test('panel connection retries a worker startup failure and consumes disconnect errors', () => {
  const app = fixture(true);
  assert.equal(app.attempts(), 1); assert.equal(app.timeouts.size, 1);
  app.retry(); assert.equal(app.attempts(), 2);
  for (const fn of app.ports[0].listeners) fn();
  assert.equal(app.reads(), 1); assert.equal(app.timeouts.size, 1);
  app.retry(); assert.equal(app.attempts(), 3);
  app.stop(); assert.equal(app.timeouts.size, 0); assert.equal(app.intervals.size, 0);
});

test('failed heartbeats reconnect once and stale port events cannot replace a new connection', () => {
  const app = fixture(); app.ports[0].fail = true;
  app.heartbeat(); app.heartbeat(); assert.equal(app.timeouts.size, 1);
  app.retry(); assert.equal(app.attempts(), 2);
  for (const fn of app.ports[0].listeners) fn();
  assert.equal(app.timeouts.size, 0);
  app.stop(); assert.equal(app.intervals.size, 0);
});

test('unmount cancels retry and prevents later disconnect callbacks from reconnecting', () => {
  const app = fixture(); const stale = app.ports[0].listeners[0];
  stale(); assert.equal(app.timeouts.size, 1);
  app.stop(); stale(); assert.equal(app.timeouts.size, 0); assert.equal(app.attempts(), 1);
});
