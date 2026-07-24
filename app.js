(() => {
  "use strict";

  const STORAGE_KEY = "hamin-planner-v5";
  const SUPABASE_URL = "https://wajhlnpyxcnhoybwtdqe.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_Kp3KAxlyT1eXot9vHE1wlQ_h4C0BVeJ";

  const supabaseFactory = window.supabase;
  const client = supabaseFactory.createClient(
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

  let currentSession = null;
  let ready = false;
  let lastFingerprint = "";
  let channel = null;
  let saveTimer = null;
  let syncGeneration = 0;
  let pendingRemoteStore = null;
  let pendingRemoteFingerprint = "";
  const recentOwnUploads = new Map();

  const canonicalize = (value) => {
    if (Array.isArray(value)) {
      return value.map(canonicalize);
    }
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

  const setBusy = (busy) => {
    signInButton.disabled = busy;
    signUpButton.disabled = busy;
    signOutButton.disabled = busy;
  };

  const setStatus = (message) => {
    statusBox.textContent = message;
    if (currentSession) label.textContent = message;
  };

  const rememberOwnUpload = (fingerprint) => {
    const now = Date.now();
    recentOwnUploads.set(fingerprint, now);
    for (const [key, savedAt] of recentOwnUploads) {
      if (now - savedAt > 30000 || recentOwnUploads.size > 40) {
        recentOwnUploads.delete(key);
      }
    }
  };

  const consumeOwnUpload = (fingerprint) => {
    if (!recentOwnUploads.has(fingerprint)) return false;
    recentOwnUploads.delete(fingerprint);
    return true;
  };

  const postStoreToPlanner = (store) => {
    if (!frame?.contentWindow || !store) return;
    frame.contentWindow.postMessage(
      {
        type: "grace-planner-cloud-store",
        store,
        fingerprint: fingerprintValue(store),
      },
      window.location.origin
    );
  };

  const applyRemoteStore = (store, message = "") => {
    const remoteRaw = JSON.stringify(store);
    localStorage.setItem(STORAGE_KEY, remoteRaw);
    lastFingerprint = fingerprintValue(store);
    pendingRemoteStore = store;
    pendingRemoteFingerprint = lastFingerprint;
    postStoreToPlanner(store);
    if (message) setStatus(message);
  };

  const openDialog = () => {
    errorBox.textContent = "";
    backdrop.hidden = false;
    window.setTimeout(() => {
      (currentSession ? closeButton : emailInput).focus();
    }, 0);
  };

  const closeDialog = () => {
    backdrop.hidden = true;
  };

  async function upload(raw) {
    if (!currentSession?.user || !raw) return;
    let store;
    try {
      store = JSON.parse(raw);
    } catch {
      return;
    }

    const uploadFingerprint = fingerprintValue(store);
    rememberOwnUpload(uploadFingerprint);
    setStatus("클라우드 저장 중…");
    const { error } = await client.from("planner_data").upsert(
      {
        user_id: currentSession.user.id,
        store,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    if (error) recentOwnUploads.delete(uploadFingerprint);
    setStatus(error ? "동기화 실패" : "클라우드 저장됨");
  }

  async function disconnectRealtime() {
    if (channel) {
      await client.removeChannel(channel);
      channel = null;
    }
  }

  async function connectSync() {
    const generation = ++syncGeneration;
    ready = false;
    await disconnectRealtime();
    if (generation !== syncGeneration) return;

    if (!currentSession?.user) {
      setStatus("로그인하면 기기 간 동기화됩니다");
      return;
    }

    setStatus("클라우드 확인 중…");
    const { data, error } = await client
      .from("planner_data")
      .select("store, updated_at")
      .eq("user_id", currentSession.user.id)
      .maybeSingle();
    if (generation !== syncGeneration) return;

    if (error) {
      setStatus("동기화 실패");
      return;
    }

    const localRaw = localStorage.getItem(STORAGE_KEY) || "";
    const localFingerprint = fingerprintRaw(localRaw);
    if (data?.store) {
      const remoteFingerprint = fingerprintValue(data.store);
      if (remoteFingerprint !== localFingerprint) {
        applyRemoteStore(data.store);
      } else {
        lastFingerprint = localFingerprint;
      }
    } else if (localRaw) {
      lastFingerprint = localFingerprint;
      await upload(localRaw);
      if (generation !== syncGeneration) return;
    } else {
      lastFingerprint = "";
    }

    if (generation !== syncGeneration) return;
    channel = client
      .channel(`planner-${currentSession.user.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "planner_data",
          filter: `user_id=eq.${currentSession.user.id}`,
        },
        (payload) => {
          if (!payload.new?.store) return;
          const remoteFingerprint = fingerprintValue(payload.new.store);
          if (consumeOwnUpload(remoteFingerprint)) {
            if (
              remoteFingerprint ===
              fingerprintRaw(localStorage.getItem(STORAGE_KEY) || "")
            ) {
              lastFingerprint = remoteFingerprint;
            }
            return;
          }
          if (remoteFingerprint === lastFingerprint) return;

          const localRaw = localStorage.getItem(STORAGE_KEY) || "";
          if (remoteFingerprint === fingerprintRaw(localRaw)) {
            lastFingerprint = remoteFingerprint;
            return;
          }

          applyRemoteStore(
            payload.new.store,
            "다른 기기의 변경사항을 받았습니다"
          );
        }
      )
      .subscribe((state) => {
        if (state === "SUBSCRIBED") {
          ready = true;
          setStatus("클라우드 저장됨");
        }
      });
  }

  async function applySession(session) {
    currentSession = session;
    const loggedIn = Boolean(session?.user);

    dot.classList.toggle("on", loggedIn);
    signedOut.hidden = loggedIn;
    signedIn.hidden = !loggedIn;
    accountEmail.textContent = session?.user?.email || "";
    label.textContent = loggedIn
      ? "클라우드 확인 중…"
      : "클라우드 로그인";

    await connectSync();
  }

  async function authenticate(mode) {
    errorBox.textContent = "";
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || password.length < 6) {
      errorBox.textContent = "이메일과 6자 이상의 비밀번호를 입력해주세요.";
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

  window.addEventListener("message", (event) => {
    if (
      event.origin !== window.location.origin ||
      event.source !== frame?.contentWindow
    ) {
      return;
    }
    if (event.data?.type === "grace-planner-ready") {
      if (pendingRemoteStore) postStoreToPlanner(pendingRemoteStore);
      return;
    }
    if (
      event.data?.type === "grace-planner-cloud-store-applied" &&
      event.data.fingerprint === pendingRemoteFingerprint
    ) {
      pendingRemoteStore = null;
      pendingRemoteFingerprint = "";
    }
  });

  frame?.addEventListener("load", () => {
    if (pendingRemoteStore) postStoreToPlanner(pendingRemoteStore);
  });

  window.setInterval(() => {
    if (!ready || !currentSession?.user) return;
    const raw = localStorage.getItem(STORAGE_KEY) || "";
    const currentFingerprint = fingerprintRaw(raw);
    if (!raw || currentFingerprint === lastFingerprint) return;
    lastFingerprint = currentFingerprint;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => upload(raw), 700);
  }, 1000);

  client.auth.getSession().then(({ data }) => applySession(data.session));
  client.auth.onAuthStateChange((_event, session) => {
    applySession(session);
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => undefined);
  }
})();
