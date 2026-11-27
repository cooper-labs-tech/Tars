import { buildFullPath } from './path-builder';
import { getProvider } from '../providers';
import { posixWords, withPath } from '../platform';
import { CliProbeError, probeCli } from '../core/cli-probe';

interface GeneratedTask {
  title: string;
  description: string;
  projectPath: string;
  projectId: string;
  priority: 'low' | 'medium' | 'high';
  labels: string[];
  requiredSkills: string[];
}

/**
 * Use the Claude CLI to generate structured task details from a natural-language prompt.
 * Falls back to a simple extraction when the CLI call or JSON parsing fails.
 */
export async function generateTaskFromPrompt(
  prompt: string,
  availableProjects: Array<{ path: string; name: string }>,
): Promise<GeneratedTask> {
  const projectList = availableProjects.map(p => `- "${p.name}" (${p.path})`).join('\n');

  const claudePrompt = `You are a task parser. Analyze the user's request and generate structured task details.

Available projects:
${projectList}

User's request:
${prompt}

Based on this request, generate a JSON object with these fields:
- title: A concise task title (max 80 chars)
- description: The full task description (keep the original request, improve clarity if needed)
- projectPath: The most relevant project path from the list above (use exact path)
- priority: "low", "medium", or "high" based on urgency indicators
- labels: Array of relevant labels (e.g., "bug", "feature", "refactor", "ui", "api", "docs", "test", "security", "performance")
- requiredSkills: Array of skills the agent might need (e.g., "commit", "test", "deploy")

IMPORTANT: Respond with ONLY the JSON object, no markdown, no explanation, just valid JSON.`;

  const fullPath = buildFullPath();

  // Build one-shot command via provider (defaults to Claude)
  const provider = getProvider('claude');
  const command = provider.buildOneShotCommand({
    binaryPath: provider.binaryName,
    prompt: claudePrompt,
    model: 'haiku',
  });

  try {
    // win32: no shell. The provider's command line is read back into argv
    // (the closed grammar of platform/posix-words.ts) and the binary resolved
    // (an npm claude.cmd) by probeCli, hidden. Through `exec` it went to
    // cmd.exe, where `'claude'` is no command, and the request and the project
    // names, which are user text, split at a newline and ran what followed an
    // `&`. darwin/linux: the line /bin/sh has always run, as `exec` ran it.
    // Started by probeCli (core/cli-probe.ts), so that its 30 s give-up and the
    // quit end it with what it started (27/11): `exec` signalled the shell
    // alone at its time, and nothing ended it at the quit.
    const env = withPath(process.env, fullPath, process.platform) as NodeJS.ProcessEnv;
    const [file, ...args] = process.platform === 'win32' ? posixWords(command) : ['/bin/sh', '-c', command];
    let claudeResult: string;
    try {
      claudeResult = (await probeCli(file, args, { env, timeoutMs: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();
    } catch (error) {
      const stderr = error instanceof CliProbeError ? error.stderr : '';
      console.error('[Kanban] Claude CLI error:', stderr || (error instanceof Error ? error.message : String(error)));
      throw error;
    }

    // Parse the JSON response
    let parsedTask;
    try {
      // Try to extract JSON from the response (in case there's extra text)
      const jsonMatch = claudeResult.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedTask = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseErr) {
      console.error('[Kanban] Failed to parse Claude response:', claudeResult);
      return buildFallbackTask(prompt, availableProjects);
    }

    // Validate and sanitize the response
    return {
      title: String(parsedTask.title || prompt.substring(0, 80)).substring(0, 80),
      description: String(parsedTask.description || prompt),
      projectPath: String(parsedTask.projectPath || availableProjects[0]?.path || ''),
      projectId: String(parsedTask.projectPath || availableProjects[0]?.path || ''),
      priority: ['low', 'medium', 'high'].includes(parsedTask.priority) ? parsedTask.priority : 'medium',
      labels: Array.isArray(parsedTask.labels) ? parsedTask.labels.slice(0, 5) : [],
      requiredSkills: Array.isArray(parsedTask.requiredSkills) ? parsedTask.requiredSkills.slice(0, 3) : [],
    };
  } catch (err) {
    console.error('[Kanban] Failed to generate task:', err);
    return buildFallbackTask(prompt, availableProjects);
  }
}

function buildFallbackTask(
  prompt: string,
  availableProjects: Array<{ path: string; name: string }>,
): GeneratedTask {
  const lines = prompt.split('\n').filter(l => l.trim());
  return {
    title: (lines[0] || prompt).substring(0, 80),
    description: prompt,
    projectPath: availableProjects[0]?.path || '',
    projectId: availableProjects[0]?.path || '',
    priority: 'medium',
    labels: [],
    requiredSkills: [],
  };
}
