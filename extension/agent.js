// Agente del panel lateral: recibe una instruccion libre ("llena este formulario con...") y la
// resuelve en la pestana activa, pidiendole al modelo una accion por vuelta (agent-tools.js) hasta
// que llama a finish, se agotan las vueltas o el usuario lo detiene.
//
// El panel (panel.js) habla con esto por un puerto "agent-panel": manda start / stop / settings y
// recibe cada paso. La corrida vive en el service worker, asi que cerrar el panel no la corta.
// Se carga desde background.js con importScripts y comparte su ambito.

const AGENT_MAX_TURNS = 30;
const AGENT_MAX_NUDGES = 2; // Veces que se le pide seguir si contesta texto sin usar herramientas
const AGENT_LOG_LIMIT = 200;

const AGENT_INSTRUCTIONS = `Controlas una pestana de Chrome para cumplir la tarea del usuario.
- Antes de actuar, mira: la captura que recibes y, si hace falta, read_page o find para obtener refs.
- Prefiere refs (ref_12) sobre coordenadas: son exactas. Si usas x, y, son pixeles de la ultima captura.
- Una accion por vuelta. Despues de cada accion recibes la pantalla nueva; revisa que paso lo que esperabas.
- Para campos de formulario usa fill con su ref. Para escribir en un campo sin ref, da clic y luego type.
- No inventes datos que el usuario no te dio. Si falta un dato o algo pide confirmar un pago o un envio
  irreversible que la tarea no pidio, termina con finish(success=false) y explica que falta.
- Cuando acabes, llama finish con un resumen corto en espanol de lo que hiciste.`;

let agentRun = null; // { id, tabId, task, cancelled, state, log[] }
const agentPorts = new Set();

/// Historia de la conversacion. La captura solo se manda en la vuelta que sigue a la accion que la
/// produjo; despues queda un resumen en texto, para no pagar miles de tokens por imagenes viejas.
class AgentConversation {
  constructor(task, firstView) {
    this.history = [{ role: "user", content: [{ type: "input_text", text: `Tarea: ${task}` }] }];
    this.view = firstView;
  }

  forModel() {
    if (!this.view) return this.history;
    const view = this.view;
    this.view = null;
    return [...this.history, { role: "user", content: [{ type: "input_text", text: "Pantalla actual:" }, ...view] }];
  }

  addModelOutput(items) {
    this.history.push(...items);
  }

  addUserText(text) {
    this.history.push({ role: "user", content: [{ type: "input_text", text }] });
  }

  addToolResult(callId, output) {
    if (Array.isArray(output)) {
      const text = output.filter((p) => p.type === "input_text").map((p) => p.text).join("\n");
      this.history.push({ type: "function_call_output", call_id: callId, output: `${text}\n(La pantalla nueva va en el siguiente mensaje.)` });
      this.view = output;
    } else {
      this.history.push({ type: "function_call_output", call_id: callId, output });
    }
  }
}

function agentBroadcast(message) {
  for (const port of agentPorts) {
    try { port.postMessage(message); } catch { agentPorts.delete(port); }
  }
}

function agentLog(kind, text) {
  if (!agentRun) return;
  const entry = { kind, text, at: Date.now() };
  agentRun.log.push(entry);
  if (agentRun.log.length > AGENT_LOG_LIMIT) agentRun.log.shift();
  agentBroadcast({ type: "log", runId: agentRun.id, entry });
}

function agentSetState(state, extra = {}) {
  agentRun.state = state;
  agentBroadcast({ type: "state", run: agentSnapshot(), ...extra });
}

function agentSnapshot() {
  if (!agentRun) return null;
  const { id, tabId, task, state, log, result } = agentRun;
  return { id, tabId, task, state, log, result: result || null };
}

/// Descripcion corta de una llamada para el registro del panel.
function agentDescribeCall(call) {
  const a = call.arguments;
  const target = a.ref ? ` ${a.ref}` : typeof a.x === "number" ? ` (${Math.round(a.x)}, ${Math.round(a.y)})` : "";
  switch (call.name) {
    case "click": return `Clic${a.kind && a.kind !== "left" ? ` ${a.kind}` : ""}${target}`;
    case "fill": return `Llena ${a.ref}: ${String(a.value).slice(0, 60)}`;
    case "type": return `Escribe: ${String(a.text).slice(0, 60)}`;
    case "key": return `Tecla: ${a.keys}`;
    case "navigate": return `Abre ${a.url}`;
    case "find": return `Busca: ${a.query}`;
    case "scroll": return `Desplaza ${a.direction}`;
    case "wait": return `Espera ${a.seconds} s`;
    default: return call.name;
  }
}

