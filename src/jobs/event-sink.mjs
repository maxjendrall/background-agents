import { createLiveEventState, normalizeLiveEvent } from "../core/events.mjs";

const STREAM_FLUSH_MS = 250;
const STREAM_FLUSH_CHARS = 1_200;

/**
 * Turns noisy runtime callbacks into durable UI events.
 *
 * Pi/AgentOS emits token-level text/thinking chunks and token-level partial
 * tool JSON args. Persisting those directly makes small chats become tens of
 * thousands of events. This sink keeps the live UI responsive while storing a
 * compact event stream:
 *   - text/thinking chunks are batched every ~250ms or 1.2k chars
 *   - pending partial tool-argument deltas are dropped
 *   - final execution-start input + terminal tool output are kept
 */
export class JobEventSink {
  constructor({ store, jobId }) {
    this.store = store;
    this.jobId = jobId;
    this.toolState = createLiveEventState();
    this.streamKind = null;
    this.streamText = "";
    this.timer = null;
    this.tail = Promise.resolve();
    this.errors = [];
  }

  event(type, data = {}) {
    this.tail = this.tail
      .then(() => this.#handle(type, data))
      .catch((e) => {
        this.errors.push(e);
        console.error("[events] sink error:", e);
      });
    return this.tail;
  }

  async flush() {
    this.#clearTimer();
    this.tail = this.tail.then(() => this.#flushStream());
    await this.tail;
    if (this.errors.length) throw this.errors[0];
  }

  async #handle(type, data) {
    if (type === "agent.text") {
      const text = String(data?.text || "");
      if (!text) return;
      await this.store.appendText(this.jobId, text);
      await this.#bufferStream("agent.text", text);
      return;
    }

    if (type === "agent.thinking") {
      const text = String(data?.text || "");
      if (!text) return;
      await this.#bufferStream("agent.thinking", text);
      return;
    }

    await this.#flushStream();
    const normalized = normalizeLiveEvent(type, data, this.toolState);
    if (!normalized) return;
    await this.store.event(this.jobId, normalized.type, normalized.data);
  }

  async #bufferStream(kind, text) {
    if (this.streamKind && this.streamKind !== kind) await this.#flushStream();
    this.streamKind = kind;
    this.streamText += text;
    if (this.streamText.length >= STREAM_FLUSH_CHARS) {
      await this.#flushStream();
      return;
    }
    this.#scheduleFlush();
  }

  async #flushStream() {
    this.#clearTimer();
    if (!this.streamKind || !this.streamText) {
      this.streamKind = null;
      this.streamText = "";
      return;
    }
    const kind = this.streamKind;
    const text = this.streamText;
    this.streamKind = null;
    this.streamText = "";
    await this.store.event(this.jobId, kind, { text });
  }

  #scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tail = this.tail
        .then(() => this.#flushStream())
        .catch((e) => {
          this.errors.push(e);
          console.error("[events] timed flush error:", e);
        });
    }, STREAM_FLUSH_MS);
    this.timer.unref?.();
  }

  #clearTimer() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
