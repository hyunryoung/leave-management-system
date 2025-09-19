// 전역 변수
let employees = [];
let leaveRecords = [];
let currentDate = new Date();
let displayMonth = new Date();

// 달력 선택 관련 변수
let selectedDates = [];
let isSelecting = false;
let startDate = null;

// Firebase 설정
const firebaseConfig = {
    apiKey: "AIzaSyA-zccMlou2FoqmiBc3XpqQUhOMv0XoJ_M",
    authDomain: "leave-management-system-f8a52.firebaseapp.com",
    databaseURL: "https://leave-management-system-f8a52-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "leave-management-system-f8a52",
    storageBucket: "leave-management-system-f8a52.firebasestorage.app",
    messagingSenderId: "863188153143",
    appId: "1:863188153143:web:1099e6c14d24d5afb0e0b2"
};

// Firebase 초기화
let firebase_app = null;
let database = null;
let isFirebaseEnabled = false;

// 고유값 기반 인증 시스템 - 전역 토큰 사용
let ACCESS_TOKENS = window.ACTIVE_TOKENS || {};

// 관리자가 생성한 토큰들 로드
function loadActiveTokens() {
    try {
        // 관리자 페이지에서 생성한 토큰들
        const activeTokens = localStorage.getItem('activeTokens');
        if (activeTokens) {
            const adminTokens = JSON.parse(activeTokens);
            ACCESS_TOKENS = { ...ACCESS_TOKENS, ...adminTokens };
        }
        
        // 관리자 토큰 데이터베이스에서도 로드
        const tokenDatabase = localStorage.getItem('tokenDatabase');
        const adminGeneratedTokens = localStorage.getItem('adminGeneratedTokens');
        
        if (tokenDatabase) {
            const allTokens = JSON.parse(tokenDatabase);
            Object.keys(allTokens).forEach(token => {
                const tokenInfo = allTokens[token];
                if (tokenInfo.status === 'active' && new Date(tokenInfo.expires) > new Date()) {
                    ACCESS_TOKENS[token] = {
                        name: tokenInfo.name,
                        role: tokenInfo.role,
                        expires: tokenInfo.expires
                    };
                }
            });
        }
        
        // 추가 동기화 경로
        if (adminGeneratedTokens) {
            const adminTokens = JSON.parse(adminGeneratedTokens);
            ACCESS_TOKENS = { ...ACCESS_TOKENS, ...adminTokens };
        }
        
        console.log('로드된 토큰들:', Object.keys(ACCESS_TOKENS));
    } catch (error) {
        console.log('토큰 로드 실패:', error);
    }
}

// 실시간 동기화를 위한 변수
let syncInterval = null;
let userToken = null;
let isRealtimeSubscribed = false; // 중복 구독 방지

// 2025년 대한민국 공휴일 데이터
const koreanHolidays2025 = {
    '2025-01-01': '신정',
    '2025-01-28': '설날연휴',
    '2025-01-29': '설날',
    '2025-01-30': '설날연휴',
    '2025-03-01': '삼일절',
    '2025-05-05': '어린이날',
    '2025-05-06': '어린이날 대체공휴일',
    '2025-05-13': '석가탄신일',
    '2025-06-06': '현충일',
    '2025-08-15': '광복절',
    '2025-10-03': '개천절',
    '2025-10-06': '추석연휴',
    '2025-10-07': '추석연휴',
    '2025-10-08': '추석',
    '2025-10-09': '추석연휴',
    '2025-10-09': '한글날',
    '2025-12-25': '크리스마스'
};

// 페이지 로드 시 초기화
document.addEventListener('DOMContentLoaded', async function() {
    // Firebase 초기화 시도
    initializeFirebase();
    
    // 관리자가 생성한 토큰들 로드
    loadActiveTokens();
    
    // Firebase 토큰 구독이 켜졌다면, 처음 동기화 끝날 때까지 대기
    if (isFirebaseEnabled) {
        await waitForInitialTokensLoad();
    }
    
    // 토큰 기반 인증 체크 (비동기)
    if (!(await checkTokenAuthentication())) {
        return;
    }
    
    await loadData(); // Firebase에서 데이터 우선 로드
    updateCurrentTime();
    setInterval(updateCurrentTime, 1000); // 매초 시간 업데이트
    renderCalendar();
    renderEmployeeSummary();
    updateModalEmployeeDropdown();
    
    // 매일 자정에 연차/월차 자동 계산
    setInterval(calculateLeaves, 60000); // 1분마다 체크
    
    // 전역 마우스 이벤트
    document.addEventListener('mouseup', () => {
        if (isSelecting) {
            isSelecting = false;
            if (selectedDates.length > 0) {
                openLeaveModal();
            }
        }
    });
});

