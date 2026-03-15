const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');
const path = require('path');
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
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
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
  const res = await fetchWithTimeout(`${MB_BASE}/usertoken/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'API-Key': CONFIG.apiKey, 'SiteId': CONFIG.siteId },
    body: JSON.stringify({ Username: CONFIG.mbUsername, Password: CONFIG.mbPassword }),
  }, 5000);
  const data = await res.json();
  if (!data.AccessToken) throw new Error('MB auth failed');
  tokenCache = { token: data.AccessToken, expires: Date.now() + 55 * 60 * 1000 };
  return tokenCache.token;
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
      headers: { 'Content-Type': 'application/json', 'API-Key': CONFIG.apiKey, 'SiteId': CONFIG.siteId, 'Authorization': token },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    }, 8000);
    const data = await mbRes.json();
    res.status(mbRes.status).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
// ─── Email sending via SendGrid ───────────────────────────────────────────────
async function sendEmail({ to, toName, subject, html }) {
  if (!CONFIG.sendgridKey) {
    console.log(`[email] No SendGrid key — would send to ${to}: ${subject}`);
    return { ok: true, simulated: true };
  }
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${CONFIG.sendgridKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to, name: toName }] }],
      from: { email: CONFIG.fromEmail, name: CONFIG.fromName },
      subject,
      content: [{ type: 'text/html', value: html }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('[email] SendGrid error:', err);
    return { ok: false, error: err };
  }
  console.log(`[email] Sent to ${to}: ${subject}`);
  return { ok: true };
}
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
      <a href="https://www.palmsportingclub.com/prices" style="display:block;background:#0D3D20;color:#fff;text-decoration:none;padding:14px;border-radius:10px;text-align:center;font-weight:600;font-size:15px;margin-bottom:12px;">Shop class packs →</a>
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
      <a href="https://www.palmsportingclub.com/prices" style="display:block;background:#0D3D20;color:#fff;text-decoration:none;padding:14px;border-radius:10px;text-align:center;font-weight:600;font-size:15px;margin-bottom:12px;">View membership options →</a>
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
        <a href="https://www.palmsportingclub.com/prices" style="flex:1;display:block;background:#0D3D20;color:#fff;text-decoration:none;padding:14px;border-radius:10px;text-align:center;font-weight:600;font-size:14px;">5-class pack →</a>
        <a href="https://www.palmsportingclub.com/prices" style="flex:1;display:block;background:#111827;color:#fff;text-decoration:none;padding:14px;border-radius:10px;text-align:center;font-weight:600;font-size:14px;">10-class pack →</a>
      </div>
      <p style="font-size:13px;color:#6B7280;text-align:center;">Book directly from the <a href="https://mndbdy.ly/e/5737970" style="color:#0D3D20;">Palm app</a> too.</p>
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
      <a href="https://www.palmsportingclub.com/prices" style="display:block;background:#0D3D20;color:#fff;text-decoration:none;padding:14px;border-radius:10px;text-align:center;font-weight:600;font-size:15px;margin-bottom:16px;">Get your intro pack now →</a>
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
};
// ─── Automation logic ─────────────────────────────────────────────────────────
async function handleAutomations(event) {
  const type = event.type;
  const payload = event.payload;
  try {
    if (type === 'client.created') {
      const name = payload.firstName || payload.FirstName || 'there';
      const email = payload.email || payload.Email;
      if (email) {
        const tpl = EMAIL_TEMPLATES.welcome(name);
        await sendEmail({ to: email, toName: name, ...tpl });
        console.log(`[automation] Welcome email sent to ${email}`);
      }
    }
    if (type === 'clientVisit.created' || type === 'class.checkin') {
      const clientId = payload.clientId || payload.ClientId;
      const siteId = CONFIG.siteId;
      if (!clientId) return;
      const mbToken = await getMBToken();
      const [clientRes, servicesRes] = await Promise.all([
        fetch(`${MB_BASE}/client/clients?clientIds=${clientId}`, {
          headers: { 'API-Key': CONFIG.apiKey, 'SiteId': siteId, 'Authorization': mbToken }
        }),
        fetch(`${MB_BASE}/client/clientservices?clientId=${clientId}`, {
          headers: { 'API-Key': CONFIG.apiKey, 'SiteId': siteId, 'Authorization': mbToken }
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
      for (const svc of services) {
        const remaining = svc.Remaining || 0;
        const total = svc.Count || 0;
        const svcName = (svc.Name || '').toLowerCase();
        if (remaining === 0 && total <= 3 && svcName.includes('intro')) {
          const tpl = EMAIL_TEMPLATES.introPackComplete(name);
          await sendEmail({ to: email, toName: name, ...tpl });
          console.log(`[automation] Intro pack complete email sent to ${email}`);
        }
        if (remaining === 0 && total > 3 && !svcName.includes('intro') && !svcName.includes('unlimited') && !svcName.includes('membership')) {
          const tpl = EMAIL_TEMPLATES.lastCredit(name);
          await sendEmail({ to: email, toName: name, ...tpl });
          console.log(`[automation] Last credit email sent to ${email}`);
        }
      }
    }
    if (type === 'clientPurchase.created' || type === 'sale.created') {
      const clientId = payload.clientId || payload.ClientId;
      const itemName = (payload.itemName || payload.Description || '').toLowerCase();
      if (!clientId || !itemName.includes('10')) return;
      const mbToken = await getMBToken();
      const salesRes = await fetch(`${MB_BASE}/sale/sales?clientId=${clientId}`, {
        headers: { 'API-Key': CONFIG.apiKey, 'SiteId': CONFIG.siteId, 'Authorization': mbToken }
      });
      const salesData = await salesRes.json();
      const sales = salesData.Sales || [];
      const tenPackCount = sales.filter(s =>
        (s.Description || '').toLowerCase().includes('10')
      ).length;
      if (tenPackCount === 2) {
        const clientRes = await fetch(`${MB_BASE}/client/clients?clientIds=${clientId}`, {
          headers: { 'API-Key': CONFIG.apiKey, 'SiteId': CONFIG.siteId, 'Authorization': mbToken }
        });
        const clientData = await clientRes.json();
        const client = (clientData.Clients || [])[0];
        if (client && client.Email) {
          const tpl = EMAIL_TEMPLATES.membershipUpsell(client.FirstName || 'there');
          await sendEmail({ to: client.Email, toName: client.FirstName, ...tpl });
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
// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', siteId: CONFIG.siteId, source: CONFIG.sourceName, sseClients: sseClients.size, eventsReceived: events.length, tokenCached: !!tokenCache.token });
});
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
      headers: { 'API-Key': CONFIG.apiKey, 'SiteId': CONFIG.siteId, 'Authorization': mbToken }
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
// ─── Analytics API endpoints ──────────────────────────────────────────────────
app.get('/api/analytics/overview', requireAuth, async (req, res) => {
  try {
    const mbToken = await getMBToken();
    const today = new Date().toISOString().split('T')[0];
    const range = req.query.range || '30d';
    const now = new Date();
    const rangeDays = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : range === 'ytd' ? Math.floor((now - new Date(now.getFullYear(),0,1)) / (24*60*60*1000)) : 30;
    const startDate = new Date(Date.now() - rangeDays*24*60*60*1000).toISOString().split('T')[0];
    const thirtyDaysAgo = startDate;
    const sixtyDaysAgo = new Date(Date.now() - rangeDays*2*24*60*60*1000).toISOString().split('T')[0];
    const fourteenDaysAgo = new Date(Date.now() - 14*24*60*60*1000).toISOString().split('T')[0];

    const [clientsRes, classesRes, salesRes] = await Promise.all([
      fetchWithTimeout(`${MB_BASE}/client/clients?Limit=200`, {
        headers: { 'API-Key': CONFIG.apiKey, 'SiteId': CONFIG.siteId, 'Authorization': mbToken }
      }, 5000),
      fetchWithTimeout(`${MB_BASE}/class/classes?StartDateTime=${thirtyDaysAgo}T00:00:00&EndDateTime=${today}T23:59:59&Limit=200`, {
        headers: { 'API-Key': CONFIG.apiKey, 'SiteId': CONFIG.siteId, 'Authorization': mbToken }
      }, 5000),
      fetchWithTimeout(`${MB_BASE}/sale/sales?StartSaleDateTime=${thirtyDaysAgo}T00:00:00&EndSaleDateTime=${today}T23:59:59`, {
        headers: { 'API-Key': CONFIG.apiKey, 'SiteId': CONFIG.siteId, 'Authorization': mbToken }
      }, 5000),
    ]);

    const clients = (await clientsRes.json()).Clients || [];
    const classes = (await classesRes.json()).Classes || [];
    const sales = (await salesRes.json()).Sales || [];

    // Calculate metrics
    const activeClients = clients.filter(c => c.Active !== false);
    const newThisMonth = clients.filter(c => c.CreationDate && new Date(c.CreationDate) > new Date(thirtyDaysAgo));
    const totalBooked = classes.reduce((a, c) => a + (c.TotalBooked || 0), 0);
    const totalCapacity = classes.reduce((a, c) => a + (c.MaxCapacity || 10), 0);
    const avgFillRate = totalCapacity > 0 ? Math.round((totalBooked / totalCapacity) * 100) : 0;

    // Revenue from sales
    const totalRevenue = sales.reduce((a, s) => a + (s.TotalAmount || s.Amount || 0), 0);

    // At-risk clients (no recent activity)
    const atRisk = clients.filter(c => {
      if (!c.Active) return false;
      const lastVisit = c.LastModifiedDateTime || c.CreationDate;
      if (!lastVisit) return true;
      return new Date(lastVisit) < new Date(fourteenDaysAgo);
    });

    res.json({
      live: true,
      range, rangeDays,
      totalClients: clients.length,
      activeClients: activeClients.length,
      newThisMonth: newThisMonth.length,
      classesThisMonth: classes.length,
      totalBooked,
      avgFillRate,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      atRiskCount: atRisk.length,
      atRiskClients: atRisk.slice(0, 10).map(c => ({
        name: `${c.FirstName || ''} ${c.LastName || ''}`.trim(),
        email: c.Email,
        lastSeen: c.LastModifiedDateTime || c.CreationDate || 'Unknown',
        visits: c.VisitCount || 0,
      })),
      classes: classes.map(c => ({
        name: c.ClassDescription?.Name || 'Class',
        date: c.StartDateTime,
        booked: c.TotalBooked || 0,
        capacity: c.MaxCapacity || 10,
        instructor: c.Staff?.DisplayName || 'Staff',
      })),
      sales: sales.map(s => ({
        date: s.SaleDate || s.PurchaseDate,
        amount: s.TotalAmount || s.Amount || 0,
        description: s.Description || 'Sale',
        client: s.ClientId,
      })),
    });
  } catch (err) {
    console.error('[analytics]', err.message);
    res.status(502).json({ error: err.message, live: false });
  }
});

app.get('/api/analytics/retention', requireAuth, async (req, res) => {
  try {
    const mbToken = await getMBToken();
    const today = new Date().toISOString().split('T')[0];
    const ninetyDaysAgo = new Date(Date.now() - 90*24*60*60*1000).toISOString().split('T')[0];

    const clientsRes = await fetchWithTimeout(`${MB_BASE}/client/clients?Limit=200`, {
      headers: { 'API-Key': CONFIG.apiKey, 'SiteId': CONFIG.siteId, 'Authorization': mbToken }
    }, 5000);
    const clients = (await clientsRes.json()).Clients || [];
    const active = clients.filter(c => c.Active !== false);
    const total = clients.length;
    const retentionRate = total > 0 ? Math.round((active.length / total) * 100) : 0;

    // Churn = clients who became inactive recently
    const churned = clients.filter(c => {
      if (c.Active !== false) return false;
      const last = c.LastModifiedDateTime;
      return last && new Date(last) > new Date(ninetyDaysAgo);
    });

    res.json({
      live: true,
      retentionRate,
      activeClients: active.length,
      totalClients: total,
      churnedCount: churned.length,
      churnRate: total > 0 ? Math.round((churned.length / total) * 100) : 0,
    });
  } catch (err) {
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
