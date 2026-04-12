declare module 'ws' {
  export class WebSocketServer {
    constructor(opts: any);
    on(event: string, cb: (...args: any[]) => void): void;
  }
}
