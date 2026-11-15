// Бүх хуудсанд хэрэгтэй туслах функцууд. API_URL нь config.js-ээс ирнэ.
const TOKEN_KEY = "admin_token";

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

// Токен хүчингүй болох үед дуудагдана (app.js дотор тохируулна)
let onUnauthorized = () => {};

// Серверт хүсэлт илгээх нэгдсэн функц.
// Алдаа гарвал серверийн өгсөн мессежтэй Error шиднэ.
async function apiRequest(path, { method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${getToken()}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new Error("Сервертэй холбогдож чадсангүй");
  }

  if (response.status === 401) {
    onUnauthorized();
    throw new Error("Нэвтрэх хугацаа дууссан. Дахин нэвтэрнэ үү.");
  }

  if (response.status === 204) return null;

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data && data.detail;
    // FastAPI-ийн шалгалтын алдаа нь жагсаалт хэлбэртэй ирдэг
    if (Array.isArray(detail)) throw new Error("Оруулсан мэдээлэл буруу байна. Талбаруудаа шалгана уу.");
    throw new Error(detail || "Серверт алдаа гарлаа");
  }
  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function formatNumber(n) {
  return Number(n).toLocaleString("en-US");
}
