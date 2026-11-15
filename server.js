'use strict';
/* =====================================================================
   Mentoris — servidor
   - Sirve la app (carpeta public/)
   - Guarda la base de datos y los archivos en una nube compatible con S3 (Backblaze B2, R2...) o en ./data si no hay credenciales
   - Sesiones con cookie (duran 90 días), contraseñas con PBKDF2
   - Sin dependencias externas: solo Node 18+
   ===================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { createStorage } = require('./lib/storage');

const PORT = +process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const SECRET = process.env.SESSION_SECRET || (PROD ? '' : 'solo-para-pruebas-locales');
if (!SECRET || SECRET.length < 16) { console.error('Falta la variable SESSION_SECRET (mínimo 16 caracteres).'); process.exit(1); }
const store = createStorage(process.env);
const PUBLIC = path.join(__dirname, 'public');
const SESSION_DAYS = 90;
const MAX_UPLOAD = 26 * 1048576;
const rid = () => crypto.randomBytes(8).toString('hex');

/* ---------- datos base ---------- */
const COLS = ['users', 'grados', 'cursos', 'modulos', 'tareas', 'entregas', 'examenes', 'intentos', 'asistencia', 'anuncios', 'mensajes', 'notifs'];
const ROLES = ['admin', 'director', 'secretaria', 'maestro', 'alumno', 'padre'];
const PERM_KEYS = ['usuarios', 'grados', 'cursos', 'reportes', 'anuncio_general', 'anuncio_grado', 'anuncio_curso', 'anuncio_maestros', 'tareas', 'examenes', 'calificar', 'asistencia', 'modulos', 'buzon_masivo', 'solvencia', 'personalizar', 'permisos'];
const DEFAULT_PERMS = {
  director: ['grados', 'cursos', 'reportes', 'anuncio_general', 'anuncio_grado', 'anuncio_maestros', 'buzon_masivo'],
  secretaria: ['usuarios', 'cursos', 'anuncio_general', 'solvencia', 'buzon_masivo'],
  maestro: ['anuncio_curso', 'tareas', 'examenes', 'calificar', 'asistencia', 'modulos', 'buzon_masivo'],
  alumno: [], padre: []
};
const defaultDB = () => ({
  v: 2, _rev: 0,
  config: { nombre: 'Mi Colegio', logo: null, appIconV: 0, colors: { p: '#1e3a52', a: '#2f80ed', bg: '#f4f6fb' }, ui: { font: 'moderna', radius: 'suave', dens: 'normal', side: 'oscuro' } },
  perms: JSON.parse(JSON.stringify(DEFAULT_PERMS)),
  users: [], grados: [], cursos: [], modulos: [], tareas: [], entregas: [], examenes: [], intentos: [], asistencia: [], anuncios: [], mensajes: [], notifs: [], locks: {}
});
function migrate(db, imported) {
  const base = defaultDB();
  Object.keys(base).forEach(k => { if (db[k] === undefined) db[k] = base[k]; });
  db.config.ui = Object.assign({}, base.config.ui, db.config.ui || {});
  db.config.colors = Object.assign({}, base.config.colors, db.config.colors || {});
  if (db.config.appIconV === undefined) db.config.appIconV = 0;
  // v2: cada curso tiene su horario por día: horarios = [{ dia, inicio, fin }]
  db.cursos.forEach(c => {
    if (!Array.isArray(c.horarios)) c.horarios = (c.dias || []).map(d => ({ dia: d, inicio: c.inicio, fin: c.fin }));
    delete c.dias; delete c.inicio; delete c.fin;
  });
  if (imported) db.tareas.forEach(t => { if (!t.notificada && new Date(t.publica) <= new Date()) t.notificada = true; });
  db.locks = {};
  db.v = 2;
  return db;
}

