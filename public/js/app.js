// ============================
// 清华附中初中社团管理系统 - 前端逻辑
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

function jsStr(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
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

function switchLoginTab(tab, btn) {
  document.querySelectorAll('.login-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.login-form').forEach(f => f.classList.remove('active'));
  btn.classList.add('active');
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
    if (data.adminFeishuMobile !== undefined) {
      localStorage.setItem('adminFeishuMobile', data.adminFeishuMobile);
    }

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
  lastPendingCount = 0;
  navigateTo('login');
  loadClubOptions();
}

// ============ 飞书免登 ============

// 检测是否在飞书客户端内打开
function isFeishuEnv() {
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes('lark') || ua.includes('feishu') || ua.includes('byteview');
}

// 获取飞书配置（是否启用、App ID）
async function getFeishuConfig() {
  try {
    const res = await fetch(API + '/api/feishu/config');
    return await res.json();
  } catch (e) {
    return { enabled: false, appId: '' };
  }
}

// 重定向到飞书授权页
function redirectToFeishuAuth(appId) {
  const redirectUri = window.location.origin + window.location.pathname;
  const state = Math.random().toString(36).substring(2) + Date.now().toString(36);
  sessionStorage.setItem('feishu_state', state);
  const authUrl = 'https://open.feishu.cn/open-apis/authen/v1/authorize'
    + '?app_id=' + encodeURIComponent(appId)
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&state=' + encodeURIComponent(state)
    + '&scope=' + encodeURIComponent('openid profile email');
  window.location.href = authUrl;
}

// 飞书免登核心逻辑：用 code 换取系统 token
async function feishuAutoLogin(code) {
  try {
    const res = await fetch(API + '/api/feishu/auth?code=' + encodeURIComponent(code));
    const data = await res.json();

    if (data.error) {
      console.error('[飞书] 免登失败:', data.error);
      showToast('飞书登录失败，请手动登录');
      return false;
    }

    if (data.needBind) {
      // 匹配不到角色，提示联系管理员，但保留手动登录
      const name = data.feishuUser?.name || '您';
      showToast(name + ' 还未绑定社团，请联系管理员', 4000);
      return false;
    }

    // 免登成功，保存 token
    authToken = data.token;
    userRole = data.role;
    localStorage.setItem('authToken', authToken);
    localStorage.setItem('userRole', userRole);

    if (data.role === 'admin') {
      if (data.feishuUser) {
        // 管理员免登成功，adminFeishuMobile 就是当前用户手机号
        localStorage.setItem('adminFeishuMobile', data.feishuUser.mobile || '');
      }
      showToast('飞书免登成功');
      enterAdmin();
      return true;
    }

    if (data.role === 'teacher' && data.clubId) {
      userClubId = data.clubId;
      localStorage.setItem('userClubId', userClubId);
      currentClubId = data.clubId;
      showToast('飞书免登成功：' + (data.clubName || ''));
      await loadClubDetail();
      navigateTo('detail');
      return true;
    }

    return false;
  } catch (e) {
    console.error('[飞书] 免登异常:', e);
    showToast('飞书登录异常，请手动登录');
    return false;
  }
}

function onClubSelectChange() {}

// ============ 管理员界面 ============

let dashboardDate = '';
let lastPendingCount = 0;

function enterAdmin() {
  dashboardDate = new Date().toISOString().split('T')[0];
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
  if (tab === 'resources') loadResourceClubs();
  if (tab === 'settings') loadAdminFeishuMobile();
}

async function loadDashboard() {
  try {
    const res = await apiFetch('/api/admin/dashboard');
    const stats = await res.json();

    document.getElementById('dashboardStats').innerHTML = `
      <div class="card compact-overview">
        <div class="compact-overview-row">
          <div class="compact-stat">
            <span class="compact-val">${stats.clubCount}</span>
            <span class="compact-label">社团</span>
          </div>
          <div class="compact-divider"></div>
          <div class="compact-stat">
            <span class="compact-val">${stats.totalStudents}</span>
            <span class="compact-label">学生</span>
          </div>
          <div class="compact-divider"></div>
          <div class="compact-stat">
            <span class="compact-val" style="color:var(--success);">${stats.totalPresent}</span>
            <span class="compact-label">到勤</span>
          </div>
          <div class="compact-divider"></div>
          <div class="compact-stat">
            <span class="compact-val" style="color:var(--warning);">${stats.totalLate}</span>
            <span class="compact-label">迟到</span>
          </div>
          <div class="compact-divider"></div>
          <div class="compact-stat">
            <span class="compact-val" style="color:var(--danger);">${stats.totalAbsent}</span>
            <span class="compact-label">缺席</span>
          </div>
          <div class="compact-divider"></div>
          <div class="compact-stat">
            <span class="compact-val" style="color:var(--thu-purple);">${stats.attendanceRate}%</span>
            <span class="compact-label">出勤率</span>
          </div>
        </div>
      </div>
    `;

    // 各社团概览
    const listEl = document.getElementById('adminClubList');
    if (allClubs.length === 0) await loadAllClubsData();

    renderAdminClubOverview(allClubs);
    document.getElementById('adminClubCount').textContent = allClubs.length + ' 个社团';

    // 加载选中日期的统计
    await loadDashboardByDate();
  } catch (e) {
    showToast('加载失败');
  }
}

async function onDashboardDateChange() {
  dashboardDate = document.getElementById('dashboardDateInput').value;
  await loadDashboardByDate();
}

// 仪表盘社团概览渲染
function renderAdminClubOverview(clubs) {
  const listEl = document.getElementById('adminClubList');
  if (!clubs || clubs.length === 0) {
    listEl.innerHTML = `<div class="empty-state" style="padding:30px 10px;"><p style="font-size:14px;">未找到匹配社团</p></div>`;
    return;
  }
  listEl.innerHTML = clubs.map(c => `
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
}

function filterAdminClubs() {
  const keyword = document.getElementById('adminClubSearchInput').value.trim().toLowerCase();
  const filtered = keyword
    ? allClubs.filter(c => c.name.toLowerCase().includes(keyword) || (c.teacher && c.teacher.toLowerCase().includes(keyword)))
    : allClubs;
  renderAdminClubOverview(filtered);
}

// ============ 出勤明细弹窗 ============

let attendanceDetailData = null;

async function showClubAttendanceDetail(clubId, clubName, teacher) {
  const date = document.getElementById('dashboardDateInput').value;

  document.getElementById('attendanceDetailClubName').textContent = clubName + ' - 出勤明细';
  document.getElementById('attendanceDetailTeacher').textContent = '指导老师：' + (teacher || '未设置');
  document.getElementById('attendanceDetailDate').textContent = date ? `${formatDate(date)} ${getWeekday(date)}` : '';
  document.getElementById('attendanceDetailSummary').innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-400);">加载中...</div>';
  document.getElementById('attendanceDetailList').innerHTML = '';
  document.getElementById('attendanceDetailSearch').value = '';

  document.getElementById('modal-attendanceDetail').classList.remove('hidden');

  try {
    const res = await fetch(API + '/api/clubs/' + clubId);
    const club = await res.json();

    const students = club.students || [];
    const records = (club.attendance || {})[date] || {};

    let present = 0, late = 0, absent = 0;
    const studentList = students.map(s => {
      const status = records[s.id] || null;
      if (status === 'present') present++;
      if (status === 'late') late++;
      if (status === 'absent') absent++;
      return { id: s.id, name: s.name, clubName: clubName, status };
    });

    attendanceDetailData = { students: studentList, clubName, total: students.length, present, late, absent };

    // 汇总统计
    const unchecked = students.length - present - late - absent;
    document.getElementById('attendanceDetailSummary').innerHTML = `
      <div class="attendance-detail-stat">
        <div class="attendance-detail-stat-val" style="color:var(--gray-700);">${students.length}</div>
        <div class="attendance-detail-stat-label">应到</div>
      </div>
      <div class="attendance-detail-stat">
        <div class="attendance-detail-stat-val" style="color:var(--success);">${present}</div>
        <div class="attendance-detail-stat-label">到勤</div>
      </div>
      <div class="attendance-detail-stat">
        <div class="attendance-detail-stat-val" style="color:var(--warning);">${late}</div>
        <div class="attendance-detail-stat-label">迟到</div>
      </div>
      <div class="attendance-detail-stat">
        <div class="attendance-detail-stat-val" style="color:var(--danger);">${absent}</div>
        <div class="attendance-detail-stat-label">缺席</div>
      </div>
      <div class="attendance-detail-stat">
        <div class="attendance-detail-stat-val" style="color:var(--gray-400);">${unchecked}</div>
        <div class="attendance-detail-stat-label">未标记</div>
      </div>
    `;

    renderAttendanceDetailList(studentList);
  } catch (e) {
    document.getElementById('attendanceDetailSummary').innerHTML = '<div style="text-align:center;padding:20px;color:var(--danger);">加载失败</div>';
  }
}

function renderAttendanceDetailList(students) {
  const container = document.getElementById('attendanceDetailList');
  if (!students || students.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:20px;"><p style="font-size:14px;">暂无学生名单</p></div>';
    return;
  }

  const statusMap = {
    present: { text: '到勤', cls: 'detail-present' },
    late: { text: '迟到', cls: 'detail-late' },
    absent: { text: '缺席', cls: 'detail-absent' },
    null: { text: '未标记', cls: 'detail-unchecked' }
  };

  container.innerHTML = students.map(s => {
    const st = statusMap[s.status] || statusMap[null];
    const clubInfo = s.teacher ? `${escapeHtml(s.clubName)} · ${escapeHtml(s.teacher)}` : escapeHtml(s.clubName);
    return `
      <div class="attendance-detail-row">
        <div class="attendance-detail-student">
          <span class="attendance-detail-name">${escapeHtml(s.name)}</span>
          <span class="attendance-detail-id">${escapeHtml(s.id)}</span>
        </div>
        <span class="attendance-detail-club">${clubInfo}</span>
        <span class="attendance-detail-status ${st.cls}">${st.text}</span>
      </div>
    `;
  }).join('');
}

function filterAttendanceDetail() {
  if (!attendanceDetailData) return;
  const keyword = document.getElementById('attendanceDetailSearch').value.trim().toLowerCase();
  const filtered = keyword
    ? attendanceDetailData.students.filter(s =>
        s.name.toLowerCase().includes(keyword) || s.id.toLowerCase().includes(keyword) ||
        (s.clubName && s.clubName.toLowerCase().includes(keyword))
      )
    : attendanceDetailData.students;
  renderAttendanceDetailList(filtered);
}

// ============ 出勤汇总弹窗（跨社团） ============

async function showOverallAttendanceDetail(status) {
  const date = document.getElementById('dashboardDateInput').value;
  if (!date) { showToast('请先选择日期'); return; }

  const statusMap = {
    all: { text: '全部学生', color: 'var(--gray-700)' },
    present: { text: '到勤学生', color: 'var(--success)' },
    late: { text: '迟到学生', color: 'var(--warning)' },
    absent: { text: '缺席学生', color: 'var(--danger)' },
    unchecked: { text: '未标记学生', color: 'var(--gray-400)' }
  };
  const stInfo = statusMap[status] || statusMap.all;

  document.getElementById('attendanceDetailClubName').textContent = stInfo.text + '汇总';
  document.getElementById('attendanceDetailTeacher').textContent = formatDate(date) + ' ' + getWeekday(date);
  document.getElementById('attendanceDetailDate').textContent = '';
  document.getElementById('attendanceDetailSummary').innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-400);">加载中...</div>';
  document.getElementById('attendanceDetailList').innerHTML = '';
  document.getElementById('attendanceDetailSearch').value = '';

  document.getElementById('modal-attendanceDetail').classList.remove('hidden');

  try {
    const res = await apiFetch('/api/admin/attendance-detail?date=' + encodeURIComponent(date) + '&status=' + status);
    const data = await res.json();

    attendanceDetailData = {
      students: data.students,
      clubName: '',
      total: data.total,
      present: 0, late: 0, absent: 0,
      isOverall: true
    };

    // 汇总统计 - 简化为总数
    document.getElementById('attendanceDetailSummary').innerHTML = `
      <div class="attendance-detail-stat" style="flex:1;">
        <div class="attendance-detail-stat-val" style="color:${stInfo.color};font-size:28px;">${data.total}</div>
        <div class="attendance-detail-stat-label">${stInfo.text}</div>
      </div>
    `;

    renderAttendanceDetailList(data.students);
  } catch (e) {
    document.getElementById('attendanceDetailSummary').innerHTML = '<div style="text-align:center;padding:20px;color:var(--danger);">加载失败</div>';
  }
}

async function loadDashboardByDate() {
  if (!dashboardDate) return;

  try {
    const res = await apiFetch('/api/admin/dashboard?date=' + encodeURIComponent(dashboardDate));
    const stats = await res.json();

    if (!stats.dateStats) {
      document.getElementById('dashboardDateStats').innerHTML = '';
      return;
    }

    const ds = stats.dateStats;
    let html = `
      <div class="card">
        <div class="date-selector-row" style="margin-bottom:12px;">
          <h3 style="margin:0;font-size:15px;">出勤情况</h3>
          <input type="date" id="dashboardDateInput" value="${dashboardDate}" onchange="onDashboardDateChange()">
        </div>
        <p class="hint" style="margin-bottom:8px;font-size:12px;">${formatDate(dashboardDate)} ${getWeekday(dashboardDate)} · 点击数字查看学生名单</p>
        <div class="stats-grid" style="padding:0;">
          <div class="stat-card clickable-stat" onclick="showOverallAttendanceDetail('all')">
            <div class="stat-value" style="color:var(--gray-700);">${ds.totalStudents}</div>
            <div class="stat-label">应到人数</div>
          </div>
          <div class="stat-card clickable-stat" onclick="showOverallAttendanceDetail('present')">
            <div class="stat-value" style="color:var(--success);">${ds.present}</div>
            <div class="stat-label">到勤</div>
          </div>
          <div class="stat-card clickable-stat" onclick="showOverallAttendanceDetail('late')">
            <div class="stat-value" style="color:var(--warning);">${ds.late}</div>
            <div class="stat-label">迟到</div>
          </div>
          <div class="stat-card clickable-stat" onclick="showOverallAttendanceDetail('absent')">
            <div class="stat-value" style="color:var(--danger);">${ds.absent}</div>
            <div class="stat-label">缺席</div>
          </div>
          <div class="stat-card clickable-stat" onclick="showOverallAttendanceDetail('unchecked')">
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
      html += `<p class="hint" style="margin-bottom:10px;">点击社团查看详细考勤名单</p>`;
      html += ds.clubBreakdown.map(c => `
        <div class="date-item" style="cursor:pointer;" onclick="showClubAttendanceDetail('${c.id}','${jsStr(c.name)}','${jsStr(c.teacher)}')">
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
    <div class="admin-club-item" style="position:relative;">
      <div class="club-icon" onclick="openClub('${c.id}')" style="cursor:pointer;">${escapeHtml(c.name.charAt(0))}</div>
      <div class="club-info" onclick="openClub('${c.id}')" style="cursor:pointer;flex:1;">
        <div class="club-name">${escapeHtml(c.name)}</div>
        <div class="admin-club-stats">
          <span>${escapeHtml(c.teacher || '未设置')}</span>
          <span>${c.studentCount}人</span>
          <span>PIN: ${c.hasPin ? '已设' : '未设'}</span>
        </div>
      </div>
      <button class="icon-btn-sm delete" onclick="event.stopPropagation(); deleteClubFromList('${c.id}','${jsStr(c.name)}')" title="删除社团" style="flex-shrink:0;margin-left:8px;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>
  `).join('');
}

async function deleteClubFromList(clubId, clubName) {
  if (!confirm(`确定删除「${clubName}」吗？\n该社团所有学生和考勤记录将被永久清除！`)) return;
  try {
    await apiFetch('/api/clubs/' + clubId, { method: 'DELETE' });
    showToast('已删除');
    await loadAllClubsData();
    loadAdminClubs();
    loadDashboard();
    loadExportClubs();
  } catch (e) { showToast('删除失败'); }
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

// ============ 学生考勤详情（公开只读，免登录） ============
// 搜索页为免登录场景，点击学生直接打开只读考勤，不触发任何需要鉴权的接口，
// 因此不会因空 token 收到 401 而被踢回登录页。

let sdClub = null;        // 当前查看的社团（来自公开接口 /api/clubs/:id）
let sdStudentId = null;   // 当前查看的学生学号

async function openStudentDetail(clubId, studentId) {
  try {
    const res = await fetch(API + '/api/clubs/' + clubId);
    if (!res.ok) { showToast('未找到该社团'); return; }
    sdClub = await res.json();
    sdStudentId = studentId;
    renderStudentDetail();
    navigateTo('student-detail');
  } catch (e) {
    showToast('加载失败');
  }
}

function renderStudentDetail() {
  if (!sdClub) return;
  const student = (sdClub.students || []).find(s => s.id === sdStudentId);
  if (!student) { showToast('未找到该学生'); navigateTo('search'); return; }

  document.getElementById('sdStudentName').textContent = student.name || '';
  document.getElementById('sdStudentId').textContent = student.id || '';
  document.getElementById('sdClubName').textContent = sdClub.name || '';
  document.getElementById('sdTeacher').textContent = sdClub.teacher || '未设置';

  const dates = Object.keys(sdClub.attendance || {}).sort().reverse();
  let present = 0, late = 0, absent = 0, unchecked = 0;

  const rows = dates.map(date => {
    const status = (sdClub.attendance[date] || {})[sdStudentId];
    if (status === 'present') present++;
    else if (status === 'late') late++;
    else if (status === 'absent') absent++;
    else unchecked++;
    return renderSdDateRow(date, status);
  });

  document.getElementById('sdSummary').textContent =
    `到勤 ${present} · 迟到 ${late} · 缺席 ${absent} · 未标记 ${unchecked}`;

  const container = document.getElementById('sdDateList');
  if (dates.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding:30px 10px;"><p style="font-size:14px;">暂无考勤记录</p></div>`;
  } else {
    container.innerHTML = rows.join('');
  }
}

function renderSdDateRow(date, status) {
  const map = {
    present: { text: '到勤', cls: 'detail-present' },
    late:    { text: '迟到', cls: 'detail-late' },
    absent:  { text: '缺席', cls: 'detail-absent' }
  };
  const info = map[status] || { text: '未标记', cls: 'detail-unchecked' };
  return `
    <div class="date-item">
      <div class="date-info">
        <span class="date-text">${formatDate(date)}</span>
        <span class="date-badge">${getWeekday(date)}</span>
      </div>
      <div class="date-info">
        <span class="attendance-detail-status ${info.cls}">${info.text}</span>
      </div>
    </div>
  `;
}

// 从学生考勤详情返回搜索页（保持免登录搜索流程）
function goBackToSearch() {
  navigateTo('search');
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
    <div class="search-result-item" onclick="openStudentDetail('${r.clubId}', '${r.studentId}')">
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
    navigateTo('login');
  }
}

async function openClub(id) {
  currentClubId = id;
  editMode = false;
  await loadClubDetail();
  navigateTo('detail');
}

function navigateClub(id) {
  openClub(id);
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
  document.getElementById('clubFeishuMobileInput').value = currentClub.feishuMobile || '';
  document.getElementById('clubFeishuMobileDisplay').textContent = currentClub.feishuMobile || '未设置';

  // PIN行仅管理员可见
  document.getElementById('pinRow').style.display = userRole === 'admin' ? '' : 'none';

  // 导出按钮仅管理员或本社团教师可见
  document.getElementById('exportSingleBtn').style.display = canEdit() ? '' : 'none';
  document.getElementById('menuBtn').style.display = canEdit() ? '' : 'none';

  // 编辑按钮仅在有编辑权限且非编辑模式时显示
  const editBtn = document.getElementById('editClubBtn');
  if (editBtn) {
    editBtn.style.display = (canEdit() && !editMode) ? '' : 'none';
  }

  renderDateList();
  renderStudentManageList();
  updateEditModeUI();
  loadClubFiles();
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
        ${userRole === 'admin' ? `<button class="icon-btn-sm transfer" onclick="showTransfer('${s.id}','${jsStr(s.name)}')" title="调换社团">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
        </button>` : ''}
        <button class="icon-btn-sm delete" onclick="deleteStudent('${s.id}','${jsStr(s.name)}')" title="删除">
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

function enterEditMode() {
  if (!canEdit()) { showToast('无编辑权限'); return; }
  editMode = true;
  updateEditModeUI();
}

function cancelEditMode() {
  editMode = false;
  // 恢复输入框为原始值
  if (currentClub) {
    document.getElementById('clubNameInput').value = currentClub.name;
    document.getElementById('clubTeacherInput').value = currentClub.teacher || '';
    document.getElementById('clubPinInput').value = currentClub.pin || '';
    document.getElementById('clubFeishuMobileInput').value = currentClub.feishuMobile || '';
  }
  updateEditModeUI();
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

  // 飞书手机号：管理员和本社团教师都可编辑
  if (canEdit()) {
    document.getElementById('clubFeishuMobileDisplay').classList.toggle('hidden', isEditing);
    document.getElementById('clubFeishuMobileInput').classList.toggle('hidden', !isEditing);
  }

  document.getElementById('importSection').classList.toggle('hidden', !isEditing);
  document.getElementById('studentManageSection').classList.toggle('hidden', !isEditing);
  document.getElementById('editActions').classList.toggle('hidden', !isEditing);

  // 编辑模式下隐藏"编辑"按钮，非编辑模式且有权限时显示
  const editBtn = document.getElementById('editClubBtn');
  if (editBtn) {
    editBtn.style.display = (!isEditing && canEdit()) ? '' : 'none';
  }
}

async function saveClubInfo() {
  const name = document.getElementById('clubNameInput').value.trim();
  const teacher = document.getElementById('clubTeacherInput').value.trim();
  if (!name) { showToast('名称不能为空'); return; }

  const body = { name, teacher };
  // 飞书手机号：管理员和本社团教师都可设置
  const feishuMobile = document.getElementById('clubFeishuMobileInput').value.trim();
  body.feishuMobile = feishuMobile;
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

async function quickAttendance() {
  if (!canEdit()) { showToast('无编辑权限'); return; }
  const today = new Date().toISOString().split('T')[0];

  // 如果今天已有考勤记录，直接打开
  if (currentClub.attendance && currentClub.attendance[today]) {
    openAttendance(today);
    return;
  }

  // 否则创建今天的考勤记录
  try {
    await apiFetch(`/api/clubs/${currentClubId}/attendance/${today}`, {
      method: 'PUT',
      body: JSON.stringify({ records: {} })
    });
    await loadClubDetail();
    openAttendance(today);
  } catch (e) {
    showToast('创建考勤失败');
  }
}

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

// ============ 下载导入模板（Excel） ============
// type: 'admin' -> 社团名称/指导教师/学号/姓名；'teacher' -> 学号/姓名
function downloadTemplate(type) {
  if (typeof XLSX === 'undefined') {
    showToast('模板组件未加载，请刷新页面后重试');
    return;
  }
  let aoa, fileName;
  if (type === 'teacher') {
    aoa = [
      ['学号', '姓名'],
      ['2024001', '张三'],
      ['2024002', '李四']
    ];
    fileName = '学生名单导入模板.xlsx';
  } else {
    // 管理员模板：多社团分区格式
    // 每个社团区块：社团名称行 + 指导教师行 + 老师手机号行 + 学号|姓名表头 + 学生数据
    // 一个文件可包含多个社团，依次排列即可
    aoa = [
      // === 第1个社团 ===
      ['社团名称', '篮球社'],
      ['指导教师', '张老师'],
      ['老师手机号', '13800138000'],
      ['学号', '姓名'],
      ['2024001', '张三'],
      ['2024002', '李四'],
      // === 第2个社团（直接接着写） ===
      ['社团名称', '合唱团'],
      ['指导教师', '王老师、李老师'],
      ['老师手机号', '13900139000'],
      ['学号', '姓名'],
      ['2024003', '王五'],
      ['2024004', '赵六']
    ];
    fileName = '社团与学生批量导入模板.xlsx';
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // 列宽自适应
  const maxCol = Math.max(...aoa.map(r => r.length));
  const colWidths = [];
  for (let c = 0; c < maxCol; c++) {
    const maxLen = Math.max(...aoa.map(r => String(r[c] || '').length), 6);
    colWidths.push({ wch: maxLen + 2 });
  }
  ws['!cols'] = colWidths;
  // 给前两行（社团名、指导教师）加粗显示
  if (type !== 'teacher') {
    ws['A1'].s = { font: { bold: true } };
    ws['A2'].s = { font: { bold: true } };
    ws['A3'].s = { font: { bold: true } };
    ws['B3'].s = { font: { bold: true } };
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '导入模板');
  XLSX.writeFile(wb, fileName);
  showToast('模板已下载，请按示例填写后上传');
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
    const parts = line.trim().split(/[,，\t]+/).filter(p => p.trim());
    // 支持格式：
    // 5列：社团名称,指导老师,老师手机号,学号,姓名
    // 4列：社团名称,指导老师,学号,姓名
    // 3列：社团名称,学号,姓名
    if (parts.length >= 5) {
      items.push({ clubName: parts[0].trim(), teacher: parts[1].trim(), feishuMobile: parts[2].trim(), studentId: parts[3].trim(), studentName: parts.slice(4).join('').trim() });
    } else if (parts.length === 4) {
      items.push({ clubName: parts[0].trim(), teacher: parts[1].trim(), feishuMobile: '', studentId: parts[2].trim(), studentName: parts[3].trim() });
    } else if (parts.length === 3) {
      items.push({ clubName: parts[0].trim(), teacher: '', feishuMobile: '', studentId: parts[1].trim(), studentName: parts[2].trim() });
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

    let items = [];

    // ====== 格式检测：新模板（键值对 + 学生列表，支持多社团分区）======
    const isKVFormat = detectKVFormat(rows);

    if (isKVFormat) {
      // 新格式：支持一个文件内多个社团分区
      items = parseKVMultiSection(rows);
    } else {
      // ====== 兼容旧格式：纯表格（每行一条记录）======
      items = parseTableFormat(rows);
    }

    if (items.length === 0) { showToast('未识别到有效数据，请检查文件格式'); return; }

    // 填入文本框预览
    const previewText = items.map(it => `${it.clubName},${it.teacher || ''},${it.feishuMobile || ''},${it.studentId},${it.studentName}`).join('\n');
    document.getElementById('bulkImportInput').value = previewText;
    showToast(`已解析 ${items.length} 条学生记录，请检查后点击"一键导入"`, 3000);
  } catch (e) {
    showToast('文件解析失败：' + e.message);
  }
  event.target.value = '';
}

/**
 * 检测是否为"键值对+学生列表"新格式（支持多社团分区）
 * 判断依据：第1列包含"社团名称"/"指导教师"/"学号"等标签关键字
 */
function detectKVFormat(rows) {
  if (rows.length < 3) return null;
  let hasClubLabel = false, hasIdLabel = false;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const col0 = String(rows[i][0] || '').trim();
    if (col0 === '社团名称' || col0 === '社团') hasClubLabel = true;
    if (col0 === '学号') hasIdLabel = true;
  }
  return (hasClubLabel && hasIdLabel) ? true : null; // 返回 true 表示检测到新格式
}

/**
 * 解析新格式：支持多社团分区
 * 每个"社团名称"行开始一个新区块，包含：
 *   社团名称 | xxx
 *   指导教师 | xxx（可选）
 *   学号     | 姓名（表头）
 *   学生数据行...
 * 遇到下一个"社团名称"或文件末尾则当前区块结束
 */
function parseKVMultiSection(rows) {
  const items = [];

  // 第一步：找出所有"社团名称"行的位置（每个代表一个区块起点）
  const sectionStarts = [];
  for (let i = 0; i < rows.length; i++) {
    const col0 = String(rows[i][0] || '').trim();
    if (col0 === '社团名称' || col0 === '社团') {
      sectionStarts.push(i);
    }
  }

  if (sectionStarts.length === 0) return items;

  // 第二步：逐个解析每个区块
  for (let sIdx = 0; sIdx < sectionStarts.length; sIdx++) {
    const startRow = sectionStarts[sIdx];
    const endRow = (sIdx + 1 < sectionStarts.length) ? sectionStarts[sIdx + 1] : rows.length;

    // 提取社团名（社团名称行的第2列，即 B 列）
    const clubName = String(rows[startRow][1] || '').trim();
    if (!clubName) continue;

    // 在区块内找指导教师、老师手机号和学号表头
    let teacher = '';
    let feishuMobile = '';
    let headerRowIdx = -1;

    for (let i = startRow + 1; i < endRow; i++) {
      const col0 = String(rows[i][0] || '').trim();
      if (col0 === '指导教师' || col0 === '指导老师' || col0 === '教师' || col0 === '老师') {
        teacher = String(rows[i][1] || '').trim();
      }
      if (col0 === '老师手机号' || col0 === '手机号' || col0 === '飞书手机号' || col0 === '教师手机号') {
        feishuMobile = String(rows[i][1] || '').trim();
      }
      if (col0 === '学号') {
        headerRowIdx = i;
        break; // 找到学号表头就停止搜索元数据
      }
    }

    if (headerRowIdx < 0) continue; // 没有学生表头，跳过此区块

    // 从表头行确定列位置
    const headerRow = rows[headerRowIdx];
    let idCol = -1, nameCol = -1;
    headerRow.forEach((h, i) => {
      const lower = (h || '').toLowerCase();
      if (lower.includes('学号') || lower.includes('id') || lower.includes('编号')) idCol = i;
      if (lower.includes('姓名') || lower.includes('name') || lower.includes('学生')) nameCol = i;
    });
    if (idCol >= 0 && nameCol < 0) nameCol = idCol + 1;
    if (idCol < 0) { idCol = 0; nameCol = 1; }

    // 第三步：解析该区块的学生数据（表头行之后到区块结束）
    for (let i = headerRowIdx + 1; i < endRow; i++) {
      const row = rows[i];
      if (!row || row.every(c => !String(c == null ? '' : c).trim())) continue;
      const sid = String(row[idCol] == null ? '' : row[idCol]).trim();
      const sname = nameCol >= 0 ? String(row[nameCol] == null ? '' : row[nameCol]).trim() : '';
      if (!sid) continue;
      items.push({ clubName, teacher, feishuMobile, studentId: sid, studentName: sname });
    }
  }

  return items;
}

/**
 * 解析旧格式：纯表格（每行一条：社团名,老师,学号,姓名）
 */
function parseTableFormat(rows) {
  const items = [];
  const headers = rows[0] || [];
  let clubCol = -1, teacherCol = -1, idCol = -1, nameCol = -1;

  let mobileCol = -1;
  headers.forEach((h, i) => {
    const lower = (h || '').toLowerCase();
    if (lower.includes('社团') || lower.includes('club') || lower.includes('名称')) clubCol = i;
    if (lower.includes('老师') || lower.includes('教师') || lower.includes('指导') || lower.includes('teacher')) teacherCol = i;
    if (lower.includes('手机号') || lower.includes('mobile') || lower.includes('phone') || lower.includes('飞书')) mobileCol = i;
    if (lower.includes('学号') || lower.includes('id') || lower.includes('编号')) idCol = i;
    if (lower.includes('姓名') || lower.includes('name') || lower.includes('学生')) nameCol = i;
  });

  if (clubCol >= 0 && idCol >= 0 && nameCol >= 0) {
    let lastClub = '', lastTeacher = '';
    const startIdx = 1; // 有表头则从第2行开始
    for (let i = startIdx; i < rows.length; i++) {
      const row = rows[i];
      if (row.every(c => !String(c == null ? '' : c).trim())) continue;
      // 跳过重复表头
      const c0 = String(row[clubCol] == null ? '' : row[clubCol]).trim();
      const i0 = String(row[idCol] == null ? '' : row[idCol]).trim();
      const n0 = String(row[nameCol] == null ? '' : row[nameCol]).trim();
      if (c0 === '社团名称' && i0 === '学号' && n0 === '姓名') continue;
      if (!i0) continue;
      let club = c0; if (!club) club = lastClub;
      let tch = teacherCol >= 0 ? String(row[teacherCol] == null ? '' : row[teacherCol]).trim() : ''; if (!tch) tch = lastTeacher;
      let mob = mobileCol >= 0 ? String(row[mobileCol] == null ? '' : row[mobileCol]).trim() : '';
      lastClub = club || lastClub; lastTeacher = tch || lastTeacher;
      items.push({ clubName: club, teacher: tch, feishuMobile: mob, studentId: i0, studentName: n0 });
    }
  } else {
    // 无表头，按列顺序
    const startIdx = (headers.some(h => /社团|学号|姓名|老师|teacher|name|id|club/i.test(h || ''))) ? 1 : 0;
    for (let i = startIdx; i < rows.length; i++) {
      const row = rows[i];
      if (row.length >= 5) {
        // 5列：社团名,老师,手机号,学号,姓名
        items.push({ clubName: String(row[0]).trim(), teacher: String(row[1]).trim(), feishuMobile: String(row[2]).trim(), studentId: String(row[3]).trim(), studentName: String(row[4]).trim() });
      } else if (row.length === 4) {
        items.push({ clubName: String(row[0]).trim(), teacher: String(row[1]).trim(), feishuMobile: '', studentId: String(row[2]).trim(), studentName: String(row[3]).trim() });
      } else if (row.length === 3) {
        items.push({ clubName: String(row[0]).trim(), teacher: '', feishuMobile: '', studentId: String(row[1]).trim(), studentName: String(row[2]).trim() });
      }
    }
  }
  return items;
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
        // 跳过完全为空的行
        if (row.every(c => !String(c == null ? '' : c).trim())) continue;
        // 跳过重复出现的表头行
        const i0 = String(row[idCol] == null ? '' : row[idCol]).trim();
        const n0 = String(row[nameCol] == null ? '' : row[nameCol]).trim();
        if (i0 === '学号' && n0 === '姓名') continue;
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
    if (msg.type === 'bulk_imported' && document.getElementById('page-admin-dashboard').classList.contains('active')) {
      loadClubOptions();
    }
  });

}



// ============ 初始化 ============

window.addEventListener('DOMContentLoaded', async () => {
  loadClubOptions();
  connectSSE();

  // 1. 先检查 URL 是否有飞书回调 code
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');

  if (code) {
    // 有 code，尝试飞书免登
    await feishuAutoLogin(code);
    // 清除 URL 上的 code 参数，避免刷新重复处理
    window.history.replaceState({}, document.title, window.location.pathname);
    // 绑定回车键登录（即使免登失败也需要）
    bindLoginEnterKeys();
    return;
  }

  // 2. 检查本地已有 token
  if (authToken && userRole) {
    try {
      const res = await fetch(API + '/api/auth/check', { headers: authHeaders() });
      if (res.ok) {
        if (userRole === 'admin') {
          enterAdmin();
          bindLoginEnterKeys();
          return;
        }
        if (userRole === 'teacher' && userClubId) {
          currentClubId = userClubId;
          await loadClubDetail();
          navigateTo('detail');
          bindLoginEnterKeys();
          return;
        }
      }
    } catch (e) {}
    // token 无效，清除
    authToken = ''; userRole = ''; userClubId = '';
    localStorage.removeItem('authToken');
    localStorage.removeItem('userRole');
    localStorage.removeItem('userClubId');
  }

  // 3. 没有有效 token，检查是否在飞书环境且飞书已启用
  if (isFeishuEnv()) {
    try {
      const config = await getFeishuConfig();
      if (config.enabled && config.appId) {
        // 重定向到飞书授权
        redirectToFeishuAuth(config.appId);
        return;
      }
    } catch (e) {}
  }

  // 4. 都不满足，显示登录页
  navigateTo('login');
  bindLoginEnterKeys();
});

function bindLoginEnterKeys() {
  const adminPwd = document.getElementById('adminPassword');
  const teacherPin = document.getElementById('teacherPin');
  if (adminPwd) {
    adminPwd.addEventListener('keypress', e => {
      if (e.key === 'Enter') adminLogin();
    });
  }
  if (teacherPin) {
    teacherPin.addEventListener('keypress', e => {
      if (e.key === 'Enter') teacherLogin();
    });
  }
}

// ============ 系统设置 ============

async function changeAdminPassword() {
  const newPwd = document.getElementById('newAdminPassword').value;
  const confirmPwd = document.getElementById('confirmAdminPassword').value;

  if (!newPwd) { showToast('请输入新密码'); return; }
  if (newPwd.length < 4) { showToast('密码至少4位'); return; }
  if (newPwd !== confirmPwd) { showToast('两次输入的密码不一致'); return; }

  try {
    const res = await apiFetch('/api/admin/password', {
      method: 'PUT',
      body: JSON.stringify({ newPassword: newPwd })
    });
    const data = await res.json();
    if (data.success) {
      showToast('密码修改成功，请重新登录');
      document.getElementById('newAdminPassword').value = '';
      document.getElementById('confirmAdminPassword').value = '';
      setTimeout(() => logout(), 1500);
    } else {
      showToast(data.error || '修改失败');
    }
  } catch (e) {
    showToast('修改失败');
  }
}

// 保存管理员飞书手机号
async function saveAdminFeishuMobile() {
  const mobile = document.getElementById('adminFeishuMobileInput').value.trim();
  try {
    const res = await apiFetch('/api/admin/settings', {
      method: 'PUT',
      body: JSON.stringify({ adminFeishuMobile: mobile })
    });
    const data = await res.json();
    if (data.success) {
      localStorage.setItem('adminFeishuMobile', mobile);
      showToast(mobile ? '手机号保存成功' : '已清除手机号');
    } else {
      showToast(data.error || '保存失败');
    }
  } catch (e) {
    showToast('保存失败');
  }
}

// 加载管理员飞书手机号到输入框
async function loadAdminFeishuMobile() {
  try {
    // 通过获取社团列表间接拿到 settings 不太方便，这里用一个简单方式：
    // 调用 /api/settings 只能拿到 appName，所以我们需要另一个方式
    // 实际上 adminFeishuMobile 保存在 settings 中，但公开接口不返回
    // 我们可以在进入设置页时，通过一个已登录的接口获取
    // 这里简化：保存时直接 PUT，加载时我们可以从 data 中读取
    // 为了简单，我们在管理员登录时把 adminFeishuMobile 存到 localStorage
    const saved = localStorage.getItem('adminFeishuMobile') || '';
    document.getElementById('adminFeishuMobileInput').value = saved;
  } catch (e) {}
}

// ============ 数据备份与恢复 ============
async function openBackupModal() {
  try {
    const res = await apiFetch('/api/admin/backups');
    const data = await res.json();
    document.getElementById('backupDirHint').textContent = '备份位置：' + (data.backupDir || '未知');
    const list = document.getElementById('backupList');
    if (!data.backups || data.backups.length === 0) {
      list.innerHTML = '<p class="hint">暂无备份</p>';
    } else {
      list.innerHTML = data.backups.map(f =>
        `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #eee;">
           <span style="font-size:13px;">${f}</span>
           <button class="btn-small" onclick="restoreBackup('${f}')">恢复</button>
         </div>`
      ).join('');
    }
    openModalBackup();
  } catch (e) {
    showToast('获取备份列表失败');
  }
}

function openModalBackup() {
  document.getElementById('modal-backup').classList.remove('hidden');
}

async function backupNow() {
  try {
    const res = await apiFetch('/api/admin/backup-now', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('已备份，当前共 ' + data.count + ' 份');
      openBackupModal();
    } else {
      showToast('备份失败');
    }
  } catch (e) {
    showToast('备份失败');
  }
}

async function restoreBackup(file) {
  if (!confirm('确定要从备份《' + file + '》恢复考勤数据吗？当前数据将被覆盖。')) return;
  try {
    const res = await apiFetch('/api/admin/restore', {
      method: 'POST',
      body: JSON.stringify({ file })
    });
    const data = await res.json();
    if (data.success) {
      showToast('已从《' + file + '》恢复');
      setTimeout(() => closeModal('modal-backup'), 1200);
    } else {
      showToast(data.error || '恢复失败');
    }
  } catch (e) {
    showToast('恢复失败');
  }
}

// ============ 资源管理（教案与照片） ============

let clubFiles = [];

async function loadClubFiles() {
  if (!currentClubId) return;
  try {
    const res = await apiFetch('/api/clubs/' + currentClubId + '/files');
    clubFiles = await res.json();
    renderResourceFiles();
  } catch (e) {
    console.error('加载文件列表失败', e);
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatFileDate(dateStr) {
  const d = new Date(dateStr);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

function getFileIcon(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) return '🖼️';
  if (['mp4', 'avi', 'mov', 'wmv', 'flv'].includes(ext)) return '🎬';
  if (['pdf'].includes(ext)) return '📕';
  if (['doc', 'docx'].includes(ext)) return '📘';
  if (['ppt', 'pptx'].includes(ext)) return '📙';
  if (['xls', 'xlsx'].includes(ext)) return '📗';
  if (['zip', 'rar', '7z'].includes(ext)) return '🗜️';
  if (['txt', 'md'].includes(ext)) return '📝';
  return '📎';
}

function isImageFile(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  return ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext);
}

function renderResourceFiles() {
  const lessonList = document.getElementById('lessonFileList');
  const photoList = document.getElementById('photoFileList');
  if (!lessonList || !photoList) return;

  const lessons = clubFiles.filter(f => f.type === 'lesson');
  const photos = clubFiles.filter(f => f.type === 'photo');

  // 教案列表
  if (lessons.length === 0) {
    lessonList.innerHTML = '<div class="resource-empty">暂无教案文件</div>';
  } else {
    lessonList.innerHTML = lessons.map(f => `
      <div class="resource-file-item">
        <span class="resource-file-icon">${getFileIcon(f.originalName)}</span>
        <div class="resource-file-info">
          <div class="resource-file-name">${escapeHtml(f.originalName)}</div>
          <div class="resource-file-meta">${formatFileSize(f.size)} · ${formatFileDate(f.uploadDate)}</div>
        </div>
        <div class="resource-file-actions">
          <button onclick="downloadFile('${currentClubId}','${f.id}')" title="下载">⬇️</button>
          ${canEdit() ? `<button class="delete" onclick="deleteFile('${currentClubId}','${f.id}','${jsStr(f.originalName)}')" title="删除">🗑️</button>` : ''}
        </div>
      </div>
    `).join('');
  }

  // 照片列表（图片显示缩略图，其他显示文件名）
  if (photos.length === 0) {
    photoList.innerHTML = '<div class="resource-empty">暂无照片</div>';
  } else {
    const imagePhotos = photos.filter(f => isImageFile(f.originalName));
    const otherPhotos = photos.filter(f => !isImageFile(f.originalName));

    let html = '';
    if (imagePhotos.length > 0) {
      html += '<div class="resource-photo-preview">';
      html += imagePhotos.map(f => `
        <div class="resource-photo-thumb-wrap">
          <img class="resource-photo-thumb" src="${API}/api/clubs/${currentClubId}/files/${f.id}/download?token=${authToken}" alt="${escapeHtml(f.originalName)}" onclick="downloadFile('${currentClubId}','${f.id}')">
          ${canEdit() ? `<button class="delete-overlay" onclick="deleteFile('${currentClubId}','${f.id}','${jsStr(f.originalName)}')">×</button>` : ''}
        </div>
      `).join('');
      html += '</div>';
    }
    if (otherPhotos.length > 0) {
      html += otherPhotos.map(f => `
        <div class="resource-file-item">
          <span class="resource-file-icon">${getFileIcon(f.originalName)}</span>
          <div class="resource-file-info">
            <div class="resource-file-name">${escapeHtml(f.originalName)}</div>
            <div class="resource-file-meta">${formatFileSize(f.size)} · ${formatFileDate(f.uploadDate)}</div>
          </div>
          <div class="resource-file-actions">
            <button onclick="downloadFile('${currentClubId}','${f.id}')" title="下载">⬇️</button>
            ${canEdit() ? `<button class="delete" onclick="deleteFile('${currentClubId}','${f.id}','${jsStr(f.originalName)}')" title="删除">🗑️</button>` : ''}
          </div>
        </div>
      `).join('');
    }
    photoList.innerHTML = html;
  }
}

async function uploadResource(event, type) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';

  if (!canEdit()) {
    showToast('无权上传');
    return;
  }

  const maxSize = 50 * 1024 * 1024;
  if (file.size > maxSize) {
    showToast('文件不能超过50MB');
    return;
  }

  showToast('正在上传...');

  try {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch(API + '/api/clubs/' + currentClubId + '/upload?type=' + type, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + authToken },
      body: formData
    });

    const data = await res.json();
    if (data.success) {
      showToast('上传成功');
      loadClubFiles();
    } else {
      showToast(data.error || '上传失败');
    }
  } catch (e) {
    showToast('上传失败');
  }
}

