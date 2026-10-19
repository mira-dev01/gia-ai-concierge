// The guest–Gia conversation for one booking, as a compact messaging panel: who's handling it (Gia or a person),
// the WhatsApp history with each message's delivery state, waiting handoffs, the guest's context, and a reply box
// while ops has taken over. Loaded on its own when opened (never for the whole portfolio) and refreshed with the
// console's live sync. Opening a conversation never changes who's handling it.
import * as L from './live.js';
import { h, Frag, ChatItem, Tone, State, Composer, stickToBottom, trackScroll } from './ui.js';

const { React } = window;

// UC-OPS-09: the guest profile, grouped the way ops reads it.
const PREF_KINDS = [['like', 'Likes'], ['dislike', 'Dislikes'], ['arrangement', 'Arrangements']];
const RELATION = { current: 'Current stay', next: 'Next arrival', upcoming: 'Upcoming stay', past: 'Past stay', other: 'Not a confirmed stay' };
export const conversationLabel = c => `${c.guest} · ${c.check_in ? L.dateRange(c.check_in, c.check_out) : 'no dates'} · ${c.relation === 'other' ? c.label : RELATION[c.relation]}${c.messages ? '' : ' · no messages yet'}`;

export class ConversationPanel extends React.Component {
  state = { data: null, forId: null, loading: false, error: null, drafts: {}, sendError: null, prefShown: null };
  logRef = React.createRef();
  fetch = L.latest();
  scroll = {};

  componentDidMount() { if (this.props.active && this.props.bookingId) this.load(); }
  componentDidUpdate(prev) {
    const p = this.props;
    const changed = p.bookingId !== prev.bookingId;
    if (p.active && p.bookingId && (changed || p.ctx.tick !== prev.ctx.tick || !prev.active)) this.load();
    const d = this.state.data;
    if (d && d.booking.id === p.bookingId) stickToBottom(this.logRef.current, `${d.booking.id}:${d.messages.length}:${d.events.length}`, this.scroll);
  }

  load = () => {
    const id = this.props.bookingId;
    if (this.state.forId !== id) this.setState({ forId: id, data: null, loading: true, error: null, sendError: null });
    this.fetch(`/bookings/${encodeURIComponent(id)}/conversation`,
      data => this.setState({ data, loading: false, error: null }), error => this.setState({ loading: false, error }));
  };

  draft() { return this.state.drafts[this.props.bookingId] || ''; }
  setDraft(text) { const id = this.props.bookingId; this.setState(s => ({ drafts: { ...s.drafts, [id]: text }, sendError: null })); }

  async send(b) {
    const text = this.draft().trim(), ctx = this.props.ctx;
    if (!text || ctx.pending['reply:' + b.id]) return;  // one send at a time: no duplicate submissions
    const r = await ctx.act('reply:' + b.id, () => L.api('POST', `/bookings/${encodeURIComponent(b.id)}/reply`, { text }),
      () => `Sent to ${b.guest} on WhatsApp.`, { quiet: true });
    if (r.ok) this.setState(s => ({ drafts: { ...s.drafts, [b.id]: '' }, sendError: null }));
    else this.setState({ sendError: r.error });
  }

  setTakeover(b, on) {
    return this.props.ctx.act('takeover:' + b.id, () => L.api('POST', `/bookings/${encodeURIComponent(b.id)}/takeover`, { on }),
      () => on ? `You’re handling ${b.guest}’s chat. Gia is paused.` : `Handed back. Gia is replying to ${b.guest} again.`);
  }

