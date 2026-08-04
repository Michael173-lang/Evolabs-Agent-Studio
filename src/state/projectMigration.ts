import { createAgentWorkspace, nodesForProduction } from '../lib/agentPipeline';
import { planningFingerprint } from '../lib/planner';
import type {
  ArtDirectionArtifact,
  Character,
  DirectorReviewArtifact,
  EvolabsProject,
  IpBibleArtifact,
  LocationAsset,
  ProductionBible,
  ProjectSettings,
  Scene,
  ScriptAnalysisArtifact,
  SoundPlanArtifact,
  StoryBeat,
  VoiceProfile,
} from '../types';
import { createBlankProject } from './defaultProject';

const voices: readonly VoiceProfile[] = ['青年・自然', '少女・清冷', '中性・自然', '成熟・沉穩'];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, fallback: string, maximum = 20_000) => typeof value === 'string' ? value.slice(0, maximum) : fallback;
const optionalText = (value: unknown, maximum = 20_000) => typeof value === 'string' && value.trim() ? value.slice(0, maximum) : undefined;
const number = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const boolean = (value: unknown, fallback: boolean) => typeof value === 'boolean' ? value : fallback;
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback;
const clampStep = (value: unknown, fallback: number) => Math.max(0, Math.min(3, Math.trunc(number(value, fallback))));
const textArray = (value: unknown, maximumItems = 32, maximumText = 1200): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, maximumItems).map((item) => item.trim().slice(0, maximumText))
  : [];

function migrateSettings(value: unknown, fallback: ProjectSettings): ProjectSettings {
  const raw = isRecord(value) ? value : {};
  return {
    mode: oneOf(raw.mode, ['anime', 'realistic'] as const, fallback.mode),
    format: oneOf(raw.format, ['9:16', '16:9', '1:1'] as const, fallback.format),
    targetSeconds: Math.max(10, Math.min(300, number(raw.targetSeconds, fallback.targetSeconds))),
    quality: oneOf(raw.quality, ['speed', 'balanced', 'cinema'] as const, fallback.quality),
    renderMode: oneOf(raw.renderMode, ['comic', 'film'] as const, fallback.renderMode),
    visualMode: oneOf(raw.visualMode, ['cards', 'ai-images'] as const, fallback.visualMode ?? 'ai-images'),
    imageProvider: oneOf(raw.imageProvider, ['auto', 'sd-cli', 'automatic1111'] as const, fallback.imageProvider ?? 'auto'),
    captions: boolean(raw.captions, fallback.captions),
    lipSync: boolean(raw.lipSync, fallback.lipSync ?? false),
    autopilot: boolean(raw.autopilot, true),
    keepCharacterIdentity: boolean(raw.keepCharacterIdentity, true),
  };
}

function migrateCharacters(value: unknown): Character[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    return [{
      id: text(item.id, `character_migrated_${index}`, 120),
      name: text(item.name, `角色 ${index + 1}`, 80),
      role: text(item.role, '配角', 120),
      appearance: text(item.appearance, '', 2400),
      voice: oneOf(item.voice, voices, '中性・自然'),
      locked: boolean(item.locked, false),
      accent: text(item.accent, '#9298a6', 32),
      referenceImagePath: optionalText(item.referenceImagePath, 4096),
      referenceImageDataUrl: typeof item.referenceImageDataUrl === 'string' && item.referenceImageDataUrl.startsWith('data:image/') ? item.referenceImageDataUrl : undefined,
      referenceImageName: optionalText(item.referenceImageName, 240),
      consistencyStrength: Math.max(0, Math.min(1, number(item.consistencyStrength, .85))),
      identityAnchor: optionalText(item.identityAnchor, 2400),
      appearancePrompt: optionalText(item.appearancePrompt, 4000),
      negativePrompt: optionalText(item.negativePrompt, 2400),
      wardrobe: optionalText(item.wardrobe, 1600),
      expressionGuide: optionalText(item.expressionGuide, 1600),
      voiceDirection: optionalText(item.voiceDirection, 1200),
    }];
  });
}

