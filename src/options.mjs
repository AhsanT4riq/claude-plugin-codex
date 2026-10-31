export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_EFFORT = 'medium';
export const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
export const ACCESSES = ['read-only', 'edit', 'shell'];
export function capabilities(options = {}) {
  if (options.access !== undefined && !ACCESSES.includes(options.access)) throw new Error('--access must be read-only, edit, or shell.');
  let write = !!options.write, allowBash = !!options.allowBash;
  if (options.access !== undefined) {
    write = options.access !== 'read-only'; allowBash = options.access === 'shell';
    if ((options.write !== undefined && !!options.write !== write) || (options.allowBash !== undefined && !!options.allowBash !== allowBash)) throw new Error('--access conflicts with --write or --allow-bash.');
  }
  if (allowBash && !write) throw new Error('--allow-bash requires --write.');
  if (options.kind && options.kind !== 'rescue' && write) throw new Error('Review commands do not allow --write or edit/shell access.');
  return { write, allowBash, access: allowBash ? 'shell' : write ? 'edit' : 'read-only', approvalMode: 'preapproved-scope' };
}
export function selection(options = {}, previous = {}) {
  const model = options.model === 'default' ? DEFAULT_MODEL : options.model ?? previous.model ?? DEFAULT_MODEL;
  const effort = options.effort === 'default' ? DEFAULT_EFFORT : options.effort ?? previous.effort ?? DEFAULT_EFFORT;
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+@-]{0,199}$/.test(model)) throw new Error('--model must be a nonempty model alias or identifier (without spaces or leading options).');
  if (effort !== undefined && !EFFORTS.slice(1).includes(effort)) throw new Error('Invalid effort level. Choose default, low, medium, high, xhigh, or max.');
  return { model, effort, ...capabilities(options) };
}
export function selectionOptions() {
  return {
    model: { default: DEFAULT_MODEL, aliases: ['opus', 'sonnet', 'haiku'], customIdentifier: true, note: 'Aliases and availability depend on the installed Claude CLI, provider and account. No model call is made.' },
    effort: { choices: EFFORTS, default: DEFAULT_EFFORT, note: 'default resets to medium; model support varies.' },
    access: { choices: ACCESSES, default: 'read-only', tools: { 'read-only': ['Read', 'Glob', 'Grep'], edit: ['Read', 'Glob', 'Grep', 'Edit', 'Write'], shell: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] } },
    approval: { mode: 'preapproved-scope', permissionMode: 'dontAsk', permissionPrompts: 'none', note: 'Selected tools are allowed upfront. Calls needing further approval are denied. No per-action prompts or permission bypass.' },
    continuation: { model: 'inherit unless overridden; default resets to bridge default', effort: 'inherit unless overridden; default resets to medium', access: 'selected afresh for every turn; omitted means read-only' },
    reviews: { access: ['read-only'] },
  };
}
