export type PlanKind = "main" | "challenge" | "optional";
export type BlockKind = "standard" | "superset" | "circuit" | "challenge";
export type Tracking = "reps" | "seconds" | "challenge" | "check";
export type LevelKey = "handstand" | "hspu" | "dragon" | "pistol" | "lsit";
export type LoadMode = "none" | "weighted" | "band_or_weight" | "variant";

export type Exercise = {
  id: string;
  name: string;
  category: "skill" | "force" | "core" | "mobility" | "challenge";
  target: string;
  tracking: Tracking;
  restSec: number;
  restLabel: string;
  tempo: string;
  loadMode: LoadMode;
  easier?: string;
  harder?: string;
  note?: string;
  levelKey?: LevelKey;
};

export type TrainingBlock = {
  id: string;
  label: string;
  kind: BlockKind;
  rounds: number;
  roundsLabel: string;
  exercises: Exercise[];
};

export type Plan = {
  id: string;
  title: string;
  shortTitle: string;
  focus: string;
  duration: number;
  kind: PlanKind;
  scheduleDay?: number;
  warmup: string;
  blocks: TrainingBlock[];
};

export type StepResult = {
  value: string;
  ballast: string;
  variant: string;
  rpe: string;
  done: boolean;
  miniSets: string[];
};

export type ActiveStep = Exercise & {
  stepId: string;
  blockId: string;
  blockLabel: string;
  blockKind: BlockKind;
  round: number;
  totalRounds: number;
  result: StepResult;
};

export type ActiveSession = {
  plan: Plan;
  startedAt: number;
  stepIndex: number;
  steps: ActiveStep[];
  warmupDone: boolean;
  advancesPlan: boolean;
  /** Temps d'entraînement réel cumulé (ms) : les pauses de plus de 20 min ne comptent pas. */
  activeMs?: number;
  lastActivityAt?: number;
  /** Fin du repos en cours (timestamp) : le chrono reste juste même écran verrouillé. */
  restEndAt?: number | null;
  restLabel?: string;
  note?: string;
  express?: boolean;
};

export type SavedExerciseResult = {
  exerciseId: string;
  exerciseName: string;
  tracking: Tracking;
  series: number;
  value: number | null;
  ballast: number | null;
  variant: string;
  rpe: number | null;
  done: boolean;
  level: number | null;
  challengeTotal: number | null;
  challengeSets?: number[];
};

export type SessionRecord = {
  id: string;
  planId: string;
  title: string;
  kind: PlanKind | "rest" | "missed";
  date: string;
  /** null = durée non mesurée (anciennes séances au chrono faussé). */
  durationMin: number | null;
  blockWeek: number;
  cycleDay: number;
  completedSteps: number;
  totalSteps: number;
  results: SavedExerciseResult[];
  note?: string;
  express?: boolean;
};

export type Recovery = { sleep: number; energy: number; soreness: number };
export type SkillLog = { id: string; skillId: string; date: string; value: number };

export type Store = {
  version: 3;
  startDate: string;
  currentWeek: number;
  cycleDay: number;
  history: SessionRecord[];
  active: ActiveSession | null;
  levels: Record<LevelKey, 1 | 2 | 3>;
  recovery: Recovery;
  skillLogs: SkillLog[];
  /** Date ISO du dernier export de sauvegarde. */
  lastExportAt?: string;
};

export const STORAGE_KEY = "baptiste-training-v3";
export const APP_VERSION = 3;
/** Au-delà de ce délai sans action, le temps n'est plus compté comme du temps d'entraînement. */
export const IDLE_GAP_MS = 20 * 60 * 1000;
export const DAY_LABELS = ["Upper Body 1", "Lower Body 1", "Repos / séance supp.", "Upper Body 2", "Repos / séance supp.", "Challenge 5×7", "Repos / séance supp."];
export const REST_DAYS = new Set([3, 5, 7]);

const exercise = (
  id: string,
  name: string,
  category: Exercise["category"],
  target: string,
  tracking: Tracking,
  restSec: number,
  restLabel: string,
  tempo: string,
  loadMode: LoadMode = "none",
  extra: Partial<Exercise> = {},
): Exercise => ({ id, name, category, target, tracking, restSec, restLabel, tempo, loadMode, ...extra });

