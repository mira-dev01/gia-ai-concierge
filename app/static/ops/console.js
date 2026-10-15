// Gia ops console: Lohono's AI-native guest operations.
// Four areas: Overview (what needs a person now), Properties (each villa's stay, readiness, team and guest
// conversation), Operations (the ticket queue) and Workflows (scripted scenarios). Live data comes from the backend
// (live.js), refreshed every few seconds by one sync loop; Properties, conversations, tickets and operators load
// their details when opened. Every action is a real backend call.
// The guided demo scenarios (data.js) stay alongside, tagged "Demo": the concierge journey, the field app's
// photo-evidence flow and the workflow explorer, which have no live counterpart yet.
import * as D from './data.js';
import * as L from './live.js';
import { h, Frag, Pill, LiveTag, DemoChip, PresenceChip, ChatItem, AttentionList, Composer, stickToBottom } from './ui.js';
import { PropertiesWorkspace, EMPTY_QUERY } from './properties.js';
import { OperationsWorkspace, OperatorDrawer, AddOperator, DemoTicketDetail, EMPTY_FILTERS, demoRow } from './operations.js';

const { React, ReactDOM } = window;

const STORAGE_KEY = 'gia-ops-v3';
const SAVED_KEYS = ['view', 'pNav', 'pQuery', 'oSel', 'oFilters', 'cStep', 'fStep', 'cBranch', 'fBranch', 'wf', 'gTab', 'gTicket'];
const VIEWS = ['overview', 'properties', 'operations', 'workflows', 'demo'];
const DEMO_FIELD_TICKET = 'OI-5534';
const POLL_MS = 5000;          // how often live data is refreshed
const AUTO_STEP_MS = 1300;     // pause between the steps a phone action triggers
const PLAY_STEP_MS = 1700;     // pause between steps when the workflow is playing
const MIN_ZOOM = 0.3, MAX_ZOOM = 1.8;
const ALL = 'all';
const VIEW_LABEL = { overview: 'Overview', properties: 'Properties', operations: 'Operations', workflows: 'Workflows', demo: 'Demo guest journey' };
const ATTENTION_SHOWN = 5;     // Overview lists this many items needing attention before "View all"
const ACTIVITY_SHOWN = 6;

const stepsFor = (wf, s) => wf === 'concierge' ? D.conciergeSteps(s.cBranch) : D.fieldSteps(s.fBranch);
const stepKey = wf => wf === 'concierge' ? 'cStep' : 'fStep';
const EMPTY_LIVE = { now: '', bookings: [], tickets: [], handoffs: [], events: [], villas: [], ticket_statuses: [], operators: [], operator_roles: [], attention: [] };
const EMPTY_FORM = { name: '', phone: '', role: 'caretaker', villa_ids: [], presence: 'onsite' };
const EMPTY_NAV = { villa: null, booking: null, tab: 'overview', pane: 'profile' };
const TOAST_MS = 8000, URGENT_TOAST_MS = 15000;
// Live activity badges: [label, text colour, background].
const EVENT_KINDS = {
  ticket: ['Ticket', '#3E5263', '#E7ECEF'], handoff: ['Person', '#A8382A', '#F6DCD8'], resolved: ['Resolved', '#2F4A38', '#E6EEE7'],
  delayed: ['Late', '#A8382A', '#F6DCD8'], flag: ['Flag', '#A8382A', '#F6DCD8'], operator: ['Operator', '#6E4532', '#F3E7DF'],
  journey: ['Journey', '#8A5A44', '#F3E7DF'], profile: ['Guest', '#2F4A38', '#E6EEE7'], booking: ['Booking', '#3E5263', '#E7ECEF']
};

class OpsConsole extends React.Component {
  canvasRef = React.createRef();
  chatRef = React.createRef();
  chatScroll = {};
  timers = [];
  acted = new Map();  // ticket ref -> when this console changed it, so its own change doesn't pop up as news
  state = this.initialState(true);

