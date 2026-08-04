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
// eso la función **solo borra fotos que ningún reporte esté usando**. Con esa
// invariante, el peor uso posible es apurar el borrado de algo que ya iba a
// desaparecer.
//
// "HUÉRFANA" SE AMPLIÓ, sin debilitar la invariante. Antes preguntaba solo si
// el reporte existía; ahora pregunta si existe **y sigue apuntando a una
// foto**. Los dos casos que quedan cubiertos:
//
//   * el reporte se borró          -> no hay fila            -> huérfana
//   * la moderación quitó la foto  -> hay fila con photo null -> huérfana
//   * el reporte tiene su foto     -> hay fila con photo      -> SE NIEGA
//
// El segundo caso es el que hizo falta al reabrir las fotos: cuando
// flag_photo() llega al umbral pone `photo = null`, pero eso solo la esconde
// de la app — el bucket es público y el objeto se sigue sirviendo por su URL
// a quien la tenga. Sin este borrado, "ocultar" no serviría de nada contra
// quien ya la vio.

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

  // La invariante que hace segura a esta función: solo fotos que ningún
  // reporte esté usando. El `not.is.null` es la parte que importa — sin él,
  // una foto que la moderación acaba de quitar de la fila nunca se borraría
  // de Storage y se seguiría sirviendo por su URL directa.
  const { data: enUso, error: errLookup } = await supabase
    .from("reports")
    .select("id")
    .eq("id", id)
    .not("photo", "is", null)
    .maybeSingle();

  if (errLookup) {
    console.error("Error consultando el reporte", errLookup);
    return json({ error: "no se pudo verificar el reporte" }, 500);
  }
  if (enUso) {
    // Alguien está pidiendo borrar la foto de un reporte que la está usando.
    // Se ignora.
    return json({ skipped: "el reporte todavía usa esa foto" }, 409);
  }

  const { error } = await supabase.storage.from(BUCKET).remove([`${id}.jpg`]);
  if (error) {
    console.error("Error borrando la foto", error);
    return json({ error: "no se pudo borrar la foto" }, 500);
  }

  return json({ ok: true }, 200);
});
