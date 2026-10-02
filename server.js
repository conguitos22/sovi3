require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
  throw new Error('Defina SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY (veja .env.example)');
}
const SUPA_ORIGIN = new URL(SUPABASE_URL).origin;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SELLER_WHATSAPP = (process.env.SELLER_WHATSAPP || '').replace(/\D/g, '');
const OWNER_EMAIL = (process.env.STORE_OWNER_EMAIL || '').trim();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const mailer = (process.env.SMTP_HOST) ? nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
}) : null;
async function sendEmail({ to, subject, html }) {
  if (process.env.RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.MAIL_FROM || 'SOVÍ VAULT <onboarding@resend.dev>', to, subject, html })
      });
      if (!r.ok) console.error('Resend falhou:', r.status, await r.text());
    } catch (e) { console.error('Resend erro:', e.message); }
    return;
  }
  if (mailer) {
    try { await mailer.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, html }); }
    catch (e) { console.error('SMTP erro:', e.message); }
  }
}
async function sendReceipt(order) {
  if (!mailer && !process.env.RESEND_API_KEY) return;
  const rows = order.items.map(i => `<tr><td style="padding:4px 10px 4px 0;">${i.name} × ${i.qty}</td><td style="padding:4px 0;text-align:right;">${money(i.price * i.qty)}</td></tr>`).join('');
  const html = `<div style="font-family:Georgia,serif;max-width:480px;margin:auto;color:#111">
    <h2 style="letter-spacing:2px;">SOVÍ VAULT</h2>
    <p>Olá, ${order.customer_name}! Recebemos seu pedido <strong>${order.id}</strong>.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}
      <tr><td style="padding-top:10px;font-weight:bold;">Total</td><td style="padding-top:10px;text-align:right;font-weight:bold;">${money(order.total)}</td></tr>
    </table>
    <p style="color:#666;font-size:13px;">Data: ${order.date}</p></div>`;
  await sendEmail({ to: order.customer_email, subject: `Pedido ${order.id} confirmado — SOVÍ VAULT`, html });
}
async function sendOwnerAlert(order) {
  if ((!mailer && !process.env.RESEND_API_KEY) || !OWNER_EMAIL) return;
  const rows = order.items.map(i => `<tr><td style="padding:4px 10px 4px 0;">${i.name} × ${i.qty}</td><td style="padding:4px 0;text-align:right;">${money(i.price * i.qty)}</td></tr>`).join('');
  const html = `<div style="font-family:Georgia,serif;max-width:480px;margin:auto;color:#111">
    <h2 style="letter-spacing:2px;">Novo pedido — SOVÍ VAULT</h2>
    <p><strong>${order.id}</strong> · ${order.date}</p>
    <p>Cliente: ${order.customer_name}<br>E-mail: ${order.customer_email}${order.customer_phone ? '<br>Telefone: ' + order.customer_phone : ''}</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}
      <tr><td style="padding-top:10px;font-weight:bold;">Total</td><td style="padding-top:10px;text-align:right;font-weight:bold;">${money(order.total)}</td></tr>
    </table></div>`;
  await sendEmail({ to: OWNER_EMAIL, subject: `Novo pedido ${order.id} — ${money(order.total)}`, html });
}
function money(n) { return 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2 }); }
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, opts); // só no servidor: ignora RLS
const newAnon = () => createClient(SUPABASE_URL, SUPABASE_ANON_KEY, opts);

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ['https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', SUPA_ORIGIN],
      connectSrc: ["'self'"],
      mediaSrc: ["'self'", SUPA_ORIGIN],
      upgradeInsecureRequests: null
    }
  }
}));
app.use(express.json({ limit: '3mb' }));

const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Erro interno' }); });
const fail = (res, e) => { console.error(e); return res.status(500).json({ error: 'Erro no banco de dados' }); };
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, validate: false, message: { error: 'Muitas tentativas. Tente novamente em 15 minutos.' } });
const orderLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, validate: false, message: { error: 'Muitos pedidos em pouco tempo. Aguarde alguns minutos.' } });

/* ---------- helpers ---------- */
const CATS = ['Chronograph', 'Classic', 'Sport', 'Diver', 'Racing', 'Premium'];
const AVAIL = ['Em estoque', 'Últimas unidades', 'Esgotado'];
const TAGS = ['', 'oferta', 'limitado', 'destaque'];

