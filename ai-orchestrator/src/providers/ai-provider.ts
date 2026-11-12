import type {
  AIProvider,
  AIProviderGenerateOptions,
  AIProviderResponse,
  FileChange
} from '../models/types.js';

export type { AIProvider, AIProviderGenerateOptions, AIProviderResponse };

/**
 * MockAIProvider
 *
 * Deterministic local provider used for development and testing.
 * Runs completely offline without API keys.
 * Accurately reports itself as MockAIProvider so tests and audit logs
 * know mock logic was used.
 */
export class MockAIProvider implements AIProvider {
  public readonly name = 'mock';

  private customHandler?: (options: AIProviderGenerateOptions) => Promise<AIProviderResponse>;

  constructor(customHandler?: (options: AIProviderGenerateOptions) => Promise<AIProviderResponse>) {
    this.customHandler = customHandler;
  }

  async generateChanges(options: AIProviderGenerateOptions): Promise<AIProviderResponse> {
    if (this.customHandler) {
      return this.customHandler(options);
    }

    const { task, repoContext } = options;
    const taskText = `${task.id} ${task.title} ${task.description}`.toLowerCase();

    // Health endpoint mock implementation (PAY-101 / generic health check)
    if (taskText.includes('health') || taskText.includes('pay-101')) {
      // Only rewrite the file that actually holds PaymentServer. Overwriting another repo's
      // entry file (e.g. repo-b's OrderService) would destroy it.
      const paymentFile = repoContext.existingFiles.find((f) => f.content.includes('class PaymentServer'));

      if (!paymentFile) {
        return {
          providerName: this.name,
          reasoning: `[MockAIProvider] Task ${task.id} requested a health endpoint. Added src/health.ts in ${repoContext.repoId} without touching existing files.`,
          fileChanges: [
            {
              path: 'src/health.ts',
              action: 'create',
              content: `// Health check - generated for ${task.id}
export interface HealthStatus {
  status: 'UP' | 'DOWN';
  timestamp: string;
}

// GET /health
export function getHealth(): HealthStatus {
  return { status: 'UP', timestamp: new Date().toISOString() };
}
`
            }
          ]
        };
      }

      const targetFile = paymentFile.path;

      const fileChanges: FileChange[] = [
        {
          path: targetFile,
          action: 'modify',
          content: `// Service Server - Updated for ${task.id}
export interface HealthStatus {
  status: 'UP' | 'DOWN';
  timestamp: string;
  uptime: number;
}

export class PaymentServer {
  private startTime = Date.now();

  // GET /health
  public getHealth(): HealthStatus {
    return {
      status: 'UP',
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000)
    };
  }

  // Sample charge endpoint
  public charge(amount: number): { success: boolean; txId: string } {
    return {
      success: true,
      txId: \`tx_\${Date.now()}_\${amount}\`
    };
  }
}
`
        }
      ];

      return {
        providerName: this.name,
        reasoning: `[MockAIProvider] Task ${task.id} requested health endpoint. Implemented getHealth() returning status UP in ${targetFile}.`,
        fileChanges
      };
    }

    // Default mock response: adds/updates a feature module in the repo
    const fileChanges: FileChange[] = [
      {
        path: `src/features/${task.id.toLowerCase()}.ts`,
        action: 'create',
        content: `/**
 * Generated for task: ${task.id} - ${task.title}
 * Description: ${task.description}
 */    

export const featureConfig = {
  taskId: '${task.id}',
  title: ${JSON.stringify(task.title)},
  enabled: true,
  createdAt: '${new Date().toISOString()}'
};

export function executeFeature(): { success: boolean; taskId: string } {
  return {
    success: true,
    taskId: '${task.id}'
  };
}
`
      }
    ];

    return {
      providerName: this.name,
      reasoning: `[MockAIProvider] Created default feature implementation for task ${task.id} in repo ${repoContext.repoId}.`,
      fileChanges
    };
  }
}
