// Runs the real sync-app.js inside a minimal browser stub and asserts the
// sync rules that protect user data:
//   1. new local work is never lost,
//   2. existing content is never blanked or resurrected,
//   3. stale or partial snapshots can never delete anything.
// Usage: node tests/sync-rules.test.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

function makeStubWindow() {
  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  const element = () => ({
    hidden: false,
    disabled: false,
    textContent: "",
    value: "",
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {},
  });
  const document = {
    documentElement: { dataset: {} },
    getElementById: () => element(),
    addEventListener() {},
    removeEventListener() {},
    visibilityState: "visible",
  };
  const window = {
    URLSearchParams,
    JSON,
    Date,
    Math,
    Promise,
    Map,
    Set,
    location: {
      search: "?sync-test",
      origin: "https://example.test",
      href: "https://example.test/",
    },
    localStorage,
    document,
    navigator: { onLine: true },
    addEventListener() {},
    removeEventListener() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    supabase: {
      createClient: () => ({
        auth: {
          getSession: async () => ({ data: { session: null } }),
          onAuthStateChange() {},
        },
        from: () => ({ select: () => ({ eq: async () => ({ data: [] }) }) }),
        rpc: async () => ({ data: [] }),
        channel: () => ({
          on() {
            return this;
          },
          subscribe() {
            return this;
          },
        }),
        removeChannel: async () => {},
      }),
    },
  };
  window.window = window;
  window.globalThis = window;
  window.self = window;
  return window;
}

const sandbox = makeStubWindow();
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "sync-app.js"), "utf8"),
  sandbox
);

const api = sandbox.window.__plannerSyncDiagnostics;
assert.ok(api, "diagnostics API should be exposed with ?sync-test");

// Values returned from the sandbox belong to another realm, so compare by
// value rather than with deepStrictEqual's realm-sensitive checks.
const equalList = (actual, expected, message) =>
  assert.strictEqual(JSON.stringify([...actual]), JSON.stringify(expected), message);

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, message: error.message });
  }
}

const DAY = "2026-08-13";
const dayStore = (todos, extra = {}) => ({
  projects: [],
  weeks: {},
  prayerGroups: [],
  memoSnapshots: [],
  scratch: { content: "", updatedAt: null },
  days: {
    [DAY]: {
      todos,
      gratitude: [],
      blocksPlan: [],
      blocksActual: [],
      focusSessions: [],
      ...extra,
    },
  },
});

const todo = (id, text, done = false) => ({ id, text, done });

const cloudStore = dayStore([todo("todo-1", "클라우드에 있는 할 일")]);

// --- Rule 1: new local work survives a refresh -----------------------------

check("새로 적은 할 일은 새로고침 후에도 살아남는다", () => {
  const localStore = dayStore([
    todo("todo-1", "클라우드에 있는 할 일"),
    todo("todo-2", "방금 적은 할 일"),
  ]);
  const result = api.simulate({ remoteStore: cloudStore, localStore });
  assert.ok(result.todoTexts.includes("방금 적은 할 일"), "새 할 일이 유지되어야 함");
  assert.ok(
    result.todoTexts.includes("클라우드에 있는 할 일"),
    "기존 할 일도 유지되어야 함"
  );
});

check("기존 할 일을 고친 내용은 새로고침 후에도 살아남는다", () => {
  const edited = dayStore([todo("todo-1", "방금 고친 할 일")]);
  const result = api.simulate({
    remoteStore: cloudStore,
    localStore: edited,
    lastAppliedFingerprint: api.fingerprintStore(cloudStore),
  });
  assert.ok(result.todoTexts.includes("방금 고친 할 일"));
  assert.ok(result.outboxCount > 0, "고친 내용이 업로드 대기해야 함");
});

check("며칠 전 스냅샷을 든 기기가 재접속해도 최신 클라우드를 덮지 않는다", () => {
  const daysOldLocal = dayStore([todo("todo-1", "3일 전에 쓰던 할 일")]);
  const result = api.simulate({
    remoteStore: cloudStore,
    localStore: daysOldLocal,
    // 이 기기가 마지막으로 적용한 상태도, 로컬을 마지막으로 쓴 시각도
    // 클라우드 행(1000)보다 앞선다.
    lastAppliedFingerprint: api.fingerprintStore(dayStore([todo("todo-1", "3일 전 클라우드 할 일")])),
    localUpdatedAt: 500,
  });
  assert.ok(result.todoTexts.includes("클라우드에 있는 할 일"));
  assert.ok(
    !result.todoTexts.includes("3일 전에 쓰던 할 일"),
    "오래된 스냅샷이 최신 클라우드를 덮으면 안 됨"
  );
  assert.strictEqual(result.outboxCount, 0, "덮어쓰기 업로드가 없어야 함");
});

