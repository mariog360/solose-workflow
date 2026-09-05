/* =====================================================================
   Workflow Casita Solosé — lógica del tablero
   Stack: Supabase (Auth magic link + Postgres + Realtime), sin build step.
   ===================================================================== */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

/* ---------------- configuración ---------------- */
const LS_CFG = 'solose.cfg';

function leerConfig () {
  const fija = window.SOLOSE_CONFIG || {};
  if (fija.url && fija.anonKey) return { url: fija.url, anonKey: fija.anonKey, fuente: 'archivo' };
  try {
    const g = JSON.parse(localStorage.getItem(LS_CFG) || 'null');
    if (g && g.url && g.anonKey) return { ...g, fuente: 'navegador' };
  } catch (_) {}
  return null;
}

/* ---------------- definición de secciones ---------------- */
const SECCIONES = [
  { id:'acuerdo',      titulo:'Acuerdos',      nav:'Acuerdos',   acento:'azul', fecha:true,
    desc:'Compromisos que tomamos juntos, cada uno con su fecha.',
    placeholder:'Nuevo acuerdo…' },
  { id:'todo',         titulo:"To-do's",       nav:"To-do's",    acento:'azul', responsable:true, completable:true,
    desc:'Pendientes con responsable. Al marcarlos pasan a Completadas.',
    placeholder:'Nuevo to-do…' },
  { id:'en_curso',     titulo:'En curso',      nav:'En curso',   acento:'azul', responsable:true, completable:true,
    desc:'Lo que estamos trabajando ahora mismo.',
    placeholder:'Nueva tarea en curso…' },
  { id:'completada',   titulo:'Completadas',   nav:'Hechas',     acento:'ok',   completable:true, cerrada:true, sinAlta:true,
    desc:'Historial. Un clic en la palomita la regresa a donde estaba.' },
  { id:'nota',         titulo:'Notas',         nav:'Notas',      acento:'vino',
    desc:'Lo que ya investigamos o decidimos, para no perderlo.',
    placeholder:'Nueva nota…' },
  { id:'largo_plazo',  titulo:'Largo plazo',   nav:'Largo plazo',acento:'vino', promovible:true,
    desc:'Ideas y features para la v2 o después. La flecha las pasa a En curso.',
    placeholder:'Idea para más adelante…' }
];

/* ---------------- estado ---------------- */
let sb = null;
let sesion = null;
let items = [];
let permitidos = [];
let canal = null;
let editando = null;   // id del item en edición
let borrando = null;   // id del item con borrado pendiente de confirmar

/* ---------------- utilidades ---------------- */
const $  = (s, r = document) => r.querySelector(s);
const el = (t, c, txt) => { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n; };
const hoyISO = () => new Date().toISOString().slice(0, 10);

function nombreDe (email) {
  if (!email) return '—';
  const p = permitidos.find(x => x.email === email.toLowerCase());
  if (p && p.label) return p.label;
  return email.split('@')[0];
}

function fechaCorta (iso) {
  if (!iso) return '';
  const [a, m, d] = iso.slice(0, 10).split('-');
  const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  return `${d} ${meses[Number(m) - 1]} ${a.slice(2)}`;
}

function fechaRelativa (ts) {
  const dif = (Date.now() - new Date(ts).getTime()) / 1000;
  if (dif < 90) return 'ahora';
  if (dif < 3600) return `hace ${Math.round(dif / 60)} min`;
  if (dif < 86400) return `hace ${Math.round(dif / 3600)} h`;
  if (dif < 86400 * 7) return `hace ${Math.round(dif / 86400)} d`;
  return fechaCorta(new Date(ts).toISOString());
}

function icono (d, extra = '') {
  return `<svg viewBox="0 0 24 24" ${extra}>${d}</svg>`;
}
const ICO = {
  check:  '<polyline points="20 6 9 17 4 12"/>',
  editar: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  borrar: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  subir:  '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  caret:  '<polyline points="6 9 12 15 18 9"/>'
};

function aviso (nodo, texto, tipo = '') {
  nodo.hidden = false;
  nodo.className = 'aviso' + (tipo ? ' ' + tipo : '');
  nodo.textContent = texto;
}
function limpiarAviso (nodo) { nodo.hidden = true; nodo.textContent = ''; }

function mostrar (id) {
  ['vista-config', 'vista-login', 'vista-app'].forEach(v => { $('#' + v).hidden = (v !== id); });
}

