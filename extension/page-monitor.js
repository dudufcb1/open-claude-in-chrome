// Monitor de pagina: graba todo lo que pasa por detras de una pestana. Sirve para QA, para
// debuguear y para descifrar los endpoints que usa una app (lo que manda, con que headers y
// que le responden).
//
// Se carga desde background.js con importScripts y comparte su ambito global (nativePort, cdp,
// ensureAttached, attachedTabs, isInGroup, toolHandlers).
//
// Cada evento (request con su body, respuesta, fallo de red, consola, excepcion, aviso del
// navegador, navegacion, websocket, marca de paso) se manda al host nativo como "monitor_event" y el
// host lo agrega como una linea JSON a /tmp/page-monitor/<sesion>.jsonl. /tmp se vacia al
// reiniciar la PC, asi que las sesiones no se acumulan.
//
// Iframes de otro dominio y workers: Chrome los corre en otro proceso y el Network de la pestana
// no ve su trafico (por ejemplo el builder de workflows de GHL, que vive en un iframe de
// leadconnectorhq.com). Por eso se activa Target.setAutoAttach: Chrome engancha cada iframe o
// worker como sesion hija (sessionId) y en cada una se encienden los mismos dominios. Sus eventos
// llevan los campos frame (url del iframe o worker) y target (iframe, worker, service_worker).

const MON_DIR = "/tmp/page-monitor"; // Debe coincidir con el host nativo y con automaton
const MON_BODY_MAX_CHARS = 2_000_000; // Un body mas grande se corta y se marca body_truncated
const MON_POST_DATA_MAX_BYTES = 1_000_000;
const MON_BODY_TYPES = new Set(["XHR", "Fetch", "Document", "EventSource"]);
const MON_BACKLOG_MAX = 5000;
// waitForDebuggerOnStart deja cada iframe o worker en pausa hasta encender sus dominios, para no
// perder sus primeras llamadas. Siempre se reanuda con Runtime.runIfWaitingForDebugger.
const MON_AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

// tabId -> { session, seq, section, requests: Map(clave -> {type, mime, start}),
//            children: Map(sessionId -> {type, url, targetId}), backlog }
const monSessions = new Map();

function monPath(session) {
  return `${MON_DIR}/${session}.jsonl`;
}