  // A preference's source: say where and when the guest said it, and if that message is in this chat, go to it.
  showSource(x) {
    this.setState({ prefShown: x.id });
    const log = this.logRef.current;
    const el = x.booking_id === this.props.bookingId && log && log.querySelector(`[data-msg="${x.message_id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;  // restart the highlight if it's already running
    el.classList.add('flash');
  }

  resolveHandoff(x) {
    return this.props.ctx.act('handoff:' + x.id, () => L.api('POST', `/handoffs/${x.id}/resolve`), () => `HO-${x.id} marked resolved.`);
  }

  render() {
    const p = this.props, s = this.state, ctx = p.ctx;
    const d = s.data && s.data.booking.id === p.bookingId ? s.data : null;
    const options = p.options || [];
    const picked = options.find(o => o.id === p.bookingId);
    const picker = options.length > 1 && h`<label className="convo-pick">
      <span className="sr-only">Conversation</span>
      <select value=${p.bookingId || ''} onChange=${e => p.onSelect(e.target.value)} aria-label="Choose a conversation at this property">
        ${!p.bookingId && h`<option value="">Choose a conversation…</option>`}
        ${options.map(o => h`<option key=${o.id} value=${o.id}>${conversationLabel(o)}</option>`)}
      </select>
    </label>`;
    if (!d) return h`<section className="convo" aria-label="Guest conversation">
      ${picker}
      <div className="convo-body"><${State} loading=${s.loading || !s.error} error=${s.error} retry=${this.load} /></div>
    </section>`;

    const b = d.booking, now = ctx.now;
    const waiting = d.handoffs.filter(x => x.status === 'waiting');
    const takeover = d.takeover;
    const busy = !!ctx.pending['takeover:' + b.id], sending = !!ctx.pending['reply:' + b.id];
    const blocked = ctx.stale ? 'Reconnecting: actions are paused until the console can confirm the current state.' : '';
    const chat = L.chatItems(d, now, t => ctx.openTicket(t.ref));
    const relation = picked ? picked.relation : null;
    const first = b.guest.split(' ')[0];
    const openRequests = d.tickets.filter(t => t.status !== 'closed');
    const ctxRows = [
      ['Party', L.party(b)],
      ...(b.occasion ? [['Occasion', b.occasion]] : []),
      ...L.detailRows(d.details).map(r => [r.k, r.v]),
      ...(b.pre_booked_services.length ? [['Pre-booked', b.pre_booked_services.join(', ')]] : []),
      ['Phone', L.phoneLabel(b.phone)], ['Language', b.language === 'hi' ? 'Hindi' : b.language === 'en' ? 'English' : (b.language || 'Not recorded')]
    ];

    return h`<section className="convo" aria-label=${`Conversation with ${b.guest}`}>
      <header className="convo-head">
        <div className="convo-who">
          <div className="convo-name">${b.guest}${b.vip && h` <span className="vip">VIP</span>`}</div>
          <div className="convo-sub"><span className="mono">${b.id}</span> · ${b.check_in ? L.dateRange(b.check_in, b.check_out) : 'No dates'} · ${b.label}</div>
        </div>
        <div className="convo-actions">
          <${Tone} tone=${takeover ? 'warn' : 'ok'} glyph=${takeover ? '◆' : '●'}>${takeover ? 'You’re replying' : 'Gia is replying'}<//>
          <button className=${!takeover && waiting.length ? 'btn-primary small' : 'btn small'} onClick=${() => this.setTakeover(b, !takeover)}
            disabled=${busy || !!blocked} title=${blocked || (takeover ? 'Gia starts replying again and is told what happened' : 'Gia stops replying and holds scheduled messages until you hand back')}>
            ${busy ? 'Saving…' : takeover ? 'Hand back to Gia' : 'Take over'}
          </button>
        </div>
      </header>
      ${picker}
      ${relation === 'past' && h`<div className="convo-banner warn" role="note">Past stay: ${first} checked out on ${L.dayLabel(b.check_out)}. These messages aren’t about the current or next booking.</div>`}
      ${relation === 'other' && h`<div className="convo-banner warn" role="note">${b.label}. This isn’t a confirmed stay.</div>`}
      ${(relation === 'next' || relation === 'upcoming') && b.check_in && h`<div className="convo-banner info">Arrives ${L.longDate(b.check_in)} (${L.relDays(b.days_to_arrival)})${b.arrival_time ? ` · check-in from ${b.arrival_time}` : ''}</div>`}
      ${waiting.map(x => h`<div key=${x.id} className=${'handoff-bar' + (x.urgency === 'urgent' ? ' urgent' : '')} role="status">
        <span className="tx"><b>${x.urgency === 'urgent' ? '▲ Urgent · needs a person' : 'Needs a person'}</b> · ${x.reason} <span className="at">${L.whenFull(x.at, now)}</span></span>
        <button className="btn small" onClick=${() => this.resolveHandoff(x)} disabled=${!!ctx.pending['handoff:' + x.id] || !!blocked}>Mark resolved</button>
      </div>`)}
      ${s.error && h`<div className="convo-banner warn" role="status">Couldn’t refresh (${s.error}). Showing what was loaded last.</div>`}

      <details className="convo-context">
        <summary>Guest context${openRequests.length ? ` · ${openRequests.length} open request${openRequests.length > 1 ? 's' : ''}` : ''}${d.preferences.length ? ` · ${d.preferences.length} preference${d.preferences.length > 1 ? 's' : ''}` : ''}</summary>
        <div className="convo-context-body">
          <dl className="kv">${ctxRows.map(([k, v]) => h`<${Frag} key=${k}><dt>${k}</dt><dd>${v}</dd><//>`)}
            ${!Object.keys(d.details || {}).length && h`<${Frag}><dt>Arrival</dt><dd className="missing">Not shared yet</dd><//>`}
          </dl>
          ${d.preferences.length > 0 && h`<div className="stack sm"><div className="eyebrow">Guest profile${d.profile.stays > 1 ? ` · ${d.profile.stays} stays` : ''}</div>
            ${PREF_KINDS.map(([kind, label]) => {
              const xs = d.preferences.filter(x => (x.kind || 'like') === kind);
              return xs.length > 0 && h`<div key=${kind} className="prefs"><span className="pref-kind">${label}</span>
                ${xs.map(x => h`<button key=${x.id} className="pref" aria-pressed=${s.prefShown === x.id} onClick=${() => this.showSource(x)}
                  title="Show where the guest said this">${x.preference}</button>`)}
              </div>`;
            })}
            ${(shown => shown && h`<div className="pref-source" role="status">${L.titleCase(shown.category)} · “${shown.source_quote}” · ${shown.booking_id === b.id ? 'this chat' : `${shown.villa || shown.booking_id} stay (${shown.booking_id})`}, ${L.whenFull(shown.at, now)}${shown.source && shown.source !== 'whatsapp' ? ` · via ${shown.source}` : ''}</div>`)(d.preferences.find(x => x.id === s.prefShown))}
          </div>`}
          ${openRequests.length > 0 && h`<ul className="plain-list">${openRequests.map(t => h`<li key=${t.ref}>
            <button className="btn-link" onClick=${() => ctx.openTicket(t.ref)}>${t.ref}</button> ${t.summary} · ${L.STATUS_LABEL[t.status] || L.titleCase(t.status)}
          </li>`)}</ul>`}
          ${d.journey.length > 0 && h`<div className="stack sm"><div className="eyebrow">Pre-arrival messages</div>
            ${L.journeyRows(d.journey, now).map(j => h`<div key=${j.k} className="mark-row"><span className="g" style=${{ color: j.color }} aria-hidden="true">${j.glyph}</span><span className="spacer">${j.k}</span><span className="n">${j.note}</span></div>`)}
          </div>`}
        </div>
      </details>

      <div ref=${this.logRef} className="chat-log" onScroll=${trackScroll(this.scroll)} aria-live="polite" aria-relevant="additions">
        ${d.total_messages > d.messages.length && h`<div className="chat-date">Showing the latest ${d.messages.length} of ${d.total_messages} messages</div>`}
        ${chat.map(ChatItem)}
        ${chat.length === 0 && h`<div className="chat-empty">No messages with ${first} yet.${b.presence === 'upcoming' || b.presence === 'arriving' ? ' Gia’s pre-arrival messages will appear here.' : ''}</div>`}
      </div>

      <footer className="composer">
        ${takeover ? h`<${Composer} value=${this.draft()} onChange=${t => this.setDraft(t)} onSend=${() => this.send(b)} sending=${sending}
            disabled=${!!blocked} placeholder="Reply on WhatsApp…" label=${`Reply to ${b.guest} on WhatsApp`}
            warn=${!d.window_open && `${first} hasn’t written in the last 24 hours, so WhatsApp will refuse free text. Call them instead.`}
            error=${s.sendError} onRetry=${() => this.send(b)} />`
          : h`<div className="composer-status"><span className="live" aria-hidden="true"></span>Gia is replying automatically. Take over to reply yourself.</div>`}
      </footer>
    </section>`;
  }
}
