// setRole.js - Firebase Custom Claims 설정 스크립트
// 실행 전에 필요한 것들:
// 1. npm install firebase-admin
// 2. Firebase 콘솔에서 serviceAccountKey.json 다운로드
// 3. Firebase Authentication에서 이메일/비밀번호 사용자 생성

const admin = require('firebase-admin');
const fs = require('fs');

// 서비스 계정 키 파일 확인
if (!fs.existsSync('./serviceAccountKey.json')) {
    console.error('❌ serviceAccountKey.json 파일이 없습니다!');
    console.log('Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성');
    process.exit(1);
}

// Firebase Admin 초기화
admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(fs.readFileSync('./serviceAccountKey.json', 'utf8')))
});

// 사용자에게 역할 부여
async function setRole(email, role) {
    try {
        const user = await admin.auth().getUserByEmail(email);
        await admin.auth().setCustomUserClaims(user.uid, { role });
        console.log(`✅ 역할 설정 완료: ${email} → ${role}`);
    } catch (error) {
        console.error(`❌ 역할 설정 실패: ${email} →`, error.message);
    }
}

// 사용자 생성 (이미 존재하면 건너뜀)
async function createUser(email, password, role) {
    try {
        const user = await admin.auth().createUser({
            email: email,
            password: password,
            emailVerified: true
        });
        console.log(`✅ 사용자 생성: ${email}`);
        
        // 역할 설정
        await admin.auth().setCustomUserClaims(user.uid, { role });
        console.log(`✅ 역할 설정: ${email} → ${role}`);
        
    } catch (error) {
        if (error.code === 'auth/email-already-exists') {
            console.log(`⚠️  사용자 이미 존재: ${email}, 역할만 설정합니다.`);
            await setRole(email, role);
        } else {
            console.error(`❌ 사용자 생성 실패: ${email} →`, error.message);
        }
    }
}

// 메인 실행 함수
(async () => {
    console.log('🚀 Firebase Custom Claims 설정 시작...\n');
    
    // 테스트 계정들 생성 및 역할 설정
    await createUser('admin@company.com', 'admin123', 'admin');
    await createUser('manager@company.com', 'manager123', 'manager');
    await createUser('staff@company.com', 'staff123', 'user');
    
    // 실제 운영용 계정들 (필요시 수정)
    // await createUser('hr@yourcompany.com', 'your_secure_password', 'admin');
    // await createUser('team_manager@yourcompany.com', 'your_secure_password', 'manager');
    
    // Google 로그인 사용자에게 역할 부여 (이메일만으로)
    // 먼저 웹에서 Google 로그인을 한 번 해서 사용자가 생성되어야 함
    
    // 🔽 여기에 실제 Google 계정 이메일을 추가하세요 🔽
    await setRole('shr941207@gmail.com', 'admin');
    await setRole('rhdudgok@gmail.com', 'admin');
    // await setRole('manager_email@company.com', 'manager');
    // await setRole('employee_email@gmail.com', 'user');
    
    // 예시:
    // await setRole('john.doe@gmail.com', 'admin');
    // await setRole('jane.smith@company.com', 'manager');
    // await setRole('staff.member@gmail.com', 'user');
    
    console.log('\n✅ 모든 설정이 완료되었습니다!');
    console.log('\n📋 다음 단계:');
    console.log('1. Firebase Console → Authentication → 로그인 방법 → 이메일/비밀번호 활성화');
    console.log('2. Firebase Console → Realtime Database → 규칙 → 운영용 보안 규칙 적용');
    console.log('3. 웹사이트에서 생성된 계정으로 로그인 테스트');
    console.log('\n⚠️  주의: 사용자들은 다시 로그인해야 새 역할이 적용됩니다.');
    
    process.exit(0);
})().catch(error => {
    console.error('❌ 스크립트 실행 실패:', error);
    process.exit(1);
});
