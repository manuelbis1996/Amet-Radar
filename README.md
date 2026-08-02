# AMET Radar

## En producción

La app ya está publicada: **https://amet-radar.lavega.workers.dev**
(Cloudflare Workers, ver [CLAUDE.md](CLAUDE.md#despliegue-cloudflare-workers)).
Sirve directo desde ahí, con HTTPS (necesario para geolocalización en el
celular) y sin depender de que ninguna PC esté prendida — los reportes
viven en Supabase (ver más abajo). El resto de este README es para correr
el proyecto en local (desarrollo/pruebas).

## Requisitos

- [Node.js](https://nodejs.org/) instalado (cualquier versión reciente, no
  usa dependencias externas). No necesita `npm install` — `server.js` solo
  usa módulos nativos de Node.

## Cómo correrlo

La geolocalización, el service worker (PWA) y el fetch a Supabase no
funcionan bien abriendo el archivo directamente con doble clic (`file://`),
así que hay que levantar `server.js` para servirlo por `http://`:

```bash
cd carpeta-donde-estan-los-archivos
node server.js
```

Luego abre en el navegador (idealmente Chrome/Android o Safari/iOS si vas a
probar en el celular):

```
http://localhost:8000/amet-radar.html
```

Si quieres probarlo desde tu teléfono en la misma red Wi-Fi, usa la IP de tu
computadora en vez de `localhost`, por ejemplo `http://192.168.1.20:8000/amet-radar.html`.
Nota: la geolocalización solo funciona sobre HTTPS o `localhost` — por IP de
red (`http://`) los navegadores móviles la bloquean por defecto. Para probar
desde el móvil con geolocalización, usa un túnel HTTPS (ej. `npx localtunnel
--port 8000`) o activa el flag de Chrome
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` agregando la IP.

## Reportes compartidos entre dispositivos

Los reportes viven en una tabla `reports` de un proyecto Supabase (no en
`localStorage` ni en un archivo del servidor). `amet-radar.html` llama
directo a la API REST de Supabase con una publishable key embebida en el
cliente; el control de acceso lo hacen las políticas RLS de la tabla, no
`server.js`. Cualquier dispositivo que entre a la app ve, publica, vota y
borra sobre los mismos reportes, sin depender de que una PC en particular
esté prendida; el cliente refresca cada 8 segundos.

## Qué se implementó de la lista de mejoras

- **Datos**: los reportes ahora se guardan en `localStorage` en una sola clave
  (en vez de una llamada por reporte), con limpieza automática de vencidos.
- **Confirmación comunitaria**: botones "Sigue ahí" / "Ya no está" en cada
  popup; con suficientes negaciones el reporte se retira solo.
- **Categorías**: retén fijo, retén móvil, accidente, control de tránsito —
  con íconos, colores y chips de filtro en la parte superior.
- **Filtro por zona visible**: solo se dibujan los marcadores dentro del área
  actual del mapa (se recalcula al mover/hacer zoom).
- **Mi ubicación**: el mapa se centra automáticamente en tu posición al abrir
  (con manejo de error si el permiso se rechaza), un punto azul te sigue en
  tiempo real, y hay un botón 🎯 para recentrar cuando quieras.
- **Gestión de reporte propio**: puedes eliminar un reporte que tú mismo
  publicaste desde su popup.
- **Anti-spam**: máximo 3 reportes por hora por dispositivo.
- **Compartir**: botón para copiar un enlace directo a un reporte específico.
- **Accesibilidad**: `aria-label` en botones de ícono, `aria-pressed` en los
  filtros, y `prefers-reduced-motion` respetado.
- **PWA**: `manifest.json` + `sw.js` para instalar la app y cachear el shell
  básico (funciona una vez que se sirve por `http://localhost` o HTTPS).

## Panel de administración

`admin.html` — moderar reportes (verlos todos, borrar cualquiera), ver
estadísticas y editar en caliente los parámetros del sistema, sin backend
propio (le pega directo a Supabase, protegido por password vía un Edge
Function). Detalles completos en
[CLAUDE.md](CLAUDE.md#panel-de-administración).

## Redesplegar a producción

El Worker de Cloudflare (`amet-radar`, cuenta `manuelbis1996`) está
conectado al repo de GitHub — un push a `main` redespliega solo. Detalles
en [CLAUDE.md](CLAUDE.md#despliegue-cloudflare-workers).
