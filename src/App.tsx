import type { CSSProperties, ReactNode } from "react";
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
  lastPerformance,
  makeMissedRecord,
  makeRestRecord,
  migrateStore,
  personalBest,
  skipToDay,
  lSitPlan,
  mainPlans,
  makeAbsPlan,
  makeFlexPlan,
  progressionExercises,
  recoveryStatus,
  skillMetrics,
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

type Sheet =
  | { type: "skip" }
  | { type: "jump"; day: number }
  | null;

/** Ajoute le temps écoulé depuis la dernière action, sans compter les longues pauses. */
function bumpActivity(active: ActiveSession): ActiveSession {
  const now = Date.now();
  const last = active.lastActivityAt ?? active.startedAt;
  return { ...active, activeMs: (active.activeMs ?? 0) + Math.max(0, Math.min(now - last, IDLE_GAP_MS)), lastActivityAt: now };
}

function unitFor(tracking: ActiveStep["tracking"]) {
  return tracking === "seconds" ? "s" : "reps";
}

/** Résumé court de la dernière perf : « 6 · 6 · 6 · 4 reps » */
function previousLine(previous: PreviousPerformance) {
  const first = previous.results[0];
  if (first.tracking === "challenge") {
    const sets = first.challengeSets?.length ? ` (${first.challengeSets.join("-")})` : "";
    return `${first.challengeTotal ?? 0} reps${sets}`;
  }
  if (first.tracking === "check") return [first.level ? `Niveau ${first.level}` : "Validé", first.variant.trim()].filter(Boolean).join(" · ");
  const values = previous.results.map((result) => result.value).filter((value): value is number => value !== null);
  return values.length ? `${values.join(" · ")} ${unitFor(first.tracking)}` : "—";
}

function previousDetails(previous: PreviousPerformance) {
  const variants = [...new Set(previous.results.map((result) => result.variant.trim()).filter(Boolean))];
  const ballasts = [...new Set(previous.results.map((result) => result.ballast).filter((value): value is number => value !== null && value > 0))];
  const rpes = previous.results.map((result) => result.rpe).filter((value): value is number => value !== null);
  return [
    variants.length ? variants.join(", ") : null,
    ballasts.length ? `+${ballasts.join("/")} kg` : null,
    rpes.length ? `RPE ${Math.min(...rpes)}–${Math.max(...rpes)}`.replace(/RPE (\d+)–\1$/, "RPE $1") : null,
  ].filter(Boolean).join(" · ");
}

type Tab = "home" | "program" | "workout" | "summary" | "progress" | "skills" | "more";
type ProgressMetric = "best" | "average" | "total";

type ActiveExerciseGroup = {
  key: string;
  firstIndex: number;
  entries: { index: number; step: ActiveStep }[];
};

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

function groupActiveExercises(steps: ActiveStep[]): ActiveExerciseGroup[] {
  const groups = new Map<string, ActiveExerciseGroup>();
  steps.forEach((step, index) => {
    const key = `${step.blockId}:${step.id}`;
    const current = groups.get(key);
    if (current) current.entries.push({ index, step });
    else groups.set(key, { key, firstIndex: index, entries: [{ index, step }] });
  });
  return [...groups.values()];
}

function activeSummary(groups: ActiveExerciseGroup[], levels: Store["levels"]): SummaryRow[] {
  return groups.map((group) => {
    const representative = group.entries[0].step;
    const isChallenge = representative.tracking === "challenge";
    const values = group.entries.flatMap(({ step }) => isChallenge
      ? step.result.miniSets.filter((value) => value !== "").map(Number).filter(Number.isFinite)
      : [Number(step.result.value)].filter((value) => step.result.value !== "" && Number.isFinite(value)));
    const completedSets = isChallenge
      ? group.entries.reduce((sum, { step }) => sum + step.result.miniSets.filter((value) => value !== "").length, 0)
      : group.entries.filter(({ step }) => step.result.done).length;
    const plannedSets = isChallenge ? null : group.entries.length;
    const hasActivity = completedSets > 0 || values.length > 0;
    const isDone = isChallenge
      ? group.entries.every(({ step }) => step.result.done)
      : completedSets === plannedSets;
    return {
      key: group.key,
      name: representative.name,
      tracking: representative.tracking,
      plannedSets,
      completedSets,
      total: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
      best: values.length ? Math.max(...values) : null,
      level: representative.levelKey ? levels[representative.levelKey] : null,
      status: isDone ? "done" : hasActivity ? "active" : "todo",
    };
  });
}

function completedSummary(record: SessionRecord): SummaryRow[] {
  const groups = new Map<string, SessionRecord["results"]>();
  record.results.forEach((result) => {
    const current = groups.get(result.exerciseId) ?? [];
    current.push(result);
    groups.set(result.exerciseId, current);
  });
  return [...groups.entries()].map(([key, results]) => {
    const representative = results[0];
    const values = results
      .map((result) => result.challengeTotal ?? result.value)
      .filter((value): value is number => value !== null && Number.isFinite(value));
    const completedSets = representative.tracking === "challenge"
      ? results.reduce((sum, result) => sum + (result.challengeSets?.length ?? (result.challengeTotal !== null ? 1 : 0)), 0)
      : results.filter((result) => result.done).length;
    return {
      key,
      name: representative.exerciseName,
      tracking: representative.tracking,
      plannedSets: representative.tracking === "challenge" ? null : results.length,
      completedSets,
      total: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
      best: values.length ? Math.max(...values) : null,
      level: representative.level,
      status: results.every((result) => result.done) ? "done" : completedSets ? "active" : "todo",
    };
  });
}

