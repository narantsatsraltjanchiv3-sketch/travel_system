// API_URL — config.js, apiRequest/escapeHtml — api.js, createCrudPage — crud.js

const loginPage = document.getElementById("login-page");
const appEl = document.getElementById("app");
const form = document.getElementById("login-form");
const message = document.getElementById("message");
const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const menu = document.getElementById("menu");
const pageTitle = document.getElementById("page-title");
const pageBody = document.getElementById("page-body");

function logout() {
  sessionStorage.removeItem(TOKEN_KEY);
  showView();
}

// Токен хугацаа дуусвал нэвтрэх хуудас руу буцаана
onUnauthorized = () => {
  logout();
  message.textContent = "Нэвтрэх хугацаа дууссан. Дахин нэвтэрнэ үү.";
};

function showView() {
  const loggedIn = Boolean(getToken());
  loginPage.hidden = loggedIn;
  appEl.hidden = !loggedIn;
  if (loggedIn) openPage("dashboard");
}

// ---------- Нэвтрэх ----------
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  loginBtn.disabled = true;

  try {
    const response = await fetch(`${API_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: document.getElementById("email").value,
        password: document.getElementById("password").value,
      }),
    });

    if (response.status === 401) {
      message.textContent = "Имэйл эсвэл нууц үг буруу байна";
      return;
    }
    if (!response.ok) {
      message.textContent = "Серверт алдаа гарлаа. Дахин оролдоно уу.";
      return;
    }

    const data = await response.json();
    sessionStorage.setItem(TOKEN_KEY, data.access_token);
    form.reset();
    showView();
  } catch (error) {
    message.textContent = "Сервертэй холбогдож чадсангүй";
  } finally {
    loginBtn.disabled = false;
  }
});

logoutBtn.addEventListener("click", logout);

// ---------- Аялал цэс (нэгдсэн CRUD функцээр) ----------
// Жагсаалтыг нэрээр эрэмбэлнэ (Монгол үсгийг зөв эрэмбэлэхийн тулд localeCompare)
function byLabel(a, b) {
  return a.label.localeCompare(b.label, "mn");
}

// Хөтөч цэсэд нэмсэн/зассан нь шууд харагдахын тулд кэшлэхгүй
async function guideOptions() {
  const guides = await apiRequest("/guides");
  return guides.map((g) => ({
    value: g.guide_id,
    label: g.language ? `${g.full_name} (${g.language})` : g.full_name,
  })).sort(byLabel);
}

const toursPage = createCrudPage({
  endpoint: "/tours",
  idKey: "tour_id",
  itemName: "аялал",
  searchKeys: ["name", "destination", "guide_name"],
  deleteLabel: (row) => row.name,
  columns: [
    { key: "name", label: "Нэр" },
    { key: "destination", label: "Чиглэл" },
    { key: "days", label: "Хоног", render: (r) => (r.days ? `${r.days} хоног` : "—") },
    { key: "price", label: "Үнэ", render: (r) => (r.price != null ? `${formatNumber(r.price)} ₮` : "—") },
    { key: "guide_name", label: "Хөтөч", render: (r) => escapeHtml(r.guide_name || "—") },
    { key: "booking_count", label: "Захиалга" },
  ],
  fields: [
    { key: "name", label: "Нэр", required: true, maxlength: 100 },
    { key: "destination", label: "Чиглэл", maxlength: 50 },
    { key: "days", label: "Хоног", type: "number", min: 1, step: 1 },
    { key: "price", label: "Үнэ (₮)", type: "number", min: 0, step: "any" },
    { key: "start_date", label: "Эхлэх огноо", type: "date" },
    { key: "guide_id", label: "Хөтөч", type: "select", numeric: true, options: guideOptions },
  ],
});

// ---------- Захиалга цэс (мөн нэгдсэн CRUD функцээр) ----------
const BOOKING_STATUS = {
  pending: { label: "Хүлээгдэж буй", className: "badge" },
  confirmed: { label: "Батлагдсан", className: "badge badge-green" },
  cancelled: { label: "Цуцлагдсан", className: "badge badge-gray" },
};

function statusBadge(status) {
  const s = BOOKING_STATUS[status] || { label: status, className: "badge" };
  return `<span class="${s.className}">${escapeHtml(s.label)}</span>`;
}

function setBookingStatus(row, status) {
  return apiRequest(`/bookings/${row.booking_id}/status`, { method: "PATCH", body: { status } });
}

// Аяллын жагсаалт байнга өөрчлөгдөж болох тул кэшлэхгүй
async function tourOptions() {
  const tours = await apiRequest("/tours");
  return tours.map((t) => ({ value: t.tour_id, label: t.destination ? `${t.name} — ${t.destination}` : t.name }));
}

async function customerOptions() {
  const customers = await apiRequest("/customers");
  return customers.map((c) => ({
    value: c.customer_id,
    label: c.country ? `${c.full_name} (${c.country})` : c.full_name,
  })).sort(byLabel);
}

const statusOptions = Object.entries(BOOKING_STATUS).map(([value, s]) => ({ value, label: s.label }));

const bookingsPage = createCrudPage({
  endpoint: "/bookings",
  idKey: "booking_id",
  itemName: "захиалга",
  subtitle: "Сүүлийн 50 захиалга",
  searchKeys: ["customer_name", "tour_name"],
  deleteLabel: (r) => `#${r.booking_id} — ${r.customer_name || ""}`,
  filter: { param: "status", label: "Төлөв", options: statusOptions },
  columns: [
    { key: "booking_id", label: "№", render: (r) => `#${r.booking_id}` },
    { key: "customer_name", label: "Үйлчлүүлэгч", render: (r) => escapeHtml(r.customer_name || "—") },
    { key: "tour_name", label: "Аялал", render: (r) => escapeHtml(r.tour_name || "—") },
    { key: "people", label: "Хүн" },
    { key: "booked_at", label: "Огноо", render: (r) => escapeHtml(r.booked_at || "—") },
    { key: "paid_amount", label: "Төлсөн", render: (r) => (Number(r.paid_amount) > 0 ? `${formatNumber(r.paid_amount)} ₮` : "—") },
    { key: "status", label: "Төлөв", render: (r) => statusBadge(r.status) },
  ],
  fields: [
    { key: "tour_id", label: "Аялал", type: "select", required: true, numeric: true, options: tourOptions },
    { key: "customer_id", label: "Үйлчлүүлэгч", type: "select", required: true, numeric: true, options: customerOptions },
    { key: "people", label: "Хүний тоо", type: "number", required: true, min: 1, step: 1, default: 1 },
    { key: "status", label: "Төлөв", type: "select", required: true, default: "pending", options: async () => statusOptions },
  ],
  // Зөвхөн «Хүлээгдэж буй» захиалгад гарах товчнууд
  rowActions: [
    {
      label: "Батлах",
      className: "btn-success",
      show: (r) => r.status === "pending",
      run: (r) => setBookingStatus(r, "confirmed"),
      done: "Захиалга батлагдлаа",
    },
    {
      label: "Цуцлах",
      className: "btn-danger",
      show: (r) => r.status === "pending",
      confirm: {
        title: "Цуцлах уу?",
        text: (r) => `<strong>#${r.booking_id} — ${escapeHtml(r.customer_name || "")}</strong>-ийн захиалгыг цуцлах гэж байна.`,
        button: "Тийм, цуцлах",
      },
      run: (r) => setBookingStatus(r, "cancelled"),
      done: "Захиалга цуцлагдлаа",
    },
  ],
  // Төлбөртэй захиалгыг устгаж чадахгүй үед «Цуцлах»-ыг санал болгоно
  deleteFallback: {
    label: "Цуцлах",
    show: (r) => r.status !== "cancelled",
    run: (r) => setBookingStatus(r, "cancelled"),
    done: "Захиалга цуцлагдлаа",
  },
});

