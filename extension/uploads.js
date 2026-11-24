// Subir archivos a la pagina sin abrir el selector nativo del sistema: file_upload (archivos que
// manda el cliente) y upload_image (una captura ya tomada). Ambos meten los archivos en un
// <input type="file"> por ref o los sueltan con arrastrar y soltar en una coordenada.
//
// El mensaje del host nativo hacia la extension tiene tope de 1 MB, asi que un archivo grande llega
// en partes con upload_stage y file_upload lo cita por su stageId. Se carga desde background.js con
// importScripts y comparte su ambito (usa frames.js para refs y puntos dentro de iframes).

const UPLOAD_STAGE_TTL_MS = 10 * 60 * 1000; // Una subida a medias se descarta a los 10 minutos
const UPLOAD_MAX_BYTES = 50 * 1024 * 1024; // Tope de todos los archivos de una llamada

const uploadStages = new Map(); // stageId -> { parts: string[], touched: number }

function uploadText(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function uploadPruneStages() {
  const now = Date.now();
  for (const [id, st] of uploadStages) if (now - st.touched > UPLOAD_STAGE_TTL_MS) uploadStages.delete(id);
}

/// Bytes reales de un base64, sin decodificarlo.
function uploadBase64Bytes(b64) {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

/// Solo el nombre del archivo, sin carpetas: la pagina no debe recibir rutas de esta maquina.
function uploadSafeName(name) {
  const base = String(name || "").split(/[/\\]/).pop();
  return base && base !== "." && base !== ".." && base.length <= 255 ? base : null;
}

/// Convierte la lista de archivos de la llamada ({data} o {stageId}) en [{name, mimeType, data}].
/// Devuelve un string con el error si algo no cuadra.
function uploadCollect(files) {
  if (!Array.isArray(files) || !files.length) return "files debe ser una lista con al menos un archivo.";
  const out = [];
  let total = 0;
  for (const [i, f] of files.entries()) {
    const name = uploadSafeName(f?.name);
    if (!name) return `files[${i}].name no es un nombre de archivo valido.`;
    let data = f.data;
    if (f.stageId) {
      const st = uploadStages.get(f.stageId);
      if (!st) return `files[${i}]: no hay partes con stageId ${f.stageId} (expiraron o no se mandaron).`;
      data = st.parts.join("");
      uploadStages.delete(f.stageId);
    }
    if (typeof data !== "string" || !data) return `files[${i}] no trae contenido (data o stageId).`;
    total += uploadBase64Bytes(data);
    out.push({ name, mimeType: f.mimeType || "application/octet-stream", data });
  }
  if (total > UPLOAD_MAX_BYTES) return `Los archivos suman ${total} bytes; el tope es ${UPLOAD_MAX_BYTES}.`;
  return out;
}

// --- Lo que corre dentro de la pagina ---
// Ambas funciones se serializan (fn.toString) y se evaluan en el frame destino, asi que no pueden
// usar nada de fuera de su cuerpo. Devuelven { ok, ... } o { ok: false, error }.

function uploadPageIntoInput(ref, files) {
  const el = window.__unblockedChrome?.resolveRef?.(ref);
  if (!el) return { ok: false, error: `La ref ${ref} ya no existe en la pagina; vuelve a usar find o read_page.` };
  const toFile = (f) => new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name, { type: f.mimeType });
  const dt = new DataTransfer();
  files.forEach((f) => dt.items.add(toFile(f)));
  const input = el.matches?.('input[type="file"]') ? el : el.querySelector?.('input[type="file"]');
  if (input) {
    if (!input.multiple && files.length > 1) return { ok: false, error: "El campo acepta un solo archivo y se mandaron varios." };
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, how: "input", count: input.files.length };
  }
  // No es un input de archivo: se trata como zona de arrastrar y soltar.
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, opts));
  return { ok: true, how: "drop", tag: el.tagName.toLowerCase() };
}

function uploadPageDropAt(x, y, files) {
  const el = document.elementFromPoint(x, y);
  if (!el) return { ok: false, error: `No hay ningun elemento en (${x}, ${y}).` };
  const toFile = (f) => new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name, { type: f.mimeType });
  const dt = new DataTransfer();
  files.forEach((f) => dt.items.add(toFile(f)));
  const opts = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x, clientY: y };
  for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, opts));
  return { ok: true, how: "drop", tag: el.tagName.toLowerCase() };
}