export const mainPlans: Plan[] = [
  {
    id: "upper-1",
    title: "Upper Body 1",
    shortTitle: "Upper 1",
    focus: "Handstand · Muscle-up · tirage et poussée verticaux",
    duration: 70,
    kind: "main",
    scheduleDay: 1,
    warmup: "Échauffement complet — tu le réalises de ton côté.",
    blocks: [
      {
        id: "u1-handstand", label: "Technique & équilibre", kind: "standard", rounds: 1, roundsLabel: "Routine personnelle",
        exercises: [exercise("handstand", "Progression Handstand", "skill", "Selon ton niveau", "check", 0, "—", "Contrôlé", "variant", { levelKey: "handstand", note: "Sélectionne simplement ton niveau actuel avant de valider." })],
      },
      {
        id: "u1-muscle", label: "Figure mixte", kind: "standard", rounds: 4, roundsLabel: "4 séries",
        exercises: [exercise("muscle-up", "Muscle-ups", "skill", "3–6 reps", "reps", 120, "1–2 min", "Explosif", "band_or_weight", { easier: "Utiliser une bande élastique", harder: "Exécution stricte ou ajouter du lest" })],
      },
      {
        id: "u1-vertical", label: "Tiré & poussé verticaux alternés", kind: "superset", rounds: 4, roundsLabel: "3–4 tours",
        exercises: [
          exercise("pull-explosive", "Tractions pronation explosives", "force", "MR − 2", "reps", 60, "30–60 s", "Explosif ↑ · 1 s ↓", "band_or_weight", { easier: "Utiliser une bande élastique", harder: "Exploser plus haut ou ajouter du lest" }),
          exercise("straight-dips", "Dips sur barre droite", "force", "MR − 2", "reps", 90, "60–90 s", "1 s ↑ · 2 s ↓", "band_or_weight", { easier: "Réduire l’amplitude ou utiliser une bande", harder: "Descendre plus bas ou ajouter du lest" }),
        ],
      },
      {
        id: "u1-skin", label: "Renforcement figure", kind: "standard", rounds: 4, roundsLabel: "3–4 séries",
        exercises: [exercise("skin-cat", "Skin The Cat", "skill", "4–6 reps", "reps", 120, "1–2 min", "2 s ↓ · 1 s ↑", "variant", { easier: "Assistance des pieds ou bras pliés", harder: "Bras tendus, augmenter le TST et l’amplitude" })],
      },
      {
        id: "u1-dragon", label: "Figure tirée / gainage", kind: "standard", rounds: 4, roundsLabel: "3–4 séries",
        exercises: [exercise("dragon-flag", "Progression Dragon Flag", "core", "Selon ton niveau", "reps", 120, "1–2 min", "Selon le niveau", "variant", { levelKey: "dragon" })],
      },
    ],
  },
  {
    id: "lower-1",
    title: "Lower Body 1",
    shortTitle: "Lower 1",
    focus: "Quadriceps · ischios · travail unilatéral · L-Sit",
    duration: 65,
    kind: "main",
    scheduleDay: 2,
    warmup: "Échauffement complet — tu le réalises de ton côté.",
    blocks: [
      {
        id: "l1-pistol", label: "Focus quadriceps", kind: "standard", rounds: 4, roundsLabel: "3–4 séries par côté",
        exercises: [exercise("pistol", "Progression Pistol Squats", "force", "5–8 reps / côté", "reps", 90, "45–90 s", "2 s ↓ · 1 s ↑", "variant", { levelKey: "pistol" })],
      },
      {
        id: "l1-nordic", label: "Focus ischios", kind: "standard", rounds: 4, roundsLabel: "3–4 séries",
        exercises: [exercise("nordic", "Nordic Ham Curls", "force", "3–6 reps", "reps", 120, "1–2 min", "2–6 s ↓ · 1 s ↑", "variant", { easier: "Assistance avec bâton/bande ou négatives", harder: "Moins plier aux hanches" })],
      },
      {
        id: "l1-unilateral", label: "Bi-set unilatéral", kind: "superset", rounds: 2, roundsLabel: "2 tours par côté",
        exercises: [
          exercise("split-squat", "Split Squats", "force", "6–12 reps / côté", "reps", 0, "0 s", "2 s ↓ · pause 1 s · 1 s ↑", "weighted", { easier: "Réduire le TST ou se tenir", harder: "Se lester ou passer aux fentes à une jambe" }),
          exercise("single-hip", "Hip Thrusts à une jambe", "force", "6–12 reps / côté", "reps", 120, "1–2 min", "1 s ↑ · pause 1 s · 2 s ↓", "weighted", { easier: "Réduire le TST", harder: "Augmenter le TST ou se lester" }),
        ],
      },
      {
        id: "l1-calves", label: "Mollets", kind: "standard", rounds: 4, roundsLabel: "3–4 séries par côté",
        exercises: [exercise("single-calf", "Relevés de mollets à une jambe", "force", "10–15 reps / côté", "reps", 0, "0 s", "1 s ↑ · pause 1 s · 1 s ↓", "weighted", { easier: "Prendre du repos entre les séries", harder: "Se lester, max reps ou augmenter le TST" })],
      },
      {
        id: "l1-lsit", label: "Gainage & mobilité", kind: "standard", rounds: 6, roundsLabel: "3–6 séries",
        exercises: [exercise("lower-lsit", "L-Sit", "core", "≈ 80 % du temps max", "seconds", 60, "30–60 s", "Isométrique", "variant", { levelKey: "lsit", easier: "Suspendu à une barre", harder: "Barres parallèles, sol ou V-Sit" })],
      },
    ],
  },
  {
    id: "upper-2",
    title: "Upper Body 2",
    shortTitle: "Upper 2",
    focus: "HSPU · mouvements horizontaux unilatéraux · circuit core",
    duration: 70,
    kind: "main",
    scheduleDay: 4,
    warmup: "Échauffement complet — tu le réalises de ton côté.",
    blocks: [
      {
        id: "u2-hspu", label: "Figure poussée", kind: "standard", rounds: 4, roundsLabel: "3–4 séries",
        exercises: [exercise("hspu", "Progression HSPU", "skill", "Selon ton niveau", "reps", 180, "2–3 min", "Selon le niveau", "variant", { levelKey: "hspu" })],
      },
      {
        id: "u2-horizontal", label: "Tiré & poussé horizontaux alternés", kind: "superset", rounds: 3, roundsLabel: "3 tours par côté",
        exercises: [
          exercise("one-arm-row", "Rows à un bras", "force", "6–12 reps / côté", "reps", 60, "30–60 s", "1 s ↑ · pause 1 s · 2 s ↓", "weighted", { easier: "Ajuster le levier ou le TST", harder: "Surélever les pieds ou se lester" }),
          exercise("archer-push", "Pompes en archer à un bras", "force", "6–12 reps / côté", "reps", 90, "60–90 s", "2 s ↓ · pause 1 s · 1 s ↑", "variant", { easier: "Bras pliés ou réduire le TST", harder: "Bras tendus, augmenter le TST ou pompe à un bras" }),
        ],
      },
      {
        id: "u2-core", label: "Circuit abdos & gainage", kind: "circuit", rounds: 3, roundsLabel: "2–3 tours",
        exercises: [
          exercise("hanging-leg", "Relevés de jambes suspendu", "core", "8–15 reps", "reps", 10, "0–10 s", "1 s ↑ · pause 1 s · 1 s ↓", "variant", { easier: "Jambes pliées", harder: "Monter plus haut ou augmenter le TST" }),
          exercise("german-hang", "German Hang actif", "core", "5–30 s", "seconds", 10, "0–10 s", "Isométrique", "variant", { easier: "Barre basse, pieds au sol ou German Hang passif", harder: "Progressions supérieures Back Lever" }),
          exercise("flag-left", "Progression gainage drapeau", "core", "20–30 s", "seconds", 10, "0–10 s", "Isométrique", "variant"),
          exercise("flag-right", "Gainage drapeau — autre côté", "core", "20–30 s", "seconds", 10, "0–10 s", "Isométrique", "variant"),
          exercise("superman", "Gainage Superman dynamique", "core", "30 s", "seconds", 180, "2–3 min", "1 s ↑ · pause 1 s · 1 s ↓", "none", { easier: "Monter moins haut ou se reposer au sol", harder: "Monter plus haut, augmenter le TST ou dépasser 30 s" }),
        ],
      },
    ],
  },
  {
    id: "challenge-5x7",
    title: "Challenge 5×7",
    shortTitle: "5×7",
    focus: "Full body · endurance musculaire · total de répétitions",
    duration: 47,
    kind: "challenge",
    scheduleDay: 6,
    warmup: "Échauffement complet — tu le réalises de ton côté.",
    blocks: [
      {
        id: "challenge", label: "5 exercices · 7 minutes chacun", kind: "challenge", rounds: 1, roundsLabel: "Maximum propre",
        exercises: [
          exercise("challenge-pull", "Tractions pronation", "challenge", "Maximum en 7 min", "challenge", 180, "2–4 min", "1 s ↑ · 1 s ↓"),
          exercise("challenge-dips", "Dips", "challenge", "Maximum en 7 min", "challenge", 180, "2–4 min", "1 s ↓ · 1 s ↑"),
          exercise("challenge-legs", "Relevés de jambes suspendu", "challenge", "Maximum en 7 min", "challenge", 180, "2–4 min", "1 s ↑ · 1 s ↓"),
          exercise("challenge-pistol", "Progression Pistol Squat", "challenge", "Maximum en 7 min", "challenge", 180, "2–4 min", "1 s ↓ · 1 s ↑", "variant", { levelKey: "pistol" }),
          exercise("challenge-push", "Pompes", "challenge", "Maximum en 7 min", "challenge", 0, "Fin", "1 s ↓ · 1 s ↑"),
        ],
      },
    ],
  },
];

