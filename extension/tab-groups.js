// Grupos de pestanas de la extension. Se carga con importScripts desde background.js y comparte
// su estado global (tabGroupId, tabGroupTabs, toolHandlers).
//
// Una pestana es "nuestra" si esta en un grupo titulado "Chrome" (o "MCP" de versiones viejas);
// solo sobre esas operan las demas tools. Aqui viven:
// - tabs_context_mcp / tabs_create_mcp, con `incognito` opcional para elegir el tipo de ventana.
//   Una pestana de incognito no puede entrar a un grupo de ventana normal (ni al reves), por
//   eso cada tipo lleva su propio grupo "Chrome".
// - tabs_list_all: todas las pestanas abiertas, con su ventana y si son de incognito.
// - tabs_attach: engancha una pestana que ya existe (sin recargarla) metiendola a un grupo
//   "Chrome" de su propia ventana.

const OUR_GROUP_TITLES = new Set(["Chrome", "MCP"]);
const ATTACHED_KEY = "attachedTabIds";

/// Ids de pestanas enganchadas por el usuario; la limpieza de grupos viejos nunca las cierra.
async function getAttachedTabIds() {
  try {
    const stored = await chrome.storage.session.get(ATTACHED_KEY);
    return new Set(stored[ATTACHED_KEY] || []);
  } catch {
    return new Set();
  }
}

async function rememberAttachedTab(tabId) {
  const ids = await getAttachedTabIds();
  ids.add(tabId);
  try { await chrome.storage.session.set({ [ATTACHED_KEY]: [...ids] }); } catch {}
}

/// Evita acumulacion infinita de grupos huerfanos de sesiones viejas. Solo si ya hay mas de
/// MAX_MCP_GROUPS grupos nuestros se cierran TODOS antes de abrir el nuevo. El umbral evita
/// reventar grupos donde otra instancia siga trabajando. Las pestanas enganchadas con
/// tabs_attach son del usuario y nunca se cierran.
async function pruneOrphanGroups() {
  const MAX_MCP_GROUPS = 5;
  try {
    const ours = (await chrome.tabGroups.query({})).filter((g) => OUR_GROUP_TITLES.has(g.title));
    if (ours.length <= MAX_MCP_GROUPS) return;
    const attached = await getAttachedTabIds();
    for (const g of ours) {
      const gtabs = await chrome.tabs.query({ groupId: g.id });
      const ids = gtabs.map((t) => t.id).filter((id) => id != null && !attached.has(id));
      if (ids.length) { try { await chrome.tabs.remove(ids); } catch {} }
    }
    tabGroupId = null;
    tabGroupTabs.clear();
  } catch {}
}

async function ensureTabGroup(createIfEmpty) {
  if (tabGroupId !== null) {
    try {
      await chrome.tabGroups.get(tabGroupId);
      const tabs = await chrome.tabs.query({ groupId: tabGroupId });
      tabGroupTabs = new Set(tabs.map((t) => t.id));
      if (tabGroupTabs.size > 0) return;
    } catch {
      tabGroupId = null;
      tabGroupTabs.clear();
    }
  }
  if (!createIfEmpty) return;
  await pruneOrphanGroups();

  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
  await chrome.tabGroups.update(groupId, { title: "Chrome", color: tab.incognito ? "grey" : "blue" });
  tabGroupId = groupId;
  tabGroupTabs = new Set([tab.id]);
}

function formatTabContext(tabs) {
  const available = tabs.map((t) => ({
    tabId: t.id,
    incognito: t.incognito,
    title: t.title || "Untitled",
    url: t.url || "",
  }));

  let text = `Tab Context:\n- Available tabs:\n`;
  for (const t of available) {
    text += `  • tabId ${t.tabId}${t.incognito ? " [incógnito]" : ""}: "${t.title}" (${t.url})\n`;
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ availableTabs: available, tabGroupId }) + "\n\n" + text }],
  };
}