// 현재 시간 업데이트
function updateCurrentTime() {
    const now = new Date();
    const timeStr = now.toLocaleString('ko-KR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
    document.getElementById('currentTime').textContent = timeStr;
}

// 권한 체크 함수
function checkPermission(requiredRole) {
    const userRole = sessionStorage.getItem('userRole') || localStorage.getItem('userRole');
    const roleHierarchy = { 'user': 1, 'manager': 2, 'admin': 3 };
    
    const userLevel = roleHierarchy[userRole] || 0;
    const requiredLevel = roleHierarchy[requiredRole] || 0;
    
    return userLevel >= requiredLevel;
}

// 권한 없음 알림
function showNoPermissionAlert(action) {
    const userRole = sessionStorage.getItem('userRole') || localStorage.getItem('userRole');
    const roleText = userRole === 'user' ? '일반 사용자' : 
                     userRole === 'manager' ? '매니저' : '알 수 없음';
    alert(`권한이 부족합니다.\n현재 권한: ${roleText}\n필요 권한: 관리자 또는 매니저\n\n${action} 기능은 관리자나 매니저만 사용할 수 있습니다.`);
}

// 직원 추가
async function addEmployee() {
    // 권한 체크: 매니저 이상만 가능
    if (!checkPermission('manager')) {
        showNoPermissionAlert('직원 추가');
        return;
    }
    
    const name = document.getElementById('employeeName').value.trim();
    const joinDate = document.getElementById('joinDate').value;
    
    if (!name || !joinDate) {
        alert('직원 이름과 입사일을 입력해주세요.');
        return;
    }
    
    const employee = {
        id: Date.now(),
        name: name,
        joinDate: joinDate,
        annualLeave: 0, // 연차
        monthlyLeave: 0, // 월차
        usedAnnual: 0,
        usedMonthly: 0,
        lastMonthlyUpdate: joinDate // 마지막 월차 업데이트 날짜
    };
    
    // 초기 연차/월차 계산
    calculateEmployeeLeaves(employee);
    
    employees.push(employee);
    
    // 개별 저장으로 충돌 방지
    await saveEmployee(employee);
    saveData();
    
    // UI 업데이트
    document.getElementById('employeeName').value = '';
    document.getElementById('joinDate').value = '';
    renderEmployeeSummary();
    updateModalEmployeeDropdown();
}

// 직원별 연차/월차 계산
function calculateEmployeeLeaves(employee) {
    const today = new Date();
    const joinDate = new Date(employee.joinDate);
    
    // 사용량 속성 초기화 (누락된 경우)
    if (typeof employee.usedAnnual === 'undefined') employee.usedAnnual = 0;
    if (typeof employee.usedMonthly === 'undefined') employee.usedMonthly = 0;
    
    // 근무일수 계산
    const daysDiff = Math.floor((today - joinDate) / (1000 * 60 * 60 * 24));
    const yearsOfService = Math.floor(daysDiff / 365);
    
    // 1년 미만 직원 - 월차만 지급
    if (yearsOfService < 1) {
        // 입사일 기준으로 매달 1개 월차 (입사한 달부터 시작)
        const monthsSinceJoin = (today.getFullYear() - joinDate.getFullYear()) * 12 + 
                              (today.getMonth() - joinDate.getMonth()) + 
                              (today.getDate() >= joinDate.getDate() ? 1 : 0);
        employee.monthlyLeave = Math.max(0, monthsSinceJoin);
        employee.annualLeave = 0; // 1년 미만은 연차 없음
        employee.usedAnnual = 0;
    } 
    // 1년 이상 직원 - 연차만 지급 (매년 리셋)
    else {
        employee.monthlyLeave = 0; // 1년 이상은 월차 없음
        employee.usedMonthly = 0;
        
        // 연차 지급 주기 계산 (입사일 기준)
        const currentAnnualYear = new Date(today.getFullYear(), joinDate.getMonth(), joinDate.getDate());
        const nextAnnualYear = new Date(today.getFullYear() + 1, joinDate.getMonth(), joinDate.getDate());
        const prevAnnualYear = new Date(today.getFullYear() - 1, joinDate.getMonth(), joinDate.getDate());
        
        // 현재 연차 주기 시작일
        let currentCycleStart;
        if (today >= currentAnnualYear) {
            currentCycleStart = currentAnnualYear;
        } else {
            currentCycleStart = prevAnnualYear;
        }
        
        // 연차 리셋 체크 (새로운 연차 주기가 시작되었는지)
        if (!employee.lastAnnualReset) {
            employee.lastAnnualReset = currentCycleStart.toISOString().split('T')[0];
            employee.annualLeave = 15;
            // 최초 설정이므로 usedAnnual은 그대로 유지 (이미 0으로 초기화됨)
        } else {
            const lastReset = new Date(employee.lastAnnualReset);
            const lastResetStr = employee.lastAnnualReset;
            const currentCycleStr = currentCycleStart.toISOString().split('T')[0];
            
            // 정확히 1년이 지났을 때만 리셋 (날짜 비교)
            if (currentCycleStr !== lastResetStr && currentCycleStart > lastReset) {
                console.log(`${employee.name} 연차 주기 리셋: ${lastResetStr} → ${currentCycleStr}`);
                employee.lastAnnualReset = currentCycleStr;
                employee.annualLeave = 15;
                employee.usedAnnual = 0; // 새 연차 주기에만 리셋
            } else {
                // 같은 연차 주기 내에서는 절대 usedAnnual 건드리지 않음
                console.log(`${employee.name} 연차 주기 유지: ${lastResetStr}, 사용량: ${employee.usedAnnual}`);
            }
        }
    }
}

// 모든 직원의 연차/월차 계산
function calculateLeaves() {
    employees.forEach(employee => {
        calculateEmployeeLeaves(employee);
    });
    saveData();
    renderEmployeeSummary();
}

// 직원 삭제
function deleteEmployee(id) {
    // 권한 체크: 관리자만 가능
    if (!checkPermission('admin')) {
        showNoPermissionAlert('직원 삭제');
        return;
    }
    
    if (confirm('정말로 이 직원을 삭제하시겠습니까?')) {
        employees = employees.filter(emp => emp.id !== id);
        leaveRecords = leaveRecords.filter(record => record.employeeId !== id);
        saveData();
        renderEmployeeSummary();
        updateModalEmployeeDropdown();
        renderCalendar();
    }
}

// 직원 요약 렌더링
function renderEmployeeSummary() {
    const container = document.getElementById('employeeSummary');
    container.innerHTML = '';
    
    employees.forEach(employee => {
        const joinDate = new Date(employee.joinDate);
        const today = new Date();
        const daysDiff = Math.floor((today - joinDate) / (1000 * 60 * 60 * 24));
        const years = Math.floor(daysDiff / 365);
        const months = Math.floor((daysDiff % 365) / 30);
        
        const card = document.createElement('div');
        card.className = 'employee-card';
        
        let leaveDisplay = '';
        if (years < 1) {
            // 1년 미만 - 월차만
            leaveDisplay = `
                <div class="leave-summary">
                    <div class="leave-item monthly">월차: ${(employee.monthlyLeave - employee.usedMonthly).toFixed(1)}</div>
                    <div class="leave-item" style="background:#f8f9fa; color:#666;">연차: 없음</div>
                </div>
            `;
        } else {
            // 1년 이상 - 연차만
            leaveDisplay = `
                <div class="leave-summary">
                    <div class="leave-item annual">연차: ${(employee.annualLeave - employee.usedAnnual).toFixed(1)}</div>
                    <div class="leave-item" style="background:#f8f9fa; color:#666;">월차: 없음</div>
                </div>
            `;
        }
        
        // 권한에 따른 삭제 버튼 표시
        const deleteButton = checkPermission('admin') ? 
            `<button class="delete-employee" onclick="deleteEmployee(${employee.id}); event.stopPropagation();">×</button>` : 
            '';
        
        card.innerHTML = `
            ${deleteButton}
            <div class="employee-name">${employee.name}</div>
            <div class="employee-info">
                입사: ${employee.joinDate} (${years}년 ${months}개월)
            </div>
            ${leaveDisplay}
        `;
        
        // 직원 카드 클릭 이벤트 추가
        card.addEventListener('click', () => showEmployeeDetail(employee.id));
        container.appendChild(card);
    });
}

// 달력 렌더링
function renderCalendar() {
    const calendar = document.getElementById('calendar');
    const monthYearStr = displayMonth.toLocaleDateString('ko-KR', {
        year: 'numeric',
        month: 'long'
    });
    document.getElementById('currentMonth').textContent = monthYearStr;
    
    calendar.innerHTML = '';
    
    // 요일 헤더
    const daysOfWeek = ['일', '월', '화', '수', '목', '금', '토'];
    daysOfWeek.forEach(day => {
        const header = document.createElement('div');
        header.className = 'calendar-header';
        header.textContent = day;
        calendar.appendChild(header);
    });
    
    // 달력 날짜
    const year = displayMonth.getFullYear();
    const month = displayMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const prevLastDay = new Date(year, month, 0);
    
    const startDate = firstDay.getDay();
    const endDate = lastDay.getDate();
    const prevEndDate = prevLastDay.getDate();
    
    // 이전 달 날짜
    for (let i = startDate - 1; i >= 0; i--) {
        const day = document.createElement('div');
        day.className = 'calendar-day other-month';
        day.innerHTML = `<div class="day-number">${prevEndDate - i}</div>`;
        calendar.appendChild(day);
    }
    
    // 현재 달 날짜
    for (let i = 1; i <= endDate; i++) {
        const day = document.createElement('div');
        day.className = 'calendar-day';
        
        const currentDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
        const todayStr = new Date().toISOString().split('T')[0];
        
        if (currentDateStr === todayStr) {
            day.classList.add('today');
        }
        
        // 공휴일 체크
        const isHoliday = koreanHolidays2025[currentDateStr];
        if (isHoliday) {
            day.classList.add('holiday');
        }
        
        // 해당 날짜의 휴가 정보 표시
        const dayLeaves = getLeavesByDate(currentDateStr);
        let leaveHTML = `<div class="day-number">${i}</div>`;
        
        // 공휴일 표시
        if (isHoliday) {
            leaveHTML += `<div class="holiday-indicator">${isHoliday}</div>`;
        }
        
        dayLeaves.forEach(leave => {
            const employee = employees.find(emp => emp.id === leave.employeeId);
            if (employee) {
                let duration = '';
                if (leave.duration === 'morning') duration = '오전';
                else if (leave.duration === 'afternoon') duration = '오후';
                leaveHTML += `<div class="leave-indicator ${leave.type}" onclick="showLeaveCancelModal(${leave.id})" data-leave-id="${leave.id}">${employee.name.substring(0, 3)}${duration}</div>`;
            }
        });
        
        day.innerHTML = leaveHTML;
        day.dataset.date = currentDateStr;
        
        // 달력 이벤트 추가
        day.addEventListener('mousedown', handleDateMouseDown);
        day.addEventListener('mouseover', handleDateMouseOver);
        day.addEventListener('mouseup', handleDateMouseUp);
        
        calendar.appendChild(day);
    }
    
    // 다음 달 날짜
    const remainingDays = 42 - (startDate + endDate); // 6주 * 7일
    for (let i = 1; i <= remainingDays; i++) {
        const day = document.createElement('div');
        day.className = 'calendar-day other-month';
        day.innerHTML = `<div class="day-number">${i}</div>`;
        calendar.appendChild(day);
    }
}

// 특정 날짜의 휴가 정보 가져오기
function getLeavesByDate(dateStr) {
    return leaveRecords.filter(record => {
        const startDate = new Date(record.startDate);
        const endDate = new Date(record.endDate);
        const checkDate = new Date(dateStr);
        return checkDate >= startDate && checkDate <= endDate;
    });
}

// 이전 달로 이동
function previousMonth() {
    displayMonth.setMonth(displayMonth.getMonth() - 1);
    renderCalendar();
}

// 다음 달로 이동
function nextMonth() {
    displayMonth.setMonth(displayMonth.getMonth() + 1);
    renderCalendar();
}

// 모달 직원 드롭다운 업데이트
function updateModalEmployeeDropdown() {
    const dropdown = document.getElementById('modalEmployee');
    dropdown.innerHTML = '<option value="">직원 선택</option>';
    
    employees.forEach(employee => {
        const option = document.createElement('option');
        option.value = employee.id;
        option.textContent = employee.name;
        dropdown.appendChild(option);
    });
}

// 달력 날짜 선택 이벤트
function handleDateMouseDown(e) {
    e.preventDefault();
    const dateStr = e.currentTarget.dataset.date;
    
    if (e.currentTarget.classList.contains('other-month')) return;
    
    selectedDates = [dateStr];
    startDate = dateStr;
    isSelecting = true;
    
    updateSelectedDatesDisplay();
    updateCalendarSelection();
}

function handleDateMouseOver(e) {
    if (!isSelecting || e.currentTarget.classList.contains('other-month')) return;
    
    const endDate = e.currentTarget.dataset.date;
    selectedDates = getDateRange(startDate, endDate);
    
    updateSelectedDatesDisplay();
    updateCalendarSelection();
}

function handleDateMouseUp(e) {
    if (!isSelecting) return;
    
    isSelecting = false;
    
    if (selectedDates.length > 0) {
        openLeaveModal();
    }
}

// 날짜 범위 계산
function getDateRange(start, end) {
    const dates = [];
    const startDate = new Date(start);
    const endDate = new Date(end);
    
    if (startDate > endDate) {
        [startDate, endDate] = [endDate, startDate];
    }
    
    const current = new Date(startDate);
    while (current <= endDate) {
        dates.push(current.toISOString().split('T')[0]);
        current.setDate(current.getDate() + 1);
    }
    
    return dates;
}

// 선택된 날짜 디스플레이 업데이트
function updateSelectedDatesDisplay() {
    const info = document.getElementById('selectedInfo');
    if (selectedDates.length === 0) {
        info.textContent = '드래그하여 연속 날짜 선택 또는 클릭하여 단일 날짜 선택';
    } else if (selectedDates.length === 1) {
        info.textContent = `선택된 날짜: ${selectedDates[0]}`;
    } else {
        info.textContent = `선택된 날짜: ${selectedDates[0]} ~ ${selectedDates[selectedDates.length - 1]} (${selectedDates.length}일)`;
    }
}

// 달력 선택 표시 업데이트
function updateCalendarSelection() {
    document.querySelectorAll('.calendar-day').forEach(day => {
        day.classList.remove('selected', 'selecting');
    });
    
    selectedDates.forEach(dateStr => {
        const dayElement = document.querySelector(`[data-date="${dateStr}"]`);
        if (dayElement) {
            dayElement.classList.add(isSelecting ? 'selecting' : 'selected');
        }
    });
}

// 휴가 등록 모달 열기
function openLeaveModal() {
    if (selectedDates.length === 0) return;
    
    const modal = document.getElementById('leaveModal');
    const selectedDatesSpan = document.getElementById('selectedDates');
    
    if (selectedDates.length === 1) {
        selectedDatesSpan.textContent = selectedDates[0];
    } else {
        selectedDatesSpan.textContent = `${selectedDates[0]} ~ ${selectedDates[selectedDates.length - 1]} (${selectedDates.length}일)`;
    }
    
    modal.style.display = 'block';
}

// 모달 닫기
function closeLeaveModal() {
    const modal = document.getElementById('leaveModal');
    modal.style.display = 'none';
    
    // 선택 초기화
    selectedDates = [];
    updateSelectedDatesDisplay();
    updateCalendarSelection();
    
    // 폼 초기화
    document.getElementById('modalEmployee').value = '';
    document.getElementById('modalLeaveType').value = 'annual';
    document.getElementById('modalDuration').value = 'full';
    document.getElementById('modalReason').value = '';
}

// 휴가 등록
function registerLeave() {
    // 권한 체크: 매니저 이상만 가능 (또는 본인 휴가만)
    const employeeId = parseInt(document.getElementById('modalEmployee').value);
    const currentUserName = sessionStorage.getItem('userName') || localStorage.getItem('userName');
    const selectedEmployee = employees.find(emp => emp.id === employeeId);
    
    // 본인 휴가가 아니면 매니저 이상 권한 필요
    if (selectedEmployee && selectedEmployee.name !== currentUserName) {
        if (!checkPermission('manager')) {
            showNoPermissionAlert('다른 직원의 휴가 등록');
            return;
        }
    }
    
    const leaveType = document.getElementById('modalLeaveType').value;
    const leaveDuration = document.getElementById('modalDuration').value;
    const reason = document.getElementById('modalReason').value.trim();
    
    if (selectedDates.length === 0) {
        alert('날짜를 선택해주세요.');
        return;
    }
    
    if (!employeeId) {
        alert('직원을 선택해주세요.');
        return;
    }
    
    const employee = employees.find(emp => emp.id === employeeId);
    if (!employee) {
        alert('직원을 찾을 수 없습니다.');
        return;
    }
    
    // 1년 미만 직원은 월차만, 1년 이상 직원은 연차만 사용 가능
    const today = new Date();
    const joinDate = new Date(employee.joinDate);
    const yearsOfService = Math.floor((today - joinDate) / (1000 * 60 * 60 * 24 * 365));
    
    if (yearsOfService < 1 && leaveType === 'annual') {
        alert('1년 미만 직원은 연차를 사용할 수 없습니다. 월차를 선택해주세요.');
        return;
    }
    
    if (yearsOfService >= 1 && leaveType === 'monthly') {
        alert('1년 이상 직원은 월차를 사용할 수 없습니다. 연차를 선택해주세요.');
        return;
    }
    
    // 휴가 일수 계산 (반차 고려)
    let days = selectedDates.length;
    
    if (leaveDuration === 'morning' || leaveDuration === 'afternoon') {
        days = days * 0.5; // 반차
    }
    
    // 잔여 휴가 확인
    if (leaveType === 'annual') {
        if (employee.annualLeave - employee.usedAnnual < days) {
            alert('연차가 부족합니다.');
            return;
        }
        employee.usedAnnual += days;
    } else {
        if (employee.monthlyLeave - employee.usedMonthly < days) {
            alert('월차가 부족합니다.');
            return;
        }
        employee.usedMonthly += days;
    }
    
    // 각 날짜에 대해 휴가 기록 추가
    selectedDates.forEach((dateStr, index) => {
        const leaveRecord = {
            id: `${Date.now()}_${index}`, // Firebase 호환 ID (점 제거)
            employeeId: employeeId,
            type: leaveType,
            duration: leaveDuration,
            startDate: dateStr,
            endDate: dateStr,
            days: leaveDuration === 'morning' || leaveDuration === 'afternoon' ? 0.5 : 1,
            reason: reason,
            requestDate: new Date().toISOString()
        };
        leaveRecords.push(leaveRecord);
    });
    
    saveData();
    
    // UI 업데이트
    renderEmployeeSummary();
    renderCalendar();
    
    alert('휴가가 등록되었습니다.');
    closeLeaveModal();
}


// 휴가 내역 렌더링
function renderLeaveHistory() {
    const container = document.getElementById('leaveHistory');
    container.innerHTML = '';
    
    // 최신순으로 정렬
    const sortedRecords = [...leaveRecords].sort((a, b) => 
        new Date(b.requestDate) - new Date(a.requestDate)
    );
    
    sortedRecords.forEach(record => {
        const employee = employees.find(emp => emp.id === record.employeeId);
        if (!employee) return;
        
        let durationText = '';
        if (record.duration === 'morning') durationText = ' (오전반차)';
        else if (record.duration === 'afternoon') durationText = ' (오후반차)';
        
        const item = document.createElement('div');
        item.className = 'leave-item';
        item.innerHTML = `
            <div class="leave-item-info">
                <div class="leave-item-employee">${employee.name}</div>
                <div class="leave-item-dates">
                    ${record.startDate} ~ ${record.endDate} (${record.days}일${durationText})
                    ${record.reason ? `- ${record.reason}` : ''}
                </div>
            </div>
            <span class="leave-item-type ${record.type}">${record.type === 'annual' ? '연차' : '월차'}</span>
            <button class="cancel-leave" onclick="cancelLeave(${record.id})">취소</button>
        `;
        container.appendChild(item);
    });
}

// 통계 업데이트
function updateStats() {
    const statsGrid = document.getElementById('statsGrid');
    
    // 전체 직원 수
    const totalEmployees = employees.length;
    
    // 전체 연차/월차 통계
    let totalAnnual = 0, usedAnnual = 0;
    let totalMonthly = 0, usedMonthly = 0;
    
    employees.forEach(emp => {
        totalAnnual += emp.annualLeave;
        usedAnnual += emp.usedAnnual;
        totalMonthly += emp.monthlyLeave;
        usedMonthly += emp.usedMonthly;
    });
    
    // 오늘 휴가 중인 직원
    const todayStr = new Date().toISOString().split('T')[0];
    const todayLeaves = getLeavesByDate(todayStr);
    
    statsGrid.innerHTML = `
        <div class="stat-card">
            <h3>전체 직원</h3>
            <div class="stat-value">${totalEmployees}</div>
            <div class="stat-label">명</div>
        </div>
        <div class="stat-card">
            <h3>연차 현황</h3>
            <div class="stat-value">${totalAnnual - usedAnnual}/${totalAnnual}</div>
            <div class="stat-label">잔여/전체</div>
        </div>
        <div class="stat-card">
            <h3>월차 현황</h3>
            <div class="stat-value">${totalMonthly - usedMonthly}/${totalMonthly}</div>
            <div class="stat-label">잔여/전체</div>
        </div>
        <div class="stat-card">
            <h3>오늘 휴가</h3>
            <div class="stat-value">${todayLeaves.length}</div>
            <div class="stat-label">명</div>
        </div>
    `;
}

// 개별 직원 저장
async function saveEmployee(employee) {
    if (isFirebaseEnabled) {
        try {
            await database.ref(`employees/${employee.id}`).set(employee);
            console.log('Firebase에 직원 저장 완료:', employee.name);
        } catch (error) {
            console.log('Firebase 직원 저장 실패:', error);
        }
    }
}

// 개별 휴가 기록 저장
async function saveLeaveRecord(leaveRecord) {
    if (isFirebaseEnabled) {
        try {
            // ID에 소수점이 있으면 변환
            let safeId = leaveRecord.id.toString().replace(/\./g, '_');
            await database.ref(`leaveRecords/${safeId}`).set({
                ...leaveRecord,
                id: safeId // 안전한 ID로 업데이트
            });
            console.log('Firebase에 휴가 기록 저장 완료:', safeId);
        } catch (error) {
            console.log('Firebase 휴가 저장 실패:', error);
        }
    }
}

// 개별 휴가 기록 삭제
async function deleteLeaveRecord(leaveId) {
    if (isFirebaseEnabled) {
        try {
            await database.ref(`leaveRecords/${leaveId}`).remove();
            console.log('Firebase에서 휴가 기록 삭제 완료');
        } catch (error) {
            console.log('Firebase 휴가 삭제 실패:', error);
        }
    }
}

// 기존 잘못된 휴가 기록 완전 정리
async function cleanupInvalidLeaveRecords() {
    if (!isFirebaseEnabled) return;
    
    try {
        // 소수점이 포함된 ID를 가진 기록들 완전 제거
        leaveRecords = leaveRecords.filter(record => 
            !record.id.toString().includes('.')
        );
        
        console.log('잘못된 휴가 기록 완전 제거 완료, 남은 기록:', leaveRecords.length + '개');
        
        // Firebase에서도 잘못된 기록들 삭제
        const firebaseRecordsSnapshot = await database.ref('leaveRecords').once('value');
        const firebaseRecords = firebaseRecordsSnapshot.val() || {};
        
        for (const recordId of Object.keys(firebaseRecords)) {
            if (recordId.includes('.')) {
                await database.ref(`leaveRecords/${recordId}`).remove();
                console.log('Firebase에서 잘못된 기록 삭제:', recordId);
            }
        }
        
    } catch (error) {
        console.log('휴가 기록 정리 실패:', error);
    }
}

// 데이터 저장 (기존 + 개별 저장)
async function saveData() {
    // 기존 잘못된 데이터 정리
    await cleanupInvalidLeaveRecords();
    
    // 로컬 백업
    localStorage.setItem('employees', JSON.stringify(employees));
    localStorage.setItem('leaveRecords', JSON.stringify(leaveRecords));
    localStorage.setItem('lastUpdate', Date.now().toString());
    
    // Firebase에 개별 저장 (충돌 방지)
    if (isFirebaseEnabled) {
        try {
            // 직원들 개별 저장
            for (const employee of employees) {
                await saveEmployee(employee);
            }
            
            // 휴가 기록들 개별 저장
            for (const record of leaveRecords) {
                await saveLeaveRecord(record);
            }
            
            await database.ref('lastUpdate').set(Date.now());
            console.log('Firebase에 모든 데이터 개별 저장 완료');
        } catch (error) {
            console.log('Firebase 저장 실패:', error);
        }
    }
}

// 데이터 불러오기
async function loadData() {
    // Firebase에서 개별 로드 시도 (충돌 방지)
    if (isFirebaseEnabled) {
        try {
            const [employeesSnapshot, recordsSnapshot] = await Promise.all([
                database.ref('employees').once('value'),
                database.ref('leaveRecords').once('value')
            ]);
            
            const firebaseEmployees = employeesSnapshot.val();
            const firebaseRecords = recordsSnapshot.val();
            
            if (firebaseEmployees) {
                // 안전한 배열 변환
                if (Array.isArray(firebaseEmployees)) {
                    employees = firebaseEmployees;
                } else {
                    employees = Object.values(firebaseEmployees);
                }
                
                // 배열인지 확인 후 처리
                if (Array.isArray(employees)) {
                    employees.forEach(emp => calculateEmployeeLeaves(emp));
                    console.log('Firebase에서 직원 데이터 로드 완료');
                } else {
                    console.log('직원 데이터 형식 오류, 빈 배열로 초기화');
                    employees = [];
                }
            }
            
            if (firebaseRecords) {
                // 안전한 배열 변환
                if (Array.isArray(firebaseRecords)) {
                    leaveRecords = firebaseRecords;
                } else {
                    // 객체에서 유효한 휴가 기록만 추출
                    leaveRecords = Object.values(firebaseRecords).filter(record => 
                        record && record.id && !record.id.toString().includes('.')
                    );
                }
                console.log('Firebase에서 휴가 데이터 로드 완료:', leaveRecords.length + '개');
            }
            
            // Firebase 데이터를 로컬에도 백업
            if (firebaseEmployees) localStorage.setItem('employees', JSON.stringify(employees));
            if (firebaseRecords) localStorage.setItem('leaveRecords', JSON.stringify(leaveRecords));
            
            return; // Firebase 로드 성공하면 로컬 로드 생략
            
        } catch (error) {
            console.log('Firebase 로드 실패, 로컬 데이터 사용:', error);
        }
    }
    
    // Firebase 실패 시 로컬 데이터 사용
    const savedEmployees = localStorage.getItem('employees');
    const savedRecords = localStorage.getItem('leaveRecords');
    
    if (savedEmployees) {
        employees = JSON.parse(savedEmployees);
        employees.forEach(emp => calculateEmployeeLeaves(emp));
    }
    
    if (savedRecords) {
        leaveRecords = JSON.parse(savedRecords);
    }
}

// 직원 상세 정보 모달 표시
function showEmployeeDetail(employeeId) {
    const employee = employees.find(emp => emp.id === employeeId);
    if (!employee) return;
    
    const modal = document.getElementById('employeeDetailModal');
    const title = document.getElementById('employeeDetailTitle');
    const info = document.getElementById('employeeDetailInfo');
    const history = document.getElementById('employeeLeaveHistory');
    
    // 직원 기본 정보
    title.textContent = `${employee.name} 상세 정보`;
    
    const today = new Date();
    const joinDate = new Date(employee.joinDate);
    const daysDiff = Math.floor((today - joinDate) / (1000 * 60 * 60 * 24));
    const years = Math.floor(daysDiff / 365);
    const months = Math.floor((daysDiff % 365) / 30);
    
    let leaveInfo = '';
    if (years < 1) {
        leaveInfo = `
            <p><strong>월차:</strong> ${employee.monthlyLeave}개 (사용: ${employee.usedMonthly}개, 잔여: ${employee.monthlyLeave - employee.usedMonthly}개)</p>
            <p><strong>연차:</strong> 1년 미만으로 연차 없음</p>
        `;
    } else {
        leaveInfo = `
            <p><strong>연차:</strong> ${employee.annualLeave}개 (사용: ${employee.usedAnnual}개, 잔여: ${employee.annualLeave - employee.usedAnnual}개)</p>
            <p><strong>월차:</strong> 1년 이상으로 월차 없음</p>
        `;
    }
    
    info.innerHTML = `
        <h4>기본 정보</h4>
        <p><strong>입사일:</strong> ${employee.joinDate}</p>
        <p><strong>근무기간:</strong> ${years}년 ${months}개월</p>
        ${leaveInfo}
    `;
    
    // 휴가 사용 내역
    const employeeLeaves = leaveRecords.filter(record => record.employeeId === employeeId)
        .sort((a, b) => new Date(b.startDate) - new Date(a.startDate));
    
    let historyHTML = '<h4>휴가 사용 내역</h4>';
    
    if (employeeLeaves.length === 0) {
        historyHTML += '<p style="text-align: center; color: #666; padding: 20px;">휴가 사용 내역이 없습니다.</p>';
    } else {
        employeeLeaves.forEach(leave => {
            let durationText = '종일';
            if (leave.duration === 'morning') durationText = '오전반차';
            else if (leave.duration === 'afternoon') durationText = '오후반차';
            
            const leaveTypeText = leave.type === 'annual' ? '연차' : '월차';
            
            historyHTML += `
                <div class="leave-history-item">
                    <div class="leave-history-info">
                        <div class="leave-history-date">${leave.startDate}</div>
                        <div class="leave-history-details">
                            ${durationText} (${leave.days}일) ${leave.reason ? `- ${leave.reason}` : ''}
                        </div>
                    </div>
                    <div class="leave-history-type ${leave.type}">${leaveTypeText}</div>
                </div>
            `;
        });
    }
    
    history.innerHTML = historyHTML;
    modal.style.display = 'block';
}

// 직원 상세 모달 닫기
function closeEmployeeDetailModal() {
    const modal = document.getElementById('employeeDetailModal');
    modal.style.display = 'none';
}

// 휴가 취소 모달 표시
function showLeaveCancelModal(leaveId) {
    event.stopPropagation(); // 달력 날짜 선택 방지
    
    const leave = leaveRecords.find(record => record.id === leaveId);
    if (!leave) return;
    
    const employee = employees.find(emp => emp.id === leave.employeeId);
    if (!employee) return;
    
    const modal = document.getElementById('leaveCancelModal');
    const info = document.getElementById('leaveCancelInfo');
    
    let durationText = '종일';
    if (leave.duration === 'morning') durationText = '오전반차';
    else if (leave.duration === 'afternoon') durationText = '오후반차';
    
    const leaveTypeText = leave.type === 'annual' ? '연차' : '월차';
    
    info.innerHTML = `
        <h4>휴가 취소 확인</h4>
        <p><strong>직원:</strong> ${employee.name}</p>
        <p><strong>날짜:</strong> ${leave.startDate}</p>
        <p><strong>종류:</strong> ${leaveTypeText} (${durationText})</p>
        <p><strong>사유:</strong> ${leave.reason || '없음'}</p>
        <p style="margin-top: 15px; font-weight: bold;">이 휴가를 취소하시겠습니까?</p>
    `;
    
    // 취소할 휴가 ID를 모달에 저장
    modal.dataset.leaveId = leaveId;
    modal.style.display = 'block';
}

// 휴가 취소 모달 닫기
function closeLeaveCancelModal() {
    const modal = document.getElementById('leaveCancelModal');
    modal.style.display = 'none';
    delete modal.dataset.leaveId;
}

// 휴가 취소 확인
function confirmCancelLeave() {
    const modal = document.getElementById('leaveCancelModal');
    const leaveId = modal.dataset.leaveId; // 문자열 ID 사용
    
    if (!leaveId) return;
    
    const leaveIndex = leaveRecords.findIndex(record => record.id === leaveId);
    if (leaveIndex === -1) return;
    
    const leave = leaveRecords[leaveIndex];
    const employee = employees.find(emp => emp.id === leave.employeeId);
    const currentUserName = sessionStorage.getItem('userName') || localStorage.getItem('userName');
    
    // 본인 휴가가 아니면 매니저 이상 권한 필요
    if (employee && employee.name !== currentUserName) {
        if (!checkPermission('manager')) {
            showNoPermissionAlert('다른 직원의 휴가 취소');
            closeLeaveCancelModal();
            return;
        }
    }
    
    if (employee) {
        // 휴가 복구
        if (leave.type === 'annual') {
            employee.usedAnnual -= leave.days;
            employee.usedAnnual = Math.max(0, employee.usedAnnual); // 음수 방지
        } else {
            employee.usedMonthly -= leave.days;
            employee.usedMonthly = Math.max(0, employee.usedMonthly); // 음수 방지
        }
    }
    
    // 휴가 기록 삭제
    leaveRecords.splice(leaveIndex, 1);
    saveData();
    
    // UI 업데이트
    renderEmployeeSummary();
    renderCalendar();
    
    alert('휴가가 취소되었습니다.');
    closeLeaveCancelModal();
}

// Firebase 초기화
function initializeFirebase() {
    try {
        if (typeof firebase !== 'undefined') {
            firebase_app = firebase.initializeApp(firebaseConfig);
            database = firebase.database();
            isFirebaseEnabled = true;
            console.log('Firebase 초기화 성공');
            
            // Firebase에서 토큰 실시간 로드
            loadTokensFromFirebase();
        } else {
            console.log('Firebase를 사용할 수 없습니다. 로컬 저장소를 사용합니다.');
        }
    } catch (error) {
        console.log('Firebase 초기화 실패:', error);
        isFirebaseEnabled = false;
    }
}

// 최초 토큰 로드 완료 대기
function waitForInitialTokensLoad(timeoutMs = 3000) {
    return new Promise((resolve) => {
        if (!isFirebaseEnabled) {
            resolve();
            return;
        }
        
        let done = false;
        const finish = () => { 
            if (!done) { 
                done = true; 
                resolve(); 
            } 
        };
        
        // 첫 value 이벤트로 토큰을 메모리에 반영한 다음 resolve
        const tokensRef = database.ref('tokens');
        const onceHandler = tokensRef.on('value', () => {
            tokensRef.off('value', onceHandler);
            finish();
        });
        
        // 타임아웃 보조
        setTimeout(finish, timeoutMs);
    });
}

// Firebase에서 토큰 실시간 로드
function loadTokensFromFirebase() {
    if (!isFirebaseEnabled) return;
    
    try {
        const tokensRef = database.ref('tokens');
        
        // 실시간 리스너 설정
        tokensRef.on('value', (snapshot) => {
            const firebaseTokens = snapshot.val() || {};
            
            // Firebase 토큰을 ACCESS_TOKENS에 병합
            Object.keys(firebaseTokens).forEach(token => {
                const tokenInfo = firebaseTokens[token];
                if (tokenInfo.status === 'active' && new Date(tokenInfo.expires) > new Date()) {
                    ACCESS_TOKENS[token] = {
                        name: tokenInfo.name,
                        role: tokenInfo.role,
                        expires: tokenInfo.expires
                    };
                }
            });
            
            console.log('Firebase에서 토큰 로드 완료:', Object.keys(ACCESS_TOKENS));
        });
        
    } catch (error) {
        console.log('Firebase 토큰 로드 실패:', error);
    }
}

// 토큰 기반 인증 체크
async function checkTokenAuthentication() {
    // 여러 방법으로 저장된 토큰 확인
    let savedToken = sessionStorage.getItem('accessToken') || 
                     localStorage.getItem('accessToken') ||
                     getCookie('accessToken') ||
                     await getFromIndexedDB('accessToken');
    
    if (savedToken && await isValidToken(savedToken)) {
        userToken = savedToken;
        // 토큰을 모든 저장소에 저장
        sessionStorage.setItem('accessToken', savedToken);
        localStorage.setItem('accessToken', savedToken);
        setCookie('accessToken', savedToken, 365); // 1년간 유지
        await saveToIndexedDB('accessToken', savedToken); // IndexedDB에도 저장
        
        // 사용자 정보도 복구
        const tokenInfo = ACCESS_TOKENS[savedToken];
        sessionStorage.setItem('userRole', tokenInfo.role);
        sessionStorage.setItem('userName', tokenInfo.name);
        localStorage.setItem('userRole', tokenInfo.role);
        localStorage.setItem('userName', tokenInfo.name);
        
        startRealTimeSync();
        return true;
    }
    
    // 토큰 입력 UI 표시
    showTokenAuthenticationModal();
    return false;
}

// 토큰 유효성 검사 (Firebase DB 기준)
async function isValidToken(token) {
    // 1) 메모리에서 빠르게 시도
    let info = ACCESS_TOKENS[token];
    
    // 2) 메모리에 없으면 Firebase DB 직접 조회
    if (!info && isFirebaseEnabled) {
        try {
            const dbSnap = await database.ref(`tokens/${token}`).once('value');
            const data = dbSnap.val();
            if (data) {
                info = data;
                // 메모리 캐시에도 채워줌
                ACCESS_TOKENS[token] = { 
                    name: data.name, 
                    role: data.role, 
                    expires: data.expires 
                };
                console.log('Firebase에서 토큰 정보 로드:', token);
            }
        } catch (error) {
            console.log('Firebase 토큰 조회 실패:', error);
        }
    }
    
    // 3) 로컬 데이터베이스에서도 확인 (Firebase 실패 시)
    if (!info) {
        try {
            const tokenDatabase = JSON.parse(localStorage.getItem('tokenDatabase') || '{}');
            if (tokenDatabase[token]) {
                const dbTokenInfo = tokenDatabase[token];
                if (dbTokenInfo.status === 'active' && new Date(dbTokenInfo.expires) > new Date()) {
                    ACCESS_TOKENS[token] = {
                        name: dbTokenInfo.name,
                        role: dbTokenInfo.role,
                        expires: dbTokenInfo.expires
                    };
                    info = ACCESS_TOKENS[token];
                }
            }
        } catch (error) {
            console.log('로컬 토큰 데이터베이스 확인 실패:', error);
        }
    }
    
    if (!info) return false;
    
    // 만료일 및 상태 체크
    return (info.status ? info.status === 'active' : true) &&
           (new Date(info.expires) >= new Date());
}

// 토큰 인증 모달 표시
function showTokenAuthenticationModal() {
    const authModal = document.createElement('div');
    authModal.id = 'tokenAuthModal';
    authModal.className = 'modal';
    authModal.style.display = 'block';
    
    authModal.innerHTML = `
        <div class="modal-content" style="max-width: 500px; text-align: center;">
            <h3>🔐 휴가 관리 시스템 접근 인증</h3>
            <div style="margin: 20px 0;">
                <p><strong>관리자가 발급한 고유 접근 토큰을 입력하세요.</strong></p>
                <p style="font-size: 12px; color: #666; margin: 10px 0;">
                    토큰이 없으시면 시스템 관리자에게 문의하세요.
                </p>
                <input type="text" id="accessTokenInput" placeholder="예: USR-2025-HR-001" 
                       style="width: 100%; padding: 12px; margin: 15px 0; border: 1px solid #ddd; border-radius: 5px; font-family: monospace;">
                <div id="tokenError" style="color: red; margin: 10px 0; display: none;">
                    유효하지 않은 토큰입니다.
                </div>
                <div style="background: #f0f8ff; padding: 15px; border-radius: 5px; margin: 15px 0; text-align: left;">
                    <strong>📋 테스트용 토큰들:</strong><br>
                    <code style="background: #fff; padding: 2px 5px; margin: 2px;">USR-2025-HR-001</code> (HR 관리자)<br>
                    <code style="background: #fff; padding: 2px 5px; margin: 2px;">USR-2025-MGR-002</code> (부서 매니저)<br>
                    <code style="background: #fff; padding: 2px 5px; margin: 2px;">USR-2025-EMP-003</code> (일반 직원)
                </div>
            </div>
            <div class="modal-buttons">
                <button onclick="attemptTokenAuthentication()">인증</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(authModal);
    
    // Enter 키로 로그인
    document.getElementById('accessTokenInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            attemptTokenAuthentication();
        }
    });
    
    // 포커스
    setTimeout(() => {
        document.getElementById('accessTokenInput').focus();
    }, 100);
}

// 토큰 인증 시도
async function attemptTokenAuthentication() {
    const token = document.getElementById('accessTokenInput').value.trim();
    const errorDiv = document.getElementById('tokenError');
    
    if (await isValidToken(token)) {
        // 인증 성공
        const tokenInfo = ACCESS_TOKENS[token];
        // 모든 저장소에 저장 (최대한 안정적인 유지)
        sessionStorage.setItem('accessToken', token);
        sessionStorage.setItem('userRole', tokenInfo.role);
        sessionStorage.setItem('userName', tokenInfo.name);
        localStorage.setItem('accessToken', token);
        localStorage.setItem('userRole', tokenInfo.role);
        localStorage.setItem('userName', tokenInfo.name);
        setCookie('accessToken', token, 365); // 1년간 유지
        await saveToIndexedDB('accessToken', token); // IndexedDB에도 저장
        
        userToken = token;
        
        // 토큰 사용 로그 기록
        logTokenUsage(token);
        
        // 인증 모달 제거
        document.getElementById('tokenAuthModal').remove();
        
        // 메인 앱 시작
        await initializeApp();
        
        alert(`인증되었습니다. ${tokenInfo.name}님, 휴가 관리 시스템에 오신 것을 환영합니다!`);
    } else {
        // 인증 실패
        errorDiv.style.display = 'block';
        document.getElementById('accessTokenInput').value = '';
        document.getElementById('accessTokenInput').focus();
    }
}

// 사용자 역할 결정
function getUserRole(password) {
    if (password === 'hr_admin') return 'admin';
    if (password === 'manager_key') return 'manager';
    return 'user';
}

// UI 권한 설정
function setupUIPermissions() {
    const userRole = sessionStorage.getItem('userRole') || localStorage.getItem('userRole');
    const userName = sessionStorage.getItem('userName') || localStorage.getItem('userName');
    
    // 직원 추가 폼은 매니저 이상만 표시
    const addEmployeeDiv = document.querySelector('.add-employee');
    if (addEmployeeDiv) {
        if (!checkPermission('manager')) {
            addEmployeeDiv.style.display = 'none';
        }
    }
    
    // 사용자 정보 표시
    const header = document.querySelector('header h1');
    if (header && userName) {
        const roleText = userRole === 'admin' ? '관리자' : 
                        userRole === 'manager' ? '매니저' : '사용자';
        header.textContent = `휴가 관리 시스템 - ${userName} (${roleText})`;
    }
}

// 휴가/직원 데이터 실시간 구독 (충돌 방지)
function subscribeRealtimeData() {
    if (!isFirebaseEnabled || isRealtimeSubscribed) return;
    
    isRealtimeSubscribed = true; // 중복 구독 방지
    console.log('🔥 실시간 구독 시작');

    // 직원 리스트 실시간 반영 (개별 방식)
    database.ref('employees').on('value', (snap) => {
        const firebaseEmployees = snap.val();
        if (firebaseEmployees) {
            try {
                // 안전한 배열 변환
                let newEmployees;
                if (Array.isArray(firebaseEmployees)) {
                    newEmployees = firebaseEmployees;
                } else {
                    newEmployees = Object.values(firebaseEmployees);
                }
                
                // 완전히 교체 (중복 방지)
                employees = [...newEmployees];
                
                // 배열인지 확인 후 처리
                if (Array.isArray(employees) && employees.length > 0) {
                    employees.forEach(emp => calculateEmployeeLeaves(emp));
                    renderEmployeeSummary();
                    updateModalEmployeeDropdown();
                    renderCalendar();
                    console.log('🔥 직원 데이터 실시간 업데이트 (중복 방지)');
                }
            } catch (error) {
                console.log('직원 데이터 실시간 업데이트 실패:', error);
            }
        }
    });

    // 휴가 레코드 실시간 반영 (개별 방식)
    database.ref('leaveRecords').on('value', (snap) => {
        const firebaseRecords = snap.val();
        if (firebaseRecords) {
            try {
                // 안전한 배열 변환 및 유효한 기록만 필터링
                let newRecords;
                if (Array.isArray(firebaseRecords)) {
                    newRecords = firebaseRecords;
                } else {
                    newRecords = Object.values(firebaseRecords).filter(record => 
                        record && record.id && !record.id.toString().includes('.')
                    );
                }
                
                // 완전히 교체 (중복 방지)
                leaveRecords = [...newRecords];
                
                renderEmployeeSummary();
                renderCalendar();
                console.log('🔥 휴가 데이터 실시간 업데이트 (중복 방지):', leaveRecords.length + '개');
            } catch (error) {
                console.log('휴가 데이터 실시간 업데이트 실패:', error);
            }
        }
    });
}

// 메인 앱 초기화
async function initializeApp() {
    await loadData(); // Firebase에서 데이터 로드
    updateCurrentTime();
    setInterval(updateCurrentTime, 1000);
    renderCalendar();
    renderEmployeeSummary();
    updateModalEmployeeDropdown();
    startRealTimeSync();
    subscribeRealtimeData(); // ★ 추가: 다른 PC 변경 즉시 반영
    setupUIPermissions(); // UI 권한 설정
    
    // 매일 자정에 연차/월차 자동 계산
    setInterval(calculateLeaves, 60000);
}

// 실시간 동기화 시작
function startRealTimeSync() {
    // 5초마다 다른 사용자의 변경사항 체크
    syncInterval = setInterval(() => {
        syncWithOtherUsers();
    }, 5000);
}

// 다른 사용자와 동기화
function syncWithOtherUsers() {
    // localStorage에 마지막 업데이트 시간 저장
    const lastUpdate = localStorage.getItem('lastUpdate') || '0';
    
    // 다른 창에서 업데이트가 있었는지 확인
    const otherUpdate = localStorage.getItem('lastUpdate');
    if (otherUpdate && otherUpdate !== lastUpdate) {
        // 데이터 다시 로드
        loadData();
        renderCalendar();
        renderEmployeeSummary();
        updateModalEmployeeDropdown();
    }
    
    // 토큰 업데이트 신호 확인
    const tokenUpdateSignal = localStorage.getItem('tokenUpdateSignal');
    const lastTokenUpdate = sessionStorage.getItem('lastTokenUpdate') || '0';
    
    if (tokenUpdateSignal && tokenUpdateSignal !== lastTokenUpdate) {
        // 토큰 목록 다시 로드
        loadActiveTokens();
        sessionStorage.setItem('lastTokenUpdate', tokenUpdateSignal);
        console.log('토큰 목록이 업데이트되었습니다.');
    }
}

// 토큰 사용 로그 기록
function logTokenUsage(token) {
    try {
        const tokenDatabase = JSON.parse(localStorage.getItem('tokenDatabase') || '{}');
        if (tokenDatabase[token]) {
            tokenDatabase[token].lastUsed = new Date().toISOString();
            localStorage.setItem('tokenDatabase', JSON.stringify(tokenDatabase));
        }
    } catch (error) {
        console.log('토큰 사용 로그 기록 실패:', error);
    }
}

// 쿠키 설정 함수
function setCookie(name, value, days) {
    try {
        const expires = new Date();
        expires.setTime(expires.getTime() + (days * 24 * 60 * 60 * 1000));
        document.cookie = `${name}=${value};expires=${expires.toUTCString()};path=/;SameSite=Lax`;
    } catch (error) {
        console.log('쿠키 설정 실패:', error);
    }
}

// 쿠키 가져오기 함수
function getCookie(name) {
    try {
        const nameEQ = name + "=";
        const ca = document.cookie.split(';');
        for (let i = 0; i < ca.length; i++) {
            let c = ca[i];
            while (c.charAt(0) === ' ') c = c.substring(1, c.length);
            if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
        }
        return null;
    } catch (error) {
        console.log('쿠키 읽기 실패:', error);
        return null;
    }
}

// 쿠키 삭제 함수
function deleteCookie(name) {
    try {
        document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/;`;
    } catch (error) {
        console.log('쿠키 삭제 실패:', error);
    }
}