/// Corre fn(...args) en la pagina principal (mundo aislado, donde vive content.js con sus refs).
async function uploadRunMain(tabId, fn, args) {
  const target = { tabId, frameIds: [0] };
  // injectImmediately: no esperar a que termine de cargar una pagina que quiza nunca termina.
  const [probe] = await chrome.scripting.executeScript({ target, func: () => !!window.__unblockedChrome, injectImmediately: true });
  if (!probe?.result) await chrome.scripting.executeScript({ target, files: ["content.js"], injectImmediately: true });
  const [res] = await chrome.scripting.executeScript({ target, func: fn, args, injectImmediately: true });
  return res?.result;
}

/// Mete los archivos en el destino: ref (pagina o iframe "f2:ref_7") o coordenada de la pestana.
async function uploadDeliver(tabId, files, ref, coordinate) {
  const scoped = frameParseRef(ref);
  if (scoped) {
    const rec = await frameByNumber(tabId, scoped.n);
    return frameEval(tabId, rec, `(${uploadPageIntoInput})(${JSON.stringify(scoped.ref)}, ${JSON.stringify(files)})`);
  }
  if (ref) return uploadRunMain(tabId, uploadPageIntoInput, [ref, files]);
  const [x, y] = coordinate;
  const rec = await frameAtPoint(tabId, x, y).catch(() => null);
  if (rec) return frameEval(tabId, rec, `(${uploadPageDropAt})(${x - rec.x}, ${y - rec.y}, ${JSON.stringify(files)})`);
  return uploadRunMain(tabId, uploadPageDropAt, [x, y, files]);
}

function uploadTargetError(ref, coordinate) {
  if (ref && coordinate) return "Pasa ref o coordinate, no los dos.";
  if (!ref && !coordinate) return "Falta el destino: ref (campo de archivo) o coordinate (zona de arrastrar y soltar).";
  if (coordinate && (!Array.isArray(coordinate) || coordinate.length !== 2)) return "coordinate debe ser [x, y].";
  return null;
}

function uploadDescribe(result, files) {
  const names = files.map((f) => f.name).join(", ");
  if (result.how === "input") return `Se cargaron ${result.count} archivo(s) en el campo: ${names}.`;
  return `Se soltaron ${files.length} archivo(s) sobre <${result.tag}>: ${names}.`;
}

toolHandlers.upload_stage = async function (args) {
  const { stageId, data } = args;
  if (!stageId || typeof data !== "string") return uploadText("upload_stage: faltan stageId o data.", true);
  uploadPruneStages();
  const st = uploadStages.get(stageId) || { parts: [], touched: 0 };
  st.parts.push(data);
  st.touched = Date.now();
  uploadStages.set(stageId, st);
  return uploadText(`Parte ${st.parts.length} de ${stageId} recibida.`);
};

toolHandlers.file_upload = async function (args) {
  const { tabId, ref, coordinate, files } = args;
  if (!(await isInGroup(tabId))) return uploadText(`Tab ${tabId} is not in the MCP group. Usa tabs_context_mcp o tabs_attach.`, true);
  const targetError = uploadTargetError(ref, coordinate);
  if (targetError) return uploadText(targetError, true);
  const collected = uploadCollect(files);
  if (typeof collected === "string") return uploadText(collected, true);
  const result = await uploadDeliver(tabId, collected, ref, coordinate);
  if (!result?.ok) return uploadText(`file_upload: ${result?.error || "la pagina no respondio"}`, true);
  return uploadText(uploadDescribe(result, collected));
};

toolHandlers.upload_image = async function (args) {
  const { imageId, tabId, ref, coordinate } = args;
  if (!(await isInGroup(tabId))) return uploadText(`Tab ${tabId} is not in the MCP group. Usa tabs_context_mcp o tabs_attach.`, true);
  const targetError = uploadTargetError(ref, coordinate);
  if (targetError) return uploadText(targetError, true);
  const shot = screenshotStore.get(imageId);
  if (!shot) return uploadText(`No hay captura ${imageId}: solo se guardan las ultimas 10. Toma otra con computer screenshot.`, true);
  const ext = shot.format === "png" ? "png" : "jpg";
  const name = uploadSafeName(args.filename) || `image.${ext}`;
  const files = [{ name, mimeType: `image/${shot.format === "png" ? "png" : "jpeg"}`, data: shot.base64 }];
  const result = await uploadDeliver(tabId, files, ref, coordinate);
  if (!result?.ok) return uploadText(`upload_image: ${result?.error || "la pagina no respondio"}`, true);
  return uploadText(uploadDescribe(result, files));
};
