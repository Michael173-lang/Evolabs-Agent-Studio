import { createId } from './id';
import type {
  AgentCanvasNode,
  AgentId,
  AgentMember,
  AgentStage,
  AgentTask,
  AgentTaskState,
  AgentWorkspace,
  EvolabsProject,
  ProductionBible,
} from '../types';

export const agentRoster: Array<Pick<AgentMember, 'id' | 'name' | 'title' | 'symbol'>> = [
  { id: 'director', name: '總導演', title: '製作統籌與品質驗收', symbol: '導' },
  { id: 'screenwriter', name: '編劇', title: '劇本分析、人物動機與節奏', symbol: '劇' },
  { id: 'art-director', name: '美術指導', title: '視覺語言、材質與光線', symbol: '美' },
  { id: 'ip-designer', name: '世界觀設計', title: '世界規則與連戲限制', symbol: '世' },
  { id: 'character-designer', name: '角色設計', title: '年齡、外觀、服裝與身份錨點', symbol: '角' },
  { id: 'scene-designer', name: '場景設計', title: '空間、時間、道具與環境連續性', symbol: '景' },
  { id: 'storyboard-artist', name: '分鏡設計', title: '可由影片模型執行的鏡頭規劃', symbol: '鏡' },
  { id: 'sound-director', name: '聲音指導', title: '對白節奏、環境音與配樂', symbol: '聲' },
];

const initialTasks: Array<Omit<AgentTask, 'id'>> = [
  { agentId: 'screenwriter', title: '理解劇本', detail: '等待劇本與真實模型回覆', state: 'queued', progress: 0 },
  { agentId: 'art-director', title: '建立視覺規範', detail: '等待編劇交付', state: 'queued', progress: 0 },
  { agentId: 'ip-designer', title: '建立世界與連戲規則', detail: '等待編劇交付', state: 'queued', progress: 0 },
  { agentId: 'character-designer', title: '建立角色身份資產', detail: '等待前序交付', state: 'queued', progress: 0 },
  { agentId: 'scene-designer', title: '建立場景資產', detail: '等待前序交付', state: 'queued', progress: 0 },
  { agentId: 'storyboard-artist', title: '建立影片鏡頭', detail: '等待角色、場景與影片能力', state: 'queued', progress: 0 },
  { agentId: 'sound-director', title: '建立聲音規劃', detail: '等待分鏡交付', state: 'queued', progress: 0 },
  { agentId: 'director', title: '驗收整體製作', detail: '等待所有專業交付', state: 'queued', progress: 0 },
];

export const stageAgent: Record<AgentStage, AgentId> = {
  screenwriter: 'screenwriter',
  'art-director': 'art-director',
  'ip-designer': 'ip-designer',
  'character-designer': 'character-designer',
  'scene-designer': 'scene-designer',
  'storyboard-artist': 'storyboard-artist',
  'sound-director': 'sound-director',
  'director-review': 'director',
};

function scriptNode(project: EvolabsProject): AgentCanvasNode {
  const story = project.story.trim();
  return {
    id: 'node_script',
    kind: 'script',
    title: project.title || '原始劇本',
    subtitle: story ? `${story.length.toLocaleString()} 字` : '等待輸入',
    status: story ? 'done' : 'idle',
    progress: story ? 100 : 0,
    x: 56,
    y: 72,
    width: 320,
    height: 180,
    agentId: 'screenwriter',
    detail: story,
  };
}

function node(
  id: string,
  kind: AgentCanvasNode['kind'],
  title: string,
  subtitle: string,
  agentId: AgentId,
  index: number,
  detail?: string,
): AgentCanvasNode {
  return {
    id,
    kind,
    title,
    subtitle,
    status: 'done',
    progress: 100,
    x: 420 + (index % 3) * 330,
    y: 70 + Math.floor(index / 3) * 220,
    width: 300,
    height: 170,
    agentId,
    detail,
  };
}

