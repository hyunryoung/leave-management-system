// 활성 토큰 목록 - 관리자가 업데이트하는 파일
window.ACTIVE_TOKENS = {
    // 이 파일은 관리자가 토큰을 생성할 때마다 자동으로 업데이트됩니다
    // 예시:
    // 'USR-2025-ADM-ABC123': { name: '김철수', role: 'admin', expires: '2026-12-31' }
};

// 마스터 관리자 토큰 (최초 설정용)
window.MASTER_TOKEN = 'MASTER-ADMIN-2025-INIT';
window.ACTIVE_TOKENS[window.MASTER_TOKEN] = {
    name: '마스터 관리자',
    role: 'admin', 
    expires: '2026-12-31'
};
