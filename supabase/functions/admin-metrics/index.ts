// Métricas del proyecto para el panel admin.
//
// POR QUÉ EXISTE. El panel le pega a Supabase con la anon key, igual que la
// app, y hay datos que esa clave NO puede ver — a propósito:
//   * `push_subscriptions` no tiene política de SELECT (v14.2), así que el
//     panel no puede saber cuánta gente tiene las notificaciones activadas.
//     Ese es el número de crecimiento del proyecto y era invisible.
//   * `daily_stats` y `report_events` tampoco tienen política.
//   * el listado de objetos de Storage necesita la service_role key.
//
// Todo eso se lee acá con la service_role key, detrás del mismo
// ADMIN_PASSWORD que admin-login / admin-delete-report / admin-update-config.
//
// SOLO LEE. No modifica nada. Es deliberado: mantener las lecturas separadas
// de las escrituras hace que este endpoint sea trivial de auditar, y si algún
// día se filtra el password el peor caso acá es que alguien vea unos números
// agregados, no que borre algo.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "";

const DIAS = 14;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
}

// El bloqueo SÍ se consulta, aunque acá no se registren fallos (ver abajo).
// Es la misma tabla y la misma fila por IP que usan los otros tres endpoints
// admin: si el login ya bloqueó a esa IP, este endpoint tiene que respetarlo.
async function isLocked(ip: string): Promise<boolean> {
  const { data } = await supabase
    .from("admin_login_attempts")
    .select("lock_until")
    .eq("ip", ip)
    .maybeSingle();
  if (!data?.lock_until) return false;
  return new Date(data.lock_until).getTime() > Date.now();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!ADMIN_PASSWORD) {
    console.error("Falta ADMIN_PASSWORD como secret de la función");
    return json({ error: "admin password not configured" }, 500);
  }

  // SIN ESTO, ESTE ENDPOINT ERA UN ORÁCULO DE PASSWORD SIN LÍMITE. Era el
  // único de los cuatro admin que no consultaba el bloqueo, así que se podía
  // probar el ADMIN_PASSWORD a mansalva contra acá — sin tope y sin dejar
  // rastro — y una vez encontrado usarlo en admin-delete-report, que sí
  // borra. El rate-limit de los otros tres no protege nada si el password se
  // descubre por otra puerta.
  const ip = clientIp(req);
  if (await isLocked(ip)) {
    return json({ error: "Demasiados intentos. Intenta más tarde." }, 429);
  }

  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "body inválido" }, 400);
  }
  if (!timingSafeEqual(String(body.password ?? ""), ADMIN_PASSWORD)) {
    // El fallo NO se registra, a diferencia de los otros tres, y eso sigue
    // siendo deliberado: este endpoint solo lee, y registrar acá gastaría
    // los intentos del login real desde la misma IP (que en RD suele ser
    // compartida por CGNAT). Lo que hacía falta era CONSULTAR el bloqueo,
    // no alimentarlo: así la fuerza bruta contra acá se corta igual, porque
    // para llegar a algo útil hay que pasar también por los que sí cuentan.
    return json({ error: "Password incorrecto" }, 401);
  }

  const desde = new Date(Date.now() - (DIAS - 1) * 86400000)
    .toISOString().slice(0, 10);

  // Todo en paralelo: son cuatro consultas independientes y el panel espera
  // por la más lenta, no por la suma.
  const [subs, dias, fotos, ultimo] = await Promise.all([
    supabase.from("push_subscriptions").select("*", { count: "exact", head: true }),
    supabase.from("daily_stats").select("day, reports").gte("day", desde).order("day"),
    supabase.storage.from("report-photos").list("", { limit: 1000 }),
    supabase.from("reports").select("ts").order("ts", { ascending: false }).limit(1),
  ]);

  if (subs.error) console.error("suscriptores", subs.error);
  if (dias.error) console.error("daily_stats", dias.error);

  // Se rellenan los días sin actividad con 0. Sin esto el gráfico miente:
  // un día sin reportes simplemente no tiene fila, y al dibujarlo quedaría
  // pegado al anterior como si no hubiera pasado el tiempo.
  const porDia: { dia: string; reportes: number }[] = [];
  const mapa = new Map((dias.data ?? []).map((d) => [d.day as string, d.reports as number]));
  for (let i = DIAS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    porDia.push({ dia: d, reportes: mapa.get(d) ?? 0 });
  }

  return json({
    ok: true,
    suscriptores: subs.count ?? 0,
    por_dia: porDia,
    fotos: (fotos.data ?? []).length,
    ultimo_reporte: ultimo.data?.[0]?.ts ?? null,
  }, 200);
});
