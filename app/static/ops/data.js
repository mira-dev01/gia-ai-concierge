// Scripted demo scenarios for the Gia ops console: the two guided workflows (concierge and
// verified maintenance), the demo booking and tickets they create, and the helpers that derive a
// ticket's state from how far each scenario has been stepped through. Everything here is
// illustrative; live bookings, chats and tickets come from the backend (see live.js).

export const NODE_W = 210;
export const NODE_H = 98;

// Node types on the workflow canvas.
export const TM = {
  trigger: { label: 'Trigger', c: '#292725', bg: '#F1EBE6', shape: 'circle' },
  ai: { label: 'Gia · AI', c: '#B93832', bg: '#F8E9E2', shape: 'circle' },
  decision: { label: 'Decision', c: '#94600F', bg: '#F6EAD5', shape: 'diamond' },
  oi: { label: 'OI system', c: '#4F6475', bg: '#E7ECEF', shape: 'square' },
  human: { label: 'Human', c: '#292725', bg: '#E9DFD6', shape: 'square' },
  comms: { label: 'WhatsApp', c: '#8A5A44', bg: '#F3E7DF', shape: 'pill' },
  verify: { label: 'Verification', c: '#53735E', bg: '#E6EEE7', shape: 'diamond' },
  end: { label: 'Outcome', c: '#292725', bg: '#F1EBE6', shape: 'ring' }
};

// Marker shape per node type: [width, border-radius, transform].
export const SHAPES = {
  circle: ['9px', '50%', 'none'],
  diamond: ['9px', '1px', 'rotate(45deg)'],
  square: ['9px', '2px', 'none'],
  pill: ['15px', '9px', 'none'],
  ring: ['9px', '50%', 'none']
};

// Who did something, for activity feeds.
export const WHO = {
  ai: { label: 'AI', bg: '#F8E9E2', fg: '#9E2E29' },
  human: { label: 'Human', bg: '#292725', fg: '#FFFFFF' },
  system: { label: 'System', bg: '#E7ECEF', fg: '#3E5263' },
  guest: { label: 'Guest', bg: '#F3E7DF', fg: '#6E4532' }
};

const node = a => ({ id: a[0], type: a[1], who: a[2], x: a[3], y: a[4], title: a[5], sub: a[6], actor: a[7], system: a[8], autonomy: a[9], inputs: a[10], outputs: a[11] });

