import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import easyPtoLogo from "./assets/easypto-logo.svg";
import easyPtoLogoDark from "./assets/easypto-logo-dark.svg";
import easyPtoMark from "./assets/easypto-mark.svg";
import "./App.css";
import { exportConstructionExcel, exportConstructionWord, exportExcel, exportWord, type ReportSnapshot } from "./report";
import { ChatModule } from "./Chat";

type DatabaseStatus = { schemaVersion: number; currentSchemaVersion: number };
type ProjectListItem = {
  id: string;
  name: string;
  routeStart: number;
  routeEnd: number;
  address: string;
  updatedAt: string;
};
type Interval = { fromCentiPk: number; toCentiPk: number };
type WorkArea = { id: string; kind: "main" | "bridge" | "custom"; name: string; intervals: Interval[] };
type Exclusion = { id: string; name: string; intervals: Interval[]; reason: string; appliesToLayerIds: string[]; workAreaIds: string[] };
type JournalEvent = { id: string; happenedAt: string; action: string; entityType: string; entityId: string | null; summary: string; beforeJson: string | null; afterJson: string | null };
type BackupEntry = { fileName: string; createdAt: string; projectNames: string[]; source: string; diagnostic: string | null };
type Segment = {
  id: string;
  workAreaId: string;
  fromCentiPk: number;
  toCentiPk: number;
  workDate: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};
type LayerSnapshot = {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  color: string;
  baseLayerId: string | null;
  planPercent: number | null;
  planDate: string | null;
  workAreaIds: string[];
  segments: Segment[];
  workAreaLengthCentiPk: number;
  coveredLengthCentiPk: number;
  remainingLengthCentiPk: number;
  progressPercent: number;
  planDeltaPp: number | null;
  coveredIntervals: Interval[];
  frontIntervals: Interval[];
  frontLengthCentiPk: number;
};
type ProjectSnapshot = {
  project: ProjectListItem;
  calculationVersion: string;
  bridgeEnabled: boolean;
  bridgeAreaId: string | null;
  workAreas: WorkArea[];
  exclusions: Exclusion[];
  journal: JournalEvent[];
  layers: LayerSnapshot[];
  summary: {
    workAreaLengthCentiPk: number;
    coveredLengthCentiPk: number;
    remainingLengthCentiPk: number;
    progressPercent: number;
    layersBehindPlan: number;
  };
};
type ConstructionProgressEntry = { id: string; amount: number; happenedAt: string };
type ConstructionUnit = "pieces" | "meters" | "kilometers" | "square_meters" | "cubic_meters" | "kilograms" | "tonnes";
type ConstructionLine = {
  id: string;
  name: string;
  unit: ConstructionUnit;
  plannedAmount: number;
  completedAmount: number;
  progressPercent: number;
  sortOrder: number;
  entries: ConstructionProgressEntry[];
};
type ConstructionSnapshot = { project: ProjectListItem; lines: ConstructionLine[]; progressPercent: number };
type ConstructionLineForm = { name: string; unit: ConstructionUnit; plannedAmount: string };
type ActiveModule = "layers" | "construction" | "chat" | "settings";
const getStartupModule = (): "layers" | "construction" => {
  try {
    return localStorage.getItem("easypto.startModule") === "construction" ? "construction" : "layers";
  } catch {
    return "layers";
  }
};
const getSavedTheme = (): "light" | "dark" => {
  try {
    return localStorage.getItem("easypto.theme") === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
};
type ConstructionDeleteTarget =
  | { kind: "line"; line: ConstructionLine }
  | { kind: "entry"; line: ConstructionLine; entry: ConstructionProgressEntry };
const areaProgress = (projectSnapshot: ProjectSnapshot, areaId: string | null, enabled = true) => {
  if (!enabled || !areaId) return { covered: 0, total: 0, percent: 0 };
  const area = projectSnapshot.workAreas.find((item) => item.id === areaId);
  if (!area) return { covered: 0, total: 0, percent: 0 };
  const layers = projectSnapshot.layers.filter((layer) => layer.workAreaIds.includes(area.id));
  const areaLength = intervalLength(area.intervals);
  const covered = layers.reduce((sum, layer) => {
    const coverage = intersectIntervals(
      mergeIntervals(layer.segments.filter((segment) => segment.workAreaId === area.id).map((segment) => ({ fromCentiPk: segment.fromCentiPk, toCentiPk: segment.toCentiPk }))),
      area.intervals,
    );
    const cuts = projectSnapshot.exclusions.filter((exclusion) => exclusion.appliesToLayerIds.includes(layer.id) && exclusion.workAreaIds.includes(area.id)).flatMap((exclusion) => exclusion.intervals);
    return sum + intervalLength(subtractIntervals(coverage, cuts));
  }, 0);
  const total = areaLength * layers.length;
  return { covered, total, percent: total ? covered * 100 / total : 0 };
};
type LayerInput = {
  code: string;
  name: string;
  color: string;
  planPercent: number | null;
  planDate: string | null;
};
type SegmentInput = { workAreaId: string; fromPk: string; toPk: string; workDate: string; note: string | null };
type Filter = "all" | "unfinished" | "behind";
type LayerForm = { code: string; name: string; color: string; planPercent: string; planDate: string };
type SegmentForm = { workAreaId: string; fromPk: string; toPk: string; workDate: string; note: string };
type BridgeForm = { enabled: boolean; fromPk: string; toPk: string; layerIds: string[] };
type ExclusionForm = { id: string | null; name: string; reason: string; fromPk: string; toPk: string; layerIds: string[]; workAreaIds: string[] };
type WorkAreaForm = { name: string; fromPk: string; toPk: string; layerIds: string[] };

const formatNumber = (value: number, digits = 2) => new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
}).format(value);
const formatKm = (centiPk: number, digits = 2) => `${formatNumber(centiPk / 1000, digits)} км`;
const formatPk = (centiPk: number) => formatNumber(centiPk / 100, 2);
const roundedPercent = (percent: number) => formatNumber(percent, 1);
const constructionUnits: Record<ConstructionUnit, { label: string; short: string; precision: number; quantity: string }> = {
  pieces: { label: "Штуки", short: "шт", precision: 0, quantity: "количество" },
  meters: { label: "Метры", short: "м", precision: 2, quantity: "длина" },
  kilometers: { label: "Километры", short: "км", precision: 3, quantity: "длина" },
  square_meters: { label: "Квадратные метры", short: "м²", precision: 2, quantity: "площадь" },
  cubic_meters: { label: "Кубические метры", short: "м³", precision: 3, quantity: "объём" },
  kilograms: { label: "Килограммы", short: "кг", precision: 3, quantity: "масса" },
  tonnes: { label: "Тонны", short: "т", precision: 3, quantity: "масса" },
};
const unitMeta = (unit: ConstructionUnit) => constructionUnits[unit];
const formatDate = (value: string | null) => value ? new Intl.DateTimeFormat("ru-RU").format(new Date(`${value}T00:00:00`)) : "";
const formatTimestamp = (value: string) => value ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "Дата неизвестна";
const asCentiPk = (value: string): number | null => {
  const match = value.trim().match(/^(\d+)(?:[,.](\d{0,2}))?$/);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const result = whole * 100 + Number(fraction || "0");
  return Number.isSafeInteger(result) ? result : null;
};
const markerPosition = (value: string, project: ProjectListItem | null) => {
  if (!project) return null;
  const centiPk = asCentiPk(value);
  const routeLength = project.routeEnd - project.routeStart;
  if (centiPk === null || centiPk < project.routeStart || centiPk > project.routeEnd || routeLength <= 0) return null;
  return ((centiPk - project.routeStart) / routeLength) * 100;
};
const dateToday = () => new Date().toISOString().slice(0, 10);
const emptyBridgeForm = (): BridgeForm => ({ enabled: false, fromPk: "", toPk: "", layerIds: [] });
const emptyExclusionForm = (): ExclusionForm => ({ id: null, name: "", reason: "", fromPk: "", toPk: "", layerIds: [], workAreaIds: [] });
const mergeIntervals = (intervals: Interval[]): Interval[] => intervals.slice().sort((a, b) => a.fromCentiPk - b.fromCentiPk || a.toCentiPk - b.toCentiPk).reduce<Interval[]>((merged, interval) => {
  const last = merged[merged.length - 1];
  if (last && interval.fromCentiPk <= last.toCentiPk) last.toCentiPk = Math.max(last.toCentiPk, interval.toCentiPk);
  else merged.push({ ...interval });
  return merged;
}, []);
const intersectIntervals = (left: Interval[], right: Interval[]): Interval[] => mergeIntervals(left.flatMap((a) => right.flatMap((b) => {
  const fromCentiPk = Math.max(a.fromCentiPk, b.fromCentiPk);
  const toCentiPk = Math.min(a.toCentiPk, b.toCentiPk);
  return toCentiPk > fromCentiPk ? [{ fromCentiPk, toCentiPk }] : [];
})));
const subtractIntervals = (source: Interval[], cuts: Interval[]): Interval[] => {
  let result = mergeIntervals(source);
  for (const cut of mergeIntervals(cuts)) result = result.flatMap((item) => cut.toCentiPk <= item.fromCentiPk || cut.fromCentiPk >= item.toCentiPk ? [item] : [
    ...(cut.fromCentiPk > item.fromCentiPk ? [{ fromCentiPk: item.fromCentiPk, toCentiPk: cut.fromCentiPk }] : []),
    ...(cut.toCentiPk < item.toCentiPk ? [{ fromCentiPk: cut.toCentiPk, toCentiPk: item.toCentiPk }] : []),
  ]);
  return result;
};
const intervalLength = (intervals: Interval[]) => intervals.reduce((total, interval) => total + interval.toCentiPk - interval.fromCentiPk, 0);

const emptyLayerForm = (): LayerForm => ({
  code: "",
  name: "",
  color: "#20796e",
  planPercent: "",
  planDate: "",
});
const emptySegmentForm = (workAreaId = ""): SegmentForm => ({
  workAreaId,
  fromPk: "",
  toPk: "",
  workDate: dateToday(),
  note: "",
});