// IndexedDB에 데이터 저장
async function saveToIndexedDB(key, value) {
    try {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('LeaveManagementDB', 1);
            
            request.onerror = () => reject(request.error);
            
            request.onsuccess = () => {
                const db = request.result;
                const transaction = db.transaction(['tokens'], 'readwrite');
                const store = transaction.objectStore('tokens');
                store.put({ key: key, value: value });
                
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            };
            
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('tokens')) {
                    db.createObjectStore('tokens', { keyPath: 'key' });
                }
            };
        });
    } catch (error) {
        console.log('IndexedDB 저장 실패:', error);
    }
}

// IndexedDB에서 데이터 가져오기
async function getFromIndexedDB(key) {
    try {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('LeaveManagementDB', 1);
            
            request.onerror = () => resolve(null);
            
            request.onsuccess = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('tokens')) {
                    resolve(null);
                    return;
                }
                
                const transaction = db.transaction(['tokens'], 'readonly');
                const store = transaction.objectStore('tokens');
                const getRequest = store.get(key);
                
                getRequest.onsuccess = () => {
                    resolve(getRequest.result ? getRequest.result.value : null);
                };
                getRequest.onerror = () => resolve(null);
            };
            
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('tokens')) {
                    db.createObjectStore('tokens', { keyPath: 'key' });
                }
                resolve(null);
            };
        });
    } catch (error) {
        console.log('IndexedDB 읽기 실패:', error);
        return null;
    }
}