export const GRAPHS = {
  concierge: {
    nodes: [
      ['t1', 'trigger', 'system', 40, 60, 'Booking confirmed', 'New booking lands in OI', 'OI event stream', 'OI · system of record', 'Automatic', ['Booking record'], ['Guest journey opened']],
      ['a1', 'ai', 'ai', 300, 60, 'Gia introduces herself', 'Welcome on WhatsApp, discloses she is AI', 'Gia', 'WhatsApp Business API', 'Autonomous · reversible', ['Guest name, villa, dates'], ['Welcome message logged in OI']],
      ['a2', 'ai', 'ai', 560, 60, 'Capture arrival & preferences', 'T-7 conversation, saved to profile', 'Gia', 'WhatsApp · OI guest profile', 'Autonomous · reversible', ['Guest replies'], ['Arrival details', 'Preferences on profile']],
      ['t2', 'trigger', 'guest', 820, 60, 'Guest message received', 'A request during the stay', 'Guest', 'WhatsApp Business API', 'Automatic', ['Inbound message'], ['Message routed to Gia']],
      ['a3', 'ai', 'ai', 1080, 60, 'Interpret the request', 'Intent, time, place, known preferences', 'Gia', 'Gia', 'Autonomous', ['Message', 'Guest profile'], ['Structured request']],
      ['d1', 'decision', 'ai', 1080, 270, 'Can the villa do this?', 'Checked before any promise', 'Gia', 'Villa capability DB · read-only', 'Autonomous · read-only', ['Structured request', 'Villa capabilities'], ['Yes → raise ticket', 'No → offer alternative']],
      ['o1', 'oi', 'ai', 820, 270, 'Create OI ticket', 'Logged with category and priority', 'Ops agent', 'OI', 'Autonomous · reversible', ['Structured request'], ['Ticket in OI']],
      ['o2', 'oi', 'ai', 560, 270, 'Assign villa team', 'Routed to the on-ground owner', 'Ops agent', 'OI', 'Autonomous · reversible', ['Ticket', 'Villa roster'], ['Owner and due time']],
      ['g1', 'comms', 'ai', 300, 270, 'Confirm to guest', 'What, who and when', 'Gia', 'WhatsApp Business API', 'Autonomous', ['Ticket owner and time'], ['Confirmation message']],
      ['h1', 'human', 'human', 40, 270, 'Team does the work', 'Physical setup at the villa', 'Villa team', 'Field app', 'Human only', ['Assigned task'], ['Status update in OI']],
      ['g2', 'comms', 'ai', 40, 480, 'Proactive update', 'Sent when OI status changes', 'Gia', 'WhatsApp Business API', 'Autonomous', ['OI status change'], ['Update message']],
      ['o3', 'oi', 'ai', 300, 480, 'Resolve and confirm', 'Completion confirmed with guest', 'Gia + villa team', 'OI · WhatsApp', 'Autonomous after team completion', ['Completion + photo'], ['Ticket resolved']],
      ['e1', 'end', 'system', 560, 480, 'Resolved · preference saved', 'Remembered for future stays', 'System', 'OI guest profile', 'Automatic', ['Stay events'], ['Updated guest profile']],
      ['g3', 'comms', 'ai', 1080, 480, 'Offer an alternative', 'Never promises the original', 'Gia', 'WhatsApp Business API', 'Autonomous', ['Capability gap'], ['Alternative offer']],
      ['h2', 'human', 'human', 1080, 690, 'Villa manager approval', 'Exceptions need a person', 'Villa manager', 'OI', 'Requires approval', ['Escalated ticket'], ['Approve or decline']],
      ['e2', 'end', 'system', 820, 690, 'Awaiting human decision', 'Escalated in OI', 'System', 'OI', 'Automatic', ['Escalation'], ['Owner notified']]
    ].map(node),
    edges: [['t1', 'a1'], ['a1', 'a2'], ['a2', 't2', 'During stay'], ['t2', 'a3'], ['a3', 'd1'], ['d1', 'o1', 'Yes'], ['d1', 'g3', 'No'], ['o1', 'o2'], ['o2', 'g1'], ['g1', 'h1'], ['h1', 'g2'], ['g2', 'o3'], ['o3', 'e1'], ['g3', 'h2'], ['h2', 'e2']]
  },
  field: {
    nodes: [
      ['r1', 'trigger', 'guest', 40, 60, 'Issue reported', 'Guest or villa team flags a problem', 'Guest', 'WhatsApp Business API', 'Automatic', ['Message or field report'], ['Issue routed to ops agent']],
      ['a1', 'ai', 'ai', 300, 60, 'Classify the issue', 'Category, severity, villa, room', 'Ops agent', 'Gia', 'Autonomous', ['Report text', 'Villa record'], ['Category and severity']],
      ['o1', 'oi', 'ai', 560, 60, 'Create OI ticket', 'With a proof-of-work checklist', 'Ops agent', 'OI', 'Autonomous · reversible', ['Classification'], ['Ticket + checklist']],
      ['o2', 'oi', 'ai', 820, 60, 'Assign on-ground team', 'Owner by category and villa', 'Ops agent', 'OI', 'Autonomous · reversible', ['Ticket', 'Villa roster'], ['Assignee and ETA']],
      ['g1', 'comms', 'ai', 1080, 60, 'Update guest with ETA', 'Who is coming and when', 'Gia', 'WhatsApp Business API', 'Autonomous', ['Assignee and ETA'], ['Guest message']],
      ['h1', 'human', 'human', 1080, 270, 'Physical repair', 'Work done on site', 'Maintenance team', 'Field app', 'Human only', ['Task and checklist'], ['Work marked complete (a claim)']],
      ['h2', 'human', 'human', 820, 270, 'Submit photo evidence', 'One photo per checklist item', 'Maintenance team', 'Field evidence flow', 'Human only', ['Checklist'], ['Photo set']],
      ['v1', 'verify', 'ai', 560, 270, 'Evaluate evidence', 'Does each photo prove the item?', 'Vision check', 'Field evidence flow · simulated here', 'Autonomous · reversible', ['Photo set', 'Checklist'], ['Accepted → close', 'Rejected → corrective action']],
      ['o3', 'oi', 'ai', 300, 270, 'Close ticket', 'Only after evidence is accepted', 'Ops agent', 'OI', 'Gated on accepted evidence', ['Accepted evidence'], ['Ticket resolved', 'Villa record updated']],
      ['g2', 'comms', 'ai', 40, 270, 'Confirm fix to guest', 'Closes the loop', 'Gia', 'WhatsApp Business API', 'Autonomous', ['Resolved ticket'], ['Guest message']],
      ['e1', 'end', 'system', 40, 480, 'Resolved · verified', 'Proof of work on record', 'System', 'OI', 'Automatic', ['Closure'], ['Audit record']],
      ['v2', 'verify', 'ai', 560, 480, 'Request corrective action', 'Clear reason and what to retake', 'Ops agent', 'Field app', 'Autonomous', ['Rejection reasons'], ['Rework request']],
      ['x1', 'human', 'human', 820, 480, 'Villa manager inspection', 'After a second rejection', 'Villa manager', 'OI', 'Human only', ['Evidence history'], ['On-site decision']],
      ['e2', 'end', 'system', 1080, 480, 'Escalated', 'A person owns the outcome', 'System', 'OI', 'Automatic', ['Escalation'], ['Owner notified']]
    ].map(node),
    edges: [['r1', 'a1'], ['a1', 'o1'], ['o1', 'o2'], ['o2', 'g1'], ['g1', 'h1'], ['h1', 'h2'], ['h2', 'v1'], ['v1', 'o3', 'Accepted'], ['o3', 'g2'], ['g2', 'e1'], ['v1', 'v2', 'Rejected'], ['v2', 'h2', 'Resubmit'], ['v2', 'x1', '2nd rejection'], ['x1', 'e2']]
  }
};

