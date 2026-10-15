// Operations: the ticket queue. A compact, scannable list of every guest request and internal task, with counts,
// search and filters, and a detail pane for the selected ticket (request, assignment, progress, activity and the
// actions valid for its state). Escalation and overdue are flags beside the lifecycle (open → acknowledged →
// in progress → resolved, or delayed), so a ticket can be in progress, overdue and escalated at once.
// An operator's WhatsApp thread opens in a drawer when it's needed, instead of a phone on screen all the time.
import * as L from './live.js';
import { h, Frag, Pill, Tone, State, Popover, PresenceChip, DemoChip, Dialog, Drawer, LiveTag, ChatItem, Composer, HistoryRow, FilterChips, FilterTokens, stickToBottom, trackScroll } from './ui.js';

const { React } = window;

export const EMPTY_FILTERS = { view: 'open', q: '', villa: '', priority: '', op: '', status: '', cat: '' };
const VIEWS = [
  ['open', 'Open', t => t.status !== 'closed'],
  ['overdue', 'Overdue', t => t.status !== 'closed' && t.overdue],
  ['unassigned', 'Unassigned', t => t.status !== 'closed' && !t.operator_id],
  ['escalated', 'Escalated', t => t.status !== 'closed' && t.escalated],
  ['resolved', 'Resolved', t => t.status === 'closed'],
  ['all', 'All', () => true]
];
const NEXT = { open: 'acknowledged', acknowledged: 'in_progress', in_progress: 'closed', delayed: 'closed' };
const VERB = { acknowledged: 'Acknowledge', in_progress: 'Mark in progress', delayed: 'Mark delayed', closed: 'Resolve' };
// What each status can move to (resolving goes through its own dialog; "open" can't be set again).
const MOVES = { open: ['acknowledged', 'in_progress', 'delayed'], acknowledged: ['in_progress', 'delayed'], in_progress: ['delayed'], delayed: ['in_progress'] };
const NARROW = '(max-width: 1099px)';

const matches = (t, q) => !q || [t.ref, t.summary, t.guest, t.villa, t.assignee, t.booking_id, t.category].join(' ').toLowerCase().includes(q.toLowerCase());

// Escalated first, then by priority, overdue, and due time; resolved ones most recent first.
function order(list) {
  return list.slice().sort((a, b) => (a.status === 'closed') - (b.status === 'closed')
    || (a.status === 'closed' ? (b.resolved_at || '').localeCompare(a.resolved_at || '')
      : (b.escalated - a.escalated) || (b.overdue - a.overdue)
        || (L.SEVERITY_ORDER[a.severity] ?? 9) - (L.SEVERITY_ORDER[b.severity] ?? 9)
        || (a.due_at || '').localeCompare(b.due_at || '')));
}

export class OperationsWorkspace extends React.Component {
  state = { narrow: window.matchMedia ? window.matchMedia(NARROW).matches : false, dialog: null };

  componentDidMount() {
    if (!window.matchMedia) return;
    this.mq = window.matchMedia(NARROW);
    this.onMq = e => this.setState({ narrow: e.matches });
    this.mq.addEventListener('change', this.onMq);
  }
  componentWillUnmount() { if (this.mq) this.mq.removeEventListener('change', this.onMq); }

  model() {
    const p = this.props, f = p.filters, live = p.live;
    const scoped = live.tickets.filter(t => matches(t, f.q)
      && (!f.villa || t.villa_id === f.villa) && (!f.priority || t.severity === f.priority)
      && (!f.op || (f.op === 'none' ? !t.operator_id : String(t.operator_id) === f.op))
      && (!f.status || t.status === f.status) && (!f.cat || t.category === f.cat));
    const viewFn = (VIEWS.find(v => v[0] === f.view) || VIEWS[0])[2];
    return { scoped, rows: order(scoped.filter(viewFn)), counts: Object.fromEntries(VIEWS.map(([k, , fn]) => [k, scoped.filter(fn).length])) };
  }

