// Shared pieces of the ops console's screens: status chips, chat bubbles, and an accessible dialog and popover.
// Status is always shown as words with a glyph, never by colour alone.
import * as L from './live.js';

const { React, htm } = window;
export const h = htm.bind(React.createElement);
export const Frag = React.Fragment;

export const DemoChip = () => h`<span className="demo-chip">Demo</span>`;
export const Pill = (p, status) => h`<span className="pill" style=${{ background: p.bg, color: p.fg }}><span aria-hidden="true">${p.icon}</span> ${status}</span>`;
export const PresenceChip = ({ presence }) => h`<span className=${'presence ' + presence}>${presence === 'onsite' ? 'Onsite' : 'Offsite'}</span>`;

// A small status chip: tone is ok, warn, bad, info or neutral.
export const Tone = ({ tone, glyph, children, title }) =>
  h`<span className=${'tone tone-' + (tone || 'neutral')} title=${title}>${glyph && h`<span className="g" aria-hidden="true">${glyph}</span>`}${children}</span>`;

export const StayChip = ({ stay }) => {
  const [tone, glyph] = L.STAY_TONE[stay.key] || ['neutral', '·'];
  return h`<${Tone} tone=${tone} glyph=${glyph}>${stay.label}<//>`;
};

// A value from a record that may not have it: never shown as if it were known.
export const Missing = ({ children }) => h`<span className="missing">${children || 'Not tracked'}</span>`;
export const Value = ({ v, missing }) => v === null || v === undefined || v === '' ? h`<${Missing}>${missing}<//>` : h`<${Frag}>${String(v)}<//>`;

export function LiveTag({ sync }) {
  if (sync.error) return h`<span className="live-tag error" role="status" title=${sync.error}>${sync.lastOk ? `Not synced since ${sync.lastOk} · retrying` : 'Can’t reach the backend · retrying'}</span>`;
  if (!sync.loaded) return h`<span className="live-tag">Connecting…</span>`;
  return h`<span className="live-tag ok"><i></i>Live · synced ${sync.at} IST</span>`;
}

// Loading, failure and empty states, so a panel never looks blank or silently wrong.
export function State({ loading, error, retry, empty, children }) {
  if (error) return h`<div className="state error" role="alert"><b>Couldn’t load this.</b> ${error}${retry && h` <button className="btn-link" onClick=${retry}>Try again</button>`}</div>`;
  if (loading) return h`<div className="state" aria-busy="true">Loading…</div>`;
  if (empty) return h`<div className="state">${empty}</div>`;
  return children || null;
}

const Delivery = ({ status, error }) => {
  const d = L.DELIVERY[status];
  if (!d) return null;
  return h`<span className=${'delivery ' + d[2]} title=${error || d[0]}><span aria-hidden="true">${d[1]}</span> ${d[0]}</span>`;
};

// WhatsApp's own formatting (*bold*, _italic_), so templates read as the guest saw them. Text only: no HTML.
export function waText(text) {
  return String(text || '').split(/(\*[^*\n]+\*|_[^_\n]+_)/g).map((part, i) =>
    /^\*[^*\n]+\*$/.test(part) ? h`<b key=${i}>${part.slice(1, -1)}</b>` : /^_[^_\n]+_$/.test(part) ? h`<i key=${i}>${part.slice(1, -1)}</i>` : part);
}

