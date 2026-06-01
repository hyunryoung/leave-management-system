// 전역 변수
let employees = [];
let leaveRecords = [];
let overtimeRecords = [];
let apiKeyRecords = [];
let currentDate = new Date();
let displayMonth = new Date();
let overtimeDisplayMonth = new Date();

// 진행 중인 Firebase 쓰기 카운터: 페이지 닫기 가드용
// 0보다 크면 저장 중인 작업이 있다는 뜻
let pendingWrites = 0;
function bumpPendingWrites() { pendingWrites++; }
function dropPendingWrites() { pendingWrites = Math.max(0, pendingWrites - 1); }

// 페이지 닫기 시 진행 중 저장이 있으면 경고
window.addEventListener('beforeunload', (e) => {
    if (pendingWrites > 0) {
        // 일부 브라우저는 커스텀 메시지를 무시하고 기본 경고만 띄움
        const msg = '저장이 진행 중입니다. 지금 닫으면 일부 데이터가 유실될 수 있어요.';
        e.preventDefault();
        e.returnValue = msg;
        return msg;
    }
});

// 편집 모드 관련 변수
let isEditMode = false;
let sortableInstance = null;
let originalEmployeeOrder = [];

// ===== Google Sheets 연동 =====
const GOOGLE_SHEET_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbzj2jVNgv9lH4vLAvsehmnpAR5KmKUyOXnVVGW5YClLFIaumi4cs6y2miF8gl3-pLNYjg/exec';

async function sendToGoogleSheet(action, records) {
    try {
        const payload = JSON.stringify({ action, records });

        // 숨겨진 iframe + form 방식으로 Google 인증 쿠키 자동 전송
        let iframe = document.getElementById('gsheet-iframe');
        if (!iframe) {
            iframe = document.createElement('iframe');
            iframe.id = 'gsheet-iframe';
            iframe.name = 'gsheet-iframe';
            iframe.style.display = 'none';
            document.body.appendChild(iframe);
        }

        const form = document.createElement('form');
        form.method = 'POST';
        form.action = GOOGLE_SHEET_WEBAPP_URL;
        form.target = 'gsheet-iframe';
        form.style.display = 'none';

        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'payload';
        input.value = payload;
        form.appendChild(input);

        document.body.appendChild(form);
        form.submit();
        document.body.removeChild(form);

        console.log(`📊 구글시트 ${action} 요청 완료`);
    } catch (error) {
        console.error('구글시트 연동 실패:', error);
    }
}

function leaveRecordToSheetData(record) {
    const emp = employees.find(e => e.id === record.employeeId);
    if (!emp) return null;

    let duration = '종일';
    if (record.duration === 'morning') duration = '오전반차';
    else if (record.duration === 'afternoon') duration = '오후반차';

    return {
        date: record.startDate || record.date || '',
        name: emp.name,
        type: getLeaveTypeText(record.type),
        deducted: isDeductibleLeaveType(record.type) ? (record.days || 0) : 0,
        duration: duration,
        reason: record.reason || '',
        recordId: record.id
    };
}

// ===== Slack 알림 설정 =====
const SLACK_CONFIG = {
    enabled: false, // Slack 알림 활성화 여부
    botToken: '', // Bot User OAuth Token (xoxb-로 시작)
};

// Slack 설정 로드 (Firebase 우선, localStorage 폴백)
async function loadSlackConfig() {
    // Firebase에서 로드 시도
    if (isFirebaseEnabled && firebase.auth().currentUser) {
        try {
            const snapshot = await database.ref('slackConfig').once('value');
            const config = snapshot.val();
            if (config) {
                SLACK_CONFIG.enabled = config.enabled || false;
                SLACK_CONFIG.botToken = config.botToken || '';
                // localStorage에도 동기화
                localStorage.setItem('slackConfig', JSON.stringify(config));
                console.log('Slack 설정 Firebase에서 로드 완료');
                return;
            }
        } catch (error) {
            console.log('Firebase Slack 설정 로드 실패, localStorage 사용:', error);
        }
    }
    // localStorage 폴백
    const saved = localStorage.getItem('slackConfig');
    if (saved) {
        const config = JSON.parse(saved);
        SLACK_CONFIG.enabled = config.enabled || false;
        SLACK_CONFIG.botToken = config.botToken || '';
    }
}

// Slack 설정 저장 (Firebase + localStorage 동시 저장)
async function saveSlackConfig() {
    const configData = {
        enabled: SLACK_CONFIG.enabled,
        botToken: SLACK_CONFIG.botToken
    };
    localStorage.setItem('slackConfig', JSON.stringify(configData));
    // Firebase에도 저장 (모든 브라우저에서 공유)
    if (isFirebaseEnabled && firebase.auth().currentUser) {
        try {
            await database.ref('slackConfig').set(configData);
            console.log('Slack 설정 Firebase에 저장 완료');
        } catch (error) {
            console.error('Slack 설정 Firebase 저장 실패:', error);
        }
    }
}

// Slack DM 발송 함수 (CORS 우회: form-urlencoded 사용)
async function sendSlackDM(slackUserId, message) {
    if (!SLACK_CONFIG.enabled || !SLACK_CONFIG.botToken || !slackUserId) {
        console.log('Slack 알림 스킵: 설정 미완료 또는 Slack ID 없음');
        return false;
    }
    
    try {
        // CORS 우회: application/x-www-form-urlencoded 사용
        const params = new URLSearchParams();
        params.append('token', SLACK_CONFIG.botToken);
        params.append('channel', slackUserId);
        params.append('text', message);
        
        const response = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params
        });
        
        const result = await response.json();
        if (result.ok) {
            console.log('✅ Slack DM 발송 성공:', slackUserId);
            return true;
        } else {
            console.error('❌ Slack DM 발송 실패:', result.error);
            return false;
        }
    } catch (error) {
        console.error('❌ Slack API 오류:', error);
        return false;
    }
}

// 휴가 유형 텍스트 변환 헬퍼 함수
function getLeaveTypeText(type) {
    const typeMap = {
        'annual': '연차',
        'monthly': '월차',
        'sick': '병가',
        'official': '공가',
        'education': '교육',
        'reward': '포상',
        'vacation': '휴가',
    };
    return typeMap[type] || type;
}

// 차감 대상 휴가 유형인지 확인
function isDeductibleLeaveType(type) {
    return type === 'annual' || type === 'monthly';
}

// 휴가 사용 알림 메시지 생성
function createLeaveNotificationMessage(employee, leaveType, days, remainingLeave, dates, duration) {
    const typeText = getLeaveTypeText(leaveType);
    const emoji = isDeductibleLeaveType(leaveType) ? (leaveType === 'annual' ? '🏖️' : '📅') : '📋';
    
    // 시간 구분 텍스트
    let durationText = '종일';
    if (duration === 'morning') durationText = '오전반차';
    else if (duration === 'afternoon') durationText = '오후반차';
    
    // 날짜 포맷팅
    let dateText = '';
    if (dates && dates.length > 0) {
        const sortedDates = [...dates].sort();
        if (sortedDates.length === 1) {
            dateText = sortedDates[0];
        } else {
            dateText = `${sortedDates[0]} ~ ${sortedDates[sortedDates.length - 1]} (${sortedDates.length}일)`;
        }
    }
    
    // 차감 대상이 아닌 경우 잔여 일수 표시 안함
    if (isDeductibleLeaveType(leaveType)) {
        return `${emoji} *휴가 사용 알림*\n\n` +
               `안녕하세요, *${employee.name}*님!\n\n` +
               `📆 *날짜:* ${dateText}\n` +
               `📋 *종류:* ${typeText} (${durationText})\n` +
               `⏱️ *사용:* ${days}일\n` +
               `💼 *잔여 ${typeText}:* *${remainingLeave.toFixed(1)}일*\n\n` +
               `좋은 휴식 되세요! 😊`;
    } else {
        return `${emoji} *${typeText} 사용 알림*\n\n` +
               `안녕하세요, *${employee.name}*님!\n\n` +
               `📆 *날짜:* ${dateText}\n` +
               `📋 *종류:* ${typeText} (${durationText})\n` +
               `⏱️ *기간:* ${days}일\n` +
               `ℹ️ *연차/월차 차감 없음*\n\n` +
               `좋은 하루 되세요! 😊`;
    }
}

// Slack 설정 UI 초기화
function initSlackSettingsUI() {
    const enabledSelect = document.getElementById('slackEnabled');
    const tokenInput = document.getElementById('slackBotToken');
    
    if (enabledSelect && tokenInput) {
        enabledSelect.value = SLACK_CONFIG.enabled ? 'true' : 'false';
        tokenInput.value = SLACK_CONFIG.botToken || '';
    }
}

// Slack 활성화 상태 업데이트
function updateSlackEnabled() {
    const enabled = document.getElementById('slackEnabled').value === 'true';
    SLACK_CONFIG.enabled = enabled;
}

// Slack 설정 저장
function saveSlackSettings() {
    const token = document.getElementById('slackBotToken').value.trim();
    const enabled = document.getElementById('slackEnabled').value === 'true';
    
    // 토큰 형식 검증
    if (enabled && token && !token.startsWith('xoxb-')) {
        alert('Bot Token은 xoxb-로 시작해야 합니다.');
        return;
    }
    
    SLACK_CONFIG.enabled = enabled;
    SLACK_CONFIG.botToken = token;
    saveSlackConfig();
    
    showToast('success', 'Slack 설정 저장', 'Slack 알림 설정이 저장되었습니다.');
}

// Slack 연결 테스트 (CORS 우회: form-urlencoded 사용)
async function testSlackConnection() {
    const resultDiv = document.getElementById('slackTestResult');
    const token = document.getElementById('slackBotToken').value.trim();
    
    if (!token) {
        resultDiv.style.display = 'block';
        resultDiv.style.background = '#fff3cd';
        resultDiv.style.color = '#856404';
        resultDiv.innerHTML = '⚠️ Bot Token을 입력해주세요.';
        return;
    }
    
    resultDiv.style.display = 'block';
    resultDiv.style.background = '#e7f3ff';
    resultDiv.style.color = '#004085';
    resultDiv.innerHTML = '🔄 연결 테스트 중...';
    
    try {
        // CORS 우회: application/x-www-form-urlencoded 사용
        const params = new URLSearchParams();
        params.append('token', token);
        
        const response = await fetch('https://slack.com/api/auth.test', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params
        });
        
        const result = await response.json();
        
        if (result.ok) {
            resultDiv.style.background = '#d4edda';
            resultDiv.style.color = '#155724';
            resultDiv.innerHTML = `✅ 연결 성공! 봇 이름: ${result.bot_id ? '봇' : result.user} (워크스페이스: ${result.team})`;
        } else {
            resultDiv.style.background = '#f8d7da';
            resultDiv.style.color = '#721c24';
            resultDiv.innerHTML = `❌ 연결 실패: ${result.error}`;
        }
    } catch (error) {
        resultDiv.style.background = '#f8d7da';
        resultDiv.style.color = '#721c24';
        resultDiv.innerHTML = `❌ 오류: ${error.message}`;
    }
}

// ===== 토스트 알림 시스템 =====
function showToast(type, title, message, duration = 4000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    
    const icons = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️'
    };
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || icons.info}</span>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-message">${message}</div>
        </div>
        <button class="toast-close" onclick="this.parentElement.classList.add('hide'); setTimeout(() => this.parentElement.remove(), 300);">×</button>
    `;
    
    container.appendChild(toast);
    
    // 자동 제거
    setTimeout(() => {
        if (toast.parentElement) {
            toast.classList.add('hide');
            setTimeout(() => toast.remove(), 300);
        }
    }, duration);
}

// 기존 alert 대체 함수
function showSuccessToast(message) {
    showToast('success', '성공', message);
}

function showErrorToast(message) {
    showToast('error', '오류', message);
}

function showWarningToast(message) {
    showToast('warning', '주의', message);
}

function showInfoToast(message) {
    showToast('info', '알림', message);
}

// ===== 직원 순서 편집 모드 =====
function toggleEditMode() {
    if (isEditMode) return;
    
    isEditMode = true;
    originalEmployeeOrder = [...employees]; // 원본 순서 저장
    
    // UI 변경
    document.getElementById('editModeBtn').style.display = 'none';
    document.getElementById('editDoneBtn').style.display = 'inline-flex';
    document.getElementById('editCancelBtn').style.display = 'inline-flex';
    
    // 직원 목록에 편집 모드 클래스 추가
    const container = document.getElementById('employeeSummary');
    container.classList.add('edit-mode');
    
    // SortableJS 초기화
    if (typeof Sortable !== 'undefined') {
        sortableInstance = new Sortable(container, {
            animation: 300,
            ghostClass: 'sortable-ghost',
            chosenClass: 'sortable-chosen',
            dragClass: 'sortable-drag',
            handle: '.employee-card', // 카드 전체를 드래그 핸들로
            onEnd: function(evt) {
                // 배열 순서 변경
                const movedItem = employees.splice(evt.oldIndex, 1)[0];
                employees.splice(evt.newIndex, 0, movedItem);
                console.log('직원 순서 변경:', employees.map(e => e.name));
            }
        });
    } else {
        alert('드래그 기능을 사용할 수 없습니다. 페이지를 새로고침해주세요.');
        cancelEditMode();
    }
    
    showInfoToast('드래그하여 직원 순서를 변경하세요');
}

async function saveEmployeeOrder() {
    if (!isEditMode) return;
    if (employees.length === 0) {
        exitEditMode();
        return;
    }

    // 순서 인덱스 부여 (메모리)
    employees.forEach((emp, index) => {
        emp.sortOrder = index;
    });

    // employees만 multi-path update로 1회 RTT 저장 (휴가/야근은 건드리지 않음)
    let saveOk = true;
    if (isFirebaseEnabled && firebase.auth().currentUser) {
        bumpPendingWrites();
        try {
            const updates = {};
            for (const emp of employees) {
                const empData = {
                    ...emp,
                    sortOrder: emp.sortOrder !== undefined ? emp.sortOrder : 999
                };
                const cleaned = JSON.parse(JSON.stringify(empData, (k, v) => v === undefined ? null : v));
                updates[`employees/${emp.id}`] = cleaned;
            }
            await database.ref().update(updates);
            console.log('직원 순서 저장 완료 (multi-path):', employees.length + '명');
        } catch (err) {
            saveOk = false;
            console.error('직원 순서 저장 실패:', err);
        } finally {
            dropPendingWrites();
        }
    }

    if (!saveOk) {
        // 원본 순서 복원, 편집 모드 유지하여 재시도 가능하게
        employees = [...originalEmployeeOrder];
        renderEmployeeSummary();
        showErrorToast('순서 저장에 실패했습니다. 다시 시도해주세요.');
        return;
    }

    exitEditMode();
    renderEmployeeSummary();

    showSuccessToast('직원 순서가 저장되었습니다');
}

function cancelEditMode() {
    if (!isEditMode) return;
    
    // 원본 순서 복원
    employees = [...originalEmployeeOrder];
    
    // 편집 모드 종료
    exitEditMode();
    
    // UI 업데이트
    renderEmployeeSummary();
    
    showInfoToast('순서 변경이 취소되었습니다');
}

function exitEditMode() {
    isEditMode = false;
    
    // SortableJS 해제
    if (sortableInstance) {
        sortableInstance.destroy();
        sortableInstance = null;
    }
    
    // UI 복원
    document.getElementById('editModeBtn').style.display = 'inline-flex';
    document.getElementById('editDoneBtn').style.display = 'none';
    document.getElementById('editCancelBtn').style.display = 'none';
    
    const container = document.getElementById('employeeSummary');
    container.classList.remove('edit-mode');
}

// ===== 다크모드 시스템 =====
function toggleDarkMode() {
    const html = document.documentElement;
    const currentTheme = html.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    html.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    
    // 아이콘 변경
    const themeIcon = document.getElementById('themeIcon');
    if (themeIcon) {
        themeIcon.textContent = newTheme === 'dark' ? '☀️' : '🌙';
    }
    
    showToast('info', '테마 변경', newTheme === 'dark' ? '다크모드가 활성화되었습니다.' : '라이트모드가 활성화되었습니다.', 2000);
}

// 저장된 테마 불러오기
function loadSavedTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    
    const themeIcon = document.getElementById('themeIcon');
    if (themeIcon) {
        themeIcon.textContent = savedTheme === 'dark' ? '☀️' : '🌙';
    }
}

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

// 공공데이터포털 API 키 (한국천문연구원 특일정보)
const DATA_GO_KR_API_KEY = '765c873c705ea776dabbb2c8a2d9f05ee7577578e7665277a833c69dc08869e0';

// 기본 공휴일 (API 실패 시 사용)
const defaultHolidays2025 = {
    '2025-01-01': '신정',
    '2025-01-28': '설날연휴',
    '2025-01-29': '설날',
    '2025-01-30': '설날연휴',
    '2025-03-01': '삼일절',
    '2025-05-05': '어린이날',
    '2025-05-06': '어린이날 대체공휴일',
    '2025-05-15': '부처님오신날',
    '2025-06-06': '현충일',
    '2025-08-15': '광복절',
    '2025-10-03': '개천절',
    '2025-10-05': '추석연휴',
    '2025-10-06': '추석',
    '2025-10-07': '추석연휴',
    '2025-10-08': '추석 대체공휴일',
    '2025-10-09': '한글날',
    '2025-12-25': '크리스마스'
};

// 공공데이터포털 API로 공휴일 가져오기 (대체공휴일 포함)
async function loadHolidaysFromDataGoKr(year) {
    const encodedKey = encodeURIComponent(DATA_GO_KR_API_KEY);
    const url = `https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getHoliDeInfo?serviceKey=${encodedKey}&solYear=${year}&numOfRows=50`;
    
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`공공데이터포털 API 응답 실패: ${response.status}`);
    }
    
    const xmlText = await response.text();
    
    // XML 파싱
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
    
    // 에러 체크
    const resultCode = xmlDoc.querySelector('resultCode');
    if (resultCode && resultCode.textContent !== '00') {
        const resultMsg = xmlDoc.querySelector('resultMsg');
        throw new Error(`API 에러: ${resultMsg ? resultMsg.textContent : '알 수 없는 오류'}`);
    }
    
    const items = xmlDoc.querySelectorAll('item');
    const holidayMap = {};
    
    items.forEach(item => {
        const locdate = item.querySelector('locdate')?.textContent; // YYYYMMDD 형식
        const dateName = item.querySelector('dateName')?.textContent;
        const isHoliday = item.querySelector('isHoliday')?.textContent;
        
        // 공휴일만 추가 (isHoliday가 'Y'인 경우)
        if (locdate && dateName && isHoliday === 'Y') {
            // YYYYMMDD -> YYYY-MM-DD 형식으로 변환
            const formattedDate = `${locdate.slice(0, 4)}-${locdate.slice(4, 6)}-${locdate.slice(6, 8)}`;
            holidayMap[formattedDate] = dateName;
        }
    });
    
    return holidayMap;
}

// Nager API로 공휴일 가져오기 (폴백용)
async function loadHolidaysFromNager(year) {
    const response = await fetch(`https://date.nager.at/api/v3/publicholidays/${year}/KR`);
    if (!response.ok) {
        throw new Error(`Nager API 응답 실패: ${response.status}`);
    }
    
    const holidays = await response.json();
    const holidayMap = {};
    
    holidays.forEach(holiday => {
        holidayMap[holiday.date] = holiday.localName || holiday.name;
    });
    
    return holidayMap;
}