  render() {
    const p = this.props, f = p.filters, live = p.live, ctx = p.ctx, now = ctx.now;
    const m = this.model();
    const set = patch => p.setFilters(patch);
    const distinct = vals => Array.from(new Set(vals.filter(Boolean))).sort();
    const secondary = [f.status, f.cat].filter(Boolean).length;
    const tokens = [
      f.villa && ['villa', 'Property: ' + ((live.villas.find(v => v.id === f.villa) || {}).name || f.villa)],
      f.priority && ['priority', 'Priority: ' + L.titleCase(f.priority)],
      f.op && ['op', 'Assignee: ' + (f.op === 'none' ? 'Unassigned' : ((live.operators.find(o => String(o.id) === f.op) || {}).name || f.op))],
      f.status && ['status', 'Status: ' + (L.STATUS_LABEL[f.status] || f.status)],
      f.cat && ['cat', 'Category: ' + L.titleCase(f.cat)],
      f.q && ['q', `“${f.q}”`]
    ].filter(Boolean);
    const sel = p.sel;
    const selLive = sel && live.tickets.find(t => t.ref === sel);
    const selDemo = sel && !selLive && p.demo.rows.find(r => r.ref === sel);
    const detail = selLive ? h`<${TicketDetail} key=${selLive.id} ticket=${selLive} live=${live} ctx=${ctx} openDialog=${d => this.setState({ dialog: d })} />`
      : selDemo ? p.demo.detail(sel) : null;

    return h`<div className="page operations" data-screen-label="Operations" hidden=${!p.active}>
      <header className="page-head compact">
        <div><h1 className="page-title">Operations</h1></div>
        <div className="head-actions">
          <${LiveTag} sync=${ctx.sync} />
          <button className="btn small" onClick=${() => ctx.addOperator(null)}>+ Add operator</button>
        </div>
      </header>

      <${FilterChips} label="Ticket view" value=${f.view} onChange=${view => set({ view })}
        options=${VIEWS.map(([key, label]) => [key, label, m.counts[key], ['overdue', 'unassigned', 'escalated'].includes(key) && m.counts[key] > 0])} />

      <div className="register-tools">
        <input className="search-input" type="search" value=${f.q} onChange=${e => set({ q: e.target.value })} placeholder="Search ticket, guest, property or assignee" aria-label="Search tickets" />
        <select value=${f.villa} onChange=${e => set({ villa: e.target.value })} aria-label="Property">
          <option value="">All properties</option>${live.villas.map(v => h`<option key=${v.id} value=${v.id}>${v.name}</option>`)}
        </select>
        <select value=${f.priority} onChange=${e => set({ priority: e.target.value })} aria-label="Priority">
          <option value="">Any priority</option>${['urgent', 'high', 'medium', 'low'].map(x => h`<option key=${x} value=${x}>${L.titleCase(x)}</option>`)}
        </select>
        <select value=${f.op} onChange=${e => set({ op: e.target.value })} aria-label="Assignee">
          <option value="">Any assignee</option><option value="none">Unassigned</option>
          ${live.operators.map(o => h`<option key=${o.id} value=${String(o.id)}>${o.name}</option>`)}
        </select>
        <${Popover} label="More filters" count=${secondary}>
          <div className="filter-panel">
            <label className="field">Status
              <select value=${f.status} onChange=${e => set({ status: e.target.value })}>
                <option value="">Any status</option>${live.ticket_statuses.map(st => h`<option key=${st} value=${st}>${L.STATUS_LABEL[st] || L.titleCase(st)}</option>`)}
              </select>
            </label>
            <label className="field">Category
              <select value=${f.cat} onChange=${e => set({ cat: e.target.value })}>
                <option value="">Any category</option>${distinct(live.tickets.map(t => t.category)).map(c => h`<option key=${c} value=${c}>${L.titleCase(c)}</option>`)}
              </select>
            </label>
          </div>
        <//>
      </div>
      <${FilterTokens} tokens=${tokens} onRemove=${k => set({ [k]: '' })} onReset=${() => set({ ...EMPTY_FILTERS, view: f.view })} resetLabel="Clear filters" />

      <div className=${'ops-layout' + (detail && !this.state.narrow ? ' with-detail' : '')}>
        <div className="card queue">
          <${State} loading=${!ctx.sync.loaded && !ctx.sync.error} error=${!ctx.sync.loaded && ctx.sync.error}
            empty=${ctx.sync.loaded && m.rows.length === 0 && p.demo.rows.length === 0 && (live.tickets.length ? 'No tickets in this view.' : 'No tickets yet. Gia raises one whenever a guest asks for something the team has to do.')}>
            <table className="q-table">
              <thead><tr><th scope="col">Request</th><th scope="col">Priority</th><th scope="col">Status</th><th scope="col">Assignee</th><th scope="col">Due</th></tr></thead>
              <tbody>
                ${m.rows.map(t => this.row(t, now))}
                ${m.rows.length === 0 && h`<tr><td colSpan="5" className="note q-empty">${live.tickets.length ? 'No tickets in this view.' : 'No live tickets yet.'}</td></tr>`}
                ${p.demo.rows.length > 0 && h`<tr className="q-divider"><td colSpan="5">Demo scenarios</td></tr>`}
                ${p.demo.rows.map(r => h`<tr key=${r.ref} className=${r.ref === sel ? 'on' : ''} onClick=${() => p.setSel(r.ref)}>
                  <td className="q-title"><button className="row-link" onClick=${e => { e.stopPropagation(); p.setSel(r.ref); }}>${r.title}</button>
                    <div className="note clamp"><span className="mono">${r.ref}</span> · ${r.villa} · <${DemoChip} /></div></td>
                  <td><span style=${{ color: r.sevColor }}><span aria-hidden="true">${r.sevGlyph}</span> ${r.sev}</span></td>
                  <td>${Pill(r.pill, r.status)}</td><td>${r.ownerShort}</td><td className="note">${r.updated}</td>
                </tr>`)}
              </tbody>
            </table>
          <//>
        </div>
        ${detail && !this.state.narrow && h`<div className="card ops-detail">${detail}</div>`}
      </div>
      ${detail && this.state.narrow && h`<${Drawer} label="Ticket" onClose=${() => p.setSel(null)}>${detail}<//>`}
      ${this.state.dialog && this.dialog(this.state.dialog)}
    </div>`;
  }

  row(t, now) {
    const p = this.props, on = t.ref === p.sel, tv = L.ticketView(t, now), sev = L.severityMark(t.severity), due = tv.dueText;
    const pick = () => p.setSel(t.ref);
    return h`<tr key=${t.ref} className=${(on ? 'on' : '') + (t.escalated ? ' esc' : '')} onClick=${pick} aria-selected=${on}>
      <td className="q-title">
        <button className="row-link" onClick=${e => { e.stopPropagation(); pick(); }} aria-current=${on ? 'true' : undefined}>${t.summary}</button>
        <div className="note clamp"><span className="mono">${t.ref}</span> · ${t.villa}${t.guest ? ' · ' + t.guest : ''}${t.notifies_guest ? '' : ' · internal'}</div>
      </td>
      <td><span style=${{ color: sev.color }}><span aria-hidden="true">${sev.glyph}</span> ${sev.label}</span></td>
      <td>${Pill(tv.pill, tv.status)}${t.escalated && h`<div><${Tone} tone="bad" glyph="▲">Escalated<//></div>`}</td>
      <td className="clamp">${t.operator || h`<span className="missing">Unassigned</span>`}</td>
      <td><span className=${'due ' + due.tone}>${due.tone === 'bad' && h`<span aria-hidden="true">▲ </span>`}${due.text}</span></td>
    </tr>`;
  }

  // Escalate, resolve and reopen each ask before they act; resolve and escalate need a short note.
  dialog(d) {
    const close = () => this.setState({ dialog: null });
    return h`<${ActionDialog} ...${d} ctx=${this.props.ctx} onClose=${close} />`;
  }
}

class ActionDialog extends React.Component {
  state = { text: '', error: null };
  async submit(e) {
    e.preventDefault();
    const p = this.props, text = this.state.text.trim();
    if (p.needsText && !text) { this.setState({ error: p.needsText }); return; }
    const r = await p.ctx.act(p.key_, () => p.request(text), p.success, { quiet: true });
    if (r.ok) p.onClose(); else this.setState({ error: r.error });
  }
  render() {
    const p = this.props, pending = !!p.ctx.pending[p.key_];
    return h`<${Dialog} title=${p.title} onClose=${p.onClose}>
      <form className="dialog-form" onSubmit=${e => this.submit(e)}>
        ${p.body && h`<p className="body-text">${p.body}</p>`}
        ${p.label && h`<label className="field">${p.label}
          <textarea rows="3" value=${this.state.text} onChange=${e => this.setState({ text: e.target.value, error: null })} placeholder=${p.placeholder || ''} autoFocus></textarea>
        </label>`}
        ${p.warn && h`<p className="warn-text">${p.warn}</p>`}
        ${this.state.error && h`<p className="composer-error" role="alert">${this.state.error}</p>`}
        <div className="modal-actions">
          <button type="button" className="btn" onClick=${p.onClose}>Cancel</button>
          <button type="submit" className=${p.danger ? 'btn-dark' : 'btn-primary'} disabled=${pending}>${pending ? 'Saving…' : p.confirm}</button>
        </div>
      </form>
    <//>`;
  }
}

