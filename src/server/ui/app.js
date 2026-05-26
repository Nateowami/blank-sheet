// ─── State ─────────────────────────────────────────────────────────────────────
const state = {
  releaseStage: null, // null = all
  currentPage: "dashboard",
  groupListPage: 1,
  groupListSort: { field: "eventCount", dir: "desc" },
  groupListFilters: { releaseStage: "", hasPII: "", hasTemplate: "" },
  trendsGranularity: "day",
  trendsMode: "absolute",
  trendsChart: null,
};

// ─── Router ────────────────────────────────────────────────────────────────────
function navigate(page, params = {}) {
  document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll("nav a").forEach((a) => a.classList.remove("active"));

  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.add("active");

  const navLink = document.querySelector(`nav a[data-page="${page}"]`);
  if (navLink) navLink.classList.add("active");

  state.currentPage = page;

  if (page === "dashboard") loadDashboard();
  else if (page === "groups") loadGroups();
  else if (page === "group-detail") loadGroupDetail(params.id);
  else if (page === "merge-suggestions") loadMergeSuggestions();
  else if (page === "merge-history") loadMergeHistory();
  else if (page === "trends") loadTrends();
}

// ─── API helpers ────────────────────────────────────────────────────────────────
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

async function apiPost(path) {
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtNum(n) {
  if (n == null) return "—";
  return n.toLocaleString();
}

function stageBadge(stage) {
  const cls = stage === "production" ? "badge-prod" : stage === "staging" ? "badge-staging" : stage === "qa" ? "badge-qa" : "badge-other";
  return `<span class="badge ${cls}">${escHtml(stage)}</span>`;
}

function piiBadge(hasPII) {
  if (hasPII === true) return `<span class="badge badge-pii">⚠ PII</span>`;
  if (hasPII === false) return `<span style="color:var(--text-muted);font-size:11px">clean</span>`;
  return `<span style="color:var(--text-muted);font-size:11px">—</span>`;
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  const el = document.getElementById("page-dashboard");
  el.innerHTML = `<div class="loading">Loading…</div>`;

  let data;
  try {
    const qs = state.releaseStage ? `?releaseStage=${state.releaseStage}` : "";
    data = await api(`/api/dashboard${qs}`);
  } catch (e) {
    el.innerHTML = `<div class="empty">Failed to load dashboard: ${e.message}</div>`;
    return;
  }

  el.innerHTML = `
    <h1>Dashboard</h1>
    <div class="stat-grid">
      <div class="stat-card"><div class="label">Total Events</div><div class="value">${fmtNum(data.totalEvents)}</div></div>
      <div class="stat-card"><div class="label">Events (30d)</div><div class="value">${fmtNum(data.events30d)}</div></div>
      <div class="stat-card"><div class="label">Active Groups</div><div class="value">${fmtNum(data.totalActiveGroups)}</div></div>
      <div class="stat-card"><div class="label">Users Impacted (30d)</div><div class="value">${fmtNum(data.uniqueUsersLast30d)}</div></div>
      <div class="stat-card" style="cursor:pointer" onclick="navigate('merge-suggestions')">
        <div class="label">Pending Merges</div>
        <div class="value" style="color:${data.pendingSuggestions > 0 ? 'var(--warning)' : 'inherit'}">${fmtNum(data.pendingSuggestions)}</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:24px">
      <h2>Events / Day (last 30 days)</h2>
      <div class="chart-container" style="height:200px"><canvas id="events-day-chart"></canvas></div>
    </div>

    <h2>Top Groups (by event count)</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Group</th><th>Events</th><th>Users</th><th>Last Seen</th><th>Stages</th><th>PII</th></tr></thead>
        <tbody>
          ${data.top5Groups.map((g) => `
            <tr onclick="navigate('group-detail', {id:'${g._id}'})" style="cursor:pointer">
              <td>${escHtml(g.label)}</td>
              <td>${fmtNum(g.eventCount)}</td>
              <td>${fmtNum(g.uniqueUserCount)}</td>
              <td>${fmtDate(g.lastSeenAt)}</td>
              <td>${(g.releaseStages || []).map(stageBadge).join(" ")}</td>
              <td>${piiBadge(g.hasPII)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  // Render bar chart
  if (data.eventsPerDay && data.eventsPerDay.length > 0) {
    renderBarChart("events-day-chart", data.eventsPerDay.map((d) => d.date), data.eventsPerDay.map((d) => d.count));
  }
}

// ─── Groups list ───────────────────────────────────────────────────────────────
async function loadGroups() {
  const el = document.getElementById("page-groups");

  // Fetch distinct release stages for the filter
  let releaseStageOptions = [];
  try {
    releaseStageOptions = await api("/api/groups/release-stages");
  } catch (_) { /* fall back to empty list */ }

  const buildFiltersBar = () => `
    <div class="filters">
      <label>Sort:
        <select id="sort-select">
          <option value="eventCount" ${state.groupListSort.field === "eventCount" ? "selected" : ""}>Event Count</option>
          <option value="lastSeenAt" ${state.groupListSort.field === "lastSeenAt" ? "selected" : ""}>Last Seen</option>
          <option value="firstSeenAt" ${state.groupListSort.field === "firstSeenAt" ? "selected" : ""}>First Seen</option>
          <option value="userCount" ${state.groupListSort.field === "userCount" ? "selected" : ""}>User Count</option>
        </select>
      </label>
      <label>Dir:
        <select id="dir-select">
          <option value="desc" ${state.groupListSort.dir === "desc" ? "selected" : ""}>↓ Desc</option>
          <option value="asc" ${state.groupListSort.dir === "asc" ? "selected" : ""}>↑ Asc</option>
        </select>
      </label>
      <label>Stage:
        <select id="stage-select">
          <option value="">All</option>
          ${releaseStageOptions.map((s) => `<option value="${escHtml(s)}" ${state.groupListFilters.releaseStage === s ? "selected" : ""}>${escHtml(s)}</option>`).join("")}
        </select>
      </label>
      <label>PII:
        <select id="pii-select">
          <option value="">All</option>
          <option value="true" ${state.groupListFilters.hasPII === "true" ? "selected" : ""}>Has PII</option>
          <option value="false" ${state.groupListFilters.hasPII === "false" ? "selected" : ""}>Clean</option>
        </select>
      </label>
      <label>Template:
        <select id="template-select">
          <option value="">All</option>
          <option value="true" ${state.groupListFilters.hasTemplate === "true" ? "selected" : ""}>Has template</option>
          <option value="false" ${state.groupListFilters.hasTemplate === "false" ? "selected" : ""}>No template</option>
        </select>
      </label>
    </div>
  `;

  el.innerHTML = `<h1>Error Groups</h1>${buildFiltersBar()}<div id="groups-table-wrap"><div class="loading">Loading…</div></div>`;

  const bindFilters = () => {
    document.getElementById("sort-select")?.addEventListener("change", (e) => { state.groupListSort.field = e.target.value; state.groupListPage = 1; refreshGroupsTable(); });
    document.getElementById("dir-select")?.addEventListener("change", (e) => { state.groupListSort.dir = e.target.value; state.groupListPage = 1; refreshGroupsTable(); });
    document.getElementById("stage-select")?.addEventListener("change", (e) => { state.groupListFilters.releaseStage = e.target.value; state.groupListPage = 1; refreshGroupsTable(); });
    document.getElementById("pii-select")?.addEventListener("change", (e) => { state.groupListFilters.hasPII = e.target.value; state.groupListPage = 1; refreshGroupsTable(); });
    document.getElementById("template-select")?.addEventListener("change", (e) => { state.groupListFilters.hasTemplate = e.target.value; state.groupListPage = 1; refreshGroupsTable(); });
  };
  bindFilters();

  await refreshGroupsTable();
}

async function refreshGroupsTable() {
  const wrap = document.getElementById("groups-table-wrap");
  if (!wrap) return;
  wrap.innerHTML = `<div class="loading">Loading…</div>`;

  const params = new URLSearchParams({
    sortBy: state.groupListSort.field,
    direction: state.groupListSort.dir,
    page: state.groupListPage,
    ...(state.groupListFilters.releaseStage ? { releaseStage: state.groupListFilters.releaseStage } : {}),
    ...(state.groupListFilters.hasPII ? { hasPII: state.groupListFilters.hasPII } : {}),
    ...(state.groupListFilters.hasTemplate ? { hasTemplate: state.groupListFilters.hasTemplate } : {}),
  });

  let data;
  try {
    data = await api(`/api/groups?${params}`);
  } catch (e) {
    wrap.innerHTML = `<div class="empty">Error: ${e.message}</div>`;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(data.total / data.limit));

  wrap.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Error Template / Message</th>
            <th>First Seen</th>
            <th>Last Seen</th>
            <th>Events</th>
            <th>Users</th>
            <th>Stages</th>
            <th>PII</th>
          </tr>
        </thead>
        <tbody>
          ${data.groups.map((g) => `
            <tr onclick="navigate('group-detail', {id:'${g._id}'})" style="cursor:pointer">
              <td style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(g.label)}</td>
              <td>${fmtDate(g.firstSeenAt)}</td>
              <td>${fmtDate(g.lastSeenAt)}</td>
              <td>${fmtNum(g.eventCount)}</td>
              <td>${fmtNum(g.uniqueUserCount)}</td>
              <td>${(g.releaseStages || []).map(stageBadge).join(" ")}</td>
              <td>${piiBadge(g.hasPII)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <div class="pagination">
      <button class="btn-ghost btn-sm" onclick="changeGroupPage(-1)" ${state.groupListPage <= 1 ? "disabled" : ""}>← Prev</button>
      <span class="page-info">Page ${state.groupListPage} of ${totalPages} (${fmtNum(data.total)} groups)</span>
      <button class="btn-ghost btn-sm" onclick="changeGroupPage(1)" ${state.groupListPage >= totalPages ? "disabled" : ""}>Next →</button>
    </div>
  `;
}

function changeGroupPage(delta) {
  state.groupListPage += delta;
  refreshGroupsTable();
}

// ─── Group detail ──────────────────────────────────────────────────────────────
async function loadGroupDetail(id) {
  const el = document.getElementById("page-group-detail");
  el.innerHTML = `
    <button class="btn btn-ghost back-btn" onclick="navigate('groups')">← Back to Groups</button>
    <div class="loading">Loading…</div>
  `;

  let data;
  try {
    data = await api(`/api/groups/${id}`);
  } catch (e) {
    el.innerHTML = `<div class="empty">Error: ${e.message}</div>`;
    return;
  }

  const piiBanner = data.hasPII
    ? `<div class="pii-banner">⚠️ This error group contains PII — sanitize before sharing.</div>`
    : "";

  const stackHtml = (data.displayStacktrace || []).map((f) =>
    `<div class="stack-frame ${f.inProject ? "in-project" : ""}">at ${escHtml(f.method)} (${escHtml(f.file)}:${f.lineNumber})</div>`
  ).join("");

  const mergeHistoryHtml = data.mergeHistory && data.mergeHistory.length > 0
    ? data.mergeHistory.map((m) => `
        <div style="padding:10px 0;border-bottom:1px solid var(--border)">
          <strong>${escHtml(String(m.absorbedGroupId))}</strong> merged on ${fmtDate(m.mergedAt)}
          ${m.llmReasoning ? `<br><span style="color:var(--text-muted)">${escHtml(m.llmReasoning)}</span>` : ""}
          <br><button class="btn btn-danger btn-sm" style="margin-top:6px" onclick="undoMerge('${id}', '${m.absorbedGroupId}')">Undo</button>
        </div>
      `).join("")
    : `<div class="empty">No merges</div>`;

  el.innerHTML = `
    <button class="btn btn-ghost back-btn" onclick="navigate('groups')">← Back to Groups</button>
    ${piiBanner}
    <div class="group-header">
      <div class="title">${escHtml(data.template ?? data.exampleMessages?.[0] ?? "Unknown")}</div>
      <div class="group-meta">
        <span>First seen: <strong>${fmtDate(data.firstSeenAt)}</strong></span>
        <span>Last seen: <strong>${fmtDate(data.lastSeenAt)}</strong></span>
        <span>Trend: <strong>${escHtml(data.trend)}</strong></span>
        <span>Events: <strong>${fmtNum(data.eventCount)}</strong></span>
        <span>Users: <strong>${fmtNum(data.uniqueUserCount)}</strong></span>
        <span>No user ID: <strong>${fmtNum(data.eventsWithNoUserId)}</strong></span>
        <span>Stages: ${(data.releaseStages || []).map(stageBadge).join(" ")}</span>
        <span>PII: ${piiBadge(data.hasPII)}</span>
      </div>
    </div>

    <div class="card">
      <h2>Example Messages</h2>
      <pre class="messages">${(data.exampleMessages || []).map(escHtml).join("\n\n")}</pre>
    </div>

    <div class="card" id="group-events-card-${id}">
      <h2>Events</h2>
      <div id="group-events-${id}"><div class="loading">Loading…</div></div>
    </div>

    <div class="card">
      <h2>Most Common Stack Trace</h2>
      ${stackHtml || '<div class="empty">No stack trace available</div>'}
    </div>

    <div class="card">
      <h2>Merge History</h2>
      ${mergeHistoryHtml}
    </div>

    <div class="card">
      <h2>Markdown Summary</h2>
      <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
        <button class="btn btn-sm" onclick="copyMarkdown('${id}')">Copy as Markdown</button>
      </div>
      <div id="md-preview-${id}" class="md-preview loading">Loading…</div>
    </div>
  `;

  // Load markdown preview
  fetch(`/api/groups/${id}/summary`)
    .then((r) => r.text())
    .then((md) => {
      const el = document.getElementById(`md-preview-${id}`);
      if (el) { el.textContent = md; el.classList.remove("loading"); }
    })
    .catch(() => {});

  // Load events list
  loadGroupEvents(id, 1);
}

async function loadGroupEvents(id, page) {
  const wrap = document.getElementById(`group-events-${id}`);
  if (!wrap) return;
  wrap.innerHTML = `<div class="loading">Loading…</div>`;

  const limit = 20;
  let data;
  try {
    data = await api(`/api/groups/${id}/events?page=${page}&limit=${limit}`);
  } catch (e) {
    wrap.innerHTML = `<div class="empty">Error loading events: ${escHtml(e.message)}</div>`;
    return;
  }

  if (data.total === 0) {
    wrap.innerHTML = `<div class="empty">No events found.</div>`;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(data.total / limit));

  wrap.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Received At</th>
            <th>Stage</th>
            <th>User</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          ${data.events.map((e) => `
            <tr>
              <td style="white-space:nowrap">${fmtDate(e.receivedAt)}</td>
              <td>${stageBadge(e.releaseStage)}</td>
              <td style="color:var(--text-muted)">${escHtml(e.userId ?? "—")}</td>
              <td style="max-width:500px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(e.errorMessage)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <div class="pagination">
      <button class="btn-ghost btn-sm" onclick="loadGroupEvents('${id}', ${page - 1})" ${page <= 1 ? "disabled" : ""}>← Prev</button>
      <span class="page-info">Page ${page} of ${totalPages} (${fmtNum(data.total)} events)</span>
      <button class="btn-ghost btn-sm" onclick="loadGroupEvents('${id}', ${page + 1})" ${page >= totalPages ? "disabled" : ""}>Next →</button>
    </div>
  `;
}

async function copyMarkdown(id) {
  const res = await fetch(`/api/groups/${id}/summary`);
  const md = await res.text();
  await navigator.clipboard.writeText(md);
  alert("Copied to clipboard!");
}

async function undoMerge(groupId, absorbedGroupId) {
  if (!confirm("Undo this merge? This will restore the absorbed group.")) return;
  try {
    await apiPost(`/api/merge-history/${groupId}/undo/${absorbedGroupId}`);
    loadGroupDetail(groupId);
  } catch (e) {
    alert("Error: " + e.message);
  }
}

// ─── Merge Suggestions ─────────────────────────────────────────────────────────
async function loadMergeSuggestions() {
  const el = document.getElementById("page-merge-suggestions");
  el.innerHTML = `<h1>Merge Suggestions</h1><div class="loading">Loading…</div>`;

  let data;
  try {
    data = await api("/api/merge-suggestions");
  } catch (e) {
    el.innerHTML = `<h1>Merge Suggestions</h1><div class="empty">Error: ${e.message}</div>`;
    return;
  }

  if (data.length === 0) {
    el.innerHTML = `<h1>Merge Suggestions</h1><div class="empty">No pending suggestions.</div>`;
    return;
  }

  el.innerHTML = `
    <h1>Merge Suggestions <span style="color:var(--text-muted);font-size:16px">(${data.length} pending)</span></h1>
    ${data.map((s) => `
      <div class="suggestion-card">
        <div style="display:flex;gap:16px;align-items:center;justify-content:space-between">
          <div>
            Similarity: <strong>${(s.similarityScore * 100).toFixed(1)}%</strong>
            &nbsp;·&nbsp;
            Confidence: <span class="conf-${s.llmConfidence}">${s.llmConfidence}</span>
          </div>
          <span class="badge badge-pending">pending</span>
        </div>
        <div class="groups-row">
          <div class="group-box">
            <strong>Group A</strong><br>
            <a href="#" onclick="navigate('group-detail',{id:'${s.groupA?._id}'});return false">${escHtml(s.groupA?.label ?? "Unknown")}</a><br>
            <span style="color:var(--text-muted)">${fmtNum(s.groupA?.eventCount)} events</span>
          </div>
          <div style="display:flex;align-items:center;font-size:20px;color:var(--text-muted)">⟷</div>
          <div class="group-box">
            <strong>Group B</strong><br>
            <a href="#" onclick="navigate('group-detail',{id:'${s.groupB?._id}'});return false">${escHtml(s.groupB?.label ?? "Unknown")}</a><br>
            <span style="color:var(--text-muted)">${fmtNum(s.groupB?.eventCount)} events</span>
          </div>
        </div>
        <div class="reasoning">"${escHtml(s.llmReasoning)}"</div>
        <div class="actions">
          <button class="btn btn-sm" onclick="acceptSuggestion('${s._id}')">✓ Accept Merge</button>
          <button class="btn btn-ghost btn-sm" onclick="rejectSuggestion('${s._id}')">✗ Reject</button>
        </div>
      </div>
    `).join("")}
  `;
}

async function acceptSuggestion(id) {
  if (!confirm("Accept this merge? Group B will be absorbed into Group A.")) return;
  try {
    await apiPost(`/api/merge-suggestions/${id}/accept`);
    loadMergeSuggestions();
  } catch (e) {
    alert("Error: " + e.message);
  }
}

async function rejectSuggestion(id) {
  try {
    await apiPost(`/api/merge-suggestions/${id}/reject`);
    loadMergeSuggestions();
  } catch (e) {
    alert("Error: " + e.message);
  }
}

// ─── Merge History ─────────────────────────────────────────────────────────────
async function loadMergeHistory() {
  const el = document.getElementById("page-merge-history");
  el.innerHTML = `<h1>Merge History</h1><div class="loading">Loading…</div>`;

  let data;
  try {
    data = await api("/api/merge-history");
  } catch (e) {
    el.innerHTML = `<h1>Merge History</h1><div class="empty">Error: ${e.message}</div>`;
    return;
  }

  if (data.length === 0) {
    el.innerHTML = `<h1>Merge History</h1><div class="empty">No merge history yet.</div>`;
    return;
  }

  el.innerHTML = `
    <h1>Merge History</h1>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Into Group</th>
            <th>Absorbed Group</th>
            <th>Triggered By</th>
            <th>Reasoning</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${data.map((r) => `
            <tr>
              <td>${fmtDate(r.mergedAt)}</td>
              <td><a href="#" onclick="navigate('group-detail',{id:'${r.groupId}'});return false">${escHtml(r.groupLabel)}</a></td>
              <td>${escHtml(r.absorbedGroupLabel)}</td>
              <td>${r.triggeredBy === "llm_suggestion" ? "🤖 LLM" : "👤 Human"}</td>
              <td style="color:var(--text-muted);font-style:italic">${escHtml(r.llmReasoning ?? "—")}</td>
              <td><button class="btn btn-ghost btn-sm" onclick="undoMerge('${r.groupId}','${r.absorbedGroupId}')">Undo</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// ─── Trends ────────────────────────────────────────────────────────────────────
async function loadTrends() {
  const el = document.getElementById("page-trends");
  el.innerHTML = `
    <h1>Trends</h1>
    <div class="filters">
      <div class="toggle-group">
        <button id="gran-day" class="${state.trendsGranularity === "day" ? "active" : ""}" onclick="setGranularity('day')">Day</button>
        <button id="gran-week" class="${state.trendsGranularity === "week" ? "active" : ""}" onclick="setGranularity('week')">Week</button>
        <button id="gran-month" class="${state.trendsGranularity === "month" ? "active" : ""}" onclick="setGranularity('month')">Month</button>
      </div>
      <div class="toggle-group" style="margin-left:16px">
        <button id="mode-abs" class="${state.trendsMode === "absolute" ? "active" : ""}" onclick="setMode('absolute')">Absolute</button>
        <button id="mode-pct" class="${state.trendsMode === "percent" ? "active" : ""}" onclick="setMode('percent')">% of Total</button>
      </div>
    </div>
    <div class="chart-container"><canvas id="trends-chart"></canvas></div>
  `;
  await renderTrends();
}

async function renderTrends() {
  const params = new URLSearchParams({
    granularity: state.trendsGranularity,
    mode: state.trendsMode,
    ...(state.releaseStage ? { releaseStage: state.releaseStage } : {}),
  });

  let data;
  try {
    data = await api(`/api/trends?${params}`);
  } catch (e) {
    console.error("Trends error:", e);
    return;
  }

  if (state.trendsChart) {
    state.trendsChart.destroy();
    state.trendsChart = null;
  }

  const canvas = document.getElementById("trends-chart");
  if (!canvas) return;

  const colors = [
    "#5b8def","#22c55e","#f59e0b","#ef4444","#a78bfa",
    "#06b6d4","#f97316","#84cc16","#ec4899","#64748b",
    "#9ca3af",
  ];

  const datasets = data.series.map((s, i) => ({
    label: s.label.length > 50 ? s.label.slice(0, 50) + "…" : s.label,
    data: s.data,
    backgroundColor: colors[i % colors.length] + "cc",
    borderColor: colors[i % colors.length],
    borderWidth: 1,
    fill: true,
  }));

  const Chart = window.Chart;
  state.trendsChart = new Chart(canvas, {
    type: "bar",
    data: { labels: data.dates, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, ticks: { color: "#8892a4" }, grid: { color: "#2e3244" } },
        y: { stacked: true, ticks: { color: "#8892a4" }, grid: { color: "#2e3244" } },
      },
      plugins: {
        legend: {
          labels: { color: "#e2e8f0", boxWidth: 12 },
          onClick(e, item, legend) {
            const idx = item.datasetIndex;
            const meta = legend.chart.getDatasetMeta(idx);
            meta.hidden = !meta.hidden;
            legend.chart.update();
          },
        },
        tooltip: { mode: "index" },
      },
    },
  });
}

function setGranularity(g) {
  state.trendsGranularity = g;
  loadTrends();
}

function setMode(m) {
  state.trendsMode = m;
  loadTrends();
}

function renderBarChart(canvasId, labels, data) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !window.Chart) return;
  new window.Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Events",
        data,
        backgroundColor: "#5b8def99",
        borderColor: "#5b8def",
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#8892a4", maxRotation: 45 }, grid: { color: "#2e3244" } },
        y: { ticks: { color: "#8892a4" }, grid: { color: "#2e3244" } },
      },
    },
  });
}

// ─── Utility ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("nav a[data-page]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      navigate(a.dataset.page);
    });
  });
  navigate("dashboard");
});
