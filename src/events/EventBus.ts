// Event Pipeline
// Priority-aware event queue with typed handlers and back-pressure

import { type FlightdeckEvent, type EventType, eventId } from '../core/types.js';

export type EventHandler<T extends FlightdeckEvent = FlightdeckEvent> = (event: T) => void | Promise<void>;

interface QueuedEvent {
  event: FlightdeckEvent;
  priority: number; // 0 = critical, 1 = normal, 2 = low
}

export class EventBus {
  private handlers: Map<string, EventHandler[]> = new Map();
  private queue: QueuedEvent[] = [];
  private processing: boolean = false;
  private maxQueueSize: number = 10_000;

  private static eventPriority(event: FlightdeckEvent): number {
    // Critical events: agent crashes, gate clears, task failures
    if (event.type === 'agent.crashed' || event.type === 'task.failed') return 0;
    if (event.type === 'gate.cleared') return 0;
    // Normal
    if (event.type.startsWith('task.') || event.type.startsWith('review.')) return 1;
    // Low
    return 2;
  }

  on<T extends EventType>(type: T, handler: EventHandler<Extract<FlightdeckEvent, { type: T }>>): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type)!.push(handler as EventHandler);
  }

  off(type: EventType, handler: EventHandler): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }

  emit(event: FlightdeckEvent): void {
    const priority = EventBus.eventPriority(event);

    // Back-pressure: drop low-priority if queue full, never drop critical
    if (this.queue.length >= this.maxQueueSize) {
      if (priority > 0) return; // Drop non-critical
      // For critical: drop lowest priority item
      const lowestIdx = this.queue.reduce((min, item, idx) =>
        item.priority > this.queue[min].priority ? idx : min, 0);
      if (this.queue[lowestIdx].priority > priority) {
        this.queue.splice(lowestIdx, 1);
      }
    }

    this.queue.push({ event, priority });
    // Keep sorted by priority (critical first)
    this.queue.sort((a, b) => a.priority - b.priority);

    if (!this.processing) {
      this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const { event } = this.queue.shift()!;
      const handlers = this.handlers.get(event.type) ?? [];
      for (const handler of handlers) {
        try {
          await handler(event);
        } catch {
          // Handler errors don't crash the pipeline
        }
      }
    }
    this.processing = false;
  }

  /** Emit synchronously (for testing) */
  emitSync(event: FlightdeckEvent): void {
    const handlers = this.handlers.get(event.type) ?? [];
    for (const handler of handlers) {
      try {
        (handler as EventHandler)(event);
      } catch {
        // swallow
      }
    }
  }

  queueSize(): number {
    return this.queue.length;
  }

  setMaxQueueSize(size: number): void {
    this.maxQueueSize = size;
  }
}