// ---------- the selected ticket ----------

class TicketDetail extends React.Component {
  state = { data: null, error: null, assignTo: null };
  fetch = L.latest();
  componentDidMount() { this.load(); }
  componentDidUpdate(prev) { if (this.props.ctx.tick !== prev.ctx.tick) this.load(); }
  load = () => this.fetch(`/tickets/${this.props.ticket.id}`, data => this.setState({ data, error: null }), error => this.setState({ error }));

  setStatus(t, status) {
    const ctx = this.props.ctx;
    ctx.markActed(t.ref);
    return ctx.act('ticket:' + t.id, () => L.api('POST', `/tickets/${t.id}/status`, { status }),
      r => `${r.ref} is now ${L.STATUS_LABEL[r.status].toLowerCase()}` + (r.guest_messaged ? '. Gia messaged the guest on WhatsApp.' : '. Internal ticket, so the guest wasn’t messaged.'));
  }

  assign(t) {
    const ctx = this.props.ctx, v = this.state.assignTo;
    const id = v === 'none' ? null : Number(v);
    ctx.markActed(t.ref);
    return ctx.act('assign:' + t.id, () => L.api('POST', `/tickets/${t.id}/assign`, { operator_id: id }),
      r => `${t.ref} → ${r.assignee}` + (id ? '. They’ve been sent the task on WhatsApp.' : '.')).then(r => { if (r.ok) this.setState({ assignTo: null }); });
  }

