// In-process event bus: task lifecycle → notifier, office state, queue wake-ups.
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(50);

// Events:
//  task:created   { task }
//  task:started   { task }
//  task:completed { task }
//  task:failed    { task, error }
//  task:postponed { task, error }
//  task:cancelled { task }
//  queue:wake     {}
//  system:alert   { key, title, message }
