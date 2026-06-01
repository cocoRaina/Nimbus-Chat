import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { User } from "@supabase/supabase-js";
import { useNavigate } from "react-router-dom";
import {
  loadHomeSettings,
  loadImageDataUrl,
  removeImageData,
  saveHomeSettings,
  saveImageDataUrl,
  type AppIconConfig,
  type DecorativeWidget,
  type HomePageData,
} from "../storage/homeLayout";
import { createTodayCheckin, fetchRecentCheckins } from "../storage/supabaseSync";
import { useHomeWidgetData } from "../hooks/useHomeWidgetData";
import "./HomePage.css";

// Chinese week: Monday → Sunday. Each label maps onto a column in the
// checkin widget's 7-day row.
const WEEK_DAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"] as const;

// Returns YYYY-MM-DD for the Monday of the week containing `date`,
// then iterates forward 7 days. Used for the per-row dots.
const buildCurrentWeekDates = (today: Date): string[] => {
  const ref = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  // getDay(): Sunday=0, Monday=1, … Saturday=6. Map to Mon-start.
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

type AppIcon = {
  id: string;
  defaultEmoji: string;
  label: string;
  route?: string;
  action?: () => void;
};

type WidgetSize = "1x1" | "2x1";
type AppIconState = Record<string, AppIconConfig>;

type RenderedWidgetItem = {
  id: string;
  size: WidgetSize;
  kind: "checkin" | "decorative";
  widget?: DecorativeWidget;
};

const DEFAULT_ICON_ORDER = [
  // Retained for emoji-customisation purposes only (appIconConfigs
  // keys off these ids). The bottom dock has been removed entirely
  // — every app is now a shortcut widget on page 0 of the grid.
  "chat",
  "checkin",
  "memory",
  "snacks",
  "syzygy",
  "usage",
  "health",
  "settings",
  "export",
];
const CORE_WIDGET_ID = "widget-checkin";
// Raised from 6 → 14 so page 0 can hold the checkin tile + all 9 app
// shortcuts + a couple of content widgets without immediately
// bumping the cap.
const MAX_WIDGETS = 14;
const DEFAULT_ICON_TILE_BG_COLOR = "#ffffff";
const DEFAULT_ICON_TILE_BG_OPACITY = 0.65;

const imageCache = new Map<string, string>();

const hexToRgb = (hex: string) => {
  const sanitized = hex.replace("#", "").trim();
  const fullHex =
    sanitized.length === 3
      ? sanitized
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : sanitized;

  if (!/^[0-9a-fA-F]{6}$/.test(fullHex)) {
    return { r: 255, g: 255, b: 255 };
  }

  return {
    r: Number.parseInt(fullHex.slice(0, 2), 16),
    g: Number.parseInt(fullHex.slice(2, 4), 16),
    b: Number.parseInt(fullHex.slice(4, 6), 16),
  };
};

const readFileAsDataUrl = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : null;
      if (!result) {
        reject(new Error("读取图片失败"));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });

