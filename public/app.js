'use strict';
/* =====================================================================
   Mentoris — PWA
   Los datos viven en el servidor (Cloudflare R2). El cliente trabaja con el objeto DB
   y save(): save() envía al servidor solo lo que cambió y pull() trae lo de los demás.
   ===================================================================== */

/* ---------- utilidades ---------- */
const $ = (s, e = document) => e.querySelector(s);
const $$ = (s, e = document) => [...e.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nl = s => esc(s).replace(/\n/g, '<br>');
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '').slice(0, 16);
const pad = n => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowLocal = () => { const d = new Date(); return `${todayStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDate = s => s ? new Date(s.length <= 10 ? s + 'T00:00' : s).toLocaleDateString('es-GT', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const fmtDT = s => s ? new Date(s).toLocaleString('es-GT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const tmin = t => { const [h, m] = (t || '0:0').split(':').map(Number); return h * 60 + m; };
const fmtT = t => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${(h % 12) || 12}:${pad(m)} ${h < 12 ? 'a.m.' : 'p.m.'}`; };
const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600); };

/* ---------- constantes ---------- */
const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const ROLES = { admin: 'Administrador', director: 'Director', secretaria: 'Secretaria', maestro: 'Maestro', alumno: 'Alumno', padre: 'Padre / Madre' };
const PERMS = {
  usuarios: 'Crear, editar y eliminar usuarios',
  grados: 'Ver y administrar grados',
  cursos: 'Crear y administrar cursos',
  reportes: 'Ver reportes',
  anuncio_general: 'Anuncios generales',
  anuncio_grado: 'Anuncios por grado',
  anuncio_curso: 'Anuncios por curso',
  anuncio_maestros: 'Anuncios solo a maestros',
  tareas: 'Crear y programar tareas',
  examenes: 'Crear y calificar exámenes',
  calificar: 'Calificar tareas',
  asistencia: 'Tomar asistencia',
  modulos: 'Subir módulos del curso',
  buzon_masivo: 'Enviar mensajes a grupos en el buzón',
  solvencia: 'Cambiar solvencia de alumnos',
  personalizar: 'Personalizar colegio (logo y colores)',
  permisos: 'Gestionar permisos de los roles'
};
const DEFAULT_PERMS = {
  director: ['grados', 'cursos', 'reportes', 'anuncio_general', 'anuncio_grado', 'anuncio_maestros', 'buzon_masivo'],
  secretaria: ['usuarios', 'cursos', 'anuncio_general', 'solvencia', 'buzon_masivo'],
  maestro: ['anuncio_curso', 'tareas', 'examenes', 'calificar', 'asistencia', 'modulos', 'buzon_masivo'],
  alumno: [], padre: []
};
const ESTADOS = { P: 'Presente', A: 'Ausente', T: 'Tarde', E: 'Excusa' };
const BAD_EXT = /\.(exe|bat|cmd|com|msi|js|mjs|vbs|ps1|sh|jar|html?|svg|php|scr|dll)$/i;
const DEFAULT_LOGO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><circle cx="60" cy="60" r="56" fill="#1e3a52"/><path d="M60 28 14 52l46 24 46-24z" fill="#fff"/><path d="M34 64v16c0 8 12 16 26 16s26-8 26-16V64L60 78z" fill="#fff" opacity=".85"/><rect x="100" y="52" width="4" height="30" fill="#fff"/></svg>');

/* ---------- datos y sincronización con el servidor ---------- */
let DB, SESSION = null, deferredInstall = null, NEED_SETUP = false, LEGACY = null;
let S = { view: 'inicio', id: null, q: '', rf: '', bell: false, bz: 'in', msg: null, attC: null, attF: null, anF: 'todos' };
const COLS = ['users', 'grados', 'cursos', 'modulos', 'tareas', 'entregas', 'examenes', 'intentos', 'asistencia', 'anuncios', 'mensajes', 'notifs'];
let REV = 0, BASE = null, saveT = null, retryT = null, dirty = false, pushing = false, pulling = false;

async function api(path, o = {}) {
  const init = { method: o.method || 'GET', credentials: 'same-origin', headers: { ...(o.headers || {}) }, keepalive: !!o.keepalive };
  if (o.json !== undefined) { init.method = o.method || 'POST'; init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.json); }
  if (o.raw !== undefined) { init.method = 'POST'; init.body = o.raw; }
  let r;
  try { r = await fetch(path, init); } catch (e) { const er = new Error('Sin conexión con el servidor.'); er.offline = true; throw er; }
  let data = null; try { data = await r.json(); } catch (e) { }
  if (!r.ok) {
    if (r.status === 401 && SESSION && !o.quiet) sesionTerminada();
    const er = new Error((data && data.error) || `Error del servidor (${r.status})`); er.status = r.status; throw er;
  }
  return data;
}
const snap = db => ({ cols: Object.fromEntries(COLS.map(c => [c, new Map((db[c] || []).map(x => [x.id, JSON.stringify(x)]))])), config: JSON.stringify(db.config), perms: JSON.stringify(db.perms) });
function makePatch(db, base) {
  const p = { cols: {} }; let any = false;
  for (const c of COLS) {
    const up = [], seen = new Set();
    for (const x of db[c] || []) { seen.add(x.id); if (base.cols[c].get(x.id) !== JSON.stringify(x)) up.push(x); }
    const rm = [...base.cols[c].keys()].filter(id => !seen.has(id));
    if (up.length || rm.length) { p.cols[c] = { up, rm }; any = true; }
  }
  if (JSON.stringify(db.config) !== base.config) { p.config = db.config; any = true; }
  if (JSON.stringify(db.perms) !== base.perms) { p.perms = db.perms; any = true; }
  return any ? p : null;
}
const defaultDB = () => ({
  v: 2,
  config: { nombre: 'Mi Colegio', logo: null, appIconV: 0, colors: { p: '#1e3a52', a: '#2f80ed', bg: '#f4f6fb' }, ui: { font: 'moderna', radius: 'suave', dens: 'normal', side: 'oscuro' } },
  perms: JSON.parse(JSON.stringify(DEFAULT_PERMS)),
  users: [], grados: [], cursos: [], modulos: [], tareas: [], entregas: [], examenes: [], intentos: [], asistencia: [], anuncios: [], mensajes: [], notifs: [], locks: {}
});
function normalizeDb(d) {
  const base = defaultDB();
  Object.keys(base).forEach(k => { if (d[k] === undefined) d[k] = base[k]; });
  d.config.ui = Object.assign({}, base.config.ui, d.config.ui || {});
  d.config.colors = Object.assign({}, base.config.colors, d.config.colors || {});
  return d;
}
function save(now) { dirty = true; clearTimeout(saveT); if (now) return flush(); saveT = setTimeout(flush, 600); }
async function flush(keepalive) {
  clearTimeout(saveT);
  if (!SESSION || !BASE) return;
  if (pushing) { dirty = true; return; }
  if (!dirty) return;
  dirty = false;
  const patch = makePatch(DB, BASE);
  if (!patch) return;
  pushing = true;
  const sent = snap(DB);
  try {
    const r = await api('/api/sync', { json: { base: REV, patch }, keepalive: keepalive === true });
    BASE = sent; pushing = false;
    if (dirty) return flush();
    if (r.rev === REV + 1) REV = r.rev;          // solo cambió lo mío
    else { await pull(); if (!$('.modal')) render(); }   // otros también cambiaron algo, o el servidor ignoró mi cambio
  } catch (e) {
    pushing = false; dirty = true;
    if (e.status === 401) return;
    toast(e.offline ? 'Sin conexión: se reintentará guardar…' : e.message);
    clearTimeout(retryT); retryT = setTimeout(flush, 5000);
  }
}
async function pull() {
  if (pulling || dirty || pushing || $('.modal')) return false;
  pulling = true;
  try {
    const r = await api('/api/db');
    if (dirty || pushing) return false;
    DB = normalizeDb(r.db); REV = r.rev; BASE = snap(DB);
    return true;
  } finally { pulling = false; }
}
const isTyping = () => { const a = document.activeElement; return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && !!a.closest('#view'); };
let stale = false;
async function poll() {
  if (!SESSION || !BASE || dirty || pushing || $('.modal')) return;
  try {
    if (!stale) { const r = await api('/api/rev'); if (r.rev === REV) return; if (!(await pull())) return; }
    if (isTyping()) { stale = true; return; }
    stale = false; render();
  } catch (e) { }
}
window.addEventListener('pagehide', () => flush(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(true); else poll(); });
window.addEventListener('online', () => { flush(); poll(); });
function sesionTerminada() {
  if (!SESSION) return;
  SESSION = null; BASE = null; const cfg = DB.config; DB = defaultDB(); DB.config = cfg;
  render(); toast('Tu sesión terminó. Ingresa de nuevo.');
}

/* ---------- accesos rápidos a datos ---------- */
const U = id => DB.users.find(u => u.id === id);
const G = id => DB.grados.find(g => g.id === id);
const C = id => DB.cursos.find(c => c.id === id);
const T = id => DB.tareas.find(t => t.id === id);
const nm = u => u ? [u.nombre1, u.nombre2, u.apellido1, u.apellido2].filter(Boolean).join(' ') : '—';
const me = () => SESSION ? U(SESSION.uid) : null;
const can = p => { const u = me(); return !!u && (u.role === 'admin' || (DB.perms[u.role] || []).includes(p)); };
const logo = () => DB.config.logo || DEFAULT_LOGO;
const alumnosDeGrado = gid => DB.users.filter(u => u.role === 'alumno' && u.gradoId === gid && u.activo !== false);
const alumnosDeCurso = c => c ? alumnosDeGrado(c.gradoId) : [];
const cursosDe = u => u.role === 'alumno' ? DB.cursos.filter(c => c.gradoId === u.gradoId) : u.role === 'maestro' ? DB.cursos.filter(c => c.maestroId === u.id) : DB.cursos;
const hijosDe = p => DB.users.filter(u => u.role === 'alumno' && u.padreId === p.id && u.activo !== false);
const gradosIds = u => {
  if (u.role === 'alumno') return [u.gradoId];
  if (u.role === 'padre') return hijosDe(u).map(h => h.gradoId);
  if (u.role === 'maestro') return [...new Set(cursosDe(u).map(c => c.gradoId))];
  return DB.grados.map(g => g.id);
};
const publicada = t => new Date(t.publica) <= new Date();
const entregaDe = (tid, aid) => DB.entregas.find(e => e.tareaId === tid && e.alumnoId === aid);
const tieneNota = e => e && e.nota !== undefined && e.nota !== null && e.nota !== '';
const fileLink = f => f ? `<a class="file" href="${esc(f.data)}" download="${esc(f.name)}">📎 ${esc(f.name)}</a>` : '';
const parseLinks = txt => {
  const out = [];
  for (const raw of String(txt || '').split(/[\n,; ]+/).map(x => x.trim()).filter(Boolean)) {
    let u; try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'https://' + raw); } catch (e) { throw new Error(`El enlace "${raw}" no es válido.`); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`Solo se permiten enlaces http o https: "${raw}".`);
    if (!u.hostname.includes('.')) throw new Error(`El enlace "${raw}" no es válido.`);
    out.push(u.href);
  }
  return [...new Set(out)].slice(0, 10);
};
const linksHTML = l => (l || []).filter(x => /^https?:\/\//i.test(x)).map(x => `<a class="file" href="${esc(x)}" target="_blank" rel="noopener noreferrer">🔗 ${esc(x.replace(/^https?:\/\//, '').slice(0, 60))}</a>`).join(' ');
const cursoLabel = c => c ? `${c.nombre} — ${G(c.gradoId)?.nombre || '—'}` : '—';

/* ---------- seguridad: contraseñas y usuario ---------- */
async function hash(pw, salt) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const b = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 120000, hash: 'SHA-256' }, k, 256);
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
function genUsername(u) {
  const base = (norm(u.nombre1)[0] || '') + (norm(u.nombre2)[0] || '') + norm(u.apellido1) + (norm(u.apellido2)[0] || '');
  let n = base, i = 1;
  while (DB.users.some(x => x.username === n && x.id !== u.id)) n = base + (++i);
  return n;
}
async function nuevoUser(base) {
  const u = { id: newId(), activo: true, solvente: true, mustChange: true, creado: Date.now(), ...base };
  u.username = genUsername(u);
  u.salt = newId() + newId();
  u.hash = await hash(u.username, u.salt); // contraseña inicial = nombre de usuario
  DB.users.push(u);
  return u;
}
function validarPw(pw, user) {
  if (pw.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Debe incluir letras y números.';
  if (user && pw.toLowerCase() === user.username) return 'La contraseña no puede ser igual a tu usuario.';
  return '';
}
async function startSession(uid) {
  SESSION = { uid }; BASE = null;
  await pull();
  if (!BASE) { SESSION = null; throw new Error('No se pudieron cargar los datos.'); }
}
async function login(username, pw) {
  try { const r = await api('/api/login', { json: { usuario: username.trim(), clave: pw } }); await startSession(r.uid); return null; }
  catch (e) { return e.message; }
}
const touch = () => { };
async function logout(msg) {
  clearTimeout(saveT);
  try { if (dirty && SESSION) { dirty = true; await flush(); } } catch (e) { }
  try { await api('/api/logout', { json: {}, quiet: true }); } catch (e) { }
  SESSION = null; BASE = null; dirty = false; REV = 0;
  const cfg = DB.config; DB = defaultDB(); DB.config = cfg;
  try { localStorage.removeItem('nav'); } catch (e) { }
  S = { ...S, view: 'inicio', id: null, bell: false, menu: false, ex: null };
  render(); if (msg) toast(msg);
}

/* ---------- archivos: se comprimen en el dispositivo y se suben al servidor (R2) ---------- */
const IMG_OK = /^image\/(png|jpe?g|webp)$/;
const loadImg = file => new Promise((res, rej) => {
  const img = new Image(), url = URL.createObjectURL(file);
  img.onload = () => { URL.revokeObjectURL(url); res(img); };
  img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('No se pudo leer la imagen.')); };
  img.src = url;
});
async function compressImage(file, maxDim = 1600, quality = 0.72) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { src = await loadImg(file); }
  const w0 = src.width, h0 = src.height, k = Math.min(1, maxDim / Math.max(w0, h0));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w0 * k)); c.height = Math.max(1, Math.round(h0 * k));
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(src, 0, 0, c.width, c.height);
  if (src.close) src.close();
  return new Promise(r => c.toBlob(r, 'image/jpeg', quality));
}
const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
async function prepareFile(file, maxMB = 10) {
  let blob = file, name = file.name, type = file.type || 'application/octet-stream';
  if (IMG_OK.test(type)) {
    if (file.size > 40 * 1048576) throw new Error(`"${file.name}" es demasiado grande.`);
    try { const b = await compressImage(file); if (b && b.size < file.size) { blob = b; type = 'image/jpeg'; name = name.replace(/\.[^.]+$/, '') + '.jpg'; } } catch (e) { }
  }
  if (blob.size > maxMB * 1048576) throw new Error(`"${file.name}" supera el límite de ${maxMB} MB. Sube un archivo más ligero.`);
  toast(blob === file ? 'Subiendo archivo…' : `Comprimido: ${fmtSize(file.size)} → ${fmtSize(blob.size)}. Subiendo…`);
  const r = await api('/api/upload', { raw: blob, headers: { 'Content-Type': type, 'X-File-Name': encodeURIComponent(name) } });
  return { name: r.name, type: r.type, size: r.size, data: r.data };
}
function resizeImage(file, max = 400) {
  return loadImg(file).then(img => {
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  });
}
/* Ícono de la app instalada: 192 y 512 (rellena todo el cuadro) y una versión "maskable" con margen de seguridad */
async function makeAppIcons(file) {
  const img = await loadImg(file);
  const draw = (size, safe) => {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, size, size);
    const box = safe ? size * 0.78 : size, k = safe ? Math.min(box / img.width, box / img.height) : Math.max(box / img.width, box / img.height);
    const w = img.width * k, h = img.height * k;
    g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return c.toDataURL('image/png');
  };
  return { i192: draw(192, false), i512: draw(512, false), imask: draw(512, true) };
}

