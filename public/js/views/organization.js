import { get } from '../api.js';
import { h, mount, bizLogo, badge } from '../ui.js';
import { avatarCanvas } from '../office/sprites.js';

export function personNode(e, sub) {
  if (!e) return h('div', { class: 'org-node muted' }, 'Belum ada');
  return h('a', { class: 'org-node', href: `#/employees/${e.id}`, style: { color: 'inherit', textDecoration: 'none' } },
    avatarCanvas(e.avatar, 1.5),
    h('div', null, h('div', { class: 'who' }, e.name), h('div', { class: 'small muted' }, sub || e.role)),
    e.enabled ? null : badge('inactive'));
}

export async function render(root) {
  const org = await get('/api/organization');
  mount(root,
    h('div', { class: 'stack' },
      h('div', { class: 'card' },
        h('div', { class: 'org' },
          h('div', { class: 'org-node' }, h('span', { class: 'biz-logo', style: { '--biz': '#334155', width: '28px', height: '28px', fontSize: '12px' } }, 'OW'), h('div', null, h('div', { class: 'who' }, 'OWNER'), h('div', { class: 'small muted' }, 'Anda (administrator)'))),
          h('div', { class: 'org-connector' }),
          personNode(org.group_ceo, 'Group CEO — koordinator seluruh bisnis'),
          h('div', { class: 'org-connector' }),
          h('div', { class: 'org-level' },
            org.businesses.map((b) =>
              h('div', { class: 'org-branch', style: { borderColor: b.business.color } },
                h('h4', null, bizLogo(b.business), h('a', { href: `#/business/${b.business.id}` }, b.business.name), b.business.status !== 'active' ? badge('inactive') : null),
                h('div', { class: 'small muted' }, 'Business Manager'),
                personNode(b.manager),
                h('div', { class: 'small muted' }, `Tim (${b.staff.length})`),
                b.staff.map((e) => personNode(e)),
                b.shared_helpers.length ? h('div', { class: 'small muted' }, `Dibantu Shared Services: ${b.shared_helpers.map((e) => e.name).join(', ')}`) : null)),
            h('div', { class: 'org-branch' },
              h('h4', null, 'Shared Services'),
              h('div', { class: 'small muted' }, 'Tim pusat untuk semua bisnis (tidak diduplikasi)'),
              org.shared.map((e) => personNode(e))))),
        org.unassigned.length ? h('p', { class: 'small', style: { marginTop: '12px', color: 'var(--warn)' } }, `Staf bisnis tanpa bisnis: ${org.unassigned.map((e) => e.name).join(', ')}`) : null),
      h('p', { class: 'small muted' }, 'Ubah struktur melalui Business Directory (manager & tim) atau AI Employees (unit, peran, bisnis yang ditangani).')));
}
