import type { EvolabsProject } from '../types';
import { createId } from '../lib/id';
import { createAgentWorkspace } from '../lib/agentPipeline';

export function createBlankProject(): EvolabsProject {
  const project: EvolabsProject = {
    schemaVersion: 1,
    id: createId('project'),
    title: '未命名專案',
    story: '',
    updatedAt: new Date().toISOString(),
    workflowStep: 0,
    maxUnlockedStep: 0,
    settings: {
      mode: 'anime',
      format: '9:16',
      targetSeconds: 60,
      quality: 'balanced',
      renderMode: 'film',
      visualMode: 'ai-images',
      imageProvider: 'auto',
      captions: true,
      lipSync: false,
      autopilot: true,
      keepCharacterIdentity: true,
    },
    characters: [],
    scenes: [],
    productionBible: {},
    directorInstructions: [],
  };
  project.agentWorkspace = createAgentWorkspace(project);
  return project;
}

export const sampleStory = '一名轉學生發現校園鐘樓能讓時間倒流，但每次撥動時針，都會讓身邊的人忘記一段與他的回憶。';
