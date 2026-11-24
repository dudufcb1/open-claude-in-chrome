// gif_creator: graba un cuadro por cada accion en una pestana para armar despues un GIF del
// recorrido. La extension solo junta los cuadros y lo que paso en cada uno (clic, arrastre, tecla);
// automaton los recibe con action="frames" y dibuja las marcas y el GIF en Python (gif_export.py).
// Se carga desde background.js con importScripts y comparte su ambito.

const GIF_MAX_FRAMES = 80; // Tope por grabacion para no llenar la memoria del service worker
// Acciones de computer que no cambian la pagina y no merecen cuadro propio.
const GIF_SKIP_ACTIONS = new Set(["screenshot", "zoom", "wait"]);

const gifRecordings = new Map(); // tabId -> { recording: boolean, frames: [], dropped: number }

function gifText(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/// Lo que paso en un cuadro, con los campos que el dibujo necesita (sin el texto completo tecleado).
function gifDescribe(tool, args) {
  if (tool === "navigate") return { kind: "navigate", url: String(args.url || "") };
  const step = { kind: String(args.action || tool) };
  if (Array.isArray(args.coordinate)) step.coordinate = args.coordinate;
  if (Array.isArray(args.start_coordinate)) step.start_coordinate = args.start_coordinate;
  if (typeof args.text === "string") step.text = args.text.slice(0, 60);
  if (args.scroll_direction) step.scroll_direction = args.scroll_direction;
  return step;
}

async function gifAddFrame(tabId, step, shot) {
  const rec = gifRecordings.get(tabId);
  if (!rec?.recording) return;
  if (rec.frames.length >= GIF_MAX_FRAMES) {
    rec.dropped += 1;
    return;
  }
  const { base64, format } = shot || (await takeScreenshot(tabId));
  rec.frames.push({ data: base64, format, step, at: Date.now() });
}

/// Se llama despues de cada tool (runTool, background.js). Si la pestana esta grabando y la accion
/// cambio la pagina, guarda un cuadro. Un screenshot pedido por el agente se reutiliza tal cual.
async function gifAfterTool(tool, args, result) {
  const tabId = args?.tabId;
  if (typeof tabId !== "number" || !gifRecordings.get(tabId)?.recording) return;
  if (tool === "computer" && args.action === "screenshot") {
    const image = (result?.content || []).find((p) => p.type === "image");
    if (image) await gifAddFrame(tabId, { kind: "screenshot" }, { base64: image.data, format: image.mimeType.split("/")[1] });
    return;
  }
  if (tool === "navigate" || (tool === "computer" && !GIF_SKIP_ACTIONS.has(args.action))) {
    await gifAddFrame(tabId, gifDescribe(tool, args)).catch(() => {});
  }
}

chrome.tabs.onRemoved.addListener((tabId) => gifRecordings.delete(tabId));

toolHandlers.gif_creator = async function (args) {
  const { action, tabId } = args;
  if (!(await isInGroup(tabId))) return gifText(`Tab ${tabId} is not in the MCP group. Usa tabs_context_mcp o tabs_attach.`, true);
  const rec = gifRecordings.get(tabId);
  switch (action) {
    case "start_recording": {
      const keep = rec?.frames || [];
      gifRecordings.set(tabId, { recording: true, frames: keep, dropped: rec?.dropped || 0 });
      await gifAddFrame(tabId, { kind: "start" });
      return gifText(`Grabando la pestana ${tabId} (${gifRecordings.get(tabId).frames.length} cuadro(s)). Cada accion agrega uno, hasta ${GIF_MAX_FRAMES}.`);
    }
    case "stop_recording": {
      if (!rec) return gifText("No hay grabacion en esta pestana.", true);
      await gifAddFrame(tabId, { kind: "stop" });
      rec.recording = false;
      return gifText(`Grabacion en pausa con ${rec.frames.length} cuadro(s). Usa export para armar el GIF o start_recording para seguir.`);
    }
    case "frames": {
      if (!rec?.frames.length) return gifText("No hay cuadros grabados en esta pestana.", true);
      return gifText(JSON.stringify({ frames: rec.frames, dropped: rec.dropped }));
    }
    case "clear": {
      gifRecordings.delete(tabId);
      return gifText("Cuadros descartados.");
    }
    default:
      return gifText(`gif_creator: accion desconocida ${action}.`, true);
  }
};