/// La pestana es nuestra si esta en un grupo de la extension. Puede haber varios grupos de
/// sesiones distintas (y uno por ventana de incognito): se adopta el grupo de la pestana que se
/// pide, en vez de quedarse con el primero que se encontro.
async function isInGroup(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId === -1) return tabGroupTabs.has(tabId);
    if (tab.groupId === tabGroupId) return true;
    const group = await chrome.tabGroups.get(tab.groupId);
    if (!OUR_GROUP_TITLES.has(group.title)) return false;
    tabGroupId = group.id;
    const groupTabs = await chrome.tabs.query({ groupId: tabGroupId });
    tabGroupTabs = new Set(groupTabs.map((t) => t.id));
    return true;
  } catch {
    return false;
  }
}

/// Recupera el grupo activo despues de que el service worker se reinicia.
async function recoverTabGroupState() {
  try {
    const groups = await chrome.tabGroups.query({ title: "Chrome" });
    if (groups.length > 0) {
      tabGroupId = groups[0].id;
      const tabs = await chrome.tabs.query({ groupId: tabGroupId });
      tabGroupTabs = new Set(tabs.map((t) => t.id));
    }
  } catch {
    // No es critico: se fija en la primera llamada a tabs_context_mcp.
  }
}

// --- Incognito ---

async function isGroupIncognito(groupId) {
  const group = await chrome.tabGroups.get(groupId);
  const win = await chrome.windows.get(group.windowId);
  return win.incognito;
}

/// Ventana normal (no popup) del tipo pedido, prefiriendo la que tenga el foco. Si no hay
/// ninguna abierta se crea. Sin permiso de incognito truena con la instruccion para darlo.
async function findOrCreateWindow(incognito) {
  if (incognito && !(await chrome.extension.isAllowedIncognitoAccess())) {
    throw new Error(
      "La extensión no tiene permiso de incógnito. En chrome://extensions > automaton > Detalles, activa 'Permitir en modo incógnito' y vuelve a intentar."
    );
  }
  const windows = (await chrome.windows.getAll({ windowTypes: ["normal"] }))
    .filter((w) => w.incognito === incognito);
  const target = windows.find((w) => w.focused) || windows[0];
  if (target) return { windowId: target.id, blankTabId: null };
  const created = await chrome.windows.create({ incognito, url: "about:blank" });
  return { windowId: created.id, blankTabId: created.tabs[0].id };
}

async function createGroupIn(incognito) {
  await pruneOrphanGroups();
  const { windowId, blankTabId } = await findOrCreateWindow(incognito);
  const tabId = blankTabId ?? (await chrome.tabs.create({ windowId, url: "about:blank", active: true })).id;
  const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title: "Chrome", color: incognito ? "grey" : "blue" });
  tabGroupId = groupId;
  tabGroupTabs = new Set([tabId]);
}

/// Vuelve activo un grupo nuestro del tipo pedido (incognito o normal); si no hay, crea uno.
async function useGroupOfKind(incognito) {
  if (tabGroupId !== null) {
    try {
      if ((await isGroupIncognito(tabGroupId)) === incognito) {
        const tabs = await chrome.tabs.query({ groupId: tabGroupId });
        if (tabs.length) return;
      }
    } catch {}
  }
  for (const group of await chrome.tabGroups.query({})) {
    if (!OUR_GROUP_TITLES.has(group.title)) continue;
    try {
      if ((await isGroupIncognito(group.id)) !== incognito) continue;
    } catch {
      continue;
    }
    const tabs = await chrome.tabs.query({ groupId: group.id });
    if (!tabs.length) continue;
    tabGroupId = group.id;
    tabGroupTabs = new Set(tabs.map((t) => t.id));
    return;
  }
  await createGroupIn(incognito);
}

// --- Tools ---

toolHandlers.tabs_context_mcp = async function (args) {
  if (typeof args.incognito === "boolean") {
    await useGroupOfKind(args.incognito);
  } else {
    await ensureTabGroup(args.createIfEmpty);
  }
  if (tabGroupId === null) {
    return { content: [{ type: "text", text: "No MCP tab group exists. Use createIfEmpty: true to create one." }] };
  }
  const tabs = await chrome.tabs.query({ groupId: tabGroupId });
  return formatTabContext(tabs);
};

