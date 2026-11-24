// Reproductor de recorridos: se conecta por WebSocket al servidor de recorridos (panel con play en
// 127.0.0.1:8798) y, cuando le llega un flujo, lo recorre en la pestana: va a la URL de inicio,
// busca cada elemento por su texto visible, mueve un cursor hasta el, lo resalta y le da clic.
//
// Se carga desde background.js con importScripts y comparte su ambito: usa tutorRun y
// tutorMergeCandidates de tutor.js para buscar en todos los frames con el mismo buscador del tutor.
// No usa el depurador, asi que durante la demo no aparece la barra amarilla de "comenzo a depurar".

const RECORRIDOS_URL = "ws://127.0.0.1:8798/ws/extension";
const RECORRIDOS_RETRY_MS = 3000;
const RECORRIDOS_LOCATE_EVERY_MS = 350;
const RECORRIDOS_PAUSE_MS = 650; // Respiro entre pasos en modo automatico, para que la audiencia siga
const RECORRIDOS_LOAD_TIMEOUT_MS = 20000;
const RECORRIDOS_PAGE_FILES = ["tutor-page.js", "recorridos-page.js"];
// Puntaje del buscador del tutor: 100 = texto exacto; 75 deja pasar un boton con algo de texto extra
// ("Guardar cambios" al buscar "Guardar") pero no un contenedor cuyo texto es mucho mas largo.
const RECORRIDOS_MIN_TEXT_SCORE = 75;

let recorridosSocket = null;
let recorridosRetry = null;
// { id, mode, pace, tabId, ownTab, cancelled, waitingNext: resolve|null, lastFrame }
let recorridosRun = null;

const recorridosSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function recorridosBrowser() {
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) || [];
  return ["Google Chrome", "Microsoft Edge", "Brave", "Chromium"].find((b) => brands.includes(b)) || "Chromium";
}

function recorridosSend(message) {
  if (recorridosSocket?.readyState !== WebSocket.OPEN) return;
  try {
    recorridosSocket.send(JSON.stringify(message));
  } catch {
    // Socket a medio cerrar: el siguiente connect lo repone.
  }
}

function recorridosConnect() {
  if (recorridosSocket && recorridosSocket.readyState <= WebSocket.OPEN) return;
  clearTimeout(recorridosRetry);
  let socket;
  try {
    socket = new WebSocket(RECORRIDOS_URL);
  } catch {
    recorridosRetry = setTimeout(recorridosConnect, RECORRIDOS_RETRY_MS);
    return;
  }
  recorridosSocket = socket;
  socket.onopen = () => {
    recorridosSend({ type: "hello", browser: recorridosBrowser(), version: chrome.runtime.getManifest().version });
  };
  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    recorridosHandle(msg);
  };
  socket.onclose = () => {
    if (recorridosSocket === socket) recorridosSocket = null;
    if (recorridosRun) recorridosRun.cancelled = true; // Sin servidor nadie puede dar Siguiente ni Detener
    recorridosRetry = setTimeout(recorridosConnect, RECORRIDOS_RETRY_MS);
  };
  socket.onerror = () => {}; // Servidor apagado: onclose reintenta sin llenar la consola
}

function recorridosHandle(msg) {
  if (msg.type === "run") {
    if (recorridosRun) recorridosRun.cancelled = true;
    recorridosStart(msg).catch(() => {});
    return;
  }
  if (!recorridosRun || msg.run_id !== recorridosRun.id) return;
  if (msg.type === "next" && recorridosRun.waitingNext) {
    const resolve = recorridosRun.waitingNext;
    recorridosRun.waitingNext = null;
    resolve();
  } else if (msg.type === "stop") {
    recorridosRun.cancelled = true;
    recorridosRun.waitingNext?.();
  }
}

class RecorridosStopped extends Error {}

function recorridosCheck(run) {
  if (run.cancelled) throw new RecorridosStopped("detenido");
}

async function recorridosWaitLoaded(tabId, run) {
  const deadline = Date.now() + RECORRIDOS_LOAD_TIMEOUT_MS;
  await recorridosSleep(250); // Darle tiempo a que la navegacion arranque y el status pase a loading
  while (Date.now() < deadline) {
    recorridosCheck(run);
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await recorridosSleep(200);
  }
}

/// Inyecta el buscador y el reproductor en todos los frames; los que no se dejan (paginas internas) se saltan.
async function recorridosInject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: RECORRIDOS_PAGE_FILES });
  } catch {
    // Pagina cargando o frame de chrome://: el siguiente intento lo vuelve a probar.
  }
}