export const lSitPlan: Plan = {
  id: "optional-lsit",
  title: "L-Sit intensif",
  shortTitle: "L-Sit",
  focus: "Force · technique · compression",
  duration: 35,
  kind: "optional",
  warmup: "Échauffement général, puis les deux exercices spécifiques ci-dessous.",
  blocks: [
    {
      id: "ls-warm", label: "Échauffement spécifique", kind: "superset", rounds: 1, roundsLabel: "1 tour",
      exercises: [
        exercise("toe-arc", "Toucher ses pieds debout en arc de cercle", "mobility", "30–60 s", "seconds", 0, "—", "Régulier & contrôlé"),
        exercise("support-dips", "Support Dips actif", "skill", "30–60 s", "seconds", 0, "—", "Isométrique"),
      ],
    },
    {
      id: "ls-strength-a", label: "Force & technique — superset 1", kind: "superset", rounds: 4, roundsLabel: "4 tours",
      exercises: [
        exercise("lsit-progression", "Progression L-Sit", "skill", "3–7 s ou max si L-Sit complet", "seconds", 0, "0 s", "Isométrique", "variant", { levelKey: "lsit", easier: "Suspendu", harder: "Barres parallèles ou au sol" }),
        exercise("toe-touch", "Aller toucher ses pieds debout", "mobility", "30 s", "seconds", 90, "1–1 min 30", "Dynamique", "none", { note: "Entrer et sortir doucement de la zone d’inconfort." }),
      ],
    },
    {
      id: "ls-strength-b", label: "Force & technique — superset 2", kind: "superset", rounds: 4, roundsLabel: "3–4 tours",
      exercises: [
        exercise("tuck-alternate", "Tuck L-Sit jambes alternées", "skill", "6–12 reps", "reps", 0, "0 s", "Lent & contrôlé", "variant", { easier: "Suspendu", harder: "Barres parallèles, sol ou augmenter le TST" }),
        exercise("pike-dynamic", "Pike Stretch assis dynamique", "mobility", "30 s", "seconds", 60, "1 min", "Dynamique", "none", { note: "Petits mouvements contrôlés, sans douleur." }),
      ],
    },
    {
      id: "ls-compression", label: "Circuit superset compression", kind: "circuit", rounds: 4, roundsLabel: "3–4 tours",
      exercises: [
        exercise("hip-leg-raise", "Relevés de jambes focus hanches — barres parallèles", "core", "5–15 reps", "reps", 0, "0 s", "Explosif ↑ · 1–2 s ↓", "none", { easier: "Plier les jambes", harder: "Augmenter le TST ou bloquer 1 s en haut" }),
        exercise("hip-knee-raise", "Relevés de genoux focus hanches — barres parallèles", "core", "5–15 reps", "reps", 0, "0 s", "Explosif ↑ · 1–2 s ↓", "none", { harder: "Augmenter le TST ou bloquer 1 s en haut" }),
        exercise("floor-compression", "Relevés de jambes en compression au sol", "core", "5–15 reps", "reps", 0, "0 s", "Explosif ↑ · 1 s ↓", "none", { easier: "Mains plus près des hanches", harder: "Mains plus près des pieds ou bloquer en haut" }),
        exercise("pike-passive", "Pike Stretch assis passif", "mobility", "30 s", "seconds", 120, "1–2 min", "Isométrique passif", "none", { note: "Se pencher, se relâcher et respirer sans petits mouvements." }),
      ],
    },
  ],
};

