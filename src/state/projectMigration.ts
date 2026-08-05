import { createAgentWorkspace, nodesForProduction } from '../lib/agentPipeline';
import { planningFingerprint } from '../lib/planner';
import type {
  AgentChangeOperation,
  AgentChangeProposal,
  AgentId,
  AgentMessage,
  AgentRunEvidence,
  AgentTaskAcknowledgement,
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
  SystemActivityEvent,
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

const unsafeWardrobe = /(?:裸體|全裸|赤裸|裸身|無衣|沒穿衣|未穿衣|不穿衣|透明衣|透明服|透視裝|nude|naked|topless|bottomless|see[- ]?through|transparent clothing)/iu;
const clothingIndicator = /(?:衣|服|褲|裙|外套|襯衫|制服|西裝|毛衣|鞋|襪|shirt|jacket|coat|pants|trousers|skirt|dress|uniform|sweater|hoodie|shoe)/iu;
const validAge = (value: string) => {
  const match = value.match(/(?:^|[^0-9])(\d{1,3})(?:\s*(?:歲|years?\s*old|year[- ]old|y\/?o))?/iu);
  const age = match ? Number(match[1]) : Number.NaN;
  return Number.isInteger(age) && age >= 1 && age <= 120;
};
const validWardrobe = (value: string) => !unsafeWardrobe.test(value) && clothingIndicator.test(value);

function migrateSettings(value: unknown, fallback: ProjectSettings, sourceSchemaVersion: 1 | 2): ProjectSettings {
  const raw = isRecord(value) ? value : {};
  // Projects created before v0.8 had no true-video mode. Missing or legacy
  // values must therefore migrate to motion comic instead of silently turning
  // old still-image projects into AI-video projects.
  const visualMode = sourceSchemaVersion === 2 && (raw.visualMode === 'ai-video' || raw.visualMode === 'motion-comic')
    ? raw.visualMode
    : 'motion-comic';
  return {
    mode: oneOf(raw.mode, ['anime', 'realistic'] as const, fallback.mode),
    format: oneOf(raw.format, ['9:16', '16:9', '1:1'] as const, fallback.format),
    targetSeconds: Math.max(10, Math.min(300, number(raw.targetSeconds, fallback.targetSeconds))),
    quality: oneOf(raw.quality, ['speed', 'balanced', 'cinema'] as const, fallback.quality),
    renderMode: oneOf(raw.renderMode, ['comic', 'film'] as const, fallback.renderMode),
    visualMode,
    imageProvider: oneOf(raw.imageProvider, ['auto', 'sd-cli', 'automatic1111'] as const, fallback.imageProvider ?? 'auto'),
    videoProviderId: text(raw.videoProviderId, fallback.videoProviderId ?? 'comfyui-local', 120),
    captions: boolean(raw.captions, fallback.captions),
    lipSync: visualMode === 'ai-video' ? false : boolean(raw.lipSync, fallback.lipSync ?? false),
    autopilot: boolean(raw.autopilot, true),
    keepCharacterIdentity: boolean(raw.keepCharacterIdentity, true),
    manualShotApproval: boolean(raw.manualShotApproval, true),
    maxShotRetries: Math.max(1, Math.min(5, Math.trunc(number(raw.maxShotRetries, 3)))),
    strictCharacterSafety: boolean(raw.strictCharacterSafety, true),
    autoSave: boolean(raw.autoSave, true),
    reducedMotion: boolean(raw.reducedMotion, false),
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
      age: optionalText(item.age, 120),
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
      status: oneOf(item.status, ['draft', 'ready', 'queued', 'working', 'review', 'done', 'failed'] as const, 'draft'),
      progress: Math.max(0, Math.min(100, number(item.progress, 0))),
      seed: typeof item.seed === 'number' && Number.isInteger(item.seed) && item.seed >= 0 ? Math.min(0x7fffffff, item.seed) : undefined,
      previewPath: optionalText(item.previewPath, 4096),
      visualSource: item.visualSource === 'video' || item.visualSource === 'reference'
        ? item.visualSource
        : item.visualSource === 'ai' || item.visualSource === 'card' || item.visualSource === 'motion-comic'
          ? 'motion-comic'
          : undefined,
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
      videoPrompt: optionalText(item.videoPrompt, 6000),
      generationAttempt: Math.max(0, Math.min(10, Math.trunc(number(item.generationAttempt, 0)))),
      reviewState: oneOf(item.reviewState, ['pending', 'approved', 'rejected'] as const, 'pending'),
      reviewFeedback: optionalText(item.reviewFeedback, 1600),
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
    return [{
      name: text(item.name, '', 80),
      role: text(item.role, '配角', 120),
      goal: text(item.goal, '', 800),
      conflict: text(item.conflict, '', 800),
      traits: textArray(item.traits, 16, 120),
      age: optionalText(item.age, 120),
      wardrobe: optionalText(item.wardrobe, 1_000),
    }];
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
      videoPrompt: optionalText(item.videoPrompt, 6000),
      generationAttempt: Math.max(0, Math.min(10, Math.trunc(number(item.generationAttempt, 0)))),
      reviewState: oneOf(item.reviewState, ['pending', 'approved', 'rejected'] as const, 'pending'),
      reviewFeedback: optionalText(item.reviewFeedback, 1600),
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
    const returnToAgent = migrateAgentId(item.returnToAgent);
    return [{
      severity: oneOf(item.severity, ['info', 'warning', 'critical'] as const, 'warning'),
      sceneId: optionalText(item.sceneId, 120),
      message: text(item.message, '', 1200),
      fix: text(item.fix, '', 1200),
      returnToAgent: returnToAgent === 'director' ? undefined : returnToAgent,
    }];
  }) : [];
  return {
    approved: boolean(value.approved, !issues.some((issue) => issue.severity !== 'info')) && !issues.some((issue) => issue.severity !== 'info'),
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


const agentIds = ['director', 'screenwriter', 'art-director', 'ip-designer', 'character-designer', 'scene-designer', 'storyboard-artist', 'sound-director'] as const;
const activityCategories = ['runtime', 'agent', 'video', 'validation', 'storage'] as const;
const activityLevels = ['info', 'working', 'success', 'warning', 'error'] as const;

function migrateAgentId(value: unknown): AgentId | undefined {
  return typeof value === 'string' && agentIds.includes(value as AgentId) ? value as AgentId : undefined;
}

function migrateAcknowledgement(value: unknown): AgentTaskAcknowledgement | undefined {
  if (!isRecord(value)) return undefined;
  const objective = text(value.objective, '', 2_000).trim();
  if (!objective) return undefined;
  const acknowledgement: AgentTaskAcknowledgement = {
    understoodTask: value.understoodTask === true,
    objective,
    inputsReceived: textArray(value.inputsReceived, 40, 600),
    constraints: textArray(value.constraints, 40, 800),
    missingInformation: textArray(value.missingInformation, 24, 800),
  };
  if (!acknowledgement.understoodTask && !acknowledgement.missingInformation.length) return undefined;
  return acknowledgement;
}

function migrateEvidence(value: unknown): AgentRunEvidence | undefined {
  if (!isRecord(value) || value.schemaValid !== true) return undefined;
  const requestId = text(value.requestId, '', 240).trim();
  const modelId = text(value.modelId, '', 300).trim();
  const provider = text(value.provider, '', 120).trim();
  const latencyMs = number(value.latencyMs, -1);
  const acknowledgement = migrateAcknowledgement(value.acknowledgement);
  if (!requestId || !modelId || !provider || latencyMs < 0 || latencyMs > 24 * 60 * 60 * 1_000 || !acknowledgement) return undefined;
  const usageRaw = isRecord(value.usage) ? value.usage : undefined;
  const promptTokens = usageRaw ? number(usageRaw.promptTokens, -1) : -1;
  const completionTokens = usageRaw ? number(usageRaw.completionTokens, -1) : -1;
  const totalTokens = usageRaw ? number(usageRaw.totalTokens, -1) : -1;
  const usage = usageRaw && [promptTokens, completionTokens, totalTokens].some((entry) => entry >= 0)
    ? {
        promptTokens: promptTokens >= 0 ? Math.trunc(promptTokens) : undefined,
        completionTokens: completionTokens >= 0 ? Math.trunc(completionTokens) : undefined,
        totalTokens: totalTokens >= 0 ? Math.trunc(totalTokens) : undefined,
      }
    : undefined;
  return { requestId, modelId, provider, latencyMs, schemaValid: true, acknowledgement, usage };
}

function migrateWorkspaceMessages(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-500).flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const kind: AgentMessage['kind'] | null = item.kind === 'user' ? 'user' : item.kind === 'assistant' ? 'assistant' : null;
    if (!kind) return [];
    const messageText = text(item.text, '', 20_000).trim();
    if (!messageText) return [];
    const evidence = kind === 'assistant' ? migrateEvidence(item.evidence) : undefined;
    // Old v0.7 template messages and any assistant text without verifiable model evidence are discarded.
    if (kind === 'assistant' && !evidence) return [];
    const agentId = migrateAgentId(item.agentId);
    const conversationTargets = ['production-meeting', 'director', 'screenwriter', 'art-director', 'ip-designer', 'character-designer', 'scene-designer', 'storyboard-artist', 'sound-director'] as const;
    const conversationTarget = typeof item.conversationTarget === 'string' && conversationTargets.includes(item.conversationTarget as typeof conversationTargets[number])
      ? item.conversationTarget as typeof conversationTargets[number]
      : agentId ?? 'screenwriter';
    return [{
      id: text(item.id, `message_migrated_${index}`, 160),
      agentId,
      sender: text(item.sender, kind === 'user' ? '你' : 'AI 製片成員', 120),
      text: messageText,
      kind,
      createdAt: text(item.createdAt, new Date().toISOString(), 80),
      evidence,
      proposalId: optionalText(item.proposalId, 160),
      conversationTarget,
    }];
  });
}

