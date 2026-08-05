export type ProjectMode = 'anime' | 'realistic';
export type QualityPreset = 'speed' | 'balanced' | 'cinema';
/** `cards` and `ai-images` are retained only so v0.7 projects can be migrated safely. */
export type VisualMode = 'ai-video' | 'motion-comic' | 'cards' | 'ai-images';
export type SceneStatus = 'draft' | 'ready' | 'queued' | 'working' | 'review' | 'done' | 'failed';
export type RenderStage = 'idle' | 'visual' | 'motion' | 'voice' | 'review' | 'compose' | 'complete';
export type RenderJobState = 'queued' | 'running' | 'awaiting-review' | 'pausing' | 'paused' | 'canceling' | 'canceled' | 'failed' | 'completed';
export type RenderControlAction = 'pause' | 'resume' | 'cancel';
export type RenderSceneState = 'queued' | 'working' | 'review' | 'done' | 'failed';
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
export type ConversationTarget = AgentId | 'production-meeting';
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
  requestId?: string;
  modelId?: string;
  startedAt?: string;
  finishedAt?: string;
  failure?: string;
}

export interface AgentTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AgentTaskAcknowledgement {
  understoodTask: boolean;
  objective: string;
  inputsReceived: string[];
  constraints: string[];
  missingInformation: string[];
}

export interface AgentRunEvidence {
  requestId: string;
  modelId: string;
  provider: string;
  latencyMs: number;
  usage?: AgentTokenUsage;
  schemaValid: boolean;
  acknowledgement?: AgentTaskAcknowledgement;
}

export type AgentChangeOperation =
  | {
      type: 'append-director-instruction';
      value: string;
    }
  | {
      type: 'set-character-field';
      characterName: string;
      field: 'age' | 'role' | 'appearance' | 'wardrobe' | 'identityAnchor' | 'appearancePrompt' | 'negativePrompt' | 'expressionGuide' | 'voiceDirection';
      value: string;
    }
  | {
      type: 'set-scene-field';
      sceneId?: string;
      sceneTitle?: string;
      field: 'title' | 'visual' | 'dialogue' | 'shot' | 'composition' | 'action' | 'emotion' | 'startFramePrompt' | 'endFramePrompt' | 'motionPrompt' | 'negativePrompt' | 'transition' | 'continuityIn' | 'continuityOut';
      value: string;
    };

export interface AgentChangeProposal {
  id: string;
  agentId: AgentId;
  title: string;
  summary: string;
  operations: AgentChangeOperation[];
  status: 'pending' | 'applied' | 'rejected';
  createdAt: string;
}

export interface AgentMessage {
  id: string;
  agentId?: AgentId;
  sender: string;
  text: string;
  createdAt: string;
  /** `agent` and `system` are legacy values; v0.8 dialogue only writes user/assistant. */
  kind: 'assistant' | 'user' | 'agent' | 'system';
  evidence?: AgentRunEvidence;
  proposalId?: string;
  /** Identifies the direct Agent chat or production meeting this message belongs to. */
  conversationTarget?: ConversationTarget;
}

export interface SystemActivityEvent {
  id: string;
  category: 'runtime' | 'agent' | 'video' | 'validation' | 'storage';
  level: 'info' | 'working' | 'success' | 'warning' | 'error';
  title: string;
  detail?: string;
  createdAt: string;
  requestId?: string;
  agentId?: AgentId;
  modelId?: string;
  durationMs?: number;
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
  characterSeeds: Array<{ name: string; role: string; goal: string; conflict: string; traits: string[]; age?: string; wardrobe?: string }>;
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
  returnToAgent?: AgentId;
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
  activeConversation?: ConversationTarget;
  startedAt?: string;
  finishedAt?: string;
  provider?: string;
  providerModel?: string;
  failure?: string;
  zoom: number;
  agents: AgentMember[];
  tasks: AgentTask[];
  /** Dialogue contains only user input and real model replies in v0.8. */
  messages: AgentMessage[];
  activities?: SystemActivityEvent[];
  proposals?: AgentChangeProposal[];
  nodes: AgentCanvasNode[];
  artifacts?: ProductionBible;
}

