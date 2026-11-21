/* Care Finder display logic: search form, states, result cards, evidence modal, review queue.
   Search + data access live in app.py; scoring lives in the SQL view. */

const $ = (sel) => document.querySelector(sel);

let LAST = null;         // last successful search payload
let QUEUE = [];
let SERVICES = [];       // service catalog from /api/services (id, display name, category, aliases)
let CHOSEN_DISTRICT = null; // user's choice when a PIN spans several districts

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function api(path, options) {
  const res = await fetch(path, options);
  let body = {};
  try { body = await res.json(); } catch (e) { /* non-JSON */ }
  return { ok: res.ok, status: res.status, body };
}

/* ---------- status + field-level messages ---------- */

function setStatus(html, kind) {
  const el = $("#status");
  el.className = `status ${kind || ""}`;
  el.innerHTML = html;
}

function hideStatus() {
  $("#status").classList.add("hidden");
}

function setFieldError(sel, message) {
  const el = $(sel);
  if (el) el.textContent = message || "";
}

function clearFieldErrors() {
  setFieldError("#service-error", "");
  setFieldError("#pin-error", "");
}

function hideDistrictOptions() {
  const el = $("#pin-districts");
  el.innerHTML = "";
  el.classList.add("hidden");
}

function showDistrictOptions(districts) {
  const el = $("#pin-districts");
  el.innerHTML = (districts || []).map((d) =>
    `<button type="button" class="district-opt" data-district="${esc(d)}">${esc(d)}</button>`).join("");
  el.classList.remove("hidden");
}

function clearSections() {
  ["#ranked-section", "#no-eligible", "#leads-section", "#withheld-section"].forEach((s) => $(s).classList.add("hidden"));
  ["#ranked", "#leads", "#withheld"].forEach((s) => $(s).innerHTML = "");
  $("#map-note").textContent = "";
  $("#view-map").classList.add("hidden");
}

function renderState(status, payload) {
  clearSections();
  hideDistrictOptions();
  clearFieldErrors();
  const message = payload.message || "";
  if (status === "ambiguous_pin") {
    setFieldError("#pin-error", `PIN ${payload.pin || ""} covers more than one district. Choose an area:`);
    showDistrictOptions(payload.districts || []);
    setStatus(`<b>This PIN spans several districts.</b> Pick the area you mean — we will search from that district's center.`, "warn");
  } else if (status === "invalid_pin_format") {
    setFieldError("#pin-error", "Enter exactly six digits (0–9).");
    setStatus(`⚠️ ${esc(message)}`, "error");
  } else if (status === "unknown_pin") {
    setFieldError("#pin-error", `PIN ${esc(payload.pin || "")} is not in the India Post directory.`);
    setStatus(`⚠️ ${esc(message)}`, "warn");
  } else if (status === "unknown_service") {
    setFieldError("#service-error", "Choose a service from the catalog — type to match names and aliases.");
    setStatus("Pick a service from the list, then search again.", "warn");
  } else if (status === "no_usable_pin_coordinates") {
    setFieldError("#pin-error", "No usable coordinates for this PIN — try a nearby PIN.");
    setStatus(`<b>We cannot compute distances for PIN ${esc(payload.pin || "")}.</b> ${esc(message)}`, "warn");
  } else if (status === "data_error") {
    setStatus(`⚠️ ${esc(message)} <button id="retry" class="secondary" type="button">Retry search</button>`, "error");
  } else {
    setStatus(esc(message || status), "warn");
  }
}

/* ---------- plain-language evidence labels ---------- */

function evidenceStatus(row) {
  if (row.service_conflict) return { label: "Needs review", cls: "st-amber", icon: "⚠" };
  if (row.official_source_supports === true || row.official_source_supports === 1)
    return { label: "Supported by reviewed sources", cls: "st-teal", icon: "✓" };
  if ((row.service_evidence_points ?? 0) >= 30)
    return { label: "Reported in the dataset", cls: "st-navy", icon: "•" };
  return { label: "Needs confirmation", cls: "st-amber", icon: "?" };
}

