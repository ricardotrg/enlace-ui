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
    };
  }, []);

  const actualizarMarker = (lat, lon, headingDeg, online) => {
    const map = mapRef.current;
    if (!markerRef.current) {
     markerRef.current = L.marker([lat, lon], {
       icon: arrowIcon(headingDeg, online),
       zIndexOffset: 1000,
     }).addTo(map);
      map.setView([lat, lon], 15);
    } else {
      markerRef.current.setLatLng([lat, lon]);
      markerRef.current.setIcon(arrowIcon(headingDeg, online));
    }
    if (seguir) map.setView([lat, lon]);
  };

  const onFix = (data) => {
    const nowIso = new Date().toISOString();           // marca de recepción real
    const online = true;

    const merged = { ...data, receivedAt: nowIso };    // guarda receivedAt
    setFix(merged);

    actualizarMarker(data.lat, data.lon, data.headingDeg ?? 0, online);

    setEstado(online ? "En línea" : "Sin señal");
    setBadgeClass(online ? "ok" : "stale");

  if (showTrail && polyRef.current) {                // extiende trazo solo si está activo
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
  try {
    const tr = await fetch(
      `${API_BASE}/api/admin/trail?deviceId=${encodeURIComponent(idQ)}&hours=${encodeURIComponent(h)}`
    );
    if (tr.ok) {
      const body = await tr.json();                 // <-- antes decía r.json()
      polyRef.current.setLatLngs((body.trail || []).map(p => [p.lat, p.lon]));
    }
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

    if (!showTrail) clearTrail(); // <-- limpia trazo si el toggle está OFF

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
        if (showTrail) await loadTrail(idQ, hours); else clearTrail(); // <-- respeta toggle
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
    if (v && fix && mapRef.current) {
      mapRef.current.setView([fix.lat, fix.lon], Math.max(mapRef.current.getZoom(), 15));
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
    // "hace X" con receivedAt
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
    // estado en línea / sin señal por recencia
    if (Date.now() - new Date(fix.receivedAt).getTime() > STALE_MS) {
      setEstado("Sin señal");
      setBadgeClass("stale");
    } else {
      setEstado("En línea");
      setBadgeClass("ok");
    }
  };

  update(); // inmediato
  const t = setInterval(update, 15000); // cada 15s
  return () => clearInterval(t);
}, [fix?.receivedAt]);

  return (
  <>
    <div className="panel">
      <div><b>Vista en vivo</b></div>

      {/* Row 1: estado + conexión */}
      <div className="panel-row">
        <span className={`badge ${badgeClass}`}>Estado: {estado}</span>

        <div className="inline">
          <label>DeviceId Traccar:</label>
          <input
            placeholder="ej. 4"
            value={deviceId}
            onChange={(e) => setDeviceId(e.target.value)}
            style={{ width: 180 }}
          />
        </div>

        <button className="btn" onClick={conectar}>Conectar</button>
        <button className="btn" onClick={() => crearEspejo(deviceId || 4)}>
          Crear cuenta espejo
        </button>
      </div>

      {/* Row 2: seguimiento + recorrido */}
      <div className="panel-row">
        <label className="inline" style={{ userSelect: "none" }}>
          <input
            type="checkbox"
            checked={seguir}
            onChange={toggleSeguir}
          />
          Seguir vehículo
        </label>

        <label className="inline" style={{ userSelect: "none" }}>
          <input
            type="checkbox"
            checked={showTrail}
            onChange={async (e) => {
              const next = e.target.checked;
              setShowTrail(next);
              const idQ = (deviceId || fix?.deviceId || fix?.traccarDeviceId || "").toString();
              if (next) await loadTrail(idQ, hours); else clearTrail();
            }}
          />
          Mostrar recorrido
        </label>

        <div className="inline">
          <label>Horas:</label>
          <input
            type="number"
            min="1"
            max="168"
            value={hours}
            onChange={(e) => setHours(Number(e.target.value) || 24)}
            style={{ width: 70 }}
            disabled={!showTrail || trailBusy}
          />
          <button
            className="btn"
            onClick={async () => {
              const idQ = (deviceId || fix?.deviceId || fix?.traccarDeviceId || "").toString();
              await loadTrail(idQ, hours);
            }}
            disabled={!showTrail || trailBusy}
          >
            Actualizar
          </button>
        </div>
      </div>

      {/* Info panel */}
      <div style={{ fontSize: 13 }}>
        {fix ? (
          <>
            <div>
              Última actualización: {fmtLocal(fix.receivedAt)}{" "}
              <span style={{ opacity: 0.7 }}>({agoText})</span>
            </div>
            <div>Velocidad: {fix.speedKph ?? 0} km/h</div>
            <div>Rumbo: {fix.headingDeg ?? 0}°</div>
            <div>Lat: {fix.lat.toFixed(6)} Lon: {fix.lon.toFixed(6)}</div>
            <div>Seguimiento: {seguir ? "Activado" : "Manual"}</div>
          </>
        ) : (
          <div>Sin datos aún</div>
        )}
      </div>
    </div>

    <div id="map"></div>
  </>
);
}
