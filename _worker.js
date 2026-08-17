// Cloudflare Worker con Static Assets — sirve el sitio estático completo
// (amet-radar.html, admin.html, manifest.json, sw.js, iconos, vía el
// binding ASSETS declarado en wrangler.jsonc) y, antes de eso, intercepta
// "/" y "/amet-radar.html" para dos cosas propias:
//   1) reescribir "/" -> "/amet-radar.html" (Cloudflare no aplica _redirects
//      automáticamente cuando hay un Worker con "main" propio, así que se
//      hace acá a mano en vez de depender del archivo _redirects, que solo
//      lo sigue leyendo Netlify mientras dure la migración — ver CLAUDE.md)
//   2) mostrarle a los bots de link-preview (WhatsApp, Twitter/X, Facebook,
//      etc.) meta tags Open Graph específicos del reporte compartido
//      (?r=<id>) en vez de la tarjeta genérica de la app — mismo
//      comportamiento que antes tenía netlify/edge-functions/report-preview.ts.
// Los usuarios reales pasan de largo (ASSETS.fetch) sin cambio de
// comportamiento ni latencia extra perceptible.

const SUPABASE_URL = "https://nikexwjxxcxzhsuypsjn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_p8U6gvvBwPVHdfmspjyCXA_g6clP58v";

// Geocodificación inversa para poner LA DIRECCIÓN en la tarjeta compartida.
// Nominatim es gratis y sin key, pero su política de uso pide un User-Agent
// identificable y castiga el abuso. Por eso: solo se llama en el camino de
// BOTS (que ya es poco frecuente — un puñado de veces por link compartido) y
// la respuesta se cachea 24 h en el borde. Si falla o bloquea, se devuelve
// null y la tarjeta queda como estaba: NUNCA rompe el preview.
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const NOMINATIM_UA = "AMET-Radar/1.0 (+https://amet-radar.lavega.workers.dev)";

const CATEGORY_LABELS = {
  reten_fijo: "👮 Retén fijo",
  reten_movil: "🚓 Retén móvil",
  accidente: "⚠️ Accidente",
  control: "🚦 Control de tránsito",
};

// Cualquier User-Agent que contenga uno de estos strings se trata como bot
// de preview. Lista no exhaustiva a propósito — cubre los canales
// relevantes para esta app (WhatsApp es el principal en RD); agregar más
// según haga falta.
const BOT_UA_PATTERNS = [
  "whatsapp", "facebookexternalhit", "twitterbot", "linkedinbot",
  "slackbot", "telegrambot", "discordbot", "pinterest", "redditbot",
];

function isBot(userAgent) {
  const ua = userAgent.toLowerCase();
  return BOT_UA_PATTERNS.some((p) => ua.includes(p));
}

function timeAgo(ts) {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "justo ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

async function direccionDe(lat, lng) {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  try {
    const u = `${NOMINATIM_URL}?format=jsonv2&zoom=17&accept-language=es` +
      `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`;
    const res = await fetch(u, {
      headers: { "User-Agent": NOMINATIM_UA, Accept: "application/json" },
      // Opción propia de Cloudflare: cachea la subpetición en el borde. Fuera
      // de Workers se ignora sin romper nada.
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
    if (!res.ok) return null;
    const d = await res.json();
    const a = d.address || {};
    const via = a.road || a.pedestrian || a.footway || null;
    const zona = a.suburb || a.neighbourhood || a.quarter || null;
    const ciudad = a.city || a.town || a.village || a.municipality || null;
    if (!via && !zona && !ciudad) return null;
    return { via, zona: zona && zona !== via ? zona : null, ciudad };
  } catch (err) {
    return null;
  }
}

function escapeHtml(s) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

function renderPreviewHtml(title, description, pageUrl, imagen, grande) {
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const u = escapeHtml(pageUrl);
  const img = escapeHtml(imagen);
  // Las medidas solo se declaran para las tarjetas generadas, que sabemos que
  // son 1200x630. Con la foto de un reporte serían mentira (compressImage la
  // deja en 480px de ancho) y algunos scrapers la descartarían por eso.
  const medidas = grande
    ? '<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n'
    : "";
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${t}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${u}">
<meta property="og:site_name" content="AMET Radar">
<meta property="og:image" content="${img}">
${medidas}<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${img}">
<meta http-equiv="refresh" content="0; url=${u}">
</head>
<body></body>
</html>`;
}

async function maybeReportPreview(request, url) {
  const reportId = url.searchParams.get("r");
  const userAgent = request.headers.get("user-agent") || "";
  if (!reportId || !isBot(userAgent)) return null;

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/reports?id=eq.${encodeURIComponent(reportId)}&select=category,note,ts,lat,lng,photo`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    const report = rows[0];
    // Reporte no existe (ya expiró/lo borró la comunidad) — null, dejar
    // pasar a la SPA normal, que muestra los meta tags genéricos del <head>.
    if (!report) return null;

    const label = CATEGORY_LABELS[report.category] ?? "Reporte";

    // DÓNDE fue marcado, que es lo que hace útil compartir el link: sin esto
    // la tarjeta decía solo la categoría y quien la recibe no sabe si le
    // queda de camino. Si la geocodificación falla se cae al texto de antes.
    const dir = await direccionDe(report.lat, report.lng);
    const lugar = dir && [dir.zona, dir.ciudad].filter(Boolean).join(", ");
    const title = dir && dir.via ? `${label} en ${dir.via}` : `${label} — AMET Radar`;

    const cuando = `Reportado ${timeAgo(report.ts)}`;
    const description = report.note
      ? `${cuando}. "${report.note}"`
      : lugar
        ? `${cuando} · ${lugar}`
        : `${cuando} en La Vega.`;

    // LA IMAGEN DE FONDO. Prioridad: la foto real del reporte si la tiene
    // (es lo que mejor comunica), y si no una tarjeta 1200x630 por categoría.
    // Ojo con las filas viejas: antes de la migración a Storage la foto se
    // guardaba como data: URL embebida, y eso no sirve como og:image.
    const tieneFoto = typeof report.photo === "string" &&
      report.photo.startsWith("http");
    const imagen = tieneFoto
      ? report.photo
      : `${url.origin}/og-${CATEGORY_LABELS[report.category] ? report.category : "reten_fijo"}.png`;

    return new Response(renderPreviewHtml(title, description, request.url, imagen, !tieneFoto), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (err) {
    console.error("report-preview error", err);
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/amet-radar.html") {
      const preview = await maybeReportPreview(request, url);
      if (preview) return preview;
      if (url.pathname === "/") {
        return env.ASSETS.fetch(new Request(new URL("/amet-radar.html", request.url), request));
      }
    }

    return env.ASSETS.fetch(request);
  },
};