function Icon({ name, size = 20 }: { name: "home" | "program" | "play" | "summary" | "chart" | "skill" | "more" | "check" | "clock" | "arrow" | "download" | "upload" | "moon" | "flame" | "skip" | "history"; size?: number }) {
  const paths: Record<string, ReactNode> = {
    home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.8V21h14V9.8" /><path d="M9 21v-7h6v7" /></>,
    program: <><path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
    play: <path d="M8 5.5v13l10-6.5-10-6.5Z" />,
    summary: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>,
    chart: <><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20H2" /></>,
    skill: <><path d="M12 3v18" /><path d="m5 8 7-5 7 5" /><path d="m6 16 6 5 6-5" /><path d="M4 12h16" /></>,
    more: <><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    arrow: <><path d="M5 12h14" /><path d="m14 7 5 5-5 5" /></>,
    download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 20h16" /></>,
    upload: <><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 20h16" /></>,
    moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" />,
    skip: <><path d="M5 5.5v13l9-6.5-9-6.5Z" /><path d="M18 5v14" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 8v4l3 2" /></>,
    flame: <path d="M12 22c4 0 7-2.8 7-6.8 0-3.6-2.4-6-4.4-8.4-.4 2.4-1.6 3.6-2.8 4.2C12 8 11 5 8.6 2.5 8.8 6.4 5 9.2 5 15.2 5 19.2 8 22 12 22Z" />,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function AppLogo() {
  return <div className="app-logo" aria-label="Baptiste Training"><span className="logo-mark"><span /></span><span className="logo-word">BAPTISTE<span>TRAINING</span></span></div>;
}

function workoutLabel(plan: Plan) {
  if (plan.kind === "challenge") return "CHALLENGE";
  if (plan.kind === "optional") return "FACULTATIF";
  return "SÉANCE PRINCIPALE";
}

export default function Home() {
  const [store, setStore] = useState<Store | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [selectedPlanId, setSelectedPlanId] = useState(mainPlans[0].id);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerLabel, setTimerLabel] = useState("Chrono de repos");
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
  const [sheet, setSheet] = useState<Sheet>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) { setStore(migrateStore(JSON.parse(saved))); return; }
    } catch { /* A damaged local backup must not block the application. */ }
    setStore(createDefaultStore());
  }, []);

  useEffect(() => { if (store) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); }, [store]);
  useEffect(() => { if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => undefined); }, []);
  useEffect(() => {
    if (!timerRunning || timerSeconds <= 0) return;
    const timer = window.setInterval(() => setTimerSeconds((value) => {
      if (value <= 1) { setTimerRunning(false); return 0; }
      return value - 1;
    }), 1000);
    return () => window.clearInterval(timer);
  }, [timerRunning, timerSeconds]);

  const absPlan = useMemo(() => makeAbsPlan(absKey, absEffort, absTransition, absRounds), [absKey, absEffort, absTransition, absRounds]);
  const flexPlan = useMemo(() => makeFlexPlan(flexKey, flexSets, flexHold, flexRest), [flexKey, flexSets, flexHold, flexRest]);
  const trackedExercises = useMemo(() => progressionExercises(), []);

  if (!store) return <main className="loading-screen"><AppLogo /><div className="loading-line"><span /></div></main>;

  const complete = store.currentWeek > 6;
  const currentPlan = complete ? null : currentPlanForDay(store.cycleDay);
  const isRestDay = !complete && REST_DAYS.has(store.cycleDay);
  const absoluteDay = complete ? 42 : (store.currentWeek - 1) * 7 + store.cycleDay;
  const status = recoveryStatus(store.recovery);
  const selectedPlan = mainPlans.find((plan) => plan.id === selectedPlanId) ?? mainPlans[0];
  const activeExerciseGroups = store.active ? groupActiveExercises(store.active.steps) : [];
  const activeExerciseIndex = store.active
    ? Math.max(0, activeExerciseGroups.findIndex((group) => group.entries.some(({ index }) => index === store.active!.stepIndex)))
    : 0;
  const activeExercise = activeExerciseGroups[activeExerciseIndex] ?? null;
  const activeStep = activeExercise?.entries[0]?.step ?? null;
  const completedSteps = store.active?.steps.filter((step) => step.result.done).length ?? 0;
  const plannedMain = store.history.filter((record) => record.kind === "main" || record.kind === "challenge").length;
  const optionalCount = store.history.filter((record) => record.kind === "optional").length;
  const restCount = store.history.filter((record) => record.kind === "rest").length;
  const missedCount = store.history.filter((record) => record.kind === "missed").length;
  const staleActive = store.active && Date.now() - (store.active.lastActivityAt ?? store.active.startedAt) > 6 * 3600 * 1000;
  const weeklyCounts = Array.from({ length: 6 }, (_, index) => store.history.filter((record) => record.blockWeek === index + 1 && (record.kind === "main" || record.kind === "challenge")).length);
  const lastCompletedSession = [...store.history].reverse().find(isTrainingRecord) ?? null;
  const summaryRows = store.active
    ? activeSummary(activeExerciseGroups, store.levels)
    : lastCompletedSession ? completedSummary(lastCompletedSession) : [];
  const summaryDoneSets = summaryRows.reduce((sum, row) => sum + row.completedSets, 0);
  const summaryPlannedSets = summaryRows.reduce((sum, row) => sum + (row.plannedSets ?? 0), 0);
  const summaryDoneExercises = summaryRows.filter((row) => row.status === "done").length;
  const summaryTotalReps = summaryRows
    .filter((row) => row.tracking === "reps" || row.tracking === "challenge")
    .reduce((sum, row) => sum + (row.total ?? 0), 0);

  const activePrevious = activeStep ? lastPerformance(store.history, activeStep.id) : null;
  const activeBest = activeStep ? personalBest(store.history, activeStep.id) : null;
  const jumpTarget = sheet?.type === "jump" ? sheet.day : null;
  const jumpSkipped = jumpTarget ? Array.from({ length: jumpTarget - store.cycleDay }, (_, index) => store.cycleDay + index) : [];

  const progressExercise = trackedExercises.find((item) => item.id === progressExerciseId) ?? trackedExercises[0];
  const progressByWeek = Array.from({ length: 6 }, (_, index) => {
    const results = store.history
      .filter((record) => record.blockWeek === index + 1)
      .flatMap((record) => record.results)
      .filter((result) => result.exerciseId === progressExercise.id && result.done)
      .map((result) => result.challengeTotal ?? result.value)
      .filter((value): value is number => value !== null && Number.isFinite(value));
    if (!results.length) return { week: index + 1, best: null, average: null, total: null };
    return {
      week: index + 1,
      best: Math.max(...results),
      average: Math.round((results.reduce((sum, value) => sum + value, 0) / results.length) * 10) / 10,
      total: results.reduce((sum, value) => sum + value, 0),
    };
  });
  const plottedValues = progressByWeek.map((week) => week[progressMetric]);
  const numericValues = plottedValues.filter((value): value is number => value !== null);
  const chartMax = Math.max(...numericValues, 1);
  const firstValue = numericValues[0] ?? null;
  const lastValue = numericValues.at(-1) ?? null;
  const change = firstValue !== null && lastValue !== null ? Math.round((lastValue - firstValue) * 10) / 10 : null;
  const unit = progressExercise.tracking === "seconds" ? "s" : "reps";

  const startPlan = (plan: Plan, advancesPlan: boolean) => {
    if (store.active && !window.confirm("Une séance est déjà en cours. La remplacer ?")) return;
    setStore({ ...store, active: { plan, startedAt: Date.now(), stepIndex: 0, steps: flattenPlan(plan), warmupDone: false, advancesPlan, activeMs: 0, lastActivityAt: Date.now() } });
    setTimerRunning(false);
    setTimerSeconds(0);
    setTab("workout");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const updateStepAt = (stepIndex: number, updater: (step: ActiveStep) => ActiveStep) => {
    setStore((current) => {
      if (!current?.active) return current;
      return { ...current, active: bumpActivity({ ...current.active, steps: current.active.steps.map((step, index) => index === stepIndex ? updater(step) : step) }) };
    });
  };

  const updateStepResult = (stepIndex: number, field: "value" | "ballast" | "variant" | "rpe", value: string) => {
    updateStepAt(stepIndex, (step) => ({ ...step, result: { ...step.result, [field]: value } }));
  };

  const updateMiniSet = (stepIndex: number, setIndex: number, value: string) => {
    updateStepAt(stepIndex, (step) => ({ ...step, result: { ...step.result, miniSets: step.result.miniSets.map((item, itemIndex) => itemIndex === setIndex ? value : item) } }));
  };

  const addMiniSet = (stepIndex: number) => updateStepAt(stepIndex, (step) => ({ ...step, result: { ...step.result, miniSets: [...step.result.miniSets, ""] } }));

  const validateStep = (stepIndex: number) => {
    const step = store.active?.steps[stepIndex];
    if (!step) return;
    const wasDone = step.result.done;
    updateStepAt(stepIndex, (currentStep) => ({ ...currentStep, result: { ...currentStep.result, done: !wasDone } }));
    if (!wasDone && step.restSec > 0) {
      setTimerLabel("Chrono de repos");
      setTimerSeconds(step.restSec);
      setTimerRunning(true);
    }
  };

  const validateExercise = () => {
    if (!activeExercise || !activeStep) return;
    const allDone = activeExercise.entries.every(({ step }) => step.result.done);
    const indexes = new Set(activeExercise.entries.map(({ index }) => index));
    setStore((current) => !current?.active ? current : ({
      ...current,
      active: bumpActivity({
        ...current.active,
        steps: current.active.steps.map((step, index) => indexes.has(index) ? { ...step, result: { ...step.result, done: !allDone } } : step),
      }),
    }));
    if (!allDone && activeStep.restSec > 0) {
      setTimerLabel("Chrono de repos");
      setTimerSeconds(activeStep.restSec);
      setTimerRunning(true);
    }
  };

  const moveExercise = (direction: -1 | 1) => {
    const nextIndex = Math.min(Math.max(activeExerciseIndex + direction, 0), activeExerciseGroups.length - 1);
    const nextExercise = activeExerciseGroups[nextIndex];
    if (!nextExercise) return;
    setStore((current) => !current?.active ? current : ({ ...current, active: { ...current.active, stepIndex: nextExercise.firstIndex } }));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const openExerciseFromSummary = (key: string) => {
    const exerciseGroup = activeExerciseGroups.find((group) => group.key === key);
    if (!exerciseGroup) return;
    setStore((current) => !current?.active ? current : ({ ...current, active: { ...current.active, stepIndex: exerciseGroup.firstIndex } }));
    setTab("workout");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const finishSession = () => {
    if (!store.active) return;
    const active = bumpActivity(store.active);
    const results: SavedExerciseResult[] = active.steps.map((step) => ({
      exerciseId: step.id,
      exerciseName: step.name,
      tracking: step.tracking,
      series: step.round,
      value: step.result.value === "" ? null : Number(step.result.value),
      ballast: step.result.ballast === "" ? null : Number(step.result.ballast),
      variant: step.result.variant,
      rpe: step.result.rpe === "" ? null : Number(step.result.rpe),
      done: step.result.done,
      level: step.levelKey ? store.levels[step.levelKey] : null,
      challengeTotal: step.tracking === "challenge" ? step.result.miniSets.reduce((sum, value) => sum + (Number(value) || 0), 0) : null,
      challengeSets: step.tracking === "challenge" ? step.result.miniSets.filter((value) => value !== "").map(Number).filter(Number.isFinite) : undefined,
    }));
    const record: SessionRecord = {
      id: `${active.plan.id}-${Date.now()}`,
      planId: active.plan.id,
      title: active.plan.title,
      kind: active.plan.kind,
      date: toLocalDate(new Date()),
      durationMin: Math.max(1, Math.round((active.activeMs ?? 0) / 60000)),
      blockWeek: store.currentWeek,
      cycleDay: store.cycleDay,
      completedSteps: active.steps.filter((step) => step.result.done).length,
      totalSteps: active.steps.length,
      results,
    };
    const base = { ...store, history: [...store.history, record], active: null };
    setStore(active.advancesPlan ? advanceCycle(base) : base);
    setTimerRunning(false);
    setTimerSeconds(0);
    setTab("home");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const markRest = () => {
    if (!isRestDay) return;
    setStore(advanceCycle({ ...store, history: [...store.history, makeRestRecord(store)] }));
  };

  const markMissed = () => {
    if (!currentPlan) return;
    setStore(advanceCycle({ ...store, history: [...store.history, makeMissedRecord(store, currentPlan)] }));
    setSheet(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const jumpToDay = (day: number) => {
    setStore(skipToDay(store, store.currentWeek, day));
    setSheet(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const abandonSession = () => {
    if (!store.active) return;
    if (!window.confirm(`Abandonner « ${store.active.plan.title} » ? Rien ne sera enregistré.`)) return;
    setStore({ ...store, active: null });
    setTimerRunning(false);
    setTimerSeconds(0);
    setTab("home");
  };

  const setLevel = (key: LevelKey, level: 1 | 2 | 3) => setStore({ ...store, levels: { ...store.levels, [key]: level } });

  const saveSkill = (skillId: string) => {
    const value = Number(skillInputs[skillId]);
    if (!Number.isFinite(value) || value < 0) return;
    setStore({ ...store, skillLogs: [...store.skillLogs, { id: `${skillId}-${Date.now()}`, skillId, date: toLocalDate(new Date()), value }] });
    setSkillInputs({ ...skillInputs, [skillId]: "" });
  };

  const exportData = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(store, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `baptiste-training-${toLocalDate(new Date())}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importData = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = migrateStore(JSON.parse(await file.text()));
      if (store.history.length && !window.confirm(`Remplacer les ${store.history.length} entrées actuelles par cette sauvegarde (${parsed.history.length} entrées) ?`)) return;
      setStore(parsed);
      setTab("home");
    } catch { window.alert("Ce fichier n’est pas une sauvegarde Baptiste Training valide."); }
    finally { event.target.value = ""; }
  };

  const navItems: { id: Tab; label: string; icon: Parameters<typeof Icon>[0]["name"] }[] = [
    { id: "home", label: "Accueil", icon: "home" },
    { id: "program", label: "Programme", icon: "program" },
    { id: "workout", label: "Séance", icon: "play" },
    { id: "summary", label: "Bilan", icon: "summary" },
    { id: "progress", label: "Progrès", icon: "chart" },
    { id: "skills", label: "Niveaux", icon: "skill" },
    { id: "more", label: "Plus", icon: "more" },
  ];

  return <main className="app-shell">
    <aside className="sidebar">
      <AppLogo />
      <nav className="side-nav" aria-label="Navigation principale">{navItems.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><Icon name={item.icon} /><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-program"><span>PROGRAMME ACTUEL</span><strong>Bloc 1 · SWE 2</strong><p>{complete ? "Bloc terminé" : `Semaine ${store.currentWeek} sur 6 · Jour ${store.cycleDay}`}</p><div className="mini-progress"><span style={{ width: `${complete ? 100 : ((absoluteDay - 1) / 42) * 100}%` }} /></div></div>
      <p className="privacy-note"><span /> Données locales uniquement</p>
    </aside>

    <section className="content">
      <header className="topbar">
        <div className="mobile-logo"><AppLogo /></div>
        <div className="topbar-date"><span>{complete ? "BLOC TERMINÉ" : `S${store.currentWeek} · J${absoluteDay}`}</span><strong>{complete ? "Bloc 1 validé" : `Jour ${store.cycleDay} · ${DAY_LABELS[store.cycleDay - 1]}`}</strong></div>
        <div className="topbar-status"><span className={`status-dot ${status.level}`} /><div><small>RÉCUPÉRATION</small><strong>{status.label}</strong></div></div>
      </header>

      {tab === "home" && <div className="page home-page">
        {staleActive && store.active && <section className="notice-card warning"><div><span>SÉANCE RESTÉE OUVERTE</span><strong>{store.active.plan.title} · commencée le {formatShortDate(toLocalDate(new Date(store.active.startedAt)))}</strong><p>Termine-la si tu l’as faite, sinon abandonne-la pour repartir proprement.</p></div><div className="notice-actions"><button className="secondary-button" onClick={() => setTab("workout")}>Ouvrir</button><button className="ghost-button" onClick={abandonSession}>Abandonner</button></div></section>}
        {!store.history.length && !store.active && <section className="notice-card"><div><span>PREMIÈRE OUVERTURE</span><strong>Récupère ton historique</strong><p>Importe ta dernière sauvegarde (.json) pour retrouver tes séances, ta semaine en cours et tes perfs.</p></div><div className="notice-actions"><button className="primary-button" onClick={() => fileInputRef.current?.click()}><Icon name="upload" /> <span>Importer</span></button></div></section>}
        <section className={`hero-card ${isRestDay ? "rest-hero" : ""}`}>
          <div className="hero-copy">
            <div className="eyebrow-row"><span className="eyebrow">{complete ? "42 JOURS VALIDÉS" : `BLOC 1 · SEMAINE ${store.currentWeek} · JOUR ${store.cycleDay}`}</span><span className={`readiness-pill ${status.level}`}>{status.label}</span></div>
            <p className="overline">{complete ? "CYCLE TERMINÉ" : isRestDay ? "JOUR FLEXIBLE" : "PROCHAINE SÉANCE"}</p>
            <h1>{complete ? <>Bloc 1 <span>terminé.</span></> : isRestDay ? <>Récupère, <span>ou choisis une routine.</span></> : <>Aujourd’hui, <span>{currentPlan?.title}.</span></>}</h1>
            <p className="hero-description">{complete ? "Tes six semaines sont enregistrées. Exporte ta sauvegarde avant de passer au prochain bloc." : isRestDay ? `${status.text} Ce jour n’avance que lorsque tu valides ton repos ou termines une routine facultative.` : `${currentPlan?.focus}. ${status.text}`}</p>
            <div className="hero-actions">
              {store.active ? <button className="primary-button" onClick={() => setTab("workout")}><span>Reprendre {store.active.plan.shortTitle}</span><Icon name="arrow" /></button> : !complete && currentPlan ? <><button className="primary-button" onClick={() => startPlan(currentPlan, true)}><span>Commencer la séance</span><Icon name="arrow" /></button><button className="secondary-button" onClick={() => setSheet({ type: "skip" })}>Je ne peux pas y aller</button></> : isRestDay ? <><button className="primary-button" onClick={markRest}><span>Valider le repos</span><Icon name="check" /></button><button className="secondary-button" onClick={() => setTab("program")}>Choisir une routine</button></> : null}
              {!isRestDay && currentPlan && <span className="duration"><Icon name="clock" size={17} /> ≈ {currentPlan.duration} min</span>}
            </div>
          </div>
          <div className="hero-visual" aria-hidden="true"><div className="week-number">{complete ? "✓" : String(Math.min(store.currentWeek, 6)).padStart(2, "0")}</div><div className="visual-orbit orbit-one" /><div className="visual-orbit orbit-two" /><div className="visual-cross horizontal" /><div className="visual-cross vertical" /><span className="visual-caption">BLOC 01<br />SWE 2</span></div>
        </section>

        <section className="quick-stats">
          <article><span className="stat-icon"><Icon name="check" /></span><div><strong>{plannedMain}<em>/24</em></strong><span>Séances principales{missedCount ? ` · ${missedCount} manquée${missedCount > 1 ? "s" : ""}` : ""}</span></div></article>
          <article><span className="stat-icon purple"><Icon name="flame" /></span><div><strong>{optionalCount}</strong><span>Routines facultatives</span></div></article>
          <article><span className="stat-icon blue"><Icon name="chart" /></span><div><strong>{Math.min(6, store.currentWeek)}<em>/6</em></strong><span>Semaine du bloc</span></div></article>
          <article><span className="stat-icon orange"><Icon name="moon" /></span><div><strong>{restCount}</strong><span>Repos validés</span></div></article>
        </section>

        {!complete && <section className="panel cycle-panel">
          <div className="panel-heading"><div><span>PLANNING GLISSANT</span><h2>Ta semaine en 7 jours</h2></div><small>J{absoluteDay} EN COURS</small></div>
          <p className="cycle-hint">Touche un jour à venir pour y aller directement : les séances sautées seront notées « manquées ».</p>
          <div className="cycle-strip">{DAY_LABELS.map((label, index) => {
            const day = index + 1;
            return <button key={`${label}-${day}`} className={`cycle-day ${day < store.cycleDay ? "done" : ""} ${day === store.cycleDay ? "current" : ""}`} onClick={() => { if (day > store.cycleDay && !store.active) { setSheet({ type: "jump", day }); return; } const plan = currentPlanForDay(day); if (plan) { setSelectedPlanId(plan.id); setTab("program"); } }}><span>{day < store.cycleDay ? "✓" : `J${day}`}</span><strong>{label}</strong><small>{REST_DAYS.has(day) ? "Libre" : "Prévue"}</small></button>;
          })}</div>
        </section>}

        {isRestDay && !store.active && <section className="optional-choices">
          <article><span>01</span><h2>L-Sit intensif</h2><p>Force, technique et compression en supersets.</p><button onClick={() => startPlan(lSitPlan, true)}>Lancer</button></article>
          <article><span>02</span><h2>Abdos</h2><p>Quatre niveaux, effort et nombre de tours réglables.</p><button onClick={() => setTab("program")}>Configurer</button></article>
          <article><span>03</span><h2>Souplesse</h2><p>Trois routines, 30 à 60 secondes par position.</p><button onClick={() => setTab("program")}>Configurer</button></article>
        </section>}
      </div>}

      {tab === "program" && <div className="page workout-library">
        <div className="page-title"><span>BLOC 1 · 6 SEMAINES</span><h1>Le plan complet, <em>sans approximation.</em></h1><p>Quatre séances principales répétées pendant six semaines. Les jours 3, 5 et 7 restent libres.</p></div>
        <div className="workout-tabs" role="tablist" aria-label="Choisir une séance">{mainPlans.map((plan) => <button key={plan.id} role="tab" aria-selected={selectedPlan.id === plan.id} className={selectedPlan.id === plan.id ? "active" : ""} onClick={() => setSelectedPlanId(plan.id)}><small>J{plan.scheduleDay} · chaque semaine</small><strong>{plan.title}</strong></button>)}</div>
        <section className="workout-overview">
          <div className="overview-heading"><div><span>J{selectedPlan.scheduleDay} · SEMAINES 1 À 6</span><h2>{selectedPlan.title}</h2><p>{selectedPlan.focus}</p></div><div className="overview-actions"><span><Icon name="clock" size={18} /> ≈ {selectedPlan.duration} min</span><button className="primary-button" onClick={() => startPlan(selectedPlan, currentPlan?.id === selectedPlan.id)}>{currentPlan?.id === selectedPlan.id ? "Lancer" : "Faire hors planning"} <Icon name="play" size={18} /></button></div></div>
          <div className="warmup-line"><Icon name="check" size={17} /><span>{selectedPlan.warmup}</span></div>
          <div className="plan-blocks">{selectedPlan.blocks.map((block) => <article className="plan-block" key={block.id}><div className="block-heading"><div><span>{block.kind === "superset" ? "SUPERSET" : block.kind === "circuit" ? "CIRCUIT" : block.kind === "challenge" ? "CHALLENGE" : "EXERCICE"}</span><strong>{block.label}</strong></div><small>{block.roundsLabel}</small></div>{block.exercises.map((item) => <div className="block-exercise" key={item.id}><div><strong>{item.name}</strong><small>{item.note}</small>{(() => { const previous = lastPerformance(store.history, item.id); return previous ? <small className="block-previous"><Icon name="history" size={12} /> {formatShortDate(previous.record.date)} : {previousLine(previous)}</small> : null; })()}</div><span>{item.target}</span><span>{item.restLabel}</span><span>{item.tempo}</span></div>)}</article>)}</div>
        </section>

        <div className="page-title optional-title"><span>JOURS 3, 5 ET 7</span><h1>Routines <em>facultatives.</em></h1><p>Elles remplacent le repos seulement si ta récupération permet d’être à 100 % sur la séance suivante.</p></div>
        <section className="optional-builder-grid">
          <article className="builder-card"><span className="builder-number">01</span><small>L-SIT</small><h2>L-Sit intensif</h2><p>Deux supersets de technique puis un circuit de compression.</p><div className="builder-summary"><span>≈ {lSitPlan.duration} min</span><span>4 blocs</span></div><button className="primary-button" onClick={() => startPlan(lSitPlan, isRestDay)}>Lancer la routine</button></article>
          <article className="builder-card"><span className="builder-number">02</span><small>ABDOS</small><h2>{absRoutines[absKey].name}</h2><div className="builder-controls"><label>Routine<select value={absKey} onChange={(event) => setAbsKey(event.target.value as AbsRoutineKey)}>{Object.entries(absRoutines).map(([key, routine]) => <option key={key} value={key}>{routine.name}</option>)}</select></label><label>Effort<select value={absEffort} onChange={(event) => setAbsEffort(Number(event.target.value))}><option value={30}>30 s</option><option value={45}>45 s</option></select></label><label>Transition<select value={absTransition} onChange={(event) => setAbsTransition(Number(event.target.value))}><option value={30}>30 s</option><option value={15}>15 s</option></select></label><label>Tours<select value={absRounds} onChange={(event) => setAbsRounds(Number(event.target.value))}>{[2, 3, 4, 5].map((value) => <option key={value}>{value}</option>)}</select></label></div><div className="builder-summary"><span>≈ {absPlan.duration} min</span><span>{absRoutines[absKey].exercises.length} exercices</span></div><button className="primary-button" onClick={() => startPlan(absPlan, isRestDay)}>Lancer le circuit</button></article>
          <article className="builder-card"><span className="builder-number">03</span><small>SOUPLESSE</small><h2>{flexibilityRoutines[flexKey].name}</h2><div className="builder-controls"><label>Routine<select value={flexKey} onChange={(event) => setFlexKey(event.target.value as FlexRoutineKey)}>{Object.entries(flexibilityRoutines).map(([key, routine]) => <option key={key} value={key}>{routine.name}</option>)}</select></label><label>Séries<select value={flexSets} onChange={(event) => setFlexSets(Number(event.target.value))}>{[3, 4, 5, 6].map((value) => <option key={value}>{value}</option>)}</select></label><label>Maintien<select value={flexHold} onChange={(event) => setFlexHold(Number(event.target.value))}>{[30, 45, 60].map((value) => <option key={value}>{value} s</option>)}</select></label><label>Repos<select value={flexRest} onChange={(event) => setFlexRest(Number(event.target.value))}>{[20, 40, 60].map((value) => <option key={value}>{value} s</option>)}</select></label></div><div className="builder-summary"><span>≈ {flexPlan.duration} min</span><span>{flexibilityRoutines[flexKey].exercises.length} positions</span></div><button className="primary-button" onClick={() => startPlan(flexPlan, isRestDay)}>Lancer la routine</button></article>
        </section>
      </div>}

      {tab === "workout" && !store.active && <div className="page empty-workout"><div className="page-title"><span>MODE SÉANCE</span><h1>Aucune séance <em>en cours.</em></h1><p>Lance la séance prévue depuis l’accueil ou choisis une séance dans le programme.</p></div><button className="primary-button" onClick={() => setTab("home")}>Voir la séance du jour <Icon name="arrow" /></button></div>}

      {tab === "workout" && store.active && activeStep && activeExercise && <div className="page active-session">
        <div className="session-head"><div><span>{workoutLabel(store.active.plan)} · {store.active.advancesPlan ? "PLANNING ACTIF" : "HORS PLANNING"}</span><h1>{store.active.plan.title}</h1></div><div className="session-progress-copy"><strong>{completedSteps}<em>/{store.active.steps.length}</em></strong><span>SÉRIES VALIDÉES</span></div></div>
        <div className="session-progress"><span style={{ width: `${(completedSteps / store.active.steps.length) * 100}%` }} /></div>
        <button className={`warmup-card ${store.active.warmupDone ? "done" : ""}`} onClick={() => setStore({ ...store, active: store.active ? { ...store.active, warmupDone: !store.active.warmupDone } : null })}><span className="warmup-check"><Icon name="check" /></span><span><small>ÉCHAUFFEMENT</small><strong>{store.active.plan.warmup}</strong></span><em>{store.active.warmupDone ? "Effectué" : "À valider"}</em></button>
        <div className="active-grid">
          <section className="active-card">
            <div className="active-card-top"><div><span className={`type-pill ${activeStep.category}`}>{activeStep.category === "challenge" ? "7 MIN" : activeStep.category}</span><small>{activeStep.blockLabel.toUpperCase()} · EXERCICE {activeExerciseIndex + 1}/{activeExerciseGroups.length}</small><h2>{activeStep.name}</h2><p>{activeStep.note ?? "Reste propre, respecte le tempo et arrête la série si l’exécution se dégrade."}</p></div><div className="target-box"><span>OBJECTIF PAR SÉRIE</span><strong>{activeStep.target}</strong><small>{activeStep.restLabel === "—" ? "Sans repos imposé" : `${activeStep.restLabel} de repos`}</small></div></div>
            <div className="step-context"><span>{activeStep.tracking === "challenge" ? "SÉRIES LIBRES" : `${activeExercise.entries.length} SÉRIE${activeExercise.entries.length > 1 ? "S" : ""} AFFICHÉE${activeExercise.entries.length > 1 ? "S" : ""}`}</span><span>TEMPO · {activeStep.tempo}</span></div>
            <div className={`previous-card ${activePrevious ? "" : "empty"}`}>
              <div className="previous-main"><span><Icon name="history" size={14} /> DERNIÈRE FOIS{activePrevious ? ` · S${activePrevious.record.blockWeek} · ${formatShortDate(activePrevious.record.date)}` : ""}</span><strong>{activePrevious ? previousLine(activePrevious) : "Première fois sur cet exercice"}</strong>{activePrevious && previousDetails(activePrevious) && <small>{previousDetails(activePrevious)}</small>}</div>
              {activeBest && activeStep.tracking !== "check" && <div className="previous-best"><span>RECORD</span><strong>{activeBest.value}<em> {unitFor(activeStep.tracking)}</em></strong><small>{formatShortDate(activeBest.date)}</small></div>}
            </div>
            {activeStep.levelKey && <div className="level-picker"><div><span>NIVEAU DE PROGRESSION</span><strong>Niveau {store.levels[activeStep.levelKey]}</strong></div><div>{([1, 2, 3] as const).map((level) => <button key={level} className={store.levels[activeStep.levelKey!] === level ? "active" : ""} onClick={() => setLevel(activeStep.levelKey!, level)}>{level}</button>)}</div></div>}

            {activeStep.tracking === "challenge" ? <div className="challenge-entry"><div className="challenge-toolbar"><div><span>TOTAL ACTUEL</span><strong>{activeStep.result.miniSets.reduce((sum, value) => sum + (Number(value) || 0), 0)} reps</strong></div><button onClick={() => { setTimerLabel("Bloc de 7 minutes"); setTimerSeconds(420); setTimerRunning(true); }}>Démarrer 7 min</button></div><div className="mini-set-grid">{activeStep.result.miniSets.map((value, setIndex) => <label key={setIndex}><span>Série {setIndex + 1}</span><input inputMode="numeric" value={value} placeholder="0" onChange={(event) => updateMiniSet(activeExercise.firstIndex, setIndex, event.target.value)} /></label>)}<button className="add-set" onClick={() => addMiniSet(activeExercise.firstIndex)}>+ Ajouter une série</button></div><p>Aucun lest ici : fractionne librement les répétitions au poids du corps et bats ton total précédent.</p></div> : activeStep.tracking === "check" ? <div className="check-entry"><p>Cette progression est gérée de ton côté. Sélectionne ton niveau et valide lorsque ta routine est terminée.</p>{activeStep.loadMode === "variant" && <label><span>VARIANTE UTILISÉE</span><input value={activeStep.result.variant} placeholder="Optionnel" onChange={(event) => updateStepResult(activeExercise.firstIndex, "variant", event.target.value)} /></label>}</div> : (() => {
              const showVariant = activeStep.loadMode === "variant" || activeStep.loadMode === "band_or_weight";
              const showBallast = activeStep.loadMode === "weighted" || activeStep.loadMode === "band_or_weight";
              const fieldCount = 2 + Number(showVariant) + Number(showBallast);
              return <div className="set-table">
                <div className={`set-row set-header fields-${fieldCount}`}><span>SÉRIE</span><span>{activeStep.tracking === "seconds" ? "TEMPS (S)" : "RÉPÉTITIONS"}</span>{showVariant && <span>VARIANTE / ASSISTANCE</span>}{showBallast && <span>LEST (KG)</span>}<span>RPE</span><span>FAIT</span></div>
                {activeExercise.entries.map(({ index, step }) => {
                  const previousSet = activePrevious?.results.find((result) => result.series === step.round && result.value !== null) ?? null;
                  const current = step.result.value === "" ? null : Number(step.result.value);
                  const delta = previousSet?.value != null && current !== null && Number.isFinite(current) ? Math.round((current - previousSet.value) * 10) / 10 : null;
                  return <div className={`set-row fields-${fieldCount} ${step.result.done ? "done" : ""}`} key={step.stepId}>
                  <span className="set-number">SÉRIE {step.round}{previousSet && <small className="set-previous">préc. {previousSet.value}{step.tracking === "seconds" ? " s" : ""}{previousSet.ballast ? ` +${previousSet.ballast} kg` : ""}</small>}{delta !== null && <em className={`set-delta ${delta > 0 ? "up" : delta < 0 ? "down" : "same"}`}>{delta > 0 ? `+${delta}` : delta === 0 ? "=" : delta}</em>}</span>
                  <label><span className="mobile-field-label">{step.tracking === "seconds" ? "Temps (s)" : "Répétitions"}</span><input inputMode="decimal" aria-label={`${step.name}, série ${step.round}, ${step.tracking === "seconds" ? "temps" : "répétitions"}`} value={step.result.value} placeholder={previousSet?.value != null ? String(previousSet.value) : step.target.match(/\d+/)?.[0] ?? "0"} onChange={(event) => updateStepResult(index, "value", event.target.value)} /></label>
                  {showVariant && <label><span className="mobile-field-label">Variante / assistance</span><input aria-label={`${step.name}, série ${step.round}, variante`} value={step.result.variant} placeholder={step.loadMode === "band_or_weight" ? "Ex. élastique rouge" : "Optionnel"} onChange={(event) => updateStepResult(index, "variant", event.target.value)} /></label>}
                  {showBallast && <label><span className="mobile-field-label">Lest (kg)</span><input inputMode="decimal" aria-label={`${step.name}, série ${step.round}, lest`} value={step.result.ballast} placeholder="0" onChange={(event) => updateStepResult(index, "ballast", event.target.value)} /></label>}
                  <label><span className="mobile-field-label">RPE</span><input inputMode="decimal" aria-label={`${step.name}, série ${step.round}, RPE`} value={step.result.rpe} placeholder="—" onChange={(event) => updateStepResult(index, "rpe", event.target.value)} /></label>
                  <button className="set-check" aria-label={`${step.result.done ? "Réouvrir" : "Valider"} la série ${step.round}`} onClick={() => validateStep(index)}><Icon name="check" size={18} /></button>
                </div>;
                })}
              </div>;
            })()}

            {(activeStep.easier || activeStep.harder) && <div className="difficulty-grid"><article><span>PLUS SIMPLE</span><p>{activeStep.easier ?? "—"}</p></article><article><span>PLUS DUR</span><p>{activeStep.harder ?? "—"}</p></article></div>}
            <div className="validate-row"><button className={`validate-set ${activeExercise.entries.every(({ step }) => step.result.done) ? "done" : ""}`} onClick={validateExercise}><Icon name="check" />{activeExercise.entries.every(({ step }) => step.result.done) ? "Exercice validé" : `Valider toutes les séries`}</button></div>
            <div className="exercise-navigation"><button disabled={activeExerciseIndex === 0} onClick={() => moveExercise(-1)}>← Exercice précédent</button>{activeExerciseIndex < activeExerciseGroups.length - 1 ? <button className="next-exercise" onClick={() => moveExercise(1)}>Exercice suivant <Icon name="arrow" size={17} /></button> : <button className="finish-button" onClick={finishSession}>Terminer la séance <Icon name="check" size={17} /></button>}</div>
            <div className="abandon-row"><button onClick={abandonSession}>Abandonner la séance</button></div>
          </section>
          <aside className="session-aside"><div className={`timer-card ${timerRunning ? "running" : ""}`}><span>{timerLabel.toUpperCase()}</span><strong>{formatTimer(timerSeconds)}</strong><div className="timer-actions"><button onClick={() => setTimerRunning(!timerRunning)}>{timerRunning ? "Pause" : "Démarrer"}</button><button onClick={() => { setTimerSeconds(activeStep.restSec); setTimerRunning(false); }}>↻</button></div><div className="timer-presets">{[30, 60, 90, 120, 180, 240].map((seconds) => <button key={seconds} onClick={() => { setTimerLabel("Chrono de repos"); setTimerSeconds(seconds); setTimerRunning(true); }}>{seconds < 60 ? `${seconds}s` : seconds === 90 ? "1m30" : `${seconds / 60}m`}</button>)}</div></div><div className={`coach-card ${status.level}`}><span>RÉCUPÉRATION</span><strong>{status.label}</strong><p>{status.text}</p></div><button className="finish-link" onClick={finishSession}>Terminer maintenant</button></aside>
        </div>
      </div>}

      {tab === "summary" && <div className="page summary-page">
        <div className="page-title"><span>VUE D’ENSEMBLE</span><h1>Tous tes exercices, <em>sur un seul écran.</em></h1><p>{store.active ? "Le bilan se met à jour pendant ta séance. Tu peux revenir directement sur n’importe quel exercice." : lastCompletedSession ? "Voici le détail de ta dernière séance terminée." : "Commence une séance pour afficher toutes tes séries et répétitions."}</p></div>
        {summaryRows.length ? <>
          <section className="summary-totals">
            <article><span>EXERCICES TERMINÉS</span><strong>{summaryDoneExercises}<em>/{summaryRows.length}</em></strong><small>{store.active ? "Séance en cours" : "Dernière séance"}</small></article>
            <article><span>SÉRIES RÉALISÉES</span><strong>{summaryDoneSets}{summaryPlannedSets > 0 && <em>/{summaryPlannedSets}</em>}</strong><small>Validées série par série</small></article>
            <article><span>RÉPÉTITIONS TOTALES</span><strong>{summaryTotalReps}</strong><small>Hors exercices chronométrés</small></article>
          </section>
          <section className="panel session-summary-panel">
            <div className="panel-heading"><div><span>{store.active ? "SÉANCE EN DIRECT" : "DERNIÈRE SÉANCE TERMINÉE"}</span><h2>{store.active?.plan.title ?? lastCompletedSession?.title}</h2></div>{store.active && <button onClick={() => setTab("workout")}>Retour à la séance <Icon name="arrow" size={16} /></button>}</div>
            <div className="summary-table">
              <div className="summary-table-head"><span>EXERCICE</span><span>PRÉVU</span><span>FAIT</span><span>TOTAL</span><span>MEILLEURE</span><span>ÉTAT</span><span /></div>
              {summaryRows.map((row) => {
                const unitLabel = row.tracking === "seconds" ? "s" : "reps";
                const performance = row.tracking === "check" ? (row.level ? `Niveau ${row.level}` : "Validation") : row.total === null ? "—" : `${row.total} ${unitLabel}`;
                const best = row.tracking === "check" ? "—" : row.best === null ? "—" : `${row.best} ${unitLabel}`;
                return <article className="summary-row" key={row.key}>
                  <div className="summary-exercise"><strong>{row.name}</strong><small>{row.tracking === "seconds" ? "Temps" : row.tracking === "challenge" ? "Challenge 7 min" : row.tracking === "check" ? "Progression personnelle" : "Répétitions"}</small></div>
                  <div className="summary-stat"><span>PRÉVU</span><strong>{row.plannedSets ?? "Libre"}</strong></div>
                  <div className="summary-stat"><span>FAIT</span><strong>{row.completedSets}</strong></div>
                  <div className="summary-stat"><span>TOTAL</span><strong>{performance}</strong></div>
                  <div className="summary-stat"><span>MEILLEURE</span><strong>{best}</strong></div>
                  <span className={`summary-status ${row.status}`}>{row.status === "done" ? "Terminé" : row.status === "active" ? "En cours" : "À faire"}</span>
                  {store.active ? <button className="summary-open" onClick={() => openExerciseFromSummary(row.key)} aria-label={`Ouvrir ${row.name}`}><Icon name="arrow" size={16} /></button> : <span />}
                </article>;
              })}
            </div>
          </section>
        </> : <section className="panel summary-empty"><span>00</span><div><strong>Aucune séance à résumer.</strong><p>Lance la séance du jour : les exercices apparaîtront ici automatiquement.</p><button className="primary-button" onClick={() => setTab("home")}>Voir la séance du jour <Icon name="arrow" /></button></div></section>}
      </div>}

      {tab === "progress" && <div className="page progress-page">
        <div className="page-title"><span>PROGRESSION TOTALE</span><h1>Voir si tu progresses, <em>stagnes ou régresses.</em></h1><p>Chaque exercice au poids du corps est comparé d’une semaine à l’autre à partir de tes vraies séries.</p></div>
        <section className="progress-summary"><article><span>SÉANCES PRINCIPALES</span><strong>{plannedMain}<em>/24</em></strong><small>4 séances × 6 semaines</small></article><article><span>ROUTINES FACULTATIVES</span><strong>{optionalCount}</strong><small>L-Sit, abdos ou souplesse</small></article><article><span>AVANCEMENT</span><strong>{complete ? 100 : Math.round(((absoluteDay - 1) / 42) * 100)}<em> %</em></strong><small>{complete ? "Bloc terminé" : `Semaine ${store.currentWeek} · Jour ${store.cycleDay}`}</small></article></section>

        <section className="panel exercise-progress-panel">
          <div className="progress-controls"><label><span>EXERCICE À ANALYSER</span><select value={progressExercise.id} onChange={(event) => setProgressExerciseId(event.target.value)}>{trackedExercises.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="metric-switch">{(["best", "average", "total"] as const).map((metric) => <button key={metric} className={progressMetric === metric ? "active" : ""} onClick={() => setProgressMetric(metric)}>{metric === "best" ? "Meilleure série" : metric === "average" ? "Moyenne" : "Total séance"}</button>)}</div></div>
          <div className="exercise-progress-summary"><div><span>PREMIÈRE MESURE</span><strong>{firstValue ?? "—"}<em>{firstValue !== null ? ` ${unit}` : ""}</em></strong></div><div><span>DERNIÈRE MESURE</span><strong>{lastValue ?? "—"}<em>{lastValue !== null ? ` ${unit}` : ""}</em></strong></div><div className={change === null ? "" : change > 0 ? "positive" : change < 0 ? "negative" : "neutral"}><span>ÉVOLUTION</span><strong>{change === null ? "—" : `${change > 0 ? "+" : ""}${change}`}<em>{change !== null ? ` ${unit}` : ""}</em></strong><small>{change === null ? "Pas assez de données" : change > 0 ? "Progression" : change < 0 ? "Régression" : "Stable"}</small></div></div>
          <div className="exercise-bars">{progressByWeek.map((week) => { const value = week[progressMetric]; return <div className="exercise-bar-column" key={week.week}><div className="exercise-bar-value">{value ?? "—"}</div><div className="exercise-bar-track"><span className={week.week === store.currentWeek ? "current" : ""} style={{ height: `${value === null ? 2 : Math.max((value / chartMax) * 100, 5)}%` }} /></div><small>S{week.week}</small></div>; })}</div>
          <div className="progress-legend"><span><i className="positive-dot" /> Hausse</span><span><i className="neutral-dot" /> Stable</span><span><i className="negative-dot" /> Baisse</span><p>Pour les exercices classiques, « meilleure série » correspond à ton meilleur nombre de répétitions ou secondes. Pour le Challenge 5×7, c’est le total des 7 minutes.</p></div>
        </section>

        <div className="progress-grid"><section className="panel chart-panel"><div className="panel-heading"><div><span>RÉGULARITÉ</span><h2>Séances principales par semaine</h2></div><small>OBJECTIF : 4</small></div><div className="bar-chart six-bars">{weeklyCounts.map((count, index) => <div className="bar-column" key={index}><div className="bar-track"><span className={index + 1 === store.currentWeek ? "current" : ""} style={{ height: `${Math.max(count ? (count / 4) * 100 : 4, 4)}%` }} />{count > 0 && <em>{count}</em>}</div><small>S{index + 1}</small></div>)}</div></section><section className="panel challenge-panel"><div className="panel-heading"><div><span>5×7</span><h2>Derniers totaux</h2></div></div><div className="challenge-history">{store.history.filter((record) => record.kind === "challenge").slice(-1).flatMap((record) => record.results.filter((result) => result.challengeTotal !== null)).map((item) => <div key={item.exerciseId}><span>{item.exerciseName}</span><strong>{item.challengeTotal}</strong></div>)}{!store.history.some((record) => record.kind === "challenge") && <p>Aucun challenge enregistré pour le moment.</p>}</div></section></div>
        <section className="panel history-panel"><div className="panel-heading"><div><span>JOURNAL</span><h2>Dernières validations</h2></div></div>{store.history.length ? <div className="history-list">{[...store.history].reverse().slice(0, 20).map((record) => <article key={record.id} className={record.kind === "missed" ? "missed" : ""}><span className="history-check"><Icon name={record.kind === "rest" ? "moon" : record.kind === "missed" ? "skip" : "check"} size={18} /></span><div><strong>{record.title}</strong><small>{new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${record.date}T12:00:00`))}</small></div><span>S{record.blockWeek} · J{record.cycleDay}</span><span>{record.kind === "missed" ? "Manquée" : record.kind === "rest" ? "Repos" : record.durationMin ? `${record.durationMin} min` : "—"}</span><span>{record.totalSteps ? `${record.completedSteps}/${record.totalSteps}` : "—"}</span></article>)}</div> : <div className="empty-state"><span>01</span><div><strong>Le journal est prêt.</strong><p>Ta première validation apparaîtra ici.</p></div></div>}</section>
      </div>}

      {tab === "skills" && <div className="page skills-page">
        <div className="page-title"><span>NIVEAUX & SKILLS</span><h1>Niveau choisi, <em>performance mesurée.</em></h1><p>Les niveaux 1–3 identifient ta progression actuelle. Les scores personnels restent facultatifs.</p></div>
        <section className="level-overview">{Object.entries(store.levels).map(([key, value]) => <article key={key}><span>{key.toUpperCase()}</span><strong>Niveau {value}</strong><div>{([1, 2, 3] as const).map((level) => <button key={level} className={value === level ? "active" : ""} onClick={() => setLevel(key as LevelKey, level)}>{level}</button>)}</div></article>)}</section>
        <div className="skills-grid">{skillMetrics.map((skill, index) => {
          const logs = store.skillLogs.filter((log) => log.skillId === skill.id);
          const best = logs.length ? Math.max(...logs.map((log) => log.value)) : 0;
          const progress = Math.min((best / skill.target) * 100, 100);
          return <article className="skill-card" key={skill.id} style={{ "--skill-accent": skill.accent } as CSSProperties}><div className="skill-number">{String(index + 1).padStart(2, "0")}</div><span className="skill-label">MEILLEURE PERFORMANCE</span><h2>{skill.name}</h2><p>{best ? `${best} ${skill.unit}` : "Aucune performance enregistrée"}</p><div className="skill-progress"><span style={{ width: `${progress}%` }} /></div><div className="skill-target"><span>{Math.round(progress)} %</span><small>Cible : {skill.target} {skill.unit}</small></div><div className="skill-input"><input inputMode="decimal" aria-label={`Score ${skill.name}`} placeholder={`Score en ${skill.unit}`} value={skillInputs[skill.id] ?? ""} onChange={(event) => setSkillInputs({ ...skillInputs, [skill.id]: event.target.value })} /><button onClick={() => saveSkill(skill.id)}>AJOUTER</button></div></article>;
        })}</div>
      </div>}

      {tab === "more" && <div className="page more-page">
        <div className="page-title"><span>RÉGLAGES</span><h1>Récupération et <em>sauvegarde.</em></h1><p>Toutes les données restent enregistrées localement sur cet appareil.</p></div>
        <div className="more-grid"><section className="panel recovery-detail"><div className="panel-heading"><div><span>ÉTAT DU JOUR</span><h2>Ajuster la récupération</h2></div></div><div className={`big-status ${status.level}`}><span className="status-dot" /><div><strong>{status.label}</strong><p>{status.text}</p></div></div>{([['sleep', 'Sommeil', 4, 10, .5, ' h'], ['energy', 'Énergie', 1, 5, 1, ' / 5'], ['soreness', 'Courbatures', 1, 5, 1, ' / 5']] as const).map(([key, label, min, max, step, suffix]) => <label className="detail-slider" key={key}><div><span>{label}</span><strong>{store.recovery[key]}{suffix}</strong></div><input type="range" min={min} max={max} step={step} value={store.recovery[key]} onChange={(event) => setStore({ ...store, recovery: { ...store.recovery, [key]: Number(event.target.value) } })} /><small>Bas</small><small>Élevé</small></label>)}</section><section className="panel data-panel"><div className="panel-heading"><div><span>DONNÉES LOCALES</span><h2>Sauvegarder le suivi</h2></div></div><p>Exporte régulièrement une copie, surtout avant de changer d’iPhone ou de supprimer les données de Safari.</p><button className="data-action primary" onClick={exportData}><span className="data-icon"><Icon name="download" /></span><span><strong>Exporter la sauvegarde</strong><small>Fichier JSON complet</small></span><Icon name="arrow" size={17} /></button><button className="data-action" onClick={() => fileInputRef.current?.click()}><span className="data-icon"><Icon name="upload" /></span><span><strong>Restaurer une sauvegarde</strong><small>Ancienne (ChatGPT) ou nouvelle version</small></span><Icon name="arrow" size={17} /></button><div className="storage-info"><span><i /> Stockage local actif</span><span>{store.history.length} entrées</span></div></section></div>
        <section className="install-banner"><div className="install-icon"><span /></div><div><span>INSTALLATION IPHONE</span><h2>Ajouter à l’écran d’accueil</h2><p>Dans Safari : Partager, puis « Sur l’écran d’accueil ».</p></div><div className="install-steps"><span><b>1</b> Ouvrir dans Safari</span><span><b>2</b> Partager → écran d’accueil</span></div></section>
      </div>}

      <input ref={fileInputRef} type="file" accept="application/json,.json" hidden onChange={importData} />
      {sheet && <div className="sheet-backdrop" onClick={() => setSheet(null)}>
        <section className="sheet" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
          {sheet.type === "skip" && currentPlan && <>
            <span className="sheet-eyebrow">S{store.currentWeek} · JOUR {store.cycleDay}</span>
            <h2>Pas de salle aujourd’hui ?</h2>
            <p>Deux options, aucune ne crée de fausse séance dans ton historique.</p>
            <button className="sheet-option" onClick={() => setSheet(null)}><strong>La garder pour plus tard</strong><small>Rien ne bouge : {currentPlan.title} reste ta prochaine séance, demain ou quand tu peux.</small></button>
            <button className="sheet-option" onClick={markMissed}><strong>La marquer comme manquée</strong><small>Le planning passe au jour suivant ({DAY_LABELS[store.cycleDay % 7]}). Elle n’entre pas dans tes stats ni dans tes perfs.</small></button>
            <button className="sheet-cancel" onClick={() => setSheet(null)}>Annuler</button>
          </>}
          {sheet.type === "jump" && jumpTarget && <>
            <span className="sheet-eyebrow">S{store.currentWeek} · JOUR {jumpTarget}</span>
            <h2>Aller directement à {DAY_LABELS[jumpTarget - 1]} ?</h2>
            <p>Les jours entre deux seront notés automatiquement :</p>
            <ul className="sheet-list">{jumpSkipped.map((day) => { const plan = currentPlanForDay(day); return <li key={day}><span>J{day}</span><strong>{plan ? plan.title : "Jour libre"}</strong><em className={plan ? "missed" : ""}>{plan ? "Manquée" : "Repos"}</em></li>; })}</ul>
            <button className="primary-button" onClick={() => jumpToDay(jumpTarget)}><span>Confirmer</span><Icon name="arrow" /></button>
            {currentPlanForDay(jumpTarget) && <button className="sheet-cancel" onClick={() => { const plan = currentPlanForDay(jumpTarget); if (plan) { setSelectedPlanId(plan.id); setTab("program"); } setSheet(null); }}>Juste voir la séance</button>}
            <button className="sheet-cancel" onClick={() => setSheet(null)}>Annuler</button>
          </>}
        </section>
      </div>}

      <nav className="bottom-nav" aria-label="Navigation mobile">{navItems.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><Icon name={item.icon} size={19} /><span>{item.label}</span></button>)}</nav>
    </section>
  </main>;
}

