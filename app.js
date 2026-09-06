/* =====================================================================
   Workflow Casita Solosé — lógica del tablero
   Supabase (Auth magic link + Postgres + Realtime), sin build step.
   ===================================================================== */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const LS_CFG = 'solose.cfg';

function leerConfig () {
  const fija = window.SOLOSE_CONFIG || {};
  if (fija.url && fija.anonKey) return { url: fija.url, anonKey: fija.anonKey };
  try {
    const g = JSON.parse(localStorage.getItem(LS_CFG) || 'null');
    if (g && g.url && g.anonKey) return g;
  } catch (_) {}
  return null;
}

/* ---------------------------------------------------------------------
   Secciones. 'col' reparte en dos columnas en escritorio:
     a = lo vivo (lo acordado, lo pendiente, lo que está en marcha)
     b = la memoria (lo hecho, lo investigado, lo de después)
   En móvil las dos columnas se aplanan y quedan en este mismo orden.
   --------------------------------------------------------------------- */
const SECCIONES = [
  { id:'acuerdo', col:'a', titulo:'Acuerdos', nav:'Acuerdos', tipo:'acuerdo', fecha:true,
    completable:true,
    desc:'Lo que quedó comprometido entre los dos, con la fecha en que se acordó. No se completan: son el registro.',
    ph:'Nuevo acuerdo…' },

  { id:'todo', col:'a', titulo:"To-do's", nav:"To-do's", tipo:'tarea',
    responsable:true, completable:true, aEnCurso:true, bitacora:true, agrupa:true,
    desc:'Pendientes con responsable, todavía sin empezar.',
    ph:'Nuevo to-do…' },

  { id:'en_curso', col:'a', titulo:'En curso', nav:'En curso', tipo:'tarea',
    responsable:true, completable:true, bitacora:true, agrupa:true,
    desc:'Lo que ya está en marcha. Anota avances para saber en qué va.',
    ph:'Nueva tarea en curso…' },

  { id:'completada', col:'b', titulo:'Completadas', nav:'Hechas', tipo:'tarea',
    completable:true, bitacora:true, plegada:true, sinAlta:true,
    desc:'Historial. La casilla la regresa a donde estaba.' },

  { id:'nota', col:'b', titulo:'Notas', nav:'Notas', tipo:'nota', completable:true,
    desc:'Lo que ya investigamos o decidimos, para no perderlo.',
    ph:'Nueva nota…' },

  { id:'largo_plazo', col:'b', titulo:'Largo plazo', nav:'Largo plazo', tipo:'nota',
    promovible:true, completable:true,
    desc:'Ideas y features para la v2 o después. La flecha las manda a En curso.',
    ph:'Idea para más adelante…' }
];

/* ---------------- estado ---------------- */
let sb = null, sesion = null;
let items = [], permitidos = [], avances = [];
let canal = null;
let editando = null, borrando = null, altaAbierta = null;
const abiertos = new Set();   // items con la bitácora desplegada

/* ---------------- utilidades ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const el = (t, c, txt) => { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n; };
const hoyISO = () => new Date().toISOString().slice(0, 10);
const ORIGEN = { acuerdo:'Acuerdo', todo:"To-do", en_curso:'En curso', nota:'Nota', largo_plazo:'Largo plazo' };
const MESES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

function nombreDe (email) {
  if (!email) return '—';
  const p = permitidos.find(x => x.email === email.toLowerCase());
  return (p && p.label) ? p.label : email.split('@')[0];
}
function fechaCorta (iso) {
  if (!iso) return '';
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d} ${MESES[Number(m) - 1]} ${a.slice(2)}`;
}
function relativa (ts) {
  const dif = (Date.now() - new Date(ts).getTime()) / 1000;
  if (dif < 90) return 'ahora';
  if (dif < 3600) return `hace ${Math.round(dif / 60)} min`;
  if (dif < 86400) return `hace ${Math.round(dif / 3600)} h`;
  if (dif < 86400 * 7) return `hace ${Math.round(dif / 86400)} d`;
  return fechaCorta(new Date(ts).toISOString());
}
const svg = (d, cls) => `<svg viewBox="0 0 24 24"${cls ? ` class="${cls}"` : ''}>${d}</svg>`;
const ICO = {
  check:  '<polyline points="20 6 9 17 4 12"/>',
  editar: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  borrar: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  flecha: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  v:      '<polyline points="6 9 12 15 18 9"/>'
};

function msj (nodo, texto, tipo = '') {
  nodo.hidden = false; nodo.className = 'msj' + (tipo ? ' ' + tipo : ''); nodo.textContent = texto;
}
const limpia = (n) => { n.hidden = true; n.textContent = ''; };
const mostrar = (id) => ['vista-config','vista-login','vista-app']
  .forEach(v => { $('#' + v).hidden = (v !== id); });

/* =====================================================================
   Arranque
   ===================================================================== */
