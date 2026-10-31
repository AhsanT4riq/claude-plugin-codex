// Streaming transport is deliberately reduced to activity metadata, not a transcript.
// Thinking blocks and complete tool inputs/results are never persisted here.
export function streamCollector({ onActivity, onSession, onResult }) {
  let final = null;
  const tools = new Map();
  const denied = [];
  const activity = (type, message, extra = {}) => onActivity?.({ type, message, ...extra });
  return {
    line(line) {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { throw new Error('Claude emitted malformed streaming JSON.'); }
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid Claude stream event.');
      if (event.type === 'system' && event.subtype === 'init') {
        if (typeof event.session_id === 'string') onSession?.(event.session_id, event.model);
        activity('started', 'Claude session started.', { phase: 'investigating' });
      } else if (event.type === 'system' && event.subtype === 'permission_denied') {
        const tool = String(event.tool_name || event.tool_use?.name || 'unknown').slice(0, 80);
        denied.push({ tool_name: tool });
        activity('permission_denied', `Permission denied: ${tool}`, { tool });
      } else if (event.type === 'assistant') {
        for (const block of event.message?.content || []) {
          if (block.type !== 'tool_use') continue;
          const tool = String(block.name || 'unknown').slice(0, 80);
          const item = { tool, toolUseId: String(block.id || '').slice(0,128),
            ...(['Read','Write','Edit'].includes(tool) && typeof block.input?.file_path === 'string' ? {path:block.input.file_path.slice(0,4096),pathTruncated:block.input.file_path.length>4096} : {}),
            ...(tool === 'Bash' && typeof block.input?.command === 'string' ? {command:block.input.command.slice(0,2048),commandTruncated:block.input.command.length>2048} : {}),
            phase: ['Write', 'Edit'].includes(tool) ? 'editing' : tool === 'Bash' ? 'executing' : 'investigating' };
          if(tools.size >= 1024) tools.delete(tools.keys().next().value);
          tools.set(block.id, item);
          activity('tool_started', `Using ${tool}.`, item);
        }
      } else if (event.type === 'user') {
        for (const block of event.message?.content || []) {
          if (block.type !== 'tool_result') continue;
          const item = tools.get(block.tool_use_id);
          if (item) {
            activity('tool_finished', `${item.tool} ${block.is_error ? 'failed' : 'finished'}.`, { ...item, failed: !!block.is_error, ...(Number.isInteger(event.tool_use_result?.exitCode) ? {exitCode:event.tool_use_result.exitCode} : {}) });
            tools.delete(block.tool_use_id);
          }
        }
      } else if (event.type === 'result') {
        if (final) throw new Error('Claude emitted more than one final result.');
        final = event; onResult?.(event);
      }
      // Unknown event types are forward-compatible. No raw/partial thinking is logged.
    },
    finish() {
      if (!final) throw new Error('Claude exited without a final result.');
      const permissionDenials = [...denied, ...(Array.isArray(final.permission_denials) ? final.permission_denials.map(d => ({ tool_name: d.tool_name || 'unknown' })) : [])];
      return { ...final, permission_denials: permissionDenials };
    },
  };
}