export const absRoutines = {
  beginner: { name: "Premiers pas", exercises: ["Nageur", "Gainage avant-bras standard", "Relevés de jambes pliées", "Gainage côté gauche standard", "Gainage côté droit standard"] },
  intense: { name: "Gainage intensif", exercises: ["Hollow Body en répétitions", "Gainages alternés", "Superman statique", "Twists russes", "Gainage côté gauche avec rebonds", "Gainage côté droit avec rebonds", "Mountain Climbers contrôlés"] },
  obliques: { name: "Spéciale obliques", exercises: ["Mountain Climbers genoux opposés", "Twists russes", "Relevés de genoux et fesses", "Ciseaux opposés en étoiles", "Gainage côté gauche avec twist", "Gainage côté droit avec twist"] },
  steel: { name: "Abdos d’acier", exercises: ["Ciseaux opposés en étoiles", "Relevés de genoux et fesses", "Ouvertures complètes de corps", "Superman en répétitions", "Hollow Body statique", "Twists russes", "Relevés de jambes au sol", "Mountain Climbers genoux opposés"] },
} as const;
export type AbsRoutineKey = keyof typeof absRoutines;

export const flexibilityRoutines = {
  beginner: { name: "Premiers pas", exercises: ["Pike Stretch assis", "Cobra", "Straddle Stretch assis", "Transat ou chien tête en bas facile", "Twists"] },
  splits: { name: "Grands écarts", exercises: ["Straddle Stretch assis", "Pike Stretch assis", "Split", "Straddle Stretch debout — optionnel", "Pike Stretch debout — optionnel"] },
  advanced: { name: "Avancée", exercises: ["Split", "Pont", "Chien tête en bas", "Twists", "Straddle Stretch assis / Pancake"] },
} as const;
export type FlexRoutineKey = keyof typeof flexibilityRoutines;

