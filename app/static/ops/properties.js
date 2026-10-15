// Properties: the portfolio as a compact, searchable register, and one property as a three-column workspace
// (property selector · profile · guest conversation). Search, filters, sorting and paging run on the backend
// (/api/properties), so the register scales to the whole portfolio; a property's profile and conversation are
// loaded only when it's opened. Occupancy, booking status, readiness and attention come from the backend's
// portfolio rules, the same ones Overview and Operations use.
import * as L from './live.js';
import { h, Frag, Tone, StayChip, Missing, Value, LiveTag, State, Popover, HistoryRow, AttentionList, FilterChips, FilterTokens } from './ui.js';
import { ConversationPanel, conversationLabel } from './conversation.js';

const { React } = window;

export const EMPTY_QUERY = { q: '', stay: 'all', arrivals: '', blockers: false, location: '', manager: '', sort: 'arrival', offset: 0 };
const PAGE = 50;
const STAY_CHIPS = [['all', 'All'], ['occupied', 'Occupied'], ['pre_arrival', 'Pre-arrival'], ['turnover', 'Checkout / turnover'], ['vacant', 'Vacant'], ['attention', 'Needs attention']];
const ARRIVALS = [['', 'Any time'], ['today', 'Arriving today'], ['48h', 'Next 48 hours'], ['7d', 'Next 7 days']];
const SORTS = [['arrival', 'Next arrival'], ['attention', 'Needs attention'], ['overdue', 'Overdue work'], ['name', 'Property name']];
const TABS = [['overview', 'Overview'], ['facilities', 'Facilities'], ['team', 'Team']];
const SEARCH_DELAY_MS = 250;
const ACTIVITY_SHOWN = 6;
const SERVICES_SHOWN = 6;
const ROLE = r => L.ROLE_LABEL[r] || L.titleCase(r);

const attentionTone = sev => L.SEVERITY_TONE[sev] || 'neutral';
const nextArrivalText = (next, now) => !next ? null
  : next.days_to_arrival === 0 ? 'Today' : `${L.dayLabel(next.check_in)} · ${L.relDays(next.days_to_arrival)}`;

export class PropertiesWorkspace extends React.Component {
  state = { reg: null, regError: null, regLoading: false, prof: null, profFor: null, profError: null, qDraft: this.props.query.q };
  fetchRegister = L.latest();
  fetchProfile = L.latest();

  componentDidMount() { if (this.props.active) { this.loadRegister(); this.loadProfile(); } }
  componentDidUpdate(prev) {
    const p = this.props;
    const becameActive = p.active && !prev.active, ticked = p.ctx.tick !== prev.ctx.tick;
    if (p.active && (becameActive || ticked || JSON.stringify(p.query) !== JSON.stringify(prev.query))) this.loadRegister();
    if (p.active && p.nav.villa && (becameActive || ticked || p.nav.villa !== prev.nav.villa)) this.loadProfile();
    if (p.nav.villa !== prev.nav.villa && (this.state.allActivity || this.state.allServices)) this.setState({ allActivity: false, allServices: false });
    if (p.query.q !== prev.query.q && p.query.q !== this.state.qDraft) this.setState({ qDraft: p.query.q });
    // Back to the register: put it where the user left it.
    if (prev.nav.villa && !p.nav.villa && this.regScroll !== undefined) {
      const main = document.querySelector('.main');
      setTimeout(() => { if (main) main.scrollTop = this.regScroll; }, 0);
    }
  }
  componentWillUnmount() { clearTimeout(this.searchTimer); }

  loadRegister = () => {
    this.setState({ regLoading: true });
    this.fetchRegister('/properties' + L.query({ ...this.props.query, limit: PAGE }),
      reg => this.setState({ reg, regError: null, regLoading: false }), regError => this.setState({ regError, regLoading: false }));
  };

  loadProfile = () => {
    const villa = this.props.nav.villa;
    if (!villa) return;
    if (this.state.profFor !== villa) this.setState({ prof: null, profFor: villa, profError: null });
    this.fetchProfile(`/properties/${encodeURIComponent(villa)}`,
      prof => this.setState({ prof, profError: null }), profError => this.setState({ profError }));
  };

