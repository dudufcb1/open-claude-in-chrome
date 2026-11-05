// Tutor: senalar elementos en una pagina con un recuadro y enterarse de los clics de la persona.
//
// Se carga desde background.js con importScripts y comparte su ambito global (nativePort,
// toolHandlers). No usa el depurador, asi que no aparece la barra de "comenzo a depurar": todo va
// por chrome.scripting, que entra a iframes de otro dominio gracias a host_permissions.
//
// tutor-page.js solo se carga en las paginas mientras hay una clase: se registra como content script
// dinamico al iniciar y se quita al terminar. Los eventos van a /tmp/page-monitor/tutor-*.jsonl por el
// mismo canal del monitor, para poder seguirlos con tail, y a una lista en memoria para tutor_wait.

const TUTOR_DIR = "/tmp/page-monitor"; // Debe coincidir con el host nativo
const TUTOR_SCRIPT_ID = "tutor-page";
const TUTOR_MAX_EVENTS = 500;
const TUTOR_BACKLOG_MAX = 500;

// { session, tabs: Set, lastTab, seq, consumed, events: [], backlog: [] }
let tutor = null;

const tutorText = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});

function tutorSessionName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `tutor-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-`
    + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/// Anota el evento y lo manda al host. Si el puerto se cayo, sale con el siguiente evento.
function tutorEmit(kind, tabId, fields) {
  if (!tutor) return;
  const event = { ts: new Date().toISOString(), seq: ++tutor.seq, kind, tab: tabId, ...fields };
  tutor.events.push(event);
  if (tutor.events.length > TUTOR_MAX_EVENTS) tutor.events.shift();
  tutor.backlog.push({ type: "monitor_event", session: tutor.session, event });
  if (tutor.backlog.length > TUTOR_BACKLOG_MAX) tutor.backlog.shift();
  if (!nativePort) return;
  try {
    while (tutor.backlog.length) {
      nativePort.postMessage(tutor.backlog[0]);
      tutor.backlog.shift();
    }
  } catch {
    // Puerto caido: lo que quedo en backlog sale en el siguiente evento.
  }
}

async function tutorRegisterScript() {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [TUTOR_SCRIPT_ID] });
  if (existing.length) return;
  await chrome.scripting.registerContentScripts([{
    id: TUTOR_SCRIPT_ID,
    js: ["tutor-page.js"],
    matches: ["<all_urls>"],
    allFrames: true,
    matchOriginAsFallback: true,
    runAt: "document_start",
    persistAcrossSessions: false,
  }]);
}

async function tutorUnregisterScript() {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [TUTOR_SCRIPT_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [TUTOR_SCRIPT_ID] });
}

/// Corre una funcion de tutor-page en todos los frames de la pestana, o en uno solo.
function tutorRun(tabId, func, args = [], frameIds = null) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
  return chrome.scripting.executeScript({ target, func, args });
}

async function tutorJoinTab(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["tutor-page.js"] });
  await tutorRun(tabId, () => window.__tutor?.activate());
  tutor.tabs.add(tabId);
  tutor.lastTab = tabId;
}

function tutorResolveTab(tabId) {
  if (!tutor) throw new Error("no hay clase activa: llama primero a tutor_start");
  const resolved = tabId ?? tutor.lastTab;
  if (!tutor.tabs.has(resolved)) throw new Error(`la pestaña ${resolved} no está en la clase`);
  return resolved;
}

async function tutorClearTab(tabId) {
  await tutorRun(tabId, () => window.__tutor?.clear());
}

function tutorMergeCandidates(results) {
  return results
    .flatMap((r) => (r.result || []).map((c) => ({ ...c, frameId: r.frameId })))
    .sort((a, b) => b.score - a.score
      || Number(a.covered) - Number(b.covered)
      || Number(b.inViewport) - Number(a.inViewport)
      || a.frameId - b.frameId);
}

async function tutorEnd() {
  const ended = tutor;
  for (const tabId of ended.tabs) {
    try {
      await tutorRun(tabId, () => window.__tutor?.deactivate());
    } catch {
      // Pestana ya cerrada o en una pagina interna: no queda nada que limpiar.
    }
  }
  await tutorUnregisterScript();
  tutorEmit("end", ended.lastTab, {});
  tutor = null;
  return ended;
}

