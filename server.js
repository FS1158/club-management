const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

// ============ 飞书配置 ============
// 优先读环境变量，没有则使用内置默认值（解决 Railway 环境变量传递问题）
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || 'cli_aafaac367c789cc4';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '5BrMpU3W8ZjbZ8hktPrcacaBzWCLWTLI';
const FEISHU_ENABLED = !!(FEISHU_APP_ID && FEISHU_APP_SECRET);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ 数据存储 ============
// 数据根目录：考勤数据、照片、备份统一存放。
// 默认 D:\club-management-data（避免撑大 C 盘）；部署到其他机器可用环境变量 DATA_ROOT 覆盖（如 Linux 服务器路径）。
const DATA_ROOT = process.env.DATA_ROOT || 'D:\\club-management-data';
const DATA_FILE = path.join(DATA_ROOT, 'data.json');
const UPLOAD_DIR = path.join(DATA_ROOT, 'uploads');

// 确保上传目录存在
function ensureUploadDir(clubId, type) {
  const dir = path.join(UPLOAD_DIR, clubId, type === 'lesson' ? 'lessons' : 'photos');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// 启动时创建上传根目录
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer 文件上传配置
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const clubId = req.params.clubId;
      const type = req.query.type || 'photo';
      const dir = ensureUploadDir(clubId, type);
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const name = Date.now() + '_' + Math.random().toString(36).substring(2, 8) + ext;
      cb(null, name);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) {
    return { settings: { appName: '清华附中初中社团管理系统', adminPassword: 'admin123' }, clubs: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ============ 数据自动备份 ============
// 备份目录：可用环境变量 BACKUP_DIR 指定（如 D:\club-backups），默认在程序目录下 backups/
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_ROOT, 'backups');
const BACKUP_KEEP = 30; // 保留最近 30 份

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 仅当 data.json 合法时才备份，避免把损坏数据存成备份
function backupData(notify) {
  try {
    JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); // 校验合法性
    ensureBackupDir();
    const dest = path.join(BACKUP_DIR, `data-${ts()}.json`);
    fs.copyFileSync(DATA_FILE, dest);
    // 轮换：仅保留最近 BACKUP_KEEP 份
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('data-') && f.endsWith('.json'))
      .sort();
    while (files.length > BACKUP_KEEP) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    }
    if (notify) console.log(`[备份] 已备份 data.json -> ${dest}`);
  } catch (e) {
    console.error('[备份] 备份失败:', e.message);
  }
}

function listBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('data-') && f.endsWith('.json'))
    .sort()
    .reverse(); // 最新在前
}

// 从指定备份恢复 data.json；成功返回 true
function restoreFromBackup(filename) {
  if (!filename || !/^data-.*\.json$/.test(filename)) return false;
  const src = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(src)) return false;
  try {
    const content = fs.readFileSync(src, 'utf-8');
    JSON.parse(content); // 校验
    fs.copyFileSync(src, DATA_FILE);
    return true;
  } catch (e) {
    console.error('[恢复] 恢复失败:', e.message);
    return false;
  }
}

// 启动自检：若 data.json 损坏，尝试自动从最新备份恢复
function startupIntegrityCheck() {
  try {
    JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    return true; // 正常
  } catch (e) {
    console.error('[自检] data.json 损坏，尝试从备份自动恢复...');
    const files = listBackups();
    if (files.length > 0 && restoreFromBackup(files[0])) {
      console.log(`[自检] 已从备份 ${files[0]} 自动恢复`);
      return true;
    }
    console.error('[自检] 无可用备份，将使用默认空数据（数据可能已丢失）');
    return false;
  }
}

// 初始化数据（含升级旧数据）
function initData() {
  if (!fs.existsSync(DATA_FILE)) {
    const sample = {
      settings: {
        appName: '清华附中初中社团管理系统',
        adminPassword: 'admin123'
      },
      clubs: [
        {
          id: 'club_demo1',
          name: '篮球社（示例）',
          teacher: '张老师',
          pin: '1234',
          students: [
            { id: '2024001', name: '张三' },
            { id: '2024002', name: '李四' },
            { id: '2024003', name: '王五' }
          ],
          attendance: {}
        },
        {
          id: 'club_demo2',
          name: '合唱团（示例）',
          teacher: '李老师',
          pin: '5678',
          students: [
            { id: '2024010', name: '赵六' },
            { id: '2024011', name: '孙七' }
          ],
          attendance: {}
        }
      ]
    };
    saveData(sample);
  } else {
    // 升级旧数据格式
    const data = loadData();
    if (!data.settings) {
      data.settings = { appName: '清华附中初中社团管理系统', adminPassword: 'admin123' };
    }
    // 飞书免登：管理员手机号字段
    if (data.settings.adminFeishuMobile === undefined) {
      data.settings.adminFeishuMobile = '';
    }
    // 飞书免登：社团老师手机号字段
    data.clubs.forEach(c => {
      if (c.feishuMobile === undefined) c.feishuMobile = '';
    });
    saveData(data);
  }
}
initData();

