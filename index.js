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
    const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString().split('T')[0];
    const [salesRes, classesRes, clientsRes] = await Promise.all([
      fetchWithTimeout(`${MB_BASE}/sale/sales?StartSaleDateTime=${thirtyDaysAgo}T00:00:00&EndSaleDateTime=${today}T23:59:59&Limit=5`, { headers: mbHeaders(mbToken) }, 8000),
      fetchWithTimeout(`${MB_BASE}/class/classes?StartDateTime=${thirtyDaysAgo}T00:00:00&EndDateTime=${today}T23:59:59&Limit=5`, { headers: mbHeaders(mbToken) }, 8000),
      fetchWithTimeout(`${MB_BASE}/client/clients?Limit=5`, { headers: mbHeaders(mbToken) }, 8000),
    ]);
    const sales = await salesRes.json();
    const classes = await classesRes.json();
    const clients = await clientsRes.json();
    res.json({
      salesCount: sales.Sales?.length || 0, salesSample: sales.Sales?.slice(0,2) || sales,
      classesCount: classes.Classes?.length || 0, classesSample: classes.Classes?.slice(0,2) || classes,
      clientsCount: clients.Clients?.length || 0, clientsSample: clients.Clients?.slice(0,2)?.map(c => ({ FirstName: c.FirstName, Active: c.Active, CreationDate: c.CreationDate })) || clients,
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
// ─── Email sending via SendGrid ───────────────────────────────────────────────
async function sendEmail({ to, toName, subject, html, category }) {
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
  const payload = event.payload;
  try {
    if (type === 'client.created') {
      const name = payload.firstName || payload.FirstName || 'there';
      const email = payload.email || payload.Email;
      if (email) {
        const tpl = EMAIL_TEMPLATES.welcome(name);
        await sendEmail({ to: email, toName: name, ...tpl, category: 'welcome' });
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
      for (const svc of services) {
        const remaining = svc.Remaining || 0;
        const total = svc.Count || 0;
        const svcName = (svc.Name || '').toLowerCase();
        if (remaining === 0 && total <= 3 && svcName.includes('intro')) {
          const tpl = EMAIL_TEMPLATES.introPackComplete(name);
          await sendEmail({ to: email, toName: name, ...tpl, category: 'intro_complete' });
          console.log(`[automation] Intro pack complete email sent to ${email}`);
        }
        if (remaining === 0 && total > 3 && !svcName.includes('intro') && !svcName.includes('unlimited') && !svcName.includes('membership')) {
          const tpl = EMAIL_TEMPLATES.lastCredit(name);
          await sendEmail({ to: email, toName: name, ...tpl, category: 'last_credit' });
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
          await sendEmail({ to: client.Email, toName: client.FirstName, ...tpl, category: 'membership_upsell' });
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
  for (let offset = 0; offset < 5000; offset += 200) {
    const res = await fetchWithTimeout(`${MB_BASE}/client/clients?Limit=200&Offset=${offset}`, {
      headers: mbHeaders(mbToken)
    }, 12000);
    const data = await res.json();
    const batch = data.Clients || [];
    all = all.concat(batch);
    if (batch.length < 200) break;
  }
  return all;
}

// ─── Analytics API endpoints ──────────────────────────────────────────────────
app.get('/api/analytics/overview', requireAuth, async (req, res) => {
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
    const [allClients, currClassesRes, currSalesRes, prevClassesRes, prevSalesRes, membershipRes] = await Promise.all([
      fetchAllMBClients(mbToken),
      fetchWithTimeout(`${MB_BASE}/class/classes?StartDateTime=${startISO}&EndDateTime=${endISO}&Limit=200`, {
        headers: mbHeaders(mbToken)
      }, 12000),
      fetchWithTimeout(`${MB_BASE}/sale/sales?StartSaleDateTime=${startISO}&EndSaleDateTime=${endISO}`, {
        headers: mbHeaders(mbToken)
      }, 12000),
      fetchWithTimeout(`${MB_BASE}/class/classes?StartDateTime=${prevStartISO}&EndDateTime=${prevEndISO}&Limit=200`, {
        headers: mbHeaders(mbToken)
      }, 12000),
      fetchWithTimeout(`${MB_BASE}/sale/sales?StartSaleDateTime=${prevStartISO}&EndSaleDateTime=${prevEndISO}`, {
        headers: mbHeaders(mbToken)
      }, 12000),
      fetchWithTimeout(`${MB_BASE}/client/activeclientmemberships?Limit=200`, {
        headers: mbHeaders(mbToken)
      }, 12000),
    ]);

    const currClasses = (await currClassesRes.json()).Classes || [];
    const currSales = (await currSalesRes.json()).Sales || [];
    const prevClasses = (await prevClassesRes.json()).Classes || [];
    const prevSales = (await prevSalesRes.json()).Sales || [];
    const memberships = (await membershipRes.json()).ActiveClientMemberships || [];

    // ─── REVENUE & SALES ──────────────────────────────────────────────────────
    const totalRevenue = currSales.reduce((a, s) => a + (s.TotalAmount || s.Amount || 0), 0);
    const prevRevenue = prevSales.reduce((a, s) => a + (s.TotalAmount || s.Amount || 0), 0);
    const revenueGrowth = prevRevenue !== 0 ? Math.round(((totalRevenue - prevRevenue) / prevRevenue) * 100) : (totalRevenue > 0 ? 100 : 0);

    const totalSalesCount = currSales.length;
    const prevSalesCount = prevSales.length;
    const salesCountGrowth = prevSalesCount !== 0 ? Math.round(((totalSalesCount - prevSalesCount) / prevSalesCount) * 100) : (totalSalesCount > 0 ? 100 : 0);

    const avgSaleValue = totalSalesCount > 0 ? totalRevenue / totalSalesCount : 0;
    const prevAvgSaleValue = prevSalesCount > 0 ? prevRevenue / prevSalesCount : 0;
    const avgSaleGrowth = prevAvgSaleValue !== 0 ? Math.round(((avgSaleValue - prevAvgSaleValue) / prevAvgSaleValue) * 100) : (avgSaleValue > 0 ? 100 : 0);

    // Group sales by service type
    const revenueBySvcMap = {};
    currSales.forEach(s => {
      const svc = s.Description || 'Other';
      if (!revenueBySvcMap[svc]) revenueBySvcMap[svc] = { name: svc, revenue: 0, count: 0 };
      revenueBySvcMap[svc].revenue += (s.TotalAmount || s.Amount || 0);
      revenueBySvcMap[svc].count += 1;
    });
    const revenueBySvc = Object.values(revenueBySvcMap)
      .map(s => ({ ...s, pctOfTotal: totalRevenue > 0 ? Math.round((s.revenue / totalRevenue) * 100) : 0 }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    // Daily revenue trend
    const dailyRevenueMap = {};
    currSales.forEach(s => {
      const day = s.SaleDate ? s.SaleDate.split('T')[0] : new Date().toISOString().split('T')[0];
      if (!dailyRevenueMap[day]) dailyRevenueMap[day] = { date: day, revenue: 0, sales: 0 };
      dailyRevenueMap[day].revenue += (s.TotalAmount || s.Amount || 0);
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

    // At-risk clients (no visit in 14+ days)
    const twoWeeksAgo = new Date(Date.now() - 14*24*60*60*1000);
    const atRiskClients = allClients
      .filter(c => {
        if (c.Active === false) return false;
        const lastVisit = c.LastVisit ? new Date(c.LastVisit) : (c.LastModifiedDateTime ? new Date(c.LastModifiedDateTime) : new Date(0));
        return lastVisit < twoWeeksAgo;
      })
      .sort((a, b) => {
        const aLast = a.LastVisit ? new Date(a.LastVisit) : (a.LastModifiedDateTime ? new Date(a.LastModifiedDateTime) : new Date(0));
        const bLast = b.LastVisit ? new Date(b.LastVisit) : (b.LastModifiedDateTime ? new Date(b.LastModifiedDateTime) : new Date(0));
        return aLast - bLast;
      })
      .slice(0, 10)
      .map(c => ({
        name: `${c.FirstName || ''} ${c.LastName || ''}`.trim(),
        email: c.Email,
        lastVisit: c.LastVisit || c.LastModifiedDateTime || 'Unknown',
        totalVisits: c.VisitCount || 0,
      }));

    // Recent clients (newest)
    const recentClients = allClients
      .filter(c => c.CreationDate)
      .sort((a, b) => new Date(b.CreationDate) - new Date(a.CreationDate))
      .slice(0, 10)
      .map(c => ({
        name: `${c.FirstName || ''} ${c.LastName || ''}`.trim(),
        email: c.Email,
        joinDate: c.CreationDate,
        visits: c.VisitCount || 0,
      }));

    // ─── MEMBERSHIPS ─────────────────────────────────────────────────────────
    const activeMemberships = memberships.length;
    const prevActiveMemberships = memberships.length; // No comparison period for memberships in this API
    const membershipGrowth = 0; // Would require historical data

    const membershipTypesMap = {};
    memberships.forEach(m => {
      const type = m.MembershipType?.Name || 'Other';
      membershipTypesMap[type] = (membershipTypesMap[type] || 0) + 1;
    });
    const membershipTypes = Object.entries(membershipTypesMap)
      .map(([name, count]) => ({ name, count, pctOfTotal: activeMemberships > 0 ? Math.round((count / activeMemberships) * 100) : 0 }))
      .sort((a, b) => b.count - a.count);

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
