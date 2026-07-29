# Plan de Mejora — AMET Radar

Análisis del archivo `amet-radar.html`: app de reportes comunitarios de retenes/AMET sobre mapa Leaflet, con flujo de reporte (ubicación + foto obligatoria + nota) y almacenamiento compartido.

Prioridad: 🔴 Alta · 🟡 Media · 🟢 Baja

---

## 1. Arquitectura y datos

**🔴 Migrar de `window.storage` a un backend real**
Esta API solo funciona dentro del entorno de artifacts de Claude.ai. Para publicar la app en un dominio propio se necesita:
- Backend con base de datos (Supabase, Firebase, o API propia)
- Almacenamiento de imágenes en un bucket (S3, Cloudinary) en vez de base64 en la base de datos
- Esfuerzo: alto · Bloqueante para lanzamiento real.

**🔴 Rediseñar el modelo de lectura de reportes**
Hoy: `list()` + un `get()` por cada reporte cada 20s (N+1 queries).
Propuesta: guardar los reportes activos en una sola clave tipo `reports:activos` como array/objeto, actualizada al publicar/expirar, y leerla con una sola llamada. Reduce drásticamente las peticiones.
- Esfuerzo: medio.

**🟡 Limpieza automática de reportes vencidos**
Actualmente los reportes con `ageMinutes > MAX_AGE_MINUTES` solo se ocultan del mapa, nunca se borran del storage. Agregar una rutina (client-side al cargar, o job de backend) que haga `delete()` de los vencidos.
- Esfuerzo: bajo.

**🟢 Compresión de imagen más agresiva**
480px / calidad 0.6 está bien, pero conviene limitar tamaño máximo final (ej. rechazar/comprimir más si el resultado supera ~150KB) para no acercarse al límite de 5MB por clave con muchas fotos.
- Esfuerzo: bajo.

---

## 2. Producto y funcionalidad

**🔴 Confirmación comunitaria ("sigue ahí" / "ya no está")**
Sin esto, la confianza en los reportes se degrada rápido. Añadir botones de voto en el popup que ajusten un contador; con suficientes votos "ya no está" se elimina antes del `MAX_AGE_MINUTES`.
- Esfuerzo: medio.

**🟡 Categorías de reporte**
Hoy todo es un ícono fijo (👮). Agregar tipos: retén fijo, retén móvil, accidente, control de tránsito — con íconos y colores distintos, y filtro por tipo.
- Esfuerzo: medio.

**🟡 Filtrado por zona visible**
Cargar solo los reportes dentro del viewport/radio actual del mapa en vez de todos los activos. Importante en cuanto crezca el volumen de datos.
- Esfuerzo: medio.

**🟡 Gestión de reporte propio**
Permitir borrar o editar un reporte que el propio usuario acaba de publicar (ej. guardando su ID en localStorage/sessionStorage del dispositivo).
- Esfuerzo: bajo-medio.

**🟢 Límite de reportes por usuario/hora**
Prevención básica de spam o abuso, aunque sea heurística (ej. basada en dispositivo/IP en el backend).
- Esfuerzo: medio (requiere backend).

---

## 3. Confiabilidad y manejo de errores

**🔴 Manejo explícito de permiso de geolocalización denegado**
Hoy si el usuario rechaza el permiso, simplemente no pasa nada (`() => {}`). Mostrar un mensaje o mantener el centro por defecto con aviso.
- Esfuerzo: bajo.

**🟡 Estado de carga inicial del mapa/reportes**
No hay feedback visual mientras se cargan los primeros reportes. Agregar un loader breve.
- Esfuerzo: bajo.

**🟢 Reintento offline**
Si `publishReport` falla por falta de conexión, guardar el intento localmente y reintentar cuando vuelva la red.
- Esfuerzo: medio.

---

## 4. Accesibilidad y UI

**🟡 Contraste y etiquetas ARIA**
Revisar contraste de `--muted` (#9a9a9e) sobre fondo oscuro y añadir `aria-label` a botones de ícono (📍, cámara).
- Esfuerzo: bajo.

**🟢 Soporte de teclado en el flujo de reporte**
El picker de ubicación depende de clic en el mapa; considerar alternativa accesible (buscar dirección) para quienes no pueden interactuar con el mapa táctil.
- Esfuerzo: medio.

---

## 5. Distribución

**🟡 Convertir en PWA instalable**
Manifest + service worker para que funcione como app real en la calle (uso principal esperado: mientras se conduce). Incluye ícono, splash screen y modo standalone.
- Esfuerzo: medio.

**🟢 Compartir reporte individual (deep link)**
Generar un enlace que abra el mapa centrado en un reporte específico, útil para compartir por WhatsApp.
- Esfuerzo: bajo.

---

## Orden sugerido de implementación

1. Backend real + modelo de datos consolidado (base indispensable)
2. Limpieza automática de reportes vencidos
3. Confirmación comunitaria ("sigue ahí" / "ya no está")
4. Manejo de errores de geolocalización + estado de carga
5. Categorías de reporte + filtrado por zona
6. PWA instalable
7. Resto de mejoras de accesibilidad y pulido

---

## Estado de implementación (prueba local)

Las mejoras de las secciones 2, 3, 4 y 5 ya están implementadas en
`amet-radar.html` para pruebas locales, usando `localStorage` como
almacenamiento temporal en vez de un backend compartido (ver README.md).
El punto pendiente y bloqueante para producción sigue siendo migrar a un
backend real que sincronice reportes entre distintos usuarios/dispositivos.