export function defaultPositions(wf) {
  const o = {};
  GRAPHS[wf].nodes.forEach(n => { o[n.id] = { x: n.x, y: n.y }; });
  return o;
}

const nodeOf = (wf, id) => GRAPHS[wf].nodes.find(n => n.id === id);

// "10-08 09:00" -> "8 Oct"
export function dayLabel(key) {
  const md = key.split(' ')[0];
  const [m, d] = md.split('-');
  return (+d) + ' ' + ({ '09': 'Sep', '10': 'Oct' })[m];
}

// One scripted step: k is "MM-DD HH:MM", node is the canvas node it lights up.
function step(wf, k, nodeId, title, extra) {
  const n = nodeOf(wf, nodeId);
  return Object.assign({ k, node: nodeId, title, d: dayLabel(k), t: k.split(' ')[1], who: n ? n.who : 'system' }, extra || {});
}

const stepCache = {};

// Use case 1: the concierge journey. Branch 'yes' = villa can fulfil, 'no' = needs approval.
export function conciergeSteps(branch) {
  const key = 'c:' + branch;
  if (stepCache[key]) return stepCache[key];
  const S = (k, n, t, o) => step('concierge', k, n, t, o);
  const base = [
    S('09-22 11:04', 't1', 'Booking confirmed', { event: 'LS-BK-24117 confirmed in OI · Villa Serena · 9–13 Oct · 2 adults, 2 children.', feed: 'Booking LS-BK-24117 confirmed for Ananya Mehra' }),
    S('09-22 11:05', 'a1', 'Gia introduces herself', { msgs: [['gia', 'Hello Ananya, I’m Gia, Lohono’s AI concierge for your stay at Villa Serena. I’ll look after you from now until after you check out — message me any time here.']], event: 'Welcome sent on booking confirmation and logged against the booking.', feed: 'Gia sent welcome to Ananya Mehra' }),
    S('10-02 10:30', 'a2', 'Arrival & preferences captured', { msgs: [['gia', 'Your stay is a week away! When do you expect to arrive, and is there anything we should know — dietary needs, allergies or occasions?'], ['guest', 'We’ll drive down from Mumbai and reach around 4 pm on the 9th. Two kids, 6 and 9. We’re vegetarian and my son has a nut allergy.'], ['gia', 'Thank you — noted: arriving around 4 pm by car, vegetarian meals, and nut-free for your son. This is on the arrival brief for the villa team.']], prefs: ['Vegetarian', 'Nut allergy · son, 9', 'Arrives by car'], event: 'T-7 conversation. 3 preferences and arrival time written to the guest profile and booking.', feed: 'Gia saved arrival details and 3 preferences for Ananya Mehra' })
  ];
  const yes = [
    S('10-10 17:02', 't2', 'Guest message received', { msgs: [['guest', 'It’s our anniversary today! Could you arrange a cake and a small setup on the deck for 8 pm?']], feed: 'Ananya Mehra asked for an anniversary setup' }),
    S('10-10 17:02', 'a3', 'Request interpreted', { decision: 'Celebration setup · today, 8:00 pm · outdoor deck. Applying saved preferences: vegetarian, nut-free.' }),
    S('10-10 17:02', 'd1', 'Villa capabilities checked', { decision: 'Villa Serena lists an outdoor deck, a celebration decor kit and a partner bakery. Gia can promise this.', caps: true }),
    S('10-10 17:03', 'o1', 'OI ticket created', { ticket: { status: 'Open' }, chip: 'OI-5521 created · Guest request', event: 'OI-5521 · Anniversary setup · Villa Serena · Normal priority.', feed: 'Ops agent created OI-5521 · Anniversary setup' }),
    S('10-10 17:03', 'o2', 'Assigned to villa team', { ticket: { status: 'Assigned', owner: 'Ramesh Patil · Caretaker' }, chip: 'OI-5521 assigned to Ramesh Patil', event: 'Routed to the Villa Serena caretaker; cake ordered from the partner bakery.', feed: 'OI-5521 assigned to Ramesh Patil' }),
    S('10-10 17:04', 'g1', 'Guest told what happens next', { msgs: [['gia', 'Happy anniversary! Ramesh will have the deck ready by 7:45 pm with candles, flowers and an eggless, nut-free chocolate cake. I’ll keep you posted.']], feed: 'Gia confirmed the plan with Ananya Mehra' }),
    S('10-10 18:40', 'h1', 'Team at work', { ticket: { status: 'In Progress' }, chip: 'OI-5521 · In Progress', event: 'Ramesh marked In Progress after collecting the cake.', feed: 'Ramesh Patil started OI-5521' }),
    S('10-10 18:41', 'g2', 'Proactive update sent', { msgs: [['gia', 'Quick update: the cake has been collected and Ramesh is setting up the deck now. Everything is on track for 8 pm.']], event: 'Sent automatically because OI-5521 moved to In Progress. The guest didn’t have to ask.', feed: 'Gia sent a proactive update to Ananya Mehra' }),
    S('10-10 19:44', 'o3', 'Completed and confirmed', { ticket: { status: 'Resolved' }, chip: 'OI-5521 resolved · setup photo attached', msgs: [['gia', 'Your deck is ready — enjoy your evening, Ananya. Ramesh will clear up whenever you’re done.'], ['guest', 'It looks beautiful. Thank you, Gia!']], event: 'Ramesh marked complete with a setup photo; Gia confirmed with the guest before closing.', feed: 'OI-5521 resolved and confirmed with guest' }),
    S('10-10 19:46', 'e1', 'Preference recorded', { prefs: ['Anniversary · 10 Oct', 'Enjoys deck dinners'], event: 'Saved to the guest profile for future stays.', feed: 'Gia saved anniversary date to Ananya Mehra’s profile' })
  ];
  const no = [
    S('10-10 17:02', 't2', 'Guest message received', { msgs: [['guest', 'It’s our anniversary today! Could you arrange some fireworks on the lawn at 8 pm?']], feed: 'Ananya Mehra asked for fireworks' }),
    S('10-10 17:02', 'a3', 'Request interpreted', { decision: 'Celebration with fireworks · today, 8:00 pm · lawn.' }),
    S('10-10 17:02', 'd1', 'Villa capabilities checked', { decision: 'Fireworks are not permitted at Villa Serena. Gia will not promise this and offers an alternative instead.', caps: true }),
    S('10-10 17:03', 'g3', 'Alternative offered', { msgs: [['gia', 'Happy anniversary! I’m sorry — fireworks aren’t permitted at Villa Serena. I could arrange a lantern-lit deck with a cake instead. Shall I check that with the villa manager?'], ['guest', 'Yes please, that sounds lovely.']], feed: 'Gia offered an alternative to Ananya Mehra' }),
    S('10-10 17:05', 'h2', 'Escalated for approval', { ticket: { status: 'Escalated', title: 'Lantern deck setup · alternative to fireworks', owner: 'Arjun Rao · Villa manager' }, chip: 'OI-5521 escalated to villa manager', event: 'Lanterns are outside the standard decor kit, so a person decides. Gia does not commit to exceptions or costs.', feed: 'OI-5521 escalated to Arjun Rao for approval' }),
    S('10-10 17:06', 'e2', 'Waiting on a person', { msgs: [['gia', 'I’ve passed this to Arjun, our villa manager. I’ll come back to you as soon as he confirms.']], event: 'Ticket stays Escalated until the villa manager approves or declines.' })
  ];
  stepCache[key] = base.concat(branch === 'yes' ? yes : no);
  return stepCache[key];
}

