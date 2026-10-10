import type { ReactNode } from "react";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  DAY_LABELS,
  IDLE_GAP_MS,
  REST_DAYS,
  STORAGE_KEY,
  absRoutines,
  advanceCycle,
  createDefaultStore,
  currentPlanForDay,
  flattenPlan,
  flexibilityRoutines,
  formatShortDate,
  formatTimer,
  isTrainingRecord,
  lSitPlan,
  lastPerformance,
  mainPlans,
  makeAbsPlan,
  makeExpressPlan,
  makeFlexPlan,
  makeMissedRecord,
  makeRestRecord,
  migrateStore,
  personalBest,
  progressionHint,
  isUnilateral,
  progressionExercises,
  recoveryStatus,
  skillMetrics,
  skipToDay,
  toLocalDate,
  type AbsRoutineKey,
  type ActiveSession,
  type ActiveStep,
  type FlexRoutineKey,
  type LevelKey,
  type Plan,
  type PreviousPerformance,
  type SavedExerciseResult,
  type SessionRecord,
  type Store,
} from "./training-data";

/* ------------------------------------------------------------------ */
/* Types & helpers                                                     */
/* ------------------------------------------------------------------ */

type Tab = "home" | "program" | "summary" | "skills" | "settings" | "workout";
type SummaryView = "session" | "progress" | "journal";
type ProgressMetric = "best" | "average" | "total";
type Sheet = { type: "skip" } | { type: "jump"; day: number } | { type: "exit" } | { type: "exercises" } | { type: "record"; id: string } | null;
type PersonalRecord = { name: string; value: number; before: number; unit: string };

type ExerciseGroup = { key: string; firstIndex: number; entries: { index: number; step: ActiveStep }[] };

type SummaryRow = {
  key: string;
  name: string;
  tracking: ActiveStep["tracking"];
  plannedSets: number | null;
  completedSets: number;
  total: number | null;
  best: number | null;
  level: number | null;
  status: "done" | "active" | "todo";
};

const LEVEL_LABELS: Record<LevelKey, string> = { handstand: "Handstand", hspu: "HSPU", dragon: "Dragon Flag", pistol: "Pistol Squat", lsit: "L-Sit" };
const SHORT_DAY = ["Up 1", "Low 1", "Libre", "Up 2", "Libre", "5×7", "Libre"];

/** merge = true : un superset / circuit devient un seul écran (tous ses exercices, tour par tour). */
function groupExercises(steps: ActiveStep[], merge = false): ExerciseGroup[] {
  const groups = new Map<string, ExerciseGroup>();
  steps.forEach((step, index) => {
    const key = merge && (step.blockKind === "superset" || step.blockKind === "circuit") ? step.blockId : `${step.blockId}:${step.id}`;
    const current = groups.get(key);
    if (current) current.entries.push({ index, step });
    else groups.set(key, { key, firstIndex: index, entries: [{ index, step }] });
  });
  return [...groups.values()];
}

function groupDone(group: ExerciseGroup) {
  return group.entries.every(({ step }) => step.result.done);
}

function activeSummary(groups: ExerciseGroup[], levels: Store["levels"]): SummaryRow[] {
  return groups.map((group) => {
    const step = group.entries[0].step;
    const isChallenge = step.tracking === "challenge";
    const values = group.entries.flatMap(({ step: item }) => isChallenge
      ? item.result.miniSets.filter((value) => value !== "").map(Number).filter(Number.isFinite)
      : [Number(item.result.value)].filter((value) => item.result.value !== "" && Number.isFinite(value)));
    const completedSets = isChallenge
      ? group.entries.reduce((sum, { step: item }) => sum + item.result.miniSets.filter((value) => value !== "").length, 0)
      : group.entries.filter(({ step: item }) => item.result.done).length;
    const plannedSets = isChallenge ? null : group.entries.length;
    const done = isChallenge ? groupDone(group) : completedSets === plannedSets;
    return {
      key: group.key, name: step.name, tracking: step.tracking, plannedSets, completedSets,
      total: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
      best: values.length ? Math.max(...values) : null,
      level: step.levelKey ? levels[step.levelKey] : null,
      status: done ? "done" : completedSets || values.length ? "active" : "todo",
    };
  });
}

function completedSummary(record: SessionRecord): SummaryRow[] {
  const groups = new Map<string, SessionRecord["results"]>();
  record.results.forEach((result) => groups.set(result.exerciseId, [...(groups.get(result.exerciseId) ?? []), result]));
  return [...groups.entries()].map(([key, results]) => {
    const first = results[0];
    const values = results.map((result) => result.challengeTotal ?? result.value).filter((value): value is number => value !== null && Number.isFinite(value));
    const completedSets = first.tracking === "challenge"
      ? results.reduce((sum, result) => sum + (result.challengeSets?.length ?? 0), 0)
      : results.filter((result) => result.done).length;
    return {
      key, name: first.exerciseName, tracking: first.tracking,
      plannedSets: first.tracking === "challenge" ? null : results.length, completedSets,
      total: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
      best: values.length ? Math.max(...values) : null,
      level: first.level,
      status: results.every((result) => result.done) ? "done" : completedSets ? "active" : "todo",
    };
  });
}

function bumpActivity(active: ActiveSession): ActiveSession {
  const now = Date.now();
  const last = active.lastActivityAt ?? active.startedAt;
  return { ...active, activeMs: (active.activeMs ?? 0) + Math.max(0, Math.min(now - last, IDLE_GAP_MS)), lastActivityAt: now };
}

function unitFor(tracking: ActiveStep["tracking"]) {
  return tracking === "seconds" ? "s" : "reps";
}

function previousLine(previous: PreviousPerformance) {
  const first = previous.results[0];
  if (first.tracking === "challenge") return `${first.challengeTotal ?? 0} reps`;
  if (first.tracking === "check") return [first.level ? `Niveau ${first.level}` : "Validé", first.variant.trim()].filter(Boolean).join(" · ");
  const values = previous.results.filter((result) => result.value !== null).map((result) => result.sides && (result.sides.left !== null || result.sides.right !== null) ? `${result.sides.left ?? "–"}/${result.sides.right ?? "–"}` : String(result.value));
  if (!values.length) return "—";
  return first.tracking === "seconds" ? `${values.join(" · ")} s` : values.join(" · ");
}

function previousDetails(previous: PreviousPerformance) {
  const variants = [...new Set(previous.results.map((result) => result.variant.trim()).filter((value) => value && !/^[0\-–—.]+$/.test(value)))];
  const ballasts = [...new Set(previous.results.map((result) => result.ballast).filter((value): value is number => value !== null && value > 0))];
  const challengeSets = previous.results[0].challengeSets;
  return [
    challengeSets?.length ? challengeSets.join("-") : null,
    variants.length ? variants.join(", ") : null,
    ballasts.length ? `+${ballasts.join("/")} kg` : null,
  ].filter(Boolean).join(" · ");
}

function formatLongDate(date: Date) {
  const text = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" }).format(date);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

type IconName = "home" | "program" | "chart" | "levels" | "gear" | "play" | "check" | "close" | "list" | "arrow" | "back" | "chevron" | "upload" | "download" | "moon" | "skip" | "clock" | "plus";

function Icon({ name, size = 22, stroke = 1.9 }: { name: IconName; size?: number; stroke?: number }) {
  const paths: Record<IconName, ReactNode> = {
    home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.8V21h14V9.8" /></>,
    program: <><path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
    chart: <><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20H2" /></>,
    levels: <><path d="m5 8 7-5 7 5" /><path d="m6 16 6 5 6-5" /><path d="M4 12h16" /></>,
    gear: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
    play: <path d="M8 5.5v13l10-6.5-10-6.5Z" fill="currentColor" stroke="none" />,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="M6 6l12 12M18 6 6 18" />,
    list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    back: <path d="m15 5-7 7 7 7" />,
    chevron: <path d="m9 6 6 6-6 6" />,
    upload: <><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 20h16" /></>,
    download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 20h16" /></>,
    moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" />,
    skip: <><path d="M5 5.5v13l9-6.5-9-6.5Z" /><path d="M18 5v14" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function unlockAudio(ref: { current: AudioContext | null }) {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    if (!ref.current) ref.current = new Ctor();
    if (ref.current.state === "suspended") ref.current.resume().catch(() => undefined);
  } catch { /* pas de son, pas grave */ }
}

function playBeep(ref: { current: AudioContext | null }) {
  const ctx = ref.current;
  if (!ctx) return;
  try {
    [0, 0.22].forEach((delay) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.18);
    });
  } catch { /* ignore */ }
}