// ============ 认证系统 ============
const sessions = new Map(); // token -> { role, clubId }

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function authMiddleware(requiredRole) {
  return (req, res, next) => {
    let token = req.headers.authorization?.replace('Bearer ', '');
    if (!token && req.query.token) token = req.query.token;
    if (!token || !sessions.has(token)) {
      return res.status(401).json({ error: '未登录或登录已过期' });
    }
    const session = sessions.get(token);
    if (requiredRole === 'admin' && session.role !== 'admin') {
      return res.status(403).json({ error: '需要管理员权限' });
    }
    if (requiredRole === 'teacher' && session.role !== 'admin' && session.role !== 'teacher') {
      return res.status(403).json({ error: '需要教师权限' });
    }
    req.session = session;
    req.token = token;
    next();
  };
}

// 检查教师是否有权编辑某社团
function canEditClub(session, clubId) {
  if (session.role === 'admin') return true;
  if (session.role === 'teacher' && session.clubId === clubId) return true;
  return false;
}

// ============ SSE 实时推送 ============
const clients = new Set();

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('data: connected\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

function broadcast(message) {
  const msg = `data: ${JSON.stringify(message)}\n\n`;
  clients.forEach(client => client.write(msg));
}

// ============ 公开接口 ============

// 获取系统设置（公开）
app.get('/api/settings', (req, res) => {
  const data = loadData();
  res.json({ appName: data.settings.appName });
});

// 获取所有社团（列表摘要，公开可查看）
app.get('/api/clubs', (req, res) => {
  const data = loadData();
  const list = data.clubs.map(c => ({
    id: c.id,
    name: c.name,
    teacher: c.teacher,
    studentCount: (c.students || []).length,
    attendanceDates: Object.keys(c.attendance || {}).sort().reverse(),
    hasPin: !!(c.pin && c.pin.length > 0),
    lessonCount: (c.files || []).filter(f => f.type === 'lesson').length,
    photoCount: (c.files || []).filter(f => f.type === 'photo').length,
    fileCount: (c.files || []).length
  }));
  res.json(list);
});

// 获取单个社团详情（公开可查看）
app.get('/api/clubs/:id', (req, res) => {
  const data = loadData();
  const club = data.clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: '社团不存在' });
  res.json(club);
});

// 全局搜索学生（公开可查看）：按学号或姓名搜索所在社团
app.get('/api/search/students', (req, res) => {
  const { q } = req.query;
  const keyword = (q || '').trim().toLowerCase();
  if (!keyword) return res.json({ results: [] });

  const data = loadData();
  const results = [];

  data.clubs.forEach(club => {
    (club.students || []).forEach(s => {
      if (s.id.toLowerCase().includes(keyword) || s.name.toLowerCase().includes(keyword)) {
        results.push({
          studentId: s.id,
          studentName: s.name,
          clubId: club.id,
          clubName: club.name,
          teacher: club.teacher || ''
        });
      }
    });
  });

  res.json({ results, total: results.length });
});

// ============ 认证接口 ============

// 管理员登录
app.post('/api/login/admin', (req, res) => {
  const { password } = req.body;
  const data = loadData();
  if (password !== data.settings.adminPassword) {
    return res.status(401).json({ error: '密码错误' });
  }
  const token = generateToken();
  sessions.set(token, { role: 'admin' });
  res.json({ token, role: 'admin', adminFeishuMobile: data.settings.adminFeishuMobile || '' });
});

// 教师登录
app.post('/api/login/teacher', (req, res) => {
  const { clubId, pin } = req.body;
  const data = loadData();
  const club = data.clubs.find(c => c.id === clubId);
  if (!club) return res.status(404).json({ error: '社团不存在' });
  if (pin !== club.pin) return res.status(401).json({ error: 'PIN码错误' });
  const token = generateToken();
  sessions.set(token, { role: 'teacher', clubId });
  res.json({ token, role: 'teacher', clubId, clubName: club.name });
});

// 验证token是否有效
app.get('/api/auth/check', authMiddleware('teacher'), (req, res) => {
  res.json({ valid: true, ...req.session });
});

// 退出登录
app.post('/api/logout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) sessions.delete(token);
  res.json({ success: true });
});

// ============ 飞书免登 ============

// 手机号标准化：去掉 +86、空格、横线等，统一为纯数字
function normalizeMobile(mobile) {
  if (!mobile) return '';
  let m = String(mobile).trim().replace(/[\s\-]/g, '');
  if (m.startsWith('+86')) m = m.substring(3);
  if (m.startsWith('86') && m.length > 11) m = m.substring(2);
  return m;
}

// 获取飞书配置（公开）：前端判断是否启用飞书免登
app.get('/api/feishu/config', (req, res) => {
  res.json({
    enabled: FEISHU_ENABLED,
    appId: FEISHU_APP_ID
  });
});

// 调试接口：查看环境变量是否正确传递
app.get('/api/debug/env', (req, res) => {
  const allKeys = Object.keys(process.env).sort();
  res.json({
    feishuAppIdLength: process.env.FEISHU_APP_ID ? process.env.FEISHU_APP_ID.length : 0,
    feishuAppSecretLength: process.env.FEISHU_APP_SECRET ? process.env.FEISHU_APP_SECRET.length : 0,
    feishuAppId: process.env.FEISHU_APP_ID || '',
    hasFeishuAppId: !!process.env.FEISHU_APP_ID,
    hasFeishuAppSecret: !!process.env.FEISHU_APP_SECRET,
    allEnvKeys: allKeys
  });
});

