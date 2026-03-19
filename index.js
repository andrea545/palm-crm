const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const app = express();
app.use(cors());
app.use(express.json());
// ─── Config ──────────────────────────────────────────────────────────────────
const CONFIG = {
  apiKey:         process.env.MB_API_KEY         || '991c7812b5c7430a828e0d3dec2cb485',
  siteId:         process.env.MB_SITE_ID         || '-99',
  sourceName:     process.env.MB_SOURCE_NAME     || 'PSCCRM',
  sourcePassword: process.env.MB_SOURCE_PWD      || 'eh0z1tCPBF5GE2lTB5dV9dWSUSY=',
  mbUsername:     process.env.MB_USERNAME        || 'mindbodysandboxsite@gmail.com',
  mbPassword:     process.env.MB_PASSWORD        || 'Apitest1234',
  webhookSecret:  process.env.MB_WEBHOOK_SECRET  || 'palm-webhook-secret-2026',
  sendgridKey:    process.env.SENDGRID_API_KEY   || '',
  fromEmail:      process.env.FROM_EMAIL         || 'hello@palmsportingclub.com',
  fromName:       process.env.FROM_NAME          || 'Palm Sporting Club',
  squareToken:    (process.env.SQUARE_ACCESS_TOKEN || '').trim(),
  squareLocId:    (process.env.SQUARE_LOCATION_ID  || '').trim(),
  port:           process.env.PORT               || 3000,
};
const MB_BASE = 'https://api.mindbodyonline.com/public/v6';
// ─── Users ───────────────────────────────────────────────────────────────────
// Password: Hello999
const USERS = [
  { username: 'andrea', passwordHash: '96fbec87108641aebc24db0e94a859442b648e194d37f360cd8ae50a9e2236cc', role: 'owner', name: 'Andrea' },
  { username: 'staff1', passwordHash: '96fbec87108641aebc24db0e94a859442b648e194d37f360cd8ae50a9e2236cc', role: 'staff', name: 'Staff Member' },
];
// ─── Sessions ────────────────────────────────────────────────────────────────
const sessions = new Map();
function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    username: user.username, name: user.name, role: user.role,
    createdAt: Date.now(), expiresAt: Date.now() + 8 * 60 * 60 * 1000,
  });
  return token;
}
function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  return s;
}
function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'] || req.query._token;
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: 'Unauthorized' });
  req.session = session;
  next();
}
// ─── Auth routes ─────────────────────────────────────────────────────────────
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = USERS.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  if (hash !== user.passwordHash) return res.status(401).json({ error: 'Invalid username or password' });
  const token = createSession(user);
  res.json({ token, name: user.name, role: user.role, username: user.username });
});
app.post('/auth/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) sessions.delete(token);
  res.json({ ok: true });
});
app.get('/auth/me', (req, res) => {
  const token = req.headers['x-session-token'];
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ name: session.name, role: session.role, username: session.username });
});
// ─── Serve static files with cache-busting headers ──────────────────────────
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
// Health check endpoint for Railway
app.get('/api/health', (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  const session = getSession(sessionToken);
  const sseCount = (global.sseClients || []).length;
  if (sessionToken && !session) {
    return res.status(401).json({ status: 'unauthorized', message: 'Session expired' });
  }
  res.json({ status: 'ok', uptime: process.uptime(), authenticated: !!session, siteId: CONFIG.siteId, sseClients: sseCount });
});
app.get('/api/mb-test', async (req, res) => {
  try {
    const token = await getMBToken();
    res.json({ success: true, message: 'MindBody connected', siteId: CONFIG.siteId });
  } catch (err) {
    res.json({ success: false, error: err.message, siteId: CONFIG.siteId });
  }
});
app.get('/api/mb-debug', async (req, res) => {
  try {
    const mbToken = await getMBToken();
    const today = new Date().toISOString().split('T')[0];
    const ninetyDaysAgo = new Date(Date.now() - 90*24*60*60*1000).toISOString().split('T')[0];
    const [salesRes, classesRes, clientsRes, servicesRes] = await Promise.all([
      fetchWithTimeout(`${MB_BASE}/sale/sales?StartSaleDateTime=${ninetyDaysAgo}T00:00:00&EndSaleDateTime=${today}T23:59:59&Limit=5`, { headers: mbHeaders(mbToken) }, 12000),
      fetchWithTimeout(`${MB_BASE}/class/classes?StartDateTime=${ninetyDaysAgo}T00:00:00&EndDateTime=${today}T23:59:59&Limit=5`, { headers: mbHeaders(mbToken) }, 12000),
      fetchWithTimeout(`${MB_BASE}/client/clients?Limit=5`, { headers: mbHeaders(mbToken) }, 12000),
      fetchWithTimeout(`${MB_BASE}/client/clientservices?Limit=5`, { headers: mbHeaders(mbToken) }, 12000),
    ]);
    const sales = await salesRes.json();
    const classes = await classesRes.json();
    const clients = await clientsRes.json();
    const services = await servicesRes.json();

    // Show FULL first sale with all keys — critical for diagnosing revenue calculation
    const firstSale = (sales.Sales || [])[0];
    const firstClass = (classes.Classes || [])[0];
    const firstClient = (clients.Clients || [])[0];
    const firstService = (services.ClientServices || [])[0];

    res.json({
      // SALES — full first object + keys for verification
      salesCount: sales.Sales?.length || 0,
      salesTopLevelKeys: firstSale ? Object.keys(firstSale) : [],
      saleItemKeys: firstSale?.Items?.[0] ? Object.keys(firstSale.Items[0]) : (firstSale?.items?.[0] ? Object.keys(firstSale.items[0]) : []),
      salePaymentKeys: firstSale?.Payments?.[0] ? Object.keys(firstSale.Payments[0]) : (firstSale?.payments?.[0] ? Object.keys(firstSale.payments[0]) : []),
      firstSaleFull: firstSale || sales,

      // CLASSES — full first object
      classesCount: classes.Classes?.length || 0,
      classTopLevelKeys: firstClass ? Object.keys(firstClass) : [],
      firstClassFull: firstClass || classes,

      // CLIENTS — full first object (redact email)
      clientsCount: clients.Clients?.length || 0,
      clientTopLevelKeys: firstClient ? Object.keys(firstClient) : [],
      firstClientSample: firstClient ? {
        ...firstClient,
        Email: firstClient.Email ? '***@***' : null,
        LastName: firstClient.LastName ? firstClient.LastName[0] + '***' : null,
      } : clients,

      // CLIENT SERVICES — full first object
      servicesCount: services.ClientServices?.length || 0,
      serviceTopLevelKeys: firstService ? Object.keys(firstService) : [],
      firstServiceFull: firstService || services,

      // Error info
      salesError: sales.Error || sales.errors || null,
      classesError: classes.Error || classes.errors || null,
      clientsError: clients.Error || clients.errors || null,
      servicesError: services.Error || services.errors || null,
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use(express.static(__dirname));
// ─── MindBody token cache ─────────────────────────────────────────────────────
let tokenCache = { token: null, expires: 0 };
async function fetchWithTimeout(url, options, ms=5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch(e) {
    clearTimeout(id);
    throw e;
  }
}
async function getMBToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires) return tokenCache.token;
  console.log('[MB Auth] Attempting token issue for site:', CONFIG.siteId);
  const res = await fetchWithTimeout(`${MB_BASE}/usertoken/issue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'API-Key': CONFIG.apiKey,
      'SiteId': CONFIG.siteId,
      'SourceName': CONFIG.sourceName,
      'SourcePassword': CONFIG.sourcePassword,
    },
    body: JSON.stringify({ Username: CONFIG.mbUsername, Password: CONFIG.mbPassword }),
  }, 8000);
  const data = await res.json();
  console.log('[MB Auth] Response:', JSON.stringify(data).substring(0, 200));
  if (!data.AccessToken) throw new Error('MB auth failed: ' + (data.Error?.Message || data.Message || JSON.stringify(data)));
  tokenCache = { token: data.AccessToken, expires: Date.now() + 55 * 60 * 1000 };
  console.log('[MB Auth] Token obtained successfully');
  return tokenCache.token;
}
// ─── MindBody headers helper ──────────────────────────────────────────────────
function mbHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'API-Key': CONFIG.apiKey,
    'SiteId': CONFIG.siteId,
    'SourceName': CONFIG.sourceName,
    'SourcePassword': CONFIG.sourcePassword,
    'Authorization': token,
  };
}
// ─── MindBody proxy ───────────────────────────────────────────────────────────
app.all('/api/mb/*', requireAuth, async (req, res) => {
  try {
    const token = await getMBToken();
    const mbPath = req.params[0];
    const query = new URLSearchParams(req.query).toString();
    const url = `${MB_BASE}/${mbPath}${query ? '?' + query : ''}`;
    const mbRes = await fetchWithTimeout(url, {
      method: req.method,
      headers: mbHeaders(token),
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    }, 8000);
    const data = await mbRes.json();
    res.status(mbRes.status).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
// ─── Email Log (persisted to file so it survives redeploys) ─────────────────
const EMAIL_LOG_FILE = path.join(__dirname, '.email-log.json');
let emailLog = [];
// Load existing log on startup
try {
  if (fs.existsSync(EMAIL_LOG_FILE)) {
    emailLog = JSON.parse(fs.readFileSync(EMAIL_LOG_FILE, 'utf8'));
    console.log(`[email] Loaded ${emailLog.length} log entries from disk`);
  }
} catch (e) { console.error('[email] Failed to load log:', e.message); }
// Save log to disk (debounced)
let saveLogTimer = null;
function saveEmailLog() {
  if (saveLogTimer) clearTimeout(saveLogTimer);
  saveLogTimer = setTimeout(() => {
    try {
      fs.writeFileSync(EMAIL_LOG_FILE, JSON.stringify(emailLog.slice(0, 500)));
    } catch (e) { console.error('[email] Failed to save log:', e.message); }
  }, 1000);
}

// ─── Email sending via SendGrid ───────────────────────────────────────────────
async function sendEmail({ to, toName, subject, html, category, trigger }) {
  const logEntry = {
    id: crypto.randomUUID(),
    to, toName: toName || '',
    subject,
    category: category || 'automation',
    trigger: trigger || category || 'manual',
    sentAt: new Date().toISOString(),
    status: 'pending',
    sgMessageId: null,
    htmlPreview: html || '',
  };

  if (!CONFIG.sendgridKey) {
    console.log(`[email] No SendGrid key — would send to ${to}: ${subject}`);
    logEntry.status = 'simulated';
    emailLog.unshift(logEntry);
    if (emailLog.length > 500) emailLog.pop();
    saveEmailLog();
    return { ok: true, simulated: true, logId: logEntry.id };
  }

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${CONFIG.sendgridKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to, name: toName }] }],
      from: { email: CONFIG.fromEmail, name: CONFIG.fromName },
      subject,
      content: [{ type: 'text/html', value: html }],
      tracking_settings: {
        click_tracking: { enable: true, enable_text: false },
        open_tracking: { enable: true },
      },
      categories: [category || 'automation'],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[email] SendGrid error:', err);
    logEntry.status = 'failed';
    logEntry.error = err;
    emailLog.unshift(logEntry);
    if (emailLog.length > 500) emailLog.pop();
    saveEmailLog();
    return { ok: false, error: err, logId: logEntry.id };
  }

  // Capture SendGrid message ID from response headers
  const sgMsgId = res.headers.get('x-message-id');
  logEntry.status = 'sent';
  logEntry.sgMessageId = sgMsgId || null;
  emailLog.unshift(logEntry);
  if (emailLog.length > 500) emailLog.pop();
  saveEmailLog();

  console.log(`[email] Sent to ${to}: ${subject} (msgId: ${sgMsgId || 'n/a'})`);
  return { ok: true, logId: logEntry.id, sgMessageId: sgMsgId };
}

// ─── Email Log API ──────────────────────────────────────────────────────────
app.get('/api/email/log', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const category = req.query.category;
  const search = (req.query.search || '').toLowerCase();
  let filtered = emailLog;
  if (category) filtered = filtered.filter(e => e.category === category);
  if (search) filtered = filtered.filter(e =>
    (e.to || '').toLowerCase().includes(search) ||
    (e.toName || '').toLowerCase().includes(search) ||
    (e.subject || '').toLowerCase().includes(search)
  );
  // Strip full HTML from list to save bandwidth — use /api/email/log/:id for full preview
  const sliced = filtered.slice(offset, offset + limit).map(e => ({
    ...e,
    htmlPreview: undefined,
  }));
  res.json({
    total: filtered.length,
    offset,
    limit,
    emails: sliced,
  });
});

// Get single email log entry with full HTML preview
app.get('/api/email/log/:id', requireAuth, (req, res) => {
  const entry = emailLog.find(e => e.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  res.json(entry);
});

// SendGrid Activity — pull recent email activity (delivery, opens, clicks)
app.get('/api/email/activity', requireAuth, async (req, res) => {
  if (!CONFIG.sendgridKey) return res.json({ error: 'SendGrid not configured', messages: [] });
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    // Build date range: default last 30 days
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const startDate = thirtyDaysAgo.toISOString().split('.')[0] + 'Z';
    const endDate = now.toISOString().split('.')[0] + 'Z';
    const query = req.query.query || `from_email="${CONFIG.fromEmail}" AND last_event_time BETWEEN TIMESTAMP "${startDate}" AND TIMESTAMP "${endDate}"`;
    let url = `https://api.sendgrid.com/v3/messages?limit=${limit}&query=${encodeURIComponent(query)}`;
    console.log('[email-activity] Fetching SG activity:', url);
    const sgRes = await fetch(url, {
      headers: { 'Authorization': `Bearer ${CONFIG.sendgridKey}` },
    });
    const data = await sgRes.json();
    console.log('[email-activity] SG returned', (data.messages || []).length, 'messages');
    if (data.messages && data.messages.length > 0) {
      console.log('[email-activity] Sample SG message keys:', Object.keys(data.messages[0]).join(', '));
    }
    // Convert SendGrid messages to our log format
    const messages = (data.messages || []).map(m => ({
      id: m.msg_id || m.message_id || crypto.randomUUID(),
      to: m.to_email || m.to || m.recipient || '',
      toName: m.to_name || '',
      subject: m.subject || '',
      category: (m.categories || [])[0] || m.category || 'automation',
      trigger: (m.categories || [])[0] || m.category || 'automation',
      sentAt: m.last_event_time || m.processed_time || m.created || m.sent_at || new Date().toISOString(),
      status: m.status || 'delivered',
      sgMessageId: m.msg_id || m.message_id || null,
      sgStatus: m.status,
      opens: m.opens_count || 0,
      clicks: m.clicks_count || 0,
    }));
    res.json({ messages, total: messages.length });
  } catch (err) {
    console.error('[email-activity] Error:', err.message);
    res.json({ error: err.message, messages: [] });
  }
});

// Send/resend a specific template to a specific email
app.post('/api/email/send', requireAuth, async (req, res) => {
  const { to, toName, templateType } = req.body;
  if (!to) return res.status(400).json({ error: 'Email address required' });
  const templates = {
    welcome: EMAIL_TEMPLATES.welcome,
    introPackComplete: EMAIL_TEMPLATES.introPackComplete,
    membershipUpsell: EMAIL_TEMPLATES.membershipUpsell,
    lastCredit: EMAIL_TEMPLATES.lastCredit,
    winBack: EMAIL_TEMPLATES.winBack,
    birthday: EMAIL_TEMPLATES.birthday,
    firstVisit: EMAIL_TEMPLATES.firstVisit,
  };
  const tplFn = templates[templateType];
  if (!tplFn) return res.status(400).json({ error: `Unknown template: ${templateType}. Available: ${Object.keys(templates).join(', ')}` });
  const tpl = tplFn(toName || 'there');
  const result = await sendEmail({ to, toName, ...tpl, category: templateType, trigger: 'manual' });
  res.json(result);
});
// ─── Email templates ─────────────────────────────────────────────────────────
function emailWrapper(content) {
  return `<!DOCTYPE html><html><body style="font-family:Georgia,'Times New Roman',serif;background:#E8E5DC;margin:0;padding:30px 20px;">
<div style="max-width:580px;margin:0 auto;">
  <div style="text-align:center;padding:32px 0 24px;">
    <img src="https://images.squarespace-cdn.com/content/v1/65d13efed52d4e7d3ecca2ad/5001e330-ad2f-4883-809e-a6149e75c82b/Untitled+design+%282%29.png?format=400w" alt="Palm Sporting Club" style="width:140px;height:auto;" />
  </div>
  <div style="background:#fff;border-radius:12px;padding:36px 40px;border:1px solid #D6D3C8;">
    ${content}
    <div style="margin-top:32px;padding-top:20px;border-top:1px solid #E8E5DC;font-size:14px;color:#4A4A4A;line-height:1.8;">
      See you soon,<br>
      <span style="font-weight:600;color:#0D3D20;">PSC Team</span>
    </div>
  </div>
  <div style="text-align:center;padding:20px 0;font-size:11px;color:#8C8A82;font-family:-apple-system,sans-serif;">
    Palm Sporting Club · Oasis Business Center, Marbella<br>
    <a href="https://www.palmsportingclub.com" style="color:#0D3D20;">palmsportingclub.com</a> &nbsp;·&nbsp;
    <a href="https://wa.me/34687282994" style="color:#0D3D20;">WhatsApp</a> &nbsp;·&nbsp;
    <a href="#" style="color:#8C8A82;">Unsubscribe</a>
  </div>
</div>
</body></html>`;
}
const EMAIL_TEMPLATES = {
  introPackComplete: (name) => ({
    subject: `You crushed your intro pack — here's what's next`,
    html: emailWrapper(`
      <h2 style="font-size:20px;font-weight:600;color:#111827;margin-bottom:8px;">Amazing work, ${name}!</h2>
      <p style="color:#374151;line-height:1.7;margin-bottom:16px;">You've just completed all 3 classes in your intro pack — you're officially part of the Palm community!</p>
      <p style="color:#374151;line-height:1.7;margin-bottom:20px;">Ready to keep your momentum going? We'd love to have you back on the Megaformer.</p>
      <div style="background:#F0FDF4;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px;border:1px solid #BBF7D0;">
        <div style="font-size:13px;color:#166534;margin-bottom:6px;font-weight:500;">YOUR EXCLUSIVE DISCOUNT</div>
        <div style="font-size:32px;font-weight:700;color:#0D3D20;letter-spacing:2px;">PALM10</div>
        <div style="font-size:13px;color:#166534;margin-top:6px;">10% off a 5 or 10-class pack · Valid 7 days</div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:12px;">
        <a href="https://clients.mindbodyonline.com/classic/ws?studioid=5737970&stype=41&sTG=23&prodId=100004" style="flex:1;display:block;background:#0D3D20;color:#fff;text-decoration:none;padding:14px;border-radius:10px;text-align:center;font-weight:600;font-size:14px;">5-class pack →</a>
        <a href="https://clients.mindbodyonline.com/classic/ws?studioid=5737970&stype=41&sTG=23&prodId=100005" style="flex:1;display:block;background:#111827;color:#fff;text-decoration:none;padding:14px;border-radius:10px;text-align:center;font-weight:600;font-size:14px;">10-class pack →</a>
      </div>
      <p style="font-size:12px;color:#9CA3AF;text-align:center;">Use code PALM10 at checkout. One use per client.</p>
    `)
  }),
  membershipUpsell: (name) => ({
    subject: `You keep coming back — have you considered a membership?`,
    html: emailWrapper(`
      <h2 style="font-size:20px;font-weight:600;color:#111827;margin-bottom:8px;">You're a regular, ${name}!</h2>
      <p style="color:#374151;line-height:1.7;margin-bottom:16px;">You've now bought two 10-class packs — you're clearly hooked on Lagree (we don't blame you!).</p>
      <p style="color:#374151;line-height:1.7;margin-bottom:20px;">Have you thought about switching to a monthly membership? You'd save money, always have credits ready, and never have to think about topping up.</p>
      <div style="background:#EFF6FF;border-radius:12px;padding:20px;margin-bottom:20px;border:1px solid #BFDBFE;">
        <div style="font-size:13px;font-weight:600;color:#1E40AF;margin-bottom:10px;">MEMBERSHIP BENEFITS</div>
        <div style="font-size:13px;color:#1D4ED8;line-height:1.8;">
          ✓ Unlimited or fixed monthly classes<br>
          ✓ Better value than class packs<br>
          ✓ Priority booking<br>
          ✓ Cancel anytime
        </div>
      </div>
      <a href="https://clients.mindbodyonline.com/classic/ws?studioid=5737970&stype=40" style="display:block;background:#0D3D20;color:#fff;text-decoration:none;padding:14px;border-radius:10px;text-align:center;font-weight:600;font-size:15px;margin-bottom:12px;">View membership options →</a>
      <p style="font-size:13px;color:#6B7280;text-align:center;">Questions? Reply to this email or WhatsApp us at +34 687 28 29 94</p>
    `)
  }),
  lastCredit: (name) => ({
    subject: `That was your last credit — don't lose your momentum`,
    html: emailWrapper(`
      <h2 style="font-size:20px;font-weight:600;color:#111827;margin-bottom:8px;">Time to top up, ${name}!</h2>
      <p style="color:#374151;line-height:1.7;margin-bottom:16px;">You just used your last class credit — great work staying consistent!</p>
      <p style="color:#374151;line-height:1.7;margin-bottom:20px;">Don't let your streak fade. Grab a new pack now and keep your body moving.</p>
      <div style="display:flex;gap:10px;margin-bottom:20px;">
        <a href="https://clients.mindbodyonline.com/classic/ws?studioid=5737970&stype=41&sTG=23&prodId=100004" style="flex:1;display:block;background:#0D3D20;color:#fff;text-decoration:none;padding:14px;border-radius:10px;text-align:center;font-weight:600;font-size:14px;">5-class pack →</a>
        <a href="https://clients.mindbodyonline.com/classic/ws?studioid=5737970&stype=41&sTG=23&prodId=100005" style="flex:1;display:block;background:#111827;color:#fff;text-decoration:none;padding:14px;border-radius:10px;text-align:center;font-weight:600;font-size:14px;">10-class pack →</a>
      </div>
      <p style="font-size:13px;color:#6B7280;text-align:center;">Or book a class at <a href="https://www.palmsportingclub.com/reservations" style="color:#0D3D20;">palmsportingclub.com/reservations</a></p>
    `)
  }),
  welcome: (name) => ({
    subject: `Welcome to Palm Sporting Club, ${name}!`,
    html: emailWrapper(`
      <h2 style="font-size:20px;font-weight:600;color:#111827;margin-bottom:8px;">Welcome, ${name}!</h2>
      <p style="color:#374151;line-height:1.7;margin-bottom:16px;">We're so excited to have you join the Palm Sporting Club community in Marbella. You're about to discover why Lagree has become the most talked-about workout in the world.</p>
      <div style="background:#F0FDF4;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px;border:1px solid #BBF7D0;">
        <div style="font-size:13px;color:#166534;margin-bottom:6px;font-weight:500;">YOUR WELCOME OFFER</div>
        <div style="font-size:22px;font-weight:700;color:#0D3D20;margin-bottom:4px;">3-Class Intro Pack</div>
        <div style="font-size:13px;color:#166534;">The perfect way to try Lagree at a special intro price</div>
      </div>
      <a href="https://clients.mindbodyonline.com/classic/ws?studioid=5737970&stype=41&sTG=23&prodId=100016" style="display:block;background:#0D3D20;color:#fff;text-decoration:none;padding:14px;border-radius:10px;text-align:center;font-weight:600;font-size:15px;margin-bottom:8px;">Get your intro pack now →</a>
      <a href="https://www.palmsportingclub.com/reservations" style="display:block;color:#0D3D20;text-decoration:none;padding:10px;border-radius:10px;text-align:center;font-weight:500;font-size:14px;margin-bottom:16px;border:1px solid #0D3D20;">Book your first class →</a>
      <p style="color:#374151;line-height:1.7;margin-bottom:8px;font-size:13px;"><strong>What to expect:</strong></p>
      <p style="color:#6B7280;line-height:1.8;font-size:13px;margin-bottom:20px;">
        ✓ 50-minute full-body workout on the Megaformer<br>
        ✓ Suitable for all fitness levels<br>
        ✓ Small classes, expert instructors<br>
        ✓ Located in Oasis Business Center, Marbella
      </p>
      <p style="font-size:13px;color:#6B7280;text-align:center;">Any questions? WhatsApp us at <a href="https://wa.me/34687282994" style="color:#0D3D20;">+34 687 28 29 94</a></p>
    `)
  }),
  winBack: (name) => ({
    subject: `We miss you, ${name} — here's 10% off to come back`,
    html: emailWrapper(`
      <h2 style="font-size:20px;font-weight:600;color:#111827;margin-bottom:8px;">We miss you, ${name}!</h2>
      <p style="color:#374151;line-height:1.7;margin-bottom:16px;">It's been a little while since your last class at Palm Sporting Club. Your Megaformer is waiting — and your body will thank you for getting back on it.</p>
      <p style="color:#374151;line-height:1.7;margin-bottom:20px;">Lagree results come from consistency, and just one class is enough to feel the difference again. Come back this week and we'll make it worth your while.</p>
      <div style="background:#FEF3C7;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px;border:1px solid #FDE68A;">
        <div style="font-size:13px;color:#92400E;margin-bottom:6px;font-weight:500;">YOUR COMEBACK OFFER</div>
        <div style="font-size:32px;font-weight:700;color:#92400E;letter-spacing:2px;">COMEBACK10</div>
        <div style="font-size:13px;color:#92400E;margin-top:6px;">10% off any class pack · Valid 14 days</div>
      </div>
      <a href="https://clients.mindbodyonline.com/classic/ws?studioid=5737970&stype=41&sTG=23&prodId=100004" style="display:block;background:#0D3D20;color:#fff;text-decoration:none;padding:14px;border-radius:10px;text-align:center;font-weight:600;font-size:15px;margin-bottom:12px;">Come back to Palm →</a>
      <p style="font-size:13px;color:#6B7280;text-align:center;">Or book a class at <a href="https://www.palmsportingclub.com/reservations" style="color:#0D3D20;">palmsportingclub.com/reservations</a>. We'd love to see you again.</p>
    `)
  }),
  birthday: (name) => ({
    subject: `Happy birthday, ${name}! A gift from Palm Sporting Club`,
    html: emailWrapper(`
      <div style="text-align:center;margin-bottom:20px;">
        <span style="font-size:48px;">&#127874;</span>
      </div>
      <h2 style="font-size:20px;font-weight:600;color:#111827;margin-bottom:8px;text-align:center;">Happy Birthday, ${name}!</h2>
      <p style="color:#374151;line-height:1.7;margin-bottom:16px;text-align:center;">From everyone at Palm Sporting Club — wishing you an incredible day filled with happiness and good vibes.</p>
      <p style="color:#374151;line-height:1.7;margin-bottom:20px;text-align:center;">To celebrate, we have a little birthday treat for you. Because what better gift than investing in yourself?</p>
      <div style="background:#EDE9FE;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px;border:1px solid #DDD6FE;">
        <div style="font-size:13px;color:#5B21B6;margin-bottom:6px;font-weight:500;">YOUR BIRTHDAY GIFT</div>
        <div style="font-size:32px;font-weight:700;color:#5B21B6;letter-spacing:2px;">BDAY5</div>
        <div style="font-size:13px;color:#5B21B6;margin-top:6px;">5% off any class pack · Valid 14 days</div>
      </div>
      <a href="https://clients.mindbodyonline.com/classic/ws?studioid=5737970&stype=41&sTG=23" style="display:block;background:#0D3D20;color:#fff;text-decoration:none;padding:14px;border-radius:10px;text-align:center;font-weight:600;font-size:15px;margin-bottom:12px;">Treat yourself →</a>
      <p style="font-size:13px;color:#6B7280;text-align:center;">Enjoy your special day! &#127881;</p>
    `)
  }),
  firstVisit: (name) => ({
    subject: `You did it, ${name} — your Lagree journey starts now`,
    html: emailWrapper(`
      <h2 style="font-size:22px;font-weight:600;color:#111827;margin-bottom:12px;letter-spacing:-0.3px;">You just took your first step.</h2>
      <p style="color:#374151;line-height:1.8;margin-bottom:20px;">What you felt on the Megaformer today wasn't just a workout. It was the beginning of something — slow, controlled, and deeply effective.</p>
      <p style="color:#374151;line-height:1.8;margin-bottom:20px;">Here's what happens next:</p>
      <div style="border-left:3px solid #0D3D20;padding-left:20px;margin-bottom:24px;">
        <div style="margin-bottom:16px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:#0D3D20;margin-bottom:4px;">Weeks 1–2 · The Awakening</div>
          <p style="color:#4B5563;line-height:1.7;font-size:14px;margin:0;">Muscles you didn't know existed will make themselves known. That deep soreness? It means your slow-twitch fibres are firing for the first time.</p>
        </div>
        <div style="margin-bottom:16px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:#0D3D20;margin-bottom:4px;">Weeks 3–4 · The Shift</div>
          <p style="color:#4B5563;line-height:1.7;font-size:14px;margin:0;">The shaking stops. Movements feel intentional. You'll notice your posture changing — shoulders back, core engaged, even off the machine.</p>
        </div>
        <div>
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:#0D3D20;margin-bottom:4px;">Weeks 5–8 · The Transformation</div>
          <p style="color:#4B5563;line-height:1.7;font-size:14px;margin:0;">Longer, leaner lines. A stronger core. The sculpted definition that only comes from working muscles to true fatigue at slow tempo.</p>
        </div>
      </div>
      <div style="background:#F9FAFB;border-radius:12px;padding:20px;margin-bottom:24px;border:1px solid #E5E7EB;">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:#111827;margin-bottom:8px;">Why it works</div>
        <p style="color:#4B5563;line-height:1.7;font-size:14px;margin:0;">Low-impact, high-intensity. Each 50-minute session engages every major muscle group through slow, controlled movements under constant tension — burning fat, building lean muscle, and improving flexibility all at once. No jumping, no jarring, no wasted movement.</p>
      </div>
      <p style="color:#374151;line-height:1.8;margin-bottom:24px;">2–3 sessions per week for the fastest results. Consistency is what separates good from extraordinary.</p>
      <a href="https://www.palmsportingclub.com/reservations" style="display:block;background:#0D3D20;color:#fff;text-decoration:none;padding:14px;border-radius:10px;text-align:center;font-weight:600;font-size:15px;margin-bottom:12px;">Book your next class →</a>
    `)
  }),
};
// ─── Automation logic ─────────────────────────────────────────────────────────
async function handleAutomations(event) {
  const type = event.type;
  const rawPayload = event.payload;
  // MindBody webhooks wrap the actual data inside eventData — extract it
  const ed = rawPayload.eventData || rawPayload.EventData || {};
  // Merge: check eventData first, then top-level payload (for manual/test triggers)
  const payload = { ...rawPayload, ...ed };
  console.log(`[automation] Processing ${type}, email: ${payload.email || payload.clientEmail || 'none'}, name: ${payload.firstName || payload.clientFirstName || 'unknown'}`);
  try {
    if (type === 'client.created') {
      const name = payload.firstName || payload.FirstName || payload.clientFirstName || 'there';
      const email = payload.email || payload.Email || payload.clientEmail;
      if (email) {
        // Check if we already sent a welcome email to this address
        const alreadySent = emailLog.some(e => e.to === email && e.category === 'welcome' && e.status === 'sent');
        if (alreadySent) {
          console.log(`[automation] Welcome email already sent to ${email} — skipped`);
        } else {
          const tpl = EMAIL_TEMPLATES.welcome(name.trim());
          await sendEmail({ to: email, toName: name.trim(), ...tpl, category: 'welcome', trigger: 'client.created' });
          console.log(`[automation] Welcome email sent to ${email}`);
        }
      } else {
        console.log(`[automation] No email found for client.created — skipped`);
      }
    }
    if (type === 'clientVisit.created' || type === 'class.checkin' || type === 'classRosterBooking.created') {
      const clientId = payload.clientId || payload.ClientId || payload.clientUniqueId || payload.ClientUniqueId;
      const siteId = CONFIG.siteId;
      if (!clientId) { console.log(`[automation] No clientId for ${type} — skipped`); return; }
      const mbToken = await getMBToken();
      const [clientRes, servicesRes] = await Promise.all([
        fetch(`${MB_BASE}/client/clients?clientIds=${clientId}`, {
          headers: mbHeaders(mbToken)
        }),
        fetch(`${MB_BASE}/client/clientservices?clientId=${clientId}`, {
          headers: mbHeaders(mbToken)
        }),
      ]);
      const clientData = await clientRes.json();
      const servicesData = await servicesRes.json();
      const client = (clientData.Clients || [])[0];
      const services = servicesData.ClientServices || [];
      if (!client) return;
      const name = client.FirstName || 'there';
      const email = client.Email;
      if (!email) return;
      // Filter to active services only (not expired more than 7 days ago)
      const activeServices = services.filter(s => {
        if (s.ExpirationDate && new Date(s.ExpirationDate) < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)) return false;
        return true;
      });

      // Categorise services
      const introPacks = activeServices.filter(s => (s.Name||'').toLowerCase().includes('intro') && (s.Count||0) <= 3 && (s.Count||0) > 0);
      const classPacks = activeServices.filter(s => {
        const n = (s.Name||'').toLowerCase();
        return (s.Count||0) > 3 && !n.includes('intro') && !n.includes('unlimited') && !n.includes('membership');
      });

      // Intro pack complete: ALL intro packs used up
      const introAllUsed = introPacks.length > 0 && introPacks.every(s => (s.Remaining ?? 0) === 0);
      if (introAllUsed) {
        const alreadySent = emailLog.some(e => e.to === email && e.category === 'intro_complete');
        if (!alreadySent) {
          const tpl = EMAIL_TEMPLATES.introPackComplete(name);
          await sendEmail({ to: email, toName: name, ...tpl, category: 'intro_complete', trigger: 'classRosterBooking.created' });
          console.log(`[automation] Intro pack complete email sent to ${email}`);
        }
      }

      // Last credit: ONLY if ALL class packs have 0 remaining (no credits left anywhere)
      const hasAnyCredits = classPacks.some(s => (s.Remaining ?? 0) > 0);
      const allPacksEmpty = classPacks.length > 0 && !hasAnyCredits;
      if (allPacksEmpty) {
        const recentlySent = emailLog.some(e => e.to === email && e.category === 'last_credit' && e.sentAt > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
        if (!recentlySent) {
          const tpl = EMAIL_TEMPLATES.lastCredit(name);
          await sendEmail({ to: email, toName: name, ...tpl, category: 'last_credit', trigger: 'classRosterBooking.created' });
          console.log(`[automation] Last credit email sent to ${email} — all ${classPacks.length} packs empty`);
        } else {
          console.log(`[automation] Last credit already sent to ${email} in past 30 days — skipped`);
        }
      } else if (classPacks.length > 0) {
        const totalRemaining = classPacks.reduce((sum, s) => sum + (s.Remaining ?? 0), 0);
        console.log(`[automation] ${email} still has ${totalRemaining} credits across ${classPacks.length} packs — no last credit email`);
      }
    }
    if (type === 'clientPurchase.created' || type === 'sale.created' || type === 'clientSale.created') {
      const clientId = payload.clientId || payload.ClientId || payload.purchasingClientId || payload.PurchasingClientId || payload.clientUniqueId;
      // Webhook payload may have items array or top-level description
      const items = payload.items || payload.Items || payload.cartItems || [];
      const itemName = items.length > 0
        ? items.map(i => i.name || i.Name || i.description || i.Description || '').join(' ')
        : (payload.itemName || payload.Description || payload.description || '');
      if (!clientId || !itemName.toLowerCase().includes('10')) return;
      const mbToken = await getMBToken();
      const salesRes = await fetch(`${MB_BASE}/sale/sales?clientId=${clientId}`, {
        headers: mbHeaders(mbToken)
      });
      const salesData = await salesRes.json();
      const sales = salesData.Sales || [];
      const tenPackCount = sales.filter(s =>
        (s.Description || '').toLowerCase().includes('10')
      ).length;
      if (tenPackCount === 2) {
        const clientRes = await fetch(`${MB_BASE}/client/clients?clientIds=${clientId}`, {
          headers: mbHeaders(mbToken)
        });
        const clientData = await clientRes.json();
        const client = (clientData.Clients || [])[0];
        if (client && client.Email) {
          const tpl = EMAIL_TEMPLATES.membershipUpsell(client.FirstName || 'there');
          await sendEmail({ to: client.Email, toName: client.FirstName, ...tpl, category: 'membership_upsell', trigger: 'clientSale.created' });
          console.log(`[automation] Membership upsell email sent to ${client.Email}`);
        }
      }
    }
  } catch (err) {
    console.error('[automation] Error:', err.message);
  }
}
// ─── Webhook receiver ─────────────────────────────────────────────────────────
const events = [];
const sseClients = new Set();
// HEAD handler — MindBody sends HEAD to validate the webhook URL during subscription creation
app.head('/webhooks/mindbody', (req, res) => {
  console.log('[webhook] HEAD validation request received');
  res.status(200).end();
});
app.post('/webhooks/mindbody', (req, res) => {
  const event = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    type: req.body.eventId || req.body.EventId || 'unknown',
    payload: req.body,
  };
  events.unshift(event);
  if (events.length > 200) events.pop();
  console.log(`[webhook] ${event.type} @ ${event.receivedAt}`);
  broadcast(event);
  handleAutomations(event);
  res.status(200).json({ received: true, id: event.id });
});
// ─── SSE ─────────────────────────────────────────────────────────────────────
app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  events.slice(0, 10).forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});
function broadcast(event) {
  sseClients.forEach(c => c.write(`data: ${JSON.stringify(event)}\n\n`));
}
app.get('/api/events/log', requireAuth, (req, res) => {
  res.json({ events: events.slice(0, 50), total: events.length });
});