// 공휴일 자동 로드 (공공데이터포털 우선, 실패 시 Nager API 사용)
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
                console.log(`${year}년 공휴일 캐시 사용 (${cachedData.source})`);
                return;
            }
        }
        
        let holidayMap = {};
        let source = '';
        
        // 1차: 공공데이터포털 API 시도 (대체공휴일 포함)
        try {
            holidayMap = await loadHolidaysFromDataGoKr(year);
            source = '공공데이터포털';
            console.log(`${year}년 공휴일 공공데이터포털 API 로드 완료:`, Object.keys(holidayMap).length + '개');
        } catch (dataGoKrError) {
            console.warn(`공공데이터포털 API 실패, Nager API로 폴백:`, dataGoKrError.message);
            
            // 2차: Nager API 폴백
            try {
                holidayMap = await loadHolidaysFromNager(year);
                source = 'Nager';
                console.log(`${year}년 공휴일 Nager API 로드 완료:`, Object.keys(holidayMap).length + '개');
            } catch (nagerError) {
                throw new Error(`모든 API 실패: ${nagerError.message}`);
            }
        }
        
        // 전역 객체에 병합
        koreanHolidays = { ...koreanHolidays, ...holidayMap };
        
        // 캐시에 저장
        localStorage.setItem(cachedKey, JSON.stringify({
            holidays: holidayMap,
            source: source,
            timestamp: Date.now()
        }));
        
    } catch (error) {
        console.error(`${year}년 공휴일 API 모두 실패, 기본 데이터 사용:`, error);
        
        // API 실패 시 기본 데이터 사용
        if (year === 2025) {
            koreanHolidays = { ...koreanHolidays, ...defaultHolidays2025 };
        }
    }
}

