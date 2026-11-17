export interface BridgeMockCall {
  readonly methodId: string;
  readonly nativeName: string;
  readonly args: readonly unknown[];
}

export interface BridgeMock {
  readonly target: Record<string | symbol, unknown>;
  readonly appbridge: Record<string, (...args: unknown[]) => unknown>;
  readonly calls: BridgeMockCall[];
  queueResult(methodId: string, result: unknown): BridgeMock;
  emitCallback(requestId: string, result: unknown): void;
  emitEvent(eventType: string, eventKey: string, data: unknown): void;
}

export function createBridgeMock(options?: {
  target?: Record<string | symbol, unknown>;
  manifest?: string | Record<string, unknown>;
  bootstrapError?: Error;
  schedule?: (task: () => void) => void;
}): BridgeMock;