/// Nombre de sesion legible y ordenable: 20261007-153012_tab123.
function monSessionName(tabId) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}_tab${tabId}`;
}

/// Manda un evento al host. Si el puerto nativo se cayo un momento, se encola y sale con el
/// siguiente evento, para no perder nada en una reconexion.
function monWrite(tabId, kind, fields) {
  const s = monSessions.get(tabId);
  if (!s) return;
  const event = { ts: new Date().toISOString(), seq: ++s.seq, kind, tab: tabId, section: s.section, ...fields };
  s.backlog.push({ type: "monitor_event", session: s.session, event });
  if (s.backlog.length > MON_BACKLOG_MAX) s.backlog.splice(0, s.backlog.length - MON_BACKLOG_MAX);
  if (!nativePort) return;
  try {
    while (s.backlog.length) {
      nativePort.postMessage(s.backlog[0]);
      s.backlog.shift();
    }
  } catch {
    // Puerto caido: lo que quedo en backlog sale en el siguiente evento.
  }
}

// --- Contexto de cada evento: la pestana o una de sus sesiones hijas (iframe/worker) ---

/// De donde vino un evento. sid es null para la pestana principal.
function monContext(tabId, s, sid) {
  return { tabId, s, sid, child: sid ? s.children.get(sid) || null : null };
}

/// Los ids de request se repiten entre la pestana y cada iframe o worker, asi que los de una
/// sesion hija llevan delante el inicio de su sessionId.
function monKey(c, requestId) {
  return c.sid ? `${c.sid.slice(0, 8)}:${requestId}` : requestId;
}

/// Manda un comando CDP a la sesion de la que vino el evento (body y post data viven ahi).
function monSend(c, method, params = {}) {
  if (!c.sid) return cdp(c.tabId, method, params);
  return chrome.debugger.sendCommand({ tabId: c.tabId, sessionId: c.sid }, method, params);
}

function monEmit(c, kind, fields) {
  const origin = c.child ? { frame: c.child.url, target: c.child.type } : {};
  monWrite(c.tabId, kind, { ...fields, ...origin });
}

// --- Red ---

function monDurationMs(c, requestId, timestamp) {
  const req = c.s.requests.get(monKey(c, requestId));
  if (!req || req.start == null || timestamp == null) return null;
  return Math.round((timestamp - req.start) * 1000);
}

function monWantsBody(req) {
  if (!req) return false;
  return MON_BODY_TYPES.has(req.type) || /json|xml|text\/plain/i.test(req.mime || "");
}

async function monOnRequest(c, p) {
  const id = monKey(c, p.requestId);
  if (p.redirectResponse) monEmit(c, "response", monResponseFields(id, p.redirectResponse, true));
  c.s.requests.set(id, { type: p.type || "Other", mime: "", start: p.timestamp });
  let postData = p.request.postData;
  if (p.request.hasPostData && postData == null) {
    try {
      postData = (await monSend(c, "Network.getRequestPostData", { requestId: p.requestId })).postData;
    } catch {
      postData = null;
    }
  }
  monEmit(c, "request", {
    id,
    method: p.request.method,
    url: p.request.url,
    type: p.type || "Other",
    headers: p.request.headers,
    post_data: postData ?? null,
    initiator: p.initiator?.type || null,
    document_url: p.documentURL || null,
  });
}

function monResponseFields(id, r, redirect) {
  return {
    id,
    url: r.url,
    status: r.status,
    status_text: r.statusText,
    mime: r.mimeType,
    headers: r.headers,
    remote_ip: r.remoteIPAddress || null,
    from_cache: Boolean(r.fromDiskCache || r.fromServiceWorker || r.fromPrefetchCache),
    redirect,
  };
}

async function monOnFinished(c, p) {
  const id = monKey(c, p.requestId);
  const fields = { id, bytes: p.encodedDataLength, duration_ms: monDurationMs(c, p.requestId, p.timestamp) };
  if (monWantsBody(c.s.requests.get(id))) {
    try {
      const r = await monSend(c, "Network.getResponseBody", { requestId: p.requestId });
      const body = r.body || "";
      fields.body = body.length > MON_BODY_MAX_CHARS ? body.slice(0, MON_BODY_MAX_CHARS) : body;
      fields.body_truncated = body.length > MON_BODY_MAX_CHARS;
      fields.body_base64 = Boolean(r.base64Encoded);
    } catch (e) {
      fields.body_error = String(e.message || e);
    }
  }
  c.s.requests.delete(id);
  monEmit(c, "finished", fields);
}

function monOnFailed(c, p) {
  const id = monKey(c, p.requestId);
  monEmit(c, "failed", {
    id,
    error: p.errorText,
    canceled: Boolean(p.canceled),
    blocked_reason: p.blockedReason || null,
    cors_error: p.corsErrorStatus?.corsError || null,
    duration_ms: monDurationMs(c, p.requestId, p.timestamp),
  });
  c.s.requests.delete(id);
}

function monOnNetwork(c, method, p) {
  switch (method) {
    case "Network.requestWillBeSent":
      monOnRequest(c, p);
      return;
    case "Network.responseReceived": {
      const id = monKey(c, p.requestId);
      const req = c.s.requests.get(id);
      if (req) req.mime = p.response.mimeType;
      monEmit(c, "response", monResponseFields(id, p.response, false));
      return;
    }
    // Los headers que de verdad salieron y llegaron por el cable: incluyen Cookie y Set-Cookie,
    // que no vienen en requestWillBeSent ni en responseReceived.
    case "Network.requestWillBeSentExtraInfo":
      monEmit(c, "request_extra", { id: monKey(c, p.requestId), headers: p.headers });
      return;
    case "Network.responseReceivedExtraInfo":
      monEmit(c, "response_extra", { id: monKey(c, p.requestId), status: p.statusCode, headers: p.headers });
      return;
    case "Network.loadingFinished":
      monOnFinished(c, p);
      return;
    case "Network.loadingFailed":
      monOnFailed(c, p);
      return;
    case "Network.webSocketCreated":
      monEmit(c, "ws", { id: monKey(c, p.requestId), action: "created", url: p.url });
      return;
    case "Network.webSocketFrameSent":
    case "Network.webSocketFrameReceived":
      monEmit(c, "ws", {
        id: monKey(c, p.requestId),
        action: method.endsWith("Sent") ? "sent" : "received",
        data: p.response?.payloadData ?? null,
      });
      return;
    case "Network.webSocketFrameError":
      monEmit(c, "ws", { id: monKey(c, p.requestId), action: "error", data: p.errorMessage });
      return;
    case "Network.webSocketClosed":
      monEmit(c, "ws", { id: monKey(c, p.requestId), action: "closed" });
      return;
  }
}

// --- Consola, excepciones, avisos del navegador y navegacion ---

/// Texto legible de los argumentos de un console.*: valores primitivos tal cual y objetos por
/// su vista previa de propiedades, que es lo que se ve en DevTools.
function monConsoleText(args) {
  return (args || [])
    .map((a) => {
      if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
      if (a.preview?.properties) {
        const props = a.preview.properties.map((pr) => `${pr.name}: ${pr.value}`).join(", ");
        return `${a.description || a.className || "Object"} {${props}}`;
      }
      return a.description ?? a.unserializableValue ?? a.type;
    })
    .join(" ");
}

function monOnPage(c, method, p) {
  switch (method) {
    case "Runtime.consoleAPICalled": {
      const frame = p.stackTrace?.callFrames?.[0];
      monEmit(c, "console", {
        level: p.type,
        text: monConsoleText(p.args),
        url: frame?.url || null,
        line: frame ? frame.lineNumber + 1 : null,
      });
      return;
    }
    case "Runtime.exceptionThrown": {
      const d = p.exceptionDetails || {};
      monEmit(c, "exception", {
        text: d.text,
        description: d.exception?.description || null,
        url: d.url || null,
        line: d.lineNumber != null ? d.lineNumber + 1 : null,
        column: d.columnNumber != null ? d.columnNumber + 1 : null,
        stack: (d.stackTrace?.callFrames || []).map((f) => `${f.functionName || "(anonima)"} ${f.url}:${f.lineNumber + 1}`),
      });
      return;
    }
    case "Log.entryAdded":
      monEmit(c, "log", { source: p.entry.source, level: p.entry.level, text: p.entry.text, url: p.entry.url || null });
      return;
    case "Page.frameNavigated":
      if (!p.frame.parentId && !c.sid) {
        monEmit(c, "navigation", { url: p.frame.url });
        // Una navegacion a otro dominio puede cambiar de proceso; se repite el auto-attach.
        monSend(c, "Target.setAutoAttach", MON_AUTO_ATTACH).catch(() => {});
      }
      return;
  }
}

// --- Sesiones hijas: iframes de otro dominio y workers ---

/// Enciende en la sesion hija los mismos dominios que en la pestana. Cada uno va por separado
/// porque un worker no tiene Log ni Target y eso no debe impedir grabar su red. Al final se
/// reanuda SIEMPRE: si no, el iframe o worker se queda congelado esperando al depurador.
async function monAttachChild(tabId, s, p) {
  const c = { tabId, s, sid: p.sessionId, child: null };
  try {
    if (!s) return;
    s.children.set(p.sessionId, { type: p.targetInfo.type, url: p.targetInfo.url, targetId: p.targetInfo.targetId });
    c.child = s.children.get(p.sessionId);
    monEmit(c, "target", { action: "attached", target_session: p.sessionId });
    const steps = [
      ["Network.enable", { maxPostDataSize: MON_POST_DATA_MAX_BYTES }],
      ["Runtime.enable", {}],
      ["Log.enable", {}],
      ["Target.setAutoAttach", MON_AUTO_ATTACH], // iframes dentro del iframe
    ];
    for (const [method, params] of steps) {
      try {
        await monSend(c, method, params);
      } catch {
        // Ese dominio no existe en este tipo de target; se sigue con los demas.
      }
    }
  } finally {
    monSend(c, "Runtime.runIfWaitingForDebugger").catch(() => {});
  }
}

function monOnTarget(tabId, s, method, p) {
  if (method === "Target.attachedToTarget") {
    monAttachChild(tabId, s, p);
  } else if (method === "Target.detachedFromTarget" && s?.children.has(p.sessionId)) {
    monEmit(monContext(tabId, s, p.sessionId), "target", { action: "detached", target_session: p.sessionId });
    s.children.delete(p.sessionId);
  } else if (method === "Target.targetInfoChanged" && s) {
    // Un iframe que navega cambia de url; se actualiza para que sus eventos digan la nueva.
    for (const child of s.children.values()) {
      if (child.targetId === p.targetInfo.targetId) child.url = p.targetInfo.url;
    }
  }
}

function monOnEvent(source, method, p) {
  const tabId = source.tabId;
  const s = monSessions.get(tabId);
  if (method.startsWith("Target.")) {
    monOnTarget(tabId, s, method, p);
    return;
  }
  if (!s) return;
  const c = monContext(tabId, s, source.sessionId || null);
  if (method.startsWith("Network.")) monOnNetwork(c, method, p);
  else monOnPage(c, method, p);
}

chrome.debugger.onEvent.addListener(monOnEvent);

// --- Inicio y fin de la grabacion ---

/// Si se cierra la pestana o se quita el depurador (la barra amarilla), la sesion se cierra
/// en el archivo para que se note por que dejo de grabar.
function monEndSession(tabId, reason) {
  if (!monSessions.has(tabId)) return;
  monWrite(tabId, "session", { action: "stop", reason });
  monSessions.delete(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => monEndSession(tabId, "pestana cerrada"));
chrome.debugger.onDetach.addListener((source, reason) => monEndSession(source.tabId, `depurador quitado: ${reason}`));

async function monEnableDomains(tabId) {
  await ensureAttached(tabId);
  const state = attachedTabs.get(tabId);
  await cdp(tabId, "Network.enable", { maxPostDataSize: MON_POST_DATA_MAX_BYTES });
  for (const domain of ["Network", "Runtime", "Log", "Page"]) {
    if (domain !== "Network") await cdp(tabId, `${domain}.enable`, {});
    state.enabledDomains.add(domain);
  }
  await cdp(tabId, "Target.setAutoAttach", MON_AUTO_ATTACH);
}

/// Apaga el auto-attach y suelta las sesiones hijas: sin eso, Chrome seguiria pausando cada
/// iframe nuevo esperando a un depurador que ya no le contesta.
async function monReleaseChildren(tabId, s) {
  try {
    await cdp(tabId, "Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
  } catch {
    // La pestana ya no esta enganchada; no hay nada que soltar.
  }
  for (const sessionId of s.children.keys()) {
    cdp(tabId, "Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}

function monText(text) {
  return { content: [{ type: "text", text }] };
}

const monToolHandlers = {
  async monitor_start(args) {
    const { tabId, reload = false } = args;
    if (!(await isInGroup(tabId))) return monText(`Tab ${tabId} is not in the MCP group.`);
    if (monSessions.has(tabId)) {
      return monText(`Ya se esta grabando esta pestana en ${monPath(monSessions.get(tabId).session)}`);
    }
    const session = monSessionName(tabId);
    const tab = await chrome.tabs.get(tabId);
    monSessions.set(tabId, { session, seq: 0, section: null, requests: new Map(), children: new Map(), backlog: [] });
    monWrite(tabId, "session", { action: "start", url: tab.url, title: tab.title, file: monPath(session) });
    try {
      await monEnableDomains(tabId);
    } catch (e) {
      monSessions.delete(tabId);
      throw e;
    }
    if (reload) await cdp(tabId, "Page.reload", {});
    return monText(`Grabando la pestana ${tabId} (con sus iframes y workers) en ${monPath(session)}${reload ? " (se recargo para capturar desde la carga)" : ""}`);
  },

  async monitor_mark(args) {
    const { tabId, label } = args;
    const s = monSessions.get(tabId);
    if (!s) return monText(`No se esta grabando la pestana ${tabId}; usa monitor_start primero.`);
    s.section = String(label || "").trim() || null;
    monWrite(tabId, "mark", { label: s.section });
    return monText(`Seccion "${s.section}" marcada en ${monPath(s.session)}`);
  },

  async monitor_stop(args) {
    const { tabId } = args;
    const s = monSessions.get(tabId);
    if (!s) return monText(`No se esta grabando la pestana ${tabId}.`);
    await monReleaseChildren(tabId, s);
    monEndSession(tabId, "detenido");
    return monText(`Grabacion detenida. Archivo: ${monPath(s.session)}`);
  },
};

Object.assign(toolHandlers, monToolHandlers);
