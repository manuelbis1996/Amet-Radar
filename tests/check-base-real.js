// Chequeos contra la BASE REAL — el hueco que las otras 13 suites no pueden ver.
//
// POR QUÉ EXISTE. Las suites de Playwright mockean la red con `page.route`:
// nunca llega una petición a Postgres, así que prueban el CLIENTE y no el
// SERVIDOR. Todos los bugs caros de este proyecto se colaron exactamente por
// ahí, con las suites en verde:
//
//   * `_delete_report()` hacía `delete from storage.objects`, que Supabase
//     prohíbe; la excepción se llevaba la transacción entera y rompía los
//     CUATRO caminos de borrado a la vez
//   * `vote_report()` devolvía dos filas al retirar un reporte (`return query`
//     agrega filas y SIGUE ejecutando, no corta como un `return`)
//   * `app_config` tenía `update` abierto, y `purge_expired_reports()` lee su
//     umbral de ahí: dos peticiones y la base quedaba vacía
//
// Hasta ahora esto se verificaba a mano, pegando SQL en el editor de Supabase
// cada vez. Esto lo automatiza.
//
// NO NECESITA NINGÚN SECRET. Usa la misma publishable key que ya está en
// `amet-radar.html`, que es pública por diseño — o sea que corre en cualquier
// lado, y lo que comprueba es justamente lo que puede hacer un atacante que
// lea el código fuente de la página. Si algún día pide credenciales, algo se
// desvió: lo valioso acá es mirar el sistema con los ojos de `anon`.
//
//   node tests/check-base-real.js                 todo
//   node tests/check-base-real.js --solo-lectura  sin publicar la sonda
//
// NO va en `tests/run.js` a propósito: esa corrida es local y en CI, y el CI
// manda el dominio de Supabase a 127.0.0.1 justamente para que ningún test
// toque producción por accidente. Este se corre aparte (ver el workflow
// `base-real.yml`).

const crypto = require('crypto');

const SUPABASE_URL = 'https://nikexwjxxcxzhsuypsjn.supabase.co';
const ANON = 'sb_publishable_p8U6gvvBwPVHdfmspjyCXA_g6clP58v';
const H = {
  'apikey': ANON,
  'Authorization': `Bearer ${ANON}`,
  'Content-Type': 'application/json'
};

const SOLO_LECTURA = process.argv.includes('--solo-lectura');

// La sonda se publica en el medio del Lago Enriquillo: está dentro de la caja
// de RD (si no, `create_report` la rechazaría por `invalid`) pero es agua
// salada, no vive nadie. Importa porque publicar dispara notificaciones push
// REALES a quien esté suscrito en el radio — este archivo no puede leer
// `push_subscriptions` para comprobar que no hay nadie cerca (no hay política
// de SELECT, y está bien que no la haya), así que la única defensa es elegir
// un punto donde no pueda haber nadie.
// Con jitter, y no es cosmético: el dedupe de `create_report` rechaza otro
// reporte de la misma categoría a menos de 150 m en 30 minutos. Con un punto
// fijo, dos corridas seguidas (o una corrida más una prueba a mano) chocan
// entre sí y la segunda falla entera por `duplicate` sin que haya nada roto.
// Ya pasó mientras se escribía esto. El recuadro es todo agua del lago.
const SONDA_LAT = 18.44 + Math.random() * 0.10;
const SONDA_LNG = -71.70 + Math.random() * 0.14;
// Y aun así, con guarda: el radio es configurable hasta 50 km desde el panel,
// y con un valor grande la sonda alcanzaría Neiba o Duvergé. Si está por
// encima de esto, los chequeos que publican se saltean en vez de arriesgar
// que a alguien real le suene el teléfono por una prueba.
const RADIO_MAX_SEGURO = 8000;