// IndexedDB에서 데이터 삭제
async function deleteFromIndexedDB(key) {
    try {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('LeaveManagementDB', 1);
            
            request.onerror = () => resolve();
            
            request.onsuccess = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('tokens')) {
                    resolve();
                    return;
                }
                
                const transaction = db.transaction(['tokens'], 'readwrite');
                const store = transaction.objectStore('tokens');
                store.delete(key);
                
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => resolve();
            };
        });
    } catch (error) {
        console.log('IndexedDB 삭제 실패:', error);
    }
}

// 실시간 구독 해제
function unsubscribeRealtimeData() {
    if (isFirebaseEnabled && isRealtimeSubscribed) {
        try {
            database.ref('employees').off();
            database.ref('leaveRecords').off();
            isRealtimeSubscribed = false;
            console.log('실시간 구독 해제 완료');
        } catch (error) {
            console.log('구독 해제 실패:', error);
        }
    }
}

// 로그아웃 함수
async function logout() {
    if (confirm('로그아웃 하시겠습니까?')) {
        // 실시간 구독 해제
        unsubscribeRealtimeData();
        
        // 모든 저장소에서 제거
        sessionStorage.removeItem('accessToken');
        sessionStorage.removeItem('userRole');
        sessionStorage.removeItem('userName');
        localStorage.removeItem('accessToken');
        localStorage.removeItem('userRole');
        localStorage.removeItem('userName');
        deleteCookie('accessToken');
        await deleteFromIndexedDB('accessToken'); // IndexedDB에서도 삭제
        
        if (syncInterval) {
            clearInterval(syncInterval);
        }
        userToken = null;
        location.reload();
    }
}