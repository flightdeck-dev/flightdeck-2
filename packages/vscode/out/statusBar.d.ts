import { FlightdeckClient } from "./flightdeckClient";
export declare class StatusBar {
    private item;
    private client;
    private timer?;
    private disposables;
    constructor(client: FlightdeckClient);
    startPolling(intervalMs?: number): void;
    private update;
    dispose(): void;
}