  initialState(useSaved) {
    const d = {
      view: 'overview', cStep: 8, fStep: 6, cBranch: 'yes', fBranch: 'accept', gTab: 'tickets', gTicket: null,
      pNav: EMPTY_NAV, pQuery: EMPTY_QUERY, oSel: null, oFilters: EMPTY_FILTERS, opDrawer: null,
      ovVilla: ALL, ovAll: false, ovActivity: false,
      wf: 'concierge', sel: null, z: 0.75, px: 30, py: 30, playing: false, cap: {},
      demoTakeover: false, demoOps: [], draft: '', adding: false, opForm: EMPTY_FORM, eventToasts: [],
      moved: { concierge: false, field: false },
      pos: { concierge: D.defaultPositions('concierge'), field: D.defaultPositions('field') },
      live: null, liveError: null, lastOk: null, tick: 0, pending: {}, notice: null, back: null
    };
    if (useSaved) {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (saved) SAVED_KEYS.forEach(k => { if (saved[k] !== undefined && saved[k] !== null) d[k] = saved[k]; });
        if (!VIEWS.includes(d.view)) d.view = 'overview';
        d.pNav = { ...EMPTY_NAV, ...d.pNav };
        d.pQuery = { ...EMPTY_QUERY, ...d.pQuery };
        d.oFilters = { ...EMPTY_FILTERS, ...d.oFilters };
      } catch (e) { /* storage unavailable: start fresh */ }
    }
    return d;
  }

  componentDidMount() {
    this.onMove = e => this.pointerMove(e);
    this.onUp = () => this.pointerUp();
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    this.refresh();
    this.poll = setInterval(() => { if (!document.hidden) this.refresh(); }, POLL_MS);
    this.onVisible = () => { if (!document.hidden) this.refresh(); };
    document.addEventListener('visibilitychange', this.onVisible);
    this.needFit = true;
    this.afterRender();
  }

  componentWillUnmount() {
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    document.removeEventListener('visibilitychange', this.onVisible);
    if (this.wheelEl) this.wheelEl.removeEventListener('wheel', this.onWheel);
    clearInterval(this.poll);
    clearTimeout(this.noticeTimer);
    (this.toastTimers || []).forEach(t => clearTimeout(t));
    this.clearTimers();
    this.stopPlay();
  }

  componentDidUpdate() { this.afterRender(); }

  afterRender() {
    const el = this.canvasRef.current;
    if (el && el !== this.wheelEl) {
      // React's onWheel is passive, so zoom needs a native listener that can preventDefault.
      if (this.wheelEl) this.wheelEl.removeEventListener('wheel', this.onWheel);
      el.addEventListener('wheel', this.onWheel, { passive: false });
      this.wheelEl = el;
      this.needFit = true;
    }
    if (el && this.needFit) { this.needFit = false; setTimeout(() => this.fit(), 0); }
    if (this.chatRef.current) stickToBottom(this.chatRef.current, 'demo:' + this.chatRef.current.childElementCount, this.chatScroll);

    const s = this.state;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(SAVED_KEYS.map(k => [k, s[k]])))); } catch (e) { /* not persisted */ }
  }

  // ---------- live data and actions ----------

  // The one sync loop: the portfolio snapshot every few seconds. Each successful sync bumps `tick`, and the open
  // property, conversation, ticket or operator reloads its own details on that tick (nothing else polls).
  refresh = async () => {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const live = await L.api('GET', '/state');
      this.announce(live.events);
      this.setState(s => ({ live, liveError: null, lastOk: live.now, tick: s.tick + 1 }));
    } catch (e) {
      this.setState({ liveError: e.message });
    } finally {
      this.refreshing = false;
    }
  };

  // New toast-worthy events pop up for a few seconds. What was already there when the page opened isn't news,
  // and neither is a change this console just made (it has its own confirmation).
  announce(events) {
    const newest = events.reduce((m, e) => Math.max(m, e.id), 0);
    if (this.lastEventId === undefined) { this.lastEventId = newest; return; }
    if (newest <= this.lastEventId) return;
    const since = Date.now() - 20000;
    const fresh = events.filter(e => e.id > this.lastEventId && e.toast && !(e.ticket && this.acted.get(e.ticket) > since)).reverse();
    this.lastEventId = newest;
    if (!fresh.length) return;
    this.setState(s => ({ eventToasts: s.eventToasts.concat(fresh).slice(-4) }));
    this.toastTimers = (this.toastTimers || []).concat(fresh.map(e => setTimeout(() => this.dismissEvent(e.id), e.urgent ? URGENT_TOAST_MS : TOAST_MS)));
  }

  dismissEvent(id) { this.setState(s => ({ eventToasts: s.eventToasts.filter(e => e.id !== id) })); }

  notify(text, tone = 'ok') {
    clearTimeout(this.noticeTimer);
    this.setState({ notice: { text, tone } });
    this.noticeTimer = setTimeout(() => this.setState({ notice: null }), tone === 'error' ? 9000 : 4500);
  }

  // Runs one backend action (never twice at once for the same key), confirms the outcome, then syncs so every
  // screen shows it. Returns { ok, result } or { ok: false, error }; quiet leaves showing a failure to the caller.
  async act(key, request, success, opts = {}) {
    if (this.state.pending[key]) return { ok: false, error: 'Already in progress' };
    this.setState(s => ({ pending: { ...s.pending, [key]: true } }));
    try {
      const result = await request();
      if (success) this.notify(success(result));
      await this.refresh();
      return { ok: true, result };
    } catch (e) {
      if (!opts.quiet) this.notify(e.message, 'error');
      return { ok: false, error: e.message };
    } finally {
      this.setState(s => { const pending = { ...s.pending }; delete pending[key]; return { pending }; });
    }
  }

  async addOperator() {
    const f = this.state.opForm;
    const r = await this.act('addop', () => L.api('POST', '/operators', f),
      () => `${f.name.trim()} added as ${L.ROLE_LABEL[f.role].toLowerCase()} (${f.presence}).`);
    if (r.ok) this.setState({ adding: false, opForm: EMPTY_FORM });
  }

  // ---------- moving between areas ----------

  // Going from one area to another remembers where you came from, so you can go back; each area keeps its own
  // filters, selection and scroll while you're away.
  go(view, patch) {
    this.stopPlay();
    if (view === 'workflows') this.needFit = true;
    this.setState(st => ({ view, back: view !== st.view ? st.view : st.back, ...(patch ? patch(st) : {}) }));
  }

  navigator() {
    const live = this.state.live || EMPTY_LIVE;
    const openProperty = (villa, extra = {}) => this.go('properties', st => ({
      pNav: { ...st.pNav, villa, booking: extra.booking || null, pane: extra.pane || 'profile', tab: extra.tab || st.pNav.tab }
    }));
    return {
      openProperty,
      openConversation: bookingId => {
        const b = live.bookings.find(x => x.id === bookingId);
        if (!b) { this.notify(`Booking ${bookingId} isn’t in the current data.`, 'error'); return; }
        openProperty(b.villa_id, { booking: bookingId, pane: 'chat' });
      },
      // Open a ticket in Operations; if the current filters would hide it, show the view it belongs to instead.
      openTicket: ref => this.go('operations', st => {
        const t = live.tickets.find(x => x.ref === ref);
        const visible = !t || (st.oFilters.view === 'all' || (st.oFilters.view === 'resolved') === (t.status === 'closed'))
          && !st.oFilters.q && !st.oFilters.villa && !st.oFilters.priority && !st.oFilters.op && !st.oFilters.status && !st.oFilters.cat
          && (st.oFilters.view !== 'overdue' || t.overdue) && (st.oFilters.view !== 'unassigned' || !t.operator_id) && (st.oFilters.view !== 'escalated' || t.escalated);
        return { oSel: ref, oFilters: visible ? st.oFilters : { ...EMPTY_FILTERS, view: t.status === 'closed' ? 'resolved' : 'open' } };
      }),
      openOps: patch => this.go('operations', () => ({ oFilters: { ...EMPTY_FILTERS, ...patch } })),
      openOperator: id => this.setState({ opDrawer: id }),
      addOperator: villaId => this.setState({ adding: true, opForm: { ...EMPTY_FORM, villa_ids: villaId ? [villaId] : [] } })
    };
  }

  // ---------- canvas: zoom, pan, drag ----------

  zoomAround(mx, my, factor) {
    const { z, px, py } = this.state;
    const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
    this.setState({ z: nz, px: mx - (mx - px) * nz / z, py: my - (my - py) * nz / z });
  }

  onWheel = e => {
    e.preventDefault();
    const r = this.wheelEl.getBoundingClientRect();
    this.zoomAround(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  };

  zoomBy(factor) {
    const el = this.canvasRef.current;
    if (el) this.zoomAround(el.clientWidth / 2, el.clientHeight / 2, factor);
  }

  fit() {
    const el = this.canvasRef.current;
    if (!el) return;
    const P = Object.values(this.state.pos[this.state.wf]);
    const minX = Math.min(...P.map(p => p.x)), maxX = Math.max(...P.map(p => p.x)) + D.NODE_W;
    const minY = Math.min(...P.map(p => p.y)), maxY = Math.max(...P.map(p => p.y)) + D.NODE_H;
    const cw = el.clientWidth, ch = el.clientHeight;
    const z = Math.min(1.05, Math.max(MIN_ZOOM, Math.min((cw - 60) / (maxX - minX), (ch - 90) / (maxY - minY))));
    this.setState({ z, px: (cw - (maxX - minX) * z) / 2 - minX * z, py: (ch - (maxY - minY) * z) / 2 - minY * z + 16 });
  }

  pointerMove(e) {
    if (this.drag) {
      const d = this.drag, z = this.state.z;
      const dx = (e.clientX - d.sx) / z, dy = (e.clientY - d.sy) / z;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (!d.moved) return;
      const wf = this.state.wf;
      this.setState(s => ({
        pos: { ...s.pos, [wf]: { ...s.pos[wf], [d.id]: { x: Math.round(d.ox + dx), y: Math.round(d.oy + dy) } } },
        moved: { ...s.moved, [wf]: true }
      }));
    } else if (this.pan) {
      const p = this.pan;
      this.setState({ px: p.ox + e.clientX - p.sx, py: p.oy + e.clientY - p.sy });
    }
  }

  pointerUp() {
    if (this.drag) {
      const d = this.drag;
      this.drag = null;
      // A press without movement is a click: select the node.
      if (!d.moved) this.setState({ sel: d.id }); else this.forceUpdate();
    }
    if (this.pan) { this.pan = null; this.forceUpdate(); }
  }

  // ---------- demo scenario stepping ----------

  clearTimers() { this.timers.forEach(t => clearTimeout(t)); this.timers = []; }

  // Steps through several values in turn, as if the system were responding live.
  runSequence(key, values) {
    this.clearTimers();
    values.forEach((v, i) => this.timers.push(setTimeout(() => this.setState({ [key]: v, sel: null }), i * AUTO_STEP_MS)));
  }

  stopPlay() {
    if (this.playTimer) { clearInterval(this.playTimer); this.playTimer = null; }
    if (this.state && this.state.playing) this.setState({ playing: false });
  }

  startPlay() {
    this.stopPlay();
    this.clearTimers();
    const key = stepKey(this.state.wf);
    const atEnd = this.state[key] >= stepsFor(this.state.wf, this.state).length - 1;
    this.setState({ playing: true, sel: null, ...(atEnd ? { [key]: 0 } : {}) });
    this.playTimer = setInterval(() => {
      const s = this.state, key = stepKey(s.wf);
      if (s[key] >= stepsFor(s.wf, s).length - 1) { this.stopPlay(); return; }
      this.setState({ [key]: s[key] + 1, sel: null });
    }, PLAY_STEP_MS);
  }

  setStep(wf, i) {
    this.clearTimers();
    const v = Math.max(0, Math.min(stepsFor(wf, this.state).length - 1, i));
    const o = { [stepKey(wf)]: v, sel: null };
    if (wf === 'field' && v <= D.F.CLAIMED) o.cap = {};  // back before the photos: clear the phone's captures
    this.setState(o);
  }

  resetDemo() {
    this.clearTimers();
    this.stopPlay();
    const d = this.initialState(false);
    const reset = ['cStep', 'fStep', 'cBranch', 'fBranch', 'cap', 'demoTakeover', 'demoOps', 'draft', 'gTab', 'gTicket', 'sel', 'moved', 'pos', 'z', 'px', 'py', 'playing'];
    const next = {};
    reset.forEach(k => { next[k] = d[k]; });
    this.needFit = true;
    this.setState(next);
    this.notify('Demo scenarios reset. Live data is unchanged.');
  }

  // ---------- view model ----------

  viewModel() {
    const s = this.state;
    const live = s.live || EMPTY_LIVE, now = live.now, loaded = !!s.live;
    const nav = this.navigator();
    const navTo = view => { this.stopPlay(); if (view === 'workflows') this.needFit = true; this.setState({ view, back: null }); };
    const sync = { loaded, error: s.liveError, at: now ? now.slice(11, 19) : '', lastOk: s.lastOk ? L.whenFull(s.lastOk, s.lastOk) : '', stale: loaded && !!s.liveError };
    const ctx = {
      ...nav, now, tick: s.tick, sync, stale: sync.stale, pending: s.pending,
      act: (key, request, success, opts) => this.act(key, request, success, opts),
      notify: (text, tone) => this.notify(text, tone),
      markActed: ref => this.acted.set(ref, Date.now())
    };

    // ---- demo scenarios ----
    const cS = D.conciergeSteps(s.cBranch), fS = D.fieldSteps(s.fBranch);
    const cCur = Math.min(s.cStep, cS.length - 1), fCur = Math.min(s.fStep, fS.length - 1);
    const demoTickets = D.scenarioTickets(cS, cCur, fS, fCur);
    const scenarioNav = wf => {
      const steps = wf === 'concierge' ? cS : fS, cur = wf === 'concierge' ? cCur : fCur;
      return { no: cur + 1, total: steps.length, title: steps[cur].title, prev: () => this.setStep(wf, cur - 1), next: () => this.setStep(wf, cur + 1), flow: () => this.go('workflows', () => ({ wf, sel: null })) };
    };
    const decorated = demoTickets.map(t => D.decorateTicket(t));
    const demoOps = {
      rows: decorated.map(demoRow),
      detail: id => {
        const t = decorated.find(x => x.id === id);
        return t ? DemoTicketDetail(t, scenarioNav('field'), t.id === DEMO_FIELD_TICKET ? this.demoPhone(fS, fCur) : null) : null;
      }
    };

    // ---- what needs a person: decided by the backend, shared with Properties and the badges ----
    const attention = live.attention.map(a => ({
      ...a, go: a.kind === 'ticket' ? () => nav.openTicket(a.ref)
        : a.kind === 'booking' ? () => nav.openProperty(a.villa_id)
        : () => nav.openConversation(a.booking_id)
    }));
    const waitingHandoffs = live.handoffs.filter(x => x.status === 'waiting');
    const ticketAlerts = attention.filter(a => a.kind === 'ticket').length;
    const nav4 = [['overview', 'Overview'], ['properties', 'Properties'], ['operations', 'Operations'], ['workflows', 'Workflows']].map(([id, label]) => ({
      id, label, on: s.view === id || (id === 'workflows' && s.view === 'demo'), diamond: id === 'workflows',
      badge: id === 'properties' ? waitingHandoffs.length : id === 'operations' ? ticketAlerts : 0,
      badgeLabel: id === 'properties' ? 'guests waiting for a person' : 'tickets needing attention',
      go: () => navTo(id)
    }));

    // ---- overview: what needs a person first, then who's here, then what happened ----
    const inVilla = id => s.ovVilla === ALL || id === s.ovVilla;
    const bookings = L.sortBookings(live.bookings);
    const ovAttention = attention.filter(a => inVilla(a.villa_id));
    const inStay = bookings.filter(b => b.stage === 'In stay' && inVilla(b.villa_id));
    const open = live.tickets.filter(t => t.status !== 'closed' && inVilla(t.villa_id));
    const late = open.filter(t => t.overdue);
    const openCount = id => live.tickets.filter(t => t.booking_id === id && t.status !== 'closed').length;
    const villaFilter = s.ovVilla === ALL ? '' : s.ovVilla;
    const ov = {
      date: now ? L.longDate(now) : '', loaded,
      villa: { value: s.ovVilla, options: [[ALL, 'All properties']].concat(live.villas.map(v => [v.id, v.name])), onChange: e => this.setState({ ovVilla: e.target.value, ovAll: false }) },
      metrics: [
        { key: 'attn', label: 'need attention', value: ovAttention.length, tone: ovAttention.length ? 'red' : '', go: () => this.setState({ ovAll: true }) },
        { key: 'late', label: 'overdue', value: late.length, tone: late.length ? 'red' : '', go: () => nav.openOps({ view: 'overdue', villa: villaFilter }) },
        { key: 'open', label: 'open tickets', value: open.length, go: () => nav.openOps({ view: 'open', villa: villaFilter }) },
        { key: 'stay', label: 'guests in stay', value: inStay.length, go: () => this.go('properties', st => ({ pNav: { ...st.pNav, villa: null }, pQuery: { ...EMPTY_QUERY, sort: st.pQuery.sort } })) }
      ].map(m => ({ ...m, value: loaded ? m.value : '–' })),
      attention: s.ovAll ? ovAttention : ovAttention.slice(0, ATTENTION_SHOWN), now,
      more: !s.ovAll && ovAttention.length > ATTENTION_SHOWN ? { text: `View all ${ovAttention.length}`, go: () => this.setState({ ovAll: true }) } : null,
      conversations: bookings.filter(b => b.in_conversation && inVilla(b.villa_id)).map(b => ({
        key: b.id, initials: L.initials(b.name), title: b.name, text: `${b.villa} · ${b.takeover ? 'Ops is replying' : 'Gia is replying'} · ${L.ago(b.last_inbound_at, now)}`,
        go: () => nav.openConversation(b.id)
      })),
      stays: bookings.filter(b => (b.stage === 'In stay' || b.stage === 'Pre-arrival') && inVilla(b.villa_id)).map(b => ({
        key: b.id, name: b.name, initials: L.initials(b.name), sub: `${b.villa} · ${L.dateRange(b.check_in, b.check_out)}`, stage: b.stage,
        open: openCount(b.id), go: () => nav.openConversation(b.id)
      })),
      operators: live.operators.filter(op => s.ovVilla === ALL || op.roles.some(r => r.villa_id === s.ovVilla))
        .slice().sort((a, b) => b.open - a.open || a.name.localeCompare(b.name)).map(op => ({
          key: op.id, name: op.name, initials: L.initials(op.name), presence: op.presence, open: op.open,
          go: () => nav.openOperator(op.id)
        })),
      activity: (() => {
        const villaOf = Object.fromEntries(live.tickets.map(t => [t.ref, t.villa_id]));
        const bookingVilla = Object.fromEntries(live.bookings.map(b => [b.id, b.villa_id]));
        const list = live.events.filter(e => s.ovVilla === ALL || (e.ticket ? villaOf[e.ticket] : bookingVilla[e.booking_id]) === s.ovVilla);
        return { items: (s.ovActivity ? list.slice(0, 30) : list.slice(0, ACTIVITY_SHOWN)).map(e => this.eventView(e, now, nav)),
          more: !s.ovActivity && list.length > ACTIVITY_SHOWN ? () => this.setState({ ovActivity: true }) : null };
      })(),
      addOperator: () => nav.addOperator(null)
    };

    const { wv, pd } = this.workflowModel({ cS, fS, cCur, fCur, nav });

    return {
      view: s.view, nav: nav4, sync, ctx, notice: s.notice, dismissNotice: () => this.setState({ notice: null }),
      back: s.back && s.back !== s.view ? { label: VIEW_LABEL[s.back], go: () => { if (s.back === 'workflows') this.needFit = true; this.setState({ view: s.back, back: null }); } } : null,
      toasts: s.eventToasts.map(e => ({ ...this.eventView(e, now, nav), dismiss: () => this.dismissEvent(e.id) })),
      resetDemo: () => this.resetDemo(), openDemoJourney: () => this.go('demo'),
      ov, wv, pd, live, demoOps,
      gj: s.view === 'demo' ? this.demoJourney({ cS, cCur, demoTickets, scenarioNav }) : null,
      properties: {
        nav: s.pNav, query: s.pQuery,
        setNav: patch => this.setState(st => ({ pNav: { ...st.pNav, ...patch } })),
        setQuery: patch => this.setState(st => ({ pQuery: { ...st.pQuery, ...patch } }))
      },
      operations: {
        sel: s.oSel, filters: s.oFilters,
        setSel: ref => this.setState({ oSel: ref }),
        setFilters: patch => this.setState(st => ({ oFilters: { ...st.oFilters, ...patch } }))
      },
      add: this.addOperatorModel(live),
      opDrawer: s.opDrawer, closeDrawer: () => this.setState({ opDrawer: null })
    };
  }

  eventView(e, now, nav) {
    const k = EVENT_KINDS[e.kind] || EVENT_KINDS.ticket;
    const target = e.kind === 'operator' && e.operator_id ? () => nav.openOperator(e.operator_id)
      : e.ticket ? () => nav.openTicket(e.ticket)
      : e.booking_id ? () => nav.openConversation(e.booking_id) : () => this.go('overview');
    return { key: e.id, time: L.when(e.at, now), label: k[0], fg: k[1], bg: k[2], urgent: e.urgent, title: e.title, text: e.text, go: target };
  }

  addOperatorModel(live) {
    const s = this.state, f = s.opForm;
    const villaName = id => (live.villas.find(v => v.id === id) || {}).name || id;
    const replaced = f.villa_ids.map(v => {
      const holder = live.operators.find(o => o.roles.some(r => r.villa_id === v && r.role === f.role));
      return holder ? `${holder.name} at ${villaName(v)}` : null;
    }).filter(Boolean);
    const set = (k, v) => this.setState(st => ({ opForm: { ...st.opForm, [k]: v } }));
    return {
      open: s.adding, close: () => this.setState({ adding: false }),
      form: f, set, villas: live.villas, roles: live.operator_roles.length ? live.operator_roles : Object.keys(L.ROLE_LABEL),
      toggleVilla: id => set('villa_ids', f.villa_ids.includes(id) ? f.villa_ids.filter(x => x !== id) : f.villa_ids.concat([id])),
      replacedText: replaced.length ? `Replaces the current ${L.ROLE_LABEL[f.role].toLowerCase()}: ${replaced.join(', ')}.` : '',
      canSubmit: f.name.trim() && f.phone.replace(/\D/g, '').length >= 10 && f.villa_ids.length,
      submit: () => this.addOperator(), pending: !!s.pending.addop
    };
  }

  // The field app's photo-evidence walkthrough for the demo ticket OI-5534.
  demoPhone(fS, fCur) {
    const s = this.state;
    let lastEv = null;
    fS.slice(0, fCur + 1).forEach(x => { if (x.evidence) lastEv = x.evidence; });
    const slot = (key, label) => {
      const on = !!s.cap[key];
      return {
        key, label, on, icon: on ? '' : '+',
        thumb: on ? 'repeating-linear-gradient(135deg,#E3D6CB 0 6px,#D9CABD 6px 12px)' : '#F5F0E8',
        border: `1px ${on ? 'solid' : 'dashed'} ${on ? '#53735E' : '#C9BBAE'}`,
        tap: () => this.setState(st => ({ cap: { ...st.cap, [key]: !st.cap[key] } }))
      };
    };
    const allCaptured = ['c1', 'c2', 'c3', 'c4'].every(k => s.cap['a' + k]);
    const rejected = lastEv && lastEv.result === 'Rejected' ? lastEv.items.filter(x => !x.ok) : [];
    const allRetaken = rejected.length > 0 && rejected.every(x => s.cap['r' + x.k]);
    const escalating = s.fBranch === 'escalate';
    return {
      idle: fCur < D.F.ASSIGNED,
      showTask: fCur >= D.F.ASSIGNED,
      assigned: fCur === D.F.ASSIGNED || fCur === D.F.ETA,
      finish: () => this.setStep('field', D.F.CLAIMED),
      capture: fCur === D.F.CLAIMED,
      slots: ['c1', 'c2', 'c3', 'c4'].map(k => slot('a' + k, D.CHECKLIST[k])),
      canSubmit: allCaptured,
      submit: () => { if (allCaptured) this.runSequence('fStep', [D.F.SUBMITTED, D.F.REJECTED, D.F.REWORK]); },
      checking: fCur === D.F.SUBMITTED || fCur === D.F.RESUBMITTED,
      rework: fCur === D.F.REJECTED || fCur === D.F.REWORK || (escalating && fCur === D.F.VERDICT),
      reworkTitle: fCur === D.F.VERDICT ? 'Still not proven — escalating' : rejected.length + ' photos need retaking',
      reasons: rejected.map(x => ({ label: x.label, why: x.why })),
      canRetake: fCur === D.F.REWORK,
      retake: rejected.map(x => slot('r' + x.k, x.label)),
      canResubmit: allRetaken,
      resubmit: () => { if (allRetaken) this.runSequence('fStep', [D.F.RESUBMITTED, D.F.VERDICT]); },
      accepted: !escalating && fCur >= D.F.VERDICT,
      acceptedText: fCur >= D.F.CLOSED ? 'Ticket closed. Thank you, Santosh.' : 'Closing the ticket…',
      escalated: escalating && fCur >= D.F.CLOSED
    };
  }

  // The scripted concierge journey (Ananya Mehra at Villa Serena), reached from Workflows. Not live data.
  demoJourney({ cS, cCur, demoTickets, scenarioNav }) {
    const s = this.state;
    const chat = [];
    let lastDay = null;
    const chipGo = tid => () => this.setState({ gTab: 'tickets', gTicket: tid });
    cS.slice(0, cCur + 1).forEach(x => {
      if (!x.msgs && !x.chip) return;
      if (x.d !== lastDay) { chat.push({ kind: 'date', text: x.d }); lastDay = x.d; }
      x.msgs && x.msgs.forEach(([who, text]) => chat.push({ kind: who, text, time: x.t }));
      if (x.chip) chat.push({ kind: 'chip', text: x.chip, time: x.t, go: chipGo('OI-5521') });
    });
    s.demoOps.forEach(text => chat.push({ kind: 'ops', text }));
    // Her preferences come from the scenario; the latest step's are highlighted as new.
    const prefs = [].concat(...cS.slice(0, cCur + 1).map(x => (x.prefs || []).map(p => ({ p, fresh: x === cS[cCur] }))));
    const bT = demoTickets.filter(t => t.booking === 'demo');
    const gSel = bT.find(t => t.id === s.gTicket) || bT[0];
    const d = gSel ? D.decorateTicket(gSel) : null;
    const demoB = D.demoBooking(cCur);
    const sendDemo = () => { const text = s.draft.trim(); if (text) this.setState(st => ({ draft: '', demoOps: st.demoOps.concat([text]) })); };
    return {
      b: { name: demoB.name, initials: L.initials(demoB.name), stage: demoB.stage, sub: `${demoB.villa} · ${demoB.dates} · ${demoB.phone}` },
      chat, sc: scenarioNav('concierge'),
      takeover: s.demoTakeover, toggleTakeover: () => this.setState(st => ({ demoTakeover: !st.demoTakeover })),
      draft: s.draft, onDraft: draft => this.setState({ draft }), send: sendDemo,
      tab: s.gTab,
      tabs: [['profile', 'Profile'], ['tickets', 'Tickets · ' + bT.length], ['activity', 'Activity']].map(([id, label]) => ({ id, label, on: s.gTab === id, go: () => this.setState({ gTab: id }) })),
      profile: {
        villa: { name: D.DEMO_VILLA.name, loc: D.DEMO_VILLA.loc },
        rows: [{ k: 'Booking', v: demoB.id, mono: true }, { k: 'Stay', v: demoB.dates }, { k: 'Party', v: demoB.party }, { k: 'Arrival', v: demoB.arrival }],
        prefs: prefs.map(x => ({ label: x.p, bg: x.fresh ? '#E6EEE7' : '#F5F0E8', border: x.fresh ? '#C9D9CC' : '#EDE4DC' })),
        caps: D.capRows(D.DEMO_VILLA.caps)
      },
      tickets: bT.map(t => ({ id: t.id, cat: t.cat, title: t.title, status: t.status, pill: D.statusPill(t.status), on: gSel && t.id === gSel.id, go: () => this.setState({ gTicket: t.id }) })),
      t: d ? { title: d.title, status: d.status, pill: d.pill, rows: [['Operator', d.owner], ['Priority', d.sev]] } : null,
      openField: () => gSel && this.go('operations', () => ({ oSel: gSel.id })),
      activity: cS.slice(0, cCur + 1).map(x => ({ who: D.WHO[x.who], title: x.title, time: x.d + ', ' + x.t, text: x.event || x.decision || (x.msgs ? x.msgs[x.msgs.length - 1][1] : '') })).reverse()
    };
  }

  workflowModel({ cS, fS, cCur, fCur, nav }) {
    const s = this.state;
    const wf = s.wf, g = D.GRAPHS[wf], steps = wf === 'concierge' ? cS : fS, cur = wf === 'concierge' ? cCur : fCur, P = s.pos[wf];
    const onPath = new Set(steps.map(x => x.node));
    const lastVisit = {};
    steps.slice(0, cur + 1).forEach((x, i) => { lastVisit[x.node] = i; });
    const active = steps[cur].node;
    const traversed = new Set();
    for (let i = 1; i <= cur; i++) traversed.add(steps[i - 1].node + '>' + steps[i].node);
    const lastEdge = cur > 0 ? steps[cur - 1].node + '>' + steps[cur].node : null;
    const selId = s.sel || active;
    const nodes = g.nodes.map(n => {
      const tm = D.TM[n.type], p = P[n.id], visited = lastVisit[n.id] !== undefined, isActive = n.id === active, off = !onPath.has(n.id);
      const failed = visited && steps[lastVisit[n.id]].state === 'failed';
      const sh = D.SHAPES[tm.shape];
      return {
        id: n.id, x: p.x, y: p.y, title: n.title, sub: n.sub, typeLabel: tm.label, mw: sh[0], mr: sh[1], mrot: sh[2],
        mc: tm.c,  // the type marker keeps its colour so the legend still reads
        border: isActive ? '2px solid #C2412E' : failed ? '1px solid #E9B7B0' : off ? '1px dashed #D9CCC1' : '1px solid #E8DDD4',
        shadow: isActive ? '0 0 0 5px rgba(185,56,50,.12), 0 10px 24px rgba(41,39,37,.10)' : '0 1px 2px rgba(41,39,37,.05)',
        opacity: 1,  // dimming with opacity fails contrast; a neutral header and dashed border de-emphasise instead
        tc: off || !visited ? '#6A625C' : tm.c, tbg: off || !visited ? '#F1EBE6' : tm.bg,
        outline: n.id === selId && !isActive ? '2px solid #1A1714' : undefined,
        dot: failed ? '✕' : isActive ? '●' : visited ? '✓' : '', dotC: failed || isActive ? '#C2412E' : '#53735E',
        aria: n.title + ' — ' + (isActive ? 'current step' : visited ? 'completed' : off ? 'other branch' : 'upcoming'),
        onDown: e => { e.stopPropagation(); this.stopPlay(); this.drag = { id: n.id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false }; },
        onKey: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.setState({ sel: n.id }); } }
      };
    });
    const labels = [];
    const edges = g.edges.map(([a, b, label], i) => {
      const geo = D.edgeGeometry(P[a], P[b]), key = a + '>' + b, off = !onPath.has(a) || !onPath.has(b), trav = traversed.has(key), last = key === lastEdge;
      if (label) labels.push({ key: i, x: geo.mx, y: geo.my, text: label, fg: last || trav ? '#1A1714' : '#6A625C', border: last ? '#C2412E' : '#E0D5CB' });
      return { key: i, d: geo.d, stroke: last ? '#C2412E' : trav ? '#7A716B' : off ? '#E0D5CB' : '#CDBFB3', width: last ? 2.4 : trav ? 1.8 : 1.4, dash: off ? '5 5' : undefined, marker: `url(#gm-${last ? 'r' : trav ? 'd' : 'l'})` };
    });

    // Side panel: the selected node (or the current step), and what happened there in this run.
    const sn = g.nodes.find(n => n.id === selId), li = lastVisit[selId], stp = li !== undefined ? steps[li] : null, tm = D.TM[sn.type];
    const selActive = selId === active, offSel = !onPath.has(selId);
    const failedSel = stp && stp.state === 'failed';
    const statusText = selActive ? (failedSel ? 'Current · rejected' : 'Current step') : stp ? (failedSel ? 'Rejected' : 'Completed') : offSel ? 'Other branch' : 'Upcoming';
    const statusColors = selActive ? ['#F9E6DF', '#A8382A'] : stp ? (failedSel ? ['#F6DCD8', '#A8382A'] : ['#E6EEE7', '#2F4A38']) : ['#F1EBE6', '#6E6762'];
    const autColors = /Human|approval/.test(sn.autonomy) ? ['#1A1714', '#FFFFFF'] : /Autonomous|Gated/.test(sn.autonomy) ? ['#F9E6DF', '#A8382A'] : ['#E7ECEF', '#3E5263'];
    const tBase = D.SCENARIO_TICKETS[wf];
    const snap = stp ? D.deriveTicket(tBase, steps, li) : null;
    const otherBranch = wf === 'concierge' ? (s.cBranch === 'yes' ? 'no' : 'yes') : (s.fBranch === 'accept' ? 'escalate' : 'accept');
    const otherSteps = wf === 'concierge' ? D.conciergeSteps(otherBranch) : D.fieldSteps(otherBranch);
    const firstIdx = steps.findIndex(x => x.node === selId);
    const evColors = stp && stp.evidence ? D.EVIDENCE_RESULT[stp.evidence.result] : null;
    const pd = {
      title: sn.title, sub: sn.sub, typeLabel: tm.label, tc: tm.c, tbg: tm.bg, actor: sn.actor, system: sn.system,
      autonomy: sn.autonomy, autBg: autColors[0], autFg: autColors[1], inputs: sn.inputs, outputs: sn.outputs,
      status: statusText, stBg: statusColors[0], stFg: statusColors[1],
      pinned: !!s.sel && s.sel !== active, unpin: () => this.setState({ sel: null }),
      stp,
      // Where people come in stays visible, never tucked into details.
      needsPerson: sn.type === 'human' || /Human|approval/.test(sn.autonomy),
      next: stp ? (steps[li + 1] ? steps[li + 1].title : 'End of this scenario') : null,
      details: [['Actor', sn.actor], ['System', sn.system], ['Autonomy', sn.autonomy], ['Inputs', sn.inputs.join(', ')],
        ['Outputs', sn.outputs.join(', ')], ['When', stp ? `${stp.d}, ${stp.t}` : 'Not reached in this run']],
      unreachedText: offSel ? 'This step belongs to the other decision branch. Switch paths to see what happens there.' : 'This step hasn’t happened yet in the scenario.',
      canJump: !stp && !offSel && firstIdx >= 0, jump: () => this.setStep(wf, firstIdx),
      canSwitch: offSel,
      switchBranch: () => {
        const i = otherSteps.findIndex(x => x.node === selId);
        this.setState(wf === 'concierge' ? { cBranch: otherBranch, cStep: i, sel: null } : { fBranch: otherBranch, fStep: i, sel: null, cap: {} });
      },
      msgs: (stp && stp.msgs || []).map(([who, text]) => who === 'gia'
        ? { align: 'flex-end', bg: '#F9E6DF', border: '#F0D7CC', who: 'Gia', whoC: '#A8382A', text }
        : { align: 'flex-start', bg: '#FFFFFF', border: '#EDE4DC', who: 'Guest', whoC: '#6E4532', text }),
      caps: D.capRows(D.DEMO_VILLA.caps),
      ticket: snap ? { id: snap.id, title: snap.title, owner: snap.owner, status: snap.status, pill: D.statusPill(snap.status) } : null,
      evidence: stp && stp.evidence ? {
        n: stp.evidence.n, result: stp.evidence.result, bg: evColors[0], fg: evColors[1],
        items: stp.evidence.items.map(it => {
          const chk = stp.evidence.result === 'Checking';
          return { label: it.label, glyph: chk ? '…' : it.ok ? '✓' : '✕', color: chk ? '#7A4F0C' : it.ok ? '#53735E' : '#C2412E', why: it.why, hasWhy: !chk && !it.ok };
        })
      } : null,
      openLabel: wf === 'concierge' ? 'View guest journey' : 'View in Operations',
      open: () => wf === 'concierge' ? this.go('demo', () => ({ gTab: 'tickets', gTicket: tBase.id })) : this.go('operations', () => ({ oSel: tBase.id }))
    };
    const wv = {
      heading: wf === 'concierge' ? 'Continuous guest concierge' : 'AI-verified maintenance',
      switcher: [['concierge', 'Guest concierge'], ['field', 'Field verification']].map(([id, label]) => ({
        id, label, on: wf === id, go: () => { this.stopPlay(); this.needFit = true; this.setState({ wf: id, sel: null }); }
      })),
      branches: (wf === 'concierge' ? [['yes', 'Villa can fulfil'], ['no', 'Villa can’t fulfil → approval']] : [['accept', 'Rejected, then accepted'], ['escalate', 'Rejected twice → escalate']]).map(([id, label]) => ({
        id, label, on: (wf === 'concierge' ? s.cBranch : s.fBranch) === id,
        go: () => this.setState(wf === 'concierge' ? { cBranch: id, sel: null } : { fBranch: id, sel: null })
      })),
      legend: ['ai', 'decision', 'oi', 'human', 'comms', 'verify'].map(k => { const sh = D.SHAPES[D.TM[k].shape]; return { key: k, label: D.TM[k].label, c: D.TM[k].c, r: sh[1], rot: sh[2] }; }),
      nodes, edges, labels, moved: s.moved[wf],
      stepNo: cur + 1, total: steps.length, stepTitle: steps[cur].title, stepTime: steps[cur].d + ', ' + steps[cur].t,
      prev: () => { this.stopPlay(); this.setStep(wf, cur - 1); },
      next: () => { this.stopPlay(); this.setStep(wf, cur + 1); },
      playLabel: s.playing ? 'Pause' : 'Play', togglePlay: () => s.playing ? this.stopPlay() : this.startPlay(),
      replay: () => { this.setStep(wf, 0); setTimeout(() => this.startPlay(), 50); },
      dots: steps.map((x, i) => ({ bg: i < cur ? '#7A716B' : i === cur ? '#C2412E' : '#E8DDD4', aria: 'Go to step ' + (i + 1) + ': ' + x.title, go: () => { this.stopPlay(); this.setStep(wf, i); } })),
      onCanvasDown: e => { this.pan = { sx: e.clientX, sy: e.clientY, ox: s.px, oy: s.py }; this.forceUpdate(); },
      panning: !!this.pan,
      transform: `translate(${s.px}px, ${s.py}px) scale(${s.z})`,
      zoomPct: Math.round(s.z * 100) + '%',
      zoomIn: () => this.zoomBy(1.2), zoomOut: () => this.zoomBy(1 / 1.2), fitView: () => this.fit(),
      resetLayout: () => this.setState(st => ({ pos: { ...st.pos, [wf]: D.defaultPositions(wf) }, moved: { ...st.moved, [wf]: false } }), () => this.fit())
    };
    return { wv, pd };
  }

  render() {
    const vm = this.viewModel();
    return h`<div className="shell">
      <a className="skip-link" href="#main">Skip to content</a>
      ${Sidebar(vm)}
      ${Topbar(vm)}
      <main className=${'main view-' + vm.view + (vm.back ? ' has-back' : '')} id="main" tabIndex="-1">
        ${vm.back && h`<button className="back-link" onClick=${vm.back.go}>← Back to ${vm.back.label}</button>`}
        ${vm.view === 'overview' && Overview(vm.ov, vm.sync)}
        <${PropertiesWorkspace} active=${vm.view === 'properties'} ctx=${vm.ctx} ...${vm.properties} />
        <${OperationsWorkspace} active=${vm.view === 'operations'} ctx=${vm.ctx} live=${vm.live} demo=${vm.demoOps} ...${vm.operations} />
        ${vm.view === 'workflows' && Workflows(vm.wv, vm.pd, this.canvasRef)}
        ${vm.view === 'demo' && DemoJourney(vm.gj, this.chatRef)}
      </main>
      ${vm.toasts.length > 0 && h`<div className="event-toasts" aria-live="polite">
        ${vm.toasts.map(t => h`<div key=${t.key} className=${'event-toast' + (t.urgent ? ' urgent' : '')}>
          <button className="body" onClick=${() => { t.go(); t.dismiss(); }}>
            <span className="badge" style=${{ background: t.bg, color: t.fg }}>${t.label}</span>
            <span className="tx"><b>${t.title}</b>${t.text && h`<span>${t.text}</span>`}</span>
          </button>
          <button className="x" onClick=${t.dismiss} aria-label="Dismiss">×</button>
        </div>`)}
      </div>`}
      ${vm.opDrawer && h`<${OperatorDrawer} key=${vm.opDrawer} id=${vm.opDrawer} ctx=${vm.ctx} onClose=${vm.closeDrawer} />`}
      ${vm.add.open && AddOperator(vm.add)}
      ${vm.notice && h`<div className=${'toast ' + vm.notice.tone} role=${vm.notice.tone === 'error' ? 'alert' : 'status'}>
        <span>${vm.notice.text}</span><button onClick=${vm.dismissNotice} aria-label="Dismiss">×</button>
      </div>`}
    </div>`;
  }
}

