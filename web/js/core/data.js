// ─── Data ─────────────────────────────────────────────────────────────────────
export const AGENTS = [
  {name:'Emma Clarke', initials:'EC', role:'Admin',        active:true},
  {name:'James Webb',  initials:'JW', role:'Senior Agent', active:true},
  {name:'Sofia Reyes', initials:'SR', role:'Read Only',    active:true},
  {name:'Priya Nair',  initials:'PN', role:'Senior Agent', active:true, oooFrom:'2026-05-04', oooTo:'2026-05-08', oooNote:'Annual leave — back Friday'},
  {name:'Tom Bates',   initials:'TB', role:'Senior Agent', active:true},
];

export const CUSTOMERS = [
  {id:'M001',first:'Sarah',last:'Mitchell',username:'smitchell',email:'sarah.m@acme.com',mobile:'+44 7700 100001',emails:[{id:null,value:'sarah.m@acme.com',is_primary:true},{id:null,value:'sarah.mitchell@gmail.com',is_primary:false}],brand:'Acme Corp',vip:'Gold',jurisdiction:'UK',maestroUserId:'7f3a9c2e-demo-0001',memberId:'1001',consent:true,since:'2023-01-15',bo:'https://backoffice.example.com/M001',custom:{}},
  {id:'M002',first:'James',last:'Reed',username:'jreed',email:'james.r@globex.io',mobile:'+44 7700 100002',brand:'Globex',vip:'Silver',jurisdiction:'IE',maestroUserId:'',memberId:'',consent:true,since:'2022-11-03',bo:'https://backoffice.example.com/M002',custom:{}},
  {id:'M003',first:'Nina',last:'Kowalski',username:'nina_k',email:'nina@initech.com',mobile:'+49 151 20000003',brand:'Initech',vip:'Platinum',jurisdiction:'DE',maestroUserId:'',memberId:'',consent:false,since:'2021-06-20',bo:'https://backoffice.example.com/M003',custom:{}},
  {id:'M004',first:'Tom',last:'Brewer',username:'tbrewer',email:'tom@umbrella.co',mobile:'+44 7700 100004',brand:'Umbrella',vip:'Bronze',jurisdiction:'UK',maestroUserId:'',memberId:'',consent:true,since:'2023-08-11',bo:'https://backoffice.example.com/M004',custom:{}},
  {id:'M005',first:'Priya',last:'Sharma',username:'psharma',email:'priya@nakatomi.jp',mobile:'+81 90 0000 0005',brand:'Nakatomi',vip:'Gold',jurisdiction:'JP',maestroUserId:'',memberId:'',consent:true,since:'2020-03-07',bo:'https://backoffice.example.com/M005',custom:{}},
  {id:'M006',first:'Carlos',last:'Diaz',username:'cdiaz',email:'carlos@tyrell.com',mobile:'+1 415 000 0006',brand:'Tyrell',vip:'Silver',jurisdiction:'US',maestroUserId:'',memberId:'',consent:true,since:'2023-04-22',bo:'https://backoffice.example.com/M006',custom:{}},
];