// 飞书免登回调：用 code 换取用户信息，匹配角色，返回系统 token
app.get('/api/feishu/auth', async (req, res) => {
  if (!FEISHU_ENABLED) {
    return res.status(400).json({ error: '飞书免登未启用，请配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET' });
  }

  const { code } = req.query;
  if (!code) {
    return res.status(400).json({ error: '缺少 code 参数' });
  }

  try {
    // 1. 获取 tenant_access_token
    const tenantTokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: FEISHU_APP_ID,
        app_secret: FEISHU_APP_SECRET
      })
    });
    const tenantTokenData = await tenantTokenRes.json();
    if (tenantTokenData.code !== 0 || !tenantTokenData.tenant_access_token) {
      console.error('[飞书] 获取 tenant_access_token 失败:', tenantTokenData);
      return res.status(500).json({ error: '飞书认证失败：获取应用凭证失败' });
    }
    const tenantAccessToken = tenantTokenData.tenant_access_token;

    // 2. 用 code 换 user_access_token
    const userTokenRes = await fetch('https://open.feishu.cn/open-apis/authen/v1/oidc/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + tenantAccessToken
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: code
      })
    });
    const userTokenData = await userTokenRes.json();
    if (userTokenData.code !== 0 || !userTokenData.data?.access_token) {
      console.error('[飞书] 换取 user_access_token 失败:', userTokenData);
      return res.status(401).json({ error: '飞书认证失败：授权码无效或已过期' });
    }
    const userAccessToken = userTokenData.data.access_token;

    // 3. 获取用户信息
    const userInfoRes = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + userAccessToken }
    });
    const userInfoData = await userInfoRes.json();
    if (userInfoData.code !== 0 || !userInfoData.data) {
      console.error('[飞书] 获取用户信息失败:', userInfoData);
      return res.status(500).json({ error: '飞书认证失败：获取用户信息失败' });
    }

    const feishuUser = {
      name: userInfoData.data.name || '',
      mobile: userInfoData.data.mobile || '',
      email: userInfoData.data.email || '',
      openId: userInfoData.data.open_id || '',
      avatar: userInfoData.data.avatar_url || ''
    };

    console.log('[飞书] 免登用户:', feishuUser.name, feishuUser.mobile);

    // 4. 匹配系统角色
    const data = loadData();

    // 4.1 优先匹配管理员（手机号，标准化后比较）
    const feishuMobileNorm = normalizeMobile(feishuUser.mobile);
    const adminMobileNorm = normalizeMobile(data.settings.adminFeishuMobile);
    console.log('[飞书] 手机号匹配 - 飞书:', feishuUser.mobile, '->', feishuMobileNorm, '| 管理员:', data.settings.adminFeishuMobile, '->', adminMobileNorm);
    if (feishuMobileNorm && adminMobileNorm && feishuMobileNorm === adminMobileNorm) {
      const token = generateToken();
      sessions.set(token, { role: 'admin' });
      return res.json({
        token,
        role: 'admin',
        feishuUser
      });
    }

    // 4.2 匹配社团老师（优先手机号，其次姓名）
    if (feishuMobileNorm) {
      const clubByMobile = data.clubs.find(c => {
        const clubMobileNorm = normalizeMobile(c.feishuMobile);
        return clubMobileNorm && clubMobileNorm === feishuMobileNorm;
      });
      if (clubByMobile) {
        const token = generateToken();
        sessions.set(token, { role: 'teacher', clubId: clubByMobile.id });
        return res.json({
          token,
          role: 'teacher',
          clubId: clubByMobile.id,
          clubName: clubByMobile.name,
          feishuUser
        });
      }
    }

    // 4.3 手机号没匹配到，尝试按姓名匹配（仅当该社团没配手机号时）
    if (feishuUser.name) {
      const clubByName = data.clubs.find(c =>
        c.teacher && c.teacher === feishuUser.name &&
        (!c.feishuMobile || c.feishuMobile === '')
      );
      if (clubByName) {
        const token = generateToken();
        sessions.set(token, { role: 'teacher', clubId: clubByName.id });
        return res.json({
          token,
          role: 'teacher',
          clubId: clubByName.id,
          clubName: clubByName.name,
          feishuUser
        });
      }
    }

    // 4.4 都没匹配到，返回 needBind，前端提示联系管理员
    return res.json({
      needBind: true,
      feishuUser,
      message: '您还未绑定社团，请联系管理员在系统中设置您的手机号'
    });

  } catch (err) {
    console.error('[飞书] 免登异常:', err);
    return res.status(500).json({ error: '飞书认证异常：' + err.message });
  }
});

// ============ 需要权限的接口 ============

// 创建新社团（管理员）
app.post('/api/clubs', authMiddleware('admin'), (req, res) => {
  const data = loadData();
  const { name, teacher, pin } = req.body;
  if (!name) return res.status(400).json({ error: '社团名称不能为空' });
  const club = {
    id: 'club_' + crypto.randomBytes(6).toString('hex'),
    name,
    teacher: teacher || '',
    pin: pin || '1234',
    students: [],
    attendance: {}
  };
  data.clubs.push(club);
  saveData(data);
  broadcast({ type: 'club_created', clubId: club.id });
  res.json(club);
});

