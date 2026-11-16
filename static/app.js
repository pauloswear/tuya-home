// Tuya Dash — SPA sem build. Rotas por hash: #/ · #/consumo · #/cenas · #/tomada/<id>
/* global Charts */

const $app = document.getElementById("app");
const S = {
  auth: null,
  homes: [],
  devices: new Map(),
  live: false,
  updatedAt: null,
  range: "today",          // detalhe e consumo
  tariff: Number(safeGet("tariff")) || 0.903, // CEMIG B1 residencial, Ipatinga/MG (homologada ANEEL, bandeira verde, s/ impostos)
  detail: {},              // id -> dados com local key
  revealKey: false,
  scenes: null,
  todayKwh: new Map(),     // id -> kWh de hoje (arredondado como exibido)
  sort: (() => { try { return JSON.parse(safeGet("sort")) || { key: "power", dir: "desc" }; } catch { return { key: "power", dir: "desc" }; } })(),
};

// ------------------------------------------------------------------ utils
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* sem storage */ } }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = (d) => new Intl.NumberFormat("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
const F = {
  w: (v) => (v == null ? null : nf(1).format(v)),
  v: (v) => (v == null ? null : nf(0).format(v)),
  a: (v) => (v == null ? null : nf(2).format(v)),
  kwh: (v) => (v == null ? null : nf(3).format(v)),
  brl: (v) => (v == null ? null : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v)),
  pct: (v) => new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 0 }).format(v),
  time: (t) => new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(t),
  day: (t) => new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(t),
  dayTime: (t) => new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(t),
};
// figure with grey unit; a missing value is a grey dash
const fig = (val, unit) => (val == null ? '<span class="dash">—</span>' : `${val}${unit ? `<small> ${unit}</small>` : ""}`);
const cell = (val, unit) => (val == null ? '<span class="dash">—</span>' : `${val}<span class="dash"> ${unit}</span>`);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch { /* corpo não-JSON */ }
    const err = new Error(msg); err.status = res.status;
    if (res.status === 401 && !path.startsWith("/api/session")) { renderAuth(); }
    throw err;
  }
  return res.json();
}

let toastTimer;
function toast(msg, isErr = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), 3600);
}

// ------------------------------------------------------------------ tema
const media = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const pref = safeGet("theme") || "auto";
  const dark = pref === "dark" || (pref === "auto" && media.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
media.addEventListener("change", applyTheme);
applyTheme();

// ------------------------------------------------------- dicionário de DPs
const LABELS = {
  switch: "Ligada", switch_1: "Tomada", switch_2: "Tomada 2", switch_3: "Tomada 3", switch_usb1: "USB",
  switch_led: "Luz", countdown: "Temporizador", countdown_1: "Temporizador",
  relay_status: "Ao voltar a energia", light_mode: "LED indicador", child_lock: "Bloqueio infantil",
  cur_power: "Potência", cur_voltage: "Tensão", cur_current: "Corrente", add_ele: "Último incremento de energia",
  work_mode: "Modo", bright_value: "Brilho", bright_value_v2: "Brilho", temp_value: "Temperatura de cor",
  temp_value_v2: "Temperatura de cor", colour_data: "Cor", colour_data_v2: "Cor",
  cycle_time: "Agenda cíclica", random_time: "Agenda aleatória", fault: "Falhas",
  voltage_coe: "Calibração de tensão", electric_coe: "Calibração de corrente", power_coe: "Calibração de potência",
  electricity_coe: "Calibração de energia", overcharge_switch: "Proteção de sobrecarga", do_not_disturb: "Não perturbe",
};
const HINTS = {
  relay_status: "Estado da tomada depois de uma queda de luz",
  light_mode: "O que o LED da tomada mostra",
  child_lock: "Desativa o botão físico da tomada",
  countdown_1: "Inverte o estado da tomada ao terminar",
  countdown: "Inverte o estado ao terminar",
};
const ENUMS = {
  relay_status: { power_off: "Desligada", power_on: "Ligada", last: "Como estava", off: "Desligada", on: "Ligada", memory: "Como estava", 0: "Desligada", 1: "Ligada", 2: "Como estava" },
  light_mode: { none: "Apagado", relay: "Mostra o estado", pos: "Localizador", relay_reverse: "Estado invertido" },
  work_mode: { white: "Branco", colour: "Colorido", scene: "Cena", music: "Música" },
};
const FAULTS = { ov_cr: "sobrecorrente", ov_vol: "sobretensão", ov_pwr: "sobrepotência", ls_cr: "subcorrente", ls_vol: "subtensão", ls_pow: "subpotência" };
const HIDDEN_IN_STATE = new Set(["cur_power", "cur_voltage", "cur_current"]);
const label = (code, name) => LABELS[code] || (name && name !== code ? name : code.replace(/_/g, " "));
const enumLabel = (code, v) => ENUMS[code]?.[v] ?? v;

const dp = (dev, code) => dev.dps.find((d) => d.code === code);
const firstDp = (dev, codes) => codes.map((c) => dp(dev, c)).find(Boolean);
const mainSwitch = (dev) => firstDp(dev, ["switch_led", "switch_1", "switch", "switch_2"]);
const isOn = (dev) => !!mainSwitch(dev)?.value;
const powerOf = (dev) => (dev.online ? dev.metering?.power_w ?? null : null);
// tomadas aninhadas: uma ligada dentro de outra (ex.: Ventilador numa régua na tomada Quarto).
// A de dentro já está na medição da de fora, então só as de fora entram nos totais.
const parentOf = (d) => { const p = d.parent_id && S.devices.get(d.parent_id); return p && p.metering ? p : null; };
const childrenOf = (d) => [...S.devices.values()].filter((c) => c.metering && c.parent_id === d.id);
const isTop = (d) => !parentOf(d);
// potência só desta tomada, sem as de dentro (nunca negativa: as leituras não são simultâneas)
const ownPowerOf = (d) => { const p = powerOf(d); return p == null ? null : Math.max(0, p - childrenOf(d).reduce((s, c) => s + (powerOf(c) || 0), 0)); };
const sorted = () => [...S.devices.values()].sort((a, b) => (powerOf(b) ?? -1) - (powerOf(a) ?? -1) || a.name.localeCompare(b.name, "pt-BR"));

// ------------------------------------------------------------------ ícones (contorno 1,5px)
const I = {
  mark: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="var(--data)"/><path d="M13.4 4.3 7.6 13.1h3.4l-.9 6.6 5.9-9.1h-3.6z" fill="#fff"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m10 8.5 5 3.5-5 3.5z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/></svg>',
  menu: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>',
  unlink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 15 6.5 17.5a3.5 3.5 0 0 1-5-5L4 10M15 9l2.5-2.5a3.5 3.5 0 0 1 5 5L20 14M8 8 3 3M21 21l-5-5"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
};

// =================================================================== dados
async function boot() {
  const sess = await api("/api/session").catch(() => null);
  if (!sess) { $app.innerHTML = '<main class="login" id="view"><p class="empty-note">Não foi possível falar com o servidor. Recarregue a página.</p></main>'; return; }
  if (!sess.authenticated) return renderAuth(sess);
  S.user = sess.email;
  S.auth = await api("/api/auth/status").catch(() => ({ connected: false }));
  if (!S.auth.connected) return renderLogin();
  await loadDevices();
  connectEvents();
  if (S.auth.storage_error) toast(S.auth.storage_error, true);
}

async function loadDevices() {
  try {
    const data = await api("/api/devices");
    S.homes = data.homes;
    S.devices = new Map(data.devices.map((d) => [d.id, d]));
    S.updatedAt = new Date();
    if (!document.querySelector(".app")) renderShell();
    route();
  } catch (e) {
    if (e.status === 409) { S.auth = { connected: false }; renderLogin(); } else if (e.status !== 401) toast(e.message, true);
  }
}

let es;
function connectEvents() {
  es?.close();
  es = new EventSource("/api/events");
  es.onopen = () => { S.live = true; paintLive(); };
  es.onerror = () => { S.live = false; paintLive(); };
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === "device") {
      S.devices.set(ev.device.id, ev.device);
      S.updatedAt = new Date();
      paintNav();
      scheduleRender();
    } else if (ev.type === "poll") {
      document.querySelectorAll(".sync").forEach((el) => el.classList.toggle("spinning", ev.state === "start"));
      if (ev.state === "end") { if (ev.ok) S.updatedAt = new Date(ev.at * 1000); paintLive(); paintStamp(); }
    } else if (ev.type === "reload") {
      loadDevices();
    } else if (ev.type === "auth" && !ev.connected) {
      S.auth = { connected: false }; renderLogin();
    }
  };
}

// re-render the view on live data, but never under the user's hands
let renderTimer;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    const a = document.activeElement;
    const busy = a && document.getElementById("view")?.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.type !== "checkbox";
    if (busy) return scheduleRender();
    route({ soft: true });
  }, 500);
}