// Proof-of-work checklist for the basin leak.
export const CHECKLIST = { c1: 'Before — leak under the basin', c2: 'After — joint close-up, dry', c3: 'Tap running 30 s, no drip', c4: 'Cabinet base and floor dried' };
const ev = (k, ph, ok, why) => ({ k, label: CHECKLIST[k], ph, ok, why: why || '' });

// Use case 2: verified maintenance. Branch 'accept' = accepted on attempt 2, 'escalate' = rejected twice.
export function fieldSteps(branch) {
  const key = 'f:' + branch;
  if (stepCache[key]) return stepCache[key];
  const S = (k, n, t, o) => step('field', k, n, t, o);
  const a1 = [ev('c1', 'under basin · leak visible', true), ev('c2', 'joint close-up · blurred', false, 'Out of focus, with standing water on the cabinet base.'), ev('c3', 'basin · tap off', false, 'Tap is off, so the photo can’t show there’s no drip under flow.'), ev('c4', 'floor · dried', true)];
  const a2ok = [ev('c1', 'under basin · leak visible', true), ev('c2', 'joint close-up · dry', true), ev('c3', 'tap running · no drip', true), ev('c4', 'cabinet base · dry', true)];
  const a2bad = [ev('c1', 'under basin · leak visible', true), ev('c2', 'joint close-up · fresh moisture', false, 'Fresh moisture at the joint after drying — the leak may not be fixed.'), ev('c3', 'tap running', true), ev('c4', 'cabinet base · dry', true)];
  const base = [
    S('10-10 08:52', 'r1', 'Issue reported', { msgs: [['guest', 'Hi Gia, the basin in the second bedroom bathroom is leaking underneath. There’s water on the floor.']], feed: 'Rohan Desai reported a leak at Casa Alba' }),
    S('10-10 08:52', 'a1', 'Issue classified', { decision: 'Maintenance · Plumbing · Severity Medium — active leak, contained, no electrical risk mentioned. Casa Alba, Bedroom 2 bathroom.' }),
    S('10-10 08:53', 'o1', 'OI ticket created', { ticket: { status: 'Open' }, chip: 'OI-5534 created · Maintenance', msgs: [['gia', 'Sorry about that, Rohan. I’ve raised it with our maintenance team — your reference is OI-5534. I’ll tell you as soon as someone is on the way.']], event: 'Logged with a 4-item proof-of-work checklist.', feed: 'Ops agent created OI-5534 · Basin leak' }),
    S('10-10 08:55', 'o2', 'Assigned to maintenance', { ticket: { status: 'Assigned', owner: 'Santosh Naik · Maintenance' }, chip: 'OI-5534 assigned to Santosh Naik', feed: 'OI-5534 assigned to Santosh Naik' }),
    S('10-10 08:56', 'g1', 'Guest given an ETA', { msgs: [['gia', 'Santosh from our maintenance team will be with you by 10:30 am. He’ll need about 30 minutes in the bathroom.']] }),
    S('10-10 10:58', 'h1', 'Repair marked complete', { ticket: { status: 'In Progress' }, event: 'Santosh replaced the basin waste-pipe washer and marked the work complete. A completion claim is not verification.', feed: 'Santosh Naik marked repair complete (not yet verified)' }),
    S('10-10 11:02', 'h2', 'Evidence submitted · attempt 1', { ticket: { status: 'Awaiting Verification' }, evidence: { n: 1, result: 'Checking', items: a1 }, chip: 'OI-5534 · evidence submitted', feed: 'Santosh Naik submitted 4 photos for OI-5534' }),
    S('10-10 11:02', 'v1', 'Evidence rejected', { state: 'failed', evidence: { n: 1, result: 'Rejected', items: a1 }, decision: '2 of 4 checklist items aren’t proven by the photos. Closure is rejected and sent back with reasons.', feed: 'Vision check rejected OI-5534 · attempt 1' }),
    S('10-10 11:03', 'v2', 'Corrective action requested', { ticket: { status: 'In Progress' }, event: 'Sent to Santosh: dry the cabinet base, retake the joint close-up in good light, and photograph the tap running.', feed: 'Ops agent asked Santosh Naik to retake 2 photos' })
  ];
  const accept = [
    S('10-10 11:21', 'h2', 'Evidence resubmitted · attempt 2', { ticket: { status: 'Awaiting Verification' }, evidence: { n: 2, result: 'Checking', items: a2ok }, feed: 'Santosh Naik resubmitted evidence for OI-5534' }),
    S('10-10 11:21', 'v1', 'Evidence accepted', { evidence: { n: 2, result: 'Accepted', items: a2ok }, decision: 'All 4 checklist items are proven: joint dry, no drip with the tap running, cabinet and floor dry.', feed: 'Vision check accepted OI-5534 · attempt 2' }),
    S('10-10 11:22', 'o3', 'Ticket closed', { ticket: { status: 'Resolved' }, chip: 'OI-5534 resolved · evidence accepted', event: 'Closed in OI. Villa record updated: Casa Alba · Bedroom 2 basin washer replaced, 10 Oct.', feed: 'OI-5534 closed with verified evidence' }),
    S('10-10 11:23', 'g2', 'Guest told it’s fixed', { msgs: [['gia', 'All fixed, Rohan — the leak has been repaired and checked. Let me know if anything else needs attention.'], ['guest', 'That was quick, thanks!']] }),
    S('10-10 11:23', 'e1', 'Resolved · verified', { event: 'Work completed, evidence submitted, evidence accepted, ticket closed — each recorded separately.' })
  ];
  const escalate = [
    S('10-10 11:21', 'h2', 'Evidence resubmitted · attempt 2', { ticket: { status: 'Awaiting Verification' }, evidence: { n: 2, result: 'Checking', items: a2bad }, feed: 'Santosh Naik resubmitted evidence for OI-5534' }),
    S('10-10 11:21', 'v1', 'Evidence rejected again', { state: 'failed', evidence: { n: 2, result: 'Rejected', items: a2bad }, decision: 'Moisture reappeared at the joint after drying. A second rejection means the agent stops retrying.', feed: 'Vision check rejected OI-5534 · attempt 2' }),
    S('10-10 11:22', 'x1', 'Escalated to villa manager', { ticket: { status: 'Escalated', owner: 'Francis D’Souza · Villa manager' }, chip: 'OI-5534 escalated to villa manager', event: 'Possible ongoing leak. Routed to a person for an on-site inspection.', feed: 'OI-5534 escalated to Francis D’Souza' }),
    S('10-10 11:23', 'e2', 'A person owns it', { msgs: [['gia', 'Rohan, this needs a second look. Francis, our villa manager, will inspect it personally within the hour.']] })
  ];
  stepCache[key] = base.concat(branch === 'accept' ? accept : escalate);
  return stepCache[key];
}

