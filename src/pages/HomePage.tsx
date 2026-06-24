import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { User } from "@supabase/supabase-js";
import { useNavigate } from "react-router-dom";
import {
  createImageKey,
  loadHomeSettings,
  loadImageDataUrl,
  removeImageData,
  saveHomeSettings,
  saveImageDataUrl,
  type AppIconConfig,
} from "../storage/homeLayout";
import { createTodayCheckin, fetchRecentCheckins } from "../storage/supabaseSync";
import "./HomePage.css";

const WEEK_DAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"] as const;

const buildCurrentWeekDates = (today: Date): string[] => {
  const ref = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dayOfWeek = (ref.getDay() + 6) % 7;
  ref.setDate(ref.getDate() - dayOfWeek);
  const dates: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const cell = new Date(ref);
    cell.setDate(ref.getDate() + i);
    const yyyy = cell.getFullYear();
    const mm = String(cell.getMonth() + 1).padStart(2, "0");
    const dd = String(cell.getDate()).padStart(2, "0");
    dates.push(`${yyyy}-${mm}-${dd}`);
  }
  return dates;
};

type HomePageProps = {
  user: User | null;
  onOpenChat: () => void;
  mode?: "default" | "settings";
};

type AppIconState = Record<string, AppIconConfig>;

const DEFAULT_ICON_ORDER = [
  "chat", "checkin", "memory", "snacks", "syzygy", "usage", "health", "settings", "export",
];

const HomeCoupleCard = () => {
  const myAvatar = useState(() => localStorage.getItem('my-homepage-avatar'))[0]
  const claudeAvatar = useState(() => localStorage.getItem('syzygy-homepage-avatar'))[0]
  return (
    <section className="home-couple glass-card">
      <div className="home-couple__side">
        {myAvatar
          ? <img src={myAvatar} alt="我" className="home-couple__avatar" />
          : <div className="home-couple__avatar home-couple__avatar--empty">🐱</div>}
      </div>
      <div className="home-couple__center">
        <svg viewBox="0 0 90 28" className="home-couple__ecg" aria-hidden="true">
          <polyline points="0,14 18,14 22,3 27,25 31,7 35,14 44,14"
            stroke="#C5D6EC" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points="46,14 55,14 59,3 64,25 68,7 72,14 90,14"
            stroke="#C5D6EC" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="home-couple__heart" aria-hidden="true">🩷</span>
      </div>
      <div className="home-couple__side">
        {claudeAvatar
          ? <img src={claudeAvatar} alt="Claude" className="home-couple__avatar" />
          : <div className="home-couple__avatar home-couple__avatar--empty">🤍</div>}
      </div>
    </section>
  )
}

const readFileAsDataUrl = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : null;
      if (!result) { reject(new Error("读取图片失败")); return; }
      resolve(result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });

