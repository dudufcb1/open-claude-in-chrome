// Iframes: que las tools vean y operen lo que vive dentro de un iframe, incluido uno de otro
// dominio (Chrome lo corre en otro proceso y el script de la extension no entra ahi).
//
// Se carga desde background.js con importScripts y comparte su ambito global (cdp,
// ensureAttached, toolHandlers, sendContentMessage, isInGroup).
//
// Como funciona:
// - Target.setAutoAttach engancha cada iframe de otro dominio (y cada worker) como sesion hija
//   de chrome.debugger. Aqui se lleva el registro de esas sesiones; el monitor de pagina lo usa.
// - Los iframes se enumeran con Page.getFrameTree en la pestana y en cada sesion hija.
// - La posicion de cada iframe en la pestana sale de DOM.getFrameOwner + DOM.getBoxModel (caja
//   de contenido, ya descuenta borde y scroll) sumando la de sus ancestros. Con eso las
//   coordenadas de adentro se traducen a coordenadas de la pestana, que es donde caen los clics.
// - En cada iframe se inyecta content.js en un mundo aislado (Page.createIsolatedWorld) y se
//   llaman sus funciones por Runtime.evaluate: find, read_page, get_page_text y form_input
//   funcionan igual que en la pagina principal. Sus refs llevan delante el iframe: "f2:ref_7".

const FRAME_REF = /^f(\d+):(ref_\d+)$/;
const FRAME_WORLD = "automaton";
const FRAME_FIRST_ATTACH_WAIT_MS = 300; // Lo que tardan en llegar los attachedToTarget iniciales

// tabId -> { enabled, pause, sessions: Map(sessionId -> {targetId, type, url, parentSession}),
//            keys: Map(clave -> n), contexts: Map(clave -> executionContextId) }
const frameStates = new Map();
const frameAttachHooks = []; // fn(tabId, sessionId, info): el monitor enciende ahi su grabacion
const frameDetachHooks = [];
let frameContentSource = null;

function frameState(tabId) {
  if (!frameStates.has(tabId)) {
    frameStates.set(tabId, { enabled: false, pause: false, sessions: new Map(), keys: new Map(), contexts: new Map() });
  }
  return frameStates.get(tabId);
}

/// Manda un comando CDP a la pestana (session null) o a una sesion hija.
function frameSend(tabId, session, method, params = {}) {
  if (!session) return cdp(tabId, method, params);
  return chrome.debugger.sendCommand({ tabId, sessionId: session }, method, params);
}

function frameAutoAttachParams(st) {
  return { autoAttach: true, waitForDebuggerOnStart: st.pause, flatten: true };
}

// --- Registro de sesiones hijas ---

/// Al engancharse un iframe o worker: se registra, se avisa a los interesados (el monitor) y se
/// activa el auto-attach dentro de el para sus propios iframes. Al final se reanuda SIEMPRE: si
/// estaba en pausa esperando al depurador y nadie lo reanuda, se queda congelado.
async function frameOnAttached(tabId, parentSession, p) {
  const st = frameState(tabId);
  try {
    const info = { targetId: p.targetInfo.targetId, type: p.targetInfo.type, url: p.targetInfo.url, parentSession };
    st.sessions.set(p.sessionId, info);
    for (const hook of frameAttachHooks) {
      try {
        await hook(tabId, p.sessionId, info);
      } catch {
        // Un interesado que falla no debe impedir que el iframe siga.
      }
    }
    await frameSend(tabId, p.sessionId, "Target.setAutoAttach", frameAutoAttachParams(st)).catch(() => {});
  } finally {
    frameSend(tabId, p.sessionId, "Runtime.runIfWaitingForDebugger").catch(() => {});
  }
}

