import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { URL } from "node:url";

const env = {
  port: Number(process.env.PORT || 3000),
  dataDir: process.env.DATA_DIR || path.join(process.cwd(), "data"),
  appSecret: process.env.APP_SECRET || "dev-secret-change-me-before-production",
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "change-me",
  defaultApiToken: process.env.DEFAULT_API_TOKEN || "dev-token-change-me",
  publicApiUrl: process.env.PUBLIC_API_URL || "https://api.3dbpoint.com",
  publicAdminUrl: process.env.PUBLIC_ADMIN_URL || "https://cpanel.3dbpoint.com",
};

const dbPath = path.join(env.dataDir, "db.json");

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hmac = (value) => crypto.createHmac("sha256", env.appSecret).update(value).digest("base64url");
const timingSafeEqual = (a, b) => {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};

async function loadDb() {
  await fs.mkdir(env.dataDir, { recursive: true });
  try {
    return JSON.parse(await fs.readFile(dbPath, "utf8"));
  } catch {
    const seed = {
      devices: [],
      licenses: [],
      apiTokens: [
        {
          id: id("tok"),
          name: "Default device API token",
          tokenHash: sha256(env.defaultApiToken),
          createdAt: now(),
          lastUsedAt: null,
        },
      ],
      audit: [],
    };
    await saveDb(seed);
    return seed;
  }
}

async function saveDb(db) {
  await fs.mkdir(env.dataDir, { recursive: true });
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2));
}

function send(res, status, body, headers = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    "Content-Length": buffer.length,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    ...headers,
  });
  res.end(buffer);
}

function json(res, status, payload) {
  send(res, status, JSON.stringify(payload, null, 2), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
}

function redirect(res, location) {
  send(res, 303, "", { Location: location });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[ch]);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error("Payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function formBody(req) {
  return Object.fromEntries(new URLSearchParams(await readBody(req)));
}

async function jsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400, code: "invalid_json" });
  }
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function makeSession() {
  const payload = JSON.stringify({ sub: env.adminUsername, exp: Date.now() + 8 * 60 * 60 * 1000 });
  const encoded = Buffer.from(payload).toString("base64url");
  return `${encoded}.${hmac(encoded)}`;
}

function verifySession(req) {
  const token = parseCookies(req).session;
  if (!token || !token.includes(".")) return false;
  const [encoded, sig] = token.split(".");
  if (!timingSafeEqual(hmac(encoded), sig)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return payload.sub === env.adminUsername && payload.exp > Date.now();
  } catch {
    return false;
  }
}

async function requireApiToken(req, db) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return false;
  const tokenHash = sha256(token);
  const found = db.apiTokens.find((entry) => entry.tokenHash === tokenHash);
  if (!found) return false;
  found.lastUsedAt = now();
  await saveDb(db);
  return true;
}

function licenseStatus(license) {
  if (!license) return "missing";
  if (license.status !== "active") return license.status;
  if (license.expiresAt && new Date(license.expiresAt).getTime() < Date.now()) return "expired";
  return "active";
}