// 更新社团信息（管理员或本社团教师）
app.put('/api/clubs/:id', authMiddleware('teacher'), (req, res) => {
  if (!canEditClub(req.session, req.params.id)) {
    return res.status(403).json({ error: '无权修改此社团' });
  }
  const data = loadData();
  const club = data.clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: '社团不存在' });

  if (req.body.name !== undefined) club.name = req.body.name;
  if (req.body.teacher !== undefined) club.teacher = req.body.teacher;
  // 飞书免登：老师手机号（管理员或本社团教师都可设置）
  if (req.body.feishuMobile !== undefined) {
    club.feishuMobile = String(req.body.feishuMobile).trim();
  }
  // 只有管理员能改PIN
  if (req.body.pin !== undefined && req.session.role === 'admin') {
    club.pin = req.body.pin;
  }

  saveData(data);
  broadcast({ type: 'club_updated', clubId: club.id });
  res.json(club);
});

// 导入学生名单（管理员或本社团教师）
app.post('/api/clubs/:id/students', authMiddleware('teacher'), (req, res) => {
  if (!canEditClub(req.session, req.params.id)) {
    return res.status(403).json({ error: '无权修改此社团' });
  }
  const data = loadData();
  const club = data.clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: '社团不存在' });

  const { students } = req.body;
  if (students === undefined || students === null) {
    return res.status(400).json({ error: '缺少 students 字段，未做任何修改' });
  }
  let parsed = [];
  if (typeof students === 'string') {
    const lines = students.trim().split(/\n/).filter(l => l.trim());
    for (const line of lines) {
      const parts = line.trim().split(/[\s\t,，]+/).filter(p => p);
      if (parts.length >= 2) {
        parsed.push({ id: parts[0], name: parts.slice(1).join(' ') });
      } else if (parts.length === 1) {
        parsed.push({ id: parts[0], name: parts[0] });
      }
    }
  } else if (Array.isArray(students)) {
    parsed = students;
  } else {
    return res.status(400).json({ error: 'students 格式不正确，未做任何修改' });
  }

  club.students = parsed;
  saveData(data);
  broadcast({ type: 'students_updated', clubId: club.id });
  res.json({ success: true, count: parsed.length });
});

// 添加单个学生（管理员或本社团教师）
app.post('/api/clubs/:id/students/add', authMiddleware('teacher'), (req, res) => {
  if (!canEditClub(req.session, req.params.id)) {
    return res.status(403).json({ error: '无权修改此社团' });
  }
  const data = loadData();
  const club = data.clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: '社团不存在' });
  
  const { id, name } = req.body;
  if (!id || !name) return res.status(400).json({ error: '学号和姓名不能为空' });
  
  // 检查重复
  if (club.students.find(s => s.id === id)) {
    return res.status(400).json({ error: '该学号已存在' });
  }
  
  club.students.push({ id, name });
  saveData(data);
  broadcast({ type: 'students_updated', clubId: club.id });
  res.json({ success: true });
});

// 删除单个学生（管理员或本社团教师）
app.delete('/api/clubs/:id/students/:studentId', authMiddleware('teacher'), (req, res) => {
  if (!canEditClub(req.session, req.params.id)) {
    return res.status(403).json({ error: '无权修改此社团' });
  }
  const data = loadData();
  const club = data.clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: '社团不存在' });

  club.students = club.students.filter(s => s.id !== req.params.studentId);
  // 清除该学生的考勤记录
  if (club.attendance) {
    for (const date of Object.keys(club.attendance)) {
      delete club.attendance[date][req.params.studentId];
    }
  }
  saveData(data);
  broadcast({ type: 'students_updated', clubId: club.id });
  res.json({ success: true });
});

// 管理员：调换学生到其他社团
app.post('/api/clubs/:fromId/transfer/:studentId', authMiddleware('admin'), (req, res) => {
  const { toId } = req.body;
  const data = loadData();
  const fromClub = data.clubs.find(c => c.id === req.params.fromId);
  const toClub = data.clubs.find(c => c.id === toId);
  if (!fromClub) return res.status(404).json({ error: '源社团不存在' });
  if (!toClub) return res.status(404).json({ error: '目标社团不存在' });

  const student = fromClub.students.find(s => s.id === req.params.studentId);
  if (!student) return res.status(404).json({ error: '学生不存在' });

  // 检查目标社团是否已有该学生
  if (toClub.students.find(s => s.id === student.id)) {
    return res.status(400).json({ error: '目标社团已存在该学号' });
  }

  // 从源社团移除
  fromClub.students = fromClub.students.filter(s => s.id !== student.id);
  // 清除源社团考勤记录
  if (fromClub.attendance) {
    for (const date of Object.keys(fromClub.attendance)) {
      delete fromClub.attendance[date][student.id];
    }
  }
  // 添加到目标社团
  toClub.students.push(student);

  saveData(data);
  broadcast({ type: 'students_updated', clubId: fromClub.id });
  broadcast({ type: 'students_updated', clubId: toClub.id });
  res.json({ success: true });
});

// 更新考勤（管理员或本社团教师）
app.put('/api/clubs/:id/attendance/:date/:studentId', authMiddleware('teacher'), (req, res) => {
  if (!canEditClub(req.session, req.params.id)) {
    return res.status(403).json({ error: '无权修改此社团' });
  }
  const data = loadData();
  const club = data.clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: '社团不存在' });

  const { date, studentId } = req.params;
  const { status } = req.body;

  if (!club.attendance) club.attendance = {};
  if (!club.attendance[date]) club.attendance[date] = {};

  if (status === null) {
    delete club.attendance[date][studentId];
  } else {
    club.attendance[date][studentId] = status;
  }

  saveData(data);
  broadcast({ type: 'attendance_updated', clubId: club.id, date, studentId, status });
  res.json({ success: true });
});

