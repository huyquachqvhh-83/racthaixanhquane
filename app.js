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
let people = {}, alerts = [], photoFiles = [];
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
  fuzzy: r.fuzzy, photos: r.photos || [], status: r.status, hidden: r.hidden, createdAt: r.created_at, expiresAt: r.expires_at });

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

/* ---------- hồ sơ công khai, ảnh, Zalo ---------- */
async function loadPeople() {
  const { data } = await sb.from('public_profiles').select('*');
  people = Object.fromEntries((data || []).map(p => [p.id, p]));
}
const trustBadges = uid => {
  const p = people[uid]; if (!p) return '';
  return (p.verified ? '<span class="badge-verified">✔ Đã xác minh</span>' : '') +
         (p.review_count > 0 ? `<span class="rating">★ ${p.avg_rating} (${p.review_count})</span>` : '');
};
const zaloNum = p => { p = p.replace('+', ''); return p.startsWith('0') ? '84' + p.slice(1) : p; };
async function removePhotos(item) {
  const paths = (item.photos || []).map(u => u.split('/listing-photos/')[1]).filter(Boolean);
  if (paths.length) await sb.storage.from('listing-photos').remove(paths);
}
async function getPhone(item) {
  if (!session) { closeDetail(); openAuth('login', 'Vui lòng đăng nhập để liên hệ người đăng.'); return null; }
  const { data, error } = await sb.from('listing_contacts').select('phone').eq('listing_id', item.id).single();
  if (error || !data) { toast('Không lấy được thông tin liên hệ.', 'error'); return null; }
  return cleanPhone(data.phone);
}
function compressImage(file, max = 1280, quality = 0.8) {   // vẽ lại bằng canvas: nhỏ hơn và xóa dữ liệu vị trí (EXIF)
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      c.toBlob(b => b ? res(b) : rej(new Error('Không xử lý được ảnh')), 'image/jpeg', quality);
    };
    img.onerror = () => rej(new Error('Ảnh không hợp lệ')); img.src = url;
  });
}

/* ---------- cảnh báo tin mới ---------- */
async function loadAlerts() {
  if (!session) { alerts = []; return; }
  const { data } = await sb.from('alerts').select('*').order('created_at', { ascending: false });
  alerts = data || [];
}
const matchesFor = a => listings.filter(x => statusOf(x) === 'open' && !mine(x) && new Date(x.createdAt) > new Date(a.last_seen)
  && (a.target_role === 'any' || x.role === a.target_role) && (!a.material || x.material === a.material)
  && distanceKm({ lat: a.lat, lng: a.lng }, x) <= a.radius_km);