export function makeAbsPlan(key: AbsRoutineKey, effort: number, transition: number, rounds: number): Plan {
  const routine = absRoutines[key];
  return {
    id: `optional-abs-${key}`,
    title: `Abdos · ${routine.name}`,
    shortTitle: "Abdos",
    focus: `${effort}/${transition} · ${rounds} tours · circuit`,
    duration: Math.round((routine.exercises.length * (effort + transition) * rounds + (rounds - 1) * 150) / 60),
    kind: "optional",
    warmup: "Échauffement libre avant de démarrer le circuit.",
    blocks: [{
      id: "abs-circuit", label: "Circuit abdos", kind: "circuit", rounds, roundsLabel: `${rounds} tours`,
      exercises: routine.exercises.map((name, index) => exercise(`abs-${key}-${index}`, name, "core", `${effort} s`, "seconds", index === routine.exercises.length - 1 ? 150 : transition, index === routine.exercises.length - 1 ? "2–3 min" : `${transition} s`, "Contrôlé")),
    }],
  };
}

export function makeFlexPlan(key: FlexRoutineKey, sets: number, hold: number, rest: number): Plan {
  const routine = flexibilityRoutines[key];
  return {
    id: `optional-flex-${key}`,
    title: `Souplesse · ${routine.name}`,
    shortTitle: "Souplesse",
    focus: `${sets} séries · ${hold} s · sans douleur`,
    duration: Math.round((routine.exercises.length * sets * (hold + rest)) / 60),
    kind: "optional",
    warmup: "Échauffement libre pour faciliter l’assouplissement dès le début.",
    blocks: routine.exercises.map((name, index) => ({
      id: `flex-block-${index}`, label: "Position de souplesse", kind: "standard" as const, rounds: sets, roundsLabel: `${sets} séries`,
      exercises: [exercise(`flex-${key}-${index}`, name, "mobility", `${hold} s`, "seconds", rest, `${rest} s`, "Isométrique", "none", { note: "À la limite de l’inconfort, jamais jusqu’à la douleur. Relâche-toi et respire profondément." })],
    })),
  };
}

