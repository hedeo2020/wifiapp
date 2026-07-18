<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PisoFi Local Console</title>
  <link rel="stylesheet" href="/bootstrap/css/bootstrap.min.css">
  <link rel="stylesheet" href="/css/AdminLTE.min.css">
  <link rel="stylesheet" href="/plugins/fontawesome-free/css/all.min.css">
  <style>
    body { background: #f4f6f9; }
    .brand { color: #ff8a00; font-weight: 700; }
    .content-wrapper { margin-left: 0; min-height: 100vh; }
    .small-box { border-radius: 4px; }
    .table td, .table th { white-space: nowrap; }
    .console-nav .btn { margin: 0 6px 8px 0; }
    .status-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
    .status-ok { background: #d4edda; color: #155724; }
    .status-ng { background: #f8d7da; color: #721c24; }
  </style>
</head>
<body>
<div class="content-wrapper">
  <section class="content-header">
    <div class="container-fluid">
      <div class="row mb-2 align-items-center">
        <div class="col-sm-7">
          <h1><span class="brand">PisoFi</span> Local Console</h1>
        </div>
        <div class="col-sm-5 text-sm-right">
          <span id="systemStatus" class="status-pill status-ng">loading</span>
        </div>
      </div>
    </div>
  </section>

  <section class="content">
    <div class="container-fluid">
      <div class="alert alert-info">
        Local-only dashboard for this Orange Pi. It reads the existing PisoFi database and avoids the missing cloud dashboard credentials.
      </div>

      <div id="widgets" class="row"></div>

      <div class="card">
        <div class="card-header">
          <div class="console-nav">
            <button class="btn btn-primary btn-sm" data-view="clients">Clients</button>
            <button class="btn btn-success btn-sm" data-view="tickets">WiPass Tickets</button>
            <button class="btn btn-warning btn-sm" data-view="rates">Rates / License</button>
            <button class="btn btn-info btn-sm" data-view="credits">Credits</button>
            <button class="btn btn-secondary btn-sm" data-view="tokens">Tokens</button>
          </div>
        </div>
        <div class="card-body">
          <h4 id="viewTitle" class="mb-3">Clients</h4>
          <div id="viewBody" class="table-responsive">Loading...</div>
        </div>
      </div>
    </div>
  </section>
</div>

<script>
const api = (path) => fetch(`/local-console/api.php?path=${encodeURIComponent(path)}`, { cache: "no-store" }).then(r => r.json());

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
}[c]));

function table(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "<p class='text-muted mb-0'>No rows found.</p>";
  const fields = Object.keys(rows[0]);
  return `<table class="table table-sm table-striped table-hover"><thead><tr>${fields.map(f => `<th>${esc(f)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${fields.map(f => `<td>${esc(row[f])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function renderWidgets(items) {
  const colors = ["bg-info", "bg-success", "bg-warning", "bg-primary", "bg-secondary"];
  document.getElementById("widgets").innerHTML = items.map((item, i) => `
    <div class="col-lg-3 col-6">
      <div class="small-box ${colors[i % colors.length]}">
        <div class="inner">
          <h3>${esc(item.value)}</h3>
          <p>${esc(item.title)}</p>
        </div>
        <div class="icon"><i class="fas fa-chart-line"></i></div>
        <span class="small-box-footer">${esc(item.description)}</span>
      </div>
    </div>
  `).join("");
}

async function loadDashboard() {
  const res = await api("dashboard/stats");
  if (res.status !== "OK") throw new Error(res.message || "Dashboard API failed");
  renderWidgets(res.data.widgets);
  const sys = res.data.system;
  const licensed = sys.license && sys.license.present;
  document.getElementById("systemStatus").className = `status-pill ${licensed ? "status-ok" : "status-ng"}`;
  document.getElementById("systemStatus").textContent = `${sys.hostname || "Orange Pi"} · registered=${sys.is_registered} · license=${licensed ? "present" : "missing"}`;
}

async function loadView(view) {
  document.getElementById("viewTitle").textContent = {
    clients: "Clients",
    tickets: "WiPass Tickets",
    rates: "Rates / License",
    credits: "Credits",
    tokens: "Tokens"
  }[view] || view;

  const res = await api(view);
  if (res.status !== "OK") {
    document.getElementById("viewBody").innerHTML = `<div class="alert alert-danger">${esc(res.message || "API failed")}</div>`;
    return;
  }

  if (view === "rates") {
    document.getElementById("viewBody").innerHTML = `<h5>License</h5><pre>${esc(JSON.stringify(res.data.license, null, 2))}</pre><h5>Rates</h5>${table(res.data.rates)}`;
  } else if (view === "credits") {
    document.getElementById("viewBody").innerHTML = `<p><strong>Wallet total:</strong> ${esc(res.data.wallet_total)}</p>${table(res.data.coin_logs)}`;
  } else if (view === "tokens") {
    document.getElementById("viewBody").innerHTML = `<pre>${esc(JSON.stringify(res.data, null, 2))}</pre>`;
  } else {
    document.getElementById("viewBody").innerHTML = table(res.data);
  }
}

document.querySelectorAll("[data-view]").forEach(button => {
  button.addEventListener("click", () => loadView(button.dataset.view));
});

loadDashboard().then(() => loadView("clients")).catch(err => {
  document.getElementById("viewBody").innerHTML = `<div class="alert alert-danger">${esc(err.message)}</div>`;
});
</script>
</body>
</html>