async function recorridosClearAll(tabId, keepCursor) {
  try {
    await tutorRun(tabId, (keep) => window.__recorridos?.clear(keep), [keepCursor]);
  } catch {
    // Pestana ya cerrada o navegando.
  }
}

/// Busca el elemento del paso hasta encontrarlo o agotar el tiempo; la pagina puede seguir cargando.
async function recorridosLocate(run, step) {
  const query = { text: step.text ?? null, selector: step.selector ?? null, role: step.role ?? null };
  const deadline = Date.now() + (step.timeout_ms || 10000);
  let seen = [];
  while (true) {
    recorridosCheck(run);
    await recorridosInject(run.tabId);
    try {
      const results = await tutorRun(run.tabId, (q) => window.__tutor?.locate(q) ?? [], [query]);
      // Por texto solo cuenta un elemento cuyo texto sea casi el buscado: un contenedor enorme que lo trae
      // adentro (un panel entero) tambien "lo contiene", y darlo por bueno hacia pasar pruebas en falso.
      seen = tutorMergeCandidates(results).filter((c) => step.selector || c.score >= RECORRIDOS_MIN_TEXT_SCORE);
      const chosen = seen.filter((c) => !c.covered)[step.nth || 0] || seen[step.nth || 0];
      if (chosen) return chosen;
    } catch {
      // Navegando a media busqueda: se reintenta.
    }
    if (Date.now() >= deadline) {
      const target = step.text ? `"${step.text}"` : step.selector;
      throw new Error(`no encontré ${target} en la página después de ${Math.round((step.timeout_ms || 10000) / 1000)} s`);
    }
    await recorridosSleep(RECORRIDOS_LOCATE_EVERY_MS);
  }
}

async function recorridosStep(run, step) {
  if (step.action === "goto") {
    await chrome.tabs.update(run.tabId, { url: step.url });
    await recorridosWaitLoaded(run.tabId, run);
    return "página cargada";
  }
  const found = await recorridosLocate(run, step);
  if (run.lastFrame != null && run.lastFrame !== found.frameId) {
    await tutorRun(run.tabId, () => window.__recorridos?.clear(false), [], [run.lastFrame]).catch(() => {});
  }
  run.lastFrame = found.frameId;
  const [outcome] = await tutorRun(
    run.tabId,
    (args) => window.__recorridos?.perform(args) ?? { ok: false, error: "el reproductor no cargó en ese frame" },
    [{ index: found.index, action: step.action, value: step.value ?? null, animate: run.mode === "show",
      human: run.human, highlight: run.highlight }],
    [found.frameId],
  );
  const result = outcome?.result;
  if (!result?.ok) throw new Error(result?.error || "no se pudo ejecutar el paso");
  if (step.action === "click") await recorridosWaitLoaded(run.tabId, run); // Por si el clic navego
  return found.name ? `${found.name}` : "listo";
}

const RECORRIDOS_PANEL_PREFIX = "http://127.0.0.1:8798";
const RECORRIDOS_HISTORY_MAX = 30;
const recorridosHistory = []; // Pestanas que Eduardo fue teniendo enfrente, la mas reciente al final

const recorridosIsPanel = (tab) => (tab.url || tab.pendingUrl || "").startsWith(RECORRIDOS_PANEL_PREFIX);

/// Se guardan todas, tambien el panel: una pestana nueva que luego se convierte en el panel se descarta
/// al elegir, porque ahi se revisa su URL del momento.
function recorridosRemember(tabId) {
  const at = recorridosHistory.indexOf(tabId);
  if (at >= 0) recorridosHistory.splice(at, 1);
  recorridosHistory.push(tabId);
  if (recorridosHistory.length > RECORRIDOS_HISTORY_MAX) recorridosHistory.shift();
}

chrome.tabs.onActivated.addListener(({ tabId }) => recorridosRemember(tabId));
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  if (tab) recorridosRemember(tab.id);
});

/// En vivo: la pestana que Eduardo tenia enfrente antes de ir al panel (el panel nunca, porque desde ahi
/// le da play). Si el service worker se reinicio y perdio la cuenta, la activa de otra ventana.
async function recorridosShowTab() {
  for (let i = recorridosHistory.length - 1; i >= 0; i--) {
    const tab = await chrome.tabs.get(recorridosHistory[i]).catch(() => null);
    if (tab && !recorridosIsPanel(tab) && !tab.incognito) return tab;
  }
  const active = await chrome.tabs.query({ active: true, windowType: "normal" });
  const candidates = active.filter((t) => !recorridosIsPanel(t) && !t.incognito);
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: "normal" });
  return candidates.find((t) => t.id === focused?.id) || candidates[0] || null;
}

