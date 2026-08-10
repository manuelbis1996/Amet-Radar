// Stub mínimo de MapLibre GL para poder probar la lógica de amet-radar.html
// en este sandbox, donde el CDN real (unpkg) y los tiles de OpenFreeMap
// están bloqueados por red. Solo implementa lo que usa la app; no dibuja
// ningún mapa. Reemplaza al leaflet-stub.js que se usaba antes del cambio.
(function(){
  function Evented(){ this._ev = {}; }
  Evented.prototype.on = function(name, fn){
    (this._ev[name] = this._ev[name] || []).push(fn);
    return this;
  };
  Evented.prototype.off = function(name, fn){
    if(this._ev[name]) this._ev[name] = this._ev[name].filter(f => f !== fn);
    return this;
  };
  Evented.prototype.fire = function(name, arg){
    (this._ev[name] || []).slice().forEach(fn => fn(arg));
    return this;
  };

  function Map(opts){
    Evented.call(this);
    const self = this;
    this._opts = opts;
    this._zoom = opts.zoom;
    this._center = { lng: opts.center[0], lat: opts.center[1] };
    this._container = document.getElementById(opts.container);
    this._calls = []; // registro de jumpTo/panTo/easeTo/flyTo para los asserts
    this.touchZoomRotate = { disableRotation(){ self._rotationDisabled = true; } };
    window.__map = this;
    // Desde v17.0 la app suelta el loader de arranque en el evento 'load' del
    // mapa, en vez de esperar al GPS. Sin esto el stub nunca lo dispararía y
    // toda esa lógica quedaría sin probar (y el loader tapando la pantalla en
    // las suites). Se puede desactivar con window.__mapNoLoad = true para
    // simular el caso real de "el estilo nunca carga", que es lo que cubre el
    // tope de seguridad.
    setTimeout(function(){ if(!window.__mapNoLoad) self.fire('load'); }, 0);
  }
  Map.prototype = Object.create(Evented.prototype);
  Map.prototype.getZoom = function(){ return this._zoom; };
  Map.prototype.getCenter = function(){ return this._center; };
  Map.prototype.getContainer = function(){ return this._container; };
  Map.prototype.getBounds = function(){
    // bbox alrededor de Santo Domingo; los tests lo pueden cambiar con
    // window.__bounds para probar el filtrado por zona visible.
    const b = window.__bounds || { n: 18.60, s: 18.36, e: -69.80, w: -70.06 };
    return { getNorth: () => b.n, getSouth: () => b.s, getEast: () => b.e, getWest: () => b.w };
  };
  ['jumpTo','easeTo','flyTo'].forEach(function(m){
    Map.prototype[m] = function(arg){
      this._calls.push([m, arg]);
      if(arg && arg.zoom != null) this._zoom = arg.zoom;
      if(arg && arg.center){
        this._center = Array.isArray(arg.center)
          ? { lng: arg.center[0], lat: arg.center[1] }
          : arg.center;
      }
      return this;
    };
  });
  Map.prototype.addControl = function(ctrl, pos){
    (this._controls = this._controls || []).push({ ctrl: ctrl, pos: pos });
    return this;
  };
  Map.prototype.panTo = function(ll){
    this._calls.push(['panTo', ll]);
    if(Array.isArray(ll)) this._center = { lng: ll[0], lat: ll[1] };
    return this;
  };

  function Marker(opts){
    this._el = opts && opts.element;
    this._opts = opts || {};
    this._draggable = !!(opts && opts.draggable);
    this._anchor = opts && opts.anchor;
    this._lngLat = null;
    this._removed = false;
    (window.__markers = window.__markers || []).push(this);
  }
  // Se normaliza a {lng, lat}: el código de la app llama a setLngLat tanto
  // con un array [lng, lat] como con el objeto e.lngLat de un click.
  Marker.prototype.setLngLat = function(ll){
    this._lngLat = Array.isArray(ll) ? { lng: ll[0], lat: ll[1] } : { lng: ll.lng, lat: ll.lat };
    return this;
  };
  Marker.prototype.getLngLat = function(){ return this._lngLat; };
  Marker.prototype.addTo = function(map){
    this._map = map;
    // El contenedor sale del mapa al que se agrega, no de un id fijo: la app
    // usa #map pero el panel admin usa #admin-map, y con el id hardcodeado
    // los marcadores del panel no llegaban nunca al DOM.
    const host = (map && map.getContainer && map.getContainer()) || document.getElementById('map');
    if(this._el && host) host.appendChild(this._el);
    return this;
  };
  // El Marker real de MapLibre es Evented (dragend, drag, dragstart). La app
  // no lo usa —lee getLngLat() al confirmar— pero el panel admin sí engancha
  // 'dragend', y sin esto initAdminMap tiraba "pinMarker.on is not a
  // function" y el mapa del panel no se creaba nunca en las pruebas.
  Marker.prototype.on = function(name, fn){
    (this._ev = this._ev || {})[name] = (this._ev[name] || []).concat(fn);
    return this;
  };
  Marker.prototype.off = function(name, fn){
    if(this._ev && this._ev[name]) this._ev[name] = this._ev[name].filter(f => f !== fn);
    return this;
  };
  // Para que un test pueda simular que el usuario arrastró el pin.
  Marker.prototype.fire = function(name, arg){
    ((this._ev && this._ev[name]) || []).slice().forEach(fn => fn(arg));
    return this;
  };
  Marker.prototype.setDraggable = function(v){ this._draggable = !!v; return this; };

  Marker.prototype.remove = function(){
    this._removed = true;
    if(this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
    const i = window.__markers.indexOf(this);
    if(i >= 0) window.__markers.splice(i, 1);
    return this;
  };

  function AttributionControl(opts){ this._opts = opts || {}; }

  window.maplibregl = { Map: Map, Marker: Marker, AttributionControl: AttributionControl };
})();
