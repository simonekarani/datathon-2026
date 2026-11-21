"""Care Finder — Databricks App for the CMU Fall 2026 Datathon.

Layers (kept separate so the team can inspect or change each piece):
- Scoring rubric: the SQL view `workspace.care_finder.service_facility_scores`
  (definition and rationale in the "Care Finder Data Pipeline" notebook).
- Search + data access: this file (Flask + Databricks SDK; Databricks-managed
  app credentials; the Marketplace source tables are only ever read).
- Display + map: static/js/ui.js and static/js/map.js.

The only write path is POST /api/evidence, which appends reviewer-verified rows to
`workspace.care_finder.external_evidence`. Evidence is never fabricated: the
50-point (reviewed official/government source) and 20-point (independent
corroboration) scoring tiers stay inactive until real reviewed rows exist.
"""

import json
import os
import re
from datetime import datetime

from databricks.sdk import WorkspaceClient
from flask import Flask, jsonify, request, send_from_directory

WAREHOUSE_ID = os.environ.get("CARE_FINDER_WAREHOUSE_ID", "")
REVIEWERS = {
    e.strip().lower()
    for e in os.environ.get("CARE_FINDER_REVIEWERS", "").split(",")
    if e.strip()
}

SCHEMA = "workspace.care_finder"
PIN_RE = re.compile(r"^[0-9]{6}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
CLAIM_TYPES = {"service_availability", "branch_identity"}
OUTCOMES = {"supports", "conflicts", "inconclusive"}
SOURCE_KINDS = {"official_website", "government_empanelment", "other_identifiable"}

app = Flask(__name__, static_folder="static", static_url_path="")
w = WorkspaceClient()  # authenticates with the app's Databricks-managed credentials


def q(value):
    """SQL-quote a validated string (single quotes escaped)."""
    return "'" + str(value).replace("'", "''") + "'"


def run_sql(sql):
    """Run one SQL statement; return rows as dicts with JSON-friendly types."""
    # SDK >= 0.169 renamed the keyword from `sql` to `statement`; support both.
    try:
        resp = w.statement_execution.execute_statement(
            statement=sql, warehouse_id=WAREHOUSE_ID, wait_timeout="50s"
        )
    except TypeError:
        resp = w.statement_execution.execute_statement(
            sql=sql, warehouse_id=WAREHOUSE_ID, wait_timeout="50s"
        )
    state = resp.status.state if resp.status else None
    # SDK returns an enum (StatementState.SUCCEEDED) in newer versions, a str in older ones.
    state_name = getattr(state, "name", state)
    if str(state_name) != "SUCCEEDED":
        err = getattr(resp.status, "error", None) if resp.status else None
        raise RuntimeError(f"SQL statement ended in state {state_name}: {err}")
    if not resp.result or not getattr(resp.result, "data_array", None):
        return []
    columns = [(c.name, str(getattr(c.type_name, "name", c.type_name)))
               for c in resp.manifest.schema.columns]
    rows = []
    for values in resp.result.data_array:
        row = {}
        for i, (name, tname) in enumerate(columns):
            v = values[i]
            if v is None:
                row[name] = None
            elif tname == "BOOLEAN":
                row[name] = str(v).lower() == "true"
            elif tname in ("INT", "LONG"):
                row[name] = int(v)
            elif tname in ("DOUBLE", "FLOAT"):
                row[name] = float(v)
            elif tname in ("ARRAY", "STRUCT"):
                try:
                    row[name] = json.loads(v)
                except (TypeError, ValueError):
                    row[name] = v
            else:
                row[name] = v
        rows.append(row)
    return rows


def active_services():
    """Full catalog (no shortlist): every active service with its category and aliases."""
    return run_sql(
        f"SELECT service, display_name, category, aliases FROM {SCHEMA}.service_config "
        f"WHERE active ORDER BY display_name"
    )


def search_services(term):
    """Catalog search by display name, alias, or category (case-insensitive substring)."""
    return run_sql(
        f"SELECT service, display_name, category, aliases FROM {SCHEMA}.service_config "
        f"WHERE active AND (contains(lower(display_name), {q(term.lower())}) "
        f"OR contains(lower(array_join(aliases, ' ')), {q(term.lower())}) "
        f"OR contains(lower(category), {q(term.lower())})) "
        f"ORDER BY display_name"
    )


DISTANCE_KM = (
    "round(2 * 6371 * asin(sqrt("
    "power(sin(radians(s.usable_lat - o.representative_lat) / 2), 2) + "
    "cos(radians(o.representative_lat)) * cos(radians(s.usable_lat)) * "
    "power(sin(radians(s.usable_lon - o.representative_lon) / 2), 2)"
    ")), 1)"
)


def ranked_rows(service, pin, radius_km, condition, order_by, limit, origin=None):
    """Facility rows within radius for a WHERE condition, with straight-line distance.
    origin: optional {'lat', 'lon'} to search from a chosen district centroid
    (used when a PIN spans several districts and the user picked one)."""
    if origin:
        origin_sql = (f"SELECT {float(origin['lat'])} AS representative_lat, "
                      f"{float(origin['lon'])} AS representative_lon")
    else:
        origin_sql = f"SELECT * FROM {SCHEMA}.pin_lookup WHERE pincode = {int(pin)}"
    sql = f"""
    SELECT s.unique_id, s.name, s.address_city, s.address_stateOrRegion,
           s.address_zipOrPostcode, s.usable_lat, s.usable_lon,
           {DISTANCE_KM} AS distance_km,
           s.evidence_score, s.service_evidence_points, s.service_evidence_reason,
           s.official_source_supports, s.n_independent_supporting_sources,
           s.branch_identity_points, s.branch_identity_reason,
           s.corroboration_points, s.corroboration_reason,
           s.branch_review_status, s.branch_review_reasons,
           s.service_conflict, s.branch_needs_review, s.equipment_only_lead
    FROM {SCHEMA}.service_facility_scores s
    CROSS JOIN ({origin_sql}) o
    WHERE s.service = {q(service)}
      AND s.usable_lat IS NOT NULL AND o.representative_lat IS NOT NULL
      AND ({condition})
      AND {DISTANCE_KM} <= {int(radius_km)}
    ORDER BY {order_by}
    LIMIT {int(limit)}
    """
    return run_sql(sql)


def current_user():
    for header in ("X-Forwarded-Email", "X-Forwarded-Preferred-Username",
                   "X-Forwarded-User", "X-Forwarded-Name"):
        value = request.headers.get(header)
        if value:
            return value.strip()
    return ""


@app.get("/")
def index():
    return send_from_directory("static", "index.html")


@app.get("/api/health")
def health():
    try:
        run_sql("SELECT 1 AS ok")
        return jsonify({"status": "ok", "sql": "ok"})
    except Exception as exc:
        return jsonify({"status": "degraded", "sql": str(exc)}), 503


@app.get("/api/services")
def services():
    """Searchable service catalog: ?q= filters by display name, alias, or category."""
    term = (request.args.get("q") or "").strip()
    if len(term) > 80:
        return jsonify({"error": "search term too long"}), 400
    try:
        rows = search_services(term) if term else active_services()
        return jsonify({"services": rows, "count": len(rows), "q": term})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 503


@app.get("/api/search")
def search():
    service = (request.args.get("service") or "").strip()
    pin = (request.args.get("pin") or "").strip()
    district = (request.args.get("district") or "").strip()
    try:
        radius = int(float(request.args.get("radius_km") or 50))
    except (TypeError, ValueError):
        radius = 50
    radius = max(1, min(200, radius))

    try:
        services = active_services()
    except Exception as exc:
        return jsonify({"status": "data_error", "message": f"Data load error: {exc}"}), 503

    if service not in {s["service"] for s in services}:
        return jsonify({"status": "unknown_service",
                        "message": "Unknown or inactive service."})
    if not PIN_RE.match(pin):
        return jsonify({"status": "invalid_pin_format",
                        "message": f"'{pin or 'empty'}' is not a valid PIN. "
                                   "A PIN code is exactly six digits (e.g. 12a45 is invalid)."})
    try:
        pins = run_sql(
            f"SELECT pincode, districts, states, n_post_offices, "
            f"representative_lat, representative_lon, representative_basis, "
            f"postal_ambiguous, po_coord_conflict "
            f"FROM {SCHEMA}.pin_lookup WHERE pincode = {int(pin)}"
        )
    except Exception as exc:
        return jsonify({"status": "data_error", "message": f"Data load error: {exc}"}), 503

    if not pins:
        return jsonify({"status": "unknown_pin", "pin": pin,
                        "message": f"PIN {pin} does not exist in the India Post directory."})
    p = pins[0]
    base = {"pin": pin, "districts": p["districts"] or [], "states": p["states"] or [],
            "n_post_offices": p["n_post_offices"]}
    origin = None
    if p["postal_ambiguous"]:
        districts = p["districts"] or []
        chosen = next((d for d in districts
                        if district and d.upper() == district.upper()), None)
        if chosen is None:
            return jsonify({"status": "ambiguous_pin", **base,
                            "message": "This PIN maps to more than one district "
                                        f"({', '.join(districts)}). "
                                        "Choose the intended area or enter a different PIN."})
        # The user picked one of the PIN's districts: search from its centroid.
        try:
            dc = run_sql(
                f"SELECT district_name, district_lat, district_lon "
                f"FROM {SCHEMA}.district_centroid "
                f"WHERE upper(district_name) = {q(chosen.upper())} LIMIT 2"
            )
        except Exception as exc:
            return jsonify({"status": "data_error", "message": f"Data load error: {exc}"}), 503
        if not dc or dc[0]["district_lat"] is None:
            return jsonify({"status": "no_usable_pin_coordinates", **base,
                            "message": f"No usable centroid for district {chosen}, "
                                       "so distances cannot be computed."})
        origin = {"lat": dc[0]["district_lat"], "lon": dc[0]["district_lon"],
                  "basis": f"district centroid of {dc[0]['district_name']} "
                           f"(chosen for a PIN spanning multiple districts)"}
    if origin is None and p["representative_lat"] is None:
        return jsonify({"status": "no_usable_pin_coordinates", **base,
                        "message": "No usable post-office coordinates for this PIN, "
                                   "so distances cannot be computed."})

    try:
        ranked = ranked_rows(service, pin, radius,
                             "s.eligible_for_ranking",
                             "s.evidence_score DESC, distance_km ASC, s.unique_id ASC", 3,
                             origin=origin)
        leads = ranked_rows(service, pin, radius,
                            "s.equipment_only_lead AND NOT s.eligible_for_ranking",
                            "distance_km ASC, s.unique_id ASC", 5, origin=origin)
        withheld = ranked_rows(service, pin, radius,
                               "(s.branch_needs_review OR s.service_conflict)",
                               "distance_km ASC, s.unique_id ASC", 10, origin=origin)
    except Exception as exc:
        return jsonify({"status": "data_error", "message": f"Data load error: {exc}"}), 503

    for i, row in enumerate(ranked, start=1):
        row["rank"] = i
    return jsonify({
        "status": "ok",
        "service": service,
        "radius_km": radius,
        "origin": {**base,
                   "lat": origin["lat"] if origin else p["representative_lat"],
                   "lon": origin["lon"] if origin else p["representative_lon"],
                   "basis": origin["basis"] if origin else p["representative_basis"],
                   "chosen_district": district or None},
        "ranked": ranked,
        "leads": leads,
        "withheld": withheld,
    })


@app.get("/api/evidence/<service>/<unique_id>")
def evidence(service, unique_id):
    unique_id = (unique_id or "").strip()
    if not UUID_RE.match(unique_id):
        return jsonify({"error": "invalid facility id"}), 400
    try:
        if service not in {s["service"] for s in active_services()}:
            return jsonify({"error": "unknown or inactive service"}), 400
        claims = run_sql(
            f"SELECT field_name, claim_type, claim_text, n_duplicate_copies "
            f"FROM {SCHEMA}.facility_service_claims "
            f"WHERE service = {q(service)} AND unique_id = {q(unique_id)} "
            f"ORDER BY CASE claim_type WHEN 'explicit_service' THEN 1 "
            f"WHEN 'list_or_equipment' THEN 2 WHEN 'referral_or_other_branch' THEN 3 "
            f"WHEN 'planned_or_discontinued' THEN 4 ELSE 5 END, field_name"
        )
        urls = run_sql(
            f"SELECT url, origin_columns, is_official_website "
            f"FROM {SCHEMA}.facility_urls "
            f"WHERE unique_id = {q(unique_id)} "
            f"ORDER BY is_official_website DESC, url LIMIT 60"
        )
        external = run_sql(
            f"SELECT claim_type, source_url, source_kind, is_virtue_cited, exact_quote, "
            f"CAST(date_checked AS STRING) AS date_checked, outcome, notes, recorded_by, "
            f"CAST(recorded_at AS STRING) AS recorded_at "
            f"FROM {SCHEMA}.external_evidence "
            f"WHERE service = {q(service)} AND unique_id = {q(unique_id)} "
            f"ORDER BY recorded_at DESC"
        )
        score = run_sql(
            f"SELECT name, evidence_score, service_evidence_points, service_evidence_reason, "
            f"branch_identity_points, branch_identity_reason, corroboration_points, "
            f"corroboration_reason, branch_review_status, branch_review_reasons, "
            f"coords_agreement, usable_location_source, n_claims, official_source_supports, "
            f"n_independent_supporting_sources, has_conflicting_external_evidence, "
            f"branch_identity_source_reviewed "
            f"FROM {SCHEMA}.service_facility_scores "
            f"WHERE service = {q(service)} AND unique_id = {q(unique_id)}"
        )
        return jsonify({"claims": claims, "urls": urls, "external": external,
                        "score": score[0] if score else None})
    except Exception as exc:
        return jsonify({"error": f"Data load error: {exc}"}), 503


@app.get("/api/queue")
def queue():
    service = (request.args.get("service") or "").strip()
    try:
        if service not in {s["service"] for s in active_services()}:
            return jsonify({"error": "unknown or inactive service"}), 400
        rows = run_sql(
            f"SELECT unique_id, service, review_topic, field_name, claim_type, claim_text, "
            f"n_duplicate_copies, name, address_city, address_stateOrRegion, "
            f"address_zipOrPostcode, branch_review_status, branch_review_reasons, "
            f"record_source_links_json, queue_status "
            f"FROM {SCHEMA}.service_review_queue "
            f"WHERE service = {q(service)} AND queue_status = 'pending' "
            f"ORDER BY review_topic, name, unique_id LIMIT 200"
        )
        return jsonify({"queue": rows})
    except Exception as exc:
        return jsonify({"error": f"Data load error: {exc}"}), 503


@app.get("/api/me")
def me():
    user = current_user()
    return jsonify({"user": user or None,
                    "can_review": bool(user) and user.lower() in REVIEWERS})


@app.post("/api/evidence")
def post_evidence():
    user = current_user()
    if not user or user.lower() not in REVIEWERS:
        return jsonify({"error": "forbidden",
                        "message": "Only team reviewers can record evidence."}), 403
    body = request.get_json(silent=True) or {}
    unique_id = str(body.get("unique_id") or "").strip()
    service = str(body.get("service") or "").strip()
    claim_type = str(body.get("claim_type") or "").strip()
    source_url = str(body.get("source_url") or "").strip()
    source_kind = str(body.get("source_kind") or "").strip()
    exact_quote = str(body.get("exact_quote") or "").strip()
    outcome = str(body.get("outcome") or "").strip()
    notes = str(body.get("notes") or "").strip()
    date_checked = str(body.get("date_checked") or "").strip()

    problems = []
    if not UUID_RE.match(unique_id):
        problems.append("facility id is invalid")
    if service not in {s["service"] for s in active_services()}:
        problems.append("service is unknown or inactive")
    if claim_type not in CLAIM_TYPES:
        problems.append("claim_type must be service_availability or branch_identity")
    if outcome not in OUTCOMES:
        problems.append("outcome must be supports, conflicts, or inconclusive")
    if source_kind not in SOURCE_KINDS:
        problems.append("source_kind must be official_website, government_empanelment, "
                        "or other_identifiable")
    if not (source_url.startswith("http://") or source_url.startswith("https://")) \
            or len(source_url) > 1000:
        problems.append("source_url must be an http(s) URL")
    if not exact_quote or len(exact_quote) > 4000:
        problems.append("exact_quote is required (max 4000 chars) — "
                        "copy the supporting text from the source")
    try:
        datetime.strptime(date_checked, "%Y-%m-%d")
    except ValueError:
        problems.append("date_checked must be YYYY-MM-DD (the date you actually "
                        "checked the source)")
    if notes and len(notes) > 2000:
        problems.append("notes too long (max 2000 chars)")
    if problems:
        return jsonify({"error": "validation", "problems": problems}), 400

    try:
        cited = run_sql(
            f"SELECT count(*) AS n FROM {SCHEMA}.facility_urls "
            f"WHERE unique_id = {q(unique_id)} AND url = {q(source_url)}"
        )
        is_cited = bool(cited and cited[0]["n"] > 0) or bool(body.get("is_virtue_cited"))
        run_sql(
            f"INSERT INTO {SCHEMA}.external_evidence "
            f"(unique_id, service, claim_type, source_url, source_kind, is_virtue_cited, "
            f"exact_quote, date_checked, outcome, notes, recorded_by, recorded_at) "
            f"VALUES ({q(unique_id)}, {q(service)}, {q(claim_type)}, {q(source_url)}, "
            f"{q(source_kind)}, {'true' if is_cited else 'false'}, {q(exact_quote)}, "
            f"CAST({q(date_checked)} AS DATE), {q(outcome)}, {q(notes)}, {q(user)}, "
            f"current_timestamp())"
        )
        verify = run_sql(
            f"SELECT count(*) AS n FROM {SCHEMA}.external_evidence "
            f"WHERE unique_id = {q(unique_id)} AND service = {q(service)} "
            f"AND source_url = {q(source_url)} AND exact_quote = {q(exact_quote)}"
        )
        return jsonify({"inserted": True,
                        "rows_for_this_claim": verify[0]["n"] if verify else 0,
                        "recorded_by": user,
                        "is_virtue_cited": is_cited})
    except Exception as exc:
        return jsonify({"error": f"Insert failed: {exc}"}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