const toApi = r => ({
  id: r.id, name: r.name, cat: r.cat, price: Number(r.price),
  old: r.old_price != null ? Number(r.old_price) : undefined,
  rating: Number(r.rating), color: r.color, avail: r.avail, tag: r.tag || '',
  image: r.image || undefined, desc: r.description || '', move: r.move, mat: r.mat,
  strap: r.strap, water: r.water, size: r.size, sold: r.sold
});

function clean(b) {
  const r = {};
  if ('name' in b) { const v = String(b.name).trim(); if (!v || v.length > 80) return { error: 'Nome inválido' }; r.name = v; }
  if ('cat' in b) { if (!CATS.includes(b.cat)) return { error: 'Categoria inválida' }; r.cat = b.cat; }
  if ('price' in b) { const v = Number(b.price); if (!(v > 0 && v < 1e7)) return { error: 'Preço inválido' }; r.price = v; }
  if ('old' in b) { const v = Number(b.old); r.old_price = v > 0 ? v : null; }
  if ('rating' in b) { r.rating = Math.min(5, Math.max(0, Number(b.rating) || 4.5)); }
  if ('color' in b) { if (!/^#[0-9a-f]{6}$/i.test(b.color)) return { error: 'Cor inválida' }; r.color = b.color; }
  if ('avail' in b) { if (!AVAIL.includes(b.avail)) return { error: 'Disponibilidade inválida' }; r.avail = b.avail; }
  if ('tag' in b) { if (!TAGS.includes(b.tag || '')) return { error: 'Etiqueta inválida' }; r.tag = b.tag || null; }
  if ('desc' in b) { r.description = String(b.desc).slice(0, 1000); }
  if ('image' in b) {
    const v = b.image;
    if (v && !(typeof v === 'string' && v.length < 600 && v.startsWith(SUPA_ORIGIN + '/storage/v1/object/public/'))) return { error: 'Imagem inválida' };
    r.image = v || null;
  }
  return { row: r };
}

async function requireAdmin(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!token) return res.status(401).json({ error: 'Não autenticado' });
    const { data, error } = await newAnon().auth.getUser(token);
    const user = data && data.user;
    const email = user && user.email && user.email.toLowerCase();
    if (error || !email || !user.email_confirmed_at || !ADMIN_EMAILS.includes(email)) {
      return res.status(401).json({ error: 'Acesso negado' });
    }
    next();
  } catch (e) { res.status(401).json({ error: 'Acesso negado' }); }
}

/* ---------- API pública ---------- */
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/products', wrap(async (_req, res) => {
  const { data, error } = await db.from('products').select('*').order('id');
  if (error) return fail(res, error);
  res.set('Cache-Control', 'public, max-age=15').json(data.map(toApi));
}));

// O total é SEMPRE recalculado aqui, com os preços do banco — nunca confiamos no valor vindo do navegador.
app.post('/api/orders', orderLimiter, wrap(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 50) : [];
  if (!items.length) return res.status(400).json({ error: 'Carrinho vazio' });
  const name = String(req.body.name || '').trim().slice(0, 100);
  const email = String(req.body.email || '').trim().slice(0, 200);
  const phone = String(req.body.phone || '').replace(/\D/g, '').slice(0, 20);
  if (!name) return res.status(400).json({ error: 'Informe seu nome' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'E-mail inválido' });
  const ids = [...new Set(items.map(i => Number(i.id)))];
  if (ids.some(id => !Number.isInteger(id))) return res.status(400).json({ error: 'Item inválido' });
  const { data: prods, error } = await db.from('products').select('id,name,price,avail').in('id', ids);
  if (error) return fail(res, error);
  const byId = new Map(prods.map(p => [p.id, p]));
  const lines = []; let subtotal = 0;
  for (const i of items) {
    const p = byId.get(Number(i.id)); const qty = Math.floor(Number(i.qty));
    if (!p || !(qty >= 1 && qty <= 20)) return res.status(400).json({ error: 'Item inválido' });
    if (p.avail === 'Esgotado') return res.status(409).json({ error: p.name + ' está esgotado' });
    lines.push({ name: p.name, qty, price: Number(p.price) });
    subtotal += Number(p.price) * qty;
  }
  const shipping = subtotal > 5000 ? 0 : 69;
  const order = {
    id: 'SV' + Date.now().toString().slice(-6) + Math.floor(Math.random() * 90 + 10),
    date: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    items: lines, total: subtotal + shipping, status: 'Confirmado',
    customer_name: name, customer_email: email, customer_phone: phone || null
  };
  const { error: e2 } = await db.from('orders').insert(order);
  if (e2) return fail(res, e2);
  sendReceipt(order);
  sendOwnerAlert(order);
  let whatsapp = null;
  if (SELLER_WHATSAPP) {
    const resumo = lines.map(l => `${l.qty}x ${l.name}`).join(', ');
    const texto = `Olá! Acabei de fazer o pedido ${order.id} na SOVÍ VAULT (${name}).\n${resumo}\nTotal: ${money(order.total)}`;
    whatsapp = `https://wa.me/${SELLER_WHATSAPP}?text=${encodeURIComponent(texto)}`;
  }
  res.status(201).json({ id: order.id, total: order.total, whatsapp });
}));