function migrateScenes(value: unknown): Scene[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    return [{
      id: text(item.id, `scene_migrated_${index}`, 120),
      order: index + 1,
      title: text(item.title, `第 ${index + 1} 鏡`, 160),
      visual: text(item.visual, '', 4000),
      dialogue: text(item.dialogue, '', 3000),
      characterIds: Array.isArray(item.characterIds) ? item.characterIds.filter((entry): entry is string => typeof entry === 'string').slice(0, 24) : [],
      duration: Math.max(2, Math.min(30, number(item.duration, 5))),
      shot: text(item.shot, '中景・固定鏡頭', 300),
      status: oneOf(item.status, ['draft', 'ready', 'queued', 'working', 'done', 'failed'] as const, 'draft'),
      progress: Math.max(0, Math.min(100, number(item.progress, 0))),
      seed: typeof item.seed === 'number' && Number.isInteger(item.seed) && item.seed >= 0 ? Math.min(0x7fffffff, item.seed) : undefined,
      previewPath: optionalText(item.previewPath, 4096),
      visualSource: item.visualSource === 'ai' || item.visualSource === 'reference' || item.visualSource === 'card' ? item.visualSource : undefined,
      locationId: optionalText(item.locationId, 120),
      storyBeatId: optionalText(item.storyBeatId, 120),
      composition: optionalText(item.composition, 1600),
      action: optionalText(item.action, 2400),
      emotion: optionalText(item.emotion, 1200),
      startFramePrompt: optionalText(item.startFramePrompt, 5000),
      endFramePrompt: optionalText(item.endFramePrompt, 5000),
      motionPrompt: optionalText(item.motionPrompt, 3000),
      negativePrompt: optionalText(item.negativePrompt, 3000),
      transition: optionalText(item.transition, 500),
      continuityIn: optionalText(item.continuityIn, 1800),
      continuityOut: optionalText(item.continuityOut, 1800),
      musicCue: optionalText(item.musicCue, 1200),
      ambience: optionalText(item.ambience, 1200),
      soundEffects: textArray(item.soundEffects, 24, 300),
    }];
  });
}

function migrateScript(value: unknown): ScriptAnalysisArtifact | undefined {
  if (!isRecord(value)) return undefined;
  const beats: StoryBeat[] = Array.isArray(value.beats) ? value.beats.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    return [{
      id: text(item.id, `beat_${index + 1}`, 120),
      title: text(item.title, `節點 ${index + 1}`, 160),
      summary: text(item.summary, '', 1800),
      tension: Math.max(0, Math.min(100, number(item.tension, 50))),
      characterNames: textArray(item.characterNames, 24, 100),
      locationHint: optionalText(item.locationHint, 240),
    }];
  }) : [];
  const characterSeeds = Array.isArray(value.characterSeeds) ? value.characterSeeds.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== 'string') return [];
    return [{ name: text(item.name, '', 80), role: text(item.role, '配角', 120), goal: text(item.goal, '', 800), conflict: text(item.conflict, '', 800), traits: textArray(item.traits, 16, 120) }];
  }) : [];
  const locationSeeds = Array.isArray(value.locationSeeds) ? value.locationSeeds.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== 'string') return [];
    return [{ name: text(item.name, '', 120), purpose: text(item.purpose, '', 800), timeHint: optionalText(item.timeHint, 240) }];
  }) : [];
  return {
    title: text(value.title, '未命名專案', 160),
    logline: text(value.logline, '', 800),
    genre: text(value.genre, '', 160),
    tone: text(value.tone, '', 400),
    theme: text(value.theme, '', 600),
    targetAudience: text(value.targetAudience, '', 240),
    summary: text(value.summary, '', 3000),
    beats,
    characterSeeds,
    locationSeeds,
  };
}

function migrateArtDirection(value: unknown): ArtDirectionArtifact | undefined {
  if (!isRecord(value)) return undefined;
  return {
    styleName: text(value.styleName, '未命名視覺風格', 160),
    visualBible: text(value.visualBible, '', 4000),
    colorPalette: textArray(value.colorPalette, 16, 120),
    lighting: text(value.lighting, '', 1600),
    cameraLanguage: text(value.cameraLanguage, '', 1800),
    texture: text(value.texture, '', 1000),
    globalPrompt: text(value.globalPrompt, '', 4000),
    globalNegativePrompt: text(value.globalNegativePrompt, '', 3000),
  };
}

function migrateIpBible(value: unknown): IpBibleArtifact | undefined {
  if (!isRecord(value)) return undefined;
  return {
    title: text(value.title, 'IP／連戲聖經', 160),
    premise: text(value.premise, '', 1600),
    worldRules: textArray(value.worldRules, 32, 1000),
    continuityRules: textArray(value.continuityRules, 40, 1000),
    recurringMotifs: textArray(value.recurringMotifs, 24, 500),
    prohibitedChanges: textArray(value.prohibitedChanges, 32, 800),
  };
}

function migrateLocations(value: unknown): LocationAsset[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    return [{
      id: text(item.id, `location_migrated_${index}`, 120),
      name: text(item.name, `場景 ${index + 1}`, 160),
      purpose: text(item.purpose, '', 1200),
      environmentAnchor: text(item.environmentAnchor, '', 3000),
      timeOfDay: text(item.timeOfDay, '依劇本', 240),
      weather: text(item.weather, '依劇本', 240),
      lighting: text(item.lighting, '', 1600),
      keyProps: textArray(item.keyProps, 32, 300),
      prompt: text(item.prompt, '', 4000),
      negativePrompt: text(item.negativePrompt, '', 3000),
      referenceImagePath: optionalText(item.referenceImagePath, 4096),
      referenceImageDataUrl: typeof item.referenceImageDataUrl === 'string' && item.referenceImageDataUrl.startsWith('data:image/') ? item.referenceImageDataUrl : undefined,
    }];
  });
}