function frameOnTargetEvent(source, method, p) {
  const tabId = source.tabId;
  if (method === "Target.attachedToTarget") {
    frameOnAttached(tabId, source.sessionId || null, p);
    return;
  }
  const st = frameStates.get(tabId);
  if (!st) return;
  if (method === "Target.detachedFromTarget" && st.sessions.has(p.sessionId)) {
    const info = st.sessions.get(p.sessionId);
    for (const hook of frameDetachHooks) {
      try {
        hook(tabId, p.sessionId, info);
      } catch {
        // Igual que al enganchar: no detiene la limpieza.
      }
    }
    st.sessions.delete(p.sessionId);
  } else if (method === "Target.targetInfoChanged") {
    for (const info of st.sessions.values()) {
      if (info.targetId === p.targetInfo.targetId) info.url = p.targetInfo.url;
    }
  }
}

chrome.debugger.onEvent.addListener((source, method, p) => {
  if (method.startsWith("Target.")) frameOnTargetEvent(source, method, p);
});
// Si se suelta el depurador de la pestana, las sesiones hijas murieron con el.
chrome.debugger.onDetach.addListener((source) => frameStates.delete(source.tabId));
chrome.tabs.onRemoved.addListener((tabId) => frameStates.delete(tabId));

/// Activa el auto-attach en la pestana. Se repite en cada llamada (es barato y despues de
/// navegar a otro dominio Chrome puede haberlo olvidado); solo la primera vez se espera a que
/// lleguen los iframes que ya estaban.
async function framesEnsure(tabId) {
  await ensureAttached(tabId);
  const st = frameState(tabId);
  await cdp(tabId, "Target.setAutoAttach", frameAutoAttachParams(st));
  if (!st.enabled) {
    st.enabled = true;
    await new Promise((r) => setTimeout(r, FRAME_FIRST_ATTACH_WAIT_MS));
  }
}

/// El monitor pide pausar cada iframe nuevo hasta encender su grabacion (para no perder sus
/// primeras llamadas) y lo libera al detenerse.
async function framesSetPause(tabId, pause) {
  const st = frameState(tabId);
  st.pause = pause;
  await framesEnsure(tabId);
  for (const session of st.sessions.keys()) {
    frameSend(tabId, session, "Target.setAutoAttach", frameAutoAttachParams(st)).catch(() => {});
  }
}

function frameSessionInfo(tabId, sessionId) {
  return frameStates.get(tabId)?.sessions.get(sessionId) || null;
}

// --- Enumeracion de iframes y su posicion en la pestana ---

/// Numero estable de un iframe dentro de la pestana, para sus refs ("f2:ref_7").
function frameNumber(st, key) {
  if (!st.keys.has(key)) st.keys.set(key, st.keys.size + 1);
  return st.keys.get(key);
}

/// Caja de contenido del elemento <iframe> dueno de frameId, en coordenadas del viewport de la
/// sesion donde vive ese elemento.
async function frameOwnerBox(tabId, ownerSession, frameId) {
  const owner = await frameSend(tabId, ownerSession, "DOM.getFrameOwner", { frameId });
  const box = await frameSend(tabId, ownerSession, "DOM.getBoxModel", { backendNodeId: owner.backendNodeId });
  const q = box.model.content; // [x1,y1, x2,y2, x3,y3, x4,y4]; width/height del modelo incluyen el borde
  return { x: q[0], y: q[1], width: q[2] - q[0], height: q[5] - q[1] };
}

/// Recorre el arbol de frames de una sesion y arma un registro por iframe.
function frameCollect(tree, session, info, out) {
  const walk = (node, isRoot) => {
    if (isRoot && session) {
      // Raiz de una sesion hija: es el iframe de otro dominio; su <iframe> vive en la sesion padre.
      out.push({ session, frameId: node.frame.id, url: node.frame.url, ownerSession: info.parentSession, ownerFrameId: info.targetId });
    } else if (!isRoot) {
      // Iframe del mismo proceso: su <iframe> vive en esta misma sesion.
      out.push({ session, frameId: node.frame.id, url: node.frame.url, ownerSession: session, ownerFrameId: node.frame.id });
    }
    for (const child of node.childFrames || []) walk(child, false);
  };
  walk(tree, true);
}