export const TICKETS = [
  {id:'TK-001',subject:'Payment not processing at checkout',customerId:'M001',status:'escalated',priority:'urgent',category:'Billing',agent:'Emma Clarke',created:'2025-04-16',updated:'2 min ago',sla:'breach',tags:['billing','payment'],aiTags:[{tag:'urgent-billing',conf:94,accepted:false},{tag:'checkout-issue',conf:87,accepted:false}],csat:null,
    msgs:[
      {from:'Sarah Mitchell',r:'customer',t:'Hi, I\'ve been trying to checkout for the past hour but my payment keeps failing. Tried two different cards. I need this order urgently.',ts:'09:12'},
      {from:'AI Agent',r:'ai',t:'Hi Sarah, I can see a temporary fraud-protection hold on transactions over £200 on your account. I\'ve escalated this to our payments team for immediate review. In the meantime, could you try PayPal as an alternative? You should hear back within 30 minutes.',ts:'09:12'},
      {from:'Sarah Mitchell',r:'customer',t:'PayPal doesn\'t work for me. This is really urgent, I have a deadline.',ts:'09:35'},
    ]},
  {id:'TK-002',subject:'Export transaction history to CSV',customerId:'M002',status:'open',priority:'normal',category:'Technical',agent:'James Webb',created:'2025-04-16',updated:'14 min ago',sla:'ok',tags:['export','data'],aiTags:[{tag:'data-export',conf:91,accepted:false}],csat:null,
    msgs:[
      {from:'James Reed',r:'customer',t:'I need to export all my transaction history to CSV for my accountant. Can\'t find the option anywhere in the dashboard settings.',ts:'09:00'},
    ]},
  {id:'TK-003',subject:'Account locked after password reset',customerId:'M003',status:'open',priority:'high',category:'Account',agent:'Emma Clarke',created:'2025-04-16',updated:'1h ago',sla:'warn',tags:['account','login'],aiTags:[{tag:'account-lock',conf:97,accepted:true}],csat:null,
    msgs:[
      {from:'Nina Kowalski',r:'customer',t:'I reset my password but now my account is locked. I have a client presentation in 2 hours and really need access.',ts:'08:15'},
      {from:'James Webb',r:'agent',t:'Hi Nina, the lockout triggers automatically after 3 failed attempts during the reset flow — I\'m unlocking it now. Please try again in 2 minutes.',ts:'08:22'},
    ]},
  {id:'TK-004',subject:'Resend March 2025 invoice',customerId:'M004',status:'pending',priority:'normal',category:'Billing',agent:'Sofia Reyes',created:'2025-04-16',updated:'3h ago',sla:'ok',tags:['invoice','billing'],aiTags:[{tag:'invoice-request',conf:99,accepted:true}],csat:null,
    msgs:[
      {from:'Tom Brewer',r:'customer',t:'Could you resend the invoice for March 2025? I\'ve accidentally deleted the email and need it for our quarterly accounts.',ts:'07:00',html:"<p>Could you resend the invoice for <b>March 2025</b>? I&#39;ve accidentally deleted the email and need it for our quarterly accounts.</p><p>Here is the one I already have:</p><img src=\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAICAYAAADruLXPAAAAO0lEQVR42mP8//8/AzWBEUljVAOsGYbAaBhoDaNhoDWMhoHWMBoGWsNoGGgNo2GgNYyGgdYwGgZaAwCPqQv1qJ2sBAAAAABJRU5ErkJggg==\" alt=\"invoice thumbnail\" width=\"120\">",attachments:[{"id":"demo-att-1","filename":"invoice-feb-2025.pdf","size_bytes":218112,"mime_type":"application/pdf","is_inline":false,"disposition":"attachment","url":null},{"id":"demo-att-2","filename":"thumbnail.png","size_bytes":14233,"mime_type":"image/png","is_inline":true,"disposition":"inline","url":null}]},
    ]},
  {id:'TK-005',subject:'GDPR data erasure request',customerId:'M005',status:'gdpr',priority:'high',category:'GDPR',agent:'Emma Clarke',created:'2025-04-15',updated:'1d ago',sla:'warn',tags:['gdpr','erasure'],aiTags:[{tag:'gdpr-erasure',conf:100,accepted:true}],csat:null,
    msgs:[
      {from:'Priya Sharma',r:'customer',t:'I am formally requesting erasure of all my personal data under GDPR Article 17. Please confirm within the statutory timeframe.',ts:'14:00'},
    ]},
  {id:'TK-006',subject:'Bulk user import feature request',customerId:'M005',status:'resolved',priority:'low',category:'Feature',agent:'Tom Bates',created:'2025-04-14',updated:'2d ago',sla:'ok',tags:['feature-request'],aiTags:[{tag:'feature-request',conf:95,accepted:true}],csat:4,csatStars:4,csatSubmittedAt:'2025-04-14',csatRequestedAt:'2025-04-14',csatComment:'Quick acknowledgement and clear roadmap. Would have liked an exact ETA.',timeEntries:[{id:'TE-A1B2C3',agent:'Tom Bates',minutes:25,note:'Logged feature request, replied to customer',billable:true,ts:'2025-04-14 11:05'}],
    msgs:[
      {from:'Priya Sharma',r:'customer',t:'It would be really helpful to import users in bulk via CSV rather than one by one. We have 200+ users to migrate.',ts:'11:00'},
      {from:'AI Agent',r:'ai',t:'Thanks Priya — logged as high-priority. It\'s on the Q3 roadmap and you\'ll be notified when it ships.',ts:'11:01'},
    ]},
  {id:'TK-007',subject:'iOS app very slow on iPhone 14',customerId:'M006',status:'resolved',priority:'normal',category:'Technical',agent:'James Webb',created:'2025-04-14',updated:'2d ago',sla:'ok',tags:['mobile','performance'],aiTags:[{tag:'mobile-bug',conf:88,accepted:true}],csat:5,csatStars:5,csatSubmittedAt:'2025-04-14',csatRequestedAt:'2025-04-14',csatComment:'James was incredibly responsive and the fix worked first try. Best support I\'ve had.',timeEntries:[{id:'TE-D4E5F6',agent:'James Webb',minutes:45,note:'Reproduced on iPhone 14, traced to image cache',billable:true,ts:'2025-04-14 10:30'},{id:'TE-G7H8I9',agent:'James Webb',minutes:30,note:'Wrote test, deployed fix',billable:true,ts:'2025-04-14 13:15'}],
    msgs:[
      {from:'Carlos Diaz',r:'customer',t:'The mobile app is unusably slow on my iPhone 14. The dashboard takes 8+ seconds to load.',ts:'10:00'},
      {from:'AI Agent',r:'ai',t:'Hi Carlos, we patched a performance regression affecting iOS 17 devices earlier today in v4.2.1. Could you update the app?',ts:'10:01'},
    ]},
];

