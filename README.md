# 은혜의 하루 · Christian Planner

한 HTML 파일로 동작하는 개인용 크리스찬 플래너입니다. 브라우저에서 열면 할 일·시간표·묵상·기도·메모를 기록하고, 데이터는 브라우저 `localStorage`에 자동 저장됩니다.

## 최신 버전

| 파일 | 설명 |
|------|------|
| **`hamin_planner_ver6.3.html`** | 현재 최신 (메모장, 시간표 확대/축소, 기도 제목, 암송 구절 등) |
| `hamin_planner_ver6.2.html` | 메모·스냅샷 기능 |
| `hamin_planner_ver6.html` | 시간표·사이드바 개선 |
| `hamin_planner_ver5.html` | ver4 TimeBlocks 통합 |
| `hamin_planner_ver4.html` | 주간 프로젝트·TimeBlocks |
| `hamin_planner_ver1.html` ~ `ver3.2` | 이전 버전 (참고용) |

## 사용 방법

1. **`hamin_planner_ver6.3.html`** 을 더블클릭하거나 브라우저로 드래그해서 엽니다.
2. 별도 설치 없이 동작합니다 (React는 CDN에서 로드).
3. 모든 변경은 **자동 저장**됩니다 (같은 브라우저·같은 기기에서만 유지).

> **GitHub Pages로 배포할 때:** `index.html`로 최신 파일을 복사해 두면 루트 URL에서 바로 열립니다.

```bash
cp hamin_planner_ver6.3.html index.html
```

## 주요 기능 (ver6.3)

- **오늘** — 할 일, 시간 계획(드래그·5분 단위), 신앙 리듬, 묵상, 감사, 오늘의 기도 제목, 암송 구절
- **주간 모아보기** — 신앙 목표, 요일별 체크, 주간 기도·묵상 모아보기
- **월간** — 달력 + QT·통독 요약
- **메모** — 스크래치패드 + 포스트잇 스냅샷
- **기도 노트** — 대상별 중보기도 기록
- **사이드바** — 미니 주간 달력, 이번 주 프로젝트·할 일, 메모장, 데이터 백업

## 데이터 백업

- 앱 내 **사이드바 → 데이터 → 백업 / 가져오기** 로 JSON 내보내기·복원
- `planner-export.json` 같은 파일은 **개인 기록**이므로 이 저장소에는 포함하지 않습니다 (`.gitignore` 처리)

## 저장소에 포함하지 않는 것

| 항목 | 이유 |
|------|------|
| `planner-export.json`, `*-export.json` | 개인 플래너 데이터 |
| `.env` | Supabase 등 API 키 (추후 연동 시) |

## GitHub에 올리기

```bash
cd /home/hamin/planner
git add .
git status          # planner-export.json이 목록에 없어야 함
git commit -m "Update planner"
git push
```

## 로드맵 (예정)

- [ ] Supabase 연동 — PC·모바일 동기화
- [ ] GitHub Pages 배포 — HTTPS URL로 접속
- [ ] PWA — 모바일 홈 화면 추가

## 기술 스택

- 단일 HTML + inline CSS + React 18 (CDN) + Babel standalone
- 저장: `localStorage` (`hamin-planner-v5` 키)

## 라이선스

개인 프로젝트. 코드 공유 시 출처를 명시해 주세요.