arrancar();

async function arrancar () {
  const cfg = leerConfig();
  if (!cfg) { pantallaConfig(); return; }

  try {
    sb = createClient(cfg.url, cfg.anonKey, {
      // 'implicit' (no PKCE): el link del correo funciona aunque se abra
      // en otro navegador del mismo teléfono — Gmail/iOS suelen hacer eso.
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' }
    });
  } catch (e) { pantallaConfig('No pude usar esas credenciales: ' + e.message); return; }

  const { data } = await sb.auth.getSession();
  sesion = data.session;

  sb.auth.onAuthStateChange((evt, s) => {
    if (evt === 'INITIAL_SESSION' || evt === 'TOKEN_REFRESHED' || evt === 'USER_UPDATED') { sesion = s; return; }
    const antes = sesion;
    sesion = s;
    if (evt === 'SIGNED_IN' && s && (!antes || antes.user.id !== s.user.id)) entrar();
    if (evt === 'SIGNED_OUT') { cerrarCanal(); pantallaLogin(); }
  });

  if (location.hash.includes('access_token') || location.search.includes('code=')) {
    history.replaceState(null, '', location.pathname);
  }
  if (sesion) entrar(); else pantallaLogin();
}

/* ---------------- pantalla de configuración ---------------- */
function pantallaConfig (aviso) {
  mostrar('vista-config');
  const g = leerConfig();
  if (g) { $('#cfg-url').value = g.url; $('#cfg-key').value = g.anonKey; }
  if (aviso) msj($('#cfg-msj'), aviso, 'error');
  $('#form-config').onsubmit = (e) => {
    e.preventDefault();
    const url = $('#cfg-url').value.trim().replace(/\/+$/, '');
    const anonKey = $('#cfg-key').value.trim();
    if (!/^https:\/\/.+\.supabase\.co$/.test(url)) {
      msj($('#cfg-msj'), 'La URL debe verse como https://xxxxxxxx.supabase.co', 'error'); return;
    }
    localStorage.setItem(LS_CFG, JSON.stringify({ url, anonKey }));
    location.reload();
  };
}

/* ---------------- acceso ---------------- */
function pantallaLogin () {
  mostrar('vista-login');
  const n = $('#login-msj'), btn = $('#btn-login');
  limpia(n);
  const recordado = localStorage.getItem('solose.email');
  if (recordado) $('#login-email').value = recordado;

  $('#form-login').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#login-email').value.trim().toLowerCase();
    if (!email) return;
    btn.disabled = true; btn.textContent = 'Enviando…'; limpia(n);

    const { error } = await sb.auth.signInWithOtp({
      email, options: { emailRedirectTo: location.origin + location.pathname }
    });
    btn.disabled = false; btn.textContent = 'Enviarme el link';

    if (error) {
      const m = (error.message || '').toLowerCase();
      msj(n, (m.includes('database') || m.includes('not authorized') || m.includes('signup'))
        ? 'Ese correo no está en la lista de acceso del tablero.'
        : error.message, 'error');
      return;
    }
    localStorage.setItem('solose.email', email);
    msj(n, 'Listo. El correo trae un link y un código de 6 dígitos: usa el que te quede mejor. ' +
           'Caduca en 1 hora.', 'ok');
    mostrarCodigo(true);
    $('#login-codigo').focus();
  };

  /* ---- entrar con código ----
     El link no siempre sirve: en iPhone, una app agregada a la pantalla de
     inicio puede no recibir la sesión que el link abre en Safari. El código
     se teclea dentro de la app y evita ese callejón. */
  const toggle = $('#toggle-codigo');
  const fCod = $('#form-codigo');
  const bCod = $('#btn-codigo');

  const mostrarCodigo = (ver) => {
    fCod.hidden = !ver;
    toggle.textContent = ver ? 'Prefiero el link del correo' : 'Ya tengo un código';
  };
  mostrarCodigo(false);
  toggle.onclick = () => mostrarCodigo(fCod.hidden);

  fCod.onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#login-email').value.trim().toLowerCase();
    const token = $('#login-codigo').value.replace(/\D/g, '');
    if (!email) { msj(n, 'Escribe primero tu correo, arriba.', 'error'); return; }
    if (token.length !== 6) { msj(n, 'El código son 6 dígitos.', 'error'); return; }

    bCod.disabled = true; bCod.textContent = 'Verificando…';
    const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
    bCod.disabled = false; bCod.textContent = 'Entrar con el código';

    if (error) {
      const m = (error.message || '').toLowerCase();
      msj(n, (m.includes('expired') || m.includes('invalid'))
        ? 'Ese código no sirve o ya caducó. Pide uno nuevo con el botón de arriba.'
        : error.message, 'error');
      return;
    }
    localStorage.setItem('solose.email', email);
    // el evento SIGNED_IN se encarga de entrar al tablero
  };
}