// ============================================================ LOGIN DO PAINEL
async function renderAuth(sess) {
  es?.close();
  sess = sess || (await api("/api/session").catch(() => ({ needs_setup: false, available: true })));
  const setup = sess.needs_setup;
  $app.innerHTML = `
  <main class="login" id="view">
    <section class="panel">
      <div class="brand" style="padding:0">${I.mark}<b>Tuya Dash</b></div>
      <h1>${setup ? "Criar o acesso ao painel" : "Entrar"}</h1>
      <p class="note" style="font-size:14px">${setup
        ? "Ainda não há acesso cadastrado. O e-mail e a senha criados aqui passam a ser a única forma de entrar no painel."
        : sess.available === false ? "O banco de usuários está indisponível agora. Verifique a conexão com o MySQL." : "Use o e-mail e a senha cadastrados no painel."}</p>
      <form id="authForm" style="display:grid;gap:14px;margin-top:20px" novalidate>
        <div class="field"><label for="email">E-mail</label>
          <input class="input" id="email" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" required maxlength="254" placeholder="voce@exemplo.com…" /></div>
        <div class="field"><label for="password">Senha</label>
          <input class="input" id="password" name="password" type="password" autocomplete="${setup ? "new-password" : "current-password"}" required minlength="${setup ? 8 : 1}" maxlength="72" />
          ${setup ? '<span class="hint">Pelo menos 8 caracteres.</span>' : ""}</div>
        ${setup ? `<div class="field"><label for="password2">Repita a senha</label>
          <input class="input" id="password2" name="password2" type="password" autocomplete="new-password" required maxlength="72" /></div>` : ""}
        <p id="authErr" class="note" style="color:var(--negative);font-size:14px;min-height:20px" role="alert"></p>
        <button class="btn primary" type="submit" style="height:40px">${setup ? "Criar usuário e entrar" : "Entrar"}</button>
      </form>
    </section>
  </main>`;
  const f = document.getElementById("authForm"), err = document.getElementById("authErr");
  f.email.focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = "";
    const email = f.email.value.trim().toLowerCase(), password = f.password.value;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) { err.textContent = "Informe um e-mail válido."; f.email.focus(); return; }
    if (setup && password.length < 8) { err.textContent = "A senha precisa ter pelo menos 8 caracteres."; f.password.focus(); return; }
    if (setup && password !== f.password2.value) { err.textContent = "As senhas não são iguais."; f.password2.focus(); return; }
    const btn = f.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = setup ? "Criando…" : "Entrando…";
    try {
      await api(setup ? "/api/session/setup" : "/api/session/login", { method: "POST", body: { email, password } });
      $app.innerHTML = ""; boot();
    } catch (ex) {
      err.textContent = ex.message; f.password.value = ""; f.password.focus();
      btn.disabled = false; btn.textContent = setup ? "Criar usuário e entrar" : "Entrar";
    }
  };
}

// ============================================================ CONTA TUYA (QR)
function renderLogin() {
  es?.close();
  $app.innerHTML = `
  <main class="login" id="view">
    <section class="panel">
      <div class="brand" style="padding:0">${I.mark}<b>Tuya Dash</b></div>
      <h1>Conectar sua conta Tuya</h1>
      <p class="note" style="font-size:14px">A autorização é feita pelo app Tuya Smart no seu celular. Nenhuma senha passa por aqui.</p>
      <ol>
        <li>No app, abra <b>Eu → Configurações → Conta e segurança</b> e copie o <b>Código de usuário</b>.</li>
        <li>Cole o código abaixo e gere o QR code.</li>
        <li>No app, toque em <b>Escanear</b> e leia o QR (ou escolha a imagem pelo <b>Álbum</b>). Depois toque em <b>Confirm login</b>.</li>
      </ol>
      <form id="qrForm">
        <label for="userCode" style="font-weight:500">Código de usuário</label>
        <div class="join">
          <input class="input" id="userCode" name="user_code" autocomplete="off" spellcheck="false" placeholder="ex.: BxYCXsv…" required />
          <button class="btn primary" type="submit">Gerar QR</button>
        </div>
      </form>
      <div id="qrBox" aria-live="polite"></div>
    </section>
  </main>`;
  let pollTimer;
  document.getElementById("qrForm").onsubmit = async (e) => {
    e.preventDefault();
    clearInterval(pollTimer);
    const btn = e.target.querySelector("button");
    const box = document.getElementById("qrBox");
    btn.disabled = true; btn.textContent = "Gerando…";
    try {
      const { token, qr } = await api("/api/auth/qr", { method: "POST", body: { user_code: document.getElementById("userCode").value } });
      box.innerHTML = `<div class="qr"><img src="${qr}" width="220" height="220" alt="QR code de autorização para o app Tuya Smart" /><p id="qrStatus">Aguardando a confirmação no app…</p></div>`;
      const started = Date.now();
      pollTimer = setInterval(async () => {
        if (Date.now() - started > 5 * 60_000) {
          clearInterval(pollTimer);
          document.getElementById("qrStatus").textContent = "O QR expirou. Gere outro para tentar de novo.";
          return;
        }
        try {
          const r = await api(`/api/auth/poll/${encodeURIComponent(token)}`);
          if (r.connected) { clearInterval(pollTimer); toast("Conta conectada"); $app.innerHTML = ""; boot(); }
        } catch (err) { clearInterval(pollTimer); toast(err.message, true); }
      }, 2500);
    } catch (err) {
      box.innerHTML = `<p class="note" style="color:var(--negative);margin-top:12px">${esc(err.message)}. Confira o código em Conta e segurança.</p>`;
    } finally { btn.disabled = false; btn.textContent = "Gerar QR"; }
  };
}

