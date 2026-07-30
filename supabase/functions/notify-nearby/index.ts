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

const RADIUS_METERS = 2000;
const METERS_PER_DEG_LAT = 111320;

const CATEGORY_LABELS: Record<string, string> = {
  reten_fijo: "👮 Retén fijo",
  reten_movil: "🚓 Retén móvil",
  accidente: "⚠️ Accidente",
  control: "🚦 Control de tránsito",
};

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
    const dLat = RADIUS_METERS / METERS_PER_DEG_LAT;
    const metersPerDegLng = METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
    const dLng = RADIUS_METERS / metersPerDegLng;

    const { data: subs, error } = await supabase
      .from("push_subscriptions")
      .select("endpoint, p256dh, auth, lat, lng")
      .gte("lat", lat - dLat)
      .lte("lat", lat + dLat)
      .gte("lng", lng - dLng)
      .lte("lng", lng + dLng);

    if (error) throw error;

    const nearby = (subs ?? []).filter(
      (s) => haversineMeters(lat, lng, s.lat, s.lng) <= RADIUS_METERS,
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
      JSON.stringify({ notified: nearby.length - expired.length, expired: expired.length }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
