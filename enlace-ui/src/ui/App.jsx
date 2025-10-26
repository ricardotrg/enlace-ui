import React, { useEffect, useRef, useState } from "react";
import L from "leaflet";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const API_BASE = "http://localhost:8080";

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

  // ▼ Estado para “Mis dispositivos”
  const [devices, setDevices] = useState([]);                 // [{id, traccarDeviceId}]
  const [selected, setSelected] = useState(new Set());        // set de traccarDeviceId
  const sourcesMultiRef = useRef(new Map());                  // traccarDeviceId -> EventSource
  const markersMultiRef = useRef(new Map());                  // traccarDeviceId -> Marker
  const lastFixRef = useRef(null);
  const animRef = useRef(null);

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

  async function crearEspejo(id) {
    const r = await fetch(`${API_BASE}/api/mirror`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ traccarDeviceId: Number(id) }),
    });
    if (!r.ok) throw new Error("Error creando enlace");
    const data = await r.json();
    const url = `${window.location.origin}/mirror.html?token=${data.token}`;
    window.prompt("Enlace espejo (copiar):", url);
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

    const stopFollow = () => setSeguir(false);
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
    setSeguir(v);
    if (v && markersMultiRef.current.size > 0 && mapRef.current) {
      // Follow the first selected device
      const firstMarker = markersMultiRef.current.values().next().value;
      if (firstMarker) {
        const latLng = firstMarker.getLatLng();
        mapRef.current.setView([latLng.lat, latLng.lng], Math.max(mapRef.current.getZoom(), 15));
      }
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

    try {
      const r = await fetch(`${API_BASE}/api/admin/live?traccarDeviceId=${encodeURIComponent(traccarDeviceId)}`);
      if (r.ok) {
        const d = await r.json();
        upsertMultiMarker(traccarDeviceId, d.lat, d.lon, d.headingDeg ?? 0);
        if (selected.size <= 1 && mapRef.current) {
          mapRef.current.setView([d.lat, d.lon], Math.max(mapRef.current.getZoom(), 14));
        }
      }
    } catch {}

    const es = new EventSource(`${API_BASE}/api/admin/live/stream?traccarDeviceId=${encodeURIComponent(traccarDeviceId)}`);
    sourcesMultiRef.current.set(traccarDeviceId, es);

    es.addEventListener("position", (e) => {
      try {
        const d = JSON.parse(e.data);
        upsertMultiMarker(traccarDeviceId, d.lat, d.lon, d.headingDeg ?? 0);
      } catch {}
    });
    es.onerror = () => {
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

  return (
    <>
      {/* Vista en Vivo - Solo visible cuando hay dispositivos seleccionados */}
      {selected.size > 0 && (
        <div 
          id="panel-control-principal" 
          className="panel" 
          style={{ 
            fontFamily: "Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
            position: "fixed",
            bottom: "20px",
            left: "50%",
            transform: "translateX(-50%)",
            top: "auto",
            zIndex: 1000
          }}
        >
          <h2 className="panel-title">Vista en Vivo</h2>

        {/* Control de Seguimiento Section */}
        <div className="panel-section">
          <h3 className="section-header">Control de Seguimiento</h3>
          <div className="control-group">
            <label className="inline" style={{ userSelect: "none" }}>
              <input
                type="checkbox"
                className="modern-checkbox"
                checked={seguir}
                onChange={toggleSeguir}
              />
              Seguir vehículo
            </label>

            <label className="inline" style={{ userSelect: "none" }}>
              <input
                type="checkbox"
                className="modern-checkbox"
                checked={showTrail}
                onChange={async (e) => {
                  const next = e.target.checked;
                  console.log('🛣️ Mostrar recorrido toggled:', {
                    enabled: next,
                    selectedDevices: Array.from(selected),
                    selectedDeviceCount: selected.size,
                    hours: hours,
                    timestamp: new Date().toISOString()
                  });
                  
                  setShowTrail(next);
                  if (next && selected.size > 0) {
                    const firstSelectedId = Array.from(selected)[0];
                    console.log('🔄 Loading trail for device:', firstSelectedId);
                    await loadTrail(firstSelectedId.toString(), hours);
                  } else {
                    console.log('🧹 Clearing trail (disabled or no devices selected)');
                    clearTrail();
                  }
                }}
              />
              Mostrar recorrido
            </label>

            <div className="control-row">
              <label style={{ fontSize: "13px", color: "#64748b" }}>Horas:</label>
              <input
                type="number"
                className="modern-input"
                min="1"
                max="168"
                value={hours}
                onChange={(e) => setHours(Number(e.target.value) || 24)}
                disabled={!showTrail || trailBusy}
              />
              <button
                className="modern-btn"
                onClick={async () => {
                  console.log('🔄 Actualizar trail button clicked:', {
                    selectedDevices: Array.from(selected),
                    selectedDeviceCount: selected.size,
                    customHours: hours,
                    showTrail: showTrail,
                    trailBusy: trailBusy,
                    timestamp: new Date().toISOString()
                  });
                  
                  if (selected.size > 0) {
                    const firstSelectedId = Array.from(selected)[0];
                    console.log('🎯 Updating trail for device:', {
                      deviceId: firstSelectedId,
                      hours: hours,
                      action: 'manual_update'
                    });
                    await loadTrail(firstSelectedId.toString(), hours);
                  } else {
                    console.warn('⚠️ Cannot update trail: no devices selected');
                  }
                }}
                disabled={!showTrail || trailBusy || selected.size === 0}
              >
                Actualizar
              </button>
            </div>
          </div>
        </div>

        {/* Estado del Sistema Section */}
        <div className="panel-section">
          <h3 className="section-header">Estado del Sistema</h3>
          {selected.size > 0 ? (
            <div className="status-grid">
              <div className="status-item">
                <div className="status-dot status-active"></div>
                <span>Dispositivos: {selected.size}</span>
              </div>
              <div className="status-item">
                <div className={`status-dot ${seguir ? 'status-active' : 'status-inactive'}`}></div>
                <span>Seguimiento</span>
              </div>
              <div className="status-item">
                <div className={`status-dot ${showTrail ? 'status-active' : 'status-inactive'}`}></div>
                <span>Recorrido</span>
              </div>
              {selected.size === 1 && (
                <div className="status-item">
                  <div className="status-dot status-active"></div>
                  <span>ID: {Array.from(selected)[0]}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="device-info">
              Selecciona dispositivos desde el panel izquierdo para activar controles
            </div>
          )}
        </div>

        {/* Compartir Section */}
        <div className="panel-section">
          <h3 className="section-header">Compartir</h3>
          <button
            className="modern-btn"
            onClick={() => {
              const deviceIdToShare = selected.size === 1 
                ? Array.from(selected)[0] 
                : (selected.size > 0 ? Array.from(selected)[0] : 4);
              crearEspejo(deviceIdToShare);
            }}
            disabled={selected.size === 0}
            style={{ width: "100%" }}
          >
            Crear cuenta espejo
          </button>
          {selected.size === 0 && (
            <div className="device-info" style={{ marginTop: 6 }}>
              Selecciona un dispositivo para compartir
            </div>
          )}
        </div>
      </div>
      )}

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
        }}
      >
      <b>Mis dispositivos</b>
      <div style={{ marginTop: 6, border: "1px solid #ddd", borderRadius: 6, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", whiteSpace: "nowrap" }}>
          <thead style={{ background: "#f7f7f7", position: "sticky", top: 0 }}>
            <tr>
              <th style={{ width: 50, textAlign: "center", padding: "6px 8px" }}>Ver</th>
              <th style={{ width: 90, textAlign: "left", padding: "6px 8px" }}>Traccar ID</th>
              <th style={{ textAlign: "left", padding: "6px 8px" }}>Nombre</th>
              <th style={{ width: 70, textAlign: "right", padding: "6px 8px" }}>Interno</th>
            </tr>
          </thead>
          <tbody>
            {devices.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ padding: 8, opacity: 0.7 }}>Sin dispositivos</td>
              </tr>
            ) : (
              devices.map((d) => (
                <tr key={d.id} style={{ borderTop: "1px solid #eee" }}>
                  {/* Ver (checkbox) */}
                  <td style={{ padding: "6px 8px", textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={selected.has(d.traccarDeviceId)}
                      onChange={(e) => onToggleDevice(d.traccarDeviceId, e.target.checked)}
                    />
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
              ))
            )}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
        Marca varios para ver todos en el mapa.
      </div>
    </div>
    {/* =============================================== */}



    </>
  );
}
