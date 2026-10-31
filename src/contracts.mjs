const text = { type: 'string', maxLength: 8000 };
const strings = { type: 'array', items: text, maxItems: 100 };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const REVIEW_SCHEMA = object({
  summary: text, completion: { type: 'string', enum: ['completed', 'incomplete'] }, uncertainties: strings,
  findings: { type: 'array', maxItems: 100, items: object({
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    file: { type: 'string', minLength: 1, maxLength: 4096 }, line: { type: 'integer', minimum: 1 }, title: text, body: text,
  }) },
});
export const TASK_SCHEMA = object({
  summary: text, completion: { type: 'string', enum: ['completed', 'incomplete'] },
  changes: strings, checks: { type: 'array', maxItems: 100, items: object({command:text,outcome:{type:'string',enum:['passed','failed','not_run','unknown']},detail:text}) },
  uncertainties: strings, unverifiedClaims: strings,
});
export function validateSchema(value, schema, location = 'report') {
  const fail = message => { throw new Error(`Invalid structured ${location}: ${message}`); };
  if (schema.enum && !schema.enum.includes(value)) fail('unexpected value');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected object');
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) { if (schema.additionalProperties === false) fail(`unexpected ${key}`); }
      else validateSchema(item, schema.properties[key], `${location}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > schema.maxItems) fail('expected bounded array');
    value.forEach((v, i) => validateSchema(v, schema.items, `${location}[${i}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > (schema.maxLength ?? Infinity) || value.length < (schema.minLength || 0)) fail('expected bounded string');
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < schema.minimum) fail('expected positive integer');
  }
  return value;
}
export function validateReview(value, context) {
  validateSchema(value, REVIEW_SCHEMA);
  for (const finding of value.findings) {
    if (finding.file.startsWith('/') || finding.file.split('/').includes('..')) throw new Error('Invalid structured finding file: expected repository-relative path.');
    if (context?.scope !== 'manual' && context?.files && !context.files.includes(finding.file)) throw new Error('Invalid structured finding file: outside the reviewed changes.');
  }
  return value;
}