export const CUSTOM_FIELDS = [
  {id:'cf1',label:'Account Manager',type:'text',   entity:'customer', required:false, defaultValue:''},
  {id:'cf2',label:'Contract Value', type:'number', entity:'customer', required:false, defaultValue:''},
  {id:'cf3',label:'Renewal Date',   type:'date',   entity:'customer', required:false, defaultValue:''},
];

export const TAG_LIBRARY = [
  {tag:'billing',count:12,type:'manual',conf:null},
  {tag:'payment',count:8,type:'manual',conf:null},
  {tag:'account-lock',count:5,type:'ai',conf:97},
  {tag:'data-export',count:4,type:'ai',conf:91},
  {tag:'gdpr-erasure',count:3,type:'ai',conf:100},
  {tag:'invoice-request',count:7,type:'ai',conf:99},
  {tag:'mobile-bug',count:6,type:'ai',conf:88},
  {tag:'feature-request',count:9,type:'manual',conf:null},
  {tag:'urgent-billing',count:2,type:'ai',conf:94},
  {tag:'checkout-issue',count:3,type:'ai',conf:87},
];

export const SLA_POLICIES = [
  {id:'SLA-001', name:'Urgent · Billing',   priority:'urgent', category:'Billing',   firstResponseMin:15,  resolutionMin:240,   status:'active'},
  {id:'SLA-002', name:'Urgent · GDPR',      priority:'urgent', category:'GDPR',      firstResponseMin:30,  resolutionMin:4320,  status:'active'},
  {id:'SLA-003', name:'High · Default',     priority:'high',   category:'all',       firstResponseMin:60,  resolutionMin:1440,  status:'active'},
  {id:'SLA-004', name:'Normal · Default',   priority:'normal', category:'all',       firstResponseMin:240, resolutionMin:2880,  status:'active'},
  {id:'SLA-005', name:'Low · Default',      priority:'low',    category:'all',       firstResponseMin:480, resolutionMin:7200,  status:'inactive'},
];

// Auto-assignment rules applied on ticket creation (and via Run rules action).
// Rules are evaluated by ascending priority (1 wins over 2). The first matching
// active rule fires; round-robin rules cycle through their team.
export const ASSIGN_RULES = [
  {id:'AR-001', name:'Urgent · Billing → Sofia',  priority:1, status:'active',
   conditions:{priority:'urgent', category:'Billing', vip:'all'},
   assignment:{mode:'specific-agent', agent:'Sofia Reyes'},
   matchCount:9, lastMatchAt:'2025-04-15'},
  {id:'AR-002', name:'GDPR → Emma',               priority:2, status:'active',
   conditions:{priority:'all', category:'GDPR', vip:'all'},
   assignment:{mode:'specific-agent', agent:'Emma Clarke'},
   matchCount:4, lastMatchAt:'2025-04-15'},
  {id:'AR-003', name:'VIP gold → senior team',    priority:3, status:'active',
   conditions:{priority:'all', category:'all', vip:'Gold'},
   assignment:{mode:'least-busy', team:['Emma Clarke','Sofia Reyes']},
   matchCount:3, lastMatchAt:'2025-04-14'},
  {id:'AR-004', name:'Default round-robin',       priority:99, status:'active',
   conditions:{priority:'all', category:'all', vip:'all'},
   assignment:{mode:'round-robin', team:['Emma Clarke','James Webb','Sofia Reyes','Tom Bates']},
   matchCount:18, lastMatchAt:'2025-04-16'},
];
export const ASSIGN_RULES_RR_INDEX = {};

