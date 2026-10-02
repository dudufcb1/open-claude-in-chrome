// Background service worker for Open Claude in Chrome extension.
// Handles: native messaging, CDP via chrome.debugger, tool dispatch, tab group management.

// Prevent unhandled rejections from killing the service worker
self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
});

const NATIVE_HOST_NAME = "com.anthropic.open_claude_in_chrome";

// --- State ---
let nativePort = null;
let tabGroupId = null;
let tabGroupTabs = new Set();
const attachedTabs = new Map(); // tabId -> { enabledDomains: Set }
const consoleMessages = new Map(); // tabId -> [{level, text, timestamp, url}]
const networkRequests = new Map(); // tabId -> [{url, method, status, type, timestamp}]
const screenshotStore = new Map(); // imageId -> base64

// --- Keep-alive alarm ---
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    if (!nativePort) connectNativeHost();
  }
});

// --- Native messaging ---
function connectNativeHost() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    nativePort.onMessage.addListener((msg) => {
      if (msg.type === "tool_request" && msg.id) {
        handleToolRequest(msg.id, msg.tool, msg.args || {});
      }
    });

    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      nativePort = null;
      // Retry in 2 seconds
      setTimeout(connectNativeHost, 2000);
    });
  } catch (e) {
    nativePort = null;
    setTimeout(connectNativeHost, 2000);
  }
}

function sendResponse(id, result) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ id, type: "tool_response", result });
  } catch {
    // Port disconnected
  }
}

function sendError(id, error) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ id, type: "tool_error", error: String(error) });
  } catch {
    // Port disconnected
  }
}

// --- Tab group management ---
async function ensureTabGroup(createIfEmpty) {
  // Check if our tab group still exists
  if (tabGroupId !== null) {
    try {
      const group = await chrome.tabGroups.get(tabGroupId);
      if (group) {
        // Verify tabs are still in the group
        const tabs = await chrome.tabs.query({ groupId: tabGroupId });
        tabGroupTabs = new Set(tabs.map((t) => t.id));
        if (tabGroupTabs.size > 0) return;
      }
    } catch {
      tabGroupId = null;
      tabGroupTabs.clear();
    }
  }

  if (!createIfEmpty) return;

  // Evita acumulacion infinita de grupos huerfanos de sesiones viejas. Solo si ya
  // hay mas de MAX_MCP_GROUPS grupos nuestros se cierran TODOS antes de abrir el
  // nuevo. El umbral evita reventar grupos donde otra instancia siga trabajando.
  const MAX_MCP_GROUPS = 5;
  try {
    const ours = (await chrome.tabGroups.query({}))
      .filter((g) => g.title === "MCP" || g.title === "Chrome");
    if (ours.length > MAX_MCP_GROUPS) {
      for (const g of ours) {
        const gtabs = await chrome.tabs.query({ groupId: g.id });
        const ids = gtabs.map((t) => t.id).filter((id) => id != null);
        if (ids.length) { try { await chrome.tabs.remove(ids); } catch {} }
      }
      tabGroupId = null;
      tabGroupTabs.clear();
    }
  } catch {}

  // Create a tab in the current window, group it
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, { title: "Chrome", color: "blue" });
  tabGroupId = groupId;
  tabGroupTabs = new Set([tab.id]);
}

function formatTabContext(tabs) {
  const available = tabs.map((t) => ({
    tabId: t.id,
    title: t.title || "Untitled",
    url: t.url || "",
  }));

  let text = `Tab Context:\n- Available tabs:\n`;
  for (const t of available) {
    text += `  \u2022 tabId ${t.tabId}: "${t.title}" (${t.url})\n`;
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ availableTabs: available, tabGroupId }) + "\n\n" + text,
      },
    ],
  };
}

async function isInGroup(tabId) {
  // Always check live state — in-memory tabGroupTabs can be stale after service worker restart
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId !== -1) {
      // Recover tabGroupId if we lost it (service worker restart)
      if (tabGroupId === null) {
        try {
          const group = await chrome.tabGroups.get(tab.groupId);
          if (group.title === "Chrome") {
            tabGroupId = group.id;
            const groupTabs = await chrome.tabs.query({ groupId: tabGroupId });
            tabGroupTabs = new Set(groupTabs.map((t) => t.id));
          }
        } catch {}
      }
      return tab.groupId === tabGroupId;
    }
    return tabGroupTabs.has(tabId);
  } catch {
    return false;
  }
}

