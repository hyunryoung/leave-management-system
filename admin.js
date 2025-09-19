// 관리자 설정
const ADMIN_PASSWORD = 'admin2025!@#';

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

// Firebase 변수
let firebase_app = null;
let database = null;
let isFirebaseEnabled = false;

// 토큰 저장소 (Firebase + 로컬 백업)
let tokenDatabase = JSON.parse(localStorage.getItem('tokenDatabase') || '{}');

// 페이지 로드 시 초기화
document.addEventListener('DOMContentLoaded', function() {
    // Firebase 초기화
    initializeFirebase();
    
    // GitHub의 tokens.js에서 기존 토큰들 로드
    loadTokensFromGitHub();
    
    // Firebase에서 토큰들 로드
    loadTokensFromFirebase();
    
    // 최초 실행 시 마스터 관리자 토큰 생성
    initializeMasterToken();
    
    // Enter 키로 관리자 로그인
    const adminPwInput = document.getElementById('adminPassword');
    if (!adminPwInput) return; // 관리자 페이지가 아니면 조용히 종료
    
    adminPwInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            authenticateAdmin();
        }
    });
    
    // 기본 만료일 설정 (1년 후)
    const nextYear = new Date();
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    document.getElementById('expiryDate').value = nextYear.toISOString().split('T')[0];
});

// Firebase 초기화
function initializeFirebase() {
    try {
        if (typeof firebase !== 'undefined') {
            firebase_app = firebase.initializeApp(firebaseConfig);
            database = firebase.database();
            isFirebaseEnabled = true;
            console.log('관리자 페이지 - Firebase 초기화 성공');
        } else {
            console.log('Firebase를 사용할 수 없습니다. 로컬 저장소를 사용합니다.');
        }
    } catch (error) {
        console.log('Firebase 초기화 실패:', error);
        isFirebaseEnabled = false;
    }
}

// Firebase에서 토큰들 실시간 로드
function loadTokensFromFirebase() {
    if (!isFirebaseEnabled) return;
    
    try {
        const tokensRef = database.ref('tokens');
        
        // 실시간 리스너 설정
        tokensRef.on('value', (snapshot) => {
            const firebaseTokens = snapshot.val() || {};
            
            // Firebase 토큰으로 완전히 교체 (동기화)
            tokenDatabase = { ...firebaseTokens };
            
            // 로컬 스토리지 업데이트
            localStorage.setItem('tokenDatabase', JSON.stringify(tokenDatabase));
            
            // UI 업데이트 (관리자 페이지에서만)
            if (document.getElementById('tokenList')) {
                loadTokenList();
                updateStats();
            }
            
            console.log('🔥 Firebase 실시간 동기화 완료:', Object.keys(tokenDatabase));
        });
        
    } catch (error) {
        console.log('Firebase 토큰 로드 실패:', error);
    }
}

// Firebase에 토큰 저장
async function saveTokenToFirebase(token, tokenInfo) {
    if (!isFirebaseEnabled) return;
    
    try {
        await database.ref(`tokens/${token}`).set(tokenInfo);
        console.log('Firebase에 토큰 저장 완료:', token);
    } catch (error) {
        console.log('Firebase 토큰 저장 실패:', error);
    }
}

// Firebase에서 토큰 삭제
async function deleteTokenFromFirebase(token) {
    if (!isFirebaseEnabled) return;
    
    try {
        await database.ref(`tokens/${token}`).remove();
        console.log('Firebase에서 토큰 삭제 완료:', token);
    } catch (error) {
        console.log('Firebase 토큰 삭제 실패:', error);
    }
}

// GitHub의 tokens.js에서 기존 토큰들 로드
function loadTokensFromGitHub() {
    try {
        // tokens.js에서 로드된 전역 토큰들을 로컬 데이터베이스로 가져오기
        if (window.ACTIVE_TOKENS) {
            Object.keys(window.ACTIVE_TOKENS).forEach(token => {
                const tokenInfo = window.ACTIVE_TOKENS[token];
                
                // 로컬 데이터베이스에 없으면 추가
                if (!tokenDatabase[token]) {
                    tokenDatabase[token] = {
                        name: tokenInfo.name,
                        role: tokenInfo.role,
                        expires: tokenInfo.expires,
                        created: new Date().toISOString(),
                        lastUsed: null,
                        status: 'active'
                    };
                }
            });
            
            // 로컬 스토리지 업데이트
            localStorage.setItem('tokenDatabase', JSON.stringify(tokenDatabase));
            console.log('GitHub 토큰들을 로컬 데이터베이스로 동기화 완료');
        }
    } catch (error) {
        console.log('GitHub 토큰 로드 실패:', error);
    }
}

