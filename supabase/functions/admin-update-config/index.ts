// Edita los parámetros del sistema (public.app_config) desde el panel admin.
//
// POR QUÉ EXISTE. app_config tenía una política RLS `anon update config` con
// USING(true), y la anon key es pública dentro de amet-radar.html. Eso dejaba
// sin efecto todo el cierre de escritura de v12.0, porque
// purge_expired_reports() —expuesta a anon justamente porque "solo puede
// borrar lo que ya venció"— lee max_age_minutes de esta tabla. O sea que
// cualquiera podía mover la definición de "vencido" y después pedir la purga:
//
//   PATCH /rest/v1/app_config?id=eq.true   {"max_age_minutes": 0}
//   POST  /rest/v1/rpc/purge_expired_reports
//
// y vaciar la base entera con dos peticiones. Verificado contra la base real
// con reportes de un minuto de antigüedad. Lo mismo con deny_threshold en 1:
// un solo voto en contra retira cualquier reporte.
//
// El `select` de app_config sigue abierto a propósito: amet-radar.html lo lee
// al arrancar (loadConfig()) y ahí no hay nada sensible.
//
// Requiere el secret ADMIN_PASSWORD, el mismo de admin-login y
// admin-delete-report.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Rangos permitidos. No es desconfianza del admin: es que estos números
// mandan sobre borrados masivos (max_age_minutes lo usa
// purge_expired_reports) y un cero de más en el formulario vaciaría la base
// sin vuelta atrás. El mínimo de max_age_minutes existe exactamente por eso.
const LIMITES: Record<string, { min: number; max: number }> = {
  stale_minutes:     { min: 1, max: 10080 },  // hasta 7 días
  max_age_minutes:   { min: 15, max: 10080 }, // nunca menos de 15 min
  deny_threshold:    { min: 2, max: 100 },    // 1 dejaría que un solo voto retire cualquier reporte
  report_limit:      { min: 1, max: 100 },
  report_window_min: { min: 1, max: 1440 },
};

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Mismo rate-limit persistido que admin-login, y a propósito la misma tabla:
// si no, este endpoint sería una vía libre para probar passwords sin gastar
// los intentos del login.
async function isLocked(ip: string): Promise<boolean> {
  const { data } = await supabase
    .from("admin_login_attempts")
    .select("lock_until")
    .eq("ip", ip)
    .maybeSingle();
  if (!data?.lock_until) return false;
  return new Date(data.lock_until).getTime() > Date.now();
}

async function registerFailure(ip: string): Promise<void> {
  const now = Date.now();
  const { data } = await supabase
    .from("admin_login_attempts")
    .select("count, first_attempt_at")
    .eq("ip", ip)
    .maybeSingle();

  if (!data || now - new Date(data.first_attempt_at).getTime() > WINDOW_MS) {
    await supabase.from("admin_login_attempts").upsert({
      ip,
      count: 1,
      first_attempt_at: new Date(now).toISOString(),
      lock_until: null,
    });
    return;
  }

  const count = data.count + 1;
  const lockUntil = count >= MAX_ATTEMPTS ? new Date(now + LOCK_MS).toISOString() : null;
  await supabase.from("admin_login_attempts").update({ count, lock_until: lockUntil }).eq("ip", ip);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
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

  const ip = clientIp(req);
  if (await isLocked(ip)) {
    return json({ error: "Demasiados intentos. Intenta más tarde." }, 429);
  }

  let body: { password?: string; config?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json({ error: "body inválido" }, 400);
  }

  if (!timingSafeEqual(String(body.password ?? ""), ADMIN_PASSWORD)) {
    await registerFailure(ip);
    return json({ error: "Password incorrecto" }, 401);
  }

  const entrada = body.config ?? {};
  const limpio: Record<string, number> = {};

  for (const [campo, { min, max }] of Object.entries(LIMITES)) {
    const bruto = entrada[campo];
    if (bruto === undefined || bruto === null) {
      return json({ error: `falta el parámetro ${campo}` }, 400);
    }
    const n = Number(bruto);
    if (!Number.isInteger(n)) {
      return json({ error: `${campo} tiene que ser un número entero` }, 400);
    }
    if (n < min || n > max) {
      return json({ error: `${campo} tiene que estar entre ${min} y ${max}` }, 400);
    }
    limpio[campo] = n;
  }

  // Un reporte no puede marcarse "viejo" después de haber expirado.
  if (limpio.stale_minutes > limpio.max_age_minutes) {
    return json({ error: 'Los minutos para "viejo" no pueden superar los de expirar' }, 400);
  }

  const { error } = await supabase
    .from("app_config")
    .update({ ...limpio, updated_at: new Date().toISOString() })
    .eq("id", true);

  if (error) {
    console.error("Error guardando la config", error);
    return json({ error: "No se pudo guardar la configuración" }, 500);
  }

  return json({ ok: true, config: limpio }, 200);
});
