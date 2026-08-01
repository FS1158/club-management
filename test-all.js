// ========================================
// 清华附中初中社团管理系统 - 全功能测试脚本
// ========================================
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3000';
let passCount = 0;
let failCount = 0;
let testResults = [];

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const data = body ? JSON.stringify(body) : null;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = http.request({ hostname: 'localhost', port: 3000, path: urlPath, method, headers }, (res) => {
      let chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch(e) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json, buffer: buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function multipartRequest(urlPath, fieldName, filePath, token) {
  return new Promise((resolve, reject) => {
    const boundary = '----TestBoundary' + Math.random().toString(16).slice(2);
    const fileBuffer = fs.readFileSync(filePath);
    const originalName = path.basename(filePath);
    
    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${originalName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const headers = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const req = http.request({ hostname: 'localhost', port: 3000, path: urlPath, method: 'POST', headers }, (res) => {
      let chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch(e) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function assert(name, condition, detail) {
  if (condition) {
    passCount++;
    testResults.push({ name, status: 'PASS', detail: detail || '' });
    console.log(`  ✓ ${name}`);
  } else {
    failCount++;
    testResults.push({ name, status: 'FAIL', detail: detail || '' });
    console.log(`  ✗ ${name} — ${detail || ''}`);
  }
}

async function runTests() {
  console.log('\n========================================');
  console.log('  清华附中初中社团管理系统 - 全功能测试');
  console.log('========================================\n');

  let adminToken = '';
  let teacherToken = '';
  let testClubId = '';
  let testStudentId = '';
  let testFileId = '';
  let testDate = '2026-08-01';

  // ===== 1. 公开接口 =====
  console.log('【1. 公开接口】');

  // 1.1 获取系统设置
  let res = await request('GET', '/api/settings');
  assert('获取系统设置', res.status === 200 && res.json && res.json.appName, `status=${res.status}, appName=${res.json?.appName}`);

  // 1.2 获取社团列表
  res = await request('GET', '/api/clubs');
  assert('获取社团列表', res.status === 200 && Array.isArray(res.json), `status=${res.status}, count=${res.json?.length}`);
  const initialClubCount = res.json ? res.json.length : 0;
  const demo1Id = res.json && res.json[0] ? res.json[0].id : '';

  // 1.3 获取单个社团详情
  if (demo1Id) {
    res = await request('GET', '/api/clubs/' + demo1Id);
    assert('获取社团详情', res.status === 200 && res.json && res.json.id === demo1Id, `status=${res.status}, name=${res.json?.name}`);
  }

  // 1.4 获取不存在的社团
  res = await request('GET', '/api/clubs/nonexistent123');
  assert('获取不存在的社团返回404', res.status === 404, `status=${res.status}`);

  // 1.5 搜索学生
  res = await request('GET', '/api/search/students?q=' + encodeURIComponent('张'));
  assert('搜索学生(姓名)', res.status === 200 && res.json && res.json.total !== undefined, `status=${res.status}, total=${res.json?.total}`);

  // 1.6 搜索学生(学号)
  res = await request('GET', '/api/search/students?q=' + encodeURIComponent('2024'));
  assert('搜索学生(学号)', res.status === 200 && res.json && res.json.total !== undefined, `status=${res.status}, total=${res.json?.total}`);

  // 1.7 空关键词搜索
  res = await request('GET', '/api/search/students?q=');
  assert('空关键词搜索返回空结果', res.status === 200 && res.json && res.json.results.length === 0, `status=${res.status}`);

  // 1.8 SSE 连接
  const sseRes = await new Promise((resolve) => {
    const req = http.request({ hostname: 'localhost', port: 3000, path: '/api/events', method: 'GET' }, (res) => {
      let data = '';
      res.on('data', d => {
        data += d.toString();
        if (data.includes('connected')) {
          res.destroy();
          resolve({ connected: true });
        }
      });
      setTimeout(() => { res.destroy(); resolve({ connected: data.includes('connected') }); }, 2000);
    });
    req.on('error', () => resolve({ connected: false }));
    req.end();
  });
  assert('SSE实时推送连接', sseRes.connected, `connected=${sseRes.connected}`);

  // ===== 2. 认证系统 =====
  console.log('\n【2. 认证系统】');

  // 2.1 管理员正确密码登录
  res = await request('POST', '/api/login/admin', { password: 'admin123' });
  assert('管理员正确密码登录', res.status === 200 && res.json && res.json.token, `status=${res.status}`);
  if (res.json && res.json.token) adminToken = res.json.token;

  // 2.2 管理员错误密码登录
  res = await request('POST', '/api/login/admin', { password: 'wrongpassword' });
  assert('管理员错误密码被拒绝', res.status === 401, `status=${res.status}`);

  // 2.3 管理员空密码登录
  res = await request('POST', '/api/login/admin', { password: '' });
  assert('管理员空密码被拒绝', res.status === 401, `status=${res.status}`);

  // 2.4 教师正确PIN登录
  if (demo1Id) {
    res = await request('POST', '/api/login/teacher', { clubId: demo1Id, pin: '1234' });
    assert('教师正确PIN登录', res.status === 200 && res.json && res.json.token, `status=${res.status}`);
    if (res.json && res.json.token) teacherToken = res.json.token;

    // 2.5 教师错误PIN登录
    res = await request('POST', '/api/login/teacher', { clubId: demo1Id, pin: '9999' });
    assert('教师错误PIN被拒绝', res.status === 401, `status=${res.status}`);

    // 2.6 教师登录不存在的社团
    res = await request('POST', '/api/login/teacher', { clubId: 'nonexistent', pin: '1234' });
    assert('教师登录不存在社团返回404', res.status === 404, `status=${res.status}`);
  }

  // 2.7 Token验证
  if (adminToken) {
    res = await request('GET', '/api/auth/check', null, adminToken);
    assert('Token有效性验证', res.status === 200 && res.json && res.json.valid === true, `status=${res.status}`);
  }

  // 2.8 无效Token验证
  res = await request('GET', '/api/auth/check', null, 'invalidtoken123');
  assert('无效Token被拒绝', res.status === 401, `status=${res.status}`);

  // 2.9 无Token访问管理员接口
  res = await request('GET', '/api/admin/dashboard');
  assert('无Token访问管理员接口被拒绝', res.status === 401, `status=${res.status}`);

  // 2.10 教师Token访问管理员接口
  if (teacherToken) {
    res = await request('GET', '/api/admin/dashboard', null, teacherToken);
    assert('教师Token不能访问管理员接口', res.status === 403, `status=${res.status}`);
  }

  // ===== 3. 社团管理 =====
  console.log('\n【3. 社团管理】');

  // 3.1 创建新社团
  res = await request('POST', '/api/clubs', { name: '测试社团_自动', teacher: '测试老师', pin: '8888' }, adminToken);
  assert('创建新社团', res.status === 200 && res.json && res.json.id, `status=${res.status}, id=${res.json?.id}`);
  if (res.json && res.json.id) {
    testClubId = res.json.id;
    testStudentId = '';
  }

  // 3.2 创建社团(空名称)
  res = await request('POST', '/api/clubs', { name: '', teacher: '', pin: '' }, adminToken);
  assert('创建社团(空名称)被拒绝', res.status === 400, `status=${res.status}`);

  // 3.3 更新社团信息
  if (testClubId) {
    res = await request('PUT', '/api/clubs/' + testClubId, { name: '测试社团_已改名', teacher: '改后老师', pin: '9999' }, adminToken);
    assert('更新社团信息', res.status === 200 && res.json && res.json.name === '测试社团_已改名', `status=${res.status}, name=${res.json?.name}`);

    // 3.4 教师更新社团(非本社团)
    if (teacherToken && demo1Id) {
      res = await request('PUT', '/api/clubs/' + testClubId, { name: '不该改的' }, teacherToken);
      assert('教师不能修改非本社团', res.status === 403, `status=${res.status}`);
    }

    // 3.5 教师修改自己社团(不含PIN)
    if (teacherToken && demo1Id) {
      res = await request('PUT', '/api/clubs/' + demo1Id, { name: '篮球社（示例）', teacher: '张老师' }, teacherToken);
      assert('教师修改自己社团信息', res.status === 200, `status=${res.status}`);
    }
  }

  // ===== 4. 学生管理 =====
  console.log('\n【4. 学生管理】');

  if (testClubId) {
    // 4.1 导入学生名单(文本格式)
    res = await request('POST', `/api/clubs/${testClubId}/students`, { students: 'T001 测试学生A\nT002 测试学生B\nT003 测试学生C' }, adminToken);
    assert('导入学生名单(文本)', res.status === 200 && res.json && res.json.count === 3, `status=${res.status}, count=${res.json?.count}`);

    // 4.2 导入学生名单(数组格式)
    res = await request('POST', `/api/clubs/${testClubId}/students`, { students: [{ id: 'T004', name: '测试学生D' }, { id: 'T005', name: '测试学生E' }] }, adminToken);
    assert('导入学生名单(数组)', res.status === 200 && res.json && res.json.count === 2, `status=${res.status}, count=${res.json?.count}`);

    // 4.3 添加单个学生
    res = await request('POST', `/api/clubs/${testClubId}/students/add`, { id: 'T006', name: '测试学生F' }, adminToken);
    assert('添加单个学生', res.status === 200 && res.json && res.json.success, `status=${res.status}`);

    // 4.4 添加重复学号学生
    res = await request('POST', `/api/clubs/${testClubId}/students/add`, { id: 'T006', name: '重复学生' }, adminToken);
    assert('添加重复学号被拒绝', res.status === 400, `status=${res.status}`);

    // 4.5 添加空学号学生
    res = await request('POST', `/api/clubs/${testClubId}/students/add`, { id: '', name: '空学号' }, adminToken);
    assert('添加空学号被拒绝', res.status === 400, `status=${res.status}`);

    // 4.6 删除单个学生
    res = await request('DELETE', `/api/clubs/${testClubId}/students/T006`, null, adminToken);
    assert('删除单个学生', res.status === 200 && res.json && res.json.success, `status=${res.status}`);

    // 4.7 验证删除后学生列表
    res = await request('GET', `/api/clubs/${testClubId}`);
    const hasT006 = res.json && res.json.students ? res.json.students.find(s => s.id === 'T006') : true;
    assert('删除后学生不在列表中', !hasT006, `T006 still exists=${!!hasT006}`);

    testStudentId = 'T004';
  }

  // ===== 5. 学生调换 =====
  console.log('\n【5. 学生调换】');

  if (testClubId && demo1Id && adminToken) {
    // 5.1 调换学生到另一社团
    res = await request('POST', `/api/clubs/${testClubId}/transfer/T004`, { toId: demo1Id }, adminToken);
    assert('调换学生到另一社团', res.status === 200 && res.json && res.json.success, `status=${res.status}`);

    // 5.2 验证源社团已移除
    res = await request('GET', `/api/clubs/${testClubId}`);
    const stillInSource = res.json && res.json.students ? res.json.students.find(s => s.id === 'T004') : false;
    assert('调换后源社团无该学生', !stillInSource, `still in source=${!!stillInSource}`);

    // 5.3 验证目标社团已添加
    res = await request('GET', `/api/clubs/${demo1Id}`);
    const inTarget = res.json && res.json.students ? res.json.students.find(s => s.id === 'T004') : false;
    assert('调换后目标社团有该学生', !!inTarget, `in target=${!!inTarget}`);

    // 5.4 调换到不存在的社团
    res = await request('POST', `/api/clubs/${testClubId}/transfer/T005`, { toId: 'nonexistent' }, adminToken);
    assert('调换到不存在社团返回404', res.status === 404, `status=${res.status}`);
  }

  // ===== 6. 考勤管理 =====
  console.log('\n【6. 考勤管理】');

  if (testClubId && adminToken) {
    // 6.1 批量设置考勤(创建日期)
    res = await request('PUT', `/api/clubs/${testClubId}/attendance/${testDate}`, { records: { 'T002': 'present', 'T003': 'late', 'T004': 'absent' } }, adminToken);
    assert('批量设置考勤', res.status === 200 && res.json && res.json.success, `status=${res.status}`);

    // 6.2 单个学生考勤标记
    res = await request('PUT', `/api/clubs/${testClubId}/attendance/${testDate}/T005`, { status: 'present' }, adminToken);
    assert('单个学生考勤标记', res.status === 200 && res.json && res.json.success, `status=${res.status}`);

    // 6.3 验证考勤记录
    res = await request('GET', `/api/clubs/${testClubId}`);
    const attRecords = res.json && res.json.attendance ? res.json.attendance[testDate] : null;
    assert('验证考勤记录存在', attRecords && attRecords.T002 === 'present' && attRecords.T005 === 'present', `T002=${attRecords?.T002}, T005=${attRecords?.T005}`);

    // 6.4 取消考勤标记(status=null)
    res = await request('PUT', `/api/clubs/${testClubId}/attendance/${testDate}/T005`, { status: null }, adminToken);
    assert('取消考勤标记', res.status === 200, `status=${res.status}`);
    res = await request('GET', `/api/clubs/${testClubId}`);
    const t005AfterCancel = res.json && res.json.attendance && res.json.attendance[testDate] ? res.json.attendance[testDate].T005 : 'EXISTS';
    assert('验证取消后记录已删除', t005AfterCancel === undefined, `T005=${t005AfterCancel}`);

    // 6.5 教师修改非本社团考勤
    if (teacherToken) {
      res = await request('PUT', `/api/clubs/${testClubId}/attendance/${testDate}/T002`, { status: 'absent' }, teacherToken);
      assert('教师不能修改非本社团考勤', res.status === 403, `status=${res.status}`);
    }

    // 6.6 删除某天考勤
    res = await request('DELETE', `/api/clubs/${testClubId}/attendance/${testDate}`, null, adminToken);
    assert('删除某天考勤记录', res.status === 200 && res.json && res.json.success, `status=${res.status}`);

    // 6.7 验证考勤已删除
    res = await request('GET', `/api/clubs/${testClubId}`);
    const attAfterDelete = res.json && res.json.attendance ? res.json.attendance[testDate] : null;
    assert('验证考勤已删除', !attAfterDelete, `attendance[${testDate}] still exists=${!!attAfterDelete}`);

    // 重新设置考勤用于后续测试
    await request('PUT', `/api/clubs/${testClubId}/attendance/${testDate}`, { records: { 'T002': 'present', 'T003': 'present', 'T004': 'absent' } }, adminToken);
  }

  // ===== 7. 仪表盘 =====
  console.log('\n【7. 仪表盘统计】');

  if (adminToken) {
    // 7.1 仪表盘总览
    res = await request('GET', '/api/admin/dashboard', null, adminToken);
    assert('仪表盘总览', res.status === 200 && res.json && res.json.clubCount !== undefined, `status=${res.status}, clubs=${res.json?.clubCount}`);

    // 7.2 仪表盘按日期查询
    res = await request('GET', `/api/admin/dashboard?date=${testDate}`, null, adminToken);
    assert('仪表盘按日期查询', res.status === 200 && res.json && res.json.dateStats, `status=${res.status}, hasDateStats=${!!res.json?.dateStats}`);

    // 7.3 仪表盘日期统计含社团明细
    if (res.json && res.json.dateStats) {
      const ds = res.json.dateStats;
      assert('日期统计含汇总数据', ds.totalStudents !== undefined && ds.present !== undefined && ds.late !== undefined && ds.absent !== undefined, `total=${ds.totalStudents}, present=${ds.present}`);
      assert('日期统计含社团明细', Array.isArray(ds.clubBreakdown), `clubBreakdown count=${ds.clubBreakdown?.length}`);
    }

    // 7.4 出勤明细API - 全部
    res = await request('GET', `/api/admin/attendance-detail?date=${testDate}&status=all`, null, adminToken);
    assert('出勤明细(全部)', res.status === 200 && res.json && res.json.students, `status=${res.status}, total=${res.json?.total}`);

    // 7.5 出勤明细API - 到勤
    res = await request('GET', `/api/admin/attendance-detail?date=${testDate}&status=present`, null, adminToken);
    assert('出勤明细(到勤)', res.status === 200 && res.json && res.json.statusText === '到勤', `status=${res.status}, total=${res.json?.total}`);

    // 7.6 出勤明细API - 迟到
    res = await request('GET', `/api/admin/attendance-detail?date=${testDate}&status=late`, null, adminToken);
    assert('出勤明细(迟到)', res.status === 200, `status=${res.status}`);

    // 7.7 出勤明细API - 缺席
    res = await request('GET', `/api/admin/attendance-detail?date=${testDate}&status=absent`, null, adminToken);
    assert('出勤明细(缺席)', res.status === 200, `status=${res.status}`);

    // 7.8 出勤明细API - 未标记
    res = await request('GET', `/api/admin/attendance-detail?date=${testDate}&status=unchecked`, null, adminToken);
    assert('出勤明细(未标记)', res.status === 200, `status=${res.status}`);

    // 7.9 出勤明细API - 缺少日期参数
    res = await request('GET', '/api/admin/attendance-detail?status=present', null, adminToken);
    assert('出勤明细(缺少日期)返回400', res.status === 400, `status=${res.status}`);
  }

  // ===== 8. 批量导入 =====
  console.log('\n【8. 批量导入】');

  if (adminToken) {
    // 8.1 批量导入(含新社团)
    res = await request('POST', '/api/admin/bulk-import', { items: [
      { clubName: '批量导入社团A', teacher: 'A老师', studentId: 'B001', studentName: '批量学生1' },
      { clubName: '批量导入社团A', teacher: 'A老师', studentId: 'B002', studentName: '批量学生2' },
      { clubName: '批量导入社团B', teacher: 'B老师', studentId: 'B003', studentName: '批量学生3' }
    ]}, adminToken);
    assert('批量导入(含新社团)', res.status === 200 && res.json && res.json.success && res.json.createdClubs >= 2, `status=${res.status}, created=${res.json?.createdClubs}, added=${res.json?.addedStudents}`);

    // 8.2 批量导入(重复学生跳过)
    res = await request('POST', '/api/admin/bulk-import', { items: [
      { clubName: '批量导入社团A', teacher: 'A老师', studentId: 'B001', studentName: '重复学生' }
    ]}, adminToken);
    assert('批量导入(重复跳过)', res.status === 200 && res.json && res.json.skipped >= 1, `status=${res.status}, skipped=${res.json?.skipped}`);

    // 8.3 批量导入(空数据)
    res = await request('POST', '/api/admin/bulk-import', { items: [] }, adminToken);
    assert('批量导入(空数据)被拒绝', res.status === 400, `status=${res.status}`);
  }

  // ===== 9. 密码修改 =====
  console.log('\n【9. 密码修改】');

  if (adminToken) {
    // 9.1 修改密码(过短)
    res = await request('PUT', '/api/admin/password', { newPassword: 'ab' }, adminToken);
    assert('修改密码(过短)被拒绝', res.status === 400, `status=${res.status}`);

    // 9.2 修改密码(正常)
    res = await request('PUT', '/api/admin/password', { newPassword: 'admin123' }, adminToken);
    assert('修改密码(正常)', res.status === 200 && res.json && res.json.success, `status=${res.status}`);

    // 9.3 用新密码登录验证
    res = await request('POST', '/api/login/admin', { password: 'admin123' });
    assert('新密码登录验证', res.status === 200 && res.json && res.json.token, `status=${res.status}`);
  }

  // ===== 10. 导出功能 =====
  console.log('\n【10. 导出功能】');

  if (adminToken && testClubId) {
    // 10.1 导出单个社团CSV
    res = await request('GET', `/api/clubs/${testClubId}/export`, null, adminToken);
    assert('导出单个社团CSV', res.status === 200 && res.headers['content-type'] && res.headers['content-type'].includes('csv'), `status=${res.status}, type=${res.headers['content-type']}`);
    const csvHasBOM = res.text && res.text.startsWith('\ufeff');
    assert('CSV含BOM(Excel中文兼容)', csvHasBOM, `BOM=${csvHasBOM}`);

    // 10.2 导出所有社团CSV
    res = await request('GET', '/api/admin/export-all', null, adminToken);
    assert('导出所有社团CSV', res.status === 200 && res.headers['content-type'] && res.headers['content-type'].includes('csv'), `status=${res.status}, type=${res.headers['content-type']}`);

    // 10.3 导出含社团名
    const csvContent = res.text || '';
    assert('CSV内容含社团名', csvContent.includes('社团') || csvContent.includes('名称'), `content length=${csvContent.length}`);

    // 10.4 教师导出非本社团
    if (teacherToken) {
      res = await request('GET', `/api/clubs/${testClubId}/export`, null, teacherToken);
      assert('教师不能导出非本社团', res.status === 403, `status=${res.status}`);
    }
  }

  // ===== 11. 文件上传下载 =====
  console.log('\n【11. 文件上传下载】');

  // 创建测试文件
  const testLessonFile = path.join(__dirname, 'test_lesson.txt');
  const testPhotoFile = path.join(__dirname, 'test_photo.jpg');
  fs.writeFileSync(testLessonFile, 'This is a test lesson file content.');
  // 创建一个简单的假JPG文件
  const fakeJpgBuffer = Buffer.alloc(1024, 0xFF);
  fakeJpgBuffer[0] = 0xFF; fakeJpgBuffer[1] = 0xD8; fakeJpgBuffer[2] = 0xFF;
  fs.writeFileSync(testPhotoFile, fakeJpgBuffer);

  if (testClubId && adminToken) {
    // 11.1 上传教案
    res = await multipartRequest(`/api/clubs/${testClubId}/upload?type=lesson`, 'file', testLessonFile, adminToken);
    assert('上传教案文件', res.status === 200 && res.json && res.json.success, `status=${res.status}, error=${res.json?.error}`);
    if (res.json && res.json.file) {
      testFileId = res.json.file.id;
      assert('教案文件记录正确', res.json.file.type === 'lesson' && res.json.file.originalName === 'test_lesson.txt', `type=${res.json.file.type}, name=${res.json.file.originalName}`);
    }

    // 11.2 上传照片
    res = await multipartRequest(`/api/clubs/${testClubId}/upload?type=photo`, 'file', testPhotoFile, adminToken);
    assert('上传照片文件', res.status === 200 && res.json && res.json.success, `status=${res.status}, error=${res.json?.error}`);
    const photoFileId = res.json && res.json.file ? res.json.file.id : '';

    // 11.3 上传非法类型
    res = await multipartRequest(`/api/clubs/${testClubId}/upload?type=invalid`, 'file', testLessonFile, adminToken);
    assert('上传非法类型被拒绝', res.status === 400, `status=${res.status}`);

    // 11.4 获取文件列表
    res = await request('GET', `/api/clubs/${testClubId}/files`, null, adminToken);
    assert('获取文件列表', res.status === 200 && Array.isArray(res.json) && res.json.length >= 2, `status=${res.status}, count=${res.json?.length}`);

    // 11.5 下载文件
    if (testFileId) {
      res = await request('GET', `/api/clubs/${testClubId}/files/${testFileId}/download`, null, adminToken);
      assert('下载文件', res.status === 200 && res.text === 'This is a test lesson file content.', `status=${res.status}, content match=${res.text === 'This is a test lesson file content.'}`);
    }

    // 11.6 下载不存在的文件
    res = await request('GET', `/api/clubs/${testClubId}/files/nonexistent/download`, null, adminToken);
    assert('下载不存在文件返回404', res.status === 404, `status=${res.status}`);

    // 11.7 删除文件
    if (photoFileId) {
      res = await request('DELETE', `/api/clubs/${testClubId}/files/${photoFileId}`, null, adminToken);
      assert('删除文件', res.status === 200 && res.json && res.json.success, `status=${res.status}`);

      // 11.8 验证文件已删除
      res = await request('GET', `/api/clubs/${testClubId}/files`, null, adminToken);
      const stillExists = res.json ? res.json.find(f => f.id === photoFileId) : true;
      assert('验证文件已从列表移除', !stillExists, `still exists=${!!stillExists}`);
    }

    // 11.9 无权限上传
    if (teacherToken && demo1Id) {
      res = await multipartRequest(`/api/clubs/${testClubId}/upload?type=lesson`, 'file', testLessonFile, teacherToken);
      assert('教师不能上传到非本社团', res.status === 403, `status=${res.status}`);
    }
  }

  // ===== 12. 批量资源下载(ZIP) =====
  console.log('\n【12. 批量资源下载】');

  if (adminToken) {
    // 12.1 下载全部资源ZIP
    res = await request('GET', '/api/admin/download/all?token=' + adminToken);
    assert('下载全部资源ZIP', res.status === 200 && res.headers['content-type'] === 'application/zip', `status=${res.status}, type=${res.headers['content-type']}`);
    const allZipSize = res.buffer ? res.buffer.length : 0;
    assert('ZIP文件有内容', allZipSize > 0, `size=${allZipSize}`);

    // 12.2 下载全部教案ZIP
    res = await request('GET', '/api/admin/download/lessons?token=' + adminToken);
    assert('下载全部教案ZIP', res.status === 200 && res.headers['content-type'] === 'application/zip', `status=${res.status}`);

    // 12.3 下载全部照片ZIP
    res = await request('GET', '/api/admin/download/photos?token=' + adminToken);
    assert('下载全部照片ZIP', res.status === 200 && res.headers['content-type'] === 'application/zip', `status=${res.status}`);

    // 12.4 下载单社团资源ZIP
    if (testClubId) {
      res = await request('GET', `/api/admin/download/club/${testClubId}?token=` + adminToken);
      assert('下载单社团资源ZIP', res.status === 200 && res.headers['content-type'] === 'application/zip', `status=${res.status}`);
    }

    // 12.5 下载非法类型
    res = await request('GET', '/api/admin/download/invalid?token=' + adminToken);
    assert('下载非法类型被拒绝', res.status === 400, `status=${res.status}`);
  }

  // ===== 13. 删除社团 =====
  console.log('\n【13. 删除社团】');

  if (testClubId && adminToken) {
    // 13.1 删除测试社团
    res = await request('DELETE', `/api/clubs/${testClubId}`, null, adminToken);
    assert('删除社团', res.status === 200 && res.json && res.json.success, `status=${res.status}`);

    // 13.2 验证社团已删除
    res = await request('GET', `/api/clubs/${testClubId}`);
    assert('验证社团已删除', res.status === 404, `status=${res.status}`);

    // 13.3 删除不存在的社团
    res = await request('DELETE', '/api/clubs/nonexistent', null, adminToken);
    assert('删除不存在社团返回404', res.status === 404, `status=${res.status}`);
  }

  // ===== 14. 清理批量导入的测试社团 =====
  console.log('\n【14. 清理测试数据】');

  if (adminToken) {
    const clubsRes = await request('GET', '/api/clubs');
    if (clubsRes.json) {
      for (const c of clubsRes.json) {
        if (c.name && c.name.startsWith('批量导入社团')) {
          await request('DELETE', `/api/clubs/${c.id}`, null, adminToken);
        }
      }
      assert('清理批量导入测试社团', true, 'cleaned');
    }
  }

  // 清理测试文件
  try { fs.unlinkSync(testLessonFile); } catch(e) {}
  try { fs.unlinkSync(testPhotoFile); } catch(e) {}

  // ===== 15. 退出登录 =====
  console.log('\n【15. 退出登录】');

  if (adminToken) {
    res = await request('POST', '/api/logout', null, adminToken);
    assert('管理员退出登录', res.status === 200 && res.json && res.json.success, `status=${res.status}`);

    // 验证退出后token失效
    res = await request('GET', '/api/admin/dashboard', null, adminToken);
    assert('退出后Token失效', res.status === 401, `status=${res.status}`);
  }

  // ===== 汇总报告 =====
  console.log('\n========================================');
  console.log('  测试汇总');
  console.log('========================================');
  console.log(`  通过: ${passCount}`);
  console.log(`  失败: ${failCount}`);
  console.log(`  总计: ${passCount + failCount}`);
  console.log('========================================\n');

  if (failCount > 0) {
    console.log('失败项:');
    testResults.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  ✗ ${r.name} — ${r.detail}`);
    });
    console.log('');
  }

  // 输出JSON报告
  const report = {
    total: passCount + failCount,
    passed: passCount,
    failed: failCount,
    results: testResults
  };
  fs.writeFileSync(path.join(__dirname, 'test-report.json'), JSON.stringify(report, null, 2));

  process.exit(failCount > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('测试脚本出错:', e);
  process.exit(1);
});