/* =====================================================================
   Tablero
   ===================================================================== */
async function entrar () {
  mostrar('vista-app');
  $('#quien-soy').textContent = sesion.user.email;
  esqueleto();
  if (!await cargar()) return;
  abrirCanal();
  observarSecciones();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') cargar();
  });
}

async function cargar () {
  const [ri, rp, ra] = await Promise.all([
    sb.from('items').select('*').order('created_at', { ascending: false }),
    sb.from('allowed_emails').select('*').order('created_at'),
    sb.from('item_avances').select('*').order('created_at')
  ]);

  const err = ri.error || rp.error || ra.error;
  if (err) { pantallaError(err); return false; }

  items = ri.data || []; permitidos = rp.data || []; avances = ra.data || [];
  pintar();
  return true;
}

function pantallaError (err) {
  const falta = /item_avances/.test(err.message || '');
  $('#col-b').innerHTML = '';
  const c = $('#col-a');
  c.innerHTML = '';
  const t = el('div', 'tarjeta');
  t.innerHTML = falta
    ? `<h1>Falta una tabla</h1><p class="lead">Tu sesión funciona, pero la bitácora de avances
       todavía no existe en la base. Vuelve a correr <code>supabase/schema.sql</code> completo en
       el SQL Editor de Supabase: es idempotente, no rompe nada de lo que ya está.</p>`
    : `<h1>Sin acceso</h1><p class="lead">Tu sesión funciona, pero la base no te devuelve datos.
       Suele ser que falta correr <code>supabase/schema.sql</code>.</p>`;
  const m = el('div', 'msj error', err.message); t.appendChild(m);
  const b = el('button', 'b-full', 'Cerrar sesión');
  b.style.marginTop = '1rem';
  b.onclick = () => sb.auth.signOut();
  t.appendChild(b);
  c.appendChild(t);
}

/* ---------------- realtime ---------------- */
function abrirCanal () {
  cerrarCanal();
  canal = sb.channel('tablero')
    .on('postgres_changes', { event:'*', schema:'public', table:'items' }, cargar)
    .on('postgres_changes', { event:'*', schema:'public', table:'item_avances' }, cargar)
    .on('postgres_changes', { event:'*', schema:'public', table:'allowed_emails' }, cargar)
    .subscribe();
}
function cerrarCanal () { if (canal) { sb.removeChannel(canal); canal = null; } }

/* =====================================================================
   Estructura
   ===================================================================== */
function esqueleto () {
  const nav = $('#nav'); nav.innerHTML = '';
  SECCIONES.forEach(s => {
    const c = el('button', `chip s-${s.id}`);
    c.dataset.chip = s.id;
    c.innerHTML = `<i></i>${s.nav}<b data-n1="${s.id}">0</b>`;
    c.onclick = () => {
      const sec = document.getElementById('sec-' + s.id);
      sec.classList.remove('plegada');
      sec.scrollIntoView({ behavior:'smooth', block:'start' });
    };
    nav.appendChild(c);
  });

  $('#col-a').innerHTML = ''; $('#col-b').innerHTML = '';
  SECCIONES.forEach(s => $('#col-' + s.col).appendChild(construirSeccion(s)));

  $('#btn-salir').onclick = async () => { cerrarCanal(); await sb.auth.signOut(); };
  $('#btn-ajustes').onclick = abrirAjustes;
  $('#btn-cerrar-ajustes').onclick = () => { $('#velo-ajustes').hidden = true; };
  $('#velo-ajustes').onclick = (e) => { if (e.target.id === 'velo-ajustes') $('#velo-ajustes').hidden = true; };
  $('#btn-reconfig').onclick = () => { localStorage.removeItem(LS_CFG); location.reload(); };
  $('#btn-add-correo').onclick = agregarCorreo;
}

