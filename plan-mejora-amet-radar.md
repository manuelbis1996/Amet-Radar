# Plan de Mejora — AMET Radar

App de reportes comunitarios de retenes/AMET sobre mapa Leaflet, con flujo
de reporte (ubicación + foto obligatoria + nota), backend real en Supabase
y panel de administración. Este plan reemplaza la versión original (que
describía la app todavía sobre `localStorage`, sin backend compartido) —
casi todo lo que proponía ya está hecho; ver "Ya implementado" abajo.

Prioridad: 🔴 Alta · 🟡 Media · 🟢 Baja

---

## Ya implementado (no reabrir sin razón)

- **Backend real**: Supabase (tabla `public.reports`), no `localStorage` ni
  archivo del servidor — cualquier dispositivo ve/publica/vota/borra sobre
  los mismos reportes.
- **Confirmación comunitaria**: botones "Sigue ahí" / "Ya no está"; se
  retira solo con suficientes negaciones.
- **Categorías**: retén fijo, retén móvil, accidente, control de tránsito.
- **Filtrado por zona visible** en el mapa.
- **Manejo de geolocalización denegada** con aviso y centro por defecto.
- **PWA instalable** (`manifest.json` + `sw.js`).
- **Compartir por deep link** (`?r=<id>`) + preview dinámico por reporte
  para bots de WhatsApp/Twitter (Netlify Edge Function).
- **Notificaciones push por cercanía**, con filtro por categoría.
- **Panel de administración** (`admin.html`): moderar reportes, ver
  estadísticas, editar parámetros del sistema (`app_config`), protegido
  por password vía Edge Function `admin-login`.
- **Anti-spam** cliente (3 reportes/hora) y reporte rápido sin foto
  (`approx: true`, círculo de zona aproximada).

Detalle completo de cómo funciona cada uno en `CLAUDE.md`.

---

## 1. Seguridad (la brecha más real hoy)

**🔴 RLS completamente abierta en Supabase**
`reports`, `push_subscriptions` (insert/update/delete) y `app_config`
tienen políticas `USING (true)` — cualquiera con la anon key (pública,
embebida en el HTML) puede borrar o editar cualquier fila de cualquier
tabla pegándole directo a la REST API, sin pasar por la UI ni por el
panel admin. Ya se aceptó como diseño consciente para el volumen actual,
pero ahora que hay un panel admin real vale evaluar mediar el DELETE de
reportes (y la edición de `app_config`) a través de una Postgres function
o Edge Function con lógica propia (rate limit, registro de quién borró),
en vez de dejar la tabla abierta a cualquiera.
- Esfuerzo: alto (implica autenticación real o funciones + revocar
  acceso directo a la tabla). Bloqueante solo si el proyecto crece a un
  punto donde el abuso se vuelva un problema real.

**✅ Rate-limit de `admin-login` — resuelto**
El contador de intentos ahora vive en la tabla `public.admin_login_attempts`
(RLS habilitada, sin políticas — solo la toca el Edge Function con la
service_role key) en vez de un `Map` en memoria que se reseteaba en cada
cold start.

**🟢 Documentar el modelo de "gate de conveniencia" para el password de admin**
Ya está anotado en `CLAUDE.md` que el login de `admin.html` no protege
datos reales (la RLS abierta ya los expone). Si en algún momento se agrega
autenticación de usuarios de verdad, revisar esto junto con el punto de
RLS de arriba, no por separado.
- Esfuerzo: n/a, solo mantenerlo en mente.

---

## 2. Datos y escalabilidad

**🟡 Fotos en base64 dentro de `reports.photo`**
Cada fila carga la imagen completa codificada; `GET .../reports?select=*`
trae *todas* las fotos en cada refresh de 8s, para todos los reportes
activos. Migrar a Supabase Storage (subir el archivo, guardar solo la
URL en la fila) reduce el tamaño de cada fila y el payload de cada
refresco.
- Esfuerzo: medio.

**🟡 Sin límite/paginación en el fetch de reportes**
Se trae la tabla entera en cada poll; el filtrado por zona visible ya
existe pero es client-side (`renderVisibleMarkers`), el fetch trae todo
igual. No es un problema con el volumen actual, pero no escala si crece
mucho la cantidad de reportes activos simultáneos.
- Esfuerzo: medio.