// ---------- shell ----------

function Sidebar(vm) {
  return h`<aside className="sidebar">
    <div className="brand">
      <div className="brand-logo" role="img" aria-label="Lohono Stays"></div>
      <div className="brand-text">
        <div className="brand-name">Gia</div>
        <div className="brand-sub">Lohono Guest Ops</div>
      </div>
    </div>
    <nav className="side-nav" aria-label="Main">
      ${vm.nav.map(n => h`<button key=${n.id} className=${n.on ? 'on' : ''} onClick=${n.go} aria-current=${n.on ? 'page' : undefined}>
        <span className=${'nav-mark' + (n.diamond ? ' diamond' : '')}></span>
        <span className="nav-label">${n.label}</span>
        ${n.badge > 0 && h`<span className="nav-badge" title=${`${n.badge} ${n.badgeLabel}`}><span className="sr-only">, </span>${n.badge}<span className="sr-only"> ${n.badgeLabel}</span></span>`}
      </button>`)}
    </nav>
    <div className="demo-box">
      <p>Items tagged <${DemoChip} /> and Workflows are scripted scenarios.</p>
      <button className="btn-link" onClick=${vm.openDemoJourney}>Demo guest journey</button>
      <button className="btn-link" onClick=${vm.resetDemo}>Reset demo scenarios</button>
    </div>
  </aside>`;
}