function construirSeccion (s) {
  const sec = el('section', `sec s-${s.id}` + (s.plegada ? ' plegada' : ''));
  sec.id = 'sec-' + s.id;

  const cab = el('button', 'sec-cab');
  cab.innerHTML = `<h2>${s.titulo}</h2><span class="n" data-n2="${s.id}">0</span>${svg(ICO.v,'v')}`;
  cab.onclick = () => sec.classList.toggle('plegada');
  sec.appendChild(cab);

  const cuerpo = el('div', 'sec-cuerpo');
  const desc = el('p', 'sec-desc', s.desc); desc.dataset.desc = s.id;
  cuerpo.appendChild(desc);
  const ul = el('ul', 'lista'); ul.dataset.lista = s.id;
  cuerpo.appendChild(ul);
  const zona = el('div'); zona.dataset.alta = s.id;
  cuerpo.appendChild(zona);
  sec.appendChild(cuerpo);
  return sec;
}

/* ---------------- índice que sigue el scroll ---------------- */
function observarSecciones () {
  const obs = new IntersectionObserver((entradas) => {
    entradas.forEach(e => {
      if (!e.isIntersecting) return;
      const id = e.target.id.replace('sec-', '');
      document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.dataset.chip === id));
    });
  }, { rootMargin: '-110px 0px -70% 0px' });
  SECCIONES.forEach(s => obs.observe(document.getElementById('sec-' + s.id)));
}

/* =====================================================================
   Pintado
   ===================================================================== */
function pintar () {
  SECCIONES.forEach(s => {
    let lista = items.filter(i => i.section === s.id);
    if (s.id === 'acuerdo') {
      lista.sort((a, b) => (b.fecha_acuerdo || '').localeCompare(a.fecha_acuerdo || ''));
    } else if (s.id === 'completada') {
      lista.sort((a, b) => new Date(b.completada_at || b.updated_at) - new Date(a.completada_at || a.updated_at));
    }

    document.querySelectorAll(`[data-n1="${s.id}"],[data-n2="${s.id}"]`)
      .forEach(n => { n.textContent = lista.length; });

    // la descripción solo estorba cuando ya hay contenido
    const d = document.querySelector(`[data-desc="${s.id}"]`);
    if (d) d.hidden = lista.length > 0;

    const ul = document.querySelector(`[data-lista="${s.id}"]`);
    ul.innerHTML = '';
    if (s.agrupa && lista.length) pintarAgrupado(ul, lista, s);
    else lista.forEach(it => ul.appendChild(fila(it, s)));

    const zona = document.querySelector(`[data-alta="${s.id}"]`);
    zona.innerHTML = '';
    if (!s.sinAlta) zona.appendChild(altaAbierta === s.id ? formAlta(s) : botonNuevo(s));
    else if (!lista.length) zona.appendChild(el('p', 'vacio', 'Todavía nada terminado.'));
  });
}

/* Color por responsable. Fijo por posición en la lista de accesos, así que
   Mario siempre es el mismo azul y Fer el mismo terracota aunque se agregue
   gente después. 'Los dos' y 'Sin asignar' tienen los suyos aparte. */
const PALETA_PERSONA = ['#1B3FD1','#A63D2A','#8A6A12','#6B3A6E','#0F6E68'];
const COLOR_AMBOS = '#1F7A4C';
const COLOR_NADIE = '#8B8073';

function colorPersona (nombre) {
  if (nombre === 'Los dos') return COLOR_AMBOS;
  if (nombre === 'Sin asignar') return COLOR_NADIE;
  const i = permitidos.findIndex(p => (p.label || p.email.split('@')[0]) === nombre);
  if (i >= 0) return PALETA_PERSONA[i % PALETA_PERSONA.length];
  let h = 0;                                   // responsable escrito a mano
  for (const c of nombre) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETA_PERSONA[h % PALETA_PERSONA.length];
}

