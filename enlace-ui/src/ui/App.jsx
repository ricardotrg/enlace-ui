import React, { useEffect, useRef, useState } from "react";
import L from "leaflet";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const API_BASE = "";

export default function App() {
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const polyRef = useRef(null);
  const STALE_MS = 120000; // 2 min

  const [estado, setEstado] = useState("Desconectado");
  const [badgeClass, setBadgeClass] = useState("down");
  const [fix, setFix] = useState(null);
  const [deviceId, setDeviceId] = useState("");
  const [seguir, setSeguir] = useState(true);
  const [hours, setHours] = useState(24);
  const [agoText, setAgoText] = useState("-");
  const [showTrail, setShowTrail] = useState(false);
  const [trailBusy, setTrailBusy] = useState(false);
  
  // Toast notification state
  const [toast, setToast] = useState({ show: false, message: "", icon: "" });
  
  // Mirror expiration settings
  const [showMirrorSettings, setShowMirrorSettings] = useState(false);
  const [mirrorExpirationHours, setMirrorExpirationHours] = useState(null); // null = backend default (12h)
  
  // Panel collapse state
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(false);
  
  // Debug: Track seguir state changes
  useEffect(() => {
    console.log('🎯 seguir state changed:', {
      newValue: seguir,
      timestamp: new Date().toISOString()
    });
  }, [seguir]);
  const MX_TZ = "America/Mexico_City";
  const fmtLocal = (iso) =>
    new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: MX_TZ })
      .format(new Date(iso));

  const sseRef = useRef(null);
  const pollRef = useRef(null);
  const ONLINE_COLOR = "#1fa21f";   // verde
  const OFFLINE_COLOR = "#8a8f99";  // gris

  const arrowIcon = (headingDeg = 0, online = true) =>
    L.divIcon({
      className: "truck-arrow",
      html: `
      <svg width="36" height="36" viewBox="0 0 48 48" style="transform: rotate(${headingDeg}deg); transition: transform 0.3s ease;">
        <polygon points="24,4 38,36 24,30 10,36"
          fill="${online ? ONLINE_COLOR : OFFLINE_COLOR}"
          stroke="rgba(0,0,0,.5)"
          stroke-width="1.5"
          stroke-linejoin="round"
          style="filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4))" />
      </svg>`,
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });

  // ▼ Estado para "Mis dispositivos"
  const [devices, setDevices] = useState([]);                 // [{id, traccarDeviceId}]
  const [selected, setSelected] = useState(new Set());        // set de traccarDeviceId
  const sourcesMultiRef = useRef(new Map());                  // traccarDeviceId -> EventSource
  const markersMultiRef = useRef(new Map());                  // traccarDeviceId -> Marker
  const lastFixRef = useRef(null);
  const animRef = useRef(null);
  
  // ▼ Flag to prevent auto-stop when programmatically moving map
  const programmaticMoveRef = useRef(false);
  
  // ▼ Estado de conexión para el pill
  const [connectionStatus, setConnectionStatus] = useState("connecting"); // connecting, online, reconnecting, down
  const [lastUpdateTime, setLastUpdateTime] = useState(null);
  
  // ▼ Estado de conexión por dispositivo: Map<traccarDeviceId, {status, lastUpdate}>
  const [deviceStatuses, setDeviceStatuses] = useState(new Map());
  
  // ▼ Datos GPS del dispositivo seleccionado: Map<traccarDeviceId, gpsData>
  const [deviceGpsData, setDeviceGpsData] = useState(new Map());

  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpHeading = (a, b, t) => {
    // interpola el ángulo por el camino corto
    let d = ((b - a + 540) % 360) - 180;
    return (a + d * t + 360) % 360;
  };

  function animateTo(target, durationMs = 1000) {
    if (!markerRef.current || !mapRef.current) return;

    const start = lastFixRef.current || {
      lat: target.lat,
      lon: target.lon,
      headingDeg: target.headingDeg ?? 0,
    };
    const t0 = performance.now();

    // cancela animación previa
    if (animRef.current) cancelAnimationFrame(animRef.current);

    const step = (now) => {
      const t = Math.min(1, (now - t0) / durationMs);
      const lat = lerp(start.lat, target.lat, t);
      const lon = lerp(start.lon, target.lon, t);
      const hdg = lerpHeading(start.headingDeg ?? 0, target.headingDeg ?? 0, t);

      markerRef.current.setLatLng([lat, lon]);
      // reusa tu icono pero con heading interpolado
      markerRef.current.setIcon(arrowIcon(hdg, true));

      if (seguir && t < 1) {
        // seguimiento suave del mapa
        mapRef.current.flyTo([lat, lon], mapRef.current.getZoom(), { duration: 0.25, animate: true });
      }

      if (t < 1) {
        animRef.current = requestAnimationFrame(step);
      } else {
        lastFixRef.current = { lat: target.lat, lon: target.lon, headingDeg: target.headingDeg ?? 0 };
      }
    };

    animRef.current = requestAnimationFrame(step);
  }

  // Show toast notification
  const showToast = (message, icon = "✓") => {
    setToast({ show: true, message, icon });
    setTimeout(() => {
      setToast({ show: false, message: "", icon: "" });
    }, 2000);
  };

  async function crearEspejo(id) {
    const payload = { traccarDeviceId: Number(id) };
    if (mirrorExpirationHours !== null) {
      payload.expirationHours = mirrorExpirationHours;
    }
    
    const r = await fetch(`${API_BASE}/api/mirror`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error("Error creando enlace");
    const data = await r.json();
    const url = `${window.location.origin}/mirror.html?token=${data.token}`;
    
    // Copy to clipboard
    try {
      await navigator.clipboard.writeText(url);
      console.log('✅ Link copied to clipboard:', url);
      showToast("Enlace copiado al portapapeles", "✓");
    } catch (err) {
      console.error('❌ Failed to copy to clipboard:', err);
      showToast("Error al copiar enlace", "✗");
    }
  }

  useEffect(() => {
    const map = L.map("map").setView([19.243, -103.726], 12);
    map.zoomControl.setPosition("bottomleft");
    mapRef.current = map;

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
    }).addTo(map);
    

    polyRef.current = L.polyline([], { weight: 4, opacity: 0.8 }).addTo(map);

    const stopFollow = () => {
      // Don't stop if we're programmatically moving the map
      if (programmaticMoveRef.current) {
        console.log('⏸️ Ignoring stopFollow - programmatic move in progress');
        return;
      }
      console.log('🛑 stopFollow triggered by user interaction');
      setSeguir(false);
    };
    map.on("dragstart", stopFollow);
    map.on("zoomstart", stopFollow);

    return () => {
      map.off("dragstart", stopFollow);
      map.off("zoomstart", stopFollow);
      if (mapRef.current) mapRef.current.remove();
      if (sseRef.current) sseRef.current.close();
      if (pollRef.current) clearInterval(pollRef.current);
      // limpiar multi
      for (const [, es] of sourcesMultiRef.current) try { es.close(); } catch {}
      sourcesMultiRef.current.clear();
      for (const [, m] of markersMultiRef.current) try { map.removeLayer(m); } catch {}
      markersMultiRef.current.clear();
      
    };
  }, []);

  useEffect(() => {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap";
  document.head.appendChild(link);
  return () => { try { document.head.removeChild(link); } catch {} };
}, []);

  // Cargar dispositivos del usuario
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/client/devices`, { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const list = await r.json();
        setDevices(list || []);
      } catch {
        setDevices([]);
      }
    })();
  }, []);

  const actualizarMarker = (lat, lon, headingDeg, online) => {
    const map = mapRef.current;
    if (!markerRef.current) {
      markerRef.current = L.marker([lat, lon], {
        icon: arrowIcon(headingDeg, online),
        zIndexOffset: 1000,
      }).addTo(map);
      map.setView([lat, lon], 15);
      lastFixRef.current = { lat, lon, headingDeg: headingDeg ?? 0 };
      return;
    }
    // usa animación en lugar de salto
    animateTo({ lat, lon, headingDeg });
    if (seguir && !animRef.current) {
      map.flyTo([lat, lon], Math.max(map.getZoom(), 15), { duration: 0.5, animate: true });
    }
  };
  const onFix = (data) => {
    const nowIso = new Date().toISOString();
    const online = true;

    console.log('📦 Datos GPS recibidos:', data);
    console.log('📦 Campos disponibles:', Object.keys(data));

    const merged = { ...data, receivedAt: nowIso };
    setFix(merged);

    actualizarMarker(data.lat, data.lon, data.headingDeg ?? 0, online);

    setEstado(online ? "En línea" : "Sin señal");
    setBadgeClass(online ? "ok" : "stale");

    if (showTrail && polyRef.current) {
      const pts = polyRef.current.getLatLngs();
      pts.push([data.lat, data.lon]);
      polyRef.current.setLatLngs(pts);
    }
  };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const startPollingFallback = (idParam) => {
    stopPolling();
    const url = idParam
      ? `${API_BASE}/api/admin/live?traccarDeviceId=${encodeURIComponent(idParam)}`
      : `${API_BASE}/api/admin/live`;
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(url);
        if (r.status === 204) return;
        if (!r.ok) throw new Error("HTTP " + r.status);
        const data = await r.json();
        onFix(data);
      } catch {
        setEstado("Reconectando…");
        setBadgeClass("stale");
      }
    }, 5000);
  };

  const clearTrail = () => {
    if (polyRef.current) polyRef.current.setLatLngs([]);
  };

  const loadTrail = async (idQ, h) => {
    if (!idQ || !polyRef.current) return;
    setTrailBusy(true);
    
    const url = `${API_BASE}/api/admin/trail?deviceId=${encodeURIComponent(idQ)}&hours=${encodeURIComponent(h)}`;
    console.log('🚗 Loading trail with data:', {
      deviceId: idQ,
      hours: h,
      url: url,
      timestamp: new Date().toISOString()
    });
    
    try {
      const tr = await fetch(url);
      console.log('📡 Trail request response:', {
        status: tr.status,
        statusText: tr.statusText,
        ok: tr.ok,
        url: tr.url
      });
      
      if (tr.ok) {
        const body = await tr.json();
        console.log('📍 Trail data received:', {
          pointCount: body.trail?.length || 0,
          trailData: body,
          deviceId: idQ
        });
        polyRef.current.setLatLngs((body.trail || []).map(p => [p.lat, p.lon]));
      } else {
        console.error('❌ Trail request failed:', {
          status: tr.status,
          statusText: tr.statusText,
          deviceId: idQ,
          hours: h
        });
      }
    } catch (error) {
      console.error('🔥 Trail request error:', {
        error: error.message,
        deviceId: idQ,
        hours: h,
        timestamp: new Date().toISOString()
      });
    } finally {
      setTrailBusy(false);
    }
  };

  const conectar = async () => {
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    stopPolling();

    setEstado("Conectando…");
    setBadgeClass("stale");

    if (!showTrail) clearTrail();

    const idParam = (deviceId || "").trim();
    const initUrl = idParam
      ? `${API_BASE}/api/admin/live?traccarDeviceId=${encodeURIComponent(idParam)}`
      : `${API_BASE}/api/admin/live`;

    try {
      const r = await fetch(initUrl);
      if (r.ok) {
        const d = await r.json();
        onFix(d);
        const idQ = (idParam || d?.deviceId || "").toString();
        if (showTrail) await loadTrail(idQ, hours); else clearTrail();
      }
    } catch (err) {
      console.error("Error inicial obteniendo fix:", err);
    }

    const streamUrl = idParam
      ? `${API_BASE}/api/admin/live/stream?traccarDeviceId=${encodeURIComponent(idParam)}`
      : `${API_BASE}/api/admin/live/stream`;

    const ev = new EventSource(streamUrl);
    sseRef.current = ev;

    ev.addEventListener("open", () => {
      setEstado("Conectado");
      setBadgeClass("ok");
    });
    ev.addEventListener("position", (e) => {
      try {
        onFix(JSON.parse(e.data));
      } catch {}
    });
    ev.addEventListener("status", (e) => {
      try {
        const s = JSON.parse(e.data)?.state || "reconnecting";
        setEstado(s === "reconnecting" ? "Reconectando…" : "En línea");
        setBadgeClass(s === "reconnecting" ? "stale" : "ok");
      } catch {}
    });
    ev.onerror = () => {
      ev.close();
      setEstado("Reconectando…");
      setBadgeClass("stale");
      startPollingFallback(idParam);
    };
  };

  const toggleSeguir = (e) => {
    const v = e.target.checked;
    console.log('🔄 toggleSeguir called:', {
      newValue: v,
      currentSeguirState: seguir,
      eventTarget: e.target,
      eventTargetChecked: e.target.checked,
      mapRefExists: !!mapRef.current,
      markersCount: markersMultiRef.current.size,
      timestamp: new Date().toISOString()
    });
    
    setSeguir(v);
    console.log('✅ setSeguir called with:', v);
    
    if (v && markersMultiRef.current.size > 0 && mapRef.current) {
      // Follow the first selected device
      const firstMarker = markersMultiRef.current.values().next().value;
      console.log('📍 First marker found:', {
        exists: !!firstMarker,
        latLng: firstMarker ? firstMarker.getLatLng() : null
      });
      
      if (firstMarker) {
        const latLng = firstMarker.getLatLng();
        
        // Set flag to prevent stopFollow from firing during programmatic move
        programmaticMoveRef.current = true;
        console.log('🔒 Setting programmaticMoveRef to true');
        
        mapRef.current.setView([latLng.lat, latLng.lng], Math.max(mapRef.current.getZoom(), 15));
        console.log('🗺️ Map view updated to follow vehicle');
        
        // Clear flag after a short delay (map animation completes)
        setTimeout(() => {
          programmaticMoveRef.current = false;
          console.log('🔓 Cleared programmaticMoveRef');
        }, 500);
      }
    } else {
      console.log('⚠️ Not following - conditions not met:', {
        v,
        markersCount: markersMultiRef.current.size,
        mapExists: !!mapRef.current
      });
    }
  };

  const humanAgo = (iso) => {
    const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (secs < 60) return `hace ${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `hace ${mins} min`;
    const hrs = Math.floor(mins / 60);
    return `hace ${hrs} h ${mins % 60} min`;
  };

  const getStatusLabel = () => {
    if (!lastUpdateTime) return "CONECTANDO...";
    const timeSinceUpdate = Date.now() - lastUpdateTime;
    const timeStr = humanAgo(new Date(lastUpdateTime).toISOString());
    
    switch(connectionStatus) {
      case "online":
        return `EN LÍNEA — ${timeStr}`;
      case "connecting":
        return "CONECTANDO...";
      case "reconnecting":
        return `RECONECTANDO — ${timeStr}`;
      case "down":
        return `SIN SEÑAL — ${timeStr}`;
      default:
        return "CONECTANDO...";
    }
  };

  const getDeviceStatus = (traccarDeviceId) => {
    const statusData = deviceStatuses.get(traccarDeviceId);
    if (!statusData) return "never"; // Never connected
    return statusData.status;
  };

  useEffect(() => {
    if (!fix?.receivedAt) { setAgoText("-"); return; }

    const update = () => {
      const secs = Math.max(0, Math.floor((Date.now() - new Date(fix.receivedAt).getTime()) / 1000));
      if (secs < 60) setAgoText(`hace ${secs}s`);
      else {
        const mins = Math.floor(secs / 60);
        if (mins < 60) setAgoText(`hace ${mins} min`);
        else {
          const hrs = Math.floor(mins / 60);
          setAgoText(`hace ${hrs} h ${mins % 60} min`);
        }
      }
      if (Date.now() - new Date(fix.receivedAt).getTime() > STALE_MS) {
        setEstado("Sin señal");
        setBadgeClass("stale");
      } else {
        setEstado("En línea");
        setBadgeClass("ok");
      }
    };

    update();
    const t = setInterval(update, 15000);
    return () => clearInterval(t);
  }, [fix?.receivedAt]);

  // Monitor connection status based on last update time
  useEffect(() => {
    if (!lastUpdateTime) return;
    
    const checkStatus = () => {
      const timeSinceUpdate = Date.now() - lastUpdateTime;
      if (timeSinceUpdate > 120000) { // 2 minutes
        setConnectionStatus("down");
      }
    };
    
    const interval = setInterval(checkStatus, 5000);
    return () => clearInterval(interval);
  }, [lastUpdateTime]);

  // Force re-render every second to update "hace Xs" text
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!lastUpdateTime || selected.size === 0) return;
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, [lastUpdateTime, selected.size]);

  // Monitor all device statuses and mark as down if stale
  useEffect(() => {
    const checkAllStatuses = () => {
      setDeviceStatuses(prev => {
        const next = new Map(prev);
        let hasChanges = false;
        
        for (const [deviceId, statusData] of next.entries()) {
          if (statusData.lastUpdate && statusData.status === "online") {
            const timeSinceUpdate = Date.now() - statusData.lastUpdate;
            if (timeSinceUpdate > 120000) { // 2 minutes
              next.set(deviceId, { ...statusData, status: "down" });
              hasChanges = true;
            }
          }
        }
        
        return hasChanges ? next : prev;
      });
    };
    
    const interval = setInterval(checkAllStatuses, 5000);
    return () => clearInterval(interval);
  }, []);

  // Helpers multi-marcadores
  const upsertMultiMarker = (traccarDeviceId, lat, lon, headingDeg = 0) => {
    const map = mapRef.current;
    let mk = markersMultiRef.current.get(traccarDeviceId);
    if (!mk) {
      mk = L.marker([lat, lon], { icon: arrowIcon(headingDeg, true), zIndexOffset: 1500 }).addTo(map);
      markersMultiRef.current.set(traccarDeviceId, mk);
    } else {
      mk.setLatLng([lat, lon]);
      mk.setIcon(arrowIcon(headingDeg, true));
    }
    
    // Update connection status for this specific device
    setDeviceStatuses(prev => {
      const next = new Map(prev);
      next.set(traccarDeviceId, { status: "online", lastUpdate: Date.now() });
      return next;
    });
    
    // Update general connection status
    setConnectionStatus("online");
    setLastUpdateTime(Date.now());
    
    // If following is enabled and this is the first selected device, center map on it
    if (seguir && selected.size >= 1 && Array.from(selected)[0] === traccarDeviceId) {
      map.flyTo([lat, lon], Math.max(map.getZoom(), 15), { duration: 0.5, animate: true });
    }
  };

  const removeMultiMarker = (traccarDeviceId) => {
    const map = mapRef.current;
    const mk = markersMultiRef.current.get(traccarDeviceId);
    if (mk) {
      map.removeLayer(mk);
      markersMultiRef.current.delete(traccarDeviceId);
    }
  };

  const subscribeDevice = async (traccarDeviceId) => {
    if (sourcesMultiRef.current.has(traccarDeviceId)) return;

    // Set device status to connecting
    setDeviceStatuses(prev => {
      const next = new Map(prev);
      next.set(traccarDeviceId, { status: "connecting", lastUpdate: null });
      return next;
    });
    
    setConnectionStatus("connecting");
    
    try {
      const r = await fetch(`${API_BASE}/api/admin/live?traccarDeviceId=${encodeURIComponent(traccarDeviceId)}`);
      if (r.ok) {
        const d = await r.json();
        console.log('📦 Datos GPS iniciales:', d);
        console.log('📦 Campos disponibles:', Object.keys(d));
        
        // Store GPS data
        setDeviceGpsData(prev => {
          const next = new Map(prev);
          next.set(traccarDeviceId, d);
          return next;
        });
        
        upsertMultiMarker(traccarDeviceId, d.lat, d.lon, d.headingDeg ?? 0);
        if (selected.size <= 1 && mapRef.current) {
          mapRef.current.setView([d.lat, d.lon], Math.max(mapRef.current.getZoom(), 14));
        }
      }
    } catch {
      setDeviceStatuses(prev => {
        const next = new Map(prev);
        next.set(traccarDeviceId, { status: "down", lastUpdate: Date.now() });
        return next;
      });
      setConnectionStatus("down");
    }

    const es = new EventSource(`${API_BASE}/api/admin/live/stream?traccarDeviceId=${encodeURIComponent(traccarDeviceId)}`);
    sourcesMultiRef.current.set(traccarDeviceId, es);

    es.addEventListener("open", () => {
      setConnectionStatus("online");
    });
    
    es.addEventListener("position", (e) => {
      try {
        const d = JSON.parse(e.data);
        console.log('📦 Datos GPS recibidos (multi-device):', d);
        console.log('📦 Campos disponibles:', Object.keys(d));
        
        // Store GPS data
        setDeviceGpsData(prev => {
          const next = new Map(prev);
          next.set(traccarDeviceId, d);
          return next;
        });
        
        upsertMultiMarker(traccarDeviceId, d.lat, d.lon, d.headingDeg ?? 0);
      } catch {}
    });
    
    es.onerror = () => {
      setDeviceStatuses(prev => {
        const next = new Map(prev);
        next.set(traccarDeviceId, { status: "reconnecting", lastUpdate: Date.now() });
        return next;
      });
      setConnectionStatus("reconnecting");
      try { es.close(); } catch {}
      sourcesMultiRef.current.delete(traccarDeviceId);
    };
  };

  const unsubscribeDevice = (traccarDeviceId) => {
    const es = sourcesMultiRef.current.get(traccarDeviceId);
    if (es) { try { es.close(); } catch {} sourcesMultiRef.current.delete(traccarDeviceId); }
    removeMultiMarker(traccarDeviceId);
  };

  const onToggleDevice = (traccarDeviceId, checked) => {
    const next = new Set(selected);
    if (checked) {
      next.add(traccarDeviceId);
      setSelected(next);
      subscribeDevice(traccarDeviceId);
    } else {
      next.delete(traccarDeviceId);
      setSelected(next);
      unsubscribeDevice(traccarDeviceId);
    }
  };

  // Helper para convertir grados a dirección cardinal
  const getCardinalDirection = (degrees) => {
    if (degrees === null || degrees === undefined) return 'N/A';
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
    const index = Math.round(((degrees % 360) / 45)) % 8;
    return directions[index];
  };

  return (
    <>
      {/* Vista en Vivo - Solo visible cuando hay dispositivos seleccionados */}
      {selected.size > 0 && (() => {
        const firstSelectedId = Array.from(selected)[0];
        const gpsData = selected.size === 1 ? deviceGpsData.get(firstSelectedId) : null;
        
        console.log('🎬 Vista render:', {
          selectedSize: selected.size,
          firstSelectedId,
          hasGpsData: !!gpsData,
          isVisible: selected.size > 0
        });
        
        return (
          <div 
            id="panel-control-principal" 
            style={{ 
              fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
              position: "fixed",
              bottom: "20px",
              left: "50%",
              transform: `translateX(-50%) translateY(${selected.size > 0 ? '0' : '150%'})`,
              background: "rgba(255,255,255,0.92)",
              backdropFilter: "blur(12px)",
              padding: "12px 16px",
              borderRadius: "12px",
              boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
              zIndex: 1000,
              minWidth: "700px",
              maxWidth: "900px",
              transition: "transform 500ms cubic-bezier(0.34, 1.56, 0.64, 1)",
              opacity: 1,
              animation: "slideUpFade 500ms cubic-bezier(0.34, 1.56, 0.64, 1)"
            }}
          >
            {/* Row 1: Header with status + GPS data (if single device) */}
            <div style={{ 
              display: "flex", 
              alignItems: "center", 
              gap: "20px",
              marginBottom: "10px",
              paddingBottom: "10px",
              borderBottom: "1px solid rgba(226, 232, 240, 0.6)"
            }}>
              {/* Title + Status */}
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <h2 style={{ margin: 0, fontSize: "15px", fontWeight: 600, color: "#2c3e50" }}>Vista en Vivo</h2>
                <div className={`status-pill-inline pill-${connectionStatus}`}>
                  <span className={`pill-dot ${connectionStatus === 'online' ? 'blink' : connectionStatus === 'reconnecting' ? 'blink-fast' : ''}`}></span>
                  <span>{getStatusLabel()}</span>
                </div>
              </div>

              {/* GPS Telemetry - Only if single device */}
              {gpsData && (
                <>
                  <div style={{ width: "1px", height: "40px", background: "rgba(226, 232, 240, 0.6)" }}></div>
                  
                  {/* Speed */}
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: "9px", color: "#64748b", fontWeight: 600, letterSpacing: "0.5px" }}>VELOCIDAD</div>
                    <div style={{ fontSize: "24px", fontWeight: 700, color: "#1e40af", lineHeight: 1.2 }}>
                      {gpsData.speedKph}<span style={{ fontSize: "12px", fontWeight: 500 }}> km/h</span>
                    </div>
                  </div>

                  {/* Direction */}
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: "9px", color: "#64748b", fontWeight: 600, letterSpacing: "0.5px" }}>DIRECCIÓN</div>
                    <div style={{ fontSize: "18px", fontWeight: 600, color: "#334155", lineHeight: 1.2 }}>
                      {getCardinalDirection(gpsData.headingDeg)}
                      <div style={{ fontSize: "10px", color: "#64748b", fontWeight: 400 }}>{gpsData.headingDeg}°</div>
                    </div>
                  </div>

                  {/* Status */}
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: "9px", color: "#64748b", fontWeight: 600, letterSpacing: "0.5px" }}>ESTADO</div>
                    <div style={{ 
                      fontSize: "13px", 
                      fontWeight: 600,
                      color: gpsData.stale ? '#dc2626' : '#16a34a',
                      display: "flex",
                      alignItems: "center",
                      gap: "4px",
                      justifyContent: "center",
                      marginTop: "4px"
                    }}>
                      <div style={{
                        width: "6px",
                        height: "6px",
                        borderRadius: "50%",
                        background: gpsData.stale ? '#dc2626' : '#16a34a'
                      }}></div>
                      {gpsData.stale ? 'Stale' : 'OK'}
                    </div>
                  </div>

                  {/* Coordinates */}
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: "9px", color: "#64748b", fontWeight: 600, letterSpacing: "0.5px" }}>COORDENADAS</div>
                    <div style={{ 
                      fontSize: "10px", 
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      color: "#334155",
                      lineHeight: 1.3,
                      marginTop: "2px"
                    }}>
                      <div>{gpsData.lat.toFixed(5)}</div>
                      <div>{gpsData.lon.toFixed(5)}</div>
                    </div>
                  </div>

                  {/* Timestamp */}
                  <div style={{ fontSize: "9px", color: "#94a3b8", fontStyle: "italic" }}>
                    {new Date(gpsData.fixTime).toLocaleTimeString('es-MX')}
                  </div>
                </>
              )}
            </div>

            {/* Row 2: Controls */}
            <div style={{ 
              display: "flex", 
              alignItems: "center", 
              gap: "16px",
              flexWrap: "wrap"
            }}>
              {/* Toggle: Seguir vehículo */}
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", userSelect: "none" }}>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={(() => {
                      console.log('🔍 Rendering "Seguir vehículo" toggle, checked value:', seguir);
                      return seguir;
                    })()}
                    onChange={toggleSeguir}
                  />
                  <span className="toggle-slider"></span>
                </label>
                <span style={{ fontSize: "13px", fontWeight: 500 }}>Seguir vehículo</span>
              </label>

              <div style={{ width: "1px", height: "20px", background: "rgba(226, 232, 240, 0.6)" }}></div>

              {/* Toggle: Mostrar recorrido */}
              <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", userSelect: "none" }}>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={showTrail}
                    onChange={async (e) => {
                      const next = e.target.checked;
                      setShowTrail(next);
                      if (next && selected.size > 0) {
                        const firstSelectedId = Array.from(selected)[0];
                        await loadTrail(firstSelectedId.toString(), hours);
                      } else {
                        clearTrail();
                      }
                    }}
                  />
                  <span className="toggle-slider"></span>
                </label>
                <span style={{ fontSize: "13px", fontWeight: 500 }}>Mostrar recorrido</span>
              </label>

              {/* Trail Hours */}
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <label style={{ fontSize: "12px", color: "#64748b", fontWeight: 500 }}>Horas:</label>
                <input
                  type="number"
                  className="modern-input"
                  min="1"
                  max="168"
                  value={hours}
                  onChange={(e) => setHours(Number(e.target.value) || 24)}
                  disabled={!showTrail || trailBusy}
                  style={{ width: "55px" }}
                />
                <button
                  className="modern-btn"
                  onClick={async () => {
                    if (selected.size > 0) {
                      const firstSelectedId = Array.from(selected)[0];
                      await loadTrail(firstSelectedId.toString(), hours);
                    }
                  }}
                  disabled={!showTrail || trailBusy || selected.size === 0}
                  style={{ fontSize: "12px", padding: "5px 10px" }}
                >
                  Actualizar
                </button>
              </div>

              <div style={{ width: "1px", height: "20px", background: "rgba(226, 232, 240, 0.6)" }}></div>

              {/* Share button with settings */}
              <div className="mirror-settings-container" style={{ marginLeft: "auto" }}>
                <button
                  className="modern-btn"
                  onClick={() => {
                    const deviceIdToShare = selected.size === 1 
                      ? Array.from(selected)[0] 
                      : (selected.size > 0 ? Array.from(selected)[0] : 4);
                    crearEspejo(deviceIdToShare);
                  }}
                  disabled={selected.size === 0}
                  style={{ fontSize: "12px", padding: "5px 12px" }}
                >
                  🔗 Cuenta espejo
                </button>
                
                {/* Settings gear icon */}
                <span 
                  className="gear-icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowMirrorSettings(!showMirrorSettings);
                  }}
                  title="Configurar expiración"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1Z"/>
                  </svg>
                </span>
                
                {/* Settings popup */}
                {showMirrorSettings && (
                  <>
                    {/* Backdrop to close popup */}
                    <div 
                      style={{
                        position: "fixed",
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        zIndex: 10000
                      }}
                      onClick={() => setShowMirrorSettings(false)}
                    />
                    
                    <div className="mirror-settings-popup">
                      <div className="settings-label">Expiración del enlace</div>
                      <div className="settings-options">
                        <div 
                          className={`settings-option ${mirrorExpirationHours === 1 ? 'active' : ''}`}
                          onClick={() => {
                            setMirrorExpirationHours(1);
                            setShowMirrorSettings(false);
                          }}
                        >
                          <div className="settings-option-label">1 hora</div>
                        </div>
                        
                        <div 
                          className={`settings-option ${mirrorExpirationHours === 8 ? 'active' : ''}`}
                          onClick={() => {
                            setMirrorExpirationHours(8);
                            setShowMirrorSettings(false);
                          }}
                        >
                          <div className="settings-option-label">8 horas</div>
                        </div>
                        
                        <div 
                          className={`settings-option ${mirrorExpirationHours === null ? 'active' : ''}`}
                          onClick={() => {
                            setMirrorExpirationHours(null);
                            setShowMirrorSettings(false);
                          }}
                        >
                          <div className="settings-option-label">Por defecto</div>
                          <div className="settings-option-desc">12 horas</div>
                        </div>
                        
                        <div 
                          className={`settings-option ${mirrorExpirationHours === 24 ? 'active' : ''}`}
                          onClick={() => {
                            setMirrorExpirationHours(24);
                            setShowMirrorSettings(false);
                          }}
                        >
                          <div className="settings-option-label">24 horas</div>
                        </div>
                        
                        <div 
                          className={`settings-option ${mirrorExpirationHours === 48 ? 'active' : ''}`}
                          onClick={() => {
                            setMirrorExpirationHours(48);
                            setShowMirrorSettings(false);
                          }}
                        >
                          <div className="settings-option-label">48 horas</div>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      <div id="map"></div>

      {/* === PANEL FLOTANTE: Mis dispositivos === */}
      <div
        id="panel-dispositivos"
        style={{
          position: "fixed",
          top: "12px",
          left: "12px",
          width: "340px",
          maxHeight: "calc(100vh - 24px)",
          overflowY: "auto",
          background: "rgba(255,255,255,0.75)",
          backdropFilter: "blur(8px)",
          borderRadius: "12px",
          boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
          padding: "16px",
          fontSize: "14px",
          zIndex: 1000,
          fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
          transform: isPanelCollapsed ? "translateX(-355px)" : "translateX(0)",
          transition: "transform 400ms ease-in-out",
        }}
      >
      {/* ENLACE Wordmark - Top of panel */}
      <div style={{
        textAlign: "left",
        marginBottom: "12px",
        userSelect: "none",
      }}>
        <div style={{
          fontSize: "40px",
          fontFamily: "Impact, 'Arial Black', sans-serif",
          fontStyle: "italic",
          fontWeight: "900",
          color: "#059669",
          letterSpacing: "-0.02em",
          lineHeight: "1",
          filter: "drop-shadow(0 1px 3px rgba(16,185,129,0.4)) drop-shadow(0 1px 1px rgba(5,150,105,0.5))"
        }}>
          <span style={{ letterSpacing: "-0.02em" }}>E</span>
          <span style={{ marginLeft: "2px", letterSpacing: "-0.02em" }}>NLACE</span>
          <span style={{ 
            fontSize: "14px",
            fontWeight: "500",
            fontStyle: "normal",
            color: "#64748b",
            marginLeft: "8px",
            letterSpacing: "0.05em",
            filter: "none"
          }}>GPS</span>
        </div>
      </div>
      
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
        <b>Mis dispositivos</b>
        <button
          onClick={() => setIsPanelCollapsed(!isPanelCollapsed)}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: "18px",
            padding: "4px 8px",
            color: "#64748b",
            transition: "all 0.2s ease",
            borderRadius: "8px",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "#3b82f6";
            e.currentTarget.style.background = "rgba(59,130,246,0.08)";
            e.currentTarget.style.transform = "translateY(-1px)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "#64748b";
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.transform = "translateY(0)";
          }}
          title={isPanelCollapsed ? "Mostrar panel" : "Ocultar panel"}
        >
          {isPanelCollapsed ? "→" : "←"}
        </button>
      </div>
      <div style={{ marginTop: 6, border: "1px solid #ddd", borderRadius: "8px", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", whiteSpace: "nowrap" }}>
          <thead style={{ background: "#f7f7f7", position: "sticky", top: 0 }}>
            <tr>
              <th style={{ width: 30, textAlign: "center", padding: "6px 4px" }}></th>
              <th style={{ width: 50, textAlign: "center", padding: "6px 8px" }}>Ver</th>
              <th style={{ width: 90, textAlign: "left", padding: "6px 8px" }}>Traccar ID</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Nombre</th>
              <th style={{ width: 70, textAlign: "right", padding: "6px 8px" }}>Interno</th>
            </tr>
          </thead>
          <tbody>
            {devices.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: 8, opacity: 0.7 }}>Sin dispositivos</td>
              </tr>
            ) : (
              devices.map((d) => {
                const status = getDeviceStatus(d.traccarDeviceId);
                return (
                  <tr key={d.id} style={{ borderTop: "1px solid #eee" }}>
                    {/* Status dot */}
                    <td style={{ padding: "6px 4px", textAlign: "center" }}>
                      <span 
                        className={`device-status-dot status-${status} ${
                          status === 'online' ? 'blink' : 
                          status === 'reconnecting' ? 'blink-fast' : ''
                        }`}
                      ></span>
                    </td>
                    {/* Ver (checkbox) */}
                    <td style={{ padding: "6px 8px", textAlign: "center" }}>
                      <label className="ios-checkbox">
                        <input
                          type="checkbox"
                          checked={selected.has(d.traccarDeviceId)}
                          onChange={(e) => onToggleDevice(d.traccarDeviceId, e.target.checked)}
                        />
                        <span className="ios-checkbox-box"></span>
                      </label>
                    </td>
                    {/* Traccar ID */}
                    <td style={{ padding: "6px 8px" }}>{d.traccarDeviceId}</td>
                    {/* Nombre */}
                    <td style={{ padding: "6px 8px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {d.displayName || "(sin nombre)"}
                    </td>
                    {/* Interno */}
                    <td style={{ padding: "6px 8px", textAlign: "right", opacity: 0.7 }}>{d.id}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
        Marca varios para ver todos en el mapa.
      </div>
    </div>
    
    {/* Vertical Tab when panel is collapsed */}
    {isPanelCollapsed && (
      <div
        onClick={() => setIsPanelCollapsed(false)}
        style={{
          position: "fixed",
          top: "50%",
          left: "0px",
          transform: "translateY(-50%)",
          background: "rgba(255,255,255,0.9)",
          backdropFilter: "blur(8px)",
          padding: "16px 10px",
          borderRadius: "0 12px 12px 0",
          boxShadow: "2px 0 12px rgba(0,0,0,0.15)",
          cursor: "pointer",
          zIndex: 1000,
          transition: "all 0.3s ease",
          fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
          fontSize: "15px",
          fontWeight: "600",
          color: "#3b82f6",
          letterSpacing: "0.5px",
          writingMode: "vertical-rl",
          textOrientation: "mixed",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(59,130,246,0.1)";
          e.currentTarget.style.paddingLeft = "14px";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "rgba(255,255,255,0.9)";
          e.currentTarget.style.paddingLeft = "10px";
        }}
        title="Mostrar panel de dispositivos"
      >
        ← Dispositivos
      </div>
    )}
    {/* =============================================== */}

    {/* Toast Notification */}
    <div className={`toast ${toast.show ? 'show' : ''}`}>
      <span className="toast-icon">{toast.icon}</span>
      <span className="toast-message">{toast.message}</span>
    </div>

    </>
  );
}
