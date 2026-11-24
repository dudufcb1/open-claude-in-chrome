// Herramientas que el agente del panel le ofrece al modelo y como se traducen a las tools de la
// extension. Todas pasan por runTool (background.js), asi que el cursor se ve, el boton Detener de
// la pagina funciona y la grabacion del GIF las registra igual que las del MCP.
// Se carga desde background.js con importScripts y comparte su ambito.

const AGENT_LOOK_AFTER = new Set(["click", "type", "fill", "key", "scroll", "navigate"]); // Cambian la pagina
const AGENT_SETTLE_MS = 600; // Respiro tras una accion antes de mirar, para que la pagina reaccione

const agentFn = (name, description, properties = {}, required = []) => ({
  type: "function",
  name,
  description,
  parameters: { type: "object", properties, required, additionalProperties: false },
});

const AGENT_TOOL_SPECS = [
  agentFn("screenshot", "Toma una captura de la pestana. Las coordenadas de click y scroll son pixeles de esta captura."),
  agentFn("read_page", "Arbol de accesibilidad de la pagina con refs (ref_12) de cada elemento. Usa filter=interactive para ver solo botones, enlaces y campos.", {
    filter: { type: "string", enum: ["interactive", "all"] },
  }),
  agentFn("find", "Busca elementos por descripcion (\"boton de pagar\", \"campo de correo\"). Regresa refs y coordenadas.", {
    query: { type: "string" },
  }, ["query"]),
  agentFn("page_text", "Texto de la pagina, para leer contenido largo."),
  agentFn("click", "Da clic en un elemento. Prefiere ref (de find o read_page); usa x, y solo si no hay ref. kind: left (por omision), right o double.", {
    ref: { type: "string" },
    x: { type: "number" },
    y: { type: "number" },
    kind: { type: "string", enum: ["left", "right", "double"] },
  }),
  agentFn("fill", "Pone el valor de un campo de formulario por su ref (texto, select o checkbox con true/false).", {
    ref: { type: "string" },
    value: { type: "string" },
  }, ["ref", "value"]),
  agentFn("type", "Escribe texto donde esta el foco (despues de dar clic en un campo).", { text: { type: "string" } }, ["text"]),
  agentFn("key", "Presiona teclas separadas por espacio: Enter, Tab, Escape, ctrl+a, ArrowDown.", { keys: { type: "string" } }, ["keys"]),
  agentFn("scroll", "Desplaza la pagina. direction: up, down, left o right; x, y opcionales (centro por omision).", {
    direction: { type: "string", enum: ["up", "down", "left", "right"] },
    x: { type: "number" },
    y: { type: "number" },
  }, ["direction"]),
  agentFn("navigate", "Abre una URL en la pestana, o back / forward en el historial.", { url: { type: "string" } }, ["url"]),
  agentFn("wait", "Espera unos segundos (maximo 10) a que la pagina cargue o reaccione.", { seconds: { type: "number" } }, ["seconds"]),
  agentFn("finish", "Termina la tarea. success=true si se cumplio; summary explica lo que hiciste o por que no se pudo.", {
    success: { type: "boolean" },
    summary: { type: "string" },
  }, ["success", "summary"]),
];

function agentText(result) {
  return (result?.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n").trim();
}

/// Captura de la pestana lista para el modelo: texto con el tamano en pixeles (sin el, Muse
/// contesta coordenadas de 0 a 1000) mas la imagen.
async function agentLook(tabId) {
  const shot = await runTool("computer", { action: "screenshot", tabId });
  const image = (shot?.content || []).find((p) => p.type === "image");
  const tab = await chrome.tabs.get(tabId);
  const size = await cdp(tabId, "Runtime.evaluate", { expression: "[innerWidth, innerHeight]", returnByValue: true })
    .then((r) => r?.result?.value || [0, 0]).catch(() => [0, 0]);
  const header = `URL: ${tab.url}\nTitulo: ${tab.title}\nCaptura de ${size[0]}x${size[1]} pixeles; las coordenadas van en esa escala.`;
  if (!image) return [{ type: "input_text", text: `${header}\n(No se pudo capturar la pantalla: ${agentText(shot)})` }];
  return [{ type: "input_text", text: header }, { type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` }];
}

function agentComputerArgs(tabId, args) {
  if (args.ref) return { tabId, ref: String(args.ref) };
  if (typeof args.x === "number" && typeof args.y === "number") return { tabId, coordinate: [args.x, args.y] };
  return null;
}

/// Ejecuta una llamada del modelo. Regresa { output, finished?, stopped? }: output es texto o, si la
/// accion cambia la pagina, texto mas la captura nueva.
async function agentExecute(tabId, call) {
  const a = call.arguments;
  let result;
  switch (call.name) {
    case "screenshot":
      return { output: await agentLook(tabId) };
    case "read_page":
      result = await runTool("read_page", { tabId, filter: a.filter === "all" ? "all" : "interactive" });
      break;
    case "find":
      result = await runTool("find", { tabId, query: String(a.query || "") });
      break;
    case "page_text":
      result = await runTool("get_page_text", { tabId });
      break;
    case "click": {
      const target = agentComputerArgs(tabId, a);
      if (!target) return { output: "click necesita ref o x, y." };
      const action = a.kind === "right" ? "right_click" : a.kind === "double" ? "double_click" : "left_click";
      result = await runTool("computer", { ...target, action });
      break;
    }
    case "fill": {
      const raw = String(a.value ?? "");
      const value = raw === "true" ? true : raw === "false" ? false : raw;
      result = await runTool("form_input", { tabId, ref: String(a.ref || ""), value });
      break;
    }
    case "type":
      result = await runTool("computer", { tabId, action: "type", text: String(a.text || "") });
      break;
    case "key":
      result = await runTool("computer", { tabId, action: "key", text: String(a.keys || "") });
      break;
    case "scroll": {
      const [w, h] = await cdp(tabId, "Runtime.evaluate", { expression: "[innerWidth, innerHeight]", returnByValue: true })
        .then((r) => r?.result?.value || [800, 600]).catch(() => [800, 600]);
      const coordinate = typeof a.x === "number" && typeof a.y === "number" ? [a.x, a.y] : [Math.round(w / 2), Math.round(h / 2)];
      result = await runTool("computer", { tabId, action: "scroll", coordinate, scroll_direction: a.direction || "down", scroll_amount: 5 });
      result = { content: (result?.content || []).filter((p) => p.type === "text") }; // La captura la toma agentLook
      break;
    }
    case "navigate":
      result = await runTool("navigate", { tabId, url: String(a.url || "") });
      break;
    case "wait":
      await sleep(Math.min(Math.max(Number(a.seconds) || 1, 0), 10) * 1000);
      return { output: "Listo." };
    case "finish":
      return { output: "Tarea terminada.", finished: { success: a.success === true, summary: String(a.summary || "") } };
    default:
      return { output: `No existe la herramienta ${call.name}.` };
  }
  const text = agentText(result) || "ok";
  if (text.startsWith("Detenido:")) return { output: text, stopped: true };
  if (!AGENT_LOOK_AFTER.has(call.name)) return { output: text };
  await sleep(AGENT_SETTLE_MS);
  return { output: [{ type: "input_text", text }, ...(await agentLook(tabId))] };
}