/* =====================================================================
   Arranque
   ===================================================================== */
arrancar();

async function arrancar () {
  const cfg = leerConfig();
  if (!cfg) { pantallaConfig(); return; }

  try {
    sb = createClient(cfg.url, cfg.anonKey, {
      // 'implicit' (no PKCE) para que el link del correo funcione aunque se abra
      // en otro navegador del mismo teléfono — Gmail/iOS suelen hacer eso.
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' }
    });
  } catch (e) {
    pantallaConfig('No pude usar esas credenciales: ' + e.message);
    return;
  }

  const { data } = await sb.auth.getSession();
  sesion = data.session;

  sb.auth.onAuthStateChange((evt, s) => {
    // INITIAL_SESSION / TOKEN_REFRESHED no cambian de usuario: solo actualizan el token.
    if (evt === 'INITIAL_SESSION' || evt === 'TOKEN_REFRESHED' || evt === 'USER_UPDATED') {
      sesion = s; return;
    }
    const antes = sesion;
    sesion = s;
    if (evt === 'SIGNED_IN' && s && (!antes || antes.user.id !== s.user.id)) entrar();
    if (evt === 'SIGNED_OUT') { desconectarCanal(); pantallaLogin(); }
  });

  // Limpia el hash/query del magic link para que la URL quede presentable
  if (location.hash.includes('access_token') || location.search.includes('code=')) {
    history.replaceState(null, '', location.pathname);
  }

  if (sesion) entrar(); else pantallaLogin();
}

/* =====================================================================
   Pantalla de configuración
   ===================================================================== */
function pantallaConfig (msg) {
  mostrar('vista-config');
  const g = leerConfig();
  if (g) { $('#cfg-url').value = g.url; $('#cfg-key').value = g.anonKey; }
  if (msg) aviso($('#cfg-aviso'), msg, 'error');
  $('#form-config').onsubmit = (e) => {
    e.preventDefault();
    const url = $('#cfg-url').value.trim().replace(/\/+$/, '');
    const anonKey = $('#cfg-key').value.trim();
    if (!/^https:\/\/.+\.supabase\.co$/.test(url)) {
      aviso($('#cfg-aviso'), 'La URL debe verse como https://xxxxxxxx.supabase.co', 'error');
      return;
    }
    localStorage.setItem(LS_CFG, JSON.stringify({ url, anonKey }));
    location.reload();
  };
}

/* =====================================================================
   Login por magic link
   ===================================================================== */
function pantallaLogin () {
  mostrar('vista-login');
  const avisoN = $('#login-aviso');
  const btn = $('#btn-login');
  limpiarAviso(avisoN);

  const recordado = localStorage.getItem('solose.email');
  if (recordado) $('#login-email').value = recordado;

  $('#form-login').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#login-email').value.trim().toLowerCase();
    if (!email) return;
    btn.disabled = true; btn.textContent = 'Enviando…';
    limpiarAviso(avisoN);

    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: location.origin + location.pathname }
    });

    btn.disabled = false; btn.textContent = 'Enviarme el link';

    if (error) {
      const m = (error.message || '').toLowerCase();
      if (m.includes('database') || m.includes('not authorized') || m.includes('no autorizado') || m.includes('signup')) {
        aviso(avisoN, 'Ese correo no está en la lista de acceso del tablero.', 'error');
      } else {
        aviso(avisoN, error.message, 'error');
      }
      return;
    }
    localStorage.setItem('solose.email', email);
    aviso(avisoN, 'Listo. Revisa tu correo y abre el link desde este mismo teléfono o compu. Caduca en 1 hora.', 'ok');
  };
}

/* =====================================================================
   Entrar al tablero
   ===================================================================== */
async function entrar () {
  mostrar('vista-app');
  $('#quien-soy').textContent = sesion.user.email;

  pintarEsqueleto();

  const ok = await cargarTodo();
  if (!ok) return;

  conectarCanal();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') cargarTodo();
  });
}