export interface AgentRuntimeProfile {
  available: boolean;
  provider: 'lm-studio' | 'unavailable';
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
  age?: string;
  appearance: string;
  voice: VoiceProfile;
  locked: boolean;
  accent: string;
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

export interface ShotQualityCheck {
  id: 'decode' | 'duration' | 'black-frame' | 'frozen-frame' | 'human-review' | 'semantic-safety';
  label: string;
  state: 'passed' | 'warning' | 'failed' | 'pending' | 'unavailable';
  detail: string;
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
  previewPath?: string;
  visualSource?: 'motion-comic' | 'reference' | 'video';
  locationId?: string;
  storyBeatId?: string;
  composition?: string;
  action?: string;
  emotion?: string;
  startFramePrompt?: string;
  endFramePrompt?: string;
  motionPrompt?: string;
  videoPrompt?: string;
  negativePrompt?: string;
  transition?: string;
  continuityIn?: string;
  continuityOut?: string;
  musicCue?: string;
  ambience?: string;
  soundEffects?: string[];
  generationAttempt?: number;
  reviewState?: 'pending' | 'approved' | 'rejected';
  reviewFeedback?: string;
  qualityChecks?: ShotQualityCheck[];
}

export interface ProjectSettings {
  mode: ProjectMode;
  format: '9:16' | '16:9' | '1:1';
  targetSeconds: number;
  quality: QualityPreset;
  renderMode: 'comic' | 'film';
  visualMode?: VisualMode;
  imageProvider?: 'auto' | 'sd-cli' | 'automatic1111';
  videoProviderId?: string;
  captions: boolean;
  lipSync?: boolean;
  autopilot?: boolean;
  keepCharacterIdentity?: boolean;
  manualShotApproval?: boolean;
  maxShotRetries?: number;
  strictCharacterSafety?: boolean;
  autoSave?: boolean;
  reducedMotion?: boolean;
}

export interface EvolabsProject {
  schemaVersion: 2;
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
  trueVideoGeneration?: boolean;
  videoProviderConfigured?: boolean;
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
  visualSource?: 'motion-comic' | 'reference' | 'video';
  voiceProfile?: VoiceProfile;
  generationAttempt?: number;
  reviewState?: 'pending' | 'approved' | 'rejected';
  reviewFeedback?: string;
  qualityChecks?: ShotQualityCheck[];
  providerId?: string;
  modelName?: string;
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

export interface VideoProviderCapabilities {
  textToVideo: boolean;
  imageToVideo: boolean;
  outputVideo: boolean;
  promptBinding: boolean;
  negativePromptBinding: boolean;
  seedBinding: boolean;
  dimensionsBinding: boolean;
  frameBinding: boolean;
  fpsBinding: boolean;
  inputImageBinding: boolean;
  outputPrefixBinding: boolean;
}

export interface VideoProviderStatus {
  configured: boolean;
  available: boolean;
  providerId?: string;
  kind?: 'comfyui';
  name?: string;
  endpoint?: string;
  workflowName?: string;
  workflowValid: boolean;
  nodeCount: number;
  capabilities: VideoProviderCapabilities;
  detectedModels: string[];
  compatibility: 'unsupported' | 'experimental' | 'recommended' | 'unknown';
  message: string;
  lastVerifiedAt?: string;
  error?: string;
}

export interface AgentModelDescriptor {
  id: string;
  name: string;
  loaded: boolean;
  recommended: boolean;
  family?: string;
  contextLength?: number;
}

export interface AgentModelCatalog {
  available: boolean;
  provider: 'lm-studio' | 'unavailable';
  endpoint?: string;
  selectedModel?: string;
  models: AgentModelDescriptor[];
  message: string;
}

export interface AgentModelTestResult {
  ok: boolean;
  modelId: string;
  latencyMs: number;
  requestId: string;
  usage?: AgentTokenUsage;
  message: string;
}

export interface AgentConversationResponse {
  assistantReply: string;
  acknowledgement: AgentTaskAcknowledgement;
  proposal?: Omit<AgentChangeProposal, 'id' | 'agentId' | 'status' | 'createdAt'>;
  evidence: AgentRunEvidence;
}

export interface AgentStageResponse<T = unknown> {
  assistantReply: string;
  acknowledgement: AgentTaskAcknowledgement;
  artifact: T;
  evidence: AgentRunEvidence;
}

export interface StoryPlan {
  title: string;
  characters: Character[];
  scenes: Scene[];
  source: 'local-ai' | 'fast-planner' | 'multi-agent';
  artDirection?: string;
  productionBible?: ProductionBible;
}
