// Server-sent events hub (SCHEMA section 5.4).
export const MAX_CLIENTS = 20;
const MAX_BUFFERED = 2 * 1024 * 1024; // a client that cannot keep up is dropped, not buffered forever

export const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export class SseHub {
  constructor({ pingMs = 15000 } = {}) {
    this.clients = new Set();
    this.ping = setInterval(() => this.#raw(": ping\n\n"), pingMs);
    this.ping.unref?.();
  }
  get size() { return this.clients.size; }
  full() { return this.clients.size >= MAX_CLIENTS; }

  /** Takes over `res`. expMs = when the session cookie expires; the stream is closed then. */
  add(req, res, snapshot, expMs, headers = {}) {
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);
    req.socket.setTimeout(0);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      ...headers,
    });
    res.write("retry: 3000\n\n: ok\n\n");
    res.write(frame("snapshot", snapshot));
    const client = { res, timer: null };
    const ttl = Math.max(0, Math.min(expMs - Date.now(), 2 ** 31 - 1));
    client.timer = setTimeout(() => { try { res.end(); } catch { /* ignore */ } }, ttl);
    const done = () => { clearTimeout(client.timer); this.clients.delete(client); };
    req.on("close", done);
    res.on("close", done);
    res.on("error", done);
    this.clients.add(client);
    return client;
  }

  broadcast(event, data) { this.#raw(frame(event, data)); }

  #raw(text) {
    for (const c of this.clients) {
      try {
        if (c.res.writableLength > MAX_BUFFERED) { c.res.destroy(); continue; }
        c.res.write(text);
      } catch { /* the close handler removes it */ }
    }
  }

  closeAll() {
    clearInterval(this.ping);
    for (const c of this.clients) { clearTimeout(c.timer); try { c.res.end(); } catch { /* ignore */ } }
    this.clients.clear();
  }
}
