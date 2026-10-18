/* Rác Xanh — bản có đăng nhập (Supabase) + quản trị */
const cfg = window.RACXANH_CONFIG || {};
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const DEFAULT_CENTER = [10.7769, 106.7009];
const MATERIALS = ['Giấy / bìa carton', 'Nhựa', 'Kim loại / sắt vụn', 'Nhôm', 'Đồng',
  'Đồ điện tử cũ', 'Chai lọ thủy tinh', 'Ve chai tổng hợp', 'Khác'];
const PHONE_RE = /^(0|\+84)\d{9}$/;
const EXPIRE_DAYS = 14, DAY = 86400000;

let listings = [], map, pickMap, markers = new Map(), pickMarker = null;
let selectedCoords = null, userPos = null, lastFocus = null;
let session = null, isAdmin = false, authMode = 'login';
const $ = id => document.getElementById(id);

/* ---------- tiện ích ---------- */
const escapeHTML = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = s => s ? escapeHTML(s) : 'Thương lượng';
const normalize = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
const cleanPhone = p => String(p || '').replace(/[^\d+]/g, '');
const fmtDate = t => new Date(t).toLocaleDateString('vi-VN');

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type; el.textContent = msg;
  $('toasts').appendChild(el); setTimeout(() => el.remove(), 4000);
}
function timeAgo(iso) {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return m + ' phút trước';
  if (m < 1440) return Math.floor(m / 60) + ' giờ trước';
  return Math.floor(m / 1440) + ' ngày trước';
}
function distanceKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function fuzz(lat, lng) {
  const r = 0.00135 * Math.sqrt(Math.random()), t = Math.random() * 2 * Math.PI;
  return { lat: lat + r * Math.cos(t), lng: lng + r * Math.sin(t) / Math.cos(lat * Math.PI / 180) };
}
function fillMaterials(select, firstLabel) {
  select.innerHTML = `<option value="">${firstLabel}</option>` + MATERIALS.map(m => `<option>${escapeHTML(m)}</option>`).join('');
}
function tileLayer() {
  return L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles &copy; Esri &mdash; Sources: Esri, HERE, Garmin, OpenStreetMap contributors, and the GIS user community'
  });
}

/* ---------- trạng thái tin ---------- */
const mine = x => !!session && x.userId === session.user.id;
const canManage = x => mine(x) || isAdmin;
function statusOf(x) {
  if (x.hidden) return 'hidden';
  if (x.status === 'closed') return 'closed';
  if (x.expiresAt && Date.now() > new Date(x.expiresAt).getTime()) return 'expired';
  return 'open';
}
const closedLabel = x => x.role === 'seller' ? 'Đã bán' : 'Đã thu mua xong';
const statusLabel = x => ({ closed: closedLabel(x), expired: 'Hết hạn', hidden: 'Bị admin ẩn' }[statusOf(x)]);
const fromRow = r => ({ id: r.id, userId: r.user_id, role: r.role, name: r.name, material: r.material, quantity: r.quantity,
  price: r.price, address: r.address, handover: r.handover, hours: r.hours, description: r.description, lat: r.lat, lng: r.lng,
  fuzzy: r.fuzzy, status: r.status, hidden: r.hidden, createdAt: r.created_at, expiresAt: r.expires_at });

async function loadListings() {
  const { data, error } = await sb.from('listings').select('*').order('created_at', { ascending: false });
  if (error) { toast('Không tải được tin đăng: ' + error.message, 'error'); return []; }
  return data.map(fromRow);
}
async function updateListing(id, changes, msg) {
  const { error } = await sb.from('listings').update(changes).eq('id', id);
  if (error) return toast('Lỗi: ' + error.message, 'error');
  toast(msg, 'ok');
}

