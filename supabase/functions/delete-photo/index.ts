// Borra de Supabase Storage la foto de un reporte que ya no existe.
//
// POR QUÉ EXISTE. La primera versión de _delete_report() hacía
// `delete from storage.objects` directo por SQL, y eso **no funciona**:
// Supabase tiene un trigger `storage.protect_delete()` que corta cualquier
// borrado por SQL sobre esa tabla con "Direct deletion from storage tables
// is not allowed. Use the Storage API instead.". Como el error se propaga,
// se llevaba puesta la transacción entera — o sea que no se borraba ni la
// fila del reporte. Rompía los cuatro caminos de borrado a la vez.
//
// La única vía correcta es la Storage API, que vive fuera de Postgres. Por
// eso la base ahora solo borra la fila y un trigger AFTER DELETE le avisa
// a esta función (mismo patrón pg_net -> Edge Function que ya usa
// notify-nearby). Es best-effort y asíncrono a propósito: si falla, queda
// una foto huérfana, que es mucho mejor que un reporte que no se puede
// borrar.
//
// SEGURIDAD. El trigger la llama con la anon key, que es pública, así que
// hay que asumir que cualquiera puede invocarla con el id que quiera. Por
// eso la función **se niega a borrar la foto de un reporte que todavía
// existe**: solo limpia huérfanas. Con esa invariante, el peor uso posible
// es apurar el borrado de algo que ya iba a desaparecer.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "report-photos";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "body inválido" }, 400);
  }

  const id = String(body.id ?? "");
  // Sin barras ni "..": el id va directo al path del objeto.
  if (!id || id.includes("/") || id.includes("..")) {
    return json({ error: "id inválido" }, 400);
  }

  // La invariante que hace segura a esta función: solo huérfanas.
  const { data: sigueVivo, error: errLookup } = await supabase
    .from("reports")
    .select("id")
    .eq("id", id)
    .maybeSingle();

  if (errLookup) {
    console.error("Error consultando el reporte", errLookup);
    return json({ error: "no se pudo verificar el reporte" }, 500);
  }
  if (sigueVivo) {
    // No es un huérfano: alguien está pidiendo borrar la foto de un reporte
    // que sigue publicado. Se ignora.
    return json({ skipped: "el reporte todavía existe" }, 409);
  }

  const { error } = await supabase.storage.from(BUCKET).remove([`${id}.jpg`]);
  if (error) {
    console.error("Error borrando la foto", error);
    return json({ error: "no se pudo borrar la foto" }, 500);
  }

  return json({ ok: true }, 200);
});