let db = null;
let persistT = null, persisting = false, persistAgain = false, lastBackupDay = '';
const touchDb = () => { db._rev++; clearTimeout(persistT); persistT = setTimeout(persist, 800); };
async function persist() {
  if (persisting) { persistAgain = true; return; }
  persisting = true;
  try {
    do {
      persistAgain = false;
      const body = Buffer.from(JSON.stringify(db));
      await store.put('db/db.json', body, { contentType: 'application/json' });
      await dailyBackup(body);
    } while (persistAgain);
  } catch (e) { console.error('No se pudo guardar la base de datos:', e.message); setTimeout(persist, 5000); }
  finally { persisting = false; }
}
async function dailyBackup(body) {
  const day = new Date().toISOString().slice(0, 10);
  if (day === lastBackupDay) return;
  await store.put(`db/backups/${day}.json`, body, { contentType: 'application/json' });
  lastBackupDay = day;
  const all = (await store.list('db/backups/')).map(o => o.key).sort();
  for (const k of all.slice(0, Math.max(0, all.length - 14))) await store.del(k);
}
async function loadDb() {
  const o = await store.get('db/db.json');
  if (!o) {
    // Si falta db.json pero hay copias diarias, NO empezamos de cero: restauramos la más reciente.
    const bk = (await store.list('db/backups/')).map(x => x.key).sort();
    if (bk.length) {
      const b = await store.get(bk[bk.length - 1]);
      if (b) { db = migrate(JSON.parse(b.body.toString('utf8')), false); db._rev = (db._rev || 0) + 1; console.warn(`AVISO: db.json no estaba; se restauró la copia ${bk[bk.length - 1]} (${db.users.length} usuarios).`); touchDb(); return; }
    }
    db = defaultDB(); console.log('Base de datos nueva (primer arranque).'); return;
  }
  db = migrate(JSON.parse(o.body.toString('utf8')), false);
  console.log(`Base de datos cargada (${db.users.length} usuarios, rev ${db._rev}).`);
}

/* ---------- archivos ---------- */
const BAD_EXT = /\.(exe|bat|cmd|com|msi|js|mjs|vbs|ps1|sh|jar|html?|svg|php|scr|dll)$/i;
const INLINE = /^image\/(png|jpeg|webp|gif)$/;
const GZ_TYPE = /^(text\/|application\/(pdf|json|xml|msword|vnd\.ms-excel|vnd\.ms-powerpoint|rtf|x-rtf))/;
const GZ_EXT = /\.(pdf|txt|csv|json|xml|doc|xls|ppt|rtf|md)$/i;
async function saveFile(buf, name, type) {
  let id = crypto.randomBytes(16).toString('hex'), body = buf;
  if (buf.length > 2048 && (GZ_TYPE.test(type) || GZ_EXT.test(name))) {
    const gz = zlib.gzipSync(buf, { level: 9 });
    if (gz.length < buf.length * 0.92) { body = gz; id += 'z'; }   // la "z" final del id marca que se guardó comprimido
  }
  await store.put('files/' + id, body, { contentType: type });
  return { id, url: `/api/file/${id}/${encodeURIComponent(name)}`, stored: body.length };
}
async function readFileObj(key) {
  const o = await store.get(key);
  if (!o) return null;
  let body = o.body;
  if (key.endsWith('z')) { try { body = zlib.gunzipSync(body); } catch (e) { return null; } }
  return { body, contentType: o.contentType };
}
async function convertDataUrls(node) {
  if (Array.isArray(node)) { for (const x of node) await convertDataUrls(x); return; }
  if (!node || typeof node !== 'object') return;
  if (typeof node.data === 'string' && node.data.startsWith('data:') && typeof node.name === 'string') {
    const m = node.data.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/);
    if (m) {
      const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
      const type = node.type || m[1] || 'application/octet-stream';
      if (!BAD_EXT.test(node.name)) { const f = await saveFile(buf, node.name, type); node.data = f.url; node.size = buf.length; }
      else node.data = '';
    }
    return;
  }
  for (const k of Object.keys(node)) if (k !== 'logo') await convertDataUrls(node[k]);
}
async function gcFiles() {
  try {
    if (!db || !db.users.length) return;
    const text = JSON.stringify(db);
    const used = new Set([...text.matchAll(/\/api\/file\/([a-f0-9]{32}z?)/g)].map(m => m[1]));
    const files = await store.list('files/');
    let n = 0;
    for (const f of files) {
      const id = f.key.slice(6);
      if (!used.has(id) && Date.now() - f.lastModified > 24 * 3600 * 1000) { await store.del(f.key); n++; }
    }
    if (n) console.log(`Limpieza: ${n} archivo(s) sin uso eliminados.`);
  } catch (e) { console.error('Limpieza de archivos falló:', e.message); }
}