// Field-flow step indexes the phone mock and the attention list key off.
export const F = { ASSIGNED: 3, ETA: 4, CLAIMED: 5, SUBMITTED: 6, REJECTED: 7, REWORK: 8, RESUBMITTED: 9, VERDICT: 10, CLOSED: 11, GUEST_TOLD: 12 };

export function statusPill(s) {
  const m = {
    'Open': ['#E7ECEF', '#3E5263', '○'],
    'Assigned': ['#E7ECEF', '#3E5263', '◐'],
    'In Progress': ['#F6EAD5', '#6B440B', '◔'],
    'Awaiting Verification': ['#F6EAD5', '#6B440B', '◎'],
    'Escalated': ['#F6DCD8', '#9E2E29', '▲'],
    'Resolved': ['#E6EEE7', '#2F4A38', '✓']
  }[s] || ['#F1EBE6', '#6E6762', '·'];
  return { bg: m[0], fg: m[1], icon: m[2] };
}

export const DEMO_VILLA = { name: 'Villa Serena', loc: 'Assagao Hills, North Goa', code: 'GOA-ASG-01', caps: [['Outdoor deck', 1, ''], ['Celebration decor kit', 1, ''], ['Partner bakery', 1, 'Assagao'], ['In-villa chef', 1, 'On request'], ['Fireworks', 0, 'Not permitted']] };