export function nodesForProduction(project: EvolabsProject, artifacts: ProductionBible = {}): AgentCanvasNode[] {
  const nodes: AgentCanvasNode[] = [scriptNode(project)];
  let index = 0;
  if (artifacts.script) nodes.push(node('node_script_analysis', 'script-analysis', artifacts.script.title, artifacts.script.logline, 'screenwriter', index++, artifacts.script.summary));
  if (artifacts.artDirection) nodes.push(node('node_art_direction', 'art-direction', artifacts.artDirection.styleName, '視覺規範', 'art-director', index++, artifacts.artDirection.visualBible));
  if (artifacts.ipBible) nodes.push(node('node_ip_bible', 'ip-bible', artifacts.ipBible.title, '世界與連戲規則', 'ip-designer', index++, artifacts.ipBible.premise));
  project.characters.forEach((character) => {
    const item = node(`node_character_${character.id}`, 'character', character.name, `${character.age ?? '年齡未設定'} · ${character.role}`, 'character-designer', index++, character.identityAnchor ?? character.appearance);
    item.characterId = character.id;
    item.previewPath = character.referenceImagePath;
    nodes.push(item);
  });
  (artifacts.locations ?? []).forEach((location) => {
    const item = node(`node_location_${location.id}`, 'location', location.name, `${location.timeOfDay} · ${location.weather}`, 'scene-designer', index++, location.environmentAnchor);
    item.locationId = location.id;
    item.previewPath = location.referenceImagePath;
    nodes.push(item);
  });
  project.scenes.forEach((scene) => {
    const item = node(`node_scene_${scene.id}`, 'shot', `鏡頭 ${scene.order} · ${scene.title}`, `${scene.duration} 秒 · ${scene.shot}`, 'storyboard-artist', index++, scene.videoPrompt ?? scene.visual);
    item.sceneId = scene.id;
    item.previewPath = scene.previewPath;
    item.status = scene.status === 'failed' ? 'failed' : scene.status === 'working' || scene.status === 'review' ? 'working' : scene.status === 'done' ? 'done' : 'queued';
    item.progress = scene.progress;
    nodes.push(item);
  });
  if (artifacts.sound) nodes.push(node('node_sound', 'sound', '聲音規劃', `${artifacts.sound.cues.length} 個鏡頭 Cue`, 'sound-director', index++, artifacts.sound.mixDirection));
  if (artifacts.directorReview) {
    const review = node('node_director_review', 'director-review', '總導演驗收', artifacts.directorReview.approved ? `核准 · ${artifacts.directorReview.score}/100` : `退件 · ${artifacts.directorReview.score}/100`, 'director', index++, artifacts.directorReview.summary);
    review.status = artifacts.directorReview.approved ? 'done' : 'blocked';
    review.progress = artifacts.directorReview.approved ? 100 : 50;
    nodes.push(review);
  }
  return nodes;
}

export function createAgentWorkspace(project: EvolabsProject): AgentWorkspace {
  return {
    state: 'idle',
    autopilot: true,
    zoom: 1,
    agents: agentRoster.map((agent) => ({ ...agent, status: 'idle', progress: 0, currentTask: '等待開始' })),
    tasks: initialTasks.map((task) => ({ ...task, id: createId('task') })),
    messages: [],
    activities: [],
    proposals: [],
    activeConversation: 'screenwriter',
    nodes: [scriptNode(project)],
    artifacts: {},
  };
}

export function refreshScriptNode(workspace: AgentWorkspace, project: EvolabsProject): AgentWorkspace {
  const next = scriptNode(project);
  return {
    ...workspace,
    nodes: workspace.nodes.some((item) => item.id === next.id)
      ? workspace.nodes.map((item) => item.id === next.id ? next : item)
      : [next, ...workspace.nodes],
  };
}

export function applyArtifactToWorkspace(
  workspace: AgentWorkspace,
  project: EvolabsProject,
  stage: AgentStage,
  artifacts: ProductionBible,
): AgentWorkspace {
  const agentId = stageAgent[stage];
  return {
    ...workspace,
    activeAgentId: undefined,
    artifacts,
    agents: workspace.agents.map((agent) => agent.id === agentId
      ? { ...agent, status: 'done', progress: 100, currentTask: '模型交付已驗證' }
      : agent),
    nodes: nodesForProduction(project, artifacts),
  };
}

export function setAgentPhase(
  workspace: AgentWorkspace,
  agentId: AgentId,
  state: AgentTaskState,
  progress: number,
  detail: string,
): AgentWorkspace {
  const bounded = Math.max(0, Math.min(100, progress));
  return {
    ...workspace,
    activeAgentId: state === 'working' || state === 'blocked' ? agentId : workspace.activeAgentId === agentId ? undefined : workspace.activeAgentId,
    agents: workspace.agents.map((agent) => agent.id === agentId
      ? { ...agent, status: state, progress: bounded, currentTask: detail }
      : agent),
    tasks: workspace.tasks.map((task) => task.agentId === agentId
      ? { ...task, state, progress: bounded, detail }
      : task),
  };
}

export function workspaceOverallProgress(workspace: AgentWorkspace): number {
  if (!workspace.tasks.length) return 0;
  return workspace.tasks.reduce((sum, task) => sum + task.progress, 0) / workspace.tasks.length;
}