async function cargarTodo () {
  const [ri, rp] = await Promise.all([
    sb.from('items').select('*').order('created_at', { ascending: false }),
    sb.from('allowed_emails').select('*').order('created_at')
  ]);

  if (ri.error || rp.error) {
    const err = ri.error || rp.error;
    const cont = $('#secciones');
    cont.innerHTML = '';
    const t = el('div', 'tarjeta');
    t.innerHTML = `<h1>Sin acceso</h1><p class="lead">Tu sesión funciona, pero la base no te
      devuelve datos. Suele ser una de dos: falta correr <code>supabase/schema.sql</code>,
      o tu correo no está en la lista de acceso.</p>
      <div class="aviso error">${err.message}</div>`;
    const salir = el('button', 'btn-full', 'Cerrar sesión');
    salir.style.marginTop = '1rem';
    salir.onclick = () => sb.auth.signOut();
    t.appendChild(salir);
    cont.appendChild(t);
    return false;
  }

  items = ri.data || [];
  permitidos = rp.data || [];
  pintar();
  return true;
}

/* ---------------- realtime ---------------- */
function conectarCanal () {
  desconectarCanal();
  canal = sb.channel('tablero')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, cargarTodo)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'allowed_emails' }, cargarTodo)
    .subscribe();
}
function desconectarCanal () { if (canal) { sb.removeChannel(canal); canal = null; } }

/* =====================================================================
   Render
   ===================================================================== */
function pintarEsqueleto () {
  const nav = $('#nav');
  nav.innerHTML = '';
  SECCIONES.forEach(s => {
    const c = el('button', 'chip');
    c.innerHTML = `${s.nav}<b data-cuenta="${s.id}">0</b>`;
    c.onclick = () => {
      const sec = document.getElementById('sec-' + s.id);
      sec.classList.remove('cerrada');
      sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    nav.appendChild(c);
  });

  const main = $('#secciones');
  main.innerHTML = '';
  SECCIONES.forEach(s => main.appendChild(construirSeccion(s)));

  $('#btn-salir').onclick = async () => { desconectarCanal(); await sb.auth.signOut(); };
  $('#btn-ajustes').onclick = abrirAjustes;
  $('#btn-cerrar-ajustes').onclick = () => { $('#velo-ajustes').hidden = true; };
  $('#velo-ajustes').onclick = (e) => { if (e.target.id === 'velo-ajustes') $('#velo-ajustes').hidden = true; };
  $('#btn-reconfig').onclick = () => {
    localStorage.removeItem(LS_CFG);
    location.reload();
  };
  $('#btn-add-correo').onclick = agregarCorreo;
}

function construirSeccion (s) {
  const sec = el('section', 'seccion' + (s.cerrada ? ' cerrada' : ''));
  sec.id = 'sec-' + s.id;
  sec.dataset.acento = s.acento;

  const cab = el('button', 'seccion-cab');
  cab.innerHTML = `${icono(ICO.caret, 'class="caret"')}<h2>${s.titulo}</h2>
                   <span class="cuenta" data-cuenta2="${s.id}">0</span>`;
  cab.onclick = () => sec.classList.toggle('cerrada');
  sec.appendChild(cab);

  const cuerpo = el('div', 'seccion-cuerpo');
  cuerpo.appendChild(el('p', 'seccion-desc', s.desc));

  if (!s.sinAlta) cuerpo.appendChild(formularioAlta(s));

  const ul = el('ul', 'lista');
  ul.dataset.lista = s.id;
  cuerpo.appendChild(ul);

  sec.appendChild(cuerpo);
  return sec;
}

function formularioAlta (s) {
  const f = el('form', 'alta');
  const txt = el('textarea');
  txt.rows = 1; txt.placeholder = s.placeholder; txt.required = true;
  txt.addEventListener('input', () => {
    txt.style.height = 'auto';
    txt.style.height = Math.min(txt.scrollHeight, 160) + 'px';
  });
  txt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); }
  });
  f.appendChild(txt);

  let fecha = null, resp = null;
  if (s.fecha) {
    fecha = el('input'); fecha.type = 'date'; fecha.value = hoyISO();
    fecha.title = 'Fecha del acuerdo';
    f.appendChild(fecha);
  }
  if (s.responsable) {
    resp = el('select'); resp.dataset.resp = '1';
    f.appendChild(resp);
  }

  const btn = el('button', 'btn-add', 'Agregar');
  btn.type = 'submit';
  f.appendChild(btn);

  f.onsubmit = async (e) => {
    e.preventDefault();
    const texto = txt.value.trim();
    if (!texto) return;
    btn.disabled = true;
    const fila = { section: s.id, texto };
    if (fecha) fila.fecha_acuerdo = fecha.value || null;
    if (resp) fila.responsable = resp.value || null;

    const { error } = await sb.from('items').insert(fila);
    btn.disabled = false;
    if (error) { alertaSuave(error.message); return; }
    txt.value = ''; txt.style.height = 'auto';
    if (fecha) fecha.value = hoyISO();
    await cargarTodo();
  };
  return f;
}

