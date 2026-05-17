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
} from "../storage/homeLayout";
import "./HomePage.css";

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
  "chat",
  "checkin",
  "memory",
  "snacks",
  "syzygy",
  "usage",
  "settings",
  "export",
];
const CORE_WIDGET_ID = "widget-checkin";
const MAX_WIDGETS = 6;
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

const HomePage = ({ onOpenChat, mode = "default" }: HomePageProps) => {
  const isSettingsPage = mode === "settings";
  const navigate = useNavigate();
  const [now, setNow] = useState(() => new Date());

  const [editMode, setEditMode] = useState(false);
  const [mobileTab, setMobileTab] = useState<"settings" | "preview">(
    "settings",
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [prefsReady, setPrefsReady] = useState(false);

  const [iconOrder, setIconOrder] = useState<string[]>(DEFAULT_ICON_ORDER);
  const [widgetOrder, setWidgetOrder] = useState<string[]>([CORE_WIDGET_ID]);
  const [widgets, setWidgets] = useState<DecorativeWidget[]>([]);
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

  const holdTimerRef = useRef<number | null>(null);

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
      { id: "snacks", defaultEmoji: "🍪", label: "我的主页", route: "/snacks" },
      { id: "syzygy", defaultEmoji: "📘", label: "TA的主页", route: "/syzygy" },
      { id: "usage", defaultEmoji: "📊", label: "用量统计", route: "/usage" },
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
  const timeLabel = useMemo(
    () =>
      now.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    [now],
  );

  const decoratedWidgetCount = useMemo(
    () => widgets.length + 1,
    [widgets.length],
  );

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => setIsMobileViewport(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => window.clearInterval(intervalId);
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

    const safeWidgets = cached.widgets.filter(
      (widget) =>
        widget.type === "image" ||
        widget.type === "text" ||
        widget.type === "spacer",
    );
    const widgetIds = safeWidgets.map((widget) => widget.id);
    const restoredOrder = cached.widgetOrder.filter(
      (id) => id === CORE_WIDGET_ID || widgetIds.includes(id),
    );
    setWidgets(safeWidgets);
    setWidgetOrder(Array.from(new Set([CORE_WIDGET_ID, ...restoredOrder])));
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
      widgetOrder,
      widgets,
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
    widgetOrder,
    widgets,
    prefsReady,
  ]);

  useEffect(() => {
    const imageWidgets = widgets.filter((widget) => widget.type === "image");

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
  }, [widgets]);



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

  const handleIconDrop = (
    event: React.DragEvent<HTMLDivElement>,
    targetIndex: number,
  ) => {
    event.preventDefault();
    const sourceId = event.dataTransfer.getData("text/icon-id");
    if (!sourceId) {
      return;
    }
    setIconOrder((current) => moveInList(current, sourceId, targetIndex));
  };

  const triggerEditModeByHold = () => {
    if (!isSettingsPage || editMode) {
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

  const orderedWidgetItems = useMemo<RenderedWidgetItem[]>(() => {
    const widgetMap = new Map(widgets.map((widget) => [widget.id, widget]));
    return widgetOrder
      .map((id) => {
        if (id === CORE_WIDGET_ID) {
          return { id, kind: "checkin", size: checkinSize };
        }
        const widget = widgetMap.get(id);
        if (!widget) {
          return null;
        }
        return { id, kind: "decorative", widget, size: widget.size ?? "1x1" };
      })
      .filter((item): item is RenderedWidgetItem => Boolean(item));
  }, [checkinSize, widgetOrder, widgets]);

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
                    onClick={() => navigate("/home-layout")}
                  >
                    编辑
                  </button>
                  <h1 className="ui-title ui-numeric home-clock-title">{timeLabel}</h1>
                  <p>{dateLabel}</p>
                </>
              )}
            </header>

            {notice ? <p className="home-notice">{notice}</p> : null}

            {showSettingsPanel ? (
              <section className="glass-card widget-toolbar">
                <button
                  type="button"
                  className="ghost"
                  onClick={handleAddTextWidget}
                >
                  + 文本组件
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={handleAddImageWidget}
                >
                  + 图片组件
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={handleAddSpacerWidget}
                >
                  + 占位组件
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setShowEmptySlots((value) => !value)}
                >
                  {showEmptySlots ? "隐藏空位" : "显示空位"}
                </button>
                <span>
                  {decoratedWidgetCount}/{MAX_WIDGETS} 组件
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(event) => void handleImageSelected(event)}
                />
              </section>
            ) : null}

            {showSettingsPanel ? (
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
                <section
                  className="widget-grid home-widget-stage"
                  aria-label="Widgets"
                >
                  {orderedWidgetItems.map((item) => {
                    const isCheckin = item.kind === "checkin";
                    const widget = item.widget;
                    const isSpacer = widget?.type === "spacer";

                    return (
                      <article
                        key={item.id}
                        className={`glass-card widget-card ${item.size === "2x1" ? "widget-card-wide" : ""} ${isSpacer ? "spacer-card" : ""}`}
                        draggable={editMode}
                        onDragStart={(event) =>
                          event.dataTransfer.setData("text/widget-id", item.id)
                        }
                        onDragOver={(event) =>
                          editMode && event.preventDefault()
                        }
                        onDrop={(event) =>
                          editMode && handleWidgetDropOnItem(event, item.id)
                        }
                        onPointerDown={triggerEditModeByHold}
                        onPointerUp={cancelHold}
                        onPointerLeave={cancelHold}
                      >
                        {editMode ? (
                          <div className="widget-controls">
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
                            {!isCheckin && widget ? (
                              <button
                                type="button"
                                className="widget-delete"
                                onClick={() => void removeWidget(widget.id)}
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
                            <div className="together-date">{dateLabel}</div>
                            {togetherElapsed ? (
                              item.size === "2x1" ? (
                                <div className="together-counter together-counter-wide">
                                  <div className="together-counter-main">
                                    <strong>{togetherElapsed.days}</strong>
                                    <span>天</span>
                                  </div>
                                  <div className="together-counter-sub">
                                    {String(togetherElapsed.hours).padStart(2, "0")}:
                                    {String(togetherElapsed.minutes).padStart(2, "0")}:
                                    {String(togetherElapsed.seconds).padStart(2, "0")}
                                  </div>
                                </div>
                              ) : (
                                <div className="together-counter">
                                  <strong>{togetherElapsed.days}</strong>
                                  <span className="together-counter-unit">天</span>
                                  <span className="together-counter-time">
                                    {String(togetherElapsed.hours).padStart(2, "0")}:
                                    {String(togetherElapsed.minutes).padStart(2, "0")}:
                                    {String(togetherElapsed.seconds).padStart(2, "0")}
                                  </span>
                                </div>
                              )
                            ) : (
                              <div className="together-empty">
                                {editMode ? "下方填写起始时间" : "进入编辑模式设置起始时间"}
                              </div>
                            )}
                            {editMode ? (
                              <label className="together-input">
                                <span>起始时间</span>
                                <input
                                  type="datetime-local"
                                  value={togetherInputValue}
                                  onChange={(event) =>
                                    handleTogetherSinceChange(event.target.value)
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
                          ) : (
                            <img
                              className="image-widget"
                              src={imageUrls[widget.id]}
                              style={{ objectFit: widget.fit ?? "cover" }}
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
                          MAX_WIDGETS - orderedWidgetItems.length,
                          0,
                        ),
                      }).map((_, index) => (
                        <div
                          key={`empty-${index}`}
                          className="widget-placeholder"
                          aria-hidden="true"
                        />
                      ))
                    : null}
                </section>

                <section className="home-dock" aria-label="Apps">
                  {iconOrder.map((iconId, index) => {
                    const icon = iconMap.get(iconId);
                    if (!icon) {
                      return null;
                    }

                    const configured = appIconConfigs[iconId] ?? {
                      type: "emoji",
                      emoji: icon.defaultEmoji,
                    };
                    const emojiValue = configured.emoji || icon.defaultEmoji;

                    return (
                      <div
                        key={icon.id}
                        className="app-icon-slot"
                        onDragOver={(event) =>
                          editMode && event.preventDefault()
                        }
                        onDrop={(event) =>
                          editMode && handleIconDrop(event, index)
                        }
                      >
                        <button
                          type="button"
                          className="app-icon-button"
                          draggable={editMode}
                          onDragStart={(event) =>
                            event.dataTransfer.setData("text/icon-id", icon.id)
                          }
                          onPointerDown={triggerEditModeByHold}
                          onPointerUp={cancelHold}
                          onPointerLeave={cancelHold}
                          onClick={() => {
                            if (editMode) {
                              setEditingIconId(icon.id);
                              return;
                            }
                            if (icon.action) {
                              icon.action();
                              return;
                            }
                            if (icon.route) {
                              navigate(icon.route);
                            }
                          }}
                        >
                          <span className="icon-emoji">
                            <span>{emojiValue}</span>
                          </span>
                          <span className="icon-label">{icon.label}</span>
                        </button>
                      </div>
                    );
                  })}
                </section>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
};

export default HomePage;