Object.assign(toolHandlers, {
  async tutor_start(args) {
    let { tabId } = args;
    if (tabId == null) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) throw new Error("no encontré una pestaña activa; pasa tabId");
      tabId = tab.id;
    }
    if (tutor) await tutorEnd();
    tutor = { session: tutorSessionName(), tabs: new Set(), lastTab: tabId, seq: 0, consumed: 0, events: [], backlog: [] };
    try {
      await tutorRegisterScript();
      await tutorJoinTab(tabId);
    } catch (err) {
      await tutorUnregisterScript();
      tutor = null;
      throw new Error(`no se pudo entrar a la pestaña ${tabId} (Chrome no deja en sus páginas internas): ${err.message}`);
    }
    const tab = await chrome.tabs.get(tabId);
    tutorEmit("start", tabId, { url: tab.url, title: tab.title });
    const file = `${TUTOR_DIR}/${tutor.session}.jsonl`;
    return tutorText({ tabId, url: tab.url, title: tab.title, file, follow_command: `tail -n0 -F ${file}` });
  },

  async tutor_point(args) {
    const { text, selector, role, nth, label, area, keep } = args;
    const tabId = tutorResolveTab(args.tabId);
    tutor.lastTab = tabId;
    if (!keep) await tutorClearTab(tabId);
    tutor.consumed = tutor.seq;

    if (area) {
      await tutorRun(tabId, (a, l) => window.__tutor?.pointArea(a, l), [area, label ?? null], [0]);
      return tutorText({ pointed: { area }, tabId, label });
    }
    if (!text && !selector) throw new Error("falta text, selector o area");

    const query = { text: text ?? null, selector: selector ?? null, role: role ?? null };
    const results = await tutorRun(tabId, (q) => window.__tutor?.locate(q) ?? [], [query]);
    const merged = tutorMergeCandidates(results);
    if (!merged.length) return tutorText({ pointed: null, tabId, reason: "no encontré nada visible con eso", query });

    const chosen = merged[nth ?? 0];
    if (!chosen) return tutorText({ pointed: null, tabId, reason: `solo hay ${merged.length} coincidencias`, candidates: merged });
    const [drawn] = await tutorRun(
      tabId,
      (index, l, q) => window.__tutor?.point(index, l, q),
      [chosen.index, label ?? null, query],
      [chosen.frameId],
    );
    return tutorText({ pointed: drawn?.result ? chosen : null, tabId, label, others: merged.filter((c) => c !== chosen).slice(0, 5) });
  },

  async tutor_clear(args) {
    const tabId = tutorResolveTab(args.tabId);
    await tutorClearTab(tabId);
    return tutorText(`Recuadros quitados de la pestaña ${tabId}.`);
  },

  /// Eventos que no se han entregado desde el ultimo tutor_point o tutor_events.
  async tutor_events() {
    if (!tutor) return tutorText({ active: false, events: [] });
    const events = tutor.events.filter((e) => e.seq > tutor.consumed);
    tutor.consumed = tutor.seq;
    return tutorText({ active: true, events });
  },

  async tutor_stop() {
    if (!tutor) return tutorText("No había clase activa.");
    const ended = await tutorEnd();
    return tutorText(`Clase terminada. Eventos en ${TUTOR_DIR}/${ended.session}.jsonl`);
  },
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (msg?.type === "tutor_hello") {
    sendResponse({ active: Boolean(tutor?.tabs.has(tabId)) });
    return false;
  }
  if (msg?.type === "tutor_event" && tutor?.tabs.has(tabId)) {
    tutor.lastTab = tabId;
    tutorEmit(msg.kind, tabId, { ...msg.fields, frame_url: sender.url });
    sendResponse({ ok: true });
  }
  return false;
});

// Una navegacion, tambien las de una SPA que solo cambian la URL, deja viejo lo que se senalo.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && tutor?.tabs.has(tabId)) tutorEmit("page", tabId, { url: changeInfo.url });
});

// Un enlace que abre pestana nueva sigue siendo parte de la clase.
chrome.tabs.onCreated.addListener((tab) => {
  if (!tutor?.tabs.has(tab.openerTabId)) return;
  tutor.tabs.add(tab.id);
  tutor.lastTab = tab.id;
  tutorEmit("tab_opened", tab.id, { url: tab.pendingUrl || tab.url, from_tab: tab.openerTabId });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!tutor?.tabs.has(tabId)) return;
  tutorEmit("tab_closed", tabId, {});
  tutor.tabs.delete(tabId);
  if (tutor.lastTab === tabId) tutor.lastTab = [...tutor.tabs].pop();
});
