// Agent chat card ("Obrolan agen"): real conversation feed from task events + owner messages.
// Owner messages can be a note (no AI), a quick AI reply (1 call), or a full orchestrated task.
import { get, post, del } from '../api.js';
import { h, mount, clear, md, toast, errToast, confirmDialog, taskCode } from '../ui.js';
import { avatarCanvas } from '../office/sprites.js';

const KIND = {
  assign: { label: 'Penugasan', icon: '→' }, start: { label: 'Mulai', icon: '▶' }, meeting: { label: 'Rapat', icon: '◎' },
  done: { label: 'Selesai', icon: '✓' }, report: { label: 'Laporan', icon: '▤' }, fail: { label: 'Gagal', icon: '!' },
  approval: { label: 'Persetujuan', icon: '🔔' }, note: { label: 'Catatan', icon: '✎' }, command: { label: 'Perintah', icon: '/' },
  system: { label: 'Sistem', icon: '⚙' }, message: { label: '', icon: '' },
};
const MODES = [
  ['reply', 'Balasan cepat AI (1 panggilan)'],
  ['task', 'Tugas penuh (orkestrasi)'],
  ['note', 'Catatan saja (tanpa AI)'],
];
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (ms) => new Date(ms).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });

export function createChat({ onAgentMessage } = {}) {
  let channel = 'hq'; // 'hq' or business id (string)
  let lastId = 0;
  let firstId = null;
  let data = null; // /api/office payload, for recipients
  let sending = false;
  let loadedChannel = null;

  const list = h('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite', 'aria-label': 'Obrolan agen' });
  const typing = h('div', { class: 'chat-typing small muted' });
  const title = h('div', { class: 'grow' });
  const recipient = h('select', { 'aria-label': 'Penerima' });
  const mode = h('select', { 'aria-label': 'Mode pesan' }, MODES.map(([v, l]) => h('option', { value: v }, l)));
  const input = h('textarea', { rows: 2, maxlength: 4000, placeholder: 'Tulis pesan… (Enter kirim, Shift+Enter baris baru, /help)' });
  const sendBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Kirim');
  const hint = h('div', { class: 'small muted' });
  const olderBtn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', hidden: true, onclick: () => loadOlder() }, 'Muat pesan lebih lama');
  const clearBtn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: 'Hapus riwayat obrolan kantor ini', onclick: () => clearHistory() }, 'Hapus');

  const updateHint = () => {
    hint.textContent = mode.value === 'note'
      ? 'Hanya disimpan sebagai catatan; tidak memanggil AI.'
      : mode.value === 'reply'
        ? 'Penerima membalas lewat 1 panggilan AI (antre seperti tugas lain).'
        : 'Group CEO/Business Manager membagi pekerjaan: beberapa panggilan AI.';
  };
  mode.addEventListener('change', updateHint);
  updateHint();

  const form = h('form', { class: 'chat-composer', onsubmit: (e) => { e.preventDefault(); send(); } },
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'nowrap' } }, h('div', { class: 'grow' }, recipient), h('div', { class: 'grow' }, mode)),
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'nowrap', alignItems: 'flex-end' } }, h('div', { class: 'grow' }, input), sendBtn),
    hint);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  const el = h('section', { class: 'card chat-card', 'aria-label': 'Obrolan agen' },
    h('div', { class: 'row', style: { gap: '6px' } }, title, clearBtn),
    olderBtn, list, typing, form);

  const listChannel = () => (channel === 'hq' ? 'all' : channel);

  function renderMessage(m) {
    const k = KIND[m.kind] || KIND.message;
    const mine = m.sender_type === 'owner';
    const avatar = m.sender_type === 'employee' && m.sender_avatar
      ? avatarCanvas(m.sender_avatar, 1.25)
      : h('span', { class: `chat-avatar ${mine ? 'owner' : 'system'}`, 'aria-hidden': 'true' }, mine ? 'OW' : '⚙');
    const rich = m.sender_type === 'employee' && ['message', 'report', 'done'].includes(m.kind);
    return h('div', { class: `chat-msg ${mine ? 'mine' : ''} k-${m.kind}`, dataset: { id: m.id } },
      avatar,
      h('div', { class: 'chat-body' },
        h('div', { class: 'chat-meta' },
          h('strong', null, mine ? `${m.sender_name} (owner)` : m.sender_name),
          m.sender_role ? h('span', { class: 'muted' }, ` · ${m.sender_role.split(' — ')[0]}`) : null,
          m.recipient_name ? h('span', { class: 'muted' }, ` → ${m.recipient_name}`) : null,
          k.label ? h('span', { class: `chat-kind k-${m.kind}` }, `${k.icon} ${k.label}`) : null,
          channel === 'hq' && m.business_name ? h('span', { class: 'chat-biz', style: { '--biz': m.business_color } }, m.business_name) : null,
          h('span', { class: 'muted chat-time', title: new Date(m.created_at).toLocaleString('id-ID') }, fmtTime(m.created_at))),
        rich ? md(m.content) : h('div', { class: 'chat-text' }, m.content),
        m.task_id ? h('a', { class: 'small', href: `#/task/${m.task_id}` }, `${m.task_code || taskCode(m.task_id)} ↗`) : null));
  }

  function appendMessages(msgs, { announce }) {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    let prevDay = list.lastElementChild?.dataset?.day;
    for (const m of msgs) {
      const day = fmtDay(m.created_at);
      if (day !== prevDay) {
        list.append(h('div', { class: 'chat-day', dataset: { day } }, day));
        prevDay = day;
      }
      const node = renderMessage(m);
      node.dataset.day = day;
      list.append(node);
      lastId = Math.max(lastId, m.id);
      firstId = firstId === null ? m.id : Math.min(firstId, m.id);
      if (announce && m.sender_type === 'employee' && m.sender_employee_id) onAgentMessage?.(m);
    }
    if (nearBottom || !announce) list.scrollTop = list.scrollHeight;
  }

  function renderTyping(t) {
    typing.textContent = t.length ? `${t.map((x) => x.name).join(', ')} sedang ${t.length > 1 ? 'bekerja' : 'mengetik'}…` : '';
  }

  async function loadInitial() {
    const ch = listChannel();
    const r = await get(`/api/chat?channel=${ch}&limit=60`);
    if (ch !== listChannel()) return;
    clear(list);
    lastId = 0;
    firstId = null;
    if (!r.messages.length) list.append(h('p', { class: 'small muted chat-empty' }, 'Belum ada obrolan. Obrolan muncul otomatis saat agen bekerja, atau kirim pesan di bawah.'));
    appendMessages(r.messages, { announce: false });
    olderBtn.hidden = r.messages.length < 60;
    renderTyping(r.typing);
    loadedChannel = ch;
  }

  async function loadOlder() {
    if (!firstId) return;
    const r = await get(`/api/chat?channel=${listChannel()}&before=${firstId}&limit=60`);
    const anchor = list.scrollHeight;
    const frag = document.createDocumentFragment();
    let prevDay = null;
    for (const m of r.messages) {
      const day = fmtDay(m.created_at);
      if (day !== prevDay) {
        frag.append(h('div', { class: 'chat-day' }, day));
        prevDay = day;
      }
      frag.append(renderMessage(m));
      firstId = Math.min(firstId, m.id);
    }
    list.prepend(frag);
    list.scrollTop = list.scrollHeight - anchor;
    olderBtn.hidden = r.messages.length < 60;
  }

  async function poll() {
    if (loadedChannel !== listChannel()) return loadInitial();
    const r = await get(`/api/chat?channel=${listChannel()}&after=${lastId}&limit=100`);
    if (r.messages.length) {
      list.querySelector('.chat-empty')?.remove();
      appendMessages(r.messages, { announce: true });
    }
    renderTyping(r.typing);
  }

  let recipientsFor = null;
  function fillRecipients() {
    if (!data) return;
    // Keep the user's choice only within the same channel; a new channel starts at its default recipient.
    const prev = recipientsFor === channel ? recipient.value : null;
    recipientsFor = channel;
    const emps = data.employees.filter((e) => e.state !== 'off');
    const groups = [];
    if (channel === 'hq') {
      groups.push(['Kantor Pusat', emps.filter((e) => e.is_manager)]);
      groups.push(['Business Manager', emps.filter((e) => !e.is_manager && (e.role_key === 'business_manager' || e.manages_business_id))]);
      groups.push(['Shared Services', emps.filter((e) => e.org_unit === 'shared')]);
    } else {
      const id = Number(channel);
      const b = data.businesses.find((x) => x.id === id);
      groups.push(['Business Manager', emps.filter((e) => e.id === b?.manager_employee_id)]);
      groups.push(['Tim bisnis', emps.filter((e) => e.id !== b?.manager_employee_id && e.org_unit === 'business' && e.business_ids.includes(id))]);
      groups.push(['Shared Services', emps.filter((e) => e.org_unit === 'shared')]);
      groups.push(['Group CEO', emps.filter((e) => e.is_manager)]);
    }
    clear(recipient);
    for (const [label, list2] of groups) {
      if (!list2.length) continue;
      recipient.append(h('optgroup', { label }, list2.map((e) => h('option', { value: e.id }, `${e.name} — ${e.role.split(' — ')[0]}`))));
    }
    if (prev && [...recipient.options].some((o) => o.value === prev)) recipient.value = prev;
  }

  async function send() {
    const text = input.value.trim();
    if (!text || sending) return;
    sending = true;
    sendBtn.disabled = true;
    try {
      const r = await post('/api/chat', {
        channel: channel === 'hq' ? 'hq' : String(channel),
        content: text,
        recipient_employee_id: recipient.value ? Number(recipient.value) : null,
        mode: mode.value,
      });
      input.value = '';
      if (r.task) toast(`Dikirim · ${r.task.code} masuk antrean`, 'ok');
      if (data?.queue?.paused && r.task) toast('Antrean sedang dijeda: balasan menunggu sampai antrean dilanjutkan.', 'error');
      await poll();
    } catch (e) {
      errToast(e);
    } finally {
      sending = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  async function clearHistory() {
    const label = channel === 'hq' ? 'SEMUA kantor (pusat & bisnis)' : 'kantor bisnis ini';
    if (!(await confirmDialog(`Hapus riwayat obrolan ${label}? Tugas dan hasilnya tidak ikut terhapus.`, { danger: true, okLabel: 'Hapus' }))) return;
    try {
      await del(`/api/chat?channel=${listChannel()}`);
      toast('Riwayat obrolan dihapus', 'ok');
      await loadInitial();
    } catch (e) {
      errToast(e);
    }
  }

  return {
    el,
    setData(d) {
      data = d;
      fillRecipients();
    },
    async setChannel(ch, label) {
      channel = ch;
      mount(title, h('strong', null, 'Obrolan agen'), h('div', { class: 'small muted' }, label));
      fillRecipients();
      await loadInitial();
    },
    poll,
  };
}
