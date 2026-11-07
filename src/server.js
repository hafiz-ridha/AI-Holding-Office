// Entry point: config -> DB (backup + migrations + seed) -> HTTP server -> background jobs. Graceful shutdown.
import { config, loadAppSecret, assertDataDirWritable } from './config.js';
import { openDb, closeDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { createBackup } from './services/backup.js';
import { buildApp } from './app.js';
import { worker } from './queue/worker.js';
import { startScheduler, stopScheduler } from './scheduler/index.js';
import { startNotifier, stopNotifier } from './telegram/notifier.js';
import { bot } from './telegram/bot.js';
import { bus } from './events.js';

const app = await buildApp();
const log = app.log;

assertDataDirWritable();
loadAppSecret(log);
openDb(config.dbPath);
migrate(log, { backup: () => createBackup('pre-migrate') });
await seed(log);

if (!config.disableBackgroundJobs) {
  startNotifier(log);
  worker.start({ log, intervalMs: config.queueIntervalMs });
  startScheduler({ logger: log, intervalMs: config.schedulerIntervalMs });
  bot.start(log).catch((e) => log.warn(`Telegram bot tidak dapat dimulai: ${e.message}`));
}

await app.listen({ host: config.host, port: config.port });
log.info(`AI Virtual Holding berjalan di http://${config.host}:${config.port} (data: ${config.dataDir})`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} diterima, menghentikan aplikasi...`);
  const force = setTimeout(() => process.exit(1), 20_000);
  force.unref();
  try {
    stopScheduler();
    await bot.stop();
    await worker.stop(10_000);
    stopNotifier();
    await app.close();
  } catch (e) {
    log.error({ err: e }, 'shutdown error');
  }
  closeDb();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => {
  log.error({ err: e }, 'unhandled rejection');
  bus.emit('system:alert', { key: 'unhandled', title: 'Kesalahan aplikasi', message: String(e?.message || e) });
});
