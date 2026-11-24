// Panel lateral del agente: arma la instruccion, la manda al service worker (agent.js) por el puerto
// "agent-panel" y pinta cada paso que llega. La corrida vive en el service worker: si el panel se
// cierra y se vuelve a abrir, recibe el estado y el registro completos en "hello".

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"), task: $("task"), start: $("start"), stop: $("stop"), log: $("log"), empty: $("empty"),
  result: $("result"), notice: $("notice"), tabLabel: $("tabLabel"), settings: $("settings"),
  toggleSettings: $("toggleSettings"), backendUrl: $("backendUrl"), token: $("token"),
  saveSettings: $("saveSettings"), clearGroups: $("clearGroups"), startNew: $("startNew"), context: $("context"),
};

let port = null;
let thinkingSince = null;
let thinkingTimer = null;

function connect() {
  port = chrome.runtime.connect({ name: "agent-panel" });
  port.onMessage.addListener(onMessage);
  // Si el service worker se reinicia, el puerto se cae: se reconecta y se pide el estado de nuevo.
  port.onDisconnect.addListener(() => setTimeout(connect, 500));
}

function notice(text) {
  els.notice.textContent = text || "";
  els.notice.hidden = !text;
}

function timeLabel(at) {
  return new Date(at).toLocaleTimeString("es-MX", { hour12: false });
}

/// Convierte el poco markdown que usa el modelo (negritas, listas con "- ", saltos de linea) en nodos.
/// Se arma con textContent, nunca con innerHTML, porque el texto puede traer lo que diga una pagina.
function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  // El modelo a veces mete una lista en una sola linea ("Total: - 19 nov: ... - 11 nov: ..."): se parte.
  const lines = String(text).replace(/\s+-\s(?=\S)/g, "\n- ").split("\n").map((l) => l.trim()).filter(Boolean);
  let list = null;
  for (const line of lines) {
    const bullet = /^[-*•]\s+/.test(line);
    const block = document.createElement(bullet ? "li" : "p");
    for (const [i, part] of line.replace(/^[-*•]\s+/, "").split("**").entries()) {
      if (!part) continue;
      if (i % 2) {
        const strong = document.createElement("strong");
        strong.textContent = part;
        block.append(strong);
      } else {
        block.append(part);
      }
    }
    if (bullet) {
      if (!list) frag.append((list = document.createElement("ul")));
      list.append(block);
    } else {
      list = null;
      frag.append(block);
    }
  }
  return frag;
}

/// Cada paso del registro: las acciones van como renglon con hora, lo que dice el modelo como globo,
/// y la salida cruda de la herramienta se esconde dentro de la accion que la produjo ("ver salida").
/// "Pensando" no se pinta como renglon: lo muestra el estado de arriba con los segundos que lleva.
function addLogEntry(entry) {
  setThinking(entry.kind === "thinking" ? entry.at : null);
  if (entry.kind === "thinking") return;
  els.empty.hidden = true;
  if (entry.kind === "result") {
    const owner = els.log.lastElementChild;
    if (owner?.classList.contains("k-action") && !owner.querySelector("details")) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "ver salida";
      const pre = document.createElement("pre");
      pre.textContent = entry.text;
      details.append(summary, pre);
      owner.append(details);
    }
    return;
  }
  const li = document.createElement("li");
  li.className = `k-${entry.kind}`; // Prefijo: "result" chocaria con la clase del cuadro del resultado final
  if (entry.kind === "say") {
    li.append(renderMarkdown(entry.text));
  } else {
    const time = document.createElement("time");
    time.textContent = timeLabel(entry.at);
    const span = document.createElement("span");
    span.textContent = entry.text;
    li.append(span, time);
  }
  els.log.append(li);
  els.log.scrollTop = els.log.scrollHeight;
}

/// Mientras el modelo piensa, el estado dice cuantos segundos lleva: una vuelta puede tardar un minuto.
function setThinking(since) {
  thinkingSince = since;
  clearInterval(thinkingTimer);
  if (since) thinkingTimer = setInterval(renderThinking, 1000);
  renderThinking();
}

function renderThinking() {
  if (!thinkingSince || els.status.dataset.state !== "running") return;
  const secs = Math.round((Date.now() - thinkingSince) / 1000);
  els.status.lastElementChild.textContent = `Pensando… ${secs} s`;
}

function renderRun(run) {
  const running = run?.state === "running";
  els.start.hidden = running;
  els.startNew.hidden = running;
  els.stop.hidden = !running;
  els.task.disabled = running;
  if (!run) return setStatus("idle", "Listo");
  if (running) {
    setStatus("running", "Trabajando");
  } else if (run.result) {
    setStatus(run.result.success ? "ok" : "fail", run.result.success ? "Terminó" : "No terminó");
    els.result.hidden = false;
    els.result.className = `result ${run.result.success ? "ok" : "fail"}`;
    els.result.innerHTML = "";
    const title = document.createElement("strong");
    title.textContent = run.result.success ? "Tarea completa" : "La tarea no se completó";
    const body = document.createElement("div");
    body.className = "md";
    body.append(renderMarkdown(run.result.summary));
    els.result.append(title, body);
    if (run.usage?.turns) els.result.append(usageLine(run.usage));
    setThinking(null);
    refreshContext();
  }
}