// --- CDP helpers ---
async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.set(tabId, { enabledDomains: new Set() });
  // Force devicePixelRatio to 1 so screenshots match CSS coordinate space.
  // Without this, Retina displays produce 2x screenshots and all coordinates are wrong.
  // RETINA_OVERRIDE: set to true on HiDPI/Retina displays where screenshots come out
  // at 2x resolution. When false (default), only deviceScaleFactor is forced to 1
  // without altering the viewport dimensions -- this preserves the real viewport height
  // and prevents layout issues (buttons pushed off-screen, scroll not working, etc).
  const RETINA_OVERRIDE = false;
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
    width: RETINA_OVERRIDE ? win.width : 0,
    height: RETINA_OVERRIDE ? win.height : 0,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function ensureDomain(tabId, domain) {
  const state = attachedTabs.get(tabId);
  if (!state) throw new Error("Not attached to tab");
  if (state.enabledDomains.has(domain)) return;
  await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`, {});
  state.enabledDomains.add(domain);
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabGroupTabs.delete(tabId);
  if (attachedTabs.has(tabId)) {
    try { chrome.debugger.detach({ tabId }); } catch {}
    attachedTabs.delete(tabId);
  }
  consoleMessages.delete(tabId);
  networkRequests.delete(tabId);
});

// Handle user dismissing debugger bar
chrome.debugger.onDetach.addListener((source, reason) => {
  attachedTabs.delete(source.tabId);
});

// --- CDP event listeners for console and network ---
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;

  if (method === "Console.messageAdded" && params.message) {
    const msgs = consoleMessages.get(tabId) || [];
    msgs.push({
      level: params.message.level,
      text: params.message.text,
      url: params.message.url || "",
      timestamp: Date.now(),
    });
    // Keep last 1000
    if (msgs.length > 1000) msgs.splice(0, msgs.length - 1000);
    consoleMessages.set(tabId, msgs);
  }

  if (method === "Runtime.consoleAPICalled" && params.args) {
    const msgs = consoleMessages.get(tabId) || [];
    const text = params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    msgs.push({
      level: params.type || "log",
      text,
      url: params.stackTrace?.callFrames?.[0]?.url || "",
      timestamp: Date.now(),
    });
    if (msgs.length > 1000) msgs.splice(0, msgs.length - 1000);
    consoleMessages.set(tabId, msgs);
  }

  if (method === "Network.responseReceived" && params.response) {
    const reqs = networkRequests.get(tabId) || [];
    reqs.push({
      url: params.response.url,
      method: params.response.requestHeaders ? "?" : "GET",
      status: params.response.status,
      statusText: params.response.statusText,
      type: params.type || "Other",
      mimeType: params.response.mimeType,
      timestamp: Date.now(),
    });
    if (reqs.length > 1000) reqs.splice(0, reqs.length - 1000);
    networkRequests.set(tabId, reqs);
  }

  if (method === "Network.requestWillBeSent" && params.request) {
    const reqs = networkRequests.get(tabId) || [];
    reqs.push({
      url: params.request.url,
      method: params.request.method,
      status: 0,
      type: params.type || "Other",
      timestamp: Date.now(),
    });
    if (reqs.length > 1000) reqs.splice(0, reqs.length - 1000);
    networkRequests.set(tabId, reqs);
  }
});

// --- Key code mapping ---
const KEY_MAP = {
  enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape",
  backspace: "Backspace", delete: "Delete", space: "Space", " ": "Space",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};

function parseKeyCombo(keyStr) {
  const parts = keyStr.split("+").map((p) => p.trim().toLowerCase());
  let modifiers = 0;
  let key = "";
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers |= 2;
    else if (part === "alt") modifiers |= 1;
    else if (part === "shift") modifiers |= 8;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") modifiers |= 4;
    else key = KEY_MAP[part] || part;
  }
  return { key, modifiers };
}

function parseModifierString(modStr) {
  if (!modStr) return 0;
  let modifiers = 0;
  const parts = modStr.split("+").map((p) => p.trim().toLowerCase());
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers |= 2;
    else if (part === "alt") modifiers |= 1;
    else if (part === "shift") modifiers |= 8;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") modifiers |= 4;
  }
  return modifiers;
}

// --- Content script communication ---
async function sendContentMessage(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response;
  } catch {
    // Content script might not be injected yet, try injecting
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    // Retry
    return chrome.tabs.sendMessage(tabId, message);
  }
}

// --- Resolve ref to coordinates ---
async function resolveRefToCoordinates(tabId, ref) {
  const resp = await sendContentMessage(tabId, { type: "getRefCoordinates", ref });
  if (resp?.result) return [resp.result.x, resp.result.y];
  return null;
}

// --- Screenshot helper ---
// Cap viewport to 1280x800 for screenshots to keep size manageable.
// Retina displays produce 2x+ resolution PNGs that blow up base64 size.
const MAX_SCREENSHOT_WIDTH = 1280;
const MAX_SCREENSHOT_HEIGHT = 800;

async function takeScreenshot(tabId, lossless = false) {
  await ensureAttached(tabId);

  // With deviceScaleFactor: 1 set in ensureAttached, screenshots are captured
  // at CSS pixel dimensions (e.g., 1080x746), matching the coordinate space
  // used by Input.dispatchMouseEvent. No scaling tricks needed.
  // lossless: PNG at full quality, meant to be persisted to disk by the
  // client (e.g. building a user manual); skips the size-reduction fallback.
  const result = await cdp(tabId, "Page.captureScreenshot", lossless ? {
    format: "png",
    optimizeForSpeed: true,
    captureBeyondViewport: false,
  } : {
    format: "jpeg",
    quality: 55,
    optimizeForSpeed: true,
    captureBeyondViewport: false,
  });
  let base64 = result.data;

  // If still too large (>500KB base64 ≈ ~375KB binary), reduce quality further
  if (!lossless && base64.length > 500000) {
    const smaller = await cdp(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 30,
      optimizeForSpeed: true,
      captureBeyondViewport: false,
    });
    base64 = smaller.data;
  }

  const imageId = `screenshot_${Date.now()}`;
  screenshotStore.set(imageId, base64);
  // Keep only last 10 screenshots (less memory pressure)
  const keys = Array.from(screenshotStore.keys());
  while (keys.length > 10) {
    screenshotStore.delete(keys.shift());
  }

  return { base64, imageId, format: lossless ? "png" : "jpeg" };
}

// --- Mouse helpers ---
async function dispatchMouse(tabId, type, x, y, opts = {}) {
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: opts.button || "left",
    clickCount: opts.clickCount || 1,
    modifiers: opts.modifiers || 0,
  });
}

async function mouseClick(tabId, x, y, opts = {}) {
  const button = opts.button || "left";
  const clickCount = opts.clickCount || 1;
  const modifiers = opts.modifiers || 0;

  await dispatchMouse(tabId, "mouseMoved", x, y, { modifiers });
  await sleep(50);
  await dispatchMouse(tabId, "mousePressed", x, y, { button, clickCount, modifiers });
  await sleep(50);
  await dispatchMouse(tabId, "mouseReleased", x, y, { button, clickCount, modifiers });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Tool handlers ---
const toolHandlers = {
  async tabs_context_mcp(args) {
    await ensureTabGroup(args.createIfEmpty);
    if (tabGroupId === null) {
      return {
        content: [{ type: "text", text: "No MCP tab group exists. Use createIfEmpty: true to create one." }],
      };
    }
    const tabs = await chrome.tabs.query({ groupId: tabGroupId });
    return formatTabContext(tabs);
  },

  async tabs_create_mcp(args) {
    await ensureTabGroup(true);
    const tab = await chrome.tabs.create({ active: true });
    await chrome.tabs.group({ tabIds: [tab.id], groupId: tabGroupId });
    tabGroupTabs.add(tab.id);
    const tabs = await chrome.tabs.query({ groupId: tabGroupId });
    const result = formatTabContext(tabs);
    result.content[0].text = `Created new tab. Tab ID: ${tab.id}\n\n` + result.content[0].text;
    return result;
  },

  async navigate(args) {
    const { url, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    if (url === "back") {
      await chrome.tabs.goBack(tabId);
    } else if (url === "forward") {
      await chrome.tabs.goForward(tabId);
    } else {
      let targetUrl = url;
      // Strip any malformed protocol prefix before normalizing
      if (!targetUrl.match(/^https?:\/\//i) && !targetUrl.startsWith("about:") && !targetUrl.startsWith("chrome:") && !targetUrl.startsWith("brave:")) {
        // Remove any partial/broken protocol prefix (e.g., "hps://", "http:/", "ht://")
        targetUrl = targetUrl.replace(/^[a-z]{1,5}:\/+/i, "");
        targetUrl = "https://" + targetUrl;
      }
      try {
        new URL(targetUrl); // Validate URL before passing to Chrome
      } catch {
        return { content: [{ type: "text", text: `Invalid URL: "${url}". Could not parse as a valid URL.` }] };
      }
      await chrome.tabs.update(tabId, { url: targetUrl });
    }

    // Wait for page load — short timeout to avoid service worker idle kill
    // If the page takes longer, the caller can use screenshot/wait to check
    await new Promise((resolve) => {
      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // 10s max — enough for most pages, avoids service worker timeout
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 10000);
    });

    const tab = await chrome.tabs.get(tabId);
    const tabs = await chrome.tabs.query({ groupId: tabGroupId });
    const loading = tab.status !== "complete" ? " (still loading)" : "";
    const text = `Navigated to ${tab.url}${loading}.\n## Pages\n` +
      tabs.map((t, i) => `${i + 1}: ${t.url}${t.id === tabId ? " [selected]" : ""}`).join("\n");

    return { content: [{ type: "text", text }] };
  },

  async keyword_planner(args) {
    const { words, tabId } = args;
    if (!Array.isArray(words) || !words.length) return { content: [{ type: "text", text: "keyword_planner: 'words' debe ser un array no vacio." }] };
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    const ev = async (expr) => {
      await ensureAttached(tabId);
      const r = await cdp(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true });
      return r?.result?.value;
    };
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

    // Cuenta PC MARKET (503-017-6339): URL directa, salta el selector de cuenta.
    const KP_URL = "https://ads.google.com/aw/keywordplanner/home?ocid=90789702&__c=2463566998&__e=5030176339&authuser=0";
    // KP (Google Ads SPA) NO renderiza la tabla del plan si la pestaña esta en
    // segundo plano (throttling de tabs inactivas). Hay que ACTIVARLA y enfocar su
    // ventana, si no el extractor lee filas vacias ("no renderizo filas").
    await chrome.tabs.update(tabId, { url: KP_URL, active: true });
    try { const _t = await chrome.tabs.get(tabId); await chrome.windows.update(_t.windowId, { focused: true }); } catch (e) {}
    await new Promise((resolve) => {
      const listener = (id, info) => { if (id === tabId && info.status === "complete") { chrome.tabs.onUpdated.removeListener(listener); resolve(); } };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 10000);
    });

    // Snippets resilientes: click por texto, escritura por setter nativo, extraccion por roles.
    const clickByText = (needle, exact) =>
      "(()=>{const needle=" + JSON.stringify(needle) + ";const exact=" + (exact ? "true" : "false") + ";" +
      "for(const el of document.querySelectorAll('*')){" +
      "const own=Array.from(el.childNodes).filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim();" +
      "const m=exact?own===needle:own.includes(needle);if(!m)continue;" +
      "const t=el.closest('[role=button],button,a')||el;const r=t.getBoundingClientRect();" +
      "const cx=r.left+r.width/2,cy=r.top+r.height/2;" +
      "for(const e of ['mousedown','mouseup','click'])t.dispatchEvent(new MouseEvent(e,{bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy}));" +
      "try{t.click()}catch(_){}return true}return false})()";
    const setKeywords = (ws) =>
      "(()=>{const ta=document.querySelector('textarea');if(!ta)return false;ta.focus();" +
      "const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;" +
      "s.call(ta," + JSON.stringify(ws.join(", ")) + ");" +
      "ta.dispatchEvent(new Event('input',{bubbles:true}));ta.dispatchEvent(new Event('change',{bubbles:true}));return true})()";
    const hasText = (needle) => "document.body.innerText.toLowerCase().includes(" + JSON.stringify(needle.toLowerCase()) + ")";
    const extractRows =
      "(()=>{const out=[];for(const r of document.querySelectorAll('[role=row]')){" +
      "const cells=[...r.querySelectorAll('[role=gridcell],[role=cell],td')];" +
      "const c=cells.map(x=>(x.getAttribute('title')||x.innerText||'').trim().replace(/\\s+/g,' '));" +
      "if(c.length<5)continue;const k=c[0];if(!k||/palabra clave/i.test(k))continue;" +
      "out.push({keyword:k,volumen_mensual:c[1]||'',cambio_3m:c[2]||'',cambio_interanual:c[3]||'',competencia:c[4]||'',pct_impresiones:c[5]||'',puja_baja:c[6]||'',puja_alta:c[7]||''})}return out})()";

    // Abrir "Conozca el volumen de busqueda" (volumen de cada keyword exacta)
    let opened = false;
    for (let i = 0; i < 20 && !opened; i++) {
      if (await ev(hasText("Conozca el volumen"))) opened = await ev(clickByText("Conozca el volumen", false));
      if (!opened) await sleep(1500);
    }
    if (!opened) return { content: [{ type: "text", text: "keyword_planner: no se pudo abrir la tarjeta (¿sesion/cuenta? revisa login)." }] };

    // Escribir keywords (separadas por coma)
    let wrote = false;
    for (let i = 0; i < 12 && !wrote; i++) { wrote = await ev(setKeywords(words)); if (!wrote) await sleep(1000); }

    // Submit ("Inicio"). KP navega a la vista de plan (historical) con un splash que
    // puede tardar varios segundos; por eso se sondea LARGO hasta que rendericen las
    // filas reales (antes, 25x1.5s se quedaba corto y devolvia "no encontrada" en todo).
    try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
    await ev(clickByText("Inicio", true));
    await sleep(2000);
    let rows = [];
    // Tope ~40s de sondeo para NO rebasar el timeout de 60s del MCP. Si KP esta lento
    // y no alcanza, devuelve el mensaje de abajo y se reintenta (el plan ya queda
    // cargado, asi que el reintento responde al instante).
    for (let i = 0; i < 18; i++) { rows = (await ev(extractRows)) || []; if (rows.length) break; await sleep(2000); }

    // Distinguir "KP lento / no cargo" de "keyword sin volumen": si NO hay ninguna
    // fila, el problema es de carga, no que las keywords no existan.
    if (!rows.length) return { content: [{ type: "text", text: "keyword_planner: el plan no renderizo filas a tiempo (KP lento). Los datos quedan en el plan guardado; reintenta la consulta." }] };

    // Match tolerante a acentos (KP a veces normaliza 'mexico'/'méxico').
    const norm = (s) => (s || "").toString().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
    const byKw = {};
    for (const r of rows) byKw[norm(r.keyword)] = r;
    const result = words.map((w) => byKw[norm(w)] || { keyword: w, error: "no encontrada" });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },

  async download_url(args) {
    const { url, filename, tabId } = args;
    if (!url) return { content: [{ type: "text", text: "download_url: falta 'url'." }] };
    if (!tabId) return { content: [{ type: "text", text: "download_url: falta 'tabId' (el tab cuya sesion se usa para bajar la URL)." }] };
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} no esta en el grupo MCP.` }] };

    const dir = args.downloadDir || "/home/edu/Descargas";
    const fn = (filename || "download").replace(/['"\\]/g, "");
    await ensureAttached(tabId);

    // Forzar carpeta de descarga SIN dialogo del SO, independiente de la config del perfil.
    let forced = false;
    try { await cdp(tabId, "Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dir, eventsEnabled: false }); forced = true; }
    catch (e1) {
      try { await cdp(tabId, "Page.setDownloadBehavior", { behavior: "allow", downloadPath: dir }); forced = true; }
      catch (e2) { return { content: [{ type: "text", text: "No se pudo forzar download behavior: " + String(e2) }] }; }
    }

    // Descargar via fetch->blob->click en el contexto del tab (hereda cookies de la sesion).
    const expr =
      "(function(){var u=" + JSON.stringify(url) + ";var fn=" + JSON.stringify(fn) + ";" +
      "window.__dlDone=false;window.__dlErr='';window.__dlSize=0;" +
      "fetch(u).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.blob();}).then(function(b){" +
      "window.__dlSize=b.size;var bu=URL.createObjectURL(b);var a=document.createElement('a');a.href=bu;a.download=fn;" +
      "document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(bu);a.remove();},8000);window.__dlDone=true;" +
      "}).catch(function(e){window.__dlErr=String(e);window.__dlDone=true;});return 'started';})()";
    await cdp(tabId, "Runtime.evaluate", { expression: expr });
    await new Promise((r) => setTimeout(r, 3500));
    let info = "";
    try {
      const chk = await cdp(tabId, "Runtime.evaluate", { expression: "JSON.stringify({done:window.__dlDone,err:window.__dlErr,size:window.__dlSize})", returnByValue: true });
      info = (chk && chk.result && chk.result.value) || "";
    } catch (e) { info = "(no se pudo leer estado)"; }
    return { content: [{ type: "text", text: "download_url -> carpeta=" + dir + " filename=" + fn + " forced=" + forced + " | " + info }] };
  },

  async computer(args) {
    const { action, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    let coordinate = args.coordinate;
    // Resolve ref to coordinates if provided
    if (args.ref && !coordinate) {
      const coords = await resolveRefToCoordinates(tabId, args.ref);
      if (!coords) return { content: [{ type: "text", text: `Could not resolve ref "${args.ref}" to coordinates.` }] };
      coordinate = coords;
    }

    const modifiers = parseModifierString(args.modifiers);

    switch (action) {
      case "screenshot": {
        const { base64, imageId, format } = await takeScreenshot(tabId, !!args.lossless);
        // Get viewport dimensions for the response message
        let dims = "";
        try {
          const vp = await cdp(tabId, "Runtime.evaluate", {
            expression: "window.innerWidth + 'x' + window.innerHeight",
          });
          if (vp?.result?.value) dims = vp.result.value;
        } catch {}
        return {
          content: [
            { type: "text", text: `Successfully captured screenshot (${dims}, ${format}) - ID: ${imageId}` },
            { type: "image", data: base64, mimeType: `image/${format}` },
          ],
        };
      }

      case "left_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for left_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { modifiers });
        return { content: [{ type: "text", text: `Clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "js_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for js_click" }] };
        await ensureAttached(tabId);
        const [x, y] = coordinate;
        const expression = `
          (() => {
            const el = document.elementFromPoint(${x}, ${y});
            if (!el) return { ok: false, error: 'no element at (' + ${x} + ',' + ${y} + ')' };
            const desc = (el.tagName || '') + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
            // Walk up DOM looking for clickable ancestor (button, a, [role=button], [onclick])
            let target = el;
            let depth = 0;
            while (target && depth < 6) {
              const t = target.tagName;
              if (t === 'BUTTON' || t === 'A' || target.getAttribute('role') === 'button' || target.onclick || target.getAttribute('onclick')) break;
              target = target.parentElement;
              depth++;
            }
            if (!target) target = el;
            // Dispatch full mouse event sequence + click
            const rect = target.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const mkEvent = (type) => new MouseEvent(type, { view: window, bubbles: true, cancelable: true, button: 0, clientX: cx, clientY: cy });
            target.dispatchEvent(mkEvent('mousedown'));
            target.dispatchEvent(mkEvent('mouseup'));
            target.dispatchEvent(mkEvent('click'));
            // Also call .click() in case the framework uses pointer events / Vue/React synthetic listeners
            try { target.click(); } catch(e) {}
            return { ok: true, target: (target.tagName || '') + (target.id ? '#' + target.id : '') + (target.className && typeof target.className === 'string' ? '.' + target.className.trim().split(/\\s+/).slice(0,3).join('.') : ''), elementAtPoint: desc };
          })()
        `;
        const result = await cdp(tabId, "Runtime.evaluate", { expression, returnByValue: true });
        const value = result?.result?.value;
        if (value && value.ok) {
          return { content: [{ type: "text", text: `JS-clicked at (${x}, ${y}) target=<${value.target}> elementAtPoint=<${value.elementAtPoint}>` }] };
        }
        return { content: [{ type: "text", text: `JS click failed: ${value?.error || result?.exceptionDetails?.text || 'unknown'}` }] };
      }

      case "right_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for right_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { button: "right", modifiers });
        return { content: [{ type: "text", text: `Right-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "double_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for double_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { clickCount: 2, modifiers });
        return { content: [{ type: "text", text: `Double-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "triple_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for triple_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { clickCount: 3, modifiers });
        return { content: [{ type: "text", text: `Triple-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "hover": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for hover" }] };
        await dispatchMouse(tabId, "mouseMoved", coordinate[0], coordinate[1], { modifiers });
        await sleep(200);
        return { content: [{ type: "text", text: `Hovered at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "type": {
        if (!args.text) return { content: [{ type: "text", text: "text is required for type action" }] };
        await ensureAttached(tabId);
        // Type character by character for better compatibility
        for (const char of args.text) {
          await cdp(tabId, "Input.insertText", { text: char });
          await sleep(10);
        }
        return { content: [{ type: "text", text: `Typed "${args.text.substring(0, 50)}${args.text.length > 50 ? "..." : ""}"` }] };
      }

      case "key": {
        if (!args.text) return { content: [{ type: "text", text: "text is required for key action" }] };
        await ensureAttached(tabId);
        const repeat = Math.min(args.repeat || 1, 100);
        // Parse space-separated key combos
        const keys = args.text.split(" ").filter(Boolean);
        for (let r = 0; r < repeat; r++) {
          for (const keyStr of keys) {
            const { key, modifiers: keyMod } = parseKeyCombo(keyStr);
            const resolvedKey = key.length === 1 ? key : key;
            await cdp(tabId, "Input.dispatchKeyEvent", {
              type: "keyDown",
              key: resolvedKey,
              code: resolvedKey.length === 1 ? `Key${resolvedKey.toUpperCase()}` : resolvedKey,
              modifiers: keyMod,
              windowsVirtualKeyCode: resolvedKey.charCodeAt ? resolvedKey.charCodeAt(0) : 0,
            });
            await cdp(tabId, "Input.dispatchKeyEvent", {
              type: "keyUp",
              key: resolvedKey,
              code: resolvedKey.length === 1 ? `Key${resolvedKey.toUpperCase()}` : resolvedKey,
              modifiers: keyMod,
            });
            await sleep(30);
          }
        }
        return { content: [{ type: "text", text: `Pressed ${repeat} key${repeat > 1 ? "s" : ""}: ${args.text}` }] };
      }

      case "scroll": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for scroll" }] };
        const dir = args.scroll_direction || "down";
        const amount = Math.min(args.scroll_amount || 3, 10);
        const deltaX = dir === "left" ? -amount * 100 : dir === "right" ? amount * 100 : 0;
        const deltaY = dir === "up" ? -amount * 100 : dir === "down" ? amount * 100 : 0;
        await cdp(tabId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: coordinate[0],
          y: coordinate[1],
          deltaX,
          deltaY,
          modifiers,
        });
        await sleep(300);
        const { base64 } = await takeScreenshot(tabId);
        return {
          content: [
            { type: "text", text: `Scrolled ${dir} by ${amount} ticks at (${coordinate[0]}, ${coordinate[1]})` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      case "scroll_to": {
        if (!coordinate && !args.ref) return { content: [{ type: "text", text: "coordinate or ref is required for scroll_to" }] };
        if (args.ref) {
          await sendContentMessage(tabId, {
            type: "scrollToRef",
            ref: args.ref,
          });
        }
        // Scroll target element into view via JS
        if (coordinate) {
          await cdp(tabId, "Runtime.evaluate", {
            expression: `window.scrollTo(${coordinate[0]}, ${coordinate[1]})`,
          });
        }
        await sleep(300);
        return { content: [{ type: "text", text: `Scrolled to target` }] };
      }

      case "wait": {
        const duration = Math.min(args.duration || 1, 30);
        await sleep(duration * 1000);
        return { content: [{ type: "text", text: `Waited for ${duration} second${duration !== 1 ? "s" : ""}` }] };
      }

      case "left_click_drag": {
        if (!args.start_coordinate || !coordinate) {
          return { content: [{ type: "text", text: "start_coordinate and coordinate are required for left_click_drag" }] };
        }
        const [sx, sy] = args.start_coordinate;
        const [ex, ey] = coordinate;
        await dispatchMouse(tabId, "mouseMoved", sx, sy, { modifiers });
        await sleep(50);
        await dispatchMouse(tabId, "mousePressed", sx, sy, { button: "left", modifiers });
        await sleep(50);
        // Move in steps
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          const mx = sx + ((ex - sx) * i) / steps;
          const my = sy + ((ey - sy) * i) / steps;
          await dispatchMouse(tabId, "mouseMoved", mx, my, { modifiers });
          await sleep(20);
        }
        await dispatchMouse(tabId, "mouseReleased", ex, ey, { button: "left", modifiers });
        return { content: [{ type: "text", text: `Dragged from (${sx}, ${sy}) to (${ex}, ${ey})` }] };
      }

      case "zoom": {
        if (!args.region || args.region.length !== 4) {
          return { content: [{ type: "text", text: "region [x0, y0, x1, y1] is required for zoom" }] };
        }
        // Capture full screenshot then crop region
        const { base64: fullBase64 } = await takeScreenshot(tabId);
        // Return the full screenshot with region info — client can crop
        return {
          content: [
            { type: "text", text: `Zoom region: [${args.region.join(", ")}]` },
            { type: "image", data: fullBase64, mimeType: "image/png" },
          ],
        };
      }

      default:
        return { content: [{ type: "text", text: `Unknown computer action: ${action}` }] };
    }
  },

  async read_page(args) {
    const { tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    const resp = await sendContentMessage(tabId, {
      type: "generateAccessibilityTree",
      options: {
        filter: args.filter,
        depth: args.depth,
        max_chars: args.max_chars,
        ref_id: args.ref_id,
      },
    });

    let tree = resp?.result || "Error: Could not generate accessibility tree";
    // Append viewport dimensions so Claude knows the coordinate space
    try {
      await ensureAttached(tabId);
      const vp = await cdp(tabId, "Runtime.evaluate", {
        expression: "window.innerWidth + 'x' + window.innerHeight",
      });
      if (vp?.result?.value) tree += `\n\nViewport: ${vp.result.value}`;
    } catch {}
    return { content: [{ type: "text", text: tree }] };
  },

  async get_page_text(args) {
    const { tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    const resp = await sendContentMessage(tabId, { type: "getPageText" });
    if (!resp?.result) return { content: [{ type: "text", text: "Error: Could not extract page text" }] };

    try {
      const data = JSON.parse(resp.result);
      return {
        content: [
          {
            type: "text",
            text: `Title: ${data.title}\nURL: ${data.url}\nSource: <${data.sourceTag}>\n\n${data.text}`,
          },
        ],
      };
    } catch {
      return { content: [{ type: "text", text: resp.result }] };
    }
  },

  async find(args) {
    const { query, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    const resp = await sendContentMessage(tabId, { type: "findElements", query });
    const results = resp?.result || [];

    if (results.length === 0) {
      return { content: [{ type: "text", text: `No elements found matching "${query}"` }] };
    }

    let text = `Found ${results.length} element(s) matching "${query}":\n\n`;
    for (const r of results) {
      text += `[${r.ref}] ${r.role} "${r.name}" at (${r.coordinates[0]}, ${r.coordinates[1]})\n`;
    }

    return { content: [{ type: "text", text }] };
  },

  async form_input(args) {
    const { ref, value, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    const resp = await sendContentMessage(tabId, { type: "setFormValue", ref, value });
    const result = resp?.result;

    if (result?.error) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    return { content: [{ type: "text", text: `Set ${ref} to "${value}". Result: ${JSON.stringify(result)}` }] };
  },

  async javascript_tool(args) {
    const { text, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    await ensureAttached(tabId);
    try {
      const result = await cdp(tabId, "Runtime.evaluate", {
        expression: text,
        returnByValue: true,
        awaitPromise: true,
      });

      if (result.exceptionDetails) {
        return {
          content: [{ type: "text", text: `Error: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}` }],
        };
      }

      const val = result.result;
      if (val.type === "undefined") return { content: [{ type: "text", text: "undefined" }] };
      return {
        content: [{ type: "text", text: val.value !== undefined ? JSON.stringify(val.value) : val.description || String(val) }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  },

  async read_console_messages(args) {
    const { tabId, pattern, limit = 100, onlyErrors, clear } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    // Ensure console domain is enabled
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Console");
    await ensureDomain(tabId, "Runtime");

    let msgs = consoleMessages.get(tabId) || [];

    if (onlyErrors) {
      msgs = msgs.filter((m) => ["error", "exception"].includes(m.level));
    }

    if (pattern) {
      try {
        const re = new RegExp(pattern, "i");
        msgs = msgs.filter((m) => re.test(m.text) || re.test(m.level));
      } catch {
        // Invalid regex, use as substring
        msgs = msgs.filter((m) => m.text.includes(pattern));
      }
    }

    msgs = msgs.slice(-limit);

    if (clear) {
      consoleMessages.set(tabId, []);
    }

    if (msgs.length === 0) {
      return { content: [{ type: "text", text: "No console messages matching the pattern." }] };
    }

    const text = msgs
      .map((m) => `[${m.level}] ${m.text}${m.url ? ` (${m.url})` : ""}`)
      .join("\n");

    return { content: [{ type: "text", text: `Console messages (${msgs.length}):\n${text}` }] };
  },

  async read_network_requests(args) {
    const { tabId, urlPattern, limit = 100, clear } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    // Ensure network domain is enabled
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Network");

    let reqs = networkRequests.get(tabId) || [];

    if (urlPattern) {
      reqs = reqs.filter((r) => r.url.includes(urlPattern));
    }

    reqs = reqs.slice(-limit);

    if (clear) {
      networkRequests.set(tabId, []);
    }

    if (reqs.length === 0) {
      return { content: [{ type: "text", text: "No network requests matching the pattern." }] };
    }

    const text = reqs
      .map((r) => `${r.method} ${r.url} ${r.status ? `→ ${r.status}` : "(pending)"}${r.mimeType ? ` [${r.mimeType}]` : ""}`)
      .join("\n");

    return { content: [{ type: "text", text: `Network requests (${reqs.length}):\n${text}` }] };
  },

  async tabs_activate(args) {
    const { tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    await chrome.tabs.update(tabId, { active: true });
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId > -1) {
      try { await chrome.tabGroups.update(tab.groupId, { collapsed: false }); } catch (e) {}
    }
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (e) {}
    return { content: [{ type: "text", text: `Tab ${tabId} activated and brought to front` }] };
  },

  async resize_window(args) {
    const { width, height, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { width, height });
    return { content: [{ type: "text", text: `Resized window to ${width}x${height}` }] };
  },

  async upload_image(args) {
    const { imageId, tabId, ref, coordinate, filename = "image.png" } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };

    const base64 = screenshotStore.get(imageId);
    if (!base64) {
      return { content: [{ type: "text", text: `Image ${imageId} not found. Take a screenshot first.` }] };
    }

    // Use CDP to set file input
    if (ref) {
      // Find the element and set its files via CDP
      await ensureAttached(tabId);
      const result = await cdp(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const el = window.__unblockedChrome?.resolveRef?.("${ref}");
          if (!el) return null;
          return el.tagName.toLowerCase();
        })()`,
        returnByValue: true,
      });

      if (result.result?.value === "input") {
        // For file inputs, we need DOM.setFileInputFiles via CDP
        // First get the node
        const doc = await cdp(tabId, "DOM.getDocument", {});
        const nodeResult = await cdp(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const el = window.__unblockedChrome?.resolveRef?.("${ref}");
            if (el) el.scrollIntoView();
            return true;
          })()`,
          returnByValue: true,
        });
        return { content: [{ type: "text", text: `Upload via file input requires a temporary file. Use the file input directly.` }] };
      }
    }

    return { content: [{ type: "text", text: `Image upload for ref=${ref}, coordinate=${coordinate} — use drag & drop or file input.` }] };
  },

  async gif_creator(args) {
    return { content: [{ type: "text", text: "GIF recording is not yet implemented in this extension." }] };
  },

  async shortcuts_list(args) {
    return { content: [{ type: "text", text: "No shortcuts available. Shortcuts are not supported in this extension." }] };
  },

  async shortcuts_execute(args) {
    return { content: [{ type: "text", text: "Shortcuts are not supported in this extension." }] };
  },

  async switch_browser(args) {
    return { content: [{ type: "text", text: "Browser switching is not yet supported. The extension connects to whichever browser has it loaded (Chrome, Brave, or Edge). To switch, disable the extension in the current browser, enable it in the target browser, and restart both." }] };
  },

  async update_plan(args) {
    const { domains, approach } = args;
    let text = `Plan:\n\nDomains: ${domains.join(", ")}\n\nApproach:\n`;
    for (const step of approach) {
      text += `- ${step}\n`;
    }
    text += "\nPlan auto-approved (no permission restrictions in this extension).";
    return { content: [{ type: "text", text }] };
  },
};

// --- Tool dispatch ---
async function handleToolRequest(id, tool, args) {
  const handler = toolHandlers[tool];
  if (!handler) {
    sendError(id, `Unknown tool: ${tool}`);
    return;
  }

  try {
    const result = await handler(args);
    sendResponse(id, result);
  } catch (err) {
    sendError(id, `${tool} failed: ${err.message}`);
  }
}

// --- Init ---

// Recover MCP tab group state after service worker restart
async function recoverTabGroupState() {
  try {
    const groups = await chrome.tabGroups.query({ title: "Chrome" });
    if (groups.length > 0) {
      tabGroupId = groups[0].id;
      const tabs = await chrome.tabs.query({ groupId: tabGroupId });
      tabGroupTabs = new Set(tabs.map((t) => t.id));
    }
  } catch {
    // Not critical — will be set on first tabs_context_mcp call
  }
}

recoverTabGroupState();
connectNativeHost();
