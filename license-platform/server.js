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
  publicRemoteBaseUrl: process.env.PUBLIC_REMOTE_BASE_URL || process.env.PUBLIC_API_URL || "https://api.3dbpoint.com",
  defaultEloadApiKey: process.env.ELOAD_API_KEY || "3dbpoint-demo-key",
  defaultEloadApiSecret: process.env.ELOAD_API_SECRET || "3dbpoint-demo-secret-change-me",
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
      users: [],
      chats: [],
      remoteAccess: [],
      eload: {
        accounts: [
          {
            id: id("elo"),
            name: "Default 3DBPointLabs account",
            apiKey: env.defaultEloadApiKey,
            apiSecret: env.defaultEloadApiSecret,
            balance: 0,
            status: "active",
            createdAt: now(),
            updatedAt: now(),
          },
        ],
        products: defaultEloadProducts(),
        orders: [],
      },
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

function ensureEload(db) {
  db.eload ||= {};
  db.eload.accounts ||= [];
  db.eload.products ||= defaultEloadProducts();
  db.eload.orders ||= [];
  if (db.eload.accounts.length === 0) {
    db.eload.accounts.push({
      id: id("elo"),
      name: "Default 3DBPointLabs account",
      apiKey: env.defaultEloadApiKey,
      apiSecret: env.defaultEloadApiSecret,
      balance: 0,
      status: "active",
      createdAt: now(),
      updatedAt: now(),
    });
  }
  if (db.eload.products.length === 0) db.eload.products = defaultEloadProducts();
  return db.eload;
}

function ensureCore(db) {
  db.devices ||= [];
  db.licenses ||= [];
  db.users ||= [];
  db.chats ||= [];
  db.remoteAccess ||= [];
  db.operations ||= [];
  db.apiTokens ||= [];
  db.audit ||= [];
  ensureEload(db);
  return db;
}

function defaultEloadProducts() {
  return [
    eloadProduct("SMART10", "Smart Regular Load 10", 10, ["smart", "tnt"]),
    eloadProduct("SMART20", "Smart Regular Load 20", 20, ["smart", "tnt"]),
    eloadProduct("SMART50", "Smart Regular Load 50", 50, ["smart", "tnt"]),
    eloadProduct("GLOBE10", "Globe Regular Load 10", 10, ["globe", "tm"]),
    eloadProduct("GLOBE20", "Globe Regular Load 20", 20, ["globe", "tm"]),
    eloadProduct("GLOBE50", "Globe Regular Load 50", 50, ["globe", "tm"]),
    eloadProduct("DITO10", "DITO Regular Load 10", 10, ["dito"]),
    eloadProduct("DITO20", "DITO Regular Load 20", 20, ["dito"]),
  ];
}

function eloadProduct(code, name, price, networks, category = "eload") {
  return {
    id: code.toLowerCase(),
    code,
    name,
    description: "3DBPoint e-load product",
    category,
    price,
    currency: "PHP",
    status: "active",
    meta: { networks },
  };
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

function md5(value) {
  return crypto.createHash("md5").update(String(value)).digest("hex");
}

async function requireEloadAccount(req, db, rawBody = "") {
  const eload = ensureEload(db);
  const bearer = (req.headers.authorization || "").startsWith("Bearer ")
    ? (req.headers.authorization || "").slice(7).trim()
    : "";
  if (bearer) {
    const found = eload.accounts.find((account) => account.status === "active" && timingSafeEqual(account.apiKey, bearer));
    if (found) {
      found.lastUsedAt = now();
      await saveDb(db);
      return found;
    }
  }

  const key = String(req.headers["x-access-key"] || "");
  const nonce = String(req.headers["x-access-nonce"] || "");
  const signature = String(req.headers["x-access-signature"] || "");
  if (!key || !nonce || !signature) return null;

  const account = eload.accounts.find((entry) => entry.status === "active" && timingSafeEqual(entry.apiKey, key));
  if (!account) return null;
  const expected = md5(md5(nonce) + md5(rawBody || "") + md5(account.apiKey + account.apiSecret));
  if (!timingSafeEqual(signature, expected)) return null;
  account.lastUsedAt = now();
  await saveDb(db);
  return account;
}

function publicEloadAccount(account) {
  return {
    id: account.id,
    name: account.name,
    apiKey: account.apiKey,
    balance: Number(account.balance || 0),
    status: account.status,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastUsedAt: account.lastUsedAt || null,
  };
}

function publicOrder(order) {
  return {
    id: order.id,
    transactionId: order.id,
    status: order.status,
    productCode: order.productCode,
    recipient: order.recipient,
    amount: Number(order.amount || 0),
    currency: order.currency || "PHP",
    clientReference: order.clientReference || null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
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
    syncPolicy: license.expiresAt ? "expires_at" : "never_expire_offline",
    issuedAt: license.issuedAt,
    updatedAt: license.updatedAt,
  };
}

function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `pbkdf2:${salt}:${crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || "").split(":");
  if (kind !== "pbkdf2" || !salt || !hash) return false;
  const check = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return timingSafeEqual(check, hash);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name || "",
    status: user.status || "active",
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function deviceRegistrationPayload(user, device, license, token = "") {
  return {
    owner: {
      id: user.id,
      email: user.email,
      name: user.name || user.email,
      bearerToken: token,
    },
    device,
    license: license ? {
      licenseType: "LICENSED",
      license: license.key,
      status: licenseStatus(license),
      expirationDate: license.expiresAt || "",
      expiresAt: license.expiresAt || null,
      licenseMeta: {
        charging: Boolean(license.charging),
        vendos: Number(license.vendos || 0),
        desktops: Number(license.desktops || 0),
      },
    } : null,
  };
}

function publicChatMessage(message) {
  return {
    id: message.id,
    deviceSerial: message.deviceSerial,
    user: message.user || null,
    sender: message.sender,
    senderAdmin: Boolean(message.senderAdmin),
    message: message.message,
    status: message.status || "unread",
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

function publicOperation(operation) {
  return {
    id: operation.id,
    deviceSerial: operation.deviceSerial,
    command: operation.command,
    payload: operation.payload || {},
    status: operation.status || "pending",
    result: operation.result || null,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    acknowledgedAt: operation.acknowledgedAt || null,
  };
}

function activeLicenseForDevice(db, serial) {
  return db.licenses.find((item) => item.deviceSerial === serial && licenseStatus(item) === "active") || null;
}

function remoteUrl(slug) {
  return `${String(env.publicRemoteBaseUrl).replace(/\/+$/, "")}/r/${encodeURIComponent(slug)}`;
}

function publicRemoteAccess(remote, db) {
  const license = activeLicenseForDevice(db, remote.deviceSerial);
  return {
    id: remote.id,
    deviceSerial: remote.deviceSerial,
    slug: remote.slug,
    url: remoteUrl(remote.slug),
    status: license && remote.status === "active" ? "active" : "license_required",
    target: remote.target || "http://10.0.0.1",
    lastSeenAt: remote.lastSeenAt || null,
    createdAt: remote.createdAt,
    updatedAt: remote.updatedAt,
  };
}

function ensureRemoteForLicensedDevice(db, serial, target = "http://10.0.0.1") {
  const license = activeLicenseForDevice(db, serial);
  if (!license) return { error: "license_required" };
  let remote = db.remoteAccess.find((item) => item.deviceSerial === serial);
  if (!remote) {
    remote = {
      id: id("rem"),
      deviceSerial: serial,
      slug: `opi-${crypto.randomBytes(5).toString("hex")}`,
      target,
      status: "active",
      createdAt: now(),
      updatedAt: now(),
      lastSeenAt: null,
    };
    db.remoteAccess.push(remote);
  } else {
    remote.status = "active";
    remote.target = target || remote.target || "http://10.0.0.1";
    remote.updatedAt = now();
  }
  return { remote, license };
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
    input,select,textarea{width:100%;padding:10px;border:1px solid #cfd7e6;border-radius:6px;background:#fff} textarea{min-height:96px} label{font-weight:650;display:block;margin:10px 0 4px}
    button,.btn{display:inline-block;background:var(--brand);color:#fff;border:0;border-radius:6px;padding:9px 12px;cursor:pointer}.secondary,.btn.secondary{background:#475569}.danger,.btn.danger{background:#dc2626}.success,.btn.success{background:#16a34a}.warning,.btn.warning{background:#f59e0b;color:#111827}
    .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.pill{display:inline-block;padding:3px 8px;border-radius:999px;background:#e2e8f0}.ok{background:#dcfce7;color:#166534}.bad{background:#fee2e2;color:#991b1b}.warn{background:#fef3c7;color:#92400e}
    .actions{display:flex;gap:8px;flex-wrap:wrap}.actions form{display:inline}.split{display:grid;grid-template-columns:1fr 1fr;gap:16px}.stack>*+*{margin-top:10px}.tiny{font-size:12px}.scroll{overflow:auto}
    pre{white-space:pre-wrap;background:#0f172a;color:#dbeafe;padding:14px;border-radius:8px;overflow:auto}
    @media(max-width:760px){.top{display:block}nav a{display:inline-block;margin:8px 10px 0 0}.split{grid-template-columns:1fr}}
  </style>
</head>
<body>
<header><div class="top"><div class="brand">3DBPoint CPanel</div><nav><a href="/">Dashboard</a><a href="/admin/devices">Devices</a><a href="/admin/licenses">Licenses</a><a href="/admin/users">Users</a><a href="/admin/remotes">Remote IP</a><a href="/admin/operations">Operations</a><a href="/admin/chats">Chats</a><a href="/admin/eload">E-Load</a><a href="/admin/tokens">API Tokens</a><a href="/admin/audit">Audit</a><a href="/docs">Docs</a><form method="post" action="/logout" style="display:inline"><button class="secondary" style="padding:6px 9px;margin-left:12px">Logout</button></form></nav></div></header>
<main class="wrap">${body}</main>
</body></html>`;
}