  dialogs(t) {
    const p = this.props, guest = t.guest || 'the guest';
    return {
      resolve: { key_: 'ticket:' + t.id, title: `Resolve ${t.ref}`, confirm: 'Resolve',
        body: 'Resolve only when the work is done: not when the guest has been acknowledged, an operator assigned, or an alternative accepted.',
        label: 'How was it resolved?', placeholder: 'e.g. Replaced the basin washer; checked for leaks with the tap running',
        needsText: 'Add a short note on how it was resolved.',
        warn: t.notifies_guest ? `Gia will tell ${guest} on WhatsApp that it’s done.` : 'Internal ticket: the guest isn’t messaged.',
        request: note => { p.ctx.markActed(t.ref); return L.api('POST', `/tickets/${t.id}/status`, { status: 'closed', note }); },
        success: r => `${r.ref} resolved` + (r.guest_messaged ? '. Gia told the guest.' : '.') },
      reopen: { key_: 'ticket:' + t.id, title: `Reopen ${t.ref}`, confirm: 'Reopen as in progress', danger: true,
        body: 'The ticket goes back to In progress and its resolution is cleared.',
        warn: t.notifies_guest ? `Gia will tell ${guest} the request is in progress again.` : '',
        request: () => { p.ctx.markActed(t.ref); return L.api('POST', `/tickets/${t.id}/status`, { status: 'in_progress' }); },
        success: r => `${r.ref} reopened` },
      escalate: { key_: 'escalate:' + t.id, title: `Escalate ${t.ref}`, confirm: 'Escalate',
        body: 'Escalation puts the ticket at the top of every attention list for the whole team. It doesn’t change the status or message the guest.',
        label: 'Why is it escalated?', placeholder: 'e.g. Guest is leaving early; needs a manager decision on a refund',
        needsText: 'Say why it’s escalated.',
        request: reason => { p.ctx.markActed(t.ref); return L.api('POST', `/tickets/${t.id}/escalate`, { on: true, reason }); },
        success: r => `${r.ref} escalated` },
      deescalate: { key_: 'escalate:' + t.id, title: `Clear the escalation on ${t.ref}`, confirm: 'Clear escalation', danger: true,
        body: 'The ticket stays at its current status and keeps its overdue state.',
        request: () => L.api('POST', `/tickets/${t.id}/escalate`, { on: false }), success: r => `${r.ref} no longer escalated` }
    };
  }

