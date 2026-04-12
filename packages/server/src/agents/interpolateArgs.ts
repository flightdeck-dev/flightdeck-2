/**
 * Replace `{key}` placeholders in CLI args with actual values.
 */
export function interpolateArgs(args: string[], vars: Record<string, string>): string[] {
  return args.map(a => {
    let result = a;
    for (const [k, v] of Object.entries(vars)) {
      result = result.replaceAll(`{${k}}`, v);
    }
    return result;
  });
}
