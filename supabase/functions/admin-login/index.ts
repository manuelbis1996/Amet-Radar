// Edge Function que valida el password del panel admin (admin.html). No
// protege ningún dato real: las políticas RLS de reports/app_config ya son
// abiertas (ver CLAUDE.md) — es solo el gate para que no cualquiera
// encuentre la pantalla de moderación, mismo espíritu que el resto del
// proyecto ("no hay autenticación de usuarios en la app").
//
// Requiere el secret ADMIN_PASSWORD configurado a mano en Project Settings
// -> Edge Functions -> Secrets (mismo mecanismo que las VAPID keys, ver
// notify-nearby/index.ts — ninguna herramienta MCP conectada permite
// setearlos). SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta
// Supabase solo.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

// admin.html corre en amet-radar.netlify.app y llama a este Edge Function
// en *.supabase.co — origen distinto, a diferencia de notify-nearby (que
// solo lo llama un trigger de Postgres, servidor a servidor, nunca un
// navegador). PostgREST agrega CORS solo automáticamente; los Edge
// Functions no, hay que manejar el preflight OPTIONS a mano.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Rate-limit persistido en public.admin_login_attempts (ver migración
// admin_login_attempts) en vez de un Map en memoria — antes se reseteaba
// en cada cold start de la función y no era un límite real. Usa la
// service_role key porque la tabla no tiene políticas para el cliente
// (ver la migración): solo este Edge Function la toca.
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

async function isLoginLocked(ip: string): Promise<boolean> {
  const { data } = await supabase
    .from("admin_login_attempts")
    .select("lock_until")
    .eq("ip", ip)
    .maybeSingle();
  if (!data?.lock_until) return false;
  return new Date(data.lock_until).getTime() > Date.now();
}

async function registerFailedLogin(ip: string): Promise<void> {
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

async function clearLoginAttempts(ip: string): Promise<void> {
  await supabase.from("admin_login_attempts").delete().eq("ip", ip);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  if (!ADMIN_PASSWORD) {
    console.error("Falta ADMIN_PASSWORD como secret de la función");
    return new Response(JSON.stringify({ error: "admin password not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const ip = clientIp(req);
  if (await isLoginLocked(ip)) {
    return new Response(JSON.stringify({ error: "Demasiados intentos. Intenta más tarde." }), {
      status: 429,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "body inválido" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  if (!timingSafeEqual(String(body.password ?? ""), ADMIN_PASSWORD)) {
    await registerFailedLogin(ip);
    return new Response(JSON.stringify({ error: "Password incorrecto" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  await clearLoginAttempts(ip);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
});
