/** The tools of the tool chat. New tools: a module with a `Tool`, added here. */
import { importReferencesTool } from './import-references/tool';
import { ToolRegistry } from './registry';

export function defaultRegistry(): ToolRegistry {
  return new ToolRegistry([importReferencesTool()]);
}