// ============================================================ CONFIRMAÇÃO
// Modal nativo (<dialog>): prende o foco, fecha com Esc e devolve o foco a quem abriu.
function confirmDialog({ title, body, confirm = "Confirmar", cancel = "Cancelar", danger = false, icon = "" }) {
  return new Promise((resolve) => {
    const back = document.activeElement;
    const dlg = document.createElement("dialog");
    dlg.className = "confirm";
    dlg.setAttribute("aria-labelledby", "dlgTitle");
    dlg.setAttribute("aria-describedby", "dlgBody");
    dlg.innerHTML = `
      <form method="dialog">
        ${icon ? `<span class="dlg-icon${danger ? " danger" : ""}" aria-hidden="true">${icon}</span>` : ""}
        <h2 id="dlgTitle">${esc(title)}</h2>
        <p id="dlgBody">${esc(body)}</p>
        <div class="dlg-actions">
          <button class="btn dlg-btn" value="cancel" autofocus>${esc(cancel)}</button>
          <button class="btn dlg-btn ${danger ? "danger-fill" : "primary"}" value="ok">${esc(confirm)}</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close("cancel"); }); // clique fora
    dlg.addEventListener("close", () => {
      const ok = dlg.returnValue === "ok";
      dlg.remove();
      if (!ok) back?.focus?.();
      resolve(ok);
    });
    dlg.showModal();
  });
}

// ================================================================== SHELL
function renderShell() {
  $app.innerHTML = `
  <div class="app">
    <aside class="sidebar" id="sidebar" aria-label="Navegação">
      <div class="side-head">
        <div class="brand" style="flex:1">${I.mark}<b>Tuya Dash</b></div>
        <button class="btn ghost close-menu" id="closeMenu" aria-label="Fechar menu">${I.close}</button>
      </div>
      <nav class="main-nav" style="display:grid;gap:1px">
        <a class="nav-item" href="#/">${I.home}<span class="label">Visão geral</span></a>
        <a class="nav-item" href="#/consumo">${I.bolt}<span class="label">Consumo</span></a>
        <a class="nav-item" href="#/cenas">${I.play}<span class="label">Cenas</span></a>
      </nav>
      <div class="devices-group">
        <div class="group-label">Tomadas</div>
        <nav id="navDevices" style="display:grid;gap:1px" aria-label="Tomadas"></nav>
      </div>
      <footer class="sidebar-foot" title="As tomadas são lidas a cada 5 s">
        <span class="sync" aria-hidden="true">${I.refresh}</span><span class="stamp num" id="stamp" aria-live="off">Conectando…</span>
      </footer>
    </aside>
    <div style="min-width:0">
      <header class="topbar">
        <button class="btn ghost menu-btn" id="openMenu" aria-label="Abrir menu" aria-controls="sidebar" aria-expanded="false">${I.menu}</button>
        <b id="mobileTitle" class="mobile-title">Tuya Dash</b>
        <div class="user-menu">
          <button class="user-btn" id="userBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="userMenu">
            <span class="avatar" aria-hidden="true">${esc((S.user || "?")[0].toUpperCase())}</span>
            <span class="user-email" translate="no">${esc(S.user || "")}</span>${I.chevron}
          </button>
          <div class="menu" id="userMenu" role="menu" hidden>
            <div class="menu-head">Conectado como<b translate="no">${esc(S.user || "")}</b></div>
            <button role="menuitem" class="menu-item" id="themeBtn">${I.moon}<span id="themeLabel"></span></button>
            <button role="menuitem" class="menu-item" id="signOut">${I.out}Sair do painel</button>
            <div class="menu-sep" role="separator"></div>
            <button role="menuitem" class="menu-item danger" id="logoutBtn">${I.unlink}Desconectar conta Tuya</button>
          </div>
        </div>
      </header>
      <main class="canvas" id="view" tabindex="-1"></main>
    </div>
  </div>`;
  const sb = document.getElementById("sidebar");
  const openBtn = document.getElementById("openMenu");
  const setMenu = (open) => { sb.classList.toggle("open", open); openBtn.setAttribute("aria-expanded", open); };
  openBtn.onclick = () => setMenu(true);
  document.getElementById("closeMenu").onclick = () => setMenu(false);
  sb.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
  document.getElementById("themeBtn").onclick = (e) => {
    e.stopPropagation();
    const order = ["auto", "light", "dark"];
    const next = order[(order.indexOf(safeGet("theme") || "auto") + 1) % 3];
    safeSet("theme", next); applyTheme(); paintTheme(); route({ soft: true });
  };
  const ub = document.getElementById("userBtn"), um = document.getElementById("userMenu");
  const setUser = (open) => { um.hidden = !open; ub.setAttribute("aria-expanded", open); if (open) um.querySelector("[role=menuitem]").focus(); };
  ub.onclick = (e) => { e.stopPropagation(); setUser(um.hidden); };
  document.addEventListener("click", (e) => { if (!um.hidden && !e.target.closest(".user-menu")) setUser(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !um.hidden) { setUser(false); ub.focus(); } });
  um.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...um.querySelectorAll("[role=menuitem]")], i = items.indexOf(document.activeElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
  });
  document.getElementById("signOut").onclick = async () => {
    setUser(false);
    const ok = await confirmDialog({
      title: "Sair do painel?",
      icon: I.out,
      body: "Você vai precisar do e-mail e da senha para entrar de novo. As tomadas continuam funcionando normalmente.",
      confirm: "Sair",
    });
    if (!ok) return;
    await api("/api/session/logout", { method: "POST" }).catch(() => {});
    S.user = null; renderAuth();
  };
  document.getElementById("logoutBtn").onclick = async () => {
    setUser(false);
    const ok = await confirmDialog({
      title: "Desconectar a conta Tuya?",
      icon: I.unlink,
      body: "O painel deixa de ver e controlar suas tomadas e para de gravar o consumo. Para voltar, será preciso ler um novo QR code no app Tuya Smart. O histórico já gravado é mantido.",
      confirm: "Desconectar",
      danger: true,
    });
    if (!ok) return;
    try { await api("/api/auth/logout", { method: "POST" }); renderLogin(); }
    catch (e) { toast(`${e.message}. Tente de novo.`, true); }
  };
  paintTheme(); paintLive(); paintNav();
}

function paintStamp() {
  const el = document.getElementById("stamp");
  if (el && S.updatedAt) el.textContent = `Atualizado às ${new Intl.DateTimeFormat("pt-BR", { timeStyle: "medium" }).format(S.updatedAt)}`;
}
function paintTheme() {
  const t = safeGet("theme") || "auto";
  const el = document.getElementById("themeLabel");
  if (el) el.textContent = { auto: "Tema: automático", light: "Tema: claro", dark: "Tema: escuro" }[t];
}
function paintLive() { paintStamp(); }
function paintNav() {
  const nav = document.getElementById("navDevices");
  if (!nav) return;
  nav.innerHTML = sorted().map((d) => {
    const p = powerOf(d);
    const state = !d.online ? "offline" : isOn(d) ? "on" : "";
    return `<a class="nav-item" href="#/tomada/${encodeURIComponent(d.id)}" title="${esc(d.name)}${d.online ? "" : " (offline)"}">
      <span class="state ${state}" aria-hidden="true"></span><span class="label">${esc(d.name)}</span>
      <span class="val">${!d.online ? "offline" : p == null ? "" : `${F.w(p)} W`}</span></a>`;
  }).join("");
  markNav();
  paintLive();
}
function markNav() {
  const h = location.hash || "#/";
  document.querySelectorAll(".sidebar .nav-item[href]").forEach((a) => {
    const href = a.getAttribute("href");
    a.toggleAttribute("aria-current", href === h);
    if (href === h) a.setAttribute("aria-current", "page");
  });
}

// ================================================================== ROUTER
function route({ soft = false } = {}) {
  if (!document.querySelector(".app")) return;
  const h = location.hash.replace(/^#/, "") || "/";
  markNav();
  const view = document.getElementById("view");
  const scroll = soft ? window.scrollY : 0;
  let title = "Visão geral";
  if (h.startsWith("/tomada/")) {
    const d = S.devices.get(decodeURIComponent(h.slice(8)));
    title = d?.name || "Tomada";
    viewDevice(view, d, soft);
  } else if (h === "/consumo") { title = "Consumo"; viewEnergy(view, soft); }
  else if (h === "/cenas") { title = "Cenas"; viewScenes(view, soft); }
  else viewOverview(view, soft);
  document.title = `${title} · Tuya Dash`;
  document.getElementById("mobileTitle").textContent = title;
  if (!soft) { window.scrollTo(0, 0); view.focus({ preventScroll: true }); } else window.scrollTo(0, scroll);
}
S.navDepth = 0;
window.addEventListener("hashchange", () => { S.navDepth++; route(); });

// --------------------------------------------------------------- comandos
async function send(id, commands, okMsg) {
  try {
    await api(`/api/devices/${encodeURIComponent(id)}/commands`, { method: "POST", body: { commands } });
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(`${e.message}. Confira se a tomada está online e tente de novo.`, true);
    loadDevices();
  }
}
function toggleHtml(d, sw, extra = "") {
  return `<label class="toggle" ${extra}><input type="checkbox" data-toggle="${esc(d.id)}" ${sw.value ? "checked" : ""} ${d.online ? "" : "disabled"} aria-label="${sw.value ? "Desligar" : "Ligar"} ${esc(d.name)}"><span></span></label>`;
}
function wireToggles(root) {
  root.querySelectorAll("[data-toggle]").forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("change", () => {
      const d = S.devices.get(el.dataset.toggle);
      send(d.id, [{ code: mainSwitch(d).code, value: el.checked }], `${d.name} ${el.checked ? "ligada" : "desligada"}`);
    });
  });
}

// ---------------------------------------------------------------- séries
const energyCache = new Map();
async function getJSON(url, maxAge = 20_000) {
  const hit = energyCache.get(url);
  if (hit && Date.now() - hit.t < maxAge) return hit.v;
  const v = await api(url);
  energyCache.set(url, { t: Date.now(), v });
  return v;
}
// ------------------------------------------------------------ gráfico de área
// Curva suave (monotônica: não inventa picos entre pontos), área com degradê, grade discreta,
// rótulos com unidade e leitura ao passar o mouse/dedo. Intervalos sem leitura ficam vazios.
const STEPS = [60, 300, 900, 1800, 3600, 7200, 10800, 14400, 21600, 43200, 86400, 172800, 604800];
function niceTicks(max, count = 4) {
  if (!(max > 0)) max = 1;
  const raw = max / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw);
  const top = Math.ceil(max / step) * step + (Math.ceil(max / step) * step === max ? step : 0);
  const out = []; for (let v = 0; v <= top + step / 2; v += step) out.push(+v.toFixed(6));
  return out;
}
function monotonePath(pts) {
  // Fritsch–Carlson
  const n = pts.length;
  if (n < 2) return n ? `M${pts[0][0]},${pts[0][1]}` : "";
  const dx = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], h = dx[i] / 3;
    d += `C${(x0 + h).toFixed(1)},${(y0 + t[i] * h).toFixed(1)} ${(x1 - h).toFixed(1)},${(y1 - t[i + 1] * h).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}
let gradSeq = 0;
function areaChart(el, { since, step, values, unit, fmt, height = 220, subtitle }) {
  el.innerHTML = "";
  // começa no primeiro intervalo com leitura (o painel não tem dados de antes)
  const first = values.findIndex((v) => v != null);
  if (first < 0 || values.filter((v) => v != null).length < 2) {
    el.innerHTML = '<p class="empty-note">Ainda sem leituras suficientes neste período. O painel grava a potência a cada 5 s enquanto está rodando.</p>';
    return;
  }
  values = values.slice(first); since += first * step;
  const W = Math.max(280, el.clientWidth || 600), H = height, n = values.length;
  const max = Math.max(...values.filter((v) => v != null));
  const yt = niceTicks(max, 4), top = yt.at(-1);
  const lab = (v) => `${fmt(v)} ${unit}`;
  const tickStep = yt[1] - yt[0];
  const tickLab = (v) => `${nf(tickStep >= 1 ? 0 : tickStep >= 0.1 ? 1 : 2).format(v)} ${unit}`;
  const padL = Math.max(...yt.map((v) => tickLab(v).length)) * 6.6 + 14, padR = 8, padT = 10, padB = 26;
  const x = (i) => padL + (n === 1 ? 0 : (i * (W - padL - padR)) / (n - 1));
  const y = (v) => padT + (1 - v / top) * (H - padT - padB);
  // segmentos contínuos (quebra onde não há leitura)
  const segs = []; let cur = [];
  values.forEach((v, i) => { if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), y(v), i]); });
  if (cur.length) segs.push(cur);
  const gid = `ag${++gradSeq}`, base = y(0);
  const lines = segs.map((sg) => monotonePath(sg)).join("");
  const areas = segs.filter((sg) => sg.length > 1).map((sg) => `${monotonePath(sg)}L${sg.at(-1)[0].toFixed(1)},${base}L${sg[0][0].toFixed(1)},${base}Z`).join("");
  // eixo x em passos redondos de tempo
  const want = W < 420 ? 3 : 6, span = n * step;
  const st = STEPS.find((v) => v >= step && span / v <= want) || STEPS.at(-1);
  const long = span > 2 * 86400;
  const xl = [];
  for (let i = 0; i < n; i++) {
    const t = since + i * step, off = ((t % st) + st) % st;
    if (off < step / 2 || st - off < step / 2) xl.push(i);
  }
  const tLabel = (i) => { const d = new Date((since + i * step) * 1000); return long ? F.day(d) : F.time(d); };
  el.innerHTML = `
    <svg class="area-chart" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(subtitle || "Gráfico")}, de ${tLabel(0)} a ${tLabel(n - 1)}; máximo ${lab(max)}">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--data)" stop-opacity=".38"/><stop offset="100%" stop-color="var(--data)" stop-opacity="0"/></linearGradient></defs>
      ${yt.map((v) => `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${padL - 10}" y="${y(v) + 4}" text-anchor="end">${tickLab(v)}</text>`).join("")}
      <path d="${areas}" fill="url(#${gid})"/>
      <path d="${lines}" class="ln"/>
      ${xl.map((i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${x(i) < padL + 20 ? "start" : x(i) > W - 30 ? "end" : "middle"}">${tLabel(i)}</text>`).join("")}
      <line class="hover-rule" y1="${padT}" y2="${base}" x1="0" x2="0" opacity="0"/>
      <circle class="hover-dot" r="4.5" cx="0" cy="0" opacity="0"/>
      <rect x="${padL}" y="0" width="${W - padL - padR}" height="${H}" fill="transparent" class="hit"/>
    </svg><div class="chart-tip" hidden></div>`;
  const svg = el.querySelector("svg"), tip = el.querySelector(".chart-tip"), rule = svg.querySelector(".hover-rule"), dot = svg.querySelector(".hover-dot");
  const move = (ev) => {
    const r = svg.getBoundingClientRect(), px = ((ev.clientX - r.left) / r.width) * W;
    let i = Math.round(((px - padL) / (W - padL - padR)) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    const v = values[i];
    rule.setAttribute("x1", x(i)); rule.setAttribute("x2", x(i)); rule.setAttribute("opacity", 1);
    dot.setAttribute("cx", x(i)); dot.setAttribute("cy", v == null ? base : y(v)); dot.setAttribute("opacity", v == null ? 0 : 1);
    tip.hidden = false;
    tip.innerHTML = `<span>${tLabel(i)}</span><b>${v == null ? "sem leitura" : lab(v)}</b>`;
    const left = (x(i) / W) * r.width;
    tip.style.left = `${Math.min(Math.max(left - tip.offsetWidth / 2, 0), r.width - tip.offsetWidth)}px`;
  };
  const hit = svg.querySelector(".hit");
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", () => { tip.hidden = true; rule.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); });
}
function drawPower(el, s, height = 220) {
  areaChart(el, { since: s.since, step: s.bucket_seconds, values: s.avg_power_w, unit: "W", fmt: (v) => nf(v >= 100 || v === 0 ? 0 : 1).format(v), height, subtitle: "Potência média" });
}
function drawKwh(el, s, kwh, height = 220) {
  // o último intervalo ainda está em andamento: mostrá-lo pareceria uma queda de consumo
  const closed = s.since + kwh.length * s.bucket_seconds > s.until + 1 ? kwh.slice(0, -1) : kwh;
  areaChart(el, { since: s.since, step: s.bucket_seconds, values: closed.map((v) => (v == null ? null : v * 1000)), unit: "Wh", fmt: (v) => nf(v >= 10 || v === 0 ? 0 : 1).format(v), height, subtitle: "Energia por intervalo" });
}
const RANGE_LABEL = { today: "Hoje", "24h": "24 h", "7d": "7 dias", "30d": "30 dias" };
const rangeSeg = (cur) => `<div class="seg" role="group" aria-label="Período">${Object.entries(RANGE_LABEL).map(([k, l]) => `<button type="button" data-range="${k}" aria-pressed="${cur === k}">${l}</button>`).join("")}</div>`;
function wireRange(root) {
  root.querySelectorAll("[data-range]").forEach((b) => (b.onclick = () => { S.range = b.dataset.range; route({ soft: true }); }));
}

// ======================================================== TABELA DE TOMADAS
const SORT_COLS = [
  { key: "name", label: "Nome" },
  { key: "power", label: "Agora", n: true },
  { key: "voltage", label: "Tensão", n: true, cls: "hide-sm" },
  { key: "kwh", label: "Hoje", n: true },
  { key: "cost", label: "Custo hoje", n: true, cls: "hide-sm" },
];
function sortHead(c) {
  const on = S.sort.key === c.key;
  const aria = on ? `aria-sort="${S.sort.dir === "asc" ? "ascending" : "descending"}"` : "";
  const arrow = on ? (S.sort.dir === "asc" ? "↑" : "↓") : "";
  return `<th class="${c.n ? "n " : ""}${c.cls || ""}" ${aria}><button type="button" class="th-sort${on ? " on" : ""}" data-sort="${c.key}">${c.label}<span class="arrow" aria-hidden="true">${arrow}</span></button></th>`;
}
function sortValue(d, key) {
  const kwh = S.todayKwh.get(d.id);
  switch (key) {
    case "name": return d.name.toLocaleLowerCase("pt-BR");
    case "power": return powerOf(d);
    case "voltage": return d.online ? d.metering?.voltage_v ?? null : null;
    case "kwh": case "cost": return kwh ?? null;
    default: return null;
  }
}
function sortDevices(devs) {
  const { key, dir } = S.sort, sign = dir === "asc" ? 1 : -1;
  return [...devs].sort((a, b) => {
    const va = sortValue(a, key), vb = sortValue(b, key);
    if (va == null && vb == null) return a.name.localeCompare(b.name, "pt-BR");
    if (va == null) return 1;            // sem valor (offline) sempre no fim
    if (vb == null) return -1;
    const c = typeof va === "string" ? va.localeCompare(vb, "pt-BR") : va - vb;
    return c * sign || a.name.localeCompare(b.name, "pt-BR");
  });
}
function outletRows(devs) {
  return sortDevices(devs).map((d) => {
    const sw = mainSwitch(d), p = powerOf(d), m = d.metering || {};
    const kwh = S.todayKwh.get(d.id);
    const brl = kwh == null ? null : Math.round(kwh * S.tariff * 100) / 100;
    return `<tr data-href="#/tomada/${encodeURIComponent(d.id)}">
      <td>${sw ? toggleHtml(d, sw) : ""}</td>
      <td class="name-cell"><a href="#/tomada/${encodeURIComponent(d.id)}"><b>${esc(d.name)}</b></a><span class="sub">${d.online ? (sw ? (sw.value ? "Ligada" : "Desligada") : esc(d.category_label)) : '<span class="pill">offline</span>'}${d.room ? " · " + esc(d.room) : ""}${parentOf(d) ? ` · dentro de ${esc(parentOf(d).name)}` : ""}</span></td>
      <td class="n num">${d.online ? cell(F.w(p), "W") : '<span class="dash">—</span>'}</td>
      <td class="n num hide-sm">${d.online ? cell(F.v(m.voltage_v), "V") : '<span class="dash">—</span>'}</td>
      <td class="n num">${kwh == null ? '<span class="dash">—</span>' : kwh ? cell(F.kwh(kwh), "kWh") : '<span class="zero">0 kWh</span>'}</td>
      <td class="n num hide-sm">${brl == null ? '<span class="dash">—</span>' : brl ? F.brl(brl) : `<span class="zero">${F.brl(0)}</span>`}</td></tr>`;
  }).join("");
}
function wireOutlets(view) {
  view.querySelectorAll("tr[data-href]").forEach((tr) => (tr.onclick = (e) => { if (!e.target.closest("a,label")) location.hash = tr.dataset.href; }));
  wireToggles(view.querySelector("#outletRows") || view);
}

// ============================================================== VISÃO GERAL
async function viewOverview(view, soft) {
  const devs = sorted();
  const metered = devs.filter((d) => d.metering);
  const total = metered.filter(isTop).reduce((s, d) => s + (powerOf(d) || 0), 0);
  // divisão sem contar em dobro: cada tomada entra com a parte só dela
  const parts = metered.map((d) => ({ d, w: ownPowerOf(d), name: childrenOf(d).length ? `${d.name} (resto)` : d.name }))
    .filter((x) => x.w > 0).sort((a, b) => b.w - a.w);
  const top = parts[0];
  const onCount = devs.filter(isOn).length;
  const offline = devs.filter((d) => !d.online);
  const finding = top && total > 0
    ? `<b>${esc(top.name)}</b> puxa ${F.pct(top.w / total)} da potência agora: ${F.w(top.w)} de ${F.w(total)} W.`
    : "Nenhuma tomada está consumindo agora.";
  const offlineNote = offline.length ? ` ${offline.map((d) => esc(d.name)).join(", ")} ${offline.length > 1 ? "estão" : "está"} offline.` : "";

  view.innerHTML = `
    <div class="title-row">
      <div><h1>Visão geral</h1><p class="sub">${finding}${offlineNote}</p></div>
      <div class="title-actions"><button class="btn" id="refreshBtn">${I.refresh}Recarregar tudo</button></div>
    </div>
    <section class="kpis" aria-label="Resumo de hoje">
      <div class="kpi lead"><div class="kpi-label">Potência agora</div><div class="kpi-value num">${fig(F.w(total), "W")}</div><div class="delta">${onCount} de ${devs.length} tomadas ligadas</div></div>
      <div class="kpi"><div class="kpi-label">Consumo hoje</div><div class="kpi-value num" id="kToday"><span class="dash">—</span></div><div class="delta">desde 00:00</div></div>
      <div class="kpi"><div class="kpi-label">Custo hoje</div><div class="kpi-value num money" id="kCost"><span class="dash">—</span></div><div class="delta">a ${F.brl(S.tariff)}/kWh</div></div>
      <div class="kpi"><div class="kpi-label">Projeção para 30 dias</div><div class="kpi-value num money" id="kProj"><span class="dash">—</span></div><div class="delta">no ritmo da potência atual</div></div>
    </section>
    <section class="panel" style="margin-bottom:var(--gap)" aria-labelledby="hSplit">
      <header><h2 id="hSplit">Para onde vai a potência agora</h2><span class="meta num">${fig(F.w(total), "W")} no total</span></header>
      ${total > 0 ? `<div class="split" role="img" aria-label="Divisão da potência entre as tomadas">${parts.map((x, i) => `<i class="${i === 0 ? "lead" : ""}" style="flex:${x.w}" title="${esc(x.name)}: ${F.w(x.w)} W"></i>`).join("")}</div>
        <div class="split-legend">${parts.map((x, i) => `<span><i class="sw ${i === 0 ? "lead" : ""}"></i>${esc(x.name)} <b>${F.w(x.w)} W</b> · ${F.pct(x.w / total)}</span>`).join("")}</div>`
        : '<p class="empty-note">Todas as tomadas estão em 0 W.</p>'}
    </section>
    <div class="grid top">
      <section class="panel flush span-8" aria-labelledby="hOutlets">
        <header><h2 id="hOutlets">Tomadas</h2><span class="meta">${devs.length} na casa · toque na linha para detalhes</span></header>
        <div class="table-wrap"><table class="outlets">
          <thead><tr><th><span class="sr-only">Ligar</span></th>${SORT_COLS.map((c) => sortHead(c)).join("")}</tr></thead>
          <tbody id="outletRows">${outletRows(devs)}</tbody></table></div>
      </section>
      <div class="stack span-4">
        <section class="panel" aria-labelledby="hPower">
          <header><h2 id="hPower">Potência</h2><span class="meta" id="hPowerMeta">hoje, a cada 15 min</span></header>
          <div class="chart" id="cToday" style="min-height:200px"></div>
        </section>
        <section class="panel" aria-labelledby="hScenes">
          <header><h2 id="hScenes">Cenas</h2><a class="card-link" href="#/cenas">Todas</a></header>
          <div class="rows" id="sceneRows"><p class="note">Carregando…</p></div>
        </section>
      </div>
    </div>`;

  paintStamp();
  view.querySelector("#refreshBtn").onclick = async (e) => {
    e.currentTarget.disabled = true;
    try { await api("/api/refresh", { method: "POST" }); energyCache.clear(); await loadDevices(); toast("Dados recarregados da nuvem"); }
    catch (err) { toast(err.message, true); }
  };
  wireOutlets(view);
  view.querySelectorAll("[data-sort]").forEach((b) => (b.onclick = () => {
    const k = b.dataset.sort;
    S.sort = S.sort.key === k ? { key: k, dir: S.sort.dir === "asc" ? "desc" : "asc" } : { key: k, dir: k === "name" ? "asc" : "desc" };
    safeSet("sort", JSON.stringify(S.sort));
    route({ soft: true });
  }));

  // figures that need the history
  try {
    const [sum, tot] = await Promise.all([getJSON("/api/energy/summary?range=today"), getJSON("/api/energy/total?range=today")]);
    if (!view.isConnected) return;
    // the total is the sum of the rows as shown
    const rows = sum.devices.map((r) => ({ ...r, kwhR: Math.round(r.kwh * 1000) / 1000 }));
    const outer = rows.filter((r) => !r.parent_id); // as de dentro já estão na medição da de fora
    const kwh = outer.reduce((s, r) => s + r.kwhR, 0);
    const cost = outer.reduce((s, r) => s + Math.round(r.kwhR * S.tariff * 100) / 100, 0);
    view.querySelector("#kToday").innerHTML = fig(F.kwh(kwh), "kWh");
    view.querySelector("#kCost").innerHTML = F.brl(cost);
    view.querySelector("#kProj").innerHTML = F.brl((total / 1000) * 24 * 30 * S.tariff);
    S.todayKwh = new Map(rows.map((r) => [r.id, r.kwhR]));
    view.querySelector("#outletRows").innerHTML = outletRows(devs);
    wireOutlets(view);
    let series = tot;
    if (tot.avg_power_w.filter((v) => v != null).length < 3) {
      // pouco histórico hoje: mostra a última hora em blocos de 1 min
      series = await getJSON("/api/energy/total?range=1h");
      view.querySelector("#hPowerMeta").textContent = "última hora, por minuto";
    }
    drawPower(view.querySelector("#cToday"), series, 200);
  } catch (e) { view.querySelector("#cToday").innerHTML = `<p class="empty-note">Não foi possível carregar o histórico: ${esc(e.message)}. <button class="linkish" onclick="location.reload()">Tentar de novo</button></p>`; }

  try {
    const scenes = S.scenes || (S.scenes = await api("/api/scenes"));
    if (!view.isConnected) return;
    view.querySelector("#sceneRows").innerHTML = scenes.length
      ? scenes.slice(0, 4).map(sceneRow).join("")
      : '<p class="empty-note">Nenhuma cena de toque na conta.</p>';
    wireScenes(view);
  } catch (e) { view.querySelector("#sceneRows").innerHTML = `<p class="empty-note">Cenas indisponíveis: ${esc(e.message)}</p>`; }
}

// ================================================================ TOMADA
async function viewDevice(view, d, soft) {
  if (!d) { view.innerHTML = '<div class="title-row"><div><h1>Tomada não encontrada</h1><p class="sub">Ela pode ter sido removida da conta. <a class="linkish" href="#/">Voltar à visão geral</a></p></div></div>'; return; }
  const sw = mainSwitch(d), m = d.metering || {}, p = powerOf(d);
  const isRaw = (x) => ["String", "Json", "Raw"].includes(x.type) && !/^colou?r_data/.test(x.code);
  const writable = d.dps.filter((x) => x.writable && x !== sw && !isRaw(x));
  const advanced = d.dps.filter((x) => x.writable && isRaw(x));
  const state = d.dps.filter((x) => !x.writable && !HIDDEN_IN_STATE.has(x.code));
  if (!S.detail[d.id]) api(`/api/devices/${encodeURIComponent(d.id)}`).then((x) => { S.detail[d.id] = x; scheduleRender(); }).catch(() => {});
  const info = S.detail[d.id];
  const status = !d.online ? "offline" : sw ? (sw.value ? "ligada" : "desligada") : "online";
  const kids = d.metering ? childrenOf(d) : [];

  view.innerHTML = `
    <div class="title-row">
      <div class="with-back"><button class="btn back" id="backBtn" aria-label="Voltar">${I.back}</button>
      <div><h1>${esc(d.name)}</h1>
        <p class="sub">${esc(d.category_label)}${d.room ? " · " + esc(d.room) : ""} · ${status}. ${d.online && p != null ? `Puxando <b>${F.w(p)} W</b> agora.` : ""}${kids.length ? ` A medição inclui ${kids.map((c) => esc(c.name)).join(", ")}.` : ""}</p></div>
      </div>
      <div class="title-actions">${sw ? `<label class="power-switch" for="powerToggle"><span>${!d.online ? "Offline" : sw.value ? "Ligada" : "Desligada"}</span>
        <span class="toggle big"><input type="checkbox" id="powerToggle" data-toggle="${esc(d.id)}" ${sw.value ? "checked" : ""} ${d.online ? "" : "disabled"} aria-label="${sw.value ? "Desligar" : "Ligar"} ${esc(d.name)}"><span></span></span></label>` : ""}</div>
    </div>
    ${d.metering ? `
    <section class="kpis" aria-label="Leituras">
      <div class="kpi lead"><div class="kpi-label">Potência</div><div class="kpi-value num">${d.online ? fig(F.w(m.power_w), "W") : '<span class="dash">—</span>'}</div></div>
      <div class="kpi"><div class="kpi-label">Tensão</div><div class="kpi-value num">${d.online ? fig(F.v(m.voltage_v), "V") : '<span class="dash">—</span>'}</div></div>
      <div class="kpi"><div class="kpi-label">Corrente</div><div class="kpi-value num">${d.online ? fig(F.a(m.current_a), "A") : '<span class="dash">—</span>'}</div></div>
      <div class="kpi"><div class="kpi-label">Consumo · ${RANGE_LABEL[S.range].toLowerCase()}</div><div class="kpi-value num" id="kE"><span class="dash">—</span></div><div class="delta" id="kECost">&nbsp;</div></div>
    </section>` : ""}
    <div class="grid top">
      ${d.metering ? `
      <section class="panel span-8 grow-panel" aria-labelledby="hUse">
        <header><div><h2 id="hUse">Energia por intervalo</h2><span class="meta">em Wh</span></div>${rangeSeg(S.range)}</header>
        <div class="chart fill" id="cUse" style="min-height:240px"></div>
        <p class="note" id="cUseNote" style="margin-top:8px"></p>
      </section>` : ""}
      <section class="panel ${d.metering ? "span-4" : "span-8"}" aria-labelledby="hBeh">
        <header><h2 id="hBeh">Comportamento</h2></header>
        ${d.metering ? nestControl(d) : ""}
        ${writable.length ? writable.map((x) => control(d, x)).join("") : d.metering ? "" : '<p class="empty-note">Este dispositivo não tem ajustes.</p>'}
      </section>
      ${S.auth?.schedules && mainSwitch(d) ? `
      <section class="panel span-12" aria-labelledby="hSched">
        <header><h2 id="hSched">Agendamentos</h2><span class="meta">por dia e horário</span></header>
        <div id="schedWrap"><p class="note">Carregando…</p></div>
      </section>` : ""}
      <section class="panel span-12" aria-labelledby="hInfo">
        <header><h2 id="hInfo">Estado e identificação</h2></header>
        <div class="kv-grid">
          <dl class="kv half">${state.map((x) => `<dt>${esc(label(x.code, x.name))}</dt><dd class="num">${esc(displayValue(x))}</dd>`).join("")}</dl>
          <dl class="kv half">
            <dt>ID do dispositivo</dt><dd><span class="mono" translate="no">${esc(d.id)}</span></dd>
            <dt>Produto</dt><dd>${esc(d.product_name || "—")}</dd>
            <dt>IP de saída</dt><dd class="num">${esc(info?.ip || "—")}</dd>
            <dt>Pareada em</dt><dd class="num">${info?.active_time ? F.dayTime(new Date(info.active_time * 1000)) : "—"}</dd>
            <dt>Local key</dt><dd>${info ? (S.revealKey ? `<span class="mono" translate="no">${esc(info.local_key)}</span>` : '<button class="linkish" id="revealKey">Mostrar</button>') : "—"}</dd>
          </dl>
        </div>
        ${advanced.length ? `<div style="margin-top:8px">${advanced.map((x) => control(d, x)).join("")}</div>` : ""}
        <p class="note" style="margin-top:12px">A local key permite controlar a tomada direto pela rede local (por exemplo com tinytuya), sem passar pela nuvem. Não compartilhe.</p>
      </section>
    </div>`;

  view.querySelector("#backBtn").onclick = () => (S.navDepth > 0 ? history.back() : (location.hash = "#/"));
  wireToggles(view);
  view.querySelector("#revealKey")?.addEventListener("click", () => { S.revealKey = true; route({ soft: true }); });
  wireControls(view, d);
  wireNest(view, d);
  wireRange(view);
  if (S.auth?.schedules && mainSwitch(d)) loadSchedules(view, d);

  if (d.metering) {
    try {
      const s = await getJSON(`/api/devices/${encodeURIComponent(d.id)}/energy?range=${S.range}`);
      if (!view.isConnected) return;
      const kwhSeries = s.has_measured ? s.kwh_measured : s.kwh_estimated, total = s.has_measured ? s.total_kwh_measured : s.total_kwh_estimated;
      view.querySelector("#kE").innerHTML = fig(F.kwh(total), "kWh");
      view.querySelector("#kECost").textContent = `${F.brl(Math.round(total * 1000) / 1000 * S.tariff)} a ${F.brl(S.tariff)}/kWh`;
      const cu = view.querySelector("#cUse");
      drawKwh(cu, s, kwhSeries, Math.max(240, cu.clientHeight));
      view.querySelector("#cUseNote").textContent = (s.has_measured ? "Medido pela tomada (importado da nuvem)." : "Calculado pela potência lida a cada 5 s.") + ` Pico de ${F.w(s.peak_power_w) ?? "—"} W no período.`;
    } catch (e) { view.querySelector("#cUse").innerHTML = `<p class="empty-note">Histórico indisponível: ${esc(e.message)}</p>`; }
  }
}

// ------------------------------------------------------ tomada aninhada
// "Ligada dentro de": esta tomada está numa régua/extensão ligada em outra tomada que mede.
function nestControl(d) {
  const below = new Set([d.id]); // ela e as que estão dentro dela (direta ou indiretamente) não podem ser a de fora
  for (let grew = true; grew;) { grew = false; for (const c of S.devices.values()) if (c.parent_id && below.has(c.parent_id) && !below.has(c.id)) { below.add(c.id); grew = true; } }
  const opts = [...S.devices.values()].filter((o) => o.metering && !below.has(o.id)).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const cur = parentOf(d)?.id || "";
  return `<div class="setting wide"><div><label for="nestSel">Ligada dentro de</label><span class="hint">Numa régua ou extensão ligada em outra tomada que mede? Escolha a de fora para não contar o consumo duas vezes.</span></div>
    <select class="input" id="nestSel" name="parent" style="justify-self:start">${[`<option value="">Nenhuma (direto na parede)</option>`, ...opts.map((o) => `<option value="${esc(o.id)}" ${o.id === cur ? "selected" : ""}>${esc(o.name)}</option>`)].join("")}</select></div>`;
}
function wireNest(root, d) {
  const sel = root.querySelector("#nestSel");
  if (!sel) return;
  sel.onchange = async () => {
    sel.disabled = true;
    try {
      const r = await api(`/api/devices/${encodeURIComponent(d.id)}/parent`, { method: "POST", body: { parent_id: sel.value || null } });
      S.devices.set(d.id, { ...S.devices.get(d.id), parent_id: r.parent_id });
      energyCache.clear();
      toast(r.parent_id ? `${d.name} agora conta dentro de ${S.devices.get(r.parent_id)?.name}` : `${d.name} volta a contar separada`);
    } catch (e) { toast(e.message, true); }
    sel.disabled = false; sel.blur();
    route({ soft: true });
  };
}

// ---------------------------------------------------------- agendamentos
const WD = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"]; // loops: índice 0 = segunda
function loopsText(loops) {
  const on = [...loops].map((c, i) => (c === "1" ? i : -1)).filter((i) => i >= 0);
  if (on.length === 7) return "Todos os dias";
  if (loops === "1111100") return "Dias úteis";
  if (loops === "0000011") return "Fim de semana";
  if (on.length === 0) return "Uma vez";
  return on.map((i) => WD[i]).join(", ");
}
async function loadSchedules(view, d) {
  const wrap = view.querySelector("#schedWrap");
  if (!wrap) return;
  let data;
  try { data = await api(`/api/schedules/${encodeURIComponent(d.id)}`); }
  catch (e) { wrap.innerHTML = `<p class="empty-note">Não foi possível carregar os agendamentos: ${esc(e.message)}</p>`; return; }
  if (!view.isConnected) return;
  const list = data.schedules || [];
  wrap.innerHTML = `
    <div class="rows" id="schedRows">
      ${list.length ? list.map(schedRow).join("") : '<p class="note" style="padding:8px 0">Nenhum agendamento ainda.</p>'}
    </div>
    <form id="schedForm" class="sched-form">
      <div class="sched-when">
        <input class="input" type="time" id="schedTime" value="07:00" required aria-label="Horário" />
        <div class="seg" role="group" aria-label="Dias da semana" id="schedDays">
          ${WD.map((w, i) => `<button type="button" data-day="${i}" aria-pressed="${i < 5}">${w}</button>`).join("")}
        </div>
      </div>
      <div class="sched-act">
        <div class="seg" role="group" aria-label="Ação">
          <button type="button" data-val="true" aria-pressed="true">Ligar</button>
          <button type="button" data-val="false" aria-pressed="false">Desligar</button>
        </div>
        <button class="btn primary" type="submit">Adicionar</button>
      </div>
    </form>
    <p class="note" id="schedMsg" role="alert" style="min-height:18px;margin-top:6px"></p>
    <p class="note" style="margin-top:4px">Agendamentos do painel, executados na nuvem da Tuya. São independentes dos agendamentos criados no app.</p>`;

  wrap.querySelectorAll("#schedDays [data-day]").forEach((b) => (b.onclick = () => b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true")));
  const actSeg = wrap.querySelector(".sched-act .seg");
  actSeg.querySelectorAll("button").forEach((b) => (b.onclick = () => actSeg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b))));
  wrap.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog({ title: "Apagar agendamento?", body: "Ele será removido da tomada.", confirm: "Apagar", danger: true }))) return;
    try { await api(`/api/schedules/${encodeURIComponent(d.id)}/${encodeURIComponent(b.dataset.del)}?category=${encodeURIComponent(b.dataset.cat)}`, { method: "DELETE" }); toast("Agendamento apagado"); loadSchedules(view, d); }
    catch (e) { toast(e.message, true); }
  }));
  wrap.querySelector("#schedForm").onsubmit = async (e) => {
    e.preventDefault();
    const msg = wrap.querySelector("#schedMsg"); msg.textContent = "";
    const time = wrap.querySelector("#schedTime").value;
    const loops = WD.map((_, i) => (wrap.querySelector(`[data-day="${i}"]`).getAttribute("aria-pressed") === "true" ? "1" : "0")).join("");
    if (!/^[01]{7}$/.test(loops) || loops === "0000000") { msg.textContent = "Escolha pelo menos um dia."; return; }
    const value = actSeg.querySelector('[aria-pressed="true"]').dataset.val === "true";
    const btn = e.target.querySelector('button[type="submit"]'); btn.disabled = true;
    try {
      await api(`/api/schedules/${encodeURIComponent(d.id)}`, { method: "POST", body: { time, loops, value, alias: "" } });
      toast("Agendamento criado"); loadSchedules(view, d);
    } catch (err) { msg.textContent = err.message; btn.disabled = false; }
  };
}
function schedRow(s) {
  const act = s.value === true ? "Ligar" : s.value === false ? "Desligar" : "—";
  return `<div class="row sched-row">
    <span class="sched-time num">${esc(s.time || "—")}</span>
    <span class="grow"><b>${act}</b><span class="sub">${esc(loopsText(s.loops))}${s.alias ? " · " + esc(s.alias) : ""}${s.enabled ? "" : " · desativado"}</span></span>
    ${s.editable ? `<button class="btn ghost icon-del" data-del="${esc(s.group_id)}" data-cat="${esc(s.category)}" aria-label="Apagar agendamento">${I.close}</button>` : '<span class="pill">externo</span>'}
  </div>`;
}

function displayValue(x) {
  const v = x.value;
  if (v == null || v === "") return "—";
  if (x.type === "Boolean") return v ? "sim" : "não";
  if (x.type === "Integer") {
    const n = v / 10 ** (x.values.scale || 0);
    return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(n)} ${x.values.unit || ""}`.trim();
  }
  if (x.type === "Enum") return enumLabel(x.code, v);
  if (x.type === "Bitmap") {
    const bits = (x.values.label || []).filter((_, i) => v & (1 << i)).map((l) => FAULTS[l] || l);
    return bits.length ? bits.join(", ") : v ? `código ${v}` : "nenhuma";
  }
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

const hms = (s) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
function control(d, x) {
  const id = `c_${x.code}`;
  const dis = d.online ? "" : "disabled";
  const head = (forId = id) => `<div><label for="${esc(forId)}">${esc(label(x.code, x.name))}</label>${HINTS[x.code] ? `<span class="hint">${esc(HINTS[x.code])}</span>` : ""}</div>`;
  if (x.type === "Boolean") {
    return `<div class="setting">${head()}<label class="toggle"><input id="${esc(id)}" type="checkbox" data-code="${esc(x.code)}" data-t="bool" ${x.value ? "checked" : ""} ${dis}><span></span></label></div>`;
  }
  if (x.type === "Enum") {
    const opts = x.values.range || [];
    return `<div class="setting">${head()}<select class="input" id="${esc(id)}" name="${esc(x.code)}" data-code="${esc(x.code)}" data-t="select" ${dis}>${opts.map((o) => `<option value="${esc(o)}" ${o === x.value ? "selected" : ""}>${esc(enumLabel(x.code, o))}</option>`).join("")}</select></div>`;
  }
  if (x.type === "Integer" && /^countdown/.test(x.code)) {
    const left = x.value || 0;
    const presets = [[900, "15 min"], [1800, "30 min"], [3600, "1 h"], [7200, "2 h"]].filter(([s]) => s <= (x.values.max ?? 86400));
    return `<div class="setting wide"><div><span class="lbl">${esc(label(x.code))}</span><span class="hint">${left ? `Muda de estado em <span class="num">${hms(left)}</span>` : HINTS[x.code] || ""}</span></div>
      <div class="seg" role="group" aria-label="Temporizador">${presets.map(([s, l]) => `<button type="button" data-code="${esc(x.code)}" data-t="int" data-v="${s}" ${dis}>${l}</button>`).join("")}${left ? `<button type="button" data-code="${esc(x.code)}" data-t="int" data-v="0" ${dis}>Cancelar</button>` : ""}</div></div>`;
  }
  if (x.type === "Integer") {
    const sc = 10 ** (x.values.scale || 0);
    return `<div class="setting wide">${head()}<div class="range-row"><input id="${esc(id)}" type="range" data-code="${esc(x.code)}" data-t="range" data-scale="${sc}" min="${x.values.min ?? 0}" max="${x.values.max ?? 100}" step="${x.values.step ?? 1}" value="${x.value ?? x.values.min ?? 0}" ${dis}><output for="${esc(id)}">${nf(0).format((x.value ?? 0) / sc)} ${esc(x.values.unit || "")}</output></div></div>`;
  }
  if (x.type === "Json" && /^colou?r_data/.test(x.code)) {
    return `<div class="setting">${head()}<input id="${esc(id)}" type="color" data-code="${esc(x.code)}" data-t="colour" value="${hsvToHex(x)}" ${dis} style="width:48px;height:32px;border:0;background:none"></div>`;
  }
  if (["String", "Json", "Raw"].includes(x.type)) {
    // agendas binárias (cycle_time, random_time): editar só se souber o formato
    return `<details class="setting wide"><summary style="cursor:pointer;font-weight:500">${esc(label(x.code, x.name))} <span class="hint">avançado</span></summary>
      <div class="join" style="display:flex;margin-top:8px"><input class="input mono" style="flex:1;min-width:0" aria-label="${esc(label(x.code))}" data-raw="${esc(x.code)}" autocomplete="off" spellcheck="false" value="${esc(typeof x.value === "object" ? JSON.stringify(x.value) : x.value ?? "")}" ${dis}><button class="btn" type="button" data-code="${esc(x.code)}" data-t="text" ${dis}>Enviar</button></div></details>`;
  }
  return "";
}

function wireControls(root, d) {
  const go = (code, value) => send(d.id, [{ code, value }], "Ajuste enviado");
  root.querySelectorAll("[data-t]").forEach((el) => {
    const code = el.dataset.code;
    switch (el.dataset.t) {
      case "bool": el.onchange = () => go(code, el.checked); break;
      case "select": el.onchange = () => { go(code, el.value); el.blur(); }; break;
      case "int": el.onclick = () => go(code, +el.dataset.v); break;
      case "range": {
        const x = dp(d, code);
        el.oninput = () => (el.nextElementSibling.textContent = `${nf(0).format(+el.value / +el.dataset.scale)} ${x.values.unit || ""}`);
        el.onchange = () => { go(code, +el.value); el.blur(); };
        break;
      }
      case "colour": el.onchange = () => go(code, hexToHsv(el.value, dp(d, code))); break;
      case "text": el.onclick = () => go(code, root.querySelector(`[data-raw="${CSS.escape(code)}"]`).value); break;
    }
  });
}

// cores Tuya: {"h":0-360,"s":0-1000,"v":0-1000} (v2) ou 0-255 (v1)
const colourMax = (x) => (x.code.endsWith("_v2") || (x.values?.s?.max ?? 1000) > 255 ? 1000 : 255);
function hsvToHex(x) {
  let c = x.value;
  try { if (typeof c === "string") c = JSON.parse(c); } catch { c = null; }
  if (!c) return "#ffffff";
  const M = colourMax(x), h = c.h / 60, s = c.s / M, v = Math.max(c.v / M, 0.35);
  const f = (n) => { const k = (n + h) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return "#" + [f(5), f(3), f(1)].map((n) => Math.round(n * 255).toString(16).padStart(2, "0")).join("");
}
function hexToHsv(hex, x) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), dl = max - min;
  let h = 0;
  if (dl) h = max === r ? ((g - b) / dl) % 6 : max === g ? (b - r) / dl + 2 : (r - g) / dl + 4;
  const M = colourMax(x);
  return JSON.stringify({ h: Math.round((h * 60 + 360) % 360), s: Math.round((max ? dl / max : 0) * M), v: Math.round(max * M) });
}

// ================================================================ CONSUMO
async function viewEnergy(view, soft) {
  view.innerHTML = `
    <div class="title-row">
      <div><h1>Consumo</h1><p class="sub" id="eFinding">Calculando…</p></div>
      <div class="title-actions">${rangeSeg(S.range)}
        <label class="note" for="tariff" style="display:flex;align-items:center;gap:8px;font-size:14px">Tarifa
          <input class="input num" id="tariff" name="tariff" type="number" inputmode="decimal" step="0.01" min="0" value="${S.tariff}" style="width:96px;height:36px"> R$/kWh</label></div>
    </div>
    <section class="kpis" aria-label="Totais do período">
      <div class="kpi"><div class="kpi-label">Energia</div><div class="kpi-value num" id="eK"><span class="dash">—</span></div></div>
      <div class="kpi lead"><div class="kpi-label">Custo</div><div class="kpi-value num money" id="eC"><span class="dash">—</span></div></div>
      <div class="kpi"><div class="kpi-label">Projeção para 30 dias</div><div class="kpi-value num money" id="eP"><span class="dash">—</span></div><div class="delta" id="ePNote">pela potência média do período</div></div>
      <div class="kpi"><div class="kpi-label">Potência média</div><div class="kpi-value num" id="eA"><span class="dash">—</span></div></div>
    </section>
    <div class="grid top">
      <section class="panel span-7 grow-panel" aria-labelledby="hTot">
        <header><h2 id="hTot">Potência da casa</h2><span class="meta" id="hTotMeta">soma das tomadas com medição</span></header>
        <div class="chart fill" id="cTot" style="min-height:300px"></div>
      </section>
      <section class="panel span-5" aria-labelledby="hRank">
        <header><h2 id="hRank">Por tomada</h2><span class="meta" id="rankMeta"></span></header>
        <div class="rows" id="rank"><p class="note">Carregando…</p></div>
      </section>
    </div>
    <p class="note" style="margin-top:16px">O histórico é gravado pelo próprio painel a partir das leituras das tomadas. Períodos em que o painel não estava rodando aparecem vazios, não como zero.</p>`;
  wireRange(view);
  view.querySelector("#tariff").onchange = (e) => { S.tariff = Math.max(0, +e.target.value || 0); safeSet("tariff", S.tariff); route({ soft: true }); };

  try {
    const [sum, tot] = await Promise.all([getJSON(`/api/energy/summary?range=${S.range}`), getJSON(`/api/energy/total?range=${S.range}`)]);
    if (!view.isConnected) return;
    // cada linha entra com a parte só dela: a de fora sem as de dentro, para a soma bater com o total
    const names = new Map(sum.devices.map((r) => [r.id, r.name]));
    const rows = sum.devices.map((r) => {
      const kwh = Math.round((r.children?.length ? r.own_kwh : r.kwh) * 1000) / 1000;
      return { ...r, measured: Math.round(r.kwh * 1000) / 1000, kwh, brl: Math.round(kwh * S.tariff * 100) / 100 };
    }).sort((a, b) => b.kwh - a.kwh);
    const kwh = rows.reduce((s, r) => s + r.kwh, 0), brl = rows.reduce((s, r) => s + r.brl, 0);
    const covered = tot.avg_power_w.filter((v) => v != null);
    const avg = covered.length ? covered.reduce((a, b) => a + b, 0) / covered.length : null;
    view.querySelector("#eK").innerHTML = fig(F.kwh(kwh), "kWh");
    view.querySelector("#eC").innerHTML = F.brl(brl);
    // projeta pela potência média do tempo realmente gravado (não pelo período inteiro,
    // que inclui horas antes do painel começar a gravar)
    view.querySelector("#eP").innerHTML = avg == null ? '<span class="dash">—</span>' : F.brl((avg / 1000) * 24 * 30 * S.tariff);
    view.querySelector("#ePNote").textContent = avg == null ? "sem leituras no período" : `${F.w(avg)} W em média × 720 h`;
    view.querySelector("#eA").innerHTML = fig(F.w(avg), "W");
    const top = rows[0];
    view.querySelector("#eFinding").innerHTML = top && kwh > 0
      ? `<b>${esc(top.name)}</b> responde por ${F.pct(top.kwh / kwh)} do consumo ${S.range === "today" ? "de hoje" : `dos últimos ${RANGE_LABEL[S.range]}`}: ${F.kwh(top.kwh)} de ${F.kwh(kwh)} kWh.`
      : "Ainda não há consumo registrado neste período.";
    view.querySelector("#rankMeta").textContent = `${rows.length} tomadas`;
    const max = Math.max(...rows.map((r) => r.kwh), 1e-9);
    view.querySelector("#rank").innerHTML = rows.map((r, i) => `
      <a class="row rank" href="#/tomada/${encodeURIComponent(r.id)}">
        <span class="grow"><b>${esc(r.name)}</b><span class="sub num">${S.devices.get(r.id)?.online === false ? "offline" : r.power_w == null ? "—" : `${F.w(r.power_w)} W agora`}${r.parent_id ? ` · dentro de ${esc(names.get(r.parent_id))}` : ""}${r.children?.length ? ` · sem ${r.children.map((c) => esc(names.get(c))).join(", ")} (medido ${F.kwh(r.measured)} kWh)` : ""}</span>
          <span class="bar ${i === 0 && r.kwh > 0 ? "lead" : ""}" style="width:${r.kwh > 0 ? Math.max(2, (r.kwh / max) * 100) : 0}%"></span></span>
        <span class="fig">${r.kwh ? `${F.kwh(r.kwh)}<span class="dash"> kWh</span>` : '<span class="zero">0 kWh</span>'}<span class="sub">${F.brl(r.brl)}</span></span>
      </a>`).join("");
    let series = tot;
    if (tot.avg_power_w.filter((v) => v != null).length < 3) {
      series = await getJSON("/api/energy/total?range=1h");
      view.querySelector("#hTotMeta").textContent = "última hora, por minuto (pouco histórico no período)";
    }
    const cto = view.querySelector("#cTot");
    drawPower(cto, series, Math.max(300, cto.clientHeight));
  } catch (e) { view.querySelector("#eFinding").textContent = `Não foi possível carregar o consumo: ${e.message}.`; }
}

// ================================================================== CENAS
const sceneRow = (s) => `
  <div class="row"><span class="grow"><b>${esc(s.name)}</b><span class="sub">${s.enabled ? "Ativa" : "Desativada"}</span></span>
  <button class="btn" type="button" data-scene="${esc(s.id)}" data-home="${esc(s.home_id)}" data-name="${esc(s.name)}" ${s.enabled ? "" : "disabled"}>Executar</button></div>`;
function wireScenes(root) {
  root.querySelectorAll("[data-scene]").forEach((b) => (b.onclick = async () => {
    b.disabled = true; b.textContent = "Executando…";
    try { await api(`/api/scenes/${encodeURIComponent(b.dataset.home)}/${encodeURIComponent(b.dataset.scene)}/trigger`, { method: "POST" }); toast(`Cena “${b.dataset.name}” executada`); }
    catch (e) { toast(`${e.message}. Tente de novo em alguns segundos.`, true); }
    b.disabled = false; b.textContent = "Executar";
  }));
}
async function viewScenes(view) {
  view.innerHTML = `<div class="title-row"><div><h1>Cenas</h1><p class="sub" id="scSub">Carregando…</p></div></div>
    <section class="panel span-8" style="max-width:760px" aria-labelledby="hSc"><header><h2 id="hSc">Toque para executar</h2></header><div class="rows" id="scRows"></div></section>`;
  try {
    S.scenes = await api("/api/scenes");
    if (!view.isConnected) return;
    const home = S.homes.map((h) => h.name.replace(/[.\s]+$/, "")).join(", ");
    view.querySelector("#scSub").textContent = `${S.scenes.length} ${S.scenes.length === 1 ? "cena" : "cenas"} em ${home}. Automações por horário ou sensor continuam no app.`;
    view.querySelector("#scRows").innerHTML = S.scenes.length ? S.scenes.map(sceneRow).join("") : '<p class="empty-note">Nenhuma cena de toque na conta. Crie em Smart → Toque para executar, no app.</p>';
    wireScenes(view);
  } catch (e) { view.querySelector("#scSub").textContent = `Não foi possível carregar as cenas: ${e.message}.`; }
}

boot();