/// Engancha la pestana al grupo si no lo esta (las tools solo operan pestanas del grupo).
async function agentPrepareTab(tabId) {
  if (await isInGroup(tabId)) return null;
  const res = await toolHandlers.tabs_attach({ tabId });
  return (await isInGroup(tabId)) ? null : agentText(res) || "No se pudo enganchar la pestana.";
}

/// Espera la accion, pero si el usuario pica Detener regresa en ese momento: una accion colgada (una
/// pagina que no termina de cargar) no debe dejar la corrida viva. La accion sigue sola y se descarta.
function agentUntilCancelled(run, promise) {
  const cancelled = new Promise((resolve) => {
    if (run.abort.signal.aborted) resolve({ output: "Detenido." });
    run.abort.signal.addEventListener("abort", () => resolve({ output: "Detenido." }), { once: true });
  });
  return Promise.race([promise, cancelled]);
}

async function agentLoop(run, settings) {
  const sessionId = agentNewSessionId();
  const conversation = new AgentConversation(run.task, await agentLook(run.tabId));
  let nudges = 0;
  for (let turn = 1; turn <= AGENT_MAX_TURNS; turn++) {
    if (run.cancelled) return { success: false, summary: "Detenido por el usuario." };
    agentLog("thinking", `Vuelta ${turn}`);
    const reply = await agentCallModel(settings, sessionId, run.id, AGENT_INSTRUCTIONS, conversation.forModel(), AGENT_TOOL_SPECS, run.abort.signal);
    conversation.addModelOutput(reply.items);
    if (reply.text) agentLog("say", reply.text);
    if (!reply.calls.length) {
      if (++nudges > AGENT_MAX_NUDGES) return { success: false, summary: reply.text || "El modelo dejo de usar herramientas." };
      conversation.addUserText("Sigue con las herramientas, o termina con finish.");
      continue;
    }
    for (const call of reply.calls) {
      if (run.cancelled) return { success: false, summary: "Detenido por el usuario." };
      agentLog("action", agentDescribeCall(call));
      const out = await agentUntilCancelled(run, agentExecute(run.tabId, call)).catch((e) => ({ output: `Error: ${e.message}` }));
      if (run.cancelled) return { success: false, summary: "Detenido por el usuario." };
      if (out.finished) return out.finished;
      if (out.stopped) return { success: false, summary: "Detenido desde el boton de la pagina." };
      conversation.addToolResult(call.callId, out.output);
      const text = Array.isArray(out.output) ? out.output.find((p) => p.type === "input_text")?.text : out.output;
      if (text) agentLog("result", text.slice(0, 300));
    }
  }
  return { success: false, summary: `Se agotaron las ${AGENT_MAX_TURNS} vueltas sin terminar.` };
}

async function agentStart(tabId, task) {
  if (agentRun?.state === "running") return "Ya hay una tarea corriendo; detenla primero.";
  const settings = await agentLoadSettings();
  if (!settings.token) return "Falta el token del backend. Ponlo en Ajustes.";
  if (!task.trim()) return "Escribe que quieres que haga.";
  agentRun = { id: crypto.randomUUID(), tabId, task: task.trim(), cancelled: false, abort: new AbortController(), state: "running", log: [] };
  const run = agentRun;
  agentSetState("running");
  const tabError = await agentPrepareTab(tabId);
  if (tabError) {
    run.result = { success: false, summary: tabError };
    agentSetState("done");
    return null;
  }
  agentLoop(run, settings)
    .then((result) => { run.result = result; })
    .catch((e) => { run.result = { success: false, summary: run.cancelled ? "Detenido por el usuario." : e.message }; })
    .finally(() => {
      if (agentRun === run) agentSetState("done");
    });
  return null;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "agent-panel") return;
  agentPorts.add(port);
  port.onDisconnect.addListener(() => agentPorts.delete(port));
  agentLoadSettings().then((settings) => port.postMessage({ type: "hello", run: agentSnapshot(), settings }));
  port.onMessage.addListener(async (msg) => {
    if (msg.type === "start") {
      const error = await agentStart(msg.tabId, String(msg.task || ""));
      if (error) port.postMessage({ type: "error", text: error });
    } else if (msg.type === "stop" && agentRun?.state === "running") {
      agentRun.cancelled = true;
      agentRun.abort.abort();
      agentLog("info", "Detenido.");
    } else if (msg.type === "settings") {
      port.postMessage({ type: "settings", settings: await agentSaveSettings(msg.settings || {}) });
    } else if (msg.type === "clear_groups") {
      const closed = await clearOurGroups().catch(() => 0);
      port.postMessage({ type: "info", text: `Grupos limpiados: ${closed}.` });
    }
  });
});

// El icono de la extension abre el panel. Limpiar grupos (lo que hacia el icono) quedo como boton
// del panel.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
