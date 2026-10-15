// Live data for the ops console: talking to the backend (/api) and turning its records
// (bookings, WhatsApp transcripts, tickets, handoffs, the audit log) into what the screens draw.
// Status rules (occupancy, booking status, readiness, what needs attention) are decided by the backend
// (app/portfolio.py), so every screen shows the same answer; this file only formats them.
// Times arrive as IST ISO strings and are shown in IST whatever the browser's time zone.

const API = '/api';

// signal: an AbortSignal, so a request for a property or conversation the user has already left can be dropped.
export async function api(method, path, body, signal) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    signal
  });
  if (res.status === 401) throw new Error('Signed out. Reload the page and sign in again.');
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty or non-JSON body */ }
  if (!res.ok) throw new Error((data && data.detail) || `Request failed (${res.status})`);
  return data;
}

// One loader per panel: each call cancels the previous request, and a reply that arrives after a newer request
// was made is dropped, so a slow answer for a property or conversation the user has left never shows.
export function latest() {
  let ctl = null, seq = 0;
  return (path, onData, onError) => {
    if (ctl) ctl.abort();
    ctl = new AbortController();
    const mine = ++seq;
    api('GET', path, null, ctl.signal)
      .then(data => { if (mine === seq) onData(data); })
      .catch(e => { if (e.name !== 'AbortError' && mine === seq) onError(e.message); });
  };
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
// "today", "tomorrow", "in 3 days", "2 days ago"
export function relDays(n) {
  if (n === null || n === undefined) return '';
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}
// Minutes until a time (negative once it has passed), e.g. for due times.
export const minutesUntil = (iso, now) => Math.round((Date.parse(iso) - Date.parse(now)) / 60000);
export const query = params => {
  const q = Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined && v !== false);
  return q.length ? '?' + q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
};
export const initials = name => name.split(' ').filter(Boolean).map(x => x[0]).slice(0, 2).join('');

// ---------- tickets ----------

export const STATUS_LABEL = { open: 'Open', acknowledged: 'Acknowledged', in_progress: 'In progress', delayed: 'Delayed', closed: 'Resolved' };
const STATUS_PILL = {
  open: ['#E7ECEF', '#3E5263', '○'],
  acknowledged: ['#E7ECEF', '#3E5263', '◐'],
  in_progress: ['#F6EAD5', '#6B440B', '◔'],
  delayed: ['#F6DCD8', '#A8382A', '▲'],
  closed: ['#E6EEE7', '#2F4A38', '✓']
};
export const statusPill = s => { const m = STATUS_PILL[s] || ['#F1EBE6', '#6E6762', '·']; return { bg: m[0], fg: m[1], icon: m[2] }; };
const SEVERITY = { urgent: ['#A8382A', '▲'], high: ['#A8382A', '▲'], medium: ['#7A4F0C', '◆'], low: ['#6E6762', '·'] };
export const severityMark = sev => { const m = SEVERITY[sev] || ['#6E6762', '·']; return { color: m[0], glyph: m[1], label: titleCase(sev) }; };
export const SEVERITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };
const FLOW = ['open', 'acknowledged', 'in_progress', 'closed'];
const SOURCE_LABEL = { guest: 'Guest via WhatsApp', 'uc-ops-01': 'Pre-arrival check', system: 'System' };

export function ticketView(t, now) {
  let list = FLOW, idx = FLOW.indexOf(t.status);
  if (t.status === 'delayed') { list = FLOW.slice(0, 3).concat(['delayed']); idx = 3; }
  return {
    ...t,
    status: STATUS_LABEL[t.status] || titleCase(t.status), statusKey: t.status,
    pill: statusPill(t.status),
    origin: SOURCE_LABEL[t.source] || titleCase(t.source),
    due: whenFull(t.due_at, now),
    resolvedText: t.status === 'closed' && t.resolve_minutes !== null
      ? `Resolved in ${duration(t.resolve_minutes)}${t.resolved_by ? ' by ' + t.resolved_by : ''} · ${t.within_sla ? 'within' : 'over'} SLA` : '',
    flowItems: list.map((x, i) => ({ label: STATUS_LABEL[x], bg: i <= idx ? (x === 'delayed' ? '#C2412E' : i === idx ? '#1A1714' : '#53735E') : '#E8DDD4', fg: i <= idx ? '#1A1714' : '#6A625C' })),
    dueText: dueText(t, now)
  };
}

// The queue's due column: how long overdue, how long until due, or how long it took.
export function dueText(t, now) {
  if (t.status === 'closed') return t.resolve_minutes !== null ? { text: 'Took ' + duration(t.resolve_minutes), tone: t.within_sla ? 'ok' : 'warn' } : { text: 'Resolved', tone: 'ok' };
  if (!t.due_at) return { text: 'No due time', tone: '' };
  const m = minutesUntil(t.due_at, now);
  return m < 0 ? { text: 'Overdue ' + duration(-m), tone: 'bad' } : { text: 'Due in ' + duration(m), tone: m < 30 ? 'warn' : '' };
}

