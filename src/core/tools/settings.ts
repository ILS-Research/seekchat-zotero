/**
 * Which tools are switched on and their settings, as prefs: `seekchat.tools.disabled` (names, comma-separated;
 * new tools are on by default) and `seekchat.tools.<tool>.<option>`. A stored choice that is not available
 * (plugin missing) falls back to the default, so a tool keeps working.
 */
import { getPref, setPref } from '../../prefs';
import type { Tool, ToolOption } from './types';

function disabledSet(): Set<string> {
  return new Set(String(getPref('tools.disabled') || '').split(',').map((s) => s.trim()).filter(Boolean));
}

export function isToolEnabled(name: string): boolean {
  return !disabledSet().has(name);
}

export function setToolEnabled(name: string, on: boolean): void {
  const set = disabledSet();
  if (on) set.delete(name);
  else set.add(name);
  setPref('tools.disabled', [...set].sort().join(','));
}

export function choiceAvailable(option: ToolOption, value: string): boolean {
  const choice = option.choices.find((c) => c.value === value);
  return !!choice && (choice.available?.() ?? true);
}

/** The stored choice (whether usable or not), for the select box. */
export function storedOption(tool: Tool, option: ToolOption): string {
  const v = String(getPref(`tools.${tool.spec.name}.${option.key}`) ?? '');
  return option.choices.some((c) => c.value === v) ? v : option.default;
}

/** The choice in effect: the stored one if available, else the default. */
export function effectiveOption(tool: Tool, option: ToolOption): string {
  const v = storedOption(tool, option);
  return choiceAvailable(option, v) ? v : option.default;
}

export function setToolOption(tool: Tool, key: string, value: string): void {
  setPref(`tools.${tool.spec.name}.${key}`, value);
}

export function effectiveOptions(tool: Tool): Record<string, string> {
  return Object.fromEntries((tool.options || []).map((o) => [o.key, effectiveOption(tool, o)]));
}
