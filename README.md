# LoL Triple Draft (React + Express + Socket.io)

간단한 5vs5 트리플 드래프트 예제입니다.

## 실행 방법

1. 루트에서 의존성 설치

```bash
npm run install:all
```

2. 개발 서버 실행 (클라이언트 + 서버 동시 실행)

```bash
npm run dev
```

3. 접속

- 프론트엔드: http://localhost:5173
- 백엔드: http://localhost:4000

## 동작 요약

- 서버가 드래프트 상태를 100% 관리합니다.
- 턴마다 랜덤 챔피언 3개를 제공하고, 현재 턴 팀이 1개를 선택합니다.
- 선택된 챔피언은 풀에서 제거되고 중복 선택이 불가능합니다.
- 10픽 완료 후 SWAP 단계로 전환됩니다.
- SWAP 단계에서 같은 팀 내부 순서 변경이 가능합니다.
