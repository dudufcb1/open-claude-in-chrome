// Cliente del backend del agente (automaton-agent-backend): manda una vuelta de la conversacion en
// formato de la API Responses y regresa lo que el modelo quiere hacer. La extension no conoce ni la
// llave ni el modelo; solo la URL del backend y su token, que se guardan desde el panel.
// Se carga desde background.js con importScripts y comparte su ambito.

const AGENT_SETTINGS_KEY = "agentSettings";
const AGENT_DEFAULT_BACKEND = "http://127.0.0.1:8792";
const AGENT_REQUEST_TIMEOUT_MS = 120000;
const AGENT_RETRY_DELAYS_MS = [3000, 10000]; // El backend ya reintenta; esto cubre que el backend mismo no conteste

class AgentModelError extends Error {
  constructor(message, transient) {
    super(message);
    this.transient = transient;
  }
}

async function agentLoadSettings() {
  const stored = (await chrome.storage.local.get(AGENT_SETTINGS_KEY))[AGENT_SETTINGS_KEY] || {};
  return { backendUrl: stored.backendUrl || AGENT_DEFAULT_BACKEND, token: stored.token || "" };
}

async function agentSaveSettings(settings) {
  const clean = {
    backendUrl: String(settings.backendUrl || AGENT_DEFAULT_BACKEND).trim().replace(/\/+$/, ""),
    token: String(settings.token || "").trim(),
  };
  await chrome.storage.local.set({ [AGENT_SETTINGS_KEY]: clean });
  return clean;
}

/// Id de sesion con la forma de OpenCode (ses_ + 12 hex + 14 alfanumericos): el backend lo pasa como
/// x-opencode-session y de eso depende que el proveedor reutilice la cache entre vueltas.
function agentNewSessionId() {
  const hex = Date.now().toString(16).padStart(12, "0").slice(-12);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let tail = "";
  for (let i = 0; i < 14; i++) tail += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `ses_${hex}${tail}`;
}

function agentParseArguments(raw) {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/// Separa la respuesta en: items para reenviar tal cual (incluido el razonamiento), llamadas a
/// herramienta y el texto que haya escrito el modelo.
function agentParseTurn(body) {
  if (!body || typeof body !== "object") throw new AgentModelError("El modelo devolvio una respuesta ilegible.", true);
  if (body.error) throw new AgentModelError(`El modelo fallo: ${body.error.message || "sin detalle"}`, false);
  const items = (Array.isArray(body.output) ? body.output : []).filter((o) => o && typeof o === "object");
  const calls = items
    .filter((o) => o.type === "function_call")
    .map((o) => ({ callId: String(o.call_id || ""), name: String(o.name || ""), arguments: agentParseArguments(o.arguments) }));
  const text = items
    .filter((o) => o.type === "message" && Array.isArray(o.content))
    .flatMap((o) => o.content)
    .map((c) => (typeof c?.text === "string" ? c.text : ""))
    .join("\n")
    .trim();
  return { items, calls, text, usage: body.usage || {} };
}

/// cancelSignal es el de la corrida: al picar Detener corta la peticion en vuelo.
async function agentCallOnce(settings, sessionId, runId, payload, cancelSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_REQUEST_TIMEOUT_MS);
  const onCancel = () => controller.abort();
  cancelSignal?.addEventListener("abort", onCancel);
  let res;
  try {
    res = await fetch(`${settings.backendUrl}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.token}`,
        "Content-Type": "application/json",
        "X-Session-Id": sessionId,
        "X-Run-Id": runId,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    if (cancelSignal?.aborted) throw new AgentModelError("Detenido por el usuario.", false);
    throw new AgentModelError(e.name === "AbortError" ? "El modelo tardo mas de dos minutos." : `No se pudo contactar al backend (${settings.backendUrl}).`, true);
  } finally {
    clearTimeout(timer);
    cancelSignal?.removeEventListener("abort", onCancel);
  }
  if (res.status === 401) throw new AgentModelError("El backend rechazo el token. Revisalo en Ajustes del panel.", false);
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new AgentModelError(`El modelo respondio ${res.status}. ${detail}`, res.status === 429 || res.status >= 500);
  }
  const body = await res.json().catch(() => null);
  if (body === null) throw new AgentModelError("La respuesta del modelo llego incompleta.", true);
  return agentParseTurn(body);
}

/// Una vuelta del modelo, con dos reintentos si el backend no contesta o falla de su lado.
async function agentCallModel(settings, sessionId, runId, instructions, input, tools, cancelSignal) {
  const payload = { instructions, input, tools, store: false, parallel_tool_calls: false };
  for (let attempt = 0; ; attempt++) {
    try {
      return await agentCallOnce(settings, sessionId, runId, payload, cancelSignal);
    } catch (e) {
      const delay = AGENT_RETRY_DELAYS_MS[attempt];
      if (!(e instanceof AgentModelError) || !e.transient || delay === undefined) throw e;
      await sleep(delay);
    }
  }
}
