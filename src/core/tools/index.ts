/** The tools of the tool chat. New tools: a module with a `Tool`, added here. */
import { importReferencesTool } from './import-references/tool';
import { libraryTools } from './library/tools';
import { saveToCollectionTool } from './library/save-to-collection';
import { delegateTaskTool } from './agent/delegate';
import { createNoteTool } from './library/create-note';
import { updateItemTool } from './library/update-item';
import { readDocumentTool } from './library/read-document';
import { getDocumentReferencesTool, showReferencesTool } from './library/document-references';
import { ToolRegistry } from './registry';

export function defaultRegistry(): ToolRegistry {
  return new ToolRegistry([...libraryTools(), readDocumentTool(), updateItemTool(), createNoteTool(), saveToCollectionTool(), getDocumentReferencesTool(), showReferencesTool(), importReferencesTool(), delegateTaskTool()]);
}