function App() {
  const [databaseStatus, setDatabaseStatus] = useState<DatabaseStatus | null>(null);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [constructionSnapshot, setConstructionSnapshot] = useState<ConstructionSnapshot | null>(null);
  const [activeModule, setActiveModule] = useState<ActiveModule>(getStartupModule);
  const [chatUnread, setChatUnread] = useState(0);
  const updateChatUnread = useCallback((count: number) => setChatUnread(count), []);
  const [startupModule, setStartupModule] = useState<"layers" | "construction">(getStartupModule);
  const [theme, setTheme] = useState<"light" | "dark">(getSavedTheme);
  const [applicationVersion, setApplicationVersion] = useState("—");
  const [constructionLoading, setConstructionLoading] = useState(false);
  const [constructionLoadAttempt, setConstructionLoadAttempt] = useState(0);
  const [constructionLineEditorOpen, setConstructionLineEditorOpen] = useState(false);
  const [constructionLineForm, setConstructionLineForm] = useState<ConstructionLineForm>({ name: "", unit: "meters", plannedAmount: "" });
  const [activeConstructionLineId, setActiveConstructionLineId] = useState<string | null>(null);
  const [constructionProgressAmount, setConstructionProgressAmount] = useState("");
  const [editingConstructionLineId, setEditingConstructionLineId] = useState<string | null>(null);
  const [constructionLineName, setConstructionLineName] = useState("");
  const [editingConstructionEntryId, setEditingConstructionEntryId] = useState<string | null>(null);
  const [constructionEntryAmount, setConstructionEntryAmount] = useState("");
  const [constructionReportOpen, setConstructionReportOpen] = useState(false);
  const [constructionReportSetupOpen, setConstructionReportSetupOpen] = useState(false);
  const [constructionReportPhoto, setConstructionReportPhoto] = useState<string | null>(null);
  const constructionReportPhotoInput = useRef<HTMLInputElement>(null);
  const [constructionAddressEditing, setConstructionAddressEditing] = useState(false);
  const [constructionAddressDraft, setConstructionAddressDraft] = useState("");
  const [constructionGuideOpen, setConstructionGuideOpen] = useState(false);
  const [constructionGuideStep, setConstructionGuideStep] = useState(0);
  const [constructionGuideAutoShown, setConstructionGuideAutoShown] = useState(false);
  const [constructionDeleteTarget, setConstructionDeleteTarget] = useState<ConstructionDeleteTarget | null>(null);
  const [selectedLayerId, setSelectedLayerId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectDeleteDialogOpen, setProjectDeleteDialogOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [routeStartPk, setRouteStartPk] = useState("0,00");
  const [routeEndPk, setRouteEndPk] = useState("10,00");
  const [layerEditorOpen, setLayerEditorOpen] = useState(false);
  const [layerOrderEditing, setLayerOrderEditing] = useState(false);
  const [layerOrderDraft, setLayerOrderDraft] = useState<string[]>([]);
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [layerForm, setLayerForm] = useState<LayerForm>(emptyLayerForm());
  const [segmentEditorOpen, setSegmentEditorOpen] = useState(false);
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [segmentForm, setSegmentForm] = useState<SegmentForm>(emptySegmentForm());
  const [bridgeSettingsOpen, setBridgeSettingsOpen] = useState(false);
  const [bridgeForm, setBridgeForm] = useState<BridgeForm>(emptyBridgeForm());
  const [bridgePreview, setBridgePreview] = useState<ProjectSnapshot | null>(null);
  const [exclusionEditorOpen, setExclusionEditorOpen] = useState(false);
  const [exclusionForm, setExclusionForm] = useState<ExclusionForm>(emptyExclusionForm());
  const [workAreaEditorOpen, setWorkAreaEditorOpen] = useState(false);
  const [workAreaForm, setWorkAreaForm] = useState<WorkAreaForm>({ name: "", fromPk: "", toPk: "", layerIds: [] });
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [checkingForUpdates, setCheckingForUpdates] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const refreshProjects = async () => {
    const items = await invoke<ProjectListItem[]>("list_projects");
    setProjects(items);
    return items;
  };

  const renameSelectedProject = async () => {
    if (!selectedProjectId || !selectedProject) return;
    const name = window.prompt("Новое название объекта", selectedProject.name);
    if (name === null || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const updatedProjects = await invoke<ProjectListItem[]>("rename_project", { projectId: selectedProjectId, name });
      setProjects(updatedProjects);
      const refreshed = await invoke<ProjectSnapshot>("get_project_snapshot", { projectId: selectedProjectId });
      setSnapshot(refreshed);
      if (activeModule === "construction") {
        const construction = await invoke<ConstructionSnapshot>("get_construction_snapshot", { projectId: selectedProjectId });
        setConstructionSnapshot(construction);
      }
      setNotice("Название объекта изменено.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const saveConstructionAddress = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProjectId) return;
    setSaving(true);
    setError(null);
    try {
      const updatedProjects = await invoke<ProjectListItem[]>("set_project_address", { projectId: selectedProjectId, address: constructionAddressDraft });
      setProjects(updatedProjects);
      const project = updatedProjects.find((item) => item.id === selectedProjectId);
      if (project) {
        setConstructionSnapshot((current) => current ? { ...current, project } : current);
        setSnapshot((current) => current ? { ...current, project } : current);
      }
      setConstructionAddressEditing(false);
      setNotice("Адрес объекта сохранён.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const removeSelectedProject = () => {
    if (!selectedProjectId || !selectedProject) return;
    if (projects.length <= 1) {
      setError("Нельзя удалить последний объект.");
      return;
    }
    setProjectDeleteDialogOpen(true);
  };

  const confirmRemoveSelectedProject = async () => {
    if (!selectedProjectId || !selectedProject || projects.length <= 1) return;
    setSaving(true);
    setError(null);
    try {
      const remaining = await invoke<ProjectListItem[]>("delete_project", { projectId: selectedProjectId });
      setProjects(remaining);
      const next = remaining[0];
      setSelectedProjectId(next.id);
      localStorage.setItem("easypto.activeProjectId", next.id);
      setNotice("Объект удалён.");
      setProjectDeleteDialogOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const refreshBackups = async () => {
    const result = await invoke<BackupEntry[]>("list_backups");
    setBackups(result);
  };

  const openHistory = async () => {
    setHistoryDialogOpen(true);
    try {
      await refreshBackups();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const createManualBackup = async () => {
    setSaving(true);
    setError(null);
    try {
      const created = await invoke<BackupEntry>("create_backup");
      await refreshBackups();
      setNotice(`Резервная копия создана: ${created.fileName}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const restoreBackup = async (backup: BackupEntry) => {
    const confirmed = window.confirm(`Восстановить базу из копии от ${formatTimestamp(backup.createdAt)}? Это заменит все текущие объекты. Перед восстановлением приложение создаст страховочную копию текущей базы.`);
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    try {
      const restoredProjects = await invoke<ProjectListItem[]>("restore_backup", { fileName: backup.fileName });
      setProjects(restoredProjects);
      const currentStillExists = restoredProjects.some((project) => project.id === selectedProjectId);
      const nextProjectId = currentStillExists ? selectedProjectId : restoredProjects[0]?.id ?? "";
      setSnapshot(null);
      setSelectedProjectId(nextProjectId);
      if (nextProjectId) {
        localStorage.setItem("easypto.activeProjectId", nextProjectId);
        const restoredSnapshot = await invoke<ProjectSnapshot>("get_project_snapshot", { projectId: nextProjectId });
        setSnapshot(restoredSnapshot);
      }
      await refreshBackups();
      setNotice("База восстановлена. Текущая версия перед этим сохранена в резервную копию.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    let alive = true;
    Promise.all([
      invoke<DatabaseStatus>("database_status"),
      invoke<ProjectListItem[]>("list_projects"),
    ]).then(([status, items]) => {
      if (!alive) return;
      setDatabaseStatus(status);
      setProjects(items);
      const lastProjectId = localStorage.getItem("easypto.activeProjectId");
      const preferred = items.find((project) => project.id === lastProjectId) ?? items[0];
      if (preferred) setSelectedProjectId(preferred.id);
      else setLoading(false);
    }).catch((reason: unknown) => {
      if (!alive) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void getVersion().then(setApplicationVersion).catch(() => setApplicationVersion("неизвестна"));
    let alive = true;
    const timer = window.setTimeout(() => {
      void check().then((update) => {
        if (!alive) {
          void update?.close();
          return;
        }
        if (update) setAvailableUpdate(update);
      }).catch((reason: unknown) => {
        console.warn("Не удалось проверить обновления easyPTO", reason);
      });
    }, 1200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("easypto.theme", theme);
    } catch {
      // The selected theme remains active for this session.
    }
  }, [theme]);

  const selectModule = (module: ActiveModule) => {
    setActiveModule(module);
  };

  const saveStartupModule = (module: "layers" | "construction") => {
    setStartupModule(module);
    try {
      localStorage.setItem("easypto.startModule", module);
    } catch {
      // Keep the preference for this session when browser storage is unavailable.
    }
  };

  const checkForUpdates = async () => {
    if (!isTauri()) {
      setNotice("Проверка обновлений доступна в установленной версии приложения.");
      return;
    }
    setCheckingForUpdates(true);
    setUpdateError(null);
    try {
      const update = await check();
      if (update) setAvailableUpdate(update);
      else setNotice("Установлена последняя версия easyPTO.");
    } catch (reason) {
      setUpdateError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCheckingForUpdates(false);
    }
  };

  const dismissUpdate = async () => {
    await availableUpdate?.close();
    setAvailableUpdate(null);
    setUpdateError(null);
  };

  const installAvailableUpdate = async () => {
    if (!availableUpdate) return;
    setInstallingUpdate(true);
    setUpdateError(null);
    try {
      await availableUpdate.downloadAndInstall();
      await relaunch();
    } catch (reason) {
      setUpdateError(reason instanceof Error ? reason.message : String(reason));
      setInstallingUpdate(false);
    }
  };

  useEffect(() => {
    if (!selectedProjectId) {
      setSnapshot(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    invoke<ProjectSnapshot>("get_project_snapshot", { projectId: selectedProjectId })
      .then((result) => {
        if (!alive) return;
        setSnapshot(result);
        setSelectedLayerId((current) => result.layers.some((layer) => layer.id === current) ? current : result.layers[0]?.id ?? "");
        localStorage.setItem("easypto.activeProjectId", selectedProjectId);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [selectedProjectId]);

  useEffect(() => {
    if (activeModule !== "construction" || !selectedProjectId) {
      setConstructionSnapshot(null);
      setConstructionLoading(false);
      return;
    }
    let alive = true;
    setConstructionLoading(true);
    setConstructionSnapshot(null);
    setEditingConstructionLineId(null);
    setEditingConstructionEntryId(null);
    setError(null);
    invoke<ConstructionSnapshot>("get_construction_snapshot", { projectId: selectedProjectId })
      .then((result) => {
        if (!alive) return;
        setConstructionSnapshot(result);
        setActiveConstructionLineId((current) => result.lines.some((line) => line.id === current) ? current : null);
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (alive) setConstructionLoading(false); });
    return () => { alive = false; };
  }, [activeModule, selectedProjectId, constructionLoadAttempt]);

  useEffect(() => {
    if (activeModule !== "construction" || !constructionSnapshot || constructionGuideAutoShown) return;
    setConstructionGuideAutoShown(true);
    try {
      if (localStorage.getItem("easypto.construction-guide.seen.v1") === "true") return;
      localStorage.setItem("easypto.construction-guide.seen.v1", "true");
    } catch {
      // Still show the first-use guide when browser storage is unavailable.
    }
    setConstructionGuideStep(0);
    setConstructionGuideOpen(true);
  }, [activeModule, constructionSnapshot, constructionGuideAutoShown]);

  const openConstructionGuide = () => {
    setConstructionGuideStep(0);
    setConstructionGuideOpen(true);
  };

  const closeConstructionGuide = () => setConstructionGuideOpen(false);

  const selectedProject = snapshot?.project ?? projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedLayer = snapshot?.layers.find((layer) => layer.id === selectedLayerId) ?? null;
  const currentFilterPosition = markerPosition(search, selectedProject);

  const saveConstructionLine = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedProjectId) return;
    setSaving(true);
    setError(null);
    try {
      const plannedAmount = Number(constructionLineForm.plannedAmount.trim().replace(",", "."));
      const updated = await invoke<ConstructionSnapshot>("create_construction_line", {
        projectId: selectedProjectId,
        input: {
          name: constructionLineForm.name,
          unit: constructionLineForm.unit,
          plannedAmount,
          sortOrder: constructionSnapshot?.lines.length ?? 0,
        },
      });
      const projectState = await invoke<ProjectSnapshot>("get_project_snapshot", { projectId: selectedProjectId });
      setSnapshot(projectState);
      setConstructionSnapshot(updated);
      setConstructionLineForm({ name: "", unit: "meters", plannedAmount: "" });
      setConstructionLineEditorOpen(false);
      setNotice("Линия данных добавлена.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const addConstructionProgress = async (line: ConstructionLine) => {
    if (!selectedProjectId) return;
    const amount = Number(constructionProgressAmount.trim().replace(",", "."));
    setSaving(true);
    setError(null);
    try {
      const updated = await invoke<ConstructionSnapshot>("add_construction_progress", {
        projectId: selectedProjectId,
        lineId: line.id,
        amount,
      });
      const projectState = await invoke<ProjectSnapshot>("get_project_snapshot", { projectId: selectedProjectId });
      setSnapshot(projectState);
      setConstructionSnapshot(updated);
      setConstructionProgressAmount("");
      setNotice(`Выполненный объём добавлен: ${line.name}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const removeConstructionLine = (line: ConstructionLine) => {
    setConstructionDeleteTarget({ kind: "line", line });
    setError(null);
  };

  const adoptConstructionSnapshot = async (updated: ConstructionSnapshot) => {
    setConstructionSnapshot(updated);
    const projectState = await invoke<ProjectSnapshot>("get_project_snapshot", { projectId: selectedProjectId });
    setSnapshot(projectState);
  };

  const saveConstructionLineName = async (event: FormEvent, line: ConstructionLine) => {
    event.preventDefault();
    if (!selectedProjectId) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await invoke<ConstructionSnapshot>("rename_construction_line", {
        projectId: selectedProjectId,
        lineId: line.id,
        name: constructionLineName,
      });
      await adoptConstructionSnapshot(updated);
      setEditingConstructionLineId(null);
      setNotice("Название линии изменено.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const saveConstructionEntry = async (event: FormEvent, line: ConstructionLine, entry: ConstructionProgressEntry) => {
    event.preventDefault();
    if (!selectedProjectId) return;
    setSaving(true);
    setError(null);
    try {
      const amount = Number(constructionEntryAmount.trim().replace(",", "."));
      const updated = await invoke<ConstructionSnapshot>("update_construction_progress", {
        projectId: selectedProjectId,
        lineId: line.id,
        entryId: entry.id,
        amount,
      });
      await adoptConstructionSnapshot(updated);
      setEditingConstructionEntryId(null);
      setConstructionEntryAmount("");
      setNotice("Запись выполнения исправлена.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const removeConstructionEntry = (line: ConstructionLine, entry: ConstructionProgressEntry) => {
    setConstructionDeleteTarget({ kind: "entry", line, entry });
    setError(null);
  };

  const confirmConstructionDelete = async () => {
    if (!selectedProjectId || !constructionDeleteTarget) return;
    setSaving(true);
    setError(null);
    try {
      const target = constructionDeleteTarget;
      const updated = target.kind === "line"
        ? await invoke<ConstructionSnapshot>("delete_construction_line", { projectId: selectedProjectId, lineId: target.line.id })
        : await invoke<ConstructionSnapshot>("delete_construction_progress", {
          projectId: selectedProjectId,
          lineId: target.line.id,
          entryId: target.entry.id,
        });
      await adoptConstructionSnapshot(updated);
      if (target.kind === "line") {
        if (activeConstructionLineId === target.line.id) setActiveConstructionLineId(null);
        setNotice(`Линия «${target.line.name}» и её записи удалены.`);
      } else {
        if (editingConstructionEntryId === target.entry.id) setEditingConstructionEntryId(null);
        setNotice("Запись выполнения удалена.");
      }
      setConstructionDeleteTarget(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const visibleLayers = useMemo(() => {
    const allLayers = snapshot?.layers ?? [];
    if (filter === "unfinished") return allLayers.filter((layer) => layer.remainingLengthCentiPk > 0);
    if (filter === "behind") return allLayers.filter((layer) => layer.planDeltaPp !== null && layer.planDeltaPp < 0);
    return allLayers;
  }, [filter, snapshot]);
  const layerOrderChanged = Boolean(snapshot && (
    layerOrderDraft.length !== snapshot.layers.length
    || layerOrderDraft.some((layerId, index) => snapshot.layers[index]?.id !== layerId)
  ));

  const bridgeArea = snapshot?.workAreas.find((area) => area.id === snapshot.bridgeAreaId) ?? null;
  const bridgeLayers = bridgeArea ? snapshot?.layers.filter((layer) => layer.workAreaIds.includes(bridgeArea.id)) ?? [] : [];
  const bridgeLength = bridgeArea ? intervalLength(bridgeArea.intervals) : 0;
  const bridgeCovered = bridgeArea ? bridgeLayers.reduce((total, layer) => {
    const areaCoverage = intersectIntervals(
      mergeIntervals(layer.segments.filter((segment) => segment.workAreaId === bridgeArea.id).map((segment) => ({ fromCentiPk: segment.fromCentiPk, toCentiPk: segment.toCentiPk }))),
      bridgeArea.intervals,
    );
    const excluded = snapshot?.exclusions.filter((exclusion) => exclusion.appliesToLayerIds.includes(layer.id) && exclusion.workAreaIds.includes(bridgeArea.id)).flatMap((exclusion) => exclusion.intervals) ?? [];
    return total + intervalLength(subtractIntervals(areaCoverage, excluded));
  }, 0) : 0;
  const bridgeTotal = bridgeLength * bridgeLayers.length;
  const bridgeImpactNow = snapshot ? areaProgress(snapshot, snapshot.bridgeAreaId, snapshot.bridgeEnabled) : { covered: 0, total: 0, percent: 0 };
  const bridgeImpactNext = bridgePreview ? areaProgress(bridgePreview, bridgePreview.bridgeAreaId, bridgePreview.bridgeEnabled) : { covered: 0, total: 0, percent: 0 };

  const adoptSnapshot = (updated: ProjectSnapshot) => {
    setSnapshot(updated);
    setSelectedProjectId(updated.project.id);
    setProjects((current) => [updated.project, ...current.filter((project) => project.id !== updated.project.id)]);
  };

  const createProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await invoke<ProjectSnapshot>("create_project", {
        name: projectName,
        routeStartPk,
        routeEndPk,
      });
      adoptSnapshot(result);
      await refreshProjects();
      setSelectedLayerId(result.layers[0]?.id ?? "");
      setProjectDialogOpen(false);
      setProjectName("");
      setNotice("Объект создан. Начальные слои готовы к настройке.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const beginCreateLayer = () => {
    setEditingLayerId(null);
    setLayerForm(emptyLayerForm());
    setLayerEditorOpen(true);
    setSegmentEditorOpen(false);
    setError(null);
  };

  const beginLayerOrderEdit = () => {
    if (!snapshot) return;
    setLayerOrderDraft(snapshot.layers.map((layer) => layer.id));
    setLayerOrderEditing(true);
    setLayerEditorOpen(false);
    setSegmentEditorOpen(false);
    setFilter("all");
    setSearch("");
    setError(null);
  };

  const moveLayerInOrder = (index: number, offset: -1 | 1) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= layerOrderDraft.length) return;
    setLayerOrderDraft((current) => {
      const reordered = [...current];
      [reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]];
      return reordered;
    });
  };

  const saveLayerOrder = async () => {
    if (!snapshot || !selectedProjectId || !layerOrderChanged) return;
    if (!window.confirm("Сохранить новый порядок? Базой каждого слоя станет следующий слой ниже, а у нижнего слоя базового слоя не будет.")) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await invoke<ProjectSnapshot>("reorder_layers", {
        projectId: selectedProjectId,
        orderedLayerIds: layerOrderDraft,
      });
      adoptSnapshot(updated);
      setLayerOrderEditing(false);
      setNotice("Порядок слоёв и базовые слои обновлены.");
      await refreshProjects();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const cancelLayerOrderEdit = () => {
    setLayerOrderEditing(false);
    setLayerOrderDraft([]);
  };

  const beginEditLayer = (layer: LayerSnapshot) => {
    setEditingLayerId(layer.id);
    setLayerForm({
      code: layer.code,
      name: layer.name,
      color: layer.color,
      planPercent: layer.planPercent === null ? "" : String(layer.planPercent).replace(".", ","),
      planDate: layer.planDate ?? "",
    });
    setLayerEditorOpen(true);
    setSegmentEditorOpen(false);
    setError(null);
  };

  const submitLayer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProjectId) return;
    setSaving(true);
    setError(null);
    try {
      const planPercent = layerForm.planPercent.trim() === "" ? null : Number(layerForm.planPercent.replace(",", "."));
      if ((planPercent === null) !== (layerForm.planDate === "")) {
        setError("Для плана укажите и процент, и дату.");
        setSaving(false);
        return;
      }
      if (planPercent !== null && (!Number.isFinite(planPercent) || planPercent < 0 || planPercent > 100)) {
        setError("Плановый процент должен быть от 0 до 100.");
        setSaving(false);
        return;
      }
      const input: LayerInput = {
        code: layerForm.code,
        name: layerForm.name,
        color: layerForm.color,
        planPercent,
        planDate: layerForm.planDate || null,
      };
      const command = editingLayerId ? "update_layer" : "create_layer";
      const updated = await invoke<ProjectSnapshot>(command, {
        projectId: selectedProjectId,
        ...(editingLayerId ? { layerId: editingLayerId } : {}),
        input,
      });
      adoptSnapshot(updated);
      if (!editingLayerId) {
        const newLayer = updated.layers.find((layer) => !snapshot?.layers.some((old) => old.id === layer.id));
        if (newLayer) setSelectedLayerId(newLayer.id);
      }
      await refreshProjects();
      setLayerEditorOpen(false);
      setNotice(editingLayerId ? "Параметры слоя сохранены." : "Слой добавлен.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const removeLayer = async (layer: LayerSnapshot) => {
    if (!selectedProjectId) return;
    const message = layer.segments.length
      ? `Удалить слой «${layer.name}» и ${layer.segments.length} ${layer.segments.length === 1 ? "отрезок" : "отрезка/отрезков"}? Данные слоя будут удалены.`
      : `Удалить слой «${layer.name}»?`;
    if (!window.confirm(message)) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await invoke<ProjectSnapshot>("delete_layer", { projectId: selectedProjectId, layerId: layer.id });
      adoptSnapshot(updated);
      setSelectedLayerId(updated.layers[0]?.id ?? "");
      setLayerEditorOpen(false);
      await refreshProjects();
      setNotice("Слой удалён.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const beginCreateSegment = () => {
    setEditingSegmentId(null);
    const defaultArea = snapshot?.workAreas.find((area) => selectedLayer?.workAreaIds.includes(area.id) && (snapshot.bridgeEnabled || area.kind !== "bridge"));
    setSegmentForm(emptySegmentForm(defaultArea?.id ?? ""));
    setSegmentEditorOpen(true);
    setLayerEditorOpen(false);
    setError(null);
  };

  const beginEditSegment = (segment: Segment) => {
    setEditingSegmentId(segment.id);
    setSegmentForm({
      workAreaId: segment.workAreaId,
      fromPk: formatPk(segment.fromCentiPk),
      toPk: formatPk(segment.toCentiPk),
      workDate: segment.workDate,
      note: segment.note ?? "",
    });
    setSegmentEditorOpen(true);
    setLayerEditorOpen(false);
    setError(null);
  };

  const submitSegment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProjectId || !selectedLayer) return;
    setSaving(true);
    setError(null);
    try {
      const input: SegmentInput = {
        ...segmentForm,
        note: segmentForm.note.trim() || null,
      };
      const updated = await invoke<ProjectSnapshot>("save_segment", {
        projectId: selectedProjectId,
        layerId: selectedLayer.id,
        segmentId: editingSegmentId,
        input,
      });
      adoptSnapshot(updated);
      await refreshProjects();
      setSegmentEditorOpen(false);
      setNotice(editingSegmentId ? "Отрезок обновлён." : "Отрезок сохранён.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const removeSegment = async (segment: Segment) => {
    if (!selectedProjectId || !selectedLayer) return;
    if (!window.confirm(`Удалить отрезок ${formatPk(segment.fromCentiPk)}–${formatPk(segment.toCentiPk)} ПК?`)) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await invoke<ProjectSnapshot>("delete_segment", {
        projectId: selectedProjectId,
        layerId: selectedLayer.id,
        segmentId: segment.id,
      });
      adoptSnapshot(updated);
      await refreshProjects();
      setNotice("Отрезок удалён.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const closeLayerEditor = () => { setLayerEditorOpen(false); setError(null); };
  const closeSegmentEditor = () => { setSegmentEditorOpen(false); setError(null); };

  const beginBridgeSettings = () => {
    const area = snapshot?.workAreas.find((item) => item.id === snapshot.bridgeAreaId);
    const interval = area?.intervals[0];
    const routeLength = (snapshot?.project.routeEnd ?? 0) - (snapshot?.project.routeStart ?? 0);
    setBridgeForm({
      enabled: snapshot?.bridgeEnabled ?? false,
      fromPk: interval ? formatPk(interval.fromCentiPk) : formatPk((snapshot?.project.routeStart ?? 0) + Math.round(routeLength * 0.2)),
      toPk: interval ? formatPk(interval.toCentiPk) : formatPk((snapshot?.project.routeStart ?? 0) + Math.round(routeLength * 0.8)),
      layerIds: area ? snapshot?.layers.filter((layer) => layer.workAreaIds.includes(area.id)).map((layer) => layer.id) ?? [] : snapshot?.layers.map((layer) => layer.id) ?? [],
    });
    setBridgePreview(null);
    setBridgeSettingsOpen(true);
    setError(null);
  };

  const previewBridge = async () => {
    if (!selectedProjectId) return;
    setSaving(true);
    setError(null);
    try {
      const preview = await invoke<ProjectSnapshot>("preview_bridge_config", {
        projectId: selectedProjectId,
        input: bridgeForm,
      });
      setBridgePreview(preview);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBridgePreview(null);
    } finally {
      setSaving(false);
    }
  };

  const saveBridge = async () => {
    if (!selectedProjectId) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await invoke<ProjectSnapshot>("configure_bridge", {
        projectId: selectedProjectId,
        input: bridgeForm,
      });
      adoptSnapshot(updated);
      await refreshProjects();
      setBridgeSettingsOpen(false);
      setBridgePreview(null);
      setNotice(bridgeForm.enabled ? "Настройки моста сохранены." : "Мост отключён. Его настройки и записи сохранены.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const beginCreateExclusion = () => {
    setExclusionForm({ ...emptyExclusionForm(), layerIds: snapshot?.layers.map((layer) => layer.id) ?? [], workAreaIds: snapshot?.workAreas.filter((area) => area.kind !== "bridge" || snapshot.bridgeEnabled).map((area) => area.id) ?? [] });
    setExclusionEditorOpen(true);
    setError(null);
  };

  const beginEditExclusion = (exclusion: Exclusion) => {
    setExclusionForm({
      id: exclusion.id,
      name: exclusion.name,
      reason: exclusion.reason,
      fromPk: exclusion.intervals[0] ? formatPk(exclusion.intervals[0].fromCentiPk) : "",
      toPk: exclusion.intervals[0] ? formatPk(exclusion.intervals[0].toCentiPk) : "",
      layerIds: exclusion.appliesToLayerIds,
      workAreaIds: exclusion.workAreaIds,
    });
    setExclusionEditorOpen(true);
    setError(null);
  };

  const saveExclusion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProjectId) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await invoke<ProjectSnapshot>("save_exclusion", {
        projectId: selectedProjectId,
        exclusionId: exclusionForm.id,
        input: { name: exclusionForm.name, reason: exclusionForm.reason, fromPk: exclusionForm.fromPk, toPk: exclusionForm.toPk, layerIds: exclusionForm.layerIds, workAreaIds: exclusionForm.workAreaIds },
      });
      adoptSnapshot(updated);
      setExclusionEditorOpen(false);
      setExclusionForm(emptyExclusionForm());
      setNotice(exclusionForm.id ? "Исключение обновлено; показатели пересчитаны." : "Исключённый диапазон добавлен; показатели пересчитаны.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const removeExclusion = async (exclusion: Exclusion) => {
    if (!selectedProjectId || !window.confirm(`Удалить исключение «${exclusion.name}»?`)) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await invoke<ProjectSnapshot>("delete_exclusion", { projectId: selectedProjectId, exclusionId: exclusion.id });
      adoptSnapshot(updated);
      setNotice("Исключение удалено; показатели пересчитаны.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const saveWorkArea = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProjectId) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await invoke<ProjectSnapshot>("create_work_area", { projectId: selectedProjectId, input: workAreaForm });
      adoptSnapshot(updated);
      setWorkAreaEditorOpen(false);
      setWorkAreaForm({ name: "", fromPk: "", toPk: "", layerIds: [] });
      setNotice("Рабочая область добавлена; показатели пересчитаны.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const removeWorkArea = async (area: WorkArea) => {
    if (!selectedProjectId) return;
    const segmentCount = snapshot?.layers.reduce((count, layer) => count + layer.segments.filter((segment) => segment.workAreaId === area.id).length, 0) ?? 0;
    const message = segmentCount ? `Удалить область «${area.name}» и связанные отрезки (${segmentCount})?` : `Удалить рабочую область «${area.name}»?`;
    if (!window.confirm(message)) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await invoke<ProjectSnapshot>("delete_custom_work_area", { projectId: selectedProjectId, workAreaId: area.id });
      adoptSnapshot(updated);
      setNotice("Рабочая область удалена; показатели пересчитаны.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const canExportCurrentSnapshot = () => Boolean(snapshot && snapshot.project.id === selectedProjectId && !saving && !error);
  const openReportPreview = () => {
    if (!canExportCurrentSnapshot()) return;
    setReportDialogOpen(true);
  };

  const runExport = async (format: "excel" | "word") => {
    if (!canExportCurrentSnapshot() || !snapshot) return;
    setSaving(true);
    setError(null);
    try {
      const saved = format === "excel"
        ? await exportExcel(snapshot as ReportSnapshot)
        : await exportWord(snapshot as ReportSnapshot);
      if (saved) setNotice(format === "excel" ? "Файл Excel сохранён." : "Файл Word сохранён.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const canExportConstructionSnapshot = () => Boolean(constructionSnapshot && constructionSnapshot.project.id === selectedProjectId && !saving && !error);
  const runConstructionExport = async (format: "excel" | "word") => {
    if (!canExportConstructionSnapshot() || !constructionSnapshot) return;
    setSaving(true);
    setError(null);
    try {
      const saved = format === "excel"
        ? await exportConstructionExcel(constructionSnapshot)
        : await exportConstructionWord(constructionSnapshot);
      if (saved) setNotice(format === "excel" ? "Файл Excel сохранён." : "Файл Word сохранён.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const constructionReportStartDate = useMemo(() => {
    const dates = constructionSnapshot?.lines.flatMap((line) => line.entries.map((entry) => entry.happenedAt.slice(0, 10))).sort();
    return dates?.[0] ?? dateToday();
  }, [constructionSnapshot]);

  return (
    <div className="application">
      <header className="topbar">
        <a className="brand" href="#workspace" aria-label="easyPTO — рабочая область">
          <img className="brand-logo" src={theme === "dark" ? easyPtoLogoDark : easyPtoLogo} alt="" />
        </a>
        <div className="topbar-divider" />
        <label className="object-context">
          <span className="context-label">ОБЪЕКТ</span>
          <select className="object-select" aria-label="Выбрать объект" value={selectedProjectId} onChange={(event) => { cancelLayerOrderEdit(); setSelectedProjectId(event.currentTarget.value); }} disabled={!projects.length}>
            {!projects.length && <option value="">Нет объектов</option>}
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <button className="new-project-button" type="button" onClick={() => setProjectDialogOpen(true)} title="Создать объект"><span aria-hidden="true">＋</span><span>Объект</span></button>
        <label className="mobile-module-switch"><span className="visually-hidden">Выбрать раздел</span><select aria-label="Выбрать раздел" value={activeModule} onChange={(event) => selectModule(event.currentTarget.value as ActiveModule)}><option value="layers">Слои</option><option value="construction">Строительство</option><option value="chat">Чат{chatUnread ? ` · ${chatUnread}` : ""}</option><option value="settings">Настройки</option></select></label>
        <div className="topbar-spacer" />
        <div className={`save-state${saving ? " is-saving" : ""}${error ? " is-error" : ""}`} aria-live="polite">
          <span className="save-dot" />
          <span>{saving ? "Сохранение…" : error ? "Есть ошибка" : snapshot ? "Сохранено" : "Локальный проект"}</span>
        </div>
        <div className="topbar-divider topbar-divider-short" />
        <div className={`database-state${error && !snapshot ? " is-error" : ""}`} title={error && !snapshot ? error : `Локальная база · схема ${databaseStatus?.schemaVersion ?? "…"}`}>
          <DatabaseIcon />
          <span>{databaseStatus ? "Локально" : loading ? "Подключение…" : "База недоступна"}</span>
        </div>
      </header>

      <div className="workspace" id="workspace">
        <aside className="sidebar" aria-label="Разделы приложения">
          <div className="sidebar-caption">РАБОЧЕЕ МЕСТО</div>
          <button className={`nav-item${activeModule === "layers" ? " active" : ""}`} type="button" aria-current={activeModule === "layers" ? "page" : undefined} onClick={() => selectModule("layers")} title="Слои дорожной одежды"><RoadIcon /><span>Слои</span><span className="nav-count">{snapshot?.layers.length ?? 0}</span></button>
          <button className={`nav-item construction-nav-item${activeModule === "construction" ? " active" : ""}`} type="button" aria-current={activeModule === "construction" ? "page" : undefined} onClick={() => selectModule("construction")} title="Строительство автомобильной дороги"><ConstructionIcon /><span>Строительство автомобильной дороги</span><span className="nav-count">{constructionSnapshot?.lines.length ?? 0}</span></button>
          <button className={`nav-item${activeModule === "chat" ? " active" : ""}`} type="button" aria-current={activeModule === "chat" ? "page" : undefined} onClick={() => selectModule("chat")} title="Чат"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 11.6a7.9 7.9 0 0 1-8.1 7.8 8.5 8.5 0 0 1-3.3-.7L4 20l1.2-4.1a7.5 7.5 0 0 1-1.1-4.1A7.9 7.9 0 0 1 12.2 4a7.9 7.9 0 0 1 8 7.6Z" /><path d="M8 11.8h8M8 14.8h5" /></svg><span>Чат</span>{chatUnread > 0 && <span className="nav-count chat-nav-count">{chatUnread > 99 ? "99+" : chatUnread}</span>}</button>
          <div className="sidebar-caption settings-caption">ПРИЛОЖЕНИЕ</div>
          <button className={`nav-item settings-nav-item${activeModule === "settings" ? " active" : ""}`} type="button" aria-current={activeModule === "settings" ? "page" : undefined} onClick={() => selectModule("settings")} title="Настройки"><SettingsIcon /><span>Настройки</span></button>
          <div className="sidebar-bottom"><span className="local-indicator" /><span>Проекты локально</span></div>
        </aside>

        <main className="main-content">
          {activeModule === "settings" ? <>
            <div className="page-heading settings-page-heading"><div><div className="breadcrumb"><span>easyPTO</span><span className="crumb-separator">/</span><strong>Приложение</strong></div><h1>Настройки</h1><p>Параметры работы и данные easyPTO на этом устройстве.</p></div></div>
            {error && <div className="inline-message error-message" role="alert"><InfoIcon />{error}<button type="button" onClick={() => setError(null)} aria-label="Закрыть сообщение">×</button></div>}
            {notice && <div className="inline-message success-message" role="status"><CheckIcon />{notice}<button type="button" onClick={() => setNotice(null)} aria-label="Закрыть сообщение">×</button></div>}
            <section className="settings-section" aria-labelledby="settings-appearance-title">
              <div className="settings-section-heading"><h2 id="settings-appearance-title">Внешний вид</h2><p>Настройте оформление интерфейса приложения.</p></div>
              <label className="settings-row"><span><strong>Тема интерфейса</strong><small>Выбранная тема сохранится для следующих запусков.</small></span><select value={theme} onChange={(event) => setTheme(event.currentTarget.value as "light" | "dark")}><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label>
            </section>
            <section className="settings-section" aria-labelledby="settings-workspace-title">
              <div className="settings-section-heading"><h2 id="settings-workspace-title">Рабочее место</h2><p>Выберите раздел, который будет открываться при следующем запуске.</p></div>
              <label className="settings-row"><span><strong>Раздел при запуске</strong><small>Можно изменить в любой момент в боковом меню.</small></span><select value={startupModule} onChange={(event) => saveStartupModule(event.currentTarget.value as "layers" | "construction")}><option value="layers">Слои дорожной одежды</option><option value="construction">Строительство</option></select></label>
              <div className="settings-row"><span><strong>Обучение по строительству</strong><small>Кратко показывает, как вести линии работ и добавлять объёмы.</small></span><button className="quiet-button" type="button" onClick={() => { selectModule("construction"); openConstructionGuide(); }}>Открыть обучение</button></div>
            </section>
            <section className="settings-section" aria-labelledby="settings-data-title">
              <div className="settings-section-heading"><h2 id="settings-data-title">Данные и сохранность</h2><p>Проекты хранятся локально на этом компьютере.</p></div>
              <div className="settings-row"><span><strong>История и резервные копии</strong><small>Просмотр журнала изменений, создание и восстановление копий.</small></span><button className="quiet-button" type="button" onClick={() => void openHistory()}>Открыть историю</button></div>
              <div className="settings-row"><span><strong>Создать резервную копию</strong><small>Сохранить копию текущей базы перед важными изменениями.</small></span><button className="quiet-button" type="button" onClick={() => void createManualBackup()} disabled={saving}>{saving ? "Создание…" : "Создать копию"}</button></div>
            </section>
            <section className="settings-section" aria-labelledby="settings-app-title">
              <div className="settings-section-heading"><h2 id="settings-app-title">О приложении</h2><p>Версия и обновления easyPTO.</p></div>
              <div className="settings-row"><span><strong>Версия приложения</strong><small>easyPTO для рабочего стола</small></span><span className="settings-version">{applicationVersion}</span></div>
              <div className="settings-row"><span><strong>Обновления</strong><small>{updateError ? `Не удалось проверить: ${updateError}` : "Проверяйте обновления вручную или дождитесь автоматической проверки при запуске."}</small></span><div className="update-check-action"><button className="quiet-button" type="button" onClick={() => void checkForUpdates()} disabled={checkingForUpdates || installingUpdate}>Проверить обновления</button><span className={`update-check-status${checkingForUpdates ? " is-checking" : ""}`} aria-live="polite" aria-atomic="true">{checkingForUpdates && <><i className="update-spinner" aria-hidden="true" />Проверяем…</>}</span></div></div>
            </section>
          </> : loading && !snapshot ? <LoadingState /> : !snapshot ? (
            <EmptyProjectState error={error} onCreate={() => setProjectDialogOpen(true)} />
          ) : (
            activeModule === "construction" ? (
              constructionLoading ? <LoadingState /> : !constructionSnapshot ? <>
                {error && <div className="inline-message error-message" role="alert"><InfoIcon />{error}</div>}
                <div className="construction-load-error"><span>Не удалось загрузить данные строительства.</span><button className="quiet-button" type="button" onClick={() => setConstructionLoadAttempt((attempt) => attempt + 1)}>Повторить</button></div>
              </> : <>
                <div className="page-heading construction-page-heading">
                  <div>
                    <div className="breadcrumb"><span>{constructionSnapshot.project.name}</span><span className="crumb-separator">/</span><strong>Строительство</strong></div>
                    <h1>Строительство автомобильной дороги</h1>
                    <div className="construction-object-name">
                      <div><span>ОБЪЕКТ</span><strong>{constructionSnapshot.project.name}</strong></div>
                      <div><span>АДРЕС ОБЪЕКТА</span>{constructionAddressEditing ? <form className="construction-address-form" onSubmit={(event) => void saveConstructionAddress(event)}><input autoFocus maxLength={240} value={constructionAddressDraft} onChange={(event) => setConstructionAddressDraft(event.currentTarget.value)} placeholder="Введите адрес объекта" /><button className="compact-button active-action" type="submit" disabled={saving}>Сохранить</button><button className="compact-button" type="button" onClick={() => setConstructionAddressEditing(false)} disabled={saving}>Отмена</button></form> : <button className="construction-address-value" type="button" onClick={() => { setConstructionAddressDraft(constructionSnapshot.project.address); setConstructionAddressEditing(true); }}><strong>{constructionSnapshot.project.address || "Добавить адрес"}</strong><EditIcon /></button>}</div>
                      <button className="construction-guide-link" type="button" onClick={openConstructionGuide}><HelpIcon /> Обучение</button>
                    </div>
                  </div>
                  <div className="page-heading-actions"><button className="report-button construction-report-button" type="button" onClick={() => setConstructionReportSetupOpen(true)} disabled={!constructionSnapshot || saving} title="Предпросмотр и печать PDF-отчёта"><DocumentIcon /><span>Отчёт</span></button><details className="export-menu" onClick={(event) => { if ((event.target as HTMLElement).closest("button")) event.currentTarget.open = false; }}><summary><ExportIcon /> Экспорт</summary><div><button type="button" onClick={() => runConstructionExport("excel")} disabled={!canExportConstructionSnapshot()}>Excel (.xlsx)</button><button type="button" onClick={() => runConstructionExport("word")} disabled={!canExportConstructionSnapshot()}>Word (.docx)</button></div></details><button className="quiet-button" type="button" onClick={openHistory}>История и копии</button><details className="project-actions"><summary aria-label="Действия с объектом">•••</summary><div><button type="button" onClick={renameSelectedProject}>Переименовать объект</button><button type="button" onClick={removeSelectedProject} disabled={projects.length <= 1}>Удалить объект</button></div></details></div>
                </div>

                {error && <div className="inline-message error-message" role="alert"><InfoIcon />{error}<button type="button" onClick={() => setError(null)} aria-label="Закрыть сообщение">×</button></div>}
                {notice && <div className="inline-message success-message" role="status"><CheckIcon />{notice}<button type="button" onClick={() => setNotice(null)} aria-label="Закрыть сообщение">×</button></div>}

                <section className="construction-summary" aria-label="Общий прогресс объекта">
                  <div className="construction-summary-copy"><h2>Общий прогресс по объекту</h2><p>Среднее значение процентов выполнения всех линий данных</p></div>
                  <strong className="construction-summary-value">{roundedPercent(constructionSnapshot.progressPercent)}<span>%</span></strong>
                  <div className="construction-summary-track" role="progressbar" aria-label="Общий прогресс по объекту" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, constructionSnapshot.progressPercent)}><span style={{ width: `${Math.min(100, Math.max(0, constructionSnapshot.progressPercent))}%` }} /></div>
                  <span className="construction-summary-count">{constructionSnapshot.lines.length} линий данных</span>
                </section>

                <section className="construction-panel" aria-labelledby="construction-lines-title">
                  <div className="panel-heading"><div><h2 id="construction-lines-title">Линии данных</h2></div>{!constructionLineEditorOpen && <button className="compact-button active-action" type="button" onClick={() => setConstructionLineEditorOpen(true)}><PlusIcon /> Добавить линию</button>}</div>
                  {constructionLineEditorOpen && <form className="construction-editor" onSubmit={saveConstructionLine}>
                    <div className="construction-form-grid">
                      <label>Название линии<input autoFocus required maxLength={160} value={constructionLineForm.name} onChange={(event) => setConstructionLineForm({ ...constructionLineForm, name: event.currentTarget.value })} placeholder="Например, установка дорожных знаков" /></label>
                      <label>Единица измерения<select value={constructionLineForm.unit} onChange={(event) => setConstructionLineForm({ ...constructionLineForm, unit: event.currentTarget.value as ConstructionUnit })}>{Object.entries(constructionUnits).map(([value, unit]) => <option key={value} value={value}>{unit.label}</option>)}</select></label>
                      <label>Плановый {unitMeta(constructionLineForm.unit).quantity}, {unitMeta(constructionLineForm.unit).short}<input required type="number" min={unitMeta(constructionLineForm.unit).precision ? 10 ** -unitMeta(constructionLineForm.unit).precision : "1"} step={unitMeta(constructionLineForm.unit).precision ? 10 ** -unitMeta(constructionLineForm.unit).precision : "1"} inputMode="decimal" value={constructionLineForm.plannedAmount} onChange={(event) => setConstructionLineForm({ ...constructionLineForm, plannedAmount: event.currentTarget.value })} /></label>
                    </div>
                    <div className="form-footer"><span className="form-hint">Фактические объёмы добавляются в эту линию по мере выполнения работ.</span><div><button className="quiet-button" type="button" onClick={() => setConstructionLineEditorOpen(false)}>Отмена</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Сохранение…" : "Создать линию"}</button></div></div>
                  </form>}
                  {constructionSnapshot.lines.length ? <div className="construction-list">{constructionSnapshot.lines.map((line, index) => {
                    const expanded = activeConstructionLineId === line.id;
                    const { short: unitShort, precision } = unitMeta(line.unit);
                    return <article className={`construction-line${expanded ? " expanded" : ""}`} key={line.id}>
                      <div className="construction-line-row">
                        <button className="construction-line-main" type="button" onClick={() => { setActiveConstructionLineId(expanded ? null : line.id); setConstructionProgressAmount(""); setEditingConstructionLineId(null); setEditingConstructionEntryId(null); }} aria-expanded={expanded}>
                          <span className="construction-line-index mono">{String(index + 1).padStart(2, "0")}</span>
                          <span className="construction-line-content"><strong>{line.name}</strong><span>Выполнено {formatNumber(line.completedAmount, precision)} из {formatNumber(line.plannedAmount, precision)} {unitShort}</span><span className="construction-line-track" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, line.progressPercent))}%` }} /></span></span>
                          <strong className="construction-line-percent">{roundedPercent(line.progressPercent)}%</strong>
                          <span className="construction-line-chevron" aria-hidden="true"><ChevronIcon expanded={expanded} /></span>
                        </button>
                        <button className="construction-edit-button" type="button" onClick={() => { setActiveConstructionLineId(line.id); setEditingConstructionLineId(line.id); setConstructionLineName(line.name); }} aria-label={`Изменить название линии ${line.name}`} disabled={saving}><EditIcon /></button>
                        <button className="construction-delete-button" type="button" onClick={(event) => { event.stopPropagation(); removeConstructionLine(line); }} aria-label={`Удалить линию ${line.name}`} disabled={saving}><TrashIcon /></button>
                      </div>
                      {expanded && <div className="construction-line-details">
                        {editingConstructionLineId === line.id && <form className="construction-rename-form" onSubmit={(event) => void saveConstructionLineName(event, line)}>
                          <label>Название линии<input required maxLength={160} value={constructionLineName} onChange={(event) => setConstructionLineName(event.currentTarget.value)} /></label>
                          <div><button className="quiet-button" type="button" onClick={() => setEditingConstructionLineId(null)}>Отмена</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Сохранение…" : "Сохранить название"}</button></div>
                        </form>}
                        <form className="construction-progress-form" onSubmit={(event) => { event.preventDefault(); void addConstructionProgress(line); }}>
                          <label>Добавить выполненный объём, {unitShort}<input required type="number" min={precision ? 10 ** -precision : "1"} step={precision ? 10 ** -precision : "1"} inputMode="decimal" value={constructionProgressAmount} onChange={(event) => setConstructionProgressAmount(event.currentTarget.value)} /></label>
                          <button className="primary-button" type="submit" disabled={saving}>{saving ? "Сохранение…" : "Добавить объём"}</button>
                        </form>
                        <div className="construction-history"><strong>Записи выполнения · {line.entries.length}</strong>{line.entries.length ? <ol>{line.entries.map((entry) => <li key={entry.id}>
                          {editingConstructionEntryId === entry.id ? <form className="construction-entry-edit" onSubmit={(event) => void saveConstructionEntry(event, line, entry)}>
                            <label><span className="visually-hidden">Исправить объём, {unitShort}</span><input required type="number" min={precision ? 10 ** -precision : "1"} step={precision ? 10 ** -precision : "1"} inputMode="decimal" value={constructionEntryAmount} onChange={(event) => setConstructionEntryAmount(event.currentTarget.value)} /></label>
                            <button type="submit" disabled={saving} aria-label="Сохранить объём"><CheckIcon /></button><button type="button" onClick={() => setEditingConstructionEntryId(null)} aria-label="Отменить изменение"><CloseIcon /></button>
                          </form> : <>
                            <div className="construction-entry-data"><time>{formatTimestamp(entry.happenedAt)}</time><span>+{formatNumber(entry.amount, precision)} {unitShort}</span></div>
                            <div className="construction-entry-actions"><button type="button" onClick={() => { setEditingConstructionEntryId(entry.id); setConstructionEntryAmount(String(entry.amount)); }} aria-label="Изменить запись"><EditIcon /></button><button type="button" onClick={(event) => { event.stopPropagation(); removeConstructionEntry(line, entry); }} aria-label="Удалить запись" disabled={saving}><TrashIcon /></button></div>
                          </>}
                        </li>)}</ol> : <p>Записей пока нет. Добавьте первый выполненный объём.</p>}</div>
                      </div>}
                    </article>;
                  })}</div> : !constructionLineEditorOpen && <div className="construction-empty"><span className="empty-icon"><ConstructionIcon /></span><strong>Линий данных пока нет</strong><span>Создайте линию и укажите проектное количество или протяжённость.</span><button className="quiet-button" type="button" onClick={() => setConstructionLineEditorOpen(true)}><PlusIcon /> Добавить первую линию</button></div>}
                </section>
                <div className="workspace-footnote"><span>easyPTO <b>·</b> строительство автомобильной дороги</span><span>{databaseStatus ? `Схема базы данных ${databaseStatus.schemaVersion}` : "Локальное хранилище"}</span></div>
              </>
            ) : (
            <>
              <div className="page-heading">
                <div>
                  <div className="breadcrumb"><span>{snapshot.project.name}</span><span className="crumb-separator">/</span><strong>Слои дорожной одежды</strong></div>
                  <div className="heading-row"><h1>Слои дорожной одежды</h1><span className="layer-total">{snapshot.layers.length} технологических слоёв</span></div>
                </div>
                <div className="page-heading-actions"><button className="report-button" type="button" onClick={openReportPreview} disabled={!snapshot || saving || Boolean(error)} title={error ? "Сначала устраните ошибку сохранения" : "Предпросмотр и печать PDF-отчёта"}><DocumentIcon /><span>Отчёт</span></button><details className="export-menu" onClick={(event) => { if ((event.target as HTMLElement).closest("button")) event.currentTarget.open = false; }}><summary><ExportIcon /> Экспорт</summary><div><button type="button" onClick={() => runExport("excel")} disabled={!canExportCurrentSnapshot()}>Excel (.xlsx)</button><button type="button" onClick={() => runExport("word")} disabled={!canExportCurrentSnapshot()}>Word (.docx)</button></div></details><button className="quiet-button" type="button" onClick={openHistory}>История и копии</button><details className="project-actions"><summary aria-label="Действия с объектом">•••</summary><div><button type="button" onClick={renameSelectedProject}>Переименовать объект</button><button type="button" onClick={removeSelectedProject} disabled={projects.length <= 1}>Удалить объект</button></div></details></div>
              </div>

              {error && <div className="inline-message error-message" role="alert"><InfoIcon />{error}<button type="button" onClick={() => setError(null)} aria-label="Закрыть сообщение">×</button></div>}
              {notice && <div className="inline-message success-message" role="status"><CheckIcon />{notice}<button type="button" onClick={() => setNotice(null)} aria-label="Закрыть сообщение">×</button></div>}

              <section className="route-card" aria-label="Паспорт трассы">
                <div className="route-title"><span className="route-icon"><RouteIcon /></span><div><h2>Паспорт трассы</h2><span>{snapshot.project.name}</span></div></div>
                <div className="route-field"><span className="field-label">НАЧАЛО</span><strong className="mono">{formatPk(snapshot.project.routeStart)} <small>ПК</small></strong></div>
                <div className="route-arrow" aria-hidden="true">→</div>
                <div className="route-field"><span className="field-label">КОНЕЦ</span><strong className="mono">{formatPk(snapshot.project.routeEnd)} <small>ПК</small></strong></div>
                <div className="route-field route-length"><span className="field-label">ДЛИНА ТРАССЫ</span><strong className="mono">{formatNumber((snapshot.project.routeEnd - snapshot.project.routeStart) / 1000, 3)} <small>км</small></strong></div>
              </section>

              <section className="summary-strip" aria-label="Сводка объекта">
                <article className="summary-item summary-primary"><div className="summary-label"><span className="summary-mark progress-mark" />ВЫПОЛНЕНИЕ ПО СЛОЯМ</div><div className="summary-value">{roundedPercent(snapshot.summary.progressPercent)}<span>%</span></div><div className="summary-detail">{formatNumber(snapshot.summary.coveredLengthCentiPk / 1000)} из {formatNumber(snapshot.summary.workAreaLengthCentiPk / 1000)} <span>км·слоёв</span></div></article>
                <article className="summary-item"><div className="summary-label"><span className="summary-mark remaining-mark" />ОСТАЛОСЬ ВЫПОЛНИТЬ</div><div className="summary-value">{formatNumber(snapshot.summary.remainingLengthCentiPk / 1000)}<span>км·слоёв</span></div><div className="summary-detail">сумма по применимым слоям</div></article>
                <article className="summary-item"><div className="summary-label"><span className="summary-mark behind-mark" />НИЖЕ ПЛАНА</div><div className="summary-value">{snapshot.summary.layersBehindPlan}<span>слоя</span></div><div className="summary-detail">план сравнивается в п.п.</div></article>
                <div className="summary-explainer"><span className="equation-icon">Σ</span><span>Учитывается каждый слой отдельно.<br />Физическая длина трассы — <strong>{formatNumber((snapshot.project.routeEnd - snapshot.project.routeStart) / 1000, 3)} км</strong>.</span></div>
              </section>

              <section className="layers-panel" aria-labelledby="layers-title">
                <div className="panel-heading"><div><h2 id="layers-title">Выполнение по пикетажу</h2><p>Факт, план и доступный фронт на общей шкале трассы</p></div><div className="layer-actions">{layerOrderEditing ? <><button className="quiet-button" type="button" onClick={cancelLayerOrderEdit} disabled={saving}>Отмена</button><button className="compact-button active-action" type="button" onClick={saveLayerOrder} disabled={saving || !layerOrderChanged}>{saving ? "Сохранение…" : "Сохранить порядок"}</button></> : <><button className="quiet-button" type="button" onClick={beginLayerOrderEdit} disabled={saving}>Порядок слоёв</button><button className="compact-button active-action" type="button" onClick={beginCreateLayer} disabled={saving}><PlusIcon /> Добавить слой</button></>}</div></div>
                {!layerOrderEditing && <div className="table-toolbar">
                  <label className="search-box"><SearchIcon /><input aria-label="Найти пикет" type="text" inputMode="decimal" placeholder={`Найти ПК, ${formatPk(snapshot.project.routeStart)}`} value={search} onChange={(event) => setSearch(event.currentTarget.value)} onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)} />{search && <button className="clear-search" type="button" onClick={() => setSearch("")} aria-label="Очистить поиск">×</button>}</label>
                  <div className="filter-group" role="group" aria-label="Фильтр слоёв">
                    <button className={filter === "all" ? "filter-button selected" : "filter-button"} onClick={() => setFilter("all")} type="button">Все <span>{snapshot.layers.length}</span></button>
                    <button className={filter === "unfinished" ? "filter-button selected" : "filter-button"} onClick={() => setFilter("unfinished")} type="button">Незавершённые</button>
                    <button className={filter === "behind" ? "filter-button selected" : "filter-button"} onClick={() => setFilter("behind")} type="button">Ниже плана <span>{snapshot.summary.layersBehindPlan}</span></button>
                  </div>
                  <span className="table-result-count">{visibleLayers.length} из {snapshot.layers.length}</span>
                </div>}

                {layerOrderEditing ? <div className="layer-order-editor">
                  <div className="layer-order-intro"><strong>Перемещайте слои стрелками</strong><span>После сохранения базой каждого слоя станет слой сразу под ним.</span></div>
                  <ol className="layer-order-list">{layerOrderDraft.map((layerId, index) => {
                    const layer = snapshot.layers.find((item) => item.id === layerId);
                    if (!layer) return null;
                    const baseLayer = snapshot.layers.find((item) => item.id === layerOrderDraft[index + 1]);
                    return <li className="layer-order-row" key={layer.id} style={{ "--layer-color": layer.color } as CSSProperties}>
                      <span className="layer-order-index mono">{String(index + 1).padStart(2, "0")}</span><span className="layer-swatch" /><strong>{layer.name}</strong>
                      <span className="layer-order-base">База: {baseLayer?.name ?? "Вся рабочая область"}</span>
                      <span className="layer-order-controls"><button type="button" onClick={() => moveLayerInOrder(index, -1)} disabled={index === 0} aria-label={`Переместить слой «${layer.name}» выше`} title="Выше">↑</button><button type="button" onClick={() => moveLayerInOrder(index, 1)} disabled={index === layerOrderDraft.length - 1} aria-label={`Переместить слой «${layer.name}» ниже`} title="Ниже">↓</button></span>
                    </li>;
                  })}</ol>
                </div> : <div className="table-scroll">
                  <div className="layer-grid table-head"><div className="head-layer">СЛОЙ</div><div className="head-fact">ФАКТ</div><div className="head-plan">ПЛАН · ДАТА</div><div className="head-delta">Δ П.П.</div><div className="head-front">ФРОНТ</div><div className="head-scale"><div className="scale-title">ПИКЕТАЖНАЯ ШКАЛА</div><div className="scale-values mono">{[0, 25, 50, 75, 100].map((fraction) => <span key={fraction}>{formatPk(Math.round(snapshot.project.routeStart + (snapshot.project.routeEnd - snapshot.project.routeStart) * fraction / 100))}{fraction === 100 ? " ПК" : ""}</span>)}</div></div></div>
                  <div className="layer-list">
                    {visibleLayers.map((layer) => <LayerRow key={layer.id} layer={layer} project={snapshot.project} searchPosition={currentFilterPosition} selected={selectedLayerId === layer.id} onSelect={() => { setSelectedLayerId(layer.id); setLayerEditorOpen(false); setSegmentEditorOpen(false); }} />)}
                    {!visibleLayers.length && <div className="empty-filter"><span className="empty-icon">✓</span><strong>Под фильтр не попали слои</strong><span>Смените фильтр или добавьте новый слой.</span></div>}
                  </div>
                </div>}
                {!layerOrderEditing && search && currentFilterPosition === null && <p className="search-hint" role="status">Введите координату в границах трассы с точностью до 0,01 ПК.</p>}
                {!layerOrderEditing && searchFocused && currentFilterPosition !== null && <div className="search-result"><span className="search-result-marker" />ПК {search.trim()} отмечен на шкале трассы.</div>}
                {!layerOrderEditing && <footer className="panel-footer"><div className="legend"><span><i className="legend-complete" />Выполнено</span><span><i className="legend-front" />Доступный фронт</span><span><i className="legend-track" />Граница трассы</span></div><span className="footer-note"><InfoIcon /> Полосы показаны в масштабе всей трассы</span></footer>}
              </section>

              {selectedLayer && !layerOrderEditing && <section className="layer-detail" aria-labelledby="selected-layer-title">
                <div className="detail-heading"><div className="detail-title-wrap"><span className="layer-swatch large" style={{ "--layer-color": selectedLayer.color } as CSSProperties} /><div><div className="field-label">ВЫБРАННЫЙ СЛОЙ · {selectedLayer.code}</div><h2 id="selected-layer-title">{selectedLayer.name}</h2></div></div><div className="detail-actions"><button className="quiet-button" type="button" onClick={() => beginEditLayer(selectedLayer)}><EditIcon /> Изменить слой</button><button className="compact-button active-action" type="button" onClick={beginCreateSegment}><PlusIcon /> Добавить отрезок</button></div></div>
                <div className="detail-metrics"><div><span>ФАКТ</span><strong>{roundedPercent(selectedLayer.progressPercent)}%</strong><small>{formatKm(selectedLayer.coveredLengthCentiPk)} из {formatKm(selectedLayer.workAreaLengthCentiPk)}</small></div><div><span>ОСТАЛОСЬ</span><strong>{formatKm(selectedLayer.remainingLengthCentiPk)}</strong><small>в рабочей области слоя</small></div><div><span>ФРОНТ</span><strong>{formatKm(selectedLayer.frontLengthCentiPk)}</strong><small>{selectedLayer.baseLayerId ? `по базовому слою «${snapshot.layers.find((layer) => layer.id === selectedLayer.baseLayerId)?.name ?? ""}»` : "по всей рабочей области"}</small></div><div><span>ПЛАН</span><strong>{selectedLayer.planPercent === null ? "Не задан" : `${formatNumber(selectedLayer.planPercent, 1)}%`}</strong><small>{selectedLayer.planDate ? `на ${formatDate(selectedLayer.planDate)}` : "укажите процент и дату"}</small></div></div>

                {layerEditorOpen && <form className="editor-form layer-form" onSubmit={submitLayer}>
                  <div className="form-title"><div><h3>{editingLayerId ? "Параметры слоя" : "Новый слой"}</h3><p>При изменении порядка базовые слои пересчитываются автоматически.</p></div><button className="close-editor" type="button" onClick={closeLayerEditor} aria-label="Закрыть редактор">×</button></div>
                  <div className="form-grid layer-form-grid">
                    <label>Код<input required maxLength={16} value={layerForm.code} onChange={(event) => setLayerForm({ ...layerForm, code: event.currentTarget.value })} /></label>
                    <label>Название слоя<input required value={layerForm.name} onChange={(event) => setLayerForm({ ...layerForm, name: event.currentTarget.value })} /></label>
                    <label>Цвет<span className="color-input"><input type="color" value={layerForm.color} onChange={(event) => setLayerForm({ ...layerForm, color: event.currentTarget.value })} /><span className="mono">{layerForm.color.toUpperCase()}</span></span></label>
                    <label>План, %<input inputMode="decimal" placeholder="0–100" value={layerForm.planPercent} onChange={(event) => setLayerForm({ ...layerForm, planPercent: event.currentTarget.value })} /></label>
                    <label>Дата плана<input type="date" value={layerForm.planDate} onChange={(event) => setLayerForm({ ...layerForm, planDate: event.currentTarget.value })} /></label>
                  </div>
                  <div className="form-footer"><span className="form-hint">План задаётся вместе с датой.</span><div><button className="quiet-button" type="button" onClick={closeLayerEditor}>Отмена</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Сохранение…" : "Сохранить слой"}</button>{editingLayerId && <button className="danger-button" type="button" disabled={saving} onClick={() => removeLayer(selectedLayer)}>Удалить слой</button>}</div></div>
                </form>}

                <div className="segment-section"><div className="segment-heading"><div><h3>Отрезки работ</h3><span>{selectedLayer.segments.length} записей · длина вычисляется по координатам</span></div>{!layerEditorOpen && <button className="compact-button active-action" type="button" onClick={beginCreateSegment}><PlusIcon /> Добавить отрезок</button>}</div>
                  {segmentEditorOpen && <form className="editor-form segment-form" onSubmit={submitSegment}>
                    <div className="form-title"><div><h3>{editingSegmentId ? "Изменить отрезок" : "Новый отрезок"}</h3><p>Пересечения в одном слое и рабочей области не сохраняются.</p></div><button className="close-editor" type="button" onClick={closeSegmentEditor} aria-label="Закрыть редактор">×</button></div>
                    <div className="form-grid segment-form-grid">
                      <label>Рабочая область<select required value={segmentForm.workAreaId} onChange={(event) => setSegmentForm({ ...segmentForm, workAreaId: event.currentTarget.value })}>{snapshot.workAreas.filter((area) => selectedLayer.workAreaIds.includes(area.id) && (snapshot.bridgeEnabled || area.kind !== "bridge" || area.id === segmentForm.workAreaId)).map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label>
                      <label>От, ПК<input required inputMode="decimal" placeholder="0,00" value={segmentForm.fromPk} onChange={(event) => setSegmentForm({ ...segmentForm, fromPk: event.currentTarget.value })} /></label>
                      <label>До, ПК<input required inputMode="decimal" placeholder="0,00" value={segmentForm.toPk} onChange={(event) => setSegmentForm({ ...segmentForm, toPk: event.currentTarget.value })} /></label>
                      <label>Дата выполнения<input required type="date" value={segmentForm.workDate} onChange={(event) => setSegmentForm({ ...segmentForm, workDate: event.currentTarget.value })} /></label>
                      <label className="note-field">Комментарий<textarea rows={2} maxLength={2000} value={segmentForm.note} onChange={(event) => setSegmentForm({ ...segmentForm, note: event.currentTarget.value })} placeholder="Необязательно" /></label>
                    </div>
                    <div className="form-footer"><span className="form-hint">Интервал включает начало и не включает конец: [от, до).</span><div><button className="quiet-button" type="button" onClick={closeSegmentEditor}>Отмена</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Сохранение…" : "Сохранить отрезок"}</button></div></div>
                  </form>}
                  {!selectedLayer.segments.length && !segmentEditorOpen ? <div className="empty-segments"><span className="empty-icon">＋</span><strong>Пока нет отрезков</strong><span>Добавьте выполненный участок с датой и координатами.</span><button className="quiet-button" type="button" onClick={beginCreateSegment}><PlusIcon /> Добавить первый отрезок</button></div> : null}
                  {!!selectedLayer.segments.length && <div className="segment-table-wrap"><table className="segment-table"><thead><tr><th>ОТРЕЗОК, ПК</th><th>ДЛИНА</th><th>РАБОЧАЯ ОБЛАСТЬ</th><th>ДАТА</th><th>КОММЕНТАРИЙ</th><th><span className="visually-hidden">Действия</span></th></tr></thead><tbody>{selectedLayer.segments.map((segment) => <tr key={segment.id}><td className="mono">{formatPk(segment.fromCentiPk)} — {formatPk(segment.toCentiPk)}</td><td className="mono">{formatKm(segment.toCentiPk - segment.fromCentiPk)}</td><td>{snapshot.workAreas.find((area) => area.id === segment.workAreaId)?.name ?? "Рабочая область"}</td><td>{segment.workDate}</td><td className="segment-note">{segment.note || <span className="muted-dash">—</span>}</td><td className="segment-actions"><button type="button" onClick={() => beginEditSegment(segment)} aria-label={`Изменить отрезок ${formatPk(segment.fromCentiPk)}–${formatPk(segment.toCentiPk)} ПК`}><EditIcon /></button><button type="button" onClick={() => removeSegment(segment)} aria-label={`Удалить отрезок ${formatPk(segment.fromCentiPk)}–${formatPk(segment.toCentiPk)} ПК`}><TrashIcon /></button></td></tr>)}</tbody></table></div>}
                </div>
              </section>}

              <section className="work-area-panel" aria-labelledby="work-area-title">
                <div className="work-area-heading"><div><h2 id="work-area-title">Рабочие области и исключения</h2><p>Области задают применимость слоёв; исключённые диапазоны вычитаются из расчёта.</p></div><button className="compact-button active-action" type="button" onClick={beginBridgeSettings}>{snapshot.bridgeEnabled ? "Настроить мост" : "Настроить мост…"}</button></div>
                {snapshot.bridgeEnabled && bridgeArea && <div className="bridge-summary">
                  <div className="bridge-summary-title"><span className="bridge-mark" /> <strong>Мост</strong><span className="mono">{bridgeArea.intervals.map((interval) => `${formatPk(interval.fromCentiPk)}–${formatPk(interval.toCentiPk)} ПК`).join(", ")}</span></div>
                  <div className="bridge-progress"><strong>{bridgeTotal ? roundedPercent(bridgeCovered * 100 / bridgeTotal) : "0,0"}%</strong><span>{formatKm(bridgeCovered)} из {formatKm(bridgeTotal)} по применимым слоям</span></div>
                  <div className="bridge-lanes" aria-label="Выполнение слоёв в границах моста">
                    {bridgeLayers.map((layer) => {
                      const coverage = intersectIntervals(mergeIntervals(layer.segments.filter((segment) => segment.workAreaId === bridgeArea.id).map((segment) => ({ fromCentiPk: segment.fromCentiPk, toCentiPk: segment.toCentiPk }))), bridgeArea.intervals);
                      const excluded = snapshot.exclusions.filter((exclusion) => exclusion.appliesToLayerIds.includes(layer.id) && exclusion.workAreaIds.includes(bridgeArea.id)).flatMap((exclusion) => exclusion.intervals);
                      const effective = subtractIntervals(coverage, excluded);
                      return <div className="bridge-lane" key={layer.id}><span className="layer-swatch" style={{ "--layer-color": layer.color } as CSSProperties} /><span className="bridge-lane-name">{layer.name}</span><div className="bridge-lane-track">{bridgeArea.intervals.map((interval, index) => <span key={`scope-${index}`} className="bridge-scope" style={{ left: `${((interval.fromCentiPk - snapshot.project.routeStart) / (snapshot.project.routeEnd - snapshot.project.routeStart)) * 100}%`, width: `${((interval.toCentiPk - interval.fromCentiPk) / (snapshot.project.routeEnd - snapshot.project.routeStart)) * 100}%` }} />)}{effective.map((interval, index) => <span key={`covered-${index}`} className="bridge-covered" style={{ left: `${((interval.fromCentiPk - snapshot.project.routeStart) / (snapshot.project.routeEnd - snapshot.project.routeStart)) * 100}%`, width: `${((interval.toCentiPk - interval.fromCentiPk) / (snapshot.project.routeEnd - snapshot.project.routeStart)) * 100}%`, "--layer-color": layer.color } as CSSProperties} />)}</div><span className="mono bridge-lane-value">{formatKm(intervalLength(effective))}</span></div>;
                    })}
                  </div>
                </div>}
                <div className="custom-area-heading"><div><h3>Пользовательские области</h3><span>{snapshot.workAreas.filter((area) => area.kind === "custom").length} именованных диапазонов</span></div>{!workAreaEditorOpen && <button className="compact-button active-action" type="button" onClick={() => { setWorkAreaForm({ name: "", fromPk: formatPk(snapshot.project.routeStart), toPk: formatPk(snapshot.project.routeEnd), layerIds: snapshot.layers.map((layer) => layer.id) }); setWorkAreaEditorOpen(true); }}>Добавить область</button>}</div>
                {workAreaEditorOpen && <form className="work-area-editor custom-area-editor" onSubmit={saveWorkArea}>
                  <div className="form-title"><div><h3>Новая рабочая область</h3><p>Назовите диапазон и отметьте слои, которым он доступен.</p></div><button className="close-editor" type="button" onClick={() => setWorkAreaEditorOpen(false)} aria-label="Закрыть форму области">×</button></div>
                  <div className="custom-area-inputs"><label>Название<input required value={workAreaForm.name} onChange={(event) => setWorkAreaForm({ ...workAreaForm, name: event.currentTarget.value })} placeholder="Например, съезд 1" /></label><label>Начало, ПК<input required inputMode="decimal" value={workAreaForm.fromPk} onChange={(event) => setWorkAreaForm({ ...workAreaForm, fromPk: event.currentTarget.value })} /></label><label>Конец, ПК<input required inputMode="decimal" value={workAreaForm.toPk} onChange={(event) => setWorkAreaForm({ ...workAreaForm, toPk: event.currentTarget.value })} /></label></div>
                  <fieldset className="choice-fieldset"><legend>Применяется к слоям</legend><div>{snapshot.layers.map((layer) => <label key={layer.id}><input type="checkbox" checked={workAreaForm.layerIds.includes(layer.id)} onChange={(event) => setWorkAreaForm({ ...workAreaForm, layerIds: event.currentTarget.checked ? [...workAreaForm.layerIds, layer.id] : workAreaForm.layerIds.filter((id) => id !== layer.id) })} /><span>{layer.name}</span></label>)}</div></fieldset>
                  <div className="form-footer"><span className="form-hint">Границы и применимость можно удалить и создать заново.</span><div><button className="quiet-button" type="button" onClick={() => setWorkAreaEditorOpen(false)}>Отмена</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Сохранение…" : "Создать область"}</button></div></div>
                </form>}
                {!!snapshot.workAreas.filter((area) => area.kind === "custom").length && <div className="custom-area-list">{snapshot.workAreas.filter((area) => area.kind === "custom").map((area) => <article className="custom-area-row" key={area.id}><span className="custom-area-icon">⌖</span><div><strong>{area.name}</strong><span className="mono">{area.intervals.map((interval) => `${formatPk(interval.fromCentiPk)}–${formatPk(interval.toCentiPk)} ПК`).join(", ")}</span></div><span className="exclusion-scope">{snapshot.layers.filter((layer) => layer.workAreaIds.includes(area.id)).length} слоёв</span><button type="button" onClick={() => removeWorkArea(area)}>Удалить</button></article>)}</div>}
                {bridgeSettingsOpen && <div className="work-area-editor">
                  <div className="form-title"><div><h3>Настройка моста</h3><p>Мост — отдельная область проекта. Сегменты не копируются, а показатели пересчитываются из записей слоёв.</p></div><button className="close-editor" type="button" onClick={() => { setBridgeSettingsOpen(false); setBridgePreview(null); }} aria-label="Закрыть настройку моста">×</button></div>
                  <label className="toggle-field"><input type="checkbox" checked={bridgeForm.enabled} onChange={(event) => { setBridgeForm({ ...bridgeForm, enabled: event.currentTarget.checked }); setBridgePreview(null); }} /><span><strong>Использовать мост в этом проекте</strong><small>При отключении настройки и мостовые отрезки сохраняются, но не участвуют в расчётах.</small></span></label>
                  {bridgeForm.enabled && <>
                    <div className="bridge-inputs"><label>Начало, ПК<input required inputMode="decimal" value={bridgeForm.fromPk} onChange={(event) => { setBridgeForm({ ...bridgeForm, fromPk: event.currentTarget.value }); setBridgePreview(null); }} /></label><label>Конец, ПК<input required inputMode="decimal" value={bridgeForm.toPk} onChange={(event) => { setBridgeForm({ ...bridgeForm, toPk: event.currentTarget.value }); setBridgePreview(null); }} /></label></div>
                    <fieldset className="choice-fieldset"><legend>Мост относится к слоям</legend><div>{snapshot.layers.map((layer) => <label key={layer.id}><input type="checkbox" checked={bridgeForm.layerIds.includes(layer.id)} onChange={(event) => setBridgeForm({ ...bridgeForm, layerIds: event.currentTarget.checked ? [...bridgeForm.layerIds, layer.id] : bridgeForm.layerIds.filter((id) => id !== layer.id) })} /><span>{layer.name}</span></label>)}</div></fieldset>
                  </>}
                  {bridgePreview && <div className="preview-impact" role="status"><strong>Предварительный пересчёт</strong><span>Объект: {roundedPercent(snapshot.summary.progressPercent)}% → {roundedPercent(bridgePreview.summary.progressPercent)}%</span><span>Учтено: {formatKm(snapshot.summary.coveredLengthCentiPk)} → {formatKm(bridgePreview.summary.coveredLengthCentiPk)}</span><span>Осталось: {formatKm(snapshot.summary.remainingLengthCentiPk)} → {formatKm(bridgePreview.summary.remainingLengthCentiPk)}</span><span>Мост: {roundedPercent(bridgeImpactNow.percent)}% ({formatKm(bridgeImpactNow.covered)} / {formatKm(bridgeImpactNow.total)}) → {roundedPercent(bridgeImpactNext.percent)}% ({formatKm(bridgeImpactNext.covered)} / {formatKm(bridgeImpactNext.total)})</span></div>}
                  <div className="form-footer"><span className="form-hint">Предварительный просмотр не сохраняет изменения.</span><div><button className="quiet-button" type="button" onClick={previewBridge} disabled={saving}>{saving ? "Расчёт…" : "Предпросмотр"}</button><button className="quiet-button" type="button" onClick={() => { setBridgeSettingsOpen(false); setBridgePreview(null); }}>Отмена</button><button className="primary-button" type="button" onClick={saveBridge} disabled={saving}>{saving ? "Сохранение…" : "Применить"}</button></div></div>
                </div>}
                <div className="exclusion-heading"><div><h3>Исключённые диапазоны</h3><span>{snapshot.exclusions.length} настроек · каждый диапазон хранит причину и область применения</span></div>{!exclusionEditorOpen && <button className="compact-button active-action" type="button" onClick={beginCreateExclusion}>Добавить исключение</button>}</div>
                {exclusionEditorOpen && <form className="work-area-editor exclusion-editor" onSubmit={saveExclusion}>
                  <div className="form-title"><div><h3>{exclusionForm.id ? "Изменить исключение" : "Новое исключение"}</h3><p>Диапазон исключается только из выбранных слоёв и областей.</p></div><button className="close-editor" type="button" onClick={() => setExclusionEditorOpen(false)} aria-label="Закрыть редактор исключения">×</button></div>
                  <div className="exclusion-inputs"><label>Название<input required value={exclusionForm.name} onChange={(event) => setExclusionForm({ ...exclusionForm, name: event.currentTarget.value })} placeholder="Например, водопропускная труба" /></label><label>От, ПК<input required inputMode="decimal" value={exclusionForm.fromPk} onChange={(event) => setExclusionForm({ ...exclusionForm, fromPk: event.currentTarget.value })} /></label><label>До, ПК<input required inputMode="decimal" value={exclusionForm.toPk} onChange={(event) => setExclusionForm({ ...exclusionForm, toPk: event.currentTarget.value })} /></label><label className="reason-field">Причина<textarea required rows={2} value={exclusionForm.reason} onChange={(event) => setExclusionForm({ ...exclusionForm, reason: event.currentTarget.value })} /></label></div>
                  <fieldset className="choice-fieldset"><legend>Области</legend><div>{snapshot.workAreas.filter((area) => area.kind !== "bridge" || snapshot.bridgeEnabled).map((area) => <label key={area.id}><input type="checkbox" checked={exclusionForm.workAreaIds.includes(area.id)} onChange={(event) => setExclusionForm({ ...exclusionForm, workAreaIds: event.currentTarget.checked ? [...exclusionForm.workAreaIds, area.id] : exclusionForm.workAreaIds.filter((id) => id !== area.id) })} /><span>{area.name}</span></label>)}</div></fieldset>
                  <fieldset className="choice-fieldset"><legend>Слои</legend><div>{snapshot.layers.map((layer) => <label key={layer.id}><input type="checkbox" checked={exclusionForm.layerIds.includes(layer.id)} onChange={(event) => setExclusionForm({ ...exclusionForm, layerIds: event.currentTarget.checked ? [...exclusionForm.layerIds, layer.id] : exclusionForm.layerIds.filter((id) => id !== layer.id) })} /><span>{layer.name}</span></label>)}</div></fieldset>
                  <div className="form-footer"><span className="form-hint">Длина диапазона вычисляется автоматически.</span><div><button className="quiet-button" type="button" onClick={() => setExclusionEditorOpen(false)}>Отмена</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Сохранение…" : "Сохранить исключение"}</button></div></div>
                </form>}
                {!!snapshot.exclusions.length && <div className="exclusion-list">{snapshot.exclusions.map((exclusion) => <article className="exclusion-row" key={exclusion.id}><span className="exclusion-icon" aria-hidden="true">−</span><div><strong>{exclusion.name}</strong><span className="mono">{exclusion.intervals.map((interval) => `${formatPk(interval.fromCentiPk)}–${formatPk(interval.toCentiPk)} ПК`).join(", ")}</span><small>{exclusion.reason}</small></div><span className="exclusion-scope">{exclusion.appliesToLayerIds.length} слоёв · {exclusion.workAreaIds.length} областей</span><div className="exclusion-actions"><button type="button" onClick={() => beginEditExclusion(exclusion)}>Изменить</button><button type="button" onClick={() => removeExclusion(exclusion)}>Удалить</button></div></article>)}</div>}
              </section>

              {layerEditorOpen && !selectedLayer && <section className="layer-detail" aria-label="Добавить слой">
                <form className="editor-form layer-form" onSubmit={submitLayer}>
                  <div className="form-title"><div><h3>Новый слой</h3><p>Базовые слои определяются порядком слоёв автоматически.</p></div><button className="close-editor" type="button" onClick={closeLayerEditor} aria-label="Закрыть редактор">×</button></div>
                  <div className="form-grid layer-form-grid">
                    <label>Код<input required maxLength={16} value={layerForm.code} onChange={(event) => setLayerForm({ ...layerForm, code: event.currentTarget.value })} /></label>
                    <label>Название слоя<input required value={layerForm.name} onChange={(event) => setLayerForm({ ...layerForm, name: event.currentTarget.value })} /></label>
                    <label>Цвет<span className="color-input"><input type="color" value={layerForm.color} onChange={(event) => setLayerForm({ ...layerForm, color: event.currentTarget.value })} /><span className="mono">{layerForm.color.toUpperCase()}</span></span></label>
                    <label>План, %<input inputMode="decimal" placeholder="0–100" value={layerForm.planPercent} onChange={(event) => setLayerForm({ ...layerForm, planPercent: event.currentTarget.value })} /></label>
                    <label>Дата плана<input type="date" value={layerForm.planDate} onChange={(event) => setLayerForm({ ...layerForm, planDate: event.currentTarget.value })} /></label>
                  </div>
                  <div className="form-footer"><span className="form-hint">План задаётся вместе с датой.</span><div><button className="quiet-button" type="button" onClick={closeLayerEditor}>Отмена</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Сохранение…" : "Сохранить слой"}</button></div></div>
                </form>
              </section>}

              <div className="workspace-footnote"><span>easyPTO <b>·</b> слои дорожной одежды</span><span>{databaseStatus ? `Схема базы данных ${databaseStatus.schemaVersion}` : "Локальное хранилище"}</span></div>
            </>
            )
          )}
        </main>
      </div>

      <ChatModule active={activeModule === "chat"} onUnreadChange={updateChatUnread} onOpen={() => selectModule("chat")} />

      {availableUpdate && <div className="modal-backdrop update-backdrop" role="presentation"><section className="project-dialog update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title">
        <div className="dialog-heading"><div><span className="field-label">ОБНОВЛЕНИЕ easyPTO</span><h2 id="update-dialog-title">Доступна новая версия</h2><p>Установить easyPTO {availableUpdate.version}? Приложение закроется и запустится снова после установки.</p></div><button className="close-editor" type="button" onClick={() => void dismissUpdate()} disabled={installingUpdate} aria-label="Позже">×</button></div>
        {availableUpdate.body && <div className="update-notes">{availableUpdate.body}</div>}
        {updateError && <div className="inline-message error-message" role="alert"><InfoIcon />Не удалось установить обновление: {updateError}</div>}
        <div className="form-footer"><span className="form-hint">Версия {availableUpdate.currentVersion} → {availableUpdate.version}</span><div><button className="quiet-button" type="button" onClick={() => void dismissUpdate()} disabled={installingUpdate}>Позже</button><button className="primary-button" type="button" onClick={() => void installAvailableUpdate()} disabled={installingUpdate}>{installingUpdate ? "Загрузка и установка…" : "Установить"}</button></div></div>
      </section></div>}

      {projectDialogOpen && <div className="modal-backdrop" role="presentation"><form className="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" onSubmit={createProject}>
        <div className="dialog-heading"><div><span className="field-label">НОВЫЙ ОБЪЕКТ</span><h2 id="project-dialog-title">Создать объект</h2><p>Задайте название и границы трассы. Начальная конфигурация слоёв создастся автоматически.</p></div><button className="close-editor" type="button" onClick={() => setProjectDialogOpen(false)} aria-label="Закрыть">×</button></div>
        {error && <div className="inline-message error-message" role="alert"><InfoIcon />{error}</div>}
        <label>Название объекта<input autoFocus required value={projectName} onChange={(event) => setProjectName(event.currentTarget.value)} placeholder="Например, Северный обход" /></label>
        <div className="dialog-route"><label>Начало трассы, ПК<input required inputMode="decimal" value={routeStartPk} onChange={(event) => setRouteStartPk(event.currentTarget.value)} /></label><span aria-hidden="true">→</span><label>Конец трассы, ПК<input required inputMode="decimal" value={routeEndPk} onChange={(event) => setRouteEndPk(event.currentTarget.value)} /></label></div>
        <div className="dialog-footer"><button className="quiet-button" type="button" onClick={() => setProjectDialogOpen(false)}>Отмена</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Создание…" : "Создать объект"}</button></div>
      </form></div>}
      {projectDeleteDialogOpen && selectedProject && <div className="modal-backdrop" role="presentation"><section className="project-dialog" role="alertdialog" aria-modal="true" aria-labelledby="project-delete-title" aria-describedby="project-delete-copy">
        <div className="dialog-heading"><div><span className="field-label">УДАЛЕНИЕ ОБЪЕКТА</span><h2 id="project-delete-title">Удалить «{selectedProject.name}»?</h2><p id="project-delete-copy">Будут удалены все слои, отрезки, настройки и история этого объекта. Действие нельзя отменить.</p></div><button className="close-editor" type="button" onClick={() => setProjectDeleteDialogOpen(false)} disabled={saving} aria-label="Отмена">×</button></div>
        {error && <div className="inline-message error-message" role="alert"><InfoIcon />{error}</div>}
        <div className="dialog-footer"><button className="quiet-button" type="button" onClick={() => setProjectDeleteDialogOpen(false)} disabled={saving}>Оставить объект</button><button className="danger-button" type="button" onClick={() => void confirmRemoveSelectedProject()} disabled={saving}>{saving ? "Удаление…" : "Удалить объект"}</button></div>
      </section></div>}
      {constructionGuideOpen && <div className="modal-backdrop construction-guide-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeConstructionGuide(); }}><section className="project-dialog construction-guide-dialog" role="dialog" aria-modal="true" aria-labelledby="construction-guide-title" aria-describedby="construction-guide-copy">
        <div className="construction-guide-topline"><span className="field-label">КРАТКОЕ ОБУЧЕНИЕ</span><span>Шаг {constructionGuideStep + 1} из 3</span></div>
        <div className="construction-guide-progress" aria-hidden="true"><i style={{ width: `${((constructionGuideStep + 1) / 3) * 100}%` }} /></div>
        <h2 id="construction-guide-title">{["Добавьте линии работ", "Заносите выполненный объём", "Следите за прогрессом и отчётом"][constructionGuideStep]}</h2>
        <p id="construction-guide-copy">{[
          "Создайте отдельную линию для каждого вида работ. Укажите название, единицу измерения и плановый объём — например, «Укладка асфальта», метры, 1 200.",
          "Откройте линию и добавляйте фактически выполненный объём. Приложение суммирует записи, пересчитывает проценты и сохраняет дату каждой записи.",
          "Общий и построчный прогресс обновляются автоматически. Укажите адрес рядом с названием объекта, затем откройте «Отчёт»: его можно распечатать в PDF, с фотографией или без неё."
        ][constructionGuideStep]}</p>
        <div className="construction-guide-footer"><button className="quiet-button" type="button" onClick={closeConstructionGuide}>Закрыть обучение</button><div>{constructionGuideStep > 0 && <button className="quiet-button" type="button" onClick={() => setConstructionGuideStep((step) => step - 1)}>Назад</button>}<button className="primary-button" type="button" onClick={() => constructionGuideStep < 2 ? setConstructionGuideStep((step) => step + 1) : closeConstructionGuide()}>{constructionGuideStep < 2 ? "Дальше" : "Начать работу"}</button></div></div>
      </section></div>}
      {historyDialogOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHistoryDialogOpen(false); }}><section className="history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-dialog-title">
        <div className="dialog-heading"><div><span className="field-label">СОХРАННОСТЬ ДАННЫХ</span><h2 id="history-dialog-title">История и резервные копии</h2><p>Изменения записываются в локальную базу после проверки каждой операции.</p></div><button className="close-editor" type="button" onClick={() => setHistoryDialogOpen(false)} aria-label="Закрыть историю">×</button></div>
        {error && <div className="inline-message error-message" role="alert"><InfoIcon />{error}<button type="button" onClick={() => setError(null)} aria-label="Закрыть сообщение">×</button></div>}
        <div className="backup-actions"><div><strong>Резервная копия всей базы</strong><span>Содержит все объекты на этом компьютере.</span></div><button className="primary-button" type="button" onClick={createManualBackup} disabled={saving}>{saving ? "Создание…" : "Создать копию"}</button></div>
        <div className="history-columns"><section><h3>Последние действия · {snapshot?.project.name}</h3>{snapshot?.journal.length ? <ol className="journal-list">{snapshot.journal.map((item) => <li key={item.id}><span className="journal-dot" /><div><strong>{item.summary}</strong><time>{formatTimestamp(item.happenedAt)}</time></div></li>)}</ol> : <p className="history-empty">Пока нет записей журнала.</p>}</section><section><h3>Резервные копии · {backups.length}</h3>{backups.length ? <div className="backup-list">{backups.map((backup) => <article className="backup-row" key={backup.fileName}><div><strong>{formatTimestamp(backup.createdAt)}</strong><span>{backup.source}</span><small>{backup.projectNames.join(", ") || "Нет объектов"}</small>{backup.diagnostic && <small className="backup-diagnostic">Копию нельзя восстановить: {backup.diagnostic}</small>}</div><button className="quiet-button" type="button" onClick={() => restoreBackup(backup)} disabled={saving || Boolean(backup.diagnostic)}>Восстановить</button></article>)}</div> : <p className="history-empty">Резервных копий пока нет. Создайте первую копию кнопкой выше.</p>}</section></div>
        <p className="restore-note">Восстановление заменяет всю базу. Перед заменой создаётся страховочная копия. Это действие не является покомандной отменой.</p>
      </section></div>}
      {constructionReportSetupOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConstructionReportSetupOpen(false); }}><section className="project-dialog construction-photo-dialog" role="dialog" aria-modal="true" aria-labelledby="construction-photo-title">
        <div className="dialog-heading"><div><span className="field-label">ОФОРМЛЕНИЕ ОТЧЁТА</span><h2 id="construction-photo-title">Прикрепить фото?</h2><p>Можно добавить фотографию объекта в отчёт или продолжить без неё.</p></div><button className="close-editor" type="button" onClick={() => setConstructionReportSetupOpen(false)} aria-label="Закрыть">×</button></div>
        <input ref={constructionReportPhotoInput} className="visually-hidden" type="file" accept="image/*" aria-label="Выбрать фотографию объекта" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => { if (typeof reader.result === "string") { setConstructionReportPhoto(reader.result); setConstructionReportSetupOpen(false); setConstructionReportOpen(true); } }; reader.readAsDataURL(file); event.currentTarget.value = ""; }} />
        <div className="construction-photo-actions"><button className="quiet-button" type="button" onClick={() => { setConstructionReportPhoto(null); setConstructionReportSetupOpen(false); setConstructionReportOpen(true); }}>Продолжить без фото</button><button className="primary-button" type="button" onClick={() => constructionReportPhotoInput.current?.click()}>Выбрать фото на компьютере</button></div>
      </section></div>}
      {constructionReportOpen && constructionSnapshot && <div className="report-backdrop"><section className="report-shell construction-report-shell" role="dialog" aria-modal="true" aria-labelledby="construction-report-title">
        <div className="report-toolbar"><button className="quiet-button" type="button" onClick={() => setConstructionReportOpen(false)}>Назад</button><div><strong>Отчёт о выполнении работ</strong><span>Для сохранения выберите «Microsoft Print to PDF»</span></div><button className="primary-button" type="button" onClick={() => window.print()}>Печать / PDF</button></div>
        <article className={`print-report construction-print-report${constructionReportPhoto ? " has-report-photo" : ""}`}>
          <header className="construction-report-header"><img className="construction-brand-logo" src={easyPtoMark} alt="Логотип" /><div className="construction-report-meta"><span>Дата формирования: {new Intl.DateTimeFormat("ru-RU").format(new Date())}</span></div></header>
          <h1 id="construction-report-title">Отчёт о выполнении работ</h1><p className="construction-report-subtitle">Проект строительства автомобильной дороги</p>
          <section className={`construction-report-overview${constructionReportPhoto ? " with-photo" : ""}`}><div className="construction-report-object"><div><span>Объект:</span><strong>{constructionSnapshot.project.name}</strong></div><div><span>Адрес:</span><strong>{constructionSnapshot.project.address || "—"}</strong></div><div><span>Период отчёта:</span><strong>с {new Intl.DateTimeFormat("ru-RU").format(new Date(`${constructionReportStartDate}T00:00:00`))} по {new Intl.DateTimeFormat("ru-RU").format(new Date())}</strong></div></div>{constructionReportPhoto && <img className="construction-report-photo" src={constructionReportPhoto} alt="Фото объекта строительства" />}</section>
          <section className="construction-report-progress"><h2>Общий прогресс по объекту</h2><div className="construction-report-progress-body"><strong>{roundedPercent(constructionSnapshot.progressPercent)}<small>%</small></strong><div className="construction-report-progress-track"><i style={{ width: `${Math.min(100, Math.max(0, constructionSnapshot.progressPercent))}%` }} /></div><span>{constructionSnapshot.lines.length} линии данных</span></div></section>
          <div className="construction-report-charts"><section className="construction-report-card"><h2>Выполнение по линиям данных</h2><div className="construction-donut-layout"><div className="construction-donut"><svg viewBox="0 0 120 120" role="img" aria-label={`Выполнено ${roundedPercent(constructionSnapshot.progressPercent)} процентов`}><circle className="construction-donut-remaining" cx="60" cy="60" r="45" /><circle className="construction-donut-completed" cx="60" cy="60" r="45" strokeDasharray={`${(2 * Math.PI * 45 * Math.min(100, Math.max(0, constructionSnapshot.progressPercent))) / 100} ${2 * Math.PI * 45}`} /></svg><div><strong>{roundedPercent(constructionSnapshot.progressPercent)}%</strong><span>общий<br />прогресс</span></div></div><div className="construction-donut-legend"><span><i />Выполнено <strong>{roundedPercent(constructionSnapshot.progressPercent)}%</strong></span><span><i />Осталось <strong>{roundedPercent(Math.max(0, 100 - constructionSnapshot.progressPercent))}%</strong></span></div></div></section></div>
          <section className="construction-report-card construction-report-lines"><h2>Линии данных (объёмы работ)</h2><table className="report-layer-table construction-report-table"><thead><tr><th>№</th><th>Наименование</th><th>Ед. изм.</th><th>Объём (план)</th><th>Выполнено</th><th>Осталось</th><th>Прогресс</th></tr></thead><tbody>{constructionSnapshot.lines.map((line, index) => { const { short, precision } = unitMeta(line.unit); const remainingAmount = Math.max(0, line.plannedAmount - line.completedAmount); return <tr key={line.id}><td>{String(index + 1).padStart(2, "0")}</td><td>{line.name}</td><td>{short}</td><td>{formatNumber(line.plannedAmount, precision)}</td><td>{formatNumber(line.completedAmount, precision)}</td><td>{formatNumber(remainingAmount, precision)} {short}</td><td><strong>{roundedPercent(line.progressPercent)}%</strong><div className="report-track construction-report-track"><i style={{ width: `${Math.min(100, Math.max(0, line.progressPercent))}%` }} /></div></td></tr>; })}{!constructionSnapshot.lines.length && <tr><td colSpan={7}>Линий данных пока нет.</td></tr>}<tr className="construction-report-total"><td colSpan={2}>Итого по объекту</td><td>—</td><td>—</td><td>—</td><td>—</td><td><strong>{roundedPercent(constructionSnapshot.progressPercent)}%</strong><div className="report-track construction-report-track"><i style={{ width: `${Math.min(100, Math.max(0, constructionSnapshot.progressPercent))}%` }} /></div></td></tr></tbody></table></section>
          <footer className="construction-report-footer"><span>Страница 1 из 1</span></footer>
        </article>
      </section></div>}
      {constructionDeleteTarget && <div className="modal-backdrop construction-delete-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setConstructionDeleteTarget(null); }}><section className="project-dialog construction-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="construction-delete-title" aria-describedby="construction-delete-description">
        <div className="dialog-heading"><div><span className="field-label">УДАЛЕНИЕ ДАННЫХ</span><h2 id="construction-delete-title">Подтвердите удаление</h2><p id="construction-delete-description">{constructionDeleteTarget.kind === "line"
          ? `Удалить линию «${constructionDeleteTarget.line.name}» и все её записи выполнения? Общий прогресс объекта будет пересчитан.`
          : `Удалить запись ${formatNumber(constructionDeleteTarget.entry.amount, unitMeta(constructionDeleteTarget.line.unit).precision)} ${unitMeta(constructionDeleteTarget.line.unit).short} из линии «${constructionDeleteTarget.line.name}»? Прогресс будет пересчитан.`}</p></div><button className="close-editor" type="button" onClick={() => setConstructionDeleteTarget(null)} disabled={saving} aria-label="Отмена">×</button></div>
        {error && <div className="inline-message error-message" role="alert"><InfoIcon />{error}</div>}
        <div className="dialog-footer"><button className="quiet-button" type="button" onClick={() => { setConstructionDeleteTarget(null); setError(null); }} disabled={saving}>Отмена</button><button className="danger-button" type="button" onClick={() => void confirmConstructionDelete()} disabled={saving}>{saving ? "Удаление…" : "Удалить"}</button></div>
      </section></div>}
      {reportDialogOpen && snapshot && <div className="report-backdrop"><section className="report-shell" role="dialog" aria-modal="true" aria-labelledby="report-title">
        <div className="report-toolbar"><button className="quiet-button" type="button" onClick={() => setReportDialogOpen(false)}>Назад</button><div><strong>Предпросмотр отчёта</strong><span>Для файла выберите «Microsoft Print to PDF» в системном окне</span></div><button className="primary-button" type="button" onClick={() => window.print()}>Печать / PDF</button></div>
        <article className="print-report">
          <header className="report-header"><div><span className="report-kicker">easyPTO · ИНЖЕНЕРНЫЙ КОНТРОЛЬ</span><h1 id="report-title">Слои дорожной одежды</h1><h2>{snapshot.project.name}</h2></div><div className="report-meta"><span>Период: ПК {formatPk(snapshot.project.routeStart)} — {formatPk(snapshot.project.routeEnd)}</span><span>Длина трассы: {formatNumber((snapshot.project.routeEnd - snapshot.project.routeStart) / 1000, 3)} км</span><span>Сформирован: {new Intl.DateTimeFormat("ru-RU", { dateStyle: "long" }).format(new Date())}</span><span>Версия расчёта: {snapshot.calculationVersion}</span></div></header>
          <section className="report-summary"><div><span>ВЫПОЛНЕНО ПО СЛОЯМ</span><strong>{roundedPercent(snapshot.summary.progressPercent)}%</strong><small>{formatKm(snapshot.summary.coveredLengthCentiPk)} из {formatKm(snapshot.summary.workAreaLengthCentiPk)} · км·слоёв</small></div><div><span>ОСТАЛОСЬ</span><strong>{formatKm(snapshot.summary.remainingLengthCentiPk)}</strong><small>суммарно по применимым слоям</small></div><div><span>НИЖЕ ПЛАНА</span><strong>{snapshot.summary.layersBehindPlan} слоя</strong><small>отклонение в п.п.</small></div></section>
          {snapshot.bridgeEnabled && bridgeArea && <section className="report-bridge"><strong>Мост</strong><span>{bridgeArea.intervals.map((range) => `ПК ${formatPk(range.fromCentiPk)}–${formatPk(range.toCentiPk)}`).join(", ")}</span><span>{bridgeLayers.length} применимых слоёв · {formatKm(bridgeLength)} на один слой</span></section>}
          <section className="report-section"><h2>Выполнение по слоям</h2><table className="report-layer-table"><thead><tr><th>Слой</th><th>Факт</th><th>План</th><th>Δ п.п.</th><th>Фронт</th><th>Шкала трассы, ПК {formatPk(snapshot.project.routeStart)}—{formatPk(snapshot.project.routeEnd)}</th></tr></thead><tbody>{snapshot.layers.map((layer) => <tr key={layer.id}><td><span className="report-layer-title"><i style={{ background: layer.color }} />{layer.code} · {layer.name}</span><small>{formatKm(layer.coveredLengthCentiPk)} / {formatKm(layer.workAreaLengthCentiPk)}</small></td><td>{roundedPercent(layer.progressPercent)}%</td><td>{layer.planPercent === null ? "—" : `${formatNumber(layer.planPercent, 1)}%`}<small>{formatDate(layer.planDate)}</small></td><td>{layer.planDeltaPp === null ? "—" : `${layer.planDeltaPp > 0 ? "+" : ""}${formatNumber(layer.planDeltaPp, 1)}`}</td><td>{formatKm(layer.frontLengthCentiPk)}</td><td><div className="report-track">{layer.frontIntervals.map((range, index) => <i className="report-front" key={`f-${index}`} style={{ left: `${((range.fromCentiPk - snapshot.project.routeStart) / (snapshot.project.routeEnd - snapshot.project.routeStart)) * 100}%`, width: `${((range.toCentiPk - range.fromCentiPk) / (snapshot.project.routeEnd - snapshot.project.routeStart)) * 100}%` }} />)}{layer.coveredIntervals.map((range, index) => <i className="report-covered" key={`c-${index}`} style={{ left: `${((range.fromCentiPk - snapshot.project.routeStart) / (snapshot.project.routeEnd - snapshot.project.routeStart)) * 100}%`, width: `${((range.toCentiPk - range.fromCentiPk) / (snapshot.project.routeEnd - snapshot.project.routeStart)) * 100}%`, background: layer.color }} />)}</div></td></tr>)}</tbody></table></section>
          <section className="report-section"><h2>Участки работ</h2><table className="report-segment-table"><thead><tr><th>Слой</th><th>Рабочая область</th><th>От, ПК</th><th>До, ПК</th><th>Длина</th><th>Дата</th><th>Комментарий</th></tr></thead><tbody>{snapshot.layers.flatMap((layer) => layer.segments.map((segment) => { const area = snapshot.workAreas.find((item) => item.id === segment.workAreaId); const inactiveBridge = area?.kind === "bridge" && !snapshot.bridgeEnabled; return <tr key={segment.id} className={inactiveBridge ? "not-counted" : undefined}><td>{layer.code} · {layer.name}</td><td>{area?.name ?? "—"}{inactiveBridge && <small>мост отключён</small>}</td><td className="mono">{formatPk(segment.fromCentiPk)}</td><td className="mono">{formatPk(segment.toCentiPk)}</td><td>{formatKm(segment.toCentiPk - segment.fromCentiPk)}</td><td>{formatDate(segment.workDate)}</td><td>{segment.note || "—"}</td></tr>; }))}{!snapshot.layers.some((layer) => layer.segments.length) && <tr><td colSpan={7}>Отрезков работ пока нет.</td></tr>}</tbody></table></section>
          <section className="report-section"><h2>Исключённые диапазоны</h2>{snapshot.exclusions.length ? <table className="report-segment-table"><thead><tr><th>Название</th><th>Диапазон, ПК</th><th>Причина</th><th>Слои</th><th>Рабочие области</th></tr></thead><tbody>{snapshot.exclusions.map((item) => <tr key={item.id}><td>{item.name}</td><td className="mono">{item.intervals.map((range) => `${formatPk(range.fromCentiPk)}–${formatPk(range.toCentiPk)}`).join(", ")}</td><td>{item.reason}</td><td>{item.appliesToLayerIds.map((id) => snapshot.layers.find((layer) => layer.id === id)?.name ?? id).join(", ")}</td><td>{item.workAreaIds.map((id) => snapshot.workAreas.find((area) => area.id === id)?.name ?? id).join(", ")}</td></tr>)}</tbody></table> : <p>Исключённых диапазонов нет.</p>}</section>
          <footer className="report-footer"><span>Сформировано приложением easyPTO</span><span>Расчётная модель {snapshot.calculationVersion}</span></footer>
        </article>
      </section></div>}
    </div>
  );
}

function LayerRow({ layer, project, searchPosition, selected, onSelect }: { layer: LayerSnapshot; project: ProjectListItem; searchPosition: number | null; selected: boolean; onSelect: () => void }) {
  const routeLength = project.routeEnd - project.routeStart;
  const intervalStyle = (interval: Interval): CSSProperties => ({
    left: `${((interval.fromCentiPk - project.routeStart) / routeLength) * 100}%`,
    width: `${((interval.toCentiPk - interval.fromCentiPk) / routeLength) * 100}%`,
  });
  return <button className={`layer-grid layer-row${selected ? " selected" : ""}`} type="button" onClick={onSelect} style={{ "--layer-color": layer.color } as CSSProperties} aria-label={`${layer.name}. Факт ${roundedPercent(layer.progressPercent)} процентов. План ${layer.planPercent === null ? "не задан" : `${formatNumber(layer.planPercent, 1)} процентов`}.`} aria-pressed={selected}>
    <span className="layer-name-cell"><span className="layer-index mono">{String(layer.sortOrder + 1).padStart(2, "0")}</span><span className="layer-swatch" /><strong>{layer.name}</strong></span>
    <span className="fact-cell"><strong className="mono">{roundedPercent(layer.progressPercent)}<small>%</small></strong><span>{formatKm(layer.coveredLengthCentiPk)}</span></span>
    <span className="plan-cell">{layer.planPercent === null ? <><strong className="plan-empty">—</strong><span>не задан</span></> : <><strong className="mono">{formatNumber(layer.planPercent, 1)}<small>%</small></strong><span>{formatDate(layer.planDate)}</span></>}</span>
    <span className={`delta-cell${layer.planDeltaPp === null ? " neutral" : layer.planDeltaPp < 0 ? " negative" : layer.planDeltaPp > 0 ? " positive" : " neutral"}`}><span className="delta-symbol" aria-hidden="true">{layer.planDeltaPp === null || layer.planDeltaPp === 0 ? "—" : layer.planDeltaPp < 0 ? "↓" : "↑"}</span><strong className="mono">{layer.planDeltaPp === null ? "—" : `${layer.planDeltaPp > 0 ? "+" : ""}${formatNumber(layer.planDeltaPp, 1)}`}</strong></span>
    <span className="front-cell"><strong className="mono">{formatKm(layer.frontLengthCentiPk)}</strong></span>
    <span className="track-cell"><span className="track-base" aria-hidden="true">{layer.coveredIntervals.map((interval, index) => <i key={`covered-${index}`} className="track-covered" style={intervalStyle(interval)} />)}{layer.frontIntervals.map((interval, index) => <i key={`front-${index}`} className="track-front" style={intervalStyle(interval)} />)}<span className="track-ticks"><i /><i /><i /><i /></span>{searchPosition !== null && <i className="search-marker" style={{ left: `${searchPosition}%` }} />}</span></span>
  </button>;
}

function EmptyProjectState({ error, onCreate }: { error: string | null; onCreate: () => void }) {
  return <section className="empty-project-state"><span className="empty-project-icon"><RoadIcon /></span><span className="field-label">РАБОЧЕЕ МЕСТО</span><h1>{error ? "Локальная база пока недоступна" : "Создайте первый объект"}</h1><p>{error ? error : "Укажите название и границы трассы. easyPTO создаст начальные дорожные слои для дальнейшей настройки."}</p><button className="primary-button" type="button" onClick={onCreate}><PlusIcon /> Создать объект</button></section>;
}

function LoadingState() { return <div className="loading-state" role="status"><span className="loading-indicator" /><span>Загрузка объекта…</span></div>; }

function RoadIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 2 3.8 18M14 2l2.2 16M10 3v3m0 3v3m0 3v2" /></svg>; }
function ConstructionIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 17V8l4.8-4 4.6 4v9M12.4 11.5h4.8V17M6.4 10.5h2.2m-2.2 3h2.2m6.2 0h.1M2 17h16" /></svg>; }
function SettingsIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="2.5" /><path d="m8.4 2.9.5-1h2.2l.5 1 1.2.7 1.1-.2 1.1 1.9-.6.9v1.4l.6.9-1.1 1.9-1.1-.2-1.2.7-.5 1H8.9l-.5-1-1.2-.7-1.1.2L5 8.5l.6-.9V6.2L5 5.3l1.1-1.9 1.1.2 1.2-.7Z" transform="translate(0 2)" /></svg>; }
function ChevronIcon({ expanded }: { expanded: boolean }) { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d={expanded ? "m5 12 5-5 5 5" : "m5 8 5 5 5-5"} /></svg>; }
function CloseIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>; }
function RouteIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4v4a4 4 0 0 0 4 4h6a4 4 0 0 1 4 4v4M5 4h4M5 4v4m14 12h-4m4 0v-4" /></svg>; }
function DatabaseIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><ellipse cx="10" cy="4" rx="6.2" ry="2.3" /><path d="M3.8 4v5.9c0 1.3 2.8 2.4 6.2 2.4s6.2-1.1 6.2-2.4V4M3.8 9.8v5.8c0 1.3 2.8 2.4 6.2 2.4s6.2-1.1 6.2-2.4V9.8" /></svg>; }
function DocumentIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.8h6l4 4v10.4H5zM11 2.8v4h4M7.5 11h5m-5 3h5" /></svg>; }
function HelpIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.2" /><path d="M7.8 7.8a2.3 2.3 0 1 1 3.8 1.7c-1.1.9-1.6 1.2-1.6 2.5m0 2.6h.01" /></svg>; }
function ExportIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 12V3m0 0L6.5 6.5M10 3l3.5 3.5M4 11v5h12v-5" /></svg>; }
function SearchIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.7" cy="8.7" r="5.7" /><path d="m13 13 4 4" /></svg>; }
function EditIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 13.7-.8 3.1 3.1-.8L16 8.3 12.7 5 4 13.7ZM11.5 6.2l3.3 3.3" /></svg>; }
function TrashIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6h11M8 6V3.8h4V6m-6.5 0 .7 10.2h7.6L14.5 6M8.5 9v4.5m3-4.5v4.5" /></svg>; }
function PlusIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>; }
function InfoIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.2" /><path d="M10 9v4m0-6h.01" /></svg>; }
function CheckIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.7 3.3 7.3-7.6" /></svg>; }

export default App;