// 최초 마스터 관리자 토큰 생성
async function initializeMasterToken() {
    // Firebase에서 토큰 로드 대기 (2초)
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Firebase에서 로드된 토큰이 있으면 생성하지 않음
    if (Object.keys(tokenDatabase).length > 0) {
        console.log('기존 토큰들이 있어서 마스터 토큰 생성 생략');
        return;
    }
    
    // 마스터 관리자 토큰 생성
    const masterToken = 'MASTER-ADMIN-2025-INIT';
    const tokenInfo = {
        name: '마스터 관리자',
        role: 'admin',
        expires: '2026-12-31',
        created: new Date().toISOString(),
        lastUsed: null,
        status: 'active'
    };
    
    tokenDatabase[masterToken] = tokenInfo;
    localStorage.setItem('tokenDatabase', JSON.stringify(tokenDatabase));
    
    // Firebase에도 저장
    await saveTokenToFirebase(masterToken, tokenInfo);
    
    updateMainSystemTokens();
    
    console.log('마스터 관리자 토큰 생성됨:', masterToken);
}

// 관리자 인증
function authenticateAdmin() {
    const password = document.getElementById('adminPassword').value;
    const errorDiv = document.getElementById('adminError');
    
    if (password === ADMIN_PASSWORD) {
        document.getElementById('adminAuth').style.display = 'none';
        document.getElementById('adminPanel').style.display = 'block';
        loadTokenList();
        updateStats();
    } else {
        errorDiv.style.display = 'block';
        document.getElementById('adminPassword').value = '';
        document.getElementById('adminPassword').focus();
    }
}

// 토큰 생성
async function generateToken() {
    const userName = document.getElementById('userName').value.trim();
    const userRole = document.getElementById('userRole').value;
    const expiryDate = document.getElementById('expiryDate').value;
    
    if (!userName || !expiryDate) {
        alert('사용자 이름과 만료일을 입력해주세요.');
        return;
    }
    
    // 고유 토큰 생성
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const rolePrefix = userRole.toUpperCase().substring(0, 3);
    const token = `USR-2025-${rolePrefix}-${randomId}-${timestamp.toString().slice(-6)}`;
    
    // 토큰 정보 저장
    const tokenInfo = {
        name: userName,
        role: userRole,
        expires: expiryDate,
        created: new Date().toISOString(),
        lastUsed: null,
        status: 'active'
    };
    
    tokenDatabase[token] = tokenInfo;
    
    // 로컬 스토리지에 저장
    localStorage.setItem('tokenDatabase', JSON.stringify(tokenDatabase));
    
    // Firebase에 즉시 저장 (실시간 동기화)
    await saveTokenToFirebase(token, tokenInfo);
    
    // 메인 시스템의 토큰 목록도 업데이트
    updateMainSystemTokens();
    
    // 생성된 토큰과 URL 표시
    const currentDomain = window.location.origin;
    const loginUrl = `${currentDomain}${window.location.pathname.replace('admin.html', 'index.html')}?token=${token}`;
    
    document.getElementById('newTokenDisplay').innerHTML = `
        <div><strong>토큰:</strong> <code>${token}</code></div>
        <div style="margin-top: 10px;"><strong>자동 로그인 URL:</strong></div>
        <div style="background: #f8f9fa; padding: 10px; border-radius: 5px; word-break: break-all; font-size: 12px;">
            <a href="${loginUrl}" target="_blank">${loginUrl}</a>
        </div>
        <div style="margin-top: 8px; font-size: 12px; color: #666;">
            ↑ 이 링크를 직원에게 전달하면 토큰 입력 없이 바로 로그인됩니다
        </div>
    `;
    document.getElementById('generatedToken').style.display = 'block';
    
    // 폼 초기화
    document.getElementById('userName').value = '';
    
    // 목록 새로고침
    loadTokenList();
    updateStats();
    
    alert(`토큰이 생성되었습니다!\n사용자: ${userName}\n토큰: ${token}`);
}