toolHandlers.tabs_create_mcp = async function (args) {
  if (typeof args.incognito === "boolean") {
    await useGroupOfKind(args.incognito);
  } else {
    await ensureTabGroup(true);
  }
  // Se crea en la ventana del grupo: en la ventana con foco podria ser de otro tipo
  // (incognito vs normal) y chrome.tabs.group fallaria.
  const group = await chrome.tabGroups.get(tabGroupId);
  const tab = await chrome.tabs.create({ windowId: group.windowId, active: true });
  await chrome.tabs.group({ tabIds: [tab.id], groupId: tabGroupId });
  tabGroupTabs.add(tab.id);
  const tabs = await chrome.tabs.query({ groupId: tabGroupId });
  const result = formatTabContext(tabs);
  result.content[0].text = `Created new tab. Tab ID: ${tab.id}\n\n` + result.content[0].text;
  return result;
};

toolHandlers.tabs_list_all = async function () {
  const allowed = await chrome.extension.isAllowedIncognitoAccess();
  const groupTitles = new Map();
  for (const g of await chrome.tabGroups.query({})) groupTitles.set(g.id, g.title || "");
  const rows = (await chrome.tabs.query({})).map((t) => ({
    tabId: t.id,
    windowId: t.windowId,
    incognito: t.incognito,
    active: t.active,
    group: t.groupId === -1 ? null : groupTitles.get(t.groupId) ?? "",
    attached: t.groupId !== -1 && OUR_GROUP_TITLES.has(groupTitles.get(t.groupId)),
    title: t.title || "Untitled",
    url: t.url || "",
  }));

  let text = `Pestañas abiertas (${rows.length}):\n`;
  for (const r of rows) {
    const flags = [
      r.incognito ? "incógnito" : "normal",
      `ventana ${r.windowId}`,
      r.active ? "activa" : null,
      r.attached ? "ya enganchada" : r.group !== null ? `grupo "${r.group}"` : null,
    ].filter(Boolean).join(", ");
    text += `  • tabId ${r.tabId} [${flags}]: "${r.title}" (${r.url})\n`;
  }
  if (!allowed) {
    text += "\nOjo: la extensión no tiene permiso de incógnito, así que esas pestañas no aparecen. Se activa en chrome://extensions > automaton > Detalles > 'Permitir en modo incógnito'.\n";
  }
  text += "\nPara operar una pestaña que no está enganchada: tabs_attach(tabId).";
  return {
    content: [{ type: "text", text: JSON.stringify({ tabs: rows, incognitoAllowed: allowed }) + "\n\n" + text }],
  };
};

toolHandlers.tabs_attach = async function (args) {
  const { tabId, force } = args;
  const tab = await chrome.tabs.get(tabId);
  if (/^(chrome|chrome-extension|devtools|edge):/.test(tab.url || "")) {
    return { content: [{ type: "text", text: `La pestaña ${tabId} es una página interna del navegador (${tab.url}); Chrome no deja depurarla.` }] };
  }

  let alreadyOurs = false;
  if (tab.groupId !== -1) {
    const current = await chrome.tabGroups.get(tab.groupId);
    alreadyOurs = OUR_GROUP_TITLES.has(current.title);
    if (alreadyOurs) {
      tabGroupId = current.id;
    } else if (!force) {
      return {
        content: [{ type: "text", text: `La pestaña ${tabId} está en el grupo "${current.title}" del usuario. Engancharla la saca de ese grupo; repite con force: true si es lo que se quiere.` }],
      };
    }
  }

  if (!alreadyOurs) {
    const sameWindowGroup = (await chrome.tabGroups.query({ windowId: tab.windowId }))
      .find((g) => OUR_GROUP_TITLES.has(g.title));
    if (sameWindowGroup) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: sameWindowGroup.id });
      tabGroupId = sameWindowGroup.id;
    } else {
      const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
      await chrome.tabGroups.update(groupId, { title: "Chrome", color: tab.incognito ? "grey" : "blue" });
      tabGroupId = groupId;
    }
  }

  await rememberAttachedTab(tabId);
  const tabs = await chrome.tabs.query({ groupId: tabGroupId });
  tabGroupTabs = new Set(tabs.map((t) => t.id));
  const result = formatTabContext(tabs);
  const kind = tab.incognito ? "incógnito" : "normal";
  result.content[0].text = `Pestaña ${tabId} enganchada (${kind}), sin recargar.\n\n` + result.content[0].text;
  return result;
};