function opcionesResponsable (select, valor) {
  const previo = valor != null ? valor : select.value;
  select.innerHTML = '';
  const nada = el('option', null, 'Responsable…'); nada.value = '';
  select.appendChild(nada);
  permitidos.forEach(p => {
    const o = el('option', null, p.label || p.email.split('@')[0]);
    o.value = p.label || p.email.split('@')[0];
    select.appendChild(o);
  });
  const ambos = el('option', null, 'Los dos'); ambos.value = 'Los dos';
  select.appendChild(ambos);
  if (previo && ![...select.options].some(o => o.value === previo)) {
    const extra = el('option', null, previo); extra.value = previo;
    select.appendChild(extra);
  }
  select.value = previo || '';
}

function pintar () {
  document.querySelectorAll('[data-resp]').forEach(s => opcionesResponsable(s));

  SECCIONES.forEach(s => {
    let lista = items.filter(i => i.section === s.id);

    if (s.id === 'acuerdo') {
      lista.sort((a, b) => (b.fecha_acuerdo || '').localeCompare(a.fecha_acuerdo || ''));
    } else if (s.id === 'completada') {
      lista.sort((a, b) => new Date(b.completada_at || b.updated_at) - new Date(a.completada_at || a.updated_at));
    }

    document.querySelectorAll(`[data-cuenta="${s.id}"],[data-cuenta2="${s.id}"]`)
      .forEach(n => { n.textContent = lista.length; });

    const ul = document.querySelector(`[data-lista="${s.id}"]`);
    ul.innerHTML = '';
    if (!lista.length) {
      const v = el('li', 'vacio', s.id === 'completada' ? 'Todavía nada terminado.' : 'Vacío por ahora.');
      ul.appendChild(v);
      return;
    }
    lista.forEach(it => ul.appendChild(construirItem(it, s)));
  });
}

function construirItem (it, s) {
  const li = el('li', 'item' + (it.section === 'completada' ? ' hecho' : ''));

  if (s.completable) {
    const chk = el('button', 'check');
    chk.type = 'button';
    chk.innerHTML = icono(ICO.check);
    chk.title = it.section === 'completada' ? 'Reabrir' : 'Marcar como completada';
    chk.setAttribute('aria-label', chk.title);
    chk.onclick = () => alternarCompletada(it);
    li.appendChild(chk);
  }

  const cuerpo = el('div', 'cuerpo');

  if (editando === it.id) {
    cuerpo.appendChild(editorDe(it, s));
  } else {
    cuerpo.appendChild(el('div', 'texto', it.texto));

    const meta = el('div', 'meta');
    if (it.fecha_acuerdo) {
      const vencida = it.fecha_acuerdo < hoyISO();
      meta.appendChild(el('span', 'tag fecha' + (vencida ? ' vencida' : ''), fechaCorta(it.fecha_acuerdo)));
    }
    if (it.responsable) meta.appendChild(el('span', 'tag resp', it.responsable));
    meta.appendChild(el('span', 'tag', nombreDe(it.autor_email) + ' · ' +
      fechaRelativa(it.section === 'completada' ? (it.completada_at || it.updated_at) : it.created_at)));
    cuerpo.appendChild(meta);
  }
  li.appendChild(cuerpo);

  if (editando !== it.id) {
    const acc = el('div', 'acciones');

    if (s.promovible) {
      const b = el('button', 'mini');
      b.innerHTML = icono(ICO.subir);
      b.title = 'Pasar a En curso';
      b.onclick = async () => { await actualizar(it.id, { section: 'en_curso' }); };
      acc.appendChild(b);
    }

    const bEd = el('button', 'mini');
    bEd.innerHTML = icono(ICO.editar);
    bEd.title = 'Editar';
    bEd.onclick = () => { editando = it.id; borrando = null; pintar(); };
    acc.appendChild(bEd);

    if (borrando === it.id) {
      const bSi = el('button', 'mini confirmar', 'BORRAR');
      bSi.onclick = () => borrar(it.id);
      acc.appendChild(bSi);
      const bNo = el('button', 'mini', '✕');
      bNo.onclick = () => { borrando = null; pintar(); };
      acc.appendChild(bNo);
    } else {
      const bDel = el('button', 'mini peligro');
      bDel.innerHTML = icono(ICO.borrar);
      bDel.title = 'Borrar';
      bDel.onclick = () => { borrando = it.id; editando = null; pintar(); };
      acc.appendChild(bDel);
    }
    li.appendChild(acc);
  }

  return li;
}

