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
  let lastStore = "";
  let channel = null;
  let saveTimer = null;

  const setBusy = (busy) => {
    signInButton.disabled = busy;
    signUpButton.disabled = busy;
    signOutButton.disabled = busy;
  };

  const setStatus = (message) => {
    statusBox.textContent = message;
    if (currentSession) label.textContent = message;
  };

  const reloadPlanner = () => {
    if (frame?.contentWindow) frame.contentWindow.location.reload();
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

    setStatus("클라우드 저장 중…");
    const { error } = await client.from("planner_data").upsert(
      {
        user_id: currentSession.user.id,
        store,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    setStatus(error ? "동기화 실패" : "클라우드 저장됨");
  }

  async function disconnectRealtime() {
    if (channel) {
      await client.removeChannel(channel);
      channel = null;
    }
  }

  async function connectSync() {
    ready = false;
    await disconnectRealtime();

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

    if (error) {
      setStatus("동기화 실패");
      return;
    }

    const localRaw = localStorage.getItem(STORAGE_KEY) || "";
    if (data?.store) {
      const remoteRaw = JSON.stringify(data.store);
      if (remoteRaw !== localRaw) {
        localStorage.setItem(STORAGE_KEY, remoteRaw);
        lastStore = remoteRaw;
        reloadPlanner();
      }
    } else if (localRaw) {
      lastStore = localRaw;
      await upload(localRaw);
    }

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
          const remoteRaw = JSON.stringify(payload.new.store);
          if (remoteRaw === lastStore) return;
          localStorage.setItem(STORAGE_KEY, remoteRaw);
          lastStore = remoteRaw;
          setStatus("다른 기기의 변경사항을 받았습니다");
          reloadPlanner();
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

  window.setInterval(() => {
    if (!ready || !currentSession?.user) return;
    const raw = localStorage.getItem(STORAGE_KEY) || "";
    if (!raw || raw === lastStore) return;
    lastStore = raw;
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