/* ---------- đăng nhập ---------- */
async function refreshAuth() {
  session = (await sb.auth.getSession()).data.session;
  isAdmin = false;
  if (session) {
    const { data } = await sb.from('profiles').select('role').eq('id', session.user.id).single();
    isAdmin = data?.role === 'admin';
  }
  $('adminLink').classList.toggle('hidden', !isAdmin);
  $('authArea').innerHTML = session
    ? `<span>${escapeHTML(session.user.email)}${isAdmin ? ' · <b>Admin</b>' : ''}</span><button class="btn btn-light" id="logoutBtn" type="button">Đăng xuất</button>`
    : '<button class="btn btn-green" id="loginBtn" type="button">Đăng nhập</button>';
  if ($('logoutBtn')) $('logoutBtn').onclick = async () => { await sb.auth.signOut(); location.href = 'index.html'; };
  if ($('loginBtn')) $('loginBtn').onclick = () => openAuth('login');
}
function openAuth(mode, hint) {
  authMode = mode; const login = mode === 'login';
  $('authTitle').textContent = login ? 'Đăng nhập' : 'Tạo tài khoản';
  $('authSubmit').textContent = login ? 'Đăng nhập' : 'Đăng ký';
  $('authSwitch').textContent = login ? 'Tạo tài khoản' : 'Đã có tài khoản';
  $('authPass').autocomplete = login ? 'current-password' : 'new-password';
  $('authHint').textContent = hint || 'Đăng nhập để đăng tin và liên hệ người đăng.';
  $('authMsg').textContent = '';
  $('authModal').classList.remove('hidden'); $('authEmail').focus();
}
const closeAuth = () => $('authModal').classList.add('hidden');
function setupAuthUI() {
  $('authClose').onclick = closeAuth; $('authBackdrop').onclick = closeAuth;
  $('authSwitch').onclick = () => openAuth(authMode === 'login' ? 'signup' : 'login');
  $('authForm').onsubmit = async e => {
    e.preventDefault();
    const email = $('authEmail').value.trim(), password = $('authPass').value;
    if (!/^\S+@\S+\.\S+$/.test(email)) { $('authMsg').textContent = 'Email chưa hợp lệ.'; return; }
    if (password.length < 8) { $('authMsg').textContent = 'Mật khẩu cần tối thiểu 8 ký tự.'; return; }
    const res = authMode === 'login' ? await sb.auth.signInWithPassword({ email, password }) : await sb.auth.signUp({ email, password });
    if (res.error) { $('authMsg').textContent = res.error.message; return; }
    if (authMode === 'signup' && !res.data.session) { $('authMsg').textContent = 'Đã gửi email xác nhận. Hãy mở email rồi quay lại đăng nhập.'; return; }
    location.reload();
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeAuth(); closeDetail(); } });
}

/* ---------- khởi động ---------- */
async function init() {
  setupAuthUI();
  await refreshAuth();
  const params = new URLSearchParams(location.search), page = params.get('page');
  if (page === 'seller' || page === 'buyer') {
    $('mapPage').classList.add('hidden'); $('formPage').classList.remove('hidden');
    setupForm(page); return;
  }
  if (page === 'admin') {
    $('mapPage').classList.add('hidden'); $('adminPage').classList.remove('hidden');
    return renderAdmin();
  }
  fillMaterials($('filterMaterial'), 'Mọi loại vật liệu');
  listings = await loadListings();
  setupMap(); renderListings();
  if (params.get('posted')) toast(`Đăng tin thành công! Tin hiển thị ${EXPIRE_DAYS} ngày.`, 'ok');
  const target = listings.find(x => x.id === params.get('id'));
  if (target) { map.setView([target.lat, target.lng], 16); showDetail(target); }
}