// ─── MindBody Webhook Subscription Management ─────────────────────────────────
const MB_WEBHOOKS_BASE = 'https://mb-api.mindbodyonline.com/push/api/v1';

// List current webhook subscriptions
app.get('/api/webhooks/subscriptions', requireAuth, async (req, res) => {
  try {
    const r = await fetchWithTimeout(`${MB_WEBHOOKS_BASE}/subscriptions`, {
      headers: { 'API-Key': CONFIG.apiKey, 'Content-Type': 'application/json' },
    }, 10000);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Helper: safely parse JSON or return empty object
async function safeJson(response) {
  try {
    const text = await response.text();
    if (!text || text.trim().length === 0) return { _httpStatus: response.status };
    const parsed = JSON.parse(text);
    parsed._httpStatus = response.status;
    return parsed;
  } catch (e) {
    return { _httpStatus: response.status, _parseError: e.message };
  }
}

// Helper: activate a single subscription by ID (correct MindBody API)
async function activateSubscription(subId) {
  // MindBody docs: PATCH /subscriptions/{id} with {"Status": "Active"} (NOT /activate)
  const r = await fetchWithTimeout(`${MB_WEBHOOKS_BASE}/subscriptions/${subId}`, {
    method: 'PATCH',
    headers: { 'API-Key': CONFIG.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Status: 'Active' }),
  }, 10000);
  const data = await safeJson(r);
  console.log(`[webhooks] Activate ${subId}: HTTP ${r.status}`, JSON.stringify(data).substring(0, 200));
  return data;
}

// Activate ALL pending subscriptions at once
app.post('/api/webhooks/activate-all', requireAuth, async (req, res) => {
  try {
    const r = await fetchWithTimeout(`${MB_WEBHOOKS_BASE}/subscriptions`, {
      headers: { 'API-Key': CONFIG.apiKey, 'Content-Type': 'application/json' },
    }, 10000);
    const data = await r.json();
    // MindBody wraps subscriptions in "items" array
    const subs = Array.isArray(data) ? data : (data.items || data.Items || data.Subscriptions || data.subscriptions || []);
    const pending = subs.filter(s => (s.status || s.Status || '').toLowerCase().includes('pending'));
    console.log(`[webhooks] Found ${subs.length} total, ${pending.length} pending`);
    const results = [];
    for (const sub of pending) {
      const id = sub.subscriptionId || sub.SubscriptionId || sub.Id || sub.id;
      try {
        const actData = await activateSubscription(id);
        results.push({ id, events: sub.eventIds, httpStatus: actData._httpStatus, status: actData.Status || actData.status || (actData._httpStatus < 300 ? 'activated' : 'failed'), response: actData });
      } catch (err) {
        results.push({ id, events: sub.eventIds, status: 'error', error: err.message });
      }
    }
    res.json({ total: subs.length, pending: pending.length, results });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Delete a webhook subscription by ID
app.delete('/api/webhooks/subscriptions/:subId', requireAuth, async (req, res) => {
  try {
    const { subId } = req.params;
    console.log(`[webhooks] Deleting subscription ${subId}...`);
    const r = await fetchWithTimeout(`${MB_WEBHOOKS_BASE}/subscriptions/${subId}`, {
      method: 'DELETE',
      headers: { 'API-Key': CONFIG.apiKey, 'Content-Type': 'application/json' },
    }, 10000);
    if (r.status === 204 || r.status === 200) {
      res.json({ status: 'deleted', subscriptionId: subId });
    } else {
      const data = await r.json().catch(() => ({}));
      res.json({ status: 'failed', subscriptionId: subId, response: data });
    }
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Create + activate webhook subscriptions for all email automation events
app.post('/api/webhooks/setup', requireAuth, async (req, res) => {
  const webhookUrl = req.body.webhookUrl;
  if (!webhookUrl) return res.status(400).json({ error: 'webhookUrl is required' });

  // Events we need for our email automations:
  // client.created → Welcome email
  // client.updated → Track changes
  // classRosterBooking.created → After class check-in (first visit, intro complete, last credit)
  // clientSale.created → Membership upsell trigger (after 2nd 10-pack purchase)
  // clientMembershipAssignment.created → Track new memberships
  const eventSets = [
    { events: ['client.created', 'client.updated'], ref: 'psc-client-events' },
    { events: ['classRosterBooking.created'], ref: 'psc-class-events' },
    { events: ['clientSale.created'], ref: 'psc-sale-events' },
    { events: ['clientMembershipAssignment.created'], ref: 'psc-membership-events' },
  ];

  const results = [];

  for (const set of eventSets) {
    try {
      // Step 1: Create subscription
      console.log(`[webhooks] Creating subscription for ${set.events.join(', ')}...`);
      const createRes = await fetchWithTimeout(`${MB_WEBHOOKS_BASE}/subscriptions`, {
        method: 'POST',
        headers: { 'API-Key': CONFIG.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: webhookUrl,
          eventIds: set.events,
          eventSchemaVersion: 1,
          referenceId: set.ref,
        }),
      }, 15000);
      const createData = await createRes.json();
      console.log(`[webhooks] Create response:`, JSON.stringify(createData).substring(0, 300));

      if (createData.Errors || createData.errors || createData.error || createData.Error) {
        const errDetail = createData.Errors || createData.errors || createData.error || createData.Error;
        results.push({ events: set.events, status: 'create_failed', error: errDetail });
        continue;
      }

      // MindBody returns PascalCase: SubscriptionId
      const subId = createData.SubscriptionId || createData.subscriptionId || createData.id || createData.Id;
      if (!subId) {
        results.push({ events: set.events, status: 'no_subscription_id', response: createData });
        continue;
      }

      // Step 2: Activate the subscription (PATCH /subscriptions/{id} with Status: Active)
      console.log(`[webhooks] Activating subscription ${subId}...`);
      const activateData = await activateSubscription(subId);

      results.push({
        events: set.events,
        subscriptionId: subId,
        httpStatus: activateData._httpStatus,
        status: activateData.Status || activateData.status || (activateData._httpStatus < 300 ? 'activated' : 'failed'),
        response: activateData,
      });
    } catch (err) {
      console.error(`[webhooks] Error setting up ${set.events.join(', ')}:`, err.message);
      results.push({ events: set.events, status: 'error', error: err.message });
    }
  }

  res.json({
    message: 'Webhook setup complete',
    webhookUrl,
    subscriptions: results,
  });
});

// Activate a specific pending subscription by ID
app.post('/api/webhooks/activate/:subId', requireAuth, async (req, res) => {
  try {
    const { subId } = req.params;
    console.log(`[webhooks] Manually activating subscription ${subId}...`);
    const data = await activateSubscription(subId);
    res.json(data);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ─── Email Queue (live data from MindBody) ────────────────────────────────
app.get('/api/email-queue', requireAuth, async (req, res) => {
  try {
    const mbToken = await getMBToken();
    const now = new Date();

    // Fetch clients and services in parallel
    const [clientsRes, servicesRes] = await Promise.all([
      fetchWithTimeout(`${MB_BASE}/client/clients?Limit=200`, { headers: mbHeaders(mbToken) }, 15000),
      fetchWithTimeout(`${MB_BASE}/client/clientservices?Limit=200`, { headers: mbHeaders(mbToken) }, 15000).catch(() => null),
    ]);
    const clientsData = await clientsRes.json();
    const clients = (clientsData.Clients || []).filter(c => c.Email);

    // --- Win-back: clients who haven't been active in 21+ days ---
    const lapsedCutoff = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000);
    const lapsed = clients.filter(c => {
      const lastVisit = c.LastModifiedDateTime || c.CreationDate;
      return lastVisit && new Date(lastVisit) < lapsedCutoff && c.Active !== false;
    });

    // --- Intro expired: clients whose intro pack credits are used up (remaining=0) ---
    let introExpired = [];
    if (servicesRes) {
      try {
        const servData = await servicesRes.json();
        const services = servData.ClientServices || [];
        // Find clients with intro packs that have 0 remaining
        const introClientsMap = {};
        services.forEach(s => {
          const svcName = (s.Name || '').toLowerCase();
          if (svcName.includes('intro') && (s.Remaining === 0) && s.ClientId) {
            introClientsMap[s.ClientId] = true;
          }
        });
        // Match with client emails
        introExpired = clients.filter(c => c.Id && introClientsMap[c.Id]);
      } catch (e) { /* ignore */ }
    }
    const sentIntroUpsell = emailLog
      .filter(e => e.category === 'intro_expired' && e.sentAt > winbackCooloff)
      .map(e => e.to);
    const pendingIntroExpired = introExpired.filter(c => !sentIntroUpsell.includes(c.Email));

    // --- Birthday: clients with birthday today ---
    const todayMonth = now.getMonth() + 1;
    const todayDay = now.getDate();
    const birthdayClients = clients.filter(c => {
      if (!c.BirthDate) return false;
      const bd = new Date(c.BirthDate);
      return (bd.getMonth() + 1) === todayMonth && bd.getDate() === todayDay;
    });

    // --- Smart dedup: check entire email log (any attempt, not just successful) ---
    // Win-back: don't resend within 30 days
    const winbackCooloff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const sentWinback = emailLog
      .filter(e => e.category === 'winback' && e.sentAt > winbackCooloff)
      .map(e => e.to);
    // Birthday: don't resend same year
    const thisYear = now.getFullYear().toString();
    const sentBirthday = emailLog
      .filter(e => e.category === 'birthday' && e.sentAt && e.sentAt.startsWith(thisYear))
      .map(e => e.to);

    const pendingWinback = lapsed.filter(c => !sentWinback.includes(c.Email));
    const pendingBirthday = birthdayClients.filter(c => !sentBirthday.includes(c.Email));

    res.json({
      winback: { total: lapsed.length, pending: pendingWinback.length, clients: pendingWinback.slice(0, 10).map(c => ({ name: c.FirstName, email: c.Email })) },
      birthday: { total: birthdayClients.length, pending: pendingBirthday.length, clients: pendingBirthday.slice(0, 10).map(c => ({ name: c.FirstName, email: c.Email })) },
      introExpired: { total: introExpired.length, pending: pendingIntroExpired.length, clients: pendingIntroExpired.slice(0, 10).map(c => ({ name: c.FirstName, email: c.Email })) },
    });
  } catch (err) {
    console.error('[email-queue]', err.message);
    res.json({ winback: { total: 0, pending: 0 }, birthday: { total: 0, pending: 0 }, introExpired: { total: 0, pending: 0 } });
  }
});

// ─── Preview queue email template ──────────────────────────────────────────
app.get('/api/email-queue/preview', requireAuth, async (req, res) => {
  const { type } = req.query;
  const templateMap = { winback: EMAIL_TEMPLATES.winBack, birthday: EMAIL_TEMPLATES.birthday, introExpired: EMAIL_TEMPLATES.introPackComplete };
  const tplFn = templateMap[type];
  if (!tplFn) return res.status(400).json({ error: 'Invalid type' });
  const sample = tplFn('[Name]');
  // Strip HTML tags to get plain text version for editing
  const plainText = sample.html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  res.json({ subject: sample.subject.replace('[Name]', '[Name]'), html: sample.html, plainText });
});

// ─── Send queue emails (trigger win-back, birthday, or renewal batch) ──────
app.post('/api/email-queue/send', requireAuth, async (req, res) => {
  const { type, customSubject, customBody } = req.body;
  if (!['winback', 'birthday', 'introExpired'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type. Use: winback, birthday, introExpired' });
  }
  try {
    const mbToken = await getMBToken();
    const now = new Date();
    const clientsRes = await fetchWithTimeout(`${MB_BASE}/client/clients?Limit=200`, { headers: mbHeaders(mbToken) }, 15000);
    const clientsData = await clientsRes.json();
    const clients = (clientsData.Clients || []).filter(c => c.Email);

    // Smart dedup: check full log with cooldown periods
    const winbackCooloff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const thisYear = now.getFullYear().toString();

    let targets = [];
    let templateFn;
    let category;

    if (type === 'winback') {
      const alreadySent = emailLog
        .filter(e => e.category === 'winback' && e.sentAt > winbackCooloff)
        .map(e => e.to);
      const cutoff = new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000);
      targets = clients.filter(c => {
        const lastVisit = c.LastModifiedDateTime || c.CreationDate;
        return lastVisit && new Date(lastVisit) < cutoff && c.Active !== false && !alreadySent.includes(c.Email);
      });
      templateFn = EMAIL_TEMPLATES.winBack;
      category = 'winback';
    } else if (type === 'birthday') {
      const alreadySent = emailLog
        .filter(e => e.category === 'birthday' && e.sentAt && e.sentAt.startsWith(thisYear))
        .map(e => e.to);
      const todayMonth = now.getMonth() + 1;
      const todayDay = now.getDate();
      targets = clients.filter(c => {
        if (!c.BirthDate) return false;
        const bd = new Date(c.BirthDate);
        return (bd.getMonth() + 1) === todayMonth && bd.getDate() === todayDay && !alreadySent.includes(c.Email);
      });
      templateFn = EMAIL_TEMPLATES.birthday;
      category = 'birthday';
    } else if (type === 'introExpired') {
      const alreadySent = emailLog
        .filter(e => e.category === 'intro_expired' && e.sentAt > winbackCooloff)
        .map(e => e.to);
      // Get clients with expired intro packs from services
      const mbToken2 = await getMBToken();
      const svcRes = await fetchWithTimeout(`${MB_BASE}/client/clientservices?Limit=200`, { headers: mbHeaders(mbToken2) }, 15000).catch(() => null);
      if (svcRes) {
        const svcData = await svcRes.json();
        const introClientIds = {};
        (svcData.ClientServices || []).forEach(s => {
          if ((s.Name || '').toLowerCase().includes('intro') && s.Remaining === 0 && s.ClientId) {
            introClientIds[s.ClientId] = true;
          }
        });
        targets = clients.filter(c => c.Id && introClientIds[c.Id] && !alreadySent.includes(c.Email));
      }
      templateFn = EMAIL_TEMPLATES.introPackComplete;
      category = 'intro_expired';
    }

    let sent = 0;
    for (const client of targets.slice(0, 50)) {
      const name = client.FirstName || 'there';
      // Always use the proper HTML template — only override subject if customized
      const tpl = templateFn(name.trim());
      const subject = customSubject
        ? customSubject.replace(/\[Name\]/g, name.trim())
        : tpl.subject;
      const html = tpl.html;

      const result = await sendEmail({
        to: client.Email,
        toName: `${client.FirstName || ''} ${client.LastName || ''}`.trim(),
        subject, html,
        category,
        trigger: `${category}.scheduled`,
      });
      if (result.ok) sent++;
    }

    res.json({ ok: true, sent, total: targets.length });
  } catch (err) {
    console.error('[email-queue/send]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Full clients list with pagination ─────────────────────────────────────
app.get('/api/clients/all', requireAuth, async (req, res) => {
  try {
    const mbToken = await getMBToken();
    const allClients = await fetchAllMBClients(mbToken);
    // Return clients with the fields the frontend needs
    const clients = allClients.map(c => ({
      Id: c.Id || c.UniqueId,
      FirstName: c.FirstName,
      LastName: c.LastName,
      Email: c.Email,
      MobilePhone: c.MobilePhone || c.HomePhone,
      Active: c.Active !== false,
      CreationDate: c.CreationDate,
      LastModifiedDateTime: c.LastModifiedDateTime,
      BirthDate: c.BirthDate,
      FirstClassDate: c.FirstClassDate,
    }));
    res.json({ clients, total: clients.length });
  } catch (err) {
    console.error('[clients/all]', err.message);
    res.status(500).json({ error: err.message, clients: [] });
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────
// ─── SendGrid Email Stats ─────────────────────────────────────────────────
app.get('/api/email/stats', requireAuth, async (req, res) => {
  if (!CONFIG.sendgridKey) return res.json({ error: 'SendGrid not configured', stats: [] });
  try {
    const days = parseInt(req.query.days) || 30;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const globalRes = await fetch(`https://api.sendgrid.com/v3/stats?start_date=${startDate}&aggregated_by=day`, {
      headers: { 'Authorization': `Bearer ${CONFIG.sendgridKey}` },
    });
    const globalStats = await globalRes.json();
    const catRes = await fetch(`https://api.sendgrid.com/v3/categories/stats?start_date=${startDate}&categories=welcome,intro_complete,last_credit,membership_upsell,manual&aggregated_by=day`, {
      headers: { 'Authorization': `Bearer ${CONFIG.sendgridKey}` },
    });
    const catStats = await catRes.json();
    let totals = { sent: 0, delivered: 0, opens: 0, uniqueOpens: 0, clicks: 0, uniqueClicks: 0, bounces: 0, unsubscribes: 0 };
    if (Array.isArray(globalStats)) {
      for (const day of globalStats) {
        for (const m of (day.stats || [])) {
          const s = m.metrics || {};
          totals.sent += s.requests || 0;
          totals.delivered += s.delivered || 0;
          totals.opens += s.opens || 0;
          totals.uniqueOpens += s.unique_opens || 0;
          totals.clicks += s.clicks || 0;
          totals.uniqueClicks += s.unique_clicks || 0;
          totals.bounces += s.bounces || 0;
          totals.unsubscribes += s.unsubscribes || 0;
        }
      }
    }
    totals.openRate = totals.delivered > 0 ? Math.round((totals.uniqueOpens / totals.delivered) * 100) : 0;
    totals.clickRate = totals.delivered > 0 ? Math.round((totals.uniqueClicks / totals.delivered) * 100) : 0;
    let categories = {};
    if (Array.isArray(catStats)) {
      for (const day of catStats) {
        for (const m of (day.stats || [])) {
          const cat = m.name || 'unknown';
          if (!categories[cat]) categories[cat] = { sent: 0, delivered: 0, opens: 0, uniqueOpens: 0, clicks: 0, uniqueClicks: 0 };
          const s = m.metrics || {};
          categories[cat].sent += s.requests || 0;
          categories[cat].delivered += s.delivered || 0;
          categories[cat].opens += s.opens || 0;
          categories[cat].uniqueOpens += s.unique_opens || 0;
          categories[cat].clicks += s.clicks || 0;
          categories[cat].uniqueClicks += s.unique_clicks || 0;
        }
      }
    }
    for (const cat of Object.keys(categories)) {
      const c = categories[cat];
      c.openRate = c.delivered > 0 ? Math.round((c.uniqueOpens / c.delivered) * 100) : 0;
      c.clickRate = c.delivered > 0 ? Math.round((c.uniqueClicks / c.delivered) * 100) : 0;
    }
    res.json({ totals, categories, daily: globalStats });
  } catch (err) {
    console.error('[email-stats]', err.message);
    res.json({ error: err.message, totals: {}, categories: {} });
  }
});
// (health check is at line 86)
// ─── Test email endpoint ──────────────────────────────────────────────────────
app.post('/api/test-email', requireAuth, async (req, res) => {
  const { type, email, name } = req.body;
  const templates = { welcome: EMAIL_TEMPLATES.welcome, introPackComplete: EMAIL_TEMPLATES.introPackComplete, membershipUpsell: EMAIL_TEMPLATES.membershipUpsell, lastCredit: EMAIL_TEMPLATES.lastCredit };
  const tpl = templates[type];
  if (!tpl) return res.status(400).json({ error: 'Unknown template type' });
  const result = await sendEmail({ to: email, toName: name, ...tpl(name) });
  res.json(result);
});
// ─── Manual email send endpoint ───────────────────────────────────────────────
app.post('/api/send-email', requireAuth, async (req, res) => {
  const { audience, subject, body } = req.body;
  if (!subject || !body) return res.status(400).json({ error: 'Subject and body required' });
  try {
    const mbToken = await getMBToken();
    const clientsRes = await fetch(`${MB_BASE}/client/clients?Limit=200`, {
      headers: mbHeaders(mbToken)
    });
    const clientsData = await clientsRes.json();
    let clients = clientsData.Clients || [];
    if (audience === 'lapsed') {
      const cutoff = Date.now() - 21 * 24 * 60 * 60 * 1000;
      clients = clients.filter(c => c.LastModifiedDateTime && new Date(c.LastModifiedDateTime) < cutoff);
    } else if (audience === 'new') {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      clients = clients.filter(c => c.CreationDate && new Date(c.CreationDate) > cutoff);
    }
    clients = clients.filter(c => c.Email && c.Active !== false);
    if (clients.length === 0) return res.json({ ok: true, count: 0 });
    let sent = 0;
    for (const client of clients.slice(0, 100)) {
      const personalised = body.replace(/\[Name\]/g, client.FirstName || 'there');
      const result = await sendEmail({
        to: client.Email,
        toName: `${client.FirstName||''} ${client.LastName||''}`.trim(),
        subject,
        html: emailWrapper(`<p style="color:#374151;line-height:1.8;font-size:15px;">${personalised.replace(/\n/g,'<br>')}</p>`)
      });
      if (result.ok) sent++;
    }
    res.json({ ok: true, count: sent });
  } catch (err) {
    console.error('[send-email]', err.message);
    res.status(500).json({ error: err.message });
  }
});
// ─── Analytics helper: fetch all clients with pagination ────────────────────
async function fetchAllMBClients(mbToken) {
  let all = [];
  const startTime = Date.now();
  for (let offset = 0; offset < 5000; offset += 200) {
    const res = await fetchWithTimeout(`${MB_BASE}/client/clients?Limit=200&Offset=${offset}`, {
      headers: mbHeaders(mbToken)
    }, 15000);
    const data = await res.json();
    if (data.Error || data.errors) {
      console.log(`[clients] Pagination error at offset ${offset}:`, JSON.stringify(data.Error || data.errors).substring(0, 200));
      break;
    }
    const batch = data.Clients || [];
    all = all.concat(batch);
    if (batch.length < 200) break;
  }
  console.log(`[clients] Fetched ${all.length} clients in ${Date.now() - startTime}ms`);
  return all;
}

// ─── Analytics API endpoints ──────────────────────────────────────────────────
app.get('/api/analytics/overview', requireAuth, async (req, res) => {
  const reqStart = Date.now();
  try {
    const now = new Date();
    const range = req.query.range || '1d';

    // Validate range parameter
    if (!['1d', '1w', '1m', '3m', '1y'].includes(range)) {
      return res.status(400).json({ error: 'Invalid range. Use: 1d, 1w, 1m, 3m, 1y', live: false });
    }

    const period = getCalendarPeriod(range, now);
    const mbToken = await getMBToken();

    // Format dates for MB API (ISO format)
    const startISO = period.start.toISOString();
    const endISO = period.end.toISOString();
    const prevStartISO = period.prevStart.toISOString();
    const prevEndISO = period.prevEnd.toISOString();

    // Fetch all data: current period + comparison period
    // Use individual try/catch so one failing endpoint doesn't break everything
    const safeFetch = async (url, label) => {
      try {
        const r = await fetchWithTimeout(url, { headers: mbHeaders(mbToken) }, 15000);
        const d = await r.json();
        if (d.Error || d.errors) console.log(`[analytics] ${label} error:`, JSON.stringify(d.Error || d.errors).substring(0, 200));
        return d;
      } catch (e) {
        console.log(`[analytics] ${label} failed: ${e.message}`);
        return {};
      }
    };

    const [allClients, currClassesData, currSalesData, prevClassesData, prevSalesData, membershipData] = await Promise.all([
      fetchAllMBClients(mbToken).catch(e => { console.log('[analytics] clients failed:', e.message); return []; }),
      safeFetch(`${MB_BASE}/class/classes?StartDateTime=${startISO}&EndDateTime=${endISO}&Limit=200`, 'currClasses'),
      safeFetch(`${MB_BASE}/sale/sales?StartSaleDateTime=${startISO}&EndSaleDateTime=${endISO}`, 'currSales'),
      safeFetch(`${MB_BASE}/class/classes?StartDateTime=${prevStartISO}&EndDateTime=${prevEndISO}&Limit=200`, 'prevClasses'),
      safeFetch(`${MB_BASE}/sale/sales?StartSaleDateTime=${prevStartISO}&EndSaleDateTime=${prevEndISO}`, 'prevSales'),
      safeFetch(`${MB_BASE}/client/clientservices?Limit=200`, 'memberships'),
    ]);

    const currClasses = currClassesData.Classes || [];
    const currSales = currSalesData.Sales || [];
    const prevClasses = prevClassesData.Classes || [];
    const prevSales = prevSalesData.Sales || [];
    // ClientServices can serve as membership proxy — active services with recurring payments
    const memberships = membershipData.ClientServices || [];

    // ─── Helper: calculate total from a MindBody Sale object ──────────────────
    // MindBody Public API v6 (PascalCase) vs Webhooks API (camelCase) return different field names.
    // Public API: Payments[].Amount, Items[].Total/Price, + possible top-level fields
    // Webhooks: payments[].paymentAmountPaid, items[].amountPaid, totalAmountPaid
    // We handle ALL variants defensively.
    const getSaleTotal = (sale) => {
      // 1. Top-level total fields (most direct if they exist)
      if (typeof sale.TotalAmountPaid === 'number' && sale.TotalAmountPaid > 0) return sale.TotalAmountPaid;
      if (typeof sale.totalAmountPaid === 'number' && sale.totalAmountPaid > 0) return sale.totalAmountPaid;

      // 2. Payments array — Public API PascalCase
      if (sale.Payments && sale.Payments.length > 0) {
        const total = sale.Payments.reduce((sum, p) => {
          return sum + (p.Amount || p.AmountPaid || p.PaymentAmountPaid || p.amount || p.amountPaid || p.paymentAmountPaid || 0);
        }, 0);
        if (total > 0) return total;
      }
      // Payments — Webhooks camelCase
      if (sale.payments && sale.payments.length > 0) {
        const total = sale.payments.reduce((sum, p) => {
          return sum + (p.paymentAmountPaid || p.amountPaid || p.amount || p.Amount || 0);
        }, 0);
        if (total > 0) return total;
      }

      // 3. Items array — Public API PascalCase
      if (sale.Items && sale.Items.length > 0) {
        const total = sale.Items.reduce((sum, item) => {
          return sum + (item.Total || item.AmountPaid || item.Price || item.total || item.amountPaid || item.price || 0);
        }, 0);
        if (total > 0) return total;
      }
      // Items — Webhooks camelCase
      if (sale.items && sale.items.length > 0) {
        const total = sale.items.reduce((sum, item) => {
          return sum + (item.amountPaid || item.total || item.price || item.Total || item.Price || 0);
        }, 0);
        if (total > 0) return total;
      }

      // 4. Legacy/fallback top-level fields
      return sale.TotalAmount || sale.Amount || sale.Total || sale.NetTotal ||
             sale.totalAmount || sale.amount || sale.total || sale.netTotal || 0;
    };

    // Helper: get sale date string — handles both Public API and Webhook field names
    const getSaleDate = (sale) => {
      const dt = sale.SaleDateTime || sale.SaleDate || sale.SaleTime ||
                 sale.saleDateTime || sale.saleDate || sale.CreatedDateTime;
      if (dt) return typeof dt === 'string' ? dt.split('T')[0] : new Date(dt).toISOString().split('T')[0];
      return new Date().toISOString().split('T')[0];
    };

    // Helper: get sale item descriptions — handles both APIs
    const getSaleDescriptions = (sale) => {
      const items = sale.Items || sale.items;
      if (items && items.length > 0) {
        return items.map(item => item.Description || item.Name || item.name || item.description || 'Other');
      }
      if (sale.Description || sale.description) return [sale.Description || sale.description];
      return ['Other'];
    };

    // ─── REVENUE & SALES ──────────────────────────────────────────────────────
    const totalRevenue = currSales.reduce((a, s) => a + getSaleTotal(s), 0);
    const prevRevenue = prevSales.reduce((a, s) => a + getSaleTotal(s), 0);
    const revenueGrowth = prevRevenue !== 0 ? Math.round(((totalRevenue - prevRevenue) / prevRevenue) * 100) : (totalRevenue > 0 ? 100 : 0);

    const totalSalesCount = currSales.length;
    const prevSalesCount = prevSales.length;
    const salesCountGrowth = prevSalesCount !== 0 ? Math.round(((totalSalesCount - prevSalesCount) / prevSalesCount) * 100) : (totalSalesCount > 0 ? 100 : 0);

    const avgSaleValue = totalSalesCount > 0 ? totalRevenue / totalSalesCount : 0;
    const prevAvgSaleValue = prevSalesCount > 0 ? prevRevenue / prevSalesCount : 0;
    const avgSaleGrowth = prevAvgSaleValue !== 0 ? Math.round(((avgSaleValue - prevAvgSaleValue) / prevAvgSaleValue) * 100) : (avgSaleValue > 0 ? 100 : 0);

    // Group sales by service type (using Items array descriptions)
    const revenueBySvcMap = {};
    currSales.forEach(s => {
      const saleTotal = getSaleTotal(s);
      const descriptions = getSaleDescriptions(s);
      const items = s.Items || s.items;
      // If sale has items array, attribute revenue per item; otherwise use first description
      if (items && items.length > 0) {
        items.forEach(item => {
          const svc = item.Description || item.Name || item.name || item.description || 'Other';
          const itemTotal = item.Total || item.AmountPaid || item.Price ||
                           item.total || item.amountPaid || item.price || 0;
          if (!revenueBySvcMap[svc]) revenueBySvcMap[svc] = { name: svc, revenue: 0, count: 0 };
          revenueBySvcMap[svc].revenue += itemTotal;
          revenueBySvcMap[svc].count += 1;
        });
      } else {
        const svc = descriptions[0];
        if (!revenueBySvcMap[svc]) revenueBySvcMap[svc] = { name: svc, revenue: 0, count: 0 };
        revenueBySvcMap[svc].revenue += saleTotal;
        revenueBySvcMap[svc].count += 1;
      }
    });
    const revenueBySvc = Object.values(revenueBySvcMap)
      .map(s => ({ ...s, pctOfTotal: totalRevenue > 0 ? Math.round((s.revenue / totalRevenue) * 100) : 0 }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    // Daily revenue trend
    const dailyRevenueMap = {};
    currSales.forEach(s => {
      const day = getSaleDate(s);
      if (!dailyRevenueMap[day]) dailyRevenueMap[day] = { date: day, revenue: 0, sales: 0 };
      dailyRevenueMap[day].revenue += getSaleTotal(s);
      dailyRevenueMap[day].sales += 1;
    });
    const dailyRevenue = Object.values(dailyRevenueMap).sort((a, b) => new Date(a.date) - new Date(b.date));

    // ─── ATTENDANCE & CLASSES ────────────────────────────────────────────────
    const totalClasses = currClasses.length;
    const totalBooked = currClasses.reduce((a, c) => a + (c.TotalBooked || 0), 0);
    const totalCapacity = currClasses.reduce((a, c) => a + (c.MaxCapacity || 10), 0);
    const avgFillRate = totalCapacity > 0 ? Math.round((totalBooked / totalCapacity) * 100) : 0;

    const prevTotalBooked = prevClasses.reduce((a, c) => a + (c.TotalBooked || 0), 0);
    const prevTotalCapacity = prevClasses.reduce((a, c) => a + (c.MaxCapacity || 10), 0);
    const prevFillRate = prevTotalCapacity > 0 ? Math.round((prevTotalBooked / prevTotalCapacity) * 100) : 0;
    const fillRateGrowth = avgFillRate - prevFillRate;

    const totalVisits = totalBooked;
    const prevVisits = prevTotalBooked;
    const visitsGrowth = prevVisits !== 0 ? Math.round(((totalVisits - prevVisits) / prevVisits) * 100) : (totalVisits > 0 ? 100 : 0);

    // Top classes by booking count
    const classesByNameMap = {};
    currClasses.forEach(c => {
      const name = c.ClassDescription?.Name || 'Unknown Class';
      if (!classesByNameMap[name]) {
        classesByNameMap[name] = { name, count: 0, avgFill: 0, totalBooked: 0, avgBooked: 0 };
      }
      classesByNameMap[name].count += 1;
      classesByNameMap[name].totalBooked += (c.TotalBooked || 0);
    });
    const classesByName = Object.values(classesByNameMap)
      .map(c => ({ ...c, avgBooked: c.count > 0 ? Math.round(c.totalBooked / c.count) : 0, avgFill: Math.round((c.totalBooked / (c.count * 10)) * 100) }))
      .sort((a, b) => b.totalBooked - a.totalBooked)
      .slice(0, 10);

    // Instructor stats
    const instructorMap = {};
    currClasses.forEach(c => {
      const name = c.Staff?.DisplayName || 'Unassigned';
      if (!instructorMap[name]) {
        instructorMap[name] = { name, classes: 0, totalBooked: 0, avgFill: 0 };
      }
      instructorMap[name].classes += 1;
      instructorMap[name].totalBooked += (c.TotalBooked || 0);
    });
    const instructorStats = Object.values(instructorMap)
      .map(i => ({ ...i, avgFill: i.classes > 0 ? Math.round((i.totalBooked / (i.classes * 10)) * 100) : 0 }))
      .sort((a, b) => b.totalBooked - a.totalBooked)
      .slice(0, 10);

    // Hourly attendance (0-23)
    const hourlyAttendance = new Array(24).fill(0);
    currClasses.forEach(c => {
      if (c.StartDateTime) {
        const hour = new Date(c.StartDateTime).getHours();
        hourlyAttendance[hour] = (hourlyAttendance[hour] || 0) + (c.TotalBooked || 0);
      }
    });

    // Daily attendance trend
    const dailyAttendanceMap = {};
    currClasses.forEach(c => {
      if (c.StartDateTime) {
        const day = c.StartDateTime.split('T')[0];
        if (!dailyAttendanceMap[day]) dailyAttendanceMap[day] = { date: day, visits: 0, classes: 0 };
        dailyAttendanceMap[day].visits += (c.TotalBooked || 0);
        dailyAttendanceMap[day].classes += 1;
      }
    });
    const dailyAttendance = Object.values(dailyAttendanceMap).sort((a, b) => new Date(a.date) - new Date(b.date));

    // Busiest day and hour
    let busiestDay = 'N/A', busiestHour = 'N/A';
    if (dailyAttendance.length > 0) {
      const bd = dailyAttendance.reduce((a, b) => a.visits > b.visits ? a : b);
      busiestDay = bd.date;
    }
    const maxHour = hourlyAttendance.reduce((max, v, i) => v > hourlyAttendance[max] ? i : max, 0);
    busiestHour = `${maxHour}:00`;

    // Hourly heatmap (day of week x hour)
    const heatmapData = {};
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    dayNames.forEach(d => { heatmapData[d] = {}; });
    currClasses.forEach(c => {
      if (c.StartDateTime) {
        const dt = new Date(c.StartDateTime);
        const dayName = dayNames[dt.getDay()];
        const hour = dt.getHours();
        if (!heatmapData[dayName][hour]) heatmapData[dayName][hour] = 0;
        heatmapData[dayName][hour] += (c.TotalBooked || 0);
      }
    });
    const hourlyHeatmap = Object.fromEntries(
      Object.entries(heatmapData).map(([day, hours]) => [
        day,
        Object.fromEntries(Object.entries(hours).map(([h, v]) => [parseInt(h), v]))
      ])
    );

    // ─── CLIENT HEALTH ───────────────────────────────────────────────────────
    const activeClients = allClients.filter(c => c.Active !== false);
    const totalClients = allClients.length;

    // Build a "last seen" map from class booking data (uses classes already fetched)
    // This is more reliable than LastVisit which may not exist on the clients endpoint
    const clientLastSeen = {};
    const clientVisitCount = {};
    // Use ALL classes (current + previous period) for broader visibility
    [...currClasses, ...prevClasses].forEach(cls => {
      if (cls.Clients) {
        cls.Clients.forEach(client => {
          const cId = client.Id || client.ClientId;
          if (!cId) return;
          const classDate = cls.StartDateTime ? new Date(cls.StartDateTime) : null;
          if (classDate && (!clientLastSeen[cId] || classDate > clientLastSeen[cId])) {
            clientLastSeen[cId] = classDate;
          }
          clientVisitCount[cId] = (clientVisitCount[cId] || 0) + 1;
        });
      }
    });

    // Helper: get best estimate of last activity for a client
    const getLastActivity = (c) => {
      const cId = c.Id || c.UniqueId;
      // Priority: 1) class booking data, 2) LastVisitDateTime (if MB returns it), 3) LastModifiedDateTime, 4) CreationDate
      if (cId && clientLastSeen[cId]) return clientLastSeen[cId];
      if (c.LastVisitDateTime) return new Date(c.LastVisitDateTime);
      if (c.LastModifiedDateTime) return new Date(c.LastModifiedDateTime);
      if (c.CreationDate) return new Date(c.CreationDate);
      return new Date(0);
    };

    // New clients this period
    const newClients = allClients.filter(c => {
      const cd = c.CreationDate ? new Date(c.CreationDate) : null;
      return cd && cd >= period.start && cd <= period.end;
    }).length;

    const prevNewClients = allClients.filter(c => {
      const cd = c.CreationDate ? new Date(c.CreationDate) : null;
      return cd && cd >= period.prevStart && cd <= period.prevEnd;
    }).length;
    const newClientsGrowth = prevNewClients !== 0 ? Math.round(((newClients - prevNewClients) / prevNewClients) * 100) : (newClients > 0 ? 100 : 0);

    // First visit percentage
    const firstVisitClients = allClients.filter(c => {
      const cd = c.CreationDate ? new Date(c.CreationDate) : null;
      return cd && cd >= period.start && cd <= period.end;
    }).length;
    const firstVisitPct = totalClients > 0 ? Math.round((firstVisitClients / totalClients) * 100) : 0;

    const prevFirstVisitClients = allClients.filter(c => {
      const cd = c.CreationDate ? new Date(c.CreationDate) : null;
      return cd && cd >= period.prevStart && cd <= period.prevEnd;
    }).length;
    const prevFirstVisitPct = totalClients > 0 ? Math.round((prevFirstVisitClients / totalClients) * 100) : 0;
    const firstVisitGrowth = firstVisitPct - prevFirstVisitPct;

    // Retention rate
    const retentionRate = totalClients > 0 ? Math.round((activeClients.length / totalClients) * 100) : 0;
    const prevActiveClients = allClients.filter(c => c.Active !== false).length;
    const prevRetentionRate = totalClients > 0 ? Math.round((prevActiveClients / totalClients) * 100) : 0;
    const retentionGrowth = retentionRate - prevRetentionRate;

    // At-risk clients (no activity in 14+ days)
    const twoWeeksAgo = new Date(Date.now() - 14*24*60*60*1000);
    const atRiskClients = allClients
      .filter(c => {
        if (c.Active === false) return false;
        return getLastActivity(c) < twoWeeksAgo;
      })
      .sort((a, b) => getLastActivity(a) - getLastActivity(b))
      .slice(0, 10)
      .map(c => {
        const cId = c.Id || c.UniqueId;
        return {
          name: `${c.FirstName || ''} ${c.LastName || ''}`.trim(),
          email: c.Email,
          lastVisit: getLastActivity(c).toISOString(),
          totalVisits: (cId && clientVisitCount[cId]) || 0,
        };
      });

    // Recent clients (newest)
    const recentClients = allClients
      .filter(c => c.CreationDate)
      .sort((a, b) => new Date(b.CreationDate) - new Date(a.CreationDate))
      .slice(0, 10)
      .map(c => {
        const cId = c.Id || c.UniqueId;
        return {
          name: `${c.FirstName || ''} ${c.LastName || ''}`.trim(),
          email: c.Email,
          joinDate: c.CreationDate,
          visits: (cId && clientVisitCount[cId]) || 0,
        };
      });

    // ─── MEMBERSHIPS ─────────────────────────────────────────────────────────
    // ClientServices returns active services — filter for memberships/autopay
    const activeMemberships = memberships.filter(m => m.Active === true || m.Remaining > 0).length;
    const prevActiveMemberships = activeMemberships; // Snapshot — no historical comparison available
    const membershipGrowth = 0;

    const membershipTypesMap = {};
    memberships.forEach(m => {
      const type = m.Name || m.Program?.Name || 'Other';
      membershipTypesMap[type] = (membershipTypesMap[type] || 0) + 1;
    });
    const membershipTypes = Object.entries(membershipTypesMap)
      .map(([name, count]) => ({ name, count, pctOfTotal: activeMemberships > 0 ? Math.round((count / activeMemberships) * 100) : 0 }))
      .sort((a, b) => b.count - a.count);

    console.log(`[studio-analytics] Completed in ${Date.now() - reqStart}ms — ${totalClients} clients, ${currClasses.length} classes, ${currSales.length} sales, rev €${Math.round(totalRevenue)}`);

    res.json({
      live: true,
      range,
      periodLabel: period.label,
      compLabel: period.compLabel,

      // Revenue & Sales
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      prevRevenue: Math.round(prevRevenue * 100) / 100,
      revenueGrowth,
      avgSaleValue: Math.round(avgSaleValue * 100) / 100,
      prevAvgSaleValue: Math.round(prevAvgSaleValue * 100) / 100,
      avgSaleGrowth,
      totalSalesCount,
      prevSalesCount,
      salesCountGrowth,
      revenueBySvc,
      dailyRevenue,

      // Attendance & Classes
      totalClasses,
      totalBooked,
      totalCapacity,
      avgFillRate,
      prevFillRate,
      fillRateGrowth,
      totalVisits,
      prevVisits,
      visitsGrowth,
      classesByName,
      instructorStats,
      hourlyAttendance,
      dailyAttendance,
      busiestDay,
      busiestHour,
      hourlyHeatmap,

      // Client Health
      totalClients,
      activeClients: activeClients.length,
      newClients,
      prevNewClients,
      newClientsGrowth,
      firstVisitPct,
      prevFirstVisitPct,
      firstVisitGrowth,
      retentionRate,
      prevRetentionRate,
      retentionGrowth,
      atRiskClients,
      recentClients,

      // Memberships
      activeMemberships,
      prevActiveMemberships,
      membershipGrowth,
      membershipTypes,
    });
  } catch (err) {
    console.error('[studio-analytics]', err.message);
    res.status(502).json({ error: err.message, live: false });
  }
});

app.get('/api/analytics/retention', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const range = req.query.range || '1m';

    // Validate range parameter
    if (!['1d', '1w', '1m', '3m', '1y'].includes(range)) {
      return res.status(400).json({ error: 'Invalid range. Use: 1d, 1w, 1m, 3m, 1y', live: false });
    }

    const period = getCalendarPeriod(range, now);
    const mbToken = await getMBToken();

    // Fetch all clients
    const allClients = await fetchAllMBClients(mbToken);

    // Calculate retention metrics
    const activeClients = allClients.filter(c => c.Active !== false);
    const totalClients = allClients.length;
    const retentionRate = totalClients > 0 ? Math.round((activeClients.length / totalClients) * 100) : 0;

    // Churned clients (became inactive during this period)
    const churned = allClients.filter(c => {
      if (c.Active !== false) return false;
      const lastMod = c.LastModifiedDateTime ? new Date(c.LastModifiedDateTime) : null;
      return lastMod && lastMod >= period.start && lastMod <= period.end;
    });

    // New clients in period
    const newClientsInPeriod = allClients.filter(c => {
      const cd = c.CreationDate ? new Date(c.CreationDate) : null;
      return cd && cd >= period.start && cd <= period.end;
    }).length;

    // At-risk clients (no visit in 14+ days)
    const twoWeeksAgo = new Date(Date.now() - 14*24*60*60*1000);
    const atRiskCount = allClients.filter(c => {
      if (c.Active === false) return false;
      const lastVisit = c.LastVisit ? new Date(c.LastVisit) : (c.LastModifiedDateTime ? new Date(c.LastModifiedDateTime) : new Date(0));
      return lastVisit < twoWeeksAgo;
    }).length;

    res.json({
      live: true,
      range,
      periodLabel: period.label,
      compLabel: period.compLabel,
      retentionRate,
      activeClients: activeClients.length,
      totalClients,
      churnedCount: churned.length,
      churnRate: totalClients > 0 ? Math.round((churned.length / totalClients) * 100) : 0,
      newClientsInPeriod,
      atRiskCount,
    });
  } catch (err) {
    console.error('[studio-analytics]', err.message);
    res.status(502).json({ error: err.message, live: false });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SQUARE API — Palm Kitchen restaurant
// ══════════════════════════════════════════════════════════════════════════════
const SQ_BASE = 'https://connect.squareup.com/v2';

function sqHeaders() {
  return {
    'Authorization': `Bearer ${CONFIG.squareToken}`,
    'Content-Type': 'application/json',
    'Square-Version': '2024-01-18',
  };
}

// Square proxy for arbitrary calls
app.all('/api/sq/*', requireAuth, async (req, res) => {
  if (!CONFIG.squareToken) return res.status(400).json({ error: 'Square not configured — add SQUARE_ACCESS_TOKEN to Railway env vars', live: false });
  try {
    const sqPath = req.params[0];
    const query = new URLSearchParams(req.query).toString();
    const url = `${SQ_BASE}/${sqPath}${query ? '?' + query : ''}`;
    const sqRes = await fetchWithTimeout(url, {
      method: req.method,
      headers: sqHeaders(),
      body: ['GET','HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    }, 8000);
    const data = await sqRes.json();
    res.status(sqRes.status).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ─── Helper: fetch ALL orders with cursor pagination (up to 5000) ────────────
async function fetchAllOrders(startAt, endAt, locFilter) {
  let allOrders = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const body = {
      location_ids: locFilter,
      query: {
        filter: {
          date_time_filter: { created_at: { start_at: startAt, end_at: endAt } },
          state_filter: { states: ['COMPLETED'] },
        },
        sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' },
      },
      limit: 500,
    };
    if (cursor) body.cursor = cursor;
    const res = await fetchWithTimeout(`${SQ_BASE}/orders/search`, {
      method: 'POST', headers: sqHeaders(), body: JSON.stringify(body),
    }, 12000);
    const data = await res.json();
    if (data.errors) throw new Error(data.errors[0]?.detail || data.errors[0]?.code || 'Square API error');
    allOrders = allOrders.concat(data.orders || []);
    cursor = data.cursor;
    if (!cursor) break;
  }
  return allOrders;
}

// ─── Helper: calendar-based period dates ─────────────────────────────────────
// Returns { start, end, prevStart, prevEnd, label, compLabel }
function getCalendarPeriod(range, now) {
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const dow = now.getDay(); // 0=Sun
  const mondayOffset = dow === 0 ? 6 : dow - 1; // days since Monday

  if (range === '1d') {
    // Today: midnight to now. Compare: same weekday last week
    const start = new Date(y, m, d);
    const end = now;
    const prevStart = new Date(y, m, d - 7);
    const prevEnd = new Date(prevStart.getFullYear(), prevStart.getMonth(), prevStart.getDate(),
      now.getHours(), now.getMinutes(), now.getSeconds());
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    return { start, end, prevStart, prevEnd, label: 'Today', compLabel: `Last ${dayNames[dow]}` };
  }
  if (range === '1w') {
    // This calendar week (Mon-now). Compare: last week same span
    const start = new Date(y, m, d - mondayOffset);
    const end = now;
    const prevStart = new Date(y, m, d - mondayOffset - 7);
    const daysSinceMonday = mondayOffset;
    const prevEnd = new Date(prevStart.getFullYear(), prevStart.getMonth(), prevStart.getDate() + daysSinceMonday,
      now.getHours(), now.getMinutes(), now.getSeconds());
    return { start, end, prevStart, prevEnd, label: 'This Week', compLabel: 'Last Week' };
  }
  if (range === '1m') {
    // 1st of this month to now. Compare: same days last month
    const start = new Date(y, m, 1);
    const end = now;
    const prevStart = new Date(y, m - 1, 1);
    const prevEnd = new Date(y, m - 1, Math.min(d, new Date(y, m, 0).getDate()),
      now.getHours(), now.getMinutes(), now.getSeconds());
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return { start, end, prevStart, prevEnd, label: monthNames[m], compLabel: monthNames[m === 0 ? 11 : m - 1] };
  }
  if (range === '3m') {
    // 3 calendar months including current. Compare: prior 3 months
    const start = new Date(y, m - 2, 1);
    const end = now;
    const prevStart = new Date(y, m - 5, 1);
    const prevEnd = new Date(y, m - 2, 0, 23, 59, 59); // end of month before start
    return { start, end, prevStart, prevEnd, label: 'Last 3 Months', compLabel: 'Prior 3 Months' };
  }
  // 1y — year to date. Compare: same period last year
  const start = new Date(y, 0, 1);
  const end = now;
  const prevStart = new Date(y - 1, 0, 1);
  const prevEnd = new Date(y - 1, m, d, now.getHours(), now.getMinutes(), now.getSeconds());
  return { start, end, prevStart, prevEnd, label: `${y} YTD`, compLabel: `${y - 1} YTD` };
}

// Kitchen analytics overview — Square-style Sales Report
app.get('/api/kitchen/overview', requireAuth, async (req, res) => {
  if (!CONFIG.squareToken) return res.json({ live: false, error: 'Square not configured' });
  try {
    const now = new Date();
    const range = req.query.range || '1d';
    const locFilter = CONFIG.squareLocId ? [CONFIG.squareLocId] : undefined;

    // Support custom date range
    let period;
    if (req.query.startDate && req.query.endDate) {
      const cs = new Date(req.query.startDate);
      const ce = new Date(req.query.endDate);
      const rangeDays = Math.ceil((ce - cs) / (24*60*60*1000));
      const prevCs = new Date(cs.getTime() - rangeDays * 24*60*60*1000);
      period = { start: cs, end: ce, prevStart: prevCs, prevEnd: cs, label: 'Custom', compLabel: 'Prior Period' };
    } else {
      period = getCalendarPeriod(range, now);
    }

    const startISO = period.start.toISOString();
    const endISO = period.end.toISOString();
    const prevStartISO = period.prevStart.toISOString();
    const prevEndISO = period.prevEnd.toISOString();
    const rangeDays = Math.max(1, Math.ceil((period.end - period.start) / (24*60*60*1000)));

    // Fetch current + previous orders with pagination, plus catalog
    const [orders, prevOrders, catData] = await Promise.all([
      fetchAllOrders(startISO, endISO, locFilter),
      fetchAllOrders(prevStartISO, prevEndISO, locFilter),
      (async () => {
        try {
          const r = await fetchWithTimeout(`${SQ_BASE}/catalog/list?types=ITEM,CATEGORY`, { headers: sqHeaders() }, 6000);
          return await r.json();
        } catch(e) { return { objects: [] }; }
      })(),
    ]);

    // Build catalog lookups
    const catalogItems = {};
    const catalogCategories = {};
    const itemToCategory = {};
    (catData.objects || []).forEach(obj => {
      if (obj.type === 'ITEM') {
        catalogItems[obj.id] = obj.item_data?.name || obj.id;
        if (obj.item_data?.category_id) {
          itemToCategory[obj.id] = obj.item_data.category_id;
        }
        // Map variation IDs to item name too
        (obj.item_data?.variations || []).forEach(v => {
          catalogItems[v.id] = obj.item_data?.name || obj.id;
          if (obj.item_data?.category_id) {
            itemToCategory[v.id] = obj.item_data.category_id;
          }
        });
      }
      if (obj.type === 'CATEGORY') {
        catalogCategories[obj.id] = obj.category_data?.name || obj.id;
      }
    });

    // ── Sales Summary (Square-style) ──────────────────────────────────────────
    const calcSales = (orderList) => {
      let grossSales = 0, totalTax = 0, totalDiscount = 0, totalReturns = 0;
      let cardAmount = 0, cashAmount = 0, otherAmount = 0;
      orderList.forEach(o => {
        const total = (o.total_money?.amount || 0) / 100;
        const tax = (o.total_tax_money?.amount || 0) / 100;
        const disc = (o.total_discount_money?.amount || 0) / 100;
        const ret = (o.return_amounts?.total_money?.amount || 0) / 100;
        grossSales += total + disc; // gross = net + discounts
        totalTax += tax;
        totalDiscount += disc;
        totalReturns += ret;
        // Payment types
        (o.tenders || []).forEach(t => {
          const amt = (t.amount_money?.amount || 0) / 100;
          const type = (t.type || '').toUpperCase();
          if (type === 'CARD' || type === 'SQUARE_GIFT_CARD') cardAmount += amt;
          else if (type === 'CASH') cashAmount += amt;
          else otherAmount += amt;
        });
      });
      const netSales = grossSales - totalDiscount - totalReturns;
      const count = orderList.length;
      const avgSale = count > 0 ? netSales / count : 0;
      return { grossSales, netSales, totalTax, totalDiscount, totalReturns, count, avgSale, cardAmount, cashAmount, otherAmount };
    };

    const cur = calcSales(orders);
    const prev = calcSales(prevOrders);

    const pctChange = (c, p) => p > 0 ? Math.round(((c - p) / p) * 100) : (c > 0 ? 100 : 0);

    // ── Hourly Sales Chart (current vs previous period) ───────────────────────
    const hourlyChart = [];
    for (let h = 0; h < 24; h++) {
      const curHourOrders = orders.filter(o => new Date(o.created_at).getHours() === h);
      const prevHourOrders = prevOrders.filter(o => new Date(o.created_at).getHours() === h);
      const curAmt = curHourOrders.reduce((a, o) => a + ((o.total_money?.amount || 0) / 100), 0);
      const prevAmt = prevHourOrders.reduce((a, o) => a + ((o.total_money?.amount || 0) / 100), 0);
      hourlyChart.push({
        hour: h,
        label: h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h-12}pm`,
        current: Math.round(curAmt * 100) / 100,
        previous: Math.round(prevAmt * 100) / 100,
        curOrders: curHourOrders.length,
        prevOrders: prevHourOrders.length,
      });
    }

    // ── Categories with items (expandable like Square) ────────────────────────
    const categoryMap = {};  // catName -> { revenue, prevRevenue, items: { name -> {qty, revenue, prevQty, prevRevenue} } }
    const processItemsForCategories = (orderList, isCurrent) => {
      orderList.forEach(o => {
        (o.line_items || []).forEach(li => {
          const itemName = li.name || catalogItems[li.catalog_object_id] || 'Unknown';
          const catId = itemToCategory[li.catalog_object_id] || '_uncategorized';
          const catName = catId === '_uncategorized' ? 'Other' : (catalogCategories[catId] || 'Other');
          const rev = (li.total_money?.amount || 0) / 100;
          const qty = parseInt(li.quantity || '1');

          if (!categoryMap[catName]) categoryMap[catName] = { revenue: 0, prevRevenue: 0, qty: 0, prevQty: 0, items: {} };
          if (!categoryMap[catName].items[itemName]) categoryMap[catName].items[itemName] = { qty: 0, revenue: 0, prevQty: 0, prevRevenue: 0 };

          if (isCurrent) {
            categoryMap[catName].revenue += rev;
            categoryMap[catName].qty += qty;
            categoryMap[catName].items[itemName].qty += qty;
            categoryMap[catName].items[itemName].revenue += rev;
          } else {
            categoryMap[catName].prevRevenue += rev;
            categoryMap[catName].prevQty += qty;
            categoryMap[catName].items[itemName].prevQty += qty;
            categoryMap[catName].items[itemName].prevRevenue += rev;
          }
        });
      });
    };
    processItemsForCategories(orders, true);
    processItemsForCategories(prevOrders, false);

    const categories = Object.entries(categoryMap)
      .map(([name, data]) => ({
        name,
        revenue: Math.round(data.revenue * 100) / 100,
        prevRevenue: Math.round(data.prevRevenue * 100) / 100,
        qty: data.qty,
        prevQty: data.prevQty,
        revGrowth: pctChange(data.revenue, data.prevRevenue),
        items: Object.entries(data.items)
          .map(([iName, iData]) => ({
            name: iName,
            qty: iData.qty,
            revenue: Math.round(iData.revenue * 100) / 100,
            prevQty: iData.prevQty,
            prevRevenue: Math.round(iData.prevRevenue * 100) / 100,
            qtyGrowth: pctChange(iData.qty, iData.prevQty),
            revGrowth: pctChange(iData.revenue, iData.prevRevenue),
          }))
          .sort((a, b) => b.revenue - a.revenue),
      }))
      .sort((a, b) => b.revenue - a.revenue);

    // ── Top Items (flat list) ─────────────────────────────────────────────────
    const allItems = {};
    const allPrevItems = {};
    orders.forEach(o => (o.line_items || []).forEach(li => {
      const n = li.name || catalogItems[li.catalog_object_id] || 'Unknown';
      if (!allItems[n]) allItems[n] = { qty: 0, revenue: 0 };
      allItems[n].qty += parseInt(li.quantity || '1');
      allItems[n].revenue += (li.total_money?.amount || 0) / 100;
    }));
    prevOrders.forEach(o => (o.line_items || []).forEach(li => {
      const n = li.name || catalogItems[li.catalog_object_id] || 'Unknown';
      if (!allPrevItems[n]) allPrevItems[n] = { qty: 0, revenue: 0 };
      allPrevItems[n].qty += parseInt(li.quantity || '1');
      allPrevItems[n].revenue += (li.total_money?.amount || 0) / 100;
    }));

    const topItems = Object.entries(allItems)
      .map(([name, d]) => {
        const p = allPrevItems[name] || { qty: 0, revenue: 0 };
        return {
          name, qty: d.qty,
          revenue: Math.round(d.revenue * 100) / 100,
          prevQty: p.qty,
          prevRevenue: Math.round(p.revenue * 100) / 100,
          qtyGrowth: pctChange(d.qty, p.qty),
          revGrowth: pctChange(d.revenue, p.revenue),
        };
      })
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 20);

    // ── Heatmap (day × hour) ──────────────────────────────────────────────────
    const heatmapData = {};
    orders.forEach(o => {
      const dt = new Date(o.created_at);
      const key = `${dt.getDay()}-${dt.getHours()}`;
      heatmapData[key] = (heatmapData[key] || 0) + 1;
    });
    const hourlyHeatmap = Object.entries(heatmapData)
      .map(([key, count]) => { const [day, hour] = key.split('-').map(Number); return { day, hour, count }; })
      .sort((a, b) => a.day !== b.day ? a.day - b.day : a.hour - b.hour);

    // ── Daily/Period Revenue Trend ────────────────────────────────────────────
    const dailyRevenue = [];
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (rangeDays <= 1) {
      // Hourly buckets for today
      for (let h = 0; h < 24; h++) {
        const hOrders = orders.filter(o => new Date(o.created_at).getHours() === h);
        const hRev = hOrders.reduce((a, o) => a + ((o.total_money?.amount || 0) / 100), 0);
        dailyRevenue.push({ label: h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h-12}pm`, amount: Math.round(hRev*100)/100, orders: hOrders.length });
      }
    } else if (rangeDays <= 14) {
      for (let i = 0; i < rangeDays; i++) {
        const dStart = new Date(period.start.getFullYear(), period.start.getMonth(), period.start.getDate() + i);
        const dEnd = new Date(dStart.getFullYear(), dStart.getMonth(), dStart.getDate() + 1);
        const dOrds = orders.filter(o => { const dt = new Date(o.created_at); return dt >= dStart && dt < dEnd; });
        const dRev = dOrds.reduce((a, o) => a + ((o.total_money?.amount || 0) / 100), 0);
        const label = rangeDays <= 7 ? dayNames[dStart.getDay()] : `${monthNames[dStart.getMonth()]} ${dStart.getDate()}`;
        dailyRevenue.push({ label, amount: Math.round(dRev*100)/100, orders: dOrds.length, date: dStart.toISOString().split('T')[0] });
      }
    } else {
      // Weekly buckets
      const weeks = Math.ceil(rangeDays / 7);
      for (let w = 0; w < weeks; w++) {
        const wStart = new Date(period.start.getTime() + w * 7 * 24*60*60*1000);
        const wEnd = new Date(Math.min(wStart.getTime() + 7 * 24*60*60*1000, period.end.getTime()));
        const wOrds = orders.filter(o => { const dt = new Date(o.created_at); return dt >= wStart && dt < wEnd; });
        const wRev = wOrds.reduce((a, o) => a + ((o.total_money?.amount || 0) / 100), 0);
        const label = `${monthNames[wStart.getMonth()]} ${wStart.getDate()}`;
        dailyRevenue.push({ label, amount: Math.round(wRev*100)/100, orders: wOrds.length, date: wStart.toISOString().split('T')[0] });
      }
    }

    // ── Customer metrics ──────────────────────────────────────────────────────
    const customerOrders = {};
    orders.forEach(o => { if (o.customer_id) customerOrders[o.customer_id] = (customerOrders[o.customer_id] || 0) + 1; });
    const uniqueCustomers = Object.keys(customerOrders).length;
    const repeatCustomers = Object.values(customerOrders).filter(c => c > 1).length;

    // ── Build response ────────────────────────────────────────────────────────
    res.json({
      live: true,
      range, rangeDays,
      periodLabel: period.label,
      compLabel: period.compLabel,
      // Square-style Sales Summary
      grossSales: Math.round(cur.grossSales * 100) / 100,
      netSales: Math.round(cur.netSales * 100) / 100,
      totalTax: Math.round(cur.totalTax * 100) / 100,
      totalDiscounts: Math.round(cur.totalDiscount * 100) / 100,
      totalReturns: Math.round(cur.totalReturns * 100) / 100,
      totalOrders: cur.count,
      avgSale: Math.round(cur.avgSale * 100) / 100,
      // Comparison
      prevGrossSales: Math.round(prev.grossSales * 100) / 100,
      prevNetSales: Math.round(prev.netSales * 100) / 100,
      prevTotalOrders: prev.count,
      prevAvgSale: Math.round(prev.avgSale * 100) / 100,
      prevTotalDiscounts: Math.round(prev.totalDiscount * 100) / 100,
      prevTotalReturns: Math.round(prev.totalReturns * 100) / 100,
      // % changes
      grossSalesGrowth: pctChange(cur.grossSales, prev.grossSales),
      netSalesGrowth: pctChange(cur.netSales, prev.netSales),
      ordersGrowth: pctChange(cur.count, prev.count),
      avgSaleGrowth: pctChange(cur.avgSale, prev.avgSale),
      // Payment types
      paymentTypes: {
        card: Math.round(cur.cardAmount * 100) / 100,
        cash: Math.round(cur.cashAmount * 100) / 100,
        other: Math.round(cur.otherAmount * 100) / 100,
        prevCard: Math.round(prev.cardAmount * 100) / 100,
        prevCash: Math.round(prev.cashAmount * 100) / 100,
      },
      // Hourly comparison chart
      hourlyChart,
      // Categories (expandable with items)
      categories,
      // Top items
      topItems,
      // Trend data
      dailyRevenue,
      // Heatmap
      hourlyHeatmap,
      // Customer insights
      uniqueCustomers,
      repeatCustomers,
      repeatRate: uniqueCustomers > 0 ? Math.round((repeatCustomers / uniqueCustomers) * 100) : 0,
      currency: orders[0]?.total_money?.currency || 'EUR',
      // Legacy compat fields
      totalRevenue: Math.round(cur.netSales * 100) / 100,
      todayRevenue: Math.round(orders.filter(o => o.created_at >= new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()).reduce((a, o) => a + ((o.total_money?.amount || 0) / 100), 0) * 100) / 100,
      avgOrderValue: Math.round(cur.avgSale * 100) / 100,
      prevRevenue: Math.round(prev.netSales * 100) / 100,
      prevOrders: prev.count,
      prevAvgOrder: Math.round(prev.avgSale * 100) / 100,
      revGrowth: pctChange(cur.netSales, prev.netSales),
      orderGrowth: pctChange(cur.count, prev.count),
      avgGrowth: pctChange(cur.avgSale, prev.avgSale),
    });
  } catch (err) {
    console.error('[kitchen]', err.message);
    res.status(502).json({ error: err.message, live: false });
  }
});

// Square health check
app.get('/api/kitchen/health', requireAuth, async (req, res) => {
  if (!CONFIG.squareToken) return res.json({ connected: false, reason: 'No Square token configured' });
  try {
    const locRes = await fetchWithTimeout(`${SQ_BASE}/locations`, {
      headers: sqHeaders(),
    }, 5000);
    const data = await locRes.json();
    if (data.errors) {
      return res.json({ connected: false, reason: data.errors[0]?.detail || data.errors[0]?.code || 'Unknown Square error', errors: data.errors });
    }
    const locations = data.locations || [];
    res.json({ connected: true, locations: locations.map(l => ({ id: l.id, name: l.name, status: l.status })) });
  } catch(err) {
    res.json({ connected: false, reason: err.message });
  }
});

// Square diagnostic (no auth, safe — only returns connection status, no data)
app.get('/api/kitchen/diag', async (req, res) => {
  const tokenLen = CONFIG.squareToken.length;
  const tokenPreview = CONFIG.squareToken ? CONFIG.squareToken.substring(0, 6) + '...' + CONFIG.squareToken.substring(tokenLen - 4) : 'EMPTY';
  const locId = CONFIG.squareLocId || 'NOT SET';
  if (!CONFIG.squareToken) return res.json({ ok: false, tokenLen: 0, locId, reason: 'No token' });
  try {
    const locRes = await fetchWithTimeout(`${SQ_BASE}/locations`, {
      headers: sqHeaders(),
    }, 5000);
    const status = locRes.status;
    const data = await locRes.json();
    if (data.errors) {
      return res.json({ ok: false, httpStatus: status, tokenLen, tokenPreview, locId, squareError: data.errors[0]?.detail || data.errors[0]?.code, errors: data.errors });
    }
    const locations = (data.locations || []).map(l => ({ id: l.id, name: l.name }));
    res.json({ ok: true, httpStatus: status, tokenLen, tokenPreview, locId, locations });
  } catch(err) {
    res.json({ ok: false, tokenLen, tokenPreview, locId, reason: err.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(CONFIG.port, () => {
  console.log(`Palm CRM running on port ${CONFIG.port}`);
  console.log(`   Auth: username=andrea password=Hello999`);
  console.log(`   Automations: 4 email triggers active`);
  console.log(`   Analytics: Studio + Kitchen + Master`);
  console.log(`   Square: ${CONFIG.squareToken ? 'Configured' : 'Not configured (add SQUARE_ACCESS_TOKEN)'}`);
});
