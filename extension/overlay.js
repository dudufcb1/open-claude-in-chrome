// Lado del service worker de la capa visual (overlay-page.js): inyecta la capa en la pestana, mueve
// la flecha antes de cada accion del raton, la esconde durante las capturas y recibe el boton
// Detener. Se carga desde background.js con importScripts y comparte su ambito.
//
// Solo se dibuja en una pestana visible (activa en una ventana no minimizada): en una de fondo
// nadie la ve y esperar la animacion solo haria mas lenta la tarea.

const OVERLAY_FILE = "overlay-page.js";
const OVERLAY_MOVE_CAP_MS = 700; // Tope de espera por la animacion; el clic no se retrasa mas que esto
const OVERLAY_IDLE_MS = 4000; // Sin acciones durante este tiempo, se retiran el borde y el boton
// Tools que operan la pagina: mientras corren se muestra el borde. Las de solo lectura no lo prenden.
const OVERLAY_ACTIVITY_TOOLS = new Set([
  "computer", "navigate", "form_input", "javascript_tool", "file_upload", "upload_image", "browser_batch",
]);

const overlayStoppedTabs = new Set(); // Pestanas donde se pico Detener y la siguiente tool aun no se entera

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "automaton_stop" && sender.tab?.id != null) overlayStoppedTabs.add(sender.tab.id);
});

chrome.tabs.onRemoved.addListener((tabId) => overlayStoppedTabs.delete(tabId));

async function overlayTabVisible(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) return false;
    const win = await chrome.windows.get(tab.windowId);
    return win.state !== "minimized";
  } catch {
    return false;
  }
}

/// Llama un metodo de window.__automatonOverlay en el frame principal. Con inject, si la capa no
/// esta la inyecta primero; sin inject, si no esta no hace nada. Devuelve lo que regrese el metodo,
/// o null si no se llamo o la pagina no admite scripts (chrome://, la tienda, un PDF).
async function overlayCall(tabId, method, args = [], inject = true) {
  const run = () => chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: (name, params) => (window.__automatonOverlay ? window.__automatonOverlay[name](...params) : "__missing__"),
    args: [method, args],
  });
  try {
    let [res] = await run();
    if (res?.result === "__missing__") {
      if (!inject) return null;
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [OVERLAY_FILE] });
      [res] = await run();
    }
    return res?.result ?? null;
  } catch {
    return null;
  }
}

function overlayTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
}

/// Mueve la flecha hasta (x, y) de la pestana y espera a que llegue antes de soltar el evento real.
/// press=true dibuja el aro del clic. No hace nada si la pestana no esta a la vista.
async function overlayPoint(tabId, x, y, press = false) {
  if (!(await overlayTabVisible(tabId))) return;
  await overlayTimeout(overlayCall(tabId, "move", [Math.round(x), Math.round(y), press]), OVERLAY_MOVE_CAP_MS);
}

/// Corre `capture` con la capa escondida, para que ni la flecha ni el borde salgan en la imagen.
async function overlayHiddenDuring(tabId, capture) {
  const hidden = await overlayCall(tabId, "setCapturing", [true], false);
  try {
    return await capture();
  } finally {
    if (hidden) await overlayCall(tabId, "setCapturing", [false], false);
  }
}

async function overlayActivityStart(tool, args) {
  if (!OVERLAY_ACTIVITY_TOOLS.has(tool) || typeof args?.tabId !== "number") return;
  if (await overlayTabVisible(args.tabId)) await overlayCall(args.tabId, "showActivity");
}

async function overlayActivityEnd(tool, args) {
  if (!OVERLAY_ACTIVITY_TOOLS.has(tool) || typeof args?.tabId !== "number") return;
  await overlayCall(args.tabId, "idle", [OVERLAY_IDLE_MS], false);
}

/// True una sola vez despues de que se pico Detener en la pestana: la tool que lo consulta debe
/// abortar. Luego se limpia, para que el agente pueda seguir si el usuario se lo vuelve a pedir.
function overlayConsumeStop(tabId) {
  if (!overlayStoppedTabs.has(tabId)) return false;
  overlayStoppedTabs.delete(tabId);
  return true;
}
