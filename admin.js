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
let auth = null;
let isFirebaseEnabled = false;
let isGoogleLoggedIn = false;

// 토큰 저장소 (Firebase + 로컬 백업)
let tokenDatabase = JSON.parse(localStorage.getItem('tokenDatabase') || '{}');

// 페이지 로드 시 초기화
document.addEventListener('DOMContentLoaded', function() {
    // Firebase 초기화
    initializeFirebase();
    
    // GitHub의 tokens.js에서 기존 토큰들 로드 (레거시 호환)
    loadTokensFromGitHub();

    // Firebase에서 토큰들 로드 (단일 진실원)
    loadTokensFromFirebase();
    
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
            auth = firebase.auth();
            isFirebaseEnabled = true;
            console.log('관리자 페이지 - Firebase 초기화 성공');
            
            // 인증 상태 감시
            auth.onAuthStateChanged((user) => {
                if (user) {
                    isGoogleLoggedIn = true;
                    document.getElementById('googleLoginSection').style.display = 'none';
                    document.getElementById('passwordSection').style.display = 'block';
                    document.getElementById('loggedInEmail').textContent = user.email;
                    console.log('Google 로그인 상태:', user.email);
                } else {
                    isGoogleLoggedIn = false;
                }
            });
        } else {
            console.log('Firebase를 사용할 수 없습니다. 로컬 저장소를 사용합니다.');
        }
    } catch (error) {
        console.log('Firebase 초기화 실패:', error);
        isFirebaseEnabled = false;
    }
}

