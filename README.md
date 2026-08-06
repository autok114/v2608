# 게임 월간 일정

명조: 워더링 웨이브, 붕괴: 스타레일, 젠레스 존 제로의 일정을 월간 달력으로 보여주는 정적 웹사이트입니다.

## 자동 갱신

- 매일 오전 5시 17분(KST) GitHub Actions가 실행됩니다.
- `subgamecals.com`의 월간 일정에서 대상 게임 세 개만 수집합니다.
- 수집 결과가 비정상적으로 적거나 사이트 접속에 실패하면 기존 데이터를 유지합니다.
- Actions 화면의 `Update calendar and deploy`를 수동 실행해 즉시 갱신할 수도 있습니다.

## 로컬 확인

```bash
npm install
npm run check
python -m http.server 8000
```

브라우저에서 `http://localhost:8000`을 엽니다.

## 출처

일정 데이터: <https://www.subgamecals.com/>

중요한 일정은 각 게임 공식 공지를 최종 기준으로 확인해야 합니다.
