// Memoria del agente por pestana y reglas de cache.
//
// Memoria: al terminar cada tarea se guarda un resumen (que se pidio, como termino y los pasos
// principales). "Continuar" arranca la siguiente tarea con esos resumenes al inicio, en vez de
// reenviar la conversacion completa: recuerda lo que importa sin cargar miles de tokens viejos.
//
// Cache: el proveedor reutiliza el prefijo de la peticion si es identico y llega a la misma sesion.
// Por eso: (1) la pestana conserva su id de sesion entre tareas, (2) instrucciones y herramientas
// nunca cambian (el contexto de tareas anteriores va en el primer mensaje, no en las instrucciones),
// (3) la historia solo crece al final y lo que entra se recorta una sola vez, al entrar.
// Se carga desde background.js con importScripts y comparte su ambito.

const AGENT_MEMORY_KEY = "agentMemory";
const AGENT_MEMORY_TASKS = 5; // Tareas anteriores que se recuerdan por pestana
const AGENT_MEMORY_STEPS = 12; // Pasos que se guardan de cada tarea
const AGENT_OUTPUT_MAX_CHARS = 6000; // Tope del texto de una herramienta al entrar a la historia

async function agentMemoryAll() {
  return (await chrome.storage.session.get(AGENT_MEMORY_KEY))[AGENT_MEMORY_KEY] || {};
}

/// Memoria de la pestana: { sessionId, tasks: [{ task, success, summary, steps }] }. La crea con
/// una sesion nueva si no existe.
async function agentMemoryGet(tabId) {
  const all = await agentMemoryAll();
  const mem = all[tabId];
  if (mem?.sessionId) return { sessionId: mem.sessionId, tasks: mem.tasks || [] };
  const fresh = { sessionId: agentNewSessionId(), tasks: [] };
  await chrome.storage.session.set({ [AGENT_MEMORY_KEY]: { ...all, [tabId]: fresh } });
  return fresh;
}

async function agentMemorySave(tabId, mem) {
  const all = await agentMemoryAll();
  await chrome.storage.session.set({ [AGENT_MEMORY_KEY]: { ...all, [tabId]: mem } });
}

/// Agrega el resumen de una tarea terminada y conserva solo las ultimas.
async function agentMemoryRemember(tabId, entry) {
  const mem = await agentMemoryGet(tabId);
  const tasks = [...mem.tasks, { ...entry, steps: entry.steps.slice(-AGENT_MEMORY_STEPS) }].slice(-AGENT_MEMORY_TASKS);
  await agentMemorySave(tabId, { sessionId: mem.sessionId, tasks });
}

/// "Nueva tarea": olvida las tareas anteriores pero conserva la sesion, que no guarda nada de la
/// conversacion y solo sirve para que el proveedor reutilice la cache de instrucciones y herramientas.
async function agentMemoryForget(tabId) {
  const mem = await agentMemoryGet(tabId);
  await agentMemorySave(tabId, { sessionId: mem.sessionId, tasks: [] });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const all = await agentMemoryAll();
  if (!all[tabId]) return;
  delete all[tabId];
  await chrome.storage.session.set({ [AGENT_MEMORY_KEY]: all });
});

/// Primer mensaje de la corrida: la tarea, precedida por lo que ya se hizo en la pestana.
function agentFirstMessage(task, previous) {
  if (!previous.length) return `Tarea: ${task}`;
  const lines = previous.map((t, i) => [
    `${i + 1}. Tarea: ${t.task}`,
    `   Resultado: ${t.success ? "terminada" : "no terminada"}. ${t.summary}`,
    t.steps.length ? `   Pasos: ${t.steps.join("; ")}` : null,
  ].filter(Boolean).join("\n"));
  return `Contexto: antes, en esta misma pestana, el usuario te pidio esto:\n${lines.join("\n")}\n\nTarea nueva (sigue a partir de lo anterior): ${task}`;
}

function agentClip(text) {
  if (text.length <= AGENT_OUTPUT_MAX_CHARS) return text;
  return `${text.slice(0, AGENT_OUTPUT_MAX_CHARS)}\n[... recortado: ${text.length - AGENT_OUTPUT_MAX_CHARS} caracteres mas. Usa find o read_page con ref_id para ver una parte concreta.]`;
}

/// Historia de la conversacion. Solo crece al final (asi el prefijo queda en cache). La captura va
/// en la vuelta que sigue a la accion que la produjo y luego se descarta; en la historia queda el
/// texto de la herramienta, ya recortado.
class AgentConversation {
  constructor(firstMessage, firstView) {
    this.history = [{ role: "user", content: [{ type: "input_text", text: firstMessage }] }];
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
      this.history.push({ type: "function_call_output", call_id: callId, output: `${agentClip(text)}\n(La pantalla nueva va en el siguiente mensaje.)` });
      this.view = output;
    } else {
      this.history.push({ type: "function_call_output", call_id: callId, output: agentClip(output) });
    }
  }
}

/// Suma el gasto de una vuelta. cached = tokens de entrada servidos desde cache; cost = costo de
/// lista que reporta OpenCode (0 si el proveedor no lo manda).
function agentAddUsage(totals, usage) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  totals.turns += 1;
  totals.input += num(usage.input_tokens);
  totals.cached += num(usage.input_tokens_details?.cached_tokens);
  totals.output += num(usage.output_tokens);
  totals.cost += num(usage.opencode?.list_cost);
}