// 批量更新考勤
app.put('/api/clubs/:id/attendance/:date', authMiddleware('teacher'), (req, res) => {
  if (!canEditClub(req.session, req.params.id)) {
    return res.status(403).json({ error: '无权修改此社团' });
  }
  const data = loadData();
  const club = data.clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: '社团不存在' });

  const { date } = req.params;
  const { records } = req.body;

  if (!club.attendance) club.attendance = {};
  club.attendance[date] = records;

  saveData(data);
  broadcast({ type: 'attendance_updated', clubId: club.id, date });
  res.json({ success: true });
});

// 删除社团（管理员）
app.delete('/api/clubs/:id', authMiddleware('admin'), (req, res) => {
  const data = loadData();
  const idx = data.clubs.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '社团不存在' });
  data.clubs.splice(idx, 1);
  saveData(data);
  broadcast({ type: 'club_deleted', clubId: req.params.id });
  res.json({ success: true });
});

// 删除某天考勤（管理员或本社团教师）
app.delete('/api/clubs/:id/attendance/:date', authMiddleware('teacher'), (req, res) => {
  if (!canEditClub(req.session, req.params.id)) {
    return res.status(403).json({ error: '无权修改此社团' });
  }
  const data = loadData();
  const club = data.clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: '社团不存在' });

  if (club.attendance && club.attendance[req.params.date]) {
    delete club.attendance[req.params.date];
    saveData(data);
    broadcast({ type: 'attendance_deleted', clubId: club.id, date: req.params.date });
  }
  res.json({ success: true });
});

// ============ 管理员专属接口 ============

// 管理员：获取仪表盘统计（支持按日期查询）
app.get('/api/admin/dashboard', authMiddleware('admin'), (req, res) => {
  const data = loadData();
  const clubs = data.clubs;
  const queryDate = req.query.date; // 可选日期参数 YYYY-MM-DD
  let totalStudents = 0;
  let totalAttendanceRecords = 0;
  let totalPresent = 0;
  let totalLate = 0;
  let totalAbsent = 0;
  const allDates = new Set();

  clubs.forEach(c => {
    totalStudents += (c.students || []).length;
    if (c.attendance) {
      Object.keys(c.attendance).forEach(date => {
        allDates.add(date);
        const records = c.attendance[date];
        Object.values(records).forEach(status => {
          totalAttendanceRecords++;
          if (status === 'present') totalPresent++;
          if (status === 'late') totalLate++;
          if (status === 'absent') totalAbsent++;
        });
      });
    }
  });

  const result = {
    clubCount: clubs.length,
    totalStudents,
    totalDates: allDates.size,
    dates: Array.from(allDates).sort().reverse(),
    totalAttendanceRecords,
    totalPresent,
    totalLate,
    totalAbsent,
    attendanceRate: totalAttendanceRecords > 0
      ? (((totalPresent + totalLate) / totalAttendanceRecords) * 100).toFixed(1)
      : '0.0'
  };

  // 如果指定了日期，返回该日期的详细统计
  if (queryDate) {
    let dateTotalStudents = 0, datePresent = 0, dateLate = 0, dateAbsent = 0, dateMarked = 0;
    const clubBreakdown = [];

    clubs.forEach(c => {
      const students = c.students || [];
      const records = (c.attendance || {})[queryDate] || {};
      let cPresent = 0, cLate = 0, cAbsent = 0;
      students.forEach(s => {
        const status = records[s.id];
        if (status === 'present') { cPresent++; datePresent++; }
        if (status === 'late') { cLate++; dateLate++; }
        if (status === 'absent') { cAbsent++; dateAbsent++; }
      });
      dateTotalStudents += students.length;
      dateMarked += cPresent + cLate + cAbsent;
      if (students.length > 0) {
        clubBreakdown.push({
          id: c.id,
          name: c.name,
          teacher: c.teacher || '',
          total: students.length,
          present: cPresent,
          late: cLate,
          absent: cAbsent,
          unchecked: students.length - cPresent - cLate - cAbsent
        });
      }
    });

    result.dateStats = {
      date: queryDate,
      totalStudents: dateTotalStudents,
      present: datePresent,
      late: dateLate,
      absent: dateAbsent,
      unchecked: dateTotalStudents - dateMarked,
      marked: dateMarked,
      attendanceRate: dateTotalStudents > 0
        ? ((datePresent + dateLate) / dateTotalStudents * 100).toFixed(1)
        : '0.0',
      clubBreakdown: clubBreakdown.sort((a, b) => b.present + b.late - a.present - a.late)
    };
  }

  res.json(result);
});

