export type ProjectMode = 'anime' | 'realistic';
export type QualityPreset = 'speed' | 'balanced' | 'cinema';
export type VisualMode = 'cards' | 'ai-images';
export type SceneStatus = 'draft' | 'ready' | 'queued' | 'working' | 'done' | 'failed';
export type RenderStage = 'idle' | 'visual' | 'motion' | 'voice' | 'compose' | 'complete';
export type RenderJobState = 'queued' | 'running' | 'pausing' | 'paused' | 'canceling' | 'canceled' | 'failed' | 'completed';
export type RenderControlAction = 'pause' | 'resume' | 'cancel';
export type RenderSceneState = 'queued' | 'working' | 'done' | 'failed';
export type VoiceProfile = '青年・自然' | '少女・清冷' | '中性・自然' | '成熟・沉穩';

export type AgentId =
  | 'director'
  | 'screenwriter'
  | 'art-director'
  | 'ip-designer'
  | 'character-designer'
  | 'scene-designer'
  | 'storyboard-artist'
  | 'sound-director';
export type AgentStage = Exclude<AgentId, 'director'> | 'director-review';
export type AgentRunState = 'idle' | 'planning' | 'preparing-models' | 'rendering' | 'paused' | 'completed' | 'failed';
export type AgentTaskState = 'queued' | 'working' | 'done' | 'blocked' | 'failed';
export type AgentNodeKind =
  | 'script'
  | 'script-analysis'
  | 'art-direction'
  | 'ip-bible'
  | 'characters'
  | 'character'
  | 'locations'
  | 'location'
  | 'storyboard'
  | 'shot'
  | 'sound'
  | 'director-review'
  | 'render';

export interface AgentMember {
  id: AgentId;
  name: string;
  title: string;
  symbol: string;
  status: AgentTaskState | 'idle';
  progress: number;
  currentTask: string;
  lastMessage?: string;
}

export interface AgentTask {
  id: string;
  agentId: AgentId;
  title: string;
  detail: string;
  state: AgentTaskState;
  progress: number;
  nodeId?: string;
}

export interface AgentMessage {
  id: string;
  agentId?: AgentId;
  sender: string;
  text: string;
  createdAt: string;
  kind: 'agent' | 'user' | 'system';
}

export interface AgentCanvasNode {
  id: string;
  kind: AgentNodeKind;
  title: string;
  subtitle: string;
  status: AgentTaskState | 'idle';
  progress: number;
  x: number;
  y: number;
  width: number;
  height: number;
  agentId?: AgentId;
  characterId?: string;
  locationId?: string;
  sceneId?: string;
  previewPath?: string;
  previewDataUrl?: string;
  detail?: string;
  badges?: string[];
}

export interface StoryBeat {
  id: string;
  title: string;
  summary: string;
  tension: number;
  characterNames: string[];
  locationHint?: string;
}

export interface ScriptAnalysisArtifact {
  title: string;
  logline: string;
  genre: string;
  tone: string;
  theme: string;
  targetAudience: string;
  summary: string;
  beats: StoryBeat[];
  characterSeeds: Array<{ name: string; role: string; goal: string; conflict: string; traits: string[] }>;
  locationSeeds: Array<{ name: string; purpose: string; timeHint?: string }>;
}

export interface ArtDirectionArtifact {
  styleName: string;
  visualBible: string;
  colorPalette: string[];
  lighting: string;
  cameraLanguage: string;
  texture: string;
  globalPrompt: string;
  globalNegativePrompt: string;
}

export interface IpBibleArtifact {
  title: string;
  premise: string;
  worldRules: string[];
  continuityRules: string[];
  recurringMotifs: string[];
  prohibitedChanges: string[];
}

export interface LocationAsset {
  id: string;
  name: string;
  purpose: string;
  environmentAnchor: string;
  timeOfDay: string;
  weather: string;
  lighting: string;
  keyProps: string[];
  prompt: string;
  negativePrompt: string;
  referenceImagePath?: string;
  referenceImageDataUrl?: string;
}

export interface SoundCue {
  sceneId: string;
  musicCue: string;
  ambience: string;
  soundEffects: string[];
  dialoguePacing: string;
}

export interface SoundPlanArtifact {
  musicDirection: string;
  mixDirection: string;
  narratorVoice?: VoiceProfile;
  cues: SoundCue[];
}

export interface DirectorIssue {
  severity: 'info' | 'warning' | 'critical';
  sceneId?: string;
  message: string;
  fix: string;
}

export interface DirectorReviewArtifact {
  approved: boolean;
  score: number;
  summary: string;
  issues: DirectorIssue[];
  finalInstructions: string[];
}

export interface ProductionBible {
  script?: ScriptAnalysisArtifact;
  artDirection?: ArtDirectionArtifact;
  ipBible?: IpBibleArtifact;
  locations?: LocationAsset[];
  sound?: SoundPlanArtifact;
  directorReview?: DirectorReviewArtifact;
}

export interface AgentWorkspace {
  runId?: string;
  state: AgentRunState;
  autopilot: boolean;
  activeAgentId?: AgentId;
  startedAt?: string;
  finishedAt?: string;
  provider?: string;
  providerModel?: string;
  failure?: string;
  zoom: number;
  agents: AgentMember[];
  tasks: AgentTask[];
  messages: AgentMessage[];
  nodes: AgentCanvasNode[];
  artifacts?: ProductionBible;
}

export interface AgentRuntimeProfile {
  available: boolean;
  provider: 'lm-studio' | 'fallback';
  endpoint?: string;
  model?: string;
  message: string;
}


export type RuntimeSetupState = 'idle' | 'running' | 'completed' | 'failed';
export type RuntimeSetupStepState = 'queued' | 'working' | 'done' | 'failed';

