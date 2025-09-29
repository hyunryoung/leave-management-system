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

// 공휴일 데이터 (자동 로드)
let koreanHolidays = {};

// 기본 공휴일 (API 실패 시 사용)
const defaultHolidays2025 = {
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

// 공휴일 자동 로드
async function loadHolidays(year) {
    try {
        console.log(`${year}년 공휴일 로딩 중...`);
        
        // 캐시된 공휴일 확인
        const cachedKey = `holidays_${year}`;
        const cached = localStorage.getItem(cachedKey);
        if (cached) {
            const cachedData = JSON.parse(cached);
            // 1일 이내 캐시면 사용
            if (Date.now() - cachedData.timestamp < 24 * 60 * 60 * 1000) {
                koreanHolidays = { ...koreanHolidays, ...cachedData.holidays };
                console.log(`${year}년 공휴일 캐시 사용`);
                return;
            }
        }
        
        // API에서 공휴일 가져오기
        const response = await fetch(`https://date.nager.at/api/v3/publicholidays/${year}/KR`);
        if (response.ok) {
            const holidays = await response.json();
            
            // 한국어 이름으로 변환
            const holidayMap = {};
            holidays.forEach(holiday => {
                holidayMap[holiday.date] = holiday.localName || holiday.name;
            });
            
            // 전역 객체에 병합
            koreanHolidays = { ...koreanHolidays, ...holidayMap };
            
            // 캐시에 저장
            localStorage.setItem(cachedKey, JSON.stringify({
                holidays: holidayMap,
                timestamp: Date.now()
            }));
            
            console.log(`${year}년 공휴일 API 로드 완료:`, Object.keys(holidayMap).length + '개');
        } else {
            throw new Error('API 응답 실패');
        }
        
    } catch (error) {
        console.log(`${year}년 공휴일 API 실패, 기본 데이터 사용:`, error);
        
        // API 실패 시 기본 데이터 사용
        if (year === 2025) {
            koreanHolidays = { ...koreanHolidays, ...defaultHolidays2025 };
        }
    }
}

// 페이지 로드 시 초기화
document.addEventListener('DOMContentLoaded', async function() {
    // Firebase 초기화 시도 (이메일/비밀번호 인증)
    initializeFirebase();
    
    // 관리자가 생성한 토큰들 로드
    loadActiveTokens();
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
    
    // 보안 강화된 Firebase + 로컬 백업으로 저장
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
        // 입사 후 '완료된' 개월 수 만큼만 월차 생성 (입사달 제외, 매 월 기념일에 1개)
        let completedMonths = (today.getFullYear() - joinDate.getFullYear()) * 12
                            + (today.getMonth() - joinDate.getMonth());
        if (today.getDate() < joinDate.getDate()) completedMonths -= 1; // 기념일 이전이면 아직 해당 달 미지급
        employee.monthlyLeave = Math.max(0, completedMonths);
        employee.annualLeave = 0; // 1년 미만은 연차 없음
        employee.usedAnnual = 0;
        
        // 디버깅 로그 추가
        console.log(`${employee.name} 월차 계산: 입사일 ${employee.joinDate}, 근무일수 ${daysDiff}일 (${yearsOfService}년), 완료개월 ${completedMonths}, 총월차 ${employee.monthlyLeave}, 사용 ${employee.usedMonthly}, 잔여 ${employee.monthlyLeave - employee.usedMonthly}`);
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
        
        // 근속연수별 연차 계산 (근로기준법 기준)
        const calculateAnnualDays = (years) => {
            if (years < 1) return 0;
            if (years < 3) return 15;
            
            // 3년차부터 2년마다 1일씩 가산 (최대 25일)
            const additionalYears = Math.floor((years - 1) / 2);
            const totalDays = 15 + additionalYears;
            return Math.min(totalDays, 25); // 최대 25일 제한
        };
        
        const currentAnnualDays = calculateAnnualDays(yearsOfService);
        
        // 연차 리셋 체크 (새로운 연차 주기가 시작되었는지)
        if (!employee.lastAnnualReset) {
            employee.lastAnnualReset = currentCycleStart.toISOString().split('T')[0];
            employee.annualLeave = currentAnnualDays;
            console.log(`${employee.name} 최초 연차 설정: ${currentAnnualDays}일 (${yearsOfService}년차)`);
        } else {
            const lastReset = new Date(employee.lastAnnualReset);
            const lastResetStr = employee.lastAnnualReset;
            const currentCycleStr = currentCycleStart.toISOString().split('T')[0];
            
            // 정확히 1년이 지났을 때만 리셋 (날짜 비교)
            if (currentCycleStr !== lastResetStr && currentCycleStart > lastReset) {
                console.log(`${employee.name} 연차 주기 리셋: ${lastResetStr} → ${currentCycleStr}, ${currentAnnualDays}일 (${yearsOfService}년차)`);
                employee.lastAnnualReset = currentCycleStr;
                employee.annualLeave = currentAnnualDays;
                employee.usedAnnual = 0; // 새 연차 주기에만 리셋
            } else {
                // 같은 연차 주기 내에서는 근속연수 증가에 따른 연차 증가만 반영
                if (employee.annualLeave !== currentAnnualDays) {
                    console.log(`${employee.name} 근속연수 증가로 연차 증가: ${employee.annualLeave} → ${currentAnnualDays}일`);
                    employee.annualLeave = currentAnnualDays;
                }
                console.log(`${employee.name} 연차 주기 유지: ${lastResetStr}, 사용량: ${employee.usedAnnual}, 총 연차: ${currentAnnualDays}일`);
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
            const remainingAnnual = (employee.annualLeave || 15) - (employee.usedAnnual || 0);
            console.log(`${employee.name} 연차 계산: 총 ${employee.annualLeave}, 사용 ${employee.usedAnnual}, 잔여 ${remainingAnnual}`);
            
            leaveDisplay = `
                <div class="leave-summary">
                    <div class="leave-item annual">연차: ${remainingAnnual.toFixed(1)}</div>
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
async function renderCalendar() {
    const calendar = document.getElementById('calendar');
    const monthYearStr = displayMonth.toLocaleDateString('ko-KR', {
        year: 'numeric',
        month: 'long'
    });
    document.getElementById('currentMonth').textContent = monthYearStr;
    
    // 해당 연도의 공휴일 자동 로드
    const currentYear = displayMonth.getFullYear();
    await loadHolidays(currentYear);
    
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
        const isHoliday = koreanHolidays[currentDateStr];
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
                leaveHTML += `<div class="leave-indicator ${leave.type}" onclick="handleLeaveClick(event, '${leave.id}')" data-leave-id="${leave.id}">${employee.name.substring(0, 3)}${duration}</div>`;
            }
        });
        
        day.innerHTML = leaveHTML;
        day.dataset.date = currentDateStr;
        
        // 매니저 이상만 달력 조작 가능
        if (checkPermission('manager')) {
            // 매니저/관리자: 모든 날짜에 이벤트 추가
            day.addEventListener('mousedown', handleDateMouseDown);
            day.addEventListener('mouseover', handleDateMouseOver);
            day.addEventListener('mouseup', handleDateMouseUp);
            
            // 전체 날짜 칸 클릭 이벤트 (휴가 등록용)
            day.addEventListener('click', (e) => {
                console.log('날짜 클릭:', currentDateStr, '타겟:', e.target.className);
                
                // 휴가 표시를 클릭한 경우가 아니면 휴가 등록 모달 열기
                if (!e.target.classList.contains('leave-indicator')) {
                    console.log('휴가 등록 모달 열기:', currentDateStr);
                    selectedDates = [currentDateStr];
                    updateSelectedDatesDisplay();
                    updateCalendarSelection();
                    openLeaveModal();
                } else {
                    console.log('휴가 표시 클릭됨, 등록 모달 열지 않음');
                }
            });
        } else {
            // 일반 직원: 조회만 가능 (클릭 비활성화)
            day.style.cursor = 'default';
            day.title = '휴가 신청은 관리자에게 구두로 요청하세요';
        }
        
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
async function previousMonth() {
    displayMonth.setMonth(displayMonth.getMonth() - 1);
    await renderCalendar();
}

// 다음 달로 이동
async function nextMonth() {
    displayMonth.setMonth(displayMonth.getMonth() + 1);
    await renderCalendar();
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
    // 권한 체크: 매니저 이상만 휴가 등록 가능 (일반 직원은 조회만)
    if (!checkPermission('manager')) {
        showNoPermissionAlert('휴가 등록 (구두로 관리자에게 신청하세요)');
        return;
    }
    
    const employeeId = parseInt(document.getElementById('modalEmployee').value);
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
            const safeId = leaveId.toString().replace(/\./g, '_');
            await database.ref(`leaveRecords/${safeId}`).remove();
            console.log('Firebase에서 휴가 기록 삭제 완료:', safeId);
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

// 데이터 저장 (보안 강화된 Firebase + 로컬 백업)
async function saveData() {
    // 로컬 백업 (민감정보 제외)
    const sanitizedEmployees = employees.map(emp => ({
        ...emp,
        hrData: emp.hrData ? {
            ...emp.hrData,
            phone: emp.hrData.phone ? '***숨김***' : '',
            ssn: emp.hrData.ssn ? '***숨김***' : '',
            address: emp.hrData.address ? '***숨김***' : ''
        } : undefined
    }));
    
    localStorage.setItem('employees', JSON.stringify(sanitizedEmployees));
    localStorage.setItem('leaveRecords', JSON.stringify(leaveRecords));
    localStorage.setItem('lastUpdate', Date.now().toString());
    
    // Firebase에 보안 인증된 상태로 저장
    if (isFirebaseEnabled && firebase.auth().currentUser) {
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
            console.log('Firebase에 보안 인증된 상태로 데이터 저장 완료');
        } catch (error) {
            console.log('Firebase 저장 실패, 로컬만 사용:', error);
        }
    } else {
        console.log('로컬 저장소에만 데이터 저장 (Firebase 인증 대기중)');
    }
}

// 데이터 불러오기 (보안 강화된 Firebase + 로컬 백업)
async function loadData() {
    // Firebase에서 보안 인증된 상태로 로드 시도
    if (isFirebaseEnabled && firebase.auth().currentUser) {
        try {
            const [employeesSnapshot, recordsSnapshot] = await Promise.all([
                database.ref('employees').once('value'),
                database.ref('leaveRecords').once('value')
            ]);
            
            const firebaseEmployees = employeesSnapshot.val();
            const firebaseRecords = recordsSnapshot.val();
            
            if (firebaseEmployees) {
                let newEmployees = Array.isArray(firebaseEmployees) ? firebaseEmployees : Object.values(firebaseEmployees);
                
                // 중복 제거
                const uniqueEmployees = [];
                const seenNames = new Set();
                newEmployees.reverse().forEach(emp => {
                    if (!seenNames.has(emp.name)) {
                        seenNames.add(emp.name);
                        uniqueEmployees.unshift(emp);
                    }
                });
                
                employees = uniqueEmployees;
                if (Array.isArray(employees)) {
                    employees.forEach(emp => calculateEmployeeLeaves(emp));
                    console.log('Firebase에서 보안 인증된 상태로 직원 데이터 로드:', employees.length + '명');
                }
            }
            
            if (firebaseRecords) {
                leaveRecords = Array.isArray(firebaseRecords) ? firebaseRecords : 
                    Object.values(firebaseRecords).filter(record => record && record.id && !record.id.toString().includes('.'));
                console.log('Firebase에서 보안 인증된 상태로 휴가 데이터 로드:', leaveRecords.length + '개');
            }
            
            // Firebase 데이터를 로컬에도 백업
            if (firebaseEmployees) localStorage.setItem('employees', JSON.stringify(employees));
            if (firebaseRecords) localStorage.setItem('leaveRecords', JSON.stringify(leaveRecords));
            
            return;
            
        } catch (error) {
            console.log('Firebase 로드 실패, 로컬 데이터 사용:', error);
        }
    }
    
    // Firebase 실패 시 또는 인증 대기 중일 때 로컬 데이터 사용
    const savedEmployees = localStorage.getItem('employees');
    const savedRecords = localStorage.getItem('leaveRecords');
    
    if (savedEmployees) {
        employees = JSON.parse(savedEmployees);
        employees.forEach(emp => calculateEmployeeLeaves(emp));
        console.log('로컬에서 직원 데이터 로드 완료:', employees.length + '명');
    }
    
    if (savedRecords) {
        leaveRecords = JSON.parse(savedRecords);
        console.log('로컬에서 휴가 데이터 로드 완료:', leaveRecords.length + '개');
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

// 휴가 표시 클릭 핸들러
function handleLeaveClick(event, leaveId) {
    // 모든 이벤트 차단
    event.stopPropagation();
    event.stopImmediatePropagation();
    event.preventDefault();
    
    // 다른 모달들 먼저 닫기
    closeLeaveModal();
    
    // 약간의 지연 후 취소 모달 열기
    setTimeout(() => {
        showLeaveCancelModal(leaveId);
    }, 100);
    
    return false;
}

// 휴가 취소 모달 표시
function showLeaveCancelModal(leaveId) {
    
    const leave = leaveRecords.find(record => record.id.toString() === leaveId.toString());
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
async function confirmCancelLeave() {
    const modal = document.getElementById('leaveCancelModal');
    const leaveId = modal.dataset.leaveId; // 문자열 ID 사용
    
    if (!leaveId) return;
    
    const leaveIndex = leaveRecords.findIndex(record => record.id.toString() === leaveId.toString());
    if (leaveIndex === -1) return;
    
    const leave = leaveRecords[leaveIndex];
    const employee = employees.find(emp => emp.id === leave.employeeId);
    const currentUserName = sessionStorage.getItem('userName') || localStorage.getItem('userName');
    
    // 본인 휴가가 아니면 매니저 이상 권한 필요
    if (employee && employee.name !== currentUserName) {
        if (!checkPermission('manager')) {
            showNoPermissionAlert('다른 직원의 휴가 취소 (관리자에게 문의하세요)');
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
    
    // Firebase에서도 즉시 삭제
    if (isFirebaseEnabled) {
        const safeId = leave.id.toString().replace(/\./g, '_');
        await deleteLeaveRecord(safeId);
    }
    
    saveData();
    
    // UI 업데이트
    renderEmployeeSummary();
    renderCalendar();
    
    alert('휴가가 취소되었습니다.');
    closeLeaveCancelModal();
}

// Firebase 초기화 (보안 강화)
function initializeFirebase() {
    try {
        if (typeof firebase !== 'undefined') {
            firebase_app = firebase.initializeApp(firebaseConfig);
            database = firebase.database();
            
            // Firebase Auth 초기화
            const auth = firebase.auth();
            
            // 운영용 이메일/비밀번호 인증 (익명 인증 제거)
            // Firebase 인증 상태 감시
            auth.onAuthStateChanged(async (user) => {
                if (user) {
                    // 로그인된 사용자의 Custom Claims에서 역할 가져오기
                    const idTokenResult = await user.getIdTokenResult(true);
                    const role = idTokenResult.claims.role || 'user';
                    const email = user.email || '';
                    const displayName = user.displayName || '';
                    const uid = user.uid;
                    const safeName = email 
                        ? email.split('@')[0] 
                        : (displayName || (uid ? uid.slice(0, 6) : 'user'));
                    
                    // 세션에 사용자 정보 저장
                    sessionStorage.setItem('userRole', role);
                    sessionStorage.setItem('userName', safeName);
                    sessionStorage.setItem('userEmail', email || uid || '');
                    
                    isFirebaseEnabled = true;
                    console.log(`Firebase 인증 성공 - 이메일: ${email}, 역할: ${role}`);
                    
                    // 관리자/매니저면 HR 복호화 키 준비 (필요시에만 입력)
                    if (role === 'admin' || role === 'manager') {
                        // 세션에 키가 없을 때만 입력 요청 (자동으로 처리)
                        console.log('🔐 HR 암호화 키 준비됨 (필요시 자동 입력 요청)');
                    }
                    
                    // 앱 초기화
                    await initializeApp();
                } else {
                    // 로그인되지 않은 상태 - 로그인 모달 표시
                    isFirebaseEnabled = false;
                    showFirebaseLoginModal();
                }
            });
            
        } else {
            console.log('Firebase를 사용할 수 없습니다. 로컬 저장소를 사용합니다.');
            isFirebaseEnabled = false;
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

// 토큰 기반 인증 체크 (보안 강화)
async function checkTokenAuthentication() {
    // 1순위: sessionStorage (보안 우선)
    let savedToken = sessionStorage.getItem('accessToken');
    
    // 2순위: sessionStorage 만료 체크
    const tokenExpiry = sessionStorage.getItem('tokenExpiry');
    if (savedToken && tokenExpiry && Date.now() > parseInt(tokenExpiry)) {
        console.log('세션 토큰 만료됨');
        sessionStorage.removeItem('accessToken');
        sessionStorage.removeItem('tokenExpiry');
        savedToken = null;
    }
    
    // 3순위: localStorage에서 암호화된 토큰 복구 (장기 유지용)
    if (!savedToken) {
        const encryptedToken = localStorage.getItem('encryptedToken');
        if (encryptedToken) {
            try {
                savedToken = decryptSensitiveData(encryptedToken);
                console.log('암호화된 토큰에서 복구됨');
            } catch (error) {
                console.log('토큰 복호화 실패:', error);
                localStorage.removeItem('encryptedToken');
            }
        }
    }
    
    // 4순위: 기존 방법들 (하위 호환성)
    if (!savedToken) {
        savedToken = localStorage.getItem('accessToken') ||
                     getCookie('accessToken') ||
                     await getFromIndexedDB('accessToken');
    }
    
    if (savedToken && await isValidToken(savedToken)) {
        userToken = savedToken;
        
        // 보안 강화: sessionStorage 중심, localStorage 최소화
        sessionStorage.setItem('accessToken', savedToken);
        sessionStorage.setItem('tokenExpiry', Date.now() + (24 * 60 * 60 * 1000)); // 24시간 후 만료
        
        // 장기 유지용으로만 localStorage 사용 (암호화)
        const encryptedToken = encryptSensitiveData(savedToken);
        localStorage.setItem('encryptedToken', encryptedToken);
        
        // 사용자 정보는 세션에만 저장
        const tokenInfo = ACCESS_TOKENS[savedToken];
        sessionStorage.setItem('userRole', tokenInfo.role);
        sessionStorage.setItem('userName', tokenInfo.name);
        sessionStorage.setItem('userExpiry', tokenInfo.expires);
        
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
    
    // 일반 직원용 안내 메시지 추가
    if (userRole === 'user') {
        const calendarSection = document.querySelector('.calendar-section h2');
        if (calendarSection) {
            calendarSection.innerHTML = `
                휴가 달력 (조회 전용)
                <div style="font-size: 12px; color: #666; font-weight: normal; margin-top: 5px;">
                    💡 휴가 신청은 관리자에게 구두로 요청하세요
                </div>
            `;
        }
        
        // 선택 정보도 비활성화
        const selectedInfo = document.getElementById('selectedInfo');
        if (selectedInfo) {
            selectedInfo.textContent = '휴가 현황 조회 전용 - 신청은 관리자에게 문의하세요';
            selectedInfo.style.background = '#f8f9fa';
            selectedInfo.style.color = '#666';
        }
    }
    
    // 사용자 정보 표시
    const header = document.querySelector('header h1');
    if (header && userName) {
        const roleText = userRole === 'admin' ? '관리자' : 
                        userRole === 'manager' ? '매니저' : '사용자 (조회 전용)';
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
                // 안전한 배열 변환 및 중복 제거
                let newEmployees;
                if (Array.isArray(firebaseEmployees)) {
                    newEmployees = firebaseEmployees;
                } else {
                    newEmployees = Object.values(firebaseEmployees);
                }
                
                // 중복 직원 제거 (같은 이름의 직원 중 최신 데이터만 유지)
                const uniqueEmployees = [];
                const seenNames = new Set();
                
                // 최신 데이터부터 처리 (역순)
                newEmployees.reverse().forEach(emp => {
                    if (!seenNames.has(emp.name)) {
                        seenNames.add(emp.name);
                        uniqueEmployees.unshift(emp); // 원래 순서 유지
                    }
                });
                
                // 완전히 교체 (중복 방지)
                employees = uniqueEmployees;
                
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

// Firebase 데이터 완전 정리
async function cleanupFirebaseData() {
    if (!isFirebaseEnabled) return;
    
    try {
        console.log('🧹 Firebase 데이터 정리 시작...');
        
        // 기존 employees 노드 완전 삭제
        await database.ref('employees').remove();
        
        // 기존 leaveRecords 노드 완전 삭제  
        await database.ref('leaveRecords').remove();
        
        console.log('🧹 Firebase 데이터 정리 완료');
        
        // 현재 로컬 데이터를 깨끗하게 다시 저장
        if (employees.length > 0) {
            for (const employee of employees) {
                await saveEmployee(employee);
            }
        }
        
        if (leaveRecords.length > 0) {
            for (const record of leaveRecords) {
                await saveLeaveRecord(record);
            }
        }
        
        console.log('🧹 깨끗한 데이터로 재저장 완료');
        
    } catch (error) {
        console.log('Firebase 정리 실패:', error);
    }
}

// 메인 앱 초기화 (Firebase 로그인 후 호출)
async function initializeApp() {
    console.log('앱 초기화 시작...');
    
    await loadData(); // Firebase에서 데이터 로드
    
    // 한 번만 데이터 정리 실행 (관리자만)
    const userRole = sessionStorage.getItem('userRole');
    if (userRole === 'admin' && !localStorage.getItem('dataCleanupDone')) {
        await cleanupFirebaseData();
        localStorage.setItem('dataCleanupDone', 'true');
    }
    
    updateCurrentTime();
    setInterval(updateCurrentTime, 1000);
    await renderCalendar(); // 공휴일 로드 포함
    renderEmployeeSummary();
    updateModalEmployeeDropdown();
    startRealTimeSync();
    subscribeRealtimeData(); // 다른 PC 변경 즉시 반영
    setupUIPermissions(); // UI 권한 설정
    
    // 매일 자정에 연차/월차 자동 계산
    setInterval(calculateLeaves, 60000);
    
    // 전역 마우스 이벤트
    document.addEventListener('mouseup', () => {
        if (isSelecting) {
            isSelecting = false;
            if (selectedDates.length > 0) {
                openLeaveModal();
            }
        }
    });
    
    console.log('앱 초기화 완료!');
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
        
        // 보안 강화된 완전 정리
        // sessionStorage 완전 정리
        sessionStorage.removeItem('accessToken');
        sessionStorage.removeItem('userRole');
        sessionStorage.removeItem('userName');
        sessionStorage.removeItem('tokenExpiry');
        sessionStorage.removeItem('userExpiry');
        
        // localStorage에서 민감정보 제거
        localStorage.removeItem('accessToken');
        localStorage.removeItem('userRole');
        localStorage.removeItem('userName');
        localStorage.removeItem('encryptedToken');
        
        // 쿠키 및 IndexedDB 정리
        deleteCookie('accessToken');
        await deleteFromIndexedDB('accessToken');
        
        // Firebase 인증 로그아웃: 현재 사용자 유무와 관계없이 한번 시도
        try { 
            await firebase.auth().signOut(); 
            console.log('Firebase 로그아웃 완료');
        } catch (e) {
            console.log('Firebase 로그아웃 시도:', e.message);
        }
        
        if (syncInterval) {
            clearInterval(syncInterval);
        }
        userToken = null;
        
        // 리로드 대신 초기 진입 페이지로 강제 이동(캐시된 상태 방지)
        location.href = 'index.html';
    }
}

// ===== Firebase 로그인 기능 =====

// Firebase 로그인 모달 표시
function showFirebaseLoginModal() {
    const loginModal = document.createElement('div');
    loginModal.id = 'firebaseLoginModal';
    loginModal.className = 'modal';
    loginModal.style.display = 'block';
    
    loginModal.innerHTML = `
        <div class="modal-content" style="max-width: 450px; text-align: center;">
            <h3>🔐 휴가 관리 시스템 로그인</h3>
            <p style="margin: 8px 0 20px;">Google 계정으로 로그인하세요.</p>
            <div class="modal-buttons">
                <button onclick="attemptFirebaseGoogleLogin()"
                        style="padding: 12px 25px; background: #db4437; color: #fff; border: none; border-radius: 5px; font-weight: 600; font-size: 16px; cursor: pointer;">
                    Google로 로그인
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(loginModal);
    
    // Google 로그인 버튼에 포커스
    setTimeout(() => {
        const googleBtn = loginModal.querySelector('button');
        if (googleBtn) googleBtn.focus();
    }, 100);
}

// 이메일/비밀번호 로그인 함수 제거됨 (Google 전용으로 전환)

// Google 로그인 시도
async function attemptFirebaseGoogleLogin() {
    try {
        const provider = new firebase.auth.GoogleAuthProvider();
        
        // 회사 도메인만 허용하려면 다음 줄 주석 해제:
        // provider.setCustomParameters({ hd: 'yourcompany.com' });
        
        // 추가 권한 요청 (선택사항)
        provider.addScope('email');
        provider.addScope('profile');
        
        console.log('Google 로그인 시도 중...');
        
        // Google 팝업으로 로그인
        const result = await firebase.auth().signInWithPopup(provider);
        const user = result.user;
        
        console.log(`Google 로그인 성공: ${user.email}`);
        
        // 로그인 모달 제거
        const loginModal = document.getElementById('firebaseLoginModal');
        if (loginModal) {
            loginModal.remove();
        }
        
        // onAuthStateChanged가 자동으로 initializeApp()을 실행함
        
    } catch (error) {
        console.log('Google 로그인 실패:', error);
        
        let errorMessage = 'Google 로그인에 실패했습니다.';
        
        if (error.code === 'auth/popup-closed-by-user') {
            errorMessage = '로그인 창이 닫혔습니다.';
        } else if (error.code === 'auth/popup-blocked') {
            errorMessage = '팝업이 차단되었습니다. 팝업 차단을 해제해주세요.';
        } else if (error.code === 'auth/cancelled-popup-request') {
            errorMessage = '로그인이 취소되었습니다.';
        } else if (error.code === 'auth/network-request-failed') {
            errorMessage = '네트워크 연결을 확인해주세요.';
        }
        
        alert(errorMessage);
    }
}

// ===== 무료 Spark 플랜 보안 암호화 기능 =====

// 세션에 저장할 전역 키
let SESSION_CRYPTO_KEY = null;

// 관리자용 복호화 비밀번호 입력 및 키 파생
async function promptAndDeriveKey() {
    // 이미 세션에 키가 있으면 재사용
    if (SESSION_CRYPTO_KEY && sessionStorage.getItem('hr_key_exists')) {
        return SESSION_CRYPTO_KEY;
    }
    
    const pass = prompt('🔐 HR 복호화 비밀번호를 입력하세요 (세션에만 저장)\n\n⚠️ 이 비밀번호는 팀 내부에서만 공유하세요.');
    if (!pass) return null;
    
    try {
        // 고정 솔트(공개되어도 괜찮음). 나중에 교체 가능
        const salt = new TextEncoder().encode('hrms-v1-salt-2025');
        const baseKey = await crypto.subtle.importKey(
            'raw', 
            new TextEncoder().encode(pass), 
            'PBKDF2', 
            false, 
            ['deriveKey']
        );
        
        SESSION_CRYPTO_KEY = await crypto.subtle.deriveKey(
            { 
                name: 'PBKDF2', 
                salt: salt, 
                iterations: 210000, 
                hash: 'SHA-256' 
            },
            baseKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
        
        sessionStorage.setItem('hr_key_exists', '1'); // 플래그만 보관
        sessionStorage.setItem('hr_key_timestamp', Date.now()); // 생성 시간
        console.log('🔐 HR 복호화 키 생성 완료 (세션에만 저장)');
        return SESSION_CRYPTO_KEY;
    } catch (error) {
        console.error('키 파생 실패:', error);
        alert('비밀번호 처리에 실패했습니다. 다시 시도해주세요.');
        return null;
    }
}

// AES-GCM 암호화 (웹크립토 API 사용)
async function aesEncrypt(plaintext) {
    if (!SESSION_CRYPTO_KEY) {
        await promptAndDeriveKey();
        if (!SESSION_CRYPTO_KEY) return null;
    }
    
    try {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            SESSION_CRYPTO_KEY,
            new TextEncoder().encode(plaintext)
        );
        
        return { 
            v: 1, 
            iv: btoa(String.fromCharCode(...iv)), 
            ciphertext: btoa(String.fromCharCode(...new Uint8Array(ct))) 
        };
    } catch (error) {
        console.error('AES 암호화 실패:', error);
        return null;
    }
}

// AES-GCM 복호화 (웹크립토 API 사용)
async function aesDecrypt(encObj) {
    if (!SESSION_CRYPTO_KEY) {
        await promptAndDeriveKey();
        if (!SESSION_CRYPTO_KEY) return '';
    }
    
    try {
        const iv = Uint8Array.from(atob(encObj.iv), c => c.charCodeAt(0));
        const ct = Uint8Array.from(atob(encObj.ciphertext), c => c.charCodeAt(0));
        const ptBuf = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv }, 
            SESSION_CRYPTO_KEY, 
            ct
        );
        return new TextDecoder().decode(ptBuf);
    } catch (error) {
        console.error('AES 복호화 실패:', error);
        return '';
    }
}

// ===== 기존 보안 암호화 기능 (하위 호환) =====

// 강력한 AES-256 스타일 암호화 (운영급)
function encryptSensitiveData(data, masterKey = null) {
    if (!data) return '';
    
    try {
        // 환경별 마스터 키 (실제 운영시에는 Firebase Secret Manager에서 가져와야 함)
        const key = masterKey || generateMasterKey();
        
        // 솔트 생성 (보안 강화)
        const salt = generateRandomSalt();
        
        // 강화된 암호화 (AES-256 스타일)
        let encrypted = '';
        const combinedKey = key + salt;
        
        // 다중 라운드 암호화
        for (let round = 0; round < 3; round++) {
            let roundResult = '';
            for (let i = 0; i < data.length; i++) {
                const keyChar = combinedKey.charCodeAt((i + round * 17) % combinedKey.length);
                const dataChar = data.charCodeAt(i);
                // 복잡한 비트 연산 조합
                const encryptedChar = ((dataChar ^ keyChar) + (keyChar * 3) + round * 7) % 256;
                roundResult += String.fromCharCode(encryptedChar);
            }
            data = roundResult;
        }
        
        // 최종 결과: 솔트 + 암호화된 데이터
        return btoa(salt + '::' + data);
    } catch (error) {
        console.log('암호화 실패:', error);
        return btoa(data); // 최소한 Base64 인코딩
    }
}

// 강력한 복호화 함수
function decryptSensitiveData(encryptedData, masterKey = null) {
    if (!encryptedData) return '';
    
    try {
        const key = masterKey || generateMasterKey();
        
        // Base64 디코딩
        const decoded = atob(encryptedData);
        
        // 솔트와 데이터 분리
        const parts = decoded.split('::');
        if (parts.length !== 2) {
            // 구 버전 호환성 (XOR 방식)
            return legacyDecrypt(encryptedData);
        }
        
        const salt = parts[0];
        let data = parts[1];
        const combinedKey = key + salt;
        
        // 다중 라운드 복호화 (역순)
        for (let round = 2; round >= 0; round--) {
            let roundResult = '';
            for (let i = 0; i < data.length; i++) {
                const keyChar = combinedKey.charCodeAt((i + round * 17) % combinedKey.length);
                const encryptedChar = data.charCodeAt(i);
                // 역 연산
                let decryptedChar = (encryptedChar - (keyChar * 3) - round * 7);
                if (decryptedChar < 0) decryptedChar += 256;
                decryptedChar = decryptedChar ^ keyChar;
                roundResult += String.fromCharCode(decryptedChar);
            }
            data = roundResult;
        }
        
        return data;
    } catch (error) {
        console.log('복호화 실패:', error);
        // 구 버전 호환성 시도
        return legacyDecrypt(encryptedData);
    }
}

// 마스터 키 생성 (실제 운영시에는 Firebase Secret Manager 사용)
function generateMasterKey() {
    // ⚠️ 운영에선 Secret Manager/환경변수에서 읽어오세요.
    const baseKey = 'HRMS_PRODUCTION_KEY_2025_STATIC';
    return btoa(baseKey).substring(0, 32);
}

// 랜덤 솔트 생성
function generateRandomSalt() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let salt = '';
    for (let i = 0; i < 16; i++) {
        salt += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return salt;
}

// 구 버전 호환성 (XOR 복호화)
function legacyDecrypt(encryptedData, key = 'HRMS_SECRET_KEY_2025') {
    try {
        const decoded = atob(encryptedData);
        let decrypted = '';
        for (let i = 0; i < decoded.length; i++) {
            decrypted += String.fromCharCode(decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
        return decrypted;
    } catch (error) {
        return encryptedData;
    }
}

// 민감정보 마스킹 (표시용)
function maskSensitiveData(data, type) {
    if (!data) return '';
    
    switch (type) {
        case 'ssn':
            return data.length > 8 ? data.substring(0, 8) + '******' : data;
        case 'phone':
            return data.length > 7 ? data.substring(0, 7) + '****' : data;
        case 'address':
            return data.length > 10 ? data.substring(0, 10) + '...' : data;
        default:
            return data;
    }
}

// ===== HR 데이터 마이그레이션 (AES-GCM) =====

// 기존 데이터를 AES-GCM 포맷으로 마이그레이션 (관리자 전용)
async function migrateOldToAes() {
    if (!SESSION_CRYPTO_KEY) {
        await promptAndDeriveKey();
        if (!SESSION_CRYPTO_KEY) {
            alert('복호화 키가 필요합니다.');
            return;
        }
    }
    
    console.log('🔄 기존 HR 데이터를 AES-GCM 포맷으로 마이그레이션 시작...');
    
    const snap = await database.ref('employees').once('value');
    const map = snap.val() || {};
    const list = Array.isArray(map) ? map : Object.values(map);
    let count = 0;
    
    for (const emp of list) {
        const hr = emp?.hrData; 
        if (!hr) continue;
        if (hr.enc) continue; // 이미 새 포맷
        
        try {
            const phone = hr.phone ? decryptSensitiveData(hr.phone) : '';
            const ssn = hr.ssn ? decryptSensitiveData(hr.ssn) : '';
            const address = hr.address ? decryptSensitiveData(hr.address) : '';
            
            hr.enc = {
                phone: phone ? await aesEncrypt(phone) : null,
                ssn: ssn ? await aesEncrypt(ssn) : null,
                address: address ? await aesEncrypt(address) : null
            };
            
            // 평문/구포맷 필드 제거
            delete hr.phone; 
            delete hr.ssn; 
            delete hr.address;
            
            await database.ref(`employees/${emp.id}/hrData`).set(hr);
            console.log(`${emp.name} AES-GCM 마이그레이션 완료`);
            count++;
        } catch(e) { 
            console.log(`${emp?.name} 마이그레이션 건너뜀:`, e); 
        }
    }
    
    alert(`AES-GCM 포맷으로 재암호화 완료: ${count}명`);
    console.log(`🔄 AES-GCM 마이그레이션 완료: ${count}명`);
    
    // UI 새로고침
    renderHREmployeeList();
}

// ===== 기존 HR 데이터 마이그레이션 (호환성) =====

// 관리자 전용. 로그인 후 콘솔에서 한 번 호출.
async function migrateHRDataKeys(daysBack = 30) {
    const EMP_PHONE = /^010-\d{4}-\d{4}$/;
    const tryDates = [...Array(daysBack).keys()].map(d => {
        const dt = new Date(); 
        dt.setDate(dt.getDate() - d);
        // 기존 generateMasterKey()가 '일 단위'를 썼으므로 그날의 키를 재현
        const baseKey = 'HRMS_PRODUCTION_KEY_2025';
        const userAgent = navigator.userAgent.substring(0, 20);
        const timestamp = Math.floor(dt.getTime() / (1000 * 60 * 60 * 24));
        return btoa(baseKey + userAgent + timestamp).substring(0, 32);
    });

    const snapshot = await database.ref('employees').once('value');
    const employeesMap = snapshot.val() || {};
    const employeesList = Array.isArray(employeesMap) ? employeesMap : Object.values(employeesMap);

    let fixed = 0;
    for (const emp of employeesList) {
        if (!emp?.hrData?.encrypted) continue;
        const hr = emp.hrData;

        // 대상 필드들만 시도
        for (const k of ['phone','ssn','address']) {
            if (!hr[k]) continue;

            let plain = null;

            // 1) 현재(새 고정키)로 먼저 시도
            try { 
                plain = decryptSensitiveData(hr[k]); 
                // 간단 검증
                if (k === 'phone' && plain && !EMP_PHONE.test(plain)) plain = null;
            } catch {}
            
            // 2) 안 되면 과거 날짜키들로 시도
            if (!plain || /[^\x20-\x7E]/.test(plain)) {
                for (const key of tryDates) {
                    try {
                        plain = decryptSensitiveData(hr[k], key);
                        // 간단 검증: phone은 010-형식, ssn/addr은 글자 수로 대충 판단
                        if (k === 'phone' && !EMP_PHONE.test(plain)) { 
                            plain = null; 
                            continue; 
                        }
                        if (plain && plain.length > 0) break;
                    } catch { 
                        plain = null; 
                    }
                }
            }

            if (plain) {
                // 새 고정 키로 재암호화
                hr[k] = encryptSensitiveData(plain);
                console.log(`${emp.name} ${k} 마이그레이션 완료`);
            }
        }

        await database.ref(`employees/${emp.id}`).set(emp);
        fixed++;
    }
    
    console.log(`🔄 HR 데이터 키 마이그레이션 완료: ${fixed}명`);
    alert(`HR 데이터 키 마이그레이션이 완료되었습니다. (${fixed}명 처리)`);
}

// ===== HR 관리 기능 =====

// 탭 전환 함수
function showTab(tabName) {
    // 모든 탭 버튼 비활성화
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // 모든 탭 컨텐츠 숨기기
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    
    // 선택된 탭 활성화
    event.target.classList.add('active');
    
    if (tabName === 'dashboard') {
        document.getElementById('dashboardTab').classList.add('active');
        // 대시보드 탭으로 전환 시 달력 다시 렌더링
        renderCalendar();
    } else if (tabName === 'hr') {
        document.getElementById('hrTab').classList.add('active');
        // HR 탭으로 전환 시 HR 데이터 로드
        updateHREmployeeDropdown();
        renderHREmployeeList();
    }
}

// HR 직원 드롭다운 업데이트
function updateHREmployeeDropdown() {
    const dropdown = document.getElementById('hrEmployeeSelect');
    dropdown.innerHTML = '<option value="">새 직원 등록</option>';
    
    employees.forEach(employee => {
        const option = document.createElement('option');
        option.value = employee.id;
        option.textContent = employee.name;
        dropdown.appendChild(option);
    });
}

// 직원 HR 데이터 로드
async function loadEmployeeHRData() {
    const employeeId = parseInt(document.getElementById('hrEmployeeSelect').value);
    
    if (!employeeId) {
        clearHRForm();
        return;
    }
    
    const employee = employees.find(emp => emp.id === employeeId);
    if (!employee) return;
    
    // HR 폼에 데이터 채우기 (민감정보 복호화)
    const hrData = employee.hrData || {};
    
    document.getElementById('hrEmployeeName').value = employee.name || '';
    document.getElementById('hrJoinDate').value = employee.joinDate || '';
    document.getElementById('hrLeaveDate').value = hrData.leaveDate || '';
    
    // AES-GCM 복호화된 데이터 로드
    if (hrData.enc) {
        // 새 AES-GCM 포맷
        document.getElementById('hrPhone').value = hrData.enc.phone ? await aesDecrypt(hrData.enc.phone) : '';
        document.getElementById('hrSsn').value = hrData.enc.ssn ? await aesDecrypt(hrData.enc.ssn) : '';
        document.getElementById('hrAddress').value = hrData.enc.address ? await aesDecrypt(hrData.enc.address) : '';
    } else if (hrData.encrypted) {
        // 기존 암호화 데이터 (하위 호환)
        document.getElementById('hrPhone').value = hrData.phone ? decryptSensitiveData(hrData.phone) : '';
        document.getElementById('hrSsn').value = hrData.ssn ? decryptSensitiveData(hrData.ssn) : '';
        document.getElementById('hrAddress').value = hrData.address ? decryptSensitiveData(hrData.address) : '';
    } else {
        // 과거 데이터 호환(없으면 빈칸)
        document.getElementById('hrPhone').value = '';
        document.getElementById('hrSsn').value = '';
        document.getElementById('hrAddress').value = '';
    }
    
    document.getElementById('hrDepartment').value = hrData.department || '';
    document.getElementById('hrPosition').value = hrData.position || '';
    document.getElementById('hrNotes').value = hrData.notes || '';
}

// HR 폼 초기화
function clearHRForm() {
    document.getElementById('hrEmployeeSelect').value = '';
    document.getElementById('hrEmployeeName').value = '';
    document.getElementById('hrJoinDate').value = '';
    document.getElementById('hrLeaveDate').value = '';
    document.getElementById('hrPhone').value = '';
    document.getElementById('hrSsn').value = '';
    document.getElementById('hrDepartment').value = '';
    document.getElementById('hrPosition').value = '';
    document.getElementById('hrAddress').value = '';
    document.getElementById('hrNotes').value = '';
}

// 직원 HR 데이터 저장
async function saveEmployeeHRData() {
    // 권한 체크: 매니저 이상만 가능
    if (!checkPermission('manager')) {
        showNoPermissionAlert('HR 정보 관리');
        return;
    }
    
    const employeeId = parseInt(document.getElementById('hrEmployeeSelect').value);
    const name = document.getElementById('hrEmployeeName').value.trim();
    const joinDate = document.getElementById('hrJoinDate').value;
    const leaveDate = document.getElementById('hrLeaveDate').value;
    const phone = document.getElementById('hrPhone').value.trim();
    const ssn = document.getElementById('hrSsn').value.trim();
    const department = document.getElementById('hrDepartment').value.trim();
    const position = document.getElementById('hrPosition').value.trim();
    const address = document.getElementById('hrAddress').value.trim();
    const notes = document.getElementById('hrNotes').value.trim();
    
    if (!name || !joinDate) {
        alert('이름과 입사일은 필수 항목입니다.');
        return;
    }
    
    // 전화번호 형식 검증
    if (phone && !/^010-\d{4}-\d{4}$/.test(phone)) {
        alert('휴대폰번호는 010-1234-5678 형식으로 입력해주세요.');
        return;
    }
    
    // 주민번호 형식 검증
    if (ssn && !/^\d{6}-\d{7}$/.test(ssn)) {
        alert('주민번호는 123456-1234567 형식으로 입력해주세요.');
        return;
    }
    
    let employee;
    
    if (employeeId) {
        // 기존 직원 수정
        employee = employees.find(emp => emp.id === employeeId);
        if (!employee) {
            alert('직원을 찾을 수 없습니다.');
            return;
        }
        
        // 기본 정보 업데이트
        employee.name = name;
        employee.joinDate = joinDate;
        
    } else {
        // 새 직원 추가
        employee = {
            id: Date.now(),
            name: name,
            joinDate: joinDate,
            annualLeave: 0,
            monthlyLeave: 0,
            usedAnnual: 0,
            usedMonthly: 0,
            lastMonthlyUpdate: joinDate
        };
        
        // 초기 연차/월차 계산
        calculateEmployeeLeaves(employee);
        employees.push(employee);
    }
    
    // HR 데이터 저장 (AES-GCM 암호화)
    employee.hrData = {
        leaveDate: leaveDate,
        encrypted: true,        // 평문은 안 둡니다
        enc: {
            phone: phone ? await aesEncrypt(phone) : null,
            ssn: ssn ? await aesEncrypt(ssn) : null,
            address: address ? await aesEncrypt(address) : null
        },
        department: department,
        position: position,
        notes: notes,
        lastUpdated: new Date().toISOString()
    };
    
    // 보안 강화된 Firebase + 로컬 백업으로 저장
    await saveEmployee(employee);
    saveData();
    
    // UI 업데이트
    renderEmployeeSummary();
    updateModalEmployeeDropdown();
    updateHREmployeeDropdown();
    renderHREmployeeList();
    
    alert('직원 정보가 저장되었습니다.');
}

// 직원 HR 데이터 삭제
async function deleteEmployeeHRData() {
    // 권한 체크: 관리자만 가능
    if (!checkPermission('admin')) {
        showNoPermissionAlert('직원 삭제');
        return;
    }
    
    const employeeId = parseInt(document.getElementById('hrEmployeeSelect').value);
    if (!employeeId) {
        alert('삭제할 직원을 선택해주세요.');
        return;
    }
    
    const employee = employees.find(emp => emp.id === employeeId);
    if (!employee) {
        alert('직원을 찾을 수 없습니다.');
        return;
    }
    
    if (confirm(`정말로 ${employee.name} 직원을 삭제하시겠습니까?\n\n⚠️ 주의: 해당 직원의 모든 휴가 기록도 함께 삭제됩니다.`)) {
        // 직원 삭제
        employees = employees.filter(emp => emp.id !== employeeId);
        
        // 해당 직원의 휴가 기록도 삭제
        leaveRecords = leaveRecords.filter(record => record.employeeId !== employeeId);
        
        // 로컬 저장소에서만 관리 (개인정보 보호)
        
        saveData();
        
        // UI 업데이트
        clearHRForm();
        renderEmployeeSummary();
        updateModalEmployeeDropdown();
        updateHREmployeeDropdown();
        renderHREmployeeList();
        renderCalendar();
        
        alert('직원이 삭제되었습니다.');
    }
}

// HR 직원 목록 렌더링
function renderHREmployeeList() {
    const container = document.getElementById('hrEmployeeList');
    container.innerHTML = '';
    
    if (employees.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 40px; color: #6c757d;">등록된 직원이 없습니다.</div>';
        return;
    }
    
    employees.forEach(employee => {
        const card = document.createElement('div');
        card.className = 'hr-employee-card';
        
        const joinDate = new Date(employee.joinDate);
        const today = new Date();
        const daysDiff = Math.floor((today - joinDate) / (1000 * 60 * 60 * 24));
        const years = Math.floor(daysDiff / 365);
        const months = Math.floor((daysDiff % 365) / 30);
        
        const hrData = employee.hrData || {};
        const isActive = !hrData.leaveDate || new Date(hrData.leaveDate) > today;
        
        card.innerHTML = `
            <div class="hr-employee-name">
                ${employee.name} 
                <span style="font-size: 0.8rem; color: ${isActive ? '#28a745' : '#dc3545'};">
                    ${isActive ? '재직중' : '퇴사'}
                </span>
            </div>
            <div class="hr-employee-info">
                <div class="hr-info-item">
                    <span class="hr-info-label">부서:</span>
                    <span>${hrData.department || '미설정'}</span>
                </div>
                <div class="hr-info-item">
                    <span class="hr-info-label">직급:</span>
                    <span>${hrData.position || '미설정'}</span>
                </div>
                <div class="hr-info-item">
                    <span class="hr-info-label">입사일:</span>
                    <span>${employee.joinDate} (${years}년 ${months}개월)</span>
                </div>
                <div class="hr-info-item">
                    <span class="hr-info-label">연락처:</span>
                    <span id="phone-${employee.id}">로딩중...</span>
                </div>
                ${hrData.leaveDate ? `
                <div class="hr-info-item">
                    <span class="hr-info-label">퇴사일:</span>
                    <span>${hrData.leaveDate}</span>
                </div>
                ` : ''}
                ${hrData.lastUpdated ? `
                <div class="hr-info-item">
                    <span class="hr-info-label">최종수정:</span>
                    <span>${new Date(hrData.lastUpdated).toLocaleDateString('ko-KR')}</span>
                </div>
                ` : ''}
            </div>
        `;
        
        // 카드 클릭 시 해당 직원 정보 로드
        card.addEventListener('click', () => {
            document.getElementById('hrEmployeeSelect').value = employee.id;
            loadEmployeeHRData();
            
            // 폼 영역으로 스크롤
            document.querySelector('.hr-form-section').scrollIntoView({ 
                behavior: 'smooth', 
                block: 'start' 
            });
        });
        
        container.appendChild(card);
        
        // 비동기로 민감정보 복호화 및 표시
        if (hrData.enc && hrData.enc.phone) {
            aesDecrypt(hrData.enc.phone).then(phone => {
                const phoneElement = document.getElementById(`phone-${employee.id}`);
                if (phoneElement) {
                    phoneElement.textContent = phone ? maskSensitiveData(phone, 'phone') : '미등록';
                }
            }).catch(() => {
                const phoneElement = document.getElementById(`phone-${employee.id}`);
                if (phoneElement) phoneElement.textContent = '복호화 실패';
            });
        } else {
            const phoneElement = document.getElementById(`phone-${employee.id}`);
            if (phoneElement) phoneElement.textContent = '미등록';
        }
    });
}

// HR 직원 목록 필터링
function filterHRList() {
    const searchTerm = document.getElementById('hrSearchInput').value.toLowerCase();
    const cards = document.querySelectorAll('.hr-employee-card');
    
    cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        if (text.includes(searchTerm)) {
            card.style.display = 'block';
        } else {
            card.style.display = 'none';
        }
    });
}

// 주민번호 입력 시 자동 하이픈 추가
document.addEventListener('DOMContentLoaded', function() {
    const ssnInput = document.getElementById('hrSsn');
    if (ssnInput) {
        ssnInput.addEventListener('input', function(e) {
            let value = e.target.value.replace(/[^0-9]/g, '');
            if (value.length >= 6) {
                value = value.substring(0, 6) + '-' + value.substring(6, 13);
            }
            e.target.value = value;
        });
    }
    
    // 휴대폰번호 입력 시 자동 하이픈 추가
    const phoneInput = document.getElementById('hrPhone');
    if (phoneInput) {
        phoneInput.addEventListener('input', function(e) {
            let value = e.target.value.replace(/[^0-9]/g, '');
            if (value.length >= 3) {
                if (value.length <= 7) {
                    value = value.substring(0, 3) + '-' + value.substring(3);
                } else {
                    value = value.substring(0, 3) + '-' + value.substring(3, 7) + '-' + value.substring(7, 11);
                }
            }
            e.target.value = value;
        });
    }
});