function updateBell() {
  const n = alerts.reduce((t, a) => t + matchesFor(a).length, 0), b = $('bellCount');
  if (b) { b.textContent = n; b.classList.toggle('hidden', !n); }
}
const closeAlerts = () => $('alertModal').classList.add('hidden');
function openAlerts() {
  if (!session) return openAuth('login', 'Đăng nhập để nhận thông báo tin mới.');
  const rows = alerts.map(a => ({ a, m: matchesFor(a) }));
  const roleTxt = r => r === 'seller' ? 'tin người bán' : r === 'buyer' ? 'tin người mua' : 'mọi tin';
  $('alertContent').innerHTML = (rows.length ? rows.map(({ a, m }) => `<div class="alert-item"><div>
      <strong>${escapeHTML(a.material || 'Mọi loại vật liệu')}</strong> · ${roleTxt(a.target_role)} · ${a.radius_km} km
      <small>${m.length ? m.length + ' tin mới' : 'Chưa có tin mới'}</small>
      ${m.map(x => `<button class="alert-match" data-l="${x.id}" type="button">${escapeHTML(x.material)} · ${escapeHTML(x.address)}</button>`).join('')}
    </div><button class="btn btn-light" data-del="${a.id}" type="button">Xóa</button></div>`).join('')
    : '<p class="field-help">Bạn chưa có cảnh báo nào. Tạo một cảnh báo để biết ngay khi có tin phù hợp.</p>') + `
    <h3 class="rv-title">Tạo cảnh báo mới</h3>
    <div class="field"><label for="alMat">Vật liệu</label><select id="alMat"></select></div>
    <div class="field"><label for="alRole">Nhận tin của</label><select id="alRole"><option value="seller">Người bán</option><option value="buyer">Người mua</option><option value="any">Cả hai</option></select></div>
    <div class="field"><label for="alRad">Bán kính quanh vị trí đang xem trên bản đồ</label><select id="alRad"><option>1</option><option>3</option><option selected>5</option><option>10</option></select></div>
    <button class="btn btn-green contact-btn" id="alAdd" type="button">＋ Tạo cảnh báo</button>`;
  fillMaterials($('alMat'), 'Mọi loại vật liệu');
  $('alertContent').querySelectorAll('[data-l]').forEach(b => b.onclick = () => {
    const it = listings.find(x => x.id === b.dataset.l); closeAlerts(); map.setView([it.lat, it.lng], 16); showDetail(it);
  });
  $('alertContent').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    await sb.from('alerts').delete().eq('id', b.dataset.del); await loadAlerts(); updateBell(); openAlerts();
  });
  $('alAdd').onclick = async () => {
    if (!map) return toast('Hãy mở bản đồ chung để chọn khu vực.', 'error');
    const c = map.getCenter();
    const { error } = await sb.from('alerts').insert({ material: $('alMat').value || null, target_role: $('alRole').value, radius_km: +$('alRad').value, lat: c.lat, lng: c.lng });
    if (error) return toast('Không tạo được: ' + error.message, 'error');
    toast('Đã tạo cảnh báo.', 'ok'); await loadAlerts(); updateBell(); openAlerts();
  };
  $('alertModal').classList.remove('hidden');
  if (rows.some(r => r.m.length)) {            // đánh dấu đã xem
    const now = new Date().toISOString();
    sb.from('alerts').update({ last_seen: now }).eq('user_id', session.user.id).then(() => { alerts.forEach(a => a.last_seen = now); updateBell(); });
  }
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
    ? `<button class="btn btn-light bell" id="bellBtn" type="button" aria-label="Thông báo">🔔<span id="bellCount" class="bell-count hidden">0</span></button><span>${escapeHTML(session.user.email)}${isAdmin ? ' · <b>Admin</b>' : ''}</span><button class="btn btn-light" id="logoutBtn" type="button">Đăng xuất</button>`
    : '<button class="btn btn-green" id="loginBtn" type="button">Đăng nhập</button>';
  if ($('logoutBtn')) $('logoutBtn').onclick = async () => { await sb.auth.signOut(); location.href = 'index.html'; };
  if ($('bellBtn')) $('bellBtn').onclick = () => map ? openAlerts() : (location.href = 'index.html?alerts=1');
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
  $('alertClose').onclick = closeAlerts; $('alertBackdrop').onclick = closeAlerts;
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
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeAuth(); closeDetail(); closeAlerts(); } });
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
  await Promise.all([loadPeople(), loadAlerts()]);
  setupMap(); renderListings(); updateBell();
  if (params.get('alerts')) openAlerts();
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
    card.innerHTML = `${item.photos[0] ? `<img class="thumb" src="${escapeHTML(item.photos[0])}" alt="" loading="lazy">` : ''}<span class="mini-dot ${item.role === 'seller' ? 'seller-dot' : 'buyer-dot'}"></span>
      <span class="listing-item-body"><strong>${escapeHTML(item.material)}${people[item.userId]?.verified ? '<span class="badge-verified">✔</span>' : ''}${mine(item) ? '<span class="badge-mine">Của tôi</span>' : ''}${st !== 'open' ? `<span class="badge-off">${statusLabel(item)}</span>` : ''}</strong>
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
    <p class="detail-person">${escapeHTML(item.name)} ${trustBadges(item.userId)}</p>
    <p class="detail-meta">Đăng ${timeAgo(item.createdAt)}${st === 'open' ? ' · Còn hiệu lực đến ' + fmtDate(item.expiresAt) : ''}${item.fuzzy ? ' · Vị trí gần đúng' : ''}</p>
    ${st === 'closed' ? `<p class="status-banner sold">✔ ${closedLabel(item).toUpperCase()}. Tin này không còn nhận liên hệ.</p>` : st === 'expired' ? '<p class="status-banner">⚠ Tin đã hết hạn, có thể không còn nữa.</p>' : st === 'hidden' ? '<p class="status-banner">Tin đang bị admin ẩn khỏi bản đồ chung.</p>' : ''}
    ${item.photos.length ? `<div class="gallery">${item.photos.map(u => `<a href="${escapeHTML(u)}" target="_blank" rel="noopener"><img src="${escapeHTML(u)}" alt="Ảnh tin đăng" loading="lazy"></a>`).join('')}</div>` : ''}
    <div class="detail-price">${money(item.price)}</div>
    <div class="detail-facts">${facts}</div>
    <p class="detail-description">${escapeHTML(item.description || 'Không có mô tả thêm.')}</p>
    ${st === 'open' ? '<div class="contact-row"><button class="btn btn-green" id="callBtn" type="button">☎ Gọi ngay</button><button class="btn btn-zalo" id="zaloBtn" type="button">💬 Zalo</button></div>' : ''}
    ${st === 'closed' && session && !mine(item) ? '<div id="reviewBox"><button class="btn btn-light reveal-btn" id="reviewBtn" type="button">★ Đánh giá người đăng</button></div>' : ''}
    <div id="reviewList"></div>
    <div class="detail-actions">
      <a class="btn btn-light" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${Number(item.lat)},${Number(item.lng)}">➤ Chỉ đường</a>
      <button class="btn btn-light" id="shareBtn" type="button">🔗 Chia sẻ</button>
      ${mgr ? `<button class="btn btn-light" id="toggleBtn" type="button">${item.status === 'closed' ? '↺ Mở lại tin' : '✔ Đánh dấu ' + closedLabel(item).toLowerCase()}</button>
      <button class="btn btn-light" id="renewBtn" type="button">⏱ Gia hạn ${EXPIRE_DAYS} ngày</button>` : ''}
      ${isAdmin ? `<button class="btn btn-light" id="hideBtn" type="button">${item.hidden ? '👁 Bỏ ẩn tin' : '🚫 Ẩn tin (admin)'}</button>` : ''}
      ${mgr ? '<button class="btn btn-danger" id="deleteBtn" type="button">Xóa tin</button>' : ''}
    </div>`;
  if ($('callBtn')) $('callBtn').onclick = async () => { const p = await getPhone(item); if (p) location.href = 'tel:' + p; };
  if ($('zaloBtn')) $('zaloBtn').onclick = async () => { const p = await getPhone(item); if (p) window.open('https://zalo.me/' + zaloNum(p), '_blank', 'noopener'); };
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
      await removePhotos(item);
      const { error } = await sb.from('listings').delete().eq('id', item.id);
      if (error) return toast(error.message, 'error');
      listings = await loadListings(); renderListings(); closeDetail(); toast('Đã xóa tin.', 'ok');
    };
  }
  if (isAdmin) $('hideBtn').onclick = () => apply({ hidden: !item.hidden }, item.hidden ? 'Đã bỏ ẩn tin.' : 'Đã ẩn tin.');
  setupExtras(item);
  lastFocus = document.activeElement;
  $('detailModal').classList.remove('hidden'); $('closeModal').focus();
}
async function loadReviews(item) {
  const box = $('reviewList'); if (!box) return;
  const { data } = await sb.from('reviews').select('rating, comment, created_at').eq('reviewee_id', item.userId).order('created_at', { ascending: false }).limit(3);
  box.innerHTML = data?.length ? '<h3 class="rv-title">Đánh giá gần đây</h3>' + data.map(r => `<div class="rv"><span class="stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span> <small>${timeAgo(r.created_at)}</small>${r.comment ? `<p>${escapeHTML(r.comment)}</p>` : ''}</div>`).join('') : '';
}
function setupExtras(item) {
  loadReviews(item);
  if (!$('reviewBtn')) return;
  $('reviewBtn').onclick = () => {
    $('reviewBox').innerHTML = `<div class="field"><label for="rvStars">Chấm điểm</label><select id="rvStars"><option value="5">★★★★★ Rất tốt</option><option value="4">★★★★ Tốt</option><option value="3">★★★ Bình thường</option><option value="2">★★ Chưa tốt</option><option value="1">★ Tệ</option></select></div>
      <div class="field"><textarea id="rvText" maxlength="300" rows="3" placeholder="Nhận xét (không bắt buộc)"></textarea></div><button class="btn btn-green contact-btn" id="rvSend" type="button">Gửi đánh giá</button>`;
    $('rvSend').onclick = async () => {
      const { error } = await sb.from('reviews').insert({ listing_id: item.id, reviewee_id: item.userId, rating: +$('rvStars').value, comment: $('rvText').value.trim() });
      if (error) return toast(error.code === '23505' ? 'Bạn đã đánh giá tin này rồi.' : 'Không gửi được: ' + error.message, 'error');
      toast('Cảm ơn bạn đã đánh giá!', 'ok'); await loadPeople(); renderListings(); showDetail(item);
    };
  };
}
function closeDetail() {
  if ($('detailModal').classList.contains('hidden')) return;
  $('detailModal').classList.add('hidden');
  if (lastFocus?.focus) lastFocus.focus();
}