export function ChatItem(m, i, arr) {
  // Only label the sender on the first bubble of a consecutive run from them, like any chat UI.
  const sameSenderAsPrev = arr && arr[i - 1] && arr[i - 1].kind === m.kind;
  const key = m.id || i;
  const foot = h`<div className="time">${m.time}${m.ref ? ' · ' + m.ref : ''}${m.delivery && h` · <${Delivery} status=${m.delivery} error=${m.error} />`}</div>`;
  switch (m.kind) {
    case 'date': return h`<div key=${key} className="chat-date">${m.text}</div>`;
    // m.who names the sender when it isn't the guest, Gia or ops (an operator's thread)
    case 'guest': return h`<div key=${key} className="bubble guest" data-msg=${m.id}>${m.who ? !sameSenderAsPrev && h`<div className="who">${m.who}</div>` : h`<span className="sr-only">Guest: </span>`}${waText(m.text)}${foot}</div>`;
    case 'gia': return h`<div key=${key} className=${'bubble gia' + (m.delivery === 'failed' ? ' failed' : '')}>${!sameSenderAsPrev && h`<div className="who">${m.who || 'Gia · AI concierge'}</div>`}${waText(m.text)}${foot}</div>`;
    case 'ops': return h`<div key=${key} className=${'bubble ops' + (m.delivery === 'failed' ? ' failed' : '')}>${!sameSenderAsPrev && h`<div className="who">${m.who || 'Ops team · human'}</div>`}${waText(m.text)}${m.time && foot}</div>`;
    case 'note': return h`<div key=${key} className="chat-note">${m.text}${m.time && h` · ${m.time}`}</div>`;
    default: return m.go
      ? h`<button key=${key} className="chat-chip" onClick=${m.go}><span className="sq"></span>${m.text}<span className="time">${m.time}</span></button>`
      : h`<div key=${key} className="chat-chip"><span className="sq"></span>${m.text}<span className="time">${m.time}</span></div>`;
  }
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// A modal dialog: focus moves in when it opens, Tab stays inside, Escape closes, and focus returns to
// whatever opened it.
export class Dialog extends React.Component {
  ref = React.createRef();
  componentDidMount() {
    this.opener = document.activeElement;
    const el = this.ref.current;
    const first = el && (el.querySelector('[autofocus], textarea, input:not([type=checkbox]):not([type=radio]), select') || el);
    if (first) first.focus({ preventScroll: true });
  }
  componentWillUnmount() { if (this.opener && this.opener.focus) this.opener.focus(); }
  onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); this.props.onClose(); return; }
    if (e.key !== 'Tab') return;
    const items = Array.from(this.ref.current.querySelectorAll(FOCUSABLE));
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  render() {
    const p = this.props;
    return h`<div className="modal-backdrop" onMouseDown=${e => { if (e.target === e.currentTarget) p.onClose(); }}>
      <div ref=${this.ref} tabIndex="-1" className=${'modal card' + (p.wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-labelledby="dialog-title" onKeyDown=${this.onKey}>
        <div className="modal-head"><h2 id="dialog-title" className="h2">${p.title}</h2><button type="button" className="x" onClick=${p.onClose} aria-label="Close">×</button></div>
        ${p.children}
      </div>
    </div>`;
  }
}

// A side drawer for secondary detail (an operator's thread, a ticket on narrow screens): same focus rules as Dialog.
export class Drawer extends Dialog {
  render() {
    const p = this.props;
    return h`<div className="drawer-backdrop" onMouseDown=${e => { if (e.target === e.currentTarget) p.onClose(); }}>
      <aside ref=${this.ref} tabIndex="-1" className="drawer" role="dialog" aria-modal="true" aria-label=${p.label} onKeyDown=${this.onKey}>
        <button type="button" className="drawer-x" onClick=${p.onClose} aria-label="Close">×</button>
        ${p.children}
      </aside>
    </div>`;
  }
}

// A button that opens a small panel of secondary controls (less-used filters). Escape or a click outside closes it.
export class Popover extends React.Component {
  state = { open: false };
  ref = React.createRef();
  componentDidMount() {
    this.onDoc = e => { if (this.state.open && this.ref.current && !this.ref.current.contains(e.target)) this.setState({ open: false }); };
    document.addEventListener('mousedown', this.onDoc);
  }
  componentWillUnmount() { document.removeEventListener('mousedown', this.onDoc); }
  render() {
    const p = this.props, open = this.state.open;
    return h`<div className="popover-wrap" ref=${this.ref} onKeyDown=${e => { if (e.key === 'Escape' && open) { e.stopPropagation(); this.setState({ open: false }); } }}>
      <button className=${'btn' + (p.count ? ' has-count' : '')} aria-expanded=${open} aria-haspopup="true" onClick=${() => this.setState({ open: !open })}>
        ${p.label}${p.count ? h` <span className="count">${p.count}</span>` : ''} <span aria-hidden="true">▾</span>
      </button>
      ${open && h`<div className="popover card" role="group" aria-label=${p.label}>${p.children}</div>`}
    </div>`;
  }
}

