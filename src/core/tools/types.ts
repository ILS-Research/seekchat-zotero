/**
 * Tools for the tool chat. A tool is a function the model may call (see registry.ts): it gets the parsed
 * arguments and a ToolContext, shows its progress in its ToolRun and returns the text the model reads.
 * New tools are new modules registered in tools/index.ts; session, loop and rendering stay.
 */
import type { ChatRequest, LlmClient, ToolSpec } from '../llm/types';
import type { ToolRegistry } from './registry';
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
  /** The tools switched on for this answer (a tool that runs its own loop picks from them). */
  tools?: ToolRegistry;
  /** The model of this answer, for tools that ask it themselves (subagent); its context is the server's own. */
  llm?: { client: LlmClient; request: Omit<ChatRequest, 'messages' | 'tools'>; contextChars: number };
  /**
   * A signal of this run alone: the run gets a cancel button; aborted by that button or by stopping the chat.
   * The tool decides what a cancel means (e.g. return the results so far).
   */
  cancellable?(): AbortSignal;
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
  /**
   * Changes the library. Such a tool must show a preview and change nothing unless `ctx.confirm()` resolved true
   * (tool results can carry text from documents, so the model's wish alone is never enough); never given to a subagent.
   */
  writes?: boolean;
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