export const skillMetrics = [
  { id: "handstand", name: "Handstand libre", unit: "s", target: 30, accent: "#2f8fc1" },
  { id: "muscle-up", name: "Muscle-up propre", unit: "reps", target: 6, accent: "#247da9" },
  { id: "hspu", name: "HSPU propre", unit: "reps", target: 5, accent: "#55acd4" },
  { id: "lower-lsit", name: "L-Sit", unit: "s", target: 20, accent: "#145f86" },
  { id: "dragon-flag", name: "Dragon Flag", unit: "reps", target: 5, accent: "#73bddf" },
];

export function toLocalDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function createDefaultStore(): Store {
  return {
    version: APP_VERSION,
    startDate: toLocalDate(new Date()),
    currentWeek: 1,
    cycleDay: 1,
    history: [],
    active: null,
    levels: { handstand: 1, hspu: 1, dragon: 1, pistol: 1, lsit: 1 },
    recovery: { sleep: 7.5, energy: 4, soreness: 2 },
    skillLogs: [],
  };
}

export function flattenPlan(plan: Plan): ActiveStep[] {
  const steps: ActiveStep[] = [];
  plan.blocks.forEach((block) => {
    if (block.kind === "challenge") {
      block.exercises.forEach((item, index) => steps.push({
        ...item,
        stepId: `${block.id}-${item.id}-${index}`,
        blockId: block.id,
        blockLabel: block.label,
        blockKind: block.kind,
        round: 1,
        totalRounds: 1,
        result: { value: "", ballast: "", variant: "", rpe: "", done: false, miniSets: [""] },
      }));
      return;
    }
    for (let round = 1; round <= block.rounds; round += 1) {
      block.exercises.forEach((item, index) => steps.push({
        ...item,
        stepId: `${block.id}-${round}-${item.id}-${index}`,
        blockId: block.id,
        blockLabel: block.label,
        blockKind: block.kind,
        round,
        totalRounds: block.rounds,
        result: { value: "", ballast: "", variant: "", rpe: "", done: false, miniSets: [""] },
      }));
    }
  });
  return steps;
}

export function currentPlanForDay(day: number) {
  return mainPlans.find((plan) => plan.scheduleDay === day) ?? null;
}

