// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
// Flat sessions only: every command may carry a sessionId.
// CDP payloads are loosely typed on purpose: callers know which fields a
// method returns.
type Json = any;
type Listener = (params: Json, sessionId?: string) => void;
interface Pending { resolve: (v: Json) => void; reject: (e: Error) => void; method: string }

export class CDP {
  ws: WebSocket;
  nextId = 1;
  pending = new Map<number, Pending>();
  listeners = new Map<string, Listener[]>();

  static connect(url: string): Promise<CDP> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error(`CDP connect failed: ${url}`)), { once: true });
    });
  }

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (e) => this.onMessage(JSON.parse(String(e.data))));
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
  }

  onMessage(msg: Json): void {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    const id = this.nextId++;
    const msg: Json = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(msg));
    });
  }

  on(method: string, fn: Listener): () => void {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method)!.push(fn);
    return () => {
      const a = this.listeners.get(method) ?? [];
      a.splice(a.indexOf(fn), 1);
    };
  }

  close(): void {
    this.ws.close();
  }
}