// 管理员：按日期和状态获取所有学生明细
app.get('/api/admin/attendance-detail', authMiddleware('admin'), (req, res) => {
  const data = loadData();
  const date = req.query.date;
  const status = req.query.status; // present | late | absent | unchecked | all

  if (!date) return res.status(400).json({ error: '缺少日期参数' });

  const statusTextMap = {
    present: '到勤',
    late: '迟到',
    absent: '缺席',
    unchecked: '未标记',
    all: '全部'
  };

  const students = [];
  data.clubs.forEach(c => {
    const records = (c.attendance || {})[date] || {};
    (c.students || []).forEach(s => {
      const sStatus = records[s.id] || null;
      let match = false;
      if (status === 'all') match = true;
      else if (status === 'unchecked') match = (sStatus === null);
      else match = (sStatus === status);

      if (match) {
        students.push({
          id: s.id,
          name: s.name,
          clubId: c.id,
          clubName: c.name,
          teacher: c.teacher || '',
          status: sStatus
        });
      }
    });
  });

  res.json({
    status: status,
    statusText: statusTextMap[status] || '全部',
    date: date,
    total: students.length,
    students: students
  });
});

// 管理员：批量导入社团和学生
app.post('/api/admin/bulk-import', authMiddleware('admin'), (req, res) => {
  const data = loadData();
  const { items } = req.body; // [{ clubName, teacher, feishuMobile, studentId, studentName }]

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: '数据为空' });
  }

  let createdClubs = 0, updatedClubs = 0, addedStudents = 0, skipped = 0;

  items.forEach(item => {
    if (!item.clubName || !item.studentId || !item.studentName) {
      skipped++;
      return;
    }
    // 按名称查找或创建社团
    let club = data.clubs.find(c => c.name === item.clubName);
    if (!club) {
      club = {
        id: 'club_' + crypto.randomBytes(6).toString('hex'),
        name: item.clubName,
        teacher: item.teacher || '',
        feishuMobile: item.feishuMobile || '',
        pin: '1234',
        students: [],
        attendance: {}
      };
      data.clubs.push(club);
      createdClubs++;
    } else {
      updatedClubs++;
      if (item.teacher && !club.teacher) club.teacher = item.teacher;
      // 飞书免登：老师手机号（仅当原社团未设置时才填充，避免覆盖已有的）
      if (item.feishuMobile && !club.feishuMobile) {
        club.feishuMobile = String(item.feishuMobile).trim();
      }
    }

    // 添加学生（避免重复）
    if (!club.students.find(s => s.id === item.studentId)) {
      club.students.push({ id: item.studentId, name: item.studentName });
      addedStudents++;
    } else {
      skipped++;
    }
  });

  saveData(data);
  broadcast({ type: 'bulk_imported' });
  res.json({ success: true, createdClubs, updatedClubs, addedStudents, skipped });
});

// 管理员：修改管理员密码
app.put('/api/admin/password', authMiddleware('admin'), (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: '密码至少4位' });
  }
  const data = loadData();
  data.settings.adminPassword = newPassword;
  saveData(data);
  res.json({ success: true });
});

// 管理员：修改系统设置
app.put('/api/admin/settings', authMiddleware('admin'), (req, res) => {
  const data = loadData();
  if (req.body.appName) data.settings.appName = req.body.appName;
  if (req.body.adminPassword) data.settings.adminPassword = req.body.adminPassword;
  // 飞书免登：管理员手机号
  if (req.body.adminFeishuMobile !== undefined) {
    data.settings.adminFeishuMobile = String(req.body.adminFeishuMobile).trim();
  }
  saveData(data);
  res.json({ success: true });
});

// ============ 导出接口 ============

function statusText(status) {
  if (status === 'present') return '到勤';
  if (status === 'late') return '迟到';
  if (status === 'absent') return '缺席';
  return '未记录';
}

// 导出单个社团考勤CSV
app.get('/api/clubs/:id/export', authMiddleware('teacher'), (req, res) => {
  if (!canEditClub(req.session, req.params.id)) {
    return res.status(403).json({ error: '无权导出此社团数据' });
  }
  const data = loadData();
  const club = data.clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: '社团不存在' });

  const dates = Object.keys(club.attendance || {}).sort();
  const students = club.students || [];

  // CSV with BOM for Excel Chinese support
  let csv = '\ufeff';
  csv += `社团名称,${club.name}\n`;
  csv += `指导老师,${club.teacher || ''}\n`;
  csv += `导出时间,${new Date().toLocaleString('zh-CN')}\n\n`;
  csv += '学号,姓名,' + dates.map(d => {
    const parts = d.split('-');
    return `${parts[1]}月${parts[2]}日`;
  }).join(',') + '\n';

  students.forEach(s => {
    const row = [s.id, s.name];
    dates.forEach(d => {
      const status = (club.attendance[d] || {})[s.id];
      row.push(statusText(status));
    });
    csv += row.join(',') + '\n';
  });

  // 统计行
  csv += '\n考勤统计\n';
  csv += '日期,' + dates.map(d => {
    const parts = d.split('-');
    return `${parts[1]}月${parts[2]}日`;
  }).join(',') + '\n';
  csv += '到勤,' + dates.map(d => {
    return Object.values(club.attendance[d] || {}).filter(s => s === 'present').length.toString();
  }).join(',') + '\n';
  csv += '迟到,' + dates.map(d => {
    return Object.values(club.attendance[d] || {}).filter(s => s === 'late').length.toString();
  }).join(',') + '\n';
  csv += '缺席,' + dates.map(d => {
    return Object.values(club.attendance[d] || {}).filter(s => s === 'absent').length.toString();
  }).join(',') + '\n';

  const filename = encodeURIComponent(`${club.name}_考勤报表_${new Date().toISOString().split('T')[0]}.csv`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  res.send(csv);
});

