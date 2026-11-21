/* Map logic only (Leaflet via CDN — works in Databricks Free Edition).
   Card/state rendering lives in ui.js; search/scoring live in app.py + SQL. */
const CareMap = (() => {
  let map = null;
  let radiusCircle = null;
  let originMarker = null;
  const markers = {}; // unique_id -> Leaflet marker
  let clickHandler = () => {};
  let selectedEl = null;

  function init(containerId, onPinClick) {
    clickHandler = onPinClick || clickHandler;
    try {
      if (typeof L === "undefined") return false;
      map = L.map(containerId, { scrollWheelZoom: true }).setView([22.9, 78.6], 5);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: "&copy; OpenStreetMap contributors"
      }).addTo(map);
      return true;
    } catch (err) {
      map = null;
      return false;
    }
  }

  function icon(label, kind) {
    return L.divIcon({
      className: `pin ${kind}`,
      html: `<span>${label}</span>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
  }

  function clearSearch() {
    Object.values(markers).forEach((m) => m.remove());
    Object.keys(markers).forEach((k) => delete markers[k]);
    if (radiusCircle) { radiusCircle.remove(); radiusCircle = null; }
    if (originMarker) { originMarker.remove(); originMarker = null; }
    selectedEl = null;
  }

  function showSearch(origin, groups) {
    if (!map) return;
    clearSearch();
    const latlng = [origin.lat, origin.lon];
    originMarker = L.circleMarker(latlng, {
        radius: 9, color: "#0d6e6a", weight: 3, fillColor: "#ffffff", fillOpacity: 1
      })
      .addTo(map)
      .bindPopup(`Approximate search origin (${origin.pin})<br>${origin.basis || ""}`);
    radiusCircle = L.circle(latlng, {
      radius: origin.radiusM, color: "#0d6e6a", weight: 1, fillOpacity: 0.06
    }).addTo(map);

    const add = (row, label, kind) => {
      const m = L.marker([row.usable_lat, row.usable_lon], { icon: icon(label, kind) })
        .addTo(map)
        .bindPopup(`<b>${label} · ${row.name}</b><br>${row.address_city || "—"} · ≈${row.distance_km} km`);
      m.on("click", () => clickHandler(row.unique_id));
      markers[row.unique_id] = m;
    };
    (groups.ranked || []).forEach((r, i) => add(r, String(i + 1), "ranked"));
    (groups.leads || []).forEach((r, i) => add(r, `L${i + 1}`, "lead"));
    (groups.withheld || []).forEach((r, i) => add(r, `W${i + 1}`, "withheld"));

    const pts = [latlng];
    for (const row of [...(groups.ranked || []), ...(groups.leads || []), ...(groups.withheld || [])]) {
      pts.push([row.usable_lat, row.usable_lon]);
    }
    map.fitBounds(L.latLngBounds(pts).pad(0.25));
  }

  function focus(uniqueId) {
    const m = markers[uniqueId];
    if (m && map) {
      map.panTo(m.getLatLng());
      m.openPopup();
      if (selectedEl) selectedEl.classList.remove("selected");
      const el = m.getElement && m.getElement();
      if (el) { el.classList.add("selected"); selectedEl = el; }
    }
  }

  return { init, showSearch, focus, clearSearch, available: () => !!map };
})();
window.CareMap = CareMap;