function downloadFile(clubId, fileId) {
  window.open(API + '/api/clubs/' + clubId + '/files/' + fileId + '/download?token=' + authToken, '_blank');
}

async function deleteFile(clubId, fileId, filename) {
  if (!confirm('确定删除「' + filename + '」吗？')) return;
  try {
    const res = await apiFetch('/api/clubs/' + clubId + '/files/' + fileId, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('已删除');
      loadClubFiles();
    } else {
      showToast(data.error || '删除失败');
    }
  } catch (e) {
    showToast('删除失败');
  }
}

// ============ 管理员资源下载 ============

async function loadResourceClubs() {
  try {
    const res = await apiFetch('/api/clubs');
    const clubs = await res.json();
    const container = document.getElementById('resourceClubList');
    if (!container) return;

    if (clubs.length === 0) {
      container.innerHTML = '<div class="resource-empty">暂无社团</div>';
      return;
    }

    container.innerHTML = clubs.map(c => {
      const hasFiles = c.fileCount && c.fileCount > 0;
      return `
        <div class="resource-club-item">
          <div class="resource-club-info">
            <div class="resource-club-name">${escapeHtml(c.name)}</div>
            <div class="resource-club-count">${escapeHtml(c.teacher || '未设置老师')} · ${c.fileCount || 0} 个文件${c.lessonCount ? `（教案${c.lessonCount} / 照片${c.photoCount}）` : ''}</div>
          </div>
          <div class="resource-club-actions">
            <button class="btn-small" onclick="downloadClubResources('${c.id}')" ${!hasFiles ? 'disabled style="opacity:0.5;"' : ''}>下载</button>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    console.error('加载社团列表失败', e);
  }
}

function downloadAllResources(type) {
  window.open(API + '/api/admin/download/' + type + '?token=' + authToken, '_blank');
}

function downloadClubResources(clubId) {
  window.open(API + '/api/admin/download/club/' + clubId + '?token=' + authToken, '_blank');
}