// ---------- Үйлчлүүлэгч цэс ----------
const customersPage = createCrudPage({
  endpoint: "/customers",
  idKey: "customer_id",
  itemName: "үйлчлүүлэгч",
  searchKeys: ["full_name", "country", "email"],
  deleteLabel: (r) => r.full_name,
  columns: [
    { key: "full_name", label: "Нэр" },
    { key: "country", label: "Улс", render: (r) => escapeHtml(r.country || "—") },
    { key: "email", label: "И-мэйл", render: (r) => escapeHtml(r.email || "—") },
    { key: "booking_count", label: "Захиалга" },
  ],
  fields: [
    { key: "full_name", label: "Нэр", required: true, maxlength: 100 },
    { key: "country", label: "Улс", maxlength: 50 },
    { key: "email", label: "И-мэйл", type: "email", maxlength: 100 },
  ],
});

// ---------- Хөтөч цэс ----------
const guidesPage = createCrudPage({
  endpoint: "/guides",
  idKey: "guide_id",
  itemName: "хөтөч",
  searchKeys: ["full_name", "language"],
  deleteLabel: (r) => r.full_name,
  columns: [
    { key: "full_name", label: "Нэр" },
    { key: "language", label: "Хэл", render: (r) => escapeHtml(r.language || "—") },
    {
      key: "experience_years",
      label: "Туршлага",
      render: (r) => (r.experience_years != null ? `${r.experience_years} жил` : "—"),
    },
    { key: "tour_count", label: "Хариуцсан аялал" },
  ],
  fields: [
    { key: "full_name", label: "Нэр", required: true, maxlength: 100 },
    { key: "language", label: "Хэл", maxlength: 30 },
    { key: "experience_years", label: "Туршлага (жил)", type: "number", min: 0, step: 1 },
  ],
});