export function formatTimer(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function advanceCycle(store: Store): Store {
  if (store.cycleDay < 7) return { ...store, cycleDay: store.cycleDay + 1 };
  if (store.currentWeek >= 6) return { ...store, currentWeek: 7, cycleDay: 1 };
  return { ...store, currentWeek: store.currentWeek + 1, cycleDay: 1 };
}

export function recoveryStatus(recovery: Recovery) {
  if (recovery.sleep < 6.5 || recovery.energy <= 2 || recovery.soreness >= 4) return { level: "low", label: "Récupération basse", text: "Choisis de préférence le repos complet ou une souplesse légère." };
  if (recovery.sleep < 7 || recovery.energy === 3 || recovery.soreness === 3) return { level: "medium", label: "Récupération moyenne", text: "Garde la séance propre et évite d’ajouter trop de volume." };
  return { level: "high", label: "Feu vert", text: "Tu peux suivre le volume prévu sans chercher l’échec technique." };
}

export function progressionExercises() {
  const unique = new Map<string, { id: string; name: string; tracking: Tracking }>();
  mainPlans.forEach((plan) => plan.blocks.forEach((block) => block.exercises.forEach((item) => {
    if (item.tracking !== "check") unique.set(item.id, { id: item.id, name: item.name, tracking: item.tracking });
  })));
  return [...unique.values()];
}


/* ------------------------------------------------------------------ */
/* V5 : séances manquées, migration et dernières performances          */
/* ------------------------------------------------------------------ */

export function isTrainingRecord(record: SessionRecord) {
  return record.kind !== "rest" && record.kind !== "missed";
}

function recordHasData(record: SessionRecord) {
  return record.results.some((result) => result.value !== null || (result.challengeTotal ?? 0) > 0);
}

export function makeMissedRecord(store: Store, plan: Plan | null, date = new Date()): SessionRecord {
  return {
    id: `missed-${plan?.id ?? "day"}-${date.getTime()}-${store.currentWeek}-${store.cycleDay}`,
    planId: plan?.id ?? "missed",
    title: plan?.title ?? "Séance",
    kind: "missed",
    date: toLocalDate(date),
    durationMin: null,
    blockWeek: store.currentWeek,
    cycleDay: store.cycleDay,
    completedSteps: 0,
    totalSteps: 0,
    results: [],
  };
}

export function makeRestRecord(store: Store, date = new Date()): SessionRecord {
  return {
    id: `rest-${date.getTime()}-${store.currentWeek}-${store.cycleDay}`,
    planId: "rest",
    title: "Repos complet",
    kind: "rest",
    date: toLocalDate(date),
    durationMin: 0,
    blockWeek: store.currentWeek,
    cycleDay: store.cycleDay,
    completedSteps: 0,
    totalSteps: 0,
    results: [],
  };
}

/** Avance le planning jusqu'au jour visé : séances prévues → manquées, jours libres → repos. */
export function skipToDay(store: Store, targetWeek: number, targetDay: number): Store {
  let next = store;
  let guard = 0;
  while ((next.currentWeek < targetWeek || (next.currentWeek === targetWeek && next.cycleDay < targetDay)) && next.currentWeek <= 6 && guard < 50) {
    const plan = currentPlanForDay(next.cycleDay);
    const record = plan ? makeMissedRecord(next, plan) : makeRestRecord(next);
    next = advanceCycle({ ...next, history: [...next.history, record] });
    guard += 1;
  }
  return next;
}

/**
 * Accepte une sauvegarde V2 (ChatGPT) ou V3 et la remet au propre :
 * - séances principales validées vides → « manquée »
 * - durées aberrantes (> 4 h) → non mesurées
 */
export function migrateStore(raw: unknown): Store {
  const data = raw as Omit<Partial<Store>, "version"> & { version?: number };
  if (!data || !Array.isArray(data.history) || (data.version !== 2 && data.version !== 3)) throw new Error("Format invalide");
  const defaults = createDefaultStore();
  const history: SessionRecord[] = data.history.map((record) => {
    const fixed: SessionRecord = { ...record, results: record.results ?? [] };
    if (fixed.durationMin !== null && fixed.durationMin > 240) fixed.durationMin = null;
    if ((fixed.kind === "main" || fixed.kind === "challenge") && !recordHasData(fixed)) {
      return { ...fixed, kind: "missed", durationMin: null, completedSteps: 0, results: [] };
    }
    return fixed;
  });
  return {
    ...defaults,
    ...data,
    version: APP_VERSION,
    history,
    levels: { ...defaults.levels, ...(data.levels ?? {}) },
    recovery: { ...defaults.recovery, ...(data.recovery ?? {}) },
    skillLogs: data.skillLogs ?? [],
    active: data.active ?? null,
  } as Store;
}

export type PreviousPerformance = {
  record: SessionRecord;
  results: SavedExerciseResult[];
};

/** Dernière séance réellement faite (hors manquées) contenant des valeurs pour cet exercice. */
export function lastPerformance(history: SessionRecord[], exerciseId: string): PreviousPerformance | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const record = history[index];
    if (!isTrainingRecord(record)) continue;
    const results = record.results.filter((result) => result.exerciseId === exerciseId);
    const useful = results.some((result) => result.value !== null || (result.challengeTotal ?? 0) > 0 || (result.tracking === "check" && (result.done || result.variant)));
    if (results.length && useful) return { record, results: [...results].sort((a, b) => a.series - b.series) };
  }
  return null;
}