// Google 로그인 (관리자 페이지용)
async function googleLoginForAdmin() {
    if (!auth) {
        alert('Firebase Auth가 초기화되지 않았습니다.');
        return;
    }
    
    try {
        const provider = new firebase.auth.GoogleAuthProvider();
        const result = await auth.signInWithPopup(provider);
        console.log('Google 로그인 성공:', result.user.email);
        
        document.getElementById('googleLoginStatus').innerHTML = 
            `<span style="color: green;">✅ ${result.user.email} 로그인 성공!</span>`;
    } catch (error) {
        console.error('Google 로그인 실패:', error);
        document.getElementById('googleLoginStatus').innerHTML = 
            `<span style="color: red;">❌ 로그인 실패: ${error.message}</span>`;
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

// 관리자 인증
async function authenticateAdmin() {
    const password = document.getElementById('adminPassword').value;
    const errorDiv = document.getElementById('adminError');
    
    if (password === ADMIN_PASSWORD) {
        document.getElementById('adminAuth').style.display = 'none';
        document.getElementById('adminPanel').style.display = 'block';
        
        // Firebase에서 최신 토큰 목록 강제 로드
        await forceLoadFromFirebase();
        
        loadTokenList();
        await refreshAuthorizedUsers(); // 등록된 사용자 목록도 로드
        await updateStats();
    } else {
        errorDiv.style.display = 'block';
        document.getElementById('adminPassword').value = '';
        document.getElementById('adminPassword').focus();
    }
}

// Firebase에서 강제로 토큰 로드
async function forceLoadFromFirebase() {
    if (!isFirebaseEnabled) return;
    
    try {
        const snapshot = await database.ref('tokens').once('value');
        const firebaseTokens = snapshot.val() || {};
        
        // Firebase 토큰으로 완전히 교체
        tokenDatabase = { ...firebaseTokens };
        localStorage.setItem('tokenDatabase', JSON.stringify(tokenDatabase));
        
        console.log('🔥 Firebase 강제 동기화 완료:', Object.keys(tokenDatabase));
        
        // UI 즉시 업데이트
        if (document.getElementById('tokenList')) {
            loadTokenList();
            updateStats();
        }
        
    } catch (error) {
        console.log('Firebase 강제 로드 실패:', error);
    }
}

// 이메일 기반 사용자 등록 (새로운 방식)
async function registerAuthorizedUser() {
    const userName = document.getElementById('userName').value.trim();
    const userEmail = document.getElementById('userEmail').value.trim().toLowerCase();
    const userRole = document.getElementById('userRole').value;
    const expiryDate = document.getElementById('expiryDate').value;
    
    if (!userName || !userEmail || !expiryDate) {
        alert('사용자 이름, 이메일, 만료일을 모두 입력해주세요.');
        return;
    }
    
    // 이메일 형식 검증
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(userEmail)) {
        alert('올바른 이메일 형식을 입력해주세요.');
        return;
    }
    
    // Firebase에 authorized_users로 저장
    const userInfo = {
        name: userName,
        email: userEmail,
        role: userRole,
        expires: expiryDate,
        created: new Date().toISOString(),
        lastUsed: null,
        status: 'active'
    };
    
    try {
        // 이메일을 키로 사용 (특수문자 처리)
        const emailKey = userEmail.replace(/\./g, '_dot_').replace(/@/g, '_at_');
        
        await database.ref(`authorized_users/${emailKey}`).set(userInfo);
        console.log('Firebase에 사용자 등록 완료:', userEmail);
        
        // 기존 토큰 시스템도 유지 (하위 호환성)
        const timestamp = Date.now();
        const randomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const rolePrefix = userRole.toUpperCase().substring(0, 3);
        const token = `USR-2025-${rolePrefix}-${randomId}-${timestamp.toString().slice(-6)}`;
        
        const tokenInfo = {
            name: userName,
            email: userEmail,
            role: userRole,
            expires: expiryDate,
            created: new Date().toISOString(),
            lastUsed: null,
            status: 'active'
        };
        
        tokenDatabase[token] = tokenInfo;
        localStorage.setItem('tokenDatabase', JSON.stringify(tokenDatabase));
        await saveTokenToFirebase(token, tokenInfo);
        updateMainSystemTokens();
        
        // 등록 완료 메시지 표시
        document.getElementById('newTokenDisplay').innerHTML = `
            <div style="background: #d4edda; border: 1px solid #c3e6cb; padding: 15px; border-radius: 8px;">
                <h4 style="color: #155724; margin: 0 0 10px 0;">✅ 사용자 등록 완료!</h4>
                <div><strong>이름:</strong> ${userName}</div>
                <div><strong>이메일:</strong> ${userEmail}</div>
                <div><strong>권한:</strong> ${getRoleText(userRole)}</div>
                <div style="margin-top: 10px; padding: 10px; background: #fff; border-radius: 5px;">
                    <strong>📌 안내:</strong><br>
                    이제 <code>${userEmail}</code>로 Google 로그인하면<br>
                    자동으로 <strong>${getRoleText(userRole)}</strong> 권한이 부여됩니다.
                </div>
            </div>
        `;
        document.getElementById('generatedToken').style.display = 'block';
        
        // 폼 초기화
        document.getElementById('userName').value = '';
        document.getElementById('userEmail').value = '';
        
        // 목록 새로고침
        loadTokenList();
        loadAuthorizedUsersList();
        updateStats();
        
        alert(`사용자 등록 완료!\n\n${userName}님 (${userEmail})\n권한: ${getRoleText(userRole)}\n\n이제 해당 이메일로 Google 로그인하면 자동으로 권한이 부여됩니다.`);
        
    } catch (error) {
        console.error('사용자 등록 실패:', error);
        alert('사용자 등록에 실패했습니다: ' + error.message);
    }
}

// 등록된 사용자 목록 로드
async function loadAuthorizedUsersList() {
    if (!isFirebaseEnabled) return;
    
    try {
        const snapshot = await database.ref('authorized_users').once('value');
        const users = snapshot.val() || {};
        
        console.log('등록된 사용자 목록:', Object.keys(users).length + '명');
        
        // 토큰 목록에 사용자 정보도 표시
        return users;
    } catch (error) {
        console.log('사용자 목록 로드 실패:', error);
        return {};
    }
}

// 기존 토큰 생성 함수 (하위 호환성 유지)
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
        const hasEmail = tokenInfo.email ? true : false;
        
        const tokenItem = document.createElement('div');
        tokenItem.className = 'token-item';
        
        tokenItem.innerHTML = `
            <div class="token-info">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <strong>${tokenInfo.name}</strong>
                    <span class="token-status ${status}">${status === 'active' ? '활성' : '만료'}</span>
                </div>
                <div class="token-id" style="font-size: 11px;">${token}</div>
                <div style="font-size: 12px; margin-top: 5px;">
                    ${hasEmail 
                        ? `<span style="color: #28a745;">📧 ${tokenInfo.email}</span>` 
                        : `<span style="color: #dc3545;">⚠️ 이메일 미등록</span>`
                    }
                </div>
                <div style="font-size: 11px; color: #666; margin-top: 3px;">
                    권한: ${getRoleText(tokenInfo.role)} | 만료: ${tokenInfo.expires}
                </div>
            </div>
            <div class="token-actions" style="flex-direction: column; gap: 3px;">
                <button class="btn" style="background: #17a2b8; color: white;" onclick="editTokenEmail('${token}')">
                    ${hasEmail ? '✏️ 이메일 수정' : '➕ 이메일 추가'}
                </button>
                ${status === 'active' ? 
                    `<button class="btn btn-danger" onclick="revokeToken('${token}')">해지</button>` :
                    `<button class="btn btn-success" onclick="reactivateToken('${token}')">재활성화</button>`
                }
            </div>
        `;
        
        tokenList.appendChild(tokenItem);
    });
}