/* Agrupa por responsable. Lo tuyo primero: la pregunta que uno le hace al
   tablero es "¿qué me toca a mí?", no "¿qué hay?". */
function pintarAgrupado (ul, lista, s) {
  const yo = nombreDe((sesion.user.email || '').toLowerCase());
  const SIN = 'Sin asignar';

  const grupos = new Map();
  lista.forEach(it => {
    const k = (it.responsable || '').trim() || SIN;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(it);
  });

  const rango = (k) => k === yo ? 0 : k === 'Los dos' ? 2 : k === SIN ? 3 : 1;
  const orden = [...grupos.keys()].sort((a, b) => rango(a) - rango(b) || a.localeCompare(b));

  orden.forEach(k => {
    const filas = grupos.get(k);
    const color = colorPersona(k);

    const cab = el('li', 'grupo' + (k === yo ? ' mio' : ''));
    cab.style.setProperty('--per', color);
    cab.appendChild(el('span', 'quien', k === yo ? `${k} — tú` : k));
    cab.appendChild(el('span', 'cuenta', String(filas.length)));
    ul.appendChild(cab);

    filas.forEach(it => {
      const li = fila(it, s);
      li.classList.add('per');
      li.style.setProperty('--per', color);
      ul.appendChild(li);
    });
  });
}

function botonNuevo (s) {
  const b = el('button', 'nuevo');
  b.innerHTML = `<span class="mas">+</span>${s.ph.replace('…', '')}`;
  b.onclick = () => { altaAbierta = s.id; pintar(); };
  return b;
}

function formAlta (s) {
  const f = el('form', 'alta');
  const ta = el('textarea'); ta.placeholder = s.ph; ta.required = true; ta.rows = 2;
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); f.requestSubmit(); }
    if (e.key === 'Escape') { altaAbierta = null; pintar(); }
  });
  f.appendChild(ta);

  const fila1 = el('div', 'fila');
  let fecha = null, resp = null;
  if (s.fecha) { fecha = el('input'); fecha.type = 'date'; fecha.value = hoyISO(); fila1.appendChild(fecha); }
  if (s.responsable) { resp = el('select'); opcionesResp(resp, ''); fila1.appendChild(resp); }
  const cancelar = el('button', 'b', 'Cancelar'); cancelar.type = 'button';
  cancelar.onclick = () => { altaAbierta = null; pintar(); };
  const guardar = el('button', 'b pri der', 'Agregar'); guardar.type = 'submit';
  fila1.appendChild(cancelar); fila1.appendChild(guardar);
  f.appendChild(fila1);

  f.onsubmit = async (e) => {
    e.preventDefault();
    const texto = ta.value.trim(); if (!texto) return;
    guardar.disabled = true;
    const row = { section: s.id, texto };
    if (fecha) row.fecha_acuerdo = fecha.value || null;
    if (resp) row.responsable = resp.value || null;
    const { error } = await sb.from('items').insert(row);
    guardar.disabled = false;
    if (error) { aviso(error.message); return; }
    ta.value = '';
    await cargar();
    ta.focus();
  };

  setTimeout(() => ta.focus(), 0);
  return f;
}

function opcionesResp (select, valor) {
  select.innerHTML = '';
  const n = el('option', null, 'Responsable…'); n.value = ''; select.appendChild(n);
  permitidos.forEach(p => {
    const nom = p.label || p.email.split('@')[0];
    const o = el('option', null, nom); o.value = nom; select.appendChild(o);
  });
  const dos = el('option', null, 'Los dos'); dos.value = 'Los dos'; select.appendChild(dos);
  if (valor && ![...select.options].some(o => o.value === valor)) {
    const x = el('option', null, valor); x.value = valor; select.appendChild(x);
  }
  select.value = valor || '';
}

