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

// --- Rule 2: stale local never overwrites or resurrects --------------------

check("오래된 로컬 스냅샷이 클라우드를 덮어쓰지 않는다", () => {
  const staleLocal = dayStore([todo("todo-1", "")]);
  const result = api.simulate({ remoteStore: cloudStore, localStore: staleLocal });
  assert.strictEqual(result.reason, "cloud-authoritative");
  assert.strictEqual(result.outboxCount, 0, "덮어쓰기 업로드가 없어야 함");
  assert.ok(result.todoTexts.includes("클라우드에 있는 할 일"));
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