async function recorridosPickTab(mode, startUrl) {
  if (mode === "verify") {
    // Pestana de fondo para no moverle nada a Eduardo mientras trabaja
    const tab = await chrome.tabs.create({ url: startUrl, active: false });
    return { tabId: tab.id, ownTab: true };
  }
  const tab = await recorridosShowTab();
  if (!tab) throw new Error("no hay una pestaña donde reproducirlo: abre una pestaña aparte del panel");
  return { tabId: tab.id, ownTab: false };
}

/// Avisa al panel que se espera el Siguiente del paso index y se queda ahi hasta recibirlo (o un Detener).
async function recorridosWaitNext(run, index) {
  recorridosSend({ type: "waiting_next", run_id: run.id, index });
  await new Promise((resolve) => { run.waitingNext = resolve; });
  recorridosCheck(run);
}

async function recorridosStart(msg) {
  const { flow } = msg;
  const run = {
    id: msg.run_id, mode: msg.mode, pace: msg.pace, human: Boolean(msg.human), highlight: Boolean(msg.highlight),
    cancelled: false, waitingNext: null, lastFrame: null,
  };
  recorridosRun = run;
  let failedStep = null;
  try {
    Object.assign(run, await recorridosPickTab(run.mode, flow.start_url));
    if (!run.ownTab) await chrome.tabs.update(run.tabId, { url: flow.start_url, active: true });
    await recorridosWaitLoaded(run.tabId, run);
    for (let i = 0; i < flow.steps.length; i++) {
      recorridosCheck(run);
      const step = flow.steps[i];
      if (step.action === "pause") {
        // Pausa: el recorrido se queda donde va (cursor quieto) hasta que Eduardo da Siguiente; asi una
        // demo por partes no repite la ruta desde el inicio. En la prueba de fondo no hay a quien esperar.
        if (run.mode === "show") await recorridosWaitNext(run, i);
        recorridosSend({ type: "step", run_id: run.id, index: i, status: "done", detail: "continuó" });
        continue;
      }
      if (run.pace === "manual") await recorridosWaitNext(run, i);
      failedStep = i;
      recorridosSend({ type: "step", run_id: run.id, index: i, status: "running" });
      await recorridosClearAll(run.tabId, true);
      const detail = await recorridosStep(run, step);
      recorridosSend({ type: "step", run_id: run.id, index: i, status: "done", detail });
      failedStep = null;
      const nextIsPause = flow.steps[i + 1]?.action === "pause";
      if (run.mode === "show" && run.pace === "auto" && i < flow.steps.length - 1 && !nextIsPause) {
        // Con ritmo humano la pausa varia: nadie da clics a intervalos exactos
        await recorridosSleep(run.human ? RECORRIDOS_PAUSE_MS + Math.random() * 1100 : RECORRIDOS_PAUSE_MS);
      }
    }
    recorridosSend({ type: "finished", run_id: run.id, ok: true });
  } catch (err) {
    if (!(err instanceof RecorridosStopped)) {
      if (failedStep != null) {
        recorridosSend({ type: "step", run_id: run.id, index: failedStep, status: "failed", detail: err.message });
      }
      recorridosSend({ type: "finished", run_id: run.id, ok: false, error: err.message, failed_step: failedStep });
    }
  } finally {
    if (recorridosRun === run) recorridosRun = null;
    if (run.ownTab && run.tabId != null) {
      chrome.tabs.remove(run.tabId).catch(() => {});
    } else if (run.tabId != null && run.cancelled) {
      await recorridosClearAll(run.tabId, false);
    } else if (run.tabId != null) {
      // En vivo: el cursor se va al terminar y el ultimo recuadro se queda unos segundos para explicarlo
      await recorridosSleep(1200);
      await tutorRun(run.tabId, () => window.__recorridos?.hideCursor()).catch(() => {});
      setTimeout(() => {
        if (!recorridosRun) recorridosClearAll(run.tabId, false);
      }, 6000);
    }
  }
}

chrome.alarms.create("recorridos", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "recorridos") recorridosConnect();
});

recorridosConnect();
