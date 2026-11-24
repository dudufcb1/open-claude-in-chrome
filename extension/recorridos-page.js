// Parte del reproductor de recorridos que vive en cada frame: dibuja el cursor que se mueve hasta el
// elemento, lo resalta y ejecuta la accion (clic, pasar encima, escribir). El elemento ya lo encontro
// tutor-page.js con locate(); aqui se toma con window.__tutor.candidate(index).
//
// Igual que el tutor: nada de <style> (las paginas con CSP estricta lo bloquean), todo por el CSSOM y
// element.animate(), y la capa vive en un shadow root cerrado dentro de la top layer.

(() => {
  if (window.__recorridos) return;

  const RING_COLOR = "#ff4d00";
  const RING_PADDING = 4;
  const CURSOR_SIZE = 30;
  const MOVE_MIN_MS = 450;
  const MOVE_MAX_MS = 1100;
  const SETTLE_MS = 450;

  let host = null;
  let layer = null;
  let cursor = null;
  let ring = null;
  let ringTarget = null;
  let ringFrame = 0;
  let cursorPos = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  function ensureLayer() {
    if (!host) {
      host = document.createElement("div");
      host.setAttribute("popover", "manual");
      host.style.cssText = "all:initial;position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;"
        + "border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;display:block;";
      layer = host.attachShadow({ mode: "closed" });
    }
    if (!host.isConnected) document.documentElement.appendChild(host);
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch {
      // Sin popover queda con z-index maximo, que casi siempre basta.
    }
  }

  /// Flecha de puntero normal (negra con borde blanco) para que en la llamada se vea como un mouse.
  function ensureCursor() {
    ensureLayer();
    if (cursor?.isConnected) return cursor;
    cursor = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    cursor.setAttribute("viewBox", "0 0 24 24");
    cursor.setAttribute("width", String(CURSOR_SIZE));
    cursor.setAttribute("height", String(CURSOR_SIZE));
    cursor.style.cssText = "position:fixed;left:0;top:0;pointer-events:none;overflow:visible;"
      + "filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));will-change:transform;";
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M4 2 L4 19 L8.6 14.9 L11.6 21.6 L14.6 20.3 L11.7 13.7 L18 13.4 Z");
    path.setAttribute("fill", "#111");
    path.setAttribute("stroke", "#fff");
    path.setAttribute("stroke-width", "1.6");
    path.setAttribute("stroke-linejoin", "round");
    cursor.appendChild(path);
    layer.appendChild(cursor);
    if (!cursorPos) cursorPos = { x: innerWidth * 0.5, y: innerHeight * 0.62 };
    placeCursor(cursorPos);
    return cursor;
  }

  function placeCursor(pos) {
    // La punta de la flecha esta en (4,2) del viewBox de 24: se corre para que el punto exacto sea la punta
    const scale = CURSOR_SIZE / 24;
    cursor.style.transform = `translate(${pos.x - 4 * scale}px, ${pos.y - 2 * scale}px)`;
  }

  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

  const rand = (min, max) => min + Math.random() * (max - min);
  const easeOutHuman = (t) => 1 - (1 - t) ** 2.6; // Arranca rapido y frena largo, como una mano

  /// Recorre una curva cuadratica de from a to en duration ms, con un temblor opcional de pocos pixeles.
  function animatePath(from, to, duration, bend, ease, tremor) {
    const distance = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const control = {
      x: (from.x + to.x) / 2 - ((to.y - from.y) / distance) * bend,
      y: (from.y + to.y) / 2 + ((to.x - from.x) / distance) * bend,
    };
    const phase = Math.random() * Math.PI * 2;
    const start = performance.now();
    return new Promise((resolve) => {
      const frame = (now) => {
        const linear = Math.min(1, (now - start) / duration);
        const t = ease(linear);
        const u = 1 - t;
        const wobble = tremor * Math.sin(phase + linear * 9) * (1 - linear);
        cursorPos = {
          x: u * u * from.x + 2 * u * t * control.x + t * t * to.x + wobble,
          y: u * u * from.y + 2 * u * t * control.y + t * t * to.y - wobble * 0.6,
        };
        placeCursor(cursorPos);
        if (linear < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  /// Mueve el cursor hasta el punto. human=true imita una mano: tarda segun la distancia (ley de Fitts) con
  /// variacion, la curva cambia de lado, frena largo, se pasa unos pixeles y corrige.
  async function moveCursor(to, human) {
    ensureCursor();
    const from = cursorPos;
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (reducedMotion() || distance < 2) {
      cursorPos = to;
      placeCursor(to);
      return;
    }
    if (!human) {
      const duration = Math.min(MOVE_MAX_MS, Math.max(MOVE_MIN_MS, distance * 1.1));
      await animatePath(from, to, duration, Math.min(80, distance * 0.18), easeInOut, 0);
      return;
    }
    const duration = (380 + 150 * Math.log2(1 + distance / 18)) * rand(0.85, 1.25);
    const bend = Math.min(110, distance * rand(0.06, 0.22)) * (Math.random() < 0.5 ? -1 : 1);
    const overshoot = distance > 120 ? rand(3, 9) : 0;
    const past = { x: to.x + ((to.x - from.x) / distance) * overshoot, y: to.y + ((to.y - from.y) / distance) * overshoot };
    await animatePath(from, past, duration, bend, easeOutHuman, distance > 200 ? 1.2 : 0.5);
    if (overshoot) await animatePath(past, to, rand(110, 190), 0, easeInOut, 0);
  }

  function placeRing() {
    ringFrame = 0;
    if (!ring || !ringTarget) return;
    if (!ringTarget.isConnected) {
      ring.style.display = "none";
      return;
    }
    const rect = ringTarget.getBoundingClientRect();
    ring.style.display = "block";
    ring.style.left = `${rect.left - RING_PADDING}px`;
    ring.style.top = `${rect.top - RING_PADDING}px`;
    ring.style.width = `${rect.width + RING_PADDING * 2}px`;
    ring.style.height = `${rect.height + RING_PADDING * 2}px`;
    ringFrame = requestAnimationFrame(placeRing);
  }

  /// Recuadro que sigue al elemento aunque la pagina haga scroll o se redibuje.
  function showRing(el) {
    ensureLayer();
    if (!ring) {
      ring = document.createElement("div");
      ring.style.cssText = "all:initial;position:fixed;box-sizing:border-box;pointer-events:none;border-radius:8px;"
        + `border:3px solid ${RING_COLOR};box-shadow:0 0 0 1px #fff,inset 0 0 0 1px #fff,0 0 0 6px rgba(255,77,0,.18);`;
    }
    if (!ring.isConnected) layer.insertBefore(ring, layer.firstChild);
    ringTarget = el;
    if (!ringFrame) placeRing();
    if (!reducedMotion()) {
      ring.animate([{ transform: "scale(1.18)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }],
        { duration: 260, easing: "ease-out" });
    }
  }

  function hideRing() {
    ringTarget = null;
    if (ring) ring.style.display = "none";
  }

  /// Onda que se expande donde se da el clic, para que la audiencia note que hubo clic.
  function clickRipple(pos) {
    if (reducedMotion()) return;
    const dot = document.createElement("div");
    dot.style.cssText = `all:initial;position:fixed;left:${pos.x - 18}px;top:${pos.y - 18}px;width:36px;height:36px;`
      + `border-radius:50%;background:rgba(255,77,0,.35);border:2px solid ${RING_COLOR};pointer-events:none;`;
    layer.appendChild(dot);
    dot.animate([{ transform: "scale(.3)", opacity: 1 }, { transform: "scale(1.4)", opacity: 0 }],
      { duration: 520, easing: "ease-out" }).finished.then(() => dot.remove(), () => dot.remove());
  }

  /// Donde cae el clic: el centro, o en modo humano un punto un poco al azar dentro del elemento.
  function targetPoint(el, human) {
    const rect = el.getBoundingClientRect();
    if (!human) return { x: rect.left + Math.min(rect.width / 2, 60), y: rect.top + rect.height / 2 };
    const x = rect.left + Math.min(rect.width * rand(0.3, 0.6), rand(30, 70));
    const y = rect.top + rect.height * rand(0.38, 0.62);
    return { x, y };
  }

  function mouseInit(pos) {
    return { bubbles: true, cancelable: true, composed: true, view: window, clientX: pos.x, clientY: pos.y, button: 0 };
  }

  /// Secuencia de eventos de un clic real; las apps con menus de Vue/React a veces escuchan mousedown y no click.
  function dispatchClick(el, pos) {
    const init = mouseInit(pos);
    el.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 }));
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", init));
    el.click(); // Dispara el evento click que tambien activa enlaces y botones de formulario
  }

  function dispatchHover(el, pos) {
    const init = mouseInit(pos);
    for (const type of ["pointerover", "pointerenter", "pointermove"]) {
      el.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true,
        bubbles: type !== "pointerenter" }));
    }
    for (const type of ["mouseover", "mouseenter", "mousemove"]) {
      el.dispatchEvent(new MouseEvent(type, { ...init, bubbles: type !== "mouseenter" }));
    }
  }

  /// Pone el valor con el setter nativo y avisa con input, para que React y Vue se enteren del cambio.
  function setFieldValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  }

  /// Escribe en un campo. human=true teclea letra por letra con pausas irregulares, como una persona.
  async function typeInto(el, value, human) {
    el.focus({ preventScroll: true });
    if (el.isContentEditable) {
      document.execCommand("selectAll", false);
      if (!human) {
        document.execCommand("insertText", false, value);
        return;
      }
      document.execCommand("delete", false);
      for (const char of value) {
        document.execCommand("insertText", false, char);
        await sleep(rand(45, 150) + (char === " " ? rand(30, 120) : 0));
      }
      return;
    }
    if (!human) {
      setFieldValue(el, value);
    } else {
      let typed = "";
      for (const char of value) {
        typed += char;
        setFieldValue(el, typed);
        await sleep(rand(45, 150) + (char === " " ? rand(30, 120) : 0));
      }
    }
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  /// Ejecuta un paso sobre el candidato `index` de este frame. animate=false en pruebas de fondo.
  async function perform({ index, action, value, animate, human = false, highlight = true }) {
    const el = window.__tutor?.candidate(index);
    if (!el) return { ok: false, error: "el elemento desaparecio antes de usarlo" };
    const rect = el.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > innerHeight || rect.left < 0 || rect.right > innerWidth) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: animate && !reducedMotion() ? "smooth" : "instant" });
      if (animate) await sleep(human ? rand(500, 800) : 450);
    }
    const pos = targetPoint(el, human && animate);
    if (animate) {
      await moveCursor(pos, human);
      if (highlight) showRing(el);
      await sleep(human ? rand(160, 420) : SETTLE_MS);
    }
    if (action === "click") {
      if (animate && highlight) clickRipple(pos);
      dispatchClick(el, pos);
    } else if (action === "hover") {
      dispatchHover(el, pos);
    } else if (action === "type") {
      await typeInto(el, value ?? "", human && animate);
    }
    // point y wait no hacen nada mas: el recuadro ya esta puesto (o en pruebas basta con haberlo encontrado)
    if (animate && highlight && action !== "point") setTimeout(() => ringTarget === el && hideRing(), 900);
    return { ok: true };
  }

  /// Quita todo lo dibujado. keepCursor deja la flecha donde quedo (entre pasos de la misma corrida).
  function clear(keepCursor = false) {
    hideRing();
    if (!keepCursor) {
      cursor?.remove();
      cursor = null;
    }
  }

  function hideCursor() {
    cursor?.remove();
    cursor = null;
  }

  window.__recorridos = { perform, clear, hideCursor };
})();
