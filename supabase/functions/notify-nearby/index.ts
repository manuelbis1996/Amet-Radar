// Edge Function disparada por un Database Webhook en INSERT sobre
// public.reports (ver migración create_push_subscriptions_and_notify_trigger).
// Busca suscripciones push cercanas al reporte nuevo y les manda un aviso.
//
// Requiere estos secrets configurados en el proyecto (Project Settings ->
// Edge Functions -> Secrets), a mano — no se pueden setear por API/MCP:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase solo.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:manuelbis1996@gmail.com";

// El radio ya NO es una constante: sale de app_config.push_radius_meters, que
// se edita desde el panel admin (ver "Radio de las notificaciones push" en
// CLAUDE.md). Este número queda como red: si la lectura falla, se avisa con el
// valor de siempre en vez de no avisar a nadie — una notificación que no sale
// no se recupera después, y el push es lo que hace útil a la app cuando está
// cerrada.
const RADIUS_FALLBACK_METERS = 2000;
// Los mismos topes que el check de la columna. Van repetidos a propósito: si
// alguien edita la fila por fuera del endpoint (hoy solo se puede con la
// service_role key), un valor absurdo agrandaría el bounding box hasta barrer
// la tabla entera en cada reporte.
const RADIUS_MIN_METERS = 100;
const RADIUS_MAX_METERS = 50000;
const METERS_PER_DEG_LAT = 111320;

const CATEGORY_LABELS: Record<string, string> = {
  reten_fijo: "👮 Retén fijo",
  reten_movil: "🚓 Retén móvil",
  accidente: "⚠️ Accidente",
  control: "🚦 Control de tránsito",
};

// deno-lint-ignore no-explicit-any
async function radioConfigurado(supabase: any): Promise<number> {
  try {
    const { data, error } = await supabase
      .from("app_config")
      .select("push_radius_meters")
      .eq("id", true)
      .maybeSingle();
    if (error) throw error;
    const n = Number(data?.push_radius_meters);
    if (!Number.isFinite(n)) return RADIUS_FALLBACK_METERS;
    return Math.min(RADIUS_MAX_METERS, Math.max(RADIUS_MIN_METERS, Math.round(n)));
  } catch (err) {
    console.error("No se pudo leer push_radius_meters, uso el valor por defecto", err);
    return RADIUS_FALLBACK_METERS;
  }
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

Deno.serve(async (req) => {
  if (!VAPID_PRIVATE_KEY || !VAPID_PUBLIC_KEY) {
    console.error("Faltan VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY como secrets de la función");
    return new Response(JSON.stringify({ error: "vapid keys not configured" }), { status: 500 });
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const payload = await req.json();
    const record = payload?.record;
    if (!record || typeof record.lat !== "number" || typeof record.lng !== "number") {
      return new Response(JSON.stringify({ skipped: "no record" }), { status: 200 });
    }

    const { lat, lng, id, category } = record;
    const radius = await radioConfigurado(supabase);
    const dLat = radius / METERS_PER_DEG_LAT;
    const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
    const dLng = radius / metersPerDegLng;

    const { data: subs, error } = await supabase
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth, lat, lng, categories")
      .gte("lat", lat - dLat)
      .lte("lat", lat + dLat)
      .gte("lng", lng - dLng)
      .lte("lng", lng + dLng);

    if (error) throw error;

    // categories null/vacío = suscripción sin filtro, avisa de todo.
    const nearby = (subs ?? []).filter(
      (s) =>
        haversineMeters(lat, lng, s.lat, s.lng) <= radius &&
        (!s.categories || s.categories.length === 0 || s.categories.includes(category)),
    );

    const title = CATEGORY_LABELS[category] ?? "Reporte";
    const payloadStr = JSON.stringify({
      id,
      title,
      body: "Reportado cerca de tu ubicación en AMET Radar",
    });

    const results = await Promise.allSettled(
      nearby.map((s) =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payloadStr,
        )
      ),
    );

    const expired: string[] = [];
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        const statusCode = (r.reason as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          expired.push(nearby[i].endpoint);
        } else {
          console.error("push send error", r.reason);
        }
      }
    });

    if (expired.length > 0) {
      await supabase.from("push_subscriptions").delete().in("endpoint", expired);
    }

    return new Response(
      // `radius` va en la respuesta para poder confirmar desde afuera qué valor
      // usó de verdad: como se lee de app_config en cada disparo, es la única
      // forma de distinguir "tomó el nuevo" de "cayó al de por defecto".
      JSON.stringify({ notified: nearby.length - expired.length, expired: expired.length, radius }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
