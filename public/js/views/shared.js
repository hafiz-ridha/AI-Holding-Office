import { get } from '../api.js';
import { h, mount, badge, fmtRel, taskCode, emptyState } from '../ui.js';
import { avatarCanvas } from '../office/sprites.js';
import { editEmployee } from './employees.js';

export async function render(root, _params, ctx) {
  const draw = async () => {
    const [shared, active] = await Promise.all([get('/api/employees?org_unit=shared'), get('/api/tasks?status=active&limit=100')]);
    const sharedIds = new Set(shared.map((e) => e.id));
    const work = active.items.filter((t) => sharedIds.has(t.employee_id));
    mount(root,
      h('div', { class: 'stack' },
        h('p', { class: 'muted', style: { margin: 0 } }, 'Tim pusat membantu seluruh bisnis. Setiap tugas tetap membawa business_id sehingga mereka hanya menerima data bisnis yang sedang ditugaskan.'),
        h('div', { class: 'grid grid-cards' },
          shared.map((e) => {
            const mine = work.filter((t) => t.employee_id === e.id);
            return h('div', { class: 'card stack-sm' },
              h('div', { class: 'row' }, avatarCanvas(e.avatar, 2), h('div', { class: 'grow' }, h('strong', null, e.name), h('div', { class: 'small muted' }, e.role)), e.enabled ? badge('active') : badge('inactive')),
              h('p', { class: 'small muted', style: { margin: 0 } }, e.personality),
              h('div', { class: 'small' }, mine.length ? mine.map((t) => h('div', null, h('a', { href: `#/task/${t.id}` }, `${taskCode(t.id)} ${t.title}`), ` · ${t.business_name || 'holding'}`)) : h('span', { class: 'muted' }, 'Tidak ada tugas aktif')),
              h('div', { class: 'row' },
                h('button', { class: 'btn btn-sm', type: 'button', onclick: () => ctx.openNewTask({ mode: 'direct', employee_id: e.id }) }, '+ Tugas'),
                h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => editEmployee(e, draw) }, 'Edit')));
          })),
        h('div', { class: 'card' }, h('h3', null, 'Pekerjaan Shared Services yang belum selesai'),
          work.length
            ? h('div', { class: 'list' }, work.map((t) => h('div', { class: 'list-item' }, h('a', { class: 'grow', href: `#/task/${t.id}` }, `${taskCode(t.id)} ${t.title}`), h('span', { class: 'small muted' }, `${t.employee_name} · ${t.business_name || 'holding'} · ${fmtRel(t.updated_at)}`), badge(t.status))))
            : emptyState('Tidak ada.'))));
  };
  await draw();
  ctx.poll(draw, 10000);
}