// JPEG 1x1 de verdad: `attach-photo` exige un data: URL de image/jpeg y lo
// decodifica, así que unos bytes cualquiera no sirven.
const JPEG_DATA_URL = 'data:image/jpeg;base64,' +
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const fails = [];
const check = (n, c, extra = '') => {
  console.log((c ? '  OK  ' : ' FALLA') + ' | ' + n + (extra ? '  -> ' + extra : ''));
  if (!c) fails.push(n);
};
const nota = (t) => console.log('       ' + t);

async function pedir(metodo, ruta, cuerpo, extraHeaders) {
  const res = await fetch(SUPABASE_URL + ruta, {
    method: metodo,
    headers: { ...H, ...(extraHeaders || {}) },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
  });
  const texto = await res.text();
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch { /* no era json */ }
  return { status: res.status, texto, json };
}

const rpc = (nombre, args) => pedir('POST', `/rest/v1/rpc/${nombre}`, args);

// Mismo formato de id que generan publishReport/publishQuickReport, porque
// `create_report` lo valida con una expresión regular.
const nuevoId = () => `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

(async () => {
  console.log('Contra la base real:', SUPABASE_URL);
  console.log(SOLO_LECTURA ? '(modo solo lectura: no se publica la sonda)' : '');
  console.log('');

  // =========================================================================
  // 1. Lo que anon SÍ tiene que poder hacer.
  //    Van primero a propósito: un fallo acá no es "está bien cerrado", es la
  //    app entera caída. Si el proyecto está pausado o la key rotó, se ve acá
  //    y el resto de los "no puede" serían falsos positivos.
  // =========================================================================
  console.log('-- Lo que anon tiene que poder --');
  {
    const r = await pedir('GET', '/rest/v1/reports?select=id&limit=1');
    check('leer reportes sigue abierto (la app no funciona sin esto)',
      r.status === 200, 'status=' + r.status);

    const c = await pedir('GET', '/rest/v1/app_config?select=*&limit=1');
    check('leer app_config sigue abierto (loadConfig() lo necesita al arrancar)',
      c.status === 200, 'status=' + c.status);
    var configActual = (c.json && c.json[0]) || {};
  }

  // =========================================================================
  // 2. Escritura directa: todo cerrado.
  //    OJO CON LOS PAYLOADS: cada uno viola además una restricción de columna
  //    a propósito. Si alguna de estas políticas se reabriera, el 401 se
  //    convierte en un 400 de Postgres y NO en una fila basura en producción.
  //    Un test de seguridad no puede ser el que ensucia la base que cuida.
  // =========================================================================
  console.log('');
  console.log('-- Escritura directa por REST: todo cerrado --');
  {
    const r = await pedir('POST', '/rest/v1/reports', {
      id: 'sonda_formato_invalido', lat: SONDA_LAT, lng: SONDA_LNG,
      ts: Date.now(), category: '__sonda__', confirms: 0, denies: 0, approx: false
    }, { 'Prefer': 'return=minimal' });
    check('POST directo a reports: rechazado (política de insert cerrada en v14.0)',
      r.status === 401, 'status=' + r.status + ' ' + r.texto.slice(0, 120));
    if (r.status === 400) {
      nota('OJO: 400 = la política volvió a estar abierta y lo frenó el CHECK de la columna.');
    }

    const p = await pedir('POST', '/rest/v1/push_subscriptions', {
      endpoint: 'https://sonda.invalido/x', p256dh: 'x', auth: 'x', lat: 999, lng: 999
    }, { 'Prefer': 'return=minimal' });
    check('POST directo a push_subscriptions: rechazado (v14.2)',
      p.status === 401, 'status=' + p.status);

    // LEER ESTO ANTES DE "ARREGLAR" LA EXPECTATIVA DE ABAJO. Un PATCH (o un
    // DELETE) contra una tabla sin política de UPDATE devuelve **204, no 401**:
    // RLS hace que no matchee ninguna fila y PostgREST contesta lo mismo que si
    // hubiera actualizado cero. O sea que el código de estado por sí solo NO
    // distingue "bloqueado" de "no había nada", y esperar un 401 acá da un rojo
    // falso. (El POST sí da 401, porque ahí RLS rechaza la fila nueva de forma
    // explícita — por eso los dos chequeos de arriba sí esperan 401.)
    //
    // Lo que hace concluyente a este chequeo es el VALOR: 10 viola
    // app_config_push_radius_range. Entonces:
    //   204            -> ninguna fila matcheó, RLS bloqueó        (bien)
    //   400 / 23514    -> la fila matcheó y la salvó el CHECK      (MAL: la
    //                     política de update volvió)
    // Y por las dudas se relee el valor: si cambió, es que pasó de verdad.
    const antes = configActual.push_radius_meters;
    const a = await pedir('PATCH', '/rest/v1/app_config?id=eq.true',
      { push_radius_meters: 10 }, { 'Prefer': 'return=minimal' });
    const despues = await pedir('GET', '/rest/v1/app_config?select=push_radius_meters');
    const sinCambios = despues.json && despues.json[0] &&
      despues.json[0].push_radius_meters === antes;
    check('PATCH directo a app_config: bloqueado (la puerta lateral que vaciaba la base)',
      a.status === 204 && sinCambios,
      'status=' + a.status + ' valor=' + antes + '->' +
      (despues.json && despues.json[0] && despues.json[0].push_radius_meters));
    if (a.status === 400) {
      nota('400 = la política de update volvió y solo lo frenó el CHECK de la');
      nota('columna. purge_expired_reports() es otra vez un botón de borrar todo.');
    }
  }

  // =========================================================================
  // 3. Lo que anon no tiene que poder ni ver.
  // =========================================================================
  console.log('');
  console.log('-- Tablas y funciones fuera del alcance de anon --');
  {
    const s = await pedir('GET', '/rest/v1/push_subscriptions?select=endpoint&limit=5');
    // Sin política de SELECT, PostgREST contesta 200 con lista vacía en vez de
    // un error. Lo que importa es que NUNCA devuelva filas: si devuelve, se
    // pueden enumerar los endpoints, y conocer un endpoint es la única prueba
    // de propiedad que tiene esa tabla.
    check('no se pueden enumerar las suscripciones push',
      s.status === 200 && Array.isArray(s.json) && s.json.length === 0,
      'status=' + s.status + ' filas=' + (Array.isArray(s.json) ? s.json.length : '?'));

    for (const tabla of ['report_events', 'rate_limit_salt', 'admin_login_attempts',
                         'daily_stats']) {
      const t = await pedir('GET', `/rest/v1/${tabla}?select=*&limit=1`);
      const vacio = t.status !== 200 || (Array.isArray(t.json) && t.json.length === 0);
      check(`${tabla} no expone nada a anon`, vacio,
        'status=' + t.status + ' ' + t.texto.slice(0, 80));
    }
    nota('rate_limit_salt es el que más importa: con el salt, los hashes de IP');
    nota('de report_events se fuerzan a bruta (IPv4 son 4 mil millones).');

    // CUIDADO CON EL FALSO VERDE ACÁ, que ya casi se cuela una vez. Un 404 de
    // PostgREST no quiere decir "no tenés permiso": quiere decir "no encontré
    // ninguna función con ESA firma". Si a `_client_ip()` (que no lleva
    // argumentos) se la llama con `{p_id:'x'}`, contesta 404 por firma que no
    // matchea — y el chequeo pasaría en verde aunque la función estuviera
    // abierta a todo el mundo. Por eso cada una se llama con su firma real y
    // se mira el CÓDIGO DE POSTGRES, no el status HTTP.
    //
    //   42501   -> "permission denied for function": el grant no está. Es lo
    //              que se quiere ver en las funciones que sí existen para
    //              PostgREST.
    //   PGRST202 -> la función no está en el schema cache. Es lo esperable en
    //              las de trigger (`returns trigger`): PostgREST no las expone
    //              nunca, con grant o sin grant. Ese chequeo es estructural.
    const privadas = [
      ['_delete_report', { p_id: 'x' }, '42501'],
      ['_client_ip', {}, '42501'],
      // Adjuntar una foto pasa por el Edge Function attach-photo, que la
      // llama con la service_role key. Si esta quedara expuesta a anon,
      // cualquiera podría ponerle una foto a un reporte ajeno sin token.
      ['_attach_photo', { p_id: 'x', p_token: 'x', p_photo: 'x' }, '42501'],
      // El contador de daily_stats: si anon pudiera ejecutarlo, cualquiera
      // podría inflar las métricas del panel.
      ['bump_daily_stats', {}, 'PGRST202'],
      // De trigger, invocadas por la base. Nunca callables por REST.
      ['delete_report_photo', {}, 'PGRST202'],
      ['notify_nearby_reports', {}, 'PGRST202'],
      ['clear_report_photo', {}, 'PGRST202']
    ];
    for (const [fn, args, esperado] of privadas) {
      const r = await rpc(fn, args);
      const codigo = (r.json && r.json.code) || '(sin código)';
      check(`anon no puede ejecutar ${fn}()`,
        r.status !== 200 && codigo === esperado,
        'status=' + r.status + ' code=' + codigo);
    }
  }

  // =========================================================================
  // 4. create_report valida sin escribir nada.
  //    Todos estos devuelven `invalid` antes de tocar la tabla, así que son
  //    seguros de correr siempre, incluso en modo solo lectura.
  // =========================================================================
  console.log('');
  console.log('-- create_report: validación de entrada (no escribe) --');
  {
    const base = {
      p_id: nuevoId(), p_lat: SONDA_LAT, p_lng: SONDA_LNG, p_photo: null,
      p_note: '', p_ts: Date.now(), p_category: 'reten_fijo',
      p_approx: false, p_owner_hash: sha256('x')
    };
    const casos = [
      ['id con formato inventado', { ...base, p_id: 'dame-un-pin' }],
      ['coordenadas fuera de República Dominicana', { ...base, p_lat: 40.7, p_lng: -74.0 }],
      ['categoría que no existe', { ...base, p_category: '__sonda__' }],
      ['foto (cerradas en v14.1)', { ...base, p_photo: 'https://ejemplo.com/x.jpg' }],
      ['nota (cerradas en v14.1)', { ...base, p_note: 'texto arbitrario' }],
      ['owner_hash que no es un sha256', { ...base, p_owner_hash: 'no-soy-un-hash' }]
    ];
    for (const [nombre, args] of casos) {
      const r = await rpc('create_report', args);
      const j = r.json || {};
      check(`rechaza ${nombre}`, j.ok === false && j.reason === 'invalid',
        JSON.stringify(j).slice(0, 90));
    }
  }

  console.log('');
  console.log('-- subscribe_push: validación de entrada (no escribe) --');
  {
    const casos = [
      ['endpoint que no es una URL', { p_endpoint: 'hola', p_p256dh: 'k', p_auth: 'a', p_lat: 19.2, p_lng: -70.5 }],
      ['endpoint vacío', { p_endpoint: '', p_p256dh: 'k', p_auth: 'a', p_lat: 19.2, p_lng: -70.5 }],
      ['latitud fuera de rango', { p_endpoint: 'https://x.test/abc123', p_p256dh: 'k', p_auth: 'a', p_lat: 999, p_lng: -70.5 }]
    ];
    for (const [nombre, args] of casos) {
      const r = await rpc('subscribe_push', args);
      check(`rechaza ${nombre}`, r.json === false, JSON.stringify(r.json));
    }
    // Devuelve true aunque no exista, y es deliberado: distinguirlo permitiría
    // averiguar si un endpoint está dado de alta, que es justo lo que la falta
    // de política de SELECT evita. Por eso acá NO se puede comprobar que un
    // `unsubscribe_push('%')` no borró nada — eso sigue necesitando SQL.
    const u = await rpc('unsubscribe_push', { p_endpoint: '%' });
    check('unsubscribe_push no filtra si un endpoint existe', u.json === true,
      JSON.stringify(u.json));
  }

  console.log('');
  console.log('-- flag_photo: denunciar sin filtrar información --');
  {
    // Un id que no existe tiene que responder igual que uno que existe pero
    // no tiene foto: si contestara distinto, se podría sondear la base para
    // averiguar qué reportes tienen foto sin poder leerlos.
    const inexistente = await rpc('flag_photo', { p_id: 'report_1_noexiste' });
    check('denunciar un id inexistente no revela nada ni rompe',
      inexistente.json && inexistente.json.flags === 0 && inexistente.json.hidden === false,
      JSON.stringify(inexistente.json));
    const nulo = await rpc('flag_photo', { p_id: null });
    check('denunciar con id null tampoco',
      nulo.json && nulo.json.flags === 0, JSON.stringify(nulo.json));
  }

  console.log('');
  console.log('-- Storage: el bucket no acepta subidas (v14.1) --');
  {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/report-photos/report_1_a.jpg`, {
      method: 'POST',
      headers: { 'apikey': ANON, 'Authorization': `Bearer ${ANON}`, 'Content-Type': 'image/jpeg' },
      body: Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    });
    check('subir una foto con la anon key: rechazado', res.status >= 400,
      'status=' + res.status);
  }

  // =========================================================================
  // 5. Ciclo de la sonda. Es la única parte que escribe, y la única que puede
  //    comprobar de forma CONCLUYENTE que un DELETE/PATCH directo no toca una
  //    fila que existe de verdad.
  //
  //    Por qué hace falta una fila propia: contra una tabla sin políticas, un
  //    DELETE por REST devuelve 204 igual que si hubiera borrado cero filas.
  //    El código de estado NO distingue "bloqueado" de "no había nada", así
  //    que probar con un id inventado da un falso verde. Hay que borrar algo
  //    que sabemos que está, y después mirar si sigue estando.
  // =========================================================================
  const radio = Number(configActual.push_radius_meters) || 2000;
  const sonda = { id: nuevoId(), token: crypto.randomBytes(16).toString('hex') };

  if (SOLO_LECTURA) {
    console.log('');
    console.log('-- Ciclo de la sonda: salteado (--solo-lectura) --');
  } else if (radio > RADIO_MAX_SEGURO) {
    console.log('');
    console.log('-- Ciclo de la sonda: SALTEADO --');
    nota(`push_radius_meters está en ${radio} m (máximo seguro: ${RADIO_MAX_SEGURO} m).`);
    nota('Con ese radio la sonda del lago podría hacerle sonar el teléfono a');
    nota('gente real de Neiba o Duvergé. Bajá el radio o corré --solo-lectura.');
  } else {
    console.log('');
    console.log(`-- Ciclo de la sonda (radio de push: ${radio} m) --`);
    let publicada = false;
    try {
      const alta = await rpc('create_report', {
        p_id: sonda.id, p_lat: SONDA_LAT, p_lng: SONDA_LNG, p_photo: null,
        p_note: '', p_ts: Date.now(), p_category: 'reten_fijo',
        p_approx: false, p_owner_hash: sha256(sonda.token)
      });
      publicada = !!(alta.json && alta.json.ok);
      check('publicar por create_report funciona', publicada,
        JSON.stringify(alta.json).slice(0, 120));

      if (!publicada) {
        nota('Sin sonda no se puede comprobar el resto; probablemente quedó una');
        nota('sonda de una corrida anterior (dedupe: 150 m / 30 min).');
      } else {
        // -- dedupe: el control anti-spam que no depende de ninguna identidad
        const repetida = await rpc('create_report', {
          p_id: nuevoId(), p_lat: SONDA_LAT, p_lng: SONDA_LNG, p_photo: null,
          p_note: '', p_ts: Date.now(), p_category: 'reten_fijo',
          p_approx: false, p_owner_hash: sha256('otro')
        });
        check('un segundo reporte en el mismo punto se rechaza como duplicado',
          repetida.json && repetida.json.ok === false && repetida.json.reason === 'duplicate',
          JSON.stringify(repetida.json).slice(0, 90));

        // -- reintento de la cola offline: mismo id, idempotente
        const reintento = await rpc('create_report', {
          p_id: sonda.id, p_lat: SONDA_LAT, p_lng: SONDA_LNG, p_photo: null,
          p_note: '', p_ts: Date.now(), p_category: 'reten_fijo',
          p_approx: false, p_owner_hash: sha256(sonda.token)
        });
        check('reintentar con el mismo id es idempotente, no "duplicate"',
          reintento.json && reintento.json.ok === true &&
          reintento.json.reason === 'already_exists',
          JSON.stringify(reintento.json).slice(0, 90));
        nota('Este es el orden de chequeos que ya falló una vez: con el dedupe');
        nota('primero, la cola offline recibía "duplicate" de su propio reporte.');

        // -- DELETE directo: el agujero que cerró v12.0
        await pedir('DELETE', `/rest/v1/reports?id=eq.${sonda.id}`, undefined,
          { 'Prefer': 'return=minimal' });
        let v = await pedir('GET', `/rest/v1/reports?id=eq.${sonda.id}&select=id,confirms,denies`);
        check('un DELETE directo NO se lleva la fila',
          Array.isArray(v.json) && v.json.length === 1,
          'filas=' + (Array.isArray(v.json) ? v.json.length : '?'));

        // -- PATCH directo: inflar los votos
        await pedir('PATCH', `/rest/v1/reports?id=eq.${sonda.id}`,
          { confirms: 99999 }, { 'Prefer': 'return=minimal' });
        v = await pedir('GET', `/rest/v1/reports?id=eq.${sonda.id}&select=confirms`);
        check('un PATCH directo NO puede inflar los votos',
          v.json && v.json[0] && v.json[0].confirms === 0,
          'confirms=' + (v.json && v.json[0] && v.json[0].confirms));

        // -- vote_report: una sola fila y suma de a uno
        const voto = await rpc('vote_report', { p_id: sonda.id, p_dir: 'confirm' });
        const filas = Array.isArray(voto.json) ? voto.json : [voto.json];
        check('vote_report devuelve UNA sola fila', filas.length === 1,
          'filas=' + filas.length);
        nota('Devolvía dos al retirar un reporte; el cliente lee rows[0] y');
        nota('acertaba de casualidad. `return query` no corta la ejecución.');
        check('vote_report suma exactamente 1, no lo que mande el cliente',
          filas[0] && filas[0].confirms === 1 && filas[0].removed === false,
          JSON.stringify(filas[0]));

        // -- foto opcional: adjuntar, servir, moderar (v15.0)
        const conToken = (token) => pedir('POST', '/functions/v1/attach-photo',
          { id: sonda.id, token, photo: JPEG_DATA_URL });

        const ajena = await conToken('token-equivocado');
        check('adjuntar una foto con el token equivocado se rechaza',
          ajena.status === 403 && ajena.json && ajena.json.ok === false,
          'status=' + ajena.status + ' ' + JSON.stringify(ajena.json));

        const propia = await conToken(sonda.token);
        check('adjuntar con el token correcto funciona',
          propia.status === 200 && propia.json && propia.json.ok === true,
          'status=' + propia.status + ' ' + JSON.stringify(propia.json).slice(0, 90));

        if (propia.json && propia.json.photo) {
          const img = await fetch(propia.json.photo);
          check('la foto queda servida públicamente', img.status === 200,
            'status=' + img.status);
          // El cache-control corto es parte de la moderación, no una mejora
          // de rendimiento: Storage sirve detrás de un CDN, y con el default
          // (3600 s) una foto ya borrada se sigue entregando hasta una hora
          // por su URL directa. Verificado contra producción.
          const cc = img.headers.get('cache-control') || '';
          const seg = Number((/max-age=(\d+)/.exec(cc) || [])[1]);
          check('y con un cache corto, para que moderarla sirva de algo',
            Number.isFinite(seg) && seg <= 600, 'cache-control: ' + cc);
        }

        // Reemplazar la foto tiene que ser imposible: si no, se podría
        // adjuntar algo inocente, esperar a que junte confirmaciones y recién
        // entonces cambiarla.
        const otraVez = await conToken(sonda.token);
        check('no se puede REEMPLAZAR una foto ya publicada',
          otraVez.status === 403, 'status=' + otraVez.status);

        let denuncia;
        for (let i = 0; i < 3; i++) denuncia = await rpc('flag_photo', { p_id: sonda.id });
        check('tres denuncias esconden la foto',
          denuncia.json && denuncia.json.hidden === true && denuncia.json.flags === 3,
          JSON.stringify(denuncia.json));

        v = await pedir('GET', `/rest/v1/reports?id=eq.${sonda.id}&select=photo,photo_flags`);
        check('la fila queda sin foto, pero el reporte sobrevive',
          v.json && v.json[0] && v.json[0].photo === null && v.json[0].photo_flags === 3,
          JSON.stringify(v.json && v.json[0]));
        nota('Se denuncia la IMAGEN, no el aviso de que hay un retén: el');
        nota('reporte puede ser perfectamente válido con una foto que no.');

        // -- propiedad: el token es la única llave
        const ajeno = await rpc('delete_own_report', { p_id: sonda.id, p_token: 'token-equivocado' });
        check('delete_own_report con el token equivocado devuelve false',
          ajeno.json === false, JSON.stringify(ajeno.json));
        v = await pedir('GET', `/rest/v1/reports?id=eq.${sonda.id}&select=id`);
        check('y la fila sigue viva después del intento',
          Array.isArray(v.json) && v.json.length === 1);

        const propio = await rpc('delete_own_report', { p_id: sonda.id, p_token: sonda.token });
        check('delete_own_report con el token correcto sí borra', propio.json === true,
          JSON.stringify(propio.json));
        publicada = propio.json !== true;
        v = await pedir('GET', `/rest/v1/reports?id=eq.${sonda.id}&select=id`);
        check('la sonda quedó borrada', Array.isArray(v.json) && v.json.length === 0,
          'filas=' + (Array.isArray(v.json) ? v.json.length : '?'));
      }
    } finally {
      // Red de seguridad: si algo tiró en el medio, la sonda no puede quedar
      // dando vueltas en producción. Si ni esto la borra, se avisa con el id
      // para poder sacarla a mano desde el panel.
      if (publicada) {
        const rescate = await rpc('delete_own_report', { p_id: sonda.id, p_token: sonda.token });
        if (rescate.json !== true) {
          console.log('');
          console.log(`  !!!  Quedó la sonda ${sonda.id} en producción. Borrala desde el panel.`);
          console.log('       (se autoexpira sola al llegar a max_age_minutes)');
          fails.push('no se pudo limpiar la sonda');
        } else {
          nota('sonda limpiada por la red de seguridad');
        }
      }
    }
  }

  console.log('');
  console.log(fails.length
    ? `>>> ${fails.length} FALLO(S): ${fails.join(' | ')}`
    : '>>> TODOS LOS CHEQUEOS PASARON');
  process.exit(fails.length ? 1 : 0);
})().catch((err) => {
  console.error('');
  console.error('>>> LA CORRIDA SE CORTÓ:', err && err.message ? err.message : err);
  console.error('    Si es un error de red, revisá que el proyecto de Supabase no esté pausado.');
  process.exit(1);
});
