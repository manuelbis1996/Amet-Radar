// El preview que ve WhatsApp al compartir un reporte.
//
// No usa Playwright: `_worker.js` es lógica pura, así que se importa y se le
// mockean las dos cosas de las que depende (el fetch a Supabase/Nominatim y el
// binding ASSETS de Cloudflare). Es la primera cobertura que tiene el Worker —
// hasta acá se verificaba a mano con curl contra producción.
//
// Qué protege:
//   * que la tarjeta diga DÓNDE fue marcado (la calle), que es lo que hace
//     útil compartir el link: sin eso quien lo recibe no sabe si le queda de
//     camino
//   * que si la geocodificación falla, el preview NO se rompa — se cae al
//     texto de antes
//   * que la imagen de fondo sea la foto real del reporte cuando la tiene, y
//     una tarjeta 1200x630 por categoría cuando no
//   * que un usuario real (no bot) siga pasando de largo, sin latencia extra

const path = require('path');
const { pathToFileURL } = require('url');

const fails = [];
const check = (n, c, extra = '') => {
  console.log((c ? '  OK  ' : ' FALLA') + ' | ' + n + (extra ? '  -> ' + extra : ''));
  if (!c) fails.push(n);
};

const UA_BOT = 'WhatsApp/2.23.20.0';
const UA_HUMANO = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';

const REPORTE = {
  category: 'reten_fijo', note: '', ts: Date.now() - 5 * 60000,
  lat: 19.2214, lng: -70.5295, photo: null,
};

const DIRECCION = {
  address: {
    road: 'Calle María Trinidad Sánchez',
    suburb: 'Santo Domingo Savio',
    city: 'La Vega',
  },
};

