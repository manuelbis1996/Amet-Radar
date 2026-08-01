// Borra un reporte desde el panel de administración (admin.html).
//
// Existe porque la migración 20260801120000_lock_down_writes.sql le quitó a
// anon la política de DELETE sobre public.reports: antes el panel borraba
// con la publishable key, la misma que está pública dentro de
// amet-radar.html, así que ese borrado no era "de admin" — lo podía hacer
// cualquiera que mirara el código fuente. Ahora el borrado sin restricciones
// pasa por acá, detrás del mismo ADMIN_PASSWORD que ya valida admin-login, y
// se ejecuta con la service_role key (que nunca sale de la función).
//
// Requiere el secret ADMIN_PASSWORD, el mismo que usa admin-login (ver
// CLAUDE.md: se carga a mano en Project Settings -> Edge Functions ->
// Secrets). SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

// admin.html se sirve desde el hosting estático (Cloudflare Workers, ver
// CLAUDE.md) y esto vive en *.supabase.co: origen distinto. Los Edge
// Functions no agregan CORS solos, hay que responder el preflight a mano.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Mismo rate-limit persistido que admin-login (tabla admin_login_attempts),
// y a propósito la misma tabla: si no, este endpoint sería una vía libre
// para probar passwords sin gastar los intentos del login.
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

  let body: { password?: string; id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "body inválido" }, 400);
  }

  if (!timingSafeEqual(String(body.password ?? ""), ADMIN_PASSWORD)) {
    await registerFailure(ip);
    return json({ error: "Password incorrecto" }, 401);
  }

  const id = String(body.id ?? "");
  if (!id) return json({ error: "falta el id del reporte" }, 400);

  // Reusa la misma función de la base que usan delete_own_report y el
  // retiro comunitario, para que borrar la foto del bucket junto con la
  // fila viva en un solo lugar.
  const { error } = await supabase.rpc("_delete_report", { p_id: id });
  if (error) {
    console.error("Error borrando reporte", error);
    return json({ error: "No se pudo eliminar el reporte" }, 500);
  }

  return json({ ok: true }, 200);
});