// 토큰에 이메일 추가/수정
async function editTokenEmail(token) {
    const tokenInfo = tokenDatabase[token];
    const currentEmail = tokenInfo.email || '';
    
    const newEmail = prompt(
        `${tokenInfo.name}님의 Google 이메일을 입력하세요:\n\n(이 이메일로 로그인하면 자동으로 ${getRoleText(tokenInfo.role)} 권한이 부여됩니다)`,
        currentEmail
    );
    
    if (newEmail === null) return; // 취소
    
    const email = newEmail.trim().toLowerCase();
    
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        alert('올바른 이메일 형식을 입력해주세요.');
        return;
    }
    
    try {
        // 토큰 정보에 이메일 추가
        tokenInfo.email = email;
        tokenDatabase[token] = tokenInfo;
        localStorage.setItem('tokenDatabase', JSON.stringify(tokenDatabase));
        
        // Firebase 토큰에도 저장
        await saveTokenToFirebase(token, tokenInfo);
        
        // authorized_users에도 등록 (이메일이 있을 경우만)
        if (email) {
            const emailKey = email.replace(/\./g, '_dot_').replace(/@/g, '_at_');
            const userInfo = {
                name: tokenInfo.name,
                email: email,
                role: tokenInfo.role,
                expires: tokenInfo.expires,
                created: tokenInfo.created || new Date().toISOString(),
                lastUsed: null,
                status: 'active'
            };
            
            await database.ref(`authorized_users/${emailKey}`).set(userInfo);
            console.log('authorized_users에 등록 완료:', email);
        }
        
        loadTokenList();
        await refreshAuthorizedUsers();
        
        alert(email 
            ? `이메일이 설정되었습니다!\n\n${tokenInfo.name}님이 ${email}로 Google 로그인하면\n자동으로 ${getRoleText(tokenInfo.role)} 권한이 부여됩니다.`
            : '이메일이 제거되었습니다.'
        );
        
    } catch (error) {
        console.error('이메일 설정 실패:', error);
        alert('이메일 설정 실패: ' + error.message);
    }
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

// tokens.js 다운로드 기능은 보안상 제거됨 (Firebase RTDB가 단일 진실원)
// 발급된 토큰은 자동으로 Firebase에 저장되며 별도 파일 배포가 필요 없음.
function generateTokensFile(_activeTokens) {
    // no-op: 호출부 호환 유지용 빈 함수
}

