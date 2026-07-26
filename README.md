# 은혜의 하루 · Christian Planner

컴퓨터와 모바일에서 함께 사용하는 개인용 크리스찬 플래너 PWA입니다. 할 일·시간표·묵상·기도·메모를 기록하고, Supabase 계정으로 로그인하면 기기 간에 항목별로 동기화됩니다.

## 최신 버전

| 파일 | 설명 |
|------|------|
| **`index.html` + `planner.html`** | **버전 8** — 설치형 PWA, 항목별 실시간 동기화, 오프라인 병합 |
| `hamin_planner_ver6.3.html` | 동기화 전 단일 HTML 보존본 |
| `hamin_planner_ver6.2.html` | 메모·스냅샷 기능 |
| `hamin_planner_ver6.html` | 시간표·사이드바 개선 |
| `hamin_planner_ver5.html` | ver4 TimeBlocks 통합 |
| `hamin_planner_ver4.html` | 주간 프로젝트·TimeBlocks |
| `hamin_planner_ver1.html` ~ `ver3.2` | 이전 버전 (참고용) |

## 사용 방법

1. `https://hkimkr.github.io/christian-planner/`에 접속합니다.
2. 오른쪽 위 `클라우드 로그인`에서 같은 계정으로 로그인합니다.
3. 모바일에서는 브라우저 메뉴의 `홈 화면에 추가` 또는 `앱 설치`를 사용합니다.
4. 모든 변경은 기기에 먼저 자동 저장되고, 연결되면 Supabase에 동기화됩니다.

## 주요 기능 (버전 8)

- **오늘** — 할 일, 시간 계획(드래그·5분 단위), 신앙 리듬, 묵상, 감사, 오늘의 기도 제목, 암송 구절
- **주간 모아보기** — 신앙 목표, 요일별 체크, 주간 기도·묵상 모아보기
- **월간** — 달력 + QT·통독 요약
- **메모** — 스크래치패드 + 포스트잇 스냅샷
- **기도 노트** — 사람·공동체별 중보기도, 긴급 표시, 상세 내용, 모바일 순서 변경
- **사이드바** — 미니 주간 달력, 이번 주 프로젝트·할 일, 메모장, 데이터 백업
- **클라우드 동기화** — 항목별 저장, 오프라인 대기열, 최신 수정 우선 병합, 실시간 수신

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

## 동기화 규칙

- 새 메모나 할 일을 서로 다른 기기에서 오프라인으로 추가해도 각 항목의 고유 ID를 기준으로 합쳐집니다.
- 같은 항목을 양쪽에서 수정하면 `updated_at`이 더 최신인 수정이 우선합니다.
- 업로드 전 변경은 IndexedDB 대기열에 보관하며, 서버 저장이 확인된 뒤에만 대기열에서 제거합니다.
- 기존 전체 JSON 데이터는 최초 연결 때 항목별 레코드로 복사하고 `planner_data`에는 백업으로 유지합니다.

## 기술 스택

- 정적 HTML + React 18 (CDN) + Babel standalone
- 기기 저장: `localStorage` + IndexedDB 오프라인 대기열
- 클라우드: Supabase Auth, PostgreSQL, RLS, Realtime
- 배포: GitHub Pages + PWA Service Worker

## 라이선스

개인 프로젝트. 코드 공유 시 출처를 명시해 주세요.