// 규칙 5의 증거는 "실제 편집"만이다. LOCAL_UPDATED_KEY는 클라우드 내용을 이 기기에
// 적용할 때도 찍히므로, 셸은 USER_EDITED_KEY만 본다. 예전 버전에서 올라온 기기에는
// 이 키가 없는데, 그때는 "편집 기록 없음(0)"으로 읽는다.
const localStorageStub = sandbox.window.localStorage;
const STORAGE_KEY = "hamin-planner-v5";
const LOCAL_UPDATED_KEY = "hamin-planner-v5-local-updated-at";
const USER_EDITED_KEY = "hamin-planner-v5-user-edited-at";
const setStoredLocal = ({ raw = "", localUpdatedAt = null, userEditedAt = null }) => {
  localStorageStub.setItem(STORAGE_KEY, raw);
  if (localUpdatedAt === null) localStorageStub.removeItem(LOCAL_UPDATED_KEY);
  else localStorageStub.setItem(LOCAL_UPDATED_KEY, String(localUpdatedAt));
  if (userEditedAt === null) localStorageStub.removeItem(USER_EDITED_KEY);
  else localStorageStub.setItem(USER_EDITED_KEY, String(userEditedAt));
};

check("실제 사용자 편집은 오래된 클라우드 행보다 우선한다", () => {
  const edited = dayStore([todo("todo-1", "방금 고친 할 일")]);
  setStoredLocal({
    raw: JSON.stringify(edited),
    // 클라우드를 적용하며 찍힌 시각은 더 최근이지만, 증거로 쓰여선 안 된다.
    localUpdatedAt: 9000,
    userEditedAt: 5000,
  });
  const evidence = api.localEditEvidenceAt();
  assert.strictEqual(evidence, 5000, "셸은 사용자 편집 시각만 증거로 읽어야 함");
  const result = api.simulate({
    remoteStore: cloudStore,
    localStore: edited,
    lastAppliedFingerprint: api.fingerprintStore(cloudStore),
    localUpdatedAt: evidence,
  });
  assert.ok(result.todoTexts.includes("방금 고친 할 일"));
});

check("편집 없이 페이지만 열면 규칙 5의 증거가 없다", () => {
  const daysOldLocal = dayStore([todo("todo-1", "3일 전에 쓰던 할 일")]);
  const storedRaw = JSON.stringify(daysOldLocal);
  // 편집 없이 열기만 한 기기: 사용자 편집 키가 없고, 저장 시각만 방금 찍혀 있다.
  setStoredLocal({ raw: storedRaw, localUpdatedAt: 9000, userEditedAt: null });
  assert.strictEqual(api.localEditEvidenceAt(), 0, "편집 기록이 없으면 증거도 없어야 함");
  // 저장본을 그대로 다시 보낸 in-flight 스냅샷도 증거가 되지 않는다.
  assert.strictEqual(api.localEditEvidenceAt(storedRaw), 0);
  const result = api.simulate({
    remoteStore: cloudStore,
    localStore: daysOldLocal,
    lastAppliedFingerprint: "something-else",
    localUpdatedAt: api.localEditEvidenceAt(storedRaw),
  });
  assert.ok(result.todoTexts.includes("클라우드에 있는 할 일"));
  assert.ok(
    !result.todoTexts.includes("3일 전에 쓰던 할 일"),
    "편집 증거 없이 오래된 스냅샷이 클라우드를 덮으면 안 됨"
  );
});

check("아직 저장되지 않은 in-flight 편집은 편집 키가 없어도 증거가 된다", () => {
  const storedRaw = JSON.stringify(dayStore([todo("todo-1", "저장본")]));
  const editedRaw = JSON.stringify(dayStore([todo("todo-1", "방금 고친 할 일")]));
  setStoredLocal({ raw: storedRaw, localUpdatedAt: 9000, userEditedAt: null });
  assert.ok(api.localEditEvidenceAt(editedRaw) > 0);
  // 저장본과 같은 내용이면 여전히 증거가 아니다.
  assert.strictEqual(api.localEditEvidenceAt(storedRaw), 0);
});

// --- Rule 2: stale local never overwrites or resurrects --------------------