/* ---------------- una fila ---------------- */
function fila (it, s) {
  const li = el('li', 'it' + (it.section === 'completada' ? ' ok' : ''));

  if (s.completable) {
    const b = el('button', 'box');
    b.type = 'button';
    b.innerHTML = svg(ICO.check);
    b.title = it.section === 'completada' ? 'Reabrir' : 'Marcar como completada';
    b.setAttribute('aria-label', b.title);
    b.onclick = () => alternar(it);
    li.appendChild(b);
  }

  if (s.tipo === 'acuerdo') {
    const tarde = it.fecha_acuerdo && it.fecha_acuerdo < hoyISO();
    const sello = el('div', 'sello' + (tarde ? ' tarde' : ''));
    const f = fechaCorta(it.fecha_acuerdo).split(' ');
    sello.innerHTML = it.fecha_acuerdo
      ? `${f[0]} ${f[1]}<small>${f[2]}</small>`
      : `—<small>s/f</small>`;
    li.appendChild(sello);
  }

  const cont = el('div', 'cont');

  if (editando === it.id) {
    cont.appendChild(editor(it, s));
  } else {
    cont.appendChild(el('div', 'txt', it.texto));

    const pie = el('div', 'pie');
    if (it.responsable && !s.agrupa) pie.appendChild(el('span', 'et resp', it.responsable));
    if (it.section === 'completada' && it.seccion_previa) {
      pie.appendChild(el('span', 'et origen', ORIGEN[it.seccion_previa] || it.seccion_previa));
    }
    pie.appendChild(el('span', 'et', nombreDe(it.autor_email) + ' · ' +
      relativa(it.section === 'completada' ? (it.completada_at || it.updated_at) : it.created_at)));

    if (s.bitacora) {
      const mias = avances.filter(a => a.item_id === it.id);
      const t = el('button', 'et bit',
        mias.length ? `${mias.length} ${mias.length === 1 ? 'avance' : 'avances'}` : '+ avance');
      t.type = 'button';
      t.onclick = () => { abiertos.has(it.id) ? abiertos.delete(it.id) : abiertos.add(it.id); pintar(); };
      pie.appendChild(t);
    }
    cont.appendChild(pie);

    if (s.bitacora && abiertos.has(it.id)) cont.appendChild(bitacora(it));
  }
  li.appendChild(cont);

  if (editando !== it.id) {
    const acc = el('div', 'acc');

    if (s.aEnCurso) {
      const b = el('button', 'mn');
      b.innerHTML = svg(ICO.flecha);
      b.title = 'Pasar a En curso';
      b.onclick = () => actualizar(it.id, { section:'en_curso' });
      acc.appendChild(b);
    }
    if (s.promovible) {
      const b = el('button', 'mn');
      b.innerHTML = svg(ICO.flecha);
      b.title = 'Pasar a En curso';
      b.onclick = () => actualizar(it.id, { section:'en_curso' });
      acc.appendChild(b);
    }

    const ed = el('button', 'mn');
    ed.innerHTML = svg(ICO.editar); ed.title = 'Editar';
    ed.onclick = () => { editando = it.id; borrando = null; pintar(); };
    acc.appendChild(ed);

    if (borrando === it.id) {
      const si = el('button', 'mn si', 'BORRAR'); si.onclick = () => borrar(it.id);
      const no = el('button', 'mn', '✕'); no.onclick = () => { borrando = null; pintar(); };
      acc.appendChild(si); acc.appendChild(no);
    } else {
      const d = el('button', 'mn rojo');
      d.innerHTML = svg(ICO.borrar); d.title = 'Borrar';
      d.onclick = () => { borrando = it.id; editando = null; pintar(); };
      acc.appendChild(d);
    }
    li.appendChild(acc);
  }
  return li;
}

/* ---------------- bitácora ---------------- */
function bitacora (it) {
  const caja = el('div', 'bitacora');
  const mias = avances.filter(a => a.item_id === it.id);

  mias.forEach(a => {
    const r = el('div', 'av');
    r.appendChild(el('span', 'cuando', `${fechaCorta(new Date(a.created_at).toISOString())} · ${nombreDe(a.autor_email)}`));
    r.appendChild(el('span', 'qué', a.texto));
    const x = el('button', 'x', '✕'); x.title = 'Borrar avance';
    x.onclick = async () => {
      const { error } = await sb.from('item_avances').delete().eq('id', a.id);
      if (error) aviso(error.message); else await cargar();
    };
    r.appendChild(x);
    caja.appendChild(r);
  });

  const f = el('form', 'av-form');
  const i = el('input'); i.placeholder = 'En qué va…'; i.required = true;
  const b = el('button', null, 'Anotar'); b.type = 'submit';
  f.appendChild(i); f.appendChild(b);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const texto = i.value.trim(); if (!texto) return;
    b.disabled = true;
    const { error } = await sb.from('item_avances').insert({ item_id: it.id, texto });
    b.disabled = false;
    if (error) { aviso(error.message); return; }
    i.value = '';
    await cargar();
  };
  caja.appendChild(f);
  setTimeout(() => { if (!mias.length) i.focus(); }, 0);
  return caja;
}