function Topbar(vm) {
  return h`<div className="topbar">
    <div className="brand-name">Gia</div>
    <nav className="topnav" aria-label="Main">
      ${vm.nav.map(n => h`<button key=${n.id} className=${'nav-btn' + (n.on ? ' on' : '')} onClick=${n.go} aria-current=${n.on ? 'page' : undefined}>${n.label}${n.badge > 0 ? ` · ${n.badge}` : ''}</button>`)}
    </nav>
  </div>`;
}

// ---------- overview ----------

function Overview(ov, sync) {
  return h`<div className="page overview" data-screen-label="Overview">
    <header className="page-head compact">
      <div>
        <div className="kicker">${ov.date}</div>
        <h1 className="page-title">Overview</h1>
      </div>
      <div className="head-actions">
        <select className="select-sm" value=${ov.villa.value} onChange=${ov.villa.onChange} aria-label="Property">
          ${ov.villa.options.map(([v, label]) => h`<option key=${v} value=${v}>${label}</option>`)}
        </select>
        <${LiveTag} sync=${sync} />
      </div>
    </header>

    <div className="metrics" role="list">
      ${ov.metrics.map(m => h`<button key=${m.key} role="listitem" className=${'metric' + (m.tone ? ' ' + m.tone : '')} onClick=${m.go}>
        <b>${m.value}</b> ${m.label}
      </button>`)}
    </div>

    <div className="ov-layout">
      <div className="ov-main">
        <section className="card section">
          <h2 className="h2">Needs attention</h2>
          ${ov.attention.length === 0 && h`<div className="all-clear">${ov.loaded ? h`<b>All clear.</b> Nothing needs a person right now.` : 'Loading…'}</div>`}
          <${AttentionList} items=${ov.attention} now=${ov.now} onAct=${a => a.go()} highlightFirst=${true} showVilla=${true} />
          ${ov.more && h`<button className="btn-link" onClick=${ov.more.go}>${ov.more.text}</button>`}
        </section>

        <section className="card section">
          <h2 className="h2">Recent activity</h2>
          ${ov.activity.items.map(e => h`<button key=${e.key} className=${'list-btn event-row' + (e.urgent ? ' urgent' : '')} onClick=${e.go}>
            <span className="feed-time">${e.time}</span>
            <span className="feed-who" style=${{ background: e.bg, color: e.fg }}>${e.label}</span>
            <span className="event-body"><span className="event-title">${e.title}</span>${e.text && h`<span className="note">${e.text}</span>`}</span>
          </button>`)}
          ${ov.activity.items.length === 0 && h`<div className="empty">${ov.loaded ? 'No activity yet.' : 'Loading…'}</div>`}
          ${ov.activity.more && h`<button className="btn-link" onClick=${ov.activity.more}>Show more</button>`}
        </section>
      </div>

      <aside className="ov-side">
        ${ov.conversations.length > 0 && h`<section className="card section">
          <h2 className="h3">In conversation now</h2>
          ${ov.conversations.map(c => h`<button key=${c.key} className="list-btn mini-row" onClick=${c.go}>
            <span className="avatar">${c.initials}<i className="pulse"></i></span>
            <span className="mini-body"><b>${c.title}</b><span className="note">${c.text}</span></span>
          </button>`)}
        </section>`}
        <section className="card section">
          <h2 className="h3">Guests in stay and arriving</h2>
          ${ov.stays.map(b => h`<button key=${b.key} className="list-btn mini-row" onClick=${b.go}>
            <span className="avatar">${b.initials}</span>
            <span className="mini-body"><b>${b.name}</b><span className="note">${b.sub} · ${b.stage}</span></span>
            ${b.open > 0 && h`<span className="count-badge" title="Open tickets">${b.open}</span>`}
          </button>`)}
          ${ov.stays.length === 0 && h`<div className="empty">${ov.loaded ? 'No guests in stay or arriving.' : 'Loading…'}</div>`}
        </section>
        <section className="card section">
          <h2 className="h3">Operators</h2>
          ${ov.operators.map(o => h`<button key=${o.key} className="list-btn mini-row" onClick=${o.go}>
            <span className="avatar">${o.initials}</span>
            <span className="mini-body"><b>${o.name}</b><span className="note">${o.open ? o.open + ' open' : 'Free'}</span></span>
            <${PresenceChip} presence=${o.presence} />
          </button>`)}
          ${ov.operators.length === 0 && h`<div className="empty">${ov.loaded ? h`No operators yet. <button className="btn-link" onClick=${ov.addOperator}>Add operator</button>` : 'Loading…'}</div>`}
        </section>
      </aside>
    </div>
  </div>`;
}