  render() {
    const p = this.props, ctx = p.ctx, live = p.live, now = ctx.now, t = p.ticket, d = this.state.data;
    const tv = L.ticketView(t, now), sev = L.severityMark(t.severity), closed = t.status === 'closed', unassigned = !t.operator_id;
    const blocked = ctx.stale ? 'Reconnecting: actions are paused until the console can confirm the current state.' : '';
    const pending = !!ctx.pending['ticket:' + t.id], assigning = !!ctx.pending['assign:' + t.id];
    const dlg = this.dialogs(t);
    const next = closed || unassigned ? null : NEXT[t.status];
    const moves = closed ? [] : (MOVES[t.status] || []).filter(st => st !== next);
    const sla = t.due_at ? L.minutesBetween(t.created_at, t.due_at) : null;
    const ops = live.operators.slice().sort((a, b) => (b.roles.some(r => r.villa_id === t.villa_id) - a.roles.some(r => r.villa_id === t.villa_id)) || a.name.localeCompare(b.name));
    const here = ops.filter(o => o.roles.some(r => r.villa_id === t.villa_id)), elsewhere = ops.filter(o => !here.includes(o));
    const assignVal = this.state.assignTo ?? (t.operator_id ? String(t.operator_id) : '');
    const opt = o => h`<option key=${o.id} value=${String(o.id)}>${o.name} · ${o.presence}${o.open ? ` · ${o.open} open` : ''}</option>`;

    return h`<article className="ticket" aria-label=${`Ticket ${t.ref}`}>
      <header className="ticket-head">
        <div className="ref"><span className="mono">${t.ref}</span> · ${L.titleCase(t.category)} · ${tv.origin}</div>
        <h2 className="title">${t.summary}</h2>
        <div className="chips-inline">
          ${Pill(tv.pill, tv.status)}
          <span style=${{ color: sev.color, fontWeight: 700, fontSize: '12px' }}><span aria-hidden="true">${sev.glyph}</span> ${sev.label}</span>
          ${t.escalated && h`<${Tone} tone="bad" glyph="▲">Escalated<//>`}
          ${t.overdue && h`<${Tone} tone="bad" glyph="⏱">Overdue<//>`}
          ${unassigned && !closed && h`<${Tone} tone="warn" glyph="○">Unassigned<//>`}
        </div>
      </header>
      ${blocked && h`<div className="banner warn" role="status">${blocked}</div>`}

      <section className="t-actions" aria-label="Actions">
        ${closed ? h`<${Frag}>
            <div className="resolved-line">✓ ${tv.resolvedText || 'Resolved'}</div>
            <button className="btn small" disabled=${!!blocked || pending} onClick=${() => p.openDialog(dlg.reopen)}>Reopen</button><//>`
          : h`<${Frag}>
            ${next && h`<button className="btn-primary" disabled=${!!blocked || pending}
              onClick=${() => next === 'closed' ? p.openDialog(dlg.resolve) : this.setStatus(t, next)}>${pending ? 'Saving…' : VERB[next]}</button>`}
            ${unassigned && h`<span className="next-hint">Next step: assign an operator below.</span>`}
            ${next !== 'closed' && h`<button className="btn" disabled=${!!blocked || pending} onClick=${() => p.openDialog(dlg.resolve)}>Resolve…</button>`}
            ${moves.map(st => h`<button key=${st} className="btn small" disabled=${!!blocked || pending} onClick=${() => this.setStatus(t, st)}>${VERB[st]}</button>`)}
            ${t.escalated
              ? h`<button className="btn small" disabled=${!!blocked} onClick=${() => p.openDialog(dlg.deescalate)}>Clear escalation</button>`
              : h`<button className="btn small" disabled=${!!blocked} onClick=${() => p.openDialog(dlg.escalate)}>Escalate…</button>`}<//>`}
        ${!closed && h`<p className="note">${t.notifies_guest ? `${t.guest || 'The guest'} is updated on WhatsApp at each status change.` : 'Internal ticket · the guest isn’t messaged.'}</p>`}
      </section>

      <section className="t-sec">
        <h3 className="h3">Request</h3>
        <p className="request-text">${t.details || t.summary}</p>
        ${d && d.excerpt.length > 0 && h`<div className="excerpt" aria-label="What the guest wrote">
          ${d.excerpt.map((m, i) => h`<div key=${i} className="ex-line"><span className="note">${L.whenFull(m.at, now)}</span> “${m.body}”</div>`)}
        </div>`}
        <dl className="kv">
          <dt>Guest</dt><dd>${t.guest || h`<span className="missing">No guest on this ticket</span>`}${t.booking_id && h` · <span className="mono">${t.booking_id}</span>`}${d && d.booking && h` · ${L.dateRange(d.booking.check_in, d.booking.check_out)} · ${d.booking.label}`}</dd>
          <dt>Property</dt><dd>${t.villa}${d && d.villa_location ? ` · ${d.villa_location}` : ''}</dd>
        </dl>
        <div className="link-row">
          <button className="btn small" onClick=${() => ctx.openProperty(t.villa_id)}>Open property</button>
          ${t.booking_id && h`<button className="btn small" onClick=${() => ctx.openConversation(t.booking_id)}>Open guest conversation</button>`}
        </div>
      </section>

      <section className="t-sec">
        <h3 className="h3">Assignment</h3>
        <div className="assign-row">
          <span>${t.operator ? h`<b>${t.operator}</b> <span className="note">${t.assignee.includes('·') ? t.assignee.split('·').slice(1).join('·').trim() : ''}</span>` : h`<span className="missing">${t.assignee === 'Ops control tower' ? 'Ops control tower (no operator)' : 'No operator assigned'}</span>`}</span>
          ${t.operator_id && h`<button className="btn-link" onClick=${() => ctx.openOperator(t.operator_id)}>Message operator</button>`}
        </div>
        ${!closed && (live.operators.length ? h`<form className="assign-form" onSubmit=${e => { e.preventDefault(); this.assign(t); }}>
            <label className="sr-only" htmlFor=${'assign-' + t.id}>Assign to</label>
            <select id=${'assign-' + t.id} value=${assignVal} onChange=${e => this.setState({ assignTo: e.target.value })} disabled=${assigning}>
              ${!t.operator_id && h`<option value="">Choose an operator…</option>`}
              ${here.length > 0 && h`<optgroup label=${`At ${t.villa}`}>${here.map(opt)}</optgroup>`}
              ${elsewhere.length > 0 && h`<optgroup label="Other villas">${elsewhere.map(opt)}</optgroup>`}
              ${t.operator_id && h`<option value="none">Unassign (back to the control tower)</option>`}
            </select>
            <button type="submit" className=${unassigned ? 'btn-primary small' : 'btn small'} disabled=${assigning || !!blocked || !assignVal || assignVal === String(t.operator_id || '')}>
              ${assigning ? 'Assigning…' : unassigned ? 'Assign' : 'Reassign'}</button>
          </form>`
          : h`<button className="btn small" onClick=${() => ctx.addOperator(t.villa_id)}>Add an operator</button>`)}
      </section>

      <section className="t-sec">
        <h3 className="h3">Progress</h3>
        <div className="flow-bars" aria-hidden="true">${tv.flowItems.map(f => h`<div key=${f.label}><div className="bar" style=${{ background: f.bg }}></div><span style=${{ color: f.fg }}>${f.label}</span></div>`)}</div>
        <dl className="kv">
          <dt>Status</dt><dd>${tv.status}</dd>
          <dt>Priority</dt><dd>${sev.label}</dd>
          ${!closed && h`<${Frag}><dt>Due</dt><dd><span className=${'due ' + tv.dueText.tone}>${tv.due || 'No due time'}${t.overdue ? ' · overdue' : ''}</span>${sla !== null && h` <span className="note">(SLA ${L.duration(sla)} for ${t.severity})</span>`}</dd><//>`}
          ${t.escalated && h`<${Frag}><dt>Escalated</dt><dd>${L.whenFull(t.escalated_at, now)} · ${t.escalation_reason}</dd><//>`}
          ${closed && t.resolution_note && h`<${Frag}><dt>Resolution</dt><dd>${t.resolution_note}</dd><//>`}
          <dt>Opened</dt><dd>${L.whenFull(t.created_at, now)}</dd>
          <dt>Last updated</dt><dd>${L.whenFull(t.updated_at, now)}</dd>
        </dl>
      </section>

      <section className="t-sec">
        <h3 className="h3">Activity</h3>
        <${State} loading=${!d && !this.state.error} error=${!d && this.state.error} retry=${this.load} empty=${d && d.history.length === 0 && 'No activity yet.'}>
          ${d && d.history.map((x, i) => h`<${HistoryRow} key=${i} time=${L.when(x.at, now)} title=${x.title} text=${x.text} />`)}
        <//>
        ${d && this.state.error && h`<p className="note">Couldn’t refresh the activity (${this.state.error}).</p>`}
      </section>
    </article>`;
  }
}

// ---------- an operator's WhatsApp thread, opened when it's needed ----------

export class OperatorDrawer extends React.Component {
  state = { data: null, error: null, draft: '', sendError: null };
  logRef = React.createRef();
  scroll = {};
  fetch = L.latest();
  componentDidMount() { this.load(); }
  componentDidUpdate(prev) {
    if (this.props.id !== prev.id || this.props.ctx.tick !== prev.ctx.tick) this.load();
    const d = this.state.data;
    if (d) stickToBottom(this.logRef.current, `${d.id}:${d.messages.length}`, this.scroll);
  }
  load = () => this.fetch(`/operators/${this.props.id}`, data => this.setState({ data, error: null }), error => this.setState({ error }));
  async send(op) {
    const text = this.state.draft.trim(), ctx = this.props.ctx;
    if (!text || ctx.pending['opmsg:' + op.id]) return;
    const r = await ctx.act('opmsg:' + op.id, () => L.api('POST', `/operators/${op.id}/message`, { text }), () => `Sent to ${op.name} on WhatsApp.`, { quiet: true });
    this.setState(r.ok ? { draft: '', sendError: null } : { sendError: r.error });
  }
  markDone(op, t) {
    const ctx = this.props.ctx;
    if (t.notifies_guest && !window.confirm(`Mark ${t.ref} done for ${op.name}? Gia will tell ${t.guest || 'the guest'} it’s done.`)) return;
    ctx.markActed(t.ref);
    return ctx.act('done:' + t.id, () => L.api('POST', `/tickets/${t.id}/done`),
      r => `${r.ref} done · resolved in ${L.duration(r.minutes)}` + (r.guest_messaged ? '. Gia told the guest.' : '.'));
  }
  render() {
    const p = this.props, ctx = p.ctx, d = this.state.data, now = ctx.now;
    return h`<${Drawer} label="Operator" onClose=${p.onClose}>
      <${State} loading=${!d && !this.state.error} error=${!d && this.state.error} retry=${this.load}>
        ${d && h`<div className="op-drawer">
          <header>
            <div className="eyebrow">Operator · WhatsApp</div>
            <h2 className="h2">${d.name}</h2>
            <div className="note">${L.roleSummary(d)} · ${d.phone ? L.phoneLabel(d.phone) : 'No number'}</div>
            <div className="link-row">
              <${PresenceChip} presence=${d.presence} />
              <button className="btn small" disabled=${!!ctx.pending['presence:' + d.id] || ctx.stale}
                onClick=${() => ctx.act('presence:' + d.id, () => L.api('POST', `/operators/${d.id}/presence`, { presence: d.presence === 'onsite' ? 'offsite' : 'onsite' }), () => `${d.name} is now ${d.presence === 'onsite' ? 'offsite' : 'onsite'}.`)}>
                Mark ${d.presence === 'onsite' ? 'offsite' : 'onsite'}</button>
              <span className="note">${d.open} open · ${d.resolved} resolved${d.avg_resolve_minutes !== null ? ' · avg ' + L.duration(d.avg_resolve_minutes) : ''}</span>
            </div>
          </header>
          <section>
            <h3 className="h3">Open tasks</h3>
            ${d.tasks.length === 0 && h`<div className="note">No open tasks.</div>`}
            ${d.tasks.map(t => h`<div key=${t.ref} className="op-task">
              <button className="btn-link" onClick=${() => { p.onClose(); ctx.openTicket(t.ref); }}>${t.ref}</button>
              <span className="op-task-title">${t.summary} <span className="note">· ${t.villa}</span></span>
              <button className="btn small" onClick=${() => this.markDone(d, t)} disabled=${!!ctx.pending['done:' + t.id] || ctx.stale}
                title="As the operator would from the field app">${ctx.pending['done:' + t.id] ? 'Saving…' : 'Mark done'}</button>
            </div>`)}
          </section>
          <div ref=${this.logRef} className="chat-log op-log" onScroll=${trackScroll(this.scroll)}>
            ${L.operatorChat(d, now).map(ChatItem)}
            ${d.messages.length === 0 && h`<div className="chat-empty">No messages yet. Tasks Gia sends ${d.name.split(' ')[0]} appear here.</div>`}
          </div>
          <footer className="composer">
            <${Composer} value=${this.state.draft} onChange=${draft => this.setState({ draft, sendError: null })} onSend=${() => this.send(d)}
              sending=${!!ctx.pending['opmsg:' + d.id]} disabled=${ctx.stale} placeholder=${`Message ${d.name.split(' ')[0]}…`} label=${`Message ${d.name} on WhatsApp`}
              warn=${!d.window_open && `${d.name.split(' ')[0]} hasn’t written in 24 hours, so WhatsApp may refuse free text. New tasks still reach them as a template.`}
              error=${this.state.sendError} onRetry=${() => this.send(d)} />
          </footer>
        </div>`}
      <//>
    <//>`;
  }
}

