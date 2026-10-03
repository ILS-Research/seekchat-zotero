/**
 * Tools for the tool chat. A tool is a function the model may call (see registry.ts): it gets the parsed
 * arguments and a ToolContext, shows its progress in its ToolRun and returns the text the model reads.
 * New tools are new modules registered in tools/index.ts; session, loop and rendering stay.
 */
import type { ToolSpec } from '../llm/types';
import type { ToolRun } from '../turn';

/** Where tools that create items put them. */
export interface ToolTarget {
  libraryID: number;
  /** Collection to add new items to; none = library root. */
  collectionID?: number;
  label: string;
}

export interface ToolContext {
  target: ToolTarget;
  signal: AbortSignal;
  /** This call's entry in the answer; change it and call update() to redraw. */
  run: ToolRun;
  update(): void;
  /**
   * Puts the run into state "confirm" and waits for the user: true = go on with the items still checked,
   * false = cancelled (also when the chat is stopped).
   */
  confirm(): Promise<boolean>;
}

export interface Tool {
  spec: ToolSpec;
  /** Title of a run with these arguments, in the UI language. */
  title(args: Record<string, any>): string;
  /** Does the work; the returned text is the tool result the model reads (JSON or a short sentence). */
  run(args: Record<string, any>, ctx: ToolContext): Promise<string>;
}
