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
  /** The tool's settings (option key -> chosen value, see settings.ts). */
  options: Record<string, string>;
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

/** One choice of a tool setting; `available` false: shown disabled with `unavailableHint`. */
export interface ToolOptionChoice {
  value: string;
  label: string;
  available?: () => boolean;
  unavailableHint?: string;
}

/** A setting of a tool, chosen in the tool list of the window (stored as pref). */
export interface ToolOption {
  key: string;
  label: string;
  choices: ToolOptionChoice[];
  default: string;
}

export interface Tool {
  spec: ToolSpec;
  /** Name and one-line description in the tool list, in the UI language. */
  label(): string;
  description(): string;
  options?: ToolOption[];
  /** False while something the tool needs is missing (e.g. a plugin): not offered to the model, shown greyed out. */
  available?: () => boolean;
  /** Why it is not available, for the tool list. */
  unavailableHint?: () => string;
  /** Title of a run with these arguments, in the UI language. */
  title(args: Record<string, any>): string;
  /** Does the work; the returned text is the tool result the model reads (JSON or a short sentence). */
  run(args: Record<string, any>, ctx: ToolContext): Promise<string>;
}