// 메인 시스템의 토큰 목록 업데이트
function updateMainSystemTokens() {
    // script.js의 ACCESS_TOKENS 객체를 업데이트하기 위해
    // localStorage에 저장된 토큰 정보를 사용
    const activeTokens = {};
    
    Object.keys(tokenDatabase).forEach(token => {
        const tokenInfo = tokenDatabase[token];
        if (tokenInfo.status === 'active' && new Date(tokenInfo.expires) > new Date()) {
            activeTokens[token] = {
                name: tokenInfo.name,
                role: tokenInfo.role,
                expires: tokenInfo.expires
            };
        }
    });
    
    // 여러 곳에 저장해서 확실히 동기화
    localStorage.setItem('activeTokens', JSON.stringify(activeTokens));
    localStorage.setItem('adminGeneratedTokens', JSON.stringify(activeTokens));
    localStorage.setItem('tokenDatabase', JSON.stringify(tokenDatabase));
    
    // 즉시 적용을 위해 전역 변수도 업데이트 (메인 시스템에서 사용)
    if (typeof window.ACCESS_TOKENS !== 'undefined') {
        window.ACCESS_TOKENS = { ...window.ACCESS_TOKENS, ...activeTokens };
    }
    
    // 메인 시스템에 토큰 업데이트 신호 보내기
    localStorage.setItem('tokenUpdateSignal', Date.now().toString());
    
    // 전역 변수도 즉시 업데이트
    if (window.ACTIVE_TOKENS) {
        window.ACTIVE_TOKENS = { ...window.ACTIVE_TOKENS, ...activeTokens };
    }
    
    // tokens.js 파일 내용을 생성하여 다운로드 링크 제공
    generateTokensFile(activeTokens);
    
    console.log('토큰 동기화 완료:', Object.keys(activeTokens));
}

// 토큰 목록 로드
function loadTokenList() {
    const tokenList = document.getElementById('tokenList');
    tokenList.innerHTML = '';
    
    const tokens = Object.keys(tokenDatabase).sort((a, b) => 
        new Date(tokenDatabase[b].created) - new Date(tokenDatabase[a].created)
    );
    
    if (tokens.length === 0) {
        tokenList.innerHTML = '<p style="text-align: center; color: #666; padding: 20px;">발급된 토큰이 없습니다.</p>';
        return;
    }
    
    tokens.forEach(token => {
        const tokenInfo = tokenDatabase[token];
        const isExpired = new Date(tokenInfo.expires) < new Date();
        const status = isExpired ? 'expired' : tokenInfo.status;
        
        const tokenItem = document.createElement('div');
        tokenItem.className = 'token-item';
        
        tokenItem.innerHTML = `
            <div class="token-info">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <strong>${tokenInfo.name}</strong>
                    <span class="token-status ${status}">${status === 'active' ? '활성' : '만료'}</span>
                </div>
                <div class="token-id">${token}</div>
                <div style="font-size: 12px; color: #666; margin-top: 5px;">
                    권한: ${getRoleText(tokenInfo.role)} | 
                    만료: ${tokenInfo.expires} |
                    생성: ${new Date(tokenInfo.created).toLocaleDateString()}
                    ${tokenInfo.lastUsed ? `| 마지막 사용: ${new Date(tokenInfo.lastUsed).toLocaleDateString()}` : ''}
                </div>
            </div>
            <div class="token-actions">
                ${status === 'active' ? 
                    `<button class="btn btn-danger" onclick="revokeToken('${token}')">해지</button>` :
                    `<button class="btn btn-success" onclick="reactivateToken('${token}')">재활성화</button>`
                }
                <button class="btn btn-danger" onclick="deleteToken('${token}')">삭제</button>
            </div>
        `;
        
        tokenList.appendChild(tokenItem);
    });
}

// 권한 텍스트 변환
function getRoleText(role) {
    switch(role) {
        case 'admin': return '관리자';
        case 'manager': return '매니저';
        case 'user': return '사용자';
        default: return role;
    }
}

// 토큰 해지
async function revokeToken(token) {
    if (confirm('이 토큰을 해지하시겠습니까?')) {
        tokenDatabase[token].status = 'revoked';
        localStorage.setItem('tokenDatabase', JSON.stringify(tokenDatabase));
        
        // Firebase에도 반영
        await saveTokenToFirebase(token, tokenDatabase[token]);
        
        updateMainSystemTokens();
        loadTokenList();
        updateStats();
        alert('토큰이 해지되었습니다.');
    }
}

