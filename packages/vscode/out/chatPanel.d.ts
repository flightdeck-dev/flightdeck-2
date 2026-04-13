import { FlightdeckClient } from "./flightdeckClient";
export declare class ChatPanel {
    private static currentPanel;
    private readonly panel;
    private readonly client;
    private disposables;
    private constructor();
    static createOrShow(client: FlightdeckClient): void;
    private loadHistory;
    private handleSend;
    private dispose;
    private getHtml;
}
