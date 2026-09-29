/**
 * Which sources the library window lets the user combine. Pure, unit-tested.
 *
 * "Books (own index)" = SeekBook. It needs SeekBook ready (installed, enabled,
 * REST on, books indexed). When ZotSeek is a chosen, available source and
 * already takes its books from SeekBook, asking SeekBook as well would only
 * repeat the same passages: then the option is locked. Books that ZotSeek
 * indexes itself, or excludes, leave SeekBook free; so does ZotSeek being off.
 */
import type { ZotSeekBookMode } from './coverage';
import type { SeekBookStatus } from '../seekbook/client';

export interface SeekBookChoice {
  enabled: boolean;
  /** Why it is locked, or a note while it is allowed ('' = nothing to say). */
  reason: 'seekbook' | 'viaZotSeek' | 'nativeToo' | '';
}

export function seekBookChoice(opts: {
  seekbook: SeekBookStatus | null;
  useZotSeek: boolean;
  zotseekAvailable: boolean;
  zotseekBooks: ZotSeekBookMode;
}): SeekBookChoice {
  if (!opts.seekbook?.available) return { enabled: false, reason: 'seekbook' };
  const zotseekActive = opts.useZotSeek && opts.zotseekAvailable;
  if (zotseekActive && opts.zotseekBooks === 'seekbook') return { enabled: false, reason: 'viaZotSeek' };
  if (zotseekActive && opts.zotseekBooks === 'native') return { enabled: true, reason: 'nativeToo' };
  return { enabled: true, reason: '' };
}
