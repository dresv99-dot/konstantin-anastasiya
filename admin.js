const loginForm = document.querySelector("#login-form");
const dashboard = document.querySelector("#dashboard");
const message = document.querySelector("#login-message");
const responsesBox = document.querySelector("#responses");
let allResponses = [];
let adminToken = sessionStorage.getItem("wedding-admin-token") || "";
const apiBase = window.WEDDING_API_URL;
const apiFetch = (path, options = {}) => fetch(`${apiBase}${path}`, {
  ...options,
  headers: { ...(options.headers || {}), ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}) }
});

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

async function loadDashboard() {
  const [statsResponse, responsesResponse] = await Promise.all([apiFetch("/api/admin/stats"), apiFetch("/api/admin/responses")]);
  if (!statsResponse.ok || !responsesResponse.ok) throw new Error("Войдите снова, сессия завершилась.");
  const stats = await statsResponse.json();
  allResponses = await responsesResponse.json();
  document.querySelector("#stats").innerHTML = [["Ответили", stats.replies], ["Придут", stats.accepted], ["Не придут", stats.declined], ["Всего гостей", stats.guests]].map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value || 0}</strong></div>`).join("");
  loginForm.hidden = true;
  dashboard.hidden = false;
  document.querySelector("#logout").hidden = false;
  renderResponses();
}

function renderResponses() {
  const query = document.querySelector("#search").value.trim().toLocaleLowerCase("ru");
  const filter = document.querySelector("#filter").value;
  const rows = allResponses.filter((row) => (filter === "all" || row.attendance === filter) && `${row.first_name} ${row.last_name} ${row.companion_names.join(" ")} ${row.diet}`.toLocaleLowerCase("ru").includes(query));
  responsesBox.innerHTML = rows.length ? rows.map((row) => {
    const attending = row.attendance === "yes";
    const people = row.companion_names.map((name, index) => `${escapeHtml(name)} (${row.companion_types[index] === "child" ? "ребёнок" : "взрослый"})`).join(", ") || "нет";
    const drinks = [...row.alcohol, row.alcohol_other, row.wine].filter(Boolean).map(escapeHtml).join(", ") || "не указаны";
    return `<article class="response"><div class="date">Анкета №${row.id} · ${escapeHtml(row.created_at)}</div><h2>${escapeHtml(row.first_name)} ${escapeHtml(row.last_name)}</h2><span class="badge ${attending ? "" : "no"}">${attending ? "Придёт" : "Не придёт"}</span>${attending ? `<p><b>Сопровождающие:</b> ${people}</p><p><b>Питание и аллергии:</b> ${escapeHtml(row.diet) || "не указаны"}</p><p><b>Напитки:</b> ${drinks}</p>` : ""}</article>`;
  }).join("") : '<p>Подходящих ответов пока нет.</p>';
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  const response = await apiFetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: document.querySelector("#password").value }) });
  if (!response.ok) { message.textContent = "Пароль не подошёл."; return; }
  const result = await response.json();
  adminToken = result.token;
  sessionStorage.setItem("wedding-admin-token", adminToken);
  try { await loadDashboard(); } catch (error) { message.textContent = error.message; }
});

document.querySelector("#logout").addEventListener("click", () => { sessionStorage.removeItem("wedding-admin-token"); location.reload(); });
document.querySelector("#refresh").addEventListener("click", () => loadDashboard().catch((error) => { message.textContent = error.message; }));
document.querySelector("#search").addEventListener("input", renderResponses);
document.querySelector("#filter").addEventListener("change", renderResponses);
if (adminToken) loadDashboard().catch(() => { sessionStorage.removeItem("wedding-admin-token"); adminToken = ""; });