// ---------- add operator ----------

export function AddOperator(a) {
  const f = a.form;
  return h`<${Dialog} title="Add operator" onClose=${a.close}>
    <form className="dialog-form" onSubmit=${e => { e.preventDefault(); if (a.canSubmit) a.submit(); }}>
      <label className="field">Name<input value=${f.name} onChange=${e => a.set('name', e.target.value)} placeholder="Ramesh Patil" autoFocus /></label>
      <label className="field">WhatsApp number<input value=${f.phone} onChange=${e => a.set('phone', e.target.value)} placeholder="91 98XXX XXXXX (with country code)" inputMode="tel" /></label>
      <label className="field">Role<select value=${f.role} onChange=${e => a.set('role', e.target.value)}>
        ${a.roles.map(r => h`<option key=${r} value=${r}>${L.ROLE_LABEL[r] || r}</option>`)}
      </select></label>
      <fieldset><legend>Villas</legend>
        ${a.villas.map(v => h`<label key=${v.id} className="check"><input type="checkbox" checked=${f.villa_ids.includes(v.id)} onChange=${() => a.toggleVilla(v.id)} />${v.name}</label>`)}
      </fieldset>
      <fieldset><legend>Right now</legend>
        ${['onsite', 'offsite'].map(x => h`<label key=${x} className="check"><input type="radio" name="presence" checked=${f.presence === x} onChange=${() => a.set('presence', x)} />${x === 'onsite' ? 'On-site' : 'Off-site'}</label>`)}
      </fieldset>
      ${a.replacedText && h`<p className="warn-text">${a.replacedText}</p>`}
      <p className="note">Tickets for these villas go to them by role (maintenance, housekeeping, then caretaker or manager), on-site first. Gia sends each task on WhatsApp; they reply DONE when it’s finished.</p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick=${a.close}>Cancel</button>
        <button type="submit" className="btn-primary" disabled=${!a.canSubmit || a.pending}>${a.pending ? 'Adding…' : 'Add operator'}</button>
      </div>
    </form>
  <//>`;
}