// Doble de red: decide qué contesta Supabase y qué contesta Nominatim.
function montarFetch({ filas = [REPORTE], geoFalla = false } = {}) {
  const vistas = [];
  global.fetch = async (u, opts) => {
    const url = String(u);
    vistas.push(url);
    if (url.includes('/rest/v1/reports')) {
      return new Response(JSON.stringify(filas), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('nominatim')) {
      if (geoFalla) throw new Error('nominatim caído');
      return new Response(JSON.stringify(DIRECCION), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('no', { status: 404 });
  };
  return vistas;
}

const ENV = {
  ASSETS: { fetch: async () => new Response('<html>la SPA</html>', {
    status: 200, headers: { 'content-type': 'text/html' } }) },
};

const pedir = (worker, ruta, ua) =>
  worker.fetch(new Request('https://amet-radar.lavega.workers.dev' + ruta,
    { headers: { 'user-agent': ua } }), ENV);

const meta = (html, prop) => {
  const re = new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)"`);
  const m = html.match(re);
  return m ? m[1] : null;
};

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', '_worker.js')).href);
  const worker = mod.default;

  // ---- 1. La dirección en la tarjeta ----
  montarFetch();
  {
    const res = await pedir(worker, '/?r=abc', UA_BOT);
    const html = await res.text();
    const titulo = meta(html, 'og:title');
    const desc = meta(html, 'og:description');
    check('EL PEDIDO: el título dice en qué calle fue marcado',
      /Calle María Trinidad Sánchez/.test(titulo || ''), titulo);
    check('y sigue diciendo qué tipo de reporte es',
      /Retén fijo/.test(titulo || ''), titulo);
    check('la descripción dice el barrio y la ciudad',
      /Santo Domingo Savio/.test(desc || '') && /La Vega/.test(desc || ''), desc);
    check('y hace cuánto se reportó', /hace 5 min/.test(desc || ''), desc);
  }

  // ---- 2. Si la geocodificación falla, el preview NO se rompe ----
  montarFetch({ geoFalla: true });
  {
    const res = await pedir(worker, '/?r=abc', UA_BOT);
    const html = await res.text();
    check('con Nominatim caído sigue respondiendo 200', res.status === 200, 'status=' + res.status);
    check('y cae al texto de antes en vez de romperse',
      /Retén fijo/.test(meta(html, 'og:title') || '') &&
      /hace 5 min/.test(meta(html, 'og:description') || ''),
      meta(html, 'og:title') + ' | ' + meta(html, 'og:description'));
  }

  // ---- 3. La imagen de fondo ----
  montarFetch();
  {
    const html = await (await pedir(worker, '/?r=abc', UA_BOT)).text();
    const img = meta(html, 'og:image');
    check('EL PEDIDO: sin foto usa la tarjeta grande de su categoría',
      /\/og-reten_fijo\.png$/.test(img || ''), img);
    check('y la declara como tarjeta GRANDE (si no, WhatsApp la pone chiquita al costado)',
      meta(html, 'twitter:card') === 'summary_large_image', meta(html, 'twitter:card'));
    check('con las medidas declaradas', meta(html, 'og:image:width') === '1200');
  }
  {
    const FOTO = 'https://nikexwjxxcxzhsuypsjn.supabase.co/storage/v1/object/public/report-photos/x.jpg';
    montarFetch({ filas: [{ ...REPORTE, photo: FOTO }] });
    const html = await (await pedir(worker, '/?r=abc', UA_BOT)).text();
    check('EL PEDIDO: con foto, la foto real va de fondo',
      meta(html, 'og:image') === FOTO, meta(html, 'og:image'));
    // Las medidas de la tarjeta serían mentira acá: compressImage deja la foto
    // en 480px de ancho y algunos scrapers la descartarían por no coincidir.
    check('y no se le declaran las medidas de la tarjeta',
      meta(html, 'og:image:width') === null, meta(html, 'og:image:width'));
  }
  {
    // Filas viejas: antes de Storage la foto era un data: URL embebido, que no
    // sirve como og:image.
    montarFetch({ filas: [{ ...REPORTE, photo: 'data:image/jpeg;base64,/9j/4AAQ' }] });
    const html = await (await pedir(worker, '/?r=abc', UA_BOT)).text();
    check('una foto vieja en base64 NO se usa como imagen (no funcionaría)',
      /\/og-reten_fijo\.png$/.test(meta(html, 'og:image') || ''), meta(html, 'og:image'));
  }

  // ---- 4. Categoría desconocida: no inventa una imagen que no existe ----
  montarFetch({ filas: [{ ...REPORTE, category: 'inventada' }] });
  {
    const html = await (await pedir(worker, '/?r=abc', UA_BOT)).text();
    check('una categoría desconocida cae a una imagen que SÍ existe',
      /\/og-reten_fijo\.png$/.test(meta(html, 'og:image') || ''), meta(html, 'og:image'));
  }

  // ---- 5. Lo que no debe cambiar ----
  montarFetch();
  {
    const res = await pedir(worker, '/?r=abc', UA_HUMANO);
    const html = await res.text();
    check('un usuario real no ve el preview: pasa de largo a la SPA',
      /la SPA/.test(html), html.slice(0, 40));
  }
  {
    montarFetch({ filas: [] });
    const html = await (await pedir(worker, '/?r=noexiste', UA_BOT)).text();
    check('un reporte que ya no existe cae a la SPA, sin error',
      /la SPA/.test(html), html.slice(0, 40));
  }
  {
    montarFetch();
    const html = await (await pedir(worker, '/', UA_BOT)).text();
    check('sin ?r= tampoco hay preview', /la SPA/.test(html), html.slice(0, 40));
  }

  // ---- 6. Nominatim: solo se llama en el camino de bots ----
  {
    const vistas = montarFetch();
    await pedir(worker, '/?r=abc', UA_HUMANO);
    check('a un usuario real NO se le gasta una llamada a Nominatim',
      !vistas.some(u => u.includes('nominatim')), JSON.stringify(vistas));
  }
  {
    const vistas = montarFetch();
    await pedir(worker, '/?r=abc', UA_BOT);
    const geo = vistas.filter(u => u.includes('nominatim'));
    check('el bot dispara exactamente una geocodificación', geo.length === 1, 'n=' + geo.length);
    check('y le pide la calle con zoom fino y en español',
      geo[0] && /zoom=17/.test(geo[0]) && /accept-language=es/.test(geo[0]), geo[0]);
  }

  // El User-Agent no se ve desde el mock (Request lo normaliza), así que se
  // comprueba sobre la fuente: es un requisito de la política de Nominatim y
  // olvidarlo hace que bloqueen al proyecto entero.
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', '_worker.js'), 'utf8');
    check('el Worker manda User-Agent identificable a Nominatim',
      /User-Agent["']?\s*:\s*NOMINATIM_UA/.test(src) && /AMET-Radar/.test(src));
    check('y cachea la respuesta en el borde, para no abusar del servicio',
      /cacheTtl/.test(src));
  }

  console.log(fails.length ? `\n>>> ${fails.length} CHEQUEO(S) FALLARON` : '\n>>> TODOS LOS CHEQUEOS PASARON');
  process.exit(fails.length ? 1 : 0);
})();