// ---------- Цэс ----------
const PAGES = {
  dashboard: "Хяналт",
  tours: "Аялал",
  bookings: "Захиалга",
  customers: "Үйлчлүүлэгч",
  guides: "Хөтөч",
  forecast: "Эрэлт таамаглах",
  facebook: "Facebook",
};

menu.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-page]");
  if (button) openPage(button.dataset.page);
});

function openPage(page) {
  menu.querySelectorAll("button").forEach((b) => {
    b.classList.toggle("active", b.dataset.page === page);
  });
  pageTitle.textContent = PAGES[page];

  // Хуучин хуудасны event-үүд үлдэхгүйн тулд шинэ хоосон хэсэг үүсгэнэ
  const body = document.createElement("div");
  pageBody.replaceChildren(body);

  if (page === "dashboard") {
    loadDashboard(body);
  } else if (page === "tours") {
    toursPage.render(body);
  } else if (page === "bookings") {
    bookingsPage.render(body);
  } else if (page === "customers") {
    customersPage.render(body);
  } else if (page === "guides") {
    guidesPage.render(body);
  } else if (page === "forecast") {
    renderForecast(body);
  } else if (page === "facebook") {
    body.innerHTML = placeholder("Тун удахгүй", "Facebook холболт удахгүй нэмэгдэнэ.");
  } else {
    body.innerHTML = placeholder("Удахгүй", "Энэ хэсэг хөгжүүлэлтийн шатанд байна.");
  }
}

function placeholder(title, text) {
  return `<div class="placeholder"><div class="big">${title}</div><div>${text}</div></div>`;
}

// ---------- Хяналт ----------
async function loadDashboard(body) {
  body.innerHTML = '<p class="muted">Ачаалж байна...</p>';
  try {
    renderDashboard(body, await apiRequest("/admin/stats"));
  } catch (error) {
    body.innerHTML = `<p class="error-text">${escapeHtml(error.message)}</p>`;
  }
}

// Том мөнгөн дүнг товчилно: 4,622,330,000 → "4.62 тэрбум ₮" (бүтэн дүн нь title-д)
function formatMoneyShort(n) {
  const v = Number(n);
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} тэрбум ₮`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} сая ₮`;
  return `${formatNumber(v)} ₮`;
}

function renderDashboard(body, stats) {
  const cards = [
    { label: "Нийт аялал", value: formatNumber(stats.tours) },
    { label: "Нийт захиалга", value: formatNumber(stats.bookings) },
    { label: "Хүлээгдэж буй", value: formatNumber(stats.pending), warn: true },
    { label: "Нийт орлого", value: formatMoneyShort(stats.revenue), title: `${formatNumber(stats.revenue)} ₮` },
  ];

  const cardsHtml = cards.map((c) => `
    <div class="stat-card${c.warn ? " warn" : ""}"${c.title ? ` title="${c.title}"` : ""}>
      <div class="stat-label">${c.label}</div>
      <div class="stat-value">${c.value}</div>
    </div>`).join("");

  const rows = stats.pending_list.map((b) => `
    <tr>
      <td>#${b.booking_id}</td>
      <td>${escapeHtml(b.customer_name)}</td>
      <td>${escapeHtml(b.tour_name)}</td>
      <td>${b.people}</td>
      <td>${escapeHtml(b.booked_at)}</td>
      <td><span class="badge">Хүлээгдэж буй</span></td>
    </tr>`).join("");

  body.innerHTML = `
    <div class="stats">${cardsHtml}</div>
    <div class="panel">
      <h2>Батлагдаагүй захиалга</h2>
      ${rows ? `
      <table>
        <thead>
          <tr><th>№</th><th>Үйлчлүүлэгч</th><th>Аялал</th><th>Хүн</th><th>Огноо</th><th>Төлөв</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>` : '<p class="muted">Батлагдаагүй захиалга алга.</p>'}
    </div>
    <div class="panel" style="margin-top: 20px">
      <h2>Эрэлттэй 5 аялал</h2>
      <div class="top-demand"><p class="muted">Ачаалж байна...</p></div>
    </div>`;

  loadTopDemand(body.querySelector(".top-demand"));
}

async function loadTopDemand(target) {
  try {
    const tours = await apiRequest("/demand/tours?limit=5");
    target.innerHTML = demandTable(tours, { compact: true });
  } catch (error) {
    target.innerHTML = `<p class="error-text">${escapeHtml(error.message)}</p>`;
  }
}