// ---------- the scripted demo tickets (OI-5521, OI-5534) ----------

export function DemoTicketDetail(t, sc, ph) {
  return h`<article className="ticket">
    <header className="ticket-head">
      <div className="ref"><span className="mono">${t.id}</span> · ${t.villa} · ${t.cat} · <${DemoChip} /></div>
      <h2 className="title">${t.title}</h2>
      <div className="chips-inline">${Pill(t.pill, t.status)}<span style=${{ color: t.sevColor, fontWeight: 700, fontSize: '12px' }}>${t.sevGlyph} ${t.sev}</span></div>
    </header>
    <dl className="kv"><dt>Owner</dt><dd>${t.owner}</dd><dt>Source</dt><dd>${t.origin}</dd><dt>Updated</dt><dd>${t.updated}</dd></dl>
    ${t.humanReason && h`<div className="human-only"><b>Human only</b><span>${t.humanReason}</span></div>`}
    ${t.tracker && h`<div className="tracker">${t.tracker.map(k => h`<div key=${k.label} style=${{ border: '1px solid ' + k.border, background: k.bg }}>
      <span className="g" style=${{ color: k.fg }}>${k.glyph}</span><span className="l" style=${{ color: k.fg }}>${k.label}</span></div>`)}</div>`}
    <div className="report"><div className="eyebrow">Original report</div><p>“${t.issue}”</p></div>
    <div className="two-col">
      <div><div className="eyebrow">Work checklist</div>${t.checklist.map(c => h`<div key=${c.label} className="check-row">
        <span className="g" style=${{ color: c.color }}>${c.glyph}</span><span className="l">${c.label}</span><span className="s" style=${{ color: c.color }}>${c.stateLabel}</span></div>`)}</div>
      <div><div className="eyebrow">Closure conditions</div>${t.closure.map(c => h`<div key=${c.label} className="check-row">
        <span className="g" style=${{ color: c.color }}>${c.glyph}</span><span>${c.label}</span></div>`)}</div>
    </div>
    <div className="review" style=${{ border: '1px solid ' + t.review.border, background: t.review.bg }}>
      <div className="top"><span className="title" style=${{ color: t.review.fg }}>${t.review.title}</span>${t.review.simulated && h`<span className="sim-tag">Simulated vision check</span>`}</div>
      <p>${t.review.text}</p>
    </div>
    ${t.attempts.map(at => h`<div key=${at.n} className="attempt">
      <div className="top"><span className="ti">Evidence · attempt ${at.n} <span>· ${at.time}</span></span><span className="result" style=${{ background: at.bg, color: at.fg }}>${at.result}</span></div>
      <div className="photos">${at.items.map(it => h`<div key=${it.label} className="photo" style=${{ border: '1px solid ' + it.border }}>
        <div className="hatch">${it.ph}<span className="badge" style=${{ background: it.badgeBg }}>${it.glyph}</span></div>
        <div className="cap"><b>${it.label}</b>${it.hasWhy && h`<span className="why">${it.why}</span>`}</div>
      </div>`)}</div>
    </div>`)}
    ${t.scenario && ph && h`<section className="t-sec"><h3 className="h3">Field app (the operator’s view)</h3>${DemoPhone(ph)}</section>`}
    <details className="more"><summary>Audit trail</summary><div className="more-body">${t.history.map((x, i) => h`<${HistoryRow} key=${i} ...${x} />`)}${t.history.length === 0 && h`<div className="note">No entries yet.</div>`}</div></details>
    ${t.scenario && sc && h`<div className="task-scenario">
      <span className="step-text">Step ${sc.no} of ${sc.total} · <b>${sc.title}</b></span><span className="spacer"></span>
      <button className="btn-sq" onClick=${sc.prev} aria-label="Previous step">◀</button>
      <button className="btn-step primary" onClick=${sc.next}>Next ▶</button>
      <button className="btn-step outline" onClick=${sc.flow}>View workflow</button>
    </div>`}
  </article>`;
}