// 토큰 재활성화
async function reactivateToken(token) {
    if (confirm('이 토큰을 재활성화하시겠습니까?')) {
        tokenDatabase[token].status = 'active';
        localStorage.setItem('tokenDatabase', JSON.stringify(tokenDatabase));
        
        // Firebase에도 반영
        await saveTokenToFirebase(token, tokenDatabase[token]);
        
        updateMainSystemTokens();
        loadTokenList();
        updateStats();
        alert('토큰이 재활성화되었습니다.');
    }
}

// 토큰 삭제
async function deleteToken(token) {
    if (confirm('이 토큰을 완전히 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) {
        delete tokenDatabase[token];
        localStorage.setItem('tokenDatabase', JSON.stringify(tokenDatabase));
        
        // Firebase에서도 삭제
        await deleteTokenFromFirebase(token);
        
        updateMainSystemTokens();
        loadTokenList();
        updateStats();
        alert('토큰이 삭제되었습니다.');
    }
}

// 로그인 URL 복사
function copyToken() {
    const loginUrl = document.querySelector('#newTokenDisplay a').href;
    navigator.clipboard.writeText(loginUrl).then(() => {
        alert('자동 로그인 URL이 클립보드에 복사되었습니다!\n직원들에게 이 링크를 전달하세요.');
    }).catch(() => {
        // 클립보드 API가 지원되지 않는 경우
        const textArea = document.createElement('textarea');
        textArea.value = loginUrl;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        alert('자동 로그인 URL이 클립보드에 복사되었습니다!');
    });
}

// tokens.js 파일 생성 및 다운로드 제공
function generateTokensFile(activeTokens) {
    const tokensContent = `// 활성 토큰 목록 - 관리자가 업데이트하는 파일
window.ACTIVE_TOKENS = ${JSON.stringify(activeTokens, null, 4)};

// 마스터 관리자 토큰 (최초 설정용)
window.MASTER_TOKEN = 'MASTER-ADMIN-2025-INIT';
if (!window.ACTIVE_TOKENS[window.MASTER_TOKEN]) {
    window.ACTIVE_TOKENS[window.MASTER_TOKEN] = {
        name: '마스터 관리자',
        role: 'admin', 
        expires: '2026-12-31'
    };
}`;

    // 기존 다운로드 링크 제거
    const existingLink = document.getElementById('downloadTokensLink');
    if (existingLink) {
        existingLink.remove();
    }
    
    // 새 다운로드 링크 생성
    const blob = new Blob([tokensContent], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    
    const downloadLink = document.createElement('a');
    downloadLink.id = 'downloadTokensLink';
    downloadLink.href = url;
    downloadLink.download = 'tokens.js';
    downloadLink.style.display = 'inline-block';
    downloadLink.style.margin = '10px 0';
    downloadLink.style.padding = '8px 15px';
    downloadLink.style.background = '#007bff';
    downloadLink.style.color = 'white';
    downloadLink.style.textDecoration = 'none';
    downloadLink.style.borderRadius = '5px';
    downloadLink.textContent = '📁 tokens.js 다운로드 (GitHub 업데이트용)';
    
    // 토큰 생성 섹션에 추가
    const tokenSection = document.querySelector('.token-section');
    if (tokenSection) {
        tokenSection.appendChild(downloadLink);
    }
}

// 통계 업데이트
function updateStats() {
    const tokens = Object.keys(tokenDatabase);
    const activeTokens = tokens.filter(token => {
        const tokenInfo = tokenDatabase[token];
        return tokenInfo.status === 'active' && new Date(tokenInfo.expires) > new Date();
    });
    const expiredTokens = tokens.filter(token => {
        const tokenInfo = tokenDatabase[token];
        return new Date(tokenInfo.expires) < new Date() || tokenInfo.status !== 'active';
    });
    
    // 오늘 로그인한 토큰 수 (실제로는 로그 데이터 필요)
    const todayLogins = tokens.filter(token => {
        const tokenInfo = tokenDatabase[token];
        if (!tokenInfo.lastUsed) return false;
        const lastUsed = new Date(tokenInfo.lastUsed);
        const today = new Date();
        return lastUsed.toDateString() === today.toDateString();
    }).length;
    
    document.getElementById('totalTokens').textContent = tokens.length;
    document.getElementById('activeTokens').textContent = activeTokens.length;
    document.getElementById('expiredTokens').textContent = expiredTokens.length;
    document.getElementById('todayLogins').textContent = todayLogins;
}
