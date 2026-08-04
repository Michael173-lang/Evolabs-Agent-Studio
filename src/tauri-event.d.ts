declare module '@tauri-apps/api/event' {
  export interface Event<T> {
    event?: string;
    id?: number;
    payload: T;
  }

  export function listen<T>(
    event: string,
    handler: (event: Event<T>) => void,
  ): Promise<() => void>;
}
