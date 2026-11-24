// browser_batch: corre una lista de tools del navegador en una sola peticion, en orden, y se
// detiene en el primer paso que falle. Ahorra una vuelta completa por paso cuando el agente ya sabe
// lo que sigue (clic, escribir, Enter). Se carga desde background.js con importScripts y comparte
// su ambito.
//
// No reintenta nada: repetir el lote completo volveria a dar clics que ya se dieron.

// Tools que pueden ir dentro de un lote. Las de clase, monitor, recorridos, archivos o grabacion
// tienen su propio ciclo de vida y se llaman solas.
const BATCH_TOOLS = new Set([
  "computer", "navigate", "find", "read_page", "get_page_text", "form_input", "javascript_tool",
  "tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp", "tabs_activate",
  "read_console_messages", "read_network_requests", "resize_window",
]);
const BATCH_MAX_ACTIONS = 50;
const BATCH_LOAD_WAIT_MS = 3000; // Tras un paso, espera a que la pestana deje de cargar, hasta este tope
// Tools que devuelven contenido de la pagina: su texto puede decir "Error" sin que la tool fallara.
const BATCH_READ_TOOLS = new Set(["read_page", "get_page_text", "read_console_messages", "read_network_requests"]);
// Como las tools viejas avisan sus fallas con texto normal, se reconocen por como empieza.
const BATCH_FAILURE_TEXT = [
  /^Error\b/i, /is not in the MCP group/, /no esta en el grupo/i, /\bis required\b/, /^Could not /,
  /^Unknown /, /\bfailed\b/i, /^No elements found/, /^Invalid URL/, /ya no (esta|existe)/i,
  /^No se encontr/i, /^Falta/i,
];

function batchFirstText(result) {
  return (result?.content || []).find((p) => p.type === "text")?.text || "";
}

/// True si el resultado de una tool es una falla: isError explicito o un texto de error conocido.
function batchFailed(name, result) {
  if (result?.isError) return true;
  const text = batchFirstText(result);
  if (name === "javascript_tool") return /^Error:/.test(text);
  if (BATCH_READ_TOOLS.has(name)) return false;
  return BATCH_FAILURE_TEXT.some((re) => re.test(text));
}

function batchLabel(index, step) {
  const action = step.input?.action;
  return `${index + 1}. ${step.name}${typeof action === "string" ? `:${action}` : ""}`;
}

/// Revisa el lote completo antes de correr nada. Devuelve el error o null.
function batchValidate(actions) {
  if (!Array.isArray(actions) || !actions.length) return "actions debe ser una lista con al menos un paso.";
  if (actions.length > BATCH_MAX_ACTIONS) return `Un lote admite hasta ${BATCH_MAX_ACTIONS} pasos; vienen ${actions.length}.`;
  for (const [i, step] of actions.entries()) {
    if (!step || typeof step.name !== "string") return `actions[${i}].name debe ser el nombre de una tool.`;
    if (!step.input || typeof step.input !== "object" || Array.isArray(step.input)) return `actions[${i}].input debe ser un objeto.`;
    if (!BATCH_TOOLS.has(step.name) || !toolHandlers[step.name]) {
      return `actions[${i}]: ${step.name} no puede ir dentro de browser_batch; llamala sola. Ningun paso se ejecuto.`;
    }
  }
  return null;
}

async function batchWaitLoaded(tabId) {
  if (typeof tabId !== "number") return;
  const start = Date.now();
  while (Date.now() - start < BATCH_LOAD_WAIT_MS) {
    try {
      if ((await chrome.tabs.get(tabId)).status !== "loading") return;
    } catch {
      return;
    }
    await sleep(100);
  }
}

function batchReport(lines, image, isError) {
  const content = [{ type: "text", text: lines.join("\n") }];
  if (image) content.push(image);
  return isError ? { content, isError: true } : { content };
}

toolHandlers.browser_batch = async function (args) {
  const actions = args?.actions;
  const invalid = batchValidate(actions);
  if (invalid) return { content: [{ type: "text", text: `browser_batch: ${invalid}` }], isError: true };

  const lines = [];
  let lastImage = null;
  for (const [i, step] of actions.entries()) {
    const label = batchLabel(i, step);
    const pending = actions.length - i - 1;
    let result;
    try {
      // runTool (background.js) es el mismo camino de una llamada suelta: respeta Detener, dibuja
      // el cursor y graba el cuadro del GIF de cada paso.
      result = await runTool(step.name, step.input);
    } catch (err) {
      result = { content: [{ type: "text", text: `${step.name} failed: ${err.message}` }], isError: true };
    }
    const image = (result?.content || []).find((p) => p.type === "image");
    if (image) lastImage = image;
    const text = (result?.content || []).filter((p) => p.type === "text").map((p) => p.text).join(" ").trim();
    if (batchFailed(step.name, result)) {
      lines.push(`${label}: FALLO. ${text}`);
      if (pending) lines.push(`El lote se detuvo en el paso ${i + 1}; quedaron ${pending} paso(s) sin correr.`);
      return batchReport(lines, lastImage, true);
    }
    lines.push(`${label}: ${text || "ok"}`);
    await batchWaitLoaded(step.input.tabId);
  }
  lines.unshift(`Lote completo: ${actions.length} paso(s).`);
  return batchReport(lines, lastImage, false);
};
