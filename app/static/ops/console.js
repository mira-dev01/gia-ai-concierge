// Gia ops console: Lohono's AI-native guest operations.
// Overview, Guest Journeys and Operations run on live data from the backend (live.js): bookings,
// WhatsApp conversations, tickets, handoffs and the audit log, refreshed every few seconds. Ticket status
// changes, takeovers, ops replies and handoff resolution are real actions.
// The guided demo scenarios (data.js) stay alongside, tagged "Demo": the concierge journey, the field app's
// photo-evidence flow and the workflow explorer, which have no live counterpart yet.
import * as D from './data.js';
import * as L from './live.js';

const { React, ReactDOM, htm } = window;
const h = htm.bind(React.createElement);
const Frag = React.Fragment;

const STORAGE_KEY = 'gia-ops-v2';
const SAVED_KEYS = ['view', 'cStep', 'fStep', 'cBranch', 'fBranch', 'booking', 'fTicket', 'wf', 'gTab', 'gTicket'];
const DEMO = 'demo';           // the scripted demo booking in Guest Journeys
const DEMO_FIELD_TICKET = 'OI-5534';
const POLL_MS = 5000;          // how often live data is refreshed
const AUTO_STEP_MS = 1300;     // pause between the steps a phone action triggers
const PLAY_STEP_MS = 1700;     // pause between steps when the workflow is playing
const MIN_ZOOM = 0.3, MAX_ZOOM = 1.8;
const ALL = 'all';
const VIEW_LABEL = { overview: 'Overview', guests: 'Guest journeys', field: 'Operations', workflows: 'Workflows' };
const ATTENTION_SHOWN = 5;     // Overview lists this many items needing attention before "View all"
const ACTIVITY_SHOWN = 6;

