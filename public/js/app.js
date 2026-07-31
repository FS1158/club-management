// ============================
// 清华附中社团考勤管理系统 - 前端逻辑
// ============================

const API = '';
let authToken = localStorage.getItem('authToken') || '';
let userRole = localStorage.getItem('userRole') || '';
let userClubId = localStorage.getItem('userClubId') || '';
let currentClub = null;
let currentClubId = null;
let currentDate = null;
let editMode = false;
let allClubs = [];
let transferStudentData = null;

// ============ 工具函数 ============

function showToast(msg, duration = 2000) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add('hidden'), duration);
}

function authHeaders() {
  return authToken ? { 'Authorization': 'Bearer ' + authToken, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

async function apiFetch(url, options = {}) {
  options.headers = { ...authHeaders(), ...(options.headers || {}) };
  const res = await fetch(API + url, options);
  if (res.status === 401) {
    showToast('登录已过期，请重新登录');
    logout();
    throw new Error('Unauthorized');
  }
  return res;
}

function formatDate(dateStr) {
  const parts = dateStr.split('-');
  return `${parseInt(parts[1])}月${parseInt(parts[2])}日`;
}

function getWeekday(dateStr) {
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  return '周' + days[new Date(dateStr).getDay()];
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function navigateTo(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  window.scrollTo(0, 0);
}

function closeModal(id, event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById(id).classList.add('hidden');
}

// ============ 登录系统 ============

function switchLoginTab(tab) {
  document.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.login-form').forEach(f => f.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('login' + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.add('active');
}

async function loadClubOptions() {
  try {
    const res = await fetch(API + '/api/clubs');
    const clubs = await res.json();
    const select = document.getElementById('teacherClubSelect');
    select.innerHTML = '<option value="">请选择您的社团</option>';
    clubs.forEach(c => {
      select.innerHTML += `<option value="${c.id}">${escapeHtml(c.name)} - ${escapeHtml(c.teacher || '未设置')}</option>`;
    });
  } catch (e) {}
}

async function adminLogin() {
  const password = document.getElementById('adminPassword').value;
  if (!password) { showToast('请输入密码'); return; }

  try {
    const res = await fetch(API + '/api/login/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (data.error) { showToast(data.error); return; }

    authToken = data.token;
    userRole = 'admin';
    localStorage.setItem('authToken', authToken);
    localStorage.setItem('userRole', userRole);

    showToast('登录成功');
    enterAdmin();
  } catch (e) {
    showToast('登录失败');
  }
}

async function teacherLogin() {
  const clubId = document.getElementById('teacherClubSelect').value;
  const pin = document.getElementById('teacherPin').value;

  if (!clubId) { showToast('请选择社团'); return; }
  if (!pin) { showToast('请输入PIN码'); return; }

  try {
    const res = await fetch(API + '/api/login/teacher', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clubId, pin })
    });
    const data = await res.json();
    if (data.error) { showToast(data.error); return; }

    authToken = data.token;
    userRole = 'teacher';
    userClubId = data.clubId;
    localStorage.setItem('authToken', authToken);
    localStorage.setItem('userRole', userRole);
    localStorage.setItem('userClubId', userClubId);

    showToast('登录成功');
    currentClubId = userClubId;
    await loadClubDetail();
    navigateTo('detail');
  } catch (e) {
    showToast('登录失败');
  }
}

function guestLogin() {
  userRole = 'guest';
  localStorage.setItem('userRole', 'guest');
  loadClubs('guestClubList');
  navigateTo('guest');
}

function logout() {
  if (authToken) {
    fetch(API + '/api/logout', { method: 'POST', headers: authHeaders() }).catch(() => {});
  }
  authToken = '';
  userRole = '';
  userClubId = '';
  localStorage.removeItem('authToken');
  localStorage.removeItem('userRole');
  localStorage.removeItem('userClubId');
  navigateTo('login');
  loadClubOptions();
}

function onClubSelectChange() {}

// ============ 管理员界面 ============

function enterAdmin() {
  document.getElementById('dashboardDateInput').value = new Date().toISOString().split('T')[0];
  loadDashboard();
  loadAdminClubs();
  loadExportClubs();
  navigateTo('admin-dashboard');
}

function switchAdminTab(tab, btn) {
  document.querySelectorAll('.admin-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('adminTab-' + tab).classList.add('active');
}

async function loadDashboard() {
  try {
    const res = await apiFetch('/api/admin/dashboard');
    const stats = await res.json();

    document.getElementById('dashboardStats').innerHTML = `
      <div class="stat-card highlight">
        <div class="stat-value">${stats.clubCount}</div>
        <div class="stat-label">社团总数</div>
      </div>
      <div class="stat-card highlight">
        <div class="stat-value">${stats.totalStudents}</div>
        <div class="stat-label">学生总数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:var(--success);">${stats.totalPresent}</div>
        <div class="stat-label">到勤人次</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:var(--danger);">${stats.totalAbsent}</div>
        <div class="stat-label">缺席人次</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:var(--warning);">${stats.totalLate}</div>
        <div class="stat-label">迟到人次</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:var(--thu-purple);">${stats.attendanceRate}%</div>
        <div class="stat-label">总体出勤率</div>
      </div>
    `;

    // 各社团概览
    const listEl = document.getElementById('adminClubList');
    if (allClubs.length === 0) await loadAllClubsData();

    listEl.innerHTML = allClubs.map(c => `
      <div class="admin-club-item" onclick="openClub('${c.id}')">
        <div class="club-icon">${escapeHtml(c.name.charAt(0))}</div>
        <div class="club-info">
          <div class="club-name">${escapeHtml(c.name)}</div>
          <div class="admin-club-stats">
            <span>${escapeHtml(c.teacher || '未设置')}</span>
            <span>${c.studentCount}人</span>
            <span>${c.attendanceDates.length}次考勤</span>
          </div>
        </div>
      </div>
    `).join('');

    // 加载选中日期的统计
    await loadDashboardByDate();
  } catch (e) {
    showToast('加载失败');
  }
}

async function onDashboardDateChange() {
  await loadDashboardByDate();
}

async function loadDashboardByDate() {
  const date = document.getElementById('dashboardDateInput').value;
  if (!date) return;

  try {
    const res = await apiFetch('/api/admin/dashboard?date=' + encodeURIComponent(date));
    const stats = await res.json();

    if (!stats.dateStats) {
      document.getElementById('dashboardDateStats').innerHTML = '';
      return;
    }

    const ds = stats.dateStats;
    let html = `
      <div class="card">
        <h3>${formatDate(date)} ${getWeekday(date)} 出勤情况</h3>
        <div class="stats-grid" style="padding:0;">
          <div class="stat-card">
            <div class="stat-value" style="color:var(--gray-700);">${ds.totalStudents}</div>
            <div class="stat-label">应到人数</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" style="color:var(--success);">${ds.present}</div>
            <div class="stat-label">到勤</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" style="color:var(--warning);">${ds.late}</div>
            <div class="stat-label">迟到</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" style="color:var(--danger);">${ds.absent}</div>
            <div class="stat-label">缺席</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" style="color:var(--gray-400);">${ds.unchecked}</div>
            <div class="stat-label">未标记</div>
          </div>
          <div class="stat-card highlight">
            <div class="stat-value">${ds.attendanceRate}%</div>
            <div class="stat-label">出勤率</div>
          </div>
        </div>
      </div>
    `;

    if (ds.clubBreakdown && ds.clubBreakdown.length > 0) {
      html += `<div class="card"><h3>各社团出勤明细</h3>`;
      html += ds.clubBreakdown.map(c => `
        <div class="date-item" style="cursor:pointer;" onclick="openClub('${c.id}')">
          <div class="date-info">
            <span class="date-text" style="font-size:14px;">${escapeHtml(c.name)}</span>
            <span style="font-size:12px;color:var(--gray-400);">${escapeHtml(c.teacher)}</span>
          </div>
          <div class="date-info">
            <span style="font-size:13px;">
              <span style="color:var(--success);font-weight:600;">${c.present}</span>到
              <span style="color:var(--warning);font-weight:600;">${c.late}</span>迟
              <span style="color:var(--danger);font-weight:600;">${c.absent}</span>缺
              ${c.unchecked > 0 ? `<span style="color:var(--gray-400);">${c.unchecked}未</span>` : ''}
              <span style="color:var(--gray-400);">/${c.total}</span>
            </span>
          </div>
        </div>
      `).join('');
      html += `</div>`;
    }

    document.getElementById('dashboardDateStats').innerHTML = html;
  } catch (e) {
    showToast('加载日期统计失败');
  }
}

async function loadAllClubsData() {
  const res = await fetch(API + '/api/clubs');
  allClubs = await res.json();
}

async function loadAdminClubs() {
  if (allClubs.length === 0) await loadAllClubsData();
  const listEl = document.getElementById('adminManageClubList');
  listEl.innerHTML = allClubs.map(c => `
    <div class="admin-club-item" onclick="openClub('${c.id}')">
      <div class="club-icon">${escapeHtml(c.name.charAt(0))}</div>
      <div class="club-info">
        <div class="club-name">${escapeHtml(c.name)}</div>
        <div class="admin-club-stats">
          <span>${escapeHtml(c.teacher || '未设置')}</span>
          <span>${c.studentCount}人</span>
          <span>PIN: ${c.pin || '未设'}</span>
        </div>
      </div>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--gray-300)" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
  `).join('');
}

async function loadExportClubs() {
  if (allClubs.length === 0) await loadAllClubsData();
  const listEl = document.getElementById('exportClubList');
  listEl.innerHTML = allClubs.map(c => `
    <div class="export-club-item" onclick="exportSingleClub('${c.id}')">
      <div>
        <div style="font-weight:600;font-size:15px;">${escapeHtml(c.name)}</div>
        <div style="font-size:13px;color:var(--gray-500);">${c.studentCount}人 · ${c.attendanceDates.length}次考勤</div>
      </div>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--thu-purple)" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
  `).join('');
}

// ============ 社团列表（访客） ============

async function loadClubs(containerId) {
  try {
    const res = await fetch(API + '/api/clubs');
    allClubs = await res.json();
    renderClubList(allClubs, containerId);
  } catch (e) {
    document.getElementById(containerId).innerHTML = '<div class="loading">加载失败</div>';
  }
}

function renderClubList(clubs, containerId) {
  const container = document.getElementById(containerId);
  if (!clubs || clubs.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><p>暂无社团</p></div>`;
    return;
  }
  container.innerHTML = clubs.map(c => `
    <div class="club-card" onclick="openClub('${c.id}')">
      <div class="club-icon">${escapeHtml(c.name.charAt(0))}</div>
      <div class="club-info">
        <div class="club-name">${escapeHtml(c.name)}</div>
        <div class="club-meta">${escapeHtml(c.teacher || '未设置')} · ${c.studentCount}人</div>
      </div>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--gray-300)" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
  `).join('');
}

function filterClubs() {
  const keyword = document.getElementById('searchInput').value.trim().toLowerCase();
  const filtered = keyword
    ? allClubs.filter(c => c.name.toLowerCase().includes(keyword) || (c.teacher && c.teacher.toLowerCase().includes(keyword)))
    : allClubs;
  renderClubList(filtered, 'guestClubList');
}

// ============ 全局学生搜索 ============

let searchDebounceTimer = null;
let currentSearchResults = [];

function goBackFromSearch() {
  if (userRole === 'admin') {
    navigateTo('admin-dashboard');
  } else if (userRole === 'teacher') {
    navigateTo('detail');
  } else {
    navigateTo('login');
  }
}

function enterSearchPage() {
  document.getElementById('globalSearchInput').value = '';
  renderSearchResults([], '');
  navigateTo('search');
  setTimeout(() => document.getElementById('globalSearchInput').focus(), 100);
}

function searchStudentsDebounced() {
  clearTimeout(searchDebounceTimer);
  const keyword = document.getElementById('globalSearchInput').value.trim();
  if (!keyword) {
    renderSearchResults([]);
    return;
  }
  searchDebounceTimer = setTimeout(() => searchStudents(keyword), 200);
}

async function searchStudents(keyword) {
  try {
    const res = await fetch(API + '/api/search/students?q=' + encodeURIComponent(keyword));
    const data = await res.json();
    currentSearchResults = data.results || [];
    renderSearchResults(currentSearchResults, keyword);
  } catch (e) {
    showToast('搜索失败');
  }
}

function renderSearchResults(results, keyword) {
  const container = document.getElementById('searchResults');
  const summary = document.getElementById('searchResultSummary');

  if (!keyword) {
    summary.textContent = '';
    container.innerHTML = `<div class="search-empty"><div class="search-empty-icon">🔍</div><p>输入姓名或学号搜索学生所在社团</p></div>`;
    return;
  }

  summary.textContent = results.length > 0 ? `找到 ${results.length} 条结果` : '未找到匹配结果';

  if (results.length === 0) {
    container.innerHTML = `<div class="search-empty"><div class="search-empty-icon">😕</div><p>未找到「${escapeHtml(keyword)}」相关学生</p></div>`;
    return;
  }

  container.innerHTML = results.map(r => `
    <div class="search-result-item" onclick="openClub('${r.clubId}')">
      <div class="search-result-header">
        <span class="search-result-name">${escapeHtml(r.studentName)}</span>
        <span class="search-result-id">${escapeHtml(r.studentId)}</span>
      </div>
      <div class="search-result-club">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        <span>${escapeHtml(r.clubName)} · ${escapeHtml(r.teacher || '未设置')}</span>
      </div>
    </div>
  `).join('');
}

// ============ 社团详情 ============

function goBackFromDetail() {
  if (userRole === 'admin') {
    navigateTo('admin-dashboard');
  } else if (userRole === 'teacher') {
    navigateTo('login');
    logout();
  } else {
    navigateTo('guest');
  }
}

async function openClub(id) {
  currentClubId = id;
  editMode = false;
  await loadClubDetail();
  navigateTo('detail');
}

async function loadClubDetail() {
  try {
    const res = await fetch(API + '/api/clubs/' + currentClubId);
    currentClub = await res.json();
    renderDetail();
  } catch (e) {
    showToast('加载失败');
  }
}

function canEdit() {
  return userRole === 'admin' || (userRole === 'teacher' && userClubId === currentClubId);
}

function renderDetail() {
  if (!currentClub) return;

  document.getElementById('detailTitle').textContent = currentClub.name;
  document.getElementById('clubNameDisplay').textContent = currentClub.name;
  document.getElementById('clubTeacherDisplay').textContent = currentClub.teacher || '未设置';
  document.getElementById('clubStudentCount').textContent = (currentClub.students || []).length + ' 人';
  document.getElementById('clubPinDisplay').textContent = currentClub.pin || '未设置';

  document.getElementById('clubNameInput').value = currentClub.name;
  document.getElementById('clubTeacherInput').value = currentClub.teacher || '';
  document.getElementById('clubPinInput').value = currentClub.pin || '';

  // PIN行仅管理员可见
  document.getElementById('pinRow').style.display = userRole === 'admin' ? '' : 'none';

  // 导出按钮仅管理员或本社团教师可见
  document.getElementById('exportSingleBtn').style.display = canEdit() ? '' : 'none';
  document.getElementById('menuBtn').style.display = canEdit() ? '' : 'none';

  renderDateList();
  renderStudentManageList();
  updateEditModeUI();
}

function renderDateList() {
  const container = document.getElementById('dateList');
  const dates = Object.keys(currentClub.attendance || {}).sort().reverse();

  if (dates.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding:30px 10px;"><p style="font-size:14px;">暂无考勤记录</p></div>`;
    return;
  }

  container.innerHTML = dates.map(date => {
    const records = currentClub.attendance[date];
    const total = (currentClub.students || []).length;
    const present = Object.values(records).filter(s => s === 'present').length;
    const absent = Object.values(records).filter(s => s === 'absent').length;
    const late = Object.values(records).filter(s => s === 'late').length;
    const unchecked = total - present - absent - late;

    return `
      <div class="date-item" onclick="openAttendance('${date}')">
        <div class="date-info">
          <span class="date-text">${formatDate(date)}</span>
          <span class="date-badge">${getWeekday(date)}</span>
        </div>
        <div class="date-info">
          <span style="font-size:13px;color:var(--gray-500);">
            <span style="color:var(--success);font-weight:600;">${present}</span>到
            <span style="color:var(--warning);font-weight:600;">${late}</span>迟
            <span style="color:var(--danger);font-weight:600;">${absent}</span>缺
            ${unchecked > 0 ? `<span style="color:var(--gray-400);">${unchecked}未</span>` : ''}
          </span>
        </div>
      </div>`;
  }).join('');
}

function renderStudentManageList() {
  const container = document.getElementById('studentManageList');
  if (!currentClub || !currentClub.students) return;

  const students = currentClub.students;
  if (students.length === 0) {
    container.innerHTML = `<p style="color:var(--gray-400);font-size:14px;text-align:center;padding:12px;">暂无学生，请导入名单</p>`;
    return;
  }

  container.innerHTML = students.map(s => `
    <div class="student-manage-row">
      <div class="student-info">
        <div class="student-name">${escapeHtml(s.name)}</div>
        <div class="student-id">${escapeHtml(s.id)}</div>
      </div>
      <div class="student-manage-actions">
        ${userRole === 'admin' ? `<button class="icon-btn-sm transfer" onclick="showTransfer('${s.id}','${escapeHtml(s.name)}')" title="调换社团">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        </button>` : ''}
        <button class="icon-btn-sm delete" onclick="deleteStudent('${s.id}','${escapeHtml(s.name)}')" title="删除">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>
      </div>
    </div>
  `).join('');
}

// ============ 编辑模式 ============

function showClubMenu() {
  if (!canEdit()) return;
  document.getElementById('deleteClubMenuBtn').style.display = userRole === 'admin' ? '' : 'none';
  document.getElementById('modal-clubMenu').classList.remove('hidden');
}

function toggleEditMode() {
  if (!canEdit()) { showToast('无编辑权限'); return; }
  editMode = !editMode;
  if (!editMode) {
    saveClubInfo();
  } else {
    updateEditModeUI();
  }
}

function updateEditModeUI() {
  const isEditing = editMode;
  document.getElementById('clubNameDisplay').classList.toggle('hidden', isEditing);
  document.getElementById('clubNameInput').classList.toggle('hidden', !isEditing);
  document.getElementById('clubTeacherDisplay').classList.toggle('hidden', isEditing);
  document.getElementById('clubTeacherInput').classList.toggle('hidden', !isEditing);

  // PIN仅管理员可编辑
  if (userRole === 'admin') {
    document.getElementById('clubPinDisplay').classList.toggle('hidden', isEditing);
    document.getElementById('clubPinInput').classList.toggle('hidden', !isEditing);
  }

  document.getElementById('importSection').classList.toggle('hidden', !isEditing);
  document.getElementById('studentManageSection').classList.toggle('hidden', !isEditing);
}

async function saveClubInfo() {
  const name = document.getElementById('clubNameInput').value.trim();
  const teacher = document.getElementById('clubTeacherInput').value.trim();
  if (!name) { showToast('名称不能为空'); return; }

  const body = { name, teacher };
  if (userRole === 'admin') {
    const pin = document.getElementById('clubPinInput').value.trim();
    if (pin) body.pin = pin;
  }

  try {
    await apiFetch('/api/clubs/' + currentClubId, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    editMode = false;
    await loadClubDetail();
    showToast('保存成功');
  } catch (e) {
    showToast('保存失败');
  }
}

// ============ 学生名单管理 ============

async function importStudents() {
  const text = document.getElementById('studentInput').value.trim();
  if (!text) { showToast('请先粘贴名单'); return; }

  try {
    const res = await apiFetch(`/api/clubs/${currentClubId}/students`, {
      method: 'POST',
      body: JSON.stringify({ students: text })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`导入 ${data.count} 名学生`);
      document.getElementById('studentInput').value = '';
      await loadClubDetail();
    } else {
      showToast(data.error || '导入失败');
    }
  } catch (e) {
    showToast('导入失败');
  }
}

async function clearStudents() {
  if (!confirm('确定清空所有学生名单吗？')) return;
  try {
    await apiFetch(`/api/clubs/${currentClubId}/students`, {
      method: 'POST',
      body: JSON.stringify({ students: [] })
    });
    showToast('已清空');
    await loadClubDetail();
  } catch (e) { showToast('操作失败'); }
}

function showAddStudent() {
  document.getElementById('newStudentId').value = '';
  document.getElementById('newStudentName').value = '';
  document.getElementById('modal-addStudent').classList.remove('hidden');
}

async function addStudent() {
  const id = document.getElementById('newStudentId').value.trim();
  const name = document.getElementById('newStudentName').value.trim();
  if (!id || !name) { showToast('学号和姓名不能为空'); return; }

  try {
    const res = await apiFetch(`/api/clubs/${currentClubId}/students/add`, {
      method: 'POST',
      body: JSON.stringify({ id, name })
    });
    const data = await res.json();
    if (data.success) {
      closeModal('modal-addStudent');
      showToast('已添加');
      await loadClubDetail();
    } else {
      showToast(data.error || '添加失败');
    }
  } catch (e) { showToast('添加失败'); }
}

async function deleteStudent(studentId, studentName) {
  if (!confirm(`确定删除 ${studentName} 吗？`)) return;
  try {
    await apiFetch(`/api/clubs/${currentClubId}/students/${studentId}`, { method: 'DELETE' });
    showToast('已删除');
    await loadClubDetail();
  } catch (e) { showToast('删除失败'); }
}

// ============ 学生调换（管理员） ============

function showTransfer(studentId, studentName) {
  transferStudentData = { studentId, studentName };
  document.getElementById('transferStudentInfo').textContent = `将 ${studentName}（${studentId}）调换到：`;
  const select = document.getElementById('transferTargetClub');
  select.innerHTML = '<option value="">请选择目标社团</option>';
  allClubs.filter(c => c.id !== currentClubId).forEach(c => {
    select.innerHTML += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
  });
  document.getElementById('modal-transfer').classList.remove('hidden');
}

async function transferStudent() {
  const toId = document.getElementById('transferTargetClub').value;
  if (!toId) { showToast('请选择目标社团'); return; }
  if (!confirm(`确定调换到该社团吗？该学生在原社团的考勤记录将被清除。`)) return;

  try {
    const res = await apiFetch(`/api/clubs/${currentClubId}/transfer/${transferStudentData.studentId}`, {
      method: 'POST',
      body: JSON.stringify({ toId })
    });
    const data = await res.json();
    if (data.success) {
      closeModal('modal-transfer');
      showToast('调换成功');
      await loadClubDetail();
      await loadAllClubsData();
    } else {
      showToast(data.error || '调换失败');
    }
  } catch (e) { showToast('调换失败'); }
}

// ============ 考勤管理 ============

function showAddDate() {
  if (!canEdit()) { showToast('无编辑权限'); return; }
  document.getElementById('newDateInput').value = new Date().toISOString().split('T')[0];
  document.getElementById('modal-addDate').classList.remove('hidden');
}

async function addDate() {
  const date = document.getElementById('newDateInput').value;
  if (!date) { showToast('请选择日期'); return; }

  if (currentClub.attendance && currentClub.attendance[date]) {
    closeModal('modal-addDate');
    openAttendance(date);
    return;
  }

  try {
    await apiFetch(`/api/clubs/${currentClubId}/attendance/${date}`, {
      method: 'PUT',
      body: JSON.stringify({ records: {} })
    });
    closeModal('modal-addDate');
    await loadClubDetail();
    showToast('日期已添加');
  } catch (e) { showToast('添加失败'); }
}

async function openAttendance(date) {
  currentDate = date;
  document.getElementById('attendanceDateTitle').textContent = `${formatDate(date)} ${getWeekday(date)}`;
  document.getElementById('deleteDateBtn').style.display = canEdit() ? '' : 'none';
  renderAttendance();
  navigateTo('attendance');
}

function renderAttendance() {
  if (!currentClub) return;
  let students = currentClub.students || [];
  const records = (currentClub.attendance || {})[currentDate] || {};
  const container = document.getElementById('attendanceList');
  const editable = canEdit();

  // 考勤搜索筛选
  const searchKeyword = document.getElementById('attendanceSearchInput')?.value.trim().toLowerCase() || '';
  if (searchKeyword) {
    students = students.filter(s =>
      s.name.toLowerCase().includes(searchKeyword) ||
      s.id.toLowerCase().includes(searchKeyword)
    );
  }

  if (students.length === 0) {
    container.innerHTML = searchKeyword
      ? `<div class="empty-state"><div class="empty-icon">🔍</div><p>未找到匹配学生</p></div>`
      : `<div class="empty-state"><div class="empty-icon">📝</div><p>暂无学生名单</p></div>`;
    document.getElementById('attendanceSummary').textContent = `出勤 0 / ${currentClub.students ? currentClub.students.length : 0}`;
    return;
  }

  let presentCount = 0;
  // 统计全部到勤人数（不受搜索影响）
  (currentClub.students || []).forEach(s => {
    if (records[s.id] === 'present') presentCount++;
  });

  container.innerHTML = students.map(s => {
    const status = records[s.id] || null;
    const onclick = editable ? `onclick="setAttendance('${s.id}', 'present')"` : '';
    const onclickLate = editable ? `onclick="setAttendance('${s.id}', 'late')"` : '';
    const onclickAbsent = editable ? `onclick="setAttendance('${s.id}', 'absent')"` : '';
    return `
      <div class="student-row">
        <div class="student-info">
          <div class="student-name">${escapeHtml(s.name)}</div>
          <div class="student-id">${escapeHtml(s.id)}</div>
        </div>
        <div class="status-buttons">
          <button class="status-btn ${status === 'present' ? 'active present' : ''}" ${onclick} title="到勤">到</button>
          <button class="status-btn ${status === 'late' ? 'active late' : ''}" ${onclickLate} title="迟到">迟</button>
          <button class="status-btn ${status === 'absent' ? 'active absent' : ''}" ${onclickAbsent} title="缺席">缺</button>
        </div>
      </div>`;
  }).join('');

  document.getElementById('attendanceSummary').textContent = `出勤 ${presentCount} / ${currentClub.students ? currentClub.students.length : 0}`;

  // 隐藏快捷操作（无权限时）
  document.querySelector('.attendance-actions').style.display = editable ? '' : 'none';
}

function filterAttendanceStudents() {
  renderAttendance();
}

async function setAttendance(studentId, status) {
  if (!canEdit()) { showToast('无编辑权限'); return; }

  if (!currentClub.attendance) currentClub.attendance = {};
  if (!currentClub.attendance[currentDate]) currentClub.attendance[currentDate] = {};

  const current = currentClub.attendance[currentDate][studentId];
  if (current === status) {
    delete currentClub.attendance[currentDate][studentId];
    status = null;
  } else {
    currentClub.attendance[currentDate][studentId] = status;
  }

  renderAttendance();

  try {
    await apiFetch(`/api/clubs/${currentClubId}/attendance/${currentDate}/${studentId}`, {
      method: 'PUT',
      body: JSON.stringify({ status })
    });
  } catch (e) { showToast('同步失败'); }
}

async function markAll(status) {
  if (!canEdit()) return;
  const students = currentClub.students || [];
  if (students.length === 0) return;

  const records = {};
  if (status) students.forEach(s => { records[s.id] = status; });

  if (!currentClub.attendance) currentClub.attendance = {};
  currentClub.attendance[currentDate] = records;

  renderAttendance();

  try {
    await apiFetch(`/api/clubs/${currentClubId}/attendance/${currentDate}`, {
      method: 'PUT',
      body: JSON.stringify({ records })
    });
    showToast(status ? (status === 'present' ? '已全部到勤' : '已全部缺席') : '已清空');
  } catch (e) { showToast('操作失败'); }
}

async function deleteAttendanceDate() {
  if (!canEdit()) return;
  if (!confirm(`确定删除 ${formatDate(currentDate)} 的考勤记录吗？`)) return;
  try {
    await apiFetch(`/api/clubs/${currentClubId}/attendance/${currentDate}`, { method: 'DELETE' });
    showToast('已删除');
    await loadClubDetail();
    navigateTo('detail');
  } catch (e) { showToast('删除失败'); }
}

// ============ 导出功能 ============

async function exportSingleClub(clubId) {
  try {
    const res = await apiFetch(`/api/clubs/${clubId}/export`);
    if (!res.ok) throw new Error('导出失败');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentClub ? currentClub.name : '社团'}_考勤报表.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('导出成功');
  } catch (e) {
    showToast('导出失败，请检查权限');
  }
}

async function exportAllClubs() {
  try {
    const res = await apiFetch('/api/admin/export-all');
    if (!res.ok) throw new Error('导出失败');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `全部社团考勤汇总_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('导出成功');
  } catch (e) {
    showToast('导出失败');
  }
}

// ============ 批量导入（管理员） ============

async function bulkImport() {
  const text = document.getElementById('bulkImportInput').value.trim();
  if (!text) { showToast('请先粘贴或上传数据'); return; }

  const items = parseBulkText(text);
  if (items.length === 0) { showToast('未识别到有效数据'); return; }

  if (!confirm(`将导入 ${items.length} 条记录，系统会自动创建不存在的社团。确认导入？`)) return;

  try {
    const res = await apiFetch('/api/admin/bulk-import', {
      method: 'POST',
      body: JSON.stringify({ items })
    });
    const data = await res.json();
    if (data.success) {
      let msg = `导入成功！新建社团 ${data.createdClubs} 个`;
      if (data.updatedClubs > 0) msg += `，更新 ${data.updatedClubs} 个`;
      msg += `，添加学生 ${data.addedStudents} 人`;
      if (data.skipped > 0) msg += `，跳过 ${data.skipped} 条`;
      showToast(msg, 4000);
      document.getElementById('bulkImportInput').value = '';
      await loadAllClubsData();
      loadDashboard();
      loadAdminClubs();
      loadExportClubs();
    } else {
      showToast(data.error || '导入失败');
    }
  } catch (e) {
    showToast('导入失败');
  }
}

function parseBulkText(text) {
  const lines = text.trim().split(/\n/).filter(l => l.trim());
  const items = [];
  for (const line of lines) {
    const parts = line.trim().split(/[,，\t\s]+/).filter(p => p);
    // 支持格式：社团名称,指导老师,学号,姓名（4列）
    // 或：社团名称,学号,姓名（3列）
    if (parts.length >= 4) {
      items.push({ clubName: parts[0], teacher: parts[1], studentId: parts[2], studentName: parts.slice(3).join('') });
    } else if (parts.length === 3) {
      items.push({ clubName: parts[0], teacher: '', studentId: parts[1], studentName: parts[2] });
    }
  }
  return items;
}

async function handleBulkFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const rows = await parseFile(file);
    if (rows.length === 0) { showToast('文件中未识别到有效数据'); return; }

    // 智能识别列：查找包含"社团"的列、包含"学号"的列、包含"姓名"的列、包含"老师/指导"的列
    const headers = rows[0] || [];
    let clubCol = -1, teacherCol = -1, idCol = -1, nameCol = -1;

    headers.forEach((h, i) => {
      const lower = (h || '').toLowerCase();
      if (lower.includes('社团') || lower.includes('club') || lower.includes('名称')) clubCol = i;
      if (lower.includes('老师') || lower.includes('教师') || lower.includes('指导') || lower.includes('teacher')) teacherCol = i;
      if (lower.includes('学号') || lower.includes('id') || lower.includes('编号')) idCol = i;
      if (lower.includes('姓名') || lower.includes('name') || lower.includes('学生')) nameCol = i;
    });

    let items = [];
    if (clubCol >= 0 && idCol >= 0 && nameCol >= 0) {
      // 有表头识别
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row[clubCol] && row[idCol] && row[nameCol]) {
          items.push({
            clubName: String(row[clubCol]).trim(),
            teacher: teacherCol >= 0 ? String(row[teacherCol] || '').trim() : '',
            studentId: String(row[idCol]).trim(),
            studentName: String(row[nameCol]).trim()
          });
        }
      }
    } else {
      // 无表头或无法识别，按列顺序尝试：第1列社团，第2列老师，第3列学号，第4列姓名
      // 或3列：社团，学号，姓名
      const startIdx = (headers.some(h => /社团|学号|姓名|老师|teacher|name|id|club/i.test(h || ''))) ? 1 : 0;
      for (let i = startIdx; i < rows.length; i++) {
        const row = rows[i];
        if (row.length >= 4) {
          items.push({ clubName: String(row[0]).trim(), teacher: String(row[1]).trim(), studentId: String(row[2]).trim(), studentName: String(row[3]).trim() });
        } else if (row.length === 3) {
          items.push({ clubName: String(row[0]).trim(), teacher: '', studentId: String(row[1]).trim(), studentName: String(row[2]).trim() });
        }
      }
    }

    if (items.length === 0) { showToast('未识别到有效数据，请检查文件格式'); return; }

    // 填入文本框预览
    const previewText = items.map(it => `${it.clubName},${it.teacher || ''},${it.studentId},${it.studentName}`).join('\n');
    document.getElementById('bulkImportInput').value = previewText;
    showToast(`已解析 ${items.length} 条记录，请检查后点击"一键导入"`, 3000);
  } catch (e) {
    showToast('文件解析失败：' + e.message);
  }
  event.target.value = '';
}

// ============ 文件解析工具 ============

async function parseFile(file) {
  const name = file.name.toLowerCase();
  const ext = name.split('.').pop();

  if (ext === 'csv' || ext === 'txt') {
    // CSV / TXT 文本解析
    const text = await file.text();
    return parseCSVText(text);
  } else if (ext === 'xlsx' || ext === 'xls') {
    // Excel 解析（使用 SheetJS）
    if (typeof XLSX === 'undefined') {
      throw new Error('Excel解析库未加载，请刷新页面重试');
    }
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    return data.map(row => (row || []).map(cell => String(cell).trim()));
  } else {
    // 尝试当作文本解析
    const text = await file.text();
    return parseCSVText(text);
  }
}

function parseCSVText(text) {
  const lines = text.trim().split(/\n/).filter(l => l.trim());
  return lines.map(line => {
    // 先尝试逗号分割
    if (line.includes(',')) {
      return line.split(/[,，]/).map(s => s.trim().replace(/^["']|["']$/g, ''));
    }
    // 再尝试Tab分割
    if (line.includes('\t')) {
      return line.split('\t').map(s => s.trim());
    }
    // 最后尝试空格分割（但保留姓名中的空格不分割，只分割前两段）
    const parts = line.trim().split(/\s+/);
    return parts;
  });
}

// ============ 教师端文件上传导入名单 ============

async function handleStudentFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const rows = await parseFile(file);
    if (rows.length === 0) { showToast('文件中未识别到有效数据'); return; }

    // 智能识别列
    const headers = rows[0] || [];
    let idCol = -1, nameCol = -1;

    headers.forEach((h, i) => {
      const lower = (h || '').toLowerCase();
      if (lower.includes('学号') || lower.includes('id') || lower.includes('编号')) idCol = i;
      if (lower.includes('姓名') || lower.includes('name') || lower.includes('学生')) nameCol = i;
    });

    let students = [];
    if (idCol >= 0 && nameCol >= 0) {
      // 有表头识别
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row[idCol] && row[nameCol]) {
          students.push(`${String(row[idCol]).trim()} ${String(row[nameCol]).trim()}`);
        }
      }
    } else {
      // 无表头，尝试前两列：学号 姓名
      const startIdx = (headers.some(h => /学号|姓名|id|name/i.test(h || ''))) ? 1 : 0;
      for (let i = startIdx; i < rows.length; i++) {
        const row = rows[i];
        if (row.length >= 2) {
          students.push(`${String(row[0]).trim()} ${String(row[1]).trim()}`);
        }
      }
    }

    if (students.length === 0) { showToast('未识别到有效数据，请检查文件格式'); return; }

    document.getElementById('studentInput').value = students.join('\n');
    showToast(`已解析 ${students.length} 名学生，请检查后点击"导入名单"`, 3000);
  } catch (e) {
    showToast('文件解析失败：' + e.message);
  }
  event.target.value = '';
}

// ============ 添加社团（管理员） ============

function showAddClub() {
  document.getElementById('newClubName').value = '';
  document.getElementById('newClubTeacher').value = '';
  document.getElementById('newClubPin').value = '';
  document.getElementById('modal-addClub').classList.remove('hidden');
}

async function addClub() {
  const name = document.getElementById('newClubName').value.trim();
  const teacher = document.getElementById('newClubTeacher').value.trim();
  const pin = document.getElementById('newClubPin').value.trim() || '0000';

  if (!name) { showToast('请输入社团名称'); return; }

  try {
    await apiFetch('/api/clubs', {
      method: 'POST',
      body: JSON.stringify({ name, teacher, pin })
    });
    closeModal('modal-addClub');
    showToast('社团已创建');
    await loadAllClubsData();
    loadAdminClubs();
    loadDashboard();
    loadExportClubs();
  } catch (e) { showToast('创建失败'); }
}

async function deleteClub() {
  if (userRole !== 'admin') return;
  if (!confirm(`确定删除「${currentClub.name}」吗？所有数据将被清除！`)) return;
  try {
    await apiFetch('/api/clubs/' + currentClubId, { method: 'DELETE' });
    showToast('已删除');
    await loadAllClubsData();
    enterAdmin();
  } catch (e) { showToast('删除失败'); }
}

// ============ SSE 实时推送 ============

function connectSSE() {
  const es = new EventSource(API + '/api/events');
  es.onmessage = function(event) {
    try {
      const msg = JSON.parse(event.data);
      handleSSEMessage(msg);
    } catch (e) {}
  };
  es.onerror = function() {
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

function handleSSEMessage(msg) {
  if (!msg.type) return;

  // 如果是当前社团的更新
  if (currentClubId && msg.clubId === currentClubId) {
    loadClubDetail().then(() => {
      if (document.getElementById('page-attendance').classList.contains('active')) {
        renderAttendance();
      }
    });
  }

  // 刷新列表数据
  loadAllClubsData().then(() => {
    if (userRole === 'admin') {
      if (document.getElementById('page-admin-dashboard').classList.contains('active')) {
        loadDashboard();
        loadAdminClubs();
        loadExportClubs();
      }
    }
    if (document.getElementById('page-guest').classList.contains('active')) {
      renderClubList(allClubs, 'guestClubList');
    }
    if (msg.type === 'bulk_imported' && document.getElementById('page-admin-dashboard').classList.contains('active')) {
      loadClubOptions();
    }
  });
}

// ============ 初始化 ============

window.addEventListener('DOMContentLoaded', () => {
  loadClubOptions();
  connectSSE();

  // 检查已保存的登录状态
  if (authToken && userRole) {
    // 验证token是否仍然有效
    fetch(API + '/api/auth/check', { headers: authHeaders() })
      .then(res => {
        if (res.ok) {
          if (userRole === 'admin') enterAdmin();
          else if (userRole === 'teacher') {
            currentClubId = userClubId;
            loadClubDetail().then(() => navigateTo('detail'));
          } else {
            guestLogin();
          }
        } else {
          logout();
        }
      })
      .catch(() => {});
  }

  // 回车键登录
  document.getElementById('adminPassword').addEventListener('keypress', e => {
    if (e.key === 'Enter') adminLogin();
  });
  document.getElementById('teacherPin').addEventListener('keypress', e => {
    if (e.key === 'Enter') teacherLogin();
  });
});