/// Todos los iframes visibles de la pestana con su numero y su posicion (x, y, width, height)
/// en coordenadas de la pestana.
async function framesList(tabId) {
  await framesEnsure(tabId);
  const st = frameState(tabId);
  const records = [];
  const sessions = [[null, null], ...[...st.sessions.entries()].filter(([, i]) => i.type === "iframe")];
  for (const [session, info] of sessions) {
    try {
      const { frameTree } = await frameSend(tabId, session, "Page.getFrameTree");
      frameCollect(frameTree, session, info, records);
    } catch {
      // Sesion que se cerro a media enumeracion.
    }
  }
  const origins = new Map([[null, { x: 0, y: 0 }]]); // sesion -> origen de su viewport en la pestana
  const pending = [...records];
  const placed = [];
  // Se resuelven de afuera hacia adentro: un iframe se ubica cuando ya se conoce el origen de
  // la sesion donde vive su <iframe>.
  for (let round = 0; round < 8 && pending.length; round++) {
    for (const rec of [...pending]) {
      const base = origins.get(rec.ownerSession);
      if (!base) continue;
      pending.splice(pending.indexOf(rec), 1);
      try {
        const box = await frameOwnerBox(tabId, rec.ownerSession, rec.ownerFrameId);
        Object.assign(rec, { x: Math.round(base.x + box.x), y: Math.round(base.y + box.y), width: box.width, height: box.height });
        if (rec.session && rec.frameId === st.sessions.get(rec.session)?.targetId) origins.set(rec.session, { x: rec.x, y: rec.y });
        rec.key = `${rec.session || "tab"}|${rec.frameId}`;
        rec.n = frameNumber(st, rec.key);
        if (rec.width > 0 && rec.height > 0) placed.push(rec);
      } catch {
        // Iframe sin caja (oculto o recien quitado).
      }
    }
  }
  return placed;
}

// --- Ejecutar el script de la extension dentro de un iframe ---

async function frameContentScript() {
  if (!frameContentSource) frameContentSource = await (await fetch(chrome.runtime.getURL("content.js"))).text();
  return frameContentSource;
}

async function frameWorld(tabId, rec, fresh) {
  const st = frameState(tabId);
  if (!fresh && st.contexts.has(rec.key)) return st.contexts.get(rec.key);
  const { executionContextId } = await frameSend(tabId, rec.session, "Page.createIsolatedWorld", {
    frameId: rec.frameId,
    worldName: FRAME_WORLD,
  });
  await frameSend(tabId, rec.session, "Runtime.evaluate", { expression: await frameContentScript(), contextId: executionContextId });
  st.contexts.set(rec.key, executionContextId);
  return executionContextId;
}