// ---------- the scripted demo guest journey ----------

function ScenarioBar(sc) {
  return h`<div className="scenario-bar">
    <span className="tag">Demo scenario</span>
    <span className="step-text">Step ${sc.no} of ${sc.total} · <b>${sc.title}</b></span>
    <span className="spacer"></span>
    <button className="btn-sq" onClick=${sc.prev} aria-label="Previous step">◀</button>
    <button className="btn-step primary" onClick=${sc.next} aria-label="Next step">Next ▶</button>
    <button className="btn-step outline" onClick=${sc.flow}>View workflow</button>
  </div>`;
}

function DemoJourney(gj, chatRef) {
  const t = gj.t, p = gj.profile;
  return h`<div className="page" data-screen-label="Demo guest journey">
    <header className="page-head compact">
      <div><div className="kicker">Scripted scenario · not live data</div><h1 className="page-title">Demo guest journey</h1></div>
    </header>
    <div className="columns">
      <div className="card col col-chat">
        <div className="chat-head">
          <span className="avatar">${gj.b.initials}</span>
          <div className="chat-head-body">
            <div className="chat-head-name">${gj.b.name} <${DemoChip} /> <span className="stage-tag">${gj.b.stage}</span></div>
            <div className="chat-head-sub">${gj.b.sub}</div>
          </div>
          <button className="btn" onClick=${gj.toggleTakeover}>${gj.takeover ? 'Hand back to Gia' : 'Take over'}</button>
        </div>
        ${ScenarioBar(gj.sc)}
        ${gj.takeover && h`<div className="takeover-banner">You’re replying · Gia is paused for this guest.</div>`}
        <div ref=${chatRef} className="chat-log">${gj.chat.map(ChatItem)}</div>
        <div className="composer">
          ${gj.takeover
            ? h`<${Composer} value=${gj.draft} onChange=${gj.onDraft} onSend=${gj.send} placeholder="Reply (demo, not sent)…" label="Reply to the guest" />`
            : h`<div className="composer-status"><span className="live"></span>Demo scenario · replies here aren’t sent.</div>`}
        </div>
      </div>
      <div className="card col col-context">
        <div className="tabs" role="tablist">
          ${gj.tabs.map(tb => h`<button key=${tb.id} role="tab" aria-selected=${tb.on} className=${tb.on ? 'on' : ''} onClick=${tb.go}>${tb.label}</button>`)}
        </div>
        <div className="tab-body">
          ${gj.tab === 'profile' && h`<${Frag}>
            <div><div className="villa-name">${p.villa.name}</div><div className="villa-loc">${p.villa.loc}</div></div>
            <dl className="kv">${p.rows.map(r => h`<${Frag} key=${r.k}><dt>${r.k}</dt><dd className=${r.mono ? 'mono' : ''}>${r.v}</dd><//>`)}</dl>
            <div className="stack"><div className="eyebrow">Preferences</div>
              <div className="prefs">${p.prefs.map((x, i) => h`<span key=${i} className="pref" style=${{ background: x.bg, border: '1px solid ' + x.border }}>${x.label}</span>`)}</div>
            </div>
            <details className="more"><summary>Villa capabilities</summary><div className="more-body">
              ${p.caps.map(c => h`<div key=${c.k} className="mark-row"><span className="g" style=${{ color: c.color }}>${c.glyph}</span><span className="spacer">${c.k}</span><span className="n">${c.note}</span></div>`)}
            </div></details><//>`}
          ${gj.tab === 'tickets' && h`<${Frag}>
            <div className="stack">
              ${gj.tickets.map(tk => h`<button key=${tk.id} className=${'list-btn ticket-card' + (tk.on ? ' on' : '')} onClick=${tk.go}>
                <span className="top"><span className="title">${tk.title}</span>${Pill(tk.pill, tk.status)}</span>
                <span className="id">${tk.id} · ${tk.cat}</span>
              </button>`)}
              ${gj.tickets.length === 0 && h`<div className="note">No tickets yet in this scenario.</div>`}
            </div>
            ${t && h`<div className="ticket-detail">
              <dl className="kv">${t.rows.map(([k, v]) => h`<${Frag} key=${k}><dt>${k}</dt><dd>${v}</dd><//>`)}</dl>
              <button className="btn" onClick=${gj.openField}>Open in Operations</button>
            </div>`}<//>`}
          ${gj.tab === 'activity' && gj.activity.map((a, i) => h`<div key=${i} className="activity-row">
            <span className="who" style=${{ background: a.who.bg, color: a.who.fg }}>${a.who.label}</span>
            <div className="body"><div className="top"><span className="ti">${a.title}</span><span className="t">${a.time}</span></div><div className="tx">${a.text}</div></div>
          </div>`)}
        </div>
      </div>
    </div>
  </div>`;
}

// ---------- workflows ----------

function Workflows(wv, pd, canvasRef) {
  const marker = (id, c) => h`<marker key=${id} id=${id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill=${c} /></marker>`;
  return h`<div className="page workflows" data-screen-label="Workflows">
    <header className="page-head compact">
      <div>
        <div className="kicker">Scripted scenario</div>
        <h1 className="page-title">${wv.heading}</h1>
      </div>
      <div className="switcher">
        ${wv.switcher.map(o => h`<button key=${o.id} className=${o.on ? 'on' : ''} onClick=${o.go} aria-pressed=${o.on}>${o.label}</button>`)}
      </div>
    </header>

    <div className="wf-bar">
      <div className="branches" role="group" aria-label="Scenario path">
        ${wv.branches.map(o => h`<button key=${o.id} className=${o.on ? 'on' : ''} onClick=${o.go} aria-pressed=${o.on}>${o.label}</button>`)}
      </div>
      <div className="legend">
        ${wv.legend.map(l => h`<span key=${l.key}><i style=${{ borderRadius: l.r, background: l.c, transform: l.rot }}></i>${l.label}</span>`)}
      </div>
    </div>

    <div className="columns wf-cols">
      <div className="card canvas-card">
        <div className="canvas-wrap">
          <div ref=${canvasRef} className=${'canvas' + (wv.panning ? ' panning' : '')} onPointerDown=${wv.onCanvasDown}>
            <div className="canvas-layer" style=${{ transform: wv.transform }}>
              <svg className="edges" width="1400" height="900">
                <defs>${marker('gm-r', '#C2412E')}${marker('gm-d', '#7A716B')}${marker('gm-l', '#CDBFB3')}</defs>
                ${wv.edges.map(e => h`<path key=${e.key} d=${e.d} fill="none" stroke=${e.stroke} strokeWidth=${e.width} strokeDasharray=${e.dash} markerEnd=${e.marker} />`)}
              </svg>
              ${wv.labels.map(l => h`<div key=${l.key} className="edge-label" style=${{ left: l.x + 'px', top: l.y + 'px', borderColor: l.border, color: l.fg }}>${l.text}</div>`)}
              ${wv.nodes.map(n => h`<div key=${n.id} className="node" onPointerDown=${n.onDown} onKeyDown=${n.onKey} tabIndex="0" role="button" aria-label=${n.aria}
                  style=${{ left: n.x + 'px', top: n.y + 'px', border: n.border, boxShadow: n.shadow, opacity: n.opacity, outline: n.outline }}>
                <div className="node-head" style=${{ background: n.tbg }}>
                  <span className="mk" style=${{ width: n.mw, background: n.mc, borderRadius: n.mr, transform: n.mrot }}></span>
                  <span className="type" style=${{ color: n.tc }}>${n.typeLabel}</span>
                  <span className="dot" style=${{ color: n.dotC }}>${n.dot}</span>
                </div>
                <div className="node-body">
                  <span className="ti">${n.title}</span>
                  <span className="sub">${n.sub}</span>
                </div>
              </div>`)}
            </div>
          </div>
          <div className="canvas-hint">
            <span className="info">Drag to rearrange · scroll to zoom</span>
            ${wv.moved && h`<span className="warn">Layout changed here only</span>`}
          </div>
          <div className="zoom">
            <button className="sym" onClick=${wv.zoomOut} aria-label="Zoom out">−</button>
            <span className="pct">${wv.zoomPct}</span>
            <button className="sym" onClick=${wv.zoomIn} aria-label="Zoom in">+</button>
            <span className="div"></span>
            <button onClick=${wv.fitView}>Fit</button>
            ${wv.moved && h`<button onClick=${wv.resetLayout}>Reset layout</button>`}
          </div>
        </div>
        <div className="player">
          <button className="btn-sq" onClick=${wv.prev} aria-label="Previous step">◀</button>
          <button className="next" onClick=${wv.next}>Next step ▶</button>
          <button className="play" onClick=${wv.togglePlay}>${wv.playLabel}</button>
          <div className="player-status">
            <div className="top"><span className="no">${wv.stepNo}/${wv.total}</span><span className="ti">${wv.stepTitle}</span></div>
            <div className="dots">
              ${wv.dots.map((d, i) => h`<button key=${i} onClick=${d.go} aria-label=${d.aria} style=${{ background: d.bg }}></button>`)}
            </div>
          </div>
          <button className="btn-link" onClick=${wv.replay}>Replay</button>
        </div>
      </div>

      ${StepPanel(pd)}
    </div>
  </div>`;
}

function StepPanel(pd) {
  const stp = pd.stp;
  return h`<aside className="card step-panel" aria-label="Selected step">
    <div className="head">
      <span className="type" style=${{ background: pd.tbg, color: pd.tc }}>${pd.typeLabel}</span>
      <span className="status" style=${{ background: pd.stBg, color: pd.stFg }}>${pd.status}</span>
      ${pd.needsPerson && h`<span className="person-chip">Needs a person</span>`}
      <span className="spacer"></span>
      ${pd.pinned && h`<button className="btn-link" onClick=${pd.unpin}>Back to current step</button>`}
    </div>
    <div>
      <div className="title">${pd.title}</div>
      <div className="sub">${pd.sub}</div>
    </div>

    ${!stp && h`<div className="step-detail">
      <div className="unreached">${pd.unreachedText}</div>
      ${pd.canJump && h`<button className="btn-primary" style=${{ alignSelf: 'flex-start' }} onClick=${pd.jump}>Jump to this step</button>`}
      ${pd.canSwitch && h`<button className="btn-dark" style=${{ alignSelf: 'flex-start' }} onClick=${pd.switchBranch}>Explore this branch</button>`}
    </div>`}
    ${stp && h`<div className="step-detail">
      <div className="st">${stp.title}</div>
      ${stp.decision && h`<div className="why"><b>Why: </b>${stp.decision}</div>`}
      ${stp.event && h`<div className="event">${stp.event}</div>`}
      ${pd.msgs.length > 0 && h`<div className="mini-chat">
        ${pd.msgs.map((m, i) => h`<div key=${i} style=${{ alignSelf: m.align, background: m.bg, borderColor: m.border }}>
          <div className="who" style=${{ color: m.whoC }}>${m.who}</div>${m.text}
        </div>`)}
      </div>`}
      ${stp.caps && h`<div className="mini-caps">
        ${pd.caps.map(c => h`<div key=${c.k} className="mark-row"><span className="g" style=${{ color: c.color }}>${c.glyph}</span><span className="spacer">${c.k}</span><span className="n">${c.note}</span></div>`)}
      </div>`}
      ${pd.ticket && h`<div className="mini-ticket">
        <div className="top"><span className="id">${pd.ticket.id}</span>${Pill(pd.ticket.pill, pd.ticket.status)}</div>
        <span className="ti">${pd.ticket.title}</span>
        <span className="ow">Operator: ${pd.ticket.owner}</span>
      </div>`}
      ${pd.evidence && h`<div className="mini-ev">
        <div className="top"><span className="ti">Evidence · attempt ${pd.evidence.n}</span><span className="result" style=${{ background: pd.evidence.bg, color: pd.evidence.fg }}>${pd.evidence.result}</span></div>
        ${pd.evidence.items.map(e => h`<div key=${e.label} className="row">
          <span className="g" style=${{ color: e.color }}>${e.glyph}</span>
          <span className="l">${e.label}${e.hasWhy && h`<span className="why-text">${e.why}</span>`}</span>
        </div>`)}
        <span className="sim">Simulated vision check</span>
      </div>`}
      ${stp.prefs && h`<div className="new-prefs">${stp.prefs.map(p => h`<span key=${p}>+ ${p}</span>`)}</div>`}
      <div className="next-line"><span className="eyebrow">Next</span> ${pd.next}</div>
    </div>`}

    <details className="more">
      <summary>Step details</summary>
      <div className="more-body"><dl className="facts single">${pd.details.map(([k, v]) => h`<div key=${k}><dt>${k}</dt><dd>${v}</dd></div>`)}</dl></div>
    </details>
    ${stp && h`<button className="btn-link" style=${{ alignSelf: 'flex-start' }} onClick=${pd.open}>${pd.openLabel}</button>`}
  </aside>`;
}

ReactDOM.createRoot(document.getElementById('root')).render(h`<${OpsConsole} />`);
