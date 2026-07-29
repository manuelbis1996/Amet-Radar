# AMET Radar — Prueba local

## Requisitos

- [Node.js](https://nodejs.org/) instalado (cualquier versión reciente, no
  usa dependencias externas). No necesita `npm install` — `server.js` solo
  usa módulos nativos de Node.

## Cómo correrlo

La geolocalización y el service worker (PWA) no funcionan bien abriendo el
archivo directamente con doble clic (`file://`). Además, ahora los reportes
se guardan en el servidor (no en el navegador), así que hay que levantar
`server.js` en vez de un servidor de archivos estático simple:

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

`server.js` expone una API (`/api/reports`) que guarda los reportes en
`data/reports.json`, en el servidor — no en `localStorage` del navegador.
Cualquier dispositivo que entre a la misma URL (misma red o mismo túnel) ve,
publica, vota y borra sobre los mismos reportes; el cliente refresca cada 8
segundos. La carpeta `data/` está en `.gitignore` porque es contenido en
tiempo de ejecución, no código fuente — en una PC nueva arranca vacía.

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

## Importante: esto sigue siendo una prueba local

`localStorage` guarda los reportes solo en el navegador donde los creaste —
**no se comparten entre distintos dispositivos o usuarios**. Para el
lanzamiento real, según el plan de mejora, el siguiente paso es reemplazar
las funciones `loadAllReports` / `saveAllReports` (están agrupadas y
comentadas en el `<script>`) por llamadas a un backend real (Supabase,
Firebase o una API propia) para que los reportes se vean entre todos los
usuarios de la comunidad.