// 등록된 사용자 목록 UI 표시
async function refreshAuthorizedUsers() {
    if (!isFirebaseEnabled) {
        document.getElementById('authorizedUsersList').innerHTML = '<p style="text-align: center; color: #666; padding: 20px;">Firebase 연결 필요</p>';
        return;
    }
    
    try {
        const snapshot = await database.ref('authorized_users').once('value');
        const users = snapshot.val() || {};
        const userList = document.getElementById('authorizedUsersList');
        userList.innerHTML = '';
        
        const userKeys = Object.keys(users).sort((a, b) => 
            new Date(users[b].created) - new Date(users[a].created)
        );
        
        if (userKeys.length === 0) {
            userList.innerHTML = '<p style="text-align: center; color: #666; padding: 20px;">등록된 사용자가 없습니다.</p>';
            return;
        }
        
        userKeys.forEach(emailKey => {
            const userInfo = users[emailKey];
            const isExpired = new Date(userInfo.expires) < new Date();
            const status = isExpired ? 'expired' : userInfo.status;
            
            const userItem = document.createElement('div');
            userItem.className = 'token-item';
            
            userItem.innerHTML = `
                <div class="token-info">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <strong>${userInfo.name}</strong>
                        <span class="token-status ${status}">${status === 'active' ? '활성' : '만료'}</span>
                    </div>
                    <div class="token-id" style="font-size: 12px;">${userInfo.email}</div>
                    <div style="font-size: 12px; color: #666; margin-top: 5px;">
                        권한: ${getRoleText(userInfo.role)} | 
                        만료: ${userInfo.expires} |
                        생성: ${new Date(userInfo.created).toLocaleDateString()}
                        ${userInfo.lastUsed ? `| 마지막 로그인: ${new Date(userInfo.lastUsed).toLocaleDateString()}` : ''}
                    </div>
                </div>
                <div class="token-actions">
                    ${status === 'active' ? 
                        `<button class="btn btn-danger" onclick="revokeAuthorizedUser('${emailKey}')">해지</button>` :
                        `<button class="btn btn-success" onclick="reactivateAuthorizedUser('${emailKey}')">재활성화</button>`
                    }
                    <button class="btn btn-danger" onclick="deleteAuthorizedUser('${emailKey}')">삭제</button>
                </div>
            `;
            
            userList.appendChild(userItem);
        });
        
        console.log('등록된 사용자 목록 로드 완료:', userKeys.length + '명');
    } catch (error) {
        console.error('사용자 목록 로드 실패:', error);
        document.getElementById('authorizedUsersList').innerHTML = '<p style="text-align: center; color: #dc3545; padding: 20px;">로드 실패</p>';
    }
}

// 등록된 사용자 해지
async function revokeAuthorizedUser(emailKey) {
    if (confirm('이 사용자의 권한을 해지하시겠습니까?')) {
        try {
            await database.ref(`authorized_users/${emailKey}/status`).set('revoked');
            await refreshAuthorizedUsers();
            alert('사용자 권한이 해지되었습니다.');
        } catch (error) {
            alert('해지 실패: ' + error.message);
        }
    }
}

// 등록된 사용자 재활성화
async function reactivateAuthorizedUser(emailKey) {
    if (confirm('이 사용자의 권한을 재활성화하시겠습니까?')) {
        try {
            await database.ref(`authorized_users/${emailKey}/status`).set('active');
            await refreshAuthorizedUsers();
            alert('사용자 권한이 재활성화되었습니다.');
        } catch (error) {
            alert('재활성화 실패: ' + error.message);
        }
    }
}

// 등록된 사용자 삭제
async function deleteAuthorizedUser(emailKey) {
    if (confirm('이 사용자를 완전히 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) {
        try {
            await database.ref(`authorized_users/${emailKey}`).remove();
            await refreshAuthorizedUsers();
            alert('사용자가 삭제되었습니다.');
        } catch (error) {
            alert('삭제 실패: ' + error.message);
        }
    }
}

// 통계 업데이트
async function updateStats() {
    const tokens = Object.keys(tokenDatabase);
    const activeTokens = tokens.filter(token => {
        const tokenInfo = tokenDatabase[token];
        return tokenInfo.status === 'active' && new Date(tokenInfo.expires) > new Date();
    });
    const expiredTokens = tokens.filter(token => {
        const tokenInfo = tokenDatabase[token];
        return new Date(tokenInfo.expires) < new Date() || tokenInfo.status !== 'active';
    });
    
    // 등록된 사용자 수도 포함
    let authorizedUsersCount = 0;
    let todayLogins = 0;
    
    if (isFirebaseEnabled) {
        try {
            const snapshot = await database.ref('authorized_users').once('value');
            const users = snapshot.val() || {};
            authorizedUsersCount = Object.keys(users).filter(key => 
                users[key].status === 'active' && new Date(users[key].expires) > new Date()
            ).length;
            
            // 오늘 로그인한 사용자 수
            todayLogins = Object.keys(users).filter(key => {
                if (!users[key].lastUsed) return false;
                const lastUsed = new Date(users[key].lastUsed);
                const today = new Date();
                return lastUsed.toDateString() === today.toDateString();
            }).length;
        } catch (error) {
            console.log('사용자 통계 로드 실패:', error);
        }
    }
    
    document.getElementById('totalTokens').textContent = tokens.length + authorizedUsersCount;
    document.getElementById('activeTokens').textContent = activeTokens.length + authorizedUsersCount;
    document.getElementById('expiredTokens').textContent = expiredTokens.length;
    document.getElementById('todayLogins').textContent = todayLogins;
}
