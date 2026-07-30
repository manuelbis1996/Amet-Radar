// Le muestra a los bots de link-preview (WhatsApp, Twitter/X, Facebook,
// etc.) meta tags Open Graph específicos del reporte que se está
// compartiendo (?r=<id>) en vez de la tarjeta genérica de la app. Los
// bots no ejecutan JS, así que sin esto todo link compartido se ve igual
// sin importar qué reporte sea. Los usuarios reales pasan de largo
// (context.next()) y reciben la SPA normal, sin ningún cambio de
// comportamiento ni latencia extra perceptible.
import type { Config, Context } from "https://edge.netlify.com";

const SUPABASE_URL = "https://nikexwjxxcxzhsuypsjn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_p8U6gvvBwPVHdfmspjyCXA_g6clP58v";
const SITE_URL = "https://amet-radar.netlify.app";

const CATEGORY_LABELS: Record<string, string> = {
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

function isBot(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  return BOT_UA_PATTERNS.some((p) => ua.includes(p));
}

function timeAgo(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "justo ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

function renderPreviewHtml(title: string, description: string, pageUrl: string): string {
  const t = escapeHtml(title);
  const d = escapeHtml(description);
  const u = escapeHtml(pageUrl);
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${t}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${u}">
<meta property="og:image" content="${SITE_URL}/icon-512.png">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${SITE_URL}/icon-512.png">
<meta http-equiv="refresh" content="0; url=${u}">
</head>
<body></body>
</html>`;
}

export default async (request: Request, context: Context) => {
  const url = new URL(request.url);
  const reportId = url.searchParams.get("r");
  const userAgent = request.headers.get("user-agent") || "";

  if (!reportId || !isBot(userAgent)) {
    return context.next();
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/reports?id=eq.${encodeURIComponent(reportId)}&select=category,note,ts`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } },
    );
    if (!res.ok) return context.next();
    const rows = await res.json();
    const report = rows[0];
    // Reporte no existe (ya expiró/lo borró la comunidad) — dejar pasar a
    // la SPA normal, que va a mostrar los meta tags genéricos del <head>.
    if (!report) return context.next();

    const label = CATEGORY_LABELS[report.category] ?? "Reporte";
    const title = `${label} — AMET Radar`;
    const description = report.note
      ? `Reportado ${timeAgo(report.ts)}. "${report.note}"`
      : `Reportado ${timeAgo(report.ts)} en Santo Domingo.`;

    return new Response(renderPreviewHtml(title, description, request.url), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  } catch (err) {
    console.error("report-preview error", err);
    return context.next();
  }
};

export const config: Config = {
  path: ["/", "/amet-radar.html"],
};