check("오래된 로컬 스냅샷이 클라우드를 덮어쓰지 않는다", () => {
  const staleLocal = dayStore([todo("todo-1", "")]);
  const result = api.simulate({ remoteStore: cloudStore, localStore: staleLocal });
  assert.strictEqual(result.reason, "cloud-authoritative");
  assert.strictEqual(result.outboxCount, 0, "덮어쓰기 업로드가 없어야 함");
  assert.ok(result.todoTexts.includes("클라우드에 있는 할 일"));
});

check("이 기기에서 지운 할 일은 새로고침 후 다시 나타나면 안 된다", () => {
  const result = api.simulate({
    remoteStore: cloudStore,
    localStore: dayStore([]),
    lastAppliedFingerprint: api.fingerprintStore(cloudStore),
    remoteTombstoneKeys: [`day_todo::${DAY}:todo-1`],
  });
  assert.ok(!result.todoTexts.includes("클라우드에 있는 할 일"));
});

check("빈 로컬 상태가 클라우드 내용을 지우지 않는다", () => {
  const result = api.simulate({ remoteStore: cloudStore, localStore: dayStore([]) });
  assert.ok(result.contentScore > 0, "클라우드 내용이 남아 있어야 함");
});

check("클라우드가 비어 있으면 로컬 내용을 올린다", () => {
  const result = api.simulate({ remoteStore: dayStore([]), localStore: cloudStore });
  assert.strictEqual(result.reason, "meaningful-local-recovery");
  assert.ok(result.outboxCount > 0, "로컬 내용이 업로드 대기해야 함");
});

// --- Rule 5b: an empty cloud must be proven before local is promoted -------

check("캐시엔 행이 있는데 조회가 0행이면 승격하지 않는다", () => {
  const daysOldLocal = dayStore([todo("todo-1", "3일 전에 쓰던 할 일")]);
  const result = api.simulate({
    // 조회는 0행. 그러나 이 기기는 전에 클라우드 행을 받아 캐시에 갖고 있다.
    remoteStore: null,
    cachedStore: cloudStore,
    localStore: daysOldLocal,
    // 카운트 조회까지 0을 확인해줘도 캐시에 행이 있으면 승격은 금지다.
    remoteEmptyConfirmed: true,
  });
  assert.strictEqual(result.reason, "remote-empty-unverified");
  assert.strictEqual(result.outboxCount, 0, "오래된 스냅샷을 올려선 안 됨");
});

check("확인되지 않은 빈 클라우드에는 로컬을 올리지 않는다", () => {
  const localOnly = dayStore([todo("todo-1", "이 기기에만 있는 할 일")]);
  const result = api.simulate({
    remoteStore: null,
    localStore: localOnly,
    // 카운트 조회가 실패했거나 0이 아니라고 답한 상황.
    remoteEmptyConfirmed: false,
  });
  assert.strictEqual(result.reason, "remote-empty-unverified");
  assert.strictEqual(result.outboxCount, 0, "확인 전에는 업로드 보류");
  assert.ok(result.contentScore > 0, "로컬 내용은 이 기기에 남아 있어야 함");
});

check("정말 빈 계정의 첫 동기화는 로컬 내용을 올린다", () => {
  const firstSyncLocal = dayStore([todo("todo-1", "처음 적은 할 일")]);
  const result = api.simulate({
    remoteStore: null,
    cachedStore: null,
    localStore: firstSyncLocal,
    remoteEmptyConfirmed: true,
  });
  assert.strictEqual(result.reason, "meaningful-local-recovery");
  assert.ok(result.outboxCount > 0, "빈 계정에는 로컬 내용을 올려야 함");
});

check("옛 저장소 마이그레이션도 같은 신뢰 조건을 따른다", () => {
  // 첫 동기화(캐시 없음 + 0행 확인됨)에서만 승격이 허용된다.
  assert.strictEqual(
    api.emptyCloudIsTrustworthy({ cachedSize: 0, remoteEmptyConfirmed: true }),
    true
  );
  // 캐시에 클라우드 행이 있으면 0행은 잘린 응답이나 세션 문제로 본다.
  assert.strictEqual(
    api.emptyCloudIsTrustworthy({ cachedSize: 3, remoteEmptyConfirmed: true }),
    false
  );
  // 카운트로 확인되지 않은 0행도 승격 근거가 아니다.
  assert.strictEqual(
    api.emptyCloudIsTrustworthy({ cachedSize: 0, remoteEmptyConfirmed: false }),
    false
  );
  assert.strictEqual(api.emptyCloudIsTrustworthy({}), false);
});