function editorDe (it, s) {
  const box = el('div', 'editor');
  const ta = el('textarea');
  ta.value = it.texto;
  box.appendChild(ta);

  const fila = el('div', 'fila');
  let fecha = null, resp = null;
  if (s.fecha) {
    fecha = el('input'); fecha.type = 'date'; fecha.value = it.fecha_acuerdo || '';
    fila.appendChild(fecha);
  }
  if (s.responsable) {
    resp = el('select');
    opcionesResponsable(resp, it.responsable || '');
    fila.appendChild(resp);
  }
  const guardar = el('button', 'btn-sm primario', 'Guardar');
  const cancelar = el('button', 'btn-sm', 'Cancelar');
  fila.appendChild(guardar); fila.appendChild(cancelar);
  box.appendChild(fila);

  guardar.onclick = async () => {
    const texto = ta.value.trim();
    if (!texto) return;
    const parche = { texto };
    if (fecha) parche.fecha_acuerdo = fecha.value || null;
    if (resp) parche.responsable = resp.value || null;
    editando = null;
    await actualizar(it.id, parche);
  };
  cancelar.onclick = () => { editando = null; pintar(); };

  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
  return box;
}

/* =====================================================================
   Operaciones
   ===================================================================== */
async function actualizar (id, parche) {
  const { error } = await sb.from('items').update(parche).eq('id', id);
  if (error) { alertaSuave(error.message); return; }
  await cargarTodo();
}

async function borrar (id) {
  borrando = null;
  const { error } = await sb.from('items').delete().eq('id', id);
  if (error) { alertaSuave(error.message); return; }
  await cargarTodo();
}

async function alternarCompletada (it) {
  if (it.section === 'completada') {
    await actualizar(it.id, { section: it.seccion_previa || 'en_curso', seccion_previa: null });
  } else {
    await actualizar(it.id, { section: 'completada', seccion_previa: it.section });
  }
}

function alertaSuave (msg) {
  const n = el('div', 'aviso error', msg);
  Object.assign(n.style, {
    position: 'fixed', left: '50%', transform: 'translateX(-50%)',
    bottom: 'calc(1rem + env(safe-area-inset-bottom))', zIndex: 90,
    maxWidth: '92vw', background: '#FFFBF3', boxShadow: 'var(--sombra)'
  });
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 5000);
}

/* =====================================================================
   Panel de accesos
   ===================================================================== */
function abrirAjustes () {
  $('#velo-ajustes').hidden = false;
  limpiarAviso($('#ajustes-aviso'));
  pintarCorreos();
}

function pintarCorreos () {
  const ul = $('#lista-correos');
  ul.innerHTML = '';
  permitidos.forEach(p => {
    const li = el('li');
    const quien = el('span', 'quien');
    quien.innerHTML = `<strong>${p.label || '—'}</strong> <span class="mono">${p.email}</span>`;
    li.appendChild(quien);
    if (p.email === (sesion.user.email || '').toLowerCase()) {
      li.appendChild(el('span', 'tag', 'tú'));
    } else {
      const b = el('button', 'mini peligro');
      b.innerHTML = icono(ICO.borrar);
      b.title = 'Quitar acceso';
      b.onclick = async () => {
        const { error } = await sb.from('allowed_emails').delete().eq('email', p.email);
        if (error) aviso($('#ajustes-aviso'), error.message, 'error');
        await cargarTodo(); pintarCorreos();
      };
      li.appendChild(b);
    }
    ul.appendChild(li);
  });
}

async function agregarCorreo () {
  const email = $('#nuevo-correo').value.trim().toLowerCase();
  const label = $('#nuevo-nombre').value.trim();
  const n = $('#ajustes-aviso');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    aviso(n, 'Ese correo no se ve válido.', 'error'); return;
  }
  const { error } = await sb.from('allowed_emails')
    .insert({ email, label: label || email.split('@')[0], added_by: sesion.user.email });
  if (error) { aviso(n, error.message, 'error'); return; }
  $('#nuevo-correo').value = ''; $('#nuevo-nombre').value = '';
  aviso(n, `${email} ya puede pedir su link de acceso.`, 'ok');
  await cargarTodo();
  pintarCorreos();
}

/* ---------------- service worker ---------------- */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
