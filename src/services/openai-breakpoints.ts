import { isRecord } from '../utils/is-record.ts';

type Rec = Record<string, unknown>;

const BREAKPOINT = 'prompt_cache_breakpoint';

function stripFrom(node: unknown, keep: Rec | undefined): boolean {
  if (!isRecord(node) || node === keep || !(BREAKPOINT in node)) return false;
  delete node[BREAKPOINT];
  return true;
}

/** Removes `prompt_cache_breakpoint` from tools, chat messages and parts, and Responses items, parts and tool output parts, except on `keep`. */
export function stripBreakpoints(body: Rec, keep?: Rec): boolean {
  let changed = false;
  const visit = (node: unknown): void => {
    changed = stripFrom(node, keep) || changed;
    if (!isRecord(node)) return;
    for (const parts of [node.content, node.output]) {
      if (Array.isArray(parts))
        for (const part of parts) changed = stripFrom(part, keep) || changed;
    }
  };
  for (const key of ['tools', 'messages', 'input']) {
    const list = body[key];
    if (Array.isArray(list))
      list.forEach((node) => {
        visit(node);
      });
  }
  return changed;
}