function publicLicense(license) {
  if (!license) return null;
  return {
    id: license.id,
    key: license.key,
    status: licenseStatus(license),
    plan: license.plan,
    deviceSerial: license.deviceSerial,
    vendos: Number(license.vendos || 0),
    desktops: Number(license.desktops || 0),
    charging: Boolean(license.charging),
    expiresAt: license.expiresAt || null,
    issuedAt: license.issuedAt,
    updatedAt: license.updatedAt,
  };
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · 3DBPoint</title>
  <style>
    :root{--bg:#f5f7fb;--panel:#fff;--ink:#172033;--muted:#667085;--brand:#1463ff;--line:#dde3ee}
    *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
    a{color:var(--brand);text-decoration:none}.wrap{max-width:1180px;margin:0 auto;padding:24px}
    header{background:#0f172a;color:#fff}.top{max-width:1180px;margin:0 auto;padding:14px 24px;display:flex;gap:16px;align-items:center;justify-content:space-between}
    nav a{color:#cbd5e1;margin-left:14px}.brand{font-weight:750;color:#fff}.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:18px;margin:16px 0}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:16px}
    .metric{font-size:28px;font-weight:750}.muted{color:var(--muted)} table{width:100%;border-collapse:collapse;background:#fff} th,td{padding:10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
    input,select{width:100%;padding:10px;border:1px solid #cfd7e6;border-radius:6px;background:#fff} label{font-weight:650;display:block;margin:10px 0 4px}
    button,.btn{display:inline-block;background:var(--brand);color:#fff;border:0;border-radius:6px;padding:9px 12px;cursor:pointer}.btn.secondary{background:#475569}.btn.danger{background:#dc2626}
    .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.pill{display:inline-block;padding:3px 8px;border-radius:999px;background:#e2e8f0}.ok{background:#dcfce7;color:#166534}.bad{background:#fee2e2;color:#991b1b}
    pre{white-space:pre-wrap;background:#0f172a;color:#dbeafe;padding:14px;border-radius:8px;overflow:auto}
  </style>
</head>
<body>
<header><div class="top"><div class="brand">3DBPoint License CPanel</div><nav><a href="/">Dashboard</a><a href="/admin/devices">Devices</a><a href="/admin/licenses">Licenses</a><a href="/admin/tokens">API Tokens</a><a href="/docs">Docs</a><form method="post" action="/logout" style="display:inline"><button class="secondary" style="padding:6px 9px;margin-left:12px">Logout</button></form></nav></div></header>
<main class="wrap">${body}</main>
</body></html>`;
}

function loginPage(message = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>3DBPoint Login</title><style>body{font-family:system-ui;background:#f5f7fb;display:grid;place-items:center;height:100vh;margin:0}.box{background:#fff;padding:26px;border:1px solid #dde3ee;border-radius:10px;width:min(380px,92vw)}input,button{width:100%;padding:11px;margin:8px 0;border-radius:6px;border:1px solid #cfd7e6}button{background:#1463ff;color:white;border:0}.err{color:#991b1b}</style></head><body><form class="box" method="post" action="/login"><h1>3DBPoint</h1><p>License admin login</p>${message ? `<p class="err">${escapeHtml(message)}</p>` : ""}<input name="username" placeholder="Username" autocomplete="username"><input name="password" placeholder="Password" type="password" autocomplete="current-password"><button>Login</button></form></body></html>`;
}

async function admin(req, res, url, db) {
  if (url.pathname === "/login" && req.method === "GET") return send(res, 200, loginPage(), { "Content-Type": "text/html" });
  if (url.pathname === "/login" && req.method === "POST") {
    const form = await formBody(req);
    if (timingSafeEqual(form.username || "", env.adminUsername) && timingSafeEqual(form.password || "", env.adminPassword)) {
      return send(res, 303, "", {
        Location: "/",
        "Set-Cookie": `session=${encodeURIComponent(makeSession())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
      });
    }
    return send(res, 401, loginPage("Invalid username or password"), { "Content-Type": "text/html" });
  }
  if (url.pathname === "/logout" && req.method === "POST") {
    return send(res, 303, "", { Location: "/login", "Set-Cookie": "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
  }
  if (!verifySession(req)) return redirect(res, "/login");

  if (url.pathname === "/") {
    const active = db.licenses.filter((license) => licenseStatus(license) === "active").length;
    return send(res, 200, page("Dashboard", `
      <h1>Dashboard</h1>
      <div class="grid">
        <div class="card"><div class="metric">${db.devices.length}</div><div class="muted">Devices</div></div>
        <div class="card"><div class="metric">${db.licenses.length}</div><div class="muted">Licenses</div></div>
        <div class="card"><div class="metric">${active}</div><div class="muted">Active Licenses</div></div>
        <div class="card"><div class="metric">${db.apiTokens.length}</div><div class="muted">API Tokens</div></div>
      </div>
      <div class="panel"><h2>Domains</h2><p><b>API:</b> ${escapeHtml(env.publicApiUrl)}</p><p><b>Admin:</b> ${escapeHtml(env.publicAdminUrl)}</p></div>
    `), { "Content-Type": "text/html" });
  }

  if (url.pathname === "/admin/devices" && req.method === "POST") {
    const form = await formBody(req);
    const serial = String(form.serial || "").trim();
    if (serial && !db.devices.some((d) => d.serial === serial)) {
      db.devices.push({ id: id("dev"), serial, name: String(form.name || serial), status: "active", createdAt: now(), updatedAt: now(), lastSeenAt: null });
      db.audit.push({ at: now(), action: "device.created", serial });
      await saveDb(db);
    }
    return redirect(res, "/admin/devices");
  }

  if (url.pathname === "/admin/devices") {
    return send(res, 200, page("Devices", `
      <h1>Devices</h1>
      <div class="panel"><form method="post"><div class="row"><div><label>Serial</label><input name="serial" required></div><div><label>Name</label><input name="name"></div></div><p><button>Add Device</button></p></form></div>
      <div class="panel"><table><thead><tr><th>Serial</th><th>Name</th><th>Status</th><th>Last Seen</th><th>Created</th></tr></thead><tbody>${db.devices.map((d) => `<tr><td>${escapeHtml(d.serial)}</td><td>${escapeHtml(d.name)}</td><td>${escapeHtml(d.status)}</td><td>${escapeHtml(d.lastSeenAt || "")}</td><td>${escapeHtml(d.createdAt)}</td></tr>`).join("")}</tbody></table></div>
    `), { "Content-Type": "text/html" });
  }

  if (url.pathname === "/admin/licenses" && req.method === "POST") {
    const form = await formBody(req);
    const deviceSerial = String(form.deviceSerial || "").trim();
    const license = {
      id: id("lic"),
      key: `3DB-${crypto.randomBytes(4).toString("hex").toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
      deviceSerial,
      plan: String(form.plan || "standard"),
      vendos: Number(form.vendos || 1),
      desktops: Number(form.desktops || 0),
      charging: form.charging === "on",
      status: "active",
      expiresAt: form.expiresAt || null,
      issuedAt: now(),
      updatedAt: now(),
    };
    db.licenses.push(license);
    db.audit.push({ at: now(), action: "license.created", key: license.key, deviceSerial });
    await saveDb(db);
    return redirect(res, "/admin/licenses");
  }

  const revoke = url.pathname.match(/^\/admin\/licenses\/([^/]+)\/revoke$/);
  if (revoke && req.method === "POST") {
    const license = db.licenses.find((item) => item.id === revoke[1]);
    if (license) {
      license.status = "revoked";
      license.updatedAt = now();
      db.audit.push({ at: now(), action: "license.revoked", key: license.key });
      await saveDb(db);
    }
    return redirect(res, "/admin/licenses");
  }

  if (url.pathname === "/admin/licenses") {
    return send(res, 200, page("Licenses", `
      <h1>Licenses</h1>
      <div class="panel"><form method="post"><div class="row"><div><label>Device Serial</label><input name="deviceSerial" required></div><div><label>Plan</label><input name="plan" value="standard"></div><div><label>Vendos</label><input name="vendos" type="number" value="1" min="0"></div><div><label>Desktops</label><input name="desktops" type="number" value="0" min="0"></div><div><label>Expires At</label><input name="expiresAt" type="date"></div><div><label>Charging</label><input name="charging" type="checkbox"></div></div><p><button>Create License</button></p></form></div>
      <div class="panel"><table><thead><tr><th>Key</th><th>Device</th><th>Plan</th><th>Status</th><th>Limits</th><th>Expires</th><th></th></tr></thead><tbody>${db.licenses.map((l) => `<tr><td>${escapeHtml(l.key)}</td><td>${escapeHtml(l.deviceSerial)}</td><td>${escapeHtml(l.plan)}</td><td><span class="pill ${licenseStatus(l) === "active" ? "ok" : "bad"}">${escapeHtml(licenseStatus(l))}</span></td><td>${escapeHtml(l.vendos)} vendos / ${escapeHtml(l.desktops)} desktops</td><td>${escapeHtml(l.expiresAt || "never")}</td><td><form method="post" action="/admin/licenses/${escapeHtml(l.id)}/revoke"><button class="danger">Revoke</button></form></td></tr>`).join("")}</tbody></table></div>
    `), { "Content-Type": "text/html" });
  }

  if (url.pathname === "/admin/tokens" && req.method === "POST") {
    const form = await formBody(req);
    const token = crypto.randomBytes(32).toString("base64url");
    db.apiTokens.push({ id: id("tok"), name: String(form.name || "API token"), tokenHash: sha256(token), createdAt: now(), lastUsedAt: null });
    await saveDb(db);
    return send(res, 200, page("New API Token", `<h1>New API Token</h1><div class="panel"><p>This token is shown once.</p><pre>${escapeHtml(token)}</pre><p><a class="btn" href="/admin/tokens">Back</a></p></div>`), { "Content-Type": "text/html" });
  }

  if (url.pathname === "/admin/tokens") {
    return send(res, 200, page("API Tokens", `
      <h1>API Tokens</h1>
      <div class="panel"><form method="post"><label>Name</label><input name="name" value="Orange Pi agent"><p><button>Create Token</button></p></form></div>
      <div class="panel"><table><thead><tr><th>Name</th><th>Created</th><th>Last Used</th></tr></thead><tbody>${db.apiTokens.map((t) => `<tr><td>${escapeHtml(t.name)}</td><td>${escapeHtml(t.createdAt)}</td><td>${escapeHtml(t.lastUsedAt || "")}</td></tr>`).join("")}</tbody></table></div>
    `), { "Content-Type": "text/html" });
  }

  if (url.pathname === "/docs") {
    return send(res, 200, page("Docs", `
      <h1>API Docs</h1>
      <div class="panel">
        <p>Base URL: <code>${escapeHtml(env.publicApiUrl)}</code></p>
        <p>Use <code>Authorization: Bearer &lt;token&gt;</code> for protected endpoints.</p>
        <pre>GET  /health
GET  /api/v1/status
POST /api/v1/devices/register
GET  /api/v1/devices/:serial/license
POST /api/v1/licenses/validate</pre>
      </div>
    `), { "Content-Type": "text/html" });
  }

  return send(res, 404, page("Not found", "<h1>Not found</h1>"), { "Content-Type": "text/html" });
}

async function api(req, res, url, db) {
  if (url.pathname === "/api/v1/status") return json(res, 200, { data: { status: "ok", service: "3dbpoint-license-platform", time: now() } });

  if (!(await requireApiToken(req, db))) {
    return json(res, 401, { error: { code: "unauthorized", message: "Missing or invalid bearer token" } });
  }

  if (url.pathname === "/api/v1/devices/register" && req.method === "POST") {
    const body = await jsonBody(req);
    const serial = String(body.serial || "").trim();
    if (!serial) return json(res, 422, { error: { code: "validation_error", message: "serial is required" } });
    let device = db.devices.find((item) => item.serial === serial);
    if (!device) {
      device = { id: id("dev"), serial, name: body.name || serial, status: "active", createdAt: now(), updatedAt: now(), lastSeenAt: now() };
      db.devices.push(device);
    } else {
      device.lastSeenAt = now();
      device.updatedAt = now();
      if (body.name) device.name = String(body.name);
    }
    await saveDb(db);
    return json(res, 200, { data: device });
  }

  const deviceLicense = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)\/license$/);
  if (deviceLicense && req.method === "GET") {
    const serial = decodeURIComponent(deviceLicense[1]);
    const license = db.licenses.find((item) => item.deviceSerial === serial && licenseStatus(item) === "active");
    return json(res, license ? 200 : 404, license ? { data: publicLicense(license) } : { error: { code: "not_found", message: "No active license for device" } });
  }

  if (url.pathname === "/api/v1/licenses/validate" && req.method === "POST") {
    const body = await jsonBody(req);
    const key = String(body.key || "").trim();
    const serial = String(body.serial || "").trim();
    const license = db.licenses.find((item) => item.key === key && (!serial || item.deviceSerial === serial));
    return json(res, 200, { data: { valid: licenseStatus(license) === "active", license: publicLicense(license) } });
  }

  return json(res, 404, { error: { code: "not_found", message: "API endpoint not found" } });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health") return json(res, 200, { status: "ok" });
    const db = await loadDb();
    if (url.pathname.startsWith("/api/")) return await api(req, res, url, db);
    return await admin(req, res, url, db);
  } catch (error) {
    const status = error.status || 500;
    json(res, status, { error: { code: error.code || "internal_error", message: status >= 500 ? "Internal server error" : error.message } });
    if (status >= 500) console.error(error);
  }
});

server.listen(env.port, () => {
  console.log(`3DBPoint license platform listening on :${env.port}`);
});
