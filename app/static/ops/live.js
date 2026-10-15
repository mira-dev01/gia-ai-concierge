// Live data for the ops console: talking to the backend (/admin/ops/api) and turning its records
// (bookings, WhatsApp transcripts, tickets, handoffs, the audit log) into what the screens draw.
// Times arrive as IST ISO strings and are shown in IST whatever the browser's time zone.

const API = '/api';

export async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  if (res.status === 401) throw new Error('Signed out. Reload the page and sign in again.');
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty or non-JSON body */ }
  if (!res.ok) throw new Error((data && data.detail) || `Request failed (${res.status})`);
  return data;
}

// ---------- formatting ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ymd = iso => iso.slice(0, 10).split('-').map(Number);
export const dayLabel = iso => { const [, m, d] = ymd(iso); return d + ' ' + MONTHS[m - 1]; };
export const clock = iso => iso.slice(11, 16);
// Same day as `now`: just the time; otherwise the date.
export const when = (iso, now) => !iso ? '' : iso.slice(0, 10) === now.slice(0, 10) ? clock(iso) : dayLabel(iso);
export const whenFull = (iso, now) => !iso ? '' : iso.slice(0, 10) === now.slice(0, 10) ? 'Today, ' + clock(iso) : dayLabel(iso) + ', ' + clock(iso);
export function longDate(iso) {
  const [y, m, d] = ymd(iso);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] + ', ' + d + ' ' + MONTHS_LONG[m - 1];
}
export function dateRange(checkIn, checkOut) {
  const [, m1, d1] = ymd(checkIn), [, m2, d2] = ymd(checkOut);
  return m1 === m2 ? `${d1}–${d2} ${MONTHS[m2 - 1]}` : `${d1} ${MONTHS[m1 - 1]}–${d2} ${MONTHS[m2 - 1]}`;
}
export function nights(checkIn, checkOut) {
  const n = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 864e5);
  return n + (n === 1 ? ' night' : ' nights');
}
export const phoneLabel = digits => digits && digits.length === 12 && digits.startsWith('91')
  ? `+91 ${digits.slice(2, 7)} ${digits.slice(7)}` : '+' + digits;
