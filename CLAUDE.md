# AMET Radar — Contexto del proyecto

## Qué es
App web (HTML/CSS/JS vanilla + Leaflet) de reportes comunitarios de retenes
de tránsito (AMET) en Santo Domingo. Los usuarios marcan en un mapa dónde
hay un retén, categoría, foto obligatoria y nota opcional; otros usuarios
pueden confirmar o desmentir el reporte.

## Estado actual (importante)
Esta es una **versión de prueba local**. El almacenamiento de datos usa
`localStorage` del navegador — **no hay backend real**, por lo que los
reportes solo se ven en el navegador donde se crearon, no se comparten
entre usuarios/dispositivos. Esto es intencional para poder probar el flujo
completo sin infraestructura, pero es el bloqueante #1 antes de lanzar a
producción real.

## Archivos
- `amet-radar.html` — toda la app (HTML + CSS + JS en un solo archivo)
- `manifest.json` — manifest de PWA
- `sw.js` — service worker (cache-first del app shell)
- `icon-192.png`, `icon-512.png` — íconos de la PWA
- `README.md` — cómo correr el proyecto localmente y qué mejoras de la
  lista ya están implementadas para la prueba local
- `plan-mejora-amet-radar.md` — plan de mejoras original (por prioridad
  🔴/🟡/🟢) que dio origen a las decisiones de arquitectura de abajo; incluye
  el orden sugerido de implementación y el estado de qué falta

## Cómo correrlo
Requiere servirse por `http://` (no abrir con doble clic / `file://`),
porque geolocalización y el service worker no funcionan bien sobre `file://`.

```bash
cd carpeta-del-proyecto
python3 -m http.server 8000
```
Abrir `http://localhost:8000/amet-radar.html`.

En VS Code: la extensión "Live Server" también funciona (clic derecho sobre
`amet-radar.html` → "Open with Live Server").

## Decisiones de arquitectura ya tomadas
- **Categorías de reporte**: `reten_fijo`, `reten_movil`, `accidente`, `control`
  (objeto `CATEGORIES` dentro del `<script>`, con emoji y color cada una).
- **Modelo de datos por reporte**:
  ```js
  { lat, lng, photo, note, ts, category, confirms, denies }
  ```
- **Persistencia**: todo bajo una sola clave `amet_reports_v1` en
  `localStorage` (evita el problema N+1 de la versión anterior que hacía
  una llamada de red por reporte).
- **Confirmación comunitaria**: si `denies - confirms >= 2` el reporte se
  borra automáticamente.
- **Filtrado por zona visible**: los marcadores solo se dibujan si están
  dentro del `bounds` actual del mapa (recalculado en `moveend`/`zoomend`).
- **Mi ubicación**: `navigator.geolocation.watchPosition` centra el mapa en
  el primer fix y mantiene un marcador azul (`meMarker`) actualizado.
- **Anti-spam**: máx. 3 reportes por hora por dispositivo
  (`amet_report_times_v1` en localStorage).
- **Reporte propio**: se guarda el id en `amet_my_reports_v1` para poder
  eliminarlo desde el popup.

## Pendiente (siguiente paso lógico, bloqueante para producción real)
Reemplazar las funciones `loadAllReports()` / `saveAllReports()` (agrupadas
y comentadas en el `<script>` de `amet-radar.html`) por llamadas a un
backend real (Supabase, Firebase o API propia) para que los reportes se
compartan entre todos los usuarios. El resto de la lógica (categorías,
votos, filtrado por zona, etc.) no debería necesitar cambios grandes al
migrar — solo el punto de persistencia.

## Historial relevante de decisiones (por si se pregunta "por qué así")
- Se partió de una versión anterior que usaba `window.storage` (API propia
  del entorno de artifacts de Claude.ai) — se reemplazó por `localStorage`
  porque el proyecto se está probando fuera de ese entorno.
- Se priorizó reducir llamadas de red/almacenamiento agrupando datos en
  una sola clave en vez de una clave por reporte.
- Se agregaron categorías porque el diseño original solo tenía un ícono fijo.