/** Record personnel : meilleure série (ou meilleur total pour le challenge). */
export function personalBest(history: SessionRecord[], exerciseId: string) {
  let best: { value: number; date: string } | null = null;
  history.forEach((record) => {
    if (!isTrainingRecord(record)) return;
    record.results.forEach((result) => {
      if (result.exerciseId !== exerciseId) return;
      const value = result.tracking === "challenge" ? result.challengeTotal : result.value;
      if (value !== null && value !== undefined && value > 0 && (!best || value > best.value)) best = { value, date: record.date };
    });
  });
  return best as { value: number; date: string } | null;
}

export function formatShortDate(date: string) {
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(new Date(`${date}T12:00:00`));
}

/* ------------------------------------------------------------------ */
/* Séance express & suggestions de progression                         */
/* ------------------------------------------------------------------ */

/** Version courte (≈ 30–35 min) : pas de blocs « check », 3 séries max, 3 blocs max, 3 exercices max au challenge. */
export function makeExpressPlan(plan: Plan): Plan {
  const blocks = plan.blocks
    .filter((block) => block.exercises.some((item) => item.tracking !== "check"))
    .slice(0, 3)
    .map((block) => block.kind === "challenge"
      ? { ...block, label: "3 exercices · 7 minutes chacun", exercises: block.exercises.slice(0, 3) }
      : { ...block, rounds: Math.min(block.rounds, 3), roundsLabel: `${Math.min(block.rounds, 3)} séries` });
  const fullSteps = flattenPlan(plan).length;
  const expressSteps = flattenPlan({ ...plan, blocks }).length;
  return {
    ...plan,
    title: `${plan.title} · express`,
    shortTitle: `${plan.shortTitle} express`,
    duration: Math.max(25, Math.round((plan.duration * expressSteps) / Math.max(fullSteps, 1))),
    blocks,
  };
}

/** Haut de la fourchette d'objectif (« 6–12 reps » → 12, « 20–30 s » → 30), null si pas de fourchette. */
export function targetTop(target: string): number | null {
  const range = target.match(/(\d+)\s*[–-]\s*(\d+)/);
  if (range) return Number(range[2]);
  const single = target.match(/^(\d+)\s*(reps|s)\b/);
  return single ? Number(single[1]) : null;
}

export type ProgressionHint = { title: string; text: string };

export function progressionHint(history: SessionRecord[], exercise: Exercise, level: number | null): ProgressionHint | null {
  if (exercise.tracking !== "reps" && exercise.tracking !== "seconds") return null;
  const sessions: SavedExerciseResult[][] = [];
  for (let index = history.length - 1; index >= 0 && sessions.length < 3; index -= 1) {
    const record = history[index];
    if (!isTrainingRecord(record)) continue;
    const results = record.results.filter((result) => result.exerciseId === exercise.id && result.value !== null);
    if (results.length) sessions.push(results);
  }
  if (sessions.length < 2) return null;
  const unit = exercise.tracking === "seconds" ? "s" : "reps";
  const nextStep = exercise.levelKey && level !== null && level < 3
    ? `Passe au niveau ${level + 1}.`
    : exercise.loadMode === "weighted" || exercise.loadMode === "band_or_weight"
      ? "Ajoute un peu de lest (≈ 2,5 kg) ou retire l’assistance."
      : exercise.harder ? `${exercise.harder}.` : `Vise +1 ${unit} par série.`;
  const top = targetTop(exercise.target);
  if (top !== null && sessions.slice(0, 2).every((results) => results.every((result) => (result.value ?? 0) >= top))) {
    return { title: "Prêt à monter d’un cran", text: `Haut de la fourchette (${top} ${unit}) atteint 2 séances de suite. ${nextStep}` };
  }
  if (sessions.length >= 3) {
    const signature = (results: SavedExerciseResult[]) => results.map((result) => result.value).join("-");
    const totals = sessions.map((results) => results.reduce((sum, result) => sum + (result.value ?? 0), 0));
    if (new Set(sessions.map(signature)).size === 1 || (totals[0] <= totals[1] && totals[1] <= totals[2])) {
      return { title: "Ça stagne", text: `Même total ou moins depuis 3 séances. Essaie +1 ${unit} sur la première série, garde le reste identique.` };
    }
  }
  return null;
}