// ---------- Эрэлт таамаглах ----------
// Бодит ба таамагласан захиалгын хүснэгт (Хяналт, Эрэлт таамаглах хоёуланд ашиглана)
function demandTable(tours, { compact = false } = {}) {
  if (!tours.length) return '<p class="muted">Мэдээлэл алга.</p>';

  const maxValue = Math.max(1, ...tours.map((t) => Math.max(t.actual_bookings, t.predicted_bookings ?? 0)));

  const rows = tours.map((t, i) => {
    const predicted = t.predicted_bookings;
    const diff = predicted == null ? null : Math.round((predicted - t.actual_bookings) * 10) / 10;
    const diffText = diff == null ? "—" : `${diff > 0 ? "+" : ""}${diff.toFixed(1)}`;
    const diffClass = diff == null || Math.abs(diff) < 2 ? "muted" : diff > 0 ? "diff-up" : "diff-down";

    const extraCells = compact ? "" : `
      <td>${t.days} хоног</td>
      <td>${t.price_per_day != null ? formatNumber(t.price_per_day) + " ₮" : "—"}</td>
      <td>${escapeHtml(t.guide_name || "—")} <span class="muted">(${t.guide_experience} жил)</span></td>`;

    return `
      <tr>
        <td class="muted">${i + 1}</td>
        <td><strong>${escapeHtml(t.name)}</strong><div class="muted small">${escapeHtml(t.destination || "")}</div></td>
        ${extraCells}
        <td>
          <div class="bar-cell"><span class="bar-track"><span class="bar bar-actual" style="width:${(t.actual_bookings / maxValue) * 100}%"></span></span><b>${t.actual_bookings}</b></div>
        </td>
        <td>
          <div class="bar-cell"><span class="bar-track"><span class="bar bar-predicted" style="width:${((predicted ?? 0) / maxValue) * 100}%"></span></span><b>${predicted != null ? predicted.toFixed(1) : "—"}</b></div>
        </td>
        <td class="${diffClass}">${diffText}</td>
      </tr>`;
  }).join("");

  const extraHead = compact ? "" : "<th>Хоног</th><th>Өдрийн үнэ</th><th>Хөтөч (туршлага)</th>";
  return `
    <table class="demand-table">
      <thead><tr><th>#</th><th>Аялал</th>${extraHead}<th>Бодит захиалга</th><th>Таамаглал</th><th>Зөрүү</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderForecast(body) {
  body.innerHTML = `
    <div class="forecast-grid">
      <div class="panel">
        <h2>Шинэ аяллын эрэлтийг таамаглах</h2>
        <form id="forecast-form" class="forecast-form">
          <label for="f-price">Өдрийн үнэ (₮) *</label>
          <input id="f-price" name="price_per_day" type="number" min="0" step="any" required value="200000">

          <label for="f-exp">Хөтчийн туршлага (жил) *</label>
          <input id="f-exp" name="guide_experience" type="number" min="0" max="80" step="any" required value="5">

          <label for="f-days">Хоног *</label>
          <input id="f-days" name="days" type="number" min="1" max="365" step="1" required value="5">

          <button type="submit" class="btn btn-primary">Таамаглах</button>
        </form>
      </div>
      <div class="panel result-panel">
        <div class="stat-label">Таамагласан захиалгын тоо</div>
        <div class="result-value" id="forecast-result">—</div>
        <p class="muted small" id="forecast-note">Утгуудаа оруулаад «Таамаглах» дарна уу.</p>
      </div>
    </div>

    <div class="panel" style="margin-top: 20px">
      <h2>Хамгийн их захиалгатай 10 аялал: бодит ба таамаглал</h2>
      <div class="legend muted small">
        <span><i class="dot bar-actual"></i>Бодит</span>
        <span><i class="dot bar-predicted"></i>Загварын таамаглал</span>
      </div>
      <div class="demand-list"><p class="muted">Ачаалж байна...</p></div>
    </div>`;

  const form = body.querySelector("#forecast-form");
  const result = body.querySelector("#forecast-result");
  const note = body.querySelector("#forecast-note");

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    const params = new URLSearchParams(new FormData(form));
    try {
      const data = await apiRequest(`/predict-demand?${params}`);
      result.textContent = data.predicted_bookings.toFixed(1);
      note.textContent = `${formatNumber(data.price_per_day)} ₮/өдөр · ${data.guide_experience} жилийн туршлагатай хөтөч · ${data.days} хоног`;
      note.classList.remove("error-text");
    } catch (error) {
      result.textContent = "—";
      note.textContent = error.message;
      note.classList.add("error-text");
    } finally {
      button.disabled = false;
    }
  });

  loadDemandList(body.querySelector(".demand-list"));
}

async function loadDemandList(target) {
  try {
    target.innerHTML = demandTable(await apiRequest("/demand/tours?limit=10"));
  } catch (error) {
    target.innerHTML = `<p class="error-text">${escapeHtml(error.message)}</p>`;
  }
}

showView();
