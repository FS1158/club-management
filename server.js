const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ 数据存储 ============
const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

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
      saveData(data);
    }
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
  res.json({ token, role: 'admin' });
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
    pin: pin || '0000',
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
  const { items } = req.body; // [{ clubName, teacher, studentId, studentName }]

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
        pin: String(Math.floor(1000 + Math.random() * 9000)),
        students: [],
        attendance: {}
      };
      data.clubs.push(club);
      createdClubs++;
    } else {
      updatedClubs++;
      if (item.teacher && !club.teacher) club.teacher = item.teacher;
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

// 管理员：修改系统名称
app.put('/api/admin/settings', authMiddleware('admin'), (req, res) => {
  const data = loadData();
  if (req.body.appName) data.settings.appName = req.body.appName;
  if (req.body.adminPassword) data.settings.adminPassword = req.body.adminPassword;
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

// SPA 回退
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`清华附中社团管理系统已启动: http://localhost:${PORT}`);
  console.log(`管理员默认密码: admin123`);
});