function setupMap() {
  map = L.map('map').setView(DEFAULT_CENTER, 12); tileLayer().addTo(map);
  ['filterType', 'filterMaterial', 'sortBy', 'inView', 'hideClosed'].forEach(id => $(id).addEventListener('change', onSortOrFilter));
  $('searchBox').addEventListener('input', renderListings);
  map.on('moveend', () => { if ($('inView').checked) renderListings(); });
  $('resetMap').onclick = () => map.setView(DEFAULT_CENTER, 12);
  $('locateBtn').onclick = () => locate(true);
  $('closeModal').onclick = closeDetail; $('closeBackdrop').onclick = closeDetail;
}
function locate(pan) {
  if (!navigator.geolocation) return toast('Trình duyệt không hỗ trợ định vị.', 'error');
  navigator.geolocation.getCurrentPosition(p => {
    userPos = { lat: p.coords.latitude, lng: p.coords.longitude };
    if (pan) map.setView([userPos.lat, userPos.lng], 15);
    renderListings();
  }, () => { toast('Không lấy được vị trí. Hãy cho phép trình duyệt truy cập vị trí.', 'error'); $('sortBy').value = 'newest'; renderListings(); });
}
function onSortOrFilter() {
  if ($('sortBy').value === 'nearest' && !userPos) return locate(false);
  renderListings();
}

/* ---------- bản đồ + danh sách ---------- */
function iconFor(role, closed = false) {
  return L.divIcon({
    className: 'custom-marker-wrap',
    html: `<div class="map-pin ${closed ? 'pin-closed' : role === 'seller' ? 'pin-seller' : 'pin-buyer'}"><span class="pin-fix">${closed ? '✔' : role === 'seller' ? '♻' : '🛒'}</span></div>`,
    iconSize: [38, 44], iconAnchor: [19, 40], popupAnchor: [0, -38]
  });
}
function getVisible() {
  const type = $('filterType').value, mat = $('filterMaterial').value, q = normalize($('searchBox').value.trim());
  const bounds = $('inView').checked ? map.getBounds() : null;
  const out = listings.filter(x => {
    const st = statusOf(x);
    if ((st === 'expired' || st === 'hidden') && !canManage(x)) return false;
    if (st === 'closed' && $('hideClosed').checked) return false;
    if (type !== 'all' && x.role !== type) return false;
    if (mat && x.material !== mat) return false;
    if (bounds && !bounds.contains([x.lat, x.lng])) return false;
    return !q || normalize([x.name, x.material, x.address, x.description, x.price].join(' ')).includes(q);
  });
  if ($('sortBy').value === 'nearest' && userPos) out.sort((a, b) => distanceKm(userPos, a) - distanceKm(userPos, b));
  else out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  out.sort((a, b) => (statusOf(a) === 'open' ? 0 : 1) - (statusOf(b) === 'open' ? 0 : 1));
  return out;
}
function renderListings() {
  if (!map) return;
  markers.forEach(m => map.removeLayer(m)); markers.clear();
  const visible = getVisible();
  visible.forEach(item => {
    const closed = statusOf(item) === 'closed';
    const m = L.marker([item.lat, item.lng], { icon: iconFor(item.role, closed), title: item.material + (closed ? ' (' + closedLabel(item) + ')' : '') }).addTo(map);
    m.on('click', () => showDetail(item)); markers.set(item.id, m);
  });
  $('listingCount').textContent = `${visible.length} tin đăng`;
  const list = $('listingList'); list.innerHTML = '';
  if (!visible.length) { list.innerHTML = '<div class="empty-state">Chưa có tin đăng phù hợp.<br>Thử đổi bộ lọc hoặc hãy là người đầu tiên đăng tin!</div>'; return; }
  visible.forEach(item => {
    const st = statusOf(item), dist = userPos ? ` · ${distanceKm(userPos, item).toFixed(1)} km` : '';
    const card = document.createElement('button');
    card.className = 'listing-item' + (mine(item) ? ' mine' : '') + (st !== 'open' ? ' is-closed' : '');
    card.innerHTML = `<span class="mini-dot ${item.role === 'seller' ? 'seller-dot' : 'buyer-dot'}"></span>
      <span class="listing-item-body"><strong>${escapeHTML(item.material)}${mine(item) ? '<span class="badge-mine">Của tôi</span>' : ''}${st !== 'open' ? `<span class="badge-off">${statusLabel(item)}</span>` : ''}</strong>
      <small>${item.role === 'seller' ? 'Người bán' : 'Người mua'} · ${escapeHTML(item.address)}${dist} · ${timeAgo(item.createdAt)}</small>
      <span>${escapeHTML(item.name)} · ${money(item.price)}</span></span><span class="chevron">›</span>`;
    card.onclick = () => { map.setView([item.lat, item.lng], 16); showDetail(item); };
    list.appendChild(card);
  });
}

