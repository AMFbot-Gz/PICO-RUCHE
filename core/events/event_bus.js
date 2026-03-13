// core/events/event_bus.js — Bus d'événements central PICO-RUCHE
import { EventEmitter } from 'events';

export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this._middleware = [];
    this.metrics = { emitted: 0, processed: 0, failed: 0 };
  }

  use(fn) {
    this._middleware.push(fn);
    return this;
  }

  async emit(event, payload = {}) {
    this.metrics.emitted++;
    try {
      let data = payload;
      for (const mw of this._middleware) {
        data = await mw(event, data) ?? data;
      }
      super.emit(event, data);
      const listeners = this.listeners(event);
      await Promise.all(
        listeners.map(fn =>
          Promise.resolve(fn(data)).catch(err =>
            console.error(`[EventBus] listener error on "${event}":`, err.message)
          )
        )
      );
      this.metrics.processed++;
    } catch (err) {
      this.metrics.failed++;
      console.error(`[EventBus] emit error on "${event}":`, err.message);
    }
  }

  on(event, listener) {
    super.on(event, listener);
    return this;
  }

  off(event, listener) {
    super.off(event, listener);
    return this;
  }

  getMetrics() {
    return { ...this.metrics, listeners: this.eventNames().length };
  }
}

export const eventBus = new EventBus();
export default eventBus;