  search(text) {
    this.setState({ qDraft: text });
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.props.setQuery({ q: text, offset: 0 }), SEARCH_DELAY_MS);
  }

  openProperty(id) {
    const main = document.querySelector('.main');
    if (!this.props.nav.villa && main) this.regScroll = main.scrollTop;
    this.props.setNav({ villa: id, booking: null, pane: 'profile' });
  }

  render() {
    const p = this.props;
    return h`<div className="page properties" data-screen-label="Properties" hidden=${!p.active}>
      ${p.nav.villa ? this.workspace() : this.register()}
    </div>`;
  }

  // ---------- the register ----------

  filtersModel() {
    const q = this.props.query, reg = this.state.reg, setQuery = this.props.setQuery;
    const facets = reg ? reg.facets : { locations: [], managers: [] };
    const managerName = id => id === 'none' ? 'No manager' : ((facets.managers.find(m => String(m.id) === id) || {}).name || 'Manager');
    const tokens = [
      q.arrivals && ['arrivals', (ARRIVALS.find(a => a[0] === q.arrivals) || [])[1]],
      q.blockers && ['blockers', 'Readiness blockers'],
      q.location && ['location', 'Location: ' + q.location],
      q.manager && ['manager', 'Manager: ' + managerName(q.manager)],
      q.q && ['q', `“${q.q}”`]
    ].filter(Boolean);
    return { facets, tokens, secondary: tokens.filter(t => t[0] !== 'q').length,
      reset: () => { this.setState({ qDraft: '' }); setQuery({ ...EMPTY_QUERY, sort: q.sort }); },
      clear: key => { if (key === 'q') this.setState({ qDraft: '' }); setQuery({ [key]: EMPTY_QUERY[key], offset: 0 }); } };
  }

  secondaryFilters(f) {
    const q = this.props.query, set = patch => this.props.setQuery({ ...patch, offset: 0 });
    return h`<div className="filter-panel">
      <fieldset><legend>Arrivals</legend>
        ${ARRIVALS.map(([v, label]) => h`<label key=${v || 'any'} className="check"><input type="radio" name="arrivals" checked=${q.arrivals === v} onChange=${() => set({ arrivals: v })} />${label}</label>`)}
      </fieldset>
      <fieldset><legend>Readiness</legend>
        <label className="check"><input type="checkbox" checked=${q.blockers} onChange=${e => set({ blockers: e.target.checked })} />Only villas with readiness blockers</label>
      </fieldset>
      <label className="field">Location
        <select value=${q.location} onChange=${e => set({ location: e.target.value })}>
          <option value="">All locations</option>
          ${f.facets.locations.map(x => h`<option key=${x} value=${x}>${x}</option>`)}
        </select>
      </label>
      <label className="field">Villa manager
        <select value=${q.manager} onChange=${e => set({ manager: e.target.value })}>
          <option value="">Any manager</option>
          <option value="none">No manager assigned</option>
          ${f.facets.managers.map(m => h`<option key=${m.id} value=${String(m.id)}>${m.name}</option>`)}
        </select>
      </label>
    </div>`;
  }

  register() {
    const p = this.props, s = this.state, q = p.query, ctx = p.ctx, reg = s.reg;
    const f = this.filtersModel();
    const counts = reg ? reg.counts : {};
    const rows = reg ? reg.rows : [];
    const filtered = f.tokens.length > 0 || q.stay !== 'all';
    return h`<${Frag}>
      <header className="page-head compact">
        <div><div className="kicker">${ctx.now ? L.longDate(ctx.now) : ''}</div><h1 className="page-title">Properties</h1></div>
        <div className="head-actions"><${LiveTag} sync=${ctx.sync} /></div>
      </header>

      <div className="register-tools">
        <input className="search-input" type="search" value=${s.qDraft} onChange=${e => this.search(e.target.value)}
          placeholder="Search property, ID, location or manager" aria-label="Search properties" />
        <label className="sort"><span>Sort</span>
          <select value=${q.sort} onChange=${e => p.setQuery({ sort: e.target.value, offset: 0 })}>
            ${SORTS.map(([v, label]) => h`<option key=${v} value=${v}>${label}</option>`)}
          </select>
        </label>
        <${Popover} label="More filters" count=${f.secondary}>${this.secondaryFilters(f)}<//>
      </div>

      <${FilterChips} label="Stay status" value=${q.stay} onChange=${stay => p.setQuery({ stay, offset: 0 })}
        options=${STAY_CHIPS.map(([key, label]) => [key, label, reg ? counts[key] : null, key === 'attention' && counts.attention > 0])} />
      <${FilterTokens} tokens=${f.tokens} onRemove=${f.clear} onReset=${f.reset} />

      <div className="register-meta note">
        ${reg ? `${reg.total === reg.portfolio_total ? `${reg.total} properties` : `${reg.total} of ${reg.portfolio_total} properties`} · bookings last updated from OI ${reg.bookings_updated_at ? L.whenFull(reg.bookings_updated_at, reg.now) : 'never'}` : ''}
        ${s.regLoading && reg && h` · <span aria-live="polite">Updating…</span>`}
      </div>
      ${s.regError && reg && h`<div className="banner warn" role="status">Couldn’t refresh the register (${s.regError}). Showing the last list loaded.</div>`}

      <div className="card register">
        <${State} loading=${!reg && !s.regError} error=${!reg && s.regError} retry=${this.loadRegister}
          empty=${reg && rows.length === 0 && (reg.portfolio_total === 0 ? 'No properties on record.'
            : h`No properties match ${filtered ? 'these filters' : 'this search'}. <button className="btn-link" onClick=${f.reset}>Reset filters</button>`)}>
          <table className="reg-table">
            <thead><tr><th scope="col">Property</th><th scope="col">Today</th><th scope="col">Current guest</th><th scope="col">Next arrival</th><th scope="col">Needs attention</th></tr></thead>
            <tbody>${rows.map(r => this.registerRow(r, ctx.now))}</tbody>
          </table>
        <//>
      </div>
      ${reg && this.pager(reg)}
    <//>`;
  }

  registerRow(r, now) {
    const st = r.stay, a = r.attention;
    const open = () => this.openProperty(r.id);
    return h`<tr key=${r.id} onClick=${open} className=${a.severity === 'critical' ? 'crit' : ''}>
      <td className="c-name">
        <button className="row-link" onClick=${e => { e.stopPropagation(); open(); }}>${r.name}</button>
        <div className="note">${r.location || h`<${Missing}>Location not recorded<//>`} · <span className="mono">${r.id}</span></div>
      </td>
      <td><${StayChip} stay=${st} />${r.readiness.key === 'blocked' && h`<div className="sub-flag"><${Tone} tone="bad" glyph="▲">Readiness blocked<//></div>`}</td>
      <td>${st.current ? h`<span className="strong">${st.current.guest}</span><div className="note">${st.key === 'checkout' || st.key === 'turnover' ? 'Checks out today' : 'Out ' + L.dayLabel(st.current.check_out)}</div>`
        : h`<span className="dash" aria-label="No guest in residence">—</span>`}</td>
      <td>${st.next ? h`<span className="strong">${nextArrivalText(st.next, now)}</span><div className="note">${st.next.guest}</div>`
        : h`<${Missing}>${r.has_bookings ? 'No confirmed arrival' : 'No bookings on record'}<//>`}</td>
      <td>${a.count ? h`<${Tone} tone=${attentionTone(a.severity)} glyph="▲">${a.count === 1 ? a.top.reasons[0] : `${a.count} items`}<//><div className="note clamp">${a.top.title}</div>`
        : h`<span className="note">None</span>`}</td>
    </tr>`;
  }

  pager(reg) {
    if (reg.total <= reg.limit) return null;
    const from = reg.offset + 1, to = Math.min(reg.offset + reg.limit, reg.total), set = this.props.setQuery;
    return h`<nav className="pager" aria-label="Pages">
      <span className="note">${from}–${to} of ${reg.total}</span>
      <button className="btn small" disabled=${reg.offset === 0} onClick=${() => set({ offset: Math.max(0, reg.offset - reg.limit) })}>Previous</button>
      <button className="btn small" disabled=${to >= reg.total} onClick=${() => set({ offset: reg.offset + reg.limit })}>Next</button>
    </nav>`;
  }

  // ---------- one property ----------

  workspace() {
    const p = this.props, s = this.state, nav = p.nav;
    const prof = s.prof && s.prof.property.id === nav.villa ? s.prof : null;
    const convos = prof ? prof.conversations : null;
    const listed = convos && convos.list.some(c => c.id === nav.booking);
    const bookingId = listed ? nav.booking : convos ? convos.default : null;
    return h`<${Frag}>
    ${p.ctx.stale && h`<div className="banner warn stale-banner" role="status">Can’t reach the backend. Showing what was last synced${p.ctx.sync.lastOk ? ` (${p.ctx.sync.lastOk})` : ''}; actions are paused until it reconnects.</div>`}
    <div className=${'prop-workspace pane-' + (nav.pane || 'profile')}>
      ${this.selector()}
      <div className="prop-main card">
        <${State} loading=${!prof && !s.profError} error=${!prof && s.profError} retry=${this.loadProfile}>
          ${prof && this.profile(prof)}
        <//>
      </div>
      <div className="prop-chat card">
        ${prof && (bookingId
          ? h`<${ConversationPanel} bookingId=${bookingId} active=${p.active} ctx=${p.ctx} options=${convos.list}
              onSelect=${id => p.setNav({ booking: id || null })} />`
          : this.noConversation(prof))}
      </div>
    </div><//>`;
  }

  selector() {
    const p = this.props, s = this.state, reg = s.reg;
    return h`<nav className="prop-selector card" aria-label="Properties">
      <div className="sel-head">
        <button className="back-link" onClick=${() => p.setNav({ villa: null })}>← All properties</button>
        <input type="search" value=${s.qDraft} onChange=${e => this.search(e.target.value)} placeholder="Search properties" aria-label="Search properties" />
        ${reg && h`<div className="note">${reg.total} ${reg.total === 1 ? 'property' : 'properties'}${this.filtersModel().tokens.length || p.query.stay !== 'all' ? ' · filtered' : ''}</div>`}
      </div>
      <ul className="sel-list">
        ${(reg ? reg.rows : []).map(r => {
          const on = r.id === p.nav.villa, st = r.stay, a = r.attention;
          return h`<li key=${r.id}><button className=${'sel-row' + (on ? ' on' : '')} aria-current=${on ? 'true' : undefined} onClick=${() => this.openProperty(r.id)}>
            <span className="sel-top"><span className="sel-name">${r.name}</span>
              ${a.count > 0 && h`<span className=${'att-dot ' + attentionTone(a.severity)} title=${`${a.count} need attention`}>▲ ${a.count}</span>`}</span>
            <span className="sel-sub">${r.area || r.location || r.id}</span>
            <span className="sel-sub">${st.label}${st.next && st.next.days_to_arrival > 0 ? ' · next ' + L.dayLabel(st.next.check_in) : ''}</span>
          </button></li>`;
        })}
        ${reg && reg.rows.length === 0 && h`<li className="note sel-empty">No properties match.</li>`}
      </ul>
      ${reg && this.pager(reg)}
      <label className="sel-compact">
        <span className="sr-only">Switch property</span>
        <select value=${p.nav.villa} onChange=${e => this.openProperty(e.target.value)} aria-label="Switch property">
          ${(reg ? reg.rows : []).map(r => h`<option key=${r.id} value=${r.id}>${r.name} · ${r.stay.label}</option>`)}
          ${reg && !reg.rows.some(r => r.id === p.nav.villa) && h`<option value=${p.nav.villa}>${this.state.prof ? this.state.prof.property.name : p.nav.villa}</option>`}
        </select>
      </label>
    </nav>`;
  }

  profile(prof) {
    const p = this.props, nav = p.nav, pr = prof.property, st = prof.stay;
    const tab = TABS.some(t => t[0] === nav.tab) ? nav.tab : 'overview';
    const onTabKey = e => {
      const i = TABS.findIndex(t => t[0] === tab);
      const j = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : -1;
      if (j >= 0) { e.preventDefault(); p.setNav({ tab: TABS[j][0] }); const el = document.getElementById('ptab-' + TABS[j][0]); if (el) el.focus(); }
    };
    return h`<${Frag}>
      <header className="prop-head">
        <div className="prop-id">
          <h1 className="prop-title">${pr.name}</h1>
          <div className="note">${pr.location || h`<${Missing}>Location not recorded<//>`} · <span className="mono">${pr.id}</span>${' · '}Manager: ${pr.manager ? pr.manager.name : h`<${Missing}>Not assigned<//>`}</div>
        </div>
        <div className="prop-head-actions">
          <${StayChip} stay=${st} />
          <a className="btn small" href=${'/admin/villas?q=' + encodeURIComponent(pr.id)} target="_blank" rel="noopener">Villa settings ↗</a>
        </div>
      </header>
      <div className="pane-switch" role="group" aria-label="Show">
        <button className=${nav.pane !== 'chat' ? 'on' : ''} aria-pressed=${nav.pane !== 'chat'} onClick=${() => p.setNav({ pane: 'profile' })}>Property</button>
        <button className=${nav.pane === 'chat' ? 'on' : ''} aria-pressed=${nav.pane === 'chat'} onClick=${() => p.setNav({ pane: 'chat' })}>Conversation</button>
      </div>
      ${this.facts(prof)}
      <div className="ptabs" role="tablist" aria-label="Property sections" onKeyDown=${onTabKey}>
        ${TABS.map(([id, label]) => h`<button key=${id} id=${'ptab-' + id} role="tab" aria-selected=${tab === id} tabIndex=${tab === id ? 0 : -1}
          aria-controls="ptab-panel" className=${tab === id ? 'on' : ''} onClick=${() => p.setNav({ tab: id })}>
          ${label}${id === 'overview' && prof.attention.length ? h` <span className="count-badge">${prof.attention.length}</span>` : ''}
        </button>`)}
      </div>
      <div id="ptab-panel" className="ptab-panel" role="tabpanel" aria-labelledby=${'ptab-' + tab}>
        ${tab === 'overview' && this.overviewTab(prof)}
        ${tab === 'facilities' && this.facilitiesTab(prof.facilities)}
        ${tab === 'team' && this.teamTab(prof)}
      </div>
    <//>`;
  }

  // Current stay · next booking · needs attention: the three facts that answer "what's happening here".
  facts(prof) {
    const p = this.props, st = prof.stay, cur = st.current, nxt = st.next, rd = prof.readiness;
    const att = prof.attention, top = att[0];
    const talk = id => p.setNav({ booking: id, pane: 'chat' });
    const [rdTone, rdGlyph] = L.READINESS_TONE[rd.key] || ['neutral', '–'];
    return h`<div className="facts3">
      <section className="fact" aria-label="Current stay">
        <div className="eyebrow">Current stay</div>
        ${cur ? h`<${Frag}>
            <button className="fact-main btn-link" onClick=${() => talk(cur.id)}>${cur.guest}</button>
            <div className="fact-line">${L.dateRange(cur.check_in, cur.check_out)} · ${L.nights(cur.check_in, cur.check_out)}</div>
            <div className="fact-line note">${L.party(cur)}</div>
            <div className="fact-line">${cur.presence === 'departing' ? h`<${Tone} tone="warn" glyph="◑">Checks out today<//>` : h`<${Tone} tone="ok" glyph="●">${cur.label}<//>`}</div><//>`
          : h`<${Frag}>
            <div className="fact-main muted">No guest in residence</div>
            ${st.key === 'unknown' && h`<div className="fact-line"><${Tone} tone="bad" glyph="?">A booking’s status isn’t recognised<//></div>`}
            ${st.key === 'conflict' && h`<div className="fact-line"><${Tone} tone="bad" glyph="▲">Overlapping confirmed bookings<//></div>`}<//>`}
      </section>
      <section className="fact" aria-label="Next booking">
        <div className="eyebrow">Next booking</div>
        ${nxt ? h`<${Frag}>
            <button className="fact-main btn-link" onClick=${() => talk(nxt.id)}>${nxt.guest}</button>
            <div className="fact-line">${nxt.days_to_arrival === 0 ? 'Arrives today' : `${L.dayLabel(nxt.check_in)} · ${L.relDays(nxt.days_to_arrival)}`}${nxt.arrival_time ? ` · from ${nxt.arrival_time}` : ''}</div>
            <div className="fact-line"><${Tone} tone="ok" glyph="✓">${nxt.label}<//> <span className="mono note">${nxt.id}</span></div><//>`
          : h`<div className="fact-main muted">No confirmed arrival on record</div>`}
        ${st.tentative.length > 0 && h`<div className="fact-line note">+ ${st.tentative.length} tentative hold${st.tentative.length > 1 ? 's' : ''}, not confirmed</div>`}
      </section>
      <section className=${'fact' + (top && top.severity !== 'medium' ? ' alert' : '')} aria-label="Needs attention">
        <div className="eyebrow">Needs attention</div>
        ${top ? h`<${Frag}>
            <button className="fact-main btn-link" onClick=${() => this.actOn(top)}>${att.length} item${att.length > 1 ? 's' : ''}</button>
            <div className="fact-line"><${Tone} tone=${L.SEVERITY_TONE[top.severity]} glyph="▲">${top.reasons[0]}<//></div>
            <div className="fact-line note clamp" title=${top.title}>${top.title}</div><//>`
          : h`<div className="fact-main ok-text">Nothing outstanding</div>`}
        <div className="fact-line">Readiness: <${Tone} tone=${rdTone} glyph=${rdGlyph} title=${rd.text}>${rd.label}<//></div>
      </section>
    </div>`;
  }

  // The next step for an attention item: its ticket in Operations, or the guest's conversation here.
  actOn(a) {
    const p = this.props;
    if (a.kind === 'ticket') p.ctx.openTicket(a.ref);
    else if (a.booking_id && (a.kind === 'handoff' || a.kind === 'message')) p.setNav({ booking: a.booking_id, pane: 'chat' });
    else p.setNav({ tab: 'overview' });
  }

  overviewTab(prof) {
    const p = this.props, now = p.ctx.now;
    const prep = prof.preparation;
    const showAll = this.state.allActivity;
    return h`<div className="stack-lg">
      ${prof.attention.length > 0 && h`<section className="psec">
        <h2 className="h3">Needs attention</h2>
        <${AttentionList} items=${prof.attention} now=${now} onAct=${a => this.actOn(a)} />
      </section>`}

      ${prep && this.preparation(prof, prep)}

      <section className="psec">
        <h2 className="h3">Stays</h2>
        ${prof.timeline.length === 0 ? h`<div className="note">No bookings on record for this property.</div>` : h`<ol className="timeline">
          ${prof.timeline.map(b => h`<li key=${b.id} className=${'tl-row ' + (b.presence || b.state)}>
            <span className="tl-dates">${b.check_in ? L.dateRange(b.check_in, b.check_out) : h`<${Missing}>No dates<//>`}</span>
            <span className="tl-who"><button className="btn-link" onClick=${() => p.setNav({ booking: b.id, pane: 'chat' })}>${b.guest}</button> <span className="mono note">${b.id}</span></span>
            <span className="tl-state">${this.timelineState(b)}</span>
          </li>`)}
        </ol>`}
      </section>

      <section className="psec">
        <h2 className="h3">Open tickets here</h2>
        ${prof.tickets.open.length === 0 ? h`<div className="note">No open tickets.</div>` : h`<ul className="mini-tickets">
          ${prof.tickets.open.map(t => this.ticketLine(t, now))}</ul>`}
        ${prof.tickets.resolved.length > 0 && h`<details className="more"><summary>Recently resolved (${prof.tickets.resolved_total})</summary>
          <ul className="mini-tickets">${prof.tickets.resolved.map(t => this.ticketLine(t, now))}</ul></details>`}
      </section>

      <section className="psec">
        <h2 className="h3">Recent activity</h2>
        ${prof.activity.length === 0 && h`<div className="note">Nothing yet.</div>`}
        ${(showAll ? prof.activity : prof.activity.slice(0, ACTIVITY_SHOWN)).map((a, i) => h`<${HistoryRow} key=${i} time=${L.when(a.at, now)} title=${a.title} text=${a.text} />`)}
        ${!showAll && prof.activity.length > ACTIVITY_SHOWN && h`<button className="btn-link" onClick=${() => this.setState({ allActivity: true })}>Show more</button>`}
      </section>
    </div>`;
  }

  timelineState(b) {
    const map = { arriving: ['info', '◔', 'Arrives today'], in_house: ['ok', '●', 'In stay'], departing: ['warn', '◑', 'Checks out today'],
      upcoming: ['info', '○', L.titleCase(L.relDays(b.days_to_arrival))], past: ['neutral', '✓', 'Past stay'] };
    const m = map[b.presence];
    if (m) return h`<${Tone} tone=${m[0]} glyph=${m[1]}>${m[2]}<//>${b.presence !== 'past' ? h` <span className="note">${b.label}</span>` : ''}`;
    const tone = b.state === 'cancelled' || b.state === 'completed' ? 'neutral' : 'bad';
    return h`<${Tone} tone=${tone} glyph=${tone === 'bad' ? '?' : '–'}>${b.label}<//>`;
  }

  ticketLine(t, now) {
    const tv = L.ticketView(t, now), sev = L.severityMark(t.severity), due = tv.dueText;
    return h`<li key=${t.ref}><button className="mini-ticket-row" onClick=${() => this.props.ctx.openTicket(t.ref)}>
      <span className="mono note">${t.ref}</span>
      <span className="mt-title">${t.summary}</span>
      <span className="mt-meta"><span style=${{ color: sev.color }}><span aria-hidden="true">${sev.glyph}</span> ${sev.label}</span> · ${tv.status}${t.escalated ? ' · ▲ Escalated' : ''} · ${t.operator || 'Unassigned'}</span>
      <span className=${'due ' + due.tone}>${due.text}</span>
    </button></li>`;
  }

  preparation(prof, prep) {
    const now = this.props.ctx.now, rd = prof.readiness;
    const [tone, glyph] = L.READINESS_TONE[rd.key] || ['neutral', '–'];
    const details = L.detailRows(prep.arrival_details);
    return h`<section className="psec">
      <h2 className="h3">Preparing for ${prep.guest}</h2>
      <dl className="prep">
        <div><dt>Readiness</dt><dd><${Tone} tone=${tone} glyph=${glyph}>${rd.label}<//> <span className="note">${rd.text}</span></dd></div>
        <div><dt>Pre-arrival messages</dt><dd>${prep.journey.length ? L.journeyRows(prep.journey, now).map(j => h`<div key=${j.k} className="mark-row">
            <span className="g" style=${{ color: j.color }} aria-hidden="true">${j.glyph}</span><span className="spacer">${j.k}</span><span className="n">${j.note}</span></div>`)
          : h`<${Missing}>None scheduled<//>`}</dd></div>
        <div><dt>Arrival details</dt><dd>${details.length ? details.map(r => `${r.k}: ${r.v}`).join(' · ') : h`<${Missing}>Not shared yet<//>`}</dd></div>
        <div><dt>Caretaker</dt><dd>${prep.caretaker || h`<${Missing}>Not assigned<//>`}</dd></div>
        <div><dt>Guest’s open requests</dt><dd>${prep.requests.length ? prep.requests.map(t => h`<button key=${t.ref} className="btn-link" onClick=${() => this.props.ctx.openTicket(t.ref)}>${t.ref} ${t.summary}</button>`) : h`<span className="note">None</span>`}</dd></div>
      </dl>
    </section>`;
  }

  facilitiesTab(f) {
    const showAll = this.state.allServices;
    const dl = items => h`<dl className="kv">${items.map(x => h`<${Frag} key=${x.label}><dt>${x.label}</dt><dd><${Value} v=${x.value} /></dd><//>`)}</dl>`;
    return h`<div className="stack-lg">
      <div className="fac-grid">
        <section className="psec"><h2 className="h3">Capacity</h2>${dl(f.capacity)}</section>
        <section className="psec"><h2 className="h3">Arrival and departure</h2>${dl(f.stay)}</section>
      </div>
      <section className="psec"><h2 className="h3">Amenities</h2>${dl(f.amenities)}</section>
      <section className="psec">
        <h2 className="h3">Services Gia can arrange</h2>
        ${f.services.length === 0 ? h`<${Missing}>No services on record<//>` : h`<ul className="svc-list">
          ${(showAll ? f.services : f.services.slice(0, SERVICES_SHOWN)).map(x => h`<li key=${x.label}>
            <span className="svc-name">${x.label}</span>
            <span className="note">${[x.price, x.notice && `${x.notice} notice`, x.extra].filter(Boolean).join(' · ') || 'No details on record'}</span>
          </li>`)}</ul>`}
        ${!showAll && f.services.length > SERVICES_SHOWN && h`<button className="btn-link" onClick=${() => this.setState({ allServices: true })}>Show all ${f.services.length} services</button>`}
      </section>
      ${f.unavailable.length > 0 && h`<section className="psec">
        <h2 className="h3">Not available here</h2>
        <ul className="svc-list">${f.unavailable.map(x => h`<li key=${x.label}><span className="svc-name"><span aria-hidden="true">✕ </span>${x.label}</span>
          <span className="note">${x.alternative ? 'Offer instead: ' + x.alternative : 'No alternative on record'}</span></li>`)}</ul>
      </section>`}
      ${f.rules.length > 0 && h`<section className="psec"><h2 className="h3">House rules</h2><ul className="rules">${f.rules.map(r => h`<li key=${r}>${r}</li>`)}</ul></section>`}
      <details className="more"><summary>Directions, nearby and host on record</summary>
        <div className="more-body">
          <p className="body-text">${f.directions || h`<${Missing}>No directions on record<//>`}${f.maps_url && h` <a href=${f.maps_url} target="_blank" rel="noopener">Map ↗</a>`}</p>
          ${f.nearby.length > 0 && h`<ul className="rules">${f.nearby.map(n => h`<li key=${n}>${n}</li>`)}</ul>`}
          <p className="note">Host on record: ${f.host ? `${f.host.name} · ${f.host.phone}` : 'Not recorded'}</p>
        </div>
      </details>
    </div>`;
  }

  teamTab(prof) {
    const p = this.props, ctx = p.ctx, team = prof.team, pr = prof.property;
    const group = (title, people, empty) => h`<section className="psec">
      <h2 className="h3">${title} <span className="note">${people.length}</span></h2>
      ${people.length === 0 ? h`<div className="note">${empty}</div>` : h`<ul className="team-list">${people.map(o => h`<li key=${o.id} className="team-row">
        <div className="team-who">
          <div><span className="strong">${o.name}</span>${o.contact_role && h` <span className="tag-soft">${o.contact_role === 'manager' ? 'Villa manager' : 'Guest contact'}</span>`}</div>
          <div className="note">${o.roles.map(ROLE).join(', ')}${o.phone ? ' · ' + L.phoneLabel(o.phone) : ''}</div>
          ${o.open_elsewhere > 0 && h`<div className="note">${o.open_elsewhere} open at other villas</div>`}
        </div>
        <div className="team-side">
          ${o.assigned ? h`<${Tone} tone="warn" glyph="◆" title=${o.refs_here.join(', ')}>Assigned here · ${o.refs_here.length}<//>` : h`<${Tone} tone="ok" glyph="○">Available<//>`}
          <div className="team-actions">
            <button className="btn small" onClick=${() => ctx.openOperator(o.id)}>Message</button>
            <button className="btn-link" onClick=${() => ctx.openOps({ op: String(o.id) })}>Tasks</button>
          </div>
        </div>
      </li>`)}</ul>`}
    </section>`;
    return h`<div className="stack-lg">
      <div className="team-head">
        <span>Villa manager: <b>${pr.manager ? pr.manager.name : h`<${Missing}>Not assigned<//>`}</b></span>
        <span>Guest contact (caretaker): <b>${pr.caretaker ? pr.caretaker.name : h`<${Missing}>Not assigned<//>`}</b></span>
        <span className="spacer"></span>
        <button className="btn small" onClick=${() => ctx.addOperator(pr.id)}>+ Add operator</button>
        <a className="btn-link" href=${'/admin/villas?q=' + encodeURIComponent(pr.id)} target="_blank" rel="noopener">Manage assignments ↗</a>
      </div>
      ${group('On-site', team.onsite, 'No operators on site right now.')}
      ${group('Off-site', team.offsite, 'No off-site operators for this villa.')}
      <p className="note">“Assigned” means they hold an open ticket here; “Available” means they work this villa but have nothing open here. New tickets go to an on-site operator for that kind of work first.</p>
    </div>`;
  }

  // No guest staying and no confirmed arrival: show what's known instead of an empty chat.
  noConversation(prof) {
    const p = this.props, convos = prof.conversations.list, st = prof.stay;
    return h`<section className="convo convo-none" aria-label="Guest conversation">
      <div className="convo-body">
        <div className="eyebrow">Guest conversation</div>
        <p className="body-text">No guest is staying${st.next ? '' : ' and no confirmed arrival is on record'}, so there’s no current conversation.</p>
        ${st.tentative.length > 0 && h`<p className="note">${st.tentative.length} tentative hold${st.tentative.length > 1 ? 's' : ''} (not confirmed): ${st.tentative.map(t => `${t.guest}, ${L.dateRange(t.check_in, t.check_out)}`).join('; ')}</p>`}
        ${convos.length > 0 && h`<label className="field">Open an earlier or other conversation
          <select value="" onChange=${e => e.target.value && p.setNav({ booking: e.target.value })}>
            <option value="">Choose…</option>
            ${convos.map(c => h`<option key=${c.id} value=${c.id}>${conversationLabel(c)}</option>`)}
          </select>
        </label>`}
      </div>
    </section>`;
  }
}