/* ---------- formularios modales ---------- */
function fieldHTML(f, v) {
  const id = 'f_' + f.k, req = f.req ? 'required' : '';
  const opts = typeof f.options === 'function' ? f.options() : (f.options || []);
  let inp;
  switch (f.type) {
    case 'textarea': inp = `<textarea id="${id}" name="${f.k}" rows="4" ${req}>${esc(v)}</textarea>`; break;
    case 'select':
      inp = `<select id="${id}" name="${f.k}" ${req}>${f.blank ? `<option value="">${esc(f.blank)}</option>` : ''}${opts.map(o => `<option value="${esc(o.v)}" ${o.v === v ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}</select>`; break;
    case 'checks':
      inp = `<div class="checks">${opts.map(o => `<label class="chk"><input type="checkbox" name="${f.k}" value="${esc(o.v)}" ${(v || []).includes(o.v) ? 'checked' : ''}>${esc(o.l)}</label>`).join('') || '<span class="muted">No hay opciones disponibles.</span>'}</div>`; break;
    case 'check':
      inp = `<label class="chk"><input type="checkbox" id="${id}" name="${f.k}" ${v ? 'checked' : ''}> ${esc(f.text || '')}</label>`; break;
    case 'file':
      inp = `<input type="file" id="${id}" name="${f.k}" ${f.accept ? `accept="${f.accept}"` : ''}>${v ? `<small>Actual: ${esc(v.name)}</small>` : ''}`; break;
    case 'horarios': {
      const cur = Array.isArray(v) ? v : [];
      inp = `<div class="hrs">${DAYS.map(d => { const h = cur.find(x => x.dia === d); return `<div class="hr ${h ? 'on' : ''}" data-dia="${d}"><label class="chk"><input type="checkbox" class="hd" ${h ? 'checked' : ''}> ${d}</label><span class="ht"><input type="time" class="hi" aria-label="Inicio ${d}" value="${h ? esc(h.inicio) : ''}" ${h ? '' : 'disabled'}><span>a</span><input type="time" class="hf" aria-label="Fin ${d}" value="${h ? esc(h.fin) : ''}" ${h ? '' : 'disabled'}></span></div>`; }).join('')}</div>`;
      break;
    }
    default:
      inp = `<input type="${f.type || 'text'}" id="${id}" name="${f.k}" value="${esc(v)}" ${req} ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} ${f.step ? `step="${f.step}"` : ''} ${f.type === 'password' ? 'autocomplete="new-password"' : ''}>`;
  }
  return `<div class="fld" data-k="${f.k}" ${f.when ? `data-when="${esc(JSON.stringify(f.when))}"` : ''}><label for="${id}">${esc(f.label)}</label>${inp}${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</div>`;
}
function openForm(o) {
  const values = o.values || {};
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<form class="mbox"><h3>${esc(o.title)}</h3>${o.intro ? `<p class="intro">${esc(o.intro)}</p>` : ''}${o.fields.map(f => fieldHTML(f, values[f.k])).join('')}<div class="err"></div><div class="row end"><button type="button" class="btn ghost" data-close>Cancelar</button><button class="btn main">${esc(o.submit || 'Guardar')}</button></div></form>`;
  document.body.appendChild(m);
  const form = $('form', m), err = $('.err', m);
  const mid = pushModal(() => cancel());
  const close = () => { m.remove(); document.removeEventListener('keydown', onKey); popModal(mid, cancel); };
  const cancel = () => { close(); o.onCancel && o.onCancel(); };
  const onKey = e => { if (e.key === 'Escape') cancel(); };
  document.addEventListener('keydown', onKey);
  $('[data-close]', m).onclick = cancel;
  const sync = () => $$('[data-when]', form).forEach(w => {
    const c = JSON.parse(w.dataset.when);
    const el = form.elements[c.k];
    const show = c.in.includes(el ? el.value : '');
    w.hidden = !show;
    $$('input,select,textarea', w).forEach(i => i.disabled = !show);
  });
  form.addEventListener('change', e => {
    const cb = e.target;
    if (cb.classList && cb.classList.contains('hd')) {
      const row = cb.closest('.hr'), hi = $('.hi', row), hf = $('.hf', row);
      row.classList.toggle('on', cb.checked); hi.disabled = hf.disabled = !cb.checked;
      if (cb.checked && !hi.value) { const o2 = $$('.hr.on', form).find(r => r !== row && $('.hi', r).value); if (o2) { hi.value = $('.hi', o2).value; hf.value = $('.hf', o2).value; } }
    }
  });
  form.addEventListener('change', sync);
  sync();
  const first = $('input:not([disabled]),select:not([disabled]),textarea', form); first && first.focus();
  form.onsubmit = async e => {
    e.preventDefault();
    err.textContent = '';
    const btn = $('.btn.main', form);
    btn.disabled = true;
    try {
      const data = {};
      for (const f of o.fields) {
        const w = $(`[data-k="${f.k}"]`, form);
        if (w.hidden) continue;
        if (f.type === 'checks') data[f.k] = $$(`input[name="${f.k}"]:checked`, form).map(i => i.value);
        else if (f.type === 'check') data[f.k] = form.elements[f.k].checked;
        else if (f.type === 'horarios') {
          data[f.k] = $$('.hr', w).filter(r => $('.hd', r).checked).map(r => ({ dia: r.dataset.dia, inicio: $('.hi', r).value, fin: $('.hf', r).value }));
          const falta = data[f.k].find(h => !h.inicio || !h.fin);
          if (falta) throw new Error(`Falta la hora de inicio o fin del ${falta.dia}.`);
        }
        else if (f.type === 'file') {
          const file = form.elements[f.k].files[0];
          if (file) {
            if (f.image && !/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) throw new Error('Solo se permiten imágenes PNG, JPG, WEBP o GIF.');
            if (!f.image && BAD_EXT.test(file.name)) throw new Error('Ese tipo de archivo no está permitido.');
            data[f.k] = await prepareFile(file, f.max || 10);
          } else data[f.k] = values[f.k] || null;
        } else data[f.k] = form.elements[f.k].value;
      }
      await o.onSave(data);
      close();
    } catch (ex) { err.textContent = ex.message || String(ex); btn.disabled = false; }
  };
}
function openInfo(title, html) {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="mbox"><h3>${esc(title)}</h3>${html}<div class="row end"><button class="btn" data-close>Entendido</button></div></div>`;
  document.body.appendChild(m);
  const mid = pushModal(() => m.remove());
  $('[data-close]', m).onclick = () => { m.remove(); popModal(mid); };
}

/* ---------- plantillas pequeñas ---------- */
const empty = t => `<p class="empty">${t}</p>`;
const chip = (t, c = '') => `<span class="chip ${c}">${esc(t)}</span>`;
const ab = (act, label, d = {}, cls = '') => `<button type="button" class="btn ${cls}" data-act="${act}"${Object.entries(d).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('')}>${label}</button>`;
const eb = (kind, id) => `<span class="ib"><button type="button" class="ibtn" data-act="edit" data-kind="${kind}" data-id="${id}" title="Editar">✏️</button><button type="button" class="ibtn" data-act="del" data-kind="${kind}" data-id="${id}" title="Eliminar">🗑️</button></span>`;
const head = (t, actions = '') => `<div class="vh"><h2>${t}</h2><div class="vact">${actions}</div></div>`;
const back = v => ab('back', '← Volver', { view: v }, 'ghost sm');

/* ---------- notificaciones ---------- */
function notify(to, title, body, view) {
  DB.notifs.push({ id: newId(), uid: to, title, body, view, fecha: Date.now(), leido: false });
  if (DB.notifs.length > 1500) DB.notifs.splice(0, DB.notifs.length - 1500);
}
const misNotifs = () => DB.notifs.filter(n => n.uid === SESSION.uid).sort((a, b) => b.fecha - a.fecha);
function showSys(n) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body: n.body, icon: '/icons/app-192.png', tag: n.id };
  if (navigator.serviceWorker) navigator.serviceWorker.ready.then(r => r.showNotification(n.title, opts)).catch(() => new Notification(n.title, opts));
  else new Notification(n.title, opts);
}
function flushSystemNotifs() {
  if (!SESSION || !('Notification' in window) || Notification.permission !== 'granted') return;
  const key = 'shown_' + SESSION.uid;
  let shown = []; try { shown = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { }
  const nuevas = misNotifs().filter(n => !n.leido && !shown.includes(n.id)).slice(0, 5);
  nuevas.forEach(showSys);
  try { localStorage.setItem(key, JSON.stringify([...shown, ...nuevas.map(n => n.id)].slice(-200))); } catch (e) { }
}
function tick() {
  if (!DB || !SESSION) return;
  let changed = false;
  const now = Date.now();
  const u = me();
  if (u && u.role === 'alumno') {
    DB.intentos.filter(i => i.alumnoId === u.id && i.estado === 'en_curso' && EX(i.examenId) && now >= exDeadline(EX(i.examenId), i)).forEach(i => { finalizar(i); changed = true; });
    DB.tareas.filter(t => publicada(t) && cursosDe(u).some(c => c.id === t.cursoId)).forEach(t => {
      const due = new Date(t.entrega).getTime();
      const key = `rem_${t.id}_${u.id}`;
      if (due > now && due - now < 86400000 && !entregaDe(t.id, u.id) && !DB.notifs.some(n => n.key === key)) {
        DB.notifs.push({ id: newId(), key, uid: u.id, title: 'Tarea por vencer', body: `${t.titulo} vence ${fmtDT(t.entrega)}`, view: 'tareas', fecha: now, leido: false });
        changed = true;
      }
    });
  }
  if (changed) { save(); }
  flushSystemNotifs();
  const b = $('.bell b'); const n = misNotifs().filter(x => !x.leido).length;
  if (b || n) { const bell = $('.bell'); if (bell) bell.innerHTML = `🔔${n ? `<b>${n}</b>` : ''}`; }
}

/* ---------- anuncios: quién los ve ---------- */
function veAnuncio(a, u) {
  if (a.autor === u.id || u.role === 'admin' || a.alcance === 'general') return true;
  const staff = ['director', 'secretaria'].includes(u.role);
  if (a.alcance === 'maestros') return staff || u.role === 'maestro';
  if (staff) return true;
  const gids = gradosIds(u);
  if (a.alcance === 'grado') return gids.includes(a.target);
  if (a.alcance === 'curso') { const c = C(a.target); return !!c && (u.role === 'maestro' ? c.maestroId === u.id : gids.includes(c.gradoId)); }
  return false;
}
function postBody(p) {
  if (p.img) return `<div class="post-img"><img src="${esc(p.img.data)}" alt="Imagen adjunta"></div><p class="ptext">${nl(p.texto)}</p>`;
  return `<div class="post-def"><img class="plogo" src="${logo()}" alt=""><p>${nl(p.texto)}</p></div>`;
}

/* =====================================================================
   Estructura general, acceso y vistas
   ===================================================================== */
const NAV = [
  ['inicio', 'Inicio', '🏠', () => true],
  ['usuarios', 'Usuarios', '👥', () => can('usuarios')],
  ['grados', 'Grados', '🎓', () => can('grados')],
  ['cursos', 'Cursos', '📚', u => ['alumno', 'maestro'].includes(u.role) || can('cursos')],
  ['tareas', 'Tareas', '✏️', u => ['alumno', 'maestro'].includes(u.role)],
  ['examenes', 'Exámenes', '🧪', u => u.role === 'alumno' || can('examenes')],
  ['notas', 'Calificaciones', '📝', u => u.role === 'alumno'],
  ['horario', 'Horario', '🗓️', u => u.role === 'alumno'],
  ['asistencia', 'Asistencia', '✅', u => ['alumno', 'padre'].includes(u.role) || can('asistencia')],
  ['hijos', 'Mis hijos', '👨‍👩‍👧', u => u.role === 'padre'],
  ['anuncios', 'Anuncios', '📢', () => true],
  ['buzon', 'Buzón', '✉️', () => true],
  ['solvencia', 'Solvencia', '💳', () => can('solvencia')],
  ['reportes', 'Reportes', '📊', () => can('reportes')],
  ['personalizar', 'Diseño', '🎨', () => can('personalizar')],
  ['permisos', 'Permisos', '🔐', () => can('permisos')]
];
const PARENT = { grado: 'grados', curso: 'cursos', tarea: 'tareas', calificar: 'tareas', examen: 'examenes', examen_edit: 'examenes', examen_res: 'examenes' };
function accesoVista(v, u) {
  if (v === 'grado') return can('grados');
  if (v === 'curso' || v === 'ajustes') return true;
  if (v === 'tarea') return u.role === 'alumno';
  if (v === 'calificar') return can('calificar');
  if (v === 'examen') return u.role === 'alumno';
  if (v === 'examen_edit' || v === 'examen_res') return can('examenes');
  const n = NAV.find(x => x[0] === v);
  return !!n && n[3](u);
}
const lum = hex => { const n = parseInt(hex.slice(1), 16), f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f((n >> 16) & 255) + .7152 * f((n >> 8) & 255) + .0722 * f(n & 255); };
const onColor = hex => lum(hex) > .5 ? '#111827' : '#ffffff';
const modo = () => { try { return localStorage.getItem('modo') || 'auto'; } catch (e) { return 'auto'; } };
const PRESETS = [
  { n: 'Océano', p: '#1e3a52', a: '#2f80ed', bg: '#f4f6fb' }, { n: 'Bosque', p: '#1f4d3a', a: '#16a36a', bg: '#f2f7f4' },
  { n: 'Uva', p: '#3b2a6b', a: '#7c4dff', bg: '#f6f3fc' }, { n: 'Coral', p: '#7a2e3a', a: '#ef5b5b', bg: '#fdf4f3' },
  { n: 'Sol', p: '#5b4300', a: '#f59e0b', bg: '#fffaf0' }, { n: 'Grafito', p: '#1f2937', a: '#0ea5e9', bg: '#f3f4f6' }
];
function applyTheme(c = DB.config) {
  const col = c.colors, ui = c.ui || {}, r = document.documentElement, st = r.style;
  st.setProperty('--p', col.p); st.setProperty('--a', col.a); st.setProperty('--bg-l', col.bg);
  st.setProperty('--on-p', onColor(col.p)); st.setProperty('--on-a', onColor(col.a));
  { const mm = modo(); r.dataset.mode = mm === 'claro' ? 'light' : mm === 'oscuro' ? 'dark' : 'auto'; } r.dataset.font = ui.font || 'moderna'; r.dataset.radius = ui.radius || 'suave';
  r.dataset.dens = ui.dens || 'normal'; r.dataset.side = ui.side || 'oscuro';
  document.title = 'Mentoris';
  const m = $('meta[name=theme-color]'); if (m) m.content = col.p;
}
function previewTheme(f) {
  const v = n => f.elements[n].value;
  applyTheme({ colors: { p: v('cp'), a: v('ca'), bg: v('cb') }, ui: { font: v('font'), radius: v('radius'), dens: v('dens'), side: v('side') } });
}
/* Historial: el botón "atrás" del teléfono/navegador regresa a la pantalla anterior en vez de salir de la app */
let NAVI = 0, skipPop = false, modalSeq = 0;
const navStack = [{ view: 'inicio', id: null }], modalStack = [];
function pushModal(closer) {
  const mid = ++modalSeq;
  modalStack.push({ mid, closer });
  try { history.pushState({ app: 1, i: NAVI, modal: 1, mid, view: S.view, id: S.id }, ''); } catch (e) { }
  return mid;
}
function popModal(mid) {
  const i = modalStack.findIndex(x => x.mid === mid); if (i >= 0) modalStack.splice(i, 1);
  if (history.state && history.state.mid === mid) { skipPop = true; history.back(); }
}
function go(view, id = null, opt = {}) {
  const same = view === S.view && id === S.id;
  S.view = view; S.id = id; S.bell = false; S.menu = false; S.anim = true; S.msg = null; S.q = ''; S.rf = '';
  if (!opt.pop && !same) { NAVI++; navStack.length = NAVI; navStack[NAVI] = { view, id }; try { history.pushState({ app: 1, i: NAVI, view, id }, ''); } catch (e) { } }
  try { localStorage.setItem('nav', JSON.stringify({ view, id })); } catch (e) { }
  render(); window.scrollTo(0, 0);
}
function resetHistory() { NAVI = 0; navStack.length = 0; navStack.push({ view: S.view, id: S.id }); try { history.replaceState({ app: 1, i: 0, view: S.view, id: S.id }, ''); } catch (e) { } }
window.addEventListener('popstate', e => {
  if (skipPop) { skipPop = false; return; }
  if (modalStack.length) { modalStack[modalStack.length - 1].closer(); modalStack.pop(); return; }
  const st = e.state;
  if (!SESSION || !st || !st.app) return;
  if (st.modal) { history.back(); return; }           // entrada de un diálogo que ya se cerró: la saltamos
  NAVI = st.i; go(st.view, st.id, { pop: true });
});
const volver = d => { const prev = navStack[NAVI - 1]; if (NAVI > 0 && prev && prev.view === d.view) history.back(); else go(d.view); };

function render() {
  const root = $('#app');
  if (!DB) return;
  applyTheme(); document.body.classList.toggle('noscroll', !!S.menu && !!SESSION);
  if (NEED_SETUP) { root.innerHTML = authShell(setupHTML()); return; }
  if (!SESSION) { root.innerHTML = authShell(loginHTML()); return; }
  const u = me();
  if (!u || u.activo === false) { logout(); return; }
  if (u.mustChange) { root.innerHTML = authShell(forcePwHTML()); return; }
  if (!accesoVista(S.view, u)) { S.view = 'inicio'; S.id = null; }
  const cur = PARENT[S.view] || S.view;
  const unread = misNotifs().filter(n => !n.leido).length;
  const items = NAV.filter(n => n[3](u));
  const prio = ['inicio', 'tareas', 'examenes', 'cursos', 'hijos', 'anuncios', 'usuarios', 'asistencia', 'buzon'];
  const fast = prio.map(k => items.find(n => n[0] === k)).filter(Boolean).slice(0, 4);
  const m = modo();
  root.innerHTML = `<aside class="side ${S.menu ? 'open' : ''}"><img class="slogo" src="${logo()}" alt="">${items.map(n => `<button class="nv ${n[0] === cur ? 'on' : ''}" data-act="go" data-view="${n[0]}"><span class="i">${n[2]}</span><span>${n[1]}</span></button>`).join('')}<div class="sfoot"><button data-act="go" data-view="ajustes">⚙ Ajustes</button><button data-act="logout">⎋ Salir</button></div></aside><div class="scrim ${S.menu ? 'show' : ''}" data-act="menu"></div><main class="main"><div class="top">${S.view !== 'inicio' ? '<button class="iconbtn backbtn" data-act="histback" aria-label="Volver" title="Volver">←</button>' : ''}<button class="menubtn" data-act="menu" aria-label="Menú">☰</button><h1>${esc(DB.config.nombre)}</h1>${deferredInstall ? ab('instalar', '⬇ Instalar', {}, 'sm') : ''}<div class="who">${esc(nm(u))}<br>${ROLES[u.role]}</div><button class="iconbtn" data-act="modo" title="Apariencia: ${m}" aria-label="Cambiar modo claro u oscuro">${m === 'dark' || m === 'oscuro' ? '🌙' : m === 'claro' ? '☀️' : '🌓'}</button><button class="bell" data-act="bell" aria-label="Notificaciones">🔔${unread ? `<b>${unread}</b>` : ''}</button>${S.bell ? bellPanel() : ''}</div><section id="view" class="${S.anim ? 'enter' : ''}">${(V[S.view] || vInicio)()}</section></main><nav class="bnav">${fast.map(n => `<button class="${n[0] === cur ? 'on' : ''}" data-act="go" data-view="${n[0]}"><span>${n[2]}</span><span>${n[1]}</span></button>`).join('')}<button data-act="menu"><span>☰</span><span>Más</span></button></nav>`;
  S.anim = false;
}
function bellPanel() {
  const l = misNotifs().slice(0, 30);
  return `<div class="npanel"><div class="row" style="justify-content:space-between;padding:4px 8px"><b>Notificaciones</b>${ab('readAll', 'Marcar leídas', {}, 'ghost sm')}</div>${l.map(n => `<div class="nitem ${n.leido ? '' : 'new'}" data-act="notif" data-id="${n.id}"><b>${esc(n.title)}</b><small>${esc(n.body)} · ${fmtDT(n.fecha)}</small></div>`).join('') || empty('Sin notificaciones.')}</div>`;
}

/* ---------- acceso ---------- */
const authShell = inner => `<div class="auth"><div class="authbox"><img class="alogo" src="${logo()}" alt=""><h1>${esc(DB.config.nombre)}</h1>${inner}</div></div>`;
const setupHTML = () => `${LEGACY ? `<div class="banner"><b>Encontramos datos de la versión anterior en este navegador</b> (${LEGACY.users.length} usuarios).<br><button type="button" class="btn sm" data-act="legacy" style="margin-top:8px">⬆ Importar esos datos</button></div><br>` : ''}<details style="margin-bottom:12px"><summary class="muted" style="cursor:pointer">Ya tengo un respaldo (.json) de la versión anterior</summary><div class="fld" style="margin-top:8px"><input type="file" id="impSetup" accept="application/json"><small>Se importan usuarios, cursos, tareas y archivos. Después ingresa con tu usuario de siempre.</small></div></details><p class="muted">Primer uso: crea la cuenta del administrador del colegio.</p><form data-form="setup">
<div class="fld"><label>Nombre del colegio</label><input name="colegio" required maxlength="80"></div>
<div class="fld"><label>Nombre del administrador</label><input name="nombre1" required></div>
<div class="fld"><label>Apellido</label><input name="apellido1" required></div>
<div class="fld"><label>Usuario</label><input name="usuario" required pattern="[a-z0-9._]{3,30}" title="Minúsculas, números, punto o guion bajo (3 a 30)" autocomplete="username"></div>
<div class="fld"><label>Contraseña</label><input type="password" name="pw" required autocomplete="new-password"><small>Mínimo 8 caracteres, con letras y números.</small></div>
<div class="fld"><label>Repetir contraseña</label><input type="password" name="pw2" required autocomplete="new-password"></div>
<div class="err"></div><button class="btn">Crear y entrar</button></form>`;
const loginHTML = () => `<form data-form="login">
<div class="fld"><label>Usuario</label><input name="usuario" required autocomplete="username" autocapitalize="none"></div>
<div class="fld"><label>Contraseña</label><input type="password" name="clave" required autocomplete="current-password"></div>
<div class="err"></div><button class="btn">Ingresar</button></form>`;
const forcePwHTML = () => `<p class="muted">Por seguridad debes cambiar tu contraseña antes de continuar.</p><form data-form="forcepw">
<div class="fld"><label>Contraseña actual</label><input type="password" name="act" required autocomplete="current-password"></div>
<div class="fld"><label>Nueva contraseña</label><input type="password" name="nueva" required autocomplete="new-password"><small>Mínimo 8 caracteres, letras y números.</small></div>
<div class="fld"><label>Repetir nueva contraseña</label><input type="password" name="conf" required autocomplete="new-password"></div>
<div class="err"></div><button class="btn">Cambiar contraseña</button> <button type="button" class="btn ghost" data-act="logout" style="margin-top:8px">Salir</button></form>`;
async function cambiarPw(u, act, nueva, conf) {
  if (nueva !== conf) return 'Las contraseñas nuevas no coinciden.';
  const e = validarPw(nueva, u); if (e) return e;
  try { await api('/api/password', { json: { act, nueva } }); } catch (ex) { return ex.message; }
  await pull();
  return '';
}
const FORMS = {
  async setup(f) {
    const err = $('.err', f), v = n => f.elements[n].value.trim();
    if (f.elements.pw.value !== f.elements.pw2.value) { err.textContent = 'Las contraseñas no coinciden.'; return; }
    const pe = validarPw(f.elements.pw.value, { username: v('usuario') }); if (pe) { err.textContent = pe; return; }
    const btn = $('.btn', f); btn.disabled = true;
    try {
      const r = await api('/api/setup', { json: { colegio: v('colegio'), nombre1: v('nombre1'), apellido1: v('apellido1'), usuario: v('usuario'), pw: f.elements.pw.value } });
      NEED_SETUP = false; await startSession(r.uid); afterLogin();
    } catch (e) { err.textContent = e.message; btn.disabled = false; }
  },
  async login(f) {
    const btn = $('.btn', f); btn.disabled = true;
    const e = await login(f.elements.usuario.value, f.elements.clave.value);
    if (e) { $('.err', f).textContent = e; btn.disabled = false; } else afterLogin();
  },
  async forcepw(f) {
    const e = await cambiarPw(me(), f.elements.act.value, f.elements.nueva.value, f.elements.conf.value);
    if (e) $('.err', f).textContent = e; else { toast('Contraseña actualizada'); render(); }
  },
  async pw(f) {
    const e = await cambiarPw(me(), f.elements.act.value, f.elements.nueva.value, f.elements.conf.value);
    if (e) $('.err', f).textContent = e; else { toast('Contraseña actualizada'); f.reset(); }
  },
  async tema(f) {
    const c = DB.config;
    c.nombre = f.elements.colegio.value.trim() || c.nombre;
    c.colors = { p: f.elements.cp.value, a: f.elements.ca.value, bg: f.elements.cb.value };
    c.ui = { font: f.elements.font.value, radius: f.elements.radius.value, dens: f.elements.dens.value, side: f.elements.side.value };
    const file = f.elements.logo.files[0];
    try {
      if (file) { if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) throw new Error('El logo debe ser PNG, JPG, WEBP o GIF.'); if (file.size > 10485760) throw new Error('El logo pesa más de 10 MB.'); c.logo = await resizeImage(file, 500); }
      else if (f.elements.quitar && f.elements.quitar.checked) c.logo = null;
      const ic = f.elements.appicon && f.elements.appicon.files[0];
      if (ic) {
        if (!/^image\/(png|jpe?g|webp)$/.test(ic.type)) throw new Error('El ícono de la app debe ser PNG, JPG o WEBP.');
        await api('/api/appicon', { json: await makeAppIcons(ic) });
      } else if (f.elements.quitaricon && f.elements.quitaricon.checked) await api('/api/appicon', { method: 'DELETE', json: {} });
    } catch (e) { $('.err', f).textContent = e.message; return; }
    save(true); applyTheme(); render(); toast('Diseño guardado' + (f.elements.appicon && f.elements.appicon.files[0] ? '. El ícono de la app se actualiza en los dispositivos nuevos.' : ''));
    setTimeout(async () => { if (await pull()) render(); }, 1200);
  }
};
function afterLogin() { S = { ...S, view: 'inicio', id: null, bell: false, msg: null }; resetHistory(); render(); tick(); }

/* ---------- inicio ---------- */
const TILES = {
  admin: [['usuarios', 1], ['cursos', 1], ['grados'], ['anuncios'], ['reportes'], ['personalizar'], ['permisos'], ['buzon']],
  director: [['grados', 1], ['anuncios', 1], ['cursos'], ['reportes'], ['buzon']],
  secretaria: [['usuarios', 1], ['anuncios', 1], ['cursos'], ['solvencia'], ['buzon']],
  maestro: [['tareas', 1], ['examenes', 1], ['cursos'], ['asistencia'], ['anuncios'], ['buzon']],
  alumno: [['tareas', 1], ['examenes', 1], ['cursos'], ['notas'], ['horario'], ['asistencia'], ['anuncios'], ['buzon']],
  padre: [['hijos', 1], ['anuncios', 1], ['asistencia'], ['buzon']]
};
const EMOJI = { anuncios: '📢', buzon: '✉️' };
function vInicio() {
  const u = me();
  let k = 2;
  const tiles = TILES[u.role].filter(([v]) => { const n = NAV.find(x => x[0] === v); return n && n[3](u); }).map(([v, big], i) => {
    const n = NAV.find(x => x[0] === v);
    const cls = big ? `big t${i}` : `t${k++ % 6 + 2}`;
    return `<button class="tile ${cls}" data-act="go" data-view="${v}"><span class="e">${n[2]}</span><span class="l">${n[1]}</span></button>`;
  }).join('');
  const ans = DB.anuncios.filter(a => veAnuncio(a, u)).sort((a, b) => b.fecha - a.fecha).slice(0, 3);
  let extra = '';
  if (u.role === 'alumno') {
    const pend = DB.tareas.filter(t => publicada(t) && cursosDe(u).some(c => c.id === t.cursoId) && !entregaDe(t.id, u.id) && new Date(t.entrega) > new Date()).sort((a, b) => new Date(a.entrega) - new Date(b.entrega)).slice(0, 5);
    extra = `<div class="card"><h3>Tareas pendientes</h3>${pend.map(t => `<div class="row" style="justify-content:space-between;padding:6px 0"><span>${esc(t.titulo)} <span class="muted">· ${esc(C(t.cursoId)?.nombre)}</span></span>${chip('Vence ' + fmtDT(t.entrega), 'warn')}</div>`).join('') || empty('¡Estás al día! 🎉')}</div>`;
  }
  if (u.role === 'padre') {
    extra = hijosDe(u).length ? '' : `<div class="card">${empty('Aún no tienes hijos vinculados. Pide a la secretaría que enlace tu usuario.')}</div>`;
  }
  return `<div class="tiles">${tiles}</div>${extra}<h3>Últimos anuncios</h3>${ans.map(anuncioCard).join('') || empty('No hay anuncios todavía.')}`;
}

/* ---------- usuarios ---------- */
const canTouch = t => can('usuarios') && (me().role === 'admin' || t.role !== 'admin');
const detalleUser = u => {
  if (u.role === 'alumno') return `${esc(G(u.gradoId)?.nombre || '—')}${u.padreId ? '' : ' ' + chip('sin padre', 'warn')}`;
  if (u.role === 'maestro') return esc(cursosDe(u).map(c => c.nombre).join(', ') || '—');
  if (u.role === 'padre') return esc(hijosDe(u).map(nm).join(', ') || '—');
  return '';
};
function usersTable() {
  const q = S.q.toLowerCase();
  const list = DB.users.filter(u => (!S.rf || u.role === S.rf) && (!q || (nm(u) + ' ' + u.username).toLowerCase().includes(q))).sort((a, b) => nm(a).localeCompare(nm(b)));
  if (!list.length) return empty('No hay usuarios con ese filtro.');
  return `<div class="tw"><table class="tbl"><thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Detalle</th><th>Estado</th><th></th></tr></thead><tbody>${list.map(u => `<tr><td>${esc(nm(u))}<br><span class="muted">${esc(u.telefono)}</span></td><td>${esc(u.username)}</td><td>${ROLES[u.role]}</td><td>${detalleUser(u)}</td><td>${u.activo === false ? chip('Desactivado', 'bad') : chip('Activo', 'ok')}${u.role === 'alumno' && u.solvente === false ? ' ' + chip('Insolvente', 'bad') : ''}</td><td>${canTouch(u) ? `${eb('usuario', u.id)}<button class="ibtn" data-act="resetpw" data-id="${u.id}" title="Restablecer contraseña">🔑</button><button class="ibtn" data-act="toggleActivo" data-id="${u.id}" title="Activar / desactivar">${u.activo === false ? '▶️' : '⏸️'}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}
function vUsuarios() {
  return head('Usuarios', ab('nuevoUsuario', '＋ Nuevo usuario')) + `<div class="inl"><div><label class="muted">Buscar</label><input data-search="users" placeholder="Nombre o usuario" value="${esc(S.q)}"></div><div><label class="muted">Rol</label><select data-filter="users"><option value="">Todos</option>${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${S.rf === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div><div id="ulist" class="card">${usersTable()}</div>`;
}
const baseFields = when => [
  { k: 'nombre1', label: 'Primer nombre', req: 1 }, { k: 'nombre2', label: 'Segundo nombre' },
  { k: 'apellido1', label: 'Primer apellido', req: 1 }, { k: 'apellido2', label: 'Segundo apellido' },
  { k: 'direccion', label: 'Dirección', req: 1 }, { k: 'telefono', label: 'Teléfono', type: 'tel', req: 1 },
  { k: 'nacimiento', label: 'Fecha de nacimiento', type: 'date', req: 1 }
].map(f => when ? { ...f, when } : f);
const baseData = d => ({ nombre1: d.nombre1.trim(), nombre2: (d.nombre2 || '').trim(), apellido1: d.apellido1.trim(), apellido2: (d.apellido2 || '').trim(), direccion: d.direccion.trim(), telefono: d.telefono.trim(), nacimiento: d.nacimiento });
const gOpts = () => DB.grados.map(g => ({ v: g.id, l: g.nombre }));
const cOpts = () => DB.cursos.map(c => ({ v: c.id, l: cursoLabel(c) }));
const pOpts = () => DB.users.filter(x => x.role === 'padre').map(x => ({ v: x.id, l: nm(x) }));
function asignarMaestro(u, gids, cids) {
  const set = new Set(cids);
  gids.forEach(g => DB.cursos.filter(c => c.gradoId === g).forEach(c => set.add(c.id)));
  DB.cursos.forEach(c => { if (set.has(c.id)) c.maestroId = u.id; else if (c.maestroId === u.id) c.maestroId = null; });
  u.gradosAsig = gids; u.cursosAsig = cids;
}
function showCreds(list) {
  openInfo('Usuarios creados', `<p class="muted">Entrega estos datos a cada persona. Al ingresar por primera vez se le pedirá cambiar la contraseña.</p><div class="tw"><table class="tbl"><thead><tr><th>Nombre</th><th>Usuario</th><th>Contraseña inicial</th></tr></thead><tbody>${list.map(u => `<tr><td>${esc(nm(u))}<br><span class="muted">${ROLES[u.role]}</span></td><td><b>${esc(u.username)}</b></td><td><b>${esc(u.username)}</b></td></tr>`).join('')}</tbody></table></div>`);
}
function formUsuario(ex) {
  const roles = Object.entries(ROLES).filter(([k]) => me().role === 'admin' || k !== 'admin').map(([v, l]) => ({ v, l }));
  const w = r => ({ k: 'role', in: r });
  openForm({
    title: ex ? 'Editar usuario' : 'Nuevo usuario',
    intro: ex ? '' : 'El usuario se genera solo: 1ª letra del 1er y 2º nombre + 1er apellido + 1ª letra del 2º apellido. La contraseña inicial es igual al usuario.',
    values: ex ? { ...ex, gradosAsig: ex.gradosAsig || [], cursosAsig: ex.cursosAsig || [] } : { role: 'alumno' },
    fields: [
      { k: 'role', label: 'Rol', type: 'select', req: 1, options: roles },
      ...baseFields(),
      { k: 'gradoId', label: 'Grado (se asignan sus cursos automáticamente)', type: 'select', req: 1, options: gOpts, blank: '— Selecciona —', when: w(['alumno']) },
      { k: 'padreId', label: 'Padre / madre (opcional ahora)', type: 'select', options: pOpts, blank: '— Se creará al terminar —', when: w(['alumno']) },
      { k: 'gradosAsig', label: 'Maestro: grados completos que atiende', type: 'checks', options: gOpts, when: w(['maestro']), hint: 'Se le asignan todos los cursos de esos grados.' },
      { k: 'cursosAsig', label: 'Maestro: cursos individuales', type: 'checks', options: cOpts, when: w(['maestro']) }
    ],
    onSave: async d => {
      if (d.role === 'admin' && me().role !== 'admin') throw new Error('Solo un administrador puede crear administradores.');
      if (ex && ex.role === 'admin' && me().role !== 'admin') throw new Error('No puedes editar a un administrador.');
      let u = ex;
      if (ex) Object.assign(ex, baseData(d), { role: d.role });
      else u = await nuevoUser({ ...baseData(d), role: d.role });
      if (d.role === 'alumno') { u.gradoId = d.gradoId; u.padreId = d.padreId || (ex ? null : null); }
      else { delete u.gradoId; if (d.role !== 'padre') delete u.padreId; }
      if (d.role === 'maestro') asignarMaestro(u, d.gradosAsig || [], d.cursosAsig || []);
      else DB.cursos.forEach(c => { if (c.maestroId === u.id) c.maestroId = null; });
      if (ex && d.role !== 'alumno') DB.users.forEach(x => { if (x.padreId === u.id && d.role !== 'padre') x.padreId = null; });
      save(); render();
      if (!ex) { if (u.role === 'alumno' && !u.padreId) setTimeout(() => formPadre(u), 50); else setTimeout(() => showCreds([u]), 50); }
    }
  });
}
function formPadre(al) {
  const when = { k: 'padreId', in: [''] };
  const created = [al];
  openForm({
    title: `Padre / madre de ${nm(al)}`,
    intro: 'Crea el usuario del padre o vincula uno ya registrado para enlazarlo con el alumno.',
    submit: 'Vincular',
    fields: [{ k: 'padreId', label: 'Vincular a un padre ya registrado', type: 'select', options: pOpts, blank: '— Crear uno nuevo —' }, ...baseFields(when)],
    onSave: async d => {
      let p;
      if (d.padreId) p = U(d.padreId);
      else { p = await nuevoUser({ ...baseData(d), role: 'padre' }); created.push(p); }
      al.padreId = p.id; save(); render(); setTimeout(() => showCreds(created), 50);
    },
    onCancel: () => showCreds([al])
  });
}

/* ---------- grados ---------- */
function vGrados() {
  const gs = DB.grados;
  return head('Grados', can('grados') ? ab('nuevoGrado', '＋ Nuevo grado') : '') + (gs.length ? `<div class="grid">${gs.map(g => `<div class="card"><h3>${esc(g.nombre)} <span style="float:right">${eb('grado', g.id)}</span></h3><div class="muted">${fmtT(g.inicio)} – ${fmtT(g.fin)}</div>${(g.recreos || []).map(r => `<div class="muted">Recreo: ${fmtT(r.i)} – ${fmtT(r.f)}</div>`).join('')}<p>${alumnosDeGrado(g.id).length} alumnos · ${DB.cursos.filter(c => c.gradoId === g.id).length} cursos</p>${ab('go', 'Ver alumnos', { view: 'grado', id: g.id }, 'sm')}</div>`).join('')}</div>` : empty('Aún no hay grados. Crea el primero.'));
}
function vGrado() {
  const g = G(S.id); if (!g) return empty('Grado no encontrado.');
  const als = alumnosDeGrado(g.id).sort((a, b) => nm(a).localeCompare(nm(b)));
  const cs = DB.cursos.filter(c => c.gradoId === g.id);
  return head(esc(g.nombre), back('grados')) + `<div class="card"><h3>Horario</h3><p>${fmtT(g.inicio)} – ${fmtT(g.fin)}${(g.recreos || []).map(r => ` · Recreo ${fmtT(r.i)} – ${fmtT(r.f)}`).join('')}</p></div>
<div class="card"><h3>Alumnos (${als.length})</h3>${als.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Nombre</th><th>Usuario</th><th>Padre / madre</th><th>Solvencia</th></tr></thead><tbody>${als.map(a => `<tr><td>${esc(nm(a))}</td><td>${esc(a.username)}</td><td>${esc(nm(U(a.padreId)))}</td><td>${a.solvente === false ? chip('Insolvente', 'bad') : chip('Solvente', 'ok')}</td></tr>`).join('')}</tbody></table></div>` : empty('Sin alumnos en este grado.')}</div>
<div class="card"><h3>Cursos (${cs.length})</h3>${cs.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Curso</th><th>Horario</th><th>Maestro</th></tr></thead><tbody>${cs.map(c => `<tr><td>${esc(c.nombre)}</td><td>${horarioHTML(c)}</td><td>${esc(nm(U(c.maestroId)))}</td></tr>`).join('')}</tbody></table></div>` : empty('Sin cursos.')}</div>`;
}
function formGrado(ex) {
  const r = ex?.recreos || [];
  openForm({
    title: ex ? 'Editar grado' : 'Nuevo grado',
    intro: 'Define el horario del grado (ej. 7:00 a 13:00) y a qué hora es el recreo.',
    values: ex ? { nombre: ex.nombre, inicio: ex.inicio, fin: ex.fin, r1i: r[0]?.i, r1f: r[0]?.f, r2i: r[1]?.i, r2f: r[1]?.f } : { inicio: '07:00', fin: '13:00', r1i: '09:30', r1f: '10:00' },
    fields: [
      { k: 'nombre', label: 'Nombre del grado', req: 1 },
      { k: 'inicio', label: 'Hora de entrada', type: 'time', req: 1 }, { k: 'fin', label: 'Hora de salida', type: 'time', req: 1 },
      { k: 'r1i', label: 'Recreo 1 — inicio', type: 'time' }, { k: 'r1f', label: 'Recreo 1 — fin', type: 'time' },
      { k: 'r2i', label: 'Recreo 2 — inicio (opcional)', type: 'time' }, { k: 'r2f', label: 'Recreo 2 — fin (opcional)', type: 'time' }
    ],
    onSave: async d => {
      if (!can('grados')) throw new Error('No tienes permiso.');
      if (tmin(d.fin) <= tmin(d.inicio)) throw new Error('La hora de salida debe ser después de la entrada.');
      const recreos = [];
      [[d.r1i, d.r1f], [d.r2i, d.r2f]].forEach(([i, f], n) => {
        if (!i && !f) return;
        if (!i || !f) throw new Error(`Completa inicio y fin del recreo ${n + 1}.`);
        if (tmin(f) <= tmin(i) || tmin(i) < tmin(d.inicio) || tmin(f) > tmin(d.fin)) throw new Error(`El recreo ${n + 1} debe estar dentro del horario del grado.`);
        recreos.push({ i, f });
      });
      if (DB.grados.some(g => g.nombre.toLowerCase() === d.nombre.trim().toLowerCase() && g.id !== ex?.id)) throw new Error('Ya existe un grado con ese nombre.');
      const g = ex || { id: newId() };
      Object.assign(g, { nombre: d.nombre.trim(), inicio: d.inicio, fin: d.fin, recreos });
      if (!ex) DB.grados.push(g);
      save(); render();
    }
  });
}

/* ---------- cursos ---------- */
const horariosDe = c => (c.horarios || []).slice().sort((a, b) => DAYS.indexOf(a.dia) - DAYS.indexOf(b.dia));
const horarioTxt = c => {
  const g = new Map();
  horariosDe(c).forEach(h => { const k = h.inicio + '-' + h.fin; if (!g.has(k)) g.set(k, { i: h.inicio, f: h.fin, d: [] }); g.get(k).d.push(h.dia.slice(0, 3)); });
  return [...g.values()].map(x => `${x.d.join(', ')} · ${fmtT(x.i)} – ${fmtT(x.f)}`);
};
const horarioHTML = c => horarioTxt(c).map(esc).join('<br>') || '—';
const solapa = (a, b) => a.dia === b.dia && tmin(a.inicio) < tmin(b.fin) && tmin(a.fin) > tmin(b.inicio);
function vCursos() {
  const u = me();
  if (['alumno', 'maestro'].includes(u.role)) {
    const cs = cursosDe(u);
    return head(u.role === 'maestro' ? 'Mis cursos' : 'Mis cursos') + (cs.length ? `<div class="grid">${cs.map(c => `<div class="card"><h3>${esc(c.nombre)}</h3><div class="muted">${esc(G(c.gradoId)?.nombre)}</div><p>${horarioHTML(c)}</p><p class="muted">Maestro: ${esc(nm(U(c.maestroId)))}</p>${ab('go', 'Abrir curso', { view: 'curso', id: c.id }, 'sm')}</div>`).join('')}</div>` : empty('No tienes cursos asignados todavía.'));
  }
  const list = DB.cursos.filter(c => !S.rf || c.gradoId === S.rf);
  return head('Cursos', can('cursos') ? ab('nuevoCurso', '＋ Nuevo curso') : '') + `<div class="inl"><div><label class="muted">Grado</label><select data-filter="cursos"><option value="">Todos</option>${gOpts().map(o => `<option value="${o.v}" ${S.rf === o.v ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}</select></div></div><div class="card">${list.length ? `<div class="tw"><table class="tbl"><thead><tr><th>Curso</th><th>Grado</th><th>Horario</th><th>Maestro</th><th></th></tr></thead><tbody>${list.map(c => `<tr><td>${esc(c.nombre)}</td><td>${esc(G(c.gradoId)?.nombre)}</td><td>${horarioHTML(c)}</td><td>${esc(nm(U(c.maestroId)))}</td><td>${ab('go', 'Abrir', { view: 'curso', id: c.id }, 'ghost sm')} ${can('cursos') ? eb('curso', c.id) : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('No hay cursos.')}</div>`;
}
function formCurso(ex) {
  if (!DB.grados.length) return alert('Primero crea al menos un grado.');
  openForm({
    title: ex ? 'Editar curso' : 'Nuevo curso',
    values: ex ? { ...ex, maestroId: ex.maestroId || '' } : { horarios: [] },
    fields: [
      { k: 'nombre', label: 'Nombre del curso', req: 1 },
      { k: 'gradoId', label: 'Grado al que pertenece', type: 'select', req: 1, options: gOpts, blank: '— Selecciona —' },
      { k: 'horarios', label: 'Horario por día', type: 'horarios', hint: 'Marca cada día que se imparte y su hora. Puede ser distinta en cada día (ej.: lunes 8:00 y jueves 10:00).' },
      { k: 'maestroId', label: 'Maestro', type: 'select', options: () => DB.users.filter(x => x.role === 'maestro' && x.activo !== false).map(x => ({ v: x.id, l: nm(x) })), blank: '— Sin asignar —' },
      { k: 'descripcion', label: 'Descripción', type: 'textarea' }
    ],
    onSave: async d => {
      if (!can('cursos')) throw new Error('No tienes permiso.');
      const g = G(d.gradoId);
      if (!g) throw new Error('Selecciona un grado.');
      const hs = d.horarios || [];
      if (!hs.length) throw new Error('Marca al menos un día con su horario.');
      for (const h of hs) {
        if (tmin(h.fin) <= tmin(h.inicio)) throw new Error(`${h.dia}: la hora de fin debe ser después del inicio.`);
        if (tmin(h.inicio) < tmin(g.inicio) || tmin(h.fin) > tmin(g.fin)) throw new Error(`${h.dia}: el horario debe estar dentro del horario del grado (${fmtT(g.inicio)} – ${fmtT(g.fin)}).`);
        for (const r of g.recreos || []) if (tmin(h.inicio) < tmin(r.f) && tmin(h.fin) > tmin(r.i)) throw new Error(`${h.dia}: choca con el recreo (${fmtT(r.i)} – ${fmtT(r.f)}).`);
      }
      const choca = (o, h) => o.id !== ex?.id && (o.horarios || []).some(x => solapa(x, h));
      for (const h of hs) {
        const c1 = DB.cursos.find(o => o.gradoId === d.gradoId && choca(o, h));
        if (c1) throw new Error(`${h.dia}: choca con "${c1.nombre}" del mismo grado.`);
        if (d.maestroId) { const c2 = DB.cursos.find(o => o.maestroId === d.maestroId && choca(o, h)); if (c2) throw new Error(`${h.dia}: el maestro ya tiene "${c2.nombre}" en ese horario.`); }
      }
      const c = ex || { id: newId() };
      const prev = c.maestroId;
      Object.assign(c, { nombre: d.nombre.trim(), gradoId: d.gradoId, horarios: hs, maestroId: d.maestroId || null, descripcion: d.descripcion || '' });
      if (!ex) DB.cursos.push(c);
      if (c.maestroId && c.maestroId !== prev) notify(c.maestroId, 'Curso asignado', cursoLabel(c), 'cursos');
      save(); render();
    }
  });
}

/* =====================================================================
   Cursos (detalle), módulos, tareas, calificaciones
   ===================================================================== */
function promedio(aid, cid) {
  let n = 0, d = 0;
  DB.tareas.filter(t => t.cursoId === cid).forEach(t => { const e = entregaDe(t.id, aid); if (tieneNota(e)) { n += +e.nota; d += +t.puntos; } });
  DB.examenes.filter(x => x.cursoId === cid).forEach(x => { const it = intentoDe(x.id, aid); if (it && it.estado === 'calificado') { n += +it.nota; d += exTotal(x); } });
  return d ? Math.round(n / d * 1000) / 10 : null;
}
function asistPct(aid, cid) {
  let p = 0, t = 0;
  DB.asistencia.filter(r => r.cursoId === cid && r.reg[aid] && r.reg[aid] !== 'E').forEach(r => { t++; if (r.reg[aid] === 'P' || r.reg[aid] === 'T') p++; });
  return t ? Math.round(p / t * 100) : null;
}
function estadoTarea(t, aid) {
  const e = entregaDe(t.id, aid);
  if (tieneNota(e)) return ['Calificada', 'ok'];
  if (e) return ['Entregada', ''];
  if (new Date(t.entrega) < new Date()) return ['No entregada', 'bad'];
  return ['Pendiente', 'warn'];
}
const tbl = (cols, rows) => `<div class="tw"><table class="tbl"><thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;

function vCurso() {
  const u = me(), c = C(S.id);
  if (!c) return empty('Curso no encontrado.');
  if (u.role === 'alumno' && c.gradoId !== u.gradoId) return empty('No tienes acceso a este curso.');
  if (u.role === 'maestro' && c.maestroId !== u.id) return empty('No tienes acceso a este curso.');
  const teach = (u.role === 'maestro' && c.maestroId === u.id) || u.role === 'admin';
  const mods = DB.modulos.filter(m => m.cursoId === c.id).sort((a, b) => b.fecha - a.fecha);
  const tareas = DB.tareas.filter(t => t.cursoId === c.id && (u.role !== 'alumno' || publicada(t))).sort((a, b) => new Date(a.entrega) - new Date(b.entrega));
  const ans = DB.anuncios.filter(a => a.alcance === 'curso' && a.target === c.id).sort((a, b) => b.fecha - a.fecha);
  const als = alumnosDeCurso(c).sort((a, b) => nm(a).localeCompare(nm(b)));
  const volver = u.role === 'alumno' || u.role === 'maestro' ? 'cursos' : 'cursos';
  return head(esc(c.nombre), back(volver)) + `<div class="card"><p>${esc(G(c.gradoId)?.nombre)}<br>${horarioHTML(c)}<br><span class="muted">Maestro: ${esc(nm(U(c.maestroId)))}</span></p>${c.descripcion ? `<p>${nl(c.descripcion)}</p>` : ''}</div>
<div class="card"><div class="vh"><h3 style="margin:0;flex:1">Módulos del curso</h3>${teach && can('modulos') ? ab('nuevoModulo', '＋ Módulo', { id: c.id }, 'sm') : ''}</div>${mods.map(m => `<div style="padding:8px 0;border-bottom:1px solid var(--bd)"><b>${esc(m.titulo)}</b> ${teach && can('modulos') ? eb('modulo', m.id) : ''}<div class="muted">${fmtDate(new Date(m.fecha).toISOString())}</div><div>${nl(m.descripcion)}</div>${fileLink(m.archivo)}</div>`).join('') || empty('Aún no hay módulos.')}</div>
<div class="card"><div class="vh"><h3 style="margin:0;flex:1">Tareas</h3>${teach && can('tareas') ? ab('nuevaTarea', '＋ Tarea', { id: c.id }, 'sm') : ''}</div>${tareas.map(t => `<div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--bd)"><span><b>${esc(t.titulo)}</b><br><span class="muted">Entrega: ${fmtDT(t.entrega)} · ${t.puntos} pts ${!publicada(t) ? chip('Programada ' + fmtDT(t.publica), 'warn') : ''}</span></span><span>${u.role === 'alumno' ? chip(...estadoTarea(t, u.id)) + ' ' + ab('go', 'Abrir', { view: 'tarea', id: t.id }, 'sm') : (teach ? ab('go', 'Calificar', { view: 'calificar', id: t.id }, 'sm') + ' ' + (can('tareas') ? eb('tarea', t.id) : '') : '')}</span></div>`).join('') || empty('Sin tareas.')}</div>
<div class="card"><div class="vh"><h3 style="margin:0;flex:1">Exámenes</h3>${teach && can('examenes') ? ab('exNuevoCurso', '＋ Examen', { id: c.id }, 'sm') : ''}</div>${DB.examenes.filter(x => x.cursoId === c.id && (u.role !== 'alumno' || true)).map(x => `<div class="row" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--bd)"><span><b>${esc(x.titulo)}</b><br><span class="muted">${fmtDT(x.abre)} → ${fmtDT(x.cierra)} · ${x.minutos} min</span></span><span>${u.role === 'alumno' ? chip(...estadoExamen(x, u.id)) + ' ' + ab('go', 'Abrir', { view: 'examen', id: x.id }, 'sm') : (teach ? ab('go', 'Resultados', { view: 'examen_res', id: x.id }, 'sm') : '')}</span></div>`).join('') || empty('Sin exámenes.')}</div>
<div class="card"><div class="vh"><h3 style="margin:0;flex:1">Anuncios del curso</h3>${teach && can('anuncio_curso') ? ab('nuevoAnuncio', '＋ Anuncio', { curso: c.id }, 'sm') : ''}</div>${ans.map(anuncioCard).join('') || empty('Sin anuncios.')}</div>
${u.role !== 'alumno' ? `<div class="card"><h3>Alumnos (${als.length})</h3>${als.length ? tbl(['Alumno', 'Asistencia', 'Promedio'], als.map(a => { const p = promedio(a.id, c.id), s = asistPct(a.id, c.id); return `<tr><td>${esc(nm(a))}</td><td>${s === null ? '—' : s + '%'}</td><td>${p === null ? '—' : p + '%'}</td></tr>`; })) : empty('Sin alumnos.')}</div>` : ''}`;
}

function formModulo(cursoId, ex) {
  openForm({
    title: ex ? 'Editar módulo' : 'Nuevo módulo',
    values: ex || {},
    fields: [{ k: 'titulo', label: 'Título del módulo', req: 1 }, { k: 'descripcion', label: 'Contenido / descripción', type: 'textarea' }, { k: 'archivo', label: 'Archivo (máx. 10 MB)', type: 'file', max: 10 }],
    onSave: async d => {
      if (!can('modulos')) throw new Error('No tienes permiso.');
      const m = ex || { id: newId(), cursoId, fecha: Date.now() };
      Object.assign(m, { titulo: d.titulo.trim(), descripcion: d.descripcion || '', archivo: d.archivo });
      if (!ex) { DB.modulos.push(m); alumnosDeCurso(C(cursoId)).forEach(a => notify(a.id, 'Nuevo módulo: ' + m.titulo, C(cursoId).nombre, 'cursos')); }
      save(); render();
    }
  });
}
function formTarea(cursoId, ex) {
  const u = me();
  const cs = cursosDe(u);
  if (!cs.length) return alert('No tienes cursos asignados.');
  openForm({
    title: ex ? 'Editar tarea' : 'Nueva tarea',
    intro: 'Puedes programarla: los alumnos la verán desde la fecha de publicación.',
    values: ex || { cursoId, puntos: 100, publica: nowLocal() },
    fields: [
      { k: 'cursoId', label: 'Curso', type: 'select', req: 1, options: () => cs.map(c => ({ v: c.id, l: cursoLabel(c) })) },
      { k: 'titulo', label: 'Título', req: 1 }, { k: 'descripcion', label: 'Instrucciones', type: 'textarea' },
      { k: 'puntos', label: 'Puntos', type: 'number', req: 1, min: 1, max: 1000 },
      { k: 'publica', label: 'Publicar el', type: 'datetime-local', req: 1 },
      { k: 'entrega', label: 'Fecha límite de entrega', type: 'datetime-local', req: 1 },
      { k: 'adjunto', label: 'Archivo adjunto (máx. 10 MB)', type: 'file', max: 10 }
    ],
    onSave: async d => {
      if (!can('tareas')) throw new Error('No tienes permiso.');
      if (!cs.some(c => c.id === d.cursoId)) throw new Error('Ese curso no es tuyo.');
      if (new Date(d.entrega) <= new Date(d.publica)) throw new Error('La fecha de entrega debe ser posterior a la de publicación.');
      const t = ex || { id: newId(), autor: u.id };
      Object.assign(t, { cursoId: d.cursoId, titulo: d.titulo.trim(), descripcion: d.descripcion || '', puntos: +d.puntos, publica: d.publica, entrega: d.entrega, adjunto: d.adjunto });
      if (ex && !publicada(t)) t.notificada = false;
      if (!ex) DB.tareas.push(t);
      save(); render(); tick();
    }
  });
}
function vTareas() {
  const u = me();
  if (u.role === 'alumno') {
    const items = DB.tareas.filter(t => publicada(t) && cursosDe(u).some(c => c.id === t.cursoId)).sort((a, b) => new Date(a.entrega) - new Date(b.entrega));
    return head('Mis tareas') + (items.length ? `<div class="card">${tbl(['Tarea', 'Curso', 'Entrega', 'Estado', ''], items.map(t => `<tr><td>${esc(t.titulo)}</td><td>${esc(C(t.cursoId)?.nombre)}</td><td>${fmtDT(t.entrega)}</td><td>${chip(...estadoTarea(t, u.id))}</td><td>${ab('go', 'Abrir', { view: 'tarea', id: t.id }, 'sm')}</td></tr>`))}</div>` : empty('No tienes tareas por ahora.'));
  }
  const items = DB.tareas.filter(t => cursosDe(u).some(c => c.id === t.cursoId)).sort((a, b) => new Date(b.entrega) - new Date(a.entrega));
  return head('Tareas', can('tareas') ? ab('nuevaTarea', '＋ Nueva tarea') : '') + (items.length ? `<div class="card">${tbl(['Tarea', 'Curso', 'Entrega', 'Entregas', ''], items.map(t => { const c = C(t.cursoId), tot = alumnosDeCurso(c).length, n = DB.entregas.filter(e => e.tareaId === t.id).length; return `<tr><td>${esc(t.titulo)} ${!publicada(t) ? chip('Programada ' + fmtDT(t.publica), 'warn') : ''}</td><td>${esc(c?.nombre)}</td><td>${fmtDT(t.entrega)}</td><td>${n} / ${tot}</td><td>${can('calificar') ? ab('go', 'Calificar', { view: 'calificar', id: t.id }, 'sm') : ''} ${can('tareas') ? eb('tarea', t.id) : ''}</td></tr>`; }))}</div>` : empty('Aún no has creado tareas.'));
}
function vTarea() {
  const u = me(), t = T(S.id);
  if (!t || !publicada(t) || !cursosDe(u).some(c => c.id === t.cursoId)) return empty('Tarea no disponible.');
  const e = entregaDe(t.id, u.id), cerrada = tieneNota(e);
  return head(esc(t.titulo), back('tareas')) + `<div class="card"><p class="muted">${esc(C(t.cursoId)?.nombre)} · ${t.puntos} puntos · Entrega: ${fmtDT(t.entrega)}</p><p>${nl(t.descripcion) || '<span class="muted">Sin instrucciones.</span>'}</p>${fileLink(t.adjunto)}</div>
<div class="card"><h3>Mi entrega ${chip(...estadoTarea(t, u.id))}</h3>${e ? `<p>${nl(e.texto) || ''}</p><p class="chips">${linksHTML(e.links)} ${fileLink(e.archivo)}</p><p class="muted">Enviada: ${fmtDT(e.fecha)} ${e.tarde ? chip('Con retraso', 'warn') : ''}</p>${cerrada ? `<p><b>Nota: ${e.nota} / ${t.puntos}</b></p>${e.comentario ? `<p>Comentario: ${nl(e.comentario)}</p>` : ''}` : `<div class="row">${ab('entregar', 'Editar entrega', { id: t.id }, 'sm')} ${eb('entrega', e.id)}</div>`}` : `<p class="muted">Aún no has entregado esta tarea.</p>${ab('entregar', 'Entregar tarea', { id: t.id })}`}</div>`;
}
function formEntrega(t, ex) {
  const u = me();
  openForm({
    title: ex ? 'Editar entrega' : 'Entregar tarea', intro: t.titulo + ' — puedes enviar texto, enlaces (Drive, YouTube, etc.) y/o un documento de hasta 5 MB.',
    values: { texto: ex?.texto || '', links: (ex?.links || []).join('\n'), archivo: ex?.archivo || null },
    fields: [
      { k: 'texto', label: 'Respuesta o comentario', type: 'textarea' },
      { k: 'links', label: 'Enlaces (uno por línea)', type: 'textarea', hint: 'Ej.: https://drive.google.com/…' },
      { k: 'archivo', label: 'Documento (máx. 5 MB)', type: 'file', max: 5, hint: 'PDF, Word, Excel, PowerPoint, imágenes, ZIP…' }
    ],
    onSave: async d => {
      const links = parseLinks(d.links);
      if (!d.texto.trim() && !d.archivo && !links.length) throw new Error('Escribe una respuesta, agrega un enlace o adjunta un documento.');
      if (ex && tieneNota(ex)) throw new Error('La tarea ya fue calificada.');
      if (d.archivo && d.archivo.size > 5 * 1048576) throw new Error('El documento supera los 5 MB.');
      const e = ex || { id: newId(), tareaId: t.id, alumnoId: u.id };
      Object.assign(e, { texto: d.texto.trim(), links, archivo: d.archivo, fecha: Date.now(), tarde: new Date(t.entrega) < new Date() });
      if (!ex) DB.entregas.push(e);
      const c = C(t.cursoId); if (c?.maestroId) notify(c.maestroId, 'Entrega de ' + nm(u), t.titulo, 'calificar');
      save(); render();
    }
  });
}
function vCalificar() {
  const t = T(S.id);
  if (!t) return empty('Tarea no encontrada.');
  const c = C(t.cursoId), u = me();
  if (u.role === 'maestro' && c.maestroId !== u.id) return empty('No tienes acceso.');
  const als = alumnosDeCurso(c).sort((a, b) => nm(a).localeCompare(nm(b)));
  return head('Calificar: ' + esc(t.titulo), back('tareas')) + `<div class="card"><p class="muted">${esc(c.nombre)} · ${t.puntos} puntos · Entrega ${fmtDT(t.entrega)}</p>${als.length ? tbl(['Alumno', 'Entrega', 'Estado', 'Nota', ''], als.map(a => { const e = entregaDe(t.id, a.id); return `<tr><td>${esc(nm(a))}</td><td>${e ? `${nl((e.texto || '').slice(0, 160))}${(e.texto || '').length > 160 ? '…' : ''}<br>${linksHTML(e.links)} ${fileLink(e.archivo)}` : '—'}</td><td>${chip(...estadoTarea(t, a.id))}${e && e.tarde ? ' ' + chip('Tarde', 'warn') : ''}</td><td>${tieneNota(e) ? e.nota + ' / ' + t.puntos : '—'}</td><td>${e && can('calificar') ? ab('calificarAl', tieneNota(e) ? 'Editar nota' : 'Calificar', { id: e.id }, 'sm') : ''}</td></tr>`; })) : empty('No hay alumnos en este curso.')}</div>`;
}
function formNota(e) {
  const t = T(e.tareaId), al = U(e.alumnoId);
  openForm({
    title: 'Calificar a ' + nm(al), intro: t.titulo,
    values: { nota: e.nota ?? '', comentario: e.comentario || '' },
    fields: [{ k: 'nota', label: `Nota (0 – ${t.puntos})`, type: 'number', req: 1, min: 0, max: t.puntos, step: '0.01' }, { k: 'comentario', label: 'Comentario para el alumno', type: 'textarea' }],
    onSave: async d => {
      if (!can('calificar')) throw new Error('No tienes permiso.');
      const n = +d.nota;
      if (isNaN(n) || n < 0 || n > t.puntos) throw new Error(`La nota debe estar entre 0 y ${t.puntos}.`);
      e.nota = n; e.comentario = d.comentario || ''; e.calificada = Date.now();
      notify(al.id, 'Tarea calificada: ' + t.titulo, `Nota ${n} / ${t.puntos}`, 'notas');
      save(); render();
    }
  });
}
function gradesBlock(al) {
  const cs = cursosDe(al);
  if (!cs.length) return empty('Sin cursos asignados.');
  return cs.map(c => {
    const ts = DB.tareas.filter(t => t.cursoId === c.id && publicada(t)).sort((a, b) => new Date(a.entrega) - new Date(b.entrega));
    const xs = DB.examenes.filter(x => x.cursoId === c.id && new Date(x.abre) <= new Date());
    const pr = promedio(al.id, c.id);
    const rows = ts.map(t => { const e = entregaDe(t.id, al.id); return `<tr><td>${esc(t.titulo)}</td><td>${fmtDate(t.entrega)}</td><td>${tieneNota(e) ? e.nota + ' / ' + t.puntos : '—'}</td><td>${chip(...estadoTarea(t, al.id))}</td></tr>`; })
      .concat(xs.map(x => { const it = intentoDe(x.id, al.id); return `<tr><td>🧪 ${esc(x.titulo)}</td><td>${fmtDate(x.cierra)}</td><td>${it && it.estado !== 'en_curso' ? it.nota + ' / ' + exTotal(x) : '—'}</td><td>${chip(...estadoExamen(x, al.id))}</td></tr>`; }));
    return `<div class="card"><h3>${esc(c.nombre)} ${pr !== null ? chip('Promedio ' + pr + '%', pr >= 60 ? 'ok' : 'bad') : ''}</h3>${rows.length ? tbl(['Actividad', 'Fecha', 'Nota', 'Estado'], rows) : empty('Sin tareas ni exámenes aún.')}</div>`;
  }).join('');
}
const vNotas = () => head('Mis calificaciones') + gradesBlock(me());
function vHijos() {
  const hs = hijosDe(me());
  return head('Mis hijos') + (hs.map(h => `<h3>${esc(nm(h))} <span class="muted">· ${esc(G(h.gradoId)?.nombre)}</span></h3>${h.solvente === false ? `<div class="banner bad">Estado: INSOLVENTE. Comunícate con la secretaría para ver calificaciones y tareas pendientes.</div><br>` : gradesBlock(h)}`).join('') || empty('No tienes hijos vinculados.'));
}
function vHorario() {
  const u = me(), cs = cursosDe(u), g = G(u.gradoId);
  if (!cs.length) return head('Horario semanal') + empty('No tienes cursos asignados.');
  const slots = new Map();
  cs.forEach(c => (c.horarios || []).forEach(h => slots.set(h.inicio + '-' + h.fin, { i: h.inicio, f: h.fin, rec: false })));
  (g?.recreos || []).forEach(r => slots.set(r.i + '-' + r.f, { i: r.i, f: r.f, rec: true }));
  const list = [...slots.values()].sort((a, b) => tmin(a.i) - tmin(b.i));
  const dias = DAYS.filter(d => cs.some(c => (c.horarios || []).some(h => h.dia === d)));
  if (!dias.length) return head('Horario semanal') + empty('Tus cursos aún no tienen horario.');
  return head('Horario semanal') + `<div class="card tw"><table class="tbl sched"><thead><tr><th>Hora</th>${dias.map(d => `<th class="c">${d}</th>`).join('')}</tr></thead><tbody>${list.map(s => s.rec ? `<tr class="rec"><td>${fmtT(s.i)} – ${fmtT(s.f)}</td><td colspan="${dias.length}">🍎 Recreo</td></tr>` : `<tr><td>${fmtT(s.i)} – ${fmtT(s.f)}</td>${dias.map(d => { const c = cs.find(x => (x.horarios || []).some(h => h.dia === d && h.inicio === s.i && h.fin === s.f)); return `<td>${c ? `<b>${esc(c.nombre)}</b><br><small>${esc(nm(U(c.maestroId)))}</small>` : ''}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/* ---------- asistencia ---------- */
function attCard(al, c) {
  const rs = DB.asistencia.filter(r => r.cursoId === c.id && r.reg[al.id]).sort((a, b) => b.fecha.localeCompare(a.fecha));
  const p = asistPct(al.id, c.id);
  const cls = { P: 'ok', A: 'bad', T: 'warn', E: '' };
  return `<div class="card"><h3>${esc(c.nombre)} ${p !== null ? chip('Asistencia ' + p + '%', p >= 80 ? 'ok' : 'bad') : ''}</h3>${rs.length ? tbl(['Fecha', 'Estado'], rs.map(r => `<tr><td>${fmtDate(r.fecha)}</td><td>${chip(ESTADOS[r.reg[al.id]], cls[r.reg[al.id]])}</td></tr>`)) : empty('Sin registros.')}</div>`;
}
function vAsistencia() {
  const u = me();
  if (u.role === 'alumno') return head('Mi asistencia') + (cursosDe(u).map(c => attCard(u, c)).join('') || empty('Sin cursos.'));
  if (u.role === 'padre') return head('Asistencia de mis hijos') + (hijosDe(u).map(h => `<h3>${esc(nm(h))}</h3>${cursosDe(h).map(c => attCard(h, c)).join('') || empty('Sin cursos.')}`).join('') || empty('No tienes hijos vinculados.'));
  const cs = cursosDe(u);
  if (!cs.length) return head('Asistencia') + empty('No hay cursos disponibles.');
  if (!S.attC || !cs.some(c => c.id === S.attC)) S.attC = cs[0].id;
  if (!S.attF) S.attF = todayStr();
  const c = C(S.attC), rec = DB.asistencia.find(r => r.cursoId === c.id && r.fecha === S.attF);
  const als = alumnosDeCurso(c).sort((a, b) => nm(a).localeCompare(nm(b)));
  return head('Tomar asistencia') + `<div class="inl"><div><label class="muted">Curso</label><select data-sel="attC">${cs.map(x => `<option value="${x.id}" ${x.id === c.id ? 'selected' : ''}>${esc(cursoLabel(x))}</option>`).join('')}</select></div><div><label class="muted">Fecha</label><input type="date" data-sel="attF" value="${S.attF}" max="${todayStr()}"></div></div>
<div class="card att">${als.length ? tbl(['Alumno', 'Estado'], als.map(a => { const cur = rec?.reg[a.id] || 'P'; return `<tr><td>${esc(nm(a))}</td><td>${Object.entries(ESTADOS).map(([k, l]) => `<label><input type="radio" name="st_${a.id}" value="${k}" ${cur === k ? 'checked' : ''}> ${l}</label>`).join('')}</td></tr>`; })) + `<div class="row end" style="margin-top:12px">${rec ? ab('delAsist', 'Eliminar registro del día', { id: rec.id }, 'ghost sm') : ''}${can('asistencia') ? ab('guardarAsistencia', rec ? 'Actualizar asistencia' : 'Guardar asistencia') : ''}</div>` : empty('No hay alumnos en este curso.')}</div>`;
}

/* ---------- anuncios ---------- */
function anuncioCard(a) {
  const u = me();
  const al = { general: 'General', grado: 'Grado: ' + (G(a.target)?.nombre || '—'), curso: 'Curso: ' + (C(a.target)?.nombre || '—'), maestros: 'Solo maestros' }[a.alcance];
  const editable = a.autor === u.id || u.role === 'admin';
  return `<article class="post"><header><h3>${esc(a.titulo)}</h3>${chip(al)}${editable ? eb('anuncio', a.id) : ''}</header><div class="muted">${esc(nm(U(a.autor)))} · ${fmtDT(a.fecha)}</div><br>${postBody(a)}</article>`;
}
function alcancesPermitidos() {
  const o = [];
  if (can('anuncio_general')) o.push({ v: 'general', l: 'General (todo el colegio)' });
  if (can('anuncio_grado')) o.push({ v: 'grado', l: 'Por grado' });
  if (can('anuncio_curso')) o.push({ v: 'curso', l: 'Por curso' });
  if (can('anuncio_maestros')) o.push({ v: 'maestros', l: 'Solo maestros' });
  return o;
}
function vAnuncios() {
  const u = me();
  const f = S.anF;
  const list = DB.anuncios.filter(a => veAnuncio(a, u) && (f === 'todos' || a.alcance === f)).sort((a, b) => b.fecha - a.fecha);
  return head('Anuncios', alcancesPermitidos().length ? ab('nuevoAnuncio', '＋ Nuevo anuncio') : '') + `<div class="inl"><div><label class="muted">Mostrar</label><select data-sel="anF">${[['todos', 'Todos'], ['general', 'Generales'], ['grado', 'Por grado'], ['curso', 'Por curso'], ['maestros', 'Solo maestros']].map(([v, l]) => `<option value="${v}" ${f === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>${list.map(anuncioCard).join('') || empty('No hay anuncios.')}`;
}
function formAnuncio(ex, cursoPre) {
  const u = me();
  let al = alcancesPermitidos();
  if (ex && !al.some(x => x.v === ex.alcance)) al = [...al, { v: ex.alcance, l: ex.alcance }];
  if (!al.length) return alert('No tienes permiso para enviar anuncios.');
  const cs = u.role === 'maestro' ? cursosDe(u) : DB.cursos;
  openForm({
    title: ex ? 'Editar anuncio' : 'Nuevo anuncio',
    values: ex ? { alcance: ex.alcance, tg: ex.alcance === 'grado' ? ex.target : '', tc: ex.alcance === 'curso' ? ex.target : '', titulo: ex.titulo, texto: ex.texto, img: ex.img } : (cursoPre ? { alcance: 'curso', tc: cursoPre } : {}),
    fields: [
      { k: 'alcance', label: '¿Quién lo verá?', type: 'select', req: 1, options: al },
      { k: 'tg', label: 'Grado', type: 'select', req: 1, options: gOpts, blank: '— Selecciona —', when: { k: 'alcance', in: ['grado'] } },
      { k: 'tc', label: 'Curso', type: 'select', req: 1, options: () => cs.map(c => ({ v: c.id, l: cursoLabel(c) })), blank: '— Selecciona —', when: { k: 'alcance', in: ['curso'] } },
      { k: 'titulo', label: 'Título', req: 1 },
      { k: 'texto', label: 'Texto del anuncio', type: 'textarea', req: 1 },
      { k: 'img', label: 'Imagen (opcional, máx. 10 MB)', type: 'file', image: true, accept: 'image/png,image/jpeg,image/webp,image/gif', max: 10, hint: 'Sin imagen se usa la predeterminada: fondo blanco con el logo del colegio y tu texto encima.' },
      ...(ex?.img ? [{ k: 'quitar', label: 'Imagen actual', type: 'check', text: 'Quitar imagen y usar la predeterminada' }] : [])
    ],
    onSave: async d => {
      if (!alcancesPermitidos().some(x => x.v === d.alcance) && !(ex && ex.alcance === d.alcance)) throw new Error('No tienes permiso para ese tipo de anuncio.');
      let target = null;
      if (d.alcance === 'grado') { target = d.tg; if (!G(target)) throw new Error('Selecciona un grado.'); }
      if (d.alcance === 'curso') { target = d.tc; if (!cs.some(c => c.id === target)) throw new Error('Selecciona uno de tus cursos.'); }
      const a = ex || { id: newId(), autor: u.id, fecha: Date.now() };
      Object.assign(a, { alcance: d.alcance, target, titulo: d.titulo.trim(), texto: d.texto.trim(), img: d.quitar ? null : d.img });
      if (!ex) { DB.anuncios.push(a); DB.users.filter(x => x.activo !== false && x.id !== u.id && veAnuncio(a, x)).forEach(x => notify(x.id, 'Anuncio: ' + a.titulo, nm(u), 'anuncios')); }
      save(); render();
    }
  });
}

/* ---------- buzón ---------- */
function contactos(u) {
  const act = DB.users.filter(x => x.activo !== false && x.id !== u.id);
  if (['admin', 'director', 'secretaria'].includes(u.role)) return act;
  if (u.role === 'maestro') {
    const alu = new Set(cursosDe(u).flatMap(alumnosDeCurso).map(a => a.id));
    const pad = new Set(act.filter(x => alu.has(x.id)).map(a => a.padreId));
    return act.filter(x => alu.has(x.id) || pad.has(x.id) || ['director', 'secretaria'].includes(x.role));
  }
  if (u.role === 'alumno') { const ms = new Set(cursosDe(u).map(c => c.maestroId)); return act.filter(x => ms.has(x.id)); }
  if (u.role === 'padre') { const ms = new Set(); hijosDe(u).forEach(h => cursosDe(h).forEach(c => ms.add(c.maestroId))); return act.filter(x => ms.has(x.id) || x.role === 'secretaria'); }
  return [];
}
function tiposMensaje(u) {
  const t = [{ v: 'persona', l: 'Una persona' }];
  if (!can('buzon_masivo')) return t;
  t.push({ v: 'padres_curso', l: 'Padres de un curso' }, { v: 'alumnos_curso', l: 'Alumnos de un curso' });
  if (u.role !== 'maestro') t.push({ v: 'padres_grado', l: 'Padres de un grado' }, { v: 'padres_todos', l: 'Todos los padres' }, { v: 'maestros', l: 'Todos los maestros' });
  return t;
}
const padresDe = als => [...new Set(als.map(a => a.padreId).filter(Boolean))].map(U).filter(x => x && x.activo !== false);
function resolverDest(u, d) {
  switch (d.tipo) {
    case 'persona': return contactos(u).filter(x => x.id === d.personaId);
    case 'padres_todos': return DB.users.filter(x => x.role === 'padre' && x.activo !== false);
    case 'padres_grado': return padresDe(alumnosDeGrado(d.gradoId));
    case 'padres_curso': return padresDe(alumnosDeCurso(C(d.cursoId)));
    case 'alumnos_curso': return alumnosDeCurso(C(d.cursoId));
    case 'maestros': return DB.users.filter(x => x.role === 'maestro' && x.activo !== false);
  }
  return [];
}
function formMensaje(ex, pre = {}) {
  const u = me();
  const cs = u.role === 'maestro' ? cursosDe(u) : DB.cursos;
  const comunes = [
    { k: 'asunto', label: 'Asunto', req: 1 },
    { k: 'texto', label: 'Mensaje', type: 'textarea', req: 1 },
    { k: 'img', label: 'Imagen (opcional, máx. 10 MB)', type: 'file', image: true, accept: 'image/png,image/jpeg,image/webp,image/gif', max: 10, hint: 'Sin imagen se usa la predeterminada con el logo del colegio.' }
  ];
  openForm({
    title: ex ? 'Editar mensaje' : 'Nuevo mensaje',
    values: ex ? { asunto: ex.asunto, texto: ex.texto, img: ex.img } : { tipo: 'persona', ...pre },
    fields: ex ? comunes : [
      { k: 'tipo', label: 'Enviar a', type: 'select', req: 1, options: tiposMensaje(u) },
      { k: 'personaId', label: 'Persona', type: 'select', req: 1, options: () => contactos(u).sort((a, b) => nm(a).localeCompare(nm(b))).map(x => ({ v: x.id, l: `${nm(x)} (${ROLES[x.role]})` })), blank: '— Selecciona —', when: { k: 'tipo', in: ['persona'] } },
      { k: 'gradoId', label: 'Grado', type: 'select', req: 1, options: gOpts, blank: '— Selecciona —', when: { k: 'tipo', in: ['padres_grado'] } },
      { k: 'cursoId', label: 'Curso', type: 'select', req: 1, options: () => cs.map(c => ({ v: c.id, l: cursoLabel(c) })), blank: '— Selecciona —', when: { k: 'tipo', in: ['padres_curso', 'alumnos_curso'] } },
      ...comunes
    ],
    onSave: async d => {
      if (ex) {
        DB.mensajes.filter(m => m.batch === ex.batch).forEach(m => Object.assign(m, { asunto: d.asunto.trim(), texto: d.texto.trim(), img: d.img }));
        save(); render(); return;
      }
      if (!tiposMensaje(u).some(t => t.v === d.tipo)) throw new Error('No tienes permiso para ese tipo de envío.');
      if (['padres_curso', 'alumnos_curso'].includes(d.tipo) && !cs.some(c => c.id === d.cursoId)) throw new Error('Ese curso no es tuyo.');
      const dest = resolverDest(u, d);
      if (!dest.length) throw new Error('No hay destinatarios para esa selección.');
      const et = { persona: nm(dest[0]), padres_todos: 'Todos los padres', padres_grado: 'Padres de ' + (G(d.gradoId)?.nombre || ''), padres_curso: 'Padres de ' + (C(d.cursoId)?.nombre || ''), alumnos_curso: 'Alumnos de ' + (C(d.cursoId)?.nombre || ''), maestros: 'Todos los maestros' }[d.tipo];
      const batch = newId(), fecha = Date.now();
      dest.forEach(x => {
        DB.mensajes.push({ id: newId(), batch, de: u.id, para: x.id, asunto: d.asunto.trim(), texto: d.texto.trim(), img: d.img, fecha, leido: false, etiqueta: et });
        notify(x.id, 'Mensaje: ' + d.asunto.trim(), 'De ' + nm(u), 'buzon');
      });
      S.bz = 'out'; save(); render(); toast(`Enviado a ${dest.length} persona(s)`);
    }
  });
}
function vBuzon() {
  const u = me();
  if (S.msg) {
    const m = DB.mensajes.find(x => x.id === S.msg);
    if (!m) { S.msg = null; return vBuzon(); }
    const mio = m.de === u.id;
    if (!mio && !m.leido) { m.leido = true; save(); }
    return head(esc(m.asunto), ab('cerrarMsg', '← Volver', {}, 'ghost sm')) + `<article class="post"><header><h3>${mio ? 'Para: ' + esc(m.etiqueta) : 'De: ' + esc(nm(U(m.de)))}</h3>${mio ? eb('mensaje', m.id) : ''}</header><div class="muted">${fmtDT(m.fecha)}</div><br>${postBody(m)}</article><div class="row">${!mio ? ab('responder', 'Responder', { id: m.id }) + ' ' + ab('delMsgIn', 'Eliminar', { id: m.id }, 'ghost') : ''}</div>`;
  }
  const inbox = DB.mensajes.filter(m => m.para === u.id && !m.delPara).sort((a, b) => b.fecha - a.fecha);
  const seen = new Set();
  const sent = DB.mensajes.filter(m => m.de === u.id).sort((a, b) => b.fecha - a.fecha).filter(m => !seen.has(m.batch) && seen.add(m.batch));
  const list = S.bz === 'in' ? inbox : sent;
  return head('Buzón', ab('redactar', '✉ Redactar')) + `<div class="row" style="margin-bottom:12px">${ab('bzTab', `Recibidos (${inbox.filter(m => !m.leido).length})`, { t: 'in' }, S.bz === 'in' ? '' : 'ghost')}${ab('bzTab', 'Enviados', { t: 'out' }, S.bz === 'out' ? '' : 'ghost')}</div><div class="card" style="padding:0">${list.map(m => `<div class="msg ${S.bz === 'in' && !m.leido ? 'unread' : ''}" data-act="abrirMsg" data-id="${m.id}"><div>${esc(m.asunto)}</div><div class="muted">${S.bz === 'in' ? 'De ' + esc(nm(U(m.de))) : 'Para ' + esc(m.etiqueta)} · ${fmtDT(m.fecha)}</div></div>`).join('') || empty('No hay mensajes.')}</div>`;
}

/* ---------- solvencia, reportes, diseño, permisos, ajustes ---------- */
function solvTable() {
  const q = S.q.toLowerCase();
  const als = DB.users.filter(u => u.role === 'alumno' && (!q || nm(u).toLowerCase().includes(q))).sort((a, b) => nm(a).localeCompare(nm(b)));
  return als.length ? tbl(['Alumno', 'Grado', 'Padre / madre', 'Estado', ''], als.map(a => `<tr><td>${esc(nm(a))}</td><td>${esc(G(a.gradoId)?.nombre)}</td><td>${esc(nm(U(a.padreId)))}</td><td>${a.solvente === false ? chip('Insolvente', 'bad') : chip('Solvente', 'ok')}</td><td>${ab('toggleSolv', a.solvente === false ? 'Marcar solvente' : 'Marcar insolvente', { id: a.id }, (a.solvente === false ? 'ok' : 'bad') + ' sm')}</td></tr>`)) : empty('No hay alumnos.');
}
const vSolvencia = () => head('Solvencia de alumnos') + `<p class="muted">Si un alumno está insolvente, sus padres no verán calificaciones ni tareas pendientes.</p><div class="inl"><div><label class="muted">Buscar</label><input data-search="sol" placeholder="Nombre" value="${esc(S.q)}"></div></div><div id="slist" class="card">${solvTable()}</div>`;
function vReportes() {
  const cnt = r => DB.users.filter(u => u.role === r).length;
  return head('Reportes') + `<div class="grid">${Object.entries(ROLES).map(([k, v]) => `<div class="card"><div class="muted">${v}s</div><h2 style="margin:4px 0">${cnt(k)}</h2></div>`).join('')}<div class="card"><div class="muted">Alumnos insolventes</div><h2 style="margin:4px 0">${DB.users.filter(u => u.role === 'alumno' && u.solvente === false).length}</h2></div></div>
<div class="card"><h3>Por curso</h3>${DB.cursos.length ? tbl(['Curso', 'Grado', 'Maestro', 'Alumnos', 'Asistencia', 'Promedio'], DB.cursos.map(c => { const als = alumnosDeCurso(c); const ps = als.map(a => promedio(a.id, c.id)).filter(x => x !== null), ss = als.map(a => asistPct(a.id, c.id)).filter(x => x !== null); const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 + '%' : '—'; return `<tr><td>${esc(c.nombre)}</td><td>${esc(G(c.gradoId)?.nombre)}</td><td>${esc(nm(U(c.maestroId)))}</td><td>${als.length}</td><td>${avg(ss)}</td><td>${avg(ps)}</td></tr>`; })) : empty('Sin cursos.')}</div>`;
}
function vPersonalizar() {
  const c = DB.config, ui = c.ui || {};
  const sel = (n, l, opts, cur) => `<div class="fld"><label>${l}</label><select name="${n}">${opts.map(([v, t]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`;
  return head('Diseño del colegio') + `<div class="card"><form data-form="tema"><h3>Identidad</h3><div class="grid2"><div class="fld"><label>Nombre del colegio</label><input name="colegio" value="${esc(c.nombre)}" required maxlength="80"></div><div class="fld"><label>Logo (PNG, JPG…)</label><input type="file" name="logo" accept="image/png,image/jpeg,image/webp,image/gif"></div></div>${c.logo ? `<label class="chk"><input type="checkbox" name="quitar"> Quitar logo actual</label><br>` : ''}
<div class="fld" style="margin-top:10px"><label>Ícono de la app instalada (opcional)</label><input type="file" name="appicon" accept="image/png,image/jpeg,image/webp"><small>Es el ícono que aparece en la pantalla del teléfono al instalar <b>Mentoris</b>. Usa una imagen cuadrada (ideal 512×512). Puede ser distinta al logo del colegio.</small></div>${c.appIconV ? `<label class="chk"><input type="checkbox" name="quitaricon"> Volver al ícono predeterminado de Mentoris</label><br>` : ''}
<h3 style="margin-top:14px">Colores</h3><div class="presets">${PRESETS.map(p => `<button type="button" class="preset" data-act="preset" data-p="${p.p}" data-a="${p.a}" data-bg="${p.bg}"><i style="background:${p.p}"></i><i style="background:${p.a}"></i>${p.n}</button>`).join('')}</div>
<div class="inl"><div><label class="muted">Menú</label><input type="color" name="cp" value="${c.colors.p}"></div><div><label class="muted">Acento (botones)</label><input type="color" name="ca" value="${c.colors.a}"></div><div><label class="muted">Fondo</label><input type="color" name="cb" value="${c.colors.bg}"></div></div>
<h3>Estilo</h3><div class="grid2">${sel('font', 'Tipo de letra', [['moderna', 'Moderna'], ['redondeada', 'Redondeada'], ['clasica', 'Clásica'], ['compacta', 'Compacta']], ui.font || 'moderna')}${sel('radius', 'Bordes', [['recto', 'Rectos'], ['suave', 'Suaves'], ['redondo', 'Muy redondeados']], ui.radius || 'suave')}${sel('dens', 'Espaciado', [['compacta', 'Compacto'], ['normal', 'Normal'], ['amplia', 'Amplio']], ui.dens || 'normal')}${sel('side', 'Menú lateral', [['oscuro', 'Color sólido'], ['color', 'Degradado'], ['claro', 'Claro']], ui.side || 'oscuro')}</div>
<p class="muted">Los cambios se ven al instante. Pulsa guardar para aplicarlos a todos los usuarios.</p><div class="err"></div><div class="row"><button class="btn">Guardar diseño</button>${ab('resetTema', 'Restaurar valores', {}, 'ghost')}</div></form></div>
<div class="card"><h3>Respaldo de datos</h3><p class="muted">Descarga una copia de los datos (los archivos quedan guardados en la nube) o restaura una anterior. El servidor además guarda una copia automática cada día.</p><div class="row">${ab('exportar', '⬇ Exportar respaldo', {}, 'ghost')}<label class="btn ghost" style="cursor:pointer">⬆ Importar respaldo<input id="impFile" type="file" accept="application/json" hidden></label>${me().role === 'admin' ? ab('demo', 'Cargar datos de ejemplo', {}, 'ghost') : ''}</div></div>`;
}
function vPermisos() {
  const roles = ['director', 'secretaria', 'maestro', 'alumno', 'padre'];
  return head('Permisos por rol', ab('savePerms', 'Guardar permisos')) + `<p class="muted">El administrador siempre tiene todos los permisos. Las acciones propias de cada rol (entregar tareas, ver sus cursos, etc.) no dependen de esta tabla.</p><div class="card tw"><table class="tbl perm"><thead><tr><th>Permiso</th><th class="c">Admin</th>${roles.map(r => `<th class="c">${ROLES[r]}</th>`).join('')}</tr></thead><tbody>${Object.entries(PERMS).map(([p, l]) => `<tr><td>${l}</td><td class="c"><input type="checkbox" checked disabled></td>${roles.map(r => `<td class="c"><input type="checkbox" data-perm="${r}:${p}" ${(DB.perms[r] || []).includes(p) ? 'checked' : ''}></td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function vAjustes() {
  const u = me();
  const nsup = 'Notification' in window;
  return head('Ajustes') + `<div class="card"><h3>Mi cuenta</h3><p>${esc(nm(u))}<br><span class="muted">Usuario: ${esc(u.username)} · ${ROLES[u.role]}</span></p></div>
<div class="card"><h3>Cambiar contraseña</h3><form data-form="pw" style="max-width:380px"><div class="fld"><label>Contraseña actual</label><input type="password" name="act" required autocomplete="current-password"></div><div class="fld"><label>Nueva contraseña</label><input type="password" name="nueva" required autocomplete="new-password"></div><div class="fld"><label>Repetir nueva</label><input type="password" name="conf" required autocomplete="new-password"></div><div class="err"></div><button class="btn">Guardar</button></form></div>
<div class="card"><h3>Apariencia en este dispositivo</h3><p class="muted">Modo actual: ${{ auto: 'automático (según tu teléfono)', claro: 'claro', oscuro: 'oscuro' }[modo()]}</p>${ab('modo', '🌓 Cambiar modo claro / oscuro', {}, 'ghost')}</div>
<div class="card"><h3>Notificaciones y app</h3><p class="muted">Estado de notificaciones: ${nsup ? Notification.permission === 'granted' ? 'activadas' : Notification.permission === 'denied' ? 'bloqueadas en el navegador' : 'desactivadas' : 'no compatibles con este navegador'}</p><div class="row">${nsup && Notification.permission !== 'granted' ? ab('activarNotif', '🔔 Activar notificaciones') : ''}${nsup && Notification.permission === 'granted' ? ab('probarNotif', 'Enviar notificación de prueba', {}, 'ghost') : ''}${deferredInstall ? ab('instalar', '⬇ Instalar app') : '<span class="muted">Para instalar la app usa el menú del navegador (“Instalar” o “Agregar a pantalla de inicio”).</span>'}</div></div>`;
}
const V = { examenes: vExamenes, examen: vExamen, examen_edit: vExamenEdit, examen_res: vExamenRes, inicio: vInicio, usuarios: vUsuarios, grados: vGrados, grado: vGrado, cursos: vCursos, curso: vCurso, tareas: vTareas, tarea: vTarea, calificar: vCalificar, notas: vNotas, horario: vHorario, asistencia: vAsistencia, hijos: vHijos, anuncios: vAnuncios, buzon: vBuzon, solvencia: vSolvencia, reportes: vReportes, personalizar: vPersonalizar, permisos: vPermisos, ajustes: vAjustes };

/* =====================================================================
   Editar / eliminar
   ===================================================================== */
const EDIT = {
  usuario: id => { const t = U(id); if (t && canTouch(t)) formUsuario(t); },
  grado: id => can('grados') && formGrado(G(id)),
  curso: id => can('cursos') && formCurso(C(id)),
  modulo: id => { const m = DB.modulos.find(x => x.id === id); m && can('modulos') && formModulo(m.cursoId, m); },
  tarea: id => { const t = T(id); t && can('tareas') && formTarea(t.cursoId, t); },
  anuncio: id => { const a = DB.anuncios.find(x => x.id === id); if (a && (a.autor === me().id || me().role === 'admin')) formAnuncio(a); },
  entrega: id => { const e = DB.entregas.find(x => x.id === id); e && e.alumnoId === me().id && formEntrega(T(e.tareaId), e); },
  mensaje: id => { const m = DB.mensajes.find(x => x.id === id); m && m.de === me().id && formMensaje(m); }
};
const quitar = (arr, fn) => { for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) arr.splice(i, 1); };
function delCurso(id) {
  DB.tareas.filter(t => t.cursoId === id).forEach(t => quitar(DB.entregas, e => e.tareaId === t.id));
  DB.examenes.filter(x => x.cursoId === id).forEach(x => quitar(DB.intentos, i => i.examenId === x.id)); quitar(DB.examenes, x => x.cursoId === id);
  quitar(DB.tareas, t => t.cursoId === id); quitar(DB.modulos, m => m.cursoId === id);
  quitar(DB.asistencia, r => r.cursoId === id); quitar(DB.anuncios, a => a.alcance === 'curso' && a.target === id);
  quitar(DB.cursos, c => c.id === id);
}
const DEL = {
  usuario: id => {
    const t = U(id); if (!t || !canTouch(t)) return;
    if (t.id === me().id) return alert('No puedes eliminar tu propio usuario.');
    if (t.role === 'admin' && DB.users.filter(u => u.role === 'admin').length < 2) return alert('Debe existir al menos un administrador.');
    if (!confirm(`¿Eliminar a ${nm(t)}? Se borrarán también sus entregas, asistencias y mensajes.`)) return;
    quitar(DB.entregas, e => e.alumnoId === id); quitar(DB.intentos, i => i.alumnoId === id); quitar(DB.examenes, x => x.autor === id); DB.asistencia.forEach(r => delete r.reg[id]);
    DB.cursos.forEach(c => { if (c.maestroId === id) c.maestroId = null; }); DB.users.forEach(u => { if (u.padreId === id) u.padreId = null; });
    quitar(DB.mensajes, m => m.de === id || m.para === id); quitar(DB.notifs, n => n.uid === id); quitar(DB.anuncios, a => a.autor === id);
    quitar(DB.users, u => u.id === id); save(); render();
  },
  grado: id => {
    if (!can('grados')) return;
    if (alumnosDeGrado(id).length || DB.cursos.some(c => c.gradoId === id)) return alert('Este grado tiene alumnos o cursos. Muévelos o elimínalos primero.');
    if (!confirm('¿Eliminar este grado?')) return;
    quitar(DB.anuncios, a => a.alcance === 'grado' && a.target === id); quitar(DB.grados, g => g.id === id); save(); render();
  },
  curso: id => { if (can('cursos') && confirm('¿Eliminar el curso? Se borrarán sus tareas, módulos, asistencia y anuncios.')) { delCurso(id); save(); render(); } },
  modulo: id => { if (can('modulos') && confirm('¿Eliminar este módulo?')) { quitar(DB.modulos, m => m.id === id); save(); render(); } },
  tarea: id => { if (can('tareas') && confirm('¿Eliminar la tarea y todas sus entregas?')) { quitar(DB.entregas, e => e.tareaId === id); quitar(DB.tareas, t => t.id === id); save(); render(); } },
  anuncio: id => { const a = DB.anuncios.find(x => x.id === id); if (a && (a.autor === me().id || me().role === 'admin') && confirm('¿Eliminar este anuncio?')) { quitar(DB.anuncios, x => x.id === id); save(); render(); } },
  entrega: id => { const e = DB.entregas.find(x => x.id === id); if (e && e.alumnoId === me().id && !tieneNota(e) && confirm('¿Eliminar tu entrega?')) { quitar(DB.entregas, x => x.id === id); save(); render(); } },
  mensaje: id => { const m = DB.mensajes.find(x => x.id === id); if (m && m.de === me().id && confirm('¿Eliminar este mensaje para todos los destinatarios?')) { quitar(DB.mensajes, x => x.batch === m.batch); S.msg = null; save(); render(); } }
};

/* =====================================================================
   Acciones y eventos
   ===================================================================== */
const A = {
  menu: () => { S.menu = !S.menu; render(); },
  modo: () => { const o = ['auto', 'claro', 'oscuro'], n = o[(o.indexOf(modo()) + 1) % 3]; try { localStorage.setItem('modo', n); } catch (e) { } toast('Apariencia: ' + { auto: 'automática', claro: 'clara', oscuro: 'oscura' }[n]); render(); },
  preset: (d, el) => { const f = el.closest('form'); f.elements.cp.value = d.p; f.elements.ca.value = d.a; f.elements.cb.value = d.bg; previewTheme(f); },
  go: d => go(d.view, d.id || null),
  back: d => volver(d),
  histback: () => { if (NAVI > 0) history.back(); else go('inicio'); },
  reload: () => location.reload(),
  legacy: async () => {
    if (!LEGACY || !confirm('Se copiarán a Mentoris los datos de la versión anterior guardados en este navegador. ¿Continuar?')) return;
    try {
      toast('Importando… puede tardar si hay muchos archivos');
      await api('/api/import-legacy', { raw: JSON.stringify(LEGACY), headers: { 'Content-Type': 'application/json' } });
      NEED_SETUP = false; LEGACY = null; render(); toast('Datos importados. Ingresa con tu usuario de siempre.');
    } catch (e) { alert(e.message); }
  },
  logout: () => logout(),
  bell: () => { S.bell = !S.bell; render(); },
  readAll: () => { misNotifs().forEach(n => n.leido = true); save(); render(); },
  notif: d => { const n = DB.notifs.find(x => x.id === d.id); if (n) { n.leido = true; save(); go(n.view && accesoVista(n.view, me()) ? n.view : 'inicio'); } },
  instalar: async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; render(); },
  activarNotif: async () => { const r = await Notification.requestPermission(); toast(r === 'granted' ? 'Notificaciones activadas' : 'Permiso no concedido'); flushSystemNotifs(); render(); },
  probarNotif: () => showSys({ id: newId(), title: DB.config.nombre, body: 'Las notificaciones funcionan correctamente.' }),
  nuevoUsuario: () => formUsuario(null),
  resetpw: async d => {
    const t = U(d.id); if (!t || !canTouch(t) || !confirm(`¿Restablecer la contraseña de ${nm(t)}? Quedará igual a su usuario y deberá cambiarla al ingresar.`)) return;
    t.salt = newId() + newId(); t.hash = await hash(t.username, t.salt); t.mustChange = true; save(); showCreds([t]);
  },
  toggleActivo: d => { const t = U(d.id); if (!t || !canTouch(t)) return; if (t.id === me().id) return alert('No puedes desactivarte a ti mismo.'); t.activo = t.activo === false; save(); render(); },
  toggleSolv: d => { const a = U(d.id); if (!a || !can('solvencia')) return; a.solvente = a.solvente === false; if (a.padreId) notify(a.padreId, 'Estado de solvencia', `${nm(a)}: ${a.solvente ? 'solvente' : 'insolvente'}`, 'hijos'); save(); const l = $('#slist'); if (l) l.innerHTML = solvTable(); else render(); },
  nuevoGrado: () => formGrado(null),
  nuevoCurso: () => formCurso(null),
  nuevoModulo: d => formModulo(d.id, null),
  nuevaTarea: d => formTarea(d.id || null, null),
  nuevoAnuncio: d => formAnuncio(null, d.curso),
  edit: d => EDIT[d.kind] && EDIT[d.kind](d.id),
  del: d => DEL[d.kind] && DEL[d.kind](d.id),
  entregar: d => { const t = T(d.id); if (t) formEntrega(t, entregaDe(t.id, me().id)); },
  calificarAl: d => { const e = DB.entregas.find(x => x.id === d.id); if (e) formNota(e); },
  guardarAsistencia: () => {
    if (!can('asistencia')) return;
    const c = C(S.attC); if (!c) return;
    let rec = DB.asistencia.find(r => r.cursoId === c.id && r.fecha === S.attF);
    if (!rec) { rec = { id: newId(), cursoId: c.id, fecha: S.attF, reg: {} }; DB.asistencia.push(rec); }
    alumnosDeCurso(c).forEach(a => {
      const r = $(`input[name="st_${a.id}"]:checked`); if (!r) return;
      const prev = rec.reg[a.id]; rec.reg[a.id] = r.value;
      if (r.value === 'A' && prev !== 'A' && a.padreId) notify(a.padreId, 'Inasistencia', `${nm(a)} faltó a ${c.nombre} el ${fmtDate(S.attF)}`, 'asistencia');
    });
    save(); render(); toast('Asistencia guardada');
  },
  delAsist: d => { if (confirm('¿Eliminar el registro de asistencia de este día?')) { quitar(DB.asistencia, r => r.id === d.id); save(); render(); } },
  bzTab: d => { S.bz = d.t; S.msg = null; render(); },
  abrirMsg: d => { S.msg = d.id; render(); },
  cerrarMsg: () => { S.msg = null; render(); },
  redactar: () => formMensaje(null),
  responder: d => { const m = DB.mensajes.find(x => x.id === d.id); if (m) formMensaje(null, { tipo: 'persona', personaId: m.de, asunto: 'Re: ' + m.asunto.replace(/^Re: /, '') }); },
  delMsgIn: d => { const m = DB.mensajes.find(x => x.id === d.id); if (m && m.para === me().id && confirm('¿Eliminar este mensaje de tu buzón?')) { m.delPara = true; S.msg = null; save(); render(); } },
  resetTema: () => { DB.config.colors = { p: '#1e3a52', a: '#2f80ed', bg: '#f4f6fb' }; DB.config.ui = { font: 'moderna', radius: 'suave', dens: 'normal', side: 'oscuro' }; save(); applyTheme(); render(); },
  savePerms: () => {
    if (!can('permisos')) return;
    const np = { alumno: [], padre: [], director: [], secretaria: [], maestro: [] };
    $$('[data-perm]').forEach(i => { if (i.checked) { const [r, p] = i.dataset.perm.split(':'); np[r].push(p); } });
    DB.perms = np; save(); render(); toast('Permisos guardados');
  },
  exportar: () => { const a = document.createElement('a'); a.href = '/api/export'; a.download = `respaldo-${todayStr()}.json`; document.body.appendChild(a); a.click(); a.remove(); },
  demo: async () => {
    if (me().role !== 'admin' || !confirm('Se agregarán grados, cursos y usuarios de ejemplo. ¿Continuar?')) return;
    const g1 = { id: newId(), nombre: '1ro Primaria', inicio: '07:00', fin: '13:00', recreos: [{ i: '09:30', f: '10:00' }] };
    const g2 = { id: newId(), nombre: '2do Primaria', inicio: '07:00', fin: '13:00', recreos: [{ i: '09:30', f: '10:00' }] };
    DB.grados.push(g1, g2);
    const mk = (nombre, g, dias, i, f) => ({ id: newId(), nombre, gradoId: g.id, horarios: dias.map(d => ({ dia: d, inicio: i, fin: f })), maestroId: null, descripcion: '' });
    const cs = [mk('Matemáticas', g1, ['Lunes', 'Miércoles', 'Viernes'], '07:00', '08:00'), mk('Lenguaje', g1, ['Martes', 'Jueves'], '07:00', '08:00'), mk('Ciencias', g1, ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'], '08:00', '09:00'), mk('Matemáticas', g2, ['Lunes', 'Miércoles', 'Viernes'], '07:00', '08:00')];
    DB.cursos.push(...cs);
    const mae = await nuevoUser({ nombre1: 'Ana', nombre2: 'Lucía', apellido1: 'Pérez', apellido2: 'Gómez', direccion: 'Ciudad', telefono: '5555-0001', nacimiento: '1988-04-12', role: 'maestro' });
    asignarMaestro(mae, [g1.id], []);
    const pad = await nuevoUser({ nombre1: 'Marta', nombre2: '', apellido1: 'Ruiz', apellido2: 'Díaz', direccion: 'Ciudad', telefono: '5555-0002', nacimiento: '1985-02-02', role: 'padre' });
    const alu = await nuevoUser({ nombre1: 'Carlos', nombre2: 'Andrés', apellido1: 'López', apellido2: 'Ruiz', direccion: 'Ciudad', telefono: '5555-0002', nacimiento: '2018-09-09', role: 'alumno', gradoId: g1.id, padreId: pad.id });
    save(); render(); showCreds([mae, pad, alu]);
  }
};
/* =====================================================================
   Exámenes
   ===================================================================== */
const EX = id => DB.examenes.find(x => x.id === id);
const intentoDe = (eid, aid) => DB.intentos.find(i => i.examenId === eid && i.alumnoId === aid);
const exTotal = x => x.preguntas.reduce((s, q) => s + (+q.puntos || 0), 0);
const exDeadline = (x, it) => Math.min(it.inicio + x.minutos * 60000, new Date(x.cierra).getTime());
const exOpen = x => { const n = Date.now(); return n >= new Date(x.abre).getTime() && n <= new Date(x.cierra).getTime(); };
const miExamen = (x, u) => u.role === 'admin' || (u.role === 'maestro' && C(x.cursoId)?.maestroId === u.id);
const TIPOS_Q = { opcion: 'Opción múltiple', vf: 'Verdadero / Falso', abierta: 'Respuesta abierta' };

function estadoExamen(x, aid) {
  const it = intentoDe(x.id, aid);
  if (it) return it.estado === 'en_curso' ? ['En curso', 'warn'] : it.estado === 'calificado' ? ['Calificado', 'ok'] : ['Enviado', ''];
  const n = Date.now();
  if (n < new Date(x.abre).getTime()) return ['Próximo', ''];
  if (n > new Date(x.cierra).getTime()) return ['No realizado', 'bad'];
  return ['Disponible', 'ok'];
}
function calificarAuto(x, it) {
  let auto = 0, pend = false;
  it.manual = it.manual || {};
  x.preguntas.forEach(q => {
    const r = it.respuestas[q.id];
    if (q.tipo === 'abierta') { if (it.manual[q.id] === undefined) pend = true; }
    else if (q.tipo === 'opcion') { if (r !== undefined && r !== '' && +r === +q.correcta) auto += +q.puntos; }
    else if (r !== undefined && String(r) === String(q.correcta)) auto += +q.puntos;
  });
  const man = Object.values(it.manual).reduce((s, v) => s + (+v || 0), 0);
  it.nota = Math.round((auto + man) * 100) / 100;
  it.estado = pend ? 'enviado' : 'calificado';
}
function finalizar(it) {
  const x = EX(it.examenId); if (!x || it.estado !== 'en_curso') return;
  it.fin = Date.now(); calificarAuto(x, it);
  const c = C(x.cursoId);
  if (it.estado === 'enviado' && c?.maestroId) notify(c.maestroId, 'Examen por revisar', `${nm(U(it.alumnoId))} — ${x.titulo}`, 'examenes');
  save();
}

/* ---------- listas ---------- */
function vExamenes() {
  const u = me();
  if (u.role === 'alumno') {
    const xs = DB.examenes.filter(x => cursosDe(u).some(c => c.id === x.cursoId)).sort((a, b) => new Date(b.abre) - new Date(a.abre));
    return head('Mis exámenes') + (xs.length ? `<div class="card">${tbl(['Examen', 'Curso', 'Disponible', 'Duración', 'Estado', 'Nota', ''], xs.map(x => { const it = intentoDe(x.id, u.id); return `<tr><td>${esc(x.titulo)}</td><td>${esc(C(x.cursoId)?.nombre)}</td><td>${fmtDT(x.abre)}<br><span class="muted">hasta ${fmtDT(x.cierra)}</span></td><td>${x.minutos} min</td><td>${chip(...estadoExamen(x, u.id))}</td><td>${it && it.estado !== 'en_curso' ? it.nota + ' / ' + exTotal(x) : '—'}</td><td>${ab('go', 'Abrir', { view: 'examen', id: x.id }, 'sm')}</td></tr>`; }))}</div>` : empty('No tienes exámenes por ahora.'));
  }
  const xs = DB.examenes.filter(x => miExamen(x, u)).sort((a, b) => new Date(b.abre) - new Date(a.abre));
  return head('Exámenes', can('examenes') ? ab('exNuevo', '＋ Nuevo examen') : '') + (xs.length ? `<div class="card">${tbl(['Examen', 'Curso', 'Disponible', 'Preguntas', 'Realizados', ''], xs.map(x => { const tot = alumnosDeCurso(C(x.cursoId)).length, n = DB.intentos.filter(i => i.examenId === x.id && i.estado !== 'en_curso').length; return `<tr><td>${esc(x.titulo)}</td><td>${esc(C(x.cursoId)?.nombre)}</td><td>${fmtDT(x.abre)}<br><span class="muted">hasta ${fmtDT(x.cierra)}</span></td><td>${x.preguntas.length} (${exTotal(x)} pts)</td><td>${n} / ${tot}</td><td>${ab('go', 'Resultados', { view: 'examen_res', id: x.id }, 'sm')} ${eb('examen', x.id)}</td></tr>`; }))}</div>` : empty('Aún no has creado exámenes.'));
}

/* ---------- editor (maestro) ---------- */
const newQ = (tipo = 'opcion') => ({ id: newId(), tipo, texto: '', opciones: tipo === 'opcion' ? ['', ''] : [], correcta: tipo === 'opcion' ? 0 : tipo === 'vf' ? 'v' : null, puntos: 10 });
const exDraftNew = cursoId => ({ id: null, cursoId: cursoId || '', titulo: '', descripcion: '', abre: nowLocal(), cierra: '', minutos: 30, mostrar: true, preguntas: [newQ()] });
const exLocked = d => !!d.id && DB.intentos.some(i => i.examenId === d.id);

function syncEx() {
  const d = S.ex, f = $('#exform');
  if (!d || !f) return;
  d.cursoId = f.elements.cursoId.value; d.titulo = f.elements.titulo.value; d.descripcion = f.elements.descripcion.value;
  d.abre = f.elements.abre.value; d.cierra = f.elements.cierra.value; d.minutos = f.elements.minutos.value; d.mostrar = f.elements.mostrar.checked;
  d.preguntas.forEach((q, i) => {
    const box = $(`[data-qbox="${i}"]`, f); if (!box) return;
    q.texto = $('[data-qf=texto]', box).value; q.puntos = $('[data-qf=puntos]', box).value;
    if (q.tipo === 'opcion') { q.opciones = $$('[data-qo]', box).map(x => x.value); const c = $(`input[name="qc${i}"]:checked`, box); q.correcta = c ? +c.value : 0; }
    if (q.tipo === 'vf') { const c = $(`input[name="qc${i}"]:checked`, box); q.correcta = c ? c.value : 'v'; }
  });
}
function vExamenEdit() {
  const d = S.ex, u = me();
  if (!d) return empty('Abre un examen desde la lista.');
  const cs = cursosDe(u), lock = exLocked(d);
  return head(d.id ? 'Editar examen' : 'Nuevo examen', back('examenes')) + `${lock ? `<div class="banner warn">Ya hay alumnos que lo realizaron: puedes cambiar fechas, título y duración, pero no las preguntas. Para cambiarlas elimina los intentos o crea otro examen.</div><br>` : ''}
<form id="exform">
<div class="card"><div class="grid2">
<div class="fld"><label>Curso</label><select name="cursoId" required><option value="">— Selecciona —</option>${cs.map(c => `<option value="${c.id}" ${c.id === d.cursoId ? 'selected' : ''}>${esc(cursoLabel(c))}</option>`).join('')}</select></div>
<div class="fld"><label>Título</label><input name="titulo" value="${esc(d.titulo)}" required maxlength="120"></div>
<div class="fld"><label>Disponible desde</label><input type="datetime-local" name="abre" value="${esc(d.abre)}" required></div>
<div class="fld"><label>Se cierra el</label><input type="datetime-local" name="cierra" value="${esc(d.cierra)}" required></div>
<div class="fld"><label>Duración (minutos)</label><input type="number" name="minutos" min="1" max="300" value="${esc(d.minutos)}" required></div>
<div class="fld"><label>&nbsp;</label><label class="chk"><input type="checkbox" name="mostrar" ${d.mostrar ? 'checked' : ''}> Mostrar respuestas correctas al terminar</label></div>
</div><div class="fld"><label>Instrucciones</label><textarea name="descripcion" rows="3">${esc(d.descripcion)}</textarea></div></div>
${d.preguntas.map((q, i) => qEditor(q, i, lock)).join('')}
${lock ? '' : `<div class="row">${ab('exAddQ', '＋ Opción múltiple', { t: 'opcion' }, 'ghost')}${ab('exAddQ', '＋ Verdadero / Falso', { t: 'vf' }, 'ghost')}${ab('exAddQ', '＋ Respuesta abierta', { t: 'abierta' }, 'ghost')}</div>`}
<div class="err" id="exerr"></div>
<div class="row end sticky-actions"><span class="muted">Total: ${d.preguntas.reduce((s, q) => s + (+q.puntos || 0), 0)} puntos</span>${ab('exSave', 'Guardar examen')}</div></form>`;
}
function qEditor(q, i, lock) {
  const dis = lock ? 'disabled' : '';
  let body = '';
  if (q.tipo === 'opcion') {
    body = `<div class="fld"><label>Opciones (marca la correcta)</label>${q.opciones.map((o, j) => `<div class="row nowrap"><input type="radio" name="qc${i}" value="${j}" ${+q.correcta === j ? 'checked' : ''} ${dis}><input data-qo value="${esc(o)}" placeholder="Opción ${j + 1}" ${dis} maxlength="200">${!lock && q.opciones.length > 2 ? `<button type="button" class="ibtn" data-act="exDelOpt" data-q="${i}" data-o="${j}" title="Quitar">✕</button>` : ''}</div>`).join('')}${!lock && q.opciones.length < 6 ? ab('exAddOpt', '＋ Agregar opción', { q: i }, 'ghost sm') : ''}</div>`;
  } else if (q.tipo === 'vf') {
    body = `<div class="fld"><label>Respuesta correcta</label><div class="row"><label class="chk"><input type="radio" name="qc${i}" value="v" ${q.correcta === 'v' ? 'checked' : ''} ${dis}> Verdadero</label><label class="chk"><input type="radio" name="qc${i}" value="f" ${q.correcta === 'f' ? 'checked' : ''} ${dis}> Falso</label></div></div>`;
  } else body = `<p class="muted">Esta pregunta la calificas tú manualmente después de que el alumno envíe.</p>`;
  return `<div class="card qbox" data-qbox="${i}"><div class="row" style="justify-content:space-between"><b>Pregunta ${i + 1}</b><span class="row"><select data-qf="tipo" data-q="${i}" ${dis}>${Object.entries(TIPOS_Q).map(([k, l]) => `<option value="${k}" ${q.tipo === k ? 'selected' : ''}>${l}</option>`).join('')}</select><input data-qf="puntos" type="number" min="1" max="1000" value="${esc(q.puntos)}" style="width:80px" title="Puntos" ${dis}> pts${!lock && S.ex.preguntas.length > 1 ? `<button type="button" class="ibtn" data-act="exDelQ" data-q="${i}" title="Eliminar pregunta">🗑️</button>` : ''}</span></div><div class="fld"><textarea data-qf="texto" rows="2" placeholder="Escribe la pregunta" ${dis}>${esc(q.texto)}</textarea></div>${body}</div>`;
}
function exGuardar() {
  syncEx();
  const d = S.ex, u = me(), err = $('#exerr');
  const fail = m => { err.textContent = m; err.scrollIntoView({ block: 'center' }); };
  err.textContent = '';
  if (!can('examenes')) return fail('No tienes permiso.');
  const c = C(d.cursoId);
  if (!c || !cursosDe(u).some(x => x.id === c.id)) return fail('Selecciona uno de tus cursos.');
  if (!d.titulo.trim()) return fail('Escribe el título.');
  if (!d.abre || !d.cierra || new Date(d.cierra) <= new Date(d.abre)) return fail('La fecha de cierre debe ser posterior a la de apertura.');
  const mins = parseInt(d.minutos, 10);
  if (!(mins >= 1 && mins <= 300)) return fail('La duración debe estar entre 1 y 300 minutos.');
  for (const [i, q] of d.preguntas.entries()) {
    if (!q.texto.trim()) return fail(`Escribe el texto de la pregunta ${i + 1}.`);
    if (!(+q.puntos > 0)) return fail(`La pregunta ${i + 1} necesita puntos mayores a 0.`);
    if (q.tipo === 'opcion') {
      if (q.opciones.length < 2 || q.opciones.some(o => !o.trim())) return fail(`Completa todas las opciones de la pregunta ${i + 1}.`);
      if (new Set(q.opciones.map(o => o.trim().toLowerCase())).size !== q.opciones.length) return fail(`La pregunta ${i + 1} tiene opciones repetidas.`);
    }
  }
  const lock = exLocked(d);
  const x = d.id ? EX(d.id) : { id: newId(), autor: u.id, creado: Date.now() };
  Object.assign(x, { cursoId: c.id, titulo: d.titulo.trim(), descripcion: d.descripcion.trim(), abre: d.abre, cierra: d.cierra, minutos: mins, mostrar: !!d.mostrar });
  if (!lock) x.preguntas = d.preguntas.map(q => ({ id: q.id, tipo: q.tipo, texto: q.texto.trim(), opciones: q.tipo === 'opcion' ? q.opciones.map(o => o.trim()) : [], correcta: q.correcta, puntos: +q.puntos }));
  if (!d.id) { DB.examenes.push(x); alumnosDeCurso(c).forEach(a => notify(a.id, 'Nuevo examen: ' + x.titulo, `${c.nombre} · desde ${fmtDT(x.abre)}`, 'examenes')); }
  S.ex = null; save(); go('examenes'); toast('Examen guardado');
}

/* ---------- alumno: realizar examen ---------- */
function vExamen() {
  const u = me(), x = EX(S.id);
  if (!x || !cursosDe(u).some(c => c.id === x.cursoId)) return empty('Examen no disponible.');
  const it = intentoDe(x.id, u.id);
  if (it && it.estado === 'en_curso' && Date.now() >= exDeadline(x, it)) finalizar(it);
  const it2 = intentoDe(x.id, u.id);
  if (it2 && it2.estado === 'en_curso') {
    const end = exDeadline(x, it2);
    return head(esc(x.titulo)) + `<div class="card timerbar"><span>⏱ Tiempo restante: <b id="timer" data-end="${end}" data-it="${it2.id}">--:--</b></span><span class="muted">Tus respuestas se guardan automáticamente</span></div>
<form>${x.preguntas.map((q, i) => `<div class="card"><b>${i + 1}. ${esc(q.texto)}</b> <span class="muted">(${q.puntos} pts)</span><div class="opts">${q.tipo === 'abierta' ? `<textarea data-ans="${q.id}" rows="4" placeholder="Tu respuesta">${esc(it2.respuestas[q.id] || '')}</textarea>` : (q.tipo === 'vf' ? [['v', 'Verdadero'], ['f', 'Falso']] : q.opciones.map((o, j) => [String(j), o])).map(([v, l]) => `<label class="opt"><input type="radio" name="a_${q.id}" data-ans="${q.id}" value="${v}" ${String(it2.respuestas[q.id]) === v ? 'checked' : ''}> <span>${esc(l)}</span></label>`).join('')}</div></div>`).join('')}<div class="row end">${ab('exEnviar', 'Enviar examen', { id: it2.id })}</div></form>`;
  }
  if (it2) {
    const parcial = it2.estado === 'enviado';
    return head(esc(x.titulo), back('examenes')) + `<div class="card"><h3>Resultado</h3><p style="font-size:28px;margin:6px 0"><b>${it2.nota} / ${exTotal(x)}</b></p>${parcial ? `<p class="muted">Hay preguntas abiertas pendientes de revisión: esta nota es parcial.</p>` : ''}<p class="muted">Enviado: ${fmtDT(it2.fin)}</p></div>${x.mostrar ? x.preguntas.map((q, i) => revisionQ(q, i, it2)).join('') : ''}`;
  }
  const n = Date.now(), abre = new Date(x.abre).getTime(), cierra = new Date(x.cierra).getTime();
  return head(esc(x.titulo), back('examenes')) + `<div class="card"><p class="muted">${esc(C(x.cursoId)?.nombre)}</p><p>${nl(x.descripcion) || ''}</p><p><b>${x.preguntas.length}</b> preguntas · <b>${exTotal(x)}</b> puntos · <b>${x.minutos}</b> minutos</p><p class="muted">Disponible: ${fmtDT(x.abre)} → ${fmtDT(x.cierra)}</p><p class="muted">Solo tienes un intento. Al empezar, el tiempo corre aunque cierres la página.</p>${n < abre ? chip('Aún no está disponible', 'warn') : n > cierra ? chip('El examen ya cerró', 'bad') : ab('exStart', 'Comenzar examen', { id: x.id })}</div>`;
}
function respTxt(q, v) {
  if (v === undefined || v === '') return '<i>Sin responder</i>';
  if (q.tipo === 'opcion') return esc(q.opciones[+v] ?? '—');
  if (q.tipo === 'vf') return v === 'v' ? 'Verdadero' : 'Falso';
  return nl(v);
}
function revisionQ(q, i, it) {
  const r = it.respuestas[q.id];
  let est = '';
  if (q.tipo === 'abierta') est = it.manual && it.manual[q.id] !== undefined ? chip(`${it.manual[q.id]} / ${q.puntos} pts`, 'ok') : chip('Pendiente', 'warn');
  else { const ok = q.tipo === 'opcion' ? (r !== undefined && r !== '' && +r === +q.correcta) : String(r) === String(q.correcta); est = chip(ok ? `Correcta (+${q.puntos})` : 'Incorrecta', ok ? 'ok' : 'bad'); }
  const corr = q.tipo === 'opcion' ? esc(q.opciones[+q.correcta]) : q.tipo === 'vf' ? (q.correcta === 'v' ? 'Verdadero' : 'Falso') : '';
  return `<div class="card"><b>${i + 1}. ${esc(q.texto)}</b> ${est}<p>Tu respuesta: ${respTxt(q, r)}</p>${corr ? `<p class="muted">Respuesta correcta: ${corr}</p>` : ''}</div>`;
}

/* ---------- maestro: resultados ---------- */
function vExamenRes() {
  const u = me(), x = EX(S.id);
  if (!x || !miExamen(x, u)) return empty('Examen no encontrado.');
  const c = C(x.cursoId), als = alumnosDeCurso(c).sort((a, b) => nm(a).localeCompare(nm(b)));
  const hechos = als.map(a => intentoDe(x.id, a.id)).filter(i => i && i.estado !== 'en_curso');
  const prom = hechos.length ? Math.round(hechos.reduce((s, i) => s + i.nota, 0) / hechos.length * 10) / 10 : null;
  return head('Resultados: ' + esc(x.titulo), back('examenes')) + `<div class="grid"><div class="card"><div class="muted">Realizaron</div><h2 style="margin:4px 0">${hechos.length} / ${als.length}</h2></div><div class="card"><div class="muted">Promedio</div><h2 style="margin:4px 0">${prom === null ? '—' : prom + ' / ' + exTotal(x)}</h2></div></div><div class="card">${als.length ? tbl(['Alumno', 'Estado', 'Nota', ''], als.map(a => { const it = intentoDe(x.id, a.id); return `<tr><td>${esc(nm(a))}</td><td>${chip(...estadoExamen(x, a.id))}</td><td>${it && it.estado !== 'en_curso' ? it.nota + ' / ' + exTotal(x) : '—'}</td><td>${it && it.estado !== 'en_curso' ? ab('exRevisar', it.estado === 'enviado' ? 'Revisar' : 'Ver', { id: it.id }, 'sm') + ` <button class="ibtn" data-act="exDelIntento" data-id="${it.id}" title="Eliminar intento (permite repetirlo)">🗑️</button>` : ''}</td></tr>`; })) : empty('No hay alumnos en este curso.')}</div>`;
}
function formRevision(it) {
  const x = EX(it.examenId), al = U(it.alumnoId);
  const abiertas = x.preguntas.filter(q => q.tipo === 'abierta');
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<form class="mbox"><h3>${esc(nm(al))}</h3><p class="intro">${esc(x.titulo)} · nota actual ${it.nota} / ${exTotal(x)}</p>${x.preguntas.map((q, i) => revisionQ(q, i, it)).join('')}${abiertas.length ? `<h4>Calificar preguntas abiertas</h4>${abiertas.map(q => `<div class="fld"><label>${esc(q.texto.slice(0, 90))} (0 – ${q.puntos})</label><input type="number" name="p_${q.id}" min="0" max="${q.puntos}" step="0.01" value="${it.manual && it.manual[q.id] !== undefined ? it.manual[q.id] : ''}" required></div>`).join('')}` : ''}<div class="err"></div><div class="row end"><button type="button" class="btn ghost" data-close>Cerrar</button>${abiertas.length ? '<button class="btn">Guardar calificación</button>' : ''}</div></form>`;
  document.body.appendChild(m);
  $('[data-close]', m).onclick = () => m.remove();
  $('form', m).onsubmit = e => {
    e.preventDefault();
    if (!can('examenes')) return;
    const f = e.target; it.manual = it.manual || {};
    for (const q of abiertas) {
      const v = parseFloat(f.elements['p_' + q.id].value);
      if (isNaN(v) || v < 0 || v > q.puntos) { $('.err', f).textContent = `Los puntos deben estar entre 0 y ${q.puntos}.`; return; }
      it.manual[q.id] = v;
    }
    calificarAuto(x, it);
    notify(al.id, 'Examen calificado: ' + x.titulo, `Nota ${it.nota} / ${exTotal(x)}`, 'examenes');
    save(); m.remove(); render();
  };
}

/* ---------- acciones y eventos de exámenes ---------- */
Object.assign(A, {
  exNuevoCurso: d => { S.ex = exDraftNew(d.id); go('examen_edit'); },
  exNuevo: () => { S.ex = exDraftNew(null); go('examen_edit'); },
  exAddQ: d => { syncEx(); S.ex.preguntas.push(newQ(d.t)); render(); },
  exDelQ: d => { syncEx(); if (S.ex.preguntas.length > 1 && confirm('¿Eliminar esta pregunta?')) { S.ex.preguntas.splice(+d.q, 1); render(); } },
  exAddOpt: d => { syncEx(); const q = S.ex.preguntas[+d.q]; if (q.opciones.length < 6) q.opciones.push(''); render(); },
  exDelOpt: d => { syncEx(); const q = S.ex.preguntas[+d.q]; q.opciones.splice(+d.o, 1); if (q.correcta >= q.opciones.length) q.correcta = 0; render(); },
  exSave: () => exGuardar(),
  exStart: d => {
    const u = me(), x = EX(d.id);
    if (!x || !exOpen(x) || intentoDe(x.id, u.id)) return toast('No puedes iniciar este examen.');
    if (!confirm(`Tienes ${x.minutos} minutos y un solo intento. ¿Comenzar ahora?`)) return;
    DB.intentos.push({ id: newId(), examenId: x.id, alumnoId: u.id, inicio: Date.now(), respuestas: {}, manual: {}, estado: 'en_curso' });
    save(); render();
  },
  exEnviar: d => {
    const it = DB.intentos.find(i => i.id === d.id);
    if (!it || it.alumnoId !== me().id || it.estado !== 'en_curso') return;
    const x = EX(it.examenId);
    const vacias = x.preguntas.filter(q => it.respuestas[q.id] === undefined || it.respuestas[q.id] === '').length;
    if (!confirm(vacias ? `Tienes ${vacias} pregunta(s) sin responder. ¿Enviar de todos modos?` : '¿Enviar el examen?')) return;
    finalizar(it); render();
  },
  exRevisar: d => { const it = DB.intentos.find(i => i.id === d.id); if (it && miExamen(EX(it.examenId), me())) formRevision(it); },
  exDelIntento: d => {
    const it = DB.intentos.find(i => i.id === d.id);
    if (it && miExamen(EX(it.examenId), me()) && confirm('¿Eliminar este intento? El alumno podrá volver a realizar el examen.')) { quitar(DB.intentos, i => i.id === d.id); save(); render(); }
  }
});
Object.assign(EDIT, {
  examen: id => { const x = EX(id); if (!x || !miExamen(x, me()) || !can('examenes')) return; S.ex = JSON.parse(JSON.stringify({ ...x, minutos: x.minutos })); go('examen_edit'); }
});
Object.assign(DEL, {
  examen: id => { const x = EX(id); if (x && miExamen(x, me()) && can('examenes') && confirm('¿Eliminar el examen y todos los intentos de los alumnos?')) { quitar(DB.intentos, i => i.examenId === id); quitar(DB.examenes, e => e.id === id); save(); render(); } }
});
document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset && el.dataset.ans && SESSION) {
    const u = me(); const it = DB.intentos.find(i => i.alumnoId === u.id && i.estado === 'en_curso' && EX(i.examenId)?.preguntas.some(q => q.id === el.dataset.ans));
    if (it && Date.now() < exDeadline(EX(it.examenId), it)) { it.respuestas[el.dataset.ans] = el.value; save(true); }
  }
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset && el.dataset.qf === 'tipo' && S.ex) {
    syncEx(); const q = S.ex.preguntas[+el.dataset.q]; const n = newQ(el.value);
    q.tipo = n.tipo; q.opciones = n.opciones; q.correcta = n.correcta; render();
  }
});
setInterval(() => {
  const t = $('#timer'); if (!t || !SESSION) return;
  const left = Math.max(0, Math.floor((+t.dataset.end - Date.now()) / 1000));
  t.textContent = `${pad(Math.floor(left / 60))}:${pad(left % 60)}`;
  t.classList.toggle('low', left < 60);
  if (left <= 0) { const it = DB.intentos.find(i => i.id === t.dataset.it); if (it) { finalizar(it); toast('Se acabó el tiempo: examen enviado'); render(); } }
}, 1000);

document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (S.bell && !e.target.closest('.npanel') && !t) { S.bell = false; render(); }
  if (!t) return;
  touch();
  const f = A[t.dataset.act]; if (f) f(t.dataset, t);
});
document.addEventListener('submit', e => { e.preventDefault(); const f = e.target.closest('form[data-form]'); if (f && FORMS[f.dataset.form]) FORMS[f.dataset.form](f); });
document.addEventListener('input', e => {
  touch();
  const s = e.target.dataset && e.target.dataset.search;
  if (s === 'users') { S.q = e.target.value; $('#ulist').innerHTML = usersTable(); }
  if (s === 'sol') { S.q = e.target.value; $('#slist').innerHTML = solvTable(); }
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset && el.dataset.filter === 'users') { S.rf = el.value; $('#ulist').innerHTML = usersTable(); }
  else if (el.dataset && el.dataset.filter === 'cursos') { S.rf = el.value; render(); }
  else if (el.dataset && el.dataset.sel) { S[el.dataset.sel] = el.value; render(); }
  else if (el.id === 'impSetup' && el.files[0]) {
    const file = el.files[0];
    file.text().then(async txt => {
      JSON.parse(txt); toast('Importando… puede tardar si hay muchos archivos');
      await api('/api/import-legacy', { raw: txt, headers: { 'Content-Type': 'application/json' } });
      NEED_SETUP = false; render(); toast('Respaldo importado. Ingresa con tu usuario de siempre.');
    }).catch(e => alert(e instanceof SyntaxError ? 'El archivo de respaldo no es válido.' : e.message)).finally(() => { el.value = ''; });
  }
  else if (el.id === 'impFile' && el.files[0]) {
    const file = el.files[0];
    if (!confirm('Esto reemplazará TODOS los datos actuales con el respaldo. ¿Continuar?')) { el.value = ''; return; }
    file.text().then(async txt => {
      const o = JSON.parse(txt);
      if (!o || !Array.isArray(o.users) || !o.config || !o.perms) throw new Error('Archivo inválido');
      toast('Restaurando respaldo…');
      await api('/api/import', { raw: txt, headers: { 'Content-Type': 'application/json' } });
      await logout('Respaldo restaurado. Ingresa de nuevo.');
    }).catch(e => alert(e instanceof SyntaxError || e.message === 'Archivo inválido' ? 'El archivo de respaldo no es válido.' : e.message)).finally(() => { el.value = ''; });
  }
});
['input', 'change'].forEach(ev => document.addEventListener(ev, e => { const f = e.target.form; if (f && f.dataset && f.dataset.form === 'tema' && e.target.type !== 'file' && e.target.name !== 'colegio') previewTheme(f); }));
let decT;
new MutationObserver(() => { cancelAnimationFrame(decT); decT = requestAnimationFrame(() => $$('table.tbl:not(.sched)').forEach(t => {
  if (!t.tHead || t.dataset.dec === String(t.tBodies[0]?.rows.length)) return;
  const hs = [...t.tHead.rows[0].cells].map(c => c.textContent.trim());
  [...(t.tBodies[0]?.rows || [])].forEach(r => [...r.cells].forEach((c, i) => { c.dataset.l = hs[i] || ''; }));
  t.dataset.dec = String(t.tBodies[0]?.rows.length);
})); }).observe(document.body, { childList: true, subtree: true });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; if (SESSION && !$('.modal')) render(); });
window.addEventListener('appinstalled', () => { deferredInstall = null; });

/* ---------- arranque ---------- */
async function readLegacy() {
  try {
    if (indexedDB.databases) { const l = await indexedDB.databases(); if (!l.some(d => d.name === 'escuela')) return null; }
    const d = await new Promise((res, rej) => { const r = indexedDB.open('escuela'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    if (!d.objectStoreNames.contains('kv')) { d.close(); return null; }
    const v = await new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get('db'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    d.close();
    return v && Array.isArray(v.users) && v.users.length ? v : null;
  } catch (e) { return null; }
}
function offlineScreen(msg) { $('#app').innerHTML = `<div class="auth"><div class="authbox"><h1>Mentoris</h1><p class="muted">${esc(msg)}</p><button class="btn" data-act="reload">Reintentar</button></div></div>`; }
async function boot() {
  let pub;
  try { pub = await api('/api/public'); }
  catch (e) { DB = defaultDB(); offlineScreen(e.offline ? 'No hay conexión con el servidor. Revisa tu internet y vuelve a intentar.' : e.message); return; }
  DB = normalizeDb({ config: pub.config });
  NEED_SETUP = !!pub.setup;
  if (NEED_SETUP) LEGACY = await readLegacy();
  if (pub.uid) {
    try { await startSession(pub.uid); }
    catch (e) { SESSION = null; if (e.offline) { offlineScreen('No hay conexión con el servidor. Revisa tu internet y vuelve a intentar.'); return; } }
  }
  if (SESSION) { try { const nv = JSON.parse(localStorage.getItem('nav') || 'null'); if (nv && V[nv.view] && nv.view !== 'examen_edit') { S.view = nv.view; S.id = nv.id; } } catch (e) { } }
  resetHistory();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });
  render(); tick();
  setInterval(tick, 30000); setInterval(poll, 12000);
}
boot();