export const CANNED_RESPONSES = [
  { id:'TPL-001', name: 'Greeting',         category:'General',  text: 'Hi {name},\n\nThanks for reaching out — I\'ll take a look at this right away.' },
  { id:'TPL-002', name: 'Need more info',   category:'Triage',   text: 'To help me debug this, could you share:\n\n- Steps to reproduce the issue\n- The exact error message you\'re seeing\n- A screenshot if possible' },
  { id:'TPL-003', name: 'Escalating',       category:'Triage',   text: 'I\'m escalating this to our specialist team — you should hear back within the hour.' },
  { id:'TPL-004', name: 'Resolution',       category:'General',  text: 'I\'ve resolved this for you. Please let me know if anything else needs attention.' },
  { id:'TPL-005', name: 'Refund processed', category:'Billing',  text: 'Your refund has been processed and should appear in 3-5 business days. Apologies for any inconvenience.' },
  { id:'TPL-006', name: 'CSAT request',     category:'General',  text: 'When you have a moment, we\'d appreciate your feedback on this ticket. Your rating helps us improve our support.' },
];

export const TICKET_TEMPLATES = [
  {id:'TT-001', name:'Password reset request',         category:'Account',   priority:'normal', subject:'Password reset for [customer ID]',        body:'Customer is unable to log in after attempting a password reset. Please verify identity, unlock the account if necessary, and confirm the reset email has been delivered.'},
  {id:'TT-002', name:'Refund — duplicate charge',      category:'Billing',   priority:'high',   subject:'Duplicate charge — refund requested',     body:'Customer reports being charged twice for the same transaction. Verify in the payments system, raise a refund for the duplicate amount, and confirm via email when processed.'},
  {id:'TT-003', name:'GDPR data erasure request',      category:'GDPR',      priority:'high',   subject:'Article 17 erasure request from [customer]', body:'Formal GDPR Article 17 erasure request received. Acknowledge within 24h, run the erasure workflow, and confirm completion in writing within the statutory 30-day window.'},
  {id:'TT-004', name:'Mobile app — performance issue', category:'Technical', priority:'normal', subject:'Mobile app slow on [device]',             body:'Customer reports the mobile app is unusably slow. Capture device model, OS version, and app build. Cross-reference against known performance regressions; escalate to mobile team if not on a patched build.'},
  {id:'TT-005', name:'Feature request',                category:'Feature',   priority:'low',    subject:'Feature request: [short description]',    body:'Customer suggested a new feature. Capture the use case, expected behaviour, and any business impact. Add to the product backlog and acknowledge the customer with an expected review timeframe.'},
];

// Workspace ticket categories — {key, label, is_active}. Empty in the demo
// seed (the New-Ticket modal falls back to deriving categories from existing
// tickets/templates when this is empty); loadWorkspaceData() fills it from
// GET /api/v1/categories on real-auth sign-in. Mutated in place (see
// CLAUDE.md). Holds active AND inactive rows — consumers filter is_active.
export const CATEGORIES = [];

export const CHANNELS = [
  {id:'CH-001', name:'Support inbox',          type:'email',   address:'support@respovia.com',        status:'active',   defaultCategory:'all',       defaultAgent:'',                 volume30d:142, signature:'— Respovia Support'},
  {id:'CH-002', name:'Billing inbox',          type:'email',   address:'billing@respovia.com',        status:'active',   defaultCategory:'Billing',   defaultAgent:'Sofia Reyes',      volume30d:38,  signature:'— Respovia Billing'},
  {id:'CH-003', name:'Public help portal',     type:'webform', address:'respovia.com/help/contact',   status:'active',   defaultCategory:'all',       defaultAgent:'',                 volume30d:64,  signature:''},
  {id:'CH-004', name:'In-app chat widget',     type:'chat',    address:'widget://embed',              status:'active',   defaultCategory:'Technical', defaultAgent:'James Webb',       volume30d:212, signature:'Hi! Respovia live chat — how can we help?'},
  {id:'CH-005', name:'Partner API integration',type:'api',     address:'/api/v1/tickets',             status:'inactive', defaultCategory:'all',       defaultAgent:'',                 volume30d:0,   signature:''},
];

// The set of role names in the workspace. Bootstrap replaces this in place
// from the API (/api/v1/roles); the demo persona flow uses these seeds.
// Authorization is the binary is_admin flag enforced server-side — there is
// no granular per-permission grid.
export const ROLES = ['Admin', 'Senior Agent', 'Read Only'];