export interface RuntimeSetupStep {
  id: 'system' | 'llmster' | 'model' | 'load' | 'verify';
  title: string;
  state: RuntimeSetupStepState;
  detail: string;
}

export interface RuntimeSetupSnapshot {
  state: RuntimeSetupState;
  stage: RuntimeSetupStep['id'];
  progress: number;
  title: string;
  message: string;
  model?: string;
  error?: string;
  updatedAtUnixMs: number;
  steps: RuntimeSetupStep[];
}

export interface AppUpdateInfo {
  configured: boolean;
  available: boolean;
  currentVersion: string;
  version?: string;
  notes?: string;
  endpoint?: string;
  message: string;
}

export interface Character {
  id: string;
  name: string;
  role: string;
  appearance: string;
  voice: VoiceProfile;
  locked: boolean;
  accent: string;
  /** Persisted local reference. A path is preferred in the desktop app; data URLs keep browser previews portable. */
  referenceImagePath?: string;
  referenceImageDataUrl?: string;
  referenceImageName?: string;
  consistencyStrength: number;
  identityAnchor?: string;
  appearancePrompt?: string;
  negativePrompt?: string;
  wardrobe?: string;
  expressionGuide?: string;
  voiceDirection?: string;
}

export interface Scene {
  id: string;
  order: number;
  title: string;
  visual: string;
  dialogue: string;
  characterIds: string[];
  duration: number;
  shot: string;
  status: SceneStatus;
  progress: number;
  seed?: number;
  /** Last real render artifact for this exact scene; never a CSS/mock preview. */
  previewPath?: string;
  visualSource?: 'ai' | 'reference' | 'card';
  locationId?: string;
  storyBeatId?: string;
  composition?: string;
  action?: string;
  emotion?: string;
  startFramePrompt?: string;
  endFramePrompt?: string;
  motionPrompt?: string;
  negativePrompt?: string;
  transition?: string;
  continuityIn?: string;
  continuityOut?: string;
  musicCue?: string;
  ambience?: string;
  soundEffects?: string[];
}

export interface ProjectSettings {
  mode: ProjectMode;
  format: '9:16' | '16:9' | '1:1';
  targetSeconds: number;
  quality: QualityPreset;
  renderMode: 'comic' | 'film';
  visualMode?: VisualMode;
  imageProvider?: 'auto' | 'sd-cli' | 'automatic1111';
  captions: boolean;
  /** Optional single-subject local MuseTalk pass. It is enabled only after a real provider probe succeeds. */
  lipSync?: boolean;
  autopilot?: boolean;
  keepCharacterIdentity?: boolean;
}

export interface EvolabsProject {
  schemaVersion: 1;
  id: string;
  title: string;
  story: string;
  updatedAt: string;
  workflowStep: number;
  maxUnlockedStep: number;
  plannedStoryFingerprint?: string;
  settings: ProjectSettings;
  characters: Character[];
  scenes: Scene[];
  productionBible?: ProductionBible;
  agentWorkspace?: AgentWorkspace;
  directorInstructions?: string[];
}

export interface HardwareProfile {
  gpu: string;
  vramMb: number;
  ramGb: number;
  cpu: string;
  profile: 'rtx3050-4gb' | 'low-vram' | 'balanced' | 'high-vram';
  runtimeReady: boolean;
  runtimeVersion?: string;
  aiReady?: boolean;
  aiProvider?: string;
  capabilities?: RuntimeCapabilities;
  modelPacks?: ModelPackStatus[];
}

export interface RuntimeCapabilities {
  comicCore: boolean;
  animeImage: boolean;
  realisticImage: boolean;
  characterConsistency: boolean;
  animeReference: boolean;
  realisticReference: boolean;
  multiCharacterReference: boolean;
  zhVoice: boolean;
  lipSync: boolean;
  imageToVideo: boolean;
}

export type ModelPackState = 'ready' | 'missing' | 'invalid' | 'unavailable';

export interface ModelPackStatus {
  id: string;
  name: string;
  status: ModelPackState;
  version?: string;
  message?: string;
}

export type ModelInstallState = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

export interface ModelInstallSnapshot {
  installId: string;
  packId?: string;
  packName?: string;
  state: ModelInstallState;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  fileName?: string;
  message?: string;
  error?: string;
}

export interface RenderCharacterAssetSnapshot {
  characterId: string;
  name: string;
  state: RenderSceneState;
  progress: number;
  previewPath?: string;
  generated?: boolean;
  cacheHit?: boolean;
  seed?: number;
}

export interface RenderSceneSnapshot {
  sceneId: string;
  state: RenderSceneState;
  progress: number;
  previewPath?: string;
  visualSource?: 'ai' | 'reference' | 'card';
  voiceProfile?: VoiceProfile;
}

export interface RenderJobError {
  code: string;
  message: string;
  detail?: string;
}

export interface RenderJobSnapshot {
  jobId: string;
  projectId: string;
  scope: 'sample' | 'full' | 'scene';
  state: RenderJobState;
  stage: RenderStage;
  overallProgress: number;
  sceneProgress: number;
  elapsedSeconds: number;
  activeSceneId?: string;
  characterAssets?: RenderCharacterAssetSnapshot[];
  scenes: RenderSceneSnapshot[];
  outputPath?: string;
  outputBytes?: number;
  message?: string;
  error?: RenderJobError;
}

export interface StoryPlan {
  title: string;
  characters: Character[];
  scenes: Scene[];
  source: 'local-ai' | 'fast-planner' | 'multi-agent';
  artDirection?: string;
  productionBible?: ProductionBible;
}