export const titleCase = s => (s || '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const minutesBetween = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60000));
export function duration(min) {
  if (min === null || min === undefined) return '';
  if (min < 1) return '<1 min';
  if (min < 60) return min + ' min';
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return `${h} h ${String(m).padStart(2, '0')} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
export const ago = (iso, now) => { const m = minutesBetween(iso, now); return m < 1 ? 'just now' : duration(m) + ' ago'; };
export const initials = name => name.split(' ').filter(Boolean).map(x => x[0]).slice(0, 2).join('');

// ---------- tickets ----------

export const STATUS_LABEL = { open: 'Open', acknowledged: 'Acknowledged', in_progress: 'In progress', delayed: 'Delayed', closed: 'Closed' };
const STATUS_PILL = {
  open: ['#E7ECEF', '#3E5263', '○'],
  acknowledged: ['#E7ECEF', '#3E5263', '◐'],
  in_progress: ['#F6EAD5', '#6B440B', '◔'],
  delayed: ['#F6DCD8', '#A8382A', '▲'],
  closed: ['#E6EEE7', '#2F4A38', '✓']
};
export const statusPill = s => { const m = STATUS_PILL[s] || ['#F1EBE6', '#6E6762', '·']; return { bg: m[0], fg: m[1], icon: m[2] }; };
const SEVERITY = { urgent: ['#A8382A', '▲'], high: ['#A8382A', '▲'], medium: ['#7A4F0C', '◆'], low: ['#6E6762', '·'] };
const FLOW = ['open', 'acknowledged', 'in_progress', 'closed'];
const SOURCE_LABEL = { guest: 'Guest via WhatsApp', 'uc-ops-01': 'Pre-arrival check', system: 'System' };

export function ticketView(t, now) {
  const sev = SEVERITY[t.severity] || ['#6E6762', '·'];
  let list = FLOW, idx = FLOW.indexOf(t.status);
  if (t.status === 'delayed') { list = FLOW.slice(0, 3).concat(['delayed']); idx = 3; }
  return {
    ...t,
    status: STATUS_LABEL[t.status] || titleCase(t.status), statusKey: t.status,
    pill: statusPill(t.status),
    cat: titleCase(t.category), sev: titleCase(t.severity), sevColor: sev[0], sevGlyph: sev[1],
    title: t.summary, owner: t.assignee, ownerShort: t.assignee.split(/[,·(]/)[0].trim(),
    origin: SOURCE_LABEL[t.source] || titleCase(t.source),
    updated: when(t.updated_at, now), due: whenFull(t.due_at, now),
    timeFlag: timeFlag(t, now),
    resolvedText: t.status === 'closed' && t.resolve_minutes !== null
      ? `Resolved in ${duration(t.resolve_minutes)}${t.resolved_by ? ' by ' + t.resolved_by : ''} · ${t.within_sla ? 'within' : 'over'} SLA` : '',
    flowItems: list.map((x, i) => ({ label: STATUS_LABEL[x], bg: i <= idx ? (x === 'delayed' ? '#C2412E' : i === idx ? '#1A1714' : '#53735E') : '#E8DDD4', fg: i <= idx ? '#1A1714' : '#6A625C' })),
    history: t.history.map(h => ({ time: when(h.at, now), title: h.title, text: h.text }))
  };
}

// Open: how long it's been open (red once past its SLA). Closed: how long it took (red if over its SLA).
export function timeFlag(t, now) {
  if (t.status === 'closed') {
    if (t.resolve_minutes === null) return null;
    return { text: '✓ ' + duration(t.resolve_minutes), color: t.within_sla ? '#2F4A38' : '#A8382A', bg: t.within_sla ? '#E6EEE7' : '#F6DCD8', title: t.within_sla ? 'Resolved within SLA' : 'Resolved after its SLA' };
  }
  const open = duration(minutesBetween(t.created_at, now));
  return t.overdue
    ? { text: 'Open ' + open, color: '#A8382A', bg: '#F6DCD8', title: 'Past its expected time' }
    : { text: 'Open ' + open, color: '#6B440B', bg: '#FBF3E4', title: 'Open' };
}

// ---------- needs a person ----------

// Everything a person should act on now, most urgent first: guests waiting for a person, then open tickets that are
// urgent, overdue, delayed or have no operator. Each item says what state it's in and the next thing to do.
// Overview's list and the navigation badges both come from here, so their counts always agree.
export function attention(live) {
  const items = [];
  live.handoffs.filter(h => h.status === 'waiting').forEach(h => items.push({
    key: 'HO-' + h.id, kind: 'handoff', booking: h.booking_id, villa: h.villa, at: h.at,
    urgent: h.urgency === 'urgent', rank: h.urgency === 'urgent' ? 0 : 1,
    title: h.reason, who: [h.guest, h.villa].filter(Boolean).join(' · '), ref: `HO-${h.id}`,
    state: h.urgency === 'urgent' ? 'Urgent · needs a person' : 'Waiting for a person', tone: 'red',
    action: 'Take over chat'
  }));
  live.tickets.filter(t => t.status !== 'closed').forEach(t => {
    const unassigned = !t.operator_id;
    const reasons = [t.severity === 'urgent' && 'Urgent', t.overdue && 'Overdue', t.status === 'delayed' && 'Delayed',
      unassigned && 'Unassigned'].filter(Boolean);
    if (!reasons.length) return;
    items.push({
      key: t.ref, kind: 'ticket', ref: t.ref, booking: t.booking_id, villa: t.villa, at: t.created_at,
      urgent: t.severity === 'urgent',
      rank: t.severity === 'urgent' ? 0 : t.overdue ? 2 : t.status === 'delayed' ? 3 : 4,
      title: t.summary, who: [t.guest, t.villa].filter(Boolean).join(' · '),
      state: reasons.join(' · ') + (t.overdue ? ` · was due ${whenFull(t.due_at, live.now)}` : ''),
      tone: t.severity === 'urgent' || t.overdue || t.status === 'delayed' ? 'red' : 'amber',
      status: STATUS_LABEL[t.status] || titleCase(t.status), pill: statusPill(t.status),
      action: unassigned ? 'Assign operator' : 'Update progress'
    });
  });
  return items.sort((a, b) => a.rank - b.rank || a.at.localeCompare(b.at));
}

// ---------- a booking's conversation, profile and activity ----------

const STAGE_ORDER = { 'In stay': 0, 'Pre-arrival': 1, 'Post-stay': 2, 'Cancelled': 3 };
export const sortBookings = bookings => bookings.slice().sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || a.check_in.localeCompare(b.check_in));

export function party(b) {
  const parts = [];
  if (b.adults) parts.push(plural(b.adults, 'adult', 'adults'));
  if (b.children) parts.push(plural(b.children, 'child', 'children'));
  if (b.pets) parts.push(plural(b.pets, 'pet', 'pets'));
  return parts.join(' · ') || 'Not recorded';
}

// WhatsApp messages plus ticket events, oldest first, with a date marker at each new day.
export function chatItems(b, tickets, now, openTicket) {
  const events = b.messages.map(m => ({ at: m.at, kind: m.direction === 'in' ? 'guest' : m.direction === 'ops' ? 'ops' : 'gia', text: m.body }));
  tickets.forEach(t => {
    events.push({ at: t.created_at, kind: 'chip', text: `${t.ref} created · ${titleCase(t.category)}`, go: () => openTicket(t.ref) });
    t.history.filter(h => h.who === 'human' && h.title.startsWith(t.ref + ' →'))
      .forEach(h => events.push({ at: h.at, kind: 'chip', text: h.title.replace('→', '·'), go: () => openTicket(t.ref) }));
  });
  const NOTES = { ops_takeover: 'Ops took over this chat · Gia paused', ops_handback: 'Handed back to Gia', handoff_raised: null };
  b.activity.slice().reverse().forEach(a => {  // activity is newest first; notes go in oldest first
    if (!(a.action in NOTES)) return;
    events.push({ at: a.at, kind: 'note', text: NOTES[a.action] || `Gia asked for a person · ${a.text}` });
  });
  events.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);  // stable: messages stay ahead of same-second chips
  const out = [];
  let lastDay = null;
  events.forEach(e => {
    const day = e.at.slice(0, 10) === now.slice(0, 10) ? 'Today' : dayLabel(e.at);
    if (day !== lastDay) { out.push({ kind: 'date', text: day }); lastDay = day; }
    out.push({ ...e, time: clock(e.at) });
  });
  return out;
}

const STEP_STATE = {
  read: ['✓', '#53735E'], delivered: ['✓', '#53735E'], sent: ['◔', '#7A4F0C'], scheduled: ['○', '#6A625C'],
  failed: ['✕', '#C2412E'], skipped: ['–', '#6A625C'], cancelled: ['–', '#6A625C']
};

export function journeyRows(b, now) {
  return b.journey.map(j => {
    const st = STEP_STATE[j.status] || ['·', '#6A625C'];
    const at = { scheduled: j.due_at, sent: j.sent_at, delivered: j.delivered_at, read: j.read_at }[j.status];
    return { k: j.step, glyph: st[0], color: st[1], note: titleCase(j.status) + (at ? ' · ' + whenFull(at, now) : '') + (j.note && j.status !== 'scheduled' ? ` (${j.note})` : '') };
  });
}

export function detailRows(details) {
  return Object.entries(details || {}).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => ({ k: titleCase(k), v: Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v) }));
}

// ---------- field operators ----------

export const ROLE_LABEL = { caretaker: 'Caretaker', maintenance: 'Maintenance', housekeeping: 'Housekeeping', manager: 'Manager' };

// "Maintenance · Casa Alba, Ridge House" for each role the operator holds.
export function roleSummary(op) {
  const byRole = {};
  op.roles.forEach(r => { (byRole[r.role] = byRole[r.role] || []).push(r.villa); });
  return Object.entries(byRole).map(([role, villas]) => `${ROLE_LABEL[role] || titleCase(role)} · ${villas.join(', ')}`).join(' / ') || 'No villa assigned';
}

// The operator's WhatsApp thread as they see it on their phone, with a date marker at each new day.
export function operatorChat(op, now) {
  const out = [];
  let lastDay = null;
  op.messages.forEach(m => {
    const day = m.at.slice(0, 10) === now.slice(0, 10) ? 'Today' : dayLabel(m.at);
    if (day !== lastDay) { out.push({ kind: 'date', text: day }); lastDay = day; }
    out.push({ kind: m.direction, text: m.body, time: clock(m.at), ref: m.ticket_ref });
  });
  return out;
}