function migrateActivities(value: unknown): SystemActivityEvent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-500).flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const title = text(item.title, '', 500).trim();
    if (!title) return [];
    const durationMs = number(item.durationMs, -1);
    return [{
      id: text(item.id, `activity_migrated_${index}`, 160),
      category: oneOf(item.category, activityCategories, 'validation'),
      level: oneOf(item.level, activityLevels, 'info'),
      title,
      detail: optionalText(item.detail, 8_000),
      createdAt: text(item.createdAt, new Date().toISOString(), 80),
      requestId: optionalText(item.requestId, 240),
      agentId: migrateAgentId(item.agentId),
      modelId: optionalText(item.modelId, 300),
      durationMs: durationMs >= 0 && durationMs <= 24 * 60 * 60 * 1_000 ? durationMs : undefined,
    }];
  });
}

function migrateOperation(value: unknown): AgentChangeOperation | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'append-director-instruction') {
    const content = text(value.value, '', 2_000).trim();
    return content ? { type: 'append-director-instruction', value: content } : undefined;
  }
  if (value.type === 'set-character-field') {
    const characterName = text(value.characterName, '', 100).trim();
    const content = text(value.value, '', 4_000).trim();
    const fields = ['age', 'role', 'appearance', 'wardrobe', 'identityAnchor', 'appearancePrompt', 'negativePrompt', 'expressionGuide', 'voiceDirection'] as const;
    const field = typeof value.field === 'string' && fields.includes(value.field as typeof fields[number]) ? value.field as typeof fields[number] : undefined;
    if (!characterName || !content || !field) return undefined;
    if (field === 'age' && !validAge(content)) return undefined;
    if (field === 'wardrobe' && !validWardrobe(content)) return undefined;
    return { type: 'set-character-field', characterName, field, value: content };
  }
  if (value.type === 'set-scene-field') {
    const content = text(value.value, '', 6_000).trim();
    const fields = ['title', 'visual', 'dialogue', 'shot', 'composition', 'action', 'emotion', 'startFramePrompt', 'endFramePrompt', 'motionPrompt', 'negativePrompt', 'transition', 'continuityIn', 'continuityOut'] as const;
    const field = typeof value.field === 'string' && fields.includes(value.field as typeof fields[number]) ? value.field as typeof fields[number] : undefined;
    const sceneId = optionalText(value.sceneId, 160);
    const sceneTitle = optionalText(value.sceneTitle, 180);
    if (!content || !field || Boolean(sceneId) === Boolean(sceneTitle)) return undefined;
    return sceneId
      ? { type: 'set-scene-field', sceneId, field, value: content }
      : { type: 'set-scene-field', sceneTitle, field, value: content };
  }
  return undefined;
}