/* ---------- API do admin ---------- */
app.post('/api/admin/login', loginLimiter, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Informe e-mail e senha' });
  const { data, error } = await newAnon().auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    return res.status(401).json({ error: /confirm/i.test((error && error.message) || '') ? 'Confirme seu e-mail antes de entrar.' : 'E-mail ou senha inválidos.' });
  }
  if (!ADMIN_EMAILS.includes(email) || !data.user.email_confirmed_at) {
    return res.status(403).json({ error: 'Esta conta não tem acesso ao painel.' });
  }
  res.json({ token: data.session.access_token, email });
}));

// Foto de produto: o navegador manda a imagem já redimensionada; o servidor guarda no Supabase Storage e devolve a URL pública.
app.post('/api/upload', requireAdmin, wrap(async (req, res) => {
  const m = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body && req.body.image) || ''));
  if (!m) return res.status(400).json({ error: 'Imagem inválida' });
  const buf = Buffer.from(m[3], 'base64');
  if (buf.length > 2 * 1024 * 1024) return res.status(413).json({ error: 'Imagem muito grande (máx. 2 MB)' });
  const name = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + (m[2] === 'jpeg' ? 'jpg' : m[2]);
  const { error } = await db.storage.from('products').upload(name, buf, { contentType: m[1], cacheControl: '31536000' });
  if (error) return fail(res, error);
  res.status(201).json({ url: db.storage.from('products').getPublicUrl(name).data.publicUrl });
}));

app.get('/api/orders', requireAdmin, wrap(async (_req, res) => {
  const { data, error } = await db.from('orders').select('*').order('created_at', { ascending: false }).limit(100);
  if (error) return fail(res, error);
  res.json(data);
}));

app.post('/api/products', requireAdmin, wrap(async (req, res) => {
  const { row, error: err } = clean(req.body || {});
  if (err) return res.status(400).json({ error: err });
  if (!row.name || !row.cat || !row.price) return res.status(400).json({ error: 'Nome, categoria e preço são obrigatórios' });
  const { data, error } = await db.from('products').insert(row).select().single();
  if (error) return fail(res, error);
  res.status(201).json(toApi(data));
}));

app.put('/api/products/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const { row, error: err } = clean(req.body || {});
  if (err) return res.status(400).json({ error: err });
  const { data, error } = await db.from('products').update(row).eq('id', id).select().single();
  if (error) return fail(res, error);
  res.json(toApi(data));
}));

app.delete('/api/products/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const { error } = await db.from('products').delete().eq('id', id);
  if (error) return fail(res, error);
  res.status(204).end();
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada' }));
// Qualquer erro que escape das rotas (ex: middleware) ainda volta como JSON, nunca a página de erro padrão da Vercel
app.use((err, _req, res, _next) => { console.error('Erro não tratado:', err); res.status(500).json({ error: 'Erro interno' }); });
app.use(express.static(path.join(__dirname, 'public')));

module.exports = app;
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('SOVÍ VAULT rodando em http://localhost:' + port));
}
