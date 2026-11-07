// Shared JSON-schema fragments for request validation.
export const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
};

export const str = (max, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
export const nullableInt = { type: ['integer', 'null'], minimum: 1 };
export const bool = { type: 'boolean' };
export const intRange = (min, max) => ({ type: 'integer', minimum: min, maximum: max });
export const idList = { type: 'array', maxItems: 200, items: { type: 'integer', minimum: 1 } };

export function body(properties, required = []) {
  return { type: 'object', additionalProperties: false, required, properties };
}

export function httpError(msg, code = 400) {
  const e = new Error(msg);
  e.statusCode = code;
  return e;
}