function Delta({ value }: { value: number | null }) {
  if (value === null) return null;
  return <span className={`delta ${value > 0 ? "up" : value < 0 ? "down" : "same"}`}>{value > 0 ? `+${value}` : value === 0 ? "=" : value}</span>;
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export default function App() {
  const [store, setStore] = useState<Store | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [selectedPlanId, setSelectedPlanId] = useState(mainPlans[0].id);
  const [summaryView, setSummaryView] = useState<SummaryView>("session");
  const [, setTick] = useState(0);
  const [absKey, setAbsKey] = useState<AbsRoutineKey>("beginner");
  const [absEffort, setAbsEffort] = useState(45);
  const [absTransition, setAbsTransition] = useState(15);
  const [absRounds, setAbsRounds] = useState(2);
  const [flexKey, setFlexKey] = useState<FlexRoutineKey>("beginner");
  const [flexSets, setFlexSets] = useState(3);
  const [flexHold, setFlexHold] = useState(30);
  const [flexRest, setFlexRest] = useState(40);
  const [skillInputs, setSkillInputs] = useState<Record<string, string>>({});
  const [progressExerciseId, setProgressExerciseId] = useState("pull-explosive");
  const [progressMetric, setProgressMetric] = useState<ProgressMetric>("best");
  const [tipsOpen, setTipsOpen] = useState(false);
  const [newRecords, setNewRecords] = useState<PersonalRecord[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const restored = migrateStore(JSON.parse(saved));
        setStore(restored);
        // Séance en cours récente : on la rouvre directement (l'iPhone a pu recharger l'appli).
        if (restored.active && Date.now() - (restored.active.lastActivityAt ?? restored.active.startedAt) < 3 * 3600 * 1000) setTab("workout");
        return;
      }
    } catch { /* Une sauvegarde locale abîmée ne doit pas bloquer l'appli. */ }
    setStore(createDefaultStore());
  }, []);
  useEffect(() => { if (store) { try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* stockage plein ou bloqué */ } } }, [store]);
  useEffect(() => { if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => undefined); }, []);

  /* Chrono basé sur l'heure de fin : il reste juste même si l'iPhone se verrouille. */
  const restEndAt = store?.active?.restEndAt ?? null;
  useEffect(() => {
    if (!restEndAt) return;
    const tick = () => {
      if (Date.now() >= restEndAt) {
        playBeep(audioRef);
        try { navigator.vibrate?.([200, 100, 200]); } catch { /* non supporté sur iOS */ }
        setStore((current) => current?.active && current.active.restEndAt === restEndAt ? { ...current, active: { ...current.active, restEndAt: null } } : current);
      } else setTick((value) => value + 1);
    };
    tick();
    const timer = window.setInterval(tick, 500);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [restEndAt]);

  /* Écran allumé pendant la séance (iOS 16.4+ en appli installée). */
  const inWorkoutMode = tab === "workout" && Boolean(store?.active);
  useEffect(() => {
    if (!inWorkoutMode || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== "visible") return;
      try { const next = await navigator.wakeLock.request("screen"); if (cancelled) next.release().catch(() => undefined); else lock = next; } catch { /* refusé : pas grave */ }
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", acquire); lock?.release().catch(() => undefined); };
  }, [inWorkoutMode]);

  const absPlan = useMemo(() => makeAbsPlan(absKey, absEffort, absTransition, absRounds), [absKey, absEffort, absTransition, absRounds]);
  const flexPlan = useMemo(() => makeFlexPlan(flexKey, flexSets, flexHold, flexRest), [flexKey, flexSets, flexHold, flexRest]);
  const trackedExercises = useMemo(() => progressionExercises(), []);

  if (!store) return <main className="loading"><span className="loading-dot" /></main>;

  /* ---------- état dérivé ---------- */
  const complete = store.currentWeek > 6;
  const currentPlan = complete ? null : currentPlanForDay(store.cycleDay);
  const isRestDay = !complete && REST_DAYS.has(store.cycleDay);
  const absoluteDay = complete ? 42 : (store.currentWeek - 1) * 7 + store.cycleDay;
  const status = recoveryStatus(store.recovery);
  const active = store.active;
  const groups = active ? groupExercises(active.steps, true) : [];
  const exerciseGroups = active ? groupExercises(active.steps) : [];
  const groupIndex = active ? Math.max(0, groups.findIndex((group) => group.entries.some(({ index }) => index === active.stepIndex))) : 0;
  const group = groups[groupIndex] ?? null;
  const step = group?.entries[0]?.step ?? null;
  /* Exercices de l'écran courant (plusieurs pour un superset / circuit), avec leur historique. */
  const members = group ? [...new Map(group.entries.map(({ step: item }) => [item.id, item])).values()].map((item) => ({
    step: item,
    entries: group.entries.filter(({ step: entry }) => entry.id === item.id),
    previous: lastPerformance(store.history, item.id),
    best: personalBest(store.history, item.id),
    hint: progressionHint(store.history, item, item.levelKey ? store.levels[item.levelKey] : null),
  })) : [];
  const staleActive = active && Date.now() - (active.lastActivityAt ?? active.startedAt) > 6 * 3600 * 1000;
  const mainDone = store.history.filter((record) => record.kind === "main" || record.kind === "challenge").length;
  const missedCount = store.history.filter((record) => record.kind === "missed").length;
  const weekRecords = store.history.filter((record) => record.blockWeek === store.currentWeek);
  const weekMainDone = weekRecords.filter((record) => record.kind === "main" || record.kind === "challenge").length;
  const lastSession = [...store.history].reverse().find(isTrainingRecord) ?? null;
  const selectedPlan = mainPlans.find((plan) => plan.id === selectedPlanId) ?? mainPlans[0];
  const daysSinceExport = store.lastExportAt ? Math.floor((Date.now() - Date.parse(store.lastExportAt)) / 86400000) : null;
  const needsBackup = store.history.length > 0 && (daysSinceExport === null || daysSinceExport >= 7);
  const editedRecord = sheet?.type === "record" ? store.history.find((record) => record.id === sheet.id) ?? null : null;
  const jumpTarget = sheet?.type === "jump" ? sheet.day : null;
  const jumpSkipped = jumpTarget ? Array.from({ length: jumpTarget - store.cycleDay }, (_, index) => store.cycleDay + index) : [];

  /* ---------- actions ---------- */
  const setRest = (endAt: number | null, label?: string) => setStore((current) => !current?.active ? current : { ...current, active: { ...current.active, restEndAt: endAt, restLabel: label ?? current.active.restLabel } });
  const resetTimer = () => setRest(null);
  const startRest = (seconds: number, label = "Repos") => { if (seconds <= 0) return; unlockAudio(audioRef); setRest(Date.now() + seconds * 1000, label); };
  const addRest = (seconds: number) => setRest(Math.max(restEndAt ?? 0, Date.now()) + seconds * 1000);
  const restRemaining = restEndAt ? Math.max(0, Math.ceil((restEndAt - Date.now()) / 1000)) : 0;

  const startPlan = (plan: Plan, advancesPlan: boolean, express = false) => {
    if (active && !window.confirm(`« ${active.plan.title} » est en cours. La remplacer ?`)) return;
    setStore({ ...store, active: { plan, startedAt: Date.now(), stepIndex: 0, steps: flattenPlan(plan), warmupDone: false, advancesPlan, activeMs: 0, lastActivityAt: Date.now(), express } });
    setSheet(null);
    resetTimer();
    setTab("workout");
    window.scrollTo({ top: 0 });
  };

  const updateSteps = (mapper: (step: ActiveStep, index: number) => ActiveStep) => {
    setStore((current) => !current?.active ? current : { ...current, active: bumpActivity({ ...current.active, steps: current.active.steps.map(mapper) }) });
  };
  const updateResult = (stepIndex: number, field: "value" | "ballast", value: string) =>
    updateSteps((item, index) => index === stepIndex ? { ...item, result: { ...item.result, [field]: value } } : item);
  /** Côté gauche / droit : la valeur de référence (stats, records) est le côté le plus faible. */
  const updateSide = (stepIndex: number, side: "left" | "right", value: string) =>
    updateSteps((item, index) => {
      if (index !== stepIndex) return item;
      const next = { ...item.result, [side]: value };
      const numbers = [next.left, next.right].filter((entry): entry is string => entry !== undefined && entry !== "").map(Number).filter(Number.isFinite);
      return { ...item, result: { ...next, value: numbers.length ? String(Math.min(...numbers)) : "" } };
    });
  const setGroupVariant = (value: string, exerciseId: string) => {
    if (!group) return;
    const indexes = new Set(group.entries.filter(({ step: item }) => item.id === exerciseId).map(({ index }) => index));
    updateSteps((item, index) => indexes.has(index) ? { ...item, result: { ...item.result, variant: value } } : item);
  };
  const updateMiniSet = (stepIndex: number, setIndex: number, value: string) =>
    updateSteps((item, index) => index === stepIndex ? { ...item, result: { ...item.result, miniSets: item.result.miniSets.map((entry, entryIndex) => entryIndex === setIndex ? value : entry) } } : item);
  const addMiniSet = (stepIndex: number) =>
    updateSteps((item, index) => index === stepIndex ? { ...item, result: { ...item.result, miniSets: [...item.result.miniSets, ""] } } : item);

  const toggleSet = (stepIndex: number) => {
    const target = active?.steps[stepIndex];
    if (!target) return;
    const wasDone = target.result.done;
    const prevResult = lastPerformance(store.history, target.id)?.results.find((result) => result.series === target.round);
    const fallback = target.result.value === "" ? prevResult?.value : null;
    const unilateral = isUnilateral(target);
    updateSteps((item, index) => {
      if (index !== stepIndex) return item;
      const result = { ...item.result, done: !wasDone };
      if (!wasDone && unilateral) {
        const left = result.left || (prevResult?.sides?.left ?? prevResult?.value)?.toString() || "";
        const right = result.right || (prevResult?.sides?.right ?? prevResult?.value)?.toString() || "";
        const numbers = [left, right].filter(Boolean).map(Number);
        return { ...item, result: { ...result, left, right, value: numbers.length ? String(Math.min(...numbers)) : result.value } };
      }
      return { ...item, result: { ...result, value: !wasDone && fallback != null ? String(fallback) : item.result.value } };
    });
    if (!wasDone) startRest(target.restSec);
  };

  const toggleGroup = () => {
    if (!group || !step) return;
    const allDone = groupDone(group);
    const indexes = new Set(group.entries.map(({ index }) => index));
    updateSteps((item, index) => indexes.has(index) ? { ...item, result: { ...item.result, done: !allDone } } : item);
    if (!allDone && step.tracking !== "challenge") startRest(group.entries[group.entries.length - 1].step.restSec);
  };

  const goToGroup = (index: number) => {
    const target = groups[Math.min(Math.max(index, 0), groups.length - 1)];
    if (!target) return;
    setStore((current) => !current?.active ? current : { ...current, active: { ...current.active, stepIndex: target.firstIndex } });
    setTipsOpen(false);
    setSheet(null);
    window.scrollTo({ top: 0 });
  };

  const finishSession = () => {
    if (!store.active) return;
    const session = bumpActivity(store.active);
    const results: SavedExerciseResult[] = session.steps.map((item) => ({
      exerciseId: item.id,
      exerciseName: item.name,
      tracking: item.tracking,
      series: item.round,
      value: item.result.value === "" ? null : Number(item.result.value),
      sides: isUnilateral(item) && (item.result.left || item.result.right) ? { left: item.result.left ? Number(item.result.left) : null, right: item.result.right ? Number(item.result.right) : null } : undefined,
      ballast: item.result.ballast === "" ? null : Number(item.result.ballast),
      variant: item.result.variant,
      rpe: item.result.rpe === "" ? null : Number(item.result.rpe),
      done: item.result.done,
      level: item.levelKey ? store.levels[item.levelKey] : null,
      challengeTotal: item.tracking === "challenge" ? item.result.miniSets.reduce((sum, value) => sum + (Number(value) || 0), 0) : null,
      challengeSets: item.tracking === "challenge" ? item.result.miniSets.filter((value) => value !== "").map(Number).filter(Number.isFinite) : undefined,
    }));
    const record: SessionRecord = {
      id: `${session.plan.id}-${Date.now()}`,
      planId: session.plan.id,
      title: session.plan.title,
      kind: session.plan.kind,
      date: toLocalDate(new Date()),
      durationMin: Math.max(1, Math.round((session.activeMs ?? 0) / 60000)),
      blockWeek: store.currentWeek,
      cycleDay: store.cycleDay,
      completedSteps: session.steps.filter((item) => item.result.done).length,
      totalSteps: session.steps.length,
      results,
      note: session.note?.trim() || undefined,
      express: session.express || undefined,
    };
    const records: PersonalRecord[] = [];
    [...new Set(results.map((result) => result.exerciseId))].forEach((exerciseId) => {
      const own = results.filter((result) => result.exerciseId === exerciseId);
      const values = own.map((result) => result.tracking === "challenge" ? result.challengeTotal : result.done ? result.value : null).filter((value): value is number => value !== null && value > 0);
      const before = personalBest(store.history, exerciseId);
      if (values.length && before && Math.max(...values) > before.value) records.push({ name: own[0].exerciseName, value: Math.max(...values), before: before.value, unit: own[0].tracking === "seconds" ? "s" : "reps" });
    });
    setNewRecords(records);
    const base = { ...store, history: [...store.history, record], active: null };
    setStore(session.advancesPlan ? advanceCycle(base) : base);
    resetTimer();
    setSheet(null);
    setSummaryView("session");
    setTab("summary");
    window.scrollTo({ top: 0 });
  };

  const abandonSession = () => {
    if (!store.active || !window.confirm(`Abandonner « ${store.active.plan.title} » ? Rien ne sera enregistré.`)) return;
    setStore({ ...store, active: null });
    resetTimer();
    setSheet(null);
    setTab("home");
  };

  const markRest = () => { if (isRestDay) setStore(advanceCycle({ ...store, history: [...store.history, makeRestRecord(store)] })); };
  const markMissed = () => { if (currentPlan) setStore(advanceCycle({ ...store, history: [...store.history, makeMissedRecord(store, currentPlan)] })); setSheet(null); };
  const jumpToDay = (day: number) => { setStore(skipToDay(store, store.currentWeek, day)); setSheet(null); };
  const setLevel = (key: LevelKey, level: 1 | 2 | 3) => setStore({ ...store, levels: { ...store.levels, [key]: level } });

  const saveSkill = (skillId: string) => {
    const value = Number(skillInputs[skillId]);
    if (!Number.isFinite(value) || value <= 0) return;
    setStore({ ...store, skillLogs: [...store.skillLogs, { id: `${skillId}-${Date.now()}`, skillId, date: toLocalDate(new Date()), value }] });
    setSkillInputs({ ...skillInputs, [skillId]: "" });
  };

  const exportData = async () => {
    const exportedAt = new Date().toISOString();
    const snapshot = { ...store, lastExportAt: exportedAt };
    const name = `baptiste-training-${toLocalDate(new Date())}.json`;
    const json = JSON.stringify(snapshot, null, 2);
    const markDone = () => setStore((current) => current ? { ...current, lastExportAt: exportedAt } : current);
    try {
      const file = new File([json], name, { type: "application/json" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "Sauvegarde Baptiste Training" });
        markDone();
        return;
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
    }
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
    markDone();
  };

  const updateRecord = (id: string, mapper: (record: SessionRecord) => SessionRecord) =>
    setStore((current) => current ? { ...current, history: current.history.map((record) => record.id === id ? mapper(record) : record) } : current);
  const updateRecordResult = (id: string, resultIndex: number, field: "value" | "ballast", raw: string) =>
    updateRecord(id, (record) => ({ ...record, results: record.results.map((result, index) => index === resultIndex ? { ...result, [field]: raw === "" ? null : Number(raw.replace(",", ".")) } : result) }));
  const deleteRecord = (id: string) => {
    if (!window.confirm("Supprimer cette entrée du journal ? Le planning ne recule pas.")) return;
    setStore((current) => current ? { ...current, history: current.history.filter((record) => record.id !== id) } : current);
    setSheet(null);
  };
  const setActiveNote = (note: string) => setStore((current) => current?.active ? { ...current, active: { ...current.active, note } } : current);

  const importData = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = migrateStore(JSON.parse(await file.text()));
      if (!parsed.lastExportAt) parsed.lastExportAt = new Date().toISOString();
      if (store.history.length && !window.confirm(`Remplacer tes ${store.history.length} entrées par cette sauvegarde (${parsed.history.length} entrées) ?`)) return;
      setStore(parsed);
      setTab("home");
    } catch { window.alert("Ce fichier n’est pas une sauvegarde Baptiste Training valide."); }
    finally { event.target.value = ""; }
  };

  /* ------------------------------------------------------------------ */
  /* Écrans                                                              */
  /* ------------------------------------------------------------------ */

  const header = (title: string, eyebrow?: string, back?: () => void) => <header className="page-header">
    <div className="page-header-row">
      {back ? <button className="icon-button" aria-label="Retour" onClick={back}><Icon name="back" /></button> : <span className="page-date">{formatLongDate(new Date())}</span>}
      {!back && <button className="icon-button" aria-label="Réglages et sauvegarde" onClick={() => setTab("settings")}><Icon name="gear" size={20} /></button>}
    </div>
    {eyebrow && <p className="eyebrow">{eyebrow}</p>}
    <h1>{title}</h1>
  </header>;

  const renderHome = () => {
    const planForPreview = currentPlan;
    const previewRows = planForPreview
      ? planForPreview.blocks.flatMap((block) => block.exercises).filter((item) => item.tracking !== "check")
        .map((item) => ({ item, previous: lastPerformance(store.history, item.id) }))
        .filter((row) => row.previous).slice(0, 4)
      : [];
    const previewDate = previewRows[0]?.previous?.record.date;
    return <div className="page">
      <header className="page-header">
        <div className="page-header-row">
          <span className="page-date">{formatLongDate(new Date())}</span>
          <button className="icon-button" aria-label="Réglages et sauvegarde" onClick={() => setTab("settings")}><Icon name="gear" size={20} /></button>
        </div>
        <p className="eyebrow">{complete ? "Bloc 1 terminé" : `Semaine ${store.currentWeek} · Jour ${store.cycleDay}`}</p>
        <h1>{complete ? "Bloc terminé" : isRestDay ? "Jour libre" : currentPlan?.title}</h1>
        <p className="lead">{complete ? "Exporte ta sauvegarde avant de lancer le bloc suivant." : isRestDay ? "Repos complet, ou une routine légère si tu es frais." : `≈ ${currentPlan?.duration} min · ${currentPlan?.focus}`}</p>
      </header>

      {staleActive && active && <div className="notice warning"><div><strong>Séance restée ouverte</strong><p>{active.plan.title}, commencée le {formatShortDate(toLocalDate(new Date(active.startedAt)))}.</p></div><div className="notice-actions"><button className="btn btn-quiet" onClick={() => setTab("workout")}>Ouvrir</button><button className="btn btn-quiet danger" onClick={abandonSession}>Abandonner</button></div></div>}
      {needsBackup && !staleActive && <div className="notice"><div><strong>{daysSinceExport === null ? "Aucune sauvegarde récente" : `Dernière sauvegarde il y a ${daysSinceExport} jours`}</strong><p>Enregistre une copie dans Fichiers, au cas où.</p></div><button className="btn btn-secondary btn-small" onClick={exportData}><Icon name="download" size={18} />Sauvegarder</button></div>}
      {!store.history.length && !active && <div className="notice"><div><strong>Récupère ton historique</strong><p>Importe ta dernière sauvegarde (.json) pour retrouver tes séances et tes perfs.</p></div><button className="btn btn-primary btn-small" onClick={() => fileInputRef.current?.click()}><Icon name="upload" size={18} />Importer</button></div>}

      <div className="actions">
        {active ? <button className="btn btn-primary btn-large" onClick={() => setTab("workout")}><Icon name="play" size={18} />Reprendre {active.plan.shortTitle}</button>
          : complete ? <button className="btn btn-primary btn-large" onClick={exportData}><Icon name="download" size={20} />Exporter la sauvegarde</button>
          : isRestDay ? <>
            <button className="btn btn-primary btn-large" onClick={markRest}><Icon name="moon" size={20} />Valider le repos</button>
            <button className="btn btn-text" onClick={() => setTab("program")}>Choisir une routine</button>
          </> : currentPlan && <>
            <button className="btn btn-primary btn-large" onClick={() => startPlan(currentPlan, true)}><Icon name="play" size={18} />Commencer la séance</button>
            <div className="split-actions">
              <button className="btn btn-secondary" onClick={() => startPlan(makeExpressPlan(currentPlan), true, true)}><Icon name="clock" size={17} />Express · {makeExpressPlan(currentPlan).duration} min</button>
              <button className="btn btn-quiet" onClick={() => setSheet({ type: "skip" })}>Pas de salle</button>
            </div>
          </>}
      </div>

      {!complete && <section className="card">
        <div className="card-head"><h2>Cette semaine</h2><span>{weekMainDone} / 4 séances</span></div>
        <div className="week">{DAY_LABELS.map((_, index) => {
          const day = index + 1;
          const record = [...weekRecords].reverse().find((item) => item.cycleDay === day && item.kind !== "optional") ?? weekRecords.find((item) => item.cycleDay === day);
          const state = day < store.cycleDay ? record?.kind === "missed" ? "missed" : "done" : day === store.cycleDay ? "current" : REST_DAYS.has(day) ? "rest" : "planned";
          return <button key={day} className={`week-day ${state}`} disabled={Boolean(active) && day > store.cycleDay} aria-label={`Jour ${day} : ${DAY_LABELS[index]}`} onClick={() => {
            if (day > store.cycleDay && !active) setSheet({ type: "jump", day });
            else { const plan = currentPlanForDay(day); if (plan) { setSelectedPlanId(plan.id); setTab("program"); } }
          }}>
            <span className="week-dot">{state === "done" ? <Icon name="check" size={16} stroke={2.6} /> : state === "missed" ? <Icon name="close" size={14} stroke={2.4} /> : `J${day}`}</span>
            <small>{SHORT_DAY[index]}</small>
          </button>;
        })}</div>
      </section>}

      {previewRows.length > 0 && <section className="card">
        <div className="card-head"><h2>Dernière fois{previewDate ? ` · ${formatShortDate(previewDate)}` : ""}</h2><span>à battre</span></div>
        <div className="rows">{previewRows.map(({ item, previous: prev }) => <div className="row" key={item.id}><span>{item.name.replace("Progression ", "")}</span><strong>{prev ? previousLine(prev) : "—"}</strong></div>)}</div>
      </section>}

      {isRestDay && !active && <section className="card">
        <div className="card-head"><h2>Routines facultatives</h2></div>
        <div className="rows">
          <button className="row row-button" onClick={() => startPlan(lSitPlan, true)}><span><strong>L-Sit intensif</strong><small>≈ {lSitPlan.duration} min · compression</small></span><Icon name="chevron" size={18} /></button>
          <button className="row row-button" onClick={() => setTab("program")}><span><strong>Abdos</strong><small>4 circuits réglables</small></span><Icon name="chevron" size={18} /></button>
          <button className="row row-button" onClick={() => setTab("program")}><span><strong>Souplesse</strong><small>3 routines, 30 à 60 s</small></span><Icon name="chevron" size={18} /></button>
        </div>
      </section>}

      <div className="block-progress"><div className="bar"><span style={{ width: `${((absoluteDay - (complete ? 0 : 1)) / 42) * 100}%` }} /></div><span>Bloc 1 · J{absoluteDay} / 42 · {mainDone} séances{missedCount ? ` · ${missedCount} manquée${missedCount > 1 ? "s" : ""}` : ""}</span></div>
    </div>;
  };

  const renderProgram = () => <div className="page">
    {header("Programme", "Bloc 1 · 6 semaines")}
    <div className="segmented scroll">{mainPlans.map((plan) => <button key={plan.id} className={selectedPlan.id === plan.id ? "active" : ""} onClick={() => setSelectedPlanId(plan.id)}>J{plan.scheduleDay} · {plan.shortTitle}</button>)}</div>
    <section className="card">
      <div className="plan-head"><div><h2>{selectedPlan.title}</h2><p>{selectedPlan.focus}</p></div><span className="pill"><Icon name="clock" size={15} />{selectedPlan.duration} min</span></div>
      <button className="btn btn-primary" onClick={() => startPlan(selectedPlan, currentPlan?.id === selectedPlan.id)}><Icon name="play" size={16} />{currentPlan?.id === selectedPlan.id ? "Lancer la séance du jour" : "Faire hors planning"}</button>
    </section>
    {selectedPlan.blocks.map((block) => <section className="card" key={block.id}>
      <div className="card-head"><h2>{block.label}</h2><span>{block.kind === "superset" ? "Superset · " : block.kind === "circuit" ? "Circuit · " : ""}{block.roundsLabel}</span></div>
      <div className="rows">{block.exercises.map((item) => {
        const prev = item.tracking !== "check" ? lastPerformance(store.history, item.id) : null;
        return <div className="row exercise-row" key={item.id}>
          <span><strong>{item.name}</strong><small>{item.target}{item.restLabel !== "—" ? ` · repos ${item.restLabel}` : ""}</small></span>
          {prev && <em>{previousLine(prev)}</em>}
        </div>;
      })}</div>
    </section>)}

    <h2 className="section-title">Routines facultatives</h2>
    <section className="card">
      <div className="plan-head"><div><h2>L-Sit intensif</h2><p>Technique en supersets puis circuit de compression.</p></div><span className="pill">{lSitPlan.duration} min</span></div>
      <button className="btn btn-secondary" onClick={() => startPlan(lSitPlan, isRestDay)}>Lancer</button>
    </section>
    <section className="card">
      <div className="plan-head"><div><h2>Abdos</h2><p>{absRoutines[absKey].exercises.length} exercices · {absPlan.duration} min</p></div></div>
      <div className="field-grid">
        <label>Routine<select value={absKey} onChange={(event) => setAbsKey(event.target.value as AbsRoutineKey)}>{Object.entries(absRoutines).map(([key, routine]) => <option key={key} value={key}>{routine.name}</option>)}</select></label>
        <label>Effort<select value={absEffort} onChange={(event) => setAbsEffort(Number(event.target.value))}><option value={30}>30 s</option><option value={45}>45 s</option></select></label>
        <label>Transition<select value={absTransition} onChange={(event) => setAbsTransition(Number(event.target.value))}><option value={15}>15 s</option><option value={30}>30 s</option></select></label>
        <label>Tours<select value={absRounds} onChange={(event) => setAbsRounds(Number(event.target.value))}>{[2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      </div>
      <button className="btn btn-secondary" onClick={() => startPlan(absPlan, isRestDay)}>Lancer le circuit</button>
    </section>
    <section className="card">
      <div className="plan-head"><div><h2>Souplesse</h2><p>{flexibilityRoutines[flexKey].exercises.length} positions · {flexPlan.duration} min</p></div></div>
      <div className="field-grid">
        <label>Routine<select value={flexKey} onChange={(event) => setFlexKey(event.target.value as FlexRoutineKey)}>{Object.entries(flexibilityRoutines).map(([key, routine]) => <option key={key} value={key}>{routine.name}</option>)}</select></label>
        <label>Séries<select value={flexSets} onChange={(event) => setFlexSets(Number(event.target.value))}>{[3, 4, 5, 6].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Maintien<select value={flexHold} onChange={(event) => setFlexHold(Number(event.target.value))}>{[30, 45, 60].map((value) => <option key={value} value={value}>{value} s</option>)}</select></label>
        <label>Repos<select value={flexRest} onChange={(event) => setFlexRest(Number(event.target.value))}>{[20, 40, 60].map((value) => <option key={value} value={value}>{value} s</option>)}</select></label>
      </div>
      <button className="btn btn-secondary" onClick={() => startPlan(flexPlan, isRestDay)}>Lancer la routine</button>
    </section>
  </div>;

  const renderSummary = () => {
    const rows = active ? activeSummary(exerciseGroups, store.levels) : lastSession ? completedSummary(lastSession) : [];
    const doneSets = rows.reduce((sum, row) => sum + row.completedSets, 0);
    const plannedSets = rows.reduce((sum, row) => sum + (row.plannedSets ?? 0), 0);
    const totalReps = rows.filter((row) => row.tracking === "reps" || row.tracking === "challenge").reduce((sum, row) => sum + (row.total ?? 0), 0);
    const exercise = trackedExercises.find((item) => item.id === progressExerciseId) ?? trackedExercises[0];
    const weeks = Array.from({ length: 6 }, (_, index) => {
      const values = store.history.filter((record) => record.blockWeek === index + 1).flatMap((record) => record.results)
        .filter((result) => result.exerciseId === exercise.id)
        .map((result) => result.challengeTotal ?? result.value)
        .filter((value): value is number => value !== null && value > 0);
      if (!values.length) return { week: index + 1, best: null, average: null, total: null } as Record<ProgressMetric, number | null> & { week: number };
      return { week: index + 1, best: Math.max(...values), average: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10, total: values.reduce((a, b) => a + b, 0) };
    });
    const plotted = weeks.map((week) => week[progressMetric]);
    const numbers = plotted.filter((value): value is number => value !== null);
    const max = Math.max(...numbers, 1);
    const change = numbers.length > 1 ? Math.round((numbers[numbers.length - 1] - numbers[0]) * 10) / 10 : null;
    const unit = exercise.tracking === "seconds" ? "s" : "reps";

    return <div className="page">
      {header("Bilan")}
      <div className="segmented">
        <button className={summaryView === "session" ? "active" : ""} onClick={() => setSummaryView("session")}>Séance</button>
        <button className={summaryView === "progress" ? "active" : ""} onClick={() => setSummaryView("progress")}>Progrès</button>
        <button className={summaryView === "journal" ? "active" : ""} onClick={() => setSummaryView("journal")}>Journal</button>
      </div>

      {summaryView === "session" && (rows.length ? <>
        {!active && newRecords.length > 0 && <section className="card records">
          <div className="card-head"><h2>{newRecords.length > 1 ? `${newRecords.length} nouveaux records` : "Nouveau record"}</h2></div>
          <div className="rows">{newRecords.map((item) => <div className="row" key={item.name}><span>{item.name}</span><strong>{item.value} {item.unit} <small>avant {item.before}</small></strong></div>)}</div>
        </section>}
        <section className="card">
          <div className="card-head"><h2>{active ? active.plan.title : lastSession?.title}</h2><span>{active ? "En cours" : lastSession ? `${formatShortDate(lastSession.date)}${lastSession.durationMin ? ` · ${lastSession.durationMin} min` : ""}` : ""}</span></div>
          <div className="stats">
            <div><strong>{rows.filter((row) => row.status === "done").length}<em>/{rows.length}</em></strong><span>Exercices</span></div>
            <div><strong>{doneSets}{plannedSets > 0 && <em>/{plannedSets}</em>}</strong><span>Séries</span></div>
            <div><strong>{totalReps}</strong><span>Reps</span></div>
          </div>
        </section>
        <section className="card">
          <div className="rows">{rows.map((row) => {
            const index = groups.findIndex((item) => item.entries.some(({ step: entry }) => `${entry.blockId}:${entry.id}` === row.key));
            const value = row.tracking === "check" ? (row.level ? `Niv. ${row.level}` : "—") : row.total === null ? "—" : `${row.total} ${unitFor(row.tracking)}`;
            const content = <>
              <span className={`status-dot ${row.status}`} />
              <span className="grow"><strong>{row.name}</strong><small>{row.plannedSets ? `${row.completedSets}/${row.plannedSets} séries` : `${row.completedSets} séries`}{row.best !== null && row.tracking !== "check" ? ` · max ${row.best} ${unitFor(row.tracking)}` : ""}</small></span>
              <em>{value}</em>
            </>;
            return active && index >= 0
              ? <button className="row row-button summary-row" key={row.key} onClick={() => { goToGroup(index); setTab("workout"); }}>{content}</button>
              : <div className="row summary-row" key={row.key}>{content}</div>;
          })}</div>
        </section>
        {(active || lastSession) && <label className="note-field"><span>Note de séance</span><textarea rows={2} placeholder="Ex. épaule gauche sensible, salle bondée…" value={active ? active.note ?? "" : lastSession?.note ?? ""} onChange={(event) => active ? setActiveNote(event.target.value) : lastSession && updateRecord(lastSession.id, (record) => ({ ...record, note: event.target.value }))} /></label>}
        {active && <button className="btn btn-secondary" onClick={() => setTab("workout")}>Retour à la séance</button>}
      </> : <div className="empty"><strong>Rien à résumer pour l’instant.</strong><p>Ta prochaine séance apparaîtra ici.</p></div>)}

      {summaryView === "progress" && <>
        <section className="card">
          <label className="select-field"><span>Exercice</span><select value={exercise.id} onChange={(event) => setProgressExerciseId(event.target.value)}>{trackedExercises.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <div className="segmented small">{(["best", "average", "total"] as const).map((metric) => <button key={metric} className={progressMetric === metric ? "active" : ""} onClick={() => setProgressMetric(metric)}>{metric === "best" ? "Meilleure" : metric === "average" ? "Moyenne" : "Total"}</button>)}</div>
          <div className="chart">{weeks.map((week) => { const value = week[progressMetric]; return <div className="chart-col" key={week.week}><em>{value ?? ""}</em><div className="chart-track"><span className={week.week === store.currentWeek ? "current" : ""} style={{ height: `${value === null ? 0 : Math.max((value / max) * 100, 6)}%` }} /></div><small>S{week.week}</small></div>; })}</div>
          <div className="stats">
            <div><strong>{numbers[0] ?? "—"}</strong><span>Première ({unit})</span></div>
            <div><strong>{numbers.at(-1) ?? "—"}</strong><span>Dernière ({unit})</span></div>
            <div className={change === null ? "" : change > 0 ? "up" : change < 0 ? "down" : ""}><strong>{change === null ? "—" : `${change > 0 ? "+" : ""}${change}`}</strong><span>Évolution</span></div>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h2>Régularité</h2><span>objectif 4 / semaine</span></div>
          <div className="regularity">{Array.from({ length: 6 }, (_, index) => {
            const records = store.history.filter((record) => record.blockWeek === index + 1);
            const done = records.filter((record) => record.kind === "main" || record.kind === "challenge").length;
            const missed = records.filter((record) => record.kind === "missed").length;
            return <div key={index} className="regularity-row"><small>S{index + 1}</small><div className="pips">{Array.from({ length: 4 }, (_, pip) => <i key={pip} className={pip < done ? "done" : pip < done + missed ? "missed" : ""} />)}</div><span>{done}{missed ? ` · ${missed} manquée${missed > 1 ? "s" : ""}` : ""}</span></div>;
          })}</div>
        </section>
      </>}

      {summaryView === "journal" && <section className="card">
        {store.history.length ? <div className="rows">{[...store.history].reverse().slice(0, 40).map((record) => <button className={`row row-button journal-row ${record.kind}`} key={record.id} onClick={() => setSheet({ type: "record", id: record.id })}>
          <span className="journal-icon"><Icon name={record.kind === "rest" ? "moon" : record.kind === "missed" ? "skip" : "check"} size={16} stroke={2.2} /></span>
          <span className="grow"><strong>{record.title}</strong><small>{formatShortDate(record.date)} · S{record.blockWeek} J{record.cycleDay}{record.note ? ` · ${record.note}` : ""}</small></span>
          <em>{record.kind === "missed" ? "Manquée" : record.kind === "rest" ? "Repos" : record.durationMin ? `${record.durationMin} min` : `${record.completedSteps}/${record.totalSteps}`}</em>
        </button>)}</div> : <div className="empty"><strong>Journal vide.</strong></div>}
      </section>}
    </div>;
  };

  const renderSkills = () => <div className="page">
    {header("Niveaux")}
    <section className="card">
      <div className="card-head"><h2>Progressions</h2><span>niveau actuel</span></div>
      <div className="rows">{(Object.keys(store.levels) as LevelKey[]).map((key) => <div className="row level-row" key={key}>
        <strong>{LEVEL_LABELS[key]}</strong>
        <div className="segmented tiny">{([1, 2, 3] as const).map((level) => <button key={level} aria-label={`${LEVEL_LABELS[key]} niveau ${level}`} className={store.levels[key] === level ? "active" : ""} onClick={() => setLevel(key, level)}>{level}</button>)}</div>
      </div>)}</div>
    </section>
    <h2 className="section-title">Skills</h2>
    {skillMetrics.map((skill) => {
      const logs = store.skillLogs.filter((log) => log.skillId === skill.id);
      const fromHistory = personalBest(store.history, skill.id);
      const bestValue = Math.max(0, ...logs.map((log) => log.value), fromHistory?.value ?? 0);
      const progress = Math.min((bestValue / skill.target) * 100, 100);
      return <section className="card skill" key={skill.id}>
        <div className="card-head"><h2>{skill.name}</h2><span>objectif {skill.target} {skill.unit}</span></div>
        <div className="skill-value"><strong>{bestValue || "—"}</strong>{bestValue > 0 && <em>{skill.unit}</em>}<span>{Math.round(progress)} %</span></div>
        <div className="bar"><span style={{ width: `${progress}%` }} /></div>
        <div className="inline-input"><input inputMode="decimal" aria-label={`Nouveau score ${skill.name}`} placeholder={`Nouveau score (${skill.unit})`} value={skillInputs[skill.id] ?? ""} onChange={(event) => setSkillInputs({ ...skillInputs, [skill.id]: event.target.value })} /><button className="btn btn-secondary btn-small" onClick={() => saveSkill(skill.id)}>Ajouter</button></div>
      </section>;
    })}
  </div>;

  const renderSettings = () => <div className="page">
    {header("Réglages", undefined, () => setTab("home"))}
    <section className="card">
      <div className="card-head"><h2>Sauvegarde</h2><span>{store.history.length} entrées</span></div>
      <p className="muted">Tes données restent sur cet iPhone. Exporte une copie de temps en temps.</p>
      <div className="rows">
        <button className="row row-button" onClick={exportData}><span className="row-icon"><Icon name="download" size={18} /></span><span className="grow"><strong>Exporter la sauvegarde</strong><small>Fichier .json</small></span><Icon name="chevron" size={18} /></button>
        <button className="row row-button" onClick={() => fileInputRef.current?.click()}><span className="row-icon"><Icon name="upload" size={18} /></span><span className="grow"><strong>Restaurer une sauvegarde</strong><small>Ancienne ou nouvelle version</small></span><Icon name="chevron" size={18} /></button>
      </div>
    </section>
    <section className="card">
      <div className="card-head"><h2>Récupération</h2><span className={`recovery ${status.level}`}>{status.label}</span></div>
      <p className="muted">{status.text}</p>
      {([["sleep", "Sommeil", 4, 10, 0.5, " h"], ["energy", "Énergie", 1, 5, 1, " / 5"], ["soreness", "Courbatures", 1, 5, 1, " / 5"]] as const).map(([key, label, min, max, stepValue, suffix]) => <label className="slider" key={key}>
        <span><span>{label}</span><strong>{store.recovery[key]}{suffix}</strong></span>
        <input type="range" min={min} max={max} step={stepValue} value={store.recovery[key]} onChange={(event) => setStore({ ...store, recovery: { ...store.recovery, [key]: Number(event.target.value) } })} />
      </label>)}
    </section>
    <section className="card">
      <div className="card-head"><h2>Installer sur l’iPhone</h2></div>
      <p className="muted">Dans Safari : Partager, puis « Sur l’écran d’accueil ».</p>
    </section>
  </div>;

  /* ---------- Séance (plein écran) ---------- */
  const renderWorkout = () => {
    if (!active || !group || !step) return <div className="page">
      {header("Séance")}
      <div className="empty"><strong>Aucune séance en cours.</strong><p>Lance la séance du jour depuis l’accueil.</p><button className="btn btn-primary" onClick={() => setTab("home")}>Voir la séance du jour</button></div>
    </div>;
    const isChallenge = step.tracking === "challenge";
    const isCheck = step.tracking === "check";
    const isMulti = members.length > 1;
    const showBallast = members.some(({ step: item }) => item.loadMode === "weighted" || item.loadMode === "band_or_weight");
    const allDone = groupDone(group);
    const isLast = groupIndex === groups.length - 1;
    const minutes = Math.round((active.activeMs ?? 0) / 60000);
    const blockKind = step.blockKind === "superset" ? "Superset" : step.blockKind === "circuit" ? "Circuit" : step.blockKind === "challenge" ? "Challenge" : step.blockLabel;
    const timerVisible = Boolean(restEndAt);
    const timerLabel = active.restLabel ?? "Repos";
    const nextGroup = groups[groupIndex + 1];
    const shortName = (name: string) => { const value = name.replace("Progression ", "").replace(" à un bras", "").replace("Gainage drapeau — autre côté", "Drapeau (autre côté)"); return value.charAt(0).toUpperCase() + value.slice(1); };
    const letters = "ABCDEFGH";
    const rounds = [...new Set(group.entries.map(({ step: item }) => item.round))];
    const firstOpenIndex = group.entries.find(({ step: entry }) => !entry.result.done)?.index;
    const lastStep = group.entries[group.entries.length - 1].step;
    const title = isMulti ? (members.length <= 2 ? members.map(({ step: item }) => item.name).join(" + ") : step.blockLabel) : step.name;
    const cleanVariant = (value: string) => value && !/^[0\-–—.]+$/.test(value);

    const renderSetRow = (index: number, item: ActiveStep, member: typeof members[number], memberIndex: number) => {
      const prevSet = member.previous?.results.find((result) => result.series === item.round && result.value !== null) ?? null;
      const current = item.result.value === "" ? null : Number(item.result.value);
      const delta = prevSet?.value != null && current !== null && Number.isFinite(current) ? Math.round((current - prevSet.value) * 10) / 10 : null;
      const hasBallast = item.loadMode === "weighted" || item.loadMode === "band_or_weight";
      const unilateral = isUnilateral(item);
      return <div key={item.stepId} className={`set-wrap ${isMulti ? "multi" : ""}`}>
        {isMulti && <div className="set-label"><span className="set-letter">{letters[memberIndex]}</span>{shortName(item.name)}<em>{item.target}{item.tracking === "seconds" && !/s\b/.test(item.target) ? " s" : ""}</em></div>}
        <div className={`set-grid ${showBallast ? "with-ballast" : ""} ${item.result.done ? "done" : ""} ${firstOpenIndex === index ? "current" : ""}`}>
          <span className="set-number">{isMulti ? letters[memberIndex] : item.round}</span>
          {item.result.done ? <span className="set-value"><strong>{unilateral && (item.result.left || item.result.right) ? `${item.result.left || "–"}/${item.result.right || "–"}` : item.result.value || "—"}</strong>{member.best && current !== null && current > member.best.value ? <span className="delta record-badge">Record</span> : <Delta value={delta} />}</span>
            : unilateral ? <span className="side-inputs">
              <label className="set-input side"><span className="side-tag">G</span><span className="sr-only">{item.name} série {item.round} côté gauche</span><input inputMode="decimal" value={item.result.left ?? ""} placeholder={String(prevSet?.sides?.left ?? prevSet?.value ?? item.target.match(/\d+/)?.[0] ?? "0")} onChange={(event) => updateSide(index, "left", event.target.value)} /></label>
              <label className="set-input side"><span className="side-tag">D</span><span className="sr-only">{item.name} série {item.round} côté droit</span><input inputMode="decimal" value={item.result.right ?? ""} placeholder={String(prevSet?.sides?.right ?? prevSet?.value ?? item.target.match(/\d+/)?.[0] ?? "0")} onChange={(event) => updateSide(index, "right", event.target.value)} /></label>
            </span>
            : <label className="set-input"><span className="sr-only">{item.name} série {item.round}</span><input inputMode="decimal" value={item.result.value} placeholder={prevSet?.value != null ? String(prevSet.value) : item.target.match(/\d+/)?.[0] ?? "0"} onChange={(event) => updateResult(index, "value", event.target.value)} /></label>}
          {showBallast && (!hasBallast ? <span /> : item.result.done ? <span className="set-muted">{item.result.ballast ? `+${item.result.ballast} kg` : ""}</span>
            : <label className="set-input light side"><span className="side-tag">kg</span><span className="sr-only">Lest {item.name} série {item.round}</span><input inputMode="decimal" value={item.result.ballast} placeholder={prevSet?.ballast ? String(prevSet.ballast) : "0"} onChange={(event) => updateResult(index, "ballast", event.target.value)} /></label>)}
          <button className={`check-circle ${item.result.done ? "on" : ""}`} aria-label={`${item.result.done ? "Réouvrir" : "Valider"} ${item.name} série ${item.round}`} onClick={() => toggleSet(index)}><Icon name="check" size={18} stroke={2.6} /></button>
        </div>
      </div>;
    };

    return <div className="workout">
      <div className="workout-top">
        <button className="icon-button plain" aria-label="Quitter la séance" onClick={() => setSheet({ type: "exit" })}><Icon name="close" /></button>
        <div className="workout-title">{active.plan.title}{minutes > 0 && <span> · {minutes} min</span>}</div>
        <button className="icon-button plain" aria-label="Liste des exercices" onClick={() => setSheet({ type: "exercises" })}><Icon name="list" /></button>
      </div>
      <div className="segments">{groups.map((item, index) => <button key={item.key} aria-label={`Exercice ${index + 1}`} className={groupDone(item) ? "done" : index === groupIndex ? "current" : ""} onClick={() => goToGroup(index)} />)}</div>

      <div className="workout-body">
        {groupIndex === 0 && <button className={`warmup ${active.warmupDone ? "done" : ""}`} onClick={() => setStore({ ...store, active: { ...active, warmupDone: !active.warmupDone } })}>
          <span className="check-circle small"><Icon name="check" size={14} stroke={2.6} /></span>Échauffement {active.warmupDone ? "fait" : "à faire"}
        </button>}
        <p className="eyebrow">{blockKind} · {groupIndex + 1} / {groups.length}</p>
        <h1 className="exercise-title">{title}</h1>
        {isMulti ? <div className="chips">
          <span className="chip strong">{rounds.length} tours</span>
          <span className="chip">{members.length} exercices enchaînés</span>
          {lastStep.restSec > 0 && <span className="chip">Repos {lastStep.restLabel} après le tour</span>}
        </div> : <div className="chips">
          <span className="chip strong">{isChallenge ? "Max en 7 min" : /^(\d|MR|≈)/.test(step.target) ? `Objectif ${step.target}` : step.target}</span>
          <span className="chip">{step.tempo}</span>
          {step.restSec > 0 && !isChallenge && <span className="chip">Repos {step.restLabel}</span>}
        </div>}

        {step.levelKey && !isMulti && <div className="level-line"><span>Niveau</span><div className="segmented tiny">{([1, 2, 3] as const).map((level) => <button key={level} className={store.levels[step.levelKey!] === level ? "active" : ""} onClick={() => setLevel(step.levelKey!, level)}>{level}</button>)}</div></div>}

        {isMulti ? <div className="last-time multi">
          <small>Dernière fois{members[0].previous ? ` · ${formatShortDate(members[0].previous.record.date)}` : ""}</small>
          {members.map((member, memberIndex) => <div className="last-row" key={member.step.id}><span><b>{letters[memberIndex]}</b>{shortName(member.step.name)}</span><strong>{member.previous ? previousLine(member.previous) : "—"}</strong>{member.best && <em>rec. {member.best.value}</em>}</div>)}
        </div> : !isCheck && <div className={`last-time ${members[0].previous ? "" : "empty"}`}>
          <div><small>{members[0].previous ? `Dernière fois · ${formatShortDate(members[0].previous.record.date)}` : "Dernière fois"}</small><strong>{members[0].previous ? previousLine(members[0].previous) : "Première fois"}</strong>{members[0].previous && previousDetails(members[0].previous) && <span>{previousDetails(members[0].previous)}</span>}</div>
          {members[0].best && <div className="record"><small>Record</small><strong>{members[0].best.value}</strong></div>}
        </div>}
        {members.filter((member) => member.hint).map((member) => <div className="hint" key={member.step.id}><strong>{isMulti ? `${shortName(member.step.name)} · ` : ""}{member.hint!.title}</strong><p>{member.hint!.text}</p></div>)}

        {isChallenge ? <section className="card challenge">
          <div className="challenge-total"><div><small>Total</small><strong>{step.result.miniSets.reduce((sum, value) => sum + (Number(value) || 0), 0)}</strong></div><button className="btn btn-secondary btn-small" onClick={() => startRest(420, "Bloc 7 min")}><Icon name="clock" size={16} />Lancer 7 min</button></div>
          <div className="mini-sets">{step.result.miniSets.map((value, setIndex) => <label key={setIndex}><span>{setIndex + 1}</span><input inputMode="numeric" value={value} placeholder="0" onChange={(event) => updateMiniSet(group.firstIndex, setIndex, event.target.value)} /></label>)}<button className="mini-add" aria-label="Ajouter une série" onClick={() => addMiniSet(group.firstIndex)}><Icon name="plus" size={18} /></button></div>
        </section> : isCheck ? <section className="card">
          <p className="muted">Routine gérée de ton côté : choisis ton niveau, note la variante si besoin, puis valide.</p>
        </section> : <section className="card sets">
          {!isMulti && <div className={`set-grid head ${showBallast ? "with-ballast" : ""}`}><span>Série</span><span>{step.tracking === "seconds" ? "Secondes" : "Reps"}{isUnilateral(step) ? " · G / D" : ""}</span>{showBallast && <span>Lest (kg)</span>}<span /></div>}
          {isMulti ? rounds.map((round) => <div className="round" key={round}>
            <div className="round-head"><span>Tour {round}</span>{group.entries.filter(({ step: item }) => item.round === round).every(({ step: item }) => item.result.done) && <Icon name="check" size={14} stroke={2.6} />}</div>
            {group.entries.filter(({ step: item }) => item.round === round).map(({ index, step: item }) => { const memberIndex = members.findIndex((member) => member.step.id === item.id); return renderSetRow(index, item, members[memberIndex], memberIndex); })}
          </div>) : group.entries.map(({ index, step: item }) => renderSetRow(index, item, members[0], 0))}
        </section>}

        {members.filter(({ step: item }) => (item.loadMode !== "none" && item.tracking !== "challenge") || item.tracking === "check").map((member) => {
          const previousVariant = member.previous?.results.map((result) => result.variant.trim()).find(cleanVariant) ?? "";
          return <label className="variant-field" key={member.step.id}>
            <span>{isMulti ? <><span className="set-letter">{letters[members.indexOf(member)]}</span> Variante</> : "Variante"}</span>
            <input value={member.entries[0].step.result.variant} placeholder={previousVariant || "Aucune assistance"} onChange={(event) => setGroupVariant(event.target.value, member.step.id)} />
          </label>;
        })}

        {(isCheck || isChallenge) && <button className={`btn ${allDone ? "btn-secondary" : "btn-primary"}`} onClick={toggleGroup}><Icon name="check" size={18} stroke={2.4} />{allDone ? "Validé" : "Valider l’exercice"}</button>}
        {!isCheck && !isChallenge && !allDone && <button className="btn btn-text" onClick={toggleGroup}>Tout valider d’un coup</button>}

        {members.some(({ step: item }) => item.easier || item.harder || item.note) && <div className="tips">
          <button className="tips-toggle" onClick={() => setTipsOpen(!tipsOpen)}>Conseils <Icon name="chevron" size={16} /></button>
          {tipsOpen && <div className="tips-body">
            {members.filter(({ step: item }) => item.easier || item.harder || item.note).map(({ step: item }) => <div key={item.id} className="tips-group">
              {isMulti && <strong className="tips-name">{item.name}</strong>}
              {item.note && <p>{item.note}</p>}
              {item.easier && <p><strong>Plus simple :</strong> {item.easier}</p>}
              {item.harder && <p><strong>Plus dur :</strong> {item.harder}</p>}
            </div>)}
          </div>}
        </div>}
      </div>

      <div className="workout-bar">
        {timerVisible ? <div className="rest-bar">
          <div className="grow"><small>{timerLabel}{nextGroup && timerLabel === "Repos" && allDone ? ` · puis ${shortName(nextGroup.entries[0].step.name)}` : ""}</small><strong>{formatTimer(restRemaining)}</strong></div>
          <button className="rest-ghost" onClick={() => addRest(15)}>+15</button>
          <button className="rest-main" onClick={resetTimer}>Passer</button>
        </div> : <div className="nav-bar">
          <button className="icon-button" aria-label="Exercice précédent" disabled={groupIndex === 0} onClick={() => goToGroup(groupIndex - 1)}><Icon name="back" /></button>
          {isLast ? <button className="btn btn-primary grow" onClick={finishSession}><Icon name="check" size={18} stroke={2.4} />Terminer la séance</button>
            : <button className={`btn grow ${allDone ? "btn-primary" : "btn-secondary"}`} onClick={() => goToGroup(groupIndex + 1)}>Exercice suivant<Icon name="arrow" size={18} /></button>}
        </div>}
      </div>
    </div>;
  };

  const navItems: { id: Tab; label: string; icon: IconName }[] = [
    { id: "home", label: "Aujourd’hui", icon: "home" },
    { id: "program", label: "Programme", icon: "program" },
    { id: "summary", label: "Bilan", icon: "chart" },
    { id: "skills", label: "Niveaux", icon: "levels" },
  ];
  const inWorkout = tab === "workout" && Boolean(active);

  return <main className={`app ${inWorkout ? "in-workout" : ""}`}>
    {tab === "home" && renderHome()}
    {tab === "program" && renderProgram()}
    {tab === "summary" && renderSummary()}
    {tab === "skills" && renderSkills()}
    {tab === "settings" && renderSettings()}
    {tab === "workout" && renderWorkout()}

    {!inWorkout && active && tab !== "home" && <button className="resume-pill" onClick={() => setTab("workout")}><span className="pulse" />{active.plan.shortTitle} en cours<Icon name="chevron" size={16} /></button>}

    {!inWorkout && <nav className="tabbar" aria-label="Navigation">{navItems.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => { setTab(item.id); window.scrollTo({ top: 0 }); }}><Icon name={item.icon} /><span>{item.label}</span></button>)}</nav>}

    <input ref={fileInputRef} type="file" accept="application/json,.json" hidden onChange={importData} />

    {sheet && <div className="sheet-backdrop" onClick={() => setSheet(null)}>
      <section className="sheet" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <span className="sheet-grabber" />
        {sheet.type === "skip" && currentPlan && <>
          <h2>Pas de salle aujourd’hui ?</h2>
          <p>Aucune option ne crée de fausse séance.</p>
          <button className="sheet-option" onClick={() => startPlan(makeExpressPlan(currentPlan), true, true)}><strong>Faire la version express</strong><small>≈ {makeExpressPlan(currentPlan).duration} min, l’essentiel seulement. Compte comme la séance du jour.</small></button>
          <button className="sheet-option" onClick={() => setSheet(null)}><strong>La garder pour plus tard</strong><small>{currentPlan.title} reste ta prochaine séance.</small></button>
          <button className="sheet-option" onClick={markMissed}><strong>La marquer comme manquée</strong><small>Le planning passe au jour {store.cycleDay % 7 + 1}. Hors stats et hors perfs.</small></button>
          <button className="btn btn-text" onClick={() => setSheet(null)}>Annuler</button>
        </>}
        {sheet.type === "jump" && jumpTarget && <>
          <h2>Aller à {DAY_LABELS[jumpTarget - 1].replace(" / séance supp.", "")} ?</h2>
          <p>Les jours entre deux seront notés automatiquement.</p>
          <div className="rows boxed">{jumpSkipped.map((day) => { const plan = currentPlanForDay(day); return <div className="row" key={day}><span>J{day} · {plan ? plan.title : "Jour libre"}</span><em className={plan ? "missed" : ""}>{plan ? "Manquée" : "Repos"}</em></div>; })}</div>
          <button className="btn btn-primary btn-large" onClick={() => jumpToDay(jumpTarget)}>Confirmer</button>
          {currentPlanForDay(jumpTarget) && <button className="btn btn-text" onClick={() => { const plan = currentPlanForDay(jumpTarget); if (plan) { setSelectedPlanId(plan.id); setTab("program"); } setSheet(null); }}>Juste voir la séance</button>}
        </>}
        {sheet.type === "exit" && active && <>
          <h2>Quitter la séance ?</h2>
          <button className="sheet-option" onClick={finishSession}><strong>Terminer et enregistrer</strong><small>{active.steps.filter((item) => item.result.done).length} séries validées sur {active.steps.length}.</small></button>
          <button className="sheet-option" onClick={() => { setSheet(null); setTab("home"); }}><strong>Mettre en pause</strong><small>Tu la reprends depuis l’accueil quand tu veux.</small></button>
          <button className="sheet-option danger" onClick={abandonSession}><strong>Abandonner</strong><small>Rien n’est enregistré.</small></button>
        </>}
        {sheet.type === "exercises" && active && <>
          <h2>{active.plan.title}</h2>
          <div className="rows boxed">{groups.map((item, index) => {
            const doneCount = item.entries.filter(({ step: entry }) => entry.result.done).length;
            return <button key={item.key} className={`row row-button ${index === groupIndex ? "current" : ""}`} onClick={() => goToGroup(index)}>
              <span className={`status-dot ${groupDone(item) ? "done" : doneCount ? "active" : "todo"}`} />
              <span className="grow"><strong>{[...new Set(item.entries.map(({ step: entry }) => entry.name))].join(" + ")}</strong><small>{doneCount}/{item.entries.length} séries</small></span>
              <Icon name="chevron" size={16} />
            </button>;
          })}</div>
          <label className="note-field"><span>Note de séance</span><textarea rows={2} placeholder="Ex. épaule gauche sensible…" value={active.note ?? ""} onChange={(event) => setActiveNote(event.target.value)} /></label>
        </>}
        {sheet.type === "record" && editedRecord && <>
          <h2>{editedRecord.title}</h2>
          <p>{formatShortDate(editedRecord.date)} · S{editedRecord.blockWeek} J{editedRecord.cycleDay}{editedRecord.durationMin ? ` · ${editedRecord.durationMin} min` : ""}</p>
          {isTrainingRecord(editedRecord) && editedRecord.results.some((result) => result.tracking === "reps" || result.tracking === "seconds") && <div className="record-editor">
            {[...new Set(editedRecord.results.map((result) => result.exerciseId))].map((exerciseId) => {
              const entries = editedRecord.results.map((result, index) => ({ result, index })).filter(({ result }) => result.exerciseId === exerciseId && (result.tracking === "reps" || result.tracking === "seconds"));
              if (!entries.length) return null;
              return <div className="record-exercise" key={exerciseId}>
                <strong>{entries[0].result.exerciseName}</strong>
                <div className="record-sets">{entries.map(({ result, index }) => <label key={index}><span>S{result.series}</span><input inputMode="decimal" value={result.value ?? ""} placeholder="—" onChange={(event) => updateRecordResult(editedRecord.id, index, "value", event.target.value)} /></label>)}</div>
              </div>;
            })}
          </div>}
          {isTrainingRecord(editedRecord) && <label className="note-field"><span>Note</span><textarea rows={2} value={editedRecord.note ?? ""} placeholder="Aucune note" onChange={(event) => updateRecord(editedRecord.id, (record) => ({ ...record, note: event.target.value }))} /></label>}
          <button className="btn btn-primary" onClick={() => setSheet(null)}>Fermer</button>
          <button className="btn btn-text danger" onClick={() => deleteRecord(editedRecord.id)}>Supprimer cette entrée</button>
        </>}
      </section>
    </div>}
  </main>;
}