/* ---------- chi tiết tin ---------- */
function showDetail(item) {
  const isSeller = item.role === 'seller', st = statusOf(item), mgr = canManage(item);
  const facts = [['Số lượng', item.quantity || 'Chưa cung cấp'], ['Khu vực', item.address], ['Giao nhận', item.handover || 'Chưa xác định'], ['Giờ liên hệ', item.hours || 'Chưa cung cấp']]
    .map(([k, v]) => `<div><small>${k}</small><strong>${escapeHTML(v)}</strong></div>`).join('');
  const newExp = () => new Date(Date.now() + EXPIRE_DAYS * DAY).toISOString();
  $('detailContent').innerHTML = `
    <span class="role-pill ${st === 'closed' ? 'pill-closed' : isSeller ? 'pill-seller' : 'pill-buyer'}">${st === 'closed' ? '✔ ' + closedLabel(item) : isSeller ? '● Người bán' : '● Người mua'}</span>
    <h2 id="detailTitle">${escapeHTML(item.material)}</h2>
    <p class="detail-person">${escapeHTML(item.name)}</p>
    <p class="detail-meta">Đăng ${timeAgo(item.createdAt)}${st === 'open' ? ' · Còn hiệu lực đến ' + fmtDate(item.expiresAt) : ''}${item.fuzzy ? ' · Vị trí gần đúng' : ''}</p>
    ${st === 'closed' ? `<p class="status-banner sold">✔ ${closedLabel(item).toUpperCase()}. Tin này không còn nhận liên hệ.</p>` : st === 'expired' ? '<p class="status-banner">⚠ Tin đã hết hạn, có thể không còn nữa.</p>' : st === 'hidden' ? '<p class="status-banner">Tin đang bị admin ẩn khỏi bản đồ chung.</p>' : ''}
    <div class="detail-price">${money(item.price)}</div>
    <div class="detail-facts">${facts}</div>
    <p class="detail-description">${escapeHTML(item.description || 'Không có mô tả thêm.')}</p>
    ${st === 'open' ? '<button class="btn btn-green contact-btn" id="callBtn" type="button">☎ Gọi ngay</button>' : ''}
    <div class="detail-actions">
      <a class="btn btn-light" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${Number(item.lat)},${Number(item.lng)}">➤ Chỉ đường</a>
      <button class="btn btn-light" id="shareBtn" type="button">🔗 Chia sẻ</button>
      ${mgr ? `<button class="btn btn-light" id="toggleBtn" type="button">${item.status === 'closed' ? '↺ Mở lại tin' : '✔ Đánh dấu ' + closedLabel(item).toLowerCase()}</button>
      <button class="btn btn-light" id="renewBtn" type="button">⏱ Gia hạn ${EXPIRE_DAYS} ngày</button>` : ''}
      ${isAdmin ? `<button class="btn btn-light" id="hideBtn" type="button">${item.hidden ? '👁 Bỏ ẩn tin' : '🚫 Ẩn tin (admin)'}</button>` : ''}
      ${mgr ? '<button class="btn btn-danger" id="deleteBtn" type="button">Xóa tin</button>' : ''}
    </div>`;
  if ($('callBtn')) $('callBtn').onclick = async () => {
    if (!session) { closeDetail(); return openAuth('login', 'Vui lòng đăng nhập để liên hệ người đăng.'); }
    const { data, error } = await sb.from('listing_contacts').select('phone').eq('listing_id', item.id).single();
    if (error || !data) return toast('Không lấy được thông tin liên hệ.', 'error');
    location.href = 'tel:' + cleanPhone(data.phone);
  };
  $('shareBtn').onclick = async () => {
    const url = location.origin + location.pathname + '?id=' + encodeURIComponent(item.id);
    try { await navigator.clipboard.writeText(url); toast('Đã sao chép liên kết.', 'ok'); } catch { prompt('Sao chép liên kết:', url); }
  };
  const apply = async (changes, msg) => { await updateListing(item.id, changes, msg); listings = await loadListings(); renderListings(); closeDetail(); };
  if (mgr) {
    $('toggleBtn').onclick = () => apply(item.status === 'closed' ? { status: 'open', expires_at: newExp() } : { status: 'closed' }, 'Đã cập nhật trạng thái tin.');
    $('renewBtn').onclick = () => apply({ status: 'open', expires_at: newExp() }, 'Đã gia hạn ' + EXPIRE_DAYS + ' ngày.');
    $('deleteBtn').onclick = async () => {
      if (!confirm('Xóa tin này vĩnh viễn?')) return;
      const { error } = await sb.from('listings').delete().eq('id', item.id);
      if (error) return toast(error.message, 'error');
      listings = await loadListings(); renderListings(); closeDetail(); toast('Đã xóa tin.', 'ok');
    };
  }
  if (isAdmin) $('hideBtn').onclick = () => apply({ hidden: !item.hidden }, item.hidden ? 'Đã bỏ ẩn tin.' : 'Đã ẩn tin.');
  lastFocus = document.activeElement;
  $('detailModal').classList.remove('hidden'); $('closeModal').focus();
}
function closeDetail() {
  if ($('detailModal').classList.contains('hidden')) return;
  $('detailModal').classList.add('hidden');
  if (lastFocus?.focus) lastFocus.focus();
}

