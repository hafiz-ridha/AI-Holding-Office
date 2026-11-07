import { get } from '../api.js';
import { h, mount, fmtNum, fmtMoney, fmtRel, badge, bizLogo, taskCode, KIND_LABEL, emptyState } from '../ui.js';

function stat(label, value, sub) {
  return h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), sub ? h('div', { class: 'stat-sub' }, sub) : null);
}

function taskBar(s) {
  const total = Math.max(1, s.total);
  const seg = (n, color) => (n ? h('span', { style: { width: `${(n / total) * 100}%`, background: color } }) : null);
  return h('div', { class: 'bar', title: `${s.completed} selesai · ${s.active} aktif · ${s.failed} gagal` },
    seg(s.completed, 'var(--ok)'), seg(s.active, 'var(--info)'), seg(s.failed, 'var(--err)'));
}

export function financeLine(fin) {
  if (!fin) return h('span', { class: 'muted small' }, 'Keuangan bulan ini: DATA NOT AVAILABLE');
  return h('span', { class: 'small' }, 'Bersih bulan ini: ', fin.currencies.map((c, i) => [i ? ' · ' : '', h('strong', { style: { color: c.net >= 0 ? 'var(--ok)' : 'var(--err)' } }, fmtMoney(c.net, c.currency))]));
}

export async function render(root, _params, ctx) {
  const draw = async () => {
    const [o, recent] = await Promise.all([get('/api/overview'), get('/api/tasks?kind=top&limit=6')]);
    const t = o.holding.tasks;
    const maxReq = Math.max(1, ...o.usage.last7.map((d) => d.requests));
    mount(
      root,
      h('div', { class: 'stack' },
        h('div', { class: 'stats' },
          stat('Bisnis aktif', fmtNum(o.holding.businesses_active), `dari ${o.holding.businesses_total} bisnis`),
          stat('Karyawan AI', fmtNum(o.holding.employees_enabled), `${o.holding.employees_total} profil · 1 AI router bersama`),
          stat('Total tugas', fmtNum(t.total), `${o.holding.tasks_today.total} dibuat hari ini`),
          stat('Selesai', fmtNum(t.completed)),
          stat('Tertunda', fmtNum(t.pending + t.processing), `${t.processing} sedang diproses`),
          stat('Gagal', fmtNum(t.failed)),
          stat('Request AI hari ini', fmtNum(o.usage.today.requests), o.usage.daily_limit ? `batas ${fmtNum(o.usage.daily_limit)}/hari · ${fmtNum(o.usage.today.tokens)} token` : `${fmtNum(o.usage.today.tokens)} token`),
          stat('Persetujuan owner', fmtNum(o.approvals_pending), o.approvals_pending ? h('a', { href: '#/approvals' }, 'Tinjau') : 'tidak ada'),
        ),
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', null, 'Performa per bisnis'), h('a', { href: '#/businesses', class: 'small' }, 'Business Directory →')),
          o.businesses.length
            ? h('div', { class: 'grid grid-cards' },
                o.businesses.map((b) =>
                  h('a', { class: 'card biz-card', href: `#/business/${b.id}`, style: { '--biz': b.color, textDecoration: 'none', color: 'inherit' } },
                    h('div', { class: 'row' }, bizLogo(b), h('div', { class: 'grow' }, h('strong', null, b.name), h('div', { class: 'small muted' }, b.industry || '-')), badge(b.status)),
                    taskBar(b.stats),
                    h('div', { class: 'small muted' }, `${b.stats.total} tugas · ${b.stats.completed} selesai · ${b.stats.active} aktif · ${b.stats.failed} gagal`),
                    financeLine(b.finance_month),
                    h('div', { class: 'small muted' }, b.latest_report ? `Laporan terakhir ${fmtRel(b.latest_report.created_at)}: ${b.latest_report.title}` : 'Belum ada laporan')
                  )
                )
              )
            : emptyState('Belum ada bisnis.', h('a', { class: 'btn btn-primary', href: '#/businesses' }, 'Tambah bisnis'))
        ),
        h('div', { class: 'grid grid-2' },
          h('div', { class: 'card' },
            h('div', { class: 'card-head' }, h('h2', null, 'Tugas terbaru'), h('a', { href: '#/tasks', class: 'small' }, 'Semua →')),
            recent.items.length
              ? h('div', { class: 'list' }, recent.items.map((x) =>
                  h('a', { class: 'list-item', href: `#/task/${x.id}`, style: { color: 'inherit', textDecoration: 'none' } },
                    h('span', { class: 'mono small muted' }, taskCode(x.id)),
                    h('div', { class: 'grow' }, h('div', null, x.title), h('div', { class: 'small muted' }, `${KIND_LABEL[x.kind]}${x.business_name ? ` · ${x.business_name}` : ''} · ${fmtRel(x.created_at)}`)),
                    badge(x.status))))
              : emptyState('Belum ada tugas.', h('button', { class: 'btn btn-primary', type: 'button', onclick: () => ctx.openNewTask() }, 'Buat tugas pertama'))
          ),
          h('div', { class: 'stack' },
            h('div', { class: 'card' },
              h('div', { class: 'card-head' }, h('h2', null, 'Status AI provider'), h('a', { href: '#/providers', class: 'small' }, 'Kelola →')),
              o.providers.length
                ? h('div', { class: 'list' }, o.providers.map((p) =>
                    h('div', { class: 'list-item' }, h('div', { class: 'grow' }, h('strong', null, p.name), p.is_default ? h('span', { class: 'small muted' }, ' · default') : null,
                      h('div', { class: 'small muted mono' }, p.default_model || 'model default belum diatur')), p.enabled ? badge(p.status) : badge('inactive'))))
                : emptyState('Belum ada provider. AI belum terintegrasi.', h('a', { class: 'btn btn-primary', href: '#/providers' }, 'Tambah provider'))
            ),
            h('div', { class: 'card' },
              h('div', { class: 'card-head' }, h('h2', null, 'Request AI 7 hari'), h('span', { class: 'small muted' }, `RAM proses ${o.system.rss_mb} MB`)),
              h('div', { class: 'row', style: { alignItems: 'flex-end', height: '90px', gap: '6px', flexWrap: 'nowrap' } },
                o.usage.last7.map((d) =>
                  h('div', { class: 'grow', style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }, title: `${d.date}: ${d.requests} request, ${d.tokens} token` },
                    h('div', { style: { width: '100%', maxWidth: '28px', height: `${Math.max(2, (d.requests / maxReq) * 64)}px`, background: 'var(--primary)', borderRadius: '4px 4px 0 0', opacity: d.requests ? 1 : 0.25 } }),
                    h('span', { class: 'small muted' }, d.date.slice(8)))))
            ),
            h('div', { class: 'card' },
              h('div', { class: 'row-between' }, h('strong', null, 'Telegram bot'), badge(o.telegram.status === 'running' ? 'ok' : o.telegram.status === 'error' ? 'error' : 'pending', o.telegram.status === 'running' ? 'Aktif' : o.telegram.status === 'error' ? 'Error' : 'Tidak aktif')),
              h('p', { class: 'small muted' }, o.telegram.message || 'Atur di menu Telegram.')
            )
          )
        )
      )
    );
  };
  await draw();
  ctx.poll(draw, 10000);
}