/* ---------- contraseñas y sesiones ---------- */
const pbkdf2 = (pw, salt) => new Promise((res, rej) => crypto.pbkdf2(String(pw), String(salt), 120000, 32, 'sha256', (e, k) => e ? rej(e) : res(k.toString('hex'))));
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function validarPw(pw, username) {
  pw = String(pw || '');
  if (pw.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Debe incluir letras y números.';
  if (username && pw.toLowerCase() === username) return 'La contraseña no puede ser igual a tu usuario.';
  return '';
}
const mkToken = uid => {
  const p = Buffer.from(JSON.stringify({ u: uid, e: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
};
const parseCookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(a => a[0]));
function sessionUser(req) {
  const t = parseCookies(req).ms;
  if (!t) return null;
  const [p, sig] = t.split('.');
  if (!p || !sig) return null;
  const ok = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  if (!safeEq(sig, ok)) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (d.e < Date.now()) return null;
    const u = db.users.find(x => x.id === d.u);
    return u && u.activo !== false ? u : null;
  } catch (e) { return null; }
}
const setSession = (res, uid) => res.setHeader('Set-Cookie', `ms=${mkToken(uid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${PROD ? '; Secure' : ''}`);
const clearSession = res => res.setHeader('Set-Cookie', `ms=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${PROD ? '; Secure' : ''}`);
const locks = new Map(), ipHits = new Map();
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

/* ---------- permisos ---------- */
const has = (u, p) => u.role === 'admin' || (db.perms[u.role] || []).includes(p);
const hasAny = (u, ps) => ps.some(p => has(u, p));
const ANUN = ['anuncio_general', 'anuncio_grado', 'anuncio_curso', 'anuncio_maestros'];
const COL_PERM = { grados: ['grados'], cursos: ['cursos', 'usuarios'], modulos: ['modulos'], tareas: ['tareas'], examenes: ['examenes'], asistencia: ['asistencia'], anuncios: ANUN, entregas: ['calificar'], intentos: ['examenes'] };
const CASCADE = ['cursos', 'usuarios', 'grados'];
const stripAuth = ({ hash, salt, ...r }) => r;
const PUBLIC_USER = u => ({ id: u.id, nombre1: u.nombre1, nombre2: u.nombre2, apellido1: u.apellido1, apellido2: u.apellido2, role: u.role, activo: u.activo });

/* Lo que cada persona recibe: no se envían contraseñas, y alumnos/padres solo reciben sus propios datos. */
function visibleDb(u) {
  const out = { v: db.v, config: db.config, perms: db.perms, locks: {} };
  const kids = u.role === 'padre' ? db.users.filter(x => x.role === 'alumno' && x.padreId === u.id).map(x => x.id) : [];
  const mine = u.role === 'alumno' ? [u.id] : kids;
  COLS.forEach(c => { out[c] = db[c]; });
  out.mensajes = db.mensajes.filter(m => m.de === u.id || m.para === u.id);
  out.notifs = db.notifs.filter(n => n.uid === u.id);
  if (['alumno', 'padre'].includes(u.role)) {
    const fam = new Set([u.id, u.padreId, ...kids].filter(Boolean));
    out.users = db.users.filter(x => fam.has(x.id) || !['alumno', 'padre'].includes(x.role)).map(x => fam.has(x.id) ? stripAuth(x) : PUBLIC_USER(x));
    out.entregas = db.entregas.filter(e => mine.includes(e.alumnoId));
    out.intentos = db.intentos.filter(i => mine.includes(i.alumnoId));
    out.asistencia = db.asistencia.map(r => { const reg = {}; mine.forEach(id => { if (r.reg && r.reg[id]) reg[id] = r.reg[id]; }); return Object.keys(reg).length ? { ...r, reg } : null; }).filter(Boolean);
    out.anuncios = db.anuncios.filter(a => a.alcance !== 'maestros');
  } else out.users = db.users.map(stripAuth);
  return out;
}

/* Aplica los cambios enviados por un cliente (solo lo que su rol permite). */
function applyPatch(actor, patch) {
  let changed = false;
  const byId = c => new Map(db[c].map((x, i) => [x.id, i]));
  const put = (c, obj, idx) => { const i = idx.get(obj.id); if (i === undefined) { db[c].push(obj); idx.set(obj.id, db[c].length - 1); } else db[c][i] = obj; changed = true; };
  const del = (c, id) => { const i = db[c].findIndex(x => x.id === id); if (i >= 0) { db[c].splice(i, 1); changed = true; } };
  const isStudent = actor.role === 'alumno';
  for (const c of COLS) {
    const ch = patch.cols && patch.cols[c];
    if (!ch) continue;
    const ups = Array.isArray(ch.up) ? ch.up.filter(x => x && typeof x.id === 'string') : [];
    const rms = Array.isArray(ch.rm) ? ch.rm.filter(x => typeof x === 'string') : [];
    const idx = byId(c);
    const stored = id => db[c][idx.get(id)];
    if (c === 'users') {
      for (const up of ups) {
        const st = stored(up.id);
        if (!st) {
          if (!has(actor, 'usuarios') || !ROLES.includes(up.role) || (up.role === 'admin' && actor.role !== 'admin')) continue;
          if (!up.hash || !up.salt || !up.username || db.users.some(x => x.username === up.username)) continue;
          put(c, { ...up }, idx);
        } else if (has(actor, 'usuarios') && (st.role !== 'admin' || actor.role === 'admin') && (up.role !== 'admin' || actor.role === 'admin') && ROLES.includes(up.role)) {
          const m = { ...up }; if (!m.hash || !m.salt) { m.hash = st.hash; m.salt = st.salt; }
          m.username = st.username;
          put(c, m, idx);
        } else if (has(actor, 'solvencia') && st.role === 'alumno' && typeof up.solvente === 'boolean' && st.solvente !== up.solvente) { st.solvente = up.solvente; changed = true; }
      }
      for (const id of rms) { const st = stored(id); if (st && id !== actor.id && has(actor, 'usuarios') && (st.role !== 'admin' || actor.role === 'admin')) del(c, id); }
      continue;
    }
    if (c === 'mensajes') {
      for (const up of ups) {
        const st = stored(up.id);
        if (!st) { if (up.de === actor.id) put(c, up, idx); }
        else if (st.de === actor.id) put(c, { ...up, de: st.de, para: st.para }, idx);
        else if (st.para === actor.id) { st.leido = !!up.leido; st.delPara = !!up.delPara; changed = true; }
      }
      for (const id of rms) { const st = stored(id); if (st && st.de === actor.id) del(c, id); }
      continue;
    }
    if (c === 'notifs') {
      for (const up of ups) {
        const st = stored(up.id);
        if (!st) { if (up.key && db.notifs.some(n => n.key === up.key)) continue; put(c, up, idx); }
        else if (st.uid === actor.id) { st.leido = !!up.leido; changed = true; }
      }
      for (const id of rms) { const st = stored(id); if (st && st.uid === actor.id) del(c, id); }
      continue;
    }
    if (isStudent && (c === 'entregas' || c === 'intentos')) {
      for (const up of ups) {
        if (up.alumnoId !== actor.id) continue;
        const st = stored(up.id);
        if (c === 'entregas') {
          const keep = ['id', 'tareaId', 'alumnoId', 'texto', 'links', 'archivo', 'fecha', 'tarde'];
          const clean = Object.fromEntries(keep.filter(k => up[k] !== undefined).map(k => [k, up[k]]));
          if (!st) put(c, clean, idx);
          else if (st.alumnoId === actor.id && (st.nota === undefined || st.nota === null || st.nota === '')) put(c, { ...st, ...clean }, idx);
        } else {
          if (!st) { if (!db.intentos.some(i => i.examenId === up.examenId && i.alumnoId === actor.id)) put(c, up, idx); }
          else if (st.alumnoId === actor.id && st.estado === 'en_curso') put(c, { ...up, alumnoId: st.alumnoId, examenId: st.examenId }, idx);
        }
      }
      for (const id of rms) { const st = stored(id); if (c === 'entregas' && st && st.alumnoId === actor.id && (st.nota === undefined || st.nota === null || st.nota === '')) del(c, id); }
      continue;
    }
    if (['alumno', 'padre'].includes(actor.role)) continue;
    const need = COL_PERM[c];
    if (!need) continue;
    if (hasAny(actor, need)) {
      for (const up of ups) {
        if (c === 'anuncios') { const st = stored(up.id); if (st && st.autor !== actor.id && actor.role !== 'admin') continue; }
        put(c, up, idx);
      }
    }
    for (const id of rms) {
      const st = stored(id);
      if (!st) continue;
      const ok = hasAny(actor, need) || hasAny(actor, CASCADE) || (c === 'anuncios' && st.autor === actor.id);
      if (ok) del(c, id);
    }
  }
  if (patch.config && typeof patch.config === 'object' && has(actor, 'personalizar')) {
    db.config = { ...patch.config, appIconV: db.config.appIconV }; changed = true;
  }
  if (patch.perms && typeof patch.perms === 'object' && has(actor, 'permisos')) {
    const np = {}; ROLES.filter(r => r !== 'admin').forEach(r => { np[r] = (Array.isArray(patch.perms[r]) ? patch.perms[r] : []).filter(p => PERM_KEYS.includes(p)); });
    db.perms = np; changed = true;
  }
  return changed;
}

/* Tareas programadas: avisa a los alumnos cuando se publica una tarea. */
function serverTick() {
  if (!db) return;
  let ch = false; const now = Date.now();
  for (const t of db.tareas) {
    if (!t.notificada && new Date(t.publica) <= now) {
      t.notificada = true; ch = true;
      const c = db.cursos.find(x => x.id === t.cursoId);
      if (c) db.users.filter(u => u.role === 'alumno' && u.gradoId === c.gradoId && u.activo !== false)
        .forEach(a => db.notifs.push({ id: rid(), uid: a.id, title: 'Nueva tarea: ' + t.titulo, body: c.nombre, view: 'tareas', fecha: now, leido: false }));
    }
  }
  if (db.notifs.length > 4000) { db.notifs.splice(0, db.notifs.length - 4000); ch = true; }
  if (ch) touchDb();
}

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
const send = (res, code, body, headers = {}) => { res.writeHead(code, headers); res.end(body); };
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(Object.assign(new Error('Archivo demasiado grande'), { code: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
const readJson = async (req, limit = 3 * 1048576) => { const b = await readBody(req, limit); try { return JSON.parse(b.toString('utf8') || '{}'); } catch (e) { throw Object.assign(new Error('JSON inválido'), { code: 400 }); } };
const needUser = (req, res) => { const u = sessionUser(req); if (!u) json(res, 401, { error: 'Sesión no válida' }); return u; };

async function importDb(obj) {
  if (!obj || !Array.isArray(obj.users) || !obj.config || !obj.perms) throw Object.assign(new Error('El archivo de respaldo no es válido.'), { code: 400 });
  await convertDataUrls(obj);
  const n = migrate(obj, true);
  n._rev = (db._rev || 0) + 1;
  db = n; touchDb();
}
function iconFile(res, name, fallback) {
  (db.config.appIconV ? store.get('icons/' + name) : Promise.resolve(null)).then(o => {
    const hdr = { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' };
    if (o) return send(res, 200, o.body, hdr);
    send(res, 200, fs.readFileSync(path.join(PUBLIC, 'icons', fallback)), hdr);
  }).catch(() => send(res, 500, 'error'));
}
const dataUrlPng = s => { const m = String(s || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/); return m ? Buffer.from(m[1], 'base64') : null; };

async function route(req, res, url) {
  const p = url.pathname, m = req.method;
  if (m !== 'GET' && m !== 'HEAD' && req.headers.origin) { try { if (new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: 'Origen no permitido' }); } catch (e) { return json(res, 403, { error: 'Origen no permitido' }); } }

  if (p === '/healthz') return json(res, 200, { ok: true, storage: store.kind });

  if (p === '/manifest.webmanifest') {
    const v = db.config.appIconV || 0, c = db.config.colors;
    return send(res, 200, JSON.stringify({
      id: '/', name: 'Mentoris', short_name: 'Mentoris', description: 'Plataforma escolar: tareas, exámenes, anuncios y asistencia',
      start_url: '/', scope: '/', display: 'standalone', orientation: 'any', lang: 'es', background_color: c.bg, theme_color: c.p,
      icons: [
        { src: `/icons/app-192.png?v=${v}`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `/icons/app-512.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `/icons/app-maskable.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    }), { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
  }
  if (p === '/icons/app-192.png') return iconFile(res, 'app-192.png', 'icon-192.png');
  if (p === '/icons/app-512.png') return iconFile(res, 'app-512.png', 'icon-512.png');
  if (p === '/icons/app-maskable.png') return iconFile(res, 'app-maskable.png', 'icon-512.png');

  if (p === '/api/public' && m === 'GET') {
    const u = sessionUser(req);
    if (u) setSession(res, u.id);
    return json(res, 200, { setup: db.users.length === 0, uid: u ? u.id : null, config: db.config });
  }
  if (p === '/api/setup' && m === 'POST') {
    if (db.users.length) return json(res, 400, { error: 'El sistema ya fue configurado.' });
    const b = await readJson(req);
    const s = k => String(b[k] || '').trim();
    const usuario = s('usuario').toLowerCase();
    if (!s('colegio') || !s('nombre1') || !s('apellido1') || !/^[a-z0-9._]{3,30}$/.test(usuario)) return json(res, 400, { error: 'Completa todos los campos (usuario: minúsculas, números, punto o guion bajo).' });
    const pe = validarPw(b.pw, usuario); if (pe) return json(res, 400, { error: pe });
    const salt = crypto.randomBytes(16).toString('hex');
    const u = { id: rid(), nombre1: s('nombre1'), nombre2: '', apellido1: s('apellido1'), apellido2: '', direccion: '', telefono: '', nacimiento: '', role: 'admin', username: usuario, salt, hash: await pbkdf2(b.pw, salt), mustChange: false, activo: true, solvente: true, creado: Date.now() };
    db.config.nombre = s('colegio').slice(0, 80); db.users.push(u); touchDb();
    setSession(res, u.id);
    return json(res, 200, { uid: u.id });
  }
  if (p === '/api/import-legacy' && m === 'POST') {
    if (db.users.length) return json(res, 400, { error: 'El sistema ya tiene usuarios.' });
    await importDb(await readJson(req, 120 * 1048576));
    return json(res, 200, { ok: true });
  }
  if (p === '/api/login' && m === 'POST') {
    const ip = clientIp(req), now = Date.now();
    const h = (ipHits.get(ip) || []).filter(t => now - t < 600000);
    if (h.length >= 40) return json(res, 429, { error: 'Demasiados intentos desde este dispositivo. Espera unos minutos.' });
    h.push(now); ipHits.set(ip, h);
    const b = await readJson(req);
    const username = String(b.usuario || '').trim().toLowerCase();
    const lk = locks.get(username);
    if (lk && lk.until > now) return json(res, 429, { error: `Demasiados intentos. Intenta de nuevo en ${Math.ceil((lk.until - now) / 60000)} min.` });
    const u = db.users.find(x => x.username === username);
    const hash = await pbkdf2(b.clave || '', u ? u.salt : 'sin-usuario');
    if (!u || u.activo === false || !safeEq(hash, u.hash)) {
      const l = locks.get(username) || { n: 0 }; l.n++;
      if (l.n >= 5) { l.until = now + 5 * 60000; l.n = 0; }
      locks.set(username, l);
      return json(res, 401, { error: 'Usuario o contraseña incorrectos.' });
    }
    locks.delete(username);
    setSession(res, u.id);
    return json(res, 200, { uid: u.id });
  }
  if (p === '/api/logout' && m === 'POST') { clearSession(res); return json(res, 200, { ok: true }); }

  /* ---- a partir de aquí hace falta sesión ---- */
  if (p.startsWith('/api/')) {
    const u = needUser(req, res); if (!u) return;
    if (p === '/api/rev' && m === 'GET') return json(res, 200, { rev: db._rev });
    if (p === '/api/db' && m === 'GET') { setSession(res, u.id); return json(res, 200, { rev: db._rev, db: visibleDb(u) }); }
    if (p === '/api/sync' && m === 'POST') {
      const b = await readJson(req, 8 * 1048576);
      if (applyPatch(u, b.patch || {})) touchDb();
      return json(res, 200, { rev: db._rev });
    }
    if (p === '/api/password' && m === 'POST') {
      const b = await readJson(req);
      const st = db.users.find(x => x.id === u.id);
      if (!safeEq(await pbkdf2(b.act || '', st.salt), st.hash)) return json(res, 400, { error: 'La contraseña actual no es correcta.' });
      if (b.nueva === b.act) return json(res, 400, { error: 'Elige una contraseña distinta a la actual.' });
      const pe = validarPw(b.nueva, st.username); if (pe) return json(res, 400, { error: pe });
      st.salt = crypto.randomBytes(16).toString('hex'); st.hash = await pbkdf2(b.nueva, st.salt); st.mustChange = false; touchDb();
      return json(res, 200, { ok: true });
    }
    if (p === '/api/upload' && m === 'POST') {
      const name = decodeURIComponent(String(req.headers['x-file-name'] || 'archivo')).slice(0, 150).replace(/[\\/\r\n"]/g, '_');
      if (BAD_EXT.test(name)) return json(res, 400, { error: 'Ese tipo de archivo no está permitido.' });
      const type = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].slice(0, 100);
      const buf = await readBody(req, MAX_UPLOAD);
      if (!buf.length) return json(res, 400, { error: 'Archivo vacío.' });
      const f = await saveFile(buf, name, type);
      return json(res, 200, { data: f.url, name, type, size: buf.length, stored: f.stored });
    }
    const fm = p.match(/^\/api\/file\/([a-f0-9]{32}z?)(?:\/(.*))?$/);
    if (fm && m === 'GET') {
      const o = await readFileObj('files/' + fm[1]);
      if (!o) return json(res, 404, { error: 'Archivo no encontrado' });
      const name = decodeURIComponent(fm[2] || 'archivo');
      const inline = INLINE.test(o.contentType);
      return send(res, 200, o.body, {
        'Content-Type': inline ? o.contentType : 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=86400'
      });
    }
    if (p === '/api/export' && m === 'GET') {
      if (u.role !== 'admin') return json(res, 403, { error: 'Solo el administrador.' });
      return send(res, 200, JSON.stringify(db), { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="respaldo-mentoris-${new Date().toISOString().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' });
    }
    if (p === '/api/import' && m === 'POST') {
      if (u.role !== 'admin') return json(res, 403, { error: 'Solo el administrador.' });
      await importDb(await readJson(req, 120 * 1048576));
      clearSession(res);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/appicon') {
      if (!has(u, 'personalizar')) return json(res, 403, { error: 'No tienes permiso.' });
      if (m === 'POST') {
        const b = await readJson(req, 4 * 1048576);
        const a = dataUrlPng(b.i192), c = dataUrlPng(b.i512), d = dataUrlPng(b.imask);
        if (!a || !c || !d) return json(res, 400, { error: 'Imágenes del ícono no válidas.' });
        await store.put('icons/app-192.png', a, { contentType: 'image/png' });
        await store.put('icons/app-512.png', c, { contentType: 'image/png' });
        await store.put('icons/app-maskable.png', d, { contentType: 'image/png' });
        db.config.appIconV = Date.now(); touchDb();
        return json(res, 200, { v: db.config.appIconV });
      }
      if (m === 'DELETE') { db.config.appIconV = 0; touchDb(); return json(res, 200, { ok: true }); }
    }
    if (p === '/api/gc' && m === 'POST') { if (u.role !== 'admin') return json(res, 403, { error: 'Solo el administrador.' }); gcFiles(); return json(res, 200, { ok: true }); }
    return json(res, 404, { error: 'No existe' });
  }

  /* ---- archivos estáticos ---- */
  if (m !== 'GET' && m !== 'HEAD') return send(res, 405, 'Método no permitido');
  let rel = decodeURIComponent(p === '/' ? '/index.html' : p);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || /(^|[\\/])\./.test(rel)) return send(res, 404, 'No encontrado');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'No encontrado');
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  const url = new URL(req.url, 'http://x');
  route(req, res, url).catch(e => {
    if (e.code !== 413 && e.code !== 400) console.error(req.method, url.pathname, e);
    if (!res.headersSent) json(res, e.code === 413 || e.code === 400 ? e.code : 500, { error: e.code === 413 || e.code === 400 ? e.message : 'Error del servidor' });
  });
});

async function main() {
  if (PROD && store.kind === 'local' && !process.env.ALLOW_LOCAL_STORAGE) {
    const need = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
    const missing = need.filter(k => !(process.env[k] || '').trim());
    const present = Object.keys(process.env).filter(k => /^(s3|r2)_/i.test(k));
    console.error('ERROR: no hay almacenamiento en la nube configurado. En Render el disco se borra al reiniciar y perderías todos los datos.');
    console.error('Variables que faltan o están vacías: ' + (missing.join(', ') || '(ninguna)'));
    console.error('Variables S3_/R2_ que sí existen en este servicio: ' + (present.join(', ') || '(ninguna)'));
    console.error('Revisa que los nombres sean EXACTAMENTE los de la lista (mayúsculas, guiones bajos, sin espacios) en Render → Environment.');
    process.exit(1);
  }
  console.log(`Almacenamiento: ${({ r2: 'Cloudflare R2', s3: 'nube compatible con S3 (Backblaze B2, etc.)', local: 'carpeta local ./data (sin nube)' })[store.kind]}`);
  try {
    await store.put('db/.ping', Buffer.from(String(Date.now())), { contentType: 'text/plain' });   // comprueba que se puede escribir (bucket y claves correctos)
    await loadDb();
  } catch (e) { console.error('No se pudo leer la base de datos del almacenamiento:', e.message, '\nRevisa las variables de almacenamiento (S3_* o R2_*), el nombre del bucket y que la clave tenga permiso de lectura y escritura.'); process.exit(1); }
  server.listen(PORT, () => console.log(`Mentoris escuchando en el puerto ${PORT}`));
  setInterval(serverTick, 30000);
  setTimeout(gcFiles, 60000); setInterval(gcFiles, 6 * 3600 * 1000);
  setInterval(() => { const n = Date.now(); for (const [k, v] of locks) if (v.until && v.until < n) locks.delete(k); for (const [k, v] of ipHits) if (!v.some(t => n - t < 600000)) ipHits.delete(k); }, 600000);
}
const shutdown = async () => { clearTimeout(persistT); try { if (db) { await persist(); while (persisting) await new Promise(r => setTimeout(r, 100)); } } catch (e) { } process.exit(0); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
main();