function Slot(sl, prefix) {
  return h`<button key=${sl.key} className="slot" onClick=${sl.tap} style=${{ border: sl.border }} aria-pressed=${sl.on}>
    <span className="thumb" style=${{ background: sl.thumb }}>${sl.icon}</span><span className="l">${prefix || ''}${sl.label}</span>
  </button>`;
}

// The photo-evidence walkthrough on OI-5534: shown only with that ticket, where it's the point of the scenario.
function DemoPhone(ph) {
  return h`<div className="phone">
    <div className="phone-head"><span className="app">Lohono Field</span><span className="who">Santosh Naik · Maintenance</span></div>
    <div className="phone-body">
      ${ph.idle && h`<div className="phone-hint">No task assigned yet. The ops agent is creating the ticket.</div>`}
      ${ph.showTask && h`<div className="phone-task"><span className="ref">OI-5534 · Medium</span><span className="ti">Basin leak · Bedroom 2 bathroom</span><span className="loc">Casa Alba · Awas Shores, Alibaug</span></div>`}
      ${ph.assigned && h`<${Frag}><div className="phone-text">Guest has been told you’ll arrive by 10:30 am. You’ll need a photo for each checklist item before the ticket can close.</div>
        <button className="phone-cta" onClick=${ph.finish}>I’ve finished the repair</button><//>`}
      ${ph.capture && h`<${Frag}><div className="phone-label">Add a photo for each item</div>${ph.slots.map(sl => Slot(sl))}
        <button className="phone-cta" onClick=${ph.submit} disabled=${!ph.canSubmit}>Submit evidence</button><//>`}
      ${ph.checking && h`<div className="phone-state checking"><span className="icon">◎</span><span className="ti">Checking your photos…</span><span className="tx">Each photo is compared against its checklist item.</span></div>`}
      ${ph.rework && h`<${Frag}><div className="phone-state rework"><span className="ti">${ph.reworkTitle}</span>${ph.reasons.map(rs => h`<span key=${rs.label} className="tx"><b>${rs.label}:</b> ${rs.why}</span>`)}</div>
        ${ph.canRetake && h`<${Frag}>${ph.retake.map(sl => Slot(sl, 'Retake · '))}<button className="phone-cta" onClick=${ph.resubmit} disabled=${!ph.canResubmit}>Resubmit evidence</button><//>`}<//>`}
      ${ph.accepted && h`<div className="phone-state accepted"><span className="icon">✓</span><span className="ti">Evidence accepted</span><span className="tx">${ph.acceptedText}</span></div>`}
      ${ph.escalated && h`<div className="phone-state escalated"><span className="ti">Escalated to villa manager</span><span className="tx">Francis D’Souza will inspect on site. Please stay at the villa until he arrives.</span></div>`}
    </div>
  </div>`;
}

export const demoRow = t => ({ ref: t.id, title: t.title, villa: t.villa, sev: t.sev, sevColor: t.sevColor, sevGlyph: t.sevGlyph,
  pill: t.pill, status: t.status, ownerShort: t.ownerShort, updated: t.updated || '' });
