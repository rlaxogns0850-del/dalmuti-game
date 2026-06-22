# 달무티 (The Great Dalmuti) — 실시간 멀티플레이어 웹 게임

## 로컬 실행
```bash
npm install
npm start
```
브라우저에서 http://localhost:3000 접속

## Render.com 배포 (지난번 경매 게임과 동일한 방식)

1. 이 폴더를 GitHub 저장소로 push
2. https://dashboard.render.com → **New + → Web Service** → 저장소 연결
3. 설정값
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free (친구들과 가볍게 플레이하기엔 충분)
4. 배포 완료 후 발급되는 `https://xxxx.onrender.com` 주소를 친구들에게 공유

### 지난번 경매 게임에서 겪었던 404 이슈 방지 포인트
- 이번 프로젝트는 **빌드 단계가 없는 순수 정적 파일**(`public/index.html`, `app.js`, `style.css`)이라
  React 빌드 캐시로 인한 404 문제가 구조적으로 발생하지 않습니다.
- 코드를 수정해서 재배포할 때도 보통 `npm install`만 다시 돌면 충분하지만,
  혹시 정적 파일이 이상하게 보이면 Render 대시보드에서 **"Clear build cache & deploy"**를 눌러주세요.

### Free 플랜 관련 참고
- Render 무료 인스턴스는 일정 시간 트래픽이 없으면 슬립 상태가 됩니다.
- 친구가 접속 시 첫 로딩이 10~30초 정도 걸릴 수 있어요. 게임 시작 전에 미리 한 번 접속해서 깨워두는 걸 추천합니다.

## 게임 플로우 요약
1. 한 명이 "방 만들기"로 방 생성 → 입장 코드 공유
2. 친구들은 코드로 입장, 닉네임/아이콘 설정 후 "준비완료"
3. 호스트가 4~8명 모이면 "게임 시작"
4. 1라운드는 무작위 신분 → 카드 제출 → 2라운드부터 왕/노예 세금 징수 자동 진행
5. 라운드가 끝날 때마다 신분이 재배정되고 화면 좌석도 자동 재배치됩니다

## 재접속
브라우저(또는 기기)별로 영구 `userId`가 `localStorage`에 저장되어, 와이파이가 끊겼다가
다시 접속해도 같은 방·같은 카드로 자동 복귀됩니다 (최대 60초 유예).