function rankSentence(row, prev) {
  const km = row.distance_km;
  if (row.rank === 1) {
    let why = "it has the strongest documented evidence within the radius";
    if (row.official_source_supports === true || row.official_source_supports === 1)
      why = "a reviewed source confirms this service at this branch";
    else if ((row.n_independent_supporting_sources || 0) >= 2)
      why = "two independent reviewed sources list this service at this branch";
    else if ((row.service_evidence_points ?? 0) >= 30)
      why = "the dataset reports this service at this branch";
    return `Ranks first because ${why}, at ≈${km} km from the PIN.`;
  }
  if (prev && prev.evidence_score === row.evidence_score)
    return `Ranks #${row.rank} — the same evidence score as the result above, but farther from the PIN (≈${km} km).`;
  return `Ranks #${row.rank} — the next-strongest documented evidence within the radius, at ≈${km} km.`;
}

/* ---------- cards ---------- */

function reviewBadge(row) {
  const status = row.branch_review_status || "unknown";
  const label = status === "needs_branch_review" ? "Needs branch review"
    : status === "consistent_awaiting_branch_review" ? "Consistent — awaiting branch review"
    : status;
  const cls = status === "needs_branch_review" ? "badge-warn" : "badge-info";
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function breakdown(row) {
  return `
    <ul class="breakdown">
      <li><b>Service evidence ${row.service_evidence_points ?? 0}/50</b> — ${esc(row.service_evidence_reason || "")}</li>
      <li><b>Branch identity ${row.branch_identity_points ?? 0}/30</b> — ${esc(row.branch_identity_reason || "")}</li>
      <li><b>Independent corroboration ${row.corroboration_points ?? 0}/20</b> — ${esc(row.corroboration_reason || "")}</li>
    </ul>`;
}

function card(row, options = {}) {
  const st = evidenceStatus(row);
  const reasons = (row.branch_review_reasons || []).map(esc).join("; ");
  return `
  <article class="card" id="card-${esc(row.unique_id)}" data-uid="${esc(row.unique_id)}" tabindex="0"
           aria-label="${esc(row.name)}, ${esc(st.label)}, approximately ${row.distance_km} kilometers away">
    <div class="card-head">
      ${options.label ? `<span class="rank-badge ${options.kind}" aria-hidden="true">${esc(options.label)}</span>` : ""}
      <h3>${esc(row.name)}</h3>
      <span class="status-chip ${st.cls}"><span aria-hidden="true">${st.icon}</span> ${esc(st.label)}</span>
    </div>
    <p class="loc">${esc(row.address_city || "—")}, ${esc(row.address_stateOrRegion || "—")}
      · PIN ${esc(row.address_zipOrPostcode || "—")} · ≈${row.distance_km} km
      <span class="dist-note">(approximate straight-line distance)</span></p>
    ${options.why ? `<p class="why">${esc(options.why)}</p>` : ""}
    <p class="badges">${reviewBadge(row)}
      ${row.service_conflict ? '<span class="badge badge-warn">Service conflict</span>' : ""}
      ${row.branch_needs_review ? '<span class="badge badge-warn">Branch/location review</span>' : ""}
    </p>
    ${reasons ? `<p class="reasons">Review notes: ${reasons}</p>` : ""}
    <button class="view-evidence" data-uid="${esc(row.unique_id)}">View evidence · score ${row.evidence_score ?? 0}/100</button>
  </article>`;
}

function serviceDisplayName(serviceId) {
  const svc = SERVICES.find((s) => s.service === serviceId);
  return (svc && svc.display_name) || serviceId;
}

function renderSearch(payload) {
  LAST = payload;
  clearSections();
  hideDistrictOptions();
  clearFieldErrors();
  hideStatus();

  const origin = payload.origin || {};
  const where = origin.chosen_district
    ? `${origin.chosen_district}, ${(origin.states || []).join(", ")}`
    : `${(origin.districts || []).join(", ")}, ${(origin.states || []).join(", ")}`;
  $("#results-summary").innerHTML =
    `<b>${esc(serviceDisplayName(payload.service))}</b> near PIN <b>${esc(origin.pin)}</b> (${esc(where)})`
    + ` · within ${payload.radius_km} km`
    + ` · distances are approximate straight-line distances`
    + (origin.basis ? ` · origin: ${esc(origin.basis)}` : "");

  if (payload.ranked.length) {
    $("#ranked-section").classList.remove("hidden");
    $("#ranked").innerHTML = payload.ranked.map((row, i) =>
      card(row, { label: String(i + 1), kind: "ranked", why: rankSentence(row, payload.ranked[i - 1]) })).join("");
  } else {
    $("#no-eligible").classList.remove("hidden");
  }
  if (payload.leads.length) {
    $("#leads-section").classList.remove("hidden");
    $("#leads").innerHTML = payload.leads.map((row, i) =>
      card(row, { label: `L${i + 1}`, kind: "lead",
        why: "Equipment is listed. Service availability at this branch is unclear." })).join("");
  }
  if (payload.withheld.length) {
    $("#withheld-section").classList.remove("hidden");
    $("#withheld").innerHTML = payload.withheld.map((row, i) =>
      card(row, { label: `W${i + 1}`, kind: "withheld",
        why: "Kept out of the ranking until the conflict above is reviewed." })).join("");
  }

  $("#view-map").classList.remove("hidden");
  if (CareMap.available()) {
    CareMap.showSearch({ ...payload.origin, radiusM: payload.radius_km * 1000 },
      { ranked: payload.ranked, leads: payload.leads, withheld: payload.withheld });
    $("#map-note").textContent = "Numbered pins match the numbered cards · L = lead · W = withheld. The ring marks the approximate search origin. Select a pin to highlight its card; select a card to center its pin.";
  } else {
    $("#map-note").textContent = "Map could not load — the list above is fully usable on its own.";
  }
}

/* ---------- search ---------- */

async function doSearch() {
  const service = $("#service").value;
  const pin = $("#pin").value.trim();
  const radius = $("#radius").value || 50;
  clearFieldErrors();
  if (!service) {
    setFieldError("#service-error", "Choose a service — type to match names and aliases.");
    $("#service-search").focus();
    renderServiceList();
    return;
  }
  if (!/^[0-9]{6}$/.test(pin)) {
    setFieldError("#pin-error", "Enter a six-digit PIN code (numbers only).");
    $("#pin").focus();
    return;
  }
  setStatus("Searching nearby facilities…", "info");
  $("#results").setAttribute("aria-busy", "true");
  let qs = `service=${encodeURIComponent(service)}&pin=${encodeURIComponent(pin)}&radius_km=${encodeURIComponent(radius)}`;
  if (CHOSEN_DISTRICT) qs += `&district=${encodeURIComponent(CHOSEN_DISTRICT)}`;
  try {
    const { body } = await api(`/api/search?${qs}`);
    $("#results").setAttribute("aria-busy", "false");
    if (body.status === "ok") {
      renderSearch(body);
      await loadQueue();
    } else {
      if (body.status !== "ambiguous_pin") CHOSEN_DISTRICT = null;
      renderState(body.status, body);
    }
  } catch (err) {
    $("#results").setAttribute("aria-busy", "false");
    CHOSEN_DISTRICT = null;
    renderState("data_error", { message: `Could not reach the app server: ${err}` });
  }
}

/* ---------- evidence modal ---------- */

async function openEvidence(uid) {
  const service = (LAST && LAST.service) || $("#service").value;
  const modal = $("#evidence-modal");
  $("#modal-content").innerHTML = "<p>Loading evidence…</p>";
  modal.showModal();
  const { ok, body } = await api(`/api/evidence/${encodeURIComponent(service)}/${encodeURIComponent(uid)}`);
  if (!ok || body.error) {
    $("#modal-content").innerHTML = `<p class="form-result error">Could not load evidence: ${esc(body.error || "unknown error")}</p>`;
    return;
  }
  const score = body.score || {};
  const claims = (body.claims || []).map((c) => `
    <div class="claim">
      <p class="claim-meta">Dataset excerpt — field <code>${esc(c.field_name)}</code>
        · classified <span class="tag">${esc(c.claim_type)}</span>
        ${c.n_duplicate_copies > 1 ? `· ${c.n_duplicate_copies} duplicate copies deduplicated` : ""}</p>
      <blockquote>${esc(c.claim_text)}</blockquote>
    </div>`).join("") || "<p><em>No service claim rows for this facility/service.</em></p>";
  const urls = (body.urls || []).slice(0, 15).map((u) => `
    <li><a href="${esc(u.url)}" target="_blank" rel="noopener">${esc(u.url)}</a>
      <span class="tag">${(u.origin_columns || []).map(esc).join(", ")}</span>
      ${u.is_official_website ? '<span class="tag">official website</span>' : ""}</li>`).join("");
  const ext = (body.external || []).map((e) => `
    <div class="claim">
      <p class="claim-meta"><span class="tag ${esc(e.outcome)}">${esc(e.outcome)}</span> ${esc(e.claim_type)} ·
        <a href="${esc(e.source_url)}" target="_blank" rel="noopener">source</a> (${esc(e.source_kind)})
        checked ${esc(e.date_checked)} by ${esc(e.recorded_by)}
        ${e.is_virtue_cited ? " · already cited by Virtue Foundation (not independent)" : ""}</p>
      <blockquote>${esc(e.exact_quote)}</blockquote>
      ${e.notes ? `<p class="notes">${esc(e.notes)}</p>` : ""}
    </div>`).join("") || "<p><em>No externally reviewed evidence recorded yet — this is why the 50-point and 20-point tiers are inactive for this facility.</em></p>";
  $("#modal-content").innerHTML = `
    <h3>${esc(score.name || "Facility evidence")}</h3>
    <p class="score-line">Evidence score for <b>documented evidence</b>:
      <b>${score.evidence_score ?? 0}/100</b> — what the records show, not a guarantee of current availability.</p>
    <h4>Dataset excerpts (Virtue Foundation record)</h4>${claims}
    <h4>Record source links</h4>
    <ul class="links">${urls || "<li><em>None</em></li>"}</ul>
    <h4>Reviewed external evidence</h4>${ext}
    <h4>Evidence score breakdown — documented evidence only</h4>
    ${score.service_evidence_points !== undefined ? breakdown(score) : "<p><em>Not scored.</em></p>"}
    <p class="confirm-note">This score summarizes <b>documented evidence</b>, not current availability — confirm with the facility before referring a patient.</p>`;
}

/* ---------- review queue + form ---------- */

function refreshFacilitySelect() {
  const sel = $("#e-uid");
  const seen = new Set();
  const opts = [];
  const push = (uid, label) => {
    if (uid && !seen.has(uid)) { seen.add(uid); opts.push(`<option value="${esc(uid)}">${esc(label)}</option>`); }
  };
  QUEUE.forEach((r) => push(r.unique_id, `${r.name} — ${r.review_topic}`));
  if (LAST) {
    [...LAST.ranked, ...LAST.leads, ...LAST.withheld].forEach((r) => push(r.unique_id, r.name));
  }
  sel.innerHTML = opts.join("");
}

async function loadQueue() {
  const service = (LAST && LAST.service) || $("#service").value;
  if (!service) return;
  const { body } = await api(`/api/queue?service=${encodeURIComponent(service)}`);
  QUEUE = body.queue || [];
  $("#queue-count").textContent = QUEUE.length ? `${QUEUE.length} pending` : "";
  const shown = QUEUE.slice(0, 12);
  $("#queue-list").innerHTML = shown.map((row) => {
    let links = [];
    try { links = JSON.parse(row.record_source_links_json || "[]"); } catch (e) { /* leave empty */ }
    const linkHtml = links.slice(0, 3).map((l) =>
      `<a href="${esc(l.url)}" target="_blank" rel="noopener">source</a>`).join(" · ")
      + (links.length > 3 ? ` +${links.length - 3} more` : "");
    const claim = row.claim_text
      ? `<blockquote class="small">${esc(row.claim_text.slice(0, 220))}${row.claim_text.length > 220 ? "…" : ""}</blockquote>` : "";
    const reasons = row.branch_review_reasons && row.branch_review_reasons.length
      ? `<p class="notes">Review notes: ${row.branch_review_reasons.map(esc).join("; ")}</p>` : "";
    return `
    <div class="queue-card">
      <p><b>${esc(row.name)}</b> <span class="tag">${esc(row.review_topic)}</span>
        <span class="tag ${row.claim_type === "explicit_service" ? "explicit" : ""}">${esc(row.claim_type)}</span></p>
      <p class="q-loc notes">${esc(row.address_city || "—")}, ${esc(row.address_stateOrRegion || "—")} · PIN ${esc(row.address_zipOrPostcode || "—")}</p>
      ${claim}${reasons}
      <p class="links">${linkHtml || "No record source links"}</p>
      <button class="use-in-form" data-uid="${esc(row.unique_id)}">Review this</button>
    </div>`;
  }).join("") || "<p>No pending reviews for this service.</p>";
  if (QUEUE.length > 12) {
    $("#queue-list").insertAdjacentHTML("beforeend",
      `<p class="notes">Showing 12 of ${QUEUE.length} pending — the full queue is in workspace.care_finder.service_review_queue.</p>`);
  }
  refreshFacilitySelect();
}

async function submitEvidence(ev) {
  ev.preventDefault();
  const payload = {
    unique_id: $("#e-uid").value,
    service: (LAST && LAST.service) || $("#service").value,
    claim_type: $("#e-claim").value,
    source_kind: $("#e-kind").value,
    source_url: $("#e-url").value.trim(),
    exact_quote: $("#e-quote").value.trim(),
    date_checked: $("#e-date").value,
    outcome: $("#e-outcome").value,
    notes: $("#e-notes").value.trim()
  };
  const { ok, body } = await api("/api/evidence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const out = $("#form-result");
  if (ok && body.inserted) {
    out.className = "form-result";
    out.textContent = "Recorded — this evidence now feeds the scoring tiers. Thank you.";
    $("#e-quote").value = ""; $("#e-url").value = ""; $("#e-notes").value = "";
    loadQueue();
  } else {
    out.className = "form-result error";
    out.textContent = `Not recorded: ${(body.problems || [body.message || body.error || "unknown error"]).join("; ")}`;
  }
}

/* ---------- searchable service picker ---------- */

function matchesCatalog(term) {
  const t = (term || "").trim().toLowerCase();
  return SERVICES.filter((s) =>
    !t
    || (s.display_name || "").toLowerCase().includes(t)
    || (s.aliases || []).some((a) => (a || "").toLowerCase().includes(t))
    || (s.category || "").toLowerCase().includes(t));
}

function findServiceByTerm(term) {
  const t = (term || "").trim().toLowerCase();
  if (!t) return null;
  return SERVICES.find((s) => (s.display_name || "").toLowerCase() === t)
    || SERVICES.find((s) => (s.aliases || []).some((a) => (a || "").toLowerCase() === t))
    || matchesCatalog(t)[0] || null;
}

function renderServiceList() {
  const term = $("#service-search").value;
  const matches = matchesCatalog(term);
  const list = $("#service-list");
  if (!matches.length) {
    list.innerHTML = `<li class="service-empty" role="option" aria-disabled="true">No catalog service matches “${esc(term)}”.</li>`;
  } else {
    const byCat = {};
    matches.forEach((s) => { (byCat[s.category || "Other"] = byCat[s.category || "Other"] || []).push(s); });
    const selected = $("#service").value;
    list.innerHTML = Object.keys(byCat).sort().map((cat) =>
      `<li class="service-cat" role="presentation">${esc(cat)}</li>`
      + byCat[cat].map((s) =>
        `<li role="option" class="service-opt${s.service === selected ? " selected" : ""}"
             data-service="${esc(s.service)}" data-name="${esc(s.display_name)}"
             aria-selected="${s.service === selected}">${esc(s.display_name)}</li>`).join("")
    ).join("");
  }
  list.classList.remove("hidden");
  $("#service-search").setAttribute("aria-expanded", "true");
}

function hideServiceList() {
  $("#service-list").classList.add("hidden");
  $("#service-search").setAttribute("aria-expanded", "false");
}

function selectService(serviceId, displayName) {
  $("#service").value = serviceId || "";
  $("#service-search").value = displayName || "";
  hideServiceList();
}

/* ---------- init ---------- */

async function init() {
  CareMap.init("map", (uid) => {
    const el = document.getElementById(`card-${uid}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1600);
    }
  });

  const { ok, body } = await api("/api/services");
  SERVICES = (ok && body.services) || [];
  if (!SERVICES.length) {
    setStatus("The service catalog could not be loaded — refresh the page or check /api/health.", "error");
  }

  const searchInput = $("#service-search");
  searchInput.addEventListener("focus", renderServiceList);
  searchInput.addEventListener("input", renderServiceList);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!$("#service").value) {
        const first = findServiceByTerm(searchInput.value);
        if (!first) {
          const term = searchInput.value.trim() || "your search";
          setFieldError("#service-error", `No service matches “${term}”. Open the list to browse the full catalog.`);
          return;
        }
        selectService(first.service, first.display_name);
      }
      doSearch();
    } else if (e.key === "Escape") {
      hideServiceList();
    }
  });
  $("#service-list").addEventListener("click", (e) => {
    const opt = e.target.closest(".service-opt");
    if (!opt) return;
    selectService(opt.dataset.service, opt.dataset.name);
    doSearch();
  });

  $("#pin").addEventListener("input", () => {
    CHOSEN_DISTRICT = null;
    hideDistrictOptions();
    setFieldError("#pin-error", "");
  });
  $("#search-form").addEventListener("submit", (e) => { e.preventDefault(); doSearch(); });

  const me = (await api("/api/me")).body;
  $("#reviewer-note").textContent = me.can_review
    ? `Signed in as ${me.user}. You can record reviewed evidence below — quotes must come from the linked source, checked on the date you enter.`
    : (me.user
      ? `Signed in as ${me.user} (read-only — only team reviewers can record evidence).`
      : "Review actions are limited to team reviewers configured for this app.");

  $("#e-date").value = new Date().toISOString().slice(0, 10);
  document.addEventListener("click", (e) => {
    if (e.target.closest("#retry")) { doSearch(); return; }
    if (!e.target.closest(".service-picker")) hideServiceList();
    const pinEx = e.target.closest(".linklike[data-pin], .chip[data-pin]");
    if (pinEx) {
      $("#pin").value = pinEx.dataset.pin;
      CHOSEN_DISTRICT = null;
      hideDistrictOptions();
      doSearch();
      return;
    }
    const svcEx = e.target.closest(".linklike[data-service], .service-chip");
    if (svcEx) {
      const found = findServiceByTerm(svcEx.dataset.service);
      if (!found) {
        setFieldError("#service-error", `No service matches “${svcEx.dataset.service}”.`);
        return;
      }
      selectService(found.service, found.display_name);
      doSearch();
      return;
    }
    const dist = e.target.closest(".district-opt");
    if (dist) {
      CHOSEN_DISTRICT = dist.dataset.district;
      setFieldError("#pin-error", `Searching from the center of ${dist.dataset.district}.`);
      doSearch();
      return;
    }
    if (e.target.closest("#change-service")) {
      $("#service-search").focus();
      renderServiceList();
      $("#service-search").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (e.target.closest("#change-pin")) {
      $("#pin").focus();
      $("#pin").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const ve = e.target.closest(".view-evidence");
    if (ve) { openEvidence(ve.dataset.uid); return; }
    const uf = e.target.closest(".use-in-form");
    if (uf) {
      $("#e-uid").value = uf.dataset.uid;
      $("#evidence-form").scrollIntoView({ behavior: "smooth" });
      return;
    }
    const cardEl = e.target.closest(".card");
    if (cardEl && !e.target.closest("button")) CareMap.focus(cardEl.dataset.uid);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const cardEl = e.target.closest && e.target.closest(".card");
    if (cardEl && !e.target.closest("button")) {
      e.preventDefault();
      CareMap.focus(cardEl.dataset.uid);
    }
  });
  $("#evidence-form").addEventListener("submit", submitEvidence);
  $("#modal-close").addEventListener("click", () => $("#evidence-modal").close());

  setStatus("Type a service, enter a six-digit PIN code, and select Find facilities.", "info");
  await loadQueue();
}

init();
