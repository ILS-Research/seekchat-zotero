import type { ToolSpec } from '../llm/types';
import type { Tool } from './types';

/** The tools offered to the model, by name. */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.spec.name)) throw new Error(`tool ${tool.spec.name} registered twice`);
    this.tools.set(tool.spec.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  all(): Tool[] {
    return [...this.tools.values()];
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }

  get size(): number {
    return this.tools.size;
  }
}
