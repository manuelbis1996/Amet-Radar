// Stub mínimo de MapLibre GL para las pruebas.
//
// Por qué existe: el sandbox donde se corren estas pruebas bloquea tanto el
// CDN de unpkg como los tiles de OpenFreeMap, así que la librería real nunca
// carga y sin esto la app revienta en `new maplibregl.Map(...)` antes de
// ejecutar una sola línea del flujo que se quiere probar.
//
// Cubre SOLO la superficie que amet-radar.html realmente usa (sacada con
// grep del archivo): si algún día la app empieza a llamar a otro método del
// mapa, esto hay que ampliarlo o la prueba falla con "is not a function".
// NO intenta dibujar nada — el render visual no se verifica acá.
(function () {
  // Ojo: se usa un objeto plano y no un Map() nativo — más abajo se declara
  // `class StubMap`, y una clase llamada `Map` acá dentro sombrearía al Map
  // global por TDZ ("Cannot access 'Map' before initialization").
  const listeners = Object.create(null);

  function on(ev, fn) {
    (listeners[ev] || (listeners[ev] = [])).push(fn);
  }
  function off(ev, fn) {
    const arr = listeners[ev] || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
  function emitir(ev) { (listeners[ev] || []).forEach((f) => f()); }

  const container = document.createElement('div');

  class StubMap {
    constructor() {
      this.transform = {};
      this.touchZoomRotate = { disableRotation() {} };
      this._center = { lat: 19.2230, lng: -70.5290 };
      this._zoom = 12;
    }
    on(ev, fn) { on(ev, fn); return this; }
    off(ev, fn) { off(ev, fn); return this; }
    // Caja amplia alrededor de La Vega: así los reportes de prueba caen
    // siempre dentro del área "visible" y renderVisibleMarkers los dibuja.
    getBounds() {
      return {
        getNorth: () => this._center.lat + 0.05,
        getSouth: () => this._center.lat - 0.05,
        getEast:  () => this._center.lng + 0.05,
        getWest:  () => this._center.lng - 0.05
      };
    }
    getCenter() { return { ...this._center }; }
    getZoom() { return this._zoom; }
    getContainer() { return container; }
    addControl() { return this; }
    easeTo(o) { return this._move(o); }
    flyTo(o)  { return this._move(o); }
    jumpTo(o) { return this._move(o); }
    panTo(c)  { return this._move({ center: c }); }
    _move(o) {
      if (o && o.center) {
        const c = o.center;
        this._center = Array.isArray(c) ? { lng: c[0], lat: c[1] } : { lng: c.lng, lat: c.lat };
      }
      if (o && typeof o.zoom === 'number') this._zoom = o.zoom;
      emitir('moveend');
      return this;
    }
  }

  class Marker {
    constructor(opts) {
      this.opts = opts || {};
      this._el = this.opts.element || document.createElement('div');
      this._lngLat = { lng: 0, lat: 0 };
    }
    setLngLat(v) {
      this._lngLat = Array.isArray(v) ? { lng: v[0], lat: v[1] } : v;
      return this;
    }
    getLngLat() { return this._lngLat; }
    addTo() {
      // El elemento tiene que estar en el DOM: las pruebas cuentan pines con
      // selectores CSS, y el click en un pin abre la hoja de detalle.
      document.body.appendChild(this._el);
      return this;
    }
    remove() { if (this._el.parentNode) this._el.parentNode.removeChild(this._el); return this; }
    on() { return this; }
    setDraggable() { return this; }
  }

  class AttributionControl { onAdd() { return document.createElement('div'); } onRemove() {} }

  window.maplibregl = { Map: StubMap, Marker, AttributionControl };
})();
