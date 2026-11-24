// Capa visual que se dibuja ENCIMA de la pagina mientras automaton la opera: una flecha que viaja
// hasta donde va el clic, un aro cuando presiona, un borde que avisa que la pestana esta siendo
// controlada y un boton "Detener". Se inyecta con chrome.scripting en el frame principal (mundo
// aislado de la extension) y la maneja overlay.js desde el service worker.
//
// Todo vive dentro de un shadow root con pointer-events: none, asi que no intercepta clics ni
// cambia el layout. Solo el boton Detener recibe eventos.
(() => {
  if (window.__automatonOverlay) return;

  const Z_INDEX = 2147483646;
  const ACCENT = "37, 99, 235"; // Azul de la marca de la extension
  const MOVE_MIN_MS = 140;
  const MOVE_MAX_MS = 380;
  const RING_MS = 420;
  const ARC_RATIO = 0.1; // Curvatura de la trayectoria respecto a la distancia recorrida
  const ARC_MAX_PX = 30;

  let host = null;
  let root = null;
  let cursor = null;
  let frame = null;
  let pill = null;
  let position = null; // Ultima posicion de la punta de la flecha, en px del viewport
  let hideTimer = null;

  const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const smooth = (t) => t * t * t * (10 - 15 * t + 6 * t * t); // Arranca y frena suave
  const translate = (p) => `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;

  function build() {
    if (host?.isConnected) return;
    host = document.createElement("automaton-overlay");
    host.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${Z_INDEX};`;
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .frame { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity 200ms;
          box-shadow: inset 0 0 0 2px rgba(${ACCENT}, .85), inset 0 0 18px rgba(${ACCENT}, .35); }
        .frame.on { opacity: 1; }
        .pill { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); display: none;
          align-items: center; gap: 8px; padding: 5px 6px 5px 12px; border-radius: 999px;
          background: rgba(17, 24, 39, .92); color: #fff; font: 500 12px/1.2 system-ui, sans-serif;
          box-shadow: 0 2px 10px rgba(0, 0, 0, .25); pointer-events: auto; }
        .pill.on { display: flex; }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: rgb(${ACCENT}); }
        .pill button { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 999px;
          background: #dc2626; color: #fff; font: 600 12px/1 system-ui, sans-serif; }
        .pill button:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
        .cursor { position: fixed; top: 0; left: 0; width: 20px; height: 26px; display: none;
          pointer-events: none; will-change: transform; }
        .cursor.on { display: block; }
        .ring { position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
          border: 2px solid rgb(${ACCENT}); pointer-events: none; opacity: 0; }
      </style>
      <div class="frame"></div>
      <div class="pill" role="status"><span class="dot"></span><span>Automatón está usando esta pestaña</span><button type="button">Detener</button></div>
      <svg class="cursor" viewBox="0 0 20 26" aria-hidden="true">
        <path d="M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z" fill="#fff" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>
        <path d="M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z" fill="rgb(${ACCENT})"/>
      </svg>`;
    frame = root.querySelector(".frame");
    pill = root.querySelector(".pill");
    cursor = root.querySelector(".cursor");
    root.querySelector("button").addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "automaton_stop" }).catch(() => {});
      pill.querySelector("span:nth-child(2)").textContent = "Detenido";
    });
    document.documentElement.appendChild(host);
  }

  /// Puntos de una trayectoria con una curva leve, como la de una mano, de `from` a `to`.
  function path(from, to, steps) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.max(Math.hypot(dx, dy), 1e-6);
    const bend = (dx * 0.8 - dy * 0.6 > 0 ? -1 : 1) * Math.min(ARC_RATIO * dist, ARC_MAX_PX);
    return Array.from({ length: steps + 1 }, (_, i) => {
      const t = smooth(i / steps);
      const side = (bend * Math.sin(Math.PI * t)) / dist;
      return { x: from.x + dx * t - dy * side, y: from.y + dy * t + dx * side };
    });
  }

  /// Duracion del viaje: crece con el logaritmo de la distancia (ley de Fitts), con tope.
  function travelMs(from, to) {
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < 0.5) return 0;
    return Math.round(clamp(80 + 70 * Math.log2(dist / 24 + 1), MOVE_MIN_MS, MOVE_MAX_MS));
  }

  function ring(at) {
    const el = document.createElement("div");
    el.className = "ring";
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y}px`;
    root.appendChild(el);
    el.animate(
      [{ opacity: 0.9, transform: "scale(.35)" }, { opacity: 0, transform: "scale(1)" }],
      { duration: RING_MS, easing: "ease-out" },
    ).onfinish = () => el.remove();
  }

  /// Lleva la flecha a (x, y) y resuelve cuando llego. Con press dibuja el aro del clic.
  async function move(x, y, press) {
    build();
    showActivity();
    const to = { x, y };
    cursor.classList.add("on");
    const from = position || { x: to.x - 40, y: to.y + 60 };
    position = to;
    const ms = document.hidden || reducedMotion() ? 0 : travelMs(from, to);
    cursor.getAnimations().forEach((a) => a.cancel());
    cursor.style.transform = translate(to);
    if (ms > 0) {
      const keyframes = path(from, to, 16).map((p) => ({ transform: translate(p) }));
      await cursor.animate(keyframes, { duration: ms, easing: "linear" }).finished.catch(() => {});
    }
    if (press && !document.hidden) ring(to);
    return true;
  }

  function showActivity() {
    build();
    frame.classList.add("on");
    pill.classList.add("on");
    pill.querySelector("span:nth-child(2)").textContent = "Automatón está usando esta pestaña";
    clearTimeout(hideTimer);
  }

  /// Retira el borde y el boton tras `afterMs` sin actividad; la flecha se queda donde quedo.
  function idle(afterMs) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      frame?.classList.remove("on");
      pill?.classList.remove("on");
      cursor?.classList.remove("on");
    }, afterMs);
  }

  /// Oculta (o regresa) toda la capa mientras se toma una captura, para que no salga en ella.
  /// Espera un cuadro pintado antes de resolver; en una pestana de fondo requestAnimationFrame no
  /// corre, por eso tambien hay un tope de 50 ms.
  function setCapturing(on) {
    if (!host) return Promise.resolve(false);
    host.style.visibility = on ? "hidden" : "";
    return new Promise((resolve) => {
      const done = () => resolve(true);
      requestAnimationFrame(done);
      setTimeout(done, 50);
    });
  }

  function remove() {
    clearTimeout(hideTimer);
    host?.remove();
    host = root = cursor = frame = pill = position = null;
  }

  window.__automatonOverlay = { move, showActivity, idle, setCapturing, remove };
})();
