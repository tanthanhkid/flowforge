import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement ResizeObserver, but @xyflow/react (used by
// node-card.test.tsx, rendered inside a real <ReactFlow>) requires it to
// measure node dimensions. A no-op stub is enough for tests — layout math
// itself isn't under test here.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
