// Shared login/register gate — used by both the game page and the deck builder.
// Stores a JWT in localStorage; not sensitive data, just a session token.
const AUTH_TOKEN_KEY = 'bot_token';

function authToken() { return localStorage.getItem(AUTH_TOKEN_KEY); }
function authHeaders() { const t = authToken(); return t ? { 'Authorization': 'Bearer ' + t } : {}; }
function authFetch(url, opts = {}) {
  opts.headers = Object.assign({}, opts.headers, authHeaders());
  return fetch(url, opts);
}
function logout() { localStorage.removeItem(AUTH_TOKEN_KEY); location.reload(); }

async function checkAuth() {
  if (!authToken()) return null;
  try {
    const res = await fetch('/api/me', { headers: authHeaders() });
    if (!res.ok) { localStorage.removeItem(AUTH_TOKEN_KEY); return null; }
    return await res.json(); // {username, coins}
  } catch (e) { return null; }
}

// Renders a login/register box inside `container`, calls onSuccess({username, coins, token}) once authenticated.
function renderAuthGate(container, onSuccess) {
  container.innerHTML = `
    <div class="card-frame" id="authBox">
      <div style="display:flex;gap:6px;margin-bottom:12px;">
        <button class="btn authtab active" data-m="login" style="flex:1;">เข้าสู่ระบบ</button>
        <button class="btn authtab" data-m="register" style="flex:1;">สมัครใหม่</button>
      </div>
      <input type="text" id="authUser" placeholder="ชื่อผู้ใช้" autocomplete="username">
      <input type="password" id="authPass" placeholder="รหัสผ่าน" autocomplete="current-password">
      <button class="btn primary" id="authSubmit">เข้าสู่ระบบ</button>
      <div id="authMsg" style="color:#D63A28;font-size:12px;min-height:16px;margin-top:8px;text-align:center;"></div>
    </div>
  `;
  let mode = 'login';
  container.querySelectorAll('.authtab').forEach(b => b.onclick = () => {
    mode = b.dataset.m;
    container.querySelectorAll('.authtab').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById('authSubmit').textContent = mode === 'login' ? 'เข้าสู่ระบบ' : 'สมัครสมาชิก';
    document.getElementById('authMsg').textContent = '';
  });
  const submit = async () => {
    const username = document.getElementById('authUser').value.trim();
    const password = document.getElementById('authPass').value;
    const msg = document.getElementById('authMsg');
    msg.textContent = '';
    if (!username || !password) { msg.textContent = 'กรอกให้ครบทั้งชื่อผู้ใช้และรหัสผ่าน'; return; }
    const url = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const data = await res.json();
      if (!res.ok) { msg.textContent = data.error || 'เกิดข้อผิดพลาด'; return; }
      localStorage.setItem(AUTH_TOKEN_KEY, data.token);
      onSuccess({ username: data.username, coins: data.coins, token: data.token });
    } catch (e) { msg.textContent = 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้'; }
  };
  document.getElementById('authSubmit').onclick = submit;
  document.getElementById('authPass').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}
