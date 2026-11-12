'use strict';
// Reasoning-effort levels offered per model family. First matching rule wins.
// 'off' is always offered and means: send no reasoning/thinking parameter.
const RULES = [
  { match: /deepseek/i, levels: ['low', 'high', 'max'] },
  { match: /^(gpt-|o\d|codex)/i, levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { match: /claude-(fable|mythos|opus-5|opus-4-[78]|sonnet-5|haiku-5)/i, levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { match: /claude-(sonnet-4-6|opus-4-6)/i, levels: ['low', 'medium', 'high', 'max'] },
  { match: /^/, levels: ['low', 'medium', 'high'] }, // fallback for anything else
];
const ALL_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
const levelsFor = (model) => ['off', ...RULES.find((r) => r.match.test(String(model || ''))).levels];
// Sent to the browser so the dropdown uses the same rules (RegExp source + flags).
const effortRulesForClient = () => RULES.map((r) => ({ match: r.match.source, flags: r.match.flags, levels: ['off', ...r.levels] }));

module.exports = { levelsFor, ALL_EFFORTS, effortRulesForClient };
