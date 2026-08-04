// Adjunta una foto a un reporte que YA existe, comprobando que quien la manda
// sea su autor.
//
// POR QUÉ EXISTE, y por qué el cliente no sube directo a Storage. Hasta la
// v14.1 el cliente subía la foto al bucket con la anon key, que es pública: o
// sea que cualquiera podía subir archivos arbitrarios al dominio del proyecto
// sin haber publicado nada. Ese fue el agujero que se cerró quitándole al
// bucket todas sus políticas.
//
// Al reabrir las fotos (opcionales, adjuntas DESPUÉS de publicar) no hacía
// falta volver a abrirlo: la subida pasa por acá, esta función valida la
// propiedad contra `owner_hash` y escribe con la service_role key. El bucket
// se queda **sin ninguna política**, igual que cuando estaba todo cerrado.
//
// LA PRUEBA DE PROPIEDAD es el token que el cliente guarda en localStorage al
// publicar (`amet_report_tokens_v1`); la base solo conoce su SHA-256. Mismo
// esquema que `delete_own_report`: sin cuentas de usuario, pero verificable
// del lado del servidor.
//
// ORDEN DE LAS OPERACIONES, que importa. Primero se RESERVA el lugar en la
// fila (`_attach_photo` valida la propiedad y escribe la URL en el mismo
// UPDATE) y recién después se sube el archivo. Parece al revés, y es a
// propósito:
//
//   * el chequeo y la escritura son un solo UPDATE con `photo is null` en el
//     WHERE, o sea atómico: dos intentos simultáneos no pueden pisarse ni
//     dejar dos objetos en Storage;
//   * si la subida falla, se revierte la fila a `photo = null`, y eso dispara
//     el trigger `reports_photo_cleared`, que le pide a `delete-photo` que
//     limpie cualquier resto que haya quedado. O sea que el camino de error se
//     limpia solo.
//
// Hacerlo al revés (subir y después escribir) dejaría, ante un fallo del
// último paso, un objeto huérfano que nada limpia — el trigger solo mira
// cambios en la fila.
//
// No necesita ningún secret propio: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY
// los inyecta Supabase solo.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "report-photos";

// El mismo tope que tiene el bucket. Se comprueba también acá para poder
// devolver un mensaje entendible en vez del error crudo de Storage, y para
// cortar antes de gastar el ancho de banda de la subida.
const MAX_BYTES = 512 * 1024;

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

// El cliente manda la foto como data: URL, que es lo que ya produce
// compressImage() en amet-radar.html (480px de ancho, JPEG q0.6).
function jpegDesdeDataUrl(dataUrl: string): Uint8Array | null {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { id?: string; token?: string; photo?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "body inválido" }, 400);
  }

  const id = String(body.id ?? "");
  const token = String(body.token ?? "");
  const photo = String(body.photo ?? "");

  // El id va directo al path del objeto, así que tiene que ser exactamente el
  // formato que genera la app — nada de barras ni "..".
  if (!/^report_[0-9]+_[a-z0-9]*$/.test(id)) {
    return json({ error: "id inválido" }, 400);
  }
  if (!token) return json({ error: "falta el token" }, 400);

  const bytes = jpegDesdeDataUrl(photo);
  if (!bytes) return json({ error: "la foto tiene que ser un JPEG" }, 400);
  if (bytes.length > MAX_BYTES) {
    return json({ error: "la foto pesa demasiado" }, 413);
  }

  const ruta = `${id}.jpg`;
  const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${ruta}`;

  // 1. Reservar. Un solo UPDATE valida la propiedad y escribe la URL; si el
  //    reporte no es suyo, ya tiene foto, o no existe, devuelve false sin
  //    tocar nada. No hay una función aparte de "solo verificar" a propósito:
  //    dos caminos que decidan lo mismo terminan desincronizándose, y además
  //    verificar y escribir por separado abriría una ventana de carrera.
  const { data: puede, error: errCheck } = await supabase.rpc("_attach_photo", {
    p_id: id, p_token: token, p_photo: url,
  });
  if (errCheck) {
    console.error("Error validando la propiedad", errCheck);
    return json({ error: "no se pudo validar el reporte" }, 500);
  }
  if (puede !== true) {
    // No se dice cuál de los motivos, igual que delete_own_report.
    return json({ ok: false, reason: "not_owner" }, 403);
  }

  // 2. Subir. La fila ya quedó apuntando a esta URL en el paso anterior, así
  //    que si esto falla hay que revertirla — si no, el mapa muestra un <img>
  //    roto a todo el mundo.
  const { error: errUpload } = await supabase.storage
    .from(BUCKET)
    .upload(ruta, bytes, {
      contentType: "image/jpeg",
      upsert: true,
      // CACHE CORTO A PROPÓSITO, y no es un detalle de rendimiento: es parte
      // de la moderación. Storage sirve los objetos públicos detrás de un CDN,
      // y con el default (3600 s) una foto que la moderación acaba de borrar
      // se sigue entregando por su URL directa hasta una hora — verificado
      // contra producción: el objeto ya no estaba en `storage.objects` y el
      // GET seguía devolviendo 200.
      //
      // 300 s acota esa ventana a 5 minutos. El costo es más egreso (el plan
      // Free tiene 5 GB/mes, que es el primer techo que toca este proyecto),
      // pero las fotos pesan ~76 KB en el peor caso y los reportes viven un
      // par de horas: es barato comparado con dejar visible una imagen que se
      // decidió sacar.
      cacheControl: "300",
    });

  if (errUpload) {
    console.error("Error subiendo la foto", errUpload);
    // Revertir es best-effort: si tampoco se puede, queda un reporte con una
    // foto que no carga, que la moderación o el vencimiento se llevan.
    await supabase.from("reports").update({ photo: null }).eq("id", id);
    return json({ error: "no se pudo guardar la foto" }, 500);
  }

  return json({ ok: true, photo: url }, 200);
});
