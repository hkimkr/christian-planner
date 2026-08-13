// Grace Planner sync v8.2.3 — see README "동기화 규칙". The rules that protect
// data: written work is never dropped, empty values never overwrite content,
// and a deletion requires an observed transition rather than mere absence.
(() => {
  "use strict";

  const STORAGE_KEY = "hamin-planner-v5";
  const LOCAL_UPDATED_KEY = "hamin-planner-v5-local-updated-at";
  const LEGACY_PENDING_KEY = "hamin-planner-v5-pending-sync";
  const LAST_APPLIED_KEY = "hamin-planner-v5-last-applied-fp";
  const CLIENT_ID_KEY = "grace-planner-sync-client-id";
  const TAB_CHANNEL_NAME = "grace-planner-sync-tabs-v1";
  const INTENT_CLIENT_PREFIX = "intent-v1:";
  const DELETE_INTENT_CLIENT_PREFIX = "delete-v1:";
  const DB_NAME = "grace-planner-sync-v1";
  const DB_VERSION = 1;
  const RECORDS_STORE = "records";
  const OUTBOX_STORE = "outbox";
  const SUPABASE_URL = "https://wajhlnpyxcnhoybwtdqe.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_Kp3KAxlyT1eXot9vHE1wlQ_h4C0BVeJ";

  const client = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY
  );
  const frame = document.getElementById("planner-frame");
  const launcher = document.getElementById("cloud-sync-launcher");
  const label = document.getElementById("cloud-sync-label");
  const dot = document.getElementById("cloud-sync-dot");
  const backdrop = document.getElementById("cloud-auth-backdrop");
  const closeButton = document.getElementById("cloud-auth-close");
  const signedOut = document.getElementById("cloud-signed-out");
  const signedIn = document.getElementById("cloud-signed-in");
  const emailInput = document.getElementById("cloud-email");
  const passwordInput = document.getElementById("cloud-password");
  const errorBox = document.getElementById("cloud-auth-error");
  const statusBox = document.getElementById("cloud-status");
  const accountEmail = document.getElementById("cloud-account-email");
  const signInButton = document.getElementById("cloud-signin");
  const signUpButton = document.getElementById("cloud-signup");
  const signOutButton = document.getElementById("cloud-signout");

  const deviceId = (() => {
    const saved = localStorage.getItem(CLIENT_ID_KEY);
    if (saved) return saved;
    const created =
      globalThis.crypto?.randomUUID?.() ||
      `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, created);
    return created;
  })();
  const tabId =
    globalThis.crypto?.randomUUID?.() ||
    `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // Every tab must be its own sync writer. With one id per device, a tab
  // dismissed another tab's realtime rows as its own echo and the two never
  // converged.
  const clientId = `${deviceId}:tab:${tabId}`;
  const intentClientId = `${INTENT_CLIENT_PREFIX}${clientId}`;
  const deleteIntentClientId = `${DELETE_INTENT_CLIENT_PREFIX}${clientId}`;
  const tabChannel =
    typeof BroadcastChannel === "function"
      ? new BroadcastChannel(TAB_CHANNEL_NAME)
      : null;

  let currentSession = null;
  let channel = null;
  let reconnectTimer = null;
  let uploadTimer = null;
  let uploadRunning = false;
  let initializedUserId = "";
  let syncGeneration = 0;
  let currentRecords = new Map();
  let lastObservedFingerprint = "";
  let appliedFingerprint = "";
  let pendingPlannerStore = null;
  let pendingPlannerFingerprint = "";
  let plannerEditing = false;
  let reconnectAfterEditing = false;
  let deferredRemoteRecords = new Map();
  let deferredRemoteMessage = "";
  let localCaptureChain = Promise.resolve();
  let latestQueuedLocalRaw = "";
  let latestQueuedAdditiveOnly = false;
  let localCaptureRunning = false;
  let pendingLocalRaw = "";
  let deferredAckRaw = "";
  let ackGateTimer = null;
  let captureGateUntilApply = false;
  let lastSnapshotKeys = null;

  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.keys(value)
        .sort()
        .reduce((result, key) => {
          result[key] = canonicalize(value[key]);
          return result;
        }, {});
    }
    return value;
  };

  const fingerprintValue = (value) =>
    JSON.stringify(canonicalize(value));

  const fingerprintRaw = (raw) => {
    if (!raw) return "";
    try {
      return fingerprintValue(JSON.parse(raw));
    } catch {
      return raw;
    }
  };

  const clone = (value) =>
    value == null ? value : JSON.parse(JSON.stringify(value));

  const recordKey = (record) =>
    `${record.entity_type}::${record.entity_id}`;

  const localRecordKey = (userId, record) =>
    `${userId}|${recordKey(record)}`;

  const timestampOf = (record) =>
    Date.parse(record?.updated_at || "") || 0;

  const compareRecords = (left, right) => {
    const timeDifference = timestampOf(left) - timestampOf(right);
    if (timeDifference) return timeDifference;
    return String(left?.client_id || "").localeCompare(
      String(right?.client_id || "")
    );
  };

  // Default labels the app fills in for new items. Treating them as empty lets
  // a real title win over an untouched placeholder regardless of timestamps.
  const EMPTY_PLACEHOLDERS = new Set([
    "새 항목",
    "새 할 일",
    "새 프로젝트",
    "새 기도",
    "제목 없음",
    "제목 없는 메모",
    "무제",
  ]);
  // Bookkeeping fields carry no user content, so they must not make an
  // otherwise empty payload look meaningful.
  const STRUCTURAL_KEYS = new Set([
    "id",
    "parent_id",
    "order",
    "createdAt",
    "savedAt",
    "updatedAt",
    "completedAt",
    "date",
    "color",
  ]);

  const isPlainObject = (value) =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);

  function hasMeaningfulValue(value, key = "") {
    if (STRUCTURAL_KEYS.has(key)) return false;
    if (value == null) return false;
    if (typeof value === "string") {
      const text = value.trim();
      return Boolean(text) && !EMPTY_PLACEHOLDERS.has(text);
    }
    if (typeof value === "number" || typeof value === "boolean") return true;
    if (Array.isArray(value)) return value.some((item) => hasMeaningfulValue(item));
    if (isPlainObject(value)) {
      return Object.entries(value).some(
        ([childKey, childValue]) =>
          !STRUCTURAL_KEYS.has(childKey) &&
          hasMeaningfulValue(childValue, childKey)
      );
    }
    return Boolean(value);
  }

  const arrayItemKey = (item) =>
    isPlainObject(item) && item.id != null ? String(item.id) : "";

  // Merge field by field so that a newer-but-empty value never erases content.
  // preferredIntent marks a snapshot we trust to have really removed list
  // items; without it, entries missing from the preferred side are kept.
  function mergeContentValues(olderValue, preferredValue, preferredIntent = false) {
    const olderMeaningful = hasMeaningfulValue(olderValue);
    const preferredMeaningful = hasMeaningfulValue(preferredValue);
    if (!preferredMeaningful && olderMeaningful) return clone(olderValue);
    if (!olderMeaningful) return clone(preferredValue);

    if (Array.isArray(olderValue) && Array.isArray(preferredValue)) {
      const combined = [...olderValue, ...preferredValue];
      const keyed = combined.every(
        (item) => !isPlainObject(item) || Boolean(arrayItemKey(item))
      );
      if (keyed && combined.some(isPlainObject)) {
        const olderById = new Map(
          olderValue.map((item) => [arrayItemKey(item), item]).filter(([id]) => id)
        );
        const merged = preferredValue.map((item) => {
          const id = arrayItemKey(item);
          return id && olderById.has(id)
            ? mergeContentValues(olderById.get(id), item, preferredIntent)
            : clone(item);
        });
        if (!preferredIntent) {
          const preferredIds = new Set(
            preferredValue.map(arrayItemKey).filter(Boolean)
          );
          olderValue.forEach((item) => {
            const id = arrayItemKey(item);
            if (!id || !preferredIds.has(id)) merged.push(clone(item));
          });
        }
        return merged;
      }
      const seen = new Set();
      return [...preferredValue, ...olderValue]
        .filter((item) => {
          const fingerprint = fingerprintValue(item);
          if (seen.has(fingerprint)) return false;
          seen.add(fingerprint);
          return true;
        })
        .map(clone);
    }

    if (isPlainObject(olderValue) && isPlainObject(preferredValue)) {
      const merged = {};
      new Set([
        ...Object.keys(olderValue),
        ...Object.keys(preferredValue),
      ]).forEach((childKey) => {
        if (!(childKey in preferredValue)) {
          merged[childKey] = clone(olderValue[childKey]);
        } else if (!(childKey in olderValue)) {
          merged[childKey] = clone(preferredValue[childKey]);
        } else {
          merged[childKey] = mergeContentValues(
            olderValue[childKey],
            preferredValue[childKey],
            preferredIntent
          );
        }
      });
      return merged;
    }

    return clone(preferredValue);
  }

  const isIntentRecord = (record) =>
    record?.local_intent === true ||
    String(record?.client_id || "").startsWith(INTENT_CLIENT_PREFIX) ||
    String(record?.client_id || "").startsWith(DELETE_INTENT_CLIENT_PREFIX);

  const isOwnRecord = (record) =>
    record?.client_id === clientId ||
    record?.client_id === intentClientId ||
    record?.client_id === deleteIntentClientId;

  function contentAwareRecord(left, right) {
    if (!left) return clone(right);
    if (!right) return clone(left);
    const preferred = compareRecords(left, right) >= 0 ? left : right;
    const older = preferred === left ? right : left;
    const preferredActive = !preferred.deleted_at && preferred.payload != null;
    const olderActive = !older.deleted_at && older.payload != null;

    // A confirmed deletion is the one case where losing content is intended.
    if (
      preferred.deleted_at &&
      String(preferred.client_id || "").startsWith(DELETE_INTENT_CLIENT_PREFIX)
    ) {
      return clone(preferred);
    }
    if (preferred.deleted_at) return clone(preferred);
    if (!preferredActive && olderActive && hasMeaningfulValue(older.payload)) {
      return clone(older);
    }
    if (!olderActive || !preferredActive) return clone(preferred);
    if (
      !hasMeaningfulValue(preferred.payload) &&
      hasMeaningfulValue(older.payload)
    ) {
      return { ...clone(preferred), payload: clone(older.payload), deleted_at: null };
    }
    return {
      ...clone(preferred),
      payload: mergeContentValues(
        older.payload,
        preferred.payload,
        isIntentRecord(preferred)
      ),
      deleted_at: null,
    };
  }

  const sameRecordContent = (left, right) =>
    Boolean(left) === Boolean(right) &&
    (!left ||
      (Boolean(left.deleted_at) === Boolean(right.deleted_at) &&
        fingerprintValue(left.payload) === fingerprintValue(right.payload)));

  const hashText = (text) => {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };

  const stableItemId = (item, parentId, index, kind) => {
    if (item && typeof item === "object" && item.id) return String(item.id);
    return `legacy-${hashText(
      `${kind}|${parentId}|${index}|${fingerprintValue(item)}`
    )}`;
  };

  const makeRecord = (
    entityType,
    entityId,
    payload,
    updatedAt,
    sourceClientId = clientId,
    deletedAt = null
  ) => ({
    entity_type: entityType,
    entity_id: String(entityId),
    payload: payload == null ? null : clone(payload),
    updated_at: updatedAt,
    deleted_at: deletedAt,
    client_id: sourceClientId,
  });

  function storeToRecords(
    store,
    updatedAt = new Date().toISOString(),
    sourceClientId = clientId
  ) {
    const result = new Map();
    if (!store || typeof store !== "object") return result;
    const add = (type, id, payload) => {
      const record = makeRecord(
        type,
        id,
        payload,
        updatedAt,
        sourceClientId
      );
      result.set(recordKey(record), record);
    };

    const {
      projects = [],
      days = {},
      weeks = {},
      prayerGroups = [],
      memoSnapshots = [],
      scratch = { content: "", updatedAt: null },
      ...root
    } = store;

    add("root", "main", root);
    (Array.isArray(projects) ? projects : []).forEach((project, index) => {
      const id = stableItemId(project, "root", index, "project");
      add("project", id, { ...project, id });
    });

    Object.entries(days || {}).forEach(([dayKey, dayValue]) => {
      const day = dayValue || {};
      const {
        todos = [],
        gratitude = [],
        blocksPlan = [],
        blocksActual = [],
        focusSessions = [],
        ...dayBase
      } = day;
      add("day", dayKey, dayBase);
      [
        ["day_todo", todos],
        ["day_gratitude", gratitude],
        ["day_block_plan", blocksPlan],
        ["day_block_actual", blocksActual],
        ["day_focus_session", focusSessions],
      ].forEach(([type, items]) => {
        (Array.isArray(items) ? items : []).forEach((rawItem, index) => {
          const item =
            type === "day_gratitude" &&
            (rawItem == null || typeof rawItem !== "object")
              ? { text: String(rawItem || "") }
              : rawItem || {};
          const id = stableItemId(item, dayKey, index, type);
          add(type, `${dayKey}:${id}`, {
            parent_id: dayKey,
            item: { ...item, id },
          });
        });
      });
    });

    Object.entries(weeks || {}).forEach(([weekKey, weekValue]) => {
      const week = weekValue || {};
      const { tasks = [], projects: weekProjects = [], ...weekBase } = week;
      add("week", weekKey, weekBase);
      (Array.isArray(weekProjects) ? weekProjects : []).forEach(
        (project, index) => {
          const id = stableItemId(project, weekKey, index, "week_project");
          add("week_project", `${weekKey}:${id}`, {
            parent_id: weekKey,
            item: { ...project, id },
          });
        }
      );
      (Array.isArray(tasks) ? tasks : []).forEach((task, index) => {
        const id = stableItemId(task, weekKey, index, "week_task");
        add("week_task", `${weekKey}:${id}`, {
          parent_id: weekKey,
          item: { ...task, id },
        });
      });
    });

    (Array.isArray(prayerGroups) ? prayerGroups : []).forEach(
      (group, groupIndex) => {
        const groupId = stableItemId(
          group,
          "prayer",
          groupIndex,
          "prayer_group"
        );
        const { items = [], ...groupBase } = group || {};
        add("prayer_group", groupId, { ...groupBase, id: groupId });
        (Array.isArray(items) ? items : []).forEach((item, itemIndex) => {
          const itemId = stableItemId(
            item,
            groupId,
            itemIndex,
            "prayer_item"
          );
          add("prayer_item", `${groupId}:${itemId}`, {
            parent_id: groupId,
            item: { ...item, id: itemId },
          });
        });
      }
    );

    (Array.isArray(memoSnapshots) ? memoSnapshots : []).forEach(
      (memo, index) => {
        const id = stableItemId(memo, "memo", index, "memo");
        add("memo", id, { ...memo, id });
      }
    );
    add("scratch", "main", scratch || { content: "", updatedAt: null });
    return result;
  }

  const activeRecordsOfType = (records, type) =>
    [...records.values()].filter(
      (record) => record.entity_type === type && !record.deleted_at
    );

  const itemSort = (left, right) =>
    (left?.order ?? 0) - (right?.order ?? 0) ||
    (left?.createdAt ?? left?.savedAt ?? 0) -
      (right?.createdAt ?? right?.savedAt ?? 0) ||
    String(left?.id || "").localeCompare(String(right?.id || ""));

  function recordsToStore(records, fallbackStore = {}) {
    const rootRecord = records.get("root::main");
    const root =
      rootRecord && !rootRecord.deleted_at ? clone(rootRecord.payload) : {};
    const store = {
      ...clone(fallbackStore || {}),
      ...root,
      projects: [],
      days: {},
      weeks: {},
      prayerGroups: [],
      memoSnapshots: [],
      scratch: { content: "", updatedAt: null },
    };

    store.projects = activeRecordsOfType(records, "project")
      .map((record) => clone(record.payload))
      .sort(itemSort);

    const ensureDay = (dayKey) => {
      if (!store.days[dayKey]) {
        store.days[dayKey] = {
          todos: [],
          gratitude: [],
          blocksPlan: [],
          blocksActual: [],
          focusSessions: [],
        };
      }
      return store.days[dayKey];
    };
    activeRecordsOfType(records, "day").forEach((record) => {
      store.days[record.entity_id] = {
        ...clone(record.payload),
        todos: [],
        gratitude: [],
        blocksPlan: [],
        blocksActual: [],
        focusSessions: [],
      };
    });
    [
      ["day_todo", "todos"],
      ["day_gratitude", "gratitude"],
      ["day_block_plan", "blocksPlan"],
      ["day_block_actual", "blocksActual"],
      ["day_focus_session", "focusSessions"],
    ].forEach(([type, field]) => {
      activeRecordsOfType(records, type).forEach((record) => {
        const payload = record.payload || {};
        if (!payload.parent_id || !payload.item) return;
        ensureDay(payload.parent_id)[field].push(clone(payload.item));
      });
      Object.values(store.days).forEach((day) => day[field].sort(itemSort));
    });

    const ensureWeek = (weekKey) => {
      if (!store.weeks[weekKey]) {
        store.weeks[weekKey] = { tasks: [], projects: [] };
      }
      return store.weeks[weekKey];
    };
    activeRecordsOfType(records, "week").forEach((record) => {
      store.weeks[record.entity_id] = {
        ...clone(record.payload),
        tasks: [],
        projects: [],
      };
    });
    [
      ["week_project", "projects"],
      ["week_task", "tasks"],
    ].forEach(([type, field]) => {
      activeRecordsOfType(records, type).forEach((record) => {
        const payload = record.payload || {};
        if (!payload.parent_id || !payload.item) return;
        ensureWeek(payload.parent_id)[field].push(clone(payload.item));
      });
      Object.values(store.weeks).forEach((week) =>
        week[field].sort(itemSort)
      );
    });

    const groups = new Map();
    activeRecordsOfType(records, "prayer_group").forEach((record) => {
      groups.set(record.entity_id, { ...clone(record.payload), items: [] });
    });
    activeRecordsOfType(records, "prayer_item").forEach((record) => {
      const payload = record.payload || {};
      const group = groups.get(payload.parent_id);
      if (group && payload.item) group.items.push(clone(payload.item));
    });
    store.prayerGroups = [...groups.values()]
      .map((group) => ({ ...group, items: group.items.sort(itemSort) }))
      .sort(itemSort);

    store.memoSnapshots = activeRecordsOfType(records, "memo")
      .map((record) => clone(record.payload))
      .sort(itemSort);
    const scratchRecord = records.get("scratch::main");
    if (scratchRecord && !scratchRecord.deleted_at) {
      store.scratch = clone(scratchRecord.payload);
    }
    return store;
  }

  function mergeRecordMaps(...maps) {
    const merged = new Map();
    maps.forEach((records) => {
      records?.forEach((record, key) => {
        merged.set(key, contentAwareRecord(merged.get(key), record));
      });
    });
    return merged;
  }

  const activeRecordCount = (records, type) =>
    [...(records?.values?.() || [])].filter(
      (record) => record.entity_type === type && !record.deleted_at
    ).length;

  // A rough measure of "how much real content is in here", used only to tell a
  // populated state from an empty one before deciding what to trust.
  function storeContentScore(store) {
    if (!store || typeof store !== "object") return 0;
    let score = 0;
    (Array.isArray(store.projects) ? store.projects : []).forEach((project) => {
      if (hasMeaningfulValue(project?.name)) score += 1;
    });
    Object.values(store.days || {}).forEach((day) => {
      score += (Array.isArray(day?.todos) ? day.todos.length : 0) * 4;
      score += (Array.isArray(day?.gratitude) ? day.gratitude.length : 0) * 2;
      score += (Array.isArray(day?.blocksPlan) ? day.blocksPlan.length : 0) * 2;
      score += (Array.isArray(day?.blocksActual) ? day.blocksActual.length : 0) * 2;
      score += (Array.isArray(day?.focusSessions) ? day.focusSessions.length : 0) * 2;
    });
    Object.values(store.weeks || {}).forEach((week) => {
      score += (Array.isArray(week?.tasks) ? week.tasks.length : 0) * 4;
      score += (Array.isArray(week?.projects) ? week.projects.length : 0) * 2;
    });
    (Array.isArray(store.prayerGroups) ? store.prayerGroups : []).forEach((group) => {
      score += 1 + (Array.isArray(group?.items) ? group.items.length : 0) * 2;
    });
    score += (Array.isArray(store.memoSnapshots) ? store.memoSnapshots.length : 0) * 4;
    if (String(store.scratch?.content || "").trim()) score += 3;
    return score;
  }

  const recordsContentScore = (records) => {
    if (!records?.size) return 0;
    return (
      activeRecordCount(records, "day_todo") * 4 +
      activeRecordCount(records, "week_task") * 4 +
      activeRecordCount(records, "memo") * 4 +
      activeRecordCount(records, "prayer_item") * 2 +
      activeRecordCount(records, "day_gratitude") * 2 +
      activeRecordCount(records, "day_block_plan") * 2 +
      activeRecordCount(records, "day_block_actual") * 2 +
      activeRecordCount(records, "project")
    );
  };

  const intentRecordsFromStore = (store, timestamp = Date.now()) => {
    const marked = new Map();
    let sequence = 0;
    storeToRecords(store, new Date(timestamp).toISOString(), intentClientId)
      .forEach((record, key) => {
        sequence += 1;
        marked.set(key, {
          ...record,
          updated_at: new Date(timestamp + sequence).toISOString(),
          client_id: intentClientId,
          local_intent: true,
        });
      });
    return marked;
  };

  // Rows whose merged result differs from the cloud need to be pushed back so
  // every device converges on the merged content.
  function repairRecordsAgainstRemote(records, remoteRecords) {
    const repairs = new Map();
    let sequence = 0;
    const now = Date.now();
    records.forEach((record, key) => {
      const remote = remoteRecords.get(key);
      if (
        sameRecordContent(record, remote) ||
        (!remote && !hasMeaningfulValue(record.payload))
      ) {
        return;
      }
      sequence += 1;
      repairs.set(key, {
        ...clone(record),
        updated_at: new Date(now + sequence).toISOString(),
        client_id: record.deleted_at ? deleteIntentClientId : intentClientId,
        local_intent: true,
      });
    });
    return repairs;
  }

  // localStorage after a refresh is trustworthy only when it differs from the
  // last store this device applied from the cloud. That difference is this
  // tab's unsynced work (a new todo, or edits to one that already exists).
  function adoptUnsyncedLocalRecords({
    localRecords,
    remote,
    cached,
    outbox,
    localStore,
    lastAppliedFingerprint = "",
  }) {
    const adopted = new Map();
    if (!localRecords?.size) return adopted;
    const localFp = localStore ? fingerprintValue(localStore) : "";
    if (lastAppliedFingerprint && localFp && localFp === lastAppliedFingerprint) {
      return adopted;
    }
    const known = (key) =>
      Boolean(remote?.get(key) || cached?.get(key) || outbox?.get(key));
    const allowMergeExisting = Boolean(lastAppliedFingerprint && localFp);

    let sequence = 0;
    const now = Date.now();
    const stamp = (record) => {
      sequence += 1;
      return {
        ...clone(record),
        updated_at: new Date(now + sequence).toISOString(),
        client_id: intentClientId,
        local_intent: true,
        deleted_at: null,
      };
    };

    localRecords.forEach((local, key) => {
      if (local.deleted_at || local.payload == null) return;
      if (!hasMeaningfulValue(local.payload)) return;
      const remoteRec = remote?.get(key);
      const outboxRec = outbox?.get(key);
      const cachedRec = cached?.get(key);
      if (remoteRec?.deleted_at || outboxRec?.deleted_at || cachedRec?.deleted_at) {
        return;
      }
      if (!known(key)) {
        adopted.set(key, stamp(local));
        return;
      }
      if (!allowMergeExisting) return;
      const merged = contentAwareRecord(remoteRec || cached?.get(key), stamp(local));
      if (!sameRecordContent(merged, remoteRec || cached?.get(key))) {
        adopted.set(key, merged);
      }
    });
    return adopted;
  }

  function resolveInitialRecordState({
    remote,
    cached,
    outbox,
    localRecords,
    pendingRecords,
    remoteFetched,
    localStore,
    lastAppliedFingerprint = "",
  }) {
    const trustedOutbox = new Map();
    outbox.forEach((record, key) => {
      if (isIntentRecord(record)) trustedOutbox.set(key, record);
    });

    if (!remoteFetched) {
      const offlineRecords = mergeRecordMaps(
        cached,
        localRecords,
        outbox,
        pendingRecords
      );
      if (offlineRecords.size || storeContentScore(localStore) === 0) {
        return {
          records: offlineRecords,
          outbox: new Map(outbox),
          reason: "offline-local",
        };
      }
      const recovered = intentRecordsFromStore(localStore);
      return { records: recovered, outbox: recovered, reason: "offline-recovery" };
    }

    if (!recordsContentScore(remote) && storeContentScore(localStore) === 0) {
      return {
        records: mergeRecordMaps(remote),
        outbox: new Map(),
        reason: "empty-account",
      };
    }

    // The cloud has nothing but this device does: push the local state up
    // rather than letting an empty cloud blank the planner.
    if (!recordsContentScore(remote) && storeContentScore(localStore) > 0) {
      const recovered = intentRecordsFromStore(localStore);
      const merged = mergeRecordMaps(remote, recovered, trustedOutbox);
      const repairs = repairRecordsAgainstRemote(merged, remote);
      return {
        records: mergeRecordMaps(merged, repairs),
        outbox: mergeRecordMaps(trustedOutbox, repairs),
        reason: "meaningful-local-recovery",
      };
    }

    const unsyncedLocal = adoptUnsyncedLocalRecords({
      localRecords: mergeRecordMaps(localRecords, pendingRecords),
      remote,
      cached,
      outbox,
      localStore,
      lastAppliedFingerprint,
    });
    const merged = mergeRecordMaps(remote, trustedOutbox, unsyncedLocal);
    const repairs = repairRecordsAgainstRemote(merged, remote);
    let reason = "cloud-authoritative";
    if (unsyncedLocal.size) reason = "unsynced-local-adopt";
    else if (repairs.size) reason = "content-aware-merge";
    return {
      records: mergeRecordMaps(merged, repairs),
      outbox: mergeRecordMaps(trustedOutbox, unsyncedLocal, repairs),
      reason,
    };
  }

  function openSyncDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(RECORDS_STORE)) {
          db.createObjectStore(RECORDS_STORE, { keyPath: "local_key" });
        }
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
          db.createObjectStore(OUTBOX_STORE, { keyPath: "local_key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getStoredRecords(storeName, userId) {
    const db = await openSyncDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).getAll();
      request.onsuccess = () => {
        const records = new Map();
        (request.result || [])
          .filter((entry) => entry.user_id === userId)
          .forEach((entry) => {
            const { local_key: _localKey, user_id: _userId, ...record } =
              entry;
            records.set(recordKey(record), record);
          });
        resolve(records);
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => db.close();
    });
  }

  async function putStoredRecords(storeName, userId, records) {
    if (!records?.length) return;
    const db = await openSyncDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const objectStore = transaction.objectStore(storeName);
      records.forEach((record) => {
        objectStore.put({
          ...clone(record),
          user_id: userId,
          local_key: localRecordKey(userId, record),
        });
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }

  async function replaceStoredRecords(storeName, userId, records) {
    const db = await openSyncDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      const objectStore = transaction.objectStore(storeName);
      const request = objectStore.getAllKeys();
      request.onsuccess = () => {
        (request.result || [])
          .filter((key) => String(key).startsWith(`${userId}|`))
          .forEach((key) => objectStore.delete(key));
        (records || []).forEach((record) =>
          objectStore.put({
            ...clone(record),
            user_id: userId,
            local_key: localRecordKey(userId, record),
          })
        );
      };
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }

  async function deleteOutboxRecords(userId, uploadedRecords) {
    if (!uploadedRecords?.length) return;
    const latestOutbox = await getStoredRecords(OUTBOX_STORE, userId);
    const db = await openSyncDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(OUTBOX_STORE, "readwrite");
      const objectStore = transaction.objectStore(OUTBOX_STORE);
      uploadedRecords.forEach((record) => {
        const latest = latestOutbox.get(recordKey(record));
        if (
          latest &&
          latest.updated_at === record.updated_at &&
          latest.client_id === record.client_id
        ) {
          objectStore.delete(localRecordKey(userId, record));
        }
      });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }

  const setBusy = (busy) => {
    signInButton.disabled = busy;
    signUpButton.disabled = busy;
    signOutButton.disabled = busy;
  };

  const setStatus = (message) => {
    statusBox.textContent = message;
    if (currentSession) label.textContent = message;
    frame?.contentWindow?.postMessage(
      { type: "grace-planner-sync-status", message: String(message || "") },
      window.location.origin
    );
  };

  const postStoreToPlanner = (store) => {
    if (!frame?.contentWindow || !store) return;
    const fingerprint = fingerprintValue(store);
    pendingPlannerStore = store;
    pendingPlannerFingerprint = fingerprint;
    frame.contentWindow.postMessage(
      {
        type: "grace-planner-cloud-store",
        store,
        fingerprint,
      },
      window.location.origin
    );
  };

  function applyRecordsToPlanner(records, message = "") {
    const localRaw = localStorage.getItem(STORAGE_KEY) || "";
    let fallback = {};
    try {
      fallback = localRaw ? JSON.parse(localRaw) : {};
    } catch {
      fallback = {};
    }
    const store = recordsToStore(records, fallback);
    const raw = JSON.stringify(store);
    const appliedFp = fingerprintValue(store);
    lastObservedFingerprint = appliedFp;
    appliedFingerprint = appliedFp;
    // The planner is about to display exactly these rows, so they become the
    // baseline that a later snapshot is compared against.
    lastSnapshotKeys = new Set(
      [...records.keys()].filter((key) => !records.get(key)?.deleted_at)
    );
    localStorage.setItem(STORAGE_KEY, raw);
    localStorage.setItem(LOCAL_UPDATED_KEY, String(Date.now()));
    // Records what this device last received from the cloud, so a later
    // reconnect can tell an untouched snapshot from one with new local work.
    localStorage.setItem(LAST_APPLIED_KEY, appliedFp);
    postStoreToPlanner(store);
    if (message) setStatus(message);
  }

  async function mergeIncomingRecords(userId, incomingRecords, message = "") {
    const updates = [];
    const repairs = [];
    let sequence = 0;
    const now = Date.now();
    incomingRecords.forEach((incoming) => {
      const key = recordKey(incoming);
      const merged = contentAwareRecord(currentRecords.get(key), incoming);
      currentRecords.set(key, merged);
      updates.push(merged);
      // The merge kept something the sender did not have, so push it back to
      // let every device converge on the merged content.
      if (!sameRecordContent(merged, incoming)) {
        sequence += 1;
        repairs.push({
          ...clone(merged),
          updated_at: new Date(now + sequence).toISOString(),
          client_id: merged.deleted_at ? deleteIntentClientId : intentClientId,
          local_intent: true,
        });
      }
    });
    if (updates.length) await putStoredRecords(RECORDS_STORE, userId, updates);
    if (repairs.length) {
      setStatus("내용이 있는 항목 우선 병합 · 클라우드 복구 중");
      await queueRecords(repairs);
    }
    applyRecordsToPlanner(currentRecords, message);
  }

  const announceTabRecords = (records) => {
    if (!tabChannel || !initializedUserId || !records?.length) return;
    tabChannel.postMessage({
      type: "grace-planner-tab-records",
      sender: clientId,
      userId: initializedUserId,
      records: records.map((record) => clone(record)),
    });
  };

  async function fetchRemoteRecords(userId) {
    const { data, error } = await client
      .from("planner_records")
      .select(
        "entity_type,entity_id,payload,updated_at,deleted_at,client_id"
      )
      .eq("user_id", userId);
    if (error) throw error;
    const records = new Map();
    (data || []).forEach((record) => records.set(recordKey(record), record));
    return records;
  }

  async function fetchLegacyStore(userId) {
    const { data, error } = await client
      .from("planner_data")
      .select("store,updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return null;
    return data?.store ? data : null;
  }

  const rpcPayload = (records) =>
    records.map((record) => ({
      entity_type: record.entity_type,
      entity_id: record.entity_id,
      payload: record.payload,
      updated_at: record.updated_at,
      deleted_at: record.deleted_at,
      client_id: record.client_id,
    }));

  async function uploadOutbox() {
    if (
      uploadRunning ||
      !currentSession?.user ||
      navigator.onLine === false
    ) {
      return false;
    }
    const userId = currentSession.user.id;
    const outbox = await getStoredRecords(OUTBOX_STORE, userId);
    const records = [...outbox.values()];
    if (!records.length) {
      setStatus("클라우드 저장됨");
      return true;
    }

    uploadRunning = true;
    setStatus(`${records.length}개 변경사항 저장 중…`);
    let result;
    try {
      result = await client.rpc("upsert_planner_records", {
        p_records: rpcPayload(records),
      });
    } catch (error) {
      result = { error };
    }
    uploadRunning = false;
    if (result.error) {
      setStatus(
        navigator.onLine === false
          ? "오프라인 · 이 기기에 안전하게 저장됨"
          : "동기화 대기 중"
      );
      scheduleReconnect();
      return false;
    }

    await deleteOutboxRecords(userId, records);
    localStorage.removeItem(LEGACY_PENDING_KEY);
    const remaining = await getStoredRecords(OUTBOX_STORE, userId);
    if (remaining.size) {
      setStatus("변경사항 저장 대기 중");
      scheduleUpload(80);
    } else {
      setStatus("클라우드 저장됨");
    }
    return true;
  }

  const scheduleUpload = (delay = 350) => {
    if (uploadTimer) window.clearTimeout(uploadTimer);
    uploadTimer = window.setTimeout(() => {
      uploadTimer = null;
      uploadOutbox();
    }, delay);
  };

  async function queueRecords(records) {
    if (!currentSession?.user || !records.length) return;
    const userId = currentSession.user.id;
    records.forEach((record) =>
      currentRecords.set(recordKey(record), record)
    );
    await Promise.all([
      putStoredRecords(RECORDS_STORE, userId, records),
      putStoredRecords(OUTBOX_STORE, userId, records),
    ]);
    // Other tabs in this browser see changes immediately, without waiting for
    // the cloud round trip.
    announceTabRecords(records);
    setStatus(
      navigator.onLine === false
        ? "오프라인 · 이 기기에 안전하게 저장됨"
        : "변경사항 저장 대기 중"
    );
    scheduleUpload();
  }

  // Container rows (a day, week, prayer group) that hold the child rows below.
  const PARENT_TYPE_OF = {
    day_todo: "day",
    day_gratitude: "day",
    day_block_plan: "day",
    day_block_actual: "day",
    day_focus_session: "day",
    week_task: "week",
    week_project: "week",
    prayer_item: "prayer_group",
  };

  // Rule: an item is deleted only when the snapshot proves it. "Missing from
  // the snapshot" alone is not proof — a stale, partial, or other-tab snapshot
  // looks exactly the same and would wipe good data on every device.
  function canDeleteFromSnapshot(existing, key, desired, additiveOnly, seenKeys) {
    if (additiveOnly) return false;
    // These two always exist in a valid snapshot, so they are never removable.
    if (existing.entity_type === "root" || existing.entity_type === "scratch") {
      return false;
    }
    // Deletion must be an observed transition: the planner showed this row
    // before and no longer does. A row this tab never displayed (one that just
    // arrived from another tab or device) is not ours to remove.
    if (!seenKeys || !seenKeys.has(key)) return false;
    const parentType = PARENT_TYPE_OF[existing.entity_type];
    if (!parentType) return true;
    const parentId = existing.payload?.parent_id;
    if (!parentId) return false;
    // A child goes only when its container is still in the snapshot, proving
    // the snapshot covers that day/week/group and simply no longer lists it.
    return desired.has(`${parentType}::${parentId}`);
  }

  async function captureLocalChanges(raw, additiveOnly = false) {
    if (!initializedUserId || !raw) return;
    let store;
    try {
      store = JSON.parse(raw);
    } catch {
      return;
    }
    if (!store || typeof store !== "object" || !store.days) return;
    const desired = storeToRecords(store);
    const changed = [];
    const now = Date.now();
    let sequence = 0;

    desired.forEach((candidate, key) => {
      const existing = currentRecords.get(key);
      const unchanged =
        existing &&
        !existing.deleted_at &&
        fingerprintValue(existing.payload) === fingerprintValue(candidate.payload);
      if (unchanged) return;
      // An uncertain snapshot must not bring a deleted item back to life.
      if (additiveOnly && existing?.deleted_at) return;
      sequence += 1;
      const localCandidate = {
        ...candidate,
        updated_at: new Date(now + sequence).toISOString(),
        client_id: intentClientId,
        deleted_at: null,
        local_intent: true,
      };
      const existingActive =
        existing && !existing.deleted_at && existing.payload != null;
      const mergedCandidate = additiveOnly
        ? {
            ...localCandidate,
            // Union merge: keeps this snapshot's new content while retaining
            // list entries only the cloud copy has.
            payload: existingActive
              ? mergeContentValues(existing.payload, localCandidate.payload, false)
              : localCandidate.payload,
          }
        : contentAwareRecord(existing, localCandidate);
      if (!sameRecordContent(existing, mergedCandidate)) {
        changed.push(mergedCandidate);
      }
    });

    currentRecords.forEach((existing, key) => {
      if (existing.deleted_at || desired.has(key)) return;
      if (
        !canDeleteFromSnapshot(existing, key, desired, additiveOnly, lastSnapshotKeys)
      ) {
        return;
      }
      sequence += 1;
      changed.push({
        ...existing,
        payload: existing.payload
          ? {
              parent_id: existing.payload.parent_id,
              item: { id: existing.payload.item?.id },
            }
          : existing.payload,
        updated_at: new Date(now + sequence).toISOString(),
        deleted_at: new Date(now + sequence).toISOString(),
        client_id: deleteIntentClientId,
        local_intent: true,
      });
    });

    // Remember what the planner was showing, so the next snapshot can be read
    // as a transition rather than an absolute statement of what should exist.
    lastSnapshotKeys = new Set(desired.keys());

    if (changed.length) await queueRecords(changed);
  }

  const queueLocalCapture = (raw, additiveOnly = false) => {
    if (!raw) return localCaptureChain;
    if (!initializedUserId) {
      lastObservedFingerprint = fingerprintRaw(raw);
      pendingLocalRaw = raw;
      return localCaptureChain;
    }
    // A snapshot held at the gate below is not yet accepted as "what we have
    // seen", so lastObservedFingerprint is only updated once we take it.
    if (pendingPlannerStore || captureGateUntilApply) {
      // We just pushed a cloud store to the iframe and are still waiting for
      // its "applied" confirmation. Snapshots arriving now may be pre-push
      // echoes, so hold the newest one instead of trusting it. It is never
      // discarded: the ack handler or the timeout below will process it,
      // because losing a real edit here is what makes fresh work vanish.
      deferredAckRaw = raw;
      if (!ackGateTimer) {
        ackGateTimer = window.setTimeout(() => {
          ackGateTimer = null;
          // The iframe never confirmed (it reloaded, or the message was lost).
          // Reopen the gate so edits keep flowing instead of piling up unsent.
          pendingPlannerStore = null;
          pendingPlannerFingerprint = "";
          captureGateUntilApply = false;
          releaseDeferredAck();
        }, 1500);
      }
      return localCaptureChain;
    }
    lastObservedFingerprint = fingerprintRaw(raw);
    // While typing, keep only the newest complete snapshot instead of
    // processing every intermediate keystroke serially.
    latestQueuedLocalRaw = raw;
    latestQueuedAdditiveOnly = latestQueuedAdditiveOnly || additiveOnly;
    if (localCaptureRunning) return localCaptureChain;
    localCaptureRunning = true;
    localCaptureChain = (async () => {
      while (latestQueuedLocalRaw) {
        const newestRaw = latestQueuedLocalRaw;
        const newestAdditive = latestQueuedAdditiveOnly;
        latestQueuedLocalRaw = "";
        latestQueuedAdditiveOnly = false;
        try {
          await captureLocalChanges(newestRaw, newestAdditive);
        } catch {
          // IndexedDB/network retries are handled by the outbox and reconnect.
        }
      }
    })().finally(() => {
      localCaptureRunning = false;
    });
    return localCaptureChain;
  };

  // Process whatever the iframe posted while the cloud store was in flight.
  // It is captured additively: it may contain genuinely new work, but it must
  // not be able to remove anything the cloud already holds.
  function releaseDeferredAck() {
    if (ackGateTimer) {
      window.clearTimeout(ackGateTimer);
      ackGateTimer = null;
    }
    const raw = deferredAckRaw;
    deferredAckRaw = "";
    if (!raw) return;
    // Identical to the store we pushed, so it was only an echo of it.
    if (fingerprintRaw(raw) === appliedFingerprint) return;
    queueLocalCapture(raw, true);
  }

  const deferRemoteRecord = (record, message = "") => {
    const key = recordKey(record);
    deferredRemoteRecords.set(
      key,
      contentAwareRecord(deferredRemoteRecords.get(key), record)
    );
    if (message) deferredRemoteMessage = message;
  };

  async function flushDeferredRemote(raw = "") {
    if (raw) await queueLocalCapture(raw);
    else await localCaptureChain.catch(() => undefined);

    if (deferredRemoteRecords.size && initializedUserId) {
      const records = [...deferredRemoteRecords.values()];
      deferredRemoteRecords = new Map();
      const message =
        deferredRemoteMessage || "다른 기기의 변경사항을 받았습니다";
      deferredRemoteMessage = "";
      await mergeIncomingRecords(initializedUserId, records, message);
    }

    if (reconnectAfterEditing && currentSession?.user) {
      reconnectAfterEditing = false;
      await connectSync();
    }
  }

  tabChannel?.addEventListener("message", async (event) => {
    const message = event.data;
    if (
      message?.type !== "grace-planner-tab-records" ||
      message.sender === clientId ||
      !initializedUserId ||
      message.userId !== initializedUserId ||
      !Array.isArray(message.records) ||
      !message.records.length
    ) {
      return;
    }
    await localCaptureChain.catch(() => undefined);
    if (plannerEditing) {
      message.records.forEach((record) =>
        deferRemoteRecord(record, "다른 창의 변경사항을 입력 완료 후 병합합니다")
      );
      setStatus("입력 완료 후 다른 창 변경사항 병합");
      return;
    }
    await mergeIncomingRecords(
      initializedUserId,
      message.records,
      "다른 창의 변경사항을 병합했습니다"
    );
  });

  function readLegacyPending() {
    try {
      const pending = JSON.parse(
        localStorage.getItem(LEGACY_PENDING_KEY) || "null"
      );
      return pending?.raw ? pending : null;
    } catch {
      return null;
    }
  }

  async function migrateIfNeeded(userId, remoteRecords) {
    if (remoteRecords.size) return remoteRecords;
    const localRaw = localStorage.getItem(STORAGE_KEY) || "";
    let localStore = null;
    try {
      localStore = localRaw ? JSON.parse(localRaw) : null;
    } catch {
      localStore = null;
    }
    const legacy = await fetchLegacyStore(userId);
    const localUpdatedAt =
      Number(localStorage.getItem(LOCAL_UPDATED_KEY)) || Date.now();
    const localRecords = localStore
      ? storeToRecords(
          localStore,
          new Date(localUpdatedAt).toISOString(),
          clientId
        )
      : new Map();
    const legacyRecords = legacy?.store
      ? storeToRecords(
          legacy.store,
          legacy.updated_at || new Date(0).toISOString(),
          "legacy-cloud"
        )
      : new Map();
    const merged = mergeRecordMaps(legacyRecords, localRecords);
    // Stamp the migration as intentional so the reconnect logic treats it as
    // trusted local work to upload rather than a stale snapshot to discard.
    const migrated = new Map();
    let sequence = 0;
    const now = Date.now();
    merged.forEach((record, key) => {
      sequence += 1;
      migrated.set(key, {
        ...clone(record),
        updated_at: new Date(now + sequence).toISOString(),
        client_id: intentClientId,
        local_intent: true,
      });
    });
    if (migrated.size) {
      await Promise.all([
        putStoredRecords(RECORDS_STORE, userId, [...migrated.values()]),
        putStoredRecords(OUTBOX_STORE, userId, [...migrated.values()]),
      ]);
    }
    return migrated;
  }

  async function subscribeRealtime(userId, generation) {
    channel = client
      .channel(`planner-records-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "planner_records",
          filter: `user_id=eq.${userId}`,
        },
        async (payload) => {
          if (generation !== syncGeneration || !payload.new?.entity_type)
            return;
          const incoming = {
            entity_type: payload.new.entity_type,
            entity_id: payload.new.entity_id,
            payload: payload.new.payload,
            updated_at: payload.new.updated_at,
            deleted_at: payload.new.deleted_at,
            client_id: payload.new.client_id,
          };
          if (isOwnRecord(incoming)) return;
          await localCaptureChain.catch(() => undefined);
          if (plannerEditing) {
            deferRemoteRecord(incoming, "다른 기기의 변경사항을 받았습니다");
            setStatus("입력 완료 후 다른 기기 변경사항 병합");
            return;
          }
          await mergeIncomingRecords(
            userId,
            [incoming],
            "다른 기기의 변경사항을 받았습니다"
          );
        }
      )
      .subscribe((state) => {
        if (generation !== syncGeneration) return;
        if (state === "SUBSCRIBED") {
          setStatus("클라우드 저장됨");
        } else if (
          ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(state)
        ) {
          setStatus(
            navigator.onLine === false
              ? "오프라인 · 이 기기에 안전하게 저장됨"
              : "연결 재시도 중…"
          );
          scheduleReconnect();
        }
      });
  }

  async function disconnectRealtime() {
    if (!channel) return;
    await client.removeChannel(channel);
    channel = null;
  }

  const scheduleReconnect = () => {
    if (reconnectTimer || !currentSession?.user) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      if (!currentSession?.user) return;
      if (plannerEditing) {
        reconnectAfterEditing = true;
        return;
      }
      connectSync();
    }, 4000);
  };

  async function connectSync() {
    if (plannerEditing) {
      reconnectAfterEditing = true;
      setStatus("입력 완료 후 클라우드 연결 재개");
      return;
    }
    await localCaptureChain.catch(() => undefined);
    const reconnectingUserId = currentSession?.user?.id || "";
    const reconnectingSameUser = Boolean(
      reconnectingUserId && initializedUserId === reconnectingUserId
    );
    // Snapshot before clearing sync state. While remote fetch runs, the iframe
    // may keep posting the same (possibly stale) store into pendingLocalRaw;
    // only re-apply it if the fingerprint actually changed during the fetch.
    const connectStartFingerprint =
      lastObservedFingerprint ||
      fingerprintRaw(localStorage.getItem(STORAGE_KEY) || "");
    const generation = ++syncGeneration;
    initializedUserId = "";
    if (reconnectTimer) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    await disconnectRealtime();
    if (generation !== syncGeneration || !currentSession?.user) return;

    const userId = currentSession.user.id;
    setStatus("클라우드 확인 중…");
    let cached = new Map();
    let outbox = new Map();
    try {
      [cached, outbox] = await Promise.all([
        getStoredRecords(RECORDS_STORE, userId),
        getStoredRecords(OUTBOX_STORE, userId),
      ]);
    } catch {
      setStatus("이 기기의 저장소를 확인할 수 없습니다");
      return;
    }

    let remote = new Map();
    let remoteFetched = false;
    if (navigator.onLine !== false) {
      try {
        remote = await fetchRemoteRecords(userId);
        const migrated = await migrateIfNeeded(userId, remote);
        if (migrated !== remote) {
          remote = migrated;
          // Migration adds its own outbox entries; re-read so they are not
          // dropped when the outbox is rewritten below.
          outbox = await getStoredRecords(OUTBOX_STORE, userId);
        }
        remoteFetched = true;
      } catch (error) {
        if (!cached.size && !outbox.size) {
          setStatus("새 동기화 구조 설정이 필요합니다");
          errorBox.textContent =
            "Supabase에 항목별 동기화 테이블을 먼저 설정해주세요.";
          return;
        }
      }
    }
    if (generation !== syncGeneration) return;

    const localRaw = localStorage.getItem(STORAGE_KEY) || "";
    let localStore = null;
    try {
      localStore = localRaw ? JSON.parse(localRaw) : null;
    } catch {
      localStore = null;
    }
    const localUpdatedAt =
      Number(localStorage.getItem(LOCAL_UPDATED_KEY)) || Date.now();
    const localRecords = localStore
      ? storeToRecords(localStore, new Date(localUpdatedAt).toISOString(), clientId)
      : new Map();
    const legacyPending = readLegacyPending();
    let pendingRecords = new Map();
    if (legacyPending?.raw) {
      try {
        pendingRecords = storeToRecords(
          JSON.parse(legacyPending.raw),
          new Date(Number(legacyPending.updatedAt) || Date.now()).toISOString(),
          clientId
        );
      } catch {
        pendingRecords = new Map();
      }
    }

    const initialState = resolveInitialRecordState({
      remote,
      cached,
      outbox,
      localRecords,
      pendingRecords,
      remoteFetched,
      localStore,
      lastAppliedFingerprint: localStorage.getItem(LAST_APPLIED_KEY) || "",
    });
    currentRecords = initialState.records;
    if (remoteFetched || initialState.reason === "offline-recovery") {
      await replaceStoredRecords(OUTBOX_STORE, userId, [
        ...initialState.outbox.values(),
      ]);
    }
    await replaceStoredRecords(RECORDS_STORE, userId, [
      ...currentRecords.values(),
    ]);

    // Hold the capture path closed until the resolved store reaches the
    // planner. Otherwise the snapshot the iframe still shows (a default store
    // on first boot, or pre-merge content on reconnect) could look like an edit.
    captureGateUntilApply = true;
    initializedUserId = userId;
    // On first boot, discard the iframe's default snapshot. On reconnect, keep
    // edits that truly arrived while the remote fetch was in flight. They are
    // merged additively because they predate the cloud state just fetched.
    const reconnectRaw = reconnectingSameUser ? pendingLocalRaw : "";
    pendingLocalRaw = "";
    if (
      reconnectRaw &&
      fingerprintRaw(reconnectRaw) !== connectStartFingerprint
    ) {
      await captureLocalChanges(reconnectRaw, true).catch(() => undefined);
    }
    captureGateUntilApply = false;
    applyRecordsToPlanner(currentRecords);
    if (navigator.onLine === false) {
      setStatus("오프라인 · 이 기기에 안전하게 저장됨");
    } else {
      await uploadOutbox();
      if (generation !== syncGeneration) return;
      await subscribeRealtime(userId, generation);
    }
  }

  async function applySession(session) {
    const previousUserId = currentSession?.user?.id || "";
    const sameInitializedUser = Boolean(
      session?.user &&
        initializedUserId === session.user.id &&
        previousUserId === session.user.id
    );
    currentSession = session;
    const loggedIn = Boolean(session?.user);
    dot.classList.toggle("on", loggedIn);
    signedOut.hidden = loggedIn;
    signedIn.hidden = !loggedIn;
    accountEmail.textContent = session?.user?.email || "";
    if (!loggedIn) label.textContent = "클라우드 로그인";
    else if (!sameInitializedUser) label.textContent = "클라우드 확인 중…";
    if (!loggedIn) {
      initializedUserId = "";
      currentRecords = new Map();
      deferredRemoteRecords = new Map();
      deferredRemoteMessage = "";
      reconnectAfterEditing = false;
      pendingLocalRaw = "";
      deferredAckRaw = "";
      pendingPlannerStore = null;
      pendingPlannerFingerprint = "";
      captureGateUntilApply = false;
      lastSnapshotKeys = null;
      if (ackGateTimer) window.clearTimeout(ackGateTimer);
      ackGateTimer = null;
      await disconnectRealtime();
      return;
    }
    if (sameInitializedUser) return;
    await connectSync();
  }

  async function authenticate(mode) {
    errorBox.textContent = "";
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || password.length < 6) {
      errorBox.textContent =
        "이메일과 6자 이상의 비밀번호를 입력해주세요.";
      return;
    }
    setBusy(true);
    const result =
      mode === "signup"
        ? await client.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: window.location.href },
          })
        : await client.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (result.error) {
      errorBox.textContent = result.error.message;
      return;
    }
    if (mode === "signup" && !result.data.session) {
      errorBox.textContent =
        "인증 이메일을 보냈습니다. 인증 링크를 누른 뒤 로그인해주세요.";
      return;
    }
    closeDialog();
  }

  const openDialog = () => {
    errorBox.textContent = "";
    backdrop.hidden = false;
    window.setTimeout(
      () => (currentSession ? closeButton : emailInput).focus(),
      0
    );
  };
  const closeDialog = () => {
    backdrop.hidden = true;
  };

  launcher.addEventListener("click", openDialog);
  closeButton.addEventListener("click", closeDialog);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) closeDialog();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !backdrop.hidden) closeDialog();
  });
  signInButton.addEventListener("click", () => authenticate("signin"));
  signUpButton.addEventListener("click", () => authenticate("signup"));
  signOutButton.addEventListener("click", async () => {
    setBusy(true);
    await client.auth.signOut();
    setBusy(false);
    closeDialog();
  });

  window.addEventListener("message", async (event) => {
    if (
      event.origin !== window.location.origin ||
      event.source !== frame?.contentWindow
    ) {
      return;
    }
    if (event.data?.type === "grace-planner-ready") {
      if (pendingPlannerStore) postStoreToPlanner(pendingPlannerStore);
      return;
    }
    if (
      event.data?.type === "grace-planner-local-store" &&
      typeof event.data.raw === "string"
    ) {
      queueLocalCapture(event.data.raw);
      return;
    }
    if (event.data?.type === "grace-planner-editing") {
      plannerEditing = Boolean(event.data.editing);
      if (plannerEditing) return;
      await flushDeferredRemote(
        typeof event.data.raw === "string" ? event.data.raw : ""
      );
      return;
    }
    if (
      event.data?.type === "grace-planner-cloud-store-applied" &&
      event.data.fingerprint === pendingPlannerFingerprint
    ) {
      pendingPlannerStore = null;
      pendingPlannerFingerprint = "";
      releaseDeferredAck();
    }
  });

  frame?.addEventListener("load", () => {
    if (pendingPlannerStore) postStoreToPlanner(pendingPlannerStore);
  });

  // Safety net for snapshots that never arrived as a message. localStorage is
  // shared by every tab, so what it holds may belong to another tab or be
  // stale; such a snapshot may only add, never delete.
  window.setInterval(() => {
    if (!initializedUserId) return;
    const raw = localStorage.getItem(STORAGE_KEY) || "";
    const fingerprint = fingerprintRaw(raw);
    if (!raw || fingerprint === lastObservedFingerprint) return;
    queueLocalCapture(raw, true);
  }, 500);

  // A refresh or a phone switching apps must not strand the newest edit.
  const flushLocalBeforeUnload = () => {
    if (!initializedUserId) return;
    const raw = localStorage.getItem(STORAGE_KEY) || "";
    if (!raw || fingerprintRaw(raw) === lastObservedFingerprint) return;
    queueLocalCapture(raw, true);
    if (currentSession?.user && navigator.onLine !== false) scheduleUpload(0);
  };
  window.addEventListener("pagehide", flushLocalBeforeUnload);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushLocalBeforeUnload();
  });

  window.addEventListener("offline", () => {
    setStatus("오프라인 · 이 기기에 안전하게 저장됨");
  });
  window.addEventListener("online", () => {
    setStatus("연결됨 · 변경사항 병합 중…");
    if (plannerEditing) {
      reconnectAfterEditing = true;
      setStatus("입력 완료 후 변경사항 병합");
      return;
    }
    connectSync();
  });

  if (new URLSearchParams(window.location.search).has("sync-test")) {
    window.__plannerSyncDiagnostics = Object.freeze({
      // How a device resolves what it holds when it reconnects.
      simulate({
        remoteStore = null,
        cachedStore = null,
        outboxStore = null,
        outboxIntent = false,
        localStore = null,
        remoteFetched = true,
        lastAppliedFingerprint = "",
        remoteTombstoneKeys = [],
      } = {}) {
        const recordsFor = (store, time, source) =>
          store ? storeToRecords(store, new Date(time).toISOString(), source) : new Map();
        const remote = recordsFor(remoteStore, 1000, "cloud-device");
        remoteTombstoneKeys.forEach((key) => {
          const record = remote.get(key);
          if (!record) return;
          remote.set(key, {
            ...record,
            payload: null,
            deleted_at: new Date(6000).toISOString(),
            client_id: "cloud-device",
          });
        });
        const cached = recordsFor(cachedStore, 2000, "cached-device");
        const outbox = outboxIntent
          ? intentRecordsFromStore(outboxStore, 4000)
          : recordsFor(outboxStore, 4000, "legacy-phone");
        const resolved = resolveInitialRecordState({
          remote,
          cached,
          outbox,
          localRecords: recordsFor(localStore, 3000, "legacy-local"),
          pendingRecords: new Map(),
          remoteFetched,
          localStore,
          lastAppliedFingerprint,
        });
        const store = recordsToStore(resolved.records, {});
        return {
          reason: resolved.reason,
          contentScore: recordsContentScore(resolved.records),
          outboxCount: resolved.outbox.size,
          todoTexts: Object.values(store.days || {})
            .flatMap((day) => day.todos || [])
            .map((todo) => String(todo?.text || ""))
            .sort(),
        };
      },
      fingerprintStore(store) {
        return fingerprintValue(store);
      },
      // Which rows a given snapshot would remove, given what this device holds.
      deletionPlan({
        currentStore,
        snapshotStore,
        additiveOnly = false,
        seenStore = null,
      }) {
        const current = storeToRecords(
          currentStore,
          new Date(1000).toISOString(),
          "cloud-device"
        );
        const desired = storeToRecords(
          snapshotStore,
          new Date(2000).toISOString(),
          "snapshot"
        );
        const seenKeys = new Set(
          seenStore
            ? storeToRecords(seenStore, new Date(900).toISOString(), "seen").keys()
            : current.keys()
        );
        const removed = [];
        current.forEach((existing, key) => {
          if (existing.deleted_at || desired.has(key)) return;
          if (canDeleteFromSnapshot(existing, key, desired, additiveOnly, seenKeys)) {
            removed.push(key);
          }
        });
        return removed.sort();
      },
      mergeStores(olderStore, newerStore) {
        const older = storeToRecords(
          olderStore,
          new Date(1000).toISOString(),
          "cloud-device"
        );
        const newer = intentRecordsFromStore(newerStore, 5000);
        return recordsToStore(mergeRecordMaps(older, newer), {});
      },
    });
  }

  client.auth.getSession().then(({ data }) => applySession(data.session));
  client.auth.onAuthStateChange((_event, session) => {
    applySession(session);
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => undefined);
  }
})();
