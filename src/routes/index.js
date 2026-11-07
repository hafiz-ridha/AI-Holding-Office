import health from './health.js';
import auth from './auth.js';
import holding from './holding.js';
import businesses from './businesses.js';
import tasks from './tasks.js';
import employees from './employees.js';
import providers from './providers.js';
import telegram from './telegram.js';
import settings from './settings.js';
import chat from './chat.js';

export async function registerRoutes(app) {
  for (const r of [health, auth, holding, businesses, tasks, employees, providers, telegram, settings, chat]) await app.register(r);
}
