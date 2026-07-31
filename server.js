const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ 数据存储 ============
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (e) {
    return { settings: { appName: '清华附中初中社团考勤管理系统', adminPassword: 'admin123' }, clubs: [] };
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
        appName: '清华附中初中社团考勤管理系统',
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
      data.settings = { appName: '清华附中初中社团考勤管理系统', adminPassword: 'admin123' };
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
    const token = req.headers.authorization?.replace('Bearer ', '');
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
    attendanceDates: Object.keys(c.attendance || {}).sort().reverse()
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

// 管理员：获取仪表盘统计
app.get('/api/admin/dashboard', authMiddleware('admin'), (req, res) => {
  const data = loadData();
  const clubs = data.clubs;
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

  res.json({
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
  });
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
  csv += `清华附中初中社团考勤管理系统 - 全部社团考勤汇总\n`;
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

// SPA 回退
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`清华附中社团考勤管理系统已启动: http://localhost:${PORT}`);
  console.log(`管理员默认密码: admin123`);
});
