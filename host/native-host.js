#!/usr/bin/env node

// Native Messaging Host for Open Claude in Chrome extension.
// Launched by Chrome when the extension calls connectNative().
// Bridges between Chrome native messaging (stdin/stdout, 4-byte LE length prefix + JSON)
// and the MCP server (TCP on localhost).

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_PORT = 18765;
const CONFIG_DIR = path.join(os.homedir(), ".config", "open-claude-in-chrome");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const LOG_PATH = path.join(CONFIG_DIR, "host.log");
const LOG_MAX_BYTES = 512 * 1024;

// Carpeta de datos por omision de cada navegador: el perfil que arranca con ella (o sin
// --user-data-dir) es el principal, donde viven las sesiones iniciadas de todos los dias.
const DEFAULT_DATA_DIRS = {
  chrome: path.join(os.homedir(), ".config", "google-chrome"),
  chromium: path.join(os.homedir(), ".config", "chromium"),
  brave: path.join(os.homedir(), ".config", "BraveSoftware", "Brave-Browser"),
  edge: path.join(os.homedir(), ".config", "microsoft-edge"),
};

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

/// Deja una linea en host.log: es lo primero que se revisa cuando un perfil "no agarra".
function log(message) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) {
      fs.renameSync(LOG_PATH, LOG_PATH + ".1");
    }
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} pid=${process.pid} ${message}\n`);
  } catch {
    // Sin log no se detiene el host.
  }
}

// --- Native messaging protocol (Chrome <-> this process) ---

function readNativeMessage(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const len = buffer.readUInt32LE(offset);
    if (offset + 4 + len > buffer.length) break;
    const json = buffer.subarray(offset + 4, offset + 4 + len).toString("utf-8");
    try {
      messages.push(JSON.parse(json));
    } catch (e) {
      // skip malformed
    }
    offset += 4 + len;
  }
  return { messages, remainder: buffer.subarray(offset) };
}

function writeNativeMessage(obj) {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([header, buf]));
}

// --- Deteccion del navegador y perfil que lanzo este host (por proceso padre) ---
// El host lo lanza el navegador via native messaging, asi que subiendo la cadena de
// procesos se llega a chrome/brave/edge. De su linea de comandos sale el perfil: sin
// --user-data-dir (o con la carpeta por omision) es el principal; con otra carpeta es un
// perfil secundario, que se nombra por esa carpeta (ej. /home/edu/chrome-arbe -> chrome-arbe).

function browserFromComm(comm) {
  if (comm.includes("brave")) return "brave";
  if (comm.includes("chromium")) return "chromium";
  if (comm.includes("chrome")) return "chrome";
  if (comm.includes("edge") || comm.includes("msedge")) return "edge";
  return null;
}

function userDataDir(pid) {
  // Chrome reescribe su titulo de proceso: cmdline llega como una sola cadena separada por
  // espacios, no por \0. Por eso se busca el flag con una expresion y no partiendo por \0.
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ");
    const match = cmdline.match(/--user-data-dir=(\S+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function parentPid(pid) {
  // /proc/<pid>/stat -> ppid es el campo tras ") <state>"
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
  const afterComm = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  return parseInt(afterComm[1], 10);
}

function detectBrowser() {
  const unknown = { browser: "unknown", profile: "principal", principal: true, dataDir: null };
  try {
    let pid = process.ppid;
    for (let i = 0; i < 8 && pid && pid > 1; i++) {
      const comm = fs.readFileSync(`/proc/${pid}/comm`, "utf-8").trim().toLowerCase();
      const browser = browserFromComm(comm);
      if (browser) {
        const dataDir = userDataDir(pid);
        const isDefault = !dataDir || path.resolve(dataDir) === DEFAULT_DATA_DIRS[browser];
        return {
          browser,
          profile: isDefault ? "principal" : path.basename(path.resolve(dataDir)),
          principal: isDefault,
          dataDir,
        };
      }
      pid = parentPid(pid);
    }
  } catch {
    // ignore
  }
  return unknown;
}

const IDENTITY = detectBrowser();

/// A que puerto se conecta este host, o null para no conectarse a ninguno.
///
/// - OCIC_PORT en el entorno del navegador manda: alguien lo lanzo apuntado a proposito.
/// - El perfil principal va al puerto de siempre (config.json "port").
/// - Un perfil secundario va SOLO al puerto que tenga en config.json "profiles"; sin
///   entrada no se conecta, para que nunca le quite el lugar al principal.
function resolveTarget() {
  if (process.env.OCIC_PORT) {
    return { port: parseInt(process.env.OCIC_PORT, 10), source: "variable OCIC_PORT" };
  }
  const config = readConfig();
  if (IDENTITY.principal) {
    return { port: config.port || DEFAULT_PORT, source: config.port ? `${CONFIG_PATH} "port"` : "puerto por omision" };
  }
  const port = (config.profiles || {})[IDENTITY.profile];
  if (port) return { port, source: `${CONFIG_PATH} "profiles"."${IDENTITY.profile}"` };
  return { port: null, source: `el perfil "${IDENTITY.profile}" no tiene puerto en ${CONFIG_PATH} "profiles"` };
}

const TARGET = resolveTarget();
log(
  `navegador=${IDENTITY.browser} perfil=${IDENTITY.profile} carpeta=${IDENTITY.dataDir || "(por omision)"} ` +
    (TARGET.port ? `puerto=${TARGET.port} (${TARGET.source})` : `sin conexion: ${TARGET.source}`),
);

// --- TCP connection to MCP server ---

let tcpSocket = null;
let tcpBuffer = Buffer.alloc(0);
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 60; // 30 seconds at 500ms intervals
const TCP_PORT = TARGET.port;

function connectTcp() {
  if (tcpSocket) return;

  tcpSocket = new net.Socket();

  tcpSocket.connect(TCP_PORT, "127.0.0.1", () => {
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
    // Anunciar que navegador somos, para que el bridge permita multi-navegador
    // y switch. Es la PRIMERA linea, asi el bridge la lee al clasificar.
    try {
      tcpSocket.write(
        JSON.stringify({
          type: "native_hello",
          browser: IDENTITY.browser,
          profile: IDENTITY.profile,
          principal: IDENTITY.principal,
        }) + "\n",
      );
    } catch {
      // ignore
    }
  });

  tcpSocket.on("data", (chunk) => {
    // newline-delimited JSON from MCP server
    tcpBuffer = Buffer.concat([tcpBuffer, chunk]);
    let newlineIdx;
    while ((newlineIdx = tcpBuffer.indexOf(10)) !== -1) {
      const line = tcpBuffer.subarray(0, newlineIdx).toString("utf-8").trim();
      tcpBuffer = tcpBuffer.subarray(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        // Forward to extension via native messaging
        writeNativeMessage(msg);
      } catch {
        // skip malformed
      }
    }
  });

  tcpSocket.on("error", () => {
    tcpSocket = null;
  });

  tcpSocket.on("close", () => {
    tcpSocket = null;
    if (!reconnectTimer) {
      reconnectTimer = setInterval(() => {
        reconnectAttempts++;
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          // MCP server is gone — exit cleanly so we don't linger as a zombie
          clearInterval(reconnectTimer);
          process.exit(0);
        }
        if (!tcpSocket) connectTcp();
      }, 500);
    }
  });
}

// --- Monitor de pagina: la extension manda cada evento y aqui se escribe en disco ---
// Una linea JSON por evento en /tmp/page-monitor/<sesion>.jsonl. Se escribe aqui y no en el
// MCP porque el host vive mientras el navegador este abierto, haya o no automaton conectado.

const MON_DIR = "/tmp/page-monitor"; // Debe coincidir con extension/page-monitor.js y con automaton
const MON_SESSION_NAME = /^[\w.-]+$/; // Evita que un nombre raro escriba fuera de MON_DIR

function writeMonitorEvent(msg) {
  if (typeof msg.session !== "string" || !MON_SESSION_NAME.test(msg.session)) return;
  try {
    fs.mkdirSync(MON_DIR, { recursive: true });
    fs.appendFileSync(path.join(MON_DIR, `${msg.session}.jsonl`), JSON.stringify(msg.event) + "\n");
  } catch (e) {
    log(`page-monitor: no se pudo escribir ${msg.session}: ${e.message}`);
  }
}

// --- Main: bridge stdin (from extension) <-> TCP (to MCP server) ---

let stdinBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  const { messages, remainder } = readNativeMessage(stdinBuffer);
  stdinBuffer = remainder;

  for (const msg of messages) {
    if (msg.type === "monitor_event") {
      writeMonitorEvent(msg);
      continue;
    }
    // Forward to MCP server via TCP
    if (tcpSocket && !tcpSocket.destroyed) {
      tcpSocket.write(JSON.stringify(msg) + "\n");
    }
  }
});

process.stdin.on("end", () => {
  // Extension disconnected
  if (tcpSocket) tcpSocket.destroy();
  process.exit(0);
});

// Start TCP connection. Un perfil secundario sin puerto asignado se queda aislado: el host
// sigue vivo para que la extension no lo relance en bucle, pero no habla con nadie.
if (TCP_PORT) connectTcp();
