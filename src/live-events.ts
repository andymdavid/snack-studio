export type LiveEvent = {
  type: string;
  episodeId?: string | null;
  entityType: string;
  entityId: string;
  status?: string | null;
  updatedAt: number;
};

const encoder = new TextEncoder();
const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();

function encodedEvent(event: LiveEvent) {
  return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function publishLiveEvent(event: LiveEvent) {
  const payload = encodedEvent(event);
  for (const subscriber of [...subscribers]) {
    try {
      subscriber.enqueue(payload);
    } catch {
      subscribers.delete(subscriber);
    }
  }
}

export function liveEventResponse(signal: AbortSignal) {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const cleanup = () => {
    if (controller) subscribers.delete(controller);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      subscribers.add(value);
      value.enqueue(encoder.encode(': connected\n\n'));
      heartbeat = setInterval(() => {
        try { value.enqueue(encoder.encode(': keepalive\n\n')); } catch { cleanup(); }
      }, 15_000);
    },
    cancel: cleanup,
  });
  signal.addEventListener('abort', () => {
    if (!controller) return;
    cleanup();
    try { controller.close(); } catch { /* already closed */ }
  }, { once: true });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