function migrateSound(value: unknown): SoundPlanArtifact | undefined {
  if (!isRecord(value)) return undefined;
  const cues = Array.isArray(value.cues) ? value.cues.flatMap((item) => {
    if (!isRecord(item) || typeof item.sceneId !== 'string') return [];
    return [{
      sceneId: text(item.sceneId, '', 120),
      musicCue: text(item.musicCue, '', 1200),
      ambience: text(item.ambience, '', 1200),
      soundEffects: textArray(item.soundEffects, 24, 300),
      dialoguePacing: text(item.dialoguePacing, '', 800),
    }];
  }) : [];
  return {
    musicDirection: text(value.musicDirection, '', 2400),
    mixDirection: text(value.mixDirection, '', 2000),
    narratorVoice: oneOf(value.narratorVoice, voices, '中性・自然'),
    cues,
  };
}

function migrateReview(value: unknown): DirectorReviewArtifact | undefined {
  if (!isRecord(value)) return undefined;
  const issues = Array.isArray(value.issues) ? value.issues.flatMap((item) => {
    if (!isRecord(item)) return [];
    return [{
      severity: oneOf(item.severity, ['info', 'warning', 'critical'] as const, 'warning'),
      sceneId: optionalText(item.sceneId, 120),
      message: text(item.message, '', 1200),
      fix: text(item.fix, '', 1200),
    }];
  }) : [];
  return {
    approved: boolean(value.approved, !issues.some((issue) => issue.severity === 'critical')),
    score: Math.max(0, Math.min(100, number(value.score, 80))),
    summary: text(value.summary, '', 2400),
    issues,
    finalInstructions: textArray(value.finalInstructions, 32, 1000),
  };
}

function migrateProductionBible(value: unknown): ProductionBible | undefined {
  if (!isRecord(value)) return undefined;
  const productionBible: ProductionBible = {
    script: migrateScript(value.script),
    artDirection: migrateArtDirection(value.artDirection),
    ipBible: migrateIpBible(value.ipBible),
    locations: migrateLocations(value.locations),
    sound: migrateSound(value.sound),
    directorReview: migrateReview(value.directorReview),
  };
  return Object.values(productionBible).some(Boolean) ? productionBible : undefined;
}

export function normalizeProject(value: unknown): EvolabsProject | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) return null;
  if (typeof value.id !== 'string' || typeof value.story !== 'string' || !isRecord(value.settings)) return null;

  const fallback = createBlankProject();
  const characters = migrateCharacters(value.characters);
  const scenes = migrateScenes(value.scenes);
  const productionBible = migrateProductionBible(value.productionBible);
  const inferredStep = scenes.length ? 3 : characters.length ? 1 : 0;
  const maxUnlockedStep = clampStep(value.maxUnlockedStep, inferredStep);
  const workflowStep = Math.min(clampStep(value.workflowStep, maxUnlockedStep), maxUnlockedStep);
  const project: EvolabsProject = {
    schemaVersion: 1,
    id: text(value.id, fallback.id, 160),
    title: text(value.title, fallback.title, 240),
    story: text(value.story, '', 100_000),
    updatedAt: text(value.updatedAt, new Date().toISOString(), 80),
    workflowStep,
    maxUnlockedStep,
    plannedStoryFingerprint: optionalText(value.plannedStoryFingerprint, 512),
    settings: migrateSettings(value.settings, fallback.settings),
    characters,
    scenes,
    productionBible,
    directorInstructions: textArray(value.directorInstructions, 32, 1200),
  };
  if (!project.plannedStoryFingerprint && scenes.length) project.plannedStoryFingerprint = planningFingerprint(project);

  const workspace = createAgentWorkspace(project);
  const rawWorkspace = isRecord(value.agentWorkspace) ? value.agentWorkspace : {};
  const state = oneOf(rawWorkspace.state, ['idle', 'planning', 'preparing-models', 'rendering', 'paused', 'completed', 'failed'] as const,
    scenes.some((scene) => scene.status === 'working' || scene.status === 'queued') ? 'rendering' : scenes.length && scenes.every((scene) => scene.status === 'done') ? 'completed' : 'idle');
  project.agentWorkspace = {
    ...workspace,
    state,
    autopilot: true,
    provider: optionalText(rawWorkspace.provider, 80),
    providerModel: optionalText(rawWorkspace.providerModel, 240),
    failure: optionalText(rawWorkspace.failure, 2400),
    startedAt: optionalText(rawWorkspace.startedAt, 80),
    finishedAt: optionalText(rawWorkspace.finishedAt, 80),
    artifacts: productionBible ?? {},
    nodes: scenes.length || productionBible ? nodesForProduction(project, productionBible ?? {}) : workspace.nodes,
  };
  return project;
}
