# 🚀 운영용 Firebase 인증 설정 가이드

## 📋 설정 순서

### 1️⃣ Firebase Authentication 활성화
1. **Firebase Console** → **Authentication** → **Sign-in method**
2. **이메일/비밀번호** → **사용 설정** 클릭
3. **Google** → **사용 설정** 클릭 (추천!)
   - 웹 SDK 구성에서 프로젝트 지원 이메일 설정
   - (선택) 승인된 도메인에 회사 도메인 추가

### 2️⃣ 관리자 스크립트 실행

#### A. 필수 패키지 설치
```bash
npm install
```

#### B. 서비스 계정 키 다운로드
1. **Firebase Console** → **프로젝트 설정** → **서비스 계정**
2. **새 비공개 키 생성** 클릭
3. 다운로드된 JSON 파일을 `serviceAccountKey.json`으로 저장

#### C. 사용자 계정 및 역할 설정
```bash
npm run setup-roles
```

### 3️⃣ Firebase 보안 규칙 적용

**Firebase Console** → **Realtime Database** → **규칙**에 다음 규칙 적용:

```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "tokens": {
      ".read": "auth != null && auth.token.role === 'admin'",
      ".write": "auth != null && auth.token.role === 'admin'"
    },
    "employees": {
      ".read": "auth != null && (auth.token.role === 'manager' || auth.token.role === 'admin')",
      ".write": "auth != null && auth.token.role === 'admin'"
    },
    "leaveRecords": {
      ".read": "auth != null",
      ".write": "auth != null && (auth.token.role === 'manager' || auth.token.role === 'admin')"
    }
  }
}
```

### 4️⃣ 로그인 방법

#### **A. 테스트 계정 (이메일/비밀번호)**
| 역할 | 이메일 | 비밀번호 | 권한 |
|------|--------|----------|------|
| 관리자 | admin@company.com | admin123 | 모든 권한 |
| 매니저 | manager@company.com | manager123 | 직원 관리, 휴가 등록 |
| 직원 | staff@company.com | staff123 | 조회만 가능 |

#### **B. Google 로그인**
1. **"Google로 로그인"** 버튼 클릭
2. **Google 계정 선택** 및 권한 승인
3. **최초 로그인 후 역할 부여 필요:**
   ```bash
   # setRole.js 파일에 본인 이메일 추가
   await setRole('your_email@gmail.com', 'admin');
   
   # 스크립트 재실행
   npm run setup-roles
   ```
4. **다시 로그인하여 역할 적용**

## 🔒 보안 기능

### ✅ 구현된 보안
- **AES-256급 암호화**: 주민번호, 전화번호, 주소
- **Firebase Custom Claims**: 역할 기반 접근 제어
- **sessionStorage 중심**: 민감정보 로컬 저장 최소화
- **운영급 보안 규칙**: 인증된 사용자만 접근

### 🛡️ 데이터 보호
- **민감정보 마스킹**: 화면 표시 시 일부만 표시
- **로컬스토리지 보안**: 민감정보 암호화 또는 제외
- **Firebase 접근 제어**: 역할별 읽기/쓰기 권한 분리

## 🚨 주의사항

1. **serviceAccountKey.json**: 절대 공개 저장소에 업로드 금지
2. **운영 비밀번호**: 테스트 비밀번호 변경 필수
3. **Custom Claims**: 사용자는 다시 로그인해야 새 역할 적용
4. **보안 규칙**: 반드시 운영 환경에 맞게 수정

## 📞 문제 해결

### 자주 발생하는 문제들:

**Q: 로그인 후 권한이 적용되지 않음**
A: 사용자가 다시 로그인해야 Custom Claims가 토큰에 적용됩니다.

**Q: Firebase 규칙에서 auth.token.role이 undefined**
A: setRole.js 스크립트가 정상 실행되었는지, 사용자가 다시 로그인했는지 확인하세요.

**Q: 데이터 읽기/쓰기 권한 오류**
A: Firebase 보안 규칙이 정확히 적용되었는지 확인하고, 사용자 역할을 재확인하세요.

## 🎯 운영 준비 완료!

이 설정이 완료되면:
- ✅ 실제 직원 데이터 안전 관리
- ✅ 개인정보보호법 준수
- ✅ 역할 기반 접근 제어
- ✅ 운영 환경 수준 보안

**완벽한 운영용 휴가 관리 시스템이 준비됩니다!** 🚀