// 管理员：导出所有社团考勤CSV（一键导出）
app.get('/api/admin/export-all', authMiddleware('admin'), (req, res) => {
  const data = loadData();
  const clubs = data.clubs;

  // 收集所有日期
  const allDatesSet = new Set();
  clubs.forEach(c => {
    if (c.attendance) {
      Object.keys(c.attendance).forEach(d => allDatesSet.add(d));
    }
  });
  const allDates = Array.from(allDatesSet).sort();

  let csv = '\ufeff';
  csv += `清华附中初中社团管理系统 - 全部社团考勤汇总\n`;
  csv += `导出时间,${new Date().toLocaleString('zh-CN')}\n`;
  csv += `社团总数,${clubs.length}\n`;
  csv += `学生总数,${clubs.reduce((sum, c) => sum + (c.students || []).length, 0)}\n\n`;

  // 汇总表：社团,学号,姓名,各日期考勤
  const dateHeaders = allDates.map(d => {
    const parts = d.split('-');
    return `${parts[1]}月${parts[2]}日`;
  });
  csv += '社团名称,指导老师,学号,姓名,' + dateHeaders.join(',') + '\n';

  clubs.forEach(c => {
    const students = c.students || [];
    students.forEach(s => {
      const row = [c.name, c.teacher || '', s.id, s.name];
      allDates.forEach(d => {
        const status = (c.attendance || {})[d] || {};
        row.push(statusText(status[s.id]));
      });
      csv += row.join(',') + '\n';
    });
  });

  // 各社团考勤率统计
  csv += '\n各社团考勤率统计\n';
  csv += '社团名称,指导老师,学生人数,考勤次数,到勤人次,迟到人次,缺席人次,出勤率\n';
  clubs.forEach(c => {
    let present = 0, late = 0, absent = 0;
    let recordCount = 0;
    if (c.attendance) {
      Object.values(c.attendance).forEach(dayRecords => {
        Object.values(dayRecords).forEach(status => {
          recordCount++;
          if (status === 'present') present++;
          if (status === 'late') late++;
          if (status === 'absent') absent++;
        });
      });
    }
    const rate = recordCount > 0 ? (((present + late) / recordCount) * 100).toFixed(1) + '%' : '暂无数据';
    csv += `${c.name},${c.teacher || ''},${(c.students || []).length},${recordCount},${present},${late},${absent},${rate}\n`;
  });

  const filename = encodeURIComponent(`全部社团考勤汇总_${new Date().toISOString().split('T')[0]}.csv`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  res.send(csv);
});

// ============ 资源管理（教案/照片上传下载） ============

// 上传文件（教师或管理员）
app.post('/api/clubs/:clubId/upload', authMiddleware('teacher'), upload.single('file'), (req, res) => {
  if (!canEditClub(req.session, req.params.clubId)) {
    return res.status(403).json({ error: '无权上传' });
  }
  const type = req.query.type || 'photo';
  if (!['lesson', 'photo'].includes(type)) {
    return res.status(400).json({ error: '类型必须是 lesson 或 photo' });
  }
  if (!req.file) {
    return res.status(400).json({ error: '未接收到文件' });
  }

  const data = loadData();
  const club = data.clubs.find(c => c.id === req.params.clubId);
  if (!club) return res.status(404).json({ error: '社团不存在' });

  if (!club.files) club.files = [];
  const fileRecord = {
    id: 'file_' + crypto.randomBytes(6).toString('hex'),
    type: type,
    filename: req.file.filename,
    originalName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
    uploadDate: new Date().toISOString(),
    size: req.file.size
  };
  club.files.push(fileRecord);
  saveData(data);
  broadcast({ type: 'files_updated', clubId: club.id });
  res.json({ success: true, file: fileRecord });
});

// 获取社团文件列表（教师或管理员）
app.get('/api/clubs/:clubId/files', authMiddleware('teacher'), (req, res) => {
  if (!canEditClub(req.session, req.params.clubId)) {
    return res.status(403).json({ error: '无权查看' });
  }
  const data = loadData();
  const club = data.clubs.find(c => c.id === req.params.clubId);
  if (!club) return res.status(404).json({ error: '社团不存在' });
  res.json(club.files || []);
});

// 下载单个文件（教师或管理员）
app.get('/api/clubs/:clubId/files/:fileId/download', authMiddleware('teacher'), (req, res) => {
  if (!canEditClub(req.session, req.params.clubId)) {
    return res.status(403).json({ error: '无权下载' });
  }
  const data = loadData();
  const club = data.clubs.find(c => c.id === req.params.clubId);
  if (!club || !club.files) return res.status(404).json({ error: '文件不存在' });
  const file = club.files.find(f => f.id === req.params.fileId);
  if (!file) return res.status(404).json({ error: '文件不存在' });

  const filePath = path.join(UPLOAD_DIR, req.params.clubId, file.type === 'lesson' ? 'lessons' : 'photos', file.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在，可能已被清理' });

  const filename = encodeURIComponent(file.originalName);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(filePath).pipe(res);
});

// 删除文件（教师或管理员）
app.delete('/api/clubs/:clubId/files/:fileId', authMiddleware('teacher'), (req, res) => {
  if (!canEditClub(req.session, req.params.clubId)) {
    return res.status(403).json({ error: '无权删除' });
  }
  const data = loadData();
  const club = data.clubs.find(c => c.id === req.params.clubId);
  if (!club || !club.files) return res.status(404).json({ error: '文件不存在' });

  const fileIdx = club.files.findIndex(f => f.id === req.params.fileId);
  if (fileIdx === -1) return res.status(404).json({ error: '文件不存在' });

  const file = club.files[fileIdx];
  // 删除物理文件
  const filePath = path.join(UPLOAD_DIR, req.params.clubId, file.type === 'lesson' ? 'lessons' : 'photos', file.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  // 从数据中移除
  club.files.splice(fileIdx, 1);
  saveData(data);
  broadcast({ type: 'files_updated', clubId: club.id });
  res.json({ success: true });
});

// 管理员：批量下载资源（zip按社团分类）
app.get('/api/admin/download/:type', authMiddleware('admin'), (req, res) => {
  const downloadType = req.params.type; // all, lessons, photos
  if (!['all', 'lessons', 'photos'].includes(downloadType)) {
    return res.status(400).json({ error: '无效的下载类型' });
  }

  const data = loadData();
  const dateStr = new Date().toISOString().split('T')[0];
  let zipName;
  if (downloadType === 'all') zipName = `全部社团资源_${dateStr}.zip`;
  else if (downloadType === 'lessons') zipName = `全部教案_${dateStr}.zip`;
  else zipName = `全部照片_${dateStr}.zip`;

  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.on('error', (err) => {
    console.error('Archive error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: '打包失败' });
    }
    archive.abort();
  });
  const filename = encodeURIComponent(zipName);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  archive.pipe(res);

  let fileCount = 0;
  data.clubs.forEach(club => {
    if (!club.files || club.files.length === 0) return;
    const clubFolder = `${club.name}_${club.teacher || '未设置老师'}`;

    club.files.forEach(file => {
      if (downloadType === 'lessons' && file.type !== 'lesson') return;
      if (downloadType === 'photos' && file.type !== 'photo') return;

      const filePath = path.join(UPLOAD_DIR, club.id, file.type === 'lesson' ? 'lessons' : 'photos', file.filename);
      if (fs.existsSync(filePath)) {
        let zipPath;
        if (downloadType === 'all') {
          const subfolder = file.type === 'lesson' ? '教案' : '照片';
          zipPath = `${clubFolder}/${subfolder}/${file.originalName}`;
        } else {
          zipPath = `${clubFolder}/${file.originalName}`;
        }
        archive.file(filePath, { name: zipPath });
        fileCount++;
      }
    });
  });

  archive.finalize();
});

// 管理员：下载单个社团全部资源
app.get('/api/admin/download/club/:clubId', authMiddleware('admin'), (req, res) => {
  const data = loadData();
  const club = data.clubs.find(c => c.id === req.params.clubId);
  if (!club) return res.status(404).json({ error: '社团不存在' });

  const dateStr = new Date().toISOString().split('T')[0];
  const zipName = `${club.name}_资源_${dateStr}.zip`;
  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.on('error', (err) => {
    console.error('Archive error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: '打包失败' });
    }
    archive.abort();
  });
  const filename = encodeURIComponent(zipName);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  archive.pipe(res);

  if (club.files) {
    club.files.forEach(file => {
      const filePath = path.join(UPLOAD_DIR, club.id, file.type === 'lesson' ? 'lessons' : 'photos', file.filename);
      if (fs.existsSync(filePath)) {
        const subfolder = file.type === 'lesson' ? '教案' : '照片';
        archive.file(filePath, { name: `${subfolder}/${file.originalName}` });
      }
    });
  }

  archive.finalize();
});

// ============ 数据备份与恢复（管理员） ============
// 列出所有备份
app.get('/api/admin/backups', authMiddleware('admin'), (req, res) => {
  res.json({ backups: listBackups(), backupDir: BACKUP_DIR });
});

// 立即手动备份一次
app.post('/api/admin/backup-now', authMiddleware('admin'), (req, res) => {
  backupData(false);
  res.json({ success: true, count: listBackups().length });
});

// 从指定备份恢复
app.post('/api/admin/restore', authMiddleware('admin'), (req, res) => {
  const { file } = req.body || {};
  if (!file) return res.status(400).json({ error: '请指定备份文件' });
  const ok = restoreFromBackup(file);
  if (ok) {
    broadcast({ type: 'data_restored' });
    res.json({ success: true, restored: file });
  } else {
    res.status(400).json({ error: '恢复失败：备份不存在或已损坏' });
  }
});

// SPA 回退
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`清华附中社团管理系统已启动: http://localhost:${PORT}`);
  console.log(`管理员默认密码: admin123`);
  console.log(`飞书免登: ${FEISHU_ENABLED ? '已启用 (App ID: ' + FEISHU_APP_ID + ')' : '未启用（配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 后启用）'}`);
  // 启动自检：data.json 损坏则自动从最新备份恢复
  startupIntegrityCheck();
  // 启动后不久做一份初始备份，确保随时有副本
  setTimeout(() => backupData(true), 5000);
  // 每日自动备份（每 24 小时）
  setInterval(backupData, 24 * 60 * 60 * 1000);
});
