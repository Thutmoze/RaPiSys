/**
 * RaPiSys — disk collector
 * ========================
 * Thin wrappers over the host agent's disk ops. All the real work (and all the
 * safety guards) live in the agent; this just forwards calls and timeouts.
 */
import { agentCall } from '../core/agent-client.js';

export function createDiskCollector() {
  return {
    /** df breakdown of `/`. */
    usage: () => agentCall('disk.usage', {}, null, 8000),

    /**
     * Read-only detection across all cleanup categories. `onProgress` (optional)
     * receives the agent's { step } and { category } messages as the scan runs.
     */
    scan: (journalTargetMB = 200, onProgress = null) => agentCall('disk.scan', { journalTargetMB }, onProgress, 60000),

    /**
     * Run cleanup for the given allow-listed category IDs. `onLine` (optional)
     * receives streamed progress lines for SSE relay. purgeAll requires confirm
     * === 'PURGE' (enforced again in the agent).
     */
    clean: ({ categories = [], journalTargetMB = 200, purgeAll = false, confirm = '' } = {}, onLine = null) =>
      agentCall('disk.clean', { categories, journalTargetMB, purgeAll, confirm }, onLine, 600000),
  };
}