const HomePage = ({ user, onOpenChat, mode = "default" }: HomePageProps) => {
  const isSettingsPage = mode === "settings";
  const navigate = useNavigate();
  const [now, setNow] = useState(() => new Date());
  const [editMode, setEditMode] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [prefsReady, setPrefsReady] = useState(false);

  const [togetherSince, setTogetherSince] = useState<string | null>(null);
  const [checkedDates, setCheckedDates] = useState<Set<string>>(new Set());
  const [checkinBusy, setCheckinBusy] = useState(false);
  const [appIconConfigs, setAppIconConfigs] = useState<AppIconState>({});
  const [editingIconId, setEditingIconId] = useState(DEFAULT_ICON_ORDER[0]);
  const [backgroundImageKey, setBackgroundImageKey] = useState<string | undefined>(undefined);
  const [backgroundImageUrl, setBackgroundImageUrl] = useState<string | undefined>(undefined);
  const bgFileInputRef = useRef<HTMLInputElement | null>(null);

  const appIcons = useMemo(() => [
    { id: "chat",     defaultEmoji: "💬", label: "聊天",   action: onOpenChat },
    { id: "checkin",  defaultEmoji: "✅", label: "打卡",   route: "/checkin" },
    { id: "memory",   defaultEmoji: "🧠", label: "记忆库", route: "/memory-vault" },
    { id: "snacks",   defaultEmoji: "🍪", label: "mimi",   route: "/snacks" },
    { id: "syzygy",   defaultEmoji: "📘", label: "Claude", route: "/syzygy" },
    { id: "usage",    defaultEmoji: "📊", label: "检测中心", route: "/usage" },
    { id: "health",   defaultEmoji: "🫀", label: "健康",   route: "/health-sync" },
    { id: "settings", defaultEmoji: "⚙️", label: "设置",   route: "/settings" },
    { id: "export",   defaultEmoji: "📦", label: "导出",   route: "/export" },
  ], [onOpenChat]);

  const defaultAppIconConfigs = useMemo<AppIconState>(
    () => Object.fromEntries(
      appIcons.map((icon) => [icon.id, { type: "emoji" as const, emoji: icon.defaultEmoji }])
    ),
    [appIcons],
  );

  const dateLabel = useMemo(
    () => now.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" }),
    [now],
  );

  const togetherElapsed = useMemo(() => {
    if (!togetherSince) return null;
    const start = new Date(togetherSince);
    if (Number.isNaN(start.getTime())) return null;
    const diffMs = Math.max(0, now.getTime() - start.getTime());
    const days = Math.floor(diffMs / 86400000);
    return { days };
  }, [togetherSince, now]);

  const togetherInputValue = useMemo(() => {
    if (!togetherSince) return "";
    const start = new Date(togetherSince);
    if (Number.isNaN(start.getTime())) return "";
    const pad = (v: number) => v.toString().padStart(2, "0");
    return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(start.getMinutes())}`;
  }, [togetherSince]);

  const handleTogetherSinceChange = useCallback((value: string) => {
    if (!value) { setTogetherSince(null); return; }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return;
    setTogetherSince(parsed.toISOString());
  }, []);

  const weekDates = useMemo(() => buildCurrentWeekDates(now), [now]);
  const todayDate = useMemo(() => {
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }, [now]);
  const todayChecked = checkedDates.has(todayDate);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      try {
        const recent = await fetchRecentCheckins(14);
        if (cancelled) return;
        setCheckedDates(new Set(recent.map((row) => row.checkinDate)));
      } catch (err) {
        console.warn("加载本周打卡失败", err);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  const handleQuickCheckin = useCallback(async () => {
    if (!user || checkinBusy || todayChecked) return;
    setCheckinBusy(true);
    try {
      await createTodayCheckin(todayDate);
      setCheckedDates((prev) => { const next = new Set(prev); next.add(todayDate); return next; });
    } catch (err) {
      console.warn("一键打卡失败", err);
      setNotice("打卡失败，请稍后重试。");
    } finally {
      setCheckinBusy(false);
    }
  }, [checkinBusy, todayChecked, todayDate, user]);

  useEffect(() => {
    const tick = () => { if (!document.hidden) setNow(new Date()); };
    const intervalId = window.setInterval(tick, 60000);
    const onVisible = () => { if (!document.hidden) setNow(new Date()); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (isSettingsPage) setEditMode(true);
  }, [isSettingsPage]);

  const hasLoadedPrefsRef = useRef(false);
  useEffect(() => {
    if (hasLoadedPrefsRef.current) return;
    hasLoadedPrefsRef.current = true;
    const cached = loadHomeSettings();
    if (!cached) {
      setAppIconConfigs(defaultAppIconConfigs);
      setPrefsReady(true);
      return;
    }
    setTogetherSince(cached.togetherSince ?? null);
    const nextIconConfigs = Object.fromEntries(
      Object.entries({ ...defaultAppIconConfigs, ...(cached.appIconConfigs ?? {}) }).map(
        ([id, config]) => [
          id,
          config?.type === "emoji"
            ? { type: "emoji" as const, emoji: config.emoji }
            : defaultAppIconConfigs[id],
        ],
      ),
    ) as AppIconState;
    setAppIconConfigs(nextIconConfigs);
    setBackgroundImageKey(cached.backgroundImageKey);
    setPrefsReady(true);
  }, [defaultAppIconConfigs]);

  useEffect(() => {
    if (!backgroundImageKey) { setBackgroundImageUrl(undefined); return; }
    void loadImageDataUrl(backgroundImageKey).then((url) => {
      setBackgroundImageUrl(url ?? undefined);
    });
  }, [backgroundImageKey]);

  useEffect(() => {
    if (!prefsReady) return;
    saveHomeSettings({
      iconOrder: DEFAULT_ICON_ORDER,
      pages: [{ widgetOrder: [], widgets: [] }],
      togetherSince,
      appIconConfigs,
      backgroundImageKey,
    });
  }, [appIconConfigs, backgroundImageKey, togetherSince, prefsReady]);

  const handleEmojiChange = (iconId: string, emoji: string) => {
    setAppIconConfigs((current) => ({ ...current, [iconId]: { type: "emoji", emoji } }));
  };

  const handleResetAppIcon = (iconId: string) => {
    const fallback = defaultAppIconConfigs[iconId] as { type: "emoji"; emoji: string };
    setAppIconConfigs((prev) => ({ ...prev, [iconId]: fallback }));
  };

  const handleBgImageSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    const key = createImageKey();
    await saveImageDataUrl(dataUrl, key);
    if (backgroundImageKey) await removeImageData(backgroundImageKey);
    setBackgroundImageKey(key);
    setBackgroundImageUrl(dataUrl);
    if (event.target) event.target.value = "";
  };

  const handleRemoveBgImage = async () => {
    if (backgroundImageKey) await removeImageData(backgroundImageKey);
    setBackgroundImageKey(undefined);
    setBackgroundImageUrl(undefined);
  };

  const mainListItems = [
    { id: "chat",   label: "Chat",    sub: "Start a new conversation", action: onOpenChat,  route: undefined },
    { id: "memory", label: "Memory",  sub: "View memories",            action: undefined,   route: "/memory-vault" },
    { id: "snacks", label: "Moments", sub: "Mine · Yours",             action: undefined,   route: "/snacks" },
    { id: "health", label: "Health",  sub: "Today's health data",      action: undefined,   route: "/health-sync" },
  ];

  return (
    <main
      className={`home-page app-shell ${isSettingsPage ? "home-page--settings" : ""}${backgroundImageUrl ? " home-page--has-bg" : ""}`}
      style={
        backgroundImageUrl
          ? { backgroundImage: `url(${backgroundImageUrl})`, backgroundSize: "cover", backgroundPosition: "center" }
          : undefined
      }
    >
      <div className={`phone-shell ${isSettingsPage ? "phone-shell--settings" : ""}`}>
        <div className="phone-shell__mask" aria-hidden="true" />
        <div className="phone-shell__content">

          {/* ── Settings panels (edit mode only) ────────────────────────── */}
          {editMode ? (
            <div className="home-page__header app-shell__header">
              <header className="home-header">
                {isSettingsPage ? (
                  <>
                    <button type="button" className="edit-button edit-button-back" onClick={() => navigate(-1)}>
                      返回
                    </button>
                    <button type="button" className="edit-button" onClick={() => navigate("/")}>
                      完成
                    </button>
                    <h1 className="ui-title">主页设置</h1>
                  </>
                ) : (
                  <button type="button" className="edit-button" onClick={() => setEditMode(false)}>
                    完成
                  </button>
                )}
              </header>

              {notice ? <p className="home-notice">{notice}</p> : null}

              <section className="glass-card home-settings-card">
                <h2 className="home-settings-title ui-title">在一起时间</h2>
                <label className="together-input">
                  <span>起始日期</span>
                  <input
                    type="datetime-local"
                    value={togetherInputValue}
                    onChange={(event) => handleTogetherSinceChange(event.target.value)}
                  />
                </label>
              </section>

              <section className="glass-card home-settings-card">
                <h2 className="home-settings-title ui-title">背景图片</h2>
                <div className="background-controls">
                  <button type="button" className="ghost" onClick={() => bgFileInputRef.current?.click()}>
                    {backgroundImageUrl ? "更换背景" : "上传背景"}
                  </button>
                  {backgroundImageUrl ? (
                    <button type="button" className="ghost" onClick={() => void handleRemoveBgImage()}>
                      移除
                    </button>
                  ) : null}
                </div>
                <input
                  ref={bgFileInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(event) => void handleBgImageSelected(event)}
                />
              </section>

              <section className="glass-card home-settings-card">
                <h2 className="home-settings-title ui-title">图标 Emoji</h2>
                <label>
                  应用
                  <select
                    value={editingIconId}
                    onChange={(event) => setEditingIconId(event.target.value)}
                  >
                    {appIcons.map((icon) => (
                      <option key={icon.id} value={icon.id}>{icon.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Emoji
                  <input
                    type="text"
                    value={
                      appIconConfigs[editingIconId]?.type === "emoji"
                        ? appIconConfigs[editingIconId].emoji
                        : ""
                    }
                    onChange={(event) => handleEmojiChange(editingIconId, event.target.value)}
                    placeholder="输入 emoji"
                    maxLength={4}
                  />
                </label>
                <div className="background-controls">
                  <button type="button" className="ghost" onClick={() => handleResetAppIcon(editingIconId)}>
                    恢复默认
                  </button>
                </div>
              </section>
            </div>
          ) : null}

          {/* ── Main content: always shown ───────────────────────────────── */}
          <div className="home-page__content app-shell__content">
            <div className="home-layout">

              {/* Top bar */}
              <div className="home-topbar">
                {!isSettingsPage ? (
                  <button
                    type="button"
                    className="home-topbar-edit"
                    onClick={() => setEditMode((v) => !v)}
                    aria-label={editMode ? "Done" : "Edit"}
                  >
                    {editMode ? "Done" : "Edit"}
                  </button>
                ) : (
                  <span />
                )}
                <p className="home-date-label">{dateLabel}</p>
                <button
                  type="button"
                  className="home-topbar-settings"
                  onClick={() => navigate("/settings")}
                  aria-label="设置"
                >
                  ⚙️
                </button>
              </div>

              {/* Couple avatar widget — hidden in edit mode */}
              {!editMode && <HomeCoupleCard />}

              {/* Hero: days counter + week dots + check-in */}
              <section className="home-hero glass-card">
                <div className="hero-days">
                  {togetherElapsed ? (
                    <>
                      <strong className="hero-days-num">{togetherElapsed.days}</strong>
                      <span className="hero-days-label">在一起</span>
                    </>
                  ) : (
                    <span className="hero-days-empty">
                      {editMode ? "请设置起始日期" : "在一起"}
                    </span>
                  )}
                </div>

                <div className="together-week" role="list" aria-label="本周打卡">
                  {weekDates.map((iso, index) => {
                    const checked = checkedDates.has(iso);
                    const isToday = iso === todayDate;
                    return (
                      <div
                        key={iso}
                        role="listitem"
                        className={`together-week-cell${checked ? " is-checked" : ""}${isToday ? " is-today" : ""}`}
                      >
                        <span className="together-week-dot" aria-hidden="true">
                          {checked ? "✓" : ""}
                        </span>
                        <span className="together-week-label">{WEEK_DAY_LABELS[index]}</span>
                      </div>
                    );
                  })}
                </div>

                <button
                  type="button"
                  className={`together-checkin-btn${todayChecked ? " is-done" : ""}`}
                  onClick={() => void handleQuickCheckin()}
                  disabled={todayChecked || checkinBusy || !user}
                >
                  {todayChecked ? "今日已陪伴 💖" : checkinBusy ? "打卡中…" : "今日打卡 💗"}
                </button>
              </section>

              {/* Vertical nav list */}
              <nav className="home-list glass-card" aria-label="功能导航">
                {mainListItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="home-list-row"
                    onClick={() => {
                      if (item.action) item.action();
                      else if (item.route) navigate(item.route);
                    }}
                  >
                    <div className="home-list-body">
                      <strong className="home-list-title">{item.label}</strong>
                      <span className="home-list-sub">{item.sub}</span>
                    </div>
                    <span className="home-list-chevron" aria-hidden="true">›</span>
                  </button>
                ))}
              </nav>

              {/* Footer links */}
              <footer className="home-footer">
                <button type="button" className="home-footer-link" onClick={() => navigate("/checkin")}>
                  Check-in
                </button>
                <span className="home-footer-sep">·</span>
                <button type="button" className="home-footer-link" onClick={() => navigate("/usage")}>
                  Diagnostics
                </button>
                <span className="home-footer-sep">·</span>
                <button type="button" className="home-footer-link" onClick={() => navigate("/export")}>
                  Export
                </button>
              </footer>

            </div>
          </div>

        </div>
      </div>
    </main>
  );
};

export default HomePage;