/* ---------- trang quản trị ---------- */
async function renderAdmin() {
  if (!isAdmin) { $('adminTable').innerHTML = '<p class="form-message">Bạn không có quyền truy cập trang này. Hãy đăng nhập bằng tài khoản admin.</p>'; return; }
  const all = await loadListings();
  const count = s => all.filter(x => statusOf(x) === s).length;
  const { count: users } = await sb.from('profiles').select('id', { count: 'exact', head: true });
  $('adminStats').textContent = `${all.length} tin · ${count('open')} đang mở · ${count('closed')} đã chốt · ${count('expired')} hết hạn · ${count('hidden')} bị ẩn · ${users ?? '?'} tài khoản`;
  $('adminTable').innerHTML = '';
  all.forEach(item => {
    const row = document.createElement('div'); row.className = 'admin-row';
    row.innerHTML = `<div><strong>${escapeHTML(item.material)}</strong> <span class="badge-off">${statusLabel(item) || ''}</span>
      <small>${item.role === 'seller' ? 'Người bán' : 'Người mua'} · ${escapeHTML(item.name)} · ${escapeHTML(item.address)} · ${timeAgo(item.createdAt)}</small></div>
      <div class="acts"><a class="btn btn-light" href="index.html?id=${encodeURIComponent(item.id)}">Xem</a>
      <button class="btn btn-light" data-act="hide">${item.hidden ? 'Bỏ ẩn' : 'Ẩn'}</button><button class="btn btn-danger" data-act="del">Xóa</button></div>`;
    row.querySelector('[data-act=hide]').onclick = async () => { await updateListing(item.id, { hidden: !item.hidden }, 'Đã cập nhật.'); renderAdmin(); };
    row.querySelector('[data-act=del]').onclick = async () => {
      if (!confirm('Xóa tin này vĩnh viễn?')) return;
      const { error } = await sb.from('listings').delete().eq('id', item.id);
      error ? toast(error.message, 'error') : (toast('Đã xóa.', 'ok'), renderAdmin());
    };
    $('adminTable').appendChild(row);
  });
  if (!all.length) $('adminTable').innerHTML = '<p class="field-help">Chưa có tin nào.</p>';
}