export const capRows = caps => caps.map(c => ({ k: c[0], glyph: c[1] ? '✓' : '✕', color: c[1] ? '#53735E' : '#B93832', note: c[2] }));

// The demo guest. cCur is the concierge step index; her stage and arrival depend on it.
export function demoBooking(cCur) {
  return { id: 'LS-BK-24117', name: 'Ananya Mehra', villa: 'Villa Serena', dates: '9–13 Oct', stage: cCur >= 3 ? 'In stay' : 'Pre-arrival', phone: '+91 98•• •••417', party: '2 adults · 2 children', arrival: cCur >= 2 ? '9 Oct · ~4 pm · by car' : 'Not shared yet' };
}

// Replays steps[0..upto] onto a ticket: null until the first step that touches it.
export function deriveTicket(base, steps, upto) {
  let t = null;
  const hist = [];
  for (let i = 0; i <= upto && i < steps.length; i++) {
    const s = steps[i];
    if (s.ticket) {
      t = Object.assign(t || Object.assign({}, base), s.ticket);
      t.updated = s.t;
      hist.push({ time: s.t, title: s.title, text: s.event || ('Status: ' + t.status) });
    } else if (t && (s.event || s.decision)) hist.push({ time: s.t, title: s.title, text: s.event || s.decision });
    else if (t && s.evidence) hist.push({ time: s.t, title: s.title, text: 'Evidence attempt ' + s.evidence.n });
  }
  if (t) t.history = hist;
  return t;
}

export const SCENARIO_TICKETS = {
  concierge: { id: 'OI-5521', title: 'Anniversary setup · deck, 8 pm', owner: 'Unassigned' },
  field: { id: 'OI-5534', title: 'Basin leak · Bedroom 2 bathroom', owner: 'Unassigned' }
};

