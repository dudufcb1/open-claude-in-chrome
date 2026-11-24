// Recarga de la extension por orden del puente, sin pasar por chrome://extensions.
// chrome.runtime.reload() vuelve a leer los archivos de la carpeta desempaquetada y
// reinicia el service worker, que al arrancar se reconecta solo al host nativo.

const RELOAD_DELAY_MS = 300;

toolHandlers.reload_extension = async function () {
  const { version } = chrome.runtime.getManifest();
  // Se difiere para que la respuesta alcance a salir por el puerto nativo antes de que
  // el service worker muera con la recarga.
  setTimeout(() => chrome.runtime.reload(), RELOAD_DELAY_MS);
  return {
    content: [{
      type: "text",
      text: `Recargando la extensión (versión cargada: ${version}). Se reconecta sola en unos segundos; las pestañas de los grupos "Chrome" se re-adoptan solas.`,
    }],
  };
};