const ownerName = owner => owner.split(' · ')[0];
const stepsFor = (wf, s) => wf === 'concierge' ? D.conciergeSteps(s.cBranch) : D.fieldSteps(s.fBranch);
const stepKey = wf => wf === 'concierge' ? 'cStep' : 'fStep';
const STAGE_COLORS = { 'In stay': ['#F9E6DF', '#A8382A'], 'Pre-arrival': ['#E7ECEF', '#3E5263'], 'Post-stay': ['#F1EBE6', '#6E6762'], 'Cancelled': ['#F1EBE6', '#6A625C'] };
const EMPTY_LIVE = { now: '', bookings: [], tickets: [], handoffs: [], events: [], villas: [], ticket_statuses: [], operators: [], operator_roles: [] };
const EMPTY_FORM = { name: '', phone: '', role: 'caretaker', villa_ids: [], presence: 'onsite' };
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
  phoneRef = React.createRef();
  timers = [];
  acted = new Map();  // ticket ref -> when this console changed it, so its own change doesn't pop up as news
  state = this.initialState(true);

  initialState(useSaved) {
    const d = {
      view: 'overview', cStep: 8, fStep: 6, cBranch: 'yes', fBranch: 'accept', booking: null, gTab: 'tickets', gTicket: null,
      fTicket: null, fOperator: null, fVilla: ALL, fCat: ALL, fOp: ALL, fStatus: 'active', fMore: false,
      ovVilla: ALL, ovAll: false, ovActivity: false,
      wf: 'concierge', sel: null, search: '', z: 0.75, px: 30, py: 30, playing: false, cap: {},
      demoTakeover: false, demoOps: [], draft: '', opDraft: '', adding: false, opForm: EMPTY_FORM, eventToasts: [],
      moved: { concierge: false, field: false },
      pos: { concierge: D.defaultPositions('concierge'), field: D.defaultPositions('field') },
      live: null, liveError: null, pending: {}, notice: null, back: null
    };
    if (useSaved) {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (saved) SAVED_KEYS.forEach(k => { if (saved[k] !== undefined) d[k] = saved[k]; });
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

    const chat = this.chatRef.current;
    if (chat) {
      const key = this.state.booking + ':' + chat.scrollHeight;
      if (key !== this.chatKey) { this.chatKey = key; chat.scrollTop = chat.scrollHeight; }
    }
    const phone = this.phoneRef.current;
    if (phone) {
      const key = phone.dataset.who + ':' + phone.scrollHeight;
      if (key !== this.phoneKey) { this.phoneKey = key; phone.scrollTop = phone.scrollHeight; }
    }

    const s = this.state;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(SAVED_KEYS.map(k => [k, s[k]])))); } catch (e) { /* not persisted */ }
  }

  // ---------- live data and actions ----------

  refresh = async () => {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const live = await L.api('GET', '/state');
      this.announce(live.events);
      this.setState({ live, liveError: null });
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

  // Runs one backend action, shows the outcome, then refreshes so every screen reflects it.
  async act(key, request, success) {
    if (this.state.pending[key]) return false;
    this.setState(s => ({ pending: { ...s.pending, [key]: true } }));
    try {
      const result = await request();
      if (success) this.notify(success(result));
      await this.refresh();
      return true;
    } catch (e) {
      this.notify(e.message, 'error');
      return false;
    } finally {
      this.setState(s => { const pending = { ...s.pending }; delete pending[key]; return { pending }; });
    }
  }

  // Acting on a ticket keeps it selected, so its outcome stays in view even if it no longer leads the list.
  pin(t) { if (this.state.fTicket !== t.ref) this.setState({ fTicket: t.ref, fOperator: null }); }

  setTicketStatus(t, status) {
    this.pin(t);
    this.acted.set(t.ref, Date.now());
    return this.act('ticket:' + t.id, () => L.api('POST', `/tickets/${t.id}/status`, { status }),
      r => `${r.ref} is now ${L.STATUS_LABEL[r.status].toLowerCase()}` + (r.guest_messaged ? '. Gia messaged the guest on WhatsApp.' : '. Internal ticket, so the guest wasn’t messaged.'));
  }

  setTakeover(b, on) {
    return this.act('takeover:' + b.id, () => L.api('POST', `/bookings/${encodeURIComponent(b.id)}/takeover`, { on }),
      () => on ? `You’re handling ${b.name}’s chat. Gia is paused.` : `Handed back. Gia is replying to ${b.name} again.`);
  }

  async sendReply(b) {
    const text = this.state.draft.trim();
    if (!text) return;
    const ok = await this.act('reply:' + b.id, () => L.api('POST', `/bookings/${encodeURIComponent(b.id)}/reply`, { text }),
      () => `Sent to ${b.name} on WhatsApp.`);
    if (ok) this.setState({ draft: '' });
  }

  resolveHandoff(ho) {
    return this.act('handoff:' + ho.id, () => L.api('POST', `/handoffs/${ho.id}/resolve`), () => `HO-${ho.id} marked resolved.`);
  }

  markDone(t) {
    if (t.notifies_guest && !window.confirm(`Mark ${t.ref} done for ${t.operator}? Gia will tell ${t.guest || 'the guest'} it’s done.`)) return;
    this.pin(t);
    this.acted.set(t.ref, Date.now());
    return this.act('done:' + t.id, () => L.api('POST', `/tickets/${t.id}/done`),
      r => `${r.ref} done · resolved in ${L.duration(r.minutes)}` + (r.guest_messaged ? '. Gia told the guest.' : '.'));
  }

  assignTicket(t, operatorId) {
    this.pin(t);
    this.acted.set(t.ref, Date.now());
    return this.act('assign:' + t.id, () => L.api('POST', `/tickets/${t.id}/assign`, { operator_id: operatorId }),
      r => `${t.ref} → ${r.assignee}` + (operatorId ? '. They’ve been sent the task on WhatsApp.' : '.'));
  }

  setPresence(op, presence) {
    return this.act('presence:' + op.id, () => L.api('POST', `/operators/${op.id}/presence`, { presence }), () => `${op.name} is now ${presence}.`);
  }

  async messageOperator(op) {
    const text = this.state.opDraft.trim();
    if (!text) return;
    const ok = await this.act('opmsg:' + op.id, () => L.api('POST', `/operators/${op.id}/message`, { text }), () => `Sent to ${op.name} on WhatsApp.`);
    if (ok) this.setState({ opDraft: '' });
  }

  async addOperator() {
    const f = this.state.opForm;
    const ok = await this.act('addop', () => L.api('POST', '/operators', f), r => {
      this.setState({ fOperator: r.id, fTicket: null });
      return `${f.name.trim()} added as ${L.ROLE_LABEL[f.role].toLowerCase()} (${f.presence}).`;
    });
    if (ok) this.setState({ adding: false, opForm: EMPTY_FORM });
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
    const keep = ['view', 'booking', 'fTicket', 'fOperator', 'gTab', 'gTicket', 'fVilla', 'fCat', 'fOp', 'fStatus', 'fMore', 'search', 'draft',
      'ovVilla', 'ovAll', 'ovActivity',
      'opDraft', 'adding', 'opForm', 'eventToasts', 'live', 'liveError', 'pending', 'notice'];
    keep.forEach(k => { d[k] = this.state[k]; });
    this.needFit = true;
    this.setState(d);
    this.notify('Demo scenarios reset. Live data is unchanged.');
  }

  // ---------- view model ----------

  viewModel() {
    const s = this.state;
    const live = s.live || EMPTY_LIVE, now = live.now, loaded = !!s.live;
    // Following a link from one screen to another remembers the screen you came from, so you can go back to it.
    const go = (view, extra) => {
      this.stopPlay();
      if (view === 'workflows') this.needFit = true;
      this.setState(st => ({ view, back: view !== st.view ? st.view : st.back, ...(extra || {}) }));
    };
    const navTo = view => {
      this.stopPlay();
      if (view === 'workflows') this.needFit = true;
      this.setState({ view, back: null });
    };
    const toFlow = wf => go('workflows', { wf, sel: null });

    // ---- demo scenarios ----
    const cS = D.conciergeSteps(s.cBranch), fS = D.fieldSteps(s.fBranch);
    const cCur = Math.min(s.cStep, cS.length - 1), fCur = Math.min(s.fStep, fS.length - 1);
    const demoTickets = D.scenarioTickets(cS, cCur, fS, fCur);
    const demoB = D.demoBooking(cCur);
    const scenarioNav = wf => {
      const steps = wf === 'concierge' ? cS : fS, cur = wf === 'concierge' ? cCur : fCur;
      return { no: cur + 1, total: steps.length, title: steps[cur].title, prev: () => this.setStep(wf, cur - 1), next: () => this.setStep(wf, cur + 1), flow: () => toFlow(wf) };
    };

    // ---- live ----
    const tickets = live.tickets.map(t => L.ticketView(t, now));
    const ticketByRef = Object.fromEntries(tickets.map(t => [t.ref, t]));
    const bookings = L.sortBookings(live.bookings);
    const openCount = id => live.tickets.filter(t => t.booking_id === id && t.status !== 'closed').length;
    const openText = n => n ? n + ' open ticket' + (n > 1 ? 's' : '') : 'No open tickets';
    const attention = L.attention(live).map(a => ({
      ...a, go: a.kind === 'handoff' ? () => go('guests', { booking: a.booking }) : () => go('field', { fTicket: a.ref, fOperator: null })
    }));
    const waitingHandoffs = live.handoffs.filter(x => x.status === 'waiting');
    const ticketAlerts = attention.filter(a => a.kind === 'ticket').length;

    const nav = [['overview', 'Overview'], ['guests', 'Guest Journeys'], ['field', 'Operations'], ['workflows', 'Workflows']].map(([id, label]) => ({
      id, label: label, on: s.view === id, diamond: id === 'workflows',
      badge: id === 'guests' ? waitingHandoffs.length : id === 'field' ? ticketAlerts : 0, go: () => navTo(id)
    }));

    const sync = { loaded, error: s.liveError, at: now ? now.slice(11, 19) : '' };

    // ---- overview: what needs a person first, then who's here, then what happened ----
    const inVilla = name => s.ovVilla === ALL || name === s.ovVilla;
    const ovAttention = attention.filter(a => inVilla(a.villa));
    const inStay = bookings.filter(b => b.stage === 'In stay' && inVilla(b.villa));
    const open = live.tickets.filter(t => t.status !== 'closed' && inVilla(t.villa));
    const late = open.filter(t => t.overdue);
    const ov = {
      date: now ? L.longDate(now) : '', loaded,
      villa: { value: s.ovVilla, options: [[ALL, 'All villas']].concat(live.villas.map(v => [v.name, v.name])), onChange: e => this.setState({ ovVilla: e.target.value, ovAll: false }) },
      metrics: [
        { key: 'attn', label: 'need attention', value: ovAttention.length, tone: ovAttention.length ? 'red' : '', go: () => this.setState({ ovAll: true }) },
        { key: 'late', label: 'overdue', value: late.length, tone: late.length ? 'red' : '', go: () => go('field', { fStatus: 'overdue', fVilla: s.ovVilla }) },
        { key: 'open', label: 'open tickets', value: open.length, go: () => go('field', { fStatus: 'active', fVilla: s.ovVilla }) },
        { key: 'stay', label: 'in stay', value: inStay.length, go: () => go('guests') }
      ].map(m => ({ ...m, value: loaded ? m.value : '–' })),
      attention: (s.ovAll ? ovAttention : ovAttention.slice(0, ATTENTION_SHOWN)).map((a, i) => ({ ...a, primary: i === 0 })),
      more: !s.ovAll && ovAttention.length > ATTENTION_SHOWN ? { text: `View all ${ovAttention.length}`, go: () => this.setState({ ovAll: true }) } : null,
      conversations: bookings.filter(b => b.in_conversation && inVilla(b.villa)).map(b => ({
        key: b.id, initials: L.initials(b.name), title: b.name, text: `${b.takeover ? 'Ops is replying' : 'Gia is replying'} · ${L.ago(b.last_inbound_at, now)}`,
        go: () => go('guests', { booking: b.id })
      })),
      stays: bookings.filter(b => (b.stage === 'In stay' || b.stage === 'Pre-arrival') && inVilla(b.villa)).map(b => ({
        key: b.id, name: b.name, initials: L.initials(b.name), sub: `${b.villa} · ${L.dateRange(b.check_in, b.check_out)}`, stage: b.stage,
        open: openCount(b.id), go: () => go('guests', { booking: b.id })
      })),
      operators: live.operators.filter(op => s.ovVilla === ALL || op.roles.some(r => r.villa === s.ovVilla))
        .slice().sort((a, b) => b.open - a.open || a.name.localeCompare(b.name)).map(op => ({
          key: op.id, name: op.name, initials: L.initials(op.name), presence: op.presence, open: op.open,
          go: () => go('field', { fOperator: op.id, fTicket: null, fStatus: ALL })
        })),
      activity: (() => {
        const list = live.events.filter(e => s.ovVilla === ALL || !e.ticket || (ticketByRef[e.ticket] && ticketByRef[e.ticket].villa === s.ovVilla));
        return { items: (s.ovActivity ? list.slice(0, 30) : list.slice(0, ACTIVITY_SHOWN)).map(e => this.eventView(e, now, go)),
          more: !s.ovActivity && list.length > ACTIVITY_SHOWN ? () => this.setState({ ovActivity: true }) : null };
      })(),
      addOperator: () => go('field', { adding: true })
    };

    // ---- guest journeys ----
    const q = s.search.trim().toLowerCase();
    const selBookingId = s.booking === DEMO || bookings.some(b => b.id === s.booking) ? s.booking : (bookings[0] ? bookings[0].id : DEMO);
    const demoOpen = demoTickets.filter(t => t.booking === 'demo' && t.status !== 'Resolved').length;
    const matches = (...fields) => !q || fields.join(' ').toLowerCase().includes(q);
    const waitingFor = new Set(waitingHandoffs.map(x => x.booking_id));
    const listRow = (key, name, villa, dates, stage, id, open, demo) => ({
      key, name, villa, dates, stage, id, openText: openText(open), demo, on: key === selBookingId, waiting: waitingFor.has(key),
      stBg: STAGE_COLORS[stage][0], stFg: STAGE_COLORS[stage][1], go: () => this.setState({ booking: key, gTicket: null })
    });
    const gjList = bookings.filter(b => matches(b.name, b.villa, b.id))
      .map(b => listRow(b.id, b.name, b.villa, L.dateRange(b.check_in, b.check_out), b.stage, b.id, openCount(b.id), false));
    const gjDemo = matches(demoB.name, demoB.villa, demoB.id, 'demo')
      ? [listRow(DEMO, demoB.name, demoB.villa, demoB.dates, demoB.stage, demoB.id, demoOpen, true)] : [];
    const gj = selBookingId === DEMO
      ? this.demoJourney({ demoB, cS, cCur, demoTickets, scenarioNav, go })
      : this.liveJourney({ b: bookings.find(b => b.id === selBookingId), live, tickets, now, go });
    Object.assign(gj, { search: s.search, onSearch: e => this.setState({ search: e.target.value }), list: gjList, demoList: gjDemo, loaded, tab: s.gTab,
      draft: s.draft, onDraft: e => this.setState({ draft: e.target.value }) });
    gj.tabs = [['profile', 'Profile'], ['tickets', 'Tickets · ' + gj.tickets.length], ['activity', 'Activity']].map(([id, label]) => ({ id, label, on: s.gTab === id, go: () => this.setState({ gTab: id }) }));

    // ---- operations: live tickets grouped by field operator, then unassigned, then the demo tickets ----
    const distinct = vals => Array.from(new Set(vals)).sort();
    const opById = Object.fromEntries(live.operators.map(o => [o.id, o]));
    // Quick views over the ticket list; a specific status can still be picked under "More filters".
    const VIEWS = [
      ['active', 'Open', t => t.statusKey !== 'closed'], ['overdue', 'Overdue', t => t.overdue],
      ['unassigned', 'Unassigned', t => !t.operator_id && t.statusKey !== 'closed'], ['closed', 'Closed', t => t.statusKey === 'closed'],
      [ALL, 'All', () => true]
    ];
    const viewFn = (VIEWS.find(v => v[0] === s.fStatus) || [null, null, t => t.statusKey === s.fStatus])[2];
    const base = tickets.filter(t =>
      (s.fVilla === ALL || t.villa === s.fVilla) && (s.fCat === ALL || t.category === s.fCat) &&
      (s.fOp === ALL || (s.fOp === 'none' ? !t.operator_id : String(t.operator_id) === s.fOp)));
    const filtered = base.filter(viewFn);
    const narrowed = s.fVilla !== ALL || s.fCat !== ALL || s.fStatus !== ALL;
    // Open work first (newest first), then what's done (most recently resolved first).
    const order = list => list.slice().sort((a, b) => (a.statusKey === 'closed') - (b.statusKey === 'closed') ||
      (a.statusKey === 'closed' ? (b.resolved_at || '').localeCompare(a.resolved_at || '') : b.created_at.localeCompare(a.created_at)));
    const groups = live.operators
      .filter(op => s.fOp === ALL || String(op.id) === s.fOp)
      .map(op => ({ op, tickets: order(filtered.filter(t => t.operator_id === op.id)) }))
      .filter(g => !narrowed || g.tickets.length)
      .sort((a, b) => b.op.open - a.op.open || a.op.name.localeCompare(b.op.name));
    const unassigned = s.fOp === ALL || s.fOp === 'none' ? order(filtered.filter(t => !t.operator_id)) : [];
    const demoRows = demoTickets.map(t => D.decorateTicket(t));
    const picked = ticketByRef[s.fTicket] || demoRows.find(t => t.id === s.fTicket);
    const urgentRef = (attention.find(a => a.kind === 'ticket' && filtered.some(t => t.ref === a.ref)) || {}).ref;
    const firstTicket = ticketByRef[urgentRef] || unassigned[0] || (groups.find(g => g.tickets.length) || { tickets: [] }).tickets[0];
    const selTicket = picked || (s.fOperator == null ? firstTicket || null : null);
    // The phone follows the selected ticket's current operator (so a reassignment switches it), else the chosen operator.
    const selOp = selTicket ? (selTicket.ref && opById[selTicket.operator_id]) || null : opById[s.fOperator] || (groups[0] ? groups[0].op : null);
    const selOpId = selOp ? selOp.id : null;
    const selRef = selTicket ? selTicket.ref || selTicket.id : null;
    const opGroup = (key, title, sub, op, rows) => ({
      key, title, sub, rows, op: op ? { presence: op.presence, open: op.open, avg: op.avg_resolve_minutes !== null ? 'avg ' + L.duration(op.avg_resolve_minutes) : '' } : null,
      on: !!op && op.id === selOpId && !selTicket, go: op ? () => this.setState({ fOperator: op.id, fTicket: null }) : null
    });
    const extraFilters = [s.fVilla, s.fCat, s.fOp].filter(v => v !== ALL).length + (VIEWS.some(v => v[0] === s.fStatus) ? 0 : 1);
    const fo = {
      loaded, hasLive: tickets.length > 0 || live.operators.length > 0,
      views: VIEWS.map(([key, label, fn]) => ({ key, label, count: base.filter(fn).length, on: s.fStatus === key,
        alert: (key === 'overdue' || key === 'unassigned') && base.filter(fn).length > 0, go: () => this.setState({ fStatus: key }) })),
      moreOpen: s.fMore || extraFilters > 0, toggleMore: () => this.setState({ fMore: !(s.fMore || extraFilters > 0) }),
      extraCount: extraFilters,
      filters: [
        { key: 'fVilla', aria: 'Villa', options: [[ALL, 'All villas']].concat(live.villas.map(v => [v.name, v.name])) },
        { key: 'fCat', aria: 'Category', options: [[ALL, 'All categories']].concat(distinct(live.tickets.map(t => t.category)).map(c => [c, L.titleCase(c)])) },
        { key: 'fOp', aria: 'Operator', options: [[ALL, 'All operators']].concat(live.operators.map(o => [String(o.id), o.name]), [['none', 'Unassigned']]) },
        { key: 'fStatus', aria: 'Exact status', options: [['', 'Exact status: any']].concat(live.ticket_statuses.map(st => [st, L.STATUS_LABEL[st] || L.titleCase(st)])) }
      ].map(f => ({ ...f, value: f.options.some(o => o[0] === s[f.key]) ? s[f.key] : f.options[0][0],
        onChange: e => this.setState({ [f.key]: f.key === 'fStatus' && !e.target.value ? 'active' : e.target.value }) })),
      isFiltered: extraFilters > 0,
      clear: () => this.setState({ fVilla: ALL, fCat: ALL, fOp: ALL, fStatus: 'active' }),
      groups: (unassigned.length ? [opGroup('none', 'Unassigned', 'Needs an operator', null, unassigned.map(t => this.taskRow(t, t.ref, selRef)))] : [])
        .concat(groups.map(g => opGroup('op' + g.op.id, g.op.name, L.roleSummary(g.op), g.op, g.tickets.map(t => this.taskRow(t, t.ref, selRef))))),
      demoRows: demoRows.map(t => this.taskRow(t, t.id, selRef)),
      t: !selTicket ? null : selTicket.ref ? this.liveTicketDetail(selTicket, live, go) : { ...selTicket, live: false },
      opDetail: !selTicket && selOp ? this.operatorDetail(selOp) : null,
      sc: scenarioNav('field'),
      add: this.addOperatorModel(live)
    };

    // ---- the phone: the selected operator's WhatsApp, or the demo ticket's photo-evidence walkthrough ----
    const isScenario = !!selTicket && !selTicket.ref && selTicket.id === DEMO_FIELD_TICKET;
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
    const opPhone = !isScenario && selOp ? this.operatorPhone(selOp, tickets, now) : null;
    const ph = {
      show: !!opPhone || isScenario, op: opPhone,
      who: isScenario ? 'Santosh Naik · Maintenance' : opPhone ? opPhone.name : selTicket ? ownerName(selTicket.owner || '') : '',
      hint: isScenario || opPhone ? null
        : selTicket && !selTicket.ref ? h`Select <b>${DEMO_FIELD_TICKET}</b> to walk through the field evidence flow.`
        : selTicket ? h`No operator on this ticket yet. Assign one and their WhatsApp chat shows here.`
        : h`Add an operator with the button at the top right; their WhatsApp chat shows here.`,
      idle: isScenario && fCur < D.F.ASSIGNED,
      showTask: isScenario && fCur >= D.F.ASSIGNED,
      assigned: isScenario && (fCur === D.F.ASSIGNED || fCur === D.F.ETA),
      finish: () => this.setStep('field', D.F.CLAIMED),
      capture: isScenario && fCur === D.F.CLAIMED,
      slots: ['c1', 'c2', 'c3', 'c4'].map(k => slot('a' + k, D.CHECKLIST[k])),
      canSubmit: allCaptured,
      submit: () => { if (allCaptured) this.runSequence('fStep', [D.F.SUBMITTED, D.F.REJECTED, D.F.REWORK]); },
      checking: isScenario && (fCur === D.F.SUBMITTED || fCur === D.F.RESUBMITTED),
      rework: isScenario && (fCur === D.F.REJECTED || fCur === D.F.REWORK || (escalating && fCur === D.F.VERDICT)),
      reworkTitle: fCur === D.F.VERDICT ? 'Still not proven — escalating' : rejected.length + ' photos need retaking',
      reasons: rejected.map(x => ({ label: x.label, why: x.why })),
      canRetake: fCur === D.F.REWORK,
      retake: rejected.map(x => slot('r' + x.k, x.label)),
      canResubmit: allRetaken,
      resubmit: () => { if (allRetaken) this.runSequence('fStep', [D.F.RESUBMITTED, D.F.VERDICT]); },
      accepted: isScenario && !escalating && fCur >= D.F.VERDICT,
      acceptedText: fCur >= D.F.CLOSED ? 'Ticket closed. Thank you, Santosh.' : 'Closing the ticket…',
      escalated: isScenario && escalating && fCur >= D.F.CLOSED
    };

    const { wv, pd } = this.workflowModel({ cS, fS, cCur, fCur, go });

    return {
      view: s.view, nav, sync, notice: s.notice, dismissNotice: () => this.setState({ notice: null }),
      back: s.back && s.back !== s.view ? { label: VIEW_LABEL[s.back], go: () => { if (s.back === 'workflows') this.needFit = true; this.setState({ view: s.back, back: null }); } } : null,
      toasts: s.eventToasts.map(e => ({ ...this.eventView(e, now, go), dismiss: () => this.dismissEvent(e.id) })),
      resetDemo: () => this.resetDemo(), ov, gj, fo, ph, wv, pd, phoneRef: this.phoneRef
    };
  }

  eventView(e, now, go) {
    const k = EVENT_KINDS[e.kind] || EVENT_KINDS.ticket;
    const target = e.kind === 'operator' && e.operator_id ? () => go('field', { fOperator: e.operator_id, fTicket: null })
      : e.ticket ? () => go('field', { fTicket: e.ticket, fOperator: null })
      : e.booking_id ? () => go('guests', { booking: e.booking_id }) : () => go('overview');
    return { key: e.id, time: L.when(e.at, now), label: k[0], fg: k[1], bg: k[2], urgent: e.urgent, title: e.title, text: e.text, go: target };
  }

  operatorPhone(op, tickets, now) {
    const s = this.state;
    return {
      id: op.id, name: op.name, presence: op.presence, roles: L.roleSummary(op),
      togglePresence: () => this.setPresence(op, op.presence === 'onsite' ? 'offsite' : 'onsite'),
      presencePending: !!s.pending['presence:' + op.id],
      tasks: tickets.filter(t => t.operator_id === op.id && t.statusKey !== 'closed').map(t => ({
        key: t.ref, ref: t.ref, title: t.title, villa: t.villa, flag: t.timeFlag,
        done: () => this.markDone(t), pending: !!s.pending['done:' + t.id], go: () => this.setState({ fTicket: t.ref, fOperator: null })
      })),
      chat: L.operatorChat(op, now),
      draft: s.opDraft, onDraft: e => this.setState({ opDraft: e.target.value }),
      onKey: e => { if (e.key === 'Enter') this.messageOperator(op); },
      send: () => this.messageOperator(op), sending: !!s.pending['opmsg:' + op.id],
      windowNote: op.window_open ? '' : `${op.name.split(' ')[0]} hasn’t written in the last 24 hours, so WhatsApp may block free text. New tasks still reach them as a template.`
    };
  }

  operatorDetail(op) {
    return {
      name: op.name, presence: op.presence, roles: L.roleSummary(op), phone: op.phone ? L.phoneLabel(op.phone) : 'No number',
      facts: [['Open tasks', String(op.open)], ['Resolved', String(op.resolved)], ['Average time to resolve', op.avg_resolve_minutes !== null ? L.duration(op.avg_resolve_minutes) : '–']],
      togglePresence: () => this.setPresence(op, op.presence === 'onsite' ? 'offsite' : 'onsite'),
      pending: !!this.state.pending['presence:' + op.id]
    };
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
      open: s.adding, show: () => this.setState({ adding: true }), close: () => this.setState({ adding: false }),
      form: f, set, villas: live.villas, roles: live.operator_roles.length ? live.operator_roles : Object.keys(L.ROLE_LABEL),
      toggleVilla: id => set('villa_ids', f.villa_ids.includes(id) ? f.villa_ids.filter(x => x !== id) : f.villa_ids.concat([id])),
      replacedText: replaced.length ? `Replaces the current ${L.ROLE_LABEL[f.role].toLowerCase()}: ${replaced.join(', ')}.` : '',
      canSubmit: f.name.trim() && f.phone.replace(/\D/g, '').length >= 10 && f.villa_ids.length,
      submit: () => this.addOperator(), pending: !!s.pending.addop
    };
  }

  taskRow(t, ref, selRef) {
    return {
      key: ref, ref, demo: !t.ref, title: t.title, status: t.status, pill: t.pill, villa: t.villa, cat: t.cat,
      sev: t.sev, sevColor: t.sevColor, sevGlyph: t.sevGlyph, ownerShort: t.ownerShort, updated: t.updated, flag: t.timeFlag || null,
      on: ref === selRef, go: () => this.setState({ fTicket: ref, fOperator: null })
    };
  }

  // The selected ticket, arranged around its next step: assign it if no one has it, otherwise the status change that
  // usually comes next (the others stay one click away). Nothing here changes a ticket by itself.
  liveTicketDetail(t, live, go) {
    const pending = !!this.state.pending['ticket:' + t.id];
    const closed = t.statusKey === 'closed', unassigned = !t.operator_id;
    const NEXT = { open: 'acknowledged', acknowledged: 'in_progress', in_progress: 'closed', delayed: 'closed' };
    const VERB = { acknowledged: 'Acknowledge', in_progress: 'Mark in progress', delayed: 'Mark delayed', closed: 'Resolve' };
    const next = closed || unassigned ? null : NEXT[t.statusKey];
    const op = live.operators.find(o => o.id === t.operator_id);
    return {
      live: true, id: t.ref, villa: t.villa, cat: t.cat, title: t.title, status: t.status, pill: t.pill,
      sev: t.sev, sevColor: t.sevColor, sevGlyph: t.sevGlyph, flag: t.timeFlag,
      overdue: t.overdue && !closed ? `Overdue · was due ${t.due}` : '',
      closed, unassigned, resolvedText: t.resolvedText,
      assign: {
        value: t.operator_id ? String(t.operator_id) : '',
        options: [['', unassigned ? 'Choose an operator…' : 'Unassign (back to control tower)']].concat(live.operators.map(o => [String(o.id), `${o.name} · ${o.presence}${o.open ? ` · ${o.open} open` : ''}`])),
        onChange: e => this.assignTicket(t, e.target.value ? Number(e.target.value) : null),
        pending: !!this.state.pending['assign:' + t.id], hasOperators: live.operators.length > 0,
        addOperator: () => this.setState({ adding: true }),
        current: op ? `${op.name} · ${op.presence}` : t.owner
      },
      primary: next ? { label: VERB[next], go: () => this.setStatusConfirmed(t, next), pending } : null,
      secondary: closed ? [] : live.ticket_statuses.filter(st => st !== 'open' && st !== t.statusKey && st !== next)
        .map(st => ({ key: st, label: VERB[st] || L.titleCase(st), pending, go: () => this.setStatusConfirmed(t, st) })),
      notifyText: t.notifies_guest ? `${t.guest || 'The guest'} is updated on WhatsApp at each step.` : 'Internal ticket · the guest isn’t messaged.',
      issue: t.details, requestLabel: t.notifies_guest ? 'Guest request' : 'Details',
      reporter: [t.guest, t.booking_id].filter(Boolean).join(' · '),
      details: [['Source', t.origin], ['Opened', L.whenFull(t.created_at, live.now)], ['Expected by', t.due], ['Updated', t.updated],
        ['Assigned to', t.owner]],
      flowItems: t.flowItems, history: t.history,
      openJourney: t.booking_id ? () => go('guests', { booking: t.booking_id, gTab: 'tickets', gTicket: t.ref }) : null
    };
  }

  setStatusConfirmed(t, status) {
    // Closing a guest's request sends them a message, so check first.
    if (status === 'closed' && t.notifies_guest && !window.confirm(`Close ${t.ref}? Gia will tell ${t.guest || 'the guest'} it’s done.`)) return;
    this.setTicketStatus(t, status);
  }

  liveJourney({ b, live, tickets, now, go }) {
    const s = this.state;
    const bT = tickets.filter(t => t.booking_id === b.id);
    const gSel = bT.find(t => t.ref === s.gTicket) || bT[0];
    const villa = live.villas.find(v => v.id === b.villa_id) || { name: b.villa, location: b.location, caps: [] };
    const sameDay = iso => iso.slice(0, 10) === now.slice(0, 10);
    const staffRows = [['Caretaker', b.staff.caretaker], ['Manager', b.staff.manager]].filter(r => r[1]);
    if (!staffRows.length && b.host) staffRows.push(['Villa host', b.host]);
    return {
      demo: false,
      b: { id: b.id, name: b.name, initials: L.initials(b.name), stage: b.stage,
        sub: `${b.villa} · ${L.dateRange(b.check_in, b.check_out)} · ${L.phoneLabel(b.phone)}` },
      chat: L.chatItems(b, live.tickets.filter(t => t.booking_id === b.id), now, ref => this.setState({ gTab: 'tickets', gTicket: ref })),
      sc: null,
      takeover: b.takeover, takeoverPending: !!s.pending['takeover:' + b.id],
      toggleTakeover: () => this.setTakeover(b, !b.takeover),
      send: () => this.sendReply(b), sending: !!s.pending['reply:' + b.id],
      onDraftKey: e => { if (e.key === 'Enter') this.sendReply(b); },
      handoffs: live.handoffs.filter(x => x.booking_id === b.id && x.status === 'waiting').map(x => ({
        id: x.id, urgent: x.urgency === 'urgent', reason: x.reason, at: L.whenFull(x.at, now),
        pending: !!s.pending['handoff:' + x.id], resolve: () => this.resolveHandoff(x)
      })),
      profile: {
        villa: { name: villa.name, loc: villa.location, code: b.villa_id },
        rows: [
          { k: 'Booking', v: b.id, mono: true },
          { k: 'Stay', v: `${L.dateRange(b.check_in, b.check_out)} · ${L.nights(b.check_in, b.check_out)}` },
          { k: 'Party', v: L.party(b) },
          ...(b.occasion ? [{ k: 'Occasion', v: b.occasion }] : []),
          ...(b.vip ? [{ k: 'VIP', v: 'Yes' }] : []),
          ...L.detailRows(b.details),
          ...(b.pre_booked_services.length ? [{ k: 'Pre-booked', v: b.pre_booked_services.join(', ') }] : []),
          ...staffRows.map(([k, v]) => ({ k, v }))
        ],
        noArrival: !Object.keys(b.details || {}).length,
        prefs: b.preferences.map(p => ({ label: p.preference, title: `${L.titleCase(p.category)} · “${p.source_quote}”`, bg: sameDay(p.at) ? '#E6EEE7' : '#F5F0E8', border: sameDay(p.at) ? '#C9D9CC' : '#EDE4DC' })),
        journey: L.journeyRows(b, now),
        caps: villa.caps.map(c => ({ k: c.label, glyph: c.ok ? '✓' : '✕', color: c.ok ? '#53735E' : '#C2412E', note: c.note }))
      },
      tickets: bT.map(t => ({ id: t.ref, cat: t.cat, title: t.title, status: t.status, pill: t.pill, flag: t.timeFlag, on: gSel && t.ref === gSel.ref, go: () => this.setState({ gTicket: t.ref }) })),
      t: gSel ? {
        title: gSel.title, status: gSel.status, pill: gSel.pill,
        rows: [['Operator', gSel.owner], ['Priority', gSel.sev], [gSel.statusKey === 'closed' ? 'Resolved' : 'Expected by',
          gSel.statusKey === 'closed' ? (gSel.resolvedText || 'Closed') : gSel.due + (gSel.overdue ? ' · overdue' : '')]]
      } : null,
      openField: () => gSel && go('field', { fTicket: gSel.ref, fOperator: null }),
      activity: b.activity.map(a => ({ who: D.WHO[a.who], title: a.title, time: L.whenFull(a.at, now), text: a.text })),
      liveNote: 'Gia is replying automatically.'
    };
  }

  demoJourney({ demoB, cS, cCur, demoTickets, scenarioNav, go }) {
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
    const sendDemo = () => { const text = s.draft.trim(); if (text) this.setState(st => ({ draft: '', demoOps: st.demoOps.concat([text]) })); };
    return {
      demo: true,
      b: { id: demoB.id, name: demoB.name, initials: L.initials(demoB.name), stage: demoB.stage, sub: `${demoB.villa} · ${demoB.dates} · ${demoB.phone}` },
      chat, sc: scenarioNav('concierge'),
      takeover: s.demoTakeover, takeoverPending: false,
      toggleTakeover: () => this.setState(st => ({ demoTakeover: !st.demoTakeover })),
      send: sendDemo, sending: false, onDraftKey: e => { if (e.key === 'Enter') sendDemo(); },
      handoffs: [],
      profile: {
        villa: { name: D.DEMO_VILLA.name, loc: D.DEMO_VILLA.loc, code: D.DEMO_VILLA.code },
        rows: [{ k: 'Booking', v: demoB.id, mono: true }, { k: 'Stay', v: demoB.dates }, { k: 'Party', v: demoB.party }, { k: 'Arrival', v: demoB.arrival }],
        noArrival: false,
        prefs: prefs.map(x => ({ label: x.p, bg: x.fresh ? '#E6EEE7' : '#F5F0E8', border: x.fresh ? '#C9D9CC' : '#EDE4DC' })),
        journey: [],
        caps: D.capRows(D.DEMO_VILLA.caps)
      },
      tickets: bT.map(t => ({ id: t.id, cat: t.cat, title: t.title, status: t.status, pill: D.statusPill(t.status), on: gSel && t.id === gSel.id, go: () => this.setState({ gTicket: t.id }) })),
      t: d ? { title: d.title, status: d.status, pill: d.pill, rows: [['Operator', d.owner], ['Priority', d.sev]] } : null,
      openField: () => gSel && go('field', { fTicket: gSel.id, fOperator: null }),
      activity: cS.slice(0, cCur + 1).map(x => ({ who: D.WHO[x.who], title: x.title, time: x.d + ', ' + x.t, text: x.event || x.decision || (x.msgs ? x.msgs[x.msgs.length - 1][1] : '') })).reverse(),
      liveNote: 'Demo scenario · replies here aren’t sent.'
    };
  }

  workflowModel({ cS, fS, cCur, fCur, go }) {
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
      open: () => wf === 'concierge' ? go('guests', { booking: DEMO, gTicket: tBase.id }) : go('field', { fTicket: tBase.id })
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
      ${Sidebar(vm)}
      ${Topbar(vm)}
      <main className="main">
        ${vm.back && h`<button className="back-link" onClick=${vm.back.go}>← Back to ${vm.back.label}</button>`}
        ${vm.view === 'overview' && Overview(vm.ov, vm.sync)}
        ${vm.view === 'guests' && GuestJourneys(vm.gj, vm.sync, this.chatRef)}
        ${vm.view === 'field' && FieldOperations(vm.fo, vm.ph, vm.sync, vm.phoneRef)}
        ${vm.view === 'workflows' && Workflows(vm.wv, vm.pd, this.canvasRef)}
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
      ${vm.fo.add.open && AddOperator(vm.fo.add)}
      ${vm.notice && h`<div className=${'toast ' + vm.notice.tone} role=${vm.notice.tone === 'error' ? 'alert' : 'status'}>
        <span>${vm.notice.text}</span><button onClick=${vm.dismissNotice} aria-label="Dismiss">×</button>
      </div>`}
    </div>`;
  }
}

// ---------- shell ----------

function LiveTag({ sync }) {
  if (sync.error) return h`<span className="live-tag error" title=${sync.error}>Can’t reach the backend · retrying</span>`;
  if (!sync.loaded) return h`<span className="live-tag">Connecting…</span>`;
  return h`<span className="live-tag ok"><i></i>Live · synced ${sync.at} IST</span>`;
}
const DemoChip = () => h`<span className="demo-chip">Demo</span>`;
const Pill = (p, status) => h`<span className="pill" style=${{ background: p.bg, color: p.fg }}>${p.icon} ${status}</span>`;

function Sidebar(vm) {
  return h`<aside className="sidebar">
    <div className="brand">
      <div className="brand-logo" role="img" aria-label="Lohono Stays"></div>
      <div className="brand-text">
        <div className="brand-name">Gia</div>
        <div className="brand-sub">Lohono Guest Ops</div>
      </div>
    </div>
    <nav className="side-nav">
      ${vm.nav.map(n => h`<button key=${n.id} className=${n.on ? 'on' : ''} onClick=${n.go} aria-current=${n.on ? 'page' : undefined}>
        <span className=${'nav-mark' + (n.diamond ? ' diamond' : '')}></span>
        <span className="nav-label">${n.label}</span>
        ${n.badge > 0 && h`<span className="nav-badge">${n.badge}</span>`}
      </button>`)}
    </nav>
    <div className="demo-box">
      <p>Items tagged <${DemoChip} /> and Workflows are scripted scenarios.</p>
      <button className="btn-link" onClick=${vm.resetDemo}>Reset demo scenarios</button>
    </div>
  </aside>`;
}

function Topbar(vm) {
  return h`<div className="topbar">
    <div className="brand-name">Gia</div>
    ${vm.nav.map(n => h`<button key=${n.id} className=${'nav-btn' + (n.on ? ' on' : '')} onClick=${n.go}>${n.label}${n.badge > 0 ? ` · ${n.badge}` : ''}</button>`)}
    <button className="btn" onClick=${vm.resetDemo}>Reset demo</button>
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
        <select className="select-sm" value=${ov.villa.value} onChange=${ov.villa.onChange} aria-label="Villa">
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
          <ul className="attn-list">
            ${ov.attention.map(a => h`<li key=${a.key} className=${'attn-item' + (a.primary ? ' first' : '')}>
              <div className="attn-text">
                <span className="chip-row"><span className=${'state-chip ' + a.tone}>${a.state}</span>${a.pill && Pill(a.pill, a.status)}</span>
                <span className="attn-title">${a.title}</span>
                <span className="note">${a.who}${a.who ? ' · ' : ''}<span className="mono">${a.ref}</span></span>
              </div>
              <button className=${a.primary ? 'btn-primary' : 'btn'} onClick=${a.go}>${a.action}</button>
            </li>`)}
          </ul>
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
          <h2 className="h3">Stays</h2>
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

const PresenceChip = ({ presence }) => h`<span className=${'presence ' + presence}>${presence === 'onsite' ? 'Onsite' : 'Offsite'}</span>`;

// ---------- guest journeys ----------

function ChatItem(m, i, arr) {
  // Only label the sender on the first bubble of a consecutive run from them, like any chat UI.
  const sameSenderAsPrev = arr && arr[i - 1] && arr[i - 1].kind === m.kind;
  switch (m.kind) {
    case 'date': return h`<div key=${i} className="chat-date">${m.text}</div>`;
    case 'guest': return h`<div key=${i} className="bubble guest">${m.text}<div className="time">${m.time}</div></div>`;
    case 'gia': return h`<div key=${i} className="bubble gia">${!sameSenderAsPrev && h`<div className="who">Gia · AI concierge</div>`}${m.text}<div className="time">${m.time}</div></div>`;
    case 'ops': return h`<div key=${i} className="bubble ops">${!sameSenderAsPrev && h`<div className="who">Ops team · human</div>`}${m.text}${m.time && h`<div className="time">${m.time}</div>`}</div>`;
    case 'note': return h`<div key=${i} className="chat-note">${m.text}${m.time && h` · ${m.time}`}</div>`;
    default: return h`<button key=${i} className="chat-chip" onClick=${m.go}><span className="sq"></span>${m.text}<span className="time">${m.time}</span></button>`;
  }
}

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

function BookingRow(b) {
  return h`<button key=${b.key} className=${'list-btn booking-row' + (b.on ? ' on' : '')} onClick=${b.go} aria-current=${b.on ? 'true' : undefined}>
    <span className="top">
      <span className="name">${b.name}${b.demo && h` <${DemoChip} />`}</span>
      <span className="chip-tag" style=${{ background: b.stBg, color: b.stFg }}>${b.stage}</span>
    </span>
    <span className="note">${b.villa} · ${b.dates}${b.openText !== 'No open tickets' ? ' · ' + b.openText : ''}</span>
    ${b.waiting && h`<span className="state-chip red">Needs a person</span>`}
  </button>`;
}

function GuestJourneys(gj, sync, chatRef) {
  const t = gj.t, p = gj.profile, waiting = gj.handoffs.length > 0;
  return h`<div className="page" data-screen-label="Guest Journeys">
    <header className="page-head compact">
      <h1 className="page-title">Guest journeys</h1>
      <${LiveTag} sync=${sync} />
    </header>
    <div className="columns">
      <div className="card col col-list">
        <div className="search">
          <input value=${gj.search} onChange=${gj.onSearch} placeholder="Search guest, villa or booking" aria-label="Search guest, villa or booking" />
        </div>
        <div className="scroll">
          ${gj.list.map(BookingRow)}
          ${gj.list.length === 0 && h`<div className="empty list-empty">${!gj.loaded ? 'Loading…' : gj.search ? 'No bookings match.' : 'No bookings yet.'}</div>`}
          ${gj.demoList.length > 0 && h`<div className="list-divider">Demo scenario</div>`}
          ${gj.demoList.map(BookingRow)}
        </div>
      </div>

      <div className="card col col-chat">
        <div className="chat-head">
          <span className="avatar">${gj.b.initials}</span>
          <div className="chat-head-body">
            <div className="chat-head-name">${gj.b.name}${gj.demo && h` <${DemoChip} />`} <span className="stage-tag">${gj.b.stage}</span></div>
            <div className="chat-head-sub">${gj.b.sub}</div>
          </div>
          <button className=${gj.takeover ? 'btn' : waiting ? 'btn-primary' : 'btn'} onClick=${gj.toggleTakeover} disabled=${gj.takeoverPending}>
            ${gj.takeover ? 'Hand back to Gia' : 'Take over'}
          </button>
        </div>
        ${gj.sc && ScenarioBar(gj.sc)}
        ${gj.handoffs.map(ho => h`<div key=${ho.id} className=${'handoff-bar' + (ho.urgent ? ' urgent' : '')} role="status">
          <span className="tx"><b>${ho.urgent ? 'Urgent · needs a person' : 'Needs a person'}</b> · ${ho.reason} <span className="at">${ho.at}</span></span>
          <button className="btn small" onClick=${ho.resolve} disabled=${ho.pending}>Mark resolved</button>
        </div>`)}
        ${gj.takeover && h`<div className="takeover-banner">You’re replying · Gia is paused for this guest.</div>`}
        <div ref=${chatRef} className="chat-log">
          ${gj.chat.map(ChatItem)}
          ${gj.chat.length === 0 && h`<div className="chat-date">No messages yet</div>`}
        </div>
        <div className="composer">
          ${gj.takeover
            ? h`<${Frag}><input value=${gj.draft} onChange=${gj.onDraft} onKeyDown=${gj.onDraftKey} disabled=${gj.sending} placeholder=${gj.demo ? 'Reply (demo, not sent)…' : 'Reply on WhatsApp…'} aria-label="Reply to the guest" />
                <button className="send" onClick=${gj.send} disabled=${gj.sending}>${gj.sending ? 'Sending…' : 'Send'}</button><//>`
            : h`<${Frag}><span className="live"></span>
                <span className="status">${gj.liveNote}</span><//>`}
        </div>
      </div>

      <div className="card col col-context">
        <div className="tabs" role="tablist">
          ${gj.tabs.map(tb => h`<button key=${tb.id} role="tab" aria-selected=${tb.on} className=${tb.on ? 'on' : ''} onClick=${tb.go}>${tb.label}</button>`)}
        </div>
        <div className="tab-body">
          ${gj.tab === 'profile' && h`<${Frag}>
            <div>
              <div className="villa-name">${p.villa.name}</div>
              <div className="villa-loc">${p.villa.loc}</div>
            </div>
            <dl className="kv">
              ${p.rows.map(r => h`<${Frag} key=${r.k}><dt className="k">${r.k}</dt><dd className=${r.mono ? 'mono' : ''}>${r.v}</dd><//>`)}
              ${p.noArrival && h`<${Frag}><dt className="k">Arrival</dt><dd>Not shared yet</dd><//>`}
            </dl>
            <div className="stack">
              <div className="eyebrow">Preferences</div>
              <div className="prefs">
                ${p.prefs.map((x, i) => h`<span key=${i} className="pref" title=${x.title} style=${{ background: x.bg, border: '1px solid ' + x.border }}>${x.label}</span>`)}
              </div>
              ${p.prefs.length === 0 && h`<span className="note">None yet.</span>`}
            </div>
            ${p.journey.length > 0 && h`<div className="stack sm">
              <div className="eyebrow">Pre-arrival messages</div>
              ${p.journey.map(j => h`<div key=${j.k} className="mark-row">
                <span className="g" style=${{ color: j.color }}>${j.glyph}</span><span className="spacer">${j.k}</span><span className="n">${j.note}</span>
              </div>`)}
            </div>`}
            <details className="more">
              <summary>Villa capabilities</summary>
              <div className="more-body">
                ${p.caps.map(c => h`<div key=${c.k} className="mark-row">
                  <span className="g" style=${{ color: c.color }}>${c.glyph}</span><span className="spacer">${c.k}</span><span className="n">${c.note}</span>
                </div>`)}
              </div>
            </details><//>`}

          ${gj.tab === 'tickets' && h`<${Frag}>
            <div className="stack">
              ${gj.tickets.map(tk => h`<button key=${tk.id} className=${'list-btn ticket-card' + (tk.on ? ' on' : '')} onClick=${tk.go}>
                <span className="top"><span className="title">${tk.title}</span>${Pill(tk.pill, tk.status)}</span>
                <span className="id">${tk.id} · ${tk.cat}${tk.flag ? ' · ' + tk.flag.text : ''}</span>
              </button>`)}
              ${gj.tickets.length === 0 && h`<div className="note">No tickets for this guest.</div>`}
            </div>
            ${t && h`<div className="ticket-detail">
              <dl className="kv">
                ${t.rows.map(([k, v]) => h`<${Frag} key=${k}><dt className="k">${k}</dt><dd>${v}</dd><//>`)}
              </dl>
              <button className="btn" onClick=${gj.openField}>Open in Operations</button>
            </div>`}<//>`}

          ${gj.tab === 'activity' && h`<${Frag}>
            ${gj.activity.map((a, i) => h`<div key=${i} className="activity-row">
              <span className="who" style=${{ background: a.who.bg, color: a.who.fg }}>${a.who.label}</span>
              <div className="body">
                <div className="top"><span className="ti">${a.title}</span><span className="t">${a.time}</span></div>
                <div className="tx">${a.text}</div>
              </div>
            </div>`)}
            ${gj.activity.length === 0 && h`<div className="note">Nothing yet.</div>`}<//>`}
        </div>
      </div>
    </div>
  </div>`;
}

function HistoryRow(x, i) {
  return h`<div key=${i} className="hist-row">
    <span className="t">${x.time}</span>
    <div><div className="ti">${x.title}</div><div className="tx">${x.text}</div></div>
  </div>`;
}

// ---------- operations ----------

function TaskRow(r) {
  return h`<button key=${r.key} className=${'list-btn task-row' + (r.on ? ' on' : '')} onClick=${r.go} aria-current=${r.on ? 'true' : undefined}>
    <span className="top"><span className="title">${r.title}</span>${Pill(r.pill, r.status)}</span>
    <span className="meta">
      <span className="mono">${r.ref}</span>${r.demo && h` <${DemoChip} />`}<span>${r.villa}</span>
      <span className="sev" style=${{ color: r.sevColor }}>${r.sevGlyph} ${r.sev}</span>
      ${r.flag ? h`<span className="time-flag" title=${r.flag.title} style=${{ color: r.flag.color, background: r.flag.bg }}>${r.flag.text}</span>` : h`<span>${r.ownerShort}</span>`}
    </span>
  </button>`;
}

function OpGroup(g) {
  return h`<${Frag} key=${g.key}>
    ${g.go
      ? h`<button className=${'list-btn group-head' + (g.on ? ' on' : '')} onClick=${g.go}>
          <span className="name">${g.title} <${PresenceChip} presence=${g.op.presence} /></span>
          <span className="note">${g.sub}</span>
          <span className="stats">${g.op.open} open${g.op.avg ? ' · ' + g.op.avg : ''}</span>
        </button>`
      : h`<div className="group-head plain"><span className="name">${g.title}</span><span className="note">${g.sub}</span></div>`}
    ${g.rows.map(TaskRow)}
    ${g.rows.length === 0 && h`<div className="group-empty">No tasks.</div>`}
  <//>`;
}

function HistoryDetails(t, extra) {
  return h`<details className="more">
    <summary>History & details</summary>
    <div className="more-body">
      ${t.details && h`<dl className="facts">${t.details.map(([k, v]) => h`<div key=${k}><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`}
      ${t.flowItems && h`<div className="flow-bars">
        ${t.flowItems.map(f => h`<div key=${f.label}><div className="bar" style=${{ background: f.bg }}></div><span style=${{ color: f.fg }}>${f.label}</span></div>`)}
      </div>`}
      ${extra}
      <div className="audit">
        <div className="eyebrow">Audit trail</div>
        ${t.history.map((x, i) => HistoryRow(x, i))}
        ${t.history.length === 0 && h`<div className="note">No entries yet.</div>`}
      </div>
    </div>
  </details>`;
}

function LiveTicketDetail(t) {
  const a = t.assign;
  return h`<${Frag}>
    <div className="ticket-head">
      <div className="ref">${t.id} · ${t.villa} · ${t.cat}</div>
      <h2 className="title">${t.title}</h2>
      <div className="chips">
        ${Pill(t.pill, t.status)}
        <span className="sev-chip" style=${{ color: t.sevColor }}>${t.sevGlyph} ${t.sev}</span>
        ${t.flag && h`<span className="time-flag" title=${t.flag.title} style=${{ color: t.flag.color, background: t.flag.bg }}>${t.flag.text}</span>`}
      </div>
    </div>
    ${t.overdue && h`<div className="alert-bar" role="status">${t.overdue}</div>`}

    <section className="next-action" aria-label="Next step">
      ${t.closed ? h`<div className="resolved-line">${t.resolvedText || 'Closed'}</div>`
        : t.unassigned ? h`<${Frag}>
            <label className="next-label" htmlFor="assign-select">Assign operator</label>
            ${a.hasOperators
              ? h`<select id="assign-select" className="select-primary" value=${a.value} onChange=${a.onChange} disabled=${a.pending}>
                  ${a.options.map(([v, label]) => h`<option key=${v} value=${v}>${label}</option>`)}
                </select>`
              : h`<button className="btn-primary" onClick=${a.addOperator}>Add an operator</button>`}
          <//>`
        : h`<button className="btn-primary" onClick=${t.primary.go} disabled=${t.primary.pending}>${t.primary.label}</button>`}
      ${t.secondary.length > 0 && h`<div className="secondary-actions">
        ${t.secondary.map(x => h`<button key=${x.key} className="btn small" onClick=${x.go} disabled=${x.pending}>${x.label}</button>`)}
      </div>`}
      ${!t.closed && h`<p className="note">${t.notifyText}</p>`}
    </section>

    <section className="request">
      <div className="eyebrow">${t.requestLabel}</div>
      <p>${t.issue}</p>
      <div className="note">${t.reporter}${t.openJourney && h` · <button className="btn-link" onClick=${t.openJourney}>View guest journey</button>`}</div>
    </section>

    ${!t.unassigned && h`<div className="assignee-row">
      <label className="k" htmlFor="op-select">Operator</label>
      <select id="op-select" value=${a.value} onChange=${a.onChange} disabled=${a.pending}>
        ${a.options.map(([v, label]) => h`<option key=${v} value=${v}>${label}</option>`)}
      </select>
    </div>`}

    ${HistoryDetails(t, h`<p className="note">Closes when the operator replies DONE on WhatsApp or taps Mark done, or when ops resolves it. Photo-verified closure is shown on the demo ticket ${DEMO_FIELD_TICKET}.</p>`)}
  <//>`;
}

function DemoTicketDetail(t, fo) {
  return h`<${Frag}>
    <div className="ticket-head">
      <div className="ref">${t.id} · ${t.villa} · ${t.cat} · <${DemoChip} /></div>
      <h2 className="title">${t.title}</h2>
      <div className="chips">${Pill(t.pill, t.status)}<span className="sev-chip" style=${{ color: t.sevColor }}>${t.sevGlyph} ${t.sev}</span></div>
    </div>
    <div className="facts">
      <div><div className="k">Owner</div><div className="v">${t.owner}</div></div>
      <div><div className="k">Severity</div><div className="v" style=${{ fontWeight: 700, color: t.sevColor }}>${t.sevGlyph} ${t.sev}</div></div>
      <div><div className="k">Source</div><div className="v">${t.origin}</div></div>
      <div><div className="k">Updated</div><div className="v">${t.updated}</div></div>
    </div>
    ${t.humanReason && h`<div className="human-only"><b>Human only</b><span>${t.humanReason}</span></div>`}

    ${t.tracker && h`<div className="tracker">
      ${t.tracker.map(k => h`<div key=${k.label} style=${{ border: '1px solid ' + k.border, background: k.bg }}>
        <span className="g" style=${{ color: k.fg }}>${k.glyph}</span><span className="l" style=${{ color: k.fg }}>${k.label}</span>
      </div>`)}
    </div>`}

    <div className="report">
      <div className="eyebrow">Original report</div>
      <p>“${t.issue}”</p>
    </div>

    <div className="two-col">
      <div>
        <div className="eyebrow">Work checklist</div>
        ${t.checklist.map(c => h`<div key=${c.label} className="check-row">
          <span className="g" style=${{ color: c.color }}>${c.glyph}</span><span className="l">${c.label}</span><span className="s" style=${{ color: c.color }}>${c.stateLabel}</span>
        </div>`)}
      </div>
      <div>
        <div className="eyebrow">Closure conditions</div>
        ${t.closure.map(c => h`<div key=${c.label} className="check-row" style=${{ alignItems: 'normal' }}>
          <span className="g" style=${{ color: c.color }}>${c.glyph}</span><span>${c.label}</span>
        </div>`)}
      </div>
    </div>

    <div className="review" style=${{ border: '1px solid ' + t.review.border, background: t.review.bg }}>
      <div className="top">
        <span className="title" style=${{ color: t.review.fg }}>${t.review.title}</span>
        ${t.review.simulated && h`<span className="sim-tag">Simulated vision check</span>`}
      </div>
      <p>${t.review.text}</p>
    </div>

    ${t.attempts.map(at => h`<div key=${at.n} className="attempt">
      <div className="top">
        <span className="ti">Evidence · attempt ${at.n} <span>· ${at.time}</span></span>
        <span className="result" style=${{ background: at.bg, color: at.fg }}>${at.result}</span>
      </div>
      <div className="photos">
        ${at.items.map(it => h`<div key=${it.label} className="photo" style=${{ border: '1px solid ' + it.border }}>
          <div className="hatch">
            ${it.ph}
            <span className="badge" style=${{ background: it.badgeBg }}>${it.glyph}</span>
          </div>
          <div className="cap">
            <b>${it.label}</b>
            ${it.hasWhy && h`<span className="why">${it.why}</span>`}
          </div>
        </div>`)}
      </div>
    </div>`)}

    ${HistoryDetails({ history: t.history })}
    ${t.scenario && h`<div className="task-scenario">
      <span className="step-text">Step ${fo.sc.no} of ${fo.sc.total} · <b>${fo.sc.title}</b></span>
      <span className="spacer"></span>
      <button className="btn-sq" onClick=${fo.sc.prev} aria-label="Previous step">◀</button>
      <button className="btn-step primary" onClick=${fo.sc.next}>Next ▶</button>
      <button className="btn-step outline" onClick=${fo.sc.flow}>View workflow</button>
    </div>`}
  <//>`;
}

function FieldOperations(fo, ph, sync, phoneRef) {
  const d = fo.opDetail;
  return h`<div className="page" data-screen-label="Operations">
    <header className="page-head compact">
      <h1 className="page-title">Operations</h1>
      <div className="head-actions">
        <${LiveTag} sync=${sync} />
        <button className="btn small" onClick=${fo.add.show}>+ Add operator</button>
      </div>
    </header>
    <div className="toolbar">
      <div className="view-tabs" role="group" aria-label="Ticket view">
        ${fo.views.map(v => h`<button key=${v.key} className=${(v.on ? 'on' : '') + (v.alert ? ' alert' : '')} onClick=${v.go} aria-pressed=${v.on}>
          ${v.label} <span className="n">${v.count}</span>
        </button>`)}
      </div>
      <button className="btn-link" onClick=${fo.toggleMore} aria-expanded=${fo.moreOpen}>More filters${fo.extraCount ? ` (${fo.extraCount})` : ''}</button>
    </div>
    ${fo.moreOpen && h`<div className="filters">
      ${fo.filters.map(f => h`<select key=${f.key} value=${f.value} onChange=${f.onChange} aria-label=${f.aria}>
        ${f.options.map(([v, label]) => h`<option key=${v} value=${v}>${label}</option>`)}
      </select>`)}
      ${fo.isFiltered && h`<button className="btn-link" onClick=${fo.clear}>Clear</button>`}
    </div>`}

    <div className=${'columns field-cols' + (ph.show ? '' : ' no-phone')}>
      <div className="card task-list">
        ${fo.groups.map(OpGroup)}
        ${fo.groups.length === 0 && h`<div className="empty">${!fo.loaded ? 'Loading…' : fo.hasLive ? 'No tickets in this view.' : h`No tickets or operators yet. <button className="btn-link" onClick=${fo.add.show}>Add operator</button>`}</div>`}
        ${fo.demoRows.length > 0 && h`<div className="list-divider">Demo scenarios</div>`}
        ${fo.demoRows.map(TaskRow)}
      </div>

      <div className="card task-detail">
        ${fo.t ? (fo.t.live ? LiveTicketDetail(fo.t) : DemoTicketDetail(fo.t, fo))
          : d ? h`<${Frag}>
              <div className="ticket-head">
                <div className="ref">Operator · ${d.phone}</div>
                <h2 className="title">${d.name}</h2>
                <div className="chips"><${PresenceChip} presence=${d.presence} /></div>
              </div>
              <p className="note">${d.roles}</p>
              <dl className="facts">${d.facts.map(([k, v]) => h`<div key=${k}><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
              <div className="next-action">
                <button className="btn" onClick=${d.togglePresence} disabled=${d.pending}>Mark ${d.presence === 'onsite' ? 'offsite' : 'onsite'}</button>
                <p className="note">New tasks go to onsite operators first. Operators can also reply ONSITE or OFFSITE.</p>
              </div>
            <//>`
          : h`<div className="empty">Select a ticket.</div>`}
      </div>

      ${ph.show && Phone(ph, phoneRef)}
    </div>
  </div>`;
}

function AddOperator(a) {
  const f = a.form;
  return h`<div className="modal-backdrop" onClick=${e => { if (e.target === e.currentTarget) a.close(); }}>
    <form className="modal card" onSubmit=${e => { e.preventDefault(); if (a.canSubmit) a.submit(); }}>
      <div className="modal-head"><h2 className="h2">Add operator</h2><button type="button" className="x" onClick=${a.close} aria-label="Close">×</button></div>
      <label>Name<input value=${f.name} onChange=${e => a.set('name', e.target.value)} placeholder="Ramesh Patil" autoFocus /></label>
      <label>WhatsApp number<input value=${f.phone} onChange=${e => a.set('phone', e.target.value)} placeholder="91 98XXX XXXXX (with country code)" inputMode="tel" /></label>
      <label>Role<select value=${f.role} onChange=${e => a.set('role', e.target.value)}>
        ${a.roles.map(r => h`<option key=${r} value=${r}>${L.ROLE_LABEL[r] || r}</option>`)}
      </select></label>
      <fieldset><legend>Villas</legend>
        ${a.villas.map(v => h`<label key=${v.id} className="check"><input type="checkbox" checked=${f.villa_ids.includes(v.id)} onChange=${() => a.toggleVilla(v.id)} />${v.name}</label>`)}
      </fieldset>
      <fieldset><legend>Right now</legend>
        ${['onsite', 'offsite'].map(p => h`<label key=${p} className="check"><input type="radio" name="presence" checked=${f.presence === p} onChange=${() => a.set('presence', p)} />${p === 'onsite' ? 'Onsite' : 'Offsite'}</label>`)}
      </fieldset>
      ${a.replacedText && h`<p className="warn-text">${a.replacedText}</p>`}
      <p className="note">Tickets for these villas go to them by role (maintenance, housekeeping, then caretaker or manager), onsite first. Gia sends each task on WhatsApp; they reply DONE when it’s finished.</p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick=${a.close}>Cancel</button>
        <button type="submit" className="btn-primary" disabled=${!a.canSubmit || a.pending}>${a.pending ? 'Adding…' : 'Add operator'}</button>
      </div>
    </form>
  </div>`;
}

function Slot(sl, prefix) {
  return h`<button key=${sl.key} className="slot" onClick=${sl.tap} style=${{ border: sl.border }} aria-pressed=${sl.on}>
    <span className="thumb" style=${{ background: sl.thumb }}>${sl.icon}</span>
    <span className="l">${prefix || ''}${sl.label}</span>
  </button>`;
}

function OperatorPhone(op, phoneRef) {
  return h`<${Frag}>
    <div className="phone-head">
      <span className="app">Lohono Field · WhatsApp</span>
      <span className="who-row"><span className="who">${op.name}</span>
        <button className=${'presence ' + op.presence} onClick=${op.togglePresence} disabled=${op.presencePending} title="Switch onsite / offsite">${op.presence === 'onsite' ? 'Onsite' : 'Offsite'}</button>
      </span>
    </div>
    <div className="phone-body" ref=${phoneRef} data-who=${op.id}>
      ${op.tasks.length > 0 && h`<div className="phone-label">Open tasks</div>`}
      ${op.tasks.map(t => h`<div key=${t.key} className="phone-task">
        <button className="list-btn" onClick=${t.go} style=${{ flexDirection: 'column', gap: '3px' }}>
          <span className="ref">${t.ref} · ${t.villa}</span>
          <span className="ti">${t.title}</span>
        </button>
        <span className="task-foot">
          ${t.flag && h`<span className="time-flag" title=${t.flag.title} style=${{ color: t.flag.color, background: t.flag.bg }}>${t.flag.text}</span>`}
          <button className="done-btn" onClick=${t.done} disabled=${t.pending}>${t.pending ? 'Saving…' : 'Mark done'}</button>
        </span>
      </div>`)}
      ${op.tasks.length === 0 && h`<div className="phone-label muted">No open tasks</div>`}
      ${op.chat.map((m, i) => m.kind === 'date' ? h`<div key=${i} className="chat-date">${m.text}</div>`
        : m.kind === 'note' ? h`<div key=${i} className="chat-note">${m.text} · ${m.time}</div>`
        : h`<div key=${i} className=${'pbubble ' + (m.kind === 'in' ? 'mine' : m.kind === 'ops' ? 'ops' : 'gia')}>
            ${m.kind !== 'in' && h`<div className="who">${m.kind === 'ops' ? 'Ops team' : 'Gia'}</div>`}${m.text}<div className="time">${m.time}</div>
          </div>`)}
      ${op.chat.length === 0 && h`<div className="phone-hint">No messages yet. Tasks Gia sends ${op.name.split(' ')[0]} appear here.</div>`}
    </div>
    ${op.windowNote && h`<div className="phone-warn">${op.windowNote}</div>`}
    <div className="phone-compose">
      <input value=${op.draft} onChange=${op.onDraft} onKeyDown=${op.onKey} disabled=${op.sending} placeholder=${`Message ${op.name.split(' ')[0]}…`} aria-label=${`Message ${op.name} on WhatsApp`} />
      <button onClick=${op.send} disabled=${op.sending} aria-label="Send">➤</button>
    </div>
  <//>`;
}

function Phone(ph, phoneRef) {
  return h`<div className="phone-col">
    <div className="eyebrow">${ph.op ? 'Operator chat · WhatsApp' : 'Field app preview'}</div>
    <div className="phone">
      ${ph.op ? OperatorPhone(ph.op, phoneRef) : h`<${Frag}>
      <div className="phone-head">
        <span className="app">Lohono Field</span>
        <span className="who">${ph.who}</span>
      </div>
      <div className="phone-body">
        ${ph.hint && h`<div className="phone-hint">${ph.hint}</div>`}
        ${ph.idle && h`<div className="phone-hint">No task assigned yet. The ops agent is creating the ticket.</div>`}
        ${ph.showTask && h`<div className="phone-task">
          <span className="ref">OI-5534 · Medium</span>
          <span className="ti">Basin leak · Bedroom 2 bathroom</span>
          <span className="loc">Casa Alba · Awas Shores, Alibaug</span>
        </div>`}
        ${ph.assigned && h`<${Frag}>
          <div className="phone-text">Guest has been told you’ll arrive by 10:30 am. You’ll need a photo for each checklist item before the ticket can close.</div>
          <button className="phone-cta" onClick=${ph.finish}>I’ve finished the repair</button><//>`}
        ${ph.capture && h`<${Frag}>
          <div className="phone-label">Add a photo for each item</div>
          ${ph.slots.map(sl => Slot(sl))}
          <button className="phone-cta" onClick=${ph.submit} disabled=${!ph.canSubmit} style=${{ background: ph.canSubmit ? '#C2412E' : '#D9CCC1' }}>Submit evidence</button><//>`}
        ${ph.checking && h`<div className="phone-state checking">
          <span className="icon">◎</span><span className="ti">Checking your photos…</span><span className="tx">Each photo is compared against its checklist item.</span>
        </div>`}
        ${ph.rework && h`<${Frag}>
          <div className="phone-state rework">
            <span className="ti">${ph.reworkTitle}</span>
            ${ph.reasons.map(rs => h`<span key=${rs.label} className="tx"><b>${rs.label}:</b> ${rs.why}</span>`)}
          </div>
          ${ph.canRetake && h`<${Frag}>
            ${ph.retake.map(sl => Slot(sl, 'Retake · '))}
            <button className="phone-cta" onClick=${ph.resubmit} disabled=${!ph.canResubmit} style=${{ background: ph.canResubmit ? '#C2412E' : '#D9CCC1' }}>Resubmit evidence</button><//>`}<//>`}
        ${ph.accepted && h`<div className="phone-state accepted">
          <span className="icon">✓</span><span className="ti">Evidence accepted</span><span className="tx">${ph.acceptedText}</span>
        </div>`}
        ${ph.escalated && h`<div className="phone-state escalated">
          <span className="ti">Escalated to villa manager</span><span className="tx">Francis D’Souza will inspect on site. Please stay at the villa until he arrives.</span>
        </div>`}
      </div><//>`}
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
