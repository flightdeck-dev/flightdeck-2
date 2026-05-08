type JsonFn = (status: number, body: unknown) => void;

export function errorJson(json: JsonFn, e: unknown, status = 400): void {
  json(status, { error: e instanceof Error ? e.message : String(e) });
}