// --- Rule 3: deletions require proof --------------------------------------

check("스냅샷에서 할 일이 빠지면 실제 삭제로 처리된다", () => {
  const removed = api.deletionPlan({
    currentStore: cloudStore,
    snapshotStore: dayStore([]),
  });
  equalList(removed, [`day_todo::${DAY}:todo-1`]);
});

check("날짜가 통째로 빠진 스냅샷은 하위 할 일을 지우지 않는다", () => {
  const otherDay = dayStore([]);
  delete otherDay.days[DAY];
  const removed = api.deletionPlan({
    currentStore: cloudStore,
    snapshotStore: otherDay,
  });
  assert.ok(
    !removed.includes(`day_todo::${DAY}:todo-1`),
    "부모 날짜가 없는 스냅샷은 하위 항목을 지울 수 없음"
  );
});

check("다른 탭이 방금 만든 할 일은 이 탭 스냅샷 때문에 삭제되지 않는다", () => {
  const withOtherTabTodo = dayStore([
    todo("todo-1", "클라우드에 있는 할 일"),
    todo("todo-7", "다른 탭에서 적음"),
  ]);
  const thisTabSnapshot = dayStore([todo("todo-1", "클라우드에 있는 할 일")]);
  const removed = api.deletionPlan({
    currentStore: withOtherTabTodo,
    snapshotStore: thisTabSnapshot,
    seenStore: thisTabSnapshot,
  });
  assert.ok(
    !removed.includes(`day_todo::${DAY}:todo-7`),
    "다른 탭의 새 할 일이 삭제되면 안 됨"
  );
});

check("불확실한(추가 전용) 스냅샷은 절대 삭제하지 않는다", () => {
  const removed = api.deletionPlan({
    currentStore: cloudStore,
    snapshotStore: dayStore([]),
    additiveOnly: true,
  });
  equalList(removed, []);
});

check("root와 scratch는 삭제 대상이 아니다", () => {
  const removed = api.deletionPlan({
    currentStore: cloudStore,
    snapshotStore: dayStore([todo("todo-1", "클라우드에 있는 할 일")]),
  });
  assert.ok(!removed.includes("root::main"));
  assert.ok(!removed.includes("scratch::main"));
});

// --- Rule 4: field-level merges keep content ------------------------------

check("빈 값이 기존 내용을 덮어쓰지 않는다", () => {
  const merged = api.mergeStores(cloudStore, dayStore([todo("todo-1", "")]));
  assert.strictEqual(merged.days[DAY].todos[0].text, "클라우드에 있는 할 일");
});

check("실제로 바뀐 값은 최신 내용이 이긴다", () => {
  const merged = api.mergeStores(cloudStore, dayStore([todo("todo-1", "고친 할 일")]));
  assert.strictEqual(merged.days[DAY].todos[0].text, "고친 할 일");
});

check("완료 체크 같은 상태 변경은 반영된다", () => {
  const merged = api.mergeStores(
    cloudStore,
    dayStore([todo("todo-1", "클라우드에 있는 할 일", true)])
  );
  assert.strictEqual(merged.days[DAY].todos[0].done, true);
});

check("로그인 전에 고친 기존 할 일은 클라우드에 반영된다", () => {
  const edited = dayStore([todo("todo-1", "로그인 전에 고친 할 일")]);
  const result = api.simulate({
    remoteStore: cloudStore,
    localStore: edited,
    lastAppliedFingerprint: "",
    localUpdatedAt: 3000,
  });
  assert.ok(result.todoTexts.includes("로그인 전에 고친 할 일"));
  assert.ok(result.outboxCount > 0);
});

check("오프라인에서 고친 기존 할 일은 편집 키가 없어도 재접속 후 살아남는다", () => {
  const edited = dayStore([todo("todo-1", "오프라인에서 고친 할 일")]);
  const result = api.simulate({
    remoteStore: cloudStore,
    cachedStore: cloudStore,
    localStore: edited,
    lastAppliedFingerprint: api.fingerprintStore(cloudStore),
    localUpdatedAt: 0,
  });
  assert.ok(result.todoTexts.includes("오프라인에서 고친 할 일"));
  assert.ok(result.outboxCount > 0);
});

// --- Report ---------------------------------------------------------------

let failed = 0;
results.forEach(({ name, ok, message }) => {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${message}`);
  }
});
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