// The two scenario tickets, at the state their scenario has reached (null until raised).
export function scenarioTickets(cS, cCur, fS, fCur) {
  const out = [];
  const ct = deriveTicket(Object.assign({ booking: 'demo', villa: 'Villa Serena', cat: 'Guest request', sev: 'Normal', origin: 'Guest via WhatsApp', flow: ['Open', 'Assigned', 'In Progress', 'Resolved'] }, SCENARIO_TICKETS.concierge), cS, cCur);
  if (ct) {
    const done = ct.status === 'Resolved', esc = ct.status === 'Escalated';
    ct.issue = cS[3].msgs[0][1];
    ct.checklist = esc
      ? [{ label: 'Villa manager decision', state: 'pending' }, { label: 'Guest informed of outcome', state: 'pending' }]
      : ['Deck cleared and dressed', 'Candles and flowers', 'Cake · eggless, nut-free', 'Setup photo for the guest'].map(l => ({ label: l, state: done ? 'ok' : 'pending' }));
    ct.attempts = [];
    ct.review = esc
      ? { tone: 'red', title: 'Waiting on villa manager', text: 'Gia doesn’t commit to exceptions or costs. Arjun Rao approves or declines.', simulated: false }
      : done
        ? { tone: 'green', title: 'Completed and confirmed', text: 'Ramesh shared a setup photo and the guest confirmed. Guest requests close on team completion plus guest confirmation.', simulated: false }
        : { tone: 'neutral', title: 'In hand', text: 'Gia updates the guest automatically on every status change.', simulated: false };
    ct.closure = esc ? [['Villa manager approves or declines', 0]] : [['Team marks complete with photo', done ? 1 : 0], ['Guest confirms', done ? 1 : 0]];
    if (esc) ct.humanReason = 'An exception to the villa’s standard offer — a villa manager decides.';
    out.push(ct);
  }

  const ft = deriveTicket(Object.assign({ booking: null, villa: 'Casa Alba', cat: 'Maintenance', sev: 'Medium', origin: 'Guest via WhatsApp', scenario: true, issue: fS[0].msgs[0][1], flow: ['Open', 'Assigned', 'In Progress', 'Awaiting Verification', 'Resolved'] }, SCENARIO_TICKETS.field), fS, fCur);
  if (ft) {
    const at = [];
    fS.slice(0, fCur + 1).forEach(s => {
      if (!s.evidence) return;
      const rec = { n: s.evidence.n, time: s.t, result: s.evidence.result, items: s.evidence.items };
      const ex = at.find(a => a.n === s.evidence.n);
      if (ex) Object.assign(ex, rec); else at.push(rec);
    });
    const last = at[at.length - 1];
    const accepted = at.some(a => a.result === 'Accepted');
    ft.attempts = at.slice().reverse();
    ft.checklist = ['c1', 'c2', 'c3', 'c4'].map(k => {
      if (!last) return { label: CHECKLIST[k], state: 'pending' };
      const it = last.items.find(x => x.k === k);
      return { label: CHECKLIST[k], state: last.result === 'Checking' ? 'submitted' : it.ok ? 'ok' : 'rejected' };
    });
    if (!last) ft.review = { tone: 'neutral', title: fCur >= F.CLAIMED ? 'Work claimed complete — no evidence yet' : 'Waiting for the work', text: 'A completion claim is not verification. The ticket closes only after photo evidence is accepted.', simulated: false };
    else if (last.result === 'Checking') ft.review = { tone: 'amber', title: 'Checking evidence · attempt ' + last.n, text: 'Each photo is compared against its checklist item.', simulated: true };
    else if (last.result === 'Rejected') ft.review = { tone: 'red', title: 'Evidence rejected · attempt ' + last.n, text: last.items.filter(x => !x.ok).map(x => x.label + ': ' + x.why).join(' ') + (ft.status === 'Escalated' ? ' Second rejection — escalated to the villa manager.' : ' Sent back to Santosh with what to retake.'), simulated: true };
    else ft.review = { tone: 'green', title: 'Evidence accepted · attempt ' + last.n, text: 'All 4 checklist items are proven by matching photos.', simulated: true };
    ft.tracker = [['Work completed', fCur >= F.CLAIMED], ['Evidence submitted', fCur >= F.SUBMITTED], ['Evidence accepted', accepted], ['Ticket closed', ft.status === 'Resolved']];
    ft.closure = [['Assignee marks work complete', fCur >= F.CLAIMED ? 1 : 0], ['A photo for every checklist item', at.length ? 1 : 0], ['Evidence accepted', accepted ? 1 : 0], ['Guest informed', fCur >= F.GUEST_TOLD && fS[F.GUEST_TOLD].node === 'g2' ? 1 : 0]];
    if (ft.status === 'Escalated') ft.humanReason = 'Two rejected attempts. The agent stops retrying; Francis D’Souza inspects on site.';
    out.push(ft);
  }
  return out;
}

const SEVERITY = { High: ['#9E2E29', '▲'], Medium: ['#94600F', '◆'], Low: ['#6E6762', '·'], Normal: ['#6E6762', '·'] };
const CHECK_STATE = { ok: ['✓', '#53735E', 'Done'], rejected: ['✕', '#B93832', 'Rejected'], submitted: ['◎', '#94600F', 'Checking'], pending: ['○', '#9A918A', 'To do'] };
const REVIEW_TONE = { green: ['#E6EEE7', '#2F4A38', '#C9D9CC'], red: ['#FBEDEA', '#9E2E29', '#F0CFC9'], amber: ['#FBF3E4', '#6B440B', '#EFDDBA'], dark: ['#F1EBE6', '#292725', '#D9CCC1'], neutral: ['#F8F3EF', '#292725', '#E8DDD4'] };
export const EVIDENCE_RESULT = { Checking: ['#F6EAD5', '#6B440B'], Rejected: ['#F6DCD8', '#9E2E29'], Accepted: ['#E6EEE7', '#2F4A38'] };

