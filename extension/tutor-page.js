// Parte del tutor que vive dentro de cada frame de la pagina: dibuja el recuadro y la etiqueta, y
// avisa de los clics de la persona. Solo corre mientras hay una clase activa (ver tutor.js).
//
// Cada frame dibuja lo suyo con su propio DOM. Asi un recuadro dentro de un iframe de otro dominio
// no necesita traducir coordenadas, y se mueve solo con el scroll de ese iframe.
//
// Nada de <style>: las paginas con CSP estricta pueden bloquearlo. Los estilos van por el CSSOM y la
// animacion por element.animate(), que la CSP no toca. Nunca se lee lo que la persona teclea ni el
// valor de los campos: de cada clic solo sale la descripcion del elemento.

(() => {
  if (window.__tutor) return;

  const INTERACTIVE = [
    "a[href]", "button", "input", "select", "textarea", "summary", "label", "[contenteditable='true']",
    "[role='button']", "[role='link']", "[role='tab']", "[role='menuitem']", "[role='checkbox']",
    "[role='radio']", "[role='switch']", "[role='option']", "[role='combobox']", "[tabindex='0']",
  ].join(",");
  const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"]);
  const IMPLICIT_ROLES = { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button" };
  const MAX_CANDIDATES = 8;
  const MAX_CONTROL_GROWTH = 25; // Cuantas veces mas grande que el texto puede ser su control
  const RELOCATE_EVERY_MS = 500;
  const LOST_AFTER_MS = 1500;
  const NAME_MAX_CHARS = 120;
  const BOX_COLOR = "#ff4d00";
  const LABEL_BACKGROUND = "#16181d";
  const BOX_PADDING = 3;
  const EDGE_MARGIN = 6;

  let active = false;
  let host = null;
  let layer = null;
  let frameRequest = 0;
  let candidates = [];
  let marks = [];

  // --- Buscar elementos ---

  const normalize = (raw) =>
    (raw || "").normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ").trim().toLowerCase();

  /// Raiz de sombra de un elemento, tambien las cerradas (solo la API de extensiones las alcanza).
  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    if (!el.localName.includes("-")) return null;
    try {
      return chrome.dom?.openOrClosedShadowRoot?.(el) || null;
    } catch {
      return null;
    }
  }

  /// Recorre todos los elementos del frame, entrando a las raices de sombra.
  function* walk(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.nextNode(); el; el = walker.nextNode()) {
      if (el === host || SKIPPED_TAGS.has(el.tagName)) continue;
      yield el;
      const shadow = shadowOf(el);
      if (shadow) yield* walk(shadow);
    }
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return el.checkVisibility ? el.checkVisibility({ checkVisibilityCSS: true }) : true;
  }

  const ownText = (el) =>
    [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(" ");

  function labelledByText(el) {
    const ids = el.getAttribute("aria-labelledby");
    if (!ids) return "";
    const root = el.getRootNode();
    return ids.split(/\s+/).map((id) => root.getElementById?.(id)?.textContent || "").join(" ");
  }

  /// Textos con los que una persona reconoceria el elemento, sin leer nunca lo que tenga escrito.
  function textsOf(el, interactive) {
    const texts = [el.getAttribute("aria-label"), labelledByText(el), el.getAttribute("title"),
      el.getAttribute("placeholder"), el.getAttribute("alt")];
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) texts.push(el.value);
    if (el.labels?.length) texts.push(el.labels[0].textContent);
    texts.push(interactive && el.tagName !== "SELECT" ? el.textContent : ownText(el));
    return texts.filter(Boolean);
  }

  /// Puntua que tan bien coincide un texto: exacto vale mas, y un texto largo que solo lo contiene vale menos.
  function textScore(wanted, texts) {
    let best = 0;
    for (const raw of texts) {
      const text = normalize(raw);
      if (!text.includes(wanted)) continue;
      best = Math.max(best, text === wanted ? 100 : 40 + 40 * (wanted.length / text.length));
    }
    return best;
  }

  const roleOf = (el) => el.getAttribute("role") || IMPLICIT_ROLES[el.tagName] || (el.tagName === "INPUT" ? el.type : "");

  /// Sube del texto al control que se usa: de la etiqueta a su campo, o del span a su boton.
  function controlFor(el) {
    if (el.tagName === "LABEL" && el.control && isVisible(el.control)) return el.control;
    const interactive = el.closest(INTERACTIVE);
    if (!interactive || !isVisible(interactive)) return el;
    // Una tabla o un panel enfocable tambien cuentan como interactivos: subir hasta ahi recuadraria
    // todo el contenedor en vez del encabezado o la celda que se busco.
    const own = el.getBoundingClientRect();
    const outer = interactive.getBoundingClientRect();
    return outer.width * outer.height <= own.width * own.height * MAX_CONTROL_GROWTH ? interactive : el;
  }

  /// Elemento que de verdad recibiria un clic en ese punto, entrando a las raices de sombra.
  function deepElementAt(x, y) {
    let hit = document.elementFromPoint(x, y);
    while (hit) {
      const inner = shadowOf(hit)?.elementFromPoint(x, y);
      if (!inner || inner === hit) return hit;
      hit = inner;
    }
    return null;
  }

  /// Dice si otra cosa (un modal, un menu) esta encima del elemento y se llevaria el clic.
  function isCovered(el, rect) {
    if (!inViewport(rect)) return false;
    const hit = deepElementAt(
      Math.min(Math.max(0, rect.left + rect.width / 2), innerWidth - 1),
      Math.min(Math.max(0, rect.top + rect.height / 2), innerHeight - 1),
    );
    return Boolean(hit) && !el.contains(hit) && !hit.contains(el) && !el.getRootNode().host?.contains(hit);
  }

  function nameOf(el) {
    const raw = textsOf(el, true).find((t) => normalize(t)) || el.getAttribute("name") || "";
    return raw.replace(/\s+/g, " ").trim().slice(0, NAME_MAX_CHARS);
  }

  function inViewport(rect) {
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  }

  function scoreBySelector(selector, role) {
    const found = new Map();
    const roots = [document];
    for (const el of walk(document)) {
      const shadow = shadowOf(el);
      if (shadow) roots.push(shadow);
    }
    for (const root of roots) {
      for (const el of root.querySelectorAll(selector)) {
        if (isVisible(el) && (!role || roleOf(el) === role)) found.set(el, 100);
      }
    }
    return found;
  }

  function scoreByText(text, role) {
    const wanted = normalize(text);
    const found = new Map();
    if (!wanted) return found;
    for (const el of walk(document)) {
      const interactive = el.matches(INTERACTIVE);
      const score = textScore(wanted, textsOf(el, interactive));
      if (!score || !isVisible(el)) continue;
      const target = controlFor(el);
      if (role && roleOf(target) !== role) continue;
      const total = score + (target.matches(INTERACTIVE) ? 20 : 0);
      if (total > (found.get(target) || 0)) found.set(target, total);
    }
    return found;
  }

  /// Ordena de mejor a peor; a igual puntaje gana lo visible en pantalla y luego lo mas chico.
  function rankedElements(query) {
    const found = query.selector ? scoreBySelector(query.selector, query.role) : scoreByText(query.text, query.role);
    return [...found.entries()]
      .map(([el, score]) => ({ el, score, rect: el.getBoundingClientRect() }))
      .sort((a, b) => b.score - a.score
        || Number(inViewport(b.rect)) - Number(inViewport(a.rect))
        || a.rect.width * a.rect.height - b.rect.width * b.rect.height)
      .slice(0, MAX_CANDIDATES);
  }

  /// Regresa los candidatos de este frame; point() los usa despues por su posicion en la lista.
  function locate(query) {
    const ranked = rankedElements(query);
    candidates = ranked.map((r) => r.el);
    return ranked.map((r, index) => ({
      index,
      score: Math.round(r.score),
      tag: r.el.localName,
      role: roleOf(r.el),
      name: nameOf(r.el),
      inViewport: inViewport(r.rect),
      covered: isCovered(r.el, r.rect),
    }));
  }

  // --- Dibujar ---

  function ensureLayer() {
    if (host?.isConnected) return;
    if (!host) {
      host = document.createElement("div");
      host.setAttribute("popover", "manual");
      host.style.cssText = "all:initial;position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;"
        + "border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;display:block;";
      layer = host.attachShadow({ mode: "closed" });
    }
    document.documentElement.appendChild(host);
    raiseLayer();
  }

  /// Sube la capa a la top layer, encima incluso de un <dialog> modal que la pagina abra despues.
  function raiseLayer() {
    if (!host?.isConnected) return;
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch {
      // Navegador sin popover o documento raro: queda con z-index maximo, que casi siempre basta.
    }
  }

  function createMarkNodes(label, dashed) {
    const box = document.createElement("div");
    box.style.cssText = `all:initial;position:fixed;box-sizing:border-box;pointer-events:none;border-radius:6px;`
      + `border:3px ${dashed ? "dashed" : "solid"} ${BOX_COLOR};`
      + `box-shadow:0 0 0 1px #fff,inset 0 0 0 1px #fff;`;
    layer.appendChild(box);
    let tag = null;
    if (label) {
      tag = document.createElement("div");
      tag.textContent = label;
      tag.style.cssText = `all:initial;position:fixed;box-sizing:border-box;pointer-events:none;max-width:340px;`
        + `padding:6px 10px;border-radius:6px;background:${LABEL_BACKGROUND};color:#fff;`
        + `font:500 14px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;`
        + `box-shadow:0 2px 10px rgba(0,0,0,.35);`;
      layer.appendChild(tag);
    }
    return { box, tag };
  }

  function placeMark(mark, rect) {
    const { box, tag } = mark;
    box.style.display = "block";
    box.style.left = `${rect.left - BOX_PADDING}px`;
    box.style.top = `${rect.top - BOX_PADDING}px`;
    box.style.width = `${rect.width + BOX_PADDING * 2}px`;
    box.style.height = `${rect.height + BOX_PADDING * 2}px`;
    if (!tag) return;
    tag.style.display = "block";
    const size = tag.getBoundingClientRect();
    const above = rect.top - BOX_PADDING - size.height - EDGE_MARGIN;
    const below = rect.bottom + BOX_PADDING + EDGE_MARGIN;
    let top = above;
    if (above < EDGE_MARGIN) top = below + size.height <= innerHeight ? below : rect.top + EDGE_MARGIN;
    const left = Math.min(Math.max(EDGE_MARGIN, rect.left), innerWidth - size.width - EDGE_MARGIN);
    tag.style.left = `${left}px`;
    tag.style.top = `${top}px`;
  }

  function hideMark(mark) {
    mark.box.style.display = "none";
    if (mark.tag) mark.tag.style.display = "none";
  }

  function pulse(box) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    box.animate(
      [{ transform: "scale(1.25)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }],
      { duration: 280, easing: "ease-out" },
    );
  }

  /// Vuelve a buscar un elemento que la pagina redibujo. Si no aparece, avisa una sola vez.
  function relocate(mark, now) {
    mark.lostSince ??= now;
    if (now - (mark.lastSearch || 0) >= RELOCATE_EVERY_MS && mark.query) {
      mark.lastSearch = now;
      const again = rankedElements(mark.query)[0]?.el;
      if (again) {
        mark.el = again;
        mark.lostSince = null;
        mark.reported = false;
        return;
      }
    }
    if (!mark.reported && now - mark.lostSince >= LOST_AFTER_MS) {
      mark.reported = true;
      send("mark_lost", { label: mark.label, query: mark.query });
    }
  }

  function tick(now) {
    frameRequest = 0;
    if (!marks.length) return;
    ensureLayer();
    for (const mark of marks) {
      if (mark.area) {
        placeMark(mark, mark.area);
        continue;
      }
      if (mark.el?.isConnected && isVisible(mark.el)) {
        mark.lostSince = null;
        placeMark(mark, mark.el.getBoundingClientRect());
      } else {
        hideMark(mark);
        relocate(mark, now);
      }
    }
    frameRequest = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (!frameRequest) frameRequest = requestAnimationFrame(tick);
  }

  function addMark(fields, label, dashed = false) {
    ensureLayer();
    const mark = { ...fields, label, ...createMarkNodes(label, dashed) };
    marks.push(mark);
    raiseLayer();
    pulse(mark.box);
    startLoop();
    return mark;
  }

  function removeMark(mark) {
    mark.box.remove();
    mark.tag?.remove();
    marks = marks.filter((m) => m !== mark);
  }

  function clear() {
    [...marks].forEach(removeMark);
    candidates = [];
  }

  function point(index, label, query) {
    const el = candidates[index];
    if (!el?.isConnected) return false;
    if (!inViewport(el.getBoundingClientRect())) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    addMark({ el, query }, label);
    return true;
  }

  function pointArea(area, label) {
    addMark({ area: { left: area[0], top: area[1], right: area[0] + area[2], bottom: area[1] + area[3], width: area[2], height: area[3] } }, label);
    return true;
  }

  // --- Clics de la persona ---

  function send(kind, fields) {
    try {
      chrome.runtime.sendMessage({ type: "tutor_event", kind, fields }).catch(() => {});
    } catch {
      deactivate(); // La extension se recargo: este script quedo huerfano y ya no puede avisar.
    }
  }

  function describe(event) {
    const path = event.composedPath().filter((n) => n instanceof Element);
    const el = path.find((n) => n.matches(INTERACTIVE)) || path[0];
    if (!el) return { path, element: null };
    return {
      path,
      element: {
        tag: el.localName,
        role: roleOf(el),
        name: nameOf(el),
        id: el.id || undefined,
        testid: el.getAttribute("data-testid") || undefined,
        href: el.href && typeof el.href === "string" ? el.href : undefined,
      },
    };
  }

  function hitMark(event, path) {
    return marks.find((m) => (m.area
      ? event.clientX >= m.area.left && event.clientX <= m.area.right && event.clientY >= m.area.top && event.clientY <= m.area.bottom
      : m.el && path.includes(m.el)));
  }

  function report(kind, event) {
    const { path, element } = describe(event);
    const hit = hitMark(event, path);
    send(kind, {
      element,
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      on_target: Boolean(hit),
      target_label: hit?.label,
      top_frame: window === window.top,
    });
    return path;
  }

  const isQuestionGesture = (event) => event.isTrusted && event.ctrlKey && event.shiftKey;

  /// Marca un momento lo que se pregunto, para que se note que la pregunta llego.
  function acknowledge(path) {
    const el = path[0];
    if (!el) return;
    const mark = addMark({ el }, "Pregunta enviada", true);
    setTimeout(() => removeMark(mark), 1400);
  }

  /// Ctrl+Shift+clic pregunta sin activar nada: se detiene antes de que la pagina lo vea.
  function swallowQuestion(event) {
    if (!isQuestionGesture(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "pointerdown") acknowledge(report("question", event));
  }

  function onClick(event) {
    if (!event.isTrusted || isQuestionGesture(event)) return;
    report("click", event);
    setTimeout(raiseLayer, 300); // El clic pudo abrir un modal que quedo encima de la capa.
  }

  const QUESTION_EVENTS = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "auxclick", "contextmenu"];

  function activate() {
    if (active) return;
    active = true;
    for (const type of QUESTION_EVENTS) addEventListener(type, swallowQuestion, true);
    addEventListener("click", onClick, true);
  }

  function deactivate() {
    active = false;
    for (const type of QUESTION_EVENTS) removeEventListener(type, swallowQuestion, true);
    removeEventListener("click", onClick, true);
    clear();
    host?.remove();
  }

  window.__tutor = { activate, deactivate, locate, point, pointArea, clear };

  // Frame nuevo durante una clase (lo inyecta el registro dinamico): pregunta si le toca escuchar.
  try {
    chrome.runtime.sendMessage({ type: "tutor_hello" }).then((reply) => {
      if (reply?.active) activate();
    }).catch(() => {});
  } catch {
    // Sin contexto de extension no hay nada que hacer.
  }
})();
