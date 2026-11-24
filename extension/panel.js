// Panel lateral del agente: arma la instruccion, la manda al service worker (agent.js) por el puerto
// "agent-panel" y pinta cada paso que llega. La corrida vive en el service worker: si el panel se
// cierra y se vuelve a abrir, recibe el estado y el registro completos en "hello".

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"), task: $("task"), start: $("start"), stop: $("stop"), log: $("log"), empty: $("empty"),
  result: $("result"), notice: $("notice"), tabLabel: $("tabLabel"), settings: $("settings"),
  toggleSettings: $("toggleSettings"), backendUrl: $("backendUrl"), token: $("token"),
  saveSettings: $("saveSettings"), clearGroups: $("clearGroups"),
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

function addLogEntry(entry) {
  els.empty.hidden = true;
  const li = document.createElement("li");
  li.className = `k-${entry.kind}`; // Prefijo: "result" chocaria con la clase del cuadro del resultado final
  const time = document.createElement("time");
  time.textContent = timeLabel(entry.at);
  const span = document.createElement("span");
  span.textContent = entry.text;
  li.append(time, span);
  els.log.append(li);
  els.log.scrollTop = els.log.scrollHeight;
  setThinking(entry.kind === "thinking" ? entry.at : null);
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
    const body = document.createElement("span");
    body.textContent = run.result.summary;
    els.result.append(title, body);
    setThinking(null);
  }
}

function setStatus(state, text) {
  els.status.dataset.state = state;
  els.status.lastElementChild.textContent = text;
}

function onMessage(msg) {
  if (msg.type === "hello") {
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
}

async function start() {
  notice("");
  const tab = await activeTab();
  if (!tab?.id) return notice("No hay una pestaña activa en esta ventana.");
  if (/^(chrome|edge|brave|about|chrome-extension):/.test(tab.url || "")) {
    return notice("Esa pestaña es del navegador; el agente solo trabaja en páginas web.");
  }
  if (!els.task.value.trim()) return notice("Escribe qué quieres que haga.");
  els.start.disabled = true;
  port.postMessage({ type: "start", tabId: tab.id, task: els.task.value });
  setTimeout(() => { els.start.disabled = false; }, 800);
}

function openSettings(open) {
  els.settings.hidden = !open;
  els.toggleSettings.setAttribute("aria-expanded", String(open));
}

els.start.addEventListener("click", start);
els.stop.addEventListener("click", () => port.postMessage({ type: "stop" }));
els.task.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    start();
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