/// Evalua una expresion en el mundo aislado del iframe (con content.js cargado). Si el iframe
/// navego, su mundo viejo ya no existe: se crea uno nuevo y se reintenta una vez.
async function frameEval(tabId, rec, expression) {
  for (const fresh of [false, true]) {
    try {
      const contextId = await frameWorld(tabId, rec, fresh);
      const r = await frameSend(tabId, rec.session, "Runtime.evaluate", { expression, contextId, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    } catch (e) {
      if (fresh) throw e;
    }
  }
}

function frameCall(tabId, rec, fn, ...args) {
  const list = args.map((a) => JSON.stringify(a)).join(", ");
  return frameEval(tabId, rec, `window.__unblockedChrome.${fn}(${list})`);
}

// --- Refs de iframe y coordenadas ---

function frameParseRef(ref) {
  const m = FRAME_REF.exec(String(ref || ""));
  return m ? { n: Number(m[1]), ref: m[2] } : null;
}

async function frameByNumber(tabId, n) {
  const rec = (await framesList(tabId)).find((r) => r.n === n);
  if (!rec) throw new Error(`El iframe f${n} ya no esta en la pagina; vuelve a usar find o read_page.`);
  return rec;
}

/// Coordenadas en la pestana del centro de un elemento de iframe ("f2:ref_7").
async function frameRefCoordinates(tabId, frameRef) {
  const rec = await frameByNumber(tabId, frameRef.n);
  const c = await frameCall(tabId, rec, "getRefCoordinates", frameRef.ref);
  if (!c) throw new Error(`No se encontro f${frameRef.n}:${frameRef.ref}; vuelve a usar find.`);
  return [rec.x + c.x, rec.y + c.y];
}

/// El iframe mas interno que contiene el punto (x, y) de la pestana, o null.
async function frameAtPoint(tabId, x, y) {
  const inside = (await framesList(tabId)).filter((r) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height);
  inside.sort((a, b) => a.width * a.height - b.width * b.height);
  return inside[0] || null;
}

function frameLabel(rec) {
  return `f${rec.n} ${rec.url} (en ${rec.x},${rec.y}, ${Math.round(rec.width)}x${Math.round(rec.height)})`;
}

function frameText(content) {
  return { content: [{ type: "text", text: content }] };
}

function frameFirstText(result) {
  return (result?.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

// --- Tools que ahora tambien ven los iframes ---

const frameOriginal = {
  find: toolHandlers.find,
  read_page: toolHandlers.read_page,
  get_page_text: toolHandlers.get_page_text,
  form_input: toolHandlers.form_input,
  javascript_tool: toolHandlers.javascript_tool,
  computer: toolHandlers.computer,
};

async function frameFind(args) {
  const base = await frameOriginal.find(args);
  let text = frameFirstText(base);
  try {
    for (const rec of await framesList(args.tabId)) {
      const found = (await frameCall(args.tabId, rec, "findElements", args.query)) || [];
      if (!found.length) continue;
      text += `\n\nDentro del iframe ${frameLabel(rec)}:\n`;
      for (const r of found) {
        text += `[f${rec.n}:${r.ref}] ${r.role} "${r.name}" at (${rec.x + r.coordinates[0]}, ${rec.y + r.coordinates[1]})\n`;
      }
    }
  } catch (e) {
    text += `\n\n(No se pudieron revisar los iframes: ${e.message})`;
  }
  return frameText(text);
}

async function frameReadPage(args) {
  const scoped = frameParseRef(args.ref_id);
  if (scoped) {
    const rec = await frameByNumber(args.tabId, scoped.n);
    const tree = await frameCall(args.tabId, rec, "generateAccessibilityTree", { ...args, ref_id: scoped.ref });
    return frameText(`Iframe ${frameLabel(rec)}:\n${String(tree).replace(/\bref_(\d+)/g, `f${rec.n}:ref_$1`)}`);
  }
  const base = await frameOriginal.read_page(args);
  let text = frameFirstText(base);
  try {
    for (const rec of await framesList(args.tabId)) {
      const tree = await frameCall(args.tabId, rec, "generateAccessibilityTree", { filter: args.filter, depth: args.depth, max_chars: args.max_chars });
      text += `\n\n--- Iframe ${frameLabel(rec)}; sus coordenadas suman su posicion ---\n`;
      text += String(tree || "").replace(/\bref_(\d+)/g, `f${rec.n}:ref_$1`);
    }
  } catch (e) {
    text += `\n\n(No se pudieron revisar los iframes: ${e.message})`;
  }
  return frameText(text);
}

async function frameGetPageText(args) {
  const base = await frameOriginal.get_page_text(args);
  let text = frameFirstText(base);
  try {
    for (const rec of await framesList(args.tabId)) {
      const raw = await frameCall(args.tabId, rec, "getPageText");
      const data = JSON.parse(raw || "{}");
      if (data.text) text += `\n\n--- Iframe ${frameLabel(rec)} ---\n${data.text}`;
    }
  } catch (e) {
    text += `\n\n(No se pudieron revisar los iframes: ${e.message})`;
  }
  return frameText(text);
}

async function frameFormInput(args) {
  const scoped = frameParseRef(args.ref);
  if (!scoped) return frameOriginal.form_input(args);
  const rec = await frameByNumber(args.tabId, scoped.n);
  const result = await frameCall(args.tabId, rec, "setFormValue", scoped.ref, args.value);
  if (result?.error) return frameText(`Error: ${result.error}`);
  return frameText(`Set ${args.ref} to "${args.value}" (iframe ${rec.url}). Result: ${JSON.stringify(result)}`);
}

/// javascript_tool con frame: corre el codigo en el iframe cuyo numero ("f2") o url contenga
/// ese texto. En un iframe de otro dominio corre en el mundo de la pagina (ve sus variables);
/// en uno del mismo proceso, en el mundo aislado (ve el DOM, no las variables de la pagina).
async function frameJavascript(args) {
  if (!args.frame) return frameOriginal.javascript_tool(args);
  if (!(await isInGroup(args.tabId))) return frameText(`Tab ${args.tabId} is not in the MCP group.`);
  const frames = await framesList(args.tabId);
  const wanted = String(args.frame);
  const rec = frames.find((r) => `f${r.n}` === wanted) || frames.find((r) => r.url.includes(wanted));
  if (!rec) {
    const known = frames.map(frameLabel).join("\n") || "ninguno";
    return frameText(`No hay iframe que coincida con "${wanted}". Iframes en la pagina:\n${known}`);
  }
  const ownSession = rec.session && rec.frameId === frameSessionInfo(args.tabId, rec.session)?.targetId;
  try {
    let value;
    if (ownSession) {
      const r = await frameSend(args.tabId, rec.session, "Runtime.evaluate", { expression: args.text, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return frameText(`Error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      value = r.result?.value ?? r.result?.description;
    } else {
      value = await frameEval(args.tabId, rec, args.text);
    }
    return frameText(`(iframe ${frameLabel(rec)})\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
  } catch (e) {
    return frameText(`Error: ${e.message}`);
  }
}

/// Mismo js_click de background.js, pero corrido dentro del iframe con la coordenada traducida.
function frameJsClickExpression(x, y) {
  return `(() => {
    const el = document.elementFromPoint(${x}, ${y});
    if (!el) return { ok: false, error: 'no element at (${x},${y}) inside iframe' };
    let target = el, depth = 0;
    while (target && depth < 6) {
      const t = target.tagName;
      if (t === 'BUTTON' || t === 'A' || target.getAttribute('role') === 'button' || target.onclick || target.getAttribute('onclick')) break;
      target = target.parentElement; depth++;
    }
    if (!target) target = el;
    const rect = target.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const mk = (type) => new MouseEvent(type, { view: window, bubbles: true, cancelable: true, button: 0, clientX: cx, clientY: cy });
    // Un solo click: .click() ya dispara el evento click, mandarlo ademas a mano lo duplica.
    target.dispatchEvent(mk('mousedown')); target.dispatchEvent(mk('mouseup'));
    target.click();
    return { ok: true, target: target.tagName + (target.id ? '#' + target.id : '') };
  })()`;
}

/// computer: un ref de iframe se traduce a coordenada de la pestana (los clics de CDP de la
/// pestana si llegan al iframe), y un js_click sobre un iframe se corre adentro de el.
async function frameComputer(args) {
  const scoped = frameParseRef(args.ref);
  if (scoped && !args.coordinate) {
    const coordinate = await frameRefCoordinates(args.tabId, scoped);
    const { ref, ...rest } = args;
    return frameOriginal.computer({ ...rest, coordinate });
  }
  if (args.action === "js_click" && args.coordinate) {
    const [x, y] = args.coordinate;
    const rec = await frameAtPoint(args.tabId, x, y).catch(() => null);
    if (rec) {
      const v = await frameEval(args.tabId, rec, frameJsClickExpression(x - rec.x, y - rec.y));
      if (v?.ok) return frameText(`JS-clicked at (${x}, ${y}) dentro del iframe ${frameLabel(rec)} target=<${v.target}>`);
      return frameText(`JS click failed dentro del iframe ${rec.url}: ${v?.error || "unknown"}`);
    }
  }
  return frameOriginal.computer(args);
}

Object.assign(toolHandlers, {
  find: frameFind,
  read_page: frameReadPage,
  get_page_text: frameGetPageText,
  form_input: frameFormInput,
  javascript_tool: frameJavascript,
  computer: frameComputer,
});
