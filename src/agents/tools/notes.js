// Second Brain search: knowledge from earlier work in the same business scope (same rules as the automatic recall).
import { getSetting } from '../../lib/settings.js';
import { recallKnowledge, formatKnowledge } from '../../holding/knowledge.js';

export const noteTools = [
  {
    name: 'catatan_cari',
    risk: 'safe',
    connector: null,
    allowed: () => getSetting('knowledge_enabled'),
    description: 'Cari catatan Second Brain (hasil kerja dan fakta tersimpan) untuk bisnis tugas ini.',
    args: { query: { type: 'string', required: true, max: 200, desc: 'topik yang dicari' } },
    async run(ctx, { query }) {
      const r = recallKnowledge({ task: ctx.task, employee: ctx.employee, query, limit: 4 });
      return {
        text: r.notes.length ? formatKnowledge(r, getSetting('timezone')) : `Tidak ada catatan tentang "${query}".`,
        summary: `${r.notes.length} catatan untuk "${query.slice(0, 60)}"`,
      };
    },
  },
];