function loginPage(message = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>3DBPoint Login</title><style>body{font-family:system-ui;background:#f5f7fb;display:grid;place-items:center;height:100vh;margin:0}.box{background:#fff;padding:26px;border:1px solid #dde3ee;border-radius:10px;width:min(380px,92vw)}input,button{width:100%;padding:11px;margin:8px 0;border-radius:6px;border:1px solid #cfd7e6}button{background:#1463ff;color:white;border:0}.err{color:#991b1b}</style></head><body><form class="box" method="post" action="/login"><h1>3DBPoint</h1><p>License admin login</p>${message ? `<p class="err">${escapeHtml(message)}</p>` : ""}<input name="username" placeholder="Username" autocomplete="username"><input name="password" placeholder="Password" type="password" autocomplete="current-password"><button>Login</button></form></body></html>`;
}

async function admin(req, res, url, db) {
  ensureCore(db);
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
    ensureEload(db);
    const active = db.licenses.filter((license) => licenseStatus(license) === "active").length;
    const pendingOps = db.operations.filter((operation) => (operation.status || "pending") === "pending").length;
    const activeRemotes = db.remoteAccess.filter((remote) => publicRemoteAccess(remote, db).status === "active").length;
    const orderCount = db.eload.orders.length;
    const balance = db.eload.accounts.reduce((sum, account) => sum + Number(account.balance || 0), 0);
    return send(res, 200, page("Dashboard", `
      <h1>Dashboard</h1>
      <div class="grid">
        <div class="card"><div class="metric">${db.devices.length}</div><div class="muted">Devices</div></div>
        <div class="card"><div class="metric">${db.licenses.length}</div><div class="muted">Licenses</div></div>
        <div class="card"><div class="metric">${active}</div><div class="muted">Active Licenses</div></div>
        <div class="card"><div class="metric">${balance.toFixed(2)}</div><div class="muted">E-Load Balance</div></div>
        <div class="card"><div class="metric">${db.apiTokens.length}</div><div class="muted">API Tokens</div></div>
        <div class="card"><div class="metric">${db.users.length}</div><div class="muted">Users</div></div>
        <div class="card"><div class="metric">${db.chats.filter((m) => m.status === "unread" && !m.senderAdmin).length}</div><div class="muted">Unread Chats</div></div>
        <div class="card"><div class="metric">${pendingOps}</div><div class="muted">Pending Operations</div></div>
        <div class="card"><div class="metric">${activeRemotes}</div><div class="muted">Active Remote IPs</div></div>
        <div class="card"><div class="metric">${orderCount}</div><div class="muted">E-Load Orders</div></div>
      </div>
      <div class="panel"><h2>Remote Access</h2><p>Create a public remote URL only for Orange Pi devices that already have an active license.</p><p class="actions"><a class="btn" href="/admin/remotes">Create Remote IP</a><a class="btn secondary" href="/admin/chats">Open Chats</a><a class="btn success" href="/admin/eload">Manage E-Load</a></p></div>
      <div class="panel"><h2>Domains</h2><p><b>API:</b> ${escapeHtml(env.publicApiUrl)}</p><p><b>Admin:</b> ${escapeHtml(env.publicAdminUrl)}</p></div>
    `), { "Content-Type": "text/html" });
  }

  if (url.pathname === "/admin/devices" && req.method === "POST") {
    const form = await formBody(req);
    const serial = String(form.serial || "").trim();
    if (serial && !db.devices.some((d) => d.serial === serial)) {
      db.devices.push({ id: id("dev"), serial, name: String(form.name || serial), status: "active", ownerUserId: String(form.ownerUserId || "") || null, createdAt: now(), updatedAt: now(), lastSeenAt: null });
      db.audit.push({ at: now(), action: "device.created", serial });
      await saveDb(db);
    }
    return redirect(res, "/admin/devices");
  }

  const deviceAction = url.pathname.match(/^\/admin\/devices\/([^/]+)\/(update|disable|enable)$/);
  if (deviceAction && req.method === "POST") {
    const device = db.devices.find((item) => item.id === deviceAction[1]);
    if (device) {
      if (deviceAction[2] === "update") {
        const form = await formBody(req);
        device.name = String(form.name || device.name || device.serial);
        device.ownerUserId = String(form.ownerUserId || "") || null;
      } else {
        device.status = deviceAction[2] === "disable" ? "disabled" : "active";
      }
      device.updatedAt = now();
      db.audit.push({ at: now(), action: `device.${deviceAction[2]}`, serial: device.serial });
      await saveDb(db);
    }
    return redirect(res, "/admin/devices");
  }

  if (url.pathname === "/admin/devices") {
    return send(res, 200, page("Devices", `
      <h1>Devices</h1>
      <div class="panel"><form method="post"><div class="row"><div><label>Serial</label><input name="serial" required></div><div><label>Name</label><input name="name"></div><div><label>Owner</label><select name="ownerUserId"><option value="">No owner</option>${db.users.map((u) => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.email)}</option>`).join("")}</select></div></div><p><button>Add Device</button></p></form></div>
      <div class="panel scroll"><table><thead><tr><th>Serial</th><th>Name / Owner</th><th>Status</th><th>License</th><th>Last Seen</th><th>Remote Actions</th></tr></thead><tbody>${db.devices.map((d) => {
        const owner = d.ownerUserId ? db.users.find((u) => u.id === d.ownerUserId) : null;
        const license = activeLicenseForDevice(db, d.serial);
        return `<tr><td><code>${escapeHtml(d.serial)}</code></td><td><form method="post" action="/admin/devices/${escapeHtml(d.id)}/update"><label class="tiny">Name</label><input name="name" value="${escapeHtml(d.name)}"><label class="tiny">Owner</label><select name="ownerUserId"><option value="">No owner</option>${db.users.map((u) => `<option value="${escapeHtml(u.id)}" ${u.id === d.ownerUserId ? "selected" : ""}>${escapeHtml(u.email)}</option>`).join("")}</select><p><button class="secondary">Save</button></p></form>${owner ? `<span class="muted tiny">Owner: ${escapeHtml(owner.email)}</span>` : ""}</td><td><span class="pill ${d.status === "active" ? "ok" : "bad"}">${escapeHtml(d.status)}</span></td><td>${license ? `<span class="pill ok">${escapeHtml(license.plan)}</span><br><small>${escapeHtml(license.expiresAt || "never expires")}</small>` : `<span class="pill bad">No active license</span>`}</td><td>${escapeHtml(d.lastSeenAt || "")}</td><td><div class="actions"><form method="post" action="/admin/operations"><input type="hidden" name="deviceSerial" value="${escapeHtml(d.serial)}"><input type="hidden" name="command" value="sync-license"><button>Sync License</button></form><form method="post" action="/admin/operations"><input type="hidden" name="deviceSerial" value="${escapeHtml(d.serial)}"><input type="hidden" name="command" value="reload-portal"><button class="success">Reload Portal</button></form><form method="post" action="/admin/devices/${escapeHtml(d.id)}/${d.status === "active" ? "disable" : "enable"}"><button class="${d.status === "active" ? "danger" : "success"}">${d.status === "active" ? "Disable" : "Enable"}</button></form></div></td></tr>`;
      }).join("")}</tbody></table></div>
    `), { "Content-Type": "text/html" });
  }

  if (url.pathname === "/admin/users" && req.method === "POST") {
    const form = await formBody(req);
    const email = String(form.email || "").trim().toLowerCase();
    const password = String(form.password || "");
    const name = String(form.name || email).trim();
    if (email && email.includes("@") && password.length >= 6 && !db.users.some((u) => u.email === email)) {
      db.users.push({ id: id("usr"), email, name, passwordHash: passwordHash(password), status: "active", createdAt: now(), updatedAt: now() });
      db.audit.push({ at: now(), action: "user.created_by_admin", email });
      await saveDb(db);
    }
    return redirect(res, "/admin/users");
  }

  const userAction = url.pathname.match(/^\/admin\/users\/([^/]+)\/(update|disable|enable|reset-password)$/);
  if (userAction && req.method === "POST") {
    const user = db.users.find((item) => item.id === userAction[1]);
    if (user) {
      const form = await formBody(req);
      if (userAction[2] === "update") {
        user.name = String(form.name || user.name || user.email);
      } else if (userAction[2] === "reset-password") {
        const password = String(form.password || "");
        if (password.length >= 6) user.passwordHash = passwordHash(password);
      } else {
        user.status = userAction[2] === "disable" ? "disabled" : "active";
      }
      user.updatedAt = now();
      db.audit.push({ at: now(), action: `user.${userAction[2]}`, email: user.email });
      await saveDb(db);
    }
    return redirect(res, "/admin/users");
  }

  if (url.pathname === "/admin/users") {
    return send(res, 200, page("Users", `
      <h1>Users</h1>
      <div class="panel"><h2>Create Portal User</h2><form method="post"><div class="row"><div><label>Email</label><input name="email" type="email" required></div><div><label>Name</label><input name="name"></div><div><label>Password</label><input name="password" type="password" minlength="6" required></div></div><p><button>Create User</button></p></form></div>
      <div class="panel scroll"><table><thead><tr><th>Email</th><th>Name</th><th>Status</th><th>Devices</th><th>Created</th><th>Remote Actions</th></tr></thead><tbody>${db.users.map((u) => {
        const count = db.devices.filter((d) => d.ownerUserId === u.id).length;
        return `<tr><td>${escapeHtml(u.email)}</td><td><form method="post" action="/admin/users/${escapeHtml(u.id)}/update"><input name="name" value="${escapeHtml(u.name || "")}"><p><button class="secondary">Save</button></p></form></td><td><span class="pill ${(u.status || "active") === "active" ? "ok" : "bad"}">${escapeHtml(u.status || "active")}</span></td><td>${count}</td><td>${escapeHtml(u.createdAt)}</td><td><div class="stack"><form method="post" action="/admin/users/${escapeHtml(u.id)}/${(u.status || "active") === "active" ? "disable" : "enable"}"><button class="${(u.status || "active") === "active" ? "danger" : "success"}">${(u.status || "active") === "active" ? "Disable" : "Enable"}</button></form><form method="post" action="/admin/users/${escapeHtml(u.id)}/reset-password"><input name="password" type="password" minlength="6" placeholder="New password"><p><button class="warning">Reset Password</button></p></form></div></td></tr>`;
      }).join("")}</tbody></table></div>
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

  const licenseAction = url.pathname.match(/^\/admin\/licenses\/([^/]+)\/(update|activate)$/);
  if (licenseAction && req.method === "POST") {
    const license = db.licenses.find((item) => item.id === licenseAction[1]);
    if (license) {
      if (licenseAction[2] === "update") {
        const form = await formBody(req);
        license.plan = String(form.plan || license.plan || "standard");
        license.vendos = Number(form.vendos || 0);
        license.desktops = Number(form.desktops || 0);
        license.charging = form.charging === "on";
        license.expiresAt = form.neverExpire === "on" ? null : (form.expiresAt || null);
      } else {
        license.status = "active";
      }
      license.updatedAt = now();
      db.audit.push({ at: now(), action: `license.${licenseAction[2]}`, key: license.key });
      await saveDb(db);
    }
    return redirect(res, "/admin/licenses");
  }

  if (url.pathname === "/admin/licenses") {
    return send(res, 200, page("Licenses", `
      <h1>Licenses</h1>
      <div class="panel"><form method="post"><div class="row"><div><label>Device Serial</label><input name="deviceSerial" list="device-serials" required><datalist id="device-serials">${db.devices.map((d) => `<option value="${escapeHtml(d.serial)}"></option>`).join("")}</datalist></div><div><label>Plan</label><input name="plan" value="standard"></div><div><label>Vendos</label><input name="vendos" type="number" value="1" min="0"></div><div><label>Desktops</label><input name="desktops" type="number" value="0" min="0"></div><div><label>Expires At</label><input name="expiresAt" type="date"><small class="muted">Leave blank for offline never-expire.</small></div><div><label>Charging</label><input name="charging" type="checkbox" checked></div></div><p><button>Create License</button></p></form></div>
      <div class="panel scroll"><table><thead><tr><th>Key</th><th>Device</th><th>Status</th><th>Edit License</th><th>Sync Policy</th><th>Actions</th></tr></thead><tbody>${db.licenses.map((l) => `<tr><td><code>${escapeHtml(l.key)}</code></td><td>${escapeHtml(l.deviceSerial)}</td><td><span class="pill ${licenseStatus(l) === "active" ? "ok" : "bad"}">${escapeHtml(licenseStatus(l))}</span></td><td><form method="post" action="/admin/licenses/${escapeHtml(l.id)}/update"><div class="row"><div><label class="tiny">Plan</label><input name="plan" value="${escapeHtml(l.plan)}"></div><div><label class="tiny">Vendos</label><input name="vendos" type="number" value="${escapeHtml(l.vendos)}" min="0"></div><div><label class="tiny">Desktops</label><input name="desktops" type="number" value="${escapeHtml(l.desktops)}" min="0"></div><div><label class="tiny">Expires</label><input name="expiresAt" type="date" value="${escapeHtml(l.expiresAt ? String(l.expiresAt).slice(0, 10) : "")}"></div><div><label class="tiny">Never Expire</label><input name="neverExpire" type="checkbox" ${l.expiresAt ? "" : "checked"}></div><div><label class="tiny">Charging</label><input name="charging" type="checkbox" ${l.charging ? "checked" : ""}></div></div><p><button class="secondary">Save</button></p></form></td><td>${escapeHtml(publicLicense(l).syncPolicy)}</td><td><div class="actions">${licenseStatus(l) === "active" ? `<form method="post" action="/admin/licenses/${escapeHtml(l.id)}/revoke"><button class="danger">Revoke</button></form>` : `<form method="post" action="/admin/licenses/${escapeHtml(l.id)}/activate"><button class="success">Activate</button></form>`}<form method="post" action="/admin/operations"><input type="hidden" name="deviceSerial" value="${escapeHtml(l.deviceSerial)}"><input type="hidden" name="command" value="sync-license"><button>Queue Sync</button></form></div></td></tr>`).join("")}</tbody></table></div>
    `), { "Content-Type": "text/html" });
  }

  if (url.pathname === "/admin/chats" && req.method === "POST") {
    const form = await formBody(req);
    const deviceSerial = String(form.deviceSerial || "").trim();
    const message = String(form.message || "").trim();
    if (deviceSerial && message) {
      const device = db.devices.find((d) => d.serial === deviceSerial);
      const user = device?.ownerUserId ? db.users.find((u) => u.id === device.ownerUserId) : null;
      db.chats.push({
        id: id("msg"),
        deviceSerial,
        user: user ? { id: user.id, email: user.email, name: user.name || "" } : null,
        sender: "admin",
        senderAdmin: true,
        message,
        status: "unread",
        createdAt: now(),
        updatedAt: now(),
      });
      db.audit.push({ at: now(), action: "chat.admin.sent", deviceSerial });
      await saveDb(db);
    }
    return redirect(res, `/admin/chats${deviceSerial ? `?deviceSerial=${encodeURIComponent(deviceSerial)}` : ""}`);
  }

  if (url.pathname === "/admin/chats") {
    const selected = String(url.searchParams.get("deviceSerial") || "").trim();
    const devicesWithChats = [...new Set([
      ...db.chats.map((m) => m.deviceSerial).filter(Boolean),
      ...db.devices.map((d) => d.serial).filter(Boolean),
    ])].sort();
    const shown = selected || devicesWithChats[0] || "";
    const messages = db.chats.filter((m) => !shown || m.deviceSerial === shown).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const m of messages) {
      if (!m.senderAdmin && m.status === "unread") {
        m.status = "read";
        m.updatedAt = now();
      }
    }
    await saveDb(db);
    return send(res, 200, page("Chats", `
      <h1>Chats</h1>
      <div class="panel">
        <form method="get" action="/admin/chats"><label>Device/User</label><select name="deviceSerial" onchange="this.form.submit()">${devicesWithChats.map((serial) => `<option value="${escapeHtml(serial)}" ${serial === shown ? "selected" : ""}>${escapeHtml(serial)}</option>`).join("")}</select></form>
      </div>
      <div class="panel">
        <h2>${shown ? `Conversation: ${escapeHtml(shown)}` : "No conversations yet"}</h2>
        <div>${messages.map((m) => `<p><span class="pill ${m.senderAdmin ? "ok" : ""}">${m.senderAdmin ? "Admin" : escapeHtml(m.user?.email || "User")}</span> ${escapeHtml(m.message)}<br><small class="muted">${escapeHtml(m.createdAt)}</small></p>`).join("")}</div>
        ${shown ? `<form method="post"><input type="hidden" name="deviceSerial" value="${escapeHtml(shown)}"><label>Admin message</label><input name="message" placeholder="Type reply to this user"><p><button>Send Message</button></p></form>` : ""}
      </div>
    `), { "Content-Type": "text/html" });
  }

  if (url.pathname === "/admin/remotes" && req.method === "POST") {
    const form = await formBody(req);
    const deviceSerial = String(form.deviceSerial || "").trim();
    const target = String(form.target || "http://10.0.0.1").trim();
    if (deviceSerial) {
      const result = ensureRemoteForLicensedDevice(db, deviceSerial, target);
      if (!result.error) {
        db.operations.push({
          id: id("op"),
          deviceSerial,
          command: "enable-remote-access",
          payload: { remoteUrl: remoteUrl(result.remote.slug), target: result.remote.target },
          status: "pending",
          result: null,
          createdAt: now(),
          updatedAt: now(),
          acknowledgedAt: null,
        });
        db.audit.push({ at: now(), action: "remote.created", deviceSerial, remoteUrl: remoteUrl(result.remote.slug) });
        await saveDb(db);
      } else {
        db.audit.push({ at: now(), action: "remote.denied_license_required", deviceSerial });
        await saveDb(db);
      }
    }
    return redirect(res, `/admin/remotes?deviceSerial=${encodeURIComponent(deviceSerial)}`);
  }

  const remoteAction = url.pathname.match(/^\/admin\/remotes\/([^/]+)\/(disable|enable)$/);
  if (remoteAction && req.method === "POST") {
    const remote = db.remoteAccess.find((item) => item.id === remoteAction[1]);
    if (remote) {
      if (remoteAction[2] === "enable" && !activeLicenseForDevice(db, remote.deviceSerial)) {
        db.audit.push({ at: now(), action: "remote.enable_denied_license_required", deviceSerial: remote.deviceSerial });
      } else {
        remote.status = remoteAction[2] === "enable" ? "active" : "disabled";
        remote.updatedAt = now();
        db.audit.push({ at: now(), action: `remote.${remoteAction[2]}`, deviceSerial: remote.deviceSerial });
      }
      await saveDb(db);
    }
    return redirect(res, "/admin/remotes");
  }

  if (url.pathname === "/admin/remotes") {
    const selected = String(url.searchParams.get("deviceSerial") || "").trim();
    const licensedDevices = db.devices.filter((device) => activeLicenseForDevice(db, device.serial));
    const unlicensedSelected = selected && !activeLicenseForDevice(db, selected);
    const remotes = db.remoteAccess.map((remote) => publicRemoteAccess(remote, db)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return send(res, 200, page("Remote IP", `
      <h1>Remote IP</h1>
      <div class="panel"><p>This creates a public/global URL only when the selected Orange Pi already has an active license. If the license is revoked/expired, the remote URL is blocked automatically.</p>${unlicensedSelected ? `<p><span class="pill bad">No active license for ${escapeHtml(selected)}. Remote IP was not created.</span></p>` : ""}</div>
      <div class="panel"><h2>Create Global Remote URL</h2><form method="post"><div class="row"><div><label>Licensed Device</label><input name="deviceSerial" list="licensed-device-serials" value="${escapeHtml(selected)}" required><datalist id="licensed-device-serials">${licensedDevices.map((d) => `<option value="${escapeHtml(d.serial)}">${escapeHtml(d.name || d.serial)}</option>`).join("")}</datalist><small class="muted">Only devices with active licenses are accepted.</small></div><div><label>Pi Local Target</label><input name="target" value="http://10.0.0.1"><small class="muted">The Pi/tunnel agent will connect this target to the public URL.</small></div></div><p><button>Create Remote IP</button></p></form></div>
      <div class="panel scroll"><h2>Remote URLs</h2><table><thead><tr><th>Device</th><th>Global URL</th><th>Status</th><th>Target</th><th>Created</th><th>Actions</th></tr></thead><tbody>${remotes.map((remote) => `<tr><td><code>${escapeHtml(remote.deviceSerial)}</code></td><td><a href="${escapeHtml(remote.url)}" target="_blank" rel="noreferrer">${escapeHtml(remote.url)}</a></td><td><span class="pill ${remote.status === "active" ? "ok" : "bad"}">${escapeHtml(remote.status)}</span></td><td>${escapeHtml(remote.target)}</td><td>${escapeHtml(remote.createdAt)}</td><td><form method="post" action="/admin/remotes/${escapeHtml(remote.id)}/${remote.status === "active" ? "disable" : "enable"}"><button class="${remote.status === "active" ? "danger" : "success"}">${remote.status === "active" ? "Disable" : "Enable"}</button></form></td></tr>`).join("")}</tbody></table></div>
    `), { "Content-Type": "text/html" });
  }

  if (url.pathname === "/admin/operations" && req.method === "POST") {
    const form = await formBody(req);
    const deviceSerial = String(form.deviceSerial || "").trim();
    const command = String(form.command || "").trim();
    let payload = {};
    const rawPayload = String(form.payload || "").trim();
    if (rawPayload) {
      try {
        payload = JSON.parse(rawPayload);
      } catch {
        payload = { note: rawPayload };
      }
    }
    if (deviceSerial && command) {
      db.operations.push({
        id: id("op"),
        deviceSerial,
        command,
        payload,
        status: "pending",
        result: null,
        createdAt: now(),
        updatedAt: now(),
        acknowledgedAt: null,
      });
      db.audit.push({ at: now(), action: "operation.queued", deviceSerial, command });
      await saveDb(db);
    }
    return redirect(res, "/admin/operations");
  }

  const operationAction = url.pathname.match(/^\/admin\/operations\/([^/]+)\/(cancel|retry)$/);
  if (operationAction && req.method === "POST") {
    const operation = db.operations.find((item) => item.id === operationAction[1]);
    if (operation) {
      operation.status = operationAction[2] === "retry" ? "pending" : "cancelled";
      operation.updatedAt = now();
      db.audit.push({ at: now(), action: `operation.${operationAction[2]}`, operationId: operation.id });
      await saveDb(db);
    }
    return redirect(res, "/admin/operations");
  }

  if (url.pathname === "/admin/operations") {
    const commands = ["sync-license", "reload-portal", "restart-services", "pull-config", "reboot", "custom"];
    const recent = [...db.operations].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 200);
    return send(res, 200, page("Remote Operations", `
      <h1>Remote Operations</h1>
      <div class="panel"><p>Queue commands for Orange Pi devices. The device can poll <code>GET /api/v1/devices/:serial/operations</code> using the normal bearer API token, then acknowledge with <code>POST /api/v1/operations/:id/ack</code>.</p></div>
      <div class="panel"><h2>Queue Command</h2><form method="post"><div class="row"><div><label>Device Serial</label><input name="deviceSerial" list="operation-device-serials" required><datalist id="operation-device-serials">${db.devices.map((d) => `<option value="${escapeHtml(d.serial)}"></option>`).join("")}</datalist></div><div><label>Command</label><select name="command">${commands.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")}</select></div></div><label>Payload JSON or note</label><textarea name="payload" placeholder='{"service":"nginx"}'></textarea><p><button>Queue Operation</button></p></form></div>
      <div class="panel scroll"><h2>Recent Operations</h2><table><thead><tr><th>Device</th><th>Command</th><th>Status</th><th>Payload / Result</th><th>Created</th><th>Actions</th></tr></thead><tbody>${recent.map((op) => `<tr><td><code>${escapeHtml(op.deviceSerial)}</code></td><td>${escapeHtml(op.command)}</td><td><span class="pill ${op.status === "done" ? "ok" : op.status === "failed" || op.status === "cancelled" ? "bad" : "warn"}">${escapeHtml(op.status || "pending")}</span></td><td><small>Payload</small><pre>${escapeHtml(JSON.stringify(op.payload || {}, null, 2))}</pre>${op.result ? `<small>Result</small><pre>${escapeHtml(JSON.stringify(op.result, null, 2))}</pre>` : ""}</td><td>${escapeHtml(op.createdAt)}${op.acknowledgedAt ? `<br><small class="muted">Ack: ${escapeHtml(op.acknowledgedAt)}</small>` : ""}</td><td><div class="actions"><form method="post" action="/admin/operations/${escapeHtml(op.id)}/retry"><button>Retry</button></form><form method="post" action="/admin/operations/${escapeHtml(op.id)}/cancel"><button class="danger">Cancel</button></form></div></td></tr>`).join("")}</tbody></table></div>
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

  if (url.pathname === "/admin/eload" && req.method === "POST") {
    const form = await formBody(req);
    const eload = ensureEload(db);
    if (form.action === "create-account") {
      const apiKey = `3db_${crypto.randomBytes(12).toString("hex")}`;
      const apiSecret = crypto.randomBytes(24).toString("base64url");
      eload.accounts.push({
        id: id("elo"),
        name: String(form.name || "3DBPointLabs account"),
        apiKey,
        apiSecret,
        balance: Number(form.balance || 0),
        status: "active",
        createdAt: now(),
        updatedAt: now(),
      });
      await saveDb(db);
      return send(res, 200, page("New E-Load Credentials", `<h1>New E-Load Credentials</h1><div class="panel"><p>Copy these into the Orange Pi Eload Settings page. The secret is shown once here.</p><label>API Key</label><pre>${escapeHtml(apiKey)}</pre><label>API Secret</label><pre>${escapeHtml(apiSecret)}</pre><p><a class="btn" href="/admin/eload">Back</a></p></div>`), { "Content-Type": "text/html" });
    }
    if (form.action === "add-balance") {
      const account = eload.accounts.find((item) => item.id === form.accountId);
      if (account) {
        account.balance = Number(account.balance || 0) + Math.max(0, Number(form.amount || 0));
        account.updatedAt = now();
        db.audit.push({ at: now(), action: "eload.balance.added", accountId: account.id, amount: Number(form.amount || 0) });
        await saveDb(db);
      }
    }
    if (form.action === "set-account-status") {
      const account = eload.accounts.find((item) => item.id === form.accountId);
      if (account) {
        account.status = String(form.status || "active");
        account.updatedAt = now();
        db.audit.push({ at: now(), action: "eload.account.status", accountId: account.id, status: account.status });
        await saveDb(db);
      }
    }
    if (form.action === "upsert-product") {
      const code = String(form.code || "").trim().toUpperCase();
      const price = Number(form.price || 0);
      if (code && price >= 0) {
        const networks = String(form.networks || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
        let product = eload.products.find((item) => item.code === code);
        if (!product) {
          product = eloadProduct(code, String(form.name || code), price, networks, String(form.category || "eload"));
          eload.products.push(product);
        }
        product.name = String(form.name || product.name || code);
        product.description = String(form.description || product.description || "3DBPoint e-load product");
        product.category = String(form.category || product.category || "eload");
        product.price = price;
        product.status = String(form.status || product.status || "active");
        product.meta = { ...(product.meta || {}), networks };
        product.updatedAt = now();
        db.audit.push({ at: now(), action: "eload.product.upserted", code });
        await saveDb(db);
      }
    }
    return redirect(res, "/admin/eload");
  }

  if (url.pathname === "/admin/eload") {
    const eload = ensureEload(db);
    return send(res, 200, page("E-Load", `
      <h1>E-Load Provider</h1>
      <div class="panel">
        <h2>Create API Credentials</h2>
        <form method="post">
          <input type="hidden" name="action" value="create-account">
          <div class="row"><div><label>Name</label><input name="name" value="Orange Pi e-load"></div><div><label>Starting Balance</label><input name="balance" type="number" step="0.01" value="0"></div></div>
          <p><button>Create E-Load API Key</button></p>
        </form>
      </div>
      <div class="panel">
        <h2>Accounts / Balance</h2>
        <table><thead><tr><th>Name</th><th>API Key</th><th>Balance</th><th>Status</th><th>Remote Actions</th></tr></thead><tbody>${eload.accounts.map((a) => `<tr><td>${escapeHtml(a.name)}</td><td><code>${escapeHtml(a.apiKey)}</code></td><td>${Number(a.balance || 0).toFixed(2)}</td><td><span class="pill ${a.status === "active" ? "ok" : "bad"}">${escapeHtml(a.status)}</span></td><td><div class="stack"><form method="post" style="display:flex;gap:8px"><input type="hidden" name="action" value="add-balance"><input type="hidden" name="accountId" value="${escapeHtml(a.id)}"><input name="amount" type="number" step="0.01" min="0" placeholder="Amount"><button>Add Balance</button></form><form method="post" class="actions"><input type="hidden" name="action" value="set-account-status"><input type="hidden" name="accountId" value="${escapeHtml(a.id)}"><select name="status" style="max-width:140px"><option value="active" ${a.status === "active" ? "selected" : ""}>active</option><option value="disabled" ${a.status === "disabled" ? "selected" : ""}>disabled</option></select><button class="secondary">Set</button></form></div></td></tr>`).join("")}</tbody></table>
      </div>
      <div class="panel">
        <h2>Add / Update Product</h2>
        <form method="post"><input type="hidden" name="action" value="upsert-product"><div class="row"><div><label>Code</label><input name="code" required placeholder="GLOBE10"></div><div><label>Name</label><input name="name" required></div><div><label>Price</label><input name="price" type="number" step="0.01" min="0" required></div><div><label>Category</label><input name="category" value="eload"></div><div><label>Networks</label><input name="networks" placeholder="globe,tm"></div><div><label>Status</label><select name="status"><option value="active">active</option><option value="disabled">disabled</option></select></div></div><label>Description</label><input name="description" value="3DBPoint e-load product"><p><button>Save Product</button></p></form>
      </div>
      <div class="panel scroll">
        <h2>Products</h2>
        <table><thead><tr><th>Code</th><th>Name</th><th>Price</th><th>Status</th><th>Networks</th><th>Edit</th></tr></thead><tbody>${eload.products.map((p) => `<tr><td><code>${escapeHtml(p.code)}</code></td><td>${escapeHtml(p.name)}</td><td>${Number(p.price || 0).toFixed(2)}</td><td><span class="pill ${p.status === "active" ? "ok" : "bad"}">${escapeHtml(p.status)}</span></td><td>${escapeHtml((p.meta?.networks || []).join(", "))}</td><td><form method="post"><input type="hidden" name="action" value="upsert-product"><input type="hidden" name="code" value="${escapeHtml(p.code)}"><input name="name" value="${escapeHtml(p.name)}"><input name="price" type="number" step="0.01" min="0" value="${escapeHtml(p.price)}"><input name="category" value="${escapeHtml(p.category)}"><input name="networks" value="${escapeHtml((p.meta?.networks || []).join(", "))}"><select name="status"><option value="active" ${p.status === "active" ? "selected" : ""}>active</option><option value="disabled" ${p.status === "disabled" ? "selected" : ""}>disabled</option></select><input name="description" value="${escapeHtml(p.description || "")}"><p><button class="secondary">Update</button></p></form></td></tr>`).join("")}</tbody></table>
      </div>
      <div class="panel scroll">
        <h2>Recent Orders</h2>
        <table><thead><tr><th>ID</th><th>Account</th><th>Product</th><th>Recipient</th><th>Amount</th><th>Status</th><th>Created</th></tr></thead><tbody>${[...eload.orders].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 100).map((o) => {
          const account = eload.accounts.find((a) => a.id === o.accountId);
          return `<tr><td><code>${escapeHtml(o.id)}</code></td><td>${escapeHtml(account?.name || o.accountId || "")}</td><td>${escapeHtml(o.productCode)}</td><td>${escapeHtml(o.recipient)}</td><td>${Number(o.amount || 0).toFixed(2)}</td><td><span class="pill ${o.status === "success" ? "ok" : "warn"}">${escapeHtml(o.status)}</span></td><td>${escapeHtml(o.createdAt)}</td></tr>`;
        }).join("")}</tbody></table>
      </div>
    `), { "Content-Type": "text/html" });
  }

  if (url.pathname === "/admin/audit") {
    const events = [...db.audit].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 500);
    return send(res, 200, page("Audit", `
      <h1>Audit Log</h1>
      <div class="panel scroll"><table><thead><tr><th>Time</th><th>Action</th><th>Details</th></tr></thead><tbody>${events.map((event) => `<tr><td>${escapeHtml(event.at)}</td><td><span class="pill">${escapeHtml(event.action)}</span></td><td><pre>${escapeHtml(JSON.stringify(Object.fromEntries(Object.entries(event).filter(([key]) => key !== "at" && key !== "action")), null, 2))}</pre></td></tr>`).join("")}</tbody></table></div>
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
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/devices/register-user
POST /api/v1/devices/register
GET  /api/v1/devices/:serial/license
POST /api/v1/licenses/validate
GET  /api/v1/chats/messages?deviceSerial=...
POST /api/v1/chats/messages
GET  /api/v1/devices/:serial/remote-access
GET  /api/v1/devices/:serial/operations
POST /api/v1/operations/:id/ack</pre>
      </div>
    `), { "Content-Type": "text/html" });
  }

  const remoteVisit = url.pathname.match(/^\/r\/([^/]+)$/);
  if (remoteVisit && req.method === "GET") {
    const slug = decodeURIComponent(remoteVisit[1]);
    const remote = db.remoteAccess.find((item) => item.slug === slug);
    if (!remote) return send(res, 404, page("Remote not found", "<h1>Remote IP not found</h1>"), { "Content-Type": "text/html" });
    const publicRemote = publicRemoteAccess(remote, db);
    if (publicRemote.status !== "active") {
      return send(res, 403, page("Remote blocked", `<h1>Remote IP blocked</h1><div class="panel"><p>This Orange Pi has no active license, so remote access is disabled.</p><p><b>Device:</b> <code>${escapeHtml(publicRemote.deviceSerial)}</code></p></div>`), { "Content-Type": "text/html" });
    }
    return send(res, 200, page("Remote IP", `
      <h1>Remote IP Ready</h1>
      <div class="panel">
        <p><b>Device:</b> <code>${escapeHtml(publicRemote.deviceSerial)}</code></p>
        <p><b>Target:</b> ${escapeHtml(publicRemote.target)}</p>
        <p><b>Status:</b> <span class="pill ok">licensed</span></p>
        <p>This URL is reserved and license-gated. To make it show the live Orange Pi admin page, install/connect the Pi tunnel agent so it can bind <code>${escapeHtml(publicRemote.target)}</code> to this global URL.</p>
      </div>
    `), { "Content-Type": "text/html" });
  }

  return send(res, 404, page("Not found", "<h1>Not found</h1>"), { "Content-Type": "text/html" });
}

async function api(req, res, url, db) {
  ensureCore(db);
  if (url.pathname === "/api/v1/status") return json(res, 200, { data: { status: "ok", service: "3dbpoint-license-platform", time: now() } });

  if ((url.pathname === "/api/v1/auth/register" || url.pathname === "/api/v1/users/register") && req.method === "POST") {
    const body = await jsonBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const name = String(body.name || email).trim();
    if (!email || !email.includes("@")) return json(res, 422, { error: { code: "validation_error", message: "Valid email is required" } });
    if (password.length < 6) return json(res, 422, { error: { code: "validation_error", message: "Password must be at least 6 characters" } });
    let user = db.users.find((u) => u.email === email);
    if (user) return json(res, 409, { error: { code: "email_taken", message: "Email is already registered" } });
    user = { id: id("usr"), email, name, passwordHash: passwordHash(password), status: "active", createdAt: now(), updatedAt: now() };
    db.users.push(user);
    db.audit.push({ at: now(), action: "user.created", email });
    await saveDb(db);
    return json(res, 201, { data: { user: publicUser(user) } });
  }

  if (url.pathname === "/api/v1/auth/login" && req.method === "POST") {
    const body = await jsonBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = db.users.find((u) => u.email === email && u.status !== "disabled");
    if (!user || !verifyPassword(password, user.passwordHash)) return json(res, 401, { error: { code: "invalid_credentials", message: "Invalid email or password" } });
    return json(res, 200, { data: { user: publicUser(user) } });
  }

  if (url.pathname === "/api/v1/devices/register-user" && req.method === "POST") {
    const body = await jsonBody(req);
    const serial = String(body.serial || body.deviceId || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const name = String(body.name || email).trim();
    if (!serial) return json(res, 422, { error: { code: "validation_error", message: "serial is required" } });
    if (!email || !email.includes("@")) return json(res, 422, { error: { code: "validation_error", message: "Valid email is required" } });
    if (password.length < 6) return json(res, 422, { error: { code: "validation_error", message: "Password must be at least 6 characters" } });

    let user = db.users.find((u) => u.email === email);
    if (!user) {
      user = { id: id("usr"), email, name, passwordHash: passwordHash(password), status: "active", createdAt: now(), updatedAt: now() };
      db.users.push(user);
      db.audit.push({ at: now(), action: "user.created_from_device", email, serial });
    } else if (!verifyPassword(password, user.passwordHash)) {
      return json(res, 401, { error: { code: "invalid_credentials", message: "Invalid email or password" } });
    }

    let device = db.devices.find((item) => item.serial === serial);
    if (!device) {
      device = { id: id("dev"), serial, name: body.deviceName || serial, status: "active", ownerUserId: user.id, createdAt: now(), updatedAt: now(), lastSeenAt: now() };
      db.devices.push(device);
    } else {
      device.ownerUserId = user.id;
      device.status = "active";
      device.lastSeenAt = now();
      device.updatedAt = now();
      if (body.deviceName) device.name = String(body.deviceName);
    }

    let license = db.licenses.find((item) => item.deviceSerial === serial && licenseStatus(item) === "active") || null;
    if (!license) {
      license = {
        id: id("lic"),
        key: `3DB-${crypto.randomBytes(4).toString("hex").toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
        deviceSerial: serial,
        plan: "self-registered",
        vendos: 1,
        desktops: 0,
        charging: true,
        status: "active",
        expiresAt: null,
        issuedAt: now(),
        updatedAt: now(),
      };
      db.licenses.push(license);
      db.audit.push({ at: now(), action: "license.auto_created_from_user_registration", key: license.key, serial });
    }
    db.audit.push({ at: now(), action: "device.registered_by_user", serial, email });
    await saveDb(db);
    return json(res, 200, { data: deviceRegistrationPayload(user, device, license) });
  }

  const eloadRoute = url.pathname === "/api/v1/wallets"
    || url.pathname === "/api/v1/account/status"
    || url.pathname === "/api/v1/products"
    || url.pathname === "/api/v1/orders"
    || /^\/api\/v1\/orders\/[^/]+$/.test(url.pathname);

  if (eloadRoute) {
    const rawBody = ["POST", "PUT", "PATCH"].includes(req.method || "") ? await readBody(req) : "";
    const account = await requireEloadAccount(req, db, rawBody);
    if (!account) return json(res, 401, { error: { code: "unauthorized", message: "Missing or invalid e-load API credentials" } });
    const eload = ensureEload(db);

    if (url.pathname === "/api/v1/wallets" && req.method === "GET") {
      return json(res, 200, {
        data: [
          {
            id: account.id,
            name: account.name,
            currency: "PHP",
            balance: Number(account.balance || 0),
            isDefault: true,
          },
        ],
      });
    }

    if (url.pathname === "/api/v1/account/status" && req.method === "GET") {
      return json(res, 200, {
        data: {
          account: publicEloadAccount(account),
          wallets: [
            {
              id: account.id,
              name: account.name,
              currency: "PHP",
              balance: Number(account.balance || 0),
              isDefault: true,
            },
          ],
          subscription: {
            id: "3dbpointlabs-live",
            status: "active",
            plan: "3DBPointLabs",
          },
        },
      });
    }

    if (url.pathname === "/api/v1/products" && req.method === "GET") {
      const category = url.searchParams.get("category") || "eload";
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") || 1000)));
      const products = eload.products
        .filter((product) => product.status !== "disabled" && (!category || product.category === category))
        .slice(0, limit);
      return json(res, 200, { data: { items: products } });
    }

    if (url.pathname === "/api/v1/orders" && req.method === "POST") {
      let body = {};
      try {
        body = rawBody.trim() ? JSON.parse(rawBody) : {};
      } catch {
        return json(res, 400, { errors: { payload: ["Invalid JSON"] } });
      }
      const payload = body.payload || body;
      const productCode = String(payload.productCode || payload.product_code || payload.code || "").trim();
      const recipient = String(payload.recipient || payload.mobile_number || payload.number || "").trim();
      const clientReference = String(payload.clientReference || payload.client_reference || "").trim();
      const product = eload.products.find((item) => item.code === productCode);
      if (!product) return json(res, 422, { errors: { code: ["Unknown product code"] } });
      if (!recipient) return json(res, 422, { errors: { recipient: ["Recipient is required"] } });
      const amount = Number(product.price || 0);
      if (Number(account.balance || 0) < amount) return json(res, 402, { errors: { balance: ["Insufficient e-load balance"] } });
      account.balance = Number(account.balance || 0) - amount;
      account.updatedAt = now();
      const order = {
        id: id("ord"),
        accountId: account.id,
        productCode,
        recipient,
        clientReference,
        amount,
        currency: "PHP",
        status: "success",
        request: payload,
        createdAt: now(),
        updatedAt: now(),
      };
      eload.orders.push(order);
      db.audit.push({ at: now(), action: "eload.order.created", orderId: order.id, accountId: account.id, amount });
      await saveDb(db);
      return json(res, 200, { status: "200", data: publicOrder(order) });
    }

    const orderMatch = url.pathname.match(/^\/api\/v1\/orders\/([^/]+)$/);
    if (orderMatch && req.method === "GET") {
      const orderId = decodeURIComponent(orderMatch[1]);
      const order = eload.orders.find((item) => item.id === orderId && item.accountId === account.id);
      if (!order) return json(res, 404, { error: { code: "not_found", message: "Order not found" } });
      return json(res, 200, { data: publicOrder(order) });
    }

    return json(res, 404, { error: { code: "not_found", message: "E-load API endpoint not found" } });
  }

  if (!(await requireApiToken(req, db))) {
    return json(res, 401, { error: { code: "unauthorized", message: "Missing or invalid bearer token" } });
  }

  const deviceOperations = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)\/operations$/);
  if (deviceOperations && req.method === "GET") {
    const serial = decodeURIComponent(deviceOperations[1]);
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 20)));
    const operations = db.operations
      .filter((operation) => operation.deviceSerial === serial && (operation.status || "pending") === "pending")
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(0, limit)
      .map(publicOperation);
    const device = db.devices.find((item) => item.serial === serial);
    if (device) {
      device.lastSeenAt = now();
      device.updatedAt = now();
      await saveDb(db);
    }
    return json(res, 200, { data: { operations } });
  }

  const deviceRemote = url.pathname.match(/^\/api\/v1\/devices\/([^/]+)\/remote-access$/);
  if (deviceRemote && req.method === "GET") {
    const serial = decodeURIComponent(deviceRemote[1]);
    const remote = db.remoteAccess.find((item) => item.deviceSerial === serial);
    if (!remote) {
      return json(res, 404, { error: { code: "not_found", message: "No remote URL created for this device" } });
    }
    return json(res, 200, { data: publicRemoteAccess(remote, db) });
  }

  const operationAck = url.pathname.match(/^\/api\/v1\/operations\/([^/]+)\/ack$/);
  if (operationAck && req.method === "POST") {
    const body = await jsonBody(req);
    const operation = db.operations.find((item) => item.id === operationAck[1]);
    if (!operation) return json(res, 404, { error: { code: "not_found", message: "Operation not found" } });
    operation.status = String(body.status || "done");
    operation.result = body.result || null;
    operation.acknowledgedAt = now();
    operation.updatedAt = now();
    db.audit.push({ at: now(), action: "operation.acknowledged", operationId: operation.id, status: operation.status });
    await saveDb(db);
    return json(res, 200, { data: publicOperation(operation) });
  }

  if (url.pathname === "/api/v1/admin/summary" && req.method === "GET") {
    ensureEload(db);
    return json(res, 200, {
      data: {
        devices: db.devices.length,
        users: db.users.length,
        licenses: db.licenses.length,
        activeLicenses: db.licenses.filter((license) => licenseStatus(license) === "active").length,
        pendingOperations: db.operations.filter((operation) => (operation.status || "pending") === "pending").length,
        unreadChats: db.chats.filter((m) => m.status === "unread" && !m.senderAdmin).length,
        eloadBalance: db.eload.accounts.reduce((sum, account) => sum + Number(account.balance || 0), 0),
        eloadOrders: db.eload.orders.length,
      },
    });
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

  if (url.pathname === "/api/v1/chats/messages" && req.method === "GET") {
    const deviceSerial = String(url.searchParams.get("deviceSerial") || "").trim();
    if (!deviceSerial) return json(res, 422, { error: { code: "validation_error", message: "deviceSerial is required" } });
    const messages = db.chats
      .filter((m) => m.deviceSerial === deviceSerial)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(publicChatMessage);
    return json(res, 200, { data: { messages } });
  }

  if (url.pathname === "/api/v1/chats/messages" && req.method === "POST") {
    const body = await jsonBody(req);
    const deviceSerial = String(body.deviceSerial || "").trim();
    const message = String(body.message || "").trim();
    const senderAdmin = Boolean(body.senderAdmin);
    if (!deviceSerial) return json(res, 422, { error: { code: "validation_error", message: "deviceSerial is required" } });
    if (!message) return json(res, 422, { error: { code: "validation_error", message: "message is required" } });
    const device = db.devices.find((d) => d.serial === deviceSerial);
    const user = device?.ownerUserId ? db.users.find((u) => u.id === device.ownerUserId) : null;
    const chat = {
      id: id("msg"),
      deviceSerial,
      user: user ? { id: user.id, email: user.email, name: user.name || "" } : null,
      sender: senderAdmin ? "admin" : (user?.email || "portal-user"),
      senderAdmin,
      message,
      status: "unread",
      createdAt: now(),
      updatedAt: now(),
    };
    db.chats.push(chat);
    db.audit.push({ at: now(), action: senderAdmin ? "chat.admin.sent_api" : "chat.user.sent_api", deviceSerial });
    await saveDb(db);
    return json(res, 201, { data: publicChatMessage(chat) });
  }

  if (url.pathname === "/api/v1/chats/messages/read" && req.method === "POST") {
    const body = await jsonBody(req);
    const deviceSerial = String(body.deviceSerial || "").trim();
    const forAdmin = Boolean(body.forAdmin);
    for (const m of db.chats) {
      if (deviceSerial && m.deviceSerial !== deviceSerial) continue;
      if (forAdmin && m.senderAdmin) continue;
      if (!forAdmin && !m.senderAdmin) continue;
      m.status = "read";
      m.updatedAt = now();
    }
    await saveDb(db);
    return json(res, 200, { data: { status: "OK" } });
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