/* ---------------- edición ---------------- */
function editor (it, s) {
  const box = el('div', 'editor');
  const ta = el('textarea'); ta.value = it.texto;
  box.appendChild(ta);

  const fila1 = el('div', 'fila');
  let fecha = null, resp = null;
  if (s.fecha) { fecha = el('input'); fecha.type = 'date'; fecha.value = it.fecha_acuerdo || ''; fila1.appendChild(fecha); }
  if (s.responsable) { resp = el('select'); opcionesResp(resp, it.responsable || ''); fila1.appendChild(resp); }
  const cancelar = el('button', 'b', 'Cancelar');
  const guardar = el('button', 'b pri der', 'Guardar');
  fila1.appendChild(cancelar); fila1.appendChild(guardar);
  box.appendChild(fila1);

  guardar.onclick = async () => {
    const texto = ta.value.trim(); if (!texto) return;
    const p = { texto };
    if (fecha) p.fecha_acuerdo = fecha.value || null;
    if (resp) p.responsable = resp.value || null;
    editando = null;
    await actualizar(it.id, p);
  };
  cancelar.onclick = () => { editando = null; pintar(); };

  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
  return box;
}

/* ---------------- operaciones ---------------- */
async function actualizar (id, parche) {
  const { error } = await sb.from('items').update(parche).eq('id', id);
  if (error) { aviso(error.message); return; }
  await cargar();
}
async function borrar (id) {
  borrando = null;
  const { error } = await sb.from('items').delete().eq('id', id);
  if (error) { aviso(error.message); return; }
  await cargar();
}
async function alternar (it) {
  if (it.section === 'completada') {
    await actualizar(it.id, { section: it.seccion_previa || 'en_curso', seccion_previa: null });
  } else {
    await actualizar(it.id, { section: 'completada', seccion_previa: it.section });
  }
}

function aviso (texto) {
  const n = el('div', 'msj error', texto);
  Object.assign(n.style, {
    position:'fixed', left:'50%', transform:'translateX(-50%)',
    bottom:'calc(1rem + env(safe-area-inset-bottom))', zIndex:90,
    maxWidth:'92vw', background:'var(--papel)',
    boxShadow:'0 6px 24px rgba(36,29,20,.16)'
  });
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 5000);
}

/* ---------------- accesos ---------------- */
function abrirAjustes () {
  $('#velo-ajustes').hidden = false;
  limpia($('#ajustes-msj'));
  pintarCorreos();
}
function pintarCorreos () {
  const ul = $('#lista-correos'); ul.innerHTML = '';
  permitidos.forEach(p => {
    const li = el('li');
    const q = el('div', 'quien');
    q.innerHTML = `<strong>${p.label || '—'}</strong> <span>${p.email}</span>`;
    li.appendChild(q);
    if (p.email === (sesion.user.email || '').toLowerCase()) {
      li.appendChild(el('span', 'et', 'tú'));
    } else {
      const b = el('button', 'mn rojo');
      b.innerHTML = svg(ICO.borrar); b.title = 'Quitar acceso';
      b.onclick = async () => {
        const { error } = await sb.from('allowed_emails').delete().eq('email', p.email);
        if (error) msj($('#ajustes-msj'), error.message, 'error');
        await cargar(); pintarCorreos();
      };
      li.appendChild(b);
    }
    ul.appendChild(li);
  });
}
async function agregarCorreo () {
  const email = $('#nuevo-correo').value.trim().toLowerCase();
  const label = $('#nuevo-nombre').value.trim();
  const n = $('#ajustes-msj');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msj(n, 'Ese correo no se ve válido.', 'error'); return; }
  const { error } = await sb.from('allowed_emails')
    .insert({ email, label: label || email.split('@')[0], added_by: sesion.user.email });
  if (error) { msj(n, error.message, 'error'); return; }
  $('#nuevo-correo').value = ''; $('#nuevo-nombre').value = '';
  msj(n, `${email} ya puede pedir su link de acceso.`, 'ok');
  await cargar(); pintarCorreos();
}

/* ---------------- service worker ---------------- */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
