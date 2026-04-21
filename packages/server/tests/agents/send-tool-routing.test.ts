import { describe, it, expect } from 'vitest';

/**
 * Verify that the CopilotSdkAdapter's flightdeck_send tool
 * posts to /messages/send (not /messages).
 *
 * We read the source and check the tool definition rather than
 * instantiating the full adapter (which requires ACP sessions).
 */
describe('flightdeck_send SDK tool routing', () => {
  it('tool handler calls /messages/send endpoint', async () => {
    // Read the source file to verify the URL path
    const fs = await import('node:fs');
    const path = await import('node:path');
    const adapterPath = path.join(import.meta.dirname, '..', '..', 'src', 'agents', 'CopilotSdkAdapter.ts');
    const source = fs.readFileSync(adapterPath, 'utf-8');

    // Find the flightdeck_send tool definition
    const sendToolIdx = source.indexOf("name: 'flightdeck_send'");
    expect(sendToolIdx).toBeGreaterThan(-1);

    // Extract the handler region (next ~30 lines after the tool name)
    const handlerRegion = source.slice(sendToolIdx, sendToolIdx + 1000);

    // Verify it calls /messages/send, NOT /messages
    expect(handlerRegion).toContain('/messages/send');
    expect(handlerRegion).toContain('httpPost');
  });

  it('tool has correct parameter schema', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const adapterPath = path.join(import.meta.dirname, '..', '..', 'src', 'agents', 'CopilotSdkAdapter.ts');
    const source = fs.readFileSync(adapterPath, 'utf-8');

    const sendToolIdx = source.indexOf("name: 'flightdeck_send'");
    const toolRegion = source.slice(sendToolIdx, sendToolIdx + 800);

    // Should have 'to', 'channel', and 'content' properties
    expect(toolRegion).toContain("to:");
    expect(toolRegion).toContain("channel:");
    expect(toolRegion).toContain("content:");
    // 'content' should be required
    expect(toolRegion).toContain("required: ['content']");
  });
});