/* ---------- trang quản trị ---------- */
let adminTab = 'listings', adminData = { listings: [], users: [], phones: {} };
async function renderAdmin() {
  if (!isAdmin) { $('adminTable').innerHTML = '<p class="form-message">Bạn không có quyền truy cập trang này. Hãy đăng nhập bằng tài khoản admin.</p>'; return; }
  const [ls, us, ct] = await Promise.all([loadListings(), sb.rpc('admin_list_users'), sb.from('listing_contacts').select('listing_id, phone')]);
  if (us.error) toast('Chưa tải được tài khoản — đã chạy supabase-admin.sql chưa? ' + us.error.message, 'error');
  adminData = { listings: ls, users: us.data || [], phones: Object.fromEntries((ct.data || []).map(c => [c.listing_id, c.phone])) };
  $('tabListings').onclick = () => { adminTab = 'listings'; drawAdmin(); };
  $('tabUsers').onclick = () => { adminTab = 'users'; drawAdmin(); };
  $('adminSearch').oninput = drawAdmin;
  $('purgeExpired').onclick = async () => {
    const n = adminData.listings.filter(x => statusOf(x) === 'expired').length;
    if (!n) return toast('Không có tin hết hạn.');
    if (!confirm(`Xóa vĩnh viễn ${n} tin đã hết hạn?`)) return;
    const { error } = await sb.from('listings').delete().lt('expires_at', new Date().toISOString());
    error ? toast(error.message, 'error') : (toast(`Đã xóa ${n} tin hết hạn.`, 'ok'), renderAdmin());
  };
  drawAdmin();
}
async function adminAct(promise, msg) {
  const { error } = await promise;
  if (error) return toast('Lỗi: ' + error.message, 'error');
  toast(msg, 'ok'); renderAdmin();
}
function drawAdmin() {
  const { listings: ls, users: us, phones } = adminData, q = normalize($('adminSearch').value.trim());
  const emailOf = Object.fromEntries(us.map(u => [u.id, u.email]));
  const count = s => ls.filter(x => statusOf(x) === s).length;
  $('adminStats').textContent = `${ls.length} tin · ${count('open')} đang mở · ${count('closed')} đã chốt · ${count('expired')} hết hạn · ${count('hidden')} bị ẩn · ${us.length} tài khoản (${us.filter(u => u.banned).length} bị khóa)`;
  $('tabListings').className = 'btn ' + (adminTab === 'listings' ? 'btn-green' : 'btn-light');
  $('tabUsers').className = 'btn ' + (adminTab === 'users' ? 'btn-green' : 'btn-light');
  $('purgeExpired').classList.toggle('hidden', adminTab !== 'listings');
  const box = $('adminTable'); box.innerHTML = '';
  const addRow = (html, actions) => {
    const row = document.createElement('div'); row.className = 'admin-row';
    row.innerHTML = `<div>${html}</div><div class="acts"></div>`;
    actions.forEach(([label, cls, fn, href]) => {
      const el = document.createElement(href ? 'a' : 'button');
      el.className = 'btn ' + cls; el.textContent = label;
      if (href) el.href = href; else { el.type = 'button'; el.onclick = fn; }
      row.querySelector('.acts').appendChild(el);
    });
    box.appendChild(row);
  };
  if (adminTab === 'listings') {
    ls.filter(x => !q || normalize([x.name, x.material, x.address, emailOf[x.userId], phones[x.id]].join(' ')).includes(q)).forEach(item => {
      const st = statusOf(item);
      addRow(`<strong>${escapeHTML(item.material)}</strong>${st !== 'open' ? ` <span class="badge-off">${statusLabel(item)}</span>` : ''}
        <small>${item.role === 'seller' ? 'Người bán' : 'Người mua'} · ${escapeHTML(item.name)} · ${escapeHTML(phones[item.id] || '')} · ${escapeHTML(item.address)}</small>
        <small>Tài khoản: ${escapeHTML(emailOf[item.userId] || item.userId)} · ${timeAgo(item.createdAt)}</small>`, [
        ['Xem', 'btn-light', null, 'index.html?id=' + encodeURIComponent(item.id)],
        [item.hidden ? 'Bỏ ẩn' : 'Ẩn', 'btn-light', () => adminAct(sb.from('listings').update({ hidden: !item.hidden }).eq('id', item.id), 'Đã cập nhật.')],
        ['Xóa', 'btn-danger', async () => { if (!confirm('Xóa tin này vĩnh viễn?')) return; await removePhotos(item); adminAct(sb.from('listings').delete().eq('id', item.id), 'Đã xóa tin.'); }]]);
    });
    if (!box.children.length) box.innerHTML = '<p class="field-help">Không có tin nào.</p>';
  } else {
    us.filter(u => !q || normalize(u.email).includes(q)).forEach(u => {
      const self = session && u.id === session.user.id;
      addRow(`<strong>${escapeHTML(u.email || '(không email)')}</strong>${u.role === 'admin' ? ' <span class="badge-mine">Admin</span>' : ''}${u.verified ? ' <span class="badge-verified">✔ Xác minh</span>' : ''}${u.banned ? ' <span class="badge-off">Bị khóa</span>' : ''}${self ? ' <span class="badge-hidden">Bạn</span>' : ''}
        <small>${u.listing_count} tin · Tạo ${fmtDate(u.created_at)}${u.last_sign_in_at ? ' · Đăng nhập gần nhất ' + timeAgo(u.last_sign_in_at) : ''}</small>`, self ? [] : [
        [u.role === 'admin' ? 'Hạ quyền' : 'Cấp admin', 'btn-light', () => confirm(u.role === 'admin' ? 'Hạ tài khoản này xuống người dùng thường?' : 'Cấp quyền admin cho tài khoản này?') && adminAct(sb.rpc('admin_set_role', { uid: u.id, new_role: u.role === 'admin' ? 'user' : 'admin' }), 'Đã đổi quyền.')],
        [u.banned ? 'Mở khóa' : 'Khóa', 'btn-light', () => adminAct(sb.rpc('admin_set_banned', { uid: u.id, ban: !u.banned }), u.banned ? 'Đã mở khóa.' : 'Đã khóa tài khoản.')],
        [u.verified ? 'Gỡ xác minh' : 'Xác minh', 'btn-light', () => adminAct(sb.rpc('admin_set_verified', { uid: u.id, val: !u.verified }), 'Đã cập nhật huy hiệu.')],
        ['Xóa tin của họ', 'btn-light', () => confirm('Xóa toàn bộ tin của tài khoản này?') && adminAct(sb.from('listings').delete().eq('user_id', u.id), 'Đã xóa tin của tài khoản.')],
        ['Xóa tài khoản', 'btn-danger', () => confirm(`Xóa vĩnh viễn tài khoản ${u.email} cùng toàn bộ tin của họ?`) && adminAct(sb.rpc('admin_delete_user', { uid: u.id }), 'Đã xóa tài khoản.')]]);
    });
    if (!box.children.length) box.innerHTML = '<p class="field-help">Không có tài khoản nào.</p>';
  }
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
  $('addrSearch').onclick = searchAddress;
  $('address').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); searchAddress(); } });
  $('photos').onchange = onPhotos;
  $('listingForm').onsubmit = submitListing;
  setTimeout(() => pickMap.invalidateSize(), 100);
  if (!session) openAuth('login', 'Bạn cần đăng nhập để đăng tin.');
}
async function searchAddress() {
  const q = $('address').value.trim(), box = $('addrResults');
  if (q.length < 3) return showMsg('Nhập ít nhất 3 ký tự để tìm địa chỉ.');
  box.innerHTML = '<small>Đang tìm…</small>';
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=vn&accept-language=vi&q=' + encodeURIComponent(q));
    const d = await r.json();
    box.innerHTML = d.length ? '' : '<small>Không tìm thấy. Hãy thử gõ cụ thể hơn hoặc chấm điểm trực tiếp trên bản đồ.</small>';
    d.forEach(p => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'addr-item'; b.textContent = p.display_name;
      b.onclick = () => { setCoords(+p.lat, +p.lon); pickMap.setView([+p.lat, +p.lon], 17); $('address').value = p.display_name.split(', ').slice(0, 4).join(', '); box.innerHTML = ''; };
      box.appendChild(b);
    });
  } catch { box.innerHTML = '<small>Không tìm được lúc này. Hãy chấm điểm trực tiếp trên bản đồ.</small>'; }
}
function onPhotos(e) {
  photoFiles = [...e.target.files].filter(f => f.type.startsWith('image/')).slice(0, 3);
  if (e.target.files.length > 3) toast('Chỉ lấy 3 ảnh đầu tiên.');
  $('photoPreview').innerHTML = photoFiles.map(f => `<img src="${URL.createObjectURL(f)}" alt="Xem trước">`).join('');
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
  const id = crypto.randomUUID(), photos = [], uploaded = [];
  try {
    for (const [i, f] of photoFiles.entries()) {
      const path = `${session.user.id}/${id}-${i}.jpg`;
      const { error } = await sb.storage.from('listing-photos').upload(path, await compressImage(f), { contentType: 'image/jpeg' });
      if (error) throw error;
      uploaded.push(path); photos.push(sb.storage.from('listing-photos').getPublicUrl(path).data.publicUrl);
    }
  } catch (err) { if (btn) btn.disabled = false; return showMsg('Không tải ảnh lên được: ' + err.message); }
  const { data, error } = await sb.from('listings').insert({
    id, photos, role: $('role').value, name: $('name').value.trim(), material: $('material').value, quantity: $('quantity').value.trim(),
    price: $('price').value.trim(), address: $('address').value.trim(), handover: $('handover').value, hours: $('hours').value.trim(),
    description: $('description').value.trim(), lat, lng, fuzzy
  }).select('id').single();
  if (error) { if (uploaded.length) sb.storage.from('listing-photos').remove(uploaded); if (btn) btn.disabled = false; return showMsg('Không đăng được tin: ' + error.message); }
  const c = await sb.from('listing_contacts').insert({ listing_id: data.id, phone: cleanPhone($('phone').value) });
  if (c.error) { await sb.from('listings').delete().eq('id', data.id); if (btn) btn.disabled = false; return showMsg('Không lưu được số điện thoại: ' + c.error.message); }
  location.href = 'index.html?posted=1&id=' + data.id;
}

init();