// Scrolls a chat log to the bottom when new messages arrive, unless the reader has scrolled up to read; a newly
// opened chat always starts at the bottom. key is "<chat id>:<message count>"; pass trackScroll as the log's onScroll.
export function stickToBottom(el, key, memo) {
  if (!el || memo.key === key) return;
  const sameChat = memo.key && memo.key.split(':')[0] === key.split(':')[0];
  if (!sameChat || memo.atBottom !== false) el.scrollTop = el.scrollHeight;
  if (!sameChat) memo.atBottom = true;
  memo.key = key;
}
export const trackScroll = memo => e => {
  const el = e.currentTarget;
  memo.atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
};

// One line of a history or activity log.
export const HistoryRow = ({ time, title, text }) => h`<div className="hist-row">
  <span className="t">${time}</span>
  <div><div className="ti">${title}</div>${text && h`<div className="tx">${text}</div>`}</div>
</div>`;

// What needs a person (the backend's attention items), with the next action for each. Used by Overview for the
// portfolio and by a property for its own items, so both read the same.
export function AttentionList({ items, now, onAct, highlightFirst, showVilla }) {
  return h`<ul className="attn-list">${items.map((a, i) => h`<li key=${a.key} className=${'attn-item' + (highlightFirst && i === 0 ? ' first' : '')}>
    <div className="attn-text">
      <span className="chip-row"><span className=${'state-chip ' + L.SEVERITY_TONE[a.severity]}>${a.severity === 'critical' ? '▲ ' : ''}${L.attentionState(a, now)}</span>${a.status && Pill(L.statusPill(a.status), L.STATUS_LABEL[a.status] || L.titleCase(a.status))}</span>
      <span className="attn-title">${a.title}</span>
      <span className="note">${[a.guest, showVilla && a.villa].filter(Boolean).join(' · ')}${a.guest || (showVilla && a.villa) ? ' · ' : ''}<span className="mono">${a.ref}</span></span>
    </div>
    <button className=${highlightFirst && i === 0 ? 'btn-primary' : 'btn small'} onClick=${() => onAct(a)}>${a.action}</button>
  </li>`)}</ul>`;
}

// The quick views above a list (stay status, ticket views): options are [key, label, count, alert].
export const FilterChips = ({ label, options, value, onChange }) => h`<div className="chips" role="group" aria-label=${label}>
  ${options.map(([key, text, count, alert]) => h`<button key=${key} className=${'chip' + (value === key ? ' on' : '') + (alert ? ' alert' : '')}
    aria-pressed=${value === key} onClick=${() => onChange(key)}>${text} <span className="n">${count ?? '–'}</span></button>`)}
</div>`;

// The filters in force, each removable, plus a reset. tokens are [key, label].
export const FilterTokens = ({ tokens, onRemove, onReset, resetLabel }) => tokens.length > 0 && h`<div className="tokens" aria-label="Active filters">
  ${tokens.map(([key, text]) => h`<button key=${key} className="token" onClick=${() => onRemove(key)} aria-label=${`Remove filter ${text}`}>${text} <span aria-hidden="true">×</span></button>`)}
  <button className="btn-link" onClick=${onReset}>${resetLabel || 'Reset filters'}</button>
</div>`;

// A WhatsApp reply box: Enter sends, Shift+Enter adds a line, one send at a time, a failure keeps the text.
export const Composer = ({ value, onChange, onSend, sending, disabled, placeholder, label, warn, error, onRetry }) => h`<${Frag}>
  ${warn && h`<div className="composer-warn">${warn}</div>`}
  ${error && h`<div className="composer-error" role="alert">${error}${onRetry && h` <button className="btn-link" onClick=${onRetry} disabled=${sending}>Retry</button>`}</div>`}
  <form className="composer-row" onSubmit=${e => { e.preventDefault(); onSend(); }}>
    <textarea rows="1" value=${value} onChange=${e => onChange(e.target.value)}
      onKeyDown=${e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
      disabled=${sending || disabled} placeholder=${placeholder} aria-label=${label}></textarea>
    <button type="submit" className="send" disabled=${sending || disabled || !value.trim()}>${sending ? 'Sending…' : 'Send'}</button>
  </form>
<//>`;