/* ---------- form đăng tin ---------- */
const showMsg = t => { $('formMessage').textContent = t; };
function setupForm(role) {
  $('role').value = role; fillMaterials($('material'), 'Chọn loại vật liệu');
  $('formIcon').textContent = role === 'seller' ? '♻' : '🛒';
  $('formEyebrow').textContent = role === 'seller' ? 'DÀNH CHO NGƯỜI BÁN' : 'DÀNH CHO NGƯỜI MUA';
  $('formTitle').textContent = role === 'seller' ? 'Đăng tin bán ve chai' : 'Đăng nhu cầu thu mua';
  $('formDesc').textContent = role === 'seller' ? 'Cho mọi người biết bạn có vật liệu gì cần bán.' : 'Cho người bán biết bạn đang cần thu mua vật liệu gì.';
  pickMap = L.map('pickMap').setView(DEFAULT_CENTER, 12); tileLayer().addTo(pickMap);
  pickMap.on('click', e => setCoords(e.latlng.lat, e.latlng.lng));
  $('geoBtn').onclick = () => {
    if (!navigator.geolocation) return showMsg('Trình duyệt không hỗ trợ định vị.');
    navigator.geolocation.getCurrentPosition(p => { setCoords(p.coords.latitude, p.coords.longitude); pickMap.setView([p.coords.latitude, p.coords.longitude], 16); },
      () => showMsg('Không lấy được vị trí. Hãy cấp quyền định vị hoặc chọn điểm trực tiếp trên bản đồ.'));
  };
  $('listingForm').onsubmit = submitListing;
  setTimeout(() => pickMap.invalidateSize(), 100);
  if (!session) openAuth('login', 'Bạn cần đăng nhập để đăng tin.');
}
function setCoords(lat, lng) {
  selectedCoords = { lat, lng }; $('coords').value = `${lat.toFixed(6)}, ${lng.toFixed(6)}`; showMsg('');
  if (pickMarker) pickMap.removeLayer(pickMarker);
  pickMarker = L.marker([lat, lng], { icon: iconFor($('role').value) }).addTo(pickMap);
}
function validate() {
  document.querySelectorAll('.field.invalid').forEach(f => f.classList.remove('invalid'));
  const bad = [], need = (id, ok, msg) => { if (!ok) { bad.push(msg); $(id).closest('.field').classList.add('invalid'); } };
  need('name', $('name').value.trim().length >= 2, 'Vui lòng nhập tên người đăng.');
  need('phone', PHONE_RE.test(cleanPhone($('phone').value)), 'Số điện thoại chưa hợp lệ (ví dụ 0901234567 hoặc +84901234567).');
  need('material', !!$('material').value, 'Vui lòng chọn loại vật liệu.');
  need('address', $('address').value.trim().length >= 3, 'Vui lòng nhập địa chỉ / khu vực.');
  if (!selectedCoords) bad.push('Bạn cần chọn vị trí trên bản đồ.');
  return bad;
}
async function submitListing(e) {
  e.preventDefault();
  if (!session) return openAuth('login', 'Bạn cần đăng nhập để đăng tin.');
  const errors = validate(); if (errors.length) return showMsg(errors[0]);
  let { lat, lng } = selectedCoords; const fuzzy = $('fuzzy').checked;
  if (fuzzy) ({ lat, lng } = fuzz(lat, lng));
  const btn = e.submitter; if (btn) btn.disabled = true;
  const { data, error } = await sb.from('listings').insert({
    role: $('role').value, name: $('name').value.trim(), material: $('material').value, quantity: $('quantity').value.trim(),
    price: $('price').value.trim(), address: $('address').value.trim(), handover: $('handover').value, hours: $('hours').value.trim(),
    description: $('description').value.trim(), lat, lng, fuzzy
  }).select('id').single();
  if (error) { if (btn) btn.disabled = false; return showMsg('Không đăng được tin: ' + error.message); }
  const c = await sb.from('listing_contacts').insert({ listing_id: data.id, phone: cleanPhone($('phone').value) });
  if (c.error) { await sb.from('listings').delete().eq('id', data.id); if (btn) btn.disabled = false; return showMsg('Không lưu được số điện thoại: ' + c.error.message); }
  location.href = 'index.html?posted=1&id=' + data.id;
}

init();