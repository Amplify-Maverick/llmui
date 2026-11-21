/**
 * An append-only list of events with sequence numbers, for work that outlives
 * the HTTP request that started it (chat runs, image jobs). Clients read it
 * from any point (`after`) and then follow it live until it ends, so a client
 * that disconnects can come back and get what it missed.
 */

export class EventLog {
  constructor() {
    this.events = []; // { seq, ...event }
    this.seq = 0;
    this.ended = false;
    this.listeners = new Set();
  }

  /** Append an event; returns it with its `seq` (1-based). `end` marks the last one. */
  push(event, { end = false } = {}) {
    if (this.ended) return null;
    const e = { seq: ++this.seq, ...event };
    this.events.push(e);
    if (end) this.ended = true;
    for (const fn of [...this.listeners]) fn(e, this.ended);
    if (this.ended) this.listeners.clear();
    return e;
  }

  /** Events with seq > after. */
  since(after = 0) {
    const n = Number(after) || 0;
    return n <= 0 ? this.events.slice() : this.events.filter((e) => e.seq > n);
  }

  /** Call fn(event, ended) for each new event. Returns an unsubscribe function. */
  subscribe(fn) {
    if (this.ended) return () => {};
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * Write a log to an HTTP response: replay everything after `after`, then
 * follow live until the log ends (then end the response). Closing the
 * response only stops this view; the work itself carries on.
 * format "ndjson": one JSON object per line. "sse": `data: <json>\n\n`.
 */
export function streamLog(req, res, log, { after = 0, format = "ndjson", keepaliveMs = 15000 } = {}) {
  if (!res.headersSent) {
    res.setHeader("Content-Type", format === "sse" ? "text/event-stream" : "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
  }
  const write = (e) => {
    if (res.writableEnded) return;
    res.write(format === "sse" ? `data: ${JSON.stringify(e)}\n\n` : JSON.stringify(e) + "\n");
  };
  for (const e of log.since(after)) write(e);
  if (log.ended) {
    res.end();
    return;
  }
  // SSE comments / blank NDJSON lines keep idle proxies from closing the stream.
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(format === "sse" ? ": ping\n\n" : "\n");
  }, keepaliveMs);
  keepalive.unref?.();
  const unsubscribe = log.subscribe((e, ended) => {
    write(e);
    if (ended) {
      clearInterval(keepalive);
      if (!res.writableEnded) res.end();
    }
  });
  res.on("close", () => {
    clearInterval(keepalive);
    unsubscribe();
  });
}
