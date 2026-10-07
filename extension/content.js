// Content script for Open Claude in Chrome extension.
// Injected into every page. Provides:
// - Accessibility tree generation (read_page)
// - Element ref mapping with WeakRef (persistent across calls)
// - Form input handling
// - Page text extraction
// - Element finding by text/attributes

(function () {
  if (window.__unblockedChromeLoaded) return;
  window.__unblockedChromeLoaded = true;

  // --- Element reference map ---
  // Persistent ref IDs stored as WeakRefs so GC still works
  let refCounter = 0;
  const elementMap = {}; // refId -> WeakRef<Element>
  const reverseMap = new WeakMap(); // Element -> refId

  function getOrAssignRef(el) {
    const existing = reverseMap.get(el);
    if (existing && elementMap[existing]?.deref() === el) return existing;
    const ref = `ref_${++refCounter}`;
    elementMap[ref] = new WeakRef(el);
    reverseMap.set(el, ref);
    return ref;
  }

  function resolveRef(refId) {
    const wr = elementMap[refId];
    if (!wr) return null;
    const el = wr.deref();
    if (!el) {
      delete elementMap[refId];
      return null;
    }
    return el;
  }

  // --- ARIA role mapping ---
  const TAG_TO_ROLE = {
    a: "link",
    button: "button",
    input: "textbox",
    textarea: "textbox",
    select: "combobox",
    img: "img",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    aside: "complementary",
    form: "form",
    table: "table",
    tr: "row",
    th: "columnheader",
    td: "cell",
    ul: "list",
    ol: "list",
    li: "listitem",
    dialog: "dialog",
    details: "group",
    summary: "button",
    progress: "progressbar",
    meter: "meter",
    video: "video",
    audio: "audio",
    section: "region",
    article: "article",
  };

  function getRole(el) {
    if (el.getAttribute("role")) return el.getAttribute("role");
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      const typeRoles = {
        checkbox: "checkbox",
        radio: "radio",
        range: "slider",
        button: "button",
        submit: "button",
        reset: "button",
        search: "searchbox",
        number: "spinbutton",
      };
      return typeRoles[type] || "textbox";
    }
    return TAG_TO_ROLE[tag] || null;
  }

  // --- Accessible name ---
  function getAccessibleName(el) {
    // Priority: aria-label > aria-labelledby > placeholder > title > alt > label > text
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const names = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean);
      if (names.length) return names.join(" ");
    }

    if (el.placeholder) return el.placeholder.trim();
    if (el.title) return el.title.trim();
    if (el.alt) return el.alt.trim();

    // Associated <label>
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }
    if (el.closest("label")) {
      const labelText = el.closest("label").textContent.trim();
      if (labelText) return labelText;
    }

    // Direct text content (only for leaf-ish elements). Tambien para div clicables o con rol:
    // las librerias de componentes (Naive UI, el HighRise de GHL) arman botones con div.
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "h1", "h2", "h3", "h4", "h5", "h6", "li", "summary", "label", "th", "td", "span"].includes(tag) ||
        el.getAttribute("role") || isInteractive(el)) {
      const text = el.textContent?.trim();
      if (text && text.length < 200) return text;
    }

    return "";
  }

  // --- Interactivity check ---
  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "input", "textarea", "select", "summary", "details"].includes(tag)) return true;
    if (el.getAttribute("role") && ["button", "link", "textbox", "checkbox", "radio", "tab", "menuitem", "switch", "combobox", "slider", "spinbutton", "searchbox", "option"].includes(el.getAttribute("role"))) return true;
    if (el.tabIndex >= 0) return true;
    if (el.onclick || el.getAttribute("onclick")) return true;
    if (el.contentEditable === "true") return true;
    return false;
  }

  // --- Visibility check ---
  function isVisible(el) {
    if (el.offsetParent === null && el.tagName.toLowerCase() !== "body" && getComputedStyle(el).position !== "fixed") return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  }

  const MAX_DOM_DEPTH = 300;

  // --- Accessibility tree generation ---
  function generateAccessibilityTree(options = {}) {
    const filter = options.filter || "all";
    const maxDepth = options.depth || 15;
    const maxChars = options.max_chars || 50000;
    const startRefId = options.ref_id || null;

    let output = "";
    let charCount = 0;
    let truncated = false;

    function append(text) {
      if (truncated) return false;
      if (charCount + text.length > maxChars) {
        output += text.substring(0, maxChars - charCount);
        output += "\n... (truncated)";
        truncated = true;
        return false;
      }
      output += text;
      charCount += text.length;
      return true;
    }

    // depth cuenta solo los niveles que se muestran; domDepth es un tope de seguridad. Antes
    // depth contaba cada div y en apps con mucho anidamiento (GHL, Vue) el arbol se cortaba
    // antes de llegar a los botones.
    function walk(el, depth, indent, domDepth = 0) {
      if (truncated) return;
      if (depth > maxDepth || domDepth > MAX_DOM_DEPTH) return;
      if (!el || el.nodeType !== 1) return;

      const tag = el.tagName.toLowerCase();
      // Skip invisible, script, style, svg internals
      if (["script", "style", "noscript", "template"].includes(tag)) return;

      const role = getRole(el);
      const name = getAccessibleName(el);
      const interactive = isInteractive(el);
      const visible = isVisible(el);

      // Filter: if interactive-only mode, skip non-interactive non-container elements
      const isContainer = el.children.length > 0;
      if (filter === "interactive" && !interactive && !isContainer) return;

      const shouldShow =
        (filter === "all" && (role || name)) ||
        (filter === "interactive" && interactive);

      if (shouldShow && visible) {
        const ref = getOrAssignRef(el);
        let line = `${indent}`;

        if (role) line += `${role}`;
        if (name) line += ` "${name.substring(0, 100)}"`;
        line += ` [${ref}]`;

        // Extra info for specific elements
        if (tag === "a" && el.href) line += ` href="${el.href}"`;
        if (tag === "img" && el.src) line += ` src="${el.src.substring(0, 100)}"`;
        if (["input", "textarea"].includes(tag) && el.value) line += ` value="${el.value.substring(0, 100)}"`;
        if (tag === "input") line += ` type="${el.type || "text"}"`;
        if (el.getAttribute("aria-expanded")) line += ` expanded=${el.getAttribute("aria-expanded")}`;
        if (el.getAttribute("aria-checked")) line += ` checked=${el.getAttribute("aria-checked")}`;
        if (el.getAttribute("aria-selected")) line += ` selected=${el.getAttribute("aria-selected")}`;
        if (el.disabled) line += " disabled";

        // Select options
        if (tag === "select") {
          const opts = Array.from(el.options).map(
            (o) => `${o.selected ? "*" : " "}${o.value}="${o.textContent.trim()}"`
          );
          if (opts.length) line += ` options=[${opts.join(", ")}]`;
        }

        if (!append(line + "\n")) return;
      }

      // Recurse children (including shadow DOM)
      const shown = shouldShow && visible;
      const nextIndent = shown ? indent + "  " : indent;
      const nextDepth = shown ? depth + 1 : depth;
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.children) {
          walk(child, nextDepth, nextIndent, domDepth + 1);
        }
      }
      for (const child of el.children) {
        walk(child, nextDepth, nextIndent, domDepth + 1);
      }
    }

    let root = document.body;
    if (startRefId) {
      const el = resolveRef(startRefId);
      if (el) root = el;
      else return `Error: ref_id "${startRefId}" not found or element was garbage collected.`;
    }

    walk(root, 0, "");
    return output;
  }

  // --- Page text extraction ---
  function getPageText() {
    const selectors = [
      "article",
      "main",
      '[class*="articleBody"]',
      '[class*="post-content"]',
      '[class*="entry-content"]',
      '[role="main"]',
      ".content",
      "#content",
    ];
    let source = null;
    for (const sel of selectors) {
      source = document.querySelector(sel);
      if (source) break;
    }
    if (!source) source = document.body;

    const title = document.title || "";
    const url = location.href;
    const tag = source.tagName.toLowerCase();

    // Clean text: remove script/style content, collapse whitespace
    const clone = source.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, template, svg").forEach((el) => el.remove());
    const text = clone.textContent.replace(/\s+/g, " ").trim();

    return JSON.stringify({ title, url, sourceTag: tag, text: text.substring(0, 100000) });
  }

  // --- Element finding ---
  // La consulta se parte en palabras y un elemento coincide si las tiene todas, en cualquier
  // orden, entre su rol, nombre, texto y atributos ("New calendar button" encuentra un boton
  // cuyo texto es "New calendar"). De cada coincidencia se queda la mas interna (los div que
  // envuelven media pagina tambien "contienen" el texto y llenaban los 20 lugares) y se sube a
  // su ancestro clicable mas cercano. Lo interactivo sale primero.
  const MAX_FIND_RESULTS = 20;
  const CLICKABLE_LOOKUP_LEVELS = 4;

  function findElements(query) {
    const tokens = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];

    // Collect all elements including those inside shadow roots
    function collectAll(root) {
      const elements = [];
      for (const el of root.querySelectorAll("*")) {
        elements.push(el);
        if (el.shadowRoot) {
          elements.push(...collectAll(el.shadowRoot));
        }
      }
      return elements;
    }

    // Incluye las clases ("n-button", "hr-checkbox") y marca como button lo clicable sin rol:
    // asi "boton X" encuentra los botones que las librerias arman con div.
    function searchableText(el) {
      const tag = el.tagName.toLowerCase();
      const role = getRole(el) || (isInteractive(el) ? "button" : "");
      const classes = typeof el.className === "string" ? el.className.replace(/[-_]/g, " ") : "";
      const parts = [
        role, getAccessibleName(el) || "", el.textContent?.trim()?.substring(0, 200) || "",
        el.placeholder || "", el.getAttribute("aria-label") || "", el.title || "", el.type || "", tag, classes,
      ];
      return parts.join(" ").toLowerCase();
    }

    const matches = [];
    for (const el of collectAll(document)) {
      const tag = el.tagName.toLowerCase();
      if (["script", "style", "noscript", "template", "html", "head"].includes(tag)) continue;
      const text = searchableText(el);
      if (tokens.every((t) => text.includes(t)) && isVisible(el)) matches.push(el);
    }

    // Solo las mas internas: se descarta todo elemento que tenga otra coincidencia adentro.
    const hasMatchInside = new Set();
    for (const el of matches) {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (hasMatchInside.has(p)) break;
        hasMatchInside.add(p);
      }
    }
    const innermost = matches.filter((el) => !hasMatchInside.has(el));

    function clickableAncestor(el) {
      let node = el;
      for (let i = 0; node && i <= CLICKABLE_LOOKUP_LEVELS; i++, node = node.parentElement) {
        if (isInteractive(node)) return node;
      }
      return el;
    }

    const seen = new Set();
    const picked = [];
    for (const el of innermost) {
      const target = clickableAncestor(el);
      if (seen.has(target)) continue;
      seen.add(target);
      picked.push(target);
    }
    picked.sort((a, b) => Number(isInteractive(b)) - Number(isInteractive(a)));

    return picked.slice(0, MAX_FIND_RESULTS).map((el) => {
      const rect = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      return {
        ref: getOrAssignRef(el),
        role: getRole(el) || tag,
        name: getAccessibleName(el) || el.textContent?.trim()?.substring(0, 80) || "",
        coordinates: [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)],
      };
    });
  }

  // --- Form input ---

  // Find the actual input/textarea/select inside an element, traversing shadow DOM
  function findInputInside(el) {
    const tag = el.tagName.toLowerCase();
    if (["input", "textarea", "select"].includes(tag)) return el;

    // Check shadow DOM first
    const root = el.shadowRoot || el;
    const inner = root.querySelector("input, textarea, select");
    if (inner) return inner;

    // Recurse into shadow roots of children
    for (const child of root.querySelectorAll("*")) {
      if (child.shadowRoot) {
        const deep = child.shadowRoot.querySelector("input, textarea, select");
        if (deep) return deep;
      }
    }
    return null;
  }

  function setFormValue(refId, value) {
    const el = resolveRef(refId);
    if (!el) return { error: `Element ${refId} not found or was garbage collected.` };

    el.scrollIntoView({ block: "center", behavior: "instant" });

    // Resolve the actual form element (may be inside shadow DOM)
    const target = findInputInside(el) || el;
    const tag = target.tagName.toLowerCase();
    const type = (target.type || "").toLowerCase();

    if (tag === "select") {
      const opt = Array.from(target.options).find(
        (o) => o.value === String(value) || o.textContent.trim() === String(value)
      );
      if (opt) {
        target.value = opt.value;
      } else {
        target.value = String(value);
      }
    } else if (type === "checkbox" || type === "radio") {
      const shouldCheck = typeof value === "boolean" ? value : value === "true";
      if (target.checked !== shouldCheck) target.click();
      return { success: true, checked: target.checked };
    } else if (target.contentEditable === "true") {
      target.textContent = String(value);
    } else if (["input", "textarea"].includes(tag)) {
      // Use the native setter for actual input/textarea elements
      const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(target, String(value));
      } else {
        target.value = String(value);
      }
    } else {
      // Fallback for unknown elements — try direct assignment
      try {
        target.value = String(value);
      } catch {
        return { error: `Cannot set value on <${tag}> element. No input found inside.` };
      }
    }

    // Dispatch events on the target (bubbles up through shadow DOM)
    target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    return { success: true, value: target.value };
  }

  // --- Get element coordinates for ref ---
  function getRefCoordinates(refId) {
    const el = resolveRef(refId);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
    };
  }

  // --- Message handler ---
  // Dentro de un iframe de otro dominio este archivo se inyecta por CDP en un mundo aislado,
  // donde no existe chrome.runtime; ahi solo se usa window.__unblockedChrome (ver frames.js).
  if (globalThis.chrome?.runtime?.onMessage) chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "generateAccessibilityTree") {
      const result = generateAccessibilityTree(msg.options || {});
      sendResponse({ result });
      return true;
    }

    if (msg.type === "getPageText") {
      const result = getPageText();
      sendResponse({ result });
      return true;
    }

    if (msg.type === "findElements") {
      const result = findElements(msg.query);
      sendResponse({ result });
      return true;
    }

    if (msg.type === "setFormValue") {
      const result = setFormValue(msg.ref, msg.value);
      sendResponse({ result });
      return true;
    }

    if (msg.type === "getRefCoordinates") {
      const result = getRefCoordinates(msg.ref);
      sendResponse({ result });
      return true;
    }

    return false;
  });

  // Expose globally for executeScript fallback
  window.__unblockedChrome = {
    generateAccessibilityTree,
    getPageText,
    findElements,
    setFormValue,
    getRefCoordinates,
    resolveRef,
    elementMap,
  };
})();
