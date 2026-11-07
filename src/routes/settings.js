import fs from 'node:fs';
import { q } from '../db/index.js';
import { SETTINGS, getAllSettings, setSetting } from '../lib/settings.js';
import { createBackup, listBackups, backupPath } from '../services/backup.js';
import { auditReq } from '../lib/audit.js';
import { bus } from '../events.js';
import { worker } from '../queue/worker.js';
import { httpError } from './schemas.js';

export default async function settingsRoutes(app) {
  app.get('/api/settings', async () => ({
    values: getAllSettings(),
    labels: Object.fromEntries(Object.entries(SETTINGS).map(([k, v]) => [k, v.label])),
  }));

  app.put('/api/settings', {
    schema: { body: { type: 'object', maxProperties: 40, additionalProperties: true } },
  }, async (req) => {
    const changed = {};
    for (const [k, v] of Object.entries(req.body)) {
      if (!(k in SETTINGS)) throw httpError(`Setting tidak dikenal: ${k}`);
      changed[k] = setSetting(k, v);
    }
    auditReq(req, 'settings_updated', null, changed);
    if ('queue_paused' in changed || 'max_concurrency' in changed) bus.emit('queue:wake');
    return { values: getAllSettings() };
  });

  app.post('/api/queue/pause', async (req) => {
    setSetting('queue_paused', true);
    auditReq(req, 'queue_paused');
    return worker.status();
  });

  app.post('/api/queue/resume', async (req) => {
    setSetting('queue_paused', false);
    bus.emit('queue:wake');
    auditReq(req, 'queue_resumed');
    return worker.status();
  });

  app.get('/api/backups', async () => listBackups());

  app.post('/api/backups', async (req) => {
    const b = createBackup('manual');
    auditReq(req, 'backup_created', b.name, { size: b.size });
    return { name: b.name, size: b.size };
  });

  app.get('/api/backups/:name', {
    schema: { params: { type: 'object', properties: { name: { type: 'string', maxLength: 60 } } } },
  }, async (req, reply) => {
    const file = backupPath(req.params.name);
    if (!file) throw httpError('Backup tidak ditemukan', 404);
    auditReq(req, 'backup_downloaded', req.params.name);
    reply.header('Content-Disposition', `attachment; filename="${req.params.name}"`);
    return reply.type('application/octet-stream').send(fs.createReadStream(file));
  });

  app.get('/api/audit', {
    schema: { querystring: { type: 'object', properties: { page: { type: 'integer', minimum: 1, default: 1 } } } },
  }, async (req) => ({
    items: q.all(
      `SELECT a.id, a.actor, a.action, a.target, a.detail, a.ip, a.created_at, b.name AS business_name
       FROM audit_logs a LEFT JOIN businesses b ON b.id = a.business_id ORDER BY a.id DESC LIMIT 50 OFFSET ?`,
      (req.query.page - 1) * 50
    ),
  }));
}