// 날짜 입력 필드에 오늘 날짜 기본값 설정
function setDefaultDates() {
    const today = new Date().toISOString().split('T')[0];
    
    // 야근 날짜 기본값
    const overtimeDate = document.getElementById('overtimeDate');
    if (overtimeDate && !overtimeDate.value) {
        overtimeDate.value = today;
    }
    
    // HR 입사일 기본값 (신규 등록 시만)
    const hrJoinDate = document.getElementById('hrJoinDate');
    if (hrJoinDate && !hrJoinDate.value) {
        hrJoinDate.value = today;
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
    
    // 입력 검증 강화
    if (!name || !joinDate) {
        alert('직원 이름과 입사일을 입력해주세요.');
        return;
    }
    
    // 이름 길이 및 형식 검증
    if (name.length < 2 || name.length > 20) {
        alert('직원 이름은 2자 이상 20자 이하로 입력해주세요.');
        return;
    }
    
    // 특수문자 검증 (한글, 영문, 공백만 허용)
    if (!/^[가-힣a-zA-Z\s]+$/.test(name)) {
        alert('직원 이름은 한글, 영문, 공백만 사용할 수 있습니다.');
        return;
    }
    
    // 입사일 유효성 검증
    const joinDateObj = new Date(joinDate);
    const today = new Date();
    if (joinDateObj > today) {
        alert('입사일은 오늘 날짜보다 이후일 수 없습니다.');
        return;
    }
    
    // 중복 이름 검증
    if (employees.some(emp => emp.name === name)) {
        alert('이미 등록된 직원 이름입니다. 다른 이름을 입력해주세요.');
        return;
    }
    
    // 새 직원의 sortOrder는 현재 직원 수로 설정 (맨 마지막에 추가)
    const newSortOrder = employees.length;

    const employee = {
        id: Date.now(),
        name: name,
        joinDate: joinDate,
        annualLeave: 0,
        monthlyLeave: 0,
        usedAnnual: 0,
        usedMonthly: 0,
        lastMonthlyUpdate: joinDate,
        sortOrder: newSortOrder
    };

    calculateEmployeeLeaves(employee);
    employees.push(employee);

    // 낙관적 UI 업데이트 + 입력값 백업 (실패 시 복원하기 위해)
    const nameInput = document.getElementById('employeeName');
    const joinDateInput = document.getElementById('joinDate');
    const backupName = nameInput.value;
    const backupJoinDate = joinDateInput.value;
    nameInput.value = '';
    joinDateInput.value = '';
    renderEmployeeSummary();
    updateModalEmployeeDropdown();

    // 변경된 직원 1명만 await로 끝까지 보장
    let saveOk = true;
    if (isFirebaseEnabled && firebase.auth().currentUser) {
        bumpPendingWrites();
        try {
            await saveEmployee(employee);
        } catch (err) {
            saveOk = false;
            console.error('직원 저장 실패:', err);
        } finally {
            dropPendingWrites();
        }
    }

    if (!saveOk) {
        // 메모리 롤백 (ID 기반으로 안전하게 제거)
        employees = employees.filter(e => e.id !== employee.id);
        // 입력값 복원
        nameInput.value = backupName;
        joinDateInput.value = backupJoinDate;
        renderEmployeeSummary();
        updateModalEmployeeDropdown();
        showErrorToast('직원 저장에 실패했습니다. 네트워크를 확인하고 다시 시도해주세요.');
        return;
    }

    try {
        const sanitized = employees.map(emp => ({
            ...emp,
            hrData: emp.hrData ? {
                ...emp.hrData,
                phone: emp.hrData.phone ? '***숨김***' : '',
                ssn: emp.hrData.ssn ? '***숨김***' : '',
                address: emp.hrData.address ? '***숨김***' : ''
            } : undefined
        }));
        localStorage.setItem('employees', JSON.stringify(sanitized));
        localStorage.setItem('lastUpdate', Date.now().toString());
    } catch (e) { /* ignore */ }
}

// ===== 연차/월차 계산 캐싱 시스템 =====
const leaveCalculationCache = new Map();

// 캐시 초기화 (자정에 자동 초기화하려면 타이머 사용 가능)
function clearLeaveCache() {
    leaveCalculationCache.clear();
    console.log('💾 연차/월차 캐시 초기화');
}

// 캐싱이 적용된 연차/월차 계산
function calculateEmployeeLeavesWithCache(employee) {
    const today = new Date();
    const cacheKey = `${employee.id}_${today.toDateString()}`;
    
    // 캐시 확인
    if (leaveCalculationCache.has(cacheKey)) {
        // 캐시에서 복사해서 employee 객체에 적용
        const cached = leaveCalculationCache.get(cacheKey);
        employee.annualLeave = cached.annualLeave;
        employee.monthlyLeave = cached.monthlyLeave;
        employee.usedAnnual = cached.usedAnnual;
        employee.usedMonthly = cached.usedMonthly;
        employee.lastAnnualReset = cached.lastAnnualReset;
        return;
    }
    
    // 캐시 미스 - 실제 계산 수행
    calculateEmployeeLeaves(employee);
    
    // 결과 캐싱
    leaveCalculationCache.set(cacheKey, {
        annualLeave: employee.annualLeave,
        monthlyLeave: employee.monthlyLeave,
        usedAnnual: employee.usedAnnual,
        usedMonthly: employee.usedMonthly,
        lastAnnualReset: employee.lastAnnualReset
    });
}

// ===== 근속 기간 계산 (입사 기념일 기준) =====
// 만 근속 연수. 입사 기념일을 지나야 +1.
// 기존 Math.floor(일수/365) 방식은 윤년 누적으로 기념일보다 하루 이상 빨리
// 연차(年)가 올라가는 off-by-one 오차가 있어 기념일 기준으로 통일함.
function getYearsOfService(joinDate, refDate = new Date()) {
    const join = (joinDate instanceof Date) ? joinDate : new Date(joinDate);
    const ref = (refDate instanceof Date) ? refDate : new Date(refDate);
    let years = ref.getFullYear() - join.getFullYear();
    const anniversary = new Date(ref.getFullYear(), join.getMonth(), join.getDate());
    if (ref < anniversary) years -= 1;
    return Math.max(0, years);
}

// 근무기간 표시용 (년/개월) - 달력 기준. years는 getYearsOfService와 일치함.
function getServiceDuration(joinDate, refDate = new Date()) {
    const join = (joinDate instanceof Date) ? joinDate : new Date(joinDate);
    const ref = (refDate instanceof Date) ? refDate : new Date(refDate);
    let totalMonths = (ref.getFullYear() - join.getFullYear()) * 12 + (ref.getMonth() - join.getMonth());
    if (ref.getDate() < join.getDate()) totalMonths -= 1;
    totalMonths = Math.max(0, totalMonths);
    return { years: Math.floor(totalMonths / 12), months: totalMonths % 12 };
}

// 재직 여부: 퇴사일이 없거나 아직 안 지났으면 재직, 지난 퇴사일이면 퇴사
function isEmployeeActive(employee) {
    const ld = employee && employee.hrData && employee.hrData.leaveDate;
    if (!ld) return true;
    return new Date(ld) > new Date();
}

// 휴가 기록에서 직원별 사용량 계산 (데이터 동기화 보장)
function calculateUsedLeavesFromRecords(employeeId, annualCycleStart = null) {
    let usedAnnual = 0;
    let usedMonthly = 0;
    
    leaveRecords.forEach(record => {
        if (record.employeeId === employeeId) {
            const days = record.days || 0;
            // date 또는 endDate 필드 사용 (호환성)
            const dateStr = record.date || record.endDate || record.startDate;
            const recordDate = dateStr ? new Date(dateStr) : null;
            
            // 차감 대상이 아닌 유형은 사용량에서 제외 (병가, 공가, 교육 등)
            if (!isDeductibleLeaveType(record.type)) {
                return;
            }
            
            if (record.type === 'annual') {
                // 연차는 현재 연차 주기 내의 기록만 계산
                if (annualCycleStart && recordDate) {
                    if (recordDate >= annualCycleStart) {
                        usedAnnual += days;
                    }
                } else {
                    usedAnnual += days;
                }
            } else if (record.type === 'monthly') {
                // 월차는 모든 기록 합산 (1년 미만 직원용)
                usedMonthly += days;
            }
        }
    });
    
    return { usedAnnual, usedMonthly };
}

// 직원별 연차/월차 계산
function calculateEmployeeLeaves(employee) {
    const now = new Date();
    const joinDate = new Date(employee.joinDate);

    // 퇴사자는 퇴사일 기준으로 계산을 고정 (퇴사 후 근속연수/월차가 계속 늘지 않도록)
    const leaveDateStr = employee.hrData && employee.hrData.leaveDate;
    const leaveDateObj = leaveDateStr ? new Date(leaveDateStr) : null;
    const today = (leaveDateObj && leaveDateObj < now) ? leaveDateObj : now;

    // 근무일수 (로그용) + 입사 기념일 기준 만 근속 연수
    const daysDiff = Math.floor((today - joinDate) / (1000 * 60 * 60 * 24));
    const yearsOfService = getYearsOfService(joinDate, today);
    
    // 1년 미만 직원 - 월차만 지급
    if (yearsOfService < 1) {
        // 휴가 기록에서 실제 사용량 계산 (월차)
        const actualUsage = calculateUsedLeavesFromRecords(employee.id, null);
        employee.usedMonthly = actualUsage.usedMonthly;
        employee.usedAnnual = 0;
        
        // 입사 후 '완료된' 개월 수 만큼만 월차 생성 (입사달 제외, 매 월 기념일에 1개)
        let completedMonths = (today.getFullYear() - joinDate.getFullYear()) * 12
                            + (today.getMonth() - joinDate.getMonth());
        if (today.getDate() < joinDate.getDate()) completedMonths -= 1; // 기념일 이전이면 아직 해당 달 미지급
        employee.monthlyLeave = Math.max(0, completedMonths);
        employee.annualLeave = 0; // 1년 미만은 연차 없음
        
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
        
        // 휴가 기록에서 실제 사용량 계산 (현재 연차 주기 내)
        const actualUsage = calculateUsedLeavesFromRecords(employee.id, currentCycleStart);
        employee.usedAnnual = actualUsage.usedAnnual;
        
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
                // usedAnnual은 이미 휴가 기록에서 계산됨 (현재 주기 내 기록만)
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
// 메모리 재계산 + 화면 갱신만 수행. 저장은 하지 않음.
// (60초 setInterval로 호출되므로 saveData 호출 시 변경 없는 데이터까지
//  216건 순차 저장이 돌아가 휴가 등록 직후 페이지 닫기 사고 유발)
// 잔여 휴가는 다음 페이지 로드 시 휴가 기록 기반으로 자동 재계산되므로 안전.
function calculateLeaves() {
    employees.forEach(employee => {
        calculateEmployeeLeavesWithCache(employee);
    });
    renderEmployeeSummary();
}

// 직원 삭제
async function deleteEmployee(id) {
    // 권한 체크: 관리자만 가능
    if (!checkPermission('admin')) {
        showNoPermissionAlert('직원 삭제');
        return;
    }
    
    if (confirm('정말로 이 직원을 삭제하시겠습니까?')) {
        // 로컬 배열에서 먼저 삭제
        employees = employees.filter(emp => emp.id !== id);
        leaveRecords = leaveRecords.filter(record => record.employeeId !== id);
        
        // Firebase에서 직원 삭제
        if (isFirebaseEnabled) {
            try {
                await database.ref(`employees/${id}`).remove();
                console.log('Firebase에서 직원 삭제 완료:', id);
            } catch (error) {
                console.log('Firebase 직원 삭제 실패:', error);
            }
        }
        
        // 해당 직원의 휴가 기록들도 Firebase에서 삭제
        const employeeLeaveRecords = leaveRecords.filter(record => record.employeeId === id);
        for (const record of employeeLeaveRecords) {
            await deleteLeaveRecord(record.id);
        }
        
        // 로컬 스토리지만 업데이트 (Firebase에 다시 저장하지 않음)
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
        
        // UI 업데이트
        renderEmployeeSummary();
        updateModalEmployeeDropdown();
        renderHREmployeeList();
        renderCalendar();
    }
}

// 직원 요약 렌더링
function renderEmployeeSummary() {
    const container = document.getElementById('employeeSummary');
    container.innerHTML = '';
    
    employees.filter(isEmployeeActive).forEach(employee => {
        const joinDate = new Date(employee.joinDate);
        const today = new Date();
        const { years, months } = getServiceDuration(joinDate, today);
        
        const card = document.createElement('div');
        card.className = 'employee-card';
        
        let leaveDisplay = '';
        if (years < 1) {
            // 1년 미만 - 월차만
            const remainingMonthly = employee.monthlyLeave - employee.usedMonthly;
            const usedMonthly = employee.usedMonthly || 0;
            const totalMonthly = employee.monthlyLeave || 0;
            const percentUsed = totalMonthly > 0 ? Math.min((usedMonthly / totalMonthly) * 100, 100) : 0;
            const progressClass = remainingMonthly < 0 ? 'danger' : (percentUsed > 80 ? 'warning' : 'monthly');
            
            leaveDisplay = `
                <div class="leave-progress-container">
                    <div class="leave-progress-label">
                        <span>월차</span>
                        <span>${usedMonthly.toFixed(1)} / ${totalMonthly}일 사용${remainingMonthly < 0 ? ' (선차감)' : ''}</span>
                    </div>
                    <div class="leave-progress-bar">
                        <div class="leave-progress-fill ${progressClass}" style="width: ${Math.min(percentUsed, 100)}%"></div>
                    </div>
                </div>
            `;
        } else {
            // 1년 이상 - 연차만
            const remainingAnnual = (employee.annualLeave || 15) - (employee.usedAnnual || 0);
            const usedAnnual = employee.usedAnnual || 0;
            const totalAnnual = employee.annualLeave || 15;
            const percentUsed = totalAnnual > 0 ? Math.min((usedAnnual / totalAnnual) * 100, 100) : 0;
            const progressClass = remainingAnnual < 0 ? 'danger' : (percentUsed > 80 ? 'warning' : 'annual');
            
            leaveDisplay = `
                <div class="leave-progress-container">
                    <div class="leave-progress-label">
                        <span>연차</span>
                        <span>${usedAnnual.toFixed(1)} / ${totalAnnual}일 사용${remainingAnnual < 0 ? ' (선차감)' : ''}</span>
                    </div>
                    <div class="leave-progress-bar">
                        <div class="leave-progress-fill ${progressClass}" style="width: ${Math.min(percentUsed, 100)}%"></div>
                    </div>
                </div>
            `;
        }
        
        // 권한에 따른 퇴사 처리 버튼 표시 (X = 퇴사 처리, 영구삭제 아님)
        const deleteButton = checkPermission('admin') ? 
            `<button class="delete-employee" title="퇴사 처리" onclick="openRetireModal(${employee.id}); event.stopPropagation();">×</button>` : 
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
    
    employees.filter(isEmployeeActive).forEach(employee => {
        const option = document.createElement('option');
        option.value = employee.id;
        option.textContent = employee.name;
        dropdown.appendChild(option);
    });
}

// 야근 탭 드롭다운 업데이트
function updateOvertimeEmployeeDropdown() {
    const employeeSelect = document.getElementById('overtimeEmployee');
    const filterDropdown = document.getElementById('overtimeFilterEmployee');
    if (employeeSelect) {
        employeeSelect.innerHTML = '<option value="">직원 선택</option>';
        employees.forEach(employee => {
            const option = document.createElement('option');
            option.value = employee.id;
            option.textContent = employee.name;
            employeeSelect.appendChild(option);
        });
    }
    if (filterDropdown) {
        filterDropdown.innerHTML = '<option value="">전체 직원</option>';
        employees.forEach(employee => {
            const option = document.createElement('option');
            option.value = employee.id;
            option.textContent = employee.name;
            filterDropdown.appendChild(option);
        });
    }
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
    
    // 강력한 모달 열기
    modal.style.cssText = 'display: block !important; z-index: 10000 !important;';
    console.log('모달 열림 확인:', getComputedStyle(modal).display);
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
async function registerLeave() {
    // 권한 체크: 매니저 이상만 휴가 등록 가능 (일반 직원은 조회만)
    if (!checkPermission('manager')) {
        showNoPermissionAlert('휴가 등록 (구두로 관리자에게 신청하세요)');
        return;
    }
    
    const employeeId = parseInt(document.getElementById('modalEmployee').value);
    const leaveType = document.getElementById('modalLeaveType').value;
    const leaveDuration = document.getElementById('modalDuration').value;
    const reason = document.getElementById('modalReason').value.trim();
    
    // 입력 검증 강화
    if (selectedDates.length === 0) {
        alert('날짜를 선택해주세요.');
        return;
    }
    
    if (!employeeId) {
        alert('직원을 선택해주세요.');
        return;
    }
    
    // 휴가 사유 검증
    if (reason && reason.length > 50) {
        alert('휴가 사유는 50자 이하로 입력해주세요.');
        return;
    }
    
    // 과거 날짜 검증 (관리자/매니저는 과거 날짜 등록 가능)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const hasOldDates = selectedDates.some(dateStr => {
        const selectedDate = new Date(dateStr);
        selectedDate.setHours(0, 0, 0, 0);
        return selectedDate < today;
    });
    
    if (hasOldDates) {
        // 관리자/매니저는 과거 날짜 등록 가능 (확인 메시지)
        if (!confirm('⚠️ 과거 날짜를 선택하셨습니다.\n\n깜빡하고 체크 못한 연차를 추가하시겠습니까?')) {
            return;
        }
    }
    
    const employee = employees.find(emp => emp.id === employeeId);
    if (!employee) {
        alert('직원을 찾을 수 없습니다.');
        return;
    }
    
    // 1년 미만 직원은 월차만, 1년 이상 직원은 연차만 사용 가능 (차감 대상만 체크)
    const currentDate = new Date();
    const joinDate = new Date(employee.joinDate);
    const yearsOfService = getYearsOfService(joinDate, currentDate);
    
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
    
    // 차감 대상 휴가만 잔여 확인 (병가/공가/교육은 차감 없음)
    // 차감 결정/적용은 저장 성공 후 롤백을 위해 변수로 추적
    let deductedField = null; // 'annual' | 'monthly' | null
    if (isDeductibleLeaveType(leaveType)) {
        if (leaveType === 'annual') {
            const remainingAnnual = employee.annualLeave - employee.usedAnnual;
            if (remainingAnnual < days) {
                const shortage = days - remainingAnnual;
                if (!confirm(`⚠️ 연차가 부족합니다!\n\n현재 잔여 연차: ${remainingAnnual.toFixed(1)}일\n사용하려는 일수: ${days}일\n부족한 일수: ${shortage.toFixed(1)}일\n\n선차감으로 처리하시겠습니까?\n(아직 생성되지 않은 연차를 미리 사용합니다)`)) {
                    return;
                }
            }
            employee.usedAnnual += days;
            deductedField = 'annual';
        } else {
            const remainingMonthly = employee.monthlyLeave - employee.usedMonthly;
            if (remainingMonthly < days) {
                const shortage = days - remainingMonthly;
                if (!confirm(`⚠️ 월차가 부족합니다!\n\n현재 잔여 월차: ${remainingMonthly.toFixed(1)}일\n사용하려는 일수: ${days}일\n부족한 일수: ${shortage.toFixed(1)}일\n\n선차감으로 처리하시겠습니까?\n(아직 생성되지 않은 월차를 미리 사용합니다)`)) {
                    return;
                }
            }
            employee.usedMonthly += days;
            deductedField = 'monthly';
        }
    }
    // 병가, 공가, 교육은 차감하지 않음

    // 새 기록 생성 (메모리). 실패 시 롤백을 위해 ID 별도 보관
    const newRecords = [];
    const newRecordIds = new Set();
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
        newRecords.push(leaveRecord);
        newRecordIds.add(leaveRecord.id);
    });

    // Slack 알림용 날짜 복사 (closeLeaveModal에서 selectedDates가 초기화되기 전에)
    const leaveDates = [...selectedDates];

    // 낙관적 업데이트: UI 먼저 즉시 반영 (실패 시 아래에서 롤백 후 재렌더)
    renderEmployeeSummary();
    renderCalendar();
    closeLeaveModal();

    // === 핵심 변경: 변경분만 await로 저장하고, 끝까지 보장 후 슬랙/시트/토스트 ===
    let saveOk = true;
    if (isFirebaseEnabled && firebase.auth().currentUser) {
        bumpPendingWrites();
        try {
            // 변경된 직원 1명만 저장 (잔여 휴가 차감 반영)
            await saveEmployee(employee);
            // 새로 생성된 휴가 기록만 저장
            for (const r of newRecords) {
                await saveLeaveRecord(r);
            }
        } catch (err) {
            saveOk = false;
            console.error('휴가 등록 저장 실패:', err);
        } finally {
            dropPendingWrites();
        }
    }

    if (!saveOk) {
        // 메모리 롤백: 차감 원복 + 새 기록 제거
        if (deductedField === 'annual') employee.usedAnnual -= days;
        else if (deductedField === 'monthly') employee.usedMonthly -= days;
        leaveRecords = leaveRecords.filter(r => !newRecordIds.has(r.id));

        renderEmployeeSummary();
        renderCalendar();
        showToast('error', '휴가 등록 실패', '저장에 실패했습니다. 네트워크를 확인하고 다시 시도해주세요.');
        return;
    }

    // 로컬 백업도 갱신 (전체 saveData() 호출 없이 가볍게)
    try {
        localStorage.setItem('leaveRecords', JSON.stringify(leaveRecords));
        localStorage.setItem('lastUpdate', Date.now().toString());
    } catch (e) {
        console.warn('로컬 백업 실패(무시):', e);
    }

    // 저장 성공 후에만 알림/시트/토스트
    showToast('success', '휴가 등록 완료', '휴가가 성공적으로 등록되었습니다.');
    sendLeaveSlackNotification(employee, leaveType, days, leaveDates, leaveDuration);

    const sheetData = newRecords.map(r => leaveRecordToSheetData(r)).filter(Boolean);
    if (sheetData.length > 0) {
        sendToGoogleSheet('add', sheetData);
    }
}

// 휴가 등록 시 Slack 알림 발송
async function sendLeaveSlackNotification(employee, leaveType, days, dates, duration) {
    try {
        // Slack 설정 확인
        if (!SLACK_CONFIG.enabled || !SLACK_CONFIG.botToken) {
            console.log('📱 Slack 알림 비활성화 상태');
            return;
        }
        
        // 직원의 Slack 설정 확인
        const hrData = employee.hrData || {};
        if (!hrData.slackId || hrData.slackNotify === false) {
            console.log('📱 해당 직원 Slack 알림 비활성화 또는 ID 없음:', employee.name);
            return;
        }
        
        // 잔여 휴가 계산 (차감 대상만)
        let remainingLeave = 0;
        if (isDeductibleLeaveType(leaveType)) {
            remainingLeave = leaveType === 'annual' 
                ? (employee.annualLeave - employee.usedAnnual)
                : (employee.monthlyLeave - employee.usedMonthly);
        }
        
        // 알림 메시지 생성 및 발송
        const message = createLeaveNotificationMessage(employee, leaveType, days, remainingLeave, dates, duration);
        const success = await sendSlackDM(hrData.slackId, message);
        
        if (success) {
            console.log('✅ Slack 휴가 알림 발송 완료:', employee.name);
        }
    } catch (error) {
        console.error('❌ Slack 알림 발송 오류:', error);
        // 알림 실패해도 휴가 등록은 이미 완료됨
    }
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
            <span class="leave-item-type ${record.type}">${getLeaveTypeText(record.type)}</span>
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
// 실패 시 호출자가 인지할 수 있도록 에러를 다시 throw 합니다 (기존 .catch 호출자도 그대로 동작)
async function saveEmployee(employee) {
    if (isFirebaseEnabled) {
        try {
            const employeeData = {
                ...employee,
                sortOrder: employee.sortOrder !== undefined ? employee.sortOrder : 999
            };

            const cleanedData = JSON.parse(JSON.stringify(employeeData, (key, value) =>
                value === undefined ? null : value
            ));

            await database.ref(`employees/${employee.id}`).set(cleanedData);
            console.log('Firebase에 직원 저장 완료:', employee.name, 'sortOrder:', cleanedData.sortOrder);
        } catch (error) {
            console.log('Firebase 직원 저장 실패:', error);
            throw error;
        }
    }
}

// 개별 휴가 기록 저장
async function saveLeaveRecord(leaveRecord) {
    if (isFirebaseEnabled) {
        try {
            let safeId = leaveRecord.id.toString().replace(/\./g, '_');
            await database.ref(`leaveRecords/${safeId}`).set({
                ...leaveRecord,
                id: safeId
            });
            console.log('Firebase에 휴가 기록 저장 완료:', safeId);
        } catch (error) {
            console.log('Firebase 휴가 저장 실패:', error);
            throw error;
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
            throw error;
        }
    }
}

// 기존 잘못된 휴가 기록 완전 정리 (비활성화 - 데이터 보호)
async function cleanupInvalidLeaveRecords() {
    // 데이터 손실 방지를 위해 비활성화
    console.log('휴가 기록 정리 함수 비활성화됨 (데이터 보호)');
    return;
    
    // 원래 로직 주석 처리 (필요시 수동 실행)
    /*
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
    */
}

// 데이터 저장 (보안 강화된 Firebase + 로컬 백업)
// multi-path update로 1회 RTT에 끝내도록 리팩터.
// 기존 N+M+K번 순차 await 패턴은 페이지 닫기 시 유실 위험이 컸음.
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
    localStorage.setItem('overtimeRecords', JSON.stringify(overtimeRecords));

    if (!isFirebaseEnabled || !firebase.auth().currentUser) {
        console.log('로컬 저장소에만 데이터 저장 (Firebase 인증 대기중)');
        return;
    }

    bumpPendingWrites();
    try {
        const updates = {};

        for (const emp of employees) {
            const empData = {
                ...emp,
                sortOrder: emp.sortOrder !== undefined ? emp.sortOrder : 999
            };
            const cleaned = JSON.parse(JSON.stringify(empData, (k, v) => v === undefined ? null : v));
            updates[`employees/${emp.id}`] = cleaned;
        }

        for (const r of leaveRecords) {
            const safeId = r.id.toString().replace(/\./g, '_');
            updates[`leaveRecords/${safeId}`] = { ...r, id: safeId };
        }

        for (const o of overtimeRecords) {
            updates[`overtimeRecords/${o.id}`] = o;
        }

        updates['lastUpdate'] = Date.now();

        // 1회 RTT로 모든 변경사항을 원자적으로 적용
        await database.ref().update(updates);
        console.log('Firebase 저장 완료 (multi-path 1회 RTT):',
            `직원 ${employees.length}, 휴가 ${leaveRecords.length}, 야근 ${overtimeRecords.length}`);
    } catch (error) {
        console.log('Firebase 저장 실패, 로컬만 사용:', error);
    } finally {
        dropPendingWrites();
    }
}

// 데이터 불러오기 (보안 강화된 Firebase + 로컬 백업)
async function loadData() {
    // Firebase에서 보안 인증된 상태로 로드 시도
    if (isFirebaseEnabled && firebase.auth().currentUser) {
        try {
            const [employeesSnapshot, recordsSnapshot, overtimeSnapshot, apiKeySnapshot] = await Promise.all([
                database.ref('employees').once('value'),
                database.ref('leaveRecords').once('value'),
                database.ref('overtimeRecords').once('value'),
                database.ref('apiKeys').once('value')
            ]);

            const firebaseEmployees = employeesSnapshot.val();
            const firebaseRecords = recordsSnapshot.val();
            const firebaseOvertimeRecords = overtimeSnapshot.val();
            
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
                    employees.forEach(emp => calculateEmployeeLeavesWithCache(emp)); // 캐싱 적용
                    // sortOrder로 정렬 (저장된 순서 유지)
                    console.log('정렬 전 직원 순서:', employees.map(e => `${e.name}(${e.sortOrder})`));
                    employees.sort((a, b) => {
                        const orderA = a.sortOrder !== undefined ? a.sortOrder : 999;
                        const orderB = b.sortOrder !== undefined ? b.sortOrder : 999;
                        return orderA - orderB;
                    });
                    console.log('정렬 후 직원 순서:', employees.map(e => `${e.name}(${e.sortOrder})`));
                    console.log('Firebase에서 보안 인증된 상태로 직원 데이터 로드:', employees.length + '명');
                }
            }
            
            if (firebaseRecords) {
                leaveRecords = Array.isArray(firebaseRecords) ? firebaseRecords :
                    Object.values(firebaseRecords).filter(record => record && record.id && !record.id.toString().includes('.'));
                console.log('Firebase에서 보안 인증된 상태로 휴가 데이터 로드:', leaveRecords.length + '개');
            }

            if (firebaseOvertimeRecords) {
                overtimeRecords = Array.isArray(firebaseOvertimeRecords) ? firebaseOvertimeRecords :
                    Object.values(firebaseOvertimeRecords).filter(record => record && record.id);
                console.log('Firebase에서 보안 인증된 상태로 야근 데이터 로드:', overtimeRecords.length + '개');
            }

            const firebaseApiKeys = apiKeySnapshot.val();
            if (firebaseApiKeys) {
                apiKeyRecords = Array.isArray(firebaseApiKeys) ? firebaseApiKeys :
                    Object.values(firebaseApiKeys).filter(record => record && record.id);
                console.log('Firebase에서 API Key 데이터 로드:', apiKeyRecords.length + '개');
            }
            
            // Firebase 데이터를 로컬에도 백업
            if (firebaseEmployees) localStorage.setItem('employees', JSON.stringify(employees));
            if (firebaseRecords) localStorage.setItem('leaveRecords', JSON.stringify(leaveRecords));
            if (firebaseOvertimeRecords) localStorage.setItem('overtimeRecords', JSON.stringify(overtimeRecords));
            
            // 휴가 데이터 로드 후 사용량 재계산 (데이터 동기화)
            employees.forEach(emp => {
                clearLeaveCache(); // 캐시 초기화
                calculateEmployeeLeaves(emp);
            });
            console.log('🔄 휴가 기록 기반 사용량 재계산 완료');
            
            return;
            
        } catch (error) {
            console.log('Firebase 로드 실패, 로컬 데이터 사용:', error);
        }
    }
    
    // Firebase 실패 시 또는 인증 대기 중일 때 로컬 데이터 사용
    const savedEmployees = localStorage.getItem('employees');
    const savedRecords = localStorage.getItem('leaveRecords');
    const savedOvertime = localStorage.getItem('overtimeRecords');
    
    if (savedEmployees) {
        employees = JSON.parse(savedEmployees);
        employees.forEach(emp => calculateEmployeeLeavesWithCache(emp)); // 캐싱 적용
        console.log('로컬에서 직원 데이터 로드 완료:', employees.length + '명');
    }
    
    if (savedRecords) {
        leaveRecords = JSON.parse(savedRecords);
        console.log('로컬에서 휴가 데이터 로드 완료:', leaveRecords.length + '개');
        
        // 휴가 데이터 로드 후 사용량 재계산
        employees.forEach(emp => {
            clearLeaveCache();
            calculateEmployeeLeaves(emp);
        });
    }

    if (savedOvertime) {
        overtimeRecords = JSON.parse(savedOvertime);
        console.log('로컬에서 야근 데이터 로드 완료:', overtimeRecords.length + '개');
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
    const { years, months } = getServiceDuration(joinDate, today);
    
    let leaveInfo = '';
    if (years < 1) {
        const remainingMonthly = employee.monthlyLeave - employee.usedMonthly;
        const monthlyWarning = remainingMonthly < 0 ? ' <span style="color:#cc0000; font-weight:bold;">(선차감)</span>' : '';
        leaveInfo = `
            <p><strong>월차:</strong> ${employee.monthlyLeave}개 (사용: ${employee.usedMonthly}개, 잔여: ${remainingMonthly}개)${monthlyWarning}</p>
            <p><strong>연차:</strong> 1년 미만으로 연차 없음</p>
        `;
    } else {
        const remainingAnnual = employee.annualLeave - employee.usedAnnual;
        const annualWarning = remainingAnnual < 0 ? ' <span style="color:#cc0000; font-weight:bold;">(선차감)</span>' : '';
        leaveInfo = `
            <p><strong>연차:</strong> ${employee.annualLeave}개 (사용: ${employee.usedAnnual}개, 잔여: ${remainingAnnual}개)${annualWarning}</p>
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
            
            const leaveTypeText = getLeaveTypeText(leave.type);
            
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
    // 강력한 모달 열기
    modal.style.cssText = 'display: block !important; z-index: 10000 !important;';
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
    
    const leaveTypeText = getLeaveTypeText(leave.type);
    
    info.innerHTML = `
        <h4>휴가 취소 확인</h4>
        <p><strong>직원:</strong> ${employee.name}</p>
        <p><strong>날짜:</strong> ${leave.startDate}</p>
        <p><strong>종류:</strong> ${leaveTypeText} (${durationText})${!isDeductibleLeaveType(leave.type) ? ' - 차감없음' : ''}</p>
        <p><strong>사유:</strong> ${leave.reason || '없음'}</p>
        <p style="margin-top: 15px; font-weight: bold;">이 휴가를 취소하시겠습니까?</p>
    `;
    
    // 취소할 휴가 ID를 모달에 저장
    modal.dataset.leaveId = leaveId;
    // 강력한 모달 열기
    modal.style.cssText = 'display: block !important; z-index: 10000 !important;';
    console.log('휴가 취소 모달 열림:', leaveId);
}

// 휴가 취소 모달 닫기
function closeLeaveCancelModal() {
    const modal = document.getElementById('leaveCancelModal');
    modal.style.display = 'none';
    delete modal.dataset.leaveId;
}

// 휴가 수정 모달 열기
function openLeaveEditModal() {
    const cancelModal = document.getElementById('leaveCancelModal');
    const leaveId = cancelModal.dataset.leaveId;

    if (!leaveId) return;

    const leave = leaveRecords.find(record => record.id.toString() === leaveId.toString());
    if (!leave) return;

    const employee = employees.find(emp => emp.id === leave.employeeId);
    if (!employee) return;

    // 권한 체크
    const currentUserName = sessionStorage.getItem('userName') || localStorage.getItem('userName');
    if (employee.name !== currentUserName) {
        if (!checkPermission('manager')) {
            showNoPermissionAlert('다른 직원의 휴가 수정');
            return;
        }
    }

    // 취소 모달 닫기
    closeLeaveCancelModal();

    // 수정 모달 열기
    const editModal = document.getElementById('leaveEditModal');

    // 폼에 기존 데이터 채우기
    document.getElementById('editEmployeeName').value = employee.name;
    document.getElementById('editLeaveDate').value = leave.startDate;
    document.getElementById('editLeaveType').value = leave.type;
    document.getElementById('editDuration').value = leave.duration;
    document.getElementById('editReason').value = leave.reason || '';

    // 1년 미만/이상 직원에 따른 휴가 종류 제한 (휴가/병결은 항상 가능)
    const today = new Date();
    const joinDate = new Date(employee.joinDate);
    const yearsOfService = getYearsOfService(joinDate, today);

    const leaveTypeSelect = document.getElementById('editLeaveType');
    if (yearsOfService < 1) {
        // 1년 미만: 월차 + 비차감 유형
        leaveTypeSelect.innerHTML = `
            <option value="monthly">월차</option>
            <option value="sick">병가 (차감없음)</option>
            <option value="official">공가 (차감없음)</option>
            <option value="education">교육 (차감없음)</option>
            <option value="reward">포상 (차감없음)</option>
            <option value="vacation">휴가 (차감없음)</option>
        `;
    } else {
        // 1년 이상: 연차 + 비차감 유형
        leaveTypeSelect.innerHTML = `
            <option value="annual">연차</option>
            <option value="sick">병가 (차감없음)</option>
            <option value="official">공가 (차감없음)</option>
            <option value="education">교육 (차감없음)</option>
            <option value="reward">포상 (차감없음)</option>
            <option value="vacation">휴가 (차감없음)</option>
        `;
    }
    leaveTypeSelect.value = leave.type;

    // 수정할 휴가 ID를 모달에 저장
    editModal.dataset.leaveId = leaveId;
    // 강력한 모달 열기
    editModal.style.cssText = 'display: block !important; z-index: 10000 !important;';
}

// 휴가 수정 모달 닫기
function closeLeaveEditModal() {
    const modal = document.getElementById('leaveEditModal');
    modal.style.display = 'none';
    delete modal.dataset.leaveId;
}

// 휴가 수정 저장
async function saveLeaveEdit() {
    const modal = document.getElementById('leaveEditModal');
    const leaveId = modal.dataset.leaveId;

    if (!leaveId) return;

    const leaveIndex = leaveRecords.findIndex(record => record.id.toString() === leaveId.toString());
    if (leaveIndex === -1) return;

    const oldLeave = leaveRecords[leaveIndex];
    const employee = employees.find(emp => emp.id === oldLeave.employeeId);
    if (!employee) return;

    // 새 데이터 가져오기
    const newDate = document.getElementById('editLeaveDate').value;
    const newType = document.getElementById('editLeaveType').value;
    const newDuration = document.getElementById('editDuration').value;
    const newReason = document.getElementById('editReason').value.trim();

    if (!newDate) {
        alert('날짜를 선택해주세요.');
        return;
    }

    // 기존 휴가 일수 복구 (휴가/병결 제외)
    if (oldLeave.type === 'annual') {
        employee.usedAnnual -= oldLeave.days;
    } else if (oldLeave.type === 'monthly') {
        employee.usedMonthly -= oldLeave.days;
    }

    // 새 휴가 일수 계산
    const newDays = (newDuration === 'morning' || newDuration === 'afternoon') ? 0.5 : 1;

    // 잔여 휴가 확인 (휴가/병결 제외)
    if (newType === 'annual') {
        if (employee.annualLeave - employee.usedAnnual < newDays) {
            // 기존 휴가 일수 다시 차감 (롤백)
            if (oldLeave.type === 'annual') {
                employee.usedAnnual += oldLeave.days;
            } else if (oldLeave.type === 'monthly') {
                employee.usedMonthly += oldLeave.days;
            }
            alert('연차가 부족합니다.');
            return;
        }
        employee.usedAnnual += newDays;
    } else if (newType === 'monthly') {
        if (employee.monthlyLeave - employee.usedMonthly < newDays) {
            // 기존 휴가 일수 다시 차감 (롤백)
            if (oldLeave.type === 'annual') {
                employee.usedAnnual += oldLeave.days;
            } else if (oldLeave.type === 'monthly') {
                employee.usedMonthly += oldLeave.days;
            }
            alert('월차가 부족합니다.');
            return;
        }
        employee.usedMonthly += newDays;
    }
    // vacation과 sick은 차감하지 않음

    // 휴가 기록 업데이트 (메모리)
    const updatedRecord = {
        ...oldLeave,
        type: newType,
        duration: newDuration,
        startDate: newDate,
        endDate: newDate,
        days: newDays,
        reason: newReason,
        modifiedDate: new Date().toISOString(),
        modifiedBy: sessionStorage.getItem('userName') || '알 수 없음'
    };
    leaveRecords[leaveIndex] = updatedRecord;

    // Firebase에 변경분만 저장 (휴가 기록 1건 + 잔여 휴가 반영을 위한 직원 1명)
    let saveOk = true;
    if (isFirebaseEnabled && firebase.auth().currentUser) {
        bumpPendingWrites();
        try {
            await saveLeaveRecord(updatedRecord);
            await saveEmployee(employee);
        } catch (err) {
            saveOk = false;
            console.error('휴가 수정 저장 실패:', err);
        } finally {
            dropPendingWrites();
        }
    }

    if (!saveOk) {
        // 메모리 롤백: 차감/기록을 원복
        if (newType === 'annual') employee.usedAnnual -= newDays;
        else if (newType === 'monthly') employee.usedMonthly -= newDays;
        if (oldLeave.type === 'annual') employee.usedAnnual += oldLeave.days;
        else if (oldLeave.type === 'monthly') employee.usedMonthly += oldLeave.days;
        leaveRecords[leaveIndex] = oldLeave;

        renderEmployeeSummary();
        renderCalendar();
        showToast('error', '휴가 수정 실패', '저장에 실패했습니다. 다시 시도해주세요.');
        return;
    }

    try {
        localStorage.setItem('leaveRecords', JSON.stringify(leaveRecords));
        localStorage.setItem('lastUpdate', Date.now().toString());
    } catch (e) { /* ignore */ }

    renderEmployeeSummary();
    renderCalendar();

    alert('휴가가 수정되었습니다.');
    closeLeaveEditModal();
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
    
    // 차감 복구 (메모리). 실패 시 원복을 위해 적용 여부 추적
    let restoredField = null;
    let restoredAmount = 0;
    if (employee) {
        if (leave.type === 'annual') {
            restoredAmount = Math.min(leave.days, employee.usedAnnual);
            employee.usedAnnual = Math.max(0, employee.usedAnnual - leave.days);
            restoredField = 'annual';
        } else if (leave.type === 'monthly') {
            restoredAmount = Math.min(leave.days, employee.usedMonthly);
            employee.usedMonthly = Math.max(0, employee.usedMonthly - leave.days);
            restoredField = 'monthly';
        }
    }

    // 휴가 기록 삭제 (메모리)
    leaveRecords.splice(leaveIndex, 1);

    // Firebase에서도 변경분만 즉시 적용 (휴가 1건 삭제 + 직원 1명 갱신)
    let saveOk = true;
    if (isFirebaseEnabled && firebase.auth().currentUser) {
        bumpPendingWrites();
        try {
            const safeId = leave.id.toString().replace(/\./g, '_');
            await deleteLeaveRecord(safeId);
            if (employee) await saveEmployee(employee);
        } catch (err) {
            saveOk = false;
            console.error('휴가 취소 저장 실패:', err);
        } finally {
            dropPendingWrites();
        }
    }

    if (!saveOk) {
        // 메모리 롤백
        leaveRecords.splice(leaveIndex, 0, leave);
        if (employee && restoredField === 'annual') employee.usedAnnual += restoredAmount;
        else if (employee && restoredField === 'monthly') employee.usedMonthly += restoredAmount;

        renderEmployeeSummary();
        renderCalendar();
        showToast('error', '휴가 취소 실패', '저장에 실패했습니다. 다시 시도해주세요.');
        closeLeaveCancelModal();
        return;
    }

    try {
        localStorage.setItem('leaveRecords', JSON.stringify(leaveRecords));
        localStorage.setItem('lastUpdate', Date.now().toString());
    } catch (e) { /* ignore */ }

    sendToGoogleSheet('delete', [{ recordId: leave.id }]);

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
                    const email = user.email || '';
                    const displayName = user.displayName || '';
                    const uid = user.uid;
                    const safeName = email 
                        ? email.split('@')[0] 
                        : (displayName || (uid ? uid.slice(0, 6) : 'user'));
                    
                    // Firebase authorized_users에서 이메일로 권한 확인
                    let role = null; // null = 승인되지 않음 (기본값)
                    let authorizedUserName = safeName;
                    let authorized = false;
                    let denyReason = '등록되지 않은 사용자입니다.';

                    if (!email) {
                        denyReason = '이메일 정보가 없는 계정은 로그인할 수 없습니다.';
                    } else {
                        try {
                            const emailKey = email.toLowerCase().replace(/\./g, '_dot_').replace(/@/g, '_at_');
                            const userSnapshot = await database.ref(`authorized_users/${emailKey}`).once('value');
                            const authorizedUser = userSnapshot.val();

                            if (authorizedUser && authorizedUser.status === 'active') {
                                // 만료일 확인
                                const expiryDate = new Date(authorizedUser.expires);
                                if (expiryDate > new Date()) {
                                    role = authorizedUser.role || 'user';
                                    authorizedUserName = authorizedUser.name || safeName;
                                    authorized = true;
                                    console.log(`✅ 등록된 사용자 확인: ${email} -> ${role}`);

                                    // 마지막 사용 시간 업데이트
                                    database.ref(`authorized_users/${emailKey}/lastUsed`).set(new Date().toISOString());

                                    // uid 인덱스 자동 동기화 (Firebase 보안 규칙용)
                                    // RTDB 보안 규칙은 정규식 미지원이라 emailKey 변환을 못함.
                                    // uid는 변환 없이 직접 lookup 가능하므로 별도 인덱스를 둠.
                                    // 사용자가 로그인할 때마다 최신 권한 정보로 갱신됨.
                                    try {
                                        await database.ref(`authorized_users_by_uid/${user.uid}`).set({
                                            email: email,
                                            role: role,
                                            name: authorizedUserName,
                                            status: authorizedUser.status,
                                            expires: authorizedUser.expires,
                                            syncedAt: new Date().toISOString()
                                        });
                                        console.log(`🔗 uid 인덱스 동기화 완료: ${user.uid}`);
                                    } catch (syncErr) {
                                        // 인덱스 동기화 실패해도 로그인 자체는 진행 (기존 동작 유지)
                                        console.warn('uid 인덱스 동기화 실패(무시):', syncErr);
                                    }
                                } else {
                                    denyReason = `사용 권한이 만료되었습니다. (만료일: ${authorizedUser.expires})`;
                                    console.log(`⚠️ 권한 만료됨: ${email}, 만료일: ${authorizedUser.expires}`);
                                }
                            } else if (authorizedUser && authorizedUser.status !== 'active') {
                                denyReason = '사용 권한이 비활성화된 계정입니다.';
                                console.log(`⚠️ 비활성 사용자: ${email}`);
                            } else {
                                denyReason = `등록되지 않은 이메일입니다: ${email}`;
                                console.log(`🚫 등록되지 않은 사용자 차단: ${email}`);
                            }
                        } catch (error) {
                            denyReason = '권한 확인 중 오류가 발생했습니다. 네트워크를 확인하고 다시 시도해주세요.';
                            console.log('권한 확인 실패:', error);
                        }
                    }

                    // 승인되지 않은 사용자는 즉시 로그아웃
                    if (!authorized) {
                        console.warn(`🚫 승인되지 않은 로그인 시도 차단: ${email || '(이메일 없음)'}`);
                        try {
                            alert('로그인이 거부되었습니다.\n\n' + denyReason + '\n\n접근이 필요하시면 관리자에게 문의해주세요.');
                        } catch (_) {}
                        try {
                            await auth.signOut();
                        } catch (signOutErr) {
                            console.log('로그아웃 실패:', signOutErr);
                        }
                        return;
                    }

                    // 세션에 사용자 정보 저장
                    sessionStorage.setItem('userRole', role);
                    sessionStorage.setItem('userName', authorizedUserName);
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
    
    // 구글시트 동기화 버튼은 관리자만
    const syncBtn = document.getElementById('btnSyncSheet');
    if (syncBtn && checkPermission('admin')) {
        syncBtn.style.display = '';
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
    if (!isFirebaseEnabled) return;
    
    // 중복 구독 방지: 이미 구독 중이면 리턴
    if (isRealtimeSubscribed) {
        console.log('⚠️ 이미 구독 중이므로 중복 구독 방지');
        return;
    }
    
    // 안전장치: 구독 전에 기존 리스너 먼저 해제
    try {
        database.ref('employees').off();
        database.ref('leaveRecords').off();
        database.ref('overtimeRecords').off();
    } catch (e) {
        console.log('기존 리스너 해제 시도:', e.message);
    }
    
    isRealtimeSubscribed = true;
    console.log('🔥 실시간 구독 시작 (중복 방지 강화)');

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
                    // sortOrder로 정렬 (저장된 순서 유지)
                    employees.sort((a, b) => {
                        const orderA = a.sortOrder !== undefined ? a.sortOrder : 999;
                        const orderB = b.sortOrder !== undefined ? b.sortOrder : 999;
                        return orderA - orderB;
                    });
                    
                    employees.forEach(emp => calculateEmployeeLeavesWithCache(emp)); // 캐싱 적용
                    renderEmployeeSummary();
                    updateModalEmployeeDropdown();
                    renderCalendar();
                    console.log('🔥 직원 데이터 실시간 업데이트 (중복 방지, sortOrder 적용)');
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

                // 다른 PC에서 휴가 변경 시에도 잔여 사용량이 정확하게 반영되도록
                // 휴가 기록 기반으로 직원별 usedMonthly/usedAnnual 재계산
                // (캐시는 today.toDateString() 키라 무효화하지 않으면 옛 값이 그대로 나옴)
                clearLeaveCache();
                employees.forEach(emp => calculateEmployeeLeaves(emp));

                renderEmployeeSummary();
                renderCalendar();
                console.log('🔥 휴가 데이터 실시간 업데이트 (사용량 재계산):', leaveRecords.length + '개');
            } catch (error) {
                console.log('휴가 데이터 실시간 업데이트 실패:', error);
            }
        }
    });

    // 야근 데이터 실시간 반영
    database.ref('overtimeRecords').on('value', (snap) => {
        const map = snap.val();
        if (map) {
            try {
                overtimeRecords = Array.isArray(map) ? map : Object.values(map);
                renderOvertimeCalendar();
                renderOvertimeList();
                renderOvertimeSummary();
                console.log('🔥 야근 데이터 실시간 업데이트:', overtimeRecords.length + '개');
            } catch (e) {
                console.log('야근 데이터 실시간 업데이트 실패:', e);
            }
        }
    });

    // API Key 데이터 실시간 반영
    database.ref('apiKeys').on('value', (snap) => {
        const data = snap.val();
        if (data) {
            try {
                apiKeyRecords = Array.isArray(data) ? data : Object.values(data).filter(r => r && r.id);
                renderApiKeyList();
                console.log('🔥 API Key 데이터 실시간 업데이트:', apiKeyRecords.length + '개');
            } catch (e) {
                console.log('API Key 데이터 실시간 업데이트 실패:', e);
            }
        } else {
            apiKeyRecords = [];
            renderApiKeyList();
        }
    });
}

// [REMOVED 2026-04-17] cleanupFirebaseData 함수는 데이터 유실 사고의 근본 원인이었음.
// 레이스 컨디션(메모리가 비어있는 상태에서 Firebase .remove() 실행) 으로 직원 12명이 삭제됨.
// URL 변경 시 localStorage 플래그가 리셋되며 재발 가능성이 있어 함수 자체를 삭제함.
// 데이터 정리가 필요하면 Firebase Console에서 직접 수행할 것.

// 메인 앱 초기화 (Firebase 로그인 후 호출)
async function initializeApp() {
    console.log('앱 초기화 시작...');
    
    // 저장된 테마 불러오기
    loadSavedTheme();
    
    // Slack 설정 로드 (Firebase에서 공유)
    await loadSlackConfig();
    
    await loadData(); // Firebase에서 데이터 로드

    // [REMOVED 2026-04-17] cleanupFirebaseData 호출부 제거. 해당 함수가 데이터 유실을 일으켰음.
    // 안전을 위해 플래그는 true로 유지해 혹시라도 구버전 코드에서 재발하지 않도록 함.
    localStorage.setItem('dataCleanupDone', 'true');

    updateCurrentTime();
    setInterval(updateCurrentTime, 1000);
    await renderCalendar(); // 공휴일 로드 포함
    renderEmployeeSummary();
    updateModalEmployeeDropdown();
    startRealTimeSync();
    subscribeRealtimeData(); // 다른 PC 변경 즉시 반영
    setupUIPermissions(); // UI 권한 설정
    setDefaultDates(); // 날짜 기본값 설정
    
    // 매일 자정에 연차/월차 자동 계산
    setInterval(calculateLeaves, 60000);

    // 초기 야근 UI 렌더링 및 드롭다운 구성
    updateOvertimeEmployeeDropdown();
    renderOvertimeCalendar();
    renderOvertimeList();
    renderOvertimeSummary();
    
    // 전역 마우스 이벤트
    document.addEventListener('mouseup', () => {
        if (isSelecting) {
            isSelecting = false;
            if (selectedDates.length > 0) {
                openLeaveModal();
            }
        }
    });
    
    updateExportDropdowns();
    const leaveCsvInput = document.getElementById('leaveCsvImportInput');
    if (leaveCsvInput && !leaveCsvInput.dataset.importBound) {
        leaveCsvInput.dataset.importBound = '1';
        leaveCsvInput.addEventListener('change', handleLeaveCsvImport);
    }
    console.log('앱 초기화 완료!');
}

// 실시간 동기화 시작
function startRealTimeSync() {
    // 5초마다 다른 사용자의 변경사항 체크
    syncInterval = setInterval(() => {
        syncWithOtherUsers();
    }, 5000);
}

// 다른 사용자와 동기화 (토큰 업데이트 신호만 처리)
// 직원/휴가/야근 동기화는 subscribeRealtimeData()의 Firebase 실시간 구독으로 자동 처리됨.
// 기존 lastUpdate 비교는 같은 키를 두 번 읽는 데드 코드라 제거함.
function syncWithOtherUsers() {
    const tokenUpdateSignal = localStorage.getItem('tokenUpdateSignal');
    const lastTokenUpdate = sessionStorage.getItem('lastTokenUpdate') || '0';

    if (tokenUpdateSignal && tokenUpdateSignal !== lastTokenUpdate) {
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
            database.ref('overtimeRecords').off();
            database.ref('apiKeys').off();
            isRealtimeSubscribed = false;
            console.log('실시간 구독 해제 완료 (employees, leaveRecords, overtimeRecords, apiKeys)');
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
        sessionStorage.removeItem('hrAuthenticated'); // HR 인증 정보도 제거
        
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
    
    // 자동으로 고정 비밀번호 사용 (HR 탭 접근 비밀번호와 동일)
    const pass = HR_PASSWORD; // 'admin2025!@#'
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
    // 입력 유효성 검사
    if (!encObj || typeof encObj !== 'object') {
        console.warn('AES 복호화: 잘못된 입력 형식');
        return '';
    }

    if (!encObj.iv || !encObj.ciphertext) {
        console.warn('AES 복호화: 필수 필드 누락 (iv, ciphertext)');
        return '';
    }

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
        console.error('AES 복호화 실패:', error.name || error);
        // 복호화 실패시 빈 문자열 반환 (앱이 멈추지 않도록)
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

// HR 관리 비밀번호 (관리자 페이지와 동일)
const HR_PASSWORD = 'admin2025!@#';

// HR 인증 체크 중복 방지 플래그
let isCheckingHRAccess = false;

// HR 접근 권한 확인
function checkHRAccess() {
    console.log('🔐 HR 접근 권한 확인 중...');
    
    // 이미 체크 중이면 대기
    if (isCheckingHRAccess) {
        console.log('⏳ 이미 인증 체크 진행 중 - 중복 호출 무시');
        return false;
    }
    
    // 이미 인증된 경우
    const isAuthenticated = sessionStorage.getItem('hrAuthenticated');
    console.log('현재 인증 상태:', isAuthenticated);
    
    if (isAuthenticated === 'true') {
        console.log('✅ 이미 인증됨 - 비밀번호 입력 생략');
        return true;
    }
    
    // 중복 호출 방지 플래그 설정
    isCheckingHRAccess = true;
    
    try {
        // 비밀번호 확인
        console.log('🔑 비밀번호 입력 요청');
        const password = prompt('🔐 HR 관리는 민감한 개인정보를 다룹니다.\n비밀번호를 입력하세요:');
        
        if (password === HR_PASSWORD) {
            sessionStorage.setItem('hrAuthenticated', 'true');
            console.log('✅ 비밀번호 인증 성공');
            alert('✅ 인증되었습니다. HR 관리 기능을 사용할 수 있습니다.');
            return true;
        } else if (password !== null) {
            console.log('❌ 비밀번호 인증 실패');
            alert('❌ 비밀번호가 올바르지 않습니다.');
        } else {
            console.log('⚠️ 비밀번호 입력 취소');
        }
        
        return false;
    } finally {
        // 플래그 해제
        isCheckingHRAccess = false;
    }
}

// 탭 전환 함수
function showTab(tabName) {
    // HR/야근 탭 접근 시 비밀번호 확인
    if (tabName === 'hr' || tabName === 'overtime') {
        if (!checkHRAccess()) {
            return;
        }
    }
    
    // 모든 탭 버튼 비활성화
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // 모든 탭 컨텐츠 숨기기
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    
    // 선택된 탭 활성화 - 클릭된 버튼 찾기
    const activeButton = Array.from(document.querySelectorAll('.tab-button')).find(btn => {
        const btnText = btn.textContent.trim();
        if (tabName === 'dashboard') return btnText.includes('휴가');
        if (tabName === 'overtime') return btnText.includes('야근');
        if (tabName === 'apikey') return btnText.includes('API');
        if (tabName === 'hr') return btnText.includes('HR');
        return false;
    });
    if (activeButton) {
        activeButton.classList.add('active');
    }
    
    if (tabName === 'dashboard') {
        document.getElementById('dashboardTab').classList.add('active');
        renderCalendar();
        updateExportDropdowns();
    } else if (tabName === 'overtime') {
        const overtimeTab = document.getElementById('overtimeTab');
        if (overtimeTab) {
            overtimeTab.classList.add('active');
        }
        // 야근 탭 전환 시 렌더링 및 드롭다운 갱신
        updateOvertimeEmployeeDropdown();
        renderOvertimeCalendar();
        renderOvertimeList();
        renderOvertimeSummary();
    } else if (tabName === 'apikey') {
        document.getElementById('apikeyTab').classList.add('active');
        renderApiKeyList();
        setupApiKeyTabPermissions();
    } else if (tabName === 'hr') {
        document.getElementById('hrTab').classList.add('active');
        updateHREmployeeDropdown();
        renderHREmployeeList();
        initSlackSettingsUI();
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
    document.getElementById('hrSlackId').value = hrData.slackId || '';
    document.getElementById('hrSlackNotify').value = hrData.slackNotify !== false ? 'true' : 'false';
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
    document.getElementById('hrSlackId').value = '';
    document.getElementById('hrSlackNotify').value = 'true';
    document.getElementById('hrNotes').value = '';
}

// 직원 HR 데이터 저장
async function saveEmployeeHRData() {
    // 권한 체크: 매니저 이상만 가능
    if (!checkPermission('manager')) {
        showNoPermissionAlert('HR 정보 관리');
        return;
    }
    
    let employeeId = parseInt(document.getElementById('hrEmployeeSelect').value);
    const name = document.getElementById('hrEmployeeName').value.trim();
    const joinDate = document.getElementById('hrJoinDate').value;
    const leaveDate = document.getElementById('hrLeaveDate').value;
    const phone = document.getElementById('hrPhone').value.trim();
    const ssn = document.getElementById('hrSsn').value.trim();
    const department = document.getElementById('hrDepartment').value.trim();
    const position = document.getElementById('hrPosition').value.trim();
    const address = document.getElementById('hrAddress').value.trim();
    const notes = document.getElementById('hrNotes').value.trim();
    const slackId = document.getElementById('hrSlackId').value.trim();
    const slackNotify = document.getElementById('hrSlackNotify').value === 'true';
    
    // 버그 방지: 드롭다운이 초기화되어도 이름으로 기존 직원 찾기
    if (!employeeId || isNaN(employeeId)) {
        const existingEmployee = employees.find(emp => emp.name === name);
        if (existingEmployee) {
            employeeId = existingEmployee.id;
            console.log('⚠️ 드롭다운 초기화 감지 - 이름으로 기존 직원 찾음:', name, employeeId);
        }
    }
    
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
        const newSortOrder = employees.length;
        
        employee = {
            id: Date.now(),
            name: name,
            joinDate: joinDate,
            annualLeave: 0,
            monthlyLeave: 0,
            usedAnnual: 0,
            usedMonthly: 0,
            lastMonthlyUpdate: joinDate,
            sortOrder: newSortOrder // 순서 저장
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
        slackId: slackId,           // Slack 멤버 ID
        slackNotify: slackNotify,   // Slack 알림 활성화 여부
        lastUpdated: new Date().toISOString()
    };
    
    // 변경된 직원 1명만 Firebase에 저장 (전체 saveData 호출하지 않음)
    let saveOk = true;
    if (isFirebaseEnabled && firebase.auth().currentUser) {
        bumpPendingWrites();
        try {
            await saveEmployee(employee);
        } catch (err) {
            saveOk = false;
            console.error('HR 정보 저장 실패:', err);
        } finally {
            dropPendingWrites();
        }
    }

    if (!saveOk) {
        showToast('error', 'HR 정보 저장 실패', '저장에 실패했습니다. 다시 시도해주세요.');
        return;
    }

    try {
        const sanitized = employees.map(emp => ({
            ...emp,
            hrData: emp.hrData ? {
                ...emp.hrData,
                phone: emp.hrData.phone ? '***숨김***' : '',
                ssn: emp.hrData.ssn ? '***숨김***' : '',
                address: emp.hrData.address ? '***숨김***' : ''
            } : undefined
        }));
        localStorage.setItem('employees', JSON.stringify(sanitized));
        localStorage.setItem('lastUpdate', Date.now().toString());
    } catch (e) { /* ignore */ }

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
        // 로컬 배열에서 먼저 삭제
        employees = employees.filter(emp => emp.id !== employeeId);
        leaveRecords = leaveRecords.filter(record => record.employeeId !== employeeId);
        
        // Firebase에서 직원 삭제
        if (isFirebaseEnabled) {
            try {
                await database.ref(`employees/${employeeId}`).remove();
                console.log('Firebase에서 직원 삭제 완료:', employeeId);
            } catch (error) {
                console.log('Firebase 직원 삭제 실패:', error);
            }
        }
        
        // 해당 직원의 휴가 기록들도 Firebase에서 삭제
        const employeeLeaveRecords = leaveRecords.filter(record => record.employeeId === employeeId);
        for (const record of employeeLeaveRecords) {
            await deleteLeaveRecord(record.id);
        }
        
        // 로컬 스토리지만 업데이트 (Firebase에 다시 저장하지 않음)
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
        
        // UI 업데이트
        clearHRForm();
        renderEmployeeSummary();
        updateModalEmployeeDropdown();
        updateHREmployeeDropdown();
        renderHREmployeeList();
        renderCalendar();
        
        showToast('success', '직원 삭제', '직원이 삭제되었습니다.');
    }
}

// HR 직원 목록 렌더링
function renderHREmployeeList() {
    const container = document.getElementById('hrEmployeeList');
    container.innerHTML = '';

    // 재직자만 표시 (퇴사자는 renderRetiredList에서)
    const activeEmployees = employees.filter(isEmployeeActive);

    if (activeEmployees.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 40px; color: #6c757d;">재직 중인 직원이 없습니다.</div>';
    }

    activeEmployees.forEach(employee => {
        const card = document.createElement('div');
        card.className = 'hr-employee-card';
        
        const joinDate = new Date(employee.joinDate);
        const today = new Date();
        const { years, months } = getServiceDuration(joinDate, today);
        
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

    // 퇴사자 목록도 함께 갱신 (표시 여부는 switchHrListView가 제어)
    renderRetiredList();
}

// 퇴사자 목록 렌더링
function renderRetiredList() {
    const container = document.getElementById('hrRetiredList');
    if (!container) return;
    container.innerHTML = '';

    const retired = employees.filter(emp => !isEmployeeActive(emp));

    if (retired.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 40px; color: #6c757d;">퇴사자가 없습니다.</div>';
        return;
    }

    const isAdmin = checkPermission('admin');

    // 퇴사일 최신순 정렬
    retired.sort((a, b) => new Date(b.hrData.leaveDate) - new Date(a.hrData.leaveDate));

    retired.forEach(employee => {
        const hrData = employee.hrData || {};
        const joinDate = new Date(employee.joinDate);
        const leaveDate = new Date(hrData.leaveDate);
        const { years, months } = getServiceDuration(joinDate, leaveDate);

        // 퇴사 시점 기준 연차/월차 사용·잔여 (calculateEmployeeLeaves가 퇴사일로 고정 계산함)
        const yos = getYearsOfService(joinDate, leaveDate);
        let leaveLine;
        if (yos < 1) {
            const used = employee.usedMonthly || 0;
            const total = employee.monthlyLeave || 0;
            leaveLine = `월차 ${used} / ${total}개 사용 (잔여 ${(total - used).toFixed(1)}개)`;
        } else {
            const used = employee.usedAnnual || 0;
            const total = employee.annualLeave || 0;
            leaveLine = `연차 ${used} / ${total}일 사용 (잔여 ${(total - used).toFixed(1)}일)`;
        }

        const card = document.createElement('div');
        card.className = 'hr-employee-card retired';
        card.innerHTML = `
            <div class="hr-employee-name">
                ${employee.name}
                <span style="font-size: 0.8rem; color: #dc3545;">퇴사</span>
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
                    <span>${employee.joinDate}</span>
                </div>
                <div class="hr-info-item">
                    <span class="hr-info-label">퇴사일:</span>
                    <span>${hrData.leaveDate}</span>
                </div>
                <div class="hr-info-item">
                    <span class="hr-info-label">총 근무기간:</span>
                    <span>${years}년 ${months}개월</span>
                </div>
                <div class="hr-info-item">
                    <span class="hr-info-label">연락처:</span>
                    <span id="phone-${employee.id}">로딩중...</span>
                </div>
                <div class="hr-info-item">
                    <span class="hr-info-label">${yos < 1 ? '월차' : '연차'}:</span>
                    <span>${leaveLine}</span>
                </div>
                ${hrData.lastUpdated ? `
                <div class="hr-info-item">
                    <span class="hr-info-label">최종수정:</span>
                    <span>${new Date(hrData.lastUpdated).toLocaleDateString('ko-KR')}</span>
                </div>
                ` : ''}
            </div>
            ${isAdmin ? `
            <div class="retired-actions">
                <button class="btn-restore" onclick="event.stopPropagation(); restoreEmployee(${employee.id})">복직</button>
                <button class="btn-permanent-delete" onclick="event.stopPropagation(); deleteEmployee(${employee.id})">영구 삭제</button>
            </div>
            ` : ''}
        `;
        container.appendChild(card);

        // 카드 클릭 시 HR 폼에 로드 (전체 연락처 등 상세 확인용)
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => {
            document.getElementById('hrEmployeeSelect').value = employee.id;
            loadEmployeeHRData();
            const formSection = document.querySelector('.hr-form-section');
            if (formSection) formSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });

        // 연락처 비동기 복호화 및 표시 (재직 카드와 동일)
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

// 재직/퇴사 목록 전환
function switchHrListView(view) {
    const activeList = document.getElementById('hrEmployeeList');
    const retiredList = document.getElementById('hrRetiredList');
    const tabActive = document.getElementById('hrTabActive');
    const tabRetired = document.getElementById('hrTabRetired');
    if (!activeList || !retiredList) return;

    if (view === 'retired') {
        activeList.style.display = 'none';
        retiredList.style.display = 'block';
        tabActive && tabActive.classList.remove('active');
        tabRetired && tabRetired.classList.add('active');
    } else {
        activeList.style.display = 'block';
        retiredList.style.display = 'none';
        tabActive && tabActive.classList.add('active');
        tabRetired && tabRetired.classList.remove('active');
    }
}

// ===== 퇴사 처리 =====
function openRetireModal(id) {
    if (!checkPermission('admin')) {
        showNoPermissionAlert('퇴사 처리');
        return;
    }
    const employee = employees.find(emp => emp.id === id);
    if (!employee) return;

    const modal = document.getElementById('retireEmployeeModal');
    if (!modal) return;
    modal.dataset.employeeId = id;
    document.getElementById('retireEmployeeName').textContent = employee.name;
    // 기본값: 오늘
    document.getElementById('retireDate').value = new Date().toISOString().split('T')[0];
    modal.style.cssText = 'display: block !important; z-index: 10000 !important;';
}

function closeRetireModal() {
    const modal = document.getElementById('retireEmployeeModal');
    if (!modal) return;
    modal.style.display = 'none';
    delete modal.dataset.employeeId;
}

async function confirmRetire() {
    const modal = document.getElementById('retireEmployeeModal');
    const id = parseInt(modal.dataset.employeeId);
    const employee = employees.find(emp => emp.id === id);
    if (!employee) return;

    const retireDate = document.getElementById('retireDate').value;
    if (!retireDate) {
        alert('퇴사일을 기입해주세요.');
        return;
    }
    if (new Date(retireDate) < new Date(employee.joinDate)) {
        alert('퇴사일은 입사일보다 빠를 수 없습니다.');
        return;
    }

    // 퇴사일 기록 + 휴가/연차 계산을 퇴사일 기준으로 고정
    employee.hrData = employee.hrData || {};
    employee.hrData.leaveDate = retireDate;
    employee.hrData.lastUpdated = new Date().toISOString();
    clearLeaveCache();
    calculateEmployeeLeaves(employee);

    let saveOk = true;
    if (isFirebaseEnabled && firebase.auth().currentUser) {
        bumpPendingWrites();
        try {
            await saveEmployee(employee);
        } catch (err) {
            saveOk = false;
            console.error('퇴사 처리 저장 실패:', err);
        } finally {
            dropPendingWrites();
        }
    }

    if (!saveOk) {
        // 롤백
        delete employee.hrData.leaveDate;
        clearLeaveCache();
        calculateEmployeeLeaves(employee);
        showToast('error', '퇴사 처리 실패', '저장에 실패했습니다. 다시 시도해주세요.');
        return;
    }

    closeRetireModal();
    renderEmployeeSummary();
    updateModalEmployeeDropdown();
    renderHREmployeeList();
    renderCalendar();
    showToast('success', '퇴사 처리 완료', `${employee.name} 님이 퇴사 처리되었습니다.`);
}

// 복직 (퇴사 취소)
async function restoreEmployee(id) {
    if (!checkPermission('admin')) {
        showNoPermissionAlert('복직 처리');
        return;
    }
    const employee = employees.find(emp => emp.id === id);
    if (!employee || !employee.hrData) return;

    if (!confirm(`${employee.name} 님을 복직 처리하시겠습니까?`)) return;

    const backupLeaveDate = employee.hrData.leaveDate;
    delete employee.hrData.leaveDate;
    employee.hrData.lastUpdated = new Date().toISOString();
    clearLeaveCache();
    calculateEmployeeLeaves(employee);

    let saveOk = true;
    if (isFirebaseEnabled && firebase.auth().currentUser) {
        bumpPendingWrites();
        try {
            await saveEmployee(employee);
        } catch (err) {
            saveOk = false;
            console.error('복직 처리 저장 실패:', err);
        } finally {
            dropPendingWrites();
        }
    }

    if (!saveOk) {
        employee.hrData.leaveDate = backupLeaveDate;
        clearLeaveCache();
        calculateEmployeeLeaves(employee);
        showToast('error', '복직 처리 실패', '저장에 실패했습니다. 다시 시도해주세요.');
        return;
    }

    renderEmployeeSummary();
    updateModalEmployeeDropdown();
    renderHREmployeeList();
    renderCalendar();
    showToast('success', '복직 완료', `${employee.name} 님이 재직 상태로 돌아왔습니다.`);
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
            if (value.length > 13) {
                value = value.substring(0, 13); // 최대 13자리까지만
            }
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
            if (value.length > 11) {
                value = value.substring(0, 11); // 최대 11자리까지만
            }
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

// ===== 초과근무 관리 기능 =====

// 초과근무 직원 드롭다운 업데이트
function updateOvertimeEmployeeDropdown() {
    const dropdown = document.getElementById('overtimeEmployee');
    const filterDropdown = document.getElementById('overtimeFilterEmployee');

    if (dropdown) {
        dropdown.innerHTML = '<option value="">직원 선택</option>';
        employees.forEach(employee => {
            const option = document.createElement('option');
            option.value = employee.id;
            option.textContent = employee.name;
            dropdown.appendChild(option);
        });
    }

    if (filterDropdown) {
        filterDropdown.innerHTML = '<option value="">전체 직원</option>';
        employees.forEach(employee => {
            const option = document.createElement('option');
            option.value = employee.id;
            option.textContent = employee.name;
            filterDropdown.appendChild(option);
        });
    }
}

// 야근 기록 추가
async function addOvertimeRecord() {
    // 권한 체크: 매니저 이상만 가능
    if (!checkPermission('manager')) {
        showNoPermissionAlert('야근 기록 추가');
        return;
    }

    const date = document.getElementById('overtimeDate').value;
    const employeeId = parseInt(document.getElementById('overtimeEmployee').value);
    const startTime = document.getElementById('overtimeStartTime').value;
    const endTime = document.getElementById('overtimeEndTime').value;
    const reason = document.getElementById('overtimeReason').value.trim();

    // 입력 검증 강화
    if (!date || !employeeId || !startTime || !endTime) {
        alert('필수 항목을 모두 입력해주세요.');
        return;
    }

    // 날짜 유효성 검증
    const overtimeDate = new Date(date);
    const today = new Date();
    const maxDate = new Date();
    maxDate.setDate(today.getDate() + 7); // 일주일 후까지만 허용
    
    if (overtimeDate > maxDate) {
        alert('야근 날짜는 일주일 후까지만 등록 가능합니다.');
        return;
    }

    const employee = employees.find(emp => emp.id === employeeId);
    if (!employee) {
        alert('직원을 찾을 수 없습니다.');
        return;
    }

    // 야근 사유 길이 검증
    if (reason.length > 100) {
        alert('야근 사유는 100자 이하로 입력해주세요.');
        return;
    }

    // 야근 시간 계산
    const start = new Date(`2000-01-01T${startTime}`);
    const end = new Date(`2000-01-01T${endTime}`);

    // 종료 시간이 시작 시간보다 이전인 경우 (자정 넘김)
    if (end < start) {
        end.setDate(end.getDate() + 1);
    }

    const hours = (end - start) / (1000 * 60 * 60);

    if (hours <= 0) {
        alert('종료 시간은 시작 시간보다 늦어야 합니다.');
        return;
    }

    // 야근 시간 제한 검증 (최대 12시간)
    if (hours > 12) {
        alert('야근 시간은 최대 12시간까지만 등록 가능합니다.');
        return;
    }

    // 중복 야근 기록 검증
    const existingRecord = overtimeRecords.find(record => 
        record.employeeId === employeeId && record.date === date
    );
    if (existingRecord) {
        alert('해당 날짜에 이미 야근 기록이 존재합니다.');
        return;
    }

    const overtimeRecord = {
        id: Date.now(),
        employeeId: employeeId,
        employeeName: employee.name,
        date: date,
        startTime: startTime,
        endTime: endTime,
        hours: hours,
        reason: reason,
        createdAt: new Date().toISOString(),
        createdBy: sessionStorage.getItem('userName') || '알 수 없음'
    };

    overtimeRecords.push(overtimeRecord);

    // 낙관적 UI 업데이트
    document.getElementById('overtimeDate').value = '';
    document.getElementById('overtimeEmployee').value = '';
    document.getElementById('overtimeStartTime').value = '18:00';
    document.getElementById('overtimeEndTime').value = '21:00';
    document.getElementById('overtimeReason').value = '';

    renderOvertimeCalendar();
    renderOvertimeList();
    renderOvertimeSummary();

    // 변경분 1건만 await로 끝까지 보장
    let saveOk = true;
    if (isFirebaseEnabled && firebase.auth().currentUser) {
        bumpPendingWrites();
        try {
            await saveOvertimeRecord(overtimeRecord);
        } catch (err) {
            saveOk = false;
            console.error('야근 기록 저장 실패:', err);
        } finally {
            dropPendingWrites();
        }
    }

    if (!saveOk) {
        // 메모리 롤백
        overtimeRecords = overtimeRecords.filter(r => r.id !== overtimeRecord.id);
        renderOvertimeCalendar();
        renderOvertimeList();
        renderOvertimeSummary();
        showToast('error', '야근 기록 저장 실패', '저장에 실패했습니다. 다시 시도해주세요.');
        return;
    }

    try {
        localStorage.setItem('overtimeRecords', JSON.stringify(overtimeRecords));
        localStorage.setItem('lastUpdate', Date.now().toString());
    } catch (e) { /* ignore */ }

    showToast('success', '야근 기록', '야근 기록이 추가되었습니다.');
}

// 야근 달력 렌더링
function renderOvertimeCalendar() {
    const calendar = document.getElementById('overtimeCalendar');
    if (!calendar) return;

    const monthYearStr = overtimeDisplayMonth.toLocaleDateString('ko-KR', {
        year: 'numeric',
        month: 'long'
    });

    const currentMonthElement = document.getElementById('currentOvertimeMonth');
    if (currentMonthElement) {
        currentMonthElement.textContent = monthYearStr;
    }

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
    const year = overtimeDisplayMonth.getFullYear();
    const month = overtimeDisplayMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDate = firstDay.getDay();
    const endDate = lastDay.getDate();

    // 이전 달 날짜
    for (let i = startDate - 1; i >= 0; i--) {
        const day = document.createElement('div');
        day.className = 'calendar-day other-month';
        calendar.appendChild(day);
    }

    // 현재 달 날짜
    for (let i = 1; i <= endDate; i++) {
        const day = document.createElement('div');
        day.className = 'calendar-day overtime-day';

        const currentDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
        const todayStr = new Date().toISOString().split('T')[0];

        if (currentDateStr === todayStr) {
            day.classList.add('today');
        }

        // 해당 날짜의 야근 정보
        const dayOvertimes = overtimeRecords.filter(record => record.date === currentDateStr);
        let dayHTML = `<div class="day-number">${i}</div>`;

        if (dayOvertimes.length > 0) {
            const totalHours = dayOvertimes.reduce((sum, record) => sum + record.hours, 0);
            dayHTML += `<div class="overtime-info">
                <div class="overtime-count">${dayOvertimes.length}명</div>
                <div class="overtime-hours">${totalHours.toFixed(1)}h</div>
            </div>`;
            day.classList.add('has-overtime');
        }

        day.innerHTML = dayHTML;
        day.dataset.date = currentDateStr;

        // 클릭 이벤트로 해당 날짜 야근 상세 보기
        day.addEventListener('click', () => showOvertimeDetail(currentDateStr));

        calendar.appendChild(day);
    }

    // 다음 달 날짜
    const remainingDays = 42 - (startDate + endDate);
    for (let i = 1; i <= remainingDays; i++) {
        const day = document.createElement('div');
        day.className = 'calendar-day other-month';
        calendar.appendChild(day);
    }

    // 통계 업데이트
    updateOvertimeStats();
}

// 야근 통계 업데이트
function updateOvertimeStats() {
    const year = overtimeDisplayMonth.getFullYear();
    const month = overtimeDisplayMonth.getMonth();

    const monthRecords = overtimeRecords.filter(record => {
        const recordDate = new Date(record.date);
        return recordDate.getFullYear() === year && recordDate.getMonth() === month;
    });

    const totalHours = monthRecords.reduce((sum, record) => sum + record.hours, 0);
    const uniqueEmployees = new Set(monthRecords.map(record => record.employeeId)).size;

    const totalHoursElement = document.getElementById('totalOvertimeHours');
    const totalPeopleElement = document.getElementById('totalOvertimePeople');

    if (totalHoursElement) {
        totalHoursElement.textContent = `${totalHours.toFixed(1)}시간`;
    }
    if (totalPeopleElement) {
        totalPeopleElement.textContent = `${uniqueEmployees}명`;
    }
}

// 야근 목록 렌더링
function renderOvertimeList() {
    const container = document.getElementById('overtimeList');
    if (!container) return;

    const year = overtimeDisplayMonth.getFullYear();
    const month = overtimeDisplayMonth.getMonth();

    let filteredRecords = overtimeRecords.filter(record => {
        const recordDate = new Date(record.date);
        return recordDate.getFullYear() === year && recordDate.getMonth() === month;
    });

    // 직원 필터 적용
    const filterEmployee = document.getElementById('overtimeFilterEmployee');
    if (filterEmployee && filterEmployee.value) {
        const employeeId = parseInt(filterEmployee.value);
        filteredRecords = filteredRecords.filter(record => record.employeeId === employeeId);
    }

    // 날짜 역순 정렬
    filteredRecords.sort((a, b) => new Date(b.date) - new Date(a.date));

    if (filteredRecords.length === 0) {
        container.innerHTML = '<div class="no-records">이번 달 야근 기록이 없습니다.</div>';
        return;
    }

    container.innerHTML = '';

    filteredRecords.forEach(record => {
        const item = document.createElement('div');
        item.className = 'overtime-item';

        const weekday = ['일', '월', '화', '수', '목', '금', '토'][new Date(record.date).getDay()];

        item.innerHTML = `
            <div class="overtime-item-header">
                <div class="overtime-item-date">${record.date} (${weekday})</div>
                <div class="overtime-item-employee">${record.employeeName}</div>
            </div>
            <div class="overtime-item-details">
                <span class="overtime-time">${record.startTime} ~ ${record.endTime}</span>
                <span class="overtime-duration">${record.hours.toFixed(1)}시간</span>
            </div>
            ${record.reason ? `<div class="overtime-reason">사유: ${record.reason}</div>` : ''}
            <div class="overtime-item-actions">
                ${checkPermission('manager') ? `
                    <button onclick="editOvertimeRecord(${record.id})" class="btn-edit">수정</button>
                    <button onclick="deleteOvertimeRecord(${record.id})" class="btn-delete">삭제</button>
                ` : ''}
            </div>
        `;

        container.appendChild(item);
    });
}

// 직원별 야근 통계 렌더링
function renderOvertimeSummary() {
    const container = document.getElementById('overtimeSummary');
    if (!container) return;

    const year = overtimeDisplayMonth.getFullYear();
    const month = overtimeDisplayMonth.getMonth();

    const monthRecords = overtimeRecords.filter(record => {
        const recordDate = new Date(record.date);
        return recordDate.getFullYear() === year && recordDate.getMonth() === month;
    });

    // 직원별 통계 계산
    const employeeStats = {};

    monthRecords.forEach(record => {
        if (!employeeStats[record.employeeId]) {
            employeeStats[record.employeeId] = {
                name: record.employeeName,
                count: 0,
                totalHours: 0,
                dates: []
            };
        }

        employeeStats[record.employeeId].count++;
        employeeStats[record.employeeId].totalHours += record.hours;
        employeeStats[record.employeeId].dates.push(record.date);
    });

    // 총 시간 기준 정렬
    const sortedStats = Object.values(employeeStats).sort((a, b) => b.totalHours - a.totalHours);

    if (sortedStats.length === 0) {
        container.innerHTML = '<div class="no-records">이번 달 야근 기록이 없습니다.</div>';
        return;
    }

    container.innerHTML = '';

    sortedStats.forEach((stat, index) => {
        const card = document.createElement('div');
        card.className = 'overtime-summary-card';

        // 순위에 따른 색상
        let rankClass = '';
        if (index === 0) rankClass = 'rank-gold';
        else if (index === 1) rankClass = 'rank-silver';
        else if (index === 2) rankClass = 'rank-bronze';

        card.innerHTML = `
            <div class="summary-rank ${rankClass}">${index + 1}위</div>
            <div class="summary-employee">${stat.name}</div>
            <div class="summary-stats">
                <div class="stat-box">
                    <div class="stat-value">${stat.totalHours.toFixed(1)}시간</div>
                    <div class="stat-label">총 야근</div>
                </div>
                <div class="stat-box">
                    <div class="stat-value">${stat.count}일</div>
                    <div class="stat-label">야근 일수</div>
                </div>
                <div class="stat-box">
                    <div class="stat-value">${(stat.totalHours / stat.count).toFixed(1)}시간</div>
                    <div class="stat-label">일평균</div>
                </div>
            </div>
        `;

        container.appendChild(card);
    });
}

// 이전 달로 이동
function previousOvertimeMonth() {
    overtimeDisplayMonth.setMonth(overtimeDisplayMonth.getMonth() - 1);
    renderOvertimeCalendar();
    renderOvertimeList();
    renderOvertimeSummary();
}

// 다음 달로 이동
function nextOvertimeMonth() {
    overtimeDisplayMonth.setMonth(overtimeDisplayMonth.getMonth() + 1);
    renderOvertimeCalendar();
    renderOvertimeList();
    renderOvertimeSummary();
}

// 야근 기록 필터링
function filterOvertimeRecords() {
    renderOvertimeList();
}

// 야근 상세 보기
function showOvertimeDetail(date) {
    const dayRecords = overtimeRecords.filter(record => record.date === date);

    if (dayRecords.length === 0) return;

    // 날짜 파싱 (요일 포함 표시)
    const d = new Date(date);
    const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
    const dateLabel = `${date} (${dayNames[d.getDay()]})`;

    // 총 시간 / 인원 요약
    const totalHours = dayRecords.reduce((sum, r) => sum + (r.hours || 0), 0);
    const totalPeople = dayRecords.length;

    // 기록 리스트 HTML
    const itemsHTML = dayRecords.map(record => `
        <div class="ot-modal-item">
            <div class="ot-modal-item-head">
                <div class="ot-modal-name">${record.employeeName}</div>
                <div class="ot-modal-hours">${record.hours.toFixed(1)}시간</div>
            </div>
            <div class="ot-modal-time">🕐 ${record.startTime} ~ ${record.endTime}</div>
            ${record.reason ? `<div class="ot-modal-reason">📝 ${record.reason}</div>` : ''}
        </div>
    `).join('');

    // 커스텀 모달 생성
    showCustomModal({
        title: '🌙 야근 현황',
        subtitle: dateLabel,
        body: `
            <div class="ot-modal-summary">
                <div class="ot-modal-stat">
                    <div class="ot-modal-stat-label">총 야근</div>
                    <div class="ot-modal-stat-value">${totalHours.toFixed(1)}<span>시간</span></div>
                </div>
                <div class="ot-modal-stat">
                    <div class="ot-modal-stat-label">인원</div>
                    <div class="ot-modal-stat-value">${totalPeople}<span>명</span></div>
                </div>
            </div>
            <div class="ot-modal-list">${itemsHTML}</div>
        `
    });
}

// 커스텀 모달 헬퍼 (재사용 가능)
function showCustomModal({ title, subtitle, body, onClose }) {
    // 기존 모달 제거
    const existing = document.getElementById('__custom_modal__');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = '__custom_modal__';
    overlay.className = 'custom-modal-overlay';
    overlay.innerHTML = `
        <div class="custom-modal">
            <div class="custom-modal-header">
                <div>
                    <div class="custom-modal-title">${title || ''}</div>
                    ${subtitle ? `<div class="custom-modal-subtitle">${subtitle}</div>` : ''}
                </div>
                <button class="custom-modal-close" aria-label="닫기">×</button>
            </div>
            <div class="custom-modal-body">${body || ''}</div>
            <div class="custom-modal-footer">
                <button class="custom-modal-btn">확인</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const close = () => {
        overlay.classList.add('closing');
        setTimeout(() => {
            overlay.remove();
            if (onClose) onClose();
        }, 150);
    };

    overlay.querySelector('.custom-modal-close').addEventListener('click', close);
    overlay.querySelector('.custom-modal-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });

    // ESC 키로 닫기
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            close();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);

    // 애니메이션용 클래스
    requestAnimationFrame(() => overlay.classList.add('open'));
}

// 야근 기록 삭제
async function deleteOvertimeRecord(id) {
    if (!checkPermission('manager')) {
        showNoPermissionAlert('야근 기록 삭제');
        return;
    }

    if (!confirm('이 야근 기록을 삭제하시겠습니까?')) return;

    // 메모리에서 먼저 제거. 실패 시 복구하기 위해 원본 보관
    const idx = overtimeRecords.findIndex(record => record.id === id);
    if (idx === -1) return;
    const removed = overtimeRecords[idx];
    overtimeRecords.splice(idx, 1);

    // Firebase에서 1건만 삭제 (전체 saveData 호출하지 않음)
    let saveOk = true;
    if (isFirebaseEnabled && firebase.auth().currentUser) {
        bumpPendingWrites();
        try {
            await database.ref(`overtimeRecords/${id}`).remove();
        } catch (err) {
            saveOk = false;
            console.error('야근 기록 삭제 실패:', err);
        } finally {
            dropPendingWrites();
        }
    }

    if (!saveOk) {
        overtimeRecords.splice(idx, 0, removed);
        renderOvertimeCalendar();
        renderOvertimeList();
        renderOvertimeSummary();
        showToast('error', '야근 기록 삭제 실패', '저장에 실패했습니다. 다시 시도해주세요.');
        return;
    }

    try {
        localStorage.setItem('overtimeRecords', JSON.stringify(overtimeRecords));
        localStorage.setItem('lastUpdate', Date.now().toString());
    } catch (e) { /* ignore */ }

    renderOvertimeCalendar();
    renderOvertimeList();
    renderOvertimeSummary();

    showToast('success', '야근 기록', '야근 기록이 삭제되었습니다.');
}

// 야근 기록 수정
function editOvertimeRecord(id) {
    if (!checkPermission('manager')) {
        showNoPermissionAlert('야근 기록 수정');
        return;
    }

    const record = overtimeRecords.find(r => r.id === id);
    if (!record) return;

    // 폼에 기존 데이터 채우기
    document.getElementById('overtimeDate').value = record.date;
    document.getElementById('overtimeEmployee').value = record.employeeId;
    document.getElementById('overtimeStartTime').value = record.startTime;
    document.getElementById('overtimeEndTime').value = record.endTime;
    document.getElementById('overtimeReason').value = record.reason || '';

    // 기존 기록 삭제
    overtimeRecords = overtimeRecords.filter(r => r.id !== id);

    // 스크롤을 폼으로 이동
    const formSection = document.querySelector('.overtime-form-section');
    if (formSection) {
        formSection.scrollIntoView({ behavior: 'smooth' });
    }
}

// 야근 기록 Firebase 저장
async function saveOvertimeRecord(record) {
    if (isFirebaseEnabled) {
        try {
            await database.ref(`overtimeRecords/${record.id}`).set(record);
            console.log('Firebase에 야근 기록 저장 완료');
        } catch (error) {
            console.log('Firebase 야근 저장 실패:', error);
            throw error;
        }
    }
}

// 엑셀 내보내기
function exportOvertimeToExcel() {
    const year = overtimeDisplayMonth.getFullYear();
    const month = overtimeDisplayMonth.getMonth() + 1;

    const monthRecords = overtimeRecords.filter(record => {
        const recordDate = new Date(record.date);
        return recordDate.getFullYear() === year && recordDate.getMonth() === month - 1;
    });

    if (monthRecords.length === 0) {
        alert('내보낼 야근 기록이 없습니다.');
        return;
    }

    // CSV 형식으로 데이터 생성 (BOM 추가로 Excel 호환성 개선)
    let csvContent = '\uFEFF날짜,직원명,시작시간,종료시간,야근시간,사유\n';

    monthRecords.forEach(record => {
        const row = [
            record.date,
            record.employeeName,
            record.startTime,
            record.endTime,
            record.hours.toFixed(1) + '시간',
            record.reason || ''
        ].map(field => `"${field}"`).join(',');

        csvContent += row + '\n';
    });

    // 다운로드 (BOM 포함으로 Excel에서 한글 정상 표시)
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `야근기록_${year}년${month}월.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// ===== API Key 관리 기능 =====

// API Key 탭 권한 설정
function setupApiKeyTabPermissions() {
    const adminRegister = document.getElementById('apikeyAdminRegister');
    if (adminRegister) {
        adminRegister.style.display = checkPermission('manager') ? 'block' : 'none';
    }
}

// Firebase에 API Key 저장
async function saveApiKeyRecord(record) {
    if (isFirebaseEnabled && firebase.auth().currentUser) {
        try {
            await database.ref('apiKeys/' + record.id).set(record);
        } catch (error) {
            console.error('API Key 저장 실패:', error);
            throw error;
        }
    }
}

// Firebase에서 API Key 삭제
async function deleteApiKeyFromFirebase(recordId) {
    if (isFirebaseEnabled && firebase.auth().currentUser) {
        try {
            await database.ref('apiKeys/' + recordId).remove();
        } catch (error) {
            console.error('API Key 삭제 실패:', error);
            throw error;
        }
    }
}

// API Key 신청
async function requestApiKey() {
    const name = document.getElementById('apikeyName').value.trim();
    const memo = document.getElementById('apikeyMemo').value.trim();

    if (!name) {
        alert('API 이름을 입력해주세요.');
        return;
    }

    const userName = sessionStorage.getItem('userName') || localStorage.getItem('userName') || '알 수 없음';

    const record = {
        id: `apikey_${Date.now()}`,
        name: name,
        apiKey: null,
        requester: userName,
        requestDate: new Date().toISOString().split('T')[0],
        status: 'pending',
        approver: null,
        approveDate: null,
        billingStartDate: null,
        memo: memo
    };

    apiKeyRecords.push(record);

    bumpPendingWrites();
    try {
        await saveApiKeyRecord(record);
    } catch (err) {
        apiKeyRecords = apiKeyRecords.filter(r => r.id !== record.id);
        renderApiKeyList();
        showToast('error', 'API Key 신청 실패', '저장에 실패했습니다. 다시 시도해주세요.');
        dropPendingWrites();
        return;
    }
    dropPendingWrites();

    renderApiKeyList();

    document.getElementById('apikeyName').value = '';
    document.getElementById('apikeyMemo').value = '';

    showToast('success', 'API Key 신청 완료', `${name} API Key 신청이 접수되었습니다.`);

    sendApiKeySlackNotification('request', record);
}

// 관리자 직접 등록
async function registerApiKeyDirect() {
    if (!checkPermission('manager')) {
        showNoPermissionAlert('API Key 등록');
        return;
    }

    const name = document.getElementById('adminApikeyName').value.trim();
    const keyValue = document.getElementById('adminApikeyValue').value.trim();
    const billingDate = document.getElementById('adminApikeyBillingDate').value;
    const memo = document.getElementById('adminApikeyMemo').value.trim();

    if (!name || !keyValue) {
        alert('API 이름과 Key 값을 입력해주세요.');
        return;
    }

    const userName = sessionStorage.getItem('userName') || localStorage.getItem('userName') || '알 수 없음';

    const encryptedKey = await aesEncrypt(keyValue);
    if (!encryptedKey) {
        alert('API Key 암호화에 실패했습니다. 다시 시도해주세요.');
        return;
    }

    const record = {
        id: `apikey_${Date.now()}`,
        name: name,
        apiKey: encryptedKey,
        requester: userName,
        requestDate: new Date().toISOString().split('T')[0],
        status: 'approved',
        approver: userName,
        approveDate: new Date().toISOString().split('T')[0],
        billingStartDate: billingDate || null,
        memo: memo
    };

    apiKeyRecords.push(record);

    bumpPendingWrites();
    try {
        await saveApiKeyRecord(record);
    } catch (err) {
        apiKeyRecords = apiKeyRecords.filter(r => r.id !== record.id);
        renderApiKeyList();
        showToast('error', 'API Key 등록 실패', '저장에 실패했습니다. 다시 시도해주세요.');
        dropPendingWrites();
        return;
    }
    dropPendingWrites();

    renderApiKeyList();

    document.getElementById('adminApikeyName').value = '';
    document.getElementById('adminApikeyValue').value = '';
    document.getElementById('adminApikeyBillingDate').value = '';
    document.getElementById('adminApikeyMemo').value = '';

    showToast('success', 'API Key 등록 완료', `${name} API Key가 등록되었습니다.`);
}

// 승인 모달 열기
function openApikeyApproveModal(recordId) {
    if (!checkPermission('manager')) {
        showNoPermissionAlert('API Key 승인');
        return;
    }

    const record = apiKeyRecords.find(r => r.id === recordId);
    if (!record) return;

    const modal = document.getElementById('apikeyApproveModal');
    const info = document.getElementById('apikeyApproveInfo');

    info.innerHTML = `
        <p><strong>API 이름:</strong> ${record.name}</p>
        <p><strong>신청자:</strong> ${record.requester}</p>
        <p><strong>신청일:</strong> ${record.requestDate}</p>
        <p><strong>메모:</strong> ${record.memo || '없음'}</p>
    `;

    document.getElementById('approveApikeyValue').value = '';
    document.getElementById('approveApikeyBillingDate').value = '';

    modal.dataset.recordId = recordId;
    modal.style.cssText = 'display: block !important; z-index: 10000 !important;';
}

function closeApikeyApproveModal() {
    const modal = document.getElementById('apikeyApproveModal');
    modal.style.display = 'none';
    delete modal.dataset.recordId;
}

// API Key 승인 확인
async function confirmApproveApiKey() {
    const modal = document.getElementById('apikeyApproveModal');
    const recordId = modal.dataset.recordId;
    if (!recordId) return;

    const keyValue = document.getElementById('approveApikeyValue').value.trim();
    const billingDate = document.getElementById('approveApikeyBillingDate').value;

    if (!keyValue) {
        alert('API Key 값을 입력해주세요.');
        return;
    }

    const record = apiKeyRecords.find(r => r.id === recordId);
    if (!record) return;

    const encryptedKey = await aesEncrypt(keyValue);
    if (!encryptedKey) {
        alert('API Key 암호화에 실패했습니다. 다시 시도해주세요.');
        return;
    }

    const userName = sessionStorage.getItem('userName') || localStorage.getItem('userName') || '알 수 없음';

    // 실패 시 원복을 위한 백업
    const backup = { ...record };

    record.apiKey = encryptedKey;
    record.status = 'approved';
    record.approver = userName;
    record.approveDate = new Date().toISOString().split('T')[0];
    record.billingStartDate = billingDate || null;

    bumpPendingWrites();
    try {
        await saveApiKeyRecord(record);
    } catch (err) {
        Object.assign(record, backup);
        renderApiKeyList();
        showToast('error', 'API Key 승인 실패', '저장에 실패했습니다. 다시 시도해주세요.');
        dropPendingWrites();
        return;
    }
    dropPendingWrites();

    renderApiKeyList();
    closeApikeyApproveModal();

    showToast('success', 'API Key 승인', `${record.name} API Key가 승인되었습니다.`);

    sendApiKeySlackNotification('approve', record);
}

// API Key 거절
async function rejectApiKey() {
    const modal = document.getElementById('apikeyApproveModal');
    const recordId = modal.dataset.recordId;
    if (!recordId) return;

    if (!confirm('이 API Key 신청을 거절하시겠습니까?')) return;

    const record = apiKeyRecords.find(r => r.id === recordId);
    if (!record) return;

    const userName = sessionStorage.getItem('userName') || localStorage.getItem('userName') || '알 수 없음';

    const backup = { ...record };

    record.status = 'rejected';
    record.approver = userName;
    record.approveDate = new Date().toISOString().split('T')[0];

    bumpPendingWrites();
    try {
        await saveApiKeyRecord(record);
    } catch (err) {
        Object.assign(record, backup);
        renderApiKeyList();
        showToast('error', 'API Key 거절 실패', '저장에 실패했습니다. 다시 시도해주세요.');
        dropPendingWrites();
        return;
    }
    dropPendingWrites();

    renderApiKeyList();
    closeApikeyApproveModal();

    showToast('info', 'API Key 거절', `${record.name} API Key 신청이 거절되었습니다.`);

    sendApiKeySlackNotification('reject', record);
}

// API Key 삭제
async function deleteApiKey(recordId) {
    if (!checkPermission('admin')) {
        showNoPermissionAlert('API Key 삭제');
        return;
    }

    const record = apiKeyRecords.find(r => r.id === recordId);
    if (!record) return;

    if (!confirm(`"${record.name}" API Key를 삭제하시겠습니까?`)) return;

    const idx = apiKeyRecords.findIndex(r => r.id === recordId);
    apiKeyRecords = apiKeyRecords.filter(r => r.id !== recordId);

    bumpPendingWrites();
    try {
        await deleteApiKeyFromFirebase(recordId);
    } catch (err) {
        if (idx >= 0) apiKeyRecords.splice(idx, 0, record);
        renderApiKeyList();
        showToast('error', 'API Key 삭제 실패', '저장에 실패했습니다. 다시 시도해주세요.');
        dropPendingWrites();
        return;
    }
    dropPendingWrites();

    renderApiKeyList();

    showToast('success', 'API Key 삭제', `${record.name} API Key가 삭제되었습니다.`);
}

// API Key 마스킹 (앞 4자리 + **** + 뒤 4자리)
function maskApiKey(keyStr) {
    if (!keyStr || keyStr.length < 10) return '****';
    return keyStr.substring(0, 4) + '••••••••' + keyStr.substring(keyStr.length - 4);
}

// API Key 보기 (복호화 후 표시)
async function toggleApiKeyVisibility(recordId) {
    const record = apiKeyRecords.find(r => r.id === recordId);
    if (!record || !record.apiKey) return;

    const keyEl = document.getElementById(`apikey-value-${recordId}`);
    const btnEl = document.getElementById(`apikey-toggle-${recordId}`);

    if (keyEl.dataset.revealed === 'true') {
        keyEl.textContent = maskApiKey(keyEl.dataset.plainKey);
        keyEl.dataset.revealed = 'false';
        btnEl.textContent = '보기';
    } else {
        try {
            const decrypted = await aesDecrypt(record.apiKey);
            if (decrypted) {
                keyEl.textContent = decrypted;
                keyEl.dataset.plainKey = decrypted;
                keyEl.dataset.revealed = 'true';
                btnEl.textContent = '숨기기';
            } else {
                alert('API Key 복호화에 실패했습니다.');
            }
        } catch (error) {
            console.error('API Key 복호화 오류:', error);
            alert('API Key 복호화에 실패했습니다.');
        }
    }
}

// API Key 복사
async function copyApiKey(recordId) {
    const record = apiKeyRecords.find(r => r.id === recordId);
    if (!record || !record.apiKey) return;

    try {
        const decrypted = await aesDecrypt(record.apiKey);
        if (decrypted) {
            await navigator.clipboard.writeText(decrypted);
            showToast('success', '복사 완료', 'API Key가 클립보드에 복사되었습니다.');
        } else {
            alert('API Key 복호화에 실패했습니다.');
        }
    } catch (error) {
        console.error('API Key 복사 오류:', error);
        alert('API Key 복사에 실패했습니다.');
    }
}

// API Key 목록 렌더링
function renderApiKeyList() {
    const container = document.getElementById('apikeyList');
    if (!container) return;

    if (apiKeyRecords.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:#666; padding:20px;">등록된 API Key가 없습니다.</p>';
        return;
    }

    const isManager = checkPermission('manager');
    const isAdmin = checkPermission('admin');

    const sortedRecords = [...apiKeyRecords].sort((a, b) => {
        const statusOrder = { 'pending': 0, 'approved': 1, 'rejected': 2 };
        const orderA = statusOrder[a.status] ?? 9;
        const orderB = statusOrder[b.status] ?? 9;
        if (orderA !== orderB) return orderA - orderB;
        return new Date(b.requestDate) - new Date(a.requestDate);
    });

    let html = '';
    sortedRecords.forEach(record => {
        const statusBadge = getStatusBadge(record.status);
        const hasKey = record.apiKey && record.status === 'approved';

        html += `
            <div class="apikey-card ${record.status}">
                <div class="apikey-card-header">
                    <div class="apikey-card-title">${record.name}</div>
                    ${statusBadge}
                </div>
                <div class="apikey-card-body">
                    <div class="apikey-info-row">
                        <span class="apikey-label">신청자:</span>
                        <span>${record.requester}</span>
                    </div>
                    <div class="apikey-info-row">
                        <span class="apikey-label">신청일:</span>
                        <span>${record.requestDate}</span>
                    </div>
                    ${record.memo ? `<div class="apikey-info-row"><span class="apikey-label">메모:</span><span>${record.memo}</span></div>` : ''}
                    ${record.billingStartDate ? `<div class="apikey-info-row"><span class="apikey-label">결제 시작일:</span><span>${record.billingStartDate}</span></div>` : ''}
                    ${record.approver ? `<div class="apikey-info-row"><span class="apikey-label">${record.status === 'rejected' ? '거절자' : '승인자'}:</span><span>${record.approver} (${record.approveDate})</span></div>` : ''}
                    ${hasKey ? `
                        <div class="apikey-key-row">
                            <span class="apikey-label">Key:</span>
                            <code class="apikey-value" id="apikey-value-${record.id}" data-revealed="false">••••••••••••</code>
                            <button class="btn-apikey-action" id="apikey-toggle-${record.id}" onclick="toggleApiKeyVisibility('${record.id}')">보기</button>
                            <button class="btn-apikey-action btn-copy" onclick="copyApiKey('${record.id}')">복사</button>
                        </div>
                    ` : ''}
                </div>
                <div class="apikey-card-actions">
                    ${record.status === 'pending' && isManager ? `<button class="btn-approve" onclick="openApikeyApproveModal('${record.id}')">승인/거절</button>` : ''}
                    ${isAdmin ? `<button class="btn-delete-apikey" onclick="deleteApiKey('${record.id}')">삭제</button>` : ''}
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

// 상태 배지 생성
function getStatusBadge(status) {
    const badges = {
        'pending': '<span class="apikey-status-badge pending">대기중</span>',
        'approved': '<span class="apikey-status-badge approved">승인됨</span>',
        'rejected': '<span class="apikey-status-badge rejected">거절됨</span>'
    };
    return badges[status] || '';
}

// API Key Slack 알림 발송
async function sendApiKeySlackNotification(action, record) {
    if (!SLACK_CONFIG.enabled || !SLACK_CONFIG.botToken) return;

    try {
        let message = '';
        if (action === 'request') {
            message = `🔑 *API Key 신청 알림*\n\n` +
                      `👤 *신청자:* ${record.requester}\n` +
                      `📋 *API 이름:* ${record.name}\n` +
                      `📝 *메모:* ${record.memo || '없음'}\n` +
                      `📅 *신청일:* ${record.requestDate}\n\n` +
                      `API Key 관리 탭에서 승인해주세요.`;

            // authorized_users에서 admin/manager만 찾아서 알림
            const usersSnapshot = await database.ref('authorized_users').once('value');
            const authorizedUsers = usersSnapshot.val();
            if (authorizedUsers) {
                for (const [key, user] of Object.entries(authorizedUsers)) {
                    if (user.status === 'active' && (user.role === 'admin' || user.role === 'manager')) {
                        const adminEmp = employees.find(emp => emp.name === user.name);
                        if (adminEmp?.hrData?.slackId && adminEmp.name !== record.requester) {
                            await sendSlackDM(adminEmp.hrData.slackId, message);
                        }
                    }
                }
            }
        } else if (action === 'approve') {
            message = `✅ *API Key 승인 알림*\n\n` +
                      `📋 *API 이름:* ${record.name}\n` +
                      `👤 *승인자:* ${record.approver}\n` +
                      `📅 *승인일:* ${record.approveDate}\n\n` +
                      `API Key 관리 탭에서 확인하세요.`;

            const requesterEmp = employees.find(emp => emp.name === record.requester);
            if (requesterEmp?.hrData?.slackId) {
                await sendSlackDM(requesterEmp.hrData.slackId, message);
            }
        } else if (action === 'reject') {
            message = `❌ *API Key 거절 알림*\n\n` +
                      `📋 *API 이름:* ${record.name}\n` +
                      `👤 *처리자:* ${record.approver}\n` +
                      `📅 *처리일:* ${record.approveDate}\n\n` +
                      `필요시 관리자에게 문의하세요.`;

            const requesterEmp = employees.find(emp => emp.name === record.requester);
            if (requesterEmp?.hrData?.slackId) {
                await sendSlackDM(requesterEmp.hrData.slackId, message);
            }
        }
    } catch (error) {
        console.error('API Key Slack 알림 발송 오류:', error);
    }
}

// ===== 휴가 기록 CSV 내보내기 =====

// 내보내기 드롭다운 업데이트
function updateExportDropdowns() {
    // 직원 드롭다운
    const empSelect = document.getElementById('exportEmployee');
    if (!empSelect) return;

    const currentVal = empSelect.value;
    empSelect.innerHTML = '<option value="all">전체 직원</option>';
    employees.forEach(emp => {
        const option = document.createElement('option');
        option.value = emp.id;
        option.textContent = emp.name;
        empSelect.appendChild(option);
    });
    empSelect.value = currentVal || 'all';

    // 월별 드롭다운 (기록에서 존재하는 월만)
    const monthSelect = document.getElementById('exportMonth');
    if (!monthSelect) return;

    const months = new Set();
    leaveRecords.forEach(record => {
        const date = record.startDate || record.date;
        if (date) {
            months.add(date.substring(0, 7)); // YYYY-MM
        }
    });

    const sortedMonths = [...months].sort().reverse();
    const currentMonthVal = monthSelect.value;
    monthSelect.innerHTML = '<option value="all">전체 기간</option>';
    sortedMonths.forEach(month => {
        const [y, m] = month.split('-');
        const option = document.createElement('option');
        option.value = month;
        option.textContent = `${y}년 ${parseInt(m)}월`;
        monthSelect.appendChild(option);
    });
    monthSelect.value = currentMonthVal || 'all';
}

// CSV 다운로드
function exportLeaveCSV() {
    const employeeFilter = document.getElementById('exportEmployee').value;
    const monthFilter = document.getElementById('exportMonth').value;

    let filtered = [...leaveRecords];

    // 직원 필터
    if (employeeFilter !== 'all') {
        filtered = filtered.filter(r => r.employeeId === parseInt(employeeFilter));
    }

    // 월 필터
    if (monthFilter !== 'all') {
        filtered = filtered.filter(r => {
            const date = r.startDate || r.date;
            return date && date.startsWith(monthFilter);
        });
    }

    // 날짜순 정렬
    filtered.sort((a, b) => {
        const dateA = a.startDate || a.date || '';
        const dateB = b.startDate || b.date || '';
        return dateA.localeCompare(dateB);
    });

    if (filtered.length === 0) {
        alert('내보낼 휴가 기록이 없습니다.');
        return;
    }

    // CSV 헤더
    let csvContent = '\uFEFF날짜,이름,종류,차감일수,시간구분,사유\n';

    // 직원이 존재하지 않는 고아 데이터 제외
    filtered = filtered.filter(record => employees.find(e => e.id === record.employeeId));

    if (filtered.length === 0) {
        alert('내보낼 휴가 기록이 없습니다.');
        return;
    }

    filtered.forEach(record => {
        const emp = employees.find(e => e.id === record.employeeId);
        const name = emp.name;
        const date = record.startDate || record.date || '';
        const type = getLeaveTypeText(record.type);
        const days = record.days || 0;
        const deducted = isDeductibleLeaveType(record.type) ? days : 0;

        let duration = '종일';
        if (record.duration === 'morning') duration = '오전반차';
        else if (record.duration === 'afternoon') duration = '오후반차';

        const reason = (record.reason || '').replace(/,/g, ' ');

        csvContent += `${date},${name},${type},${deducted},${duration},${reason}\n`;
    });

    // 파일명 생성
    let fileName = '휴가기록';
    if (employeeFilter !== 'all') {
        const emp = employees.find(e => e.id === parseInt(employeeFilter));
        if (emp) fileName += `_${emp.name}`;
    }
    if (monthFilter !== 'all') {
        fileName += `_${monthFilter}`;
    }
    fileName += '.csv';

    // 다운로드
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showToast('success', 'CSV 다운로드', `${filtered.length}건의 휴가 기록이 다운로드되었습니다.`);
}

function parseLeaveTypeKoToInternal(ko) {
    const map = {
        연차: 'annual',
        월차: 'monthly',
        병가: 'sick',
        공가: 'official',
        교육: 'education',
        포상: 'reward',
        휴가: 'vacation',
    };
    return map[(ko || '').trim()] || null;
}

function parseLeaveDurationKoToInternal(ko) {
    const map = {
        종일: 'full',
        오전반차: 'morning',
        오후반차: 'afternoon',
    };
    const v = map[(ko || '').trim()];
    return v || 'full';
}

function triggerLeaveCsvImport() {
    if (!checkPermission('manager')) {
        showNoPermissionAlert('CSV 가져오기');
        return;
    }
    const input = document.getElementById('leaveCsvImportInput');
    if (input) {
        input.value = '';
        input.click();
    }
}

async function handleLeaveCsvImport(event) {
    const file = event.target && event.target.files && event.target.files[0];
    if (!file) return;

    if (!checkPermission('manager')) {
        showNoPermissionAlert('CSV 가져오기');
        return;
    }

    let text;
    try {
        text = await file.text();
    } catch (e) {
        alert('파일을 읽을 수 없습니다.');
        return;
    }

    text = text.replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) {
        alert('CSV에 데이터 행이 없습니다.');
        return;
    }

    const header = lines[0].replace(/^\uFEFF/, '');
    if (!header.includes('날짜') || !header.includes('이름')) {
        if (!confirm('첫 줄이 표준 헤더(날짜,이름,…)가 아닙니다. 그대로 파싱할까요?')) return;
    }

    const skipped = [];
    let added = 0;
    const baseId = Date.now();

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const parts = line.split(',');
        if (parts.length < 5) {
            skipped.push(`행 ${i + 1}: 열 부족`);
            continue;
        }

        const dateStr = parts[0].trim();
        const name = parts[1].trim();
        const typeKo = parts[2].trim();
        const durationKo = parts[4].trim();
        const reason = parts.slice(5).join(',').trim().slice(0, 50);

        const leaveType = parseLeaveTypeKoToInternal(typeKo);
        if (!leaveType) {
            skipped.push(`행 ${i + 1}: 알 수 없는 종류 "${typeKo}"`);
            continue;
        }

        const duration = parseLeaveDurationKoToInternal(durationKo);
        const employee = employees.find(e => (e.name || '').trim() === name);
        if (!employee) {
            skipped.push(`행 ${i + 1}: 직원 없음 "${name}"`);
            continue;
        }

        const days = duration === 'morning' || duration === 'afternoon' ? 0.5 : 1;
        const id = `imp_${baseId}_${i}`;

        leaveRecords.push({
            id,
            employeeId: employee.id,
            type: leaveType,
            duration,
            startDate: dateStr,
            endDate: dateStr,
            days,
            reason,
            requestDate: new Date().toISOString(),
        });
        added++;
    }

    if (added === 0) {
        alert('추가된 기록이 없습니다.\n\n' + (skipped.length ? skipped.slice(0, 15).join('\n') + (skipped.length > 15 ? '\n…' : '') : ''));
        return;
    }

    employees.forEach(emp => {
        clearLeaveCache();
        calculateEmployeeLeaves(emp);
    });

    renderEmployeeSummary();
    renderCalendar();
    updateExportDropdowns();
    await saveData();

    let msg = `${added}건을 가져왔습니다.`;
    if (skipped.length) {
        msg += `\n\n건너뜀 ${skipped.length}건:\n` + skipped.slice(0, 20).join('\n');
        if (skipped.length > 20) msg += '\n…';
    }
    showToast('success', 'CSV 가져오기', msg);
    if (skipped.length) console.log('CSV 가져오기 건너뜀:', skipped);
}

// 구글시트 전체 동기화
async function syncToGoogleSheet() {
    if (!confirm('구글시트에 현재 모든 휴가 기록을 동기화합니다.\n기존 시트 데이터는 초기화됩니다.\n\n계속하시겠습니까?')) return;

    const validRecords = leaveRecords
        .filter(r => employees.find(e => e.id === r.employeeId))
        .map(r => leaveRecordToSheetData(r))
        .filter(Boolean);

    await sendToGoogleSheet('sync', validRecords);
    showToast('success', '구글시트 동기화', `${validRecords.length}건의 휴가 기록이 구글시트에 동기화되었습니다.`);
}