export const KB_ARTICLES = [
  {id:'KB-001', title:'How to reset your account password', category:'Account', author:'Emma Clarke', updated:'2025-04-10',
   body:`Lost access to your account? Follow these steps to regain it.\n\nStep 1: Click "Forgot password?" on the sign-in screen.\n\nStep 2: Enter your work email address and submit. The reset link is sent only to addresses on your organisation's allowlist.\n\nStep 3: Check your inbox for a reset link. The link expires after 30 minutes.\n\nStep 4: Set a new password — minimum 12 characters, must include a number and a symbol.\n\nIf you don't receive an email within 5 minutes, check your spam folder. If it's still missing, contact your administrator — your account may be temporarily locked after multiple failed attempts.`},
  {id:'KB-002', title:'Understanding SLA breach alerts', category:'Best Practices', author:'James Webb', updated:'2025-04-12',
   body:`SLA breaches indicate tickets that have exceeded their contractual response or resolution window. They appear as red badges in the ticket list, in the notifications bell, and on the dashboard KPI bar.\n\nWhen an SLA is in "warn" state, the ticket is approaching but has not yet missed its deadline. When it moves to "breach", customer-facing escalation paths typically engage automatically depending on workflow rules.\n\nTo prioritise effectively: filter the Tickets page by SLA status, then sort by Updated descending. Reach out to the customer first, then update the ticket status to acknowledge the breach internally.`},
  {id:'KB-003', title:'Submitting a GDPR data erasure request', category:'GDPR', author:'Sofia Reyes', updated:'2025-03-28',
   body:`Customers in the EU/UK have the right to request erasure of their personal data under Article 17 of the GDPR.\n\nWhen a ticket is flagged with category GDPR, the ticket sidebar exposes three actions: Request Erasure, Redact Data, and SAR Export.\n\nErasure is a hard delete and is irreversible. Redaction masks identifying fields in the ticket thread but preserves the audit trail. SAR Export packages all data held about the customer into a downloadable archive within 30 days, as required by law.\n\nAll GDPR actions are logged with the requesting agent's name and timestamp.`},
  {id:'KB-004', title:'Exporting transaction history to CSV', category:'Technical', author:'Priya Nair', updated:'2025-04-05',
   body:`Customers can export their transaction history as CSV from the customer portal.\n\nIn the agent UI, open the customer's profile from any ticket sidebar, then use the "Export" action. The CSV will be emailed to the customer's verified address within a few minutes.\n\nIf the customer reports the file did not arrive, first verify the email address is correct, then check whether the export job timed out — exports for accounts with more than 50,000 transactions are generated overnight.`},
  {id:'KB-005', title:'Setting up the Claude API key for AI Draft', category:'Getting Started', author:'Emma Clarke', updated:'2025-04-15',
   body:`The "AI Draft" button in the ticket composer uses the Anthropic Claude API to draft a reply based on the conversation history.\n\nTo enable it:\n\n1. Go to Settings → AI Assistant.\n2. Paste your Claude API key in the API key field. It should start with "sk-ant-".\n3. Choose a model. Sonnet 4.6 is the default and a good balance of speed and quality.\n\nThe key is stored locally in your browser via localStorage. It is never transmitted to our servers — requests go directly from your browser to api.anthropic.com.\n\nIf the API rejects your request, the composer surfaces the error message returned by Anthropic.`},
  {id:'KB-006', title:'Creating custom roles', category:'Best Practices', author:'Emma Clarke', updated:'2025-04-08',
   body:`Out of the box, this workspace ships with Admin, Senior Agent and Read Only roles. You can extend this for your team's needs.\n\nTo add a role: Roles → "+ Role". A role is either Admin (full access) or non-admin — access is governed by that single flag rather than a per-feature permission grid.\n\nThe Admin role is protected — you cannot delete or rename it, which prevents accidental self-lockout.`},
  {id:'KB-007', title:'Resending invoices and billing documents', category:'Billing', author:'Tom Bates', updated:'2025-04-02',
   body:`Customers occasionally request a resend of their invoice or other billing documents.\n\nFor invoices from the current and previous quarter, use the customer portal action — these are regenerated on demand.\n\nFor older documents, raise an internal billing ticket with the customer ID and the invoice month. The finance team typically responds within one business day.\n\nNever attach billing documents directly to support tickets — always send via the secure document portal to maintain the audit trail.`},
];

// ─── Setters ────────────────────────────────────────────────────────────────
// data.js is now an ES module. The const collections are mutated in place
// (.push/.splice and the bootstrap target.length=0 swap), so they read live
// across importers and need no setter.
