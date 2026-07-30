// Edge Function que valida el password del panel admin (admin.html). No
// protege ningún dato real: las políticas RLS de reports/app_config ya son
// abiertas (ver CLAUDE.md) — es solo el gate para que no cualquiera
// encuentre la pantalla de moderación, mismo espíritu que el resto del
// proyecto ("no hay autenticación de usuarios en la app").
//
// Requiere el secret ADMIN_PASSWORD configurado a mano en Project Settings
// -> Edge Functions -> Secrets (mismo mecanismo que las VAPID keys, ver
// notify-nearby/index.ts — ninguna herramienta MCP conectada permite
// setearlos).

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

// Best-effort: en memoria por instancia de la función, no persiste entre
// cold starts ni se comparte entre instancias concurrentes. Suficiente
// para frenar fuerza bruta casual, no es una garantía dura.
const attempts = new Map<string, { count: number; firstAttemptAt: number; lockUntil: number }>();

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
  const now = Date.now();
  const entry = attempts.get(ip);
  if (entry?.lockUntil && entry.lockUntil > now) {
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
    if (!entry || now - entry.firstAttemptAt > WINDOW_MS) {
      attempts.set(ip, { count: 1, firstAttemptAt: now, lockUntil: 0 });
    } else {
      entry.count++;
      if (entry.count >= MAX_ATTEMPTS) entry.lockUntil = now + LOCK_MS;
    }
    return new Response(JSON.stringify({ error: "Password incorrecto" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  attempts.delete(ip);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
});