// Adds everything the ticket views need to draw a ticket: colours, glyphs, progress bars.
export function decorateTicket(t) {
  let list = t.flow.slice(), idx = list.indexOf(t.status);
  if (t.status === 'Escalated') {
    list = t.flow.filter(x => x !== 'Resolved' && x !== 'Awaiting Verification').concat(['Escalated']);
    idx = list.length - 1;
  }
  const sev = SEVERITY[t.sev] || ['#6E6762', '·'];
  const RT = REVIEW_TONE[t.review.tone];
  const verified = ['Awaiting Verification', 'Resolved'].includes(t.status);
  const tr = t.tracker || (t.flow.includes('Awaiting Verification')
    ? [['Work completed', verified], ['Evidence submitted', verified], ['Evidence accepted', t.status === 'Resolved'], ['Ticket closed', t.status === 'Resolved']]
    : null);
  return Object.assign({}, t, {
    pill: statusPill(t.status), sevColor: sev[0], sevGlyph: sev[1], ownerShort: t.owner.split(' · ')[0],
    flowItems: list.map((x, i) => ({ label: x === 'Awaiting Verification' ? 'Verify' : x, bg: i <= idx ? (x === 'Escalated' ? '#B93832' : i === idx ? '#292725' : '#53735E') : '#E8DDD4', fg: i <= idx ? '#292725' : '#9A918A' })),
    checklist: t.checklist.map(c => ({ label: c.label, glyph: CHECK_STATE[c.state][0], color: CHECK_STATE[c.state][1], stateLabel: CHECK_STATE[c.state][2] })),
    closure: t.closure.map(c => ({ label: c[0], glyph: c[1] ? '✓' : '○', color: c[1] ? '#53735E' : '#9A918A' })),
    attempts: t.attempts.map(a => {
      const R = EVIDENCE_RESULT[a.result];
      const chk = a.result === 'Checking';
      return {
        n: a.n, time: a.time, result: a.result, bg: R[0], fg: R[1],
        items: a.items.map(it => ({ label: it.label, ph: it.ph, glyph: chk ? '…' : it.ok ? '✓' : '✕', badgeBg: chk ? '#94600F' : it.ok ? '#53735E' : '#B93832', border: chk || it.ok ? '#E8DDD4' : '#E9B7B0', why: it.why || '', hasWhy: !chk && !it.ok }))
      };
    }),
    review: { title: t.review.title, text: t.review.text, simulated: t.review.simulated, bg: RT[0], fg: RT[1], border: RT[2] },
    tracker: tr && tr.map(k => ({ label: k[0], glyph: k[1] ? '✓' : '○', fg: k[1] ? '#2F4A38' : '#9A918A', bg: k[1] ? '#E6EEE7' : '#FFFFFF', border: k[1] ? '#C9D9CC' : '#E8DDD4' })),
    humanReason: t.humanReason || '',
    scenario: !!t.scenario, history: t.history || []
  });
}

// Bezier between two canvas nodes: horizontal when they share a row, vertical otherwise.
export function edgeGeometry(a, b) {
  const W = NODE_W, H = NODE_H;
  const ac = { x: a.x + W / 2, y: a.y + H / 2 }, bc = { x: b.x + W / 2, y: b.y + H / 2 };
  const dx = bc.x - ac.x, dy = bc.y - ac.y;
  let p1, p2, d;
  if (Math.abs(dy) < 80) {
    const s = dx > 0 ? 1 : -1;
    p1 = { x: ac.x + s * W / 2, y: ac.y };
    p2 = { x: bc.x - s * (W / 2 + 2), y: bc.y };
    const c = Math.max(30, Math.abs(p2.x - p1.x) / 2);
    d = `M${p1.x},${p1.y} C${p1.x + s * c},${p1.y} ${p2.x - s * c},${p2.y} ${p2.x},${p2.y}`;
  } else {
    const s = dy > 0 ? 1 : -1;
    p1 = { x: ac.x, y: ac.y + s * H / 2 };
    p2 = { x: bc.x, y: bc.y - s * (H / 2 + 2) };
    const c = Math.max(30, Math.abs(p2.y - p1.y) / 2);
    d = `M${p1.x},${p1.y} C${p1.x},${p1.y + s * c} ${p2.x},${p2.y - s * c} ${p2.x},${p2.y}`;
  }
  return { d, mx: (p1.x + p2.x) / 2, my: (p1.y + p2.y) / 2 };
}