const HomePage = ({ user, onOpenChat, mode = "default" }: HomePageProps) => {
  const isSettingsPage = mode === "settings";
  const navigate = useNavigate();
  const [now, setNow] = useState(() => new Date());
  // Shared fetcher for the three on-home content widgets. Pulls today's
  // health row, latest period cycle, and today's screen-time stats once
  // per mount so widget render is cheap.
  const widgetData = useHomeWidgetData(user?.id);

  const [editMode, setEditMode] = useState(false);
  // While editMode is on, the toolbar takes a lot of vertical room.
  // Flipping into "preview" temporarily hides the toolbar so the user
  // can see the live grid without leaving edit mode. Toggled by the
  // 👁 button inside the widget toolbar header.
  const [editPreviewing, setEditPreviewing] = useState(false);
  const [mobileTab, setMobileTab] = useState<"settings" | "preview">(
    "settings",
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [prefsReady, setPrefsReady] = useState(false);

  const [iconOrder, setIconOrder] = useState<string[]>(DEFAULT_ICON_ORDER);
  const [pages, setPages] = useState<HomePageData[]>([
    { widgetOrder: [CORE_WIDGET_ID], widgets: [] },
  ]);
  const [activePageIdx, setActivePageIdx] = useState(0);
  // Derived view into the active page. Reads through every render
  // instead of being memoed — it's a trivial index/?? lookup, and the
  // downstream consumers (decoratedWidgetCount, removeWidget) already
  // depend on the underlying pages array.
  //
  // Note: the analogous `widgetOrder` derived value was removed once
  // rendering moved to per-page `buildPageItems(page)` — nothing else
  // referenced the active page's order anymore. The setWidgetOrder
  // wrapper below still exists because reorder-drag and add-widget
  // helpers write through it.
  const widgets: DecorativeWidget[] = pages[activePageIdx]?.widgets ?? [];
  // Wrapper setters preserve the existing call sites — every place that
  // used to call setWidgets/setWidgetOrder still works because the
  // wrapper rewrites the matching slot inside pages[activePageIdx].
  // Supports both functional and direct-value updates.
  type Updater<T> = T | ((prev: T) => T);
  const setWidgets = useCallback(
    (updater: Updater<DecorativeWidget[]>) => {
      setPages((current) => {
        if (current.length === 0) return current;
        const idx = Math.min(activePageIdx, current.length - 1);
        const page = current[idx];
        const nextWidgets =
          typeof updater === "function"
            ? (updater as (prev: DecorativeWidget[]) => DecorativeWidget[])(
                page.widgets,
              )
            : updater;
        if (nextWidgets === page.widgets) return current;
        const next = current.slice();
        next[idx] = { ...page, widgets: nextWidgets };
        return next;
      });
    },
    [activePageIdx],
  );
  const setWidgetOrder = useCallback(
    (updater: Updater<string[]>) => {
      setPages((current) => {
        if (current.length === 0) return current;
        const idx = Math.min(activePageIdx, current.length - 1);
        const page = current[idx];
        const nextOrder =
          typeof updater === "function"
            ? (updater as (prev: string[]) => string[])(page.widgetOrder)
            : updater;
        if (nextOrder === page.widgetOrder) return current;
        const next = current.slice();
        next[idx] = { ...page, widgetOrder: nextOrder };
        return next;
      });
    },
    [activePageIdx],
  );
  const [checkinSize, setCheckinSize] = useState<WidgetSize>("1x1");
  const [togetherSince, setTogetherSince] = useState<string | null>(null);
  const [showEmptySlots, setShowEmptySlots] = useState(false);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [iconTileBgColor, setIconTileBgColor] = useState(
    DEFAULT_ICON_TILE_BG_COLOR,
  );
  const [iconTileBgOpacity, setIconTileBgOpacity] = useState(
    DEFAULT_ICON_TILE_BG_OPACITY,
  );
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(max-width: 900px)").matches
      : true,
  );
  const [appIconConfigs, setAppIconConfigs] = useState<AppIconState>({});
  const [editingIconId, setEditingIconId] = useState(DEFAULT_ICON_ORDER[0]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Set of YYYY-MM-DD strings the user has checked in within the
  // current week. Used to render the 7-dot row + decide whether the
  // quick-checkin button should look "done" or "ready".
  const [checkedDates, setCheckedDates] = useState<Set<string>>(new Set());
  const [checkinBusy, setCheckinBusy] = useState(false);

  const holdTimerRef = useRef<number | null>(null);
  // Ref to the horizontal pages scroller. Used both to compute which
  // page is currently snapped (scroll listener) and to programmatically
  // scroll when the user taps a dot.
  const pagesScrollRef = useRef<HTMLDivElement | null>(null);

  const addPage = useCallback(() => {
    setPages((current) => {
      const next = [...current, { widgetOrder: [], widgets: [] }];
      // Step active page to the new one in the same render so the
      // dots/scroll position match what just got created.
      setActivePageIdx(next.length - 1);
      return next;
    });
  }, []);

  // Trim a trailing empty page when the user navigates away from it.
  // Page 0 is sacred (it owns the core check-in widget) so we never
  // remove it even when empty.
  const removeActivePageIfEmpty = useCallback(() => {
    setPages((current) => {
      if (activePageIdx <= 0 || activePageIdx >= current.length) {
        return current;
      }
      const page = current[activePageIdx];
      if (page.widgets.length > 0 || page.widgetOrder.length > 0) {
        return current;
      }
      const next = current.slice();
      next.splice(activePageIdx, 1);
      setActivePageIdx((idx) => Math.max(0, idx - 1));
      return next;
    });
  }, [activePageIdx]);

  // Hard remove of the active page (even when it has widgets). Page 0
  // is locked because it owns the core checkin widget. Used by the
  // "× 删除本页" button rendered next to the page-dot indicators in
  // edit mode.
  const removeActivePage = useCallback(() => {
    setPages((current) => {
      if (activePageIdx <= 0 || current.length <= 1) {
        return current;
      }
      const next = current.slice();
      next.splice(activePageIdx, 1);
      setActivePageIdx((idx) => Math.max(0, idx - 1));
      return next;
    });
  }, [activePageIdx]);

  const scrollToPage = useCallback(
    (pageIdx: number) => {
      // If the user is leaving the active page and it's empty, drop it
      // first so we don't leave an orphan ghost behind. The helper is
      // a no-op when the active page has any content (or is page 0).
      removeActivePageIfEmpty();
      const el = pagesScrollRef.current;
      if (!el) return;
      el.scrollTo({ left: pageIdx * el.clientWidth, behavior: "smooth" });
    },
    [removeActivePageIfEmpty],
  );

  const handlePagesScroll = useCallback(() => {
    const el = pagesScrollRef.current;
    if (!el || el.clientWidth === 0) return;
    const idx = Math.round(el.scrollLeft / el.clientWidth);
    setActivePageIdx((current) => (current === idx ? current : idx));
  }, []);

  const appIcons = useMemo<AppIcon[]>(
    () => [
      { id: "chat", defaultEmoji: "💬", label: "聊天", action: onOpenChat },
      { id: "checkin", defaultEmoji: "✅", label: "打卡", route: "/checkin" },
      {
        id: "memory",
        defaultEmoji: "🧠",
        label: "记忆库",
        route: "/memory-vault",
      },
      { id: "snacks", defaultEmoji: "🍪", label: "mimi", route: "/snacks" },
      { id: "syzygy", defaultEmoji: "📘", label: "Claude", route: "/syzygy" },
      { id: "usage", defaultEmoji: "📊", label: "用量统计", route: "/usage" },
      { id: "health", defaultEmoji: "🫀", label: "健康", route: "/health-sync" },
      { id: "settings", defaultEmoji: "⚙️", label: "设置", route: "/settings" },
      { id: "export", defaultEmoji: "📦", label: "导出", route: "/export" },
    ],
    [onOpenChat],
  );

  const iconMap = useMemo(
    () => new Map(appIcons.map((icon) => [icon.id, icon])),
    [appIcons],
  );

  const defaultAppIconConfigs = useMemo<AppIconState>(
    () =>
      Object.fromEntries(
        appIcons.map((icon) => [
          icon.id,
          { type: "emoji", emoji: icon.defaultEmoji } satisfies AppIconConfig,
        ]),
      ),
    [appIcons],
  );

  const dateLabel = useMemo(
    () =>
      now.toLocaleDateString("zh-CN", {
        month: "long",
        day: "numeric",
        weekday: "short",
      }),
    [now],
  );
  const togetherElapsed = useMemo(() => {
    if (!togetherSince) {
      return null;
    }
    const start = new Date(togetherSince);
    if (Number.isNaN(start.getTime())) {
      return null;
    }
    const diffMs = Math.max(0, now.getTime() - start.getTime());
    const seconds = Math.floor(diffMs / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return { days, hours, minutes, seconds: secs };
  }, [togetherSince, now]);
  const togetherInputValue = useMemo(() => {
    if (!togetherSince) {
      return "";
    }
    const start = new Date(togetherSince);
    if (Number.isNaN(start.getTime())) {
      return "";
    }
    const pad = (value: number) => value.toString().padStart(2, "0");
    return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(
      start.getDate(),
    )}T${pad(start.getHours())}:${pad(start.getMinutes())}`;
  }, [togetherSince]);
  const handleTogetherSinceChange = useCallback((value: string) => {
    if (!value) {
      setTogetherSince(null);
      return;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return;
    }
    setTogetherSince(parsed.toISOString());
  }, []);

  // Current local week (Mon→Sun) anchored on `now` so it auto-rolls
  // at midnight. Derived rather than stored to stay correct after a
  // tab sits open across a day boundary.
  const weekDates = useMemo(() => buildCurrentWeekDates(now), [now]);
  const todayDate = useMemo(() => {
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }, [now]);
  const todayChecked = checkedDates.has(todayDate);

  // Pull the last 14 days of check-ins on mount so the widget can
  // reflect today + the rest of the current week, plus a buffer for
  // weeks that span month boundaries.
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
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleQuickCheckin = useCallback(async () => {
    if (!user || checkinBusy || todayChecked) return;
    setCheckinBusy(true);
    try {
      await createTodayCheckin(todayDate);
      setCheckedDates((prev) => {
        const next = new Set(prev);
        next.add(todayDate);
        return next;
      });
    } catch (err) {
      console.warn("一键打卡失败", err);
      setNotice("打卡失败，请稍后重试。");
    } finally {
      setCheckinBusy(false);
    }
  }, [checkinBusy, todayChecked, todayDate, user]);
  const timeLabel = useMemo(
    () =>
      now.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    [now],
  );

  // MAX_WIDGETS is enforced per page. Page 0 includes the core check-in
  // widget in its count; later pages only count decorative widgets.
  const decoratedWidgetCount = useMemo(
    () => widgets.length + (activePageIdx === 0 ? 1 : 0),
    [widgets.length, activePageIdx],
  );

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => setIsMobileViewport(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    // 1Hz tick to drive the home clock + together-elapsed counter (which
    // shows seconds). Skip while the page is hidden — switching apps or
    // locking the phone shouldn't keep waking us every second to setState
    // on a tree nobody is looking at.
    const tick = () => {
      if (!document.hidden) {
        setNow(new Date());
      }
    };
    const intervalId = window.setInterval(tick, 1000);
    const onVisible = () => {
      // Catch up immediately when coming back from background.
      if (!document.hidden) setNow(new Date());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (isSettingsPage) {
      setEditMode(true);
    }
  }, [isSettingsPage]);

  useEffect(() => {
    const cached = loadHomeSettings();
    if (!cached) {
      setAppIconConfigs(defaultAppIconConfigs);
      setPrefsReady(true);
      return;
    }

    const safeIconOrder = DEFAULT_ICON_ORDER.filter((id) =>
      cached.iconOrder.includes(id),
    );
    const missing = DEFAULT_ICON_ORDER.filter(
      (id) => !safeIconOrder.includes(id),
    );
    setIconOrder([...safeIconOrder, ...missing]);

    // Load multi-page layout. The core checkin widget must live on
    // page 1, so even if the persisted layout somehow lost it (corrupt
    // state, legacy migration edge case) we splice it back onto the
    // first page's widgetOrder.
    const sourcePages: HomePageData[] =
      Array.isArray(cached.pages) && cached.pages.length > 0
        ? cached.pages
        : [{ widgetOrder: [CORE_WIDGET_ID], widgets: [] }];

    const restoredPages: HomePageData[] = sourcePages.map((page, pageIdx) => {
      const safeWidgets = page.widgets.filter(
        (widget) =>
          widget.type === "image" ||
          widget.type === "text" ||
          widget.type === "spacer" ||
          widget.type === "app_shortcut",
      );
      const widgetIds = new Set(safeWidgets.map((widget) => widget.id));
      const filteredOrder = page.widgetOrder.filter(
        (id) =>
          (pageIdx === 0 && id === CORE_WIDGET_ID) || widgetIds.has(id),
      );
      // Page 1 always starts with the core checkin widget.
      const nextOrder =
        pageIdx === 0
          ? Array.from(new Set([CORE_WIDGET_ID, ...filteredOrder]))
          : filteredOrder;
      return { widgetOrder: nextOrder, widgets: safeWidgets };
    });

    setPages(restoredPages);
    setActivePageIdx(0);
    setCheckinSize(cached.checkinSize ?? "1x1");
    setTogetherSince(cached.togetherSince ?? null);
    setShowEmptySlots(cached.showEmptySlots ?? false);
    setIconTileBgColor(cached.iconTileBgColor ?? DEFAULT_ICON_TILE_BG_COLOR);
    setIconTileBgOpacity(
      cached.iconTileBgOpacity ?? DEFAULT_ICON_TILE_BG_OPACITY,
    );
    const nextIconConfigs = Object.fromEntries(
      Object.entries({ ...defaultAppIconConfigs, ...(cached.appIconConfigs ?? {}) }).map(
        ([id, config]) => [
          id,
          config?.type === "emoji"
            ? { type: "emoji", emoji: config.emoji }
            : defaultAppIconConfigs[id],
        ],
      ),
    ) as AppIconState;
    setAppIconConfigs(nextIconConfigs);
    setPrefsReady(true);
  }, [defaultAppIconConfigs]);

  useEffect(() => {
    if (!prefsReady) {
      return;
    }

    saveHomeSettings({
      iconOrder,
      pages,
      checkinSize,
      togetherSince,
      showEmptySlots,
      iconTileBgColor,
      iconTileBgOpacity,
      appIconConfigs,
    });
  }, [
    appIconConfigs,
    checkinSize,
    togetherSince,
    iconOrder,
    iconTileBgColor,
    iconTileBgOpacity,
    showEmptySlots,
    pages,
    prefsReady,
  ]);

  // Flatten widgets across every page so image loading covers all
  // pages, not just the active one — otherwise swiping to an unloaded
  // page would briefly flash empty image widgets, and the trailing
  // setImageUrls reset would clobber the urls we already had.
  const allWidgets = useMemo(
    () => pages.flatMap((page) => page.widgets),
    [pages],
  );

  useEffect(() => {
    const imageWidgets = allWidgets.filter(
      (widget) => widget.type === "image",
    );

    const cachedEntries = imageWidgets
      .map((widget) => {
        if (
          typeof widget.imageDataUrl === "string" &&
          widget.imageDataUrl.length > 0
        ) {
          imageCache.set(widget.id, widget.imageDataUrl);
          return [widget.id, widget.imageDataUrl] as const;
        }
        const imageKey = widget.imageKey;
        if (!imageKey) {
          return null;
        }
        const cached = imageCache.get(imageKey);
        if (!cached) {
          return null;
        }
        return [widget.id, cached] as const;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry));

    if (cachedEntries.length > 0) {
      setImageUrls((current) => {
        const next = { ...current };
        let changed = false;
        cachedEntries.forEach(([id, url]) => {
          if (next[id] !== url) {
            next[id] = url;
            changed = true;
          }
        });
        return changed ? next : current;
      });
    }

    void Promise.all(
      imageWidgets.map(async (widget) => {
        if (
          typeof widget.imageDataUrl === "string" &&
          widget.imageDataUrl.length > 0
        ) {
          return { id: widget.id, url: widget.imageDataUrl };
        }
        if (!widget.imageKey) {
          return null;
        }
        const dataUrl = await loadImageDataUrl(widget.imageKey);
        if (!dataUrl) {
          return null;
        }
        imageCache.set(widget.imageKey, dataUrl);
        return { id: widget.id, url: dataUrl };
      }),
    ).then((results) => {
      setImageUrls((current) => {
        const next: Record<string, string> = {};
        results.forEach((entry) => {
          if (entry) {
            next[entry.id] = entry.url;
          }
        });
        const sameKeys =
          Object.keys(next).length === Object.keys(current).length &&
          Object.entries(next).every(([id, url]) => current[id] === url);
        return sameKeys ? current : next;
      });
    });
  }, [allWidgets]);



  const moveInList = (list: string[], fromId: string, toIndex: number) => {
    const fromIndex = list.indexOf(fromId);
    if (fromIndex < 0 || toIndex < 0 || toIndex >= list.length) {
      return list;
    }
    const next = [...list];
    const [item] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, item);
    return next;
  };

  const triggerEditModeByHold = () => {
    // Long-pressing any widget should drop into edit mode on both the
    // default home page and the dedicated /home-layout view. The
    // `isSettingsPage` gate that used to block this meant users had
    // no way to add or arrange widgets without first navigating to
    // /home-layout — non-obvious and the source of "没办法添加组件".
    if (editMode) {
      return;
    }
    holdTimerRef.current = window.setTimeout(() => {
      setEditMode(true);
    }, 450);
  };

  const cancelHold = () => {
    if (holdTimerRef.current) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const canAddWidget = decoratedWidgetCount < MAX_WIDGETS;
  const showSettingsPanel = isSettingsPage
    ? isMobileViewport
      ? mobileTab === "settings"
      : true
    : editMode;
  const showPreviewPanel = isSettingsPage
    ? isMobileViewport
      ? mobileTab === "preview"
      : true
    : true;

  const handleAddTextWidget = () => {
    if (!canAddWidget) {
      setNotice(`最多只能放 ${MAX_WIDGETS} 个组件`);
      return;
    }
    const id = `widget-text-${Date.now()}`;
    const text = window
      .prompt("输入文本组件内容", "今天也要开心！")
      ?.trim();
    if (!text) {
      return;
    }
    setWidgets((current) => [...current, { id, type: "text", text }]);
    setWidgetOrder((current) => [...current, id]);
  };

  const handleAddImageWidget = () => {
    if (!canAddWidget) {
      setNotice(`最多只能放 ${MAX_WIDGETS} 个组件`);
      return;
    }
    fileInputRef.current?.click();
  };

  const handleAddSpacerWidget = () => {
    if (!canAddWidget) {
      setNotice(`最多只能放 ${MAX_WIDGETS} 个组件`);
      return;
    }
    const id = `widget-spacer-${Date.now()}`;
    setWidgets((current) => [...current, { id, type: "spacer", size: "1x1" }]);
    setWidgetOrder((current) => [...current, id]);
  };

  const handleAddShortcutWidget = (appId: string) => {
    if (!appId) return
    if (!canAddWidget) {
      setNotice(`最多只能放 ${MAX_WIDGETS} 个组件`);
      return;
    }
    const id = `widget-shortcut-${appId}-${Date.now()}`;
    setWidgets((current) => [
      ...current,
      { id, type: "app_shortcut", appId, size: "1x1" },
    ]);
    setWidgetOrder((current) => [...current, id]);
  };

  const handleAddContentWidget = (
    contentType: "health_panel" | "screen_time" | "period",
  ) => {
    if (!canAddWidget) {
      setNotice(`最多只能放 ${MAX_WIDGETS} 个组件`);
      return;
    }
    const id = `widget-${contentType}-${Date.now()}`;
    setWidgets((current) => [
      ...current,
      { id, type: contentType, size: "1x1" },
    ]);
    setWidgetOrder((current) => [...current, id]);
  };

  // Unified picker handler for the "＋ 应用 / 组件" select. The value
  // is prefixed with "app:" or "content:" so we can dispatch to the
  // right add-handler without a second select.
  const handlePickerSelect = (rawValue: string) => {
    if (!rawValue) return
    const [kind, key] = rawValue.split(":")
    if (kind === "app") {
      handleAddShortcutWidget(key)
    } else if (kind === "content") {
      if (key === "health_panel" || key === "screen_time" || key === "period") {
        handleAddContentWidget(key)
      }
    }
  };

  const handleImageSelected = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (!canAddWidget) {
      setNotice(`最多只能放 ${MAX_WIDGETS} 个组件`);
      return;
    }
    const id = `widget-image-${Date.now()}`;
    try {
      const imageDataUrl = await readFileAsDataUrl(file);
      const imageKey = await saveImageDataUrl(imageDataUrl);
      setWidgets((current) => [
        ...current,
        { id, type: "image", imageKey, imageDataUrl, fit: "cover" },
      ]);
      setWidgetOrder((current) => [...current, id]);
    } catch (error) {
      console.warn("保存图片组件失败", error);
      setNotice("保存图片失败，请稍后再试");
    }
  };

  const removeWidget = async (id: string) => {
    const target = widgets.find((widget) => widget.id === id);
    if (!target) {
      return;
    }
    if (target.type === "image" && target.imageKey) {
      await removeImageData(target.imageKey);
    }
    setWidgets((current) => current.filter((widget) => widget.id !== id));
    setWidgetOrder((current) => current.filter((widgetId) => widgetId !== id));
  };


  const handleEmojiChange = (iconId: string, emoji: string) => {
    setAppIconConfigs((current) => ({
      ...current,
      [iconId]: {
        type: "emoji",
        emoji,
      },
    }));
  };


  const handleResetAppIcon = (iconId: string) => {
    const fallback = defaultAppIconConfigs[iconId] as {
      type: "emoji";
      emoji: string;
    };
    setAppIconConfigs((prev) => ({ ...prev, [iconId]: fallback }));
  };

  const iconTileBackground = useMemo(() => {
    const { r, g, b } = hexToRgb(iconTileBgColor);
    return `rgba(${r}, ${g}, ${b}, ${iconTileBgOpacity})`;
  }, [iconTileBgColor, iconTileBgOpacity]);

  // Builds the renderable list for any page. Each page has its own
  // widgetOrder/widgets, so the renderer just calls this once per page
  // during the map. The checkin widget only ever appears on page 0,
  // but if a future bug ever resurrected its id on another page we
  // still render it consistently here.
  const buildPageItems = useCallback(
    (page: HomePageData): RenderedWidgetItem[] => {
      const widgetMap = new Map(
        page.widgets.map((widget) => [widget.id, widget]),
      );
      return page.widgetOrder
        .map((id) => {
          if (id === CORE_WIDGET_ID) {
            return { id, kind: "checkin", size: checkinSize };
          }
          const widget = widgetMap.get(id);
          if (!widget) {
            return null;
          }
          return {
            id,
            kind: "decorative",
            widget,
            size: widget.size ?? "1x1",
          };
        })
        .filter((item): item is RenderedWidgetItem => Boolean(item));
    },
    [checkinSize],
  );

  const handleWidgetSizeChange = (id: string, size: WidgetSize) => {
    if (id === CORE_WIDGET_ID) {
      setCheckinSize(size);
      return;
    }
    setWidgets((current) =>
      current.map((widget) =>
        widget.id === id ? { ...widget, size } : widget,
      ),
    );
  };

  const handleWidgetDropOnItem = (
    event: React.DragEvent<HTMLElement>,
    targetId: string,
  ) => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/widget-id");
    if (!sourceId || sourceId === targetId) {
      return;
    }
    setWidgetOrder((current) => {
      const fromIndex = current.indexOf(sourceId);
      const toIndex = current.indexOf(targetId);
      if (fromIndex < 0 || toIndex < 0) {
        return current;
      }
      return moveInList(current, sourceId, toIndex);
    });
  };

  return (
    <main
      className={`home-page app-shell ${isSettingsPage ? "home-page--settings" : ""}`}
      style={
        {
          "--icon-tile-bg": iconTileBackground,
        } as CSSProperties
      }
    >
      <div
        className={`phone-shell ${isSettingsPage ? "phone-shell--settings" : ""}`}
      >
        <div className="phone-shell__mask" aria-hidden="true" />
        <div className="phone-shell__content">
          <div className="home-page__header app-shell__header">
            <header className="home-header">
              {isSettingsPage ? (
                <>
                  <button
                    type="button"
                    className="edit-button edit-button-back"
                    onClick={() => navigate(-1)}
                  >
                    返回
                  </button>
                  <button
                    type="button"
                    className="edit-button"
                    onClick={() => navigate("/")}
                  >
                    完成
                  </button>
                  <h1 className="ui-title">主页布局</h1>
                  <p>编辑组件并实时预览</p>
                  {isMobileViewport ? (
                    <div
                      className="home-mode-toggle"
                      role="tablist"
                      aria-label="设置预览切换"
                    >
                      <button
                        type="button"
                        className={mobileTab === "settings" ? "active" : ""}
                        onClick={() => setMobileTab("settings")}
                      >
                        设置
                      </button>
                      <button
                        type="button"
                        className={mobileTab === "preview" ? "active" : ""}
                        onClick={() => setMobileTab("preview")}
                      >
                        预览
                      </button>
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="edit-button"
                    onClick={() => {
                      // Toggle inline edit mode on the default home
                      // page instead of bouncing to /home-layout.
                      // /home-layout is still reachable via the
                      // settings menu for deep customisation.
                      if (editMode) {
                        setEditMode(false)
                        setEditPreviewing(false)
                      } else {
                        setEditMode(true)
                      }
                    }}
                  >
                    {editMode ? "完成" : "编辑"}
                  </button>
                  {editMode ? (
                    <button
                      type="button"
                      className="edit-button edit-button-back"
                      onClick={() => setEditPreviewing((v) => !v)}
                      aria-label={editPreviewing ? "回到编辑" : "预览效果"}
                    >
                      {editPreviewing ? "编辑" : "预览"}
                    </button>
                  ) : null}
                  <h1 className="ui-title ui-numeric home-clock-title">{timeLabel}</h1>
                  <p>{dateLabel}</p>
                </>
              )}
            </header>

            {notice ? <p className="home-notice">{notice}</p> : null}

            {showSettingsPanel && !editPreviewing ? (
              <section className="glass-card widget-toolbar">
                <header className="widget-toolbar-header">
                  <span className="widget-toolbar-label">组件</span>
                  <span className="widget-toolbar-count">
                    {decoratedWidgetCount}/{MAX_WIDGETS}
                  </span>
                  <div
                    className="widget-toolbar-progress"
                    role="presentation"
                  >
                    <span
                      className="widget-toolbar-progress-fill"
                      style={{
                        width: `${Math.min(100, (decoratedWidgetCount / MAX_WIDGETS) * 100)}%`,
                      }}
                    />
                  </div>
                </header>
                <div className="widget-toolbar-grid">
                  <button
                    type="button"
                    className="ghost"
                    onClick={handleAddTextWidget}
                  >
                    ＋ 文本
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={handleAddImageWidget}
                  >
                    ＋ 图片
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={handleAddSpacerWidget}
                  >
                    ＋ 占位
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setShowEmptySlots((value) => !value)}
                  >
                    {showEmptySlots ? "隐藏空位" : "显示空位"}
                  </button>
                </div>
                <label className="ghost widget-shortcut-picker">
                  ＋ 应用 / 组件
                  <select
                    aria-label="选择要添加的应用或内容组件"
                    defaultValue=""
                    onChange={(event) => {
                      handlePickerSelect(event.target.value)
                      event.target.value = ""
                    }}
                  >
                    <option value="" disabled>
                      选择…
                    </option>
                    <optgroup label="内容组件">
                      <option value="content:health_panel">🫀 健康面板</option>
                      <option value="content:screen_time">📱 屏幕时间</option>
                      <option value="content:period">🌸 经期</option>
                    </optgroup>
                    <optgroup label="应用快捷方式">
                      {appIcons.map((icon) => (
                        <option key={icon.id} value={`app:${icon.id}`}>
                          {icon.defaultEmoji} {icon.label}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(event) => void handleImageSelected(event)}
                />
              </section>
            ) : null}

            {/* Appearance + icon emoji editor are deep-customisation
                panels — only show them on /home-layout. In-place edit
                on the main home page only needs the widget toolbar
                above so the user can still see the live grid. */}
            {showSettingsPanel && isSettingsPage ? (
              <section className="glass-card appearance-toolbar">
                <h2 className="ui-title">外观</h2>
                <label>
                  图标底色
                  <input
                    type="color"
                    value={iconTileBgColor}
                    onChange={(event) => setIconTileBgColor(event.target.value)}
                  />
                </label>
                <label>
                  图标透明度 {Math.round(iconTileBgOpacity * 100)}%
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round(iconTileBgOpacity * 100)}
                    onChange={(event) =>
                      setIconTileBgOpacity(Number(event.target.value) / 100)
                    }
                  />
                </label>
              </section>
            ) : null}

            {/* Editable icon emoji is now also reachable from the
                main home page's edit mode — keeps the LINE-style
                "dropdown app + emoji text input" affordance the user
                liked, instead of a window.prompt popup. */}
            {showSettingsPanel ? (
              <section className="glass-card icon-editor-toolbar">
                <h2 className="ui-title">编辑图标</h2>
                <label>
                  应用
                  <select
                    value={editingIconId}
                    onChange={(event) => setEditingIconId(event.target.value)}
                  >
                    {iconOrder.map((iconId) => {
                      const icon = iconMap.get(iconId);
                      return icon ? (
                        <option key={iconId} value={iconId}>
                          {icon.label}
                        </option>
                      ) : null;
                    })}
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
                    onChange={(event) =>
                      handleEmojiChange(editingIconId, event.target.value)
                    }
                    placeholder="输入 emoji"
                    maxLength={4}
                  />
                </label>
                <div className="background-controls">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void handleResetAppIcon(editingIconId)}
                  >
                    恢复默认
                  </button>
                </div>
              </section>
            ) : null}
          </div>

          {showPreviewPanel ? (
            <div className="home-page__content app-shell__content">
              <div className="home-layout">
                <div
                  className="widget-pages"
                  ref={pagesScrollRef}
                  onScroll={handlePagesScroll}
                >
                  {pages.map((page, pageIdx) => {
                    const pageItems = buildPageItems(page);
                    return (
                      <section
                        key={pageIdx}
                        className="widget-page widget-grid home-widget-stage"
                        aria-label={`Widgets page ${pageIdx + 1}`}
                      >
                        {pageItems.map((item) => {
                          const isCheckin = item.kind === "checkin";
                          const widget = item.widget;
                          const isSpacer = widget?.type === "spacer";

                          return (
                            <article
                              key={item.id}
                              className={`glass-card widget-card ${item.size === "2x1" ? "widget-card-wide" : ""} ${isSpacer ? "spacer-card" : ""}`}
                              draggable={editMode}
                              onDragStart={(event) =>
                                event.dataTransfer.setData(
                                  "text/widget-id",
                                  item.id,
                                )
                              }
                              onDragOver={(event) =>
                                editMode && event.preventDefault()
                              }
                              onDrop={(event) =>
                                editMode &&
                                handleWidgetDropOnItem(event, item.id)
                              }
                              onPointerDown={triggerEditModeByHold}
                              onPointerUp={cancelHold}
                              onPointerLeave={cancelHold}
                            >
                              {editMode ? (
                                <div className="widget-controls">
                                  {/* Size selector hidden for shortcut tiles
                                      — app icons should stay 1x1; only text
                                      / image / spacer / content widgets can
                                      flip between small and wide. */}
                                  {widget?.type !== "app_shortcut" ? (
                                    <label>
                                      尺寸
                                      <select
                                        value={item.size}
                                        onChange={(event) =>
                                          handleWidgetSizeChange(
                                            item.id,
                                            event.target.value as WidgetSize,
                                          )
                                        }
                                      >
                                        <option value="1x1">小</option>
                                        <option value="2x1">大</option>
                                      </select>
                                    </label>
                                  ) : null}
                                  {/* Emoji editing happens in the
                                      .icon-editor-toolbar section that
                                      now renders inline below the
                                      widget grid in edit mode — same
                                      dropdown + text-input UI the
                                      /home-layout page uses. */}
                                  {!isCheckin && widget ? (
                                    <button
                                      type="button"
                                      className="widget-delete"
                                      onClick={() =>
                                        void removeWidget(widget.id)
                                      }
                                    >
                                      ×
                                    </button>
                                  ) : null}
                                </div>
                              ) : null}
                              {isCheckin ? (
                                <article
                                  className={`together-inner ${item.size === "2x1" ? "together-wide" : ""}`}
                                >
                                  <div className="together-header">
                                    <span className="together-date">
                                      {dateLabel}
                                    </span>
                                    {togetherElapsed ? (
                                      <span className="together-days-pill">
                                        ❤️ {togetherElapsed.days} 天
                                      </span>
                                    ) : null}
                                  </div>
                                  {togetherElapsed ? (
                                    <div className="together-counter-stack">
                                      <div className="together-counter-headline">
                                        <strong>{togetherElapsed.days}</strong>
                                        <span>Days Together</span>
                                      </div>
                                      {item.size === "2x1" ? (
                                        <div className="together-counter-sub">
                                          {String(
                                            togetherElapsed.hours,
                                          ).padStart(2, "0")}
                                          :
                                          {String(
                                            togetherElapsed.minutes,
                                          ).padStart(2, "0")}
                                          :
                                          {String(
                                            togetherElapsed.seconds,
                                          ).padStart(2, "0")}
                                        </div>
                                      ) : null}
                                    </div>
                                  ) : (
                                    <div className="together-empty">
                                      {editMode
                                        ? "下方填写起始时间"
                                        : "进入编辑模式设置起始时间"}
                                    </div>
                                  )}
                                  <div
                                    className="together-week"
                                    role="list"
                                    aria-label="本周打卡"
                                  >
                                    {weekDates.map((iso, index) => {
                                      const checked = checkedDates.has(iso);
                                      const isToday = iso === todayDate;
                                      return (
                                        <div
                                          key={iso}
                                          role="listitem"
                                          className={`together-week-cell${checked ? " is-checked" : ""}${isToday ? " is-today" : ""}`}
                                        >
                                          <span
                                            className="together-week-dot"
                                            aria-hidden="true"
                                          >
                                            {checked ? "✓" : ""}
                                          </span>
                                          <span className="together-week-label">
                                            {WEEK_DAY_LABELS[index]}
                                          </span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                  {!editMode ? (
                                    <button
                                      type="button"
                                      className={`together-checkin-btn${todayChecked ? " is-done" : ""}`}
                                      onClick={(event) => {
                                        // Stop the pointer-hold edit-mode trigger
                                        // from swallowing this tap, otherwise long
                                        // taps still work but the actual click is
                                        // sometimes treated as the hold release.
                                        event.stopPropagation();
                                        void handleQuickCheckin();
                                      }}
                                      disabled={
                                        todayChecked || checkinBusy || !user
                                      }
                                    >
                                      {todayChecked
                                        ? "今日已陪伴 💖"
                                        : checkinBusy
                                          ? "打卡中…"
                                          : "今日打卡 💗"}
                                    </button>
                                  ) : null}
                                  {editMode ? (
                                    <label className="together-input">
                                      <span>起始时间</span>
                                      <input
                                        type="datetime-local"
                                        value={togetherInputValue}
                                        onChange={(event) =>
                                          handleTogetherSinceChange(
                                            event.target.value,
                                          )
                                        }
                                      />
                                    </label>
                                  ) : null}
                                </article>
                              ) : widget ? (
                                widget.type === "text" ? (
                                  <p className="text-widget">{widget.text}</p>
                                ) : widget.type === "spacer" ? (
                                  editMode ? (
                                    <div className="spacer-editor">占位</div>
                                  ) : null
                                ) : widget.type === "app_shortcut" ? (
                                  (() => {
                                    const targetIcon = iconMap.get(widget.appId)
                                    if (!targetIcon) {
                                      return (
                                        <div className="shortcut-widget shortcut-widget--missing">
                                          <span className="shortcut-emoji">❔</span>
                                          <span className="shortcut-label">未知应用</span>
                                        </div>
                                      )
                                    }
                                    const configured = appIconConfigs[targetIcon.id]
                                    const emoji = configured?.emoji ?? targetIcon.defaultEmoji
                                    return (
                                      <button
                                        type="button"
                                        className="shortcut-widget"
                                        onClick={(event) => {
                                          // Edit mode swallows the click so
                                          // the long-press handler can do its
                                          // job (drag / resize); only navigate
                                          // when we're not editing.
                                          if (editMode) return
                                          event.stopPropagation()
                                          if (targetIcon.action) {
                                            targetIcon.action()
                                          } else if (targetIcon.route) {
                                            navigate(targetIcon.route)
                                          }
                                        }}
                                      >
                                        <span className="shortcut-emoji">{emoji}</span>
                                        <span className="shortcut-label">{targetIcon.label}</span>
                                      </button>
                                    )
                                  })()
                                ) : widget.type === "health_panel" ? (
                                  <button
                                    type="button"
                                    className={`content-widget content-widget--health ${item.size === "2x1" ? "content-widget--wide" : ""}`}
                                    onClick={(event) => {
                                      if (editMode) return
                                      event.stopPropagation()
                                      navigate("/health-sync")
                                    }}
                                  >
                                    <header className="content-widget__title">
                                      <span aria-hidden="true">🫀</span>
                                      <span>今日健康</span>
                                    </header>
                                    {widgetData.healthRow ? (
                                      item.size === "2x1" ? (
                                        <div className="content-widget__grid">
                                          <div>
                                            <span className="label">步数</span>
                                            <span className="value">{widgetData.healthRow.steps ?? "—"}</span>
                                          </div>
                                          <div>
                                            <span className="label">睡眠</span>
                                            <span className="value">
                                              {widgetData.healthRow.sleep_hours != null ? `${widgetData.healthRow.sleep_hours}h` : "—"}
                                            </span>
                                          </div>
                                          <div>
                                            <span className="label">心率</span>
                                            <span className="value">{widgetData.healthRow.heart_rate_avg ?? "—"}</span>
                                          </div>
                                          <div>
                                            <span className="label">血氧</span>
                                            <span className="value">
                                              {widgetData.healthRow.oxygen_saturation_avg != null
                                                ? `${widgetData.healthRow.oxygen_saturation_avg}%`
                                                : "—"}
                                            </span>
                                          </div>
                                        </div>
                                      ) : (
                                        <div className="content-widget__stack">
                                          <div className="content-widget__hero">
                                            <strong>{widgetData.healthRow.steps ?? "—"}</strong>
                                            <span>步</span>
                                          </div>
                                          <div className="content-widget__sub">
                                            {widgetData.healthRow.sleep_hours != null
                                              ? `睡 ${widgetData.healthRow.sleep_hours}h`
                                              : "暂无睡眠"}
                                          </div>
                                        </div>
                                      )
                                    ) : (
                                      <div className="content-widget__empty">还没记录</div>
                                    )}
                                  </button>
                                ) : widget.type === "screen_time" ? (
                                  <button
                                    type="button"
                                    className={`content-widget content-widget--screen ${item.size === "2x1" ? "content-widget--wide" : ""}`}
                                    onClick={(event) => {
                                      if (editMode) return
                                      event.stopPropagation()
                                      navigate("/health-sync")
                                    }}
                                  >
                                    <header className="content-widget__title">
                                      <span aria-hidden="true">📱</span>
                                      <span>屏幕时间</span>
                                    </header>
                                    {widgetData.screenTime && widgetData.screenTime.total_minutes > 0 ? (
                                      item.size === "2x1" ? (
                                        <div className="content-widget__screen-body">
                                          <div className="content-widget__hero">
                                            <strong>
                                              {Math.floor(widgetData.screenTime.total_minutes / 60)}h{" "}
                                              {widgetData.screenTime.total_minutes % 60}m
                                            </strong>
                                          </div>
                                          <ul className="content-widget__top-list">
                                            {widgetData.screenTime.top_apps.slice(0, 3).map((app) => (
                                              <li key={app.name}>
                                                <span>{app.name}</span>
                                                <span>
                                                  {Math.floor(app.minutes / 60) > 0
                                                    ? `${Math.floor(app.minutes / 60)}h${app.minutes % 60}m`
                                                    : `${app.minutes}m`}
                                                </span>
                                              </li>
                                            ))}
                                          </ul>
                                        </div>
                                      ) : (
                                        <div className="content-widget__stack">
                                          <div className="content-widget__hero">
                                            <strong>
                                              {Math.floor(widgetData.screenTime.total_minutes / 60)}h{" "}
                                              {widgetData.screenTime.total_minutes % 60}m
                                            </strong>
                                          </div>
                                          <div className="content-widget__sub">今日总时长</div>
                                        </div>
                                      )
                                    ) : (
                                      <div className="content-widget__empty">还没记录</div>
                                    )}
                                  </button>
                                ) : widget.type === "period" ? (
                                  <button
                                    type="button"
                                    className={`content-widget content-widget--period ${item.size === "2x1" ? "content-widget--wide" : ""}`}
                                    onClick={(event) => {
                                      if (editMode) return
                                      event.stopPropagation()
                                      navigate("/health-sync")
                                    }}
                                  >
                                    <header className="content-widget__title">
                                      <span aria-hidden="true">🌸</span>
                                      <span>经期</span>
                                    </header>
                                    {widgetData.periodMetrics ? (
                                      item.size === "2x1" ? (
                                        <div className="content-widget__period-body">
                                          <div className="content-widget__hero">
                                            <strong>第 {widgetData.periodMetrics.cycleDay} 天</strong>
                                            <span>{widgetData.periodMetrics.phase}</span>
                                          </div>
                                          <div className="content-widget__sub">
                                            {widgetData.periodMetrics.daysToNext > 0
                                              ? `下次 ${widgetData.periodMetrics.daysToNext} 天后`
                                              : widgetData.periodMetrics.daysToNext === 0
                                                ? "今天"
                                                : `已超出 ${-widgetData.periodMetrics.daysToNext} 天`}
                                            {" · 周期 "}
                                            {widgetData.periodMetrics.cycleLength}d
                                          </div>
                                        </div>
                                      ) : (
                                        <div className="content-widget__stack">
                                          <div className="content-widget__hero">
                                            <strong>D{widgetData.periodMetrics.cycleDay}</strong>
                                          </div>
                                          <div className="content-widget__sub">
                                            {widgetData.periodMetrics.phase}
                                          </div>
                                          <div className="content-widget__sub">
                                            {widgetData.periodMetrics.daysToNext > 0
                                              ? `下次 ${widgetData.periodMetrics.daysToNext}d`
                                              : "已迟"}
                                          </div>
                                        </div>
                                      )
                                    ) : (
                                      <div className="content-widget__empty">还没记录</div>
                                    )}
                                  </button>
                                ) : (
                                  <img
                                    className="image-widget"
                                    src={imageUrls[widget.id]}
                                    style={{
                                      objectFit: widget.fit ?? "cover",
                                    }}
                                    alt="本地图片组件"
                                  />
                                )
                              ) : null}
                            </article>
                          );
                        })}
                        {editMode && showEmptySlots
                          ? Array.from({
                              length: Math.max(
                                MAX_WIDGETS - pageItems.length,
                                0,
                              ),
                            }).map((_, index) => (
                              <div
                                key={`empty-${pageIdx}-${index}`}
                                className="widget-placeholder"
                                aria-hidden="true"
                              />
                            ))
                          : null}
                      </section>
                    );
                  })}
                </div>
                <div className="widget-page-dots">
                  {pages.map((_, i) => (
                    <span
                      key={i}
                      className={i === activePageIdx ? "is-active" : ""}
                      onClick={() => scrollToPage(i)}
                    />
                  ))}
                  {editMode ? (
                    <>
                      <button
                        type="button"
                        className="widget-page-add"
                        onClick={addPage}
                        aria-label="添加新页"
                      >
                        ＋
                      </button>
                      {activePageIdx > 0 && pages.length > 1 ? (
                        <button
                          type="button"
                          className="widget-page-remove"
                          aria-label="删除当前页"
                          onClick={() => {
                            if (window.confirm("确定删除这一页？组件会一起删掉。")) {
                              removeActivePage()
                            }
                          }}
                        >
                          ×
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>

                {/* Bottom dock removed — every app is now a shortcut
                    tile on page 0. iconOrder still survives for the
                    /home-layout emoji editor; appIconConfigs flows
                    through to the shortcut widgets. */}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
};

export default HomePage;
