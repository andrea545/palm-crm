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
  squareToken:    process.env.SQUARE_ACCESS_TOKEN || '',
  squareLocId:    process.env.SQUARE_LOCATION_ID  || '',
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
    const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
    const sixtyDaysAgo = new Date(Date.now() - 60*24*60*60*1000).toISOString().split('T')[0];
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

// Kitchen analytics overview
app.get('/api/kitchen/overview', requireAuth, async (req, res) => {
  if (!CONFIG.squareToken) return res.json({ live: false, error: 'Square not configured' });
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30*24*60*60*1000).toISOString();
    const sevenDaysAgo = new Date(now - 7*24*60*60*1000).toISOString();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const locFilter = CONFIG.squareLocId ? [CONFIG.squareLocId] : undefined;

    // Fetch orders (last 30 days)
    const ordersRes = await fetchWithTimeout(`${SQ_BASE}/orders/search`, {
      method: 'POST',
      headers: sqHeaders(),
      body: JSON.stringify({
        location_ids: locFilter,
        query: {
          filter: {
            date_time_filter: { created_at: { start_at: thirtyDaysAgo, end_at: now.toISOString() } },
            state_filter: { states: ['COMPLETED'] }
          },
          sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' }
        },
        limit: 500,
      }),
    }, 8000);
    const ordersData = await ordersRes.json();
    const orders = ordersData.orders || [];

    // Fetch catalog items for names
    let catalogItems = {};
    try {
      const catRes = await fetchWithTimeout(`${SQ_BASE}/catalog/list?types=ITEM`, {
        headers: sqHeaders(),
      }, 5000);
      const catData = await catRes.json();
      (catData.objects || []).forEach(item => {
        catalogItems[item.id] = item.item_data?.name || item.id;
      });
    } catch(e) { /* catalog optional */ }

    // Calculate metrics
    const totalRevenue = orders.reduce((a, o) => a + ((o.total_money?.amount || 0) / 100), 0);
    const totalOrders = orders.length;
    const avgOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders * 100) / 100 : 0;

    // Today's revenue
    const todayOrders = orders.filter(o => o.created_at >= todayStart);
    const todayRevenue = todayOrders.reduce((a, o) => a + ((o.total_money?.amount || 0) / 100), 0);

    // Weekly revenue breakdown
    const weeklyRevenue = [];
    for (let i = 4; i >= 0; i--) {
      const wStart = new Date(now - (i+1)*7*24*60*60*1000);
      const wEnd = new Date(now - i*7*24*60*60*1000);
      const wOrders = orders.filter(o => {
        const d = new Date(o.created_at);
        return d >= wStart && d < wEnd;
      });
      const wRev = wOrders.reduce((a, o) => a + ((o.total_money?.amount || 0) / 100), 0);
      weeklyRevenue.push({ label: `W${5-i}`, amount: Math.round(wRev * 100) / 100, orders: wOrders.length });
    }

    // Top selling items
    const itemCounts = {};
    const itemRevenue = {};
    orders.forEach(o => {
      (o.line_items || []).forEach(li => {
        const name = li.name || catalogItems[li.catalog_object_id] || 'Unknown';
        itemCounts[name] = (itemCounts[name] || 0) + parseInt(li.quantity || '1');
        itemRevenue[name] = (itemRevenue[name] || 0) + ((li.total_money?.amount || 0) / 100);
      });
    });
    const topItems = Object.entries(itemCounts)
      .map(([name, qty]) => ({ name, qty, revenue: Math.round((itemRevenue[name]||0)*100)/100 }))
      .sort((a,b) => b.qty - a.qty)
      .slice(0, 10);

    // Category breakdown
    const catBreakdown = {};
    orders.forEach(o => {
      (o.line_items || []).forEach(li => {
        const cat = li.variation_name || li.name?.split(' ')[0] || 'Other';
        catBreakdown[cat] = (catBreakdown[cat] || 0) + ((li.total_money?.amount || 0) / 100);
      });
    });

    // Peak hours
    const hourCounts = {};
    orders.forEach(o => {
      const h = new Date(o.created_at).getHours();
      hourCounts[h] = (hourCounts[h] || 0) + 1;
    });
    const peakHours = Object.entries(hourCounts)
      .map(([h, count]) => ({ hour: parseInt(h), count }))
      .sort((a,b) => b.count - a.count);

    // Discounts & comps
    const totalDiscounts = orders.reduce((a, o) => {
      const disc = (o.total_discount_money?.amount || 0) / 100;
      return a + disc;
    }, 0);

    // Daily revenue (last 7 days)
    const dailyRevenue = [];
    for (let i = 6; i >= 0; i--) {
      const dStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const dEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1);
      const dOrders = orders.filter(o => {
        const d = new Date(o.created_at);
        return d >= dStart && d < dEnd;
      });
      const dRev = dOrders.reduce((a, o) => a + ((o.total_money?.amount || 0) / 100), 0);
      const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      dailyRevenue.push({ label: dayNames[dStart.getDay()], amount: Math.round(dRev*100)/100, orders: dOrders.length });
    }

    // Customer frequency (unique customers)
    const customerOrders = {};
    orders.forEach(o => {
      if (o.customer_id) {
        customerOrders[o.customer_id] = (customerOrders[o.customer_id] || 0) + 1;
      }
    });
    const uniqueCustomers = Object.keys(customerOrders).length;
    const repeatCustomers = Object.values(customerOrders).filter(c => c > 1).length;

    res.json({
      live: true,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      todayRevenue: Math.round(todayRevenue * 100) / 100,
      totalOrders,
      todayOrders: todayOrders.length,
      avgOrderValue,
      weeklyRevenue,
      dailyRevenue,
      topItems,
      peakHours: peakHours.slice(0, 8),
      totalDiscounts: Math.round(totalDiscounts * 100) / 100,
      uniqueCustomers,
      repeatCustomers,
      repeatRate: uniqueCustomers > 0 ? Math.round((repeatCustomers / uniqueCustomers) * 100) : 0,
      currency: orders[0]?.total_money?.currency || 'EUR',
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
    const locations = data.locations || [];
    res.json({ connected: true, locations: locations.map(l => ({ id: l.id, name: l.name, status: l.status })) });
  } catch(err) {
    res.json({ connected: false, reason: err.message });
  }
});
// Square diagnostic (no auth needed)
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
```

Then click **Commit changes**. Wait for Railway to redeploy (~1 min), then visit:
```
https://magnificent-courtesy-production-63b2.up.railway.app/api/kitchen/diag
// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(CONFIG.port, () => {
  console.log(`Palm CRM running on port ${CONFIG.port}`);
  console.log(`   Auth: username=andrea password=Hello999`);
  console.log(`   Automations: 4 email triggers active`);
  console.log(`   Analytics: Studio + Kitchen + Master`);
  console.log(`   Square: ${CONFIG.squareToken ? 'Configured' : 'Not configured (add SQUARE_ACCESS_TOKEN)'}`);
});