// ---------- needs a person ----------

// The backend decides what needs attention (app/portfolio.py); this adds the words and tone each screen shows.
export const SEVERITY_TONE = { critical: 'red', high: 'red', medium: 'amber' };
export function attentionState(a, now) {
  const due = a.reasons.includes('Overdue') && a.due_at ? ` · was due ${whenFull(a.due_at, now)}` : '';
  return a.reasons.join(' · ') + due;
}

// ---------- a booking's conversation, profile and activity ----------

const STAGE_ORDER = { 'In stay': 0, 'Pre-arrival': 1, 'Tentative': 2, 'Unconfirmed': 3, 'Post-stay': 4, 'Cancelled': 5 };
export const sortBookings = bookings => bookings.slice().sort((a, b) => (STAGE_ORDER[a.stage] ?? 9) - (STAGE_ORDER[b.stage] ?? 9) || a.check_in.localeCompare(b.check_in));

// A villa's stay status: tone and a glyph, so it never relies on colour alone.
export const STAY_TONE = {
  occupied: ['ok', '●'], checkout: ['warn', '◑'], turnover: ['warn', '⇄'], pre_arrival: ['info', '◔'],
  vacant: ['neutral', '○'], conflict: ['bad', '▲'], unknown: ['bad', '?']
};
export const READINESS_TONE = { blocked: ['bad', '▲'], not_assessed: ['neutral', '–'], in_progress: ['warn', '◔'], ready: ['ok', '✓'] };
// Delivery of a message sent to the guest, in words (with a glyph) rather than colour alone.
export const DELIVERY = {
  pending: ['Sending…', '◌', ''], sent: ['Sent', '✓', ''], delivered: ['Delivered', '✓✓', ''], read: ['Read', '✓✓', 'ok'],
  failed: ['Not delivered', '!', 'bad'], not_sent: ['Not sent · dry run', '–', 'warn']
};

export function party(b) {
  const parts = [];
  if (b.adults) parts.push(plural(b.adults, 'adult', 'adults'));
  if (b.children) parts.push(plural(b.children, 'child', 'children'));
  if (b.pets) parts.push(plural(b.pets, 'pet', 'pets'));
  return parts.join(' · ') || 'Not recorded';
}

// A conversation's WhatsApp messages plus its takeovers, handoffs and ticket changes, oldest first, with a date
// marker at each new day. `c` is the /bookings/{id}/conversation payload.
export function chatItems(c, now, openTicket) {
  const events = c.messages.map(m => ({
    at: m.at, id: m.id, kind: m.direction === 'in' ? 'guest' : m.direction === 'ops' ? 'ops' : 'gia', text: m.body,
    delivery: m.direction === 'in' ? null : m.status, error: m.error
  }));
  c.tickets.forEach(t => events.push({ at: t.created_at, kind: 'chip', text: `${t.ref} created · ${titleCase(t.category)}`, go: () => openTicket(t) }));
  c.events.forEach(a => {
    if (a.action === 'ops_takeover') events.push({ at: a.at, kind: 'note', text: 'Ops took over this chat · Gia paused' });
    else if (a.action === 'ops_handback') events.push({ at: a.at, kind: 'note', text: 'Handed back to Gia' });
    else if (a.action === 'handoff_raised') events.push({ at: a.at, kind: 'note', text: `Gia asked for a person · ${a.text}` });
    else if (a.ticket) {
      const t = c.tickets.find(x => x.ref === a.ticket);
      events.push({ at: a.at, kind: 'chip', text: a.title.replace('→', '·'), go: t ? () => openTicket(t) : null });
    }
  });
  events.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);  // stable: messages stay ahead of same-second chips
  return withDays(events, now);
}

// Chat items in time order, with a date marker wherever the day changes.
function withDays(events, now) {
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

export function journeyRows(journey, now) {
  return journey.map(j => {
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

// An operator's WhatsApp thread as chat items (the same bubbles as a guest's chat): the operator on the left,
// Gia and ops on the right, notes in the middle.
export function operatorChat(op, now) {
  const first = op.name.split(' ')[0];
  const KIND = { in: ['guest', first], out: ['gia', 'Gia'], ops: ['ops', 'Ops team'], note: ['note', null] };
  return withDays(op.messages.map(m => {
    const [kind, who] = KIND[m.direction] || ['note', null];
    return { at: m.at, kind, who, text: m.body, ref: m.ticket_ref };
  }), now);
}
