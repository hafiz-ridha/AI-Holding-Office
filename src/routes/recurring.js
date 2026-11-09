// Recurring tasks API: list, templates, create, edit (incl. on/off), delete, run now. Every change is audited.
import { listRecurring, getRecurring, createRecurring, updateRecurring, deleteRecurring, runRecurringNow, toPublic, TEMPLATES, FREQUENCIES } from '../holding/recurring.js';
import { auditReq } from '../lib/audit.js';
import { idParam, body, str, bool, nullableInt, httpError } from './schemas.js';

const fields = {
  title: str(200, 3),
  description: str(20000),
  mode: { type: 'string', enum: ['holding', 'business', 'direct'] },
  business_id: nullableInt,
  employee_id: nullableInt,
  priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
  frequency: { type: 'string', enum: FREQUENCIES },
  time_of_day: { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
  weekdays: { type: 'array', maxItems: 7, items: { type: 'integer', minimum: 1, maximum: 7 } },
  day_of_month: { type: ['integer', 'null'], minimum: 1, maximum: 28 },
  every_hours: { type: ['integer', 'null'], minimum: 1, maximum: 24 },
  template: { type: ['string', 'null'], maxLength: 40 },
  skip_if_running: bool,
  enabled: bool,
};

export default async function recurringRoutes(app) {
  app.get('/api/recurring', async () => listRecurring());

  app.get('/api/recurring/templates', async () => TEMPLATES);

  app.post('/api/recurring', { schema: { body: body(fields, ['title', 'mode', 'frequency', 'time_of_day']) } }, async (req, reply) => {
    const r = createRecurring(req.body, `owner:${req.user.username}`);
    auditReq(req, 'recurring_created', `R-${r.id}`, { title: r.title, frequency: r.frequency }, r.business_id);
    return reply.code(201).send(toPublic(r));
  });

  app.put('/api/recurring/:id', { schema: { params: idParam, body: body(fields) } }, async (req) => {
    const r = updateRecurring(req.params.id, req.body);
    auditReq(req, 'recurring_updated', `R-${r.id}`, { fields: Object.keys(req.body) }, r.business_id);
    return toPublic(r);
  });

  app.delete('/api/recurring/:id', { schema: { params: idParam } }, async (req) => {
    const r = deleteRecurring(req.params.id);
    auditReq(req, 'recurring_deleted', `R-${r.id}`, { title: r.title }, r.business_id);
    return { deleted: true };
  });

  app.post('/api/recurring/:id/run', { schema: { params: idParam } }, async (req) => {
    if (!getRecurring(req.params.id)) throw httpError('Tugas berulang tidak ditemukan', 404);
    const res = runRecurringNow(req.params.id);
    auditReq(req, 'recurring_run_now', `R-${req.params.id}`, { task_id: res.task_id });
    return res;
  });
}