**🟢 Polling de 8s en vez de Supabase Realtime**
Supabase soporta suscripciones en tiempo real sobre la tabla `reports`;
reemplazar el `setInterval(refreshReports, 8000)` por una suscripción
bajaría la latencia de "ver un reporte nuevo" y el tráfico redundante de
polling constante.
- Esfuerzo: medio-alto, cambio de patrón — no crítico hoy.

---

## 3. Producto y funcionalidad

**🟡 Editar (no solo borrar) un reporte propio**
Hoy `getMine()` solo habilita "Eliminar" en el popup; permitir corregir
la nota o la categoría de un reporte recién publicado evitaría el ciclo
de borrar y volver a publicar por un error de tipeo.
- Esfuerzo: bajo-medio.

**🟢 Colapsar notificaciones push repetidas**
Documentado como decisión consciente de no hacerlo todavía ("sin volumen
real de suscriptores para que el ruido sea un dolor real") — repriorizar
si empieza a haber varios reportes cercanos en poco tiempo y empiezan a
quejarse los usuarios.
- Esfuerzo: medio.

**🟢 Imagen OG dinámica por reporte**
El preview por WhatsApp/Twitter reusa `icon-512.png` genérico en vez de
un thumbnail del mapa centrado en el reporte — quedó fuera de alcance a
propósito al construir el preview dinámico, por simplicidad. Mejora
cosmética, no urgente.
- Esfuerzo: medio-alto.

---

## 4. Accesibilidad

**✅ `admin.html` sin `aria-label` — resuelto**
Se etiquetaron los botones de acción (entrar, guardar, cerrar sesión) y,
más importante, el botón "Eliminar" por fila de la tabla de reportes
(antes eran varios botones idénticos sin contexto para un lector de
pantalla — ahora dicen "Eliminar reporte de <categoría>"). También se
agregó `alt="Foto del reporte"` a la miniatura y texto oculto
(`.sr-only`) a las dos columnas de la tabla sin encabezado visible
(foto/acciones).

**🟢 Soporte de teclado para elegir ubicación en el reporte manual**
El picker de ubicación sigue dependiendo de un click en el mapa; una
alternativa por dirección/buscador serviría para quien no puede
interactuar con el mapa táctil.
- Esfuerzo: medio.

---

## 5. Calidad y DX

**🟡 Cero tests, cero CI**
No hay `.github/workflows` ni suite de tests en el repo. El proyecto ya
tiene lógica no trivial (RLS, Edge Functions, trigger de notificaciones,
panel admin) que se puede romper en silencio con un cambio sin querer.
Un smoke test automatizado en cada push a `main` (ej. GitHub Actions
corriendo un check básico contra la app desplegada, o el mismo flujo de
Playwright que se usó manualmente para validar `admin.html` en esta
sesión) evitaría regresiones que hoy solo se detectan probando a mano.
- Esfuerzo: medio.

**🟢 Vigilar que `server.js` no vuelva a acumular lógica de API**
Hoy `server.js` es puro servidor de archivos estáticos para desarrollo
local (correcto, documentado) — si en el futuro alguien le vuelve a
agregar rutas `/api/*` sin querer, diverge silenciosamente del modelo
real en Supabase. No es un problema actual, solo un riesgo a vigilar en
PRs futuros.
- Esfuerzo: n/a, solo revisión.

---

## Orden sugerido

1. ~~`aria-label` en `admin.html`~~ ✅ hecho
2. ~~Rate-limit persistente de `admin-login`~~ ✅ hecho
3. Fotos a Supabase Storage (impacto directo en performance del refresh)
4. Editar reporte propio
5. Smoke test / CI básico
6. Evaluar mediar el DELETE de reportes con lógica propia (el ítem de
   seguridad más grande, pero también el de mayor esfuerzo — requiere
   decisión de producto sobre autenticación real antes de encararlo)
7. Resto (Realtime, paginación, imagen OG dinámica, notificaciones
   colapsadas, teclado en el picker)
