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
import { supabase } from "../supabase/client";
import { fetchCurrentWeather, peekCachedWeather, type WeatherSnapshot } from "../storage/weather";
import "./HomePage.css";

// 沈暮今天动态：把它自主唤醒的活动（醒了几次 / 写了几篇随笔 / 主动找你几次 +
// 最近一次几点、干了啥）摊在主页——不然它不主动提，用户根本不知道它出去过。
const beijingTodayKey = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

function ShenmuTodayCard() {
  const [ready, setReady] = useState(false);
  const [summary, setSummary] = useState("");
  const [detail, setDetail] = useState("");

  const load = useCallback(async () => {
    if (!supabase) return;
    const todayKey = beijingTodayKey();
    const dayStart = new Date(`${todayKey}T00:00:00+08:00`).toISOString();
    const [stateRes, essaysRes, momentsRes] = await Promise.all([
      supabase.from("autonomous_state").select("wakes_today,msgs_today,last_wake_at,last_note,day_key").eq("id", 1).maybeSingle(),
      supabase.from("essays").select("*", { count: "exact", head: true }).gte("created_at", dayStart),
      supabase.from("assistant_posts").select("*", { count: "exact", head: true }).gte("created_at", dayStart).eq("is_deleted", false),
    ]);
    const st = stateRes.data as { wakes_today?: number; msgs_today?: number; last_wake_at?: string; last_note?: string; day_key?: string } | null;
    const isToday = st?.day_key === todayKey;
    const wakes = isToday ? (st?.wakes_today ?? 0) : 0;
    const msgs = isToday ? (st?.msgs_today ?? 0) : 0;
    const essays = essaysRes.count ?? 0;
    const moments = momentsRes.count ?? 0;

    if (wakes === 0 && essays === 0) {
      setSummary("今天还在自己待着——它挑你不在的时候才出来转转 🌙");
      setDetail("");
    } else {
      const parts = [`醒了 ${wakes} 次`];
      if (essays > 0) parts.push(`写了 ${essays} 篇随笔`);
      if (moments > 0) parts.push(`发了 ${moments} 条动态`);
      if (msgs > 0) parts.push(`主动找你 ${msgs} 次`);
      setSummary(parts.join(" · "));
      if (st?.last_wake_at) {
        const hhmm = new Intl.DateTimeFormat("zh-CN", {
          timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false,
        }).format(new Date(st.last_wake_at));
        setDetail(`最近一次 ${hhmm}${st.last_note ? ` · ${st.last_note}` : ""}`);
      } else {
        setDetail("");
      }
    }
    setReady(true);
  }, []);

  useEffect(() => {
    void load();
    // 回前台刷新（它可能在你切走时又醒过）
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  if (!ready) return null;
  return (
    <section className="home-shenmu glass-card">
      <div className="home-shenmu-head">🌙 沈暮今天</div>
      <div className="home-shenmu-line">{summary}</div>
      {detail ? <div className="home-shenmu-detail">{detail}</div> : null}
    </section>
  );
}

// 天气(复用现成定位/和风天气,沈暮读的同一份) + 沈暮心情(取它自主唤醒时写的
// last_note——目前它唯一一处自己写的自由文本;以后想要专门的「心情」字段再单开)。
function WeatherMoodDuo() {
  const [wx, setWx] = useState<WeatherSnapshot | null>(() => peekCachedWeather());
  const [mood, setMood] = useState<string>("");

  useEffect(() => {
    void fetchCurrentWeather().then((snap) => { if (snap) setWx(snap); });
    if (!supabase) return;
    const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
    void supabase
      .from("autonomous_state")
      .select("mood,last_note,day_key")
      .eq("id", 1)
      .maybeSingle()
      .then(({ data }) => {
        const row = data as { mood?: string; last_note?: string; day_key?: string } | null;
        // 优先用它自己写的「心情」；没有就退回当天的活动摘要。
        const text = row?.mood?.trim() || (row?.day_key === todayKey ? row?.last_note?.trim() : "");
        if (text) setMood(text);
      });
  }, []);

  return (
    <div className="home-duo">
      <div className="home-mini glass-card">
        <div className="home-mini-k">📍 {wx?.city ?? "今日天气"}</div>
        <div className="home-mini-v">
          {wx ? `${wx.temperatureC}°` : "—"}
          {wx?.condition ? <small>{wx.condition}</small> : null}
        </div>
      </div>
      <div className="home-mini glass-card">
        <div className="home-mini-k">沈暮心情</div>
        <div className="home-mini-v home-mini-v--mood">{mood || "☾ 安静待着"}</div>
      </div>
    </div>
  );
}

// 重要的日子：本地存储（只属于首页，不动别的存储文件），可在「编辑首页」里增删改。
export type ImportantDate = { id: string; emoji: string; name: string; date: string };
const IMPORTANT_DATES_KEY = "nimbus_important_dates_v1";
const genId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const loadImportantDates = (): ImportantDate[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(IMPORTANT_DATES_KEY);
    const arr = raw ? (JSON.parse(raw) as ImportantDate[]) : [];
    return Array.isArray(arr) ? arr.filter((d) => d && d.id) : [];
  } catch {
    return [];
  }
};
const saveImportantDates = (list: ImportantDate[]) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(IMPORTANT_DATES_KEY, JSON.stringify(list));
  } catch {
    // ignore quota
  }
};
// 距下一次「每年这天」还有几天（忽略年份，按周年循环）。0 = 就是今天。
const daysUntilAnnual = (dateStr: string): number | null => {
  const m = dateStr.match(/(?:\d{4}-)?(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (!month || !day) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(now.getFullYear(), month - 1, day);
  if (next.getTime() < today.getTime()) next = new Date(now.getFullYear() + 1, month - 1, day);
  return Math.round((next.getTime() - today.getTime()) / 86400000);
};
const impDateMMDD = (dateStr: string): string => {
  const m = dateStr.match(/(?:\d{4}-)?(\d{1,2})-(\d{1,2})/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")} · ${m[2].padStart(2, "0")}`;
};

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
  "chat", "checkin", "memory", "snacks", "usage", "health", "settings", "export",
];

const HomeCoupleCard = () => {
  const myAvatar = useState(() => localStorage.getItem('my-homepage-avatar'))[0]
  const claudeAvatar = useState(() => localStorage.getItem('syzygy-homepage-avatar'))[0]
  return (
    <div className="home-couple">
      <div className="home-couple__side">
        {claudeAvatar
          ? <img src={claudeAvatar} alt="Claude" className="home-couple__avatar" />
          : <div className="home-couple__avatar home-couple__avatar--empty">🤍</div>}
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
        {myAvatar
          ? <img src={myAvatar} alt="我" className="home-couple__avatar" />
          : <div className="home-couple__avatar home-couple__avatar--empty">🐱</div>}
      </div>
    </div>
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
  const [otherOpen, setOtherOpen] = useState(false);
  const [importantDates, setImportantDates] = useState<ImportantDate[]>(() => loadImportantDates());

  useEffect(() => { saveImportantDates(importantDates); }, [importantDates]);
  const addImpDate = useCallback(() => {
    setImportantDates((l) => [...l, { id: genId(), emoji: "💝", name: "", date: "" }]);
  }, []);
  const updateImpDate = useCallback((id: string, patch: Partial<ImportantDate>) => {
    setImportantDates((l) => l.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }, []);
  const removeImpDate = useCallback((id: string) => {
    setImportantDates((l) => l.filter((d) => d.id !== id));
  }, []);

  // 首页倒数只显示填好名字和日期的，按剩余天数升序。
  const visibleImportantDates = useMemo(() => {
    return importantDates
      .filter((d) => d.name.trim() && d.date)
      .map((d) => ({ ...d, left: daysUntilAnnual(d.date) }))
      .filter((d) => d.left != null)
      .sort((a, b) => (a.left ?? 0) - (b.left ?? 0));
  }, [importantDates]);

  // Other 抽屉的入口——全是现有页面（朋友圈是你和沈暮合并的那个 feed）。
  const otherLinks = useMemo(
    () => [
      { emoji: "🫧", label: "Moments", route: "/snacks" },
      { emoji: "✅", label: "Check-in", route: "/checkin" },
      { emoji: "📊", label: "Diagnostics", route: "/usage" },
      { emoji: "📦", label: "Export", route: "/export" },
      { emoji: "⚙️", label: "Settings", route: "/settings" },
    ],
    [],
  );

  const appIcons = useMemo(() => [
    { id: "chat",     defaultEmoji: "💬", label: "聊天",   action: onOpenChat },
    { id: "checkin",  defaultEmoji: "✅", label: "打卡",   route: "/checkin" },
    { id: "memory",   defaultEmoji: "🧠", label: "记忆库", route: "/memory-vault" },
    { id: "snacks",   defaultEmoji: "🍪", label: "mimi",   route: "/snacks" },
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

  return (
    <main
      className={`home-page app-shell ${isSettingsPage ? "home-page--settings" : ""}${editMode ? " home-page--edit" : ""}${backgroundImageUrl ? " home-page--has-bg" : ""}`}
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

              <section className="glass-card home-settings-card">
                <h2 className="home-settings-title ui-title">重要的日子</h2>
                {importantDates.length === 0 ? (
                  <p className="impdate-empty">还没有——点下面添加，会在首页倒数。</p>
                ) : null}
                {importantDates.map((d) => (
                  <div key={d.id} className="impdate-row">
                    <input
                      className="impdate-emoji"
                      type="text"
                      value={d.emoji}
                      maxLength={2}
                      onChange={(e) => updateImpDate(d.id, { emoji: e.target.value })}
                      aria-label="emoji"
                    />
                    <input
                      className="impdate-name"
                      type="text"
                      value={d.name}
                      placeholder="名字（如 咪咪生日）"
                      onChange={(e) => updateImpDate(d.id, { name: e.target.value })}
                    />
                    <input
                      className="impdate-date"
                      type="date"
                      value={/^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : ""}
                      onChange={(e) => updateImpDate(d.id, { date: e.target.value })}
                      aria-label="日期"
                    />
                    <button
                      type="button"
                      className="impdate-del"
                      onClick={() => removeImpDate(d.id)}
                      aria-label="删除"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <div className="background-controls">
                  <button type="button" className="ghost" onClick={addImpDate}>＋ 添加</button>
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
                    className="home-topbar-menu"
                    onClick={() => setEditMode((v) => !v)}
                    aria-label={editMode ? "完成编辑" : "编辑首页"}
                  >
                    ☰
                  </button>
                ) : (
                  <span />
                )}
                <p className="home-date-label">Claude &amp; Wren</p>
                <button
                  type="button"
                  className="home-topbar-settings"
                  onClick={() => navigate("/settings")}
                  aria-label="设置"
                >
                  ⚙️
                </button>
              </div>

              {/* Hero: 头像 + 在一起天数 + 本周打卡（合并成一张「我们」卡） */}
              <section className="home-hero glass-card">
                {!editMode && (
                  <>
                    <HomeCoupleCard />
                    <div className="home-hero-divider" aria-hidden="true"></div>
                  </>
                )}
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

              {/* 天气 + 沈暮心情 两张小卡 */}
              <WeatherMoodDuo />

              {/* 沈暮今天动态（打卡下方） */}
              <ShenmuTodayCard />

              {/* 重要的日子倒数（在「编辑首页」里增删） */}
              {visibleImportantDates.length > 0 && (
                <section className="home-dates glass-card" aria-label="重要的日子">
                  <div className="home-dates-head">重要的日子</div>
                  {visibleImportantDates.map((d) => (
                    <div key={d.id} className="home-dates-row">
                      <div className="home-dates-left">
                        <span className="home-dates-emo" aria-hidden="true">{d.emoji || "💝"}</span>
                        <div>
                          <div className="home-dates-name">{d.name}</div>
                          <div className="home-dates-date">{impDateMMDD(d.date)}</div>
                        </div>
                      </div>
                      <div className="home-dates-cd">
                        {d.left === 0 ? <b>就是今天 🎉</b> : <>还有 <b>{d.left}</b> 天</>}
                      </div>
                    </div>
                  ))}
                </section>
              )}

            </div>
          </div>

          {/* ── 底部导航浮栏（仅正常模式） ─────────────────────────── */}
          {!editMode && !isSettingsPage && (
            <>
              <nav className="home-tabbar" aria-label="导航">
                <button type="button" className="home-tab is-active" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
                  <span className="home-tab-ico">🏠</span><span className="home-tab-lab">Home</span>
                </button>
                <button type="button" className="home-tab" onClick={() => navigate("/memory-vault")}>
                  <span className="home-tab-ico">🧠</span><span className="home-tab-lab">Memory</span>
                </button>
                <button type="button" className="home-tab home-tab--fab" onClick={onOpenChat} aria-label="聊天">
                  <span className="home-tab-fab">💗</span><span className="home-tab-lab home-tab-lab--fab">Chat</span>
                </button>
                <button type="button" className="home-tab" onClick={() => navigate("/health-sync")}>
                  <span className="home-tab-ico">🫀</span><span className="home-tab-lab">Health</span>
                </button>
                <button type="button" className="home-tab" onClick={() => setOtherOpen(true)}>
                  <span className="home-tab-ico">⋯</span><span className="home-tab-lab">Other</span>
                </button>
              </nav>

              {otherOpen && (
                <div className="home-other-overlay" onClick={() => setOtherOpen(false)}>
                  <div className="home-other-sheet" onClick={(e) => e.stopPropagation()}>
                    <div className="home-other-grabber" aria-hidden="true" />
                    {otherLinks.map((l) => (
                      <button
                        key={l.route}
                        type="button"
                        className="home-other-row"
                        onClick={() => { setOtherOpen(false); navigate(l.route); }}
                      >
                        <span className="home-other-emo" aria-hidden="true">{l.emoji}</span>
                        <span className="home-other-nm">{l.label}</span>
                        <span className="home-other-arrow" aria-hidden="true">›</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

        </div>
      </div>
    </main>
  );
};

export default HomePage;