function migrateProposals(value: unknown): AgentChangeProposal[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-200).flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const agentId = migrateAgentId(item.agentId);
    const title = text(item.title, '', 240).trim();
    const summary = text(item.summary, '', 2_000).trim();
    const operations = Array.isArray(item.operations) ? item.operations.slice(0, 24).map(migrateOperation) : [];
    if (!agentId || !title || !summary || operations.some((entry) => !entry) || !operations.length) return [];
    return [{
      id: text(item.id, `proposal_migrated_${index}`, 160),
      agentId,
      title,
      summary,
      operations: operations as AgentChangeOperation[],
      status: oneOf(item.status, ['pending', 'applied', 'rejected'] as const, 'pending'),
      createdAt: text(item.createdAt, new Date().toISOString(), 80),
    }];
  });
}

export function normalizeProject(value: unknown): EvolabsProject | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1 && value.schemaVersion !== 2) return null;
  const sourceSchemaVersion: 1 | 2 = value.schemaVersion === 2 ? 2 : 1;
  if (typeof value.id !== 'string' || typeof value.story !== 'string' || !isRecord(value.settings)) return null;

  const fallback = createBlankProject();
  const characters = migrateCharacters(value.characters);
  const scenes = migrateScenes(value.scenes);
  const productionBible = migrateProductionBible(value.productionBible);
  const inferredStep = scenes.length ? 3 : characters.length ? 1 : 0;
  const maxUnlockedStep = clampStep(value.maxUnlockedStep, inferredStep);
  const workflowStep = Math.min(clampStep(value.workflowStep, maxUnlockedStep), maxUnlockedStep);
  const project: EvolabsProject = {
    schemaVersion: 2,
    id: text(value.id, fallback.id, 160),
    title: text(value.title, fallback.title, 240),
    story: text(value.story, '', 100_000),
    updatedAt: text(value.updatedAt, new Date().toISOString(), 80),
    workflowStep,
    maxUnlockedStep,
    plannedStoryFingerprint: optionalText(value.plannedStoryFingerprint, 512),
    settings: migrateSettings(value.settings, fallback.settings, sourceSchemaVersion),
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
    messages: migrateWorkspaceMessages(rawWorkspace.messages),
    activities: migrateActivities(rawWorkspace.activities),
    proposals: migrateProposals(rawWorkspace.proposals),
    activeConversation: oneOf(rawWorkspace.activeConversation, ['production-meeting', 'director', 'screenwriter', 'art-director', 'ip-designer', 'character-designer', 'scene-designer', 'storyboard-artist', 'sound-director'] as const, 'screenwriter'),
    nodes: scenes.length || productionBible ? nodesForProduction(project, productionBible ?? {}) : workspace.nodes,
  };
  return project;
}