/// "6 vueltas · 17,449 tokens de entrada (46% de caché) · $0.0011": para ver si la caché esta pegando.
function usageLine(u) {
  const el = document.createElement("small");
  el.className = "usage";
  const pct = u.input ? Math.round((u.cached / u.input) * 100) : 0;
  const cost = u.cost ? ` · $${u.cost.toFixed(4)}` : "";
  el.textContent = `${u.turns} vueltas · ${u.input.toLocaleString("es-MX")} tokens de entrada (${pct}% de caché)${cost}`;
  return el;
}

function setStatus(state, text) {
  els.status.dataset.state = state;
  els.status.lastElementChild.textContent = text;
}

function onMessage(msg) {
  if (msg.type === "hello") {
    refreshContext();
    els.backendUrl.value = msg.settings.backendUrl;
    els.token.value = msg.settings.token;
    if (!msg.settings.token) openSettings(true);
    els.log.innerHTML = "";
    (msg.run?.log || []).forEach(addLogEntry);
    if (msg.run?.task && !els.task.value) els.task.value = msg.run.task;
    renderRun(msg.run);
  } else if (msg.type === "state") {
    if (msg.run?.state === "running" && !msg.run.log.length) {
      els.log.innerHTML = "";
      els.result.hidden = true;
    }
    renderRun(msg.run);
  } else if (msg.type === "log") {
    addLogEntry(msg.entry);
  } else if (msg.type === "error") {
    notice(msg.text);
  } else if (msg.type === "settings") {
    notice("Ajustes guardados.");
    openSettings(false);
  } else if (msg.type === "info") {
    notice(msg.text);
  } else if (msg.type === "context") {
    renderContext(msg.tasks);
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshTabLabel() {
  const tab = await activeTab();
  els.tabLabel.textContent = tab ? `En: ${tab.title || tab.url}` : "Sin pestaña activa";
  els.tabLabel.title = tab?.url || "";
  refreshContext();
}

/// Pide al service worker que tareas recuerda de la pestana activa.
async function refreshContext() {
  const tab = await activeTab();
  if (tab?.id && port) port.postMessage({ type: "context", tabId: tab.id });
}

/// Con memoria, "Continuar" es la accion principal; sin ella solo hay "Nueva tarea" (que es lo mismo).
function renderContext(tasks) {
  const has = tasks.length > 0;
  els.context.hidden = !has;
  els.context.textContent = has ? `Recuerda ${tasks.length} tarea(s) de esta pestaña. Última: ${tasks[tasks.length - 1]}` : "";
  els.context.title = tasks.join("\n");
  els.start.firstChild.textContent = has ? "Continuar " : "Iniciar ";
  els.startNew.hidden = !has || els.stop.hidden === false;
}

async function start(mode) {
  notice("");
  const tab = await activeTab();
  if (!tab?.id) return notice("No hay una pestaña activa en esta ventana.");
  if (/^(chrome|edge|brave|about|chrome-extension):/.test(tab.url || "")) {
    return notice("Esa pestaña es del navegador; el agente solo trabaja en páginas web.");
  }
  if (!els.task.value.trim()) return notice("Escribe qué quieres que haga.");
  els.start.disabled = els.startNew.disabled = true;
  port.postMessage({ type: "start", tabId: tab.id, task: els.task.value, mode });
  els.task.value = "";
  setTimeout(() => { els.start.disabled = els.startNew.disabled = false; }, 800);
}

function openSettings(open) {
  els.settings.hidden = !open;
  els.toggleSettings.setAttribute("aria-expanded", String(open));
}

els.start.addEventListener("click", () => start("continue"));
els.startNew.addEventListener("click", () => start("new"));
els.stop.addEventListener("click", () => port.postMessage({ type: "stop" }));
els.task.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    start("continue");
  }
});
els.toggleSettings.addEventListener("click", () => openSettings(els.settings.hidden));
els.saveSettings.addEventListener("click", () => {
  port.postMessage({ type: "settings", settings: { backendUrl: els.backendUrl.value, token: els.token.value } });
});
els.clearGroups.addEventListener("click", () => port.postMessage({ type: "clear_groups" }));
chrome.tabs.onActivated.addListener(refreshTabLabel);
chrome.tabs.onUpdated.addListener((_, info) => { if (info.title || info.url) refreshTabLabel(); });

connect();
refreshTabLabel